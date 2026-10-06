package com.lightning.mod.client.controlplane.mc.capture;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CameraSpec;
import com.lightning.mod.client.controlplane.core.CameraSpecs;
import com.lightning.mod.client.controlplane.core.CaptureSpec;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.ControlPlaneRuntime;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SceneSessionGuard;
import com.lightning.mod.client.controlplane.mc.SteppingActionBase;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code shot.multi}（forensic，步进）：多机位截图（contract.md §4.1）。
 *
 * <p>
 * 动作本身只做三件事：解析/校验参数、开 run 目录与会话守卫、把活交给
 * {@link ShotExecutor}（与 {@code case.run} 的 cameras 段<b>同一个</b>执行器）。
 * 这就是契约要求的「抽公共执行器，禁止复制逻辑」。
 *
 * <p>
 * 参数（契约 §4.1）：
 * <ul>
 * <li>{@code cameras}：机位表（必填，{@code [CameraSpec]} 或单个 CameraSpec 对象）；</li>
 * <li>{@code target}：观察目标包围盒（可选，仅留痕进观测记录/结果）；</li>
 * <li>{@code lighting}/{@code renderMode}/{@code worldTime}：会话默认（可选，可被机位覆盖）。</li>
 * </ul>
 */
public final class ShotMultiAction extends SteppingActionBase {

    private final ControlPlaneRuntime runtime;

    private CameraSpecs.Parsed parsed;
    private CaptureSpec capture;
    private JsonArray target;
    private ShotExecutor executor;
    private JsonObject executorResult;

    /** 进度回调（lambda 里不能用 this，故显式持有 ctx）。 */
    private ActionContext progressCtx;

    public ShotMultiAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        if (WorldRuntime.mc() == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        progressCtx = ctx;
        parsed = CameraSpecs.parseParam(ctx.params(), "cameras");
        parsed.throwIfAny(
            "shot.multi 机位参数非法（" + parsed.fields()
                .size() + " 处）");
        capture = mergeSessionDefaults(ctx.params());
        target = Json.optArray(ctx.params(), "target");
        ArtifactStore.Run run = ctx.beginRun("shot-multi");
        if (run == null) {
            throw new CpException(ErrorCodes.STATE, "无法创建 run 目录");
        }
        ShotExecutor.Input in = new ShotExecutor.Input();
        in.mc = WorldRuntime.mc();
        in.artifacts = ctx.artifacts();
        in.run = run;
        in.cameras = parsed.specs();
        in.capture = capture;
        in.target = target;
        in.jobId = ctx.job() == null ? null
            : ctx.job()
                .jobId();
        in.action = "shot.multi";
        in.progress = new ShotExecutor.Progress() {

            @Override
            public void onProgress(double fraction, String message) {
                progress(progressCtx, fraction, message);
            }
        };
        executor = new ShotExecutor(in);
        SceneSessionGuard.arm(in.mc);
        enterStage("shot.multi");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "shot.multi 开始: " + parsed.specs()
                .size() + " 个机位",
            Json.object(
                "runId",
                run.runId(),
                "cameraCount",
                parsed.specs()
                    .size(),
                "cameras",
                CameraSpecs.summaries(parsed.specs())));
        CpLog.info(
            "shot.multi 开始：%d 个机位 run=%s（lighting=%s renderMode=%s worldTime=%s）",
            parsed.specs()
                .size(),
            run.runId(),
            CameraSpecs.resolveLighting(null, capture),
            CameraSpecs.resolveRenderMode(null, capture),
            capture.hasWorldTime() ? Long.valueOf(capture.worldTime()) : "keep");
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        if (executorResult != null) {
            return executorResult;
        }
        if (executor == null) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "截图执行器未初始化");
        }
        JsonObject r = executor.tick();
        if (r == null) {
            return null;
        }
        executorResult = decorate(ctx, r);
        return executorResult;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        try {
            if (executor != null) {
                executor.abort();
            }
        } catch (Throwable t) {
            CpLog.warn("shot.multi 收尾失败: %s", String.valueOf(t));
        } finally {
            SceneSessionGuard.release(WorldRuntime.mc());
        }
    }

    /** 结果补充：契约要求的每机位产物引用 + 实际渲染参数 + 会话信息。 */
    private JsonObject decorate(ActionContext ctx, JsonObject result) {
        result.addProperty(
            "runId",
            ctx.run() == null ? null
                : ctx.run()
                    .runId());
        if (target != null) {
            result.add("target", Json.copyArray(target));
        }
        JsonObject session = CaptureActions.status();
        session.addProperty("declaredHere", Boolean.FALSE);
        result.add("captureSession", session);
        JsonArray cameras = Json.optArray(result, "cameras");
        JsonArray refs = new JsonArray();
        for (int i = 0; cameras != null && i < cameras.size(); i++) {
            JsonObject c = cameras.get(i)
                .getAsJsonObject();
            JsonObject ref = new JsonObject();
            ref.addProperty("name", Json.optString(c, "name", null));
            ref.addProperty("ok", Boolean.valueOf(Json.optBool(c, "ok", false)));
            ref.addProperty("file", Json.optString(c, "file", null));
            ref.addProperty("metaFile", Json.optString(c, "metaFile", null));
            ref.addProperty("tilesDir", Json.optString(c, "tilesDir", null));
            ref.addProperty("width", Integer.valueOf(Json.optInt(c, "width", -1)));
            ref.addProperty("height", Integer.valueOf(Json.optInt(c, "height", -1)));
            ref.addProperty("renderMode", Json.optString(c, "renderMode", null));
            ref.addProperty("lighting", Json.optString(c, "lighting", null));
            ref.addProperty("worldTime", Long.valueOf(Json.optLong(c, "worldTime", -1L)));
            ref.addProperty("tile", Boolean.valueOf(Json.optBool(c, "tile", false)));
            refs.add(ref);
        }
        result.add("artifactsByCamera", refs);
        result.addProperty(
            "generatedAt",
            TimeSource.system()
                .isoNow());
        result.add("warnings", executor == null ? new JsonArray() : executor.warnings());
        if (ctx.run() != null) {
            result.add(
                "artifacts",
                ctx.run()
                    .artifactsJson());
        }
        result.addProperty("contractVersion", com.lightning.mod.client.controlplane.core.Contract.VERSION);
        return result;
    }

    /** 会话默认值：{@code capture} 段优先，顶层同名参数兜底（两条写法都合法）。 */
    private static CaptureSpec mergeSessionDefaults(JsonObject params) {
        JsonObject declared = Json.optObject(params, "capture");
        JsonObject merged = declared == null ? new JsonObject() : Json.copyObject(declared);
        if (declared == null) {
            for (String key : new String[] { "lighting", "renderMode", "worldTime" }) {
                if (params.has(key)) {
                    merged.add(key, Json.copy(params.get(key)));
                }
            }
        }
        return CaptureSpec.parseOrThrow(merged, "capture");
    }

    /** 机位表（结果留痕用）。 */
    public JsonArray cameraSummaries() {
        return parsed == null ? new JsonArray() : CameraSpecs.summaries(parsed.specs());
    }

    /** 机位规格（供 case.run 复用同一解析结果）。 */
    public java.util.List<CameraSpec> cameras() {
        return parsed == null ? new java.util.ArrayList<CameraSpec>() : parsed.specs();
    }

    /** 退出码辅助：是否有失败机位。 */
    public boolean hasFailures() {
        if (executorResult == null) {
            return false;
        }
        return Json.optInt(executorResult, "failedCount", 0) > 0;
    }
}
