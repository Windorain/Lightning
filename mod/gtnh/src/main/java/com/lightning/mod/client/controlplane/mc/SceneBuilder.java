package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * 场景构建器：在<b>服务端权威世界</b>（{@code MinecraftServer.getServer().worldServers[0]}）
 * 上按用例的 build 段铺场景，并产出场景清单（{@link SceneManifest}）。
 *
 * <h2>固定完成序（contract.md §6.3）</h2>
 * <ol>
 * <li><b>步骤执行</b>：{@code clear}（区域 {@code setBlockToAir}）/ {@code block}
 * （{@code world.setBlock(x,y,z,block,meta,3)}）/ {@code wait}（tick 计数）按声明序执行；</li>
 * <li><b>TE 补全</b>：{@code te} 步经 {@link TeCompleters} 走权威同步路径；本 tick 补不上的
 * 会进入重试阶段（最长 {@link #TE_RETRY_TICKS} tick），仍然补不上则记入清单 {@code mismatches}；</li>
 * <li>{@code markBlockRangeForRenderUpdate}（覆盖全部被触碰位置的并集包围盒）；</li>
 * <li><b>静置</b> {@code settleTicks} tick（给客户端渲染与 S35 摄取留时间）。</li>
 * </ol>
 *
 * <p>
 * 本类<b>不阻塞</b>：{@link #tick} 每 tick 调用一次，处理有限量工作后返回；返回非 null 即完成。
 * 每 tick 的工作量上限（{@link #STEPS_PER_TICK}/{@link #CLEAR_BLOCKS_PER_TICK}）是为了不让一次
 * 大范围清场卡住客户端 tick 线程。
 *
 * <p>
 * 输入步骤必须<b>已归一化</b>（坐标为绝对坐标）：{@code case.run} 用
 * {@code CaseParser}+{@code CaseValidator} 的产物；{@code world.rebuild} 的 {@code build} 参数
 * 也走同一套解析器（见 {@link CaseSources}），因此两个入口共用同一份实现。
 */
public final class SceneBuilder {

    /** 每 tick 最多执行的步骤数（不含 clear 的方块量）。 */
    public static final int STEPS_PER_TICK = 64;

    /** 每 tick 最多清场的方块数。 */
    public static final int CLEAR_BLOCKS_PER_TICK = 16384;

    /** TE 补全重试上限（tick）。 */
    public static final int TE_RETRY_TICKS = 40;

    /** 内部阶段。 */
    private enum Stage {
        /** 步骤执行。 */
        STEPS,
        /** TE 补全重试。 */
        TE_RETRY,
        /** 渲染范围刷新 + 静置前的收尾。 */
        RENDER_UPDATE,
        /** 静置。 */
        SETTLE,
        /** 完成。 */
        DONE
    }

    /** 一条 te 步的补全状态。 */
    private static final class TeSpec {

        final int[] pos;
        final String completer;
        final JsonObject params;
        boolean completed;

        TeSpec(int[] pos, String completer, JsonObject params) {
            this.pos = pos;
            this.completer = completer;
            this.params = params == null ? new JsonObject() : params;
        }
    }

    /** 清场游标（跨 tick 续跑，避免一次大范围清场卡住 tick 线程）。 */
    private static final class ClearCursor {

        private final int[] from;
        private final int[] to;
        private final int[] cur;

        ClearCursor(int[] from, int[] to) {
            this.from = from.clone();
            this.to = to.clone();
            this.cur = from.clone();
        }

        /** 当前坐标。 */
        int[] cur() {
            return cur;
        }

        /** 前进一步；越界返回 false（整段清场结束）。 */
        boolean advance() {
            cur[2]++;
            if (cur[2] <= to[2]) {
                return true;
            }
            cur[2] = from[2];
            cur[1]++;
            if (cur[1] <= to[1]) {
                return true;
            }
            cur[1] = from[1];
            cur[0]++;
            return cur[0] <= to[0];
        }
    }

    private final JsonArray steps;
    private final String folder;
    private final long seed;
    private final boolean isVoid;
    private final int settleTicks;

    private final List<TeSpec> teSpecs = new ArrayList<TeSpec>();
    private final JsonArray blocks = new JsonArray();
    private final JsonArray mismatches = new JsonArray();

    private Stage stage = Stage.STEPS;
    private int index;
    private int waitLeft;
    private int teRetryLeft = TE_RETRY_TICKS;
    private int settleLeft;
    private ClearCursor clear;
    private int[] bboxMin;
    private int[] bboxMax;
    private JsonObject manifest;

    /**
     * @param steps       已归一化的 build 步骤（绝对坐标）
     * @param folder      托管世界目录名（写进清单）
     * @param seed        种子（写进清单）
     * @param isVoid      是否虚空世界（写进清单）
     * @param settleTicks 静置 tick 数（≥0）
     */
    public SceneBuilder(JsonArray steps, String folder, long seed, boolean isVoid, int settleTicks) {
        this.steps = steps == null ? new JsonArray() : steps;
        this.folder = folder;
        this.seed = seed;
        this.isVoid = isVoid;
        this.settleTicks = Math.max(0, settleTicks);
    }

    /** 步骤总数（进度分母）。 */
    public int stepCount() {
        return steps.size();
    }

    /** 已完成（含跳过的）步骤数（进度分子，近似）。 */
    public int doneSteps() {
        return Math.min(index, steps.size());
    }

    /** 是否已完成。 */
    public boolean isFinished() {
        return stage == Stage.DONE;
    }

    /** 场景清单；未完成时为 null。 */
    public JsonObject manifest() {
        return manifest == null ? null : manifest.deepCopy();
    }

    /** 已记录的不一致（副本）。 */
    public JsonArray mismatches() {
        return mismatches.deepCopy();
    }

    /**
     * 推进一步。
     *
     * @param world 服务端权威世界（不可为 null）
     * @return 完成时的场景清单；未完成返回 null
     * @throws CpException CP-VALID-002 步骤非法；CP-EXEC-001 方块放置失败
     */
    public JsonObject tick(WorldServer world) throws Exception {
        if (world == null) {
            throw new CpException(ErrorCodes.STATE, "服务端世界不可用（未进入世界或集成服未起）");
        }
        if (stage == Stage.DONE) {
            return manifest();
        }
        if (waitLeft > 0) {
            waitLeft--;
            return null;
        }
        switch (stage) {
            case STEPS:
                runSteps(world);
                break;
            case TE_RETRY:
                runTeRetry(world);
                break;
            case RENDER_UPDATE:
                markRenderUpdate(world);
                stage = Stage.SETTLE;
                settleLeft = settleTicks;
                return null;
            case SETTLE:
                if (settleLeft > 0) {
                    settleLeft--;
                    return null;
                }
                finish(world);
                return manifest();
            default:
                return manifest();
        }
        return null;
    }

    // ------------------------------------------------------------ 阶段实现

    private void runSteps(WorldServer world) throws Exception {
        int ops = 0;
        while (true) {
            if (clear != null) {
                ops += clearChunk(world);
                if (ops >= CLEAR_BLOCKS_PER_TICK || clear != null) {
                    return;
                }
                continue;
            }
            if (index >= steps.size()) {
                stage = Stage.TE_RETRY;
                return;
            }
            JsonElement e = steps.get(index);
            if (e == null || !e.isJsonObject()) {
                throw CpException.param("构建步骤非法", "build[" + index + "]", "步骤须为 object");
            }
            JsonObject step = e.getAsJsonObject();
            String op = Json.optString(step, "op", null);
            if (op == null) {
                throw CpException.param("构建步骤非法", "build[" + index + "].op", "缺失");
            }
            switch (op) {
                case "clear": {
                    int[] from = coords(step, "from", index);
                    int[] to = coords(step, "to", index);
                    markBbox(from);
                    markBbox(to);
                    if (from[0] > to[0] || from[1] > to[1] || from[2] > to[2]) {
                        throw CpException.param("清场范围非法", "build[" + index + "]", "from 必须 <= to（逐轴）");
                    }
                    clear = new ClearCursor(from, to);
                    continue;
                }
                case "block": {
                    int[] at = coords(step, "at", index);
                    String id = Json.optString(step, "id", null);
                    if (id == null || id.trim()
                        .isEmpty()) {
                        throw CpException.param("缺少方块 id", "build[" + index + "].id", "必填");
                    }
                    int meta = Json.optInt(step, "meta", 0);
                    placeBlock(world, at, id, meta, index);
                    markBbox(at);
                    index++;
                    break;
                }
                case "te": {
                    int[] at = coords(step, "at", index);
                    String completer = Json.optString(step, "completer", null);
                    TeCompleter c = TeCompleters.get(completer);
                    if (c == null) {
                        throw CpException.param(
                            "未知 TE 补全器",
                            "build[" + index + "].completer",
                            "v1 已注册: " + TeCompleters.names() + "，收到: " + completer);
                    }
                    JsonObject params = Json.optObject(step, "params");
                    TeSpec spec = new TeSpec(at, completer, params);
                    try {
                        spec.completed = c.complete(world, at[0], at[1], at[2], spec.params);
                    } catch (CpException ex) {
                        throw ex;
                    } catch (Throwable t) {
                        throw new CpException(
                            ErrorCodes.EXEC_FAILED,
                            "TE 补全失败（" + completer + " @ " + at[0] + "," + at[1] + "," + at[2] + "）: " + t);
                    }
                    teSpecs.add(spec);
                    markBbox(at);
                    index++;
                    break;
                }
                case "wait": {
                    int ticks = Json.optInt(step, "ticks", 0);
                    index++;
                    if (ticks > 0) {
                        waitLeft = ticks;
                        return;
                    }
                    break;
                }
                default:
                    throw CpException.param("未知构建 op", "build[" + index + "].op", "收到: " + op);
            }
            if (++ops >= STEPS_PER_TICK) {
                return;
            }
        }
    }

    /** 本轮清场若干方块；返回本轮实际清掉的方块数（至少 1，避免空转）。 */
    private int clearChunk(WorldServer world) {
        int done = 0;
        while (clear != null && done < CLEAR_BLOCKS_PER_TICK) {
            int[] c = clear.cur();
            world.setBlockToAir(c[0], c[1], c[2]);
            done++;
            if (!clear.advance()) {
                clear = null;
                index++;
            }
        }
        return done <= 0 ? 1 : done;
    }

    private void runTeRetry(WorldServer world) {
        boolean allDone = true;
        for (TeSpec spec : teSpecs) {
            if (spec.completed) {
                continue;
            }
            TeCompleter c = TeCompleters.get(spec.completer);
            if (c != null) {
                try {
                    spec.completed = c.complete(world, spec.pos[0], spec.pos[1], spec.pos[2], spec.params);
                } catch (Throwable t) {
                    CpLog.warn(
                        "TE 补全重试异常（%s @ %d,%d,%d）: %s",
                        spec.completer,
                        spec.pos[0],
                        spec.pos[1],
                        spec.pos[2],
                        String.valueOf(t));
                }
            }
            allDone &= spec.completed;
        }
        if (allDone || --teRetryLeft <= 0) {
            stage = Stage.RENDER_UPDATE;
        }
    }

    private void markRenderUpdate(WorldServer world) {
        if (bboxMin == null || bboxMax == null) {
            return;
        }
        world.markBlockRangeForRenderUpdate(bboxMin[0], bboxMin[1], bboxMin[2], bboxMax[0], bboxMax[1], bboxMax[2]);
    }

    private void finish(WorldServer world) {
        JsonArray teArr = new JsonArray();
        for (TeSpec spec : teSpecs) {
            TileEntity te = world.getTileEntity(spec.pos[0], spec.pos[1], spec.pos[2]);
            String cls = te == null ? SceneManifest.ABSENT
                : te.getClass()
                    .getName();
            teArr.add(SceneManifest.teEntry(spec.pos, cls));
            if (te == null) {
                mismatches.add(
                    SceneManifest.mismatch(
                        spec.pos,
                        "te",
                        Json.object("completer", spec.completer),
                        Json.object("class", SceneManifest.ABSENT)));
            }
        }
        JsonObject m = new JsonObject();
        m.addProperty("schema", SceneManifest.SCHEMA);
        m.addProperty("folder", folder);
        m.addProperty("seed", seed);
        m.addProperty("void", isVoid);
        m.addProperty("generatorOptions", VoidWorldPreset.GENERATOR_OPTIONS);
        m.addProperty("stepCount", steps.size());
        m.addProperty("settleTicks", settleTicks);
        m.add("blocks", blocks.deepCopy());
        m.add("tileEntities", teArr);
        if (mismatches.size() > 0) {
            m.add("mismatches", mismatches.deepCopy());
        }
        m.addProperty("sha256", SceneManifest.hash(m));
        manifest = m;
        stage = Stage.DONE;
    }

    // ------------------------------------------------------------ 基元

    /** 放一个方块并把「世界实际值」记进清单（与请求值不符则记 mismatch）。 */
    private void placeBlock(WorldServer world, int[] at, String id, int meta, int stepIndex) {
        Block block = resolveBlock(id, stepIndex);
        boolean ok;
        try {
            ok = world.setBlock(at[0], at[1], at[2], block, meta, 3);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "放置方块失败（" + id + " @ " + at[0] + "," + at[1] + "," + at[2] + "）: " + t);
        }
        Block live = world.getBlock(at[0], at[1], at[2]);
        int wantId = Block.getIdFromBlock(block);
        int liveId = live == null ? 0 : Block.getIdFromBlock(live);
        int liveMeta = live == null ? 0 : world.getBlockMetadata(at[0], at[1], at[2]);
        blocks.add(SceneManifest.blockEntry(at, liveId, liveMeta, id));
        if (!ok || liveId != wantId || liveMeta != meta) {
            mismatches.add(
                SceneManifest.mismatch(
                    at,
                    "block",
                    Json.object("id", id, "blockId", wantId, "meta", meta),
                    Json.object("blockId", liveId, "meta", liveMeta)));
            CpLog.warn(
                "放置结果与世界不一致：%s @ %d,%d,%d 期望 id=%d meta=%d，实际 id=%d meta=%d（setBlock=%s）",
                id,
                at[0],
                at[1],
                at[2],
                wantId,
                meta,
                liveId,
                liveMeta,
                String.valueOf(ok));
        }
    }

    /** 解析方块：{@code GameRegistry.findBlock} 优先，回落 {@code Block.getBlockFromName}。 */
    private static Block resolveBlock(String id, int stepIndex) {
        String s = id.trim();
        String modId = "minecraft";
        String name = s;
        int colon = s.indexOf(':');
        if (colon > 0) {
            modId = s.substring(0, colon);
            name = s.substring(colon + 1);
        }
        Block b = null;
        try {
            b = GameRegistry.findBlock(modId, name);
        } catch (Throwable t) {
            CpLog.warn("GameRegistry.findBlock(%s,%s) 失败: %s", modId, name, String.valueOf(t));
        }
        if (b == null) {
            try {
                b = Block.getBlockFromName(s);
            } catch (Throwable t) {
                CpLog.warn("Block.getBlockFromName(%s) 失败: %s", s, String.valueOf(t));
            }
        }
        if (b == null) {
            throw CpException
                .param("未知方块", "build[" + stepIndex + "].id", "注册表里没有该方块: " + id + "（尝试 " + modId + ":" + name + "）");
        }
        return b;
    }

    private static int[] coords(JsonObject step, String key, int stepIndex) {
        JsonArray a = Json.optArray(step, key);
        if (a == null || a.size() != 3) {
            throw CpException.param("坐标缺失或非法", "build[" + stepIndex + "]." + key, "须为已归一化的绝对坐标 [x,y,z]");
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()) {
                throw CpException.param("坐标分量非法", "build[" + stepIndex + "]." + key + "[" + i + "]", "须为整数");
            }
            out[i] = v.getAsInt();
        }
        return out;
    }

    private void markBbox(int[] p) {
        if (p == null) {
            return;
        }
        if (bboxMin == null) {
            bboxMin = p.clone();
            bboxMax = p.clone();
            return;
        }
        for (int i = 0; i < 3; i++) {
            bboxMin[i] = Math.min(bboxMin[i], p[i]);
            bboxMax[i] = Math.max(bboxMax[i], p[i]);
        }
    }
}
