package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SceneManifest;
import com.lightning.mod.client.controlplane.mc.SceneManifestStore;
import com.lightning.mod.client.controlplane.mc.WorldDescriber;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;

/**
 * L0 布景原语的公共前置：写入门控 + 服务端权威世界句柄 + 场景清单回读。
 *
 * <h2>为什么这五组原语全都走「服务端权威世界」</h2>
 * 1.7.10 集成服里 {@code mc.theWorld} 是 {@code WorldClient}——它是权威世界的<b>只读投影</b>：
 * 直接往它身上写（方块、实体、时间、天气）会被下一个 S3x 包覆写，或干脆不产生任何服务端效果。
 * 因此 {@code world.rebuild} 的场景构建、{@code world.info} 的元数据、{@code shot.multi} 的
 * 光照基准都取 {@code MinecraftServer.getServer().worldServers[0]}（见 {@code WorldRuntime} 与
 * {@code WorldDescriber} 的实证注释）。L0 原语沿用同一口径：<b>只在服务端世界上施加状态变更</b>，
 * 客户端侧由原版同步路径（S2B/S1D/S06/S1F/S2F…）自然收敛。
 *
 * <h2>写入门控</h2>
 * 五组原语都是世界写动作，因此开场一律过 {@link CaptureControl#assertWorldWriteAllowed}：
 * 捕获会话期间被别的作业调用即 {@code CP-STATE-001}（契约 §7.3 与 §7.5 第 3 条的既有口径，不是新增规则）。
 *
 * <h2>「世界是不是还跟场景清单一致」怎么答</h2>
 * L0 原语<b>只</b>作用于清单登记的位置集合之外（实体、玩家、背包、时间、天气），或者作用于
 * 清单登记的位置之上（{@code scene.block.set} / {@code scene.clear}）。
 * 因此本类提供 {@link #manifestReadback}：按当前世界内最新场景清单的<b>位置集合</b>实读回读并重算哈希。
 * 调用方（动作）把它放进返回值，读面未就绪时也能自证「这次写发生了哪些可观察变化」。
 * 口径与 {@code world-hash-equals} 判据、{@code SceneManifest.rebuildFromWorld} 完全同源。
 */
public final class L0Session {

    private L0Session() {}

    /**
     * 公共前置：门控 + 取服务端权威世界。
     *
     * @param ctx  动作上下文（用于捕获会话门控的作业归属判定）
     * @param what 动作名（错误信息用）
     * @return 服务端权威世界（非 null）
     * @throws CpException CP-STATE-001：捕获会话期间由别的作业发起；或未进入世界/集成服未起
     */
    public static WorldServer requireServerWorld(ActionContext ctx, String what) {
        CaptureControl.assertWorldWriteAllowed(ctx);
        Minecraft mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, what + "：Minecraft 实例不可用");
        }
        WorldServer world = WorldRuntime.serverWorld();
        if (world == null) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：服务端权威世界不可用（未进入世界或集成服未起）——先 world.rebuild 进入托管世界",
                Json.object("mcDataDir", mc.mcDataDir == null ? null : mc.mcDataDir.toString()));
        }
        return world;
    }

    /** 集成服实例（供需要玩家表/难度等的原语使用）；未起时 null。 */
    public static MinecraftServer server() {
        return WorldRuntime.server();
    }

    /**
     * 读回当前世界内最新场景清单的位置集合，产出规范化哈希。
     *
     * <p>
     * 清单来源是 {@code SceneManifestStore}（{@code world.rebuild} / {@code case.run} 写进存档目录的那份）。
     * <b>没有清单不算错误</b>：世界可能从未跑过构建段，此时返回 {@code {present:false}} + 原因，
     * 让调用方自己决定（L0 原语不该要求「必须先 world.rebuild」——那会把纪律写死在能力里）。
     *
     * @return {@code {present, sha256?, blockCount?, teCount?, source?, matchesStored?, diffFromStored?}}；
     *         无清单时 {@code present=false}
     */
    public static JsonObject manifestReadback(WorldServer world, Minecraft mc) {
        JsonObject out = new JsonObject();
        if (world == null) {
            out.addProperty("present", false);
            out.addProperty("reason", "服务端世界不可用");
            return out;
        }
        JsonObject stored = null;
        try {
            String folder = WorldDescriber.currentFolder(mc);
            stored = SceneManifestStore.read(mc == null ? null : mc.mcDataDir, folder);
        } catch (Throwable t) {
            CpLog.warn("读取场景清单失败（读回哈希将缺失）: %s", String.valueOf(t));
        }
        if (stored == null) {
            out.addProperty("present", false);
            out.addProperty("reason", "当前世界没有场景清单（未跑过 world.rebuild 的构建段或 case.run 的 build 段）");
            return out;
        }
        out.addProperty("present", true);
        out.addProperty("source", "scene-manifest@" + SceneManifest.FILE_NAME);
        JsonObject subset = SceneManifest.readBack(world, stored);
        // 与 SceneManifest.hash 同口径：hash() = sha256(canonical(hashSubset(m)))，
        // 而 hashSubset 会对 blocks/tileEntities 做排序与字段归一化。readBack 的产物虽然已排序，
        // 但这里走 hash()（而不是 hashOfSubset）保证「同一个口径只有一处实现」——
        // 否则 L0 报的哈希与 world.rebuild 的 sceneManifestSha256 可能因归一化差异不可比。
        String sha = SceneManifest.hash(subset);
        out.addProperty("sha256", sha);
        out.addProperty("blockCount", size(Json.optArray(subset, "blocks")));
        out.addProperty("teCount", size(Json.optArray(subset, "tileEntities")));
        String storedSha = Json.optString(stored, "sha256", null);
        out.addProperty("storedSha256", storedSha);
        boolean matches = sha.equals(storedSha);
        out.addProperty("matchesStored", Boolean.valueOf(matches));
        if (!matches) {
            // 不匹配时给出**逐格差异**，否则调用方只看到一个 false 无从下手（D4「失败显式」）。
            // 差异也解释得清「L0 原语有没有动过场景」：本组原语只应动清单之外的维度，
            // 因此这里的 diff 正常应为空；非空即说明世界确实漂了（或 build 段本身有 mismatch）。
            out.add("diffFromStored", diffSubset(subset, stored));
            JsonArray mism = Json.optArray(stored, "mismatches");
            if (mism != null && mism.size() > 0) {
                out.add("storedMismatches", Json.copyArray(mism));
            }
        }
        return out;
    }

    /** 单次 diff 最多列出的条目数（防错误响应被大场景灌爆）。 */
    private static final int MAX_DIFF = 24;

    /**
     * 逐格比较「读回子集」与「存档清单」的 blocks/tileEntities，列出不一致项。
     *
     * @return {@code {blockDiffs[], teDiffs[], blockDiffCount, teDiffCount, truncated}}
     */
    private static JsonObject diffSubset(JsonObject readback, JsonObject stored) {
        JsonArray blockDiffs = new JsonArray();
        JsonArray teDiffs = new JsonArray();
        int blockCount = diffArray(
            Json.optArray(readback, "blocks"),
            Json.optArray(stored, "blocks"),
            "blockId",
            blockDiffs);
        int teCount = diffArray(
            Json.optArray(readback, "tileEntities"),
            Json.optArray(stored, "tileEntities"),
            "class",
            teDiffs);
        JsonObject o = new JsonObject();
        o.add("blockDiffs", blockDiffs);
        o.add("teDiffs", teDiffs);
        o.addProperty("blockDiffCount", Integer.valueOf(blockCount));
        o.addProperty("teDiffCount", Integer.valueOf(teCount));
        o.addProperty("truncated", Boolean.valueOf(blockCount > blockDiffs.size() || teCount > teDiffs.size()));
        return o;
    }

    /**
     * 按 pos 对齐两个数组并列出差异。
     *
     * @param valueKey 参与比较的值字段名（blocks 是 {@code blockId}+{@code meta}，TE 是 {@code class}）
     */
    private static int diffArray(JsonArray readback, JsonArray stored, String valueKey, JsonArray out) {
        if (stored == null) {
            return 0;
        }
        // 读回值按 pos 建索引（readBack 已按 pos 升序，但索引查找更稳）
        java.util.Map<String, JsonObject> live = new java.util.LinkedHashMap<String, JsonObject>();
        if (readback != null) {
            for (int i = 0; i < readback.size(); i++) {
                JsonObject e = readback.get(i)
                    .getAsJsonObject();
                live.put(posKey(e), e);
            }
        }
        int diffs = 0;
        for (int i = 0; i < stored.size(); i++) {
            JsonObject want = stored.get(i)
                .getAsJsonObject();
            JsonObject got = live.get(posKey(want));
            boolean same;
            if (got == null) {
                same = false;
            } else if ("blockId".equals(valueKey)) {
                same = Json.optInt(got, "blockId", -1) == Json.optInt(want, "blockId", -2)
                    && Json.optInt(got, "meta", -1) == Json.optInt(want, "meta", -2);
            } else {
                same = Json.optString(got, valueKey, "")
                    .equals(Json.optString(want, valueKey, ""));
            }
            if (same) {
                continue;
            }
            diffs++;
            if (out.size() < MAX_DIFF) {
                JsonObject d = new JsonObject();
                d.add("pos", Json.copy(Json.get(want, "pos")));
                if (got == null) {
                    d.addProperty("reason", "读回缺失（区块未加载或该位置已空）");
                }
                JsonObject wantV = new JsonObject();
                if ("blockId".equals(valueKey)) {
                    wantV.addProperty("blockId", Integer.valueOf(Json.optInt(want, "blockId", -1)));
                    wantV.addProperty("meta", Integer.valueOf(Json.optInt(want, "meta", -1)));
                } else {
                    wantV.addProperty(valueKey, Json.optString(want, valueKey, null));
                }
                d.add("stored", wantV);
                if (got != null) {
                    JsonObject gotV = new JsonObject();
                    if ("blockId".equals(valueKey)) {
                        gotV.addProperty("blockId", Integer.valueOf(Json.optInt(got, "blockId", -1)));
                        gotV.addProperty("meta", Integer.valueOf(Json.optInt(got, "meta", -1)));
                    } else {
                        gotV.addProperty(valueKey, Json.optString(got, valueKey, null));
                    }
                    d.add("actual", gotV);
                }
                out.add(d);
            }
        }
        return diffs;
    }

    private static String posKey(JsonObject e) {
        JsonArray p = Json.optArray(e, "pos");
        if (p == null || p.size() != 3) {
            return "?";
        }
        return p.get(0)
            .getAsInt() + ","
            + p.get(1)
                .getAsInt()
            + ","
            + p.get(2)
                .getAsInt();
    }

    /** 通用收尾：给结果对象补上 {@code sceneReadback}、动作名与契约留痕字段。 */
    public static JsonObject decorated(String action, JsonObject result, WorldServer world, Minecraft mc) {
        result.addProperty("action", action);
        result.add("sceneReadback", manifestReadback(world, mc));
        return result;
    }

    /**
     * 读一个数值参数（int 与 double 都收）；缺失返回 {@code null}，类型不符抛 {@code CP-VALID-002}。
     *
     * <p>
     * 为什么要这个而不是 {@code optInt}/{@code optLong}：那两个的语义是「缺失<b>或</b>类型不符都用
     * 默认值」——那会把「把 {@code health} 写成字符串」这类笔误静默变成默认值。可写参数的类型错误
     * 必须是显式失败（契约 §7.5 共同口径第 4 条「失败显式」）。
     */
    public static Double optNumber(ActionContext ctx, String name) {
        com.google.gson.JsonElement e = ctx.param(name);
        if (e == null) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            throw CpException.param("参数类型不符", name, "应为 number（收到 " + e + "）");
        }
        return Double.valueOf(e.getAsDouble());
    }

    /** 同 {@link #optNumber(ActionContext, String)}，但缺失时返回默认值。 */
    public static double optNumber(ActionContext ctx, String name, double def) {
        Double v = optNumber(ctx, name);
        return v == null ? def : v.doubleValue();
    }

    private static int size(com.google.gson.JsonArray a) {
        return a == null ? 0 : a.size();
    }
}
