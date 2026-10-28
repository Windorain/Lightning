package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;

/**
 * {@code world.rebuild}（scene，步进）：幂等重建托管世界。
 *
 * <p>
 * 参数：{@code folder}（必填，{@code cp_} 前缀）、{@code seed}（必填）、{@code void}（可选，v1 只许
 * true）、{@code base}（可选，{@code [x,y,z]}）、{@code settleTicks}（可选，默认 60）、
 * {@code build}（可选，构建段步骤，与用例文件的 build 段同一套解析器）、以及两个超时参数。
 *
 * <p>
 * 状态机在 {@link WorldRebuildRunner}（{@code case.run} 的 {@code world} 段共用同一实现）；
 * 本类只负责参数解析、run 目录与场景会话守卫。
 */
public final class WorldRebuildAction extends SteppingActionBase {

    private final ControlPlaneRuntime runtime;
    private WorldRebuildRunner runner;
    private Minecraft mc;
    private String lastRunnerStage;

    public WorldRebuildAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        // 捕获会话门控（contract.md §7.3 与 §7.5 第 3 条）：begin 之后禁止一切世界写动作，违规 CP-STATE-001
        CaptureControl.assertWorldWriteAllowed(ctx);
        mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        String folder = ctx.requireString("folder");
        if (!ManagedWorld.isManagedFolderName(folder)) {
            throw CpException
                .param("托管世界目录名非法", "folder", "须以 " + ManagedWorld.PREFIX + " 开头且只含 [A-Za-z0-9_.-]，收到: " + folder);
        }
        if (!ctx.has("seed")) {
            throw CpException.param("缺少必填参数", "seed", "必填（幂等重建要求固定种子）");
        }
        long seed = ctx.optLong("seed", 0L);
        if (ctx.has("void") && !ctx.optBool("void", true)) {
            throw CpException.param("v1 只支持虚空世界", "void", "只允许 true（C4）");
        }
        int[] base = optCoords(ctx, "base");
        int settleTicks = ctx.optInt("settleTicks", 60);
        if (settleTicks < 0) {
            throw CpException.param("静置 tick 数不得为负", "settleTicks", "收到: " + settleTicks);
        }
        JsonArray build = ctx.optArray("build");
        JsonArray normalized = CaseSources.normalizeBuild(folder, seed, base, settleTicks, build);

        WorldRebuildRunner.Spec spec = new WorldRebuildRunner.Spec();
        spec.folder = folder;
        spec.seed = seed;
        spec.base = base;
        spec.settleTicks = settleTicks;
        spec.displayName = ctx.optString("displayName", folder);
        spec.buildSteps = normalized;

        WorldRebuildRunner.assertManagedIfExists(mc.mcDataDir, folder);
        ctx.beginRun("world-rebuild");
        runner = new WorldRebuildRunner(spec, ctx);
        SceneSessionGuard.arm(mc);
        enterStage("rebuild");
        CpLog.info(
            "world.rebuild 开始：folder=%s seed=%d buildSteps=%d settleTicks=%d",
            folder,
            Long.valueOf(seed),
            Integer.valueOf(normalized.size()),
            Integer.valueOf(settleTicks));
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        // 内部阶段切换时重置阶段超时：进入世界（集成服启动 + 世界下发）单独计时
        String st = runner.stageName();
        if (!st.equals(lastRunnerStage)) {
            lastRunnerStage = st;
            enterStage("rebuild." + st.toLowerCase(java.util.Locale.ROOT));
        }
        JsonObject result = runner.tick(mc);
        if (result == null) {
            return null;
        }
        if (result.has("world")) {
            JsonObject world = Json.optObject(result, "world");
            if (world != null) {
                world.addProperty("forceLoaded", true);
            }
        }
        if (runtime != null && runtime.snapshotsRoot() != null) {
            result.addProperty(
                "snapshotsRoot",
                runtime.snapshotsRoot()
                    .toString());
        }
        return result;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        SceneSessionGuard.release(mc);
    }

    /** 读取可选坐标参数；缺失返回 null，形态非法抛 CP-VALID-002。 */
    static int[] optCoords(ActionContext ctx, String name) {
        JsonElement e = ctx.param(name);
        if (e == null) {
            return null;
        }
        if (!e.isJsonArray() || e.getAsJsonArray()
            .size() != 3) {
            throw CpException.param("坐标参数非法", name, "须为 [x,y,z] 三个整数");
        }
        JsonArray a = e.getAsJsonArray();
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()) {
                throw CpException.param("坐标分量非法", name + "[" + i + "]", "须为整数");
            }
            out[i] = v.getAsInt();
        }
        return out;
    }
}
