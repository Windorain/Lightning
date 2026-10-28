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
 *
 * <h2>同一 pos 的去重（「清单语义 = 世界最终状态」）</h2>
 * {@code SceneBuilder} 对每一次 {@code block} 构建步都追加一条清单项，于是「同一坐标被写两次」
 * （先石头后箱子）会让清单出现两条同 pos 记录：落盘清单里既有 {@code blockId=1} 也有后来的
 * {@code blockId=54}。{@code readBack} 按位置实读世界时两条都读成最终值（箱子），
 * 而清单自报的 {@code sha256} 覆盖的是<b>两条</b>记录 ⇒ {@code world-hash-equals} 在
 * 「同参无漂移」时也误判红：哈希取决于<b>构建历史</b>，而不是<b>世界最终状态</b>。
 *
 * <p>
 * 因此清单条目集合的唯一口径是<b>同一 pos 后写覆盖</b>：{@link #dedupeByPos} 是这条口径的
 * <b>唯一去重点</b>，它被三处共用、没有第二份实现：
 * <ol>
 * <li>{@link #manifestBlocks}/{@link #manifestTes}——清单<b>数据入口</b>：{@code SceneBuilder}
 * 与按段续跑的清单存根都经此组装 {@code blocks}/{@code tileEntities}。放在入口的理由是
 * 「产物自描述诚实」：落盘清单本身就不含重复 pos，而不是只在算哈希时把它掩盖掉；</li>
 * <li>{@link #hashSubset}（经 {@link #normalizeBlocks}/{@link #normalizeTes}）——哈希归一化；</li>
 * <li>{@link #readBack}（同经两个 normalize）——读回归一化。</li>
 * </ol>
 * 三者共用同一份去重，因此 {@code hash}、{@code readBack}、{@code world-hash-equals}、
 * {@code read.blocks} 互算（R2 口径）四条路径<b>天然一致</b>；而「无重复写入」的
 * 清单经去重后逐条不变，既有场景的哈希因此逐字不变（回归锁见
 * {@code SceneManifestTest#noDuplicateManifestHashIsUnchanged}）。
 *
 * <p>
 * 归一是<b>幂等</b>的，且同时覆盖「旧版本写下的清单」「调用方经 {@code expectManifest} 递进来的
 * 清单」这类非本类产出的输入——它们一样要在同一口径下被哈希与读回。
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
     * 从当前世界状态<b>重新产出</b>清单（case-file.md §8 第 2 条：判据段在新 run 中求值时，若引用的产物在本
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
                m.add(key, Json.copy(v));
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

    // ------------------------------------------------------------ 同一 pos 去重（唯一定义点）

    /**
     * 同一 {@code pos} <b>后写覆盖</b>的去重——<b>唯一定义点</b>（见类注释）。
     *
     * <p>
     * 输入按声明序（= 构建历史序），输出保留每个 pos <b>首次出现</b>的槽位、取该 pos
     * <b>最后一次出现</b>的值：清单条目集合的语义因此是「世界最终状态」，与构建历史无关。
     * 槽位取首次出现序而不是末次，是为了让输出顺序仍是<b>声明序的确定性投影</b>
     * （同一条构建程序永远产出同一份清单文本）。
     *
     * <p>
     * 缺 {@code pos} 或 pos 非法的条目按既有归一化口径<b>跳过</b>——{@link #normalizeBlocks}/
     * {@link #normalizeTes} 本来也跳过它们，两侧一致。
     *
     * <p>
     * <b>无重复的输入逐元素原样返回</b>（同序、同对象）：这是「无重复写入场景的哈希逐字不变」
     * 的机械保证，也是本方法可以安全地放进哈希/读回两条归一化流水线的原因。
     * 本方法<b>不做深拷贝</b>（归一化流水线里逐条调用，拷贝会变成两遍）；需要独占副本的调用方
     * 自行 {@link Json#copyArray}（如 {@link SceneBuilder} 把结果交给清单持有）。
     */
    public static JsonArray dedupeByPos(JsonArray entries) {
        JsonArray out = new JsonArray();
        if (entries == null) {
            return out;
        }
        // LinkedHashMap：首次出现的槽位固定，后续同 pos 只覆盖值（put 不改变既有槽位序）
        java.util.LinkedHashMap<String, JsonElement> byPos = new java.util.LinkedHashMap<String, JsonElement>();
        for (int i = 0; i < entries.size(); i++) {
            JsonElement e = entries.get(i);
            int[] pos = posOf(e);
            if (pos == null) {
                continue;
            }
            byPos.put(posKey(pos), e);
        }
        for (JsonElement e : byPos.values()) {
            out.add(e);
        }
        return out;
    }

    /** 位置索引键（{@code "x,y,z"}）：去重与逐格对齐共用同一口径，不另起一种拼法。 */
    public static String posKey(int[] pos) {
        return pos[0] + "," + pos[1] + "," + pos[2];
    }

    /**
     * 清单<b>数据入口</b>：把构建历史追加出来的 {@code blocks} 收敛成「世界最终状态」形态的清单条目
     * （同一 pos 后写覆盖），字段与<b>字段序</b>同 {@link #blockEntry}，条目序仍是声明序。
     *
     * <p>
     * {@link SceneBuilder} 与按段续跑的清单存根都经此组装清单的 {@code blocks}——落盘清单本身因此
     * 不含重复 pos（产物自描述诚实），而不是只在算哈希时把重复掩盖掉。
     */
    public static JsonArray manifestBlocks(JsonArray appended) {
        return normalizeByPos(appended, BLOCK_WITH_ID_MAPPER);
    }

    /** 清单<b>数据入口</b>的方块实体形态（同 {@link #manifestBlocks}，字段序同 {@link #teEntry}）。 */
    public static JsonArray manifestTes(JsonArray appended) {
        return normalizeByPos(appended, TE_MAPPER);
    }

    /**
     * 条目集合的规范化入口：先按 {@link #dedupeByPos} 做「同一 pos 后写覆盖」，再交给
     * {@code mapper} 逐条归一化字段（<b>不排序</b>，保留声明序——供清单落盘用）。
     *
     * <p>
     * 这是「清单构建」与「哈希/读回归一化」共用的同一段代码——两条路径因此不可能在
     * 「到底留哪一条」上分叉。
     *
     * @param src    原始条目（可为 null）
     * @param mapper 单条归一化（返回 null 表示该条非法，跳过）
     */
    private static JsonArray normalizeByPos(JsonArray src, EntryMapper mapper) {
        JsonArray list = new JsonArray();
        if (src != null) {
            for (int i = 0; i < src.size(); i++) {
                JsonObject n = mapper.map(src.get(i));
                if (n != null) {
                    list.add(n);
                }
            }
        }
        return dedupeByPos(list);
    }

    /** 单条清单项的归一化（见 {@link #normalizeByPos}）。 */
    private interface EntryMapper {

        /** 归一化一条；非法返回 null。 */
        JsonObject map(JsonElement e);
    }

    /** 方块归一化：保留注册名（清单落盘与读回归一化用）。 */
    private static final EntryMapper BLOCK_WITH_ID_MAPPER = new EntryMapper() {

        @Override
        public JsonObject map(JsonElement e) {
            return blockEntryOf(e, false);
        }
    };

    /** 方块归一化：丢掉注册名（哈希口径用，见类注释「哈希口径」）。 */
    private static final EntryMapper BLOCK_NO_ID_MAPPER = new EntryMapper() {

        @Override
        public JsonObject map(JsonElement e) {
            return blockEntryOf(e, true);
        }
    };

    /** 方块实体归一化（{@code class} 缺失用 {@link #ABSENT}）。 */
    private static final EntryMapper TE_MAPPER = new EntryMapper() {

        @Override
        public JsonObject map(JsonElement e) {
            if (e == null || !e.isJsonObject()) {
                return null;
            }
            JsonObject o = e.getAsJsonObject();
            int[] pos = posOf(o);
            if (pos == null) {
                return null;
            }
            JsonObject n = new JsonObject();
            n.add("pos", posArray(pos));
            n.addProperty("class", Json.optString(o, "class", ABSENT));
            return n;
        }
    };

    /** 一条方块条目的归一化；非法返回 null。 */
    private static JsonObject blockEntryOf(JsonElement e, boolean dropId) {
        if (e == null || !e.isJsonObject()) {
            return null;
        }
        JsonObject o = e.getAsJsonObject();
        int[] pos = posOf(o);
        if (pos == null) {
            return null;
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
        return n;
    }

    /** 规范化方块数组（去重 → 按 pos 升序；{@code dropId} 为真时丢掉注册名，用于哈希口径）。 */
    private static JsonArray normalizeBlocks(JsonArray src, boolean dropId) {
        return sortJsonArrayByPos(normalizeByPos(src, dropId ? BLOCK_NO_ID_MAPPER : BLOCK_WITH_ID_MAPPER));
    }

    /** 规范化方块实体数组（去重 → 按 pos 升序）。 */
    private static JsonArray normalizeTes(JsonArray src) {
        return sortJsonArrayByPos(normalizeByPos(src, TE_MAPPER));
    }

    /** 把条目数组按 {@code (x,y,z)} 升序排好（{@link #sortByPos} 的数组形态）。 */
    private static JsonArray sortJsonArrayByPos(JsonArray src) {
        List<JsonObject> list = new ArrayList<JsonObject>();
        for (int i = 0; src != null && i < src.size(); i++) {
            list.add(
                src.get(i)
                    .getAsJsonObject());
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
                Json.add(a, Integer.valueOf(v));
            }
        }
        return a;
    }

    private static int size(JsonArray a) {
        return a == null ? 0 : a.size();
    }
}
