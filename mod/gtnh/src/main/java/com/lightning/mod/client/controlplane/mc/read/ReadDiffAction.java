package com.lightning.mod.client.controlplane.mc.read;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.SceneManifest;
import com.lightning.mod.client.controlplane.mc.SceneManifestStore;

/**
 * {@code read.diff}（observe，同步）：两个世界状态逐格 diff。
 *
 * <h2>两个「状态」是什么</h2>
 * <b>期望态</b>（{@code expect}，三选一）：
 * <ul>
 * <li>{@code expectInline:[{op,at,id,meta}…]}：内联的方块清单（与用例 build 段的 block 步同形）；</li>
 * <li>{@code expectManifest:{…}}：场景清单对象（与 {@code world/scene-manifest.json} 同形）；</li>
 * <li>{@code expectManifestFile:"<存档目录名>"}：读该托管世界存档内最新场景清单
 * （{@code saves/<folder>/scene-manifest.json}，即 {@code world.rebuild} 写下的那份）。</li>
 * </ul>
 * <b>实际态</b>：服务端权威世界<b>实读</b>（从不读缓存）。
 *
 * <h2>为什么这是读面而不是写面</h2>
 * 需求书 §4.2：「只有 L2 允许宣称端到端」。本动作不写世界、不开 run 的可写段，
 * 只做「读两侧 → 比较 → 报告」。它因此可以被 criteria 段直接引用（{@code json-field} 断言
 * {@code /counts/meta} 等），而不必先污染世界。
 *
 * <h2>为什么逐格而不是哈希</h2>
 * 哈希只回答「一样不一样」；本动作回答「哪一格不一样、期望什么、实际什么」——
 * 这正是「Agent 必须读源码或靠猜才能得知」的反面（需求书 §5 的判据）。
 * 哈希仍在（{@code hashes}）作为快速判等与 run 产物登记的依据。
 *
 * <h2>产物入 run 清单（需求书 §8.6）</h2>
 * 给 {@code expectManifestFile}（即需要读盘的那条路径）时，本动作开一个 run 目录
 * （{@code read-diff}）并把 diff 结果落 {@code read/diff.json}、登记进 {@code manifest.json}。
 * 其余两条路径是纯内存比较，不产 run（不为产物而产物）。
 */
public final class ReadDiffAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.diff";

    /** run 产物相对路径。 */
    public static final String RUN_RELATIVE_PATH = "read/diff.json";

    /** 内联期望态的最大条目数。 */
    public static final int MAX_EXPECT = 200000;

    /** {@code changes} 数组的输出上限（超出记 {@code truncated}，不静默截断）。 */
    public static final int DEFAULT_MAX_CHANGES = 4096;

    @Override
    public JsonObject execute(ActionContext ctx) {
        WorldServer world = ReadSupport.requireServerWorld(NAME);

        Expected expected = resolveExpected(ctx);
        int maxChanges = ctx.optInt("maxChanges", DEFAULT_MAX_CHANGES);
        if (maxChanges <= 0) {
            throw CpException.param("maxChanges 非法", "maxChanges", "须为正整数，收到 " + maxChanges);
        }

        // 单点核对（at 给出时只比那一格）——比区域全扫快，且判据常用
        int[] onlyAt = ctx.has("at") ? ReadInventoryAction.parseAt(ctx, "at") : null;
        if (onlyAt != null) {
            Fields f = new Fields();
            ReadSupport.checkBounds(onlyAt, "at", f);
            f.throwIfAny("坐标非法");
        }

        JsonObject result = new JsonObject();
        result.addProperty("schema", "lightning.cp-read-diff/1");
        result.addProperty("action", NAME);
        result.addProperty("expectSource", expected.source);

        JsonArray changes = new JsonArray();
        int same = 0;
        int checked = 0;
        int truncated = 0;
        for (Map.Entry<String, JsonElement> e : expected.entries.entrySet()) {
            int[] pos = expected.positions.get(e.getKey());
            if (pos == null) {
                continue;
            }
            if (onlyAt != null && (pos[0] != onlyAt[0] || pos[1] != onlyAt[1] || pos[2] != onlyAt[2])) {
                continue;
            }
            JsonObject want = e.getValue()
                .isJsonObject()
                    ? e.getValue()
                        .getAsJsonObject()
                    : new JsonObject();
            checked++;
            JsonObject actual = ReadSupport.readBlock(world, pos[0], pos[1], pos[2]);
            JsonArray kinds = diffKinds(want, actual);
            if (kinds.size() == 0) {
                same++;
                continue;
            }
            if (changes.size() >= maxChanges) {
                truncated++;
                continue;
            }
            JsonObject c = new JsonObject();
            c.add("pos", ReadSupport.posArray(pos));
            c.add("kinds", kinds);
            c.add("expect", want);
            c.add("actual", actual);
            changes.add(c);
        }

        result.addProperty("checked", Integer.valueOf(checked));
        result.addProperty("same", Integer.valueOf(same));
        result.addProperty("different", Integer.valueOf(changes.size() + truncated));
        result.addProperty("truncatedChanges", Integer.valueOf(truncated));
        result.addProperty("maxChanges", Integer.valueOf(maxChanges));
        result.add("changes", changes);

        // 两侧的规范化哈希：同一口径（读面的区域哈希口径），故可与 read.blocks 互算
        JsonArray actualBlocks = new JsonArray();
        JsonArray expectBlocks = new JsonArray();
        for (Map.Entry<String, JsonElement> e : expected.entries.entrySet()) {
            int[] pos = expected.positions.get(e.getKey());
            if (pos == null) {
                continue;
            }
            if (onlyAt != null && (pos[0] != onlyAt[0] || pos[1] != onlyAt[1] || pos[2] != onlyAt[2])) {
                continue;
            }
            actualBlocks.add(ReadSupport.readBlock(world, pos[0], pos[1], pos[2]));
            expectBlocks.add(normalizeExpected(pos, e.getValue()));
        }
        JsonObject hashes = new JsonObject();
        hashes.addProperty("actual", ReadSupport.regionHash(actualBlocks));
        hashes.addProperty("expected", ReadSupport.regionHash(expectBlocks));
        hashes.addProperty(
            "equal",
            Boolean.valueOf(
                ReadSupport.regionHash(actualBlocks)
                    .equals(ReadSupport.regionHash(expectBlocks))));
        hashes.addProperty(
            "scope",
            "位置集合 = 期望态声明的全部位置（或 at 指定的那一格）；"
                + "哈希口径同 read.blocks（{blocks:[{pos,blockId,meta}]} 按 (x,y,z) 升序的 canonical JSON 之 sha256）");
        result.add("hashes", hashes);

        result.addProperty("scope", expected.describe());

        // 需要读盘的那条路径（expectManifestFile）落 run 产物并登记哈希（需求书 §8.6）
        ArtifactStore.Run run = ctx.run();
        if (run != null) {
            JsonObject stored = Json.copyObject(result);
            ArtifactStore.Artifact a = ctx.artifacts()
                .writeArtifact(
                    run,
                    RUN_RELATIVE_PATH,
                    Json.toPretty(stored)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    "read-diff");
            result.addProperty("resultPath", RUN_RELATIVE_PATH);
            result.addProperty("resultSha256", a.sha256());
            result.addProperty("resultBytes", a.bytes());
        }

        result.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return result;
    }

    // ------------------------------------------------------------ 期望态

    /** 规范化后的期望态：位置集合 + 逐位置期望读数。 */
    static final class Expected {

        final String source;
        final Map<String, JsonElement> entries = new java.util.LinkedHashMap<String, JsonElement>();
        final Map<String, int[]> positions = new HashMap<String, int[]>();

        Expected(String source) {
            this.source = source;
        }

        void put(int[] pos, JsonObject block) {
            String key = key(pos);
            entries.put(key, block);
            positions.put(key, pos);
        }

        String describe() {
            return "expectSource=" + source + "，位置数 " + entries.size();
        }

        static String key(int[] pos) {
            return pos[0] + "," + pos[1] + "," + pos[2];
        }
    }

    /**
     * 解析期望态（三选一，必须显式给出一个）。
     *
     * <p>
     * 三选一而不是「都接受再合并」：合并会让「空期望 vs 空实际」变成永远绿的假断言，
     * 而那正是本动作要防的东西（需求书 §8.5）。
     */
    static Expected resolveExpected(ActionContext ctx) {
        boolean hasInline = ctx.has("expectInline");
        boolean hasManifest = ctx.has("expectManifest");
        boolean hasFile = ctx.has("expectManifestFile");
        int given = (hasInline ? 1 : 0) + (hasManifest ? 1 : 0) + (hasFile ? 1 : 0);
        if (given == 0) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "缺少期望态：expectInline / expectManifest / expectManifestFile 三选一",
                Json.object(
                    "hint",
                    "expectInline:[{at:[x,y,z],id:\"minecraft:stone\",meta:0}…]；"
                        + "expectManifest:{…}（场景清单对象）；expectManifestFile:\"cp_demo\"（读存档内最新场景清单）"));
        }
        if (given > 1) {
            throw CpException.param(
                "期望态冲突",
                "expectInline|expectManifest|expectManifestFile",
                "三者只能给一个，收到 " + given + " 个（合并会让空期望变成恒绿假断言）");
        }
        if (hasInline) {
            return fromInline(ctx.requireArray("expectInline"));
        }
        if (hasManifest) {
            return fromManifest(ctx.requireObject("expectManifest"), "expectManifest");
        }
        String folder = ctx.requireString("expectManifestFile");
        if (!com.lightning.mod.client.controlplane.mc.ManagedWorld.isManagedFolderName(folder)) {
            throw CpException.param(
                "托管世界目录名非法",
                "expectManifestFile",
                "须以 " + Contract.MANAGED_WORLD_PREFIX + " 开头且只含 [A-Za-z0-9_.-]，收到: " + folder);
        }
        java.io.File dataDir = com.lightning.mod.client.controlplane.mc.WorldRuntime.mc() == null ? null
            : com.lightning.mod.client.controlplane.mc.WorldRuntime.mc().mcDataDir;
        JsonObject manifest = SceneManifestStore.read(dataDir, folder);
        if (manifest == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "该托管世界没有场景清单（还没被 world.rebuild/case.run 构建过）",
                Json.object(
                    "action",
                    NAME,
                    "folder",
                    folder,
                    "path",
                    SceneManifestStore.worldFile(dataDir, folder)
                        .toString(),
                    "hint",
                    "先构建世界（world.rebuild 或 case.run 的 world+build 段），或用 expectInline/expectManifest"));
        }
        Expected ex = fromManifest(manifest, "expectManifestFile:" + folder);
        // 读盘路径：开 run 目录并把 diff 结果登记进 manifest（需求书 §8.6 产物显式）
        ctx.beginRun("read-diff");
        return ex;
    }

    /** 内联方块清单（与用例 build 段的 block 步同形：{@code {at,id,meta}}）。 */
    private static Expected fromInline(JsonArray arr) {
        if (arr.size() > MAX_EXPECT) {
            throw CpException.param("期望态过大", "expectInline", arr.size() + " 条 > 上限 " + MAX_EXPECT);
        }
        Expected ex = new Expected("expectInline");
        Fields fields = new Fields();
        for (int i = 0; i < arr.size(); i++) {
            JsonElement e = arr.get(i);
            if (e == null || !e.isJsonObject()) {
                fields.add("expectInline[" + i + "]", "条目须为 object {at,id,meta?}");
                continue;
            }
            JsonObject o = e.getAsJsonObject();
            JsonArray at = Json.optArray(o, "at");
            if (at == null || at.size() != 3) {
                fields.add("expectInline[" + i + "].at", "必填，须为 [x,y,z] 三个整数");
                continue;
            }
            int[] pos;
            try {
                pos = ReadSupport.coords(at, "expectInline[" + i + "].at");
            } catch (CpException ex2) {
                fields.add("expectInline[" + i + "].at", ex2.detail());
                continue;
            }
            ReadSupport.checkBounds(pos, "expectInline[" + i + "].at", fields);
            JsonObject want = new JsonObject();
            want.add("pos", ReadSupport.posArray(pos));
            String id = Json.optString(o, "id", null);
            Block block = ReadSupport.parseBlock(id);
            if (id != null && block == null) {
                fields.add("expectInline[" + i + "].id", "未知方块注册名: " + id);
                continue;
            }
            want.addProperty("blockId", block == null ? 0 : Block.getIdFromBlock(block));
            want.addProperty("meta", Integer.valueOf(Json.optInt(o, "meta", 0)));
            want.addProperty("id", id);
            ex.put(pos, want);
        }
        fields.throwIfAny("期望态非法（" + fields.size() + " 处）");
        return ex;
    }

    /** 场景清单（与 {@code world/scene-manifest.json} 同形）。 */
    static Expected fromManifest(JsonObject manifest, String source) {
        Expected ex = new Expected(source);
        JsonArray blocks = Json.optArray(manifest, "blocks");
        if (blocks == null) {
            throw CpException.param("清单缺少 blocks 数组", "expectManifest", "场景清单必须含 blocks:[{pos,blockId,meta,id}]");
        }
        if (blocks.size() > MAX_EXPECT) {
            throw CpException.param("期望态过大", "expectManifest", blocks.size() + " 条 > 上限 " + MAX_EXPECT);
        }
        for (int i = 0; i < blocks.size(); i++) {
            int[] pos = SceneManifest.posOf(blocks.get(i));
            JsonObject src = blocks.get(i)
                .isJsonObject()
                    ? blocks.get(i)
                        .getAsJsonObject()
                    : new JsonObject();
            JsonObject want = new JsonObject();
            want.add("pos", ReadSupport.posArray(pos));
            want.addProperty("blockId", Integer.valueOf(Json.optInt(src, "blockId", 0)));
            want.addProperty("meta", Integer.valueOf(Json.optInt(src, "meta", 0)));
            want.addProperty("id", Json.optString(src, "id", null));
            ex.put(pos, want);
        }
        return ex;
    }

    // ------------------------------------------------------------ 比较

    /** 期望读数 → 与实读同形的方块对象（便于两侧用同一个哈希口径）。 */
    private static JsonObject normalizeExpected(int[] pos, JsonElement want) {
        JsonObject o = new JsonObject();
        o.add("pos", ReadSupport.posArray(pos));
        JsonObject w = want != null && want.isJsonObject() ? want.getAsJsonObject() : new JsonObject();
        o.addProperty("blockId", Integer.valueOf(Json.optInt(w, "blockId", 0)));
        o.addProperty("meta", Integer.valueOf(Json.optInt(w, "meta", 0)));
        return o;
    }

    /**
     * 逐格差异的<b>种类</b>（不是「一样不一样」一个布尔）。
     *
     * <p>
     * 种类：{@code blockId} / {@code meta} / {@code te}（期望态声明了 TE 而实际没有，
     * 或实际有而期望态声明的是「无 TE」）。分开报的理由是「世界漂移了」与「补全没生效」
     * 是两类不同的根因，判据与人都需要能区分。
     */
    static JsonArray diffKinds(JsonObject want, JsonObject actual) {
        JsonArray kinds = new JsonArray();
        int wantId = Json.optInt(want, "blockId", 0);
        int actualId = Json.optInt(actual, "blockId", 0);
        if (wantId != actualId) {
            Json.add(kinds, "blockId");
        }
        int wantMeta = Json.optInt(want, "meta", 0);
        int actualMeta = Json.optInt(actual, "meta", 0);
        if (wantMeta != actualMeta) {
            Json.add(kinds, "meta");
        }
        return kinds;
    }

    /** 期望态与实际态的双侧哈希相等判定（供外部工具复算）。 */
    public static boolean hashesEqual(JsonObject diffResult) {
        JsonObject h = diffResult == null ? null : Json.optObject(diffResult, "hashes");
        return h != null && Json.optBool(h, "equal", false);
    }

    /** 供外部工具：期望态位置集合的 sha256（与 {@link ReadSupport#regionHash} 同口径）。 */
    public static String expectedHash(Expected ex) {
        JsonArray arr = new JsonArray();
        List<Map.Entry<String, JsonElement>> list = new ArrayList<Map.Entry<String, JsonElement>>(
            ex.entries.entrySet());
        for (Map.Entry<String, JsonElement> e : list) {
            arr.add(normalizeExpected(ex.positions.get(e.getKey()), e.getValue()));
        }
        return Hashing.sha256HexUtf8(Json.canonical(ReadSupport.hashSubsetOf(arr)));
    }

    /** 世界此刻是否可读（供调用方在判据前探测，不走隐藏通道：直接问 read.overview）。 */
    public static boolean worldReadable() {
        return com.lightning.mod.client.controlplane.mc.WorldRuntime.serverWorld() != null;
    }

    /** TE 类名（供 diff 的 TE 维度使用；world 为 null 时返回 null）。 */
    static String teClassAt(WorldServer world, int[] pos) {
        if (world == null || pos == null) {
            return null;
        }
        TileEntity te = world.getTileEntity(pos[0], pos[1], pos[2]);
        return te == null ? null
            : te.getClass()
                .getName();
    }
}
