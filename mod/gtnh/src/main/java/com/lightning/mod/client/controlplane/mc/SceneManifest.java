package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 场景清单（{@code lightning.cp-scene/1}）：托管世界「构建产物」的规范化记录，也是
 * {@code world.rebuild} 幂等判据与 {@code world-hash-equals} 判据的哈希来源。
 *
 * <h2>结构</h2>
 * 
 * <pre>
 * {
 *   "schema": "lightning.cp-scene/1",
 *   "folder": "cp_demo", "seed": 20261006, "void": true,
 *   "generatorOptions": "2;0x1;1;", "stepCount": 3, "settleTicks": 60,
 *   "blocks": [{"pos":[65,12,64],"blockId":1,"meta":0,"id":"minecraft:stone"}, ...],
 *   "tileEntities": [{"pos":[65,12,64],"class":"logisticspipes.blocks.PipeTileEntity"}],
 *   "mismatches": [{"pos":[...],"kind":"block","requested":...,"actual":...}],
 *   "sha256": "&lt;哈希子集的规范化 sha256&gt;"
 * }
 * </pre>
 *
 * <h2>哈希口径</h2>
 * 哈希<b>只覆盖世界状态</b>：{@code {"blocks":[{"pos","blockId","meta"}...],
 * "tileEntities":[{"pos","class"}...]}}，其中 {@code blocks} 按 {@code (x,y,z)} 升序、
 * {@code tileEntities} 按 {@code (x,y,z)} 升序，然后取 {@link Json#canonical} 规范化文本的
 * sha256。{@code id}（注册名）、{@code mismatches}、种子等元数据<b>不入哈希</b>——
 * 哈希要回答的是「世界是不是同一个场景」，不是「用例文件是不是同一份」。
 *
 * <p>
 * {@code blockId}/{@code meta} 取<b>放置后从服务端世界读回的值</b>（而非请求值），
 * 因此 {@link #readBack} 用同一口径重读一遍即可做幂等/落盘一致性判定，无需信任任何缓存。
 */
public final class SceneManifest {

    /** schema 标识。 */
    public static final String SCHEMA = "lightning.cp-scene/1";

    /** 世界文件名（run 目录内相对路径与存档目录内同名）。 */
    public static final String FILE_NAME = "scene-manifest.json";

    /** run 目录内的相对路径（case-file.md §7 的 evidence 口径）。 */
    public static final String RUN_RELATIVE_PATH = "world/" + FILE_NAME;

    private SceneManifest() {}

    /**
     * 从清单里取出参与哈希的子集。
     *
     * <p>
     * 缺失字段用安全默认（{@code blockId=0}/{@code meta=0}/{@code class="absent"}），
     * 保证哈希永远可计算。
     */
    public static JsonObject hashSubset(JsonObject manifest) {
        JsonObject out = new JsonObject();
        out.add("blocks", normalizeBlocks(manifest == null ? null : Json.optArray(manifest, "blocks"), true));
        out.add("tileEntities", normalizeTes(manifest == null ? null : Json.optArray(manifest, "tileEntities")));
        return out;
    }

    /** 清单哈希（见类注释）。 */
    public static String hash(JsonObject manifest) {
        return Hashing.sha256HexUtf8(Json.canonical(hashSubset(manifest)));
    }

    /** 人读摘要，如 {@code "5 blocks, 2 TE"}。 */
    public static String summary(JsonObject manifest) {
        int blocks = size(manifest == null ? null : Json.optArray(manifest, "blocks"));
        int tes = size(manifest == null ? null : Json.optArray(manifest, "tileEntities"));
        return blocks + " blocks, " + tes + " TE";
    }

    /**
     * 从服务端世界读回清单记录的全部位置，产出与 {@link #hashSubset} 同口径的子集。
     *
     * <p>
     * 这是 {@code world-hash-equals} 的「当前场景哈希」来源：权威侧实读，
     * 不与任何缓存或期望值比较——比较留给判据引擎。
     */
    public static JsonObject readBack(WorldServer world, JsonObject manifest) {
        JsonArray blocks = new JsonArray();
        JsonArray src = manifest == null ? null : Json.optArray(manifest, "blocks");
        if (src != null) {
            for (int i = 0; i < src.size(); i++) {
                int[] pos = posOf(src.get(i));
                if (pos == null) {
                    continue;
                }
                Block b = world.getBlock(pos[0], pos[1], pos[2]);
                int id = b == null ? 0 : Block.getIdFromBlock(b);
                int meta = b == null ? 0 : world.getBlockMetadata(pos[0], pos[1], pos[2]);
                blocks.add(blockEntry(pos, id, meta, null));
            }
        }
        JsonArray tes = new JsonArray();
        JsonArray srcTes = manifest == null ? null : Json.optArray(manifest, "tileEntities");
        if (srcTes != null) {
            for (int i = 0; i < srcTes.size(); i++) {
                int[] pos = posOf(srcTes.get(i));
                if (pos == null) {
                    continue;
                }
                TileEntity te = world.getTileEntity(pos[0], pos[1], pos[2]);
                tes.add(
                    teEntry(
                        pos,
                        te == null ? ABSENT
                            : te.getClass()
                                .getName()));
            }
        }
        JsonObject out = new JsonObject();
        out.add("blocks", normalizeBlocks(blocks, false));
        out.add("tileEntities", normalizeTes(tes));
        return out;
    }

    /** 对读回子集算哈希（等价于 {@code sha256(canonical(subset))}）。 */
    public static String hashOfSubset(JsonObject subset) {
        return Hashing.sha256HexUtf8(Json.canonical(subset));
    }

    /**
     * 从当前世界状态<b>重新产出</b>清单（case-file.md §8.2：判据段在新 run 中求值时，若引用的产物在本
     * run 不存在，必须从当前世界状态重新产出再求值）。
     *
     * <p>
     * 位置集合取自 {@code stored}（世界内最新 scene-manifest 的 positions），
     * {@code blockId}/{@code meta}/{@code class} 一律换成<b>实读值</b>并重算 sha256；
     * {@code folder}/{@code seed}/{@code void}/{@code stepCount}/{@code settleTicks} 等元数据沿用。
     * 只读世界，<b>不</b>回写存档目录——世界内的清单是「构建记录」，不该被读回值覆盖。
     *
     * @param world  服务端权威世界
     * @param stored 世界内最新清单（提供位置集合与元数据）
     * @return 重新产出的清单；{@code world} 或 {@code stored} 为 null 时返回 null
     */
    public static JsonObject rebuildFromWorld(WorldServer world, JsonObject stored) {
        if (world == null || stored == null) {
            return null;
        }
        JsonObject subset = readBack(world, stored);
        JsonObject m = new JsonObject();
        m.addProperty("schema", SCHEMA);
        m.addProperty("regenerated", true);
        m.addProperty(
            "regeneratedAt",
            com.lightning.mod.client.controlplane.core.TimeSource.system()
                .isoNow());
        m.addProperty("source", "world-readback");
        for (String key : new String[] { "folder", "seed", "void", "generatorOptions", "stepCount", "settleTicks" }) {
            JsonElement v = Json.get(stored, key);
            if (v != null) {
                m.add(key, v.deepCopy());
            }
        }
        m.add("blocks", subset.get("blocks"));
        m.add("tileEntities", subset.get("tileEntities"));
        m.addProperty("sha256", hashOfSubset(subset));
        return m;
    }

    /** 方块实体缺席时的类名占位（不可与真实类名混淆，且能稳定参与哈希）。 */
    public static final String ABSENT = "absent";

    /** 组一个方块清单项。 */
    public static JsonObject blockEntry(int[] pos, int blockId, int meta, String id) {
        JsonObject o = new JsonObject();
        o.add("pos", posArray(pos));
        o.addProperty("blockId", blockId);
        o.addProperty("meta", meta);
        if (id != null) {
            o.addProperty("id", id);
        }
        return o;
    }

    /** 组一个方块实体清单项。 */
    public static JsonObject teEntry(int[] pos, String className) {
        JsonObject o = new JsonObject();
        o.add("pos", posArray(pos));
        o.addProperty("class", className == null ? ABSENT : className);
        return o;
    }

    /** 组一条不一致记录。 */
    public static JsonObject mismatch(int[] pos, String kind, JsonElement requested, JsonElement actual) {
        JsonObject o = new JsonObject();
        o.add("pos", posArray(pos));
        o.addProperty("kind", kind);
        if (requested != null) {
            o.add("requested", requested);
        }
        if (actual != null) {
            o.add("actual", actual);
        }
        return o;
    }

    /** 规范化方块数组（按 pos 升序；{@code dropId} 为真时丢掉注册名，用于哈希口径）。 */
    private static JsonArray normalizeBlocks(JsonArray src, boolean dropId) {
        List<JsonObject> list = new ArrayList<JsonObject>();
        if (src != null) {
            for (int i = 0; i < src.size(); i++) {
                JsonElement e = src.get(i);
                if (e == null || !e.isJsonObject()) {
                    continue;
                }
                JsonObject o = e.getAsJsonObject();
                int[] pos = posOf(o);
                if (pos == null) {
                    continue;
                }
                JsonObject n = new JsonObject();
                n.add("pos", posArray(pos));
                n.addProperty("blockId", Json.optInt(o, "blockId", 0));
                n.addProperty("meta", Json.optInt(o, "meta", 0));
                if (!dropId) {
                    String id = Json.optString(o, "id", null);
                    if (id != null) {
                        n.addProperty("id", id);
                    }
                }
                list.add(n);
            }
        }
        sortByPos(list);
        JsonArray out = new JsonArray();
        for (JsonObject o : list) {
            out.add(o);
        }
        return out;
    }

    /** 规范化方块实体数组（按 pos 升序）。 */
    private static JsonArray normalizeTes(JsonArray src) {
        List<JsonObject> list = new ArrayList<JsonObject>();
        if (src != null) {
            for (int i = 0; i < src.size(); i++) {
                JsonElement e = src.get(i);
                if (e == null || !e.isJsonObject()) {
                    continue;
                }
                JsonObject o = e.getAsJsonObject();
                int[] pos = posOf(o);
                if (pos == null) {
                    continue;
                }
                JsonObject n = new JsonObject();
                n.add("pos", posArray(pos));
                n.addProperty("class", Json.optString(o, "class", ABSENT));
                list.add(n);
            }
        }
        sortByPos(list);
        JsonArray out = new JsonArray();
        for (JsonObject o : list) {
            out.add(o);
        }
        return out;
    }

    private static void sortByPos(List<JsonObject> list) {
        list.sort(
            Comparator.comparingInt((JsonObject o) -> posOf(o)[0])
                .thenComparingInt(o -> posOf(o)[1])
                .thenComparingInt(o -> posOf(o)[2]));
    }

    /** 取 {@code pos} 数组；非法返回 null。 */
    public static int[] posOf(JsonElement e) {
        if (e == null || !e.isJsonObject()) {
            return null;
        }
        JsonArray a = Json.optArray(e.getAsJsonObject(), "pos");
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()) {
                return null;
            }
            out[i] = v.getAsInt();
        }
        return out;
    }

    /** 坐标数组。 */
    public static JsonArray posArray(int[] pos) {
        JsonArray a = new JsonArray();
        if (pos != null) {
            for (int v : pos) {
                a.add(v);
            }
        }
        return a;
    }

    private static int size(JsonArray a) {
        return a == null ? 0 : a.size();
    }
}
