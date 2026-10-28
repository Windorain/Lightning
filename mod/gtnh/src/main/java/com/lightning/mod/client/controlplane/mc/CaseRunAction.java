package com.lightning.mod.client.controlplane.mc;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.client.Minecraft;
import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CameraSpecs;
import com.lightning.mod.client.controlplane.core.CaptureSession;
import com.lightning.mod.client.controlplane.core.CaptureSpec;
import com.lightning.mod.client.controlplane.core.CaseFile;
import com.lightning.mod.client.controlplane.core.CaseParser;
import com.lightning.mod.client.controlplane.core.CaseValidator;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.CriteriaEngine;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.ObservationRecord;
import com.lightning.mod.client.controlplane.core.SteppingAction;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;
import com.lightning.mod.client.controlplane.mc.capture.ShotExecutor;
import com.lightning.mod.client.controlplane.mc.player.PlayerSession;

/**
 * {@code case.run}（scene 起，步进）：执行声明式用例。
 *
 * <h2>整跑 = 按段，同一实现</h2>
 * 段执行函数只有一个：{@code segments} 参数只决定<b>跑哪几段</b>，不改变每段怎么跑。默认整跑
 * （{@code world→build→criteria→evidence}），段的执行顺序恒为契约顺序。每段产出
 * {@code segments/<name>.json}；判据汇总 {@code criteria.json}；观测记录 {@code observation.json}。
 *
 * <h2>产物与结论的分工</h2>
 * <ul>
 * <li>{@code criteria.json}：{@link CriteriaEngine} 对 {@code criteria} 段的判据结论（纯判据）；</li>
 * <li>{@code evidence.json}：{@code evidence} 段的期望证据核对结论（core 的
 * {@code checkEvidence}，id 固定 {@code evidence-complete}）；</li>
 * <li>{@code observation.json}：{@link ObservationCollector} 的观测记录（A10）。</li>
 * </ul>
 * 三个文件各写一次、互不覆盖；「本次 run 到底绿没绿」由作业结果里的
 * {@code overall}（criteria 与 evidence 的合并结论）给出。这样 {@code criteria.json} 的语义
 * 始终是「用例声明的判据」，不会混进 runner 侧的核对结论。
 *
 * <p>
 * 变体（{@code variant}）先用 RFC 6902 子集补丁改写用例，再用<b>同一实现</b>跑一遍，
 * 最后逐条断言 {@code expectCriteriaRed} 指定的判据确实变红；没变红即本作业失败。
 */
public final class CaseRunAction extends SteppingActionBase {

    /** 段名：世界。 */
    public static final String SEG_WORLD = "world";

    /** 段名：捕获会话（1.1）。 */
    public static final String SEG_CAPTURE = "capture";

    /** 段名：场景构建。 */
    public static final String SEG_BUILD = "build";

    /** 段名：读面（v1.3）。 */
    public static final String SEG_READ = "read";

    /** 段名：L2 编排（v1.6）。 */
    public static final String SEG_ACTION = "action";

    /** 段名：机位拍摄（1.1）。 */
    public static final String SEG_CAMERAS = "cameras";

    /** 段名：判据。 */
    public static final String SEG_CRITERIA = "criteria";

    /** 段名：期望证据核对。 */
    public static final String SEG_EVIDENCE = "evidence";

    /** 判据结论文档内路径。 */
    public static final String CRITERIA_PATH = "criteria.json";

    /** 期望证据结论文档内路径。 */
    public static final String EVIDENCE_PATH = "evidence.json";

    /** 观测记录文档内路径。 */
    public static final String OBSERVATION_PATH = "observation.json";

    private final ControlPlaneRuntime runtime;

    private Minecraft mc;
    private CaseFile caseFile;
    private JsonObject plan;
    private final List<String> segments = new ArrayList<String>();
    private final List<String> skippedSegments = new ArrayList<String>();
    private final JsonArray deferred = new JsonArray();
    private final JsonArray segmentRecords = new JsonArray();

    private String variantId;
    private List<String> expectRed = new ArrayList<String>();
    private JsonObject variantVerification;

    private int segIndex;
    private boolean segmentStarted;
    private long segmentStartMillis;

    private WorldRebuildRunner runner;
    private JsonObject worldResult;
    private String lastWorldStage;

    private SceneBuilder builder;
    private JsonObject manifest;
    private JsonObject regeneratedManifest;
    private final JsonArray variants = new JsonArray();
    private boolean variantFailed;

    private CriteriaEngine engine;
    private JsonObject criteriaDoc;
    private JsonObject evidenceDoc;

    /** capture 段解析出的会话（1.1）。 */
    private CaptureSpec captureSpec;
    private boolean captureArmed;
    /** 本用例声明了哪些机位（cameras 段的规范化数组）。 */
    private JsonArray captureCameras;

    /**
     * {@code action} 段的步骤推进器（v1.8）：跨 tick 的输入步在它里面推进，
     * 收尾释放也经它（见 {@link ActionStepDriver#finish}）。
     */
    private ActionStepDriver actionDriver;

    /**
     * 输入族「全清所持按下态」的动作名（v1.8）。
     *
     * <p>
     * 段内失败/阶段超时/段异常的释放路径<b>经这个动作</b>走，而不是直接 import 输入运行时的实现：
     * 释放因此与用例作者能写的 {@code input.release} 步骤是<b>同一份实现</b>（用例作者能写的那一步就是它，
     * 不存在第二条释放语义），且本文件不必耦合 {@code mc/input} 的内部结构（那是运行时侧的面）。
     */
    public static final String INPUT_RELEASE_ACTION = "input.release";

    /** 段名（v1.6）。 */
    public static final String SEG_EXPORT = "export";

    /** cameras 段：与 shot.multi 共用的执行器（禁止复制逻辑）。 */
    private ShotExecutor shotExecutor;
    private JsonObject shotResult;
    private JsonArray cameraSummaries = new JsonArray();

    private boolean finalized;
    private JsonObject failure;

    public CaseRunAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        caseFile = CaseSources.resolve(ctx, runtime.casesRoot());

        String variantParam = ctx.optString("variant", null);
        if (variantParam != null && !variantParam.trim()
            .isEmpty()) {
            applyVariant(variantParam.trim());
        }
        // 指定 variant 时 caseFile 已是补丁产物：适用性判定交给 CaseSources.resolve 在原始文件上
        // 做过的那一遍（ENFORCE）；这里用 SKIP，否则同一补丁在本文件上必然空转 → CP-VALID-002 误报。
        plan = new CaseValidator()
            .plan(caseFile, variantId == null ? CaseValidator.VariantCheck.ENFORCE : CaseValidator.VariantCheck.SKIP);
        JsonArray all = Json.optArray(plan, "segments");
        JsonArray requested = ctx.optArray("segments");
        if (requested == null) {
            for (int i = 0; all != null && i < all.size(); i++) {
                segments.add(
                    all.get(i)
                        .getAsString());
            }
        } else {
            Set<String> wanted = new LinkedHashSet<String>();
            Fields fields = new Fields();
            for (int i = 0; i < requested.size(); i++) {
                JsonElement e = requested.get(i);
                if (e == null || !e.isJsonPrimitive()
                    || !e.getAsJsonPrimitive()
                        .isString()) {
                    fields.add("segments[" + i + "]", "须为字符串");
                    continue;
                }
                String name = e.getAsString();
                if (all == null || !contains(all, name)) {
                    fields.add("segments[" + i + "]", "未知段名: " + name + "（可用 " + all + "）");
                    continue;
                }
                wanted.add(name);
            }
            fields.throwIfAny("segments 参数非法");
            for (int i = 0; all != null && i < all.size(); i++) {
                String name = all.get(i)
                    .getAsString();
                if (wanted.contains(name)) {
                    segments.add(name);
                } else {
                    skippedSegments.add(name);
                }
            }
        }
        for (String s : Arrays.asList(
            SEG_WORLD,
            SEG_CAPTURE,
            SEG_BUILD,
            SEG_READ,
            SEG_ACTION,
            SEG_EXPORT,
            SEG_CAMERAS,
            SEG_CRITERIA,
            SEG_EVIDENCE)) {
            if (!segments.contains(s) && !skippedSegments.contains(s)) {
                skippedSegments.add(s);
            }
        }

        // case-file.md §4：含 cameras 段的用例必须 forensic 级调用（运行期按内容升格检查）
        assertForensicForCameras(ctx);

        JsonArray deferredSegments = CaseValidateAction.deferredSegments(caseFile);
        for (int i = 0; i < deferredSegments.size(); i++) {
            deferred.add(deferredSegments.get(i));
        }
        if (variantId != null && !segments.contains(SEG_CRITERIA)) {
            throw CpException
                .param("变体校验需要 criteria 段", "segments", "指定 variant 时必须包含 criteria 段（否则无从判定 expectCriteriaRed 是否变红）");
        }

        ArtifactStore.Run run = ctx.beginRun(caseFile.id());
        writeCaseArtifacts(ctx, run);
        // 段记录在开跑前先落「未跑」的两类（延后/未请求），保证任何时刻 segments/ 都是全的
        for (int i = 0; i < deferred.size(); i++) {
            JsonObject note = deferred.get(i)
                .getAsJsonObject();
            String seg = Json.optString(note, "segment", null);
            recordSegment(ctx, seg == null ? "deferred" : seg, "deferred", note);
            ctx.emit(
                EventStream.LEVEL_WARN,
                EventStream.Kinds.CASE_SEGMENT,
                "段延后（deferred: contract v1.x）: " + seg,
                note);
        }
        for (String s : skippedSegments) {
            JsonObject note = new JsonObject();
            note.addProperty("reason", "未在 segments 参数中请求");
            recordSegment(ctx, s, "skipped", note);
        }
        SceneSessionGuard.arm(mc);
        enterStage("case.init");
        CpLog.info(
            "case.run 开始：caseId=%s segments=%s variant=%s runId=%s",
            caseFile.id(),
            segments.toString(),
            variantId,
            run.runId());
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "用例执行开始: " + caseFile.id(),
            Json.object(
                "caseId",
                caseFile.id(),
                "runId",
                run.runId(),
                "segments",
                toJsonArray(segments),
                "variant",
                variantId,
                "deferredCount",
                Integer.valueOf(deferred.size())));
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        try {
            return advanceInternal(ctx);
        } catch (CpException e) {
            failure = e.toErrorJson();
            finalizeBestEffort(ctx);
            throw e;
        } catch (Throwable t) {
            JsonObject err = new JsonObject();
            err.addProperty("code", ErrorCodes.EXEC_FAILED);
            err.addProperty("message", String.valueOf(t));
            JsonObject c = new JsonObject();
            c.addProperty(
                "exception",
                t.getClass()
                    .getName());
            err.add("context", c);
            failure = err;
            finalizeBestEffort(ctx);
            throw t;
        }
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        // 会话标志必须无泄漏地释放：动作在失败/异常路径上也会走到这里，而「世界写动作被永久封住」
        // 比一次拍摄失败严重得多（后续所有 world.*/case.run 都会被 CP-STATE-001 拒掉）。
        try {
            if (captureArmed) {
                CaptureSession.end();
                captureArmed = false;
                CpLog.warn("case.run 收尾：捕获会话未按段序释放，已在 onFinish 兜底释放");
            }
        } catch (Throwable t) {
            CpLog.warn("case.run 释放捕获会话失败: %s", String.valueOf(t));
        } finally {
            SceneSessionGuard.release(mc);
            // 输入步的释放路径（input-contract.md §3.4 路径 1/2/3）：本段碰过输入设施就全清所持按下态——
            // 失败/阶段超时/段异常三条路径都会经过本方法（SteppingActionBase.step 的 finally），
            // 因此「步进动作被中途抛弃」不会留下按下的键。幂等：正常完成路径重复调用无害。
            if (actionDriver != null) {
                try {
                    actionDriver.finish(ctx, failure != null);
                } catch (Throwable t) {
                    CpLog.warn("case.run 收尾释放输入所持按下态失败: %s", String.valueOf(t));
                }
            }
        }
    }

    /**
     * 释放本段碰过的输入设施所持按下态（输入步的收尾路径；幂等）。
     *
     * <h2>为什么经注册表走 {@code input.release}，而不是直接调输入运行时</h2>
     * ①用例作者能写的释放步骤就是它，收尾释放走同一份实现 ⇒ 不存在第二条释放语义（无隐藏通道）；
     * ②本文件因此不必耦合 {@code mc/input} 的内部结构。未注册时记一条 warn 事件并如实说明兜底：
     * 设施对每个持有点都有 1200 tick 的到期自动抬起，因此<b>不会</b>留下永久按下的键。
     */
    private void releaseInputState(ActionContext ctx, String reason) {
        if (actionDriver == null || actionDriver.inputSteps() == 0 || runtime == null || ctx == null) {
            // 本段没碰过输入设施（不含输入步的用例）：一个字节的行为都不变
            return;
        }
        com.lightning.mod.client.controlplane.core.ActionRegistry.Entry entry = runtime.actions()
            .lookup(INPUT_RELEASE_ACTION);
        if (entry == null || entry.isStepping() || entry.action() == null) {
            ctx.emit(
                EventStream.LEVEL_WARN,
                EventStream.Kinds.CASE_SEGMENT,
                "输入步收尾未释放：本树未注册 " + INPUT_RELEASE_ACTION + "（持有点由设施的 1200 tick 到期自动抬起兜底）",
                Json.object(
                    "action",
                    INPUT_RELEASE_ACTION,
                    "reason",
                    reason,
                    "inputSteps",
                    Integer.valueOf(actionDriver.inputSteps())));
            return;
        }
        JsonObject r = entry.action()
            .execute(ctx.withParams(new JsonObject()));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "输入步收尾释放: " + INPUT_RELEASE_ACTION,
            Json.object(
                "reason",
                reason,
                "inputSteps",
                Integer.valueOf(actionDriver.inputSteps()),
                "released",
                Integer.valueOf(Json.optInt(r, "count", -1))));
    }

    private JsonObject advanceInternal(ActionContext ctx) throws Exception {
        if (segIndex >= segments.size()) {
            return finalizeRun(ctx);
        }
        String seg = segments.get(segIndex);
        if (!segmentStarted) {
            segmentStarted = true;
            segmentStartMillis = System.currentTimeMillis();
            enterStage("case." + seg);
            ctx.emit(
                EventStream.LEVEL_INFO,
                EventStream.Kinds.CASE_SEGMENT,
                "段开始: " + seg,
                Json.object(
                    "segment",
                    seg,
                    "phase",
                    "start",
                    "runId",
                    ctx.run() == null ? null
                        : ctx.run()
                            .runId()));
        }
        JsonObject detail = null;
        switch (seg) {
            case SEG_WORLD:
                detail = stepWorld(ctx);
                break;
            case SEG_CAPTURE:
                detail = stepCapture(ctx);
                break;
            case SEG_BUILD:
                detail = stepBuild(ctx);
                break;
            case SEG_READ:
                detail = stepRead(ctx);
                break;
            case SEG_ACTION:
                detail = stepAction(ctx);
                break;
            case SEG_EXPORT:
                detail = stepExport(ctx);
                break;
            case SEG_CAMERAS:
                detail = stepCameras(ctx);
                break;
            case SEG_CRITERIA:
                detail = stepCriteria(ctx);
                break;
            case SEG_EVIDENCE:
                detail = stepEvidence(ctx);
                break;
            default:
                throw new CpException(ErrorCodes.EXEC_FAILED, "未知段: " + seg);
        }
        if (detail == null) {
            return null;
        }
        recordSegment(ctx, seg, "ok", detail);
        segmentStarted = false;
        segIndex++;
        return null;
    }

    // ------------------------------------------------------------ 各段

    /**
     * {@code world} 段：同 {@code world.rebuild} 的实现（{@link WorldRebuildRunner}），不带构建段。
     *
     * <p>
     * <b>本段不收口标记</b>（{@code markComplete=false}）：本段后面还有独立的 {@code build} 段，
     * 场景尚未铺。若本段就把标记写成 {@code complete:true}，随后的 build 段失败会留下
     * 「标记说完成、场景只铺了一半」的世界——下游（{@code world.snapshot} 的成品复用门）会误判为
     * 可复用。收口点因此落在 build 段成功之后（见 {@link #stepBuild}）；用例没有 build 段时，
     * 本段就是完整的世界重建，此时如实收口（下面按 {@code segments} 判定）。
     */
    private JsonObject stepWorld(ActionContext ctx) throws Exception {
        if (runner == null) {
            JsonObject w = Json.optObject(plan, "world");
            WorldRebuildRunner.Spec spec = new WorldRebuildRunner.Spec();
            spec.folder = Json.optString(w, "folder", null);
            spec.seed = Json.optLong(w, "seed", 0L);
            spec.base = toIntArray(Json.optArray(w, "base"));
            spec.displayName = spec.folder;
            spec.buildSteps = new JsonArray();
            // 后面还有 build 段时不在本段静置：build 段收尾会按 settleTicks 静置（避免双倍等待）
            spec.settleTicks = segments.contains(SEG_BUILD) ? 0 : Json.optInt(w, "settleTicks", 60);
            boolean hasBuild = segments.contains(SEG_BUILD) && Json.optArray(plan, "build") != null
                && Json.optArray(plan, "build")
                    .size() > 0;
            spec.markComplete = !hasBuild;
            WorldRebuildRunner.assertManagedIfExists(mc.mcDataDir, spec.folder);
            runner = new WorldRebuildRunner(spec, ctx);
        }
        JsonObject r = runner.tick(mc);
        if (r == null) {
            // 内部阶段切换时重置阶段超时：进入世界单独计时（集成服启动 + 世界下发可能数十秒）
            String st = runner.stageName();
            if (!st.equals(lastWorldStage)) {
                lastWorldStage = st;
                enterStage("case.world." + st.toLowerCase(java.util.Locale.ROOT));
            }
            progress(ctx, 0.1d + 0.3d * fractionOfStep(), "world: " + stage());
            return null;
        }
        worldResult = r;
        return r;
    }

    /**
     * {@code capture} 段（case-file.md §4）：建立捕获会话（等于 {@code capture.begin}）。
     *
     * <h2>为什么本段在 {@code build} 之前</h2>
     * 契约口径是「会话包围 build 之后的区间」。段序取 {@code world→capture→build→cameras→…}，
     * 会话从 build <b>前</b>开场：这样 build 段的世界写发生在会话内（真正的加固范围最大），
     * 而会话标志对开场作业自身放行（见 {@link CaptureSession}），所以 build 不会被自己开的会话挡住。
     * 没有机位时本段立即释放（不产截图的用例不该留着会话标志）。
     */
    private JsonObject stepCapture(ActionContext ctx) throws Exception {
        if (captureSpec == null && captureCameras == null) {
            JsonObject raw = Json.optObject(plan, "capture");
            captureSpec = raw == null ? CaptureSpec.empty() : CaptureSpec.parseOrThrow(raw, "capture");
            captureCameras = Json.optArray(plan, "cameras");
            boolean hasCameras = captureCameras != null && captureCameras.size() > 0;
            if (hasCameras) {
                String jobId = ctx.job() == null ? null
                    : ctx.job()
                        .jobId();
                CaptureSession.begin(
                    jobId,
                    "case.run",
                    TimeSource.system()
                        .isoNow(),
                    0L);
                captureArmed = true;
            }
            ctx.emit(
                EventStream.LEVEL_INFO,
                EventStream.Kinds.CASE_SEGMENT,
                hasCameras ? "捕获会话开始（case.run capture 段）" : "capture 段无机位：不建会话",
                CaptureControl.status());
        }
        JsonObject detail = new JsonObject();
        detail.addProperty("armed", Boolean.valueOf(captureArmed));
        detail.add("session", CaptureControl.status());
        if (captureSpec != null) {
            detail.add("capture", captureSpec.toJson());
            detail.addProperty("lighting", CameraSpecs.resolveLighting(null, captureSpec));
            detail.addProperty("renderMode", CameraSpecs.resolveRenderMode(null, captureSpec));
            detail.addProperty("worldTime", captureSpec.hasWorldTime() ? captureSpec.worldTime() : -1L);
        }
        return detail;
    }

    /**
     * {@code cameras} 段（case-file.md §4）：逐机位走 {@code shot.multi} 的<b>同一实现</b>。
     *
     * <p>
     * 公共执行器是 {@link ShotExecutor}：本段只负责把规范化后的机位表喂进去、逐 tick 推进、
     * 段末释放捕获会话。任何「用例里的机位可以少做一步」的写法都会让交互路径与无人值守路径
     * 产出不同形态的产物，这正是契约 §7.8 要禁止的分叉。
     */
    private JsonObject stepCameras(ActionContext ctx) throws Exception {
        if (captureCameras == null) {
            captureCameras = Json.optArray(plan, "cameras");
        }
        if (captureCameras == null || captureCameras.size() == 0) {
            JsonObject detail = new JsonObject();
            detail.addProperty("cameraCount", 0);
            detail.addProperty("note", "cameras 段为空：未拍摄");
            releaseCapture();
            return detail;
        }
        if (shotExecutor == null) {
            CameraSpecs.Parsed parsed = CameraSpecs.parseArray(captureCameras, "cameras");
            parsed.throwIfAny(
                "cameras 段非法（" + parsed.fields()
                    .size() + " 处）");
            if (captureSpec == null) {
                captureSpec = CaptureSpec.empty();
            }
            ShotExecutor.Input in = new ShotExecutor.Input();
            in.mc = mc;
            in.artifacts = ctx.artifacts();
            in.run = ctx.run();
            in.cameras = parsed.specs();
            in.capture = captureSpec;
            in.target = ObservationCollector.targetBbox(plan);
            in.jobId = ctx.job() == null ? null
                : ctx.job()
                    .jobId();
            in.action = "case.run/cameras";
            in.progress = new ShotExecutor.Progress() {

                @Override
                public void onProgress(double fraction, String message) {
                    progress(ctx, 0.5d + 0.4d * fraction, "cameras: " + message);
                }
            };
            shotExecutor = new ShotExecutor(in);
            cameraSummaries = CameraSpecs.summaries(parsed.specs());
            CpLog.info(
                "case.cameras 段开始：%d 个机位（共用 shot.multi 执行器）",
                parsed.specs()
                    .size());
        }
        JsonObject result = shotExecutor.tick();
        if (result == null) {
            return null;
        }
        shotResult = result;
        releaseCapture();
        JsonObject detail = new JsonObject();
        detail.addProperty("cameraCount", Json.optInt(result, "cameraCount", 0));
        detail.addProperty("shotCount", Json.optInt(result, "shotCount", 0));
        detail.addProperty("failedCount", Json.optInt(result, "failedCount", 0));
        detail.add("cameras", Json.copyArray(cameraSummaries));
        detail.add("shots", Json.optArray(result, "cameras"));
        if (Json.optInt(result, "failedCount", 0) > 0) {
            detail.add("warnings", shotExecutor.warnings());
        }
        return detail;
    }

    /** 释放捕获会话（幂等；段末与收尾路径共用）。 */
    private void releaseCapture() {
        if (!captureArmed) {
            return;
        }
        CaptureSession.end();
        captureArmed = false;
    }

    /**
     * 运行期升格检查（case-file.md §4）：{@code cameras} 段非空 ⇒ 调用方必须 forensic 级。
     *
     * <p>
     * 静态权限级（{@code case.run} = scene）挡不住「scene 级调用方顺手拍一堆截图」，
     * 而截图是取证材料、比场景操作敏感。故按<b>内容</b>升格：只有带上这一级才放行，
     * 不足即 {@code CP-AUTH-002}（不是 VALID/STATE 类错误——它是权限问题，调用方应换 token）。
     */
    private void assertForensicForCameras(ActionContext ctx) {
        JsonArray cameras = Json.optArray(plan, "cameras");
        if (cameras == null || cameras.size() == 0) {
            return;
        }
        Tier actual = ctx.job() == null ? Tier.OBSERVE
            : ctx.job()
                .tier();
        if (actual.covers(Tier.FORENSIC)) {
            return;
        }
        JsonObject context = new JsonObject();
        context.addProperty("required", Tier.FORENSIC.id());
        context.addProperty("actual", actual == null ? null : actual.id());
        context.addProperty("caseId", caseFile.id());
        context.addProperty("cameraCount", cameras.size());
        context.addProperty("reason", "用例含 cameras 段：case.run 权限按内容升格为 forensic（case-file.md §4）");
        throw new CpException(ErrorCodes.AUTH_INSUFFICIENT, "含 cameras 段的用例必须 forensic 级调用", context);
    }

    /**
     * {@code build} 段：{@link SceneBuilder}（与 {@code world.rebuild} 的 build 段同一实现）。
     *
     * <p>
     * <b>驱动线程</b>：本段不再自己调 {@code builder.tick(world)}，而是把
     * 构建器交给 {@link ServerBuildPump}（服务端 tick 线程逐 tick 推进），本处只逐 tick
     * {@link ServerBuildPump#poll()}：阶段名、超时与进度回报语义与改前一致，进度读的是
     * {@link SceneBuilder} 的 volatile 进度快照。
     */
    private JsonObject stepBuild(ActionContext ctx) throws Exception {
        JsonObject w = Json.optObject(plan, "world");
        String folder = Json.optString(w, "folder", null);
        long seed = Json.optLong(w, "seed", 0L);
        int settle = Json.optInt(w, "settleTicks", 60);
        JsonArray steps = Json.optArray(plan, "build");
        if (builder == null) {
            builder = new SceneBuilder(steps, folder, seed, true, settle);
            CpLog.info(
                "case.build 段开始：%s，%d 步，静置 %d tick（提交到服务端线程执行）",
                folder,
                Integer.valueOf(builder.stepCount()),
                Integer.valueOf(settle));
            ServerBuildPump.instance()
                .submit(builder);
        }
        JsonObject m = ServerBuildPump.instance()
            .poll();
        if (m == null) {
            int total = Math.max(1, builder.stepCount());
            progress(ctx, 0.4d + 0.3d * ((double) builder.doneSteps() / (double) total), "build");
            return null;
        }
        manifest = m;
        ArtifactStore.Run run = ctx.run();
        byte[] bytes = Json.toPretty(m)
            .getBytes(StandardCharsets.UTF_8);
        ctx.artifacts()
            .writeArtifact(run, SceneManifest.RUN_RELATIVE_PATH, bytes, "scene-manifest");
        SceneManifestStore.write(mc.mcDataDir, folder, m);
        // 标记收口：world 段特意留了 complete:false，到本段（场景已铺好、清单已落）才允许
        // 把世界宣告为「构建完成的成品」。这一步失败即本段失败，标记保持 false —— 那正是失败残留
        // 应有的状态（可删可重建、不可复用）；故它不能放在 try 里被吞掉。
        Path worldDir = ManagedWorld.worldDir(mc.mcDataDir, folder);
        // 先显式断言「目录是托管的」，把「按段续跑跑到一个非托管目录上」这条路的错误信息说清楚：
        // 写场景清单本身就是对该存档目录的世界写，契约 §10 第 1 条只许写托管世界。若这里直接落到
        // promoteMarker 的拒绝上，调用方看到的会是「标记收口失败」这句实现内部的话，
        // 而根因多半是「segments 没包含 world 段、folder 又不是托管世界」。
        try {
            ManagedWorld.assertManaged(worldDir, folder, "case.run 的 build 段");
        } catch (CpException e) {
            throw new CpException(
                e.code(),
                e.detail() + "（build 段的场景清单要写进该存档目录；请把 world 段一并跑，或让 folder 指向托管世界）",
                e.context(),
                e);
        }
        ManagedWorld.promoteMarker(worldDir, folder, seed, true);
        CpLog.info("build 段完成，标记已收口（complete:true）: %s", folder);
        JsonObject detail = new JsonObject();
        detail.addProperty("sha256", Json.optString(m, "sha256", null));
        detail.addProperty("stepCount", Json.optInt(m, "stepCount", 0));
        detail.addProperty("blockCount", size(Json.optArray(m, "blocks")));
        detail.addProperty("teCount", size(Json.optArray(m, "tileEntities")));
        detail.addProperty("mismatchCount", size(Json.optArray(m, "mismatches")));
        detail.addProperty("manifestPath", SceneManifest.RUN_RELATIVE_PATH);
        detail.add("manifest", m);
        return detail;
    }

    /**
     * {@code read} 段（v1.3）：执行用例声明的读面动作，把读数落 run 目录。
     *
     * <h2>为什么读面要进用例</h2>
     * 「读面输出可被判据直接引用」是这一段的存在理由（case-file.md §3.1 第 6 条）。调用方在用例之外单独调读面也能拿到读数，
     * 但判据段跑在<b>本 run 的产物</b>上，读不到那份读数——「可判定」就成了一句空话。
     * 本段把两者的接缝封上：读面动作的返回值原样落 {@code read[i].path}，
     * 登记进 manifest，判据段随后用 {@code json-field} 指针去断言它。
     *
     * <h2>与既有段的关系</h2>
     * 段序 {@code world→capture→build→read→action→export→cameras→criteria→evidence}：读面在 build 之后
     * （读的是成品场景）、在 criteria 之前（产物必须先落）；{@code action}/{@code export} 段
     * （v1.6/v1.7）也排在 criteria 之前——凡要判据引用的产物都必须先落盘。<b>不</b>与 {@code shot.multi} 共用
     * 任何状态——读面不碰渲染。
     *
     * <h2>动作实例从哪来</h2>
     * 从注册表取（{@code runtime.actions()}）：这样「用例声明的读面动作必须是真注册过的动作」
     * 由查表保证，且读面动作的<b>同一份实现</b>既服务交互调用也服务用例——不存在第二条读路径
     * （无隐藏通道）。读面动作全部无状态，直接复用注册表里的实例。
     */
    private JsonObject stepRead(ActionContext ctx) throws Exception {
        JsonArray steps = Json.optArray(plan, "read");
        JsonArray records = new JsonArray();
        int executed = 0;
        if (steps != null) {
            for (int i = 0; i < steps.size(); i++) {
                JsonObject step = steps.get(i)
                    .getAsJsonObject();
                String action = Json.optString(step, "action", null);
                String path = Json.optString(step, "path", null);
                String role = Json.optString(step, "role", null);
                JsonObject params = Json.optObject(step, "params");
                com.lightning.mod.client.controlplane.core.ActionRegistry.Entry entry = runtime == null ? null
                    : runtime.actions()
                        .lookup(action);
                if (entry == null) {
                    throw new CpException(
                        ErrorCodes.VALID_UNKNOWN,
                        "用例 read 段引用了未注册的动作: " + action,
                        Json.object(
                            "field",
                            "read[" + i + "].action",
                            "action",
                            action,
                            "registered",
                            runtime == null ? null
                                : runtime.actions()
                                    .names()));
                }
                if (entry.isStepping()) {
                    throw CpException
                        .param("读面步骤不许用步进动作", "read[" + i + "].action", "读面动作必须是同步动作（跨 tick 的读面会读到两个世界状态）: " + action);
                }
                JsonObject result;
                try {
                    // 派生上下文：换本步骤的参数，run/artifacts/events 仍是用例那一份
                    // （读面产物因此落用例 run 目录，判据段才看得到——见 ActionContext#withParams）
                    result = entry.action()
                        .execute(ctx.withParams(params));
                } catch (CpException e) {
                    throw new CpException(
                        e.code(),
                        "读面步骤 read[" + i + "]（" + action + "）失败: " + e.detail(),
                        e.context(),
                        e);
                }
                if (result == null) {
                    result = new JsonObject();
                }
                // 与 read.diff 的自落盘错开：那条路径写 read/diff.json，这里也写同一条路径时
                // 由本段统一落一次（内容一致，后写者胜且仍登记同一 sha256）。
                ctx.artifacts()
                    .writeArtifact(
                        ctx.run(),
                        path,
                        Json.toPretty(result)
                            .getBytes(StandardCharsets.UTF_8),
                        role == null ? deriveRole(action) : role);
                JsonObject rec = new JsonObject();
                rec.addProperty("index", i);
                rec.addProperty("action", action);
                rec.addProperty("path", path);
                rec.addProperty("ok", true);
                rec.add("params", Json.copyObject(params));
                JsonObject shape = new JsonObject();
                shape.addProperty("schema", Json.optString(result, "schema", null));
                shape.addProperty(
                    "bytes",
                    ctx.run() == null ? 0L
                        : ctx.run()
                            .artifact(path) == null ? 0L
                                : ctx.run()
                                    .artifact(path)
                                    .bytes());
                shape.addProperty(
                    "sha256",
                    ctx.run() == null ? null
                        : ctx.run()
                            .artifact(path) == null ? null
                                : ctx.run()
                                    .artifact(path)
                                    .sha256());
                rec.add("artifact", shape);
                records.add(rec);
                executed++;
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.CASE_SEGMENT,
                    "读面步骤完成: " + action + " → " + path,
                    Json.object("action", action, "path", path, "index", Integer.valueOf(i)));
            }
        }
        JsonObject detail = new JsonObject();
        detail.addProperty("executed", executed);
        detail.addProperty("declared", steps == null ? 0 : steps.size());
        detail.add("steps", records);
        return detail;
    }

    /**
     * {@code export} 段（v1.6）：逐条执行用例声明的导出动作，产物落<b>本用例的 run 目录</b>。
     *
     * <h2>为什么必须有这一段（同一 run 纪律）</h2>
     *
     * 「导出件、实拍、观测记录、世界清单哈希<b>同一 run</b>，且该 run 内世界清单哈希唯一」是导出的硬口径。
     * 若导出只能在用例之外单独调 {@code export.scene}，它必然落在另一个 run 里——同 run 口径对导出件就永远
     * 不成立。本段让导出成为用例的一段，与 {@code read}/{@code cameras} 共享同一个 run 目录与观测记录。
     *
     * <h2>与 {@code read} 段的差别</h2>
     *
     * 导出动作是<b>步进</b>动作（{@code export.scene} 跨阶段推进），而读面段刻意拒绝步进动作
     * （「跨 tick 的读面会读到两个世界状态」）。导出段的语义恰恰相反：它本来就跨 tick，且它读的
     * 是<b>缓冲快照</b>（{@code export.scene} 在 onBegin 一次取走全部状态），因此跨 tick 不引入撕裂。
     * 但 cp 的动作执行器是<b>按作业</b>排空的——用例作业本身正在跑，无法在它内部再起一个子作业。
     * 因此本段直接调动作实例的 {@code step}，循环到完成为止，并把它当作「本段的一部分」计时。
     *
     * <p>
     * 产物路径由动作决定（run 目录的 {@code export/} 下），本段不声明落点——段里声明落点会与动作
     * 实现产生第二处真相。段记录里回显动作返回的 {@code path}/{@code sha256}，判据据此引用。
     */
    private JsonObject stepExport(ActionContext ctx) throws Exception {
        JsonArray steps = Json.optArray(plan, "export");
        JsonArray records = new JsonArray();
        int executed = 0;
        if (steps != null) {
            for (int i = 0; i < steps.size(); i++) {
                JsonObject step = steps.get(i)
                    .getAsJsonObject();
                String action = Json.optString(step, "action", null);
                JsonObject params = Json.optObject(step, "params");
                com.lightning.mod.client.controlplane.core.ActionRegistry.Entry entry = runtime == null ? null
                    : runtime.actions()
                        .lookup(action);
                if (entry == null) {
                    throw new CpException(
                        ErrorCodes.VALID_UNKNOWN,
                        "用例 export 段引用了未注册的动作: " + action,
                        Json.object(
                            "field",
                            "export[" + i + "].action",
                            "action",
                            action,
                            "registered",
                            runtime == null ? null
                                : runtime.actions()
                                    .names()));
                }
                JsonObject result;
                try {
                    if (entry.isStepping()) {
                        // 步进导出动作：在本段内循环推进到完成（每个作业一个新实例——
                        // 用例作业只有一个，故这里取一次实例并在本段内复用，符合实例的作业级语义）
                        com.lightning.mod.client.controlplane.core.SteppingAction sub = entry.newSteppingAction();
                        if (sub == null) {
                            throw new CpException(ErrorCodes.EXEC_FAILED, "步进动作工厂返回 null: " + action);
                        }
                        ActionContext derived = ctx.withParams(params == null ? new JsonObject() : params);
                        result = null;
                        for (int guard = 0; guard < MAX_EXPORT_STEPS && result == null; guard++) {
                            result = sub.step(derived);
                        }
                        if (result == null) {
                            throw new CpException(
                                ErrorCodes.EXEC_TIMEOUT,
                                "导出步骤 export[" + i + "]（" + action + "）在 " + MAX_EXPORT_STEPS + " 次推进内未完成",
                                Json.object("field", "export[" + i + "].action", "action", action));
                        }
                    } else {
                        result = entry.action()
                            .execute(ctx.withParams(params == null ? new JsonObject() : params));
                    }
                } catch (CpException e) {
                    throw new CpException(
                        e.code(),
                        "导出步骤 export[" + i + "]（" + action + "）失败: " + e.detail(),
                        e.context(),
                        e);
                }
                if (result == null) {
                    result = new JsonObject();
                }
                JsonObject rec = new JsonObject();
                rec.addProperty("index", i);
                rec.addProperty("action", action);
                rec.addProperty("ok", true);
                rec.add("params", Json.copyObject(params));
                rec.addProperty("runId", Json.optString(result, "runId", runId(ctx)));
                rec.addProperty("path", Json.optString(result, "path", null));
                rec.addProperty("sha256", Json.optString(result, "sha256", null));
                rec.addProperty("bytes", Json.optLong(result, "bytes", -1L));
                rec.addProperty("shape", Json.optString(result, "shape", null));
                rec.addProperty("frames", Json.optInt(result, "frames", 0));
                rec.add("frameIndexes", Json.copyArray(Json.optArray(result, "frameIndexes")));
                rec.addProperty("artifactCount", Json.optInt(result, "artifactCount", 0));
                records.add(rec);
                executed++;
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.CASE_SEGMENT,
                    "导出步骤完成: " + action + " → " + Json.optString(result, "path", "?"),
                    Json.object(
                        "action",
                        action,
                        "path",
                        Json.optString(result, "path", null),
                        "sha256",
                        Json.optString(result, "sha256", null),
                        "index",
                        Integer.valueOf(i)));
            }
        }
        JsonObject detail = new JsonObject();
        detail.addProperty("executed", executed);
        detail.addProperty("declared", steps == null ? 0 : steps.size());
        detail.add("steps", records);
        detail.addProperty("note", "导出件落本 run 目录（C4 同 run 纪律）；落点由导出动作决定，段内不声明 path");
        return detail;
    }

    /** 单个导出步骤的最大推进次数（防步进动作卡死；正常 export.scene 是 3 阶段）。 */
    public static final int MAX_EXPORT_STEPS = 200;

    /** 读面产物的默认 role：由动作名的最后一段派生（{@code read.blocks} → {@code read-blocks}）。 */
    static String deriveRole(String action) {
        if (action == null) {
            return "read";
        }
        int dot = action.indexOf('.');
        return dot < 0 ? "read-" + action
            : "read-" + action.substring(dot + 1)
                .replace('.', '-');
    }

    /**
     * {@code action} 段（v1.6）：逐条执行用例声明的<b>任意</b> cp 动作。
     *
     * <h2>为什么这一段是 L2 的落点</h2>
     * L2 的定义是「L0/L1 的<b>有序编排</b>，可重放、<b>逐步断言</b>」。在本段之前，
     * 用例能表达的世界写只有 {@code build} 段的四种构建 op（clear/block/te/wait）——
     * {@code scene.*}（L0）与 {@code player.*}（L1）一步也进不了固定程序，于是「L2 = 有序编排」
     * 这句话在代码上没有落点（前置盘点发现的缺口）。本段把两者的接缝封上：
     *
     * <ul>
     * <li><b>有序</b>：按数组序逐条执行，段序 {@code …build→read→action→cameras…}——排在
     * {@code read} 之后（可读成品场景）、{@code cameras} 之前（编排的世界改动必须发生在拍摄之前，
     * 否则截图与判据说的不是同一个世界）；</li>
     * <li><b>可重放</b>：每步的 {@code params} 逐字写死在用例文件里，{@code caseSha256} 落 run
     * （与 {@code read} 段同一可追溯口径）；</li>
     * <li><b>逐步断言</b>：{@code expect} 非空时<b>当场</b>按 RFC 6901 指针断言该步的结果；
     * 没命中就当场 {@code CP-EXEC-001}——不拖到 criteria 段。这条是「逐步」二字的物质保证：
     * 一步失败时，run 目录里留下的产物正好停在失败那一步，而不是一份「跑完了但判据红」的现场。</li>
     * </ul>
     *
     * <h2>与既有段的关系（不共用状态）</h2>
     * 动作实例从注册表取（{@code runtime.actions()}）——「用例声明的动作必须是真注册过的动作」
     * 由查表保证，且动作的<b>同一份实现</b>既服务交互调用也服务用例（无隐藏通道）。
     * 派生上下文 {@link ActionContext#withParams} 共享 run，因此产物落用例的 run 目录，
     * criteria 段随后用 {@code json-field} 指针就能引用它（与 {@code read} 段同一机制）。
     *
     * <h2>v1.8：输入族步进动作可以在段内跨 tick 推进</h2>
     * 原先本段一律拒绝步进动作（理由对<b>非输入族</b>仍成立：段语义是「一次 advance 里跑完」，
     * 放行要装卸世界的那类动作会让「段完成」与「动作完成」脱钩）。case-file.md §3.2 的例外
     * 只对 {@link CaseValidator#ACTION_STEPPING_INPUT_ACTIONS}（{@code input.key} / {@code input.mouse}）
     * 开一个口子——不推进它们，「注入输入 → 推进 N tick → 读后果」在用例里<b>无法表达</b>。
     *
     * <p>
     * 推进与收尾的四条纪律都落在 {@link ActionStepDriver}：一次 tick 只推进一次（不 sleep / 不忙等）、
     * 完成前不进入下一步骤、输入步不走 {@code settleBetweenSteps} 的墙钟等待、失败/超时/段异常都走
     * {@link ActionStepDriver#finish} 释放本段所持按下态。{@code holdTicks} 写在步骤对象<b>顶层</b>
     * （case-file.md §3.2 第 4 条），由驱动翻译成动作参数（{@code params} 内的 {@code holdTicks} 在静态层即被拒）。
     */
    private JsonObject stepAction(ActionContext ctx) throws Exception {
        if (actionDriver == null) {
            actionDriver = new ActionStepDriver(
                runtime == null ? null : runtime.actions(),
                this::settleBetweenSteps,
                this::releaseInputState);
        }
        return actionDriver.advance(ctx, Json.optArray(plan, "action"));
    }

    /**
     * {@code action} 段的步骤推进器（v1.8，case-file.md §3.2）。
     *
     * <h2>为什么把它从段执行体里拆出来</h2>
     * 「一次 tick 只推进一次」这条纪律必须在<b>没有 Minecraft 的环境里</b>可判定：段执行体的其它部分
     * （步骤间收敛、MC 状态）都挂在客户端线程上，离线测不了「1 tick = 1 step」。拆出来之后推进器只依赖
     * {@link ActionRegistry}/{@link SteppingAction}/{@link ActionContext} 这些 core 面，
     * 单测可以直接驱动它，并数清每次 {@code advance} 到底调了几次 {@code step()}。
     *
     * <h2>推进纪律（逐条可判定）</h2>
     * <ol>
     * <li>{@link #advance} 对<b>在飞</b>的输入步恰好调一次 {@code step()}；它返回 null 即让出本 tick；</li>
     * <li>输入步完成后<b>本 tick 到此为止</b>（下一步骤下个 tick 开始）——每个输入步至少占一个 tick，
     * 于是「按下」与「紧随其后的读断言」天然隔着帧边界，不会挤进同一次 advance；</li>
     * <li>同步步骤的行为与不含输入步的路径逐字相同：同一 tick 内按数组序跑完、每步落产物、{@code expect}
     * 当场断言、非末步做步骤间收敛；</li>
     * <li>输入步<b>不</b>做步骤间收敛——那段等待是墙钟等待（{@code Thread.sleep} 量级），
     * case-file.md §3.2 第 7 条明令不得用于输入步；输入步的「等」= tick 推进；</li>
     * <li>失败/超时/段异常都经 {@link #finish} 释放（幂等）；只有本段真的碰过输入设施才调释放钩子
     * （没碰过 ⇒ 一个字节的行为都不变，A3 基准不失效）。</li>
     * </ol>
     */
    public static final class ActionStepDriver {

        /** 步骤间收敛钩子（mc 层注入 {@code settleBetweenSteps}；离线测试可注入 no-op 或记录器）。 */
        public interface Settle {

            void settle(ActionContext ctx, String action, int index, int lastIndex, JsonObject rec);
        }

        /** 输入步收尾释放钩子（mc 层注入 {@code releaseInputState}）。 */
        public interface Releaser {

            void release(ActionContext ctx, String reason);
        }

        private final com.lightning.mod.client.controlplane.core.ActionRegistry registry;
        private final Settle settle;
        private final Releaser releaser;

        private JsonArray steps;
        private final JsonArray records = new JsonArray();
        private int index;
        private int executed;
        private int asserted;
        private int inputSteps;

        /** 在飞的输入步实例（跨 tick 复用；完成或收尾后清空）。 */
        private SteppingAction inFlight;
        private ActionContext inFlightCtx;
        private int inFlightIndex = -1;
        private String inFlightAction;
        private int inFlightTicks;

        /** 是否已收尾（{@link #finish} 幂等：段内失败路径与 onFinish 会各调一次）。 */
        private boolean finished;

        public ActionStepDriver(com.lightning.mod.client.controlplane.core.ActionRegistry registry, Settle settle,
            Releaser releaser) {
            this.registry = registry;
            this.settle = settle;
            this.releaser = releaser;
        }

        /** 在飞输入步的下标；无在飞返回 −1。 */
        public int inFlightIndex() {
            return inFlightIndex;
        }

        /** 在飞输入步已推进的 tick 数（「1 tick = 1 推进」的机械计数）。 */
        public int inFlightTicks() {
            return inFlightTicks;
        }

        /** 本段执行过的输入族步进步数（0 ⇒ 本段没碰输入设施，收尾无须释放）。 */
        public int inputSteps() {
            return inputSteps;
        }

        /**
         * 推进一次（每个客户端 tick 恰好调一次）。
         *
         * @return 段全部步骤完成时返回段记录详情；未完成返回 null（下个 tick 继续）
         */
        public JsonObject advance(ActionContext ctx, JsonArray declared) throws Exception {
            try {
                return advanceInternal(ctx, declared);
            } catch (Throwable t) {
                // 段内失败（步骤异常 / 断言不命中 / 参数非法 / 未注册动作）：**当场**释放本段所持按下态。
                // 收尾层（CaseRunAction.onFinish）还会再调一次 finish——它是幂等的，重复调用是安全的。
                finish(ctx, true);
                throw t;
            }
        }

        private JsonObject advanceInternal(ActionContext ctx, JsonArray declared) throws Exception {
            if (steps == null) {
                steps = declared == null ? new JsonArray() : declared;
            }
            while (index < steps.size() && inFlight == null) {
                JsonObject step = steps.get(index)
                    .getAsJsonObject();
                String action = Json.optString(step, "action", null);
                JsonObject params = Json.optObject(step, "params");
                com.lightning.mod.client.controlplane.core.ActionRegistry.Entry entry = registry == null ? null
                    : registry.lookup(action);
                if (entry == null) {
                    throw new CpException(
                        ErrorCodes.VALID_UNKNOWN,
                        "用例 action 段引用了未注册的动作: " + action,
                        Json.object(
                            "field",
                            "action[" + index + "].action",
                            "action",
                            action,
                            "registered",
                            registry == null ? null : registry.names()));
                }
                if (!entry.isStepping()) {
                    // 同步步骤：与不含输入步的路径逐字相同（同一 tick 内继续往下跑）
                    JsonObject result;
                    try {
                        // 派生上下文：换本步骤的参数，run/artifacts/events 仍是用例那一份
                        // （产物因此落用例 run 目录，判据段才看得到——见 ActionContext#withParams）
                        result = entry.action()
                            .execute(ctx.withParams(params));
                    } catch (CpException e) {
                        throw new CpException(
                            e.code(),
                            "编排步骤 action[" + index + "]（" + action + "）失败: " + e.detail(),
                            e.context(),
                            e);
                    }
                    record(ctx, step, action, params, result, index, false);
                    index++;
                    continue;
                }
                if (!CaseValidator.ACTION_STEPPING_INPUT_ACTIONS.contains(action)) {
                    throw CpException.param(
                        "编排步骤不许用非输入族的步进动作",
                        "action[" + index + "].action",
                        "编排动作必须是同步动作，或允许在段内跨 tick 推进的输入族步进动作 " + CaseValidator.ACTION_STEPPING_INPUT_ACTIONS
                            + "（跨 tick 的其它动作无法在单次 advance 的段语义里推进）: "
                            + action);
                }
                openStep(ctx, entry, step, params, action);
            }
            if (inFlight == null) {
                return detail();
            }
            // 在飞的输入步：**本 tick 只推进一次**（不 sleep、不忙等、不在段内循环到完成）
            inFlightTicks++;
            JsonObject result;
            try {
                result = inFlight.step(inFlightCtx);
            } catch (CpException e) {
                throw new CpException(
                    e.code(),
                    "编排步骤 action[" + inFlightIndex + "]（" + inFlightAction + "）失败: " + e.detail(),
                    e.context(),
                    e);
            }
            if (result == null) {
                return null;
            }
            int done = inFlightIndex;
            String doneAction = inFlightAction;
            JsonObject doneStep = steps.get(done)
                .getAsJsonObject();
            JsonObject doneParams = Json.optObject(doneStep, "params");
            inFlight = null;
            inFlightCtx = null;
            inFlightIndex = -1;
            inFlightAction = null;
            inFlightTicks = 0;
            record(ctx, doneStep, doneAction, doneParams, result, done, true);
            index++;
            // 输入步至少占一个 tick：本 tick 到此为止，下一步骤下个 tick 开始（后续读断言不抢跑）
            return null;
        }

        /** 开一个输入步（取实例 + 建派生上下文 + 把顶层 {@code holdTicks} 翻译进动作参数）。 */
        private void openStep(ActionContext ctx, com.lightning.mod.client.controlplane.core.ActionRegistry.Entry entry,
            JsonObject step, JsonObject params, String action) {
            if (Json.get(params, CaseValidator.FIELD_HOLD_TICKS) != null) {
                throw CpException.param(
                    "holdTicks 只能写在步骤对象顶层",
                    "action[" + index + "].params." + CaseValidator.FIELD_HOLD_TICKS,
                    "两处都写会让真值来源不明（case-file.md §3.2 第 5 条）：请删掉 params 里的那一份");
            }
            SteppingAction sub = entry.newSteppingAction();
            if (sub == null) {
                throw new CpException(ErrorCodes.EXEC_FAILED, "步进动作工厂返回 null: " + action);
            }
            inFlight = sub;
            inFlightCtx = ctx.withParams(derivedParams(step, params));
            inFlightIndex = index;
            inFlightAction = action;
            inFlightTicks = 0;
            inputSteps++;
        }

        /**
         * 步骤参数 → 动作参数：把<b>顶层</b>的 {@code holdTicks} 翻译进 {@code params}（case-file.md §3.2 第 4 条的唯一翻译点）。
         *
         * <p>
         * 位置在上层、值在动作层，因此必须有这一处显式翻译：用例作者写的是编排属性（跨 tick 持有
         * 多少拍），动作实现读的是自己的参数（{@code input.key}/{@code input.mouse} 的
         * {@code holdTicks}）。未写顶层 {@code holdTicks} 时<b>不注入</b>任何默认值——动作自己的
         * 缺省（{@code 1}）说了算，驱动不隐式跨帧。
         */
        static JsonObject derivedParams(JsonObject step, JsonObject params) {
            JsonObject p = Json.copyObject(params);
            JsonElement hold = Json.get(step, CaseValidator.FIELD_HOLD_TICKS);
            if (hold != null) {
                p.add(CaseValidator.FIELD_HOLD_TICKS, Json.copy(hold));
            }
            return p;
        }

        /** 记一步：落产物 + 逐步断言 + 段记录 + 事件（输入步不做步骤间收敛）。 */
        private void record(ActionContext ctx, JsonObject step, String action, JsonObject params, JsonObject result,
            int i, boolean inputStep) {
            String path = Json.optString(step, "path", null);
            String role = Json.optString(step, "role", null);
            JsonObject r = result == null ? new JsonObject() : result;
            ctx.artifacts()
                .writeArtifact(
                    ctx.run(),
                    path,
                    Json.toPretty(r)
                        .getBytes(StandardCharsets.UTF_8),
                    role == null ? deriveActionRole(action) : role);
            JsonObject rec = new JsonObject();
            rec.addProperty("index", i);
            rec.addProperty("action", action);
            rec.addProperty("path", path);
            rec.addProperty("ok", true);
            rec.add("params", Json.copyObject(params));
            JsonObject shape = new JsonObject();
            shape.addProperty("schema", Json.optString(r, "schema", null));
            shape.addProperty(
                "bytes",
                ctx.run() == null ? 0L
                    : ctx.run()
                        .artifact(path) == null ? 0L
                            : ctx.run()
                                .artifact(path)
                                .bytes());
            shape.addProperty(
                "sha256",
                ctx.run() == null ? null
                    : ctx.run()
                        .artifact(path) == null ? null
                            : ctx.run()
                                .artifact(path)
                                .sha256());
            rec.add("artifact", shape);
            // 逐步断言：本步的结果当场按指针核对，没命中即当场失败（见 assertStep 的说明）
            JsonObject expect = Json.optObject(step, "expect");
            if (expect != null && Json.size(expect) > 0) {
                rec.add("assertions", assertStep(action, i, r, expect));
                asserted += Json.size(expect);
            }
            records.add(rec);
            executed++;
            ctx.emit(
                EventStream.LEVEL_INFO,
                EventStream.Kinds.CASE_SEGMENT,
                "编排步骤完成: " + action + " → " + path,
                Json.object("action", action, "path", path, "index", Integer.valueOf(i)));
            if (inputStep) {
                // 输入步的「等待」由 tick 推进表达；墙钟等待（settleBetweenSteps 的 Thread.sleep 路径）
                // case-file.md §3.2 第 7 条明令不得用于输入步。
                return;
            }
            // 步骤间收敛（见 settleBetweenSteps 的说明）：本段在**单次 advance** 里逐条跑完同步步骤，
            // 若不收敛，下一步读到的是上一步还没生效的世界。
            if (settle != null) {
                settle.settle(ctx, action, i, steps.size() - 1, rec);
            }
        }

        /**
         * 收尾（成功/失败/超时/段异常四条路径都会到）：释放本段碰过的输入设施所持按下态（幂等）。
         *
         * <p>
         * 只在<b>本段真的碰过输入设施</b>（{@link #inputSteps()} &gt; 0）或有步进实例在飞时才调释放
         * 钩子：没碰过输入设施的用例（不含输入步的用例）因此一个字节的行为都不变。
         *
         * @param failed true = 失败/超时路径
         */
        public void finish(ActionContext ctx, boolean failed) {
            if (finished) {
                // 幂等：段内失败路径已经释放过一次，onFinish 再调一次不再重复投递释放
                return;
            }
            finished = true;
            boolean touched = inputSteps > 0 || inFlight != null;
            if (inFlight != null) {
                CpLog.warn(
                    "输入步未完成即收尾（action[%d] %s，已推进 %d tick）: 释放本段所持按下态",
                    Integer.valueOf(inFlightIndex),
                    inFlightAction,
                    Integer.valueOf(inFlightTicks));
            }
            inFlight = null;
            inFlightCtx = null;
            inFlightIndex = -1;
            inFlightAction = null;
            inFlightTicks = 0;
            if (!touched || releaser == null) {
                return;
            }
            try {
                releaser.release(ctx, failed ? "failed" : "segment-end");
            } catch (Throwable t) {
                // 释放失败不得让收尾再抛：持有点还有设施的 1200 tick 到期机制兜底
                CpLog.warn("输入步收尾释放失败: %s", String.valueOf(t));
            }
        }

        private JsonObject detail() {
            JsonObject detail = new JsonObject();
            detail.addProperty("executed", executed);
            detail.addProperty("declared", steps == null ? 0 : steps.size());
            detail.addProperty("asserted", asserted);
            detail.add("steps", records);
            return detail;
        }
    }

    /**
     * 逐步断言（{@code action[i].expect}）：逐条按 RFC 6901 指针核对，全部命中才算这一步过。
     *
     * <p>
     * 指针语义与 {@code json-field}/{@code te-state-equals} 判据<b>同一份实现</b>
     * （{@link Json#resolvePointer}）——同一件事只有一个定义点，编排期与判据期不会分叉。
     * 任一条不命中即 {@code CP-EXEC-001}，{@code context.assertions} 逐条给出
     * {@code {pointer, expect, actual, ok}}（失败显式：不静默跳过、不空转绿）。
     */
    /**
     * 逐步断言的实现（静态：段推进器 {@link ActionStepDriver} 也要用，而推进器刻意不持有
     * {@code CaseRunAction} 实例——它必须能在没有 Minecraft 的环境里被单测直接驱动）。
     */
    private static JsonArray assertStep(String action, int index, JsonObject result, JsonObject expect) {
        JsonArray out = new JsonArray();
        JsonArray failed = new JsonArray();
        for (java.util.Map.Entry<String, JsonElement> e : Json.entries(expect)) {
            String pointer = e.getKey();
            JsonElement want = e.getValue();
            JsonElement actual = Json.resolvePointer(result, pointer);
            boolean ok = actual != null && actual.equals(want);
            JsonObject a = new JsonObject();
            a.addProperty("pointer", pointer);
            a.add("expect", Json.copy(want));
            a.add("actual", actual == null ? com.google.gson.JsonNull.INSTANCE : Json.copy(actual));
            a.addProperty("ok", Boolean.valueOf(ok));
            if (!ok) {
                JsonObject f = new JsonObject();
                f.addProperty("pointer", pointer);
                f.add("expect", Json.copy(want));
                f.add("actual", actual == null ? com.google.gson.JsonNull.INSTANCE : Json.copy(actual));
                failed.add(f);
            }
            out.add(a);
        }
        if (failed.size() > 0) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "编排步骤逐步断言未通过（action[" + index + "] " + action + "）：" + failed.size() + "/" + out.size() + " 条不命中",
                Json.object(
                    "field",
                    "action[" + index + "].expect",
                    "action",
                    action,
                    "index",
                    Integer.valueOf(index),
                    "assertions",
                    out,
                    "failed",
                    failed));
        }
        return out;
    }

    /**
     * 编排产物的默认 role：由动作名的<b>首段</b>派生（{@code player.place_block} → {@code player-place_block}）。
     *
     * <p>
     * 与 {@code read} 段的 {@link #deriveRole} 不同（那条固定 {@code read-} 前缀，因为读面是一族）。
     * 编排段能调任意族，用首段做前缀才有区分度（{@code scene-*} / {@code player-*} / …）。
     */
    static String deriveActionRole(String action) {
        if (action == null) {
            return "action";
        }
        return "action-" + action.replace('.', '-');
    }

    /**
     * 步骤间收敛：等集成服把上一步发出的包处理掉，再跑下一步。
     *
     * <h2>为什么「逐步」必须包含这一步（实机实测）</h2>
     * 本段在**单次 {@code advance}** 里逐条跑完（同步动作不跨 tick），而 L1（{@code player.*}）
     * 的请求是<b>包</b>：客户端发出 C03/C07/C08，服务端在<b>它自己线程的 tick</b> 里处理
     * （{@code MinecraftServer.updateTimeLightAndEntities → networkTick}）。
     * 因此「上一步发了包」与「下一步能读到它的后果」之间隔着服务端的一拍。
     *
     * <p>
     * 实测形态（首轮实机）：{@code l1-orchestration} 里 {@code scene.player.pose} 之后紧跟
     * {@code player.move}，move 的 {@code serverBefore=[62.5,12.0,64.5]} 还是 pose <b>之前</b>的位置，
     * 于是 move 从旧位置起算、被服务端拽回（{@code movedServerBlocks=0, observed=false}）。
     * 而 move 内部自己的 {@code awaitServerSync()} 只保证「move 自己发的那一批」被处理——
     * 它管不到「上一步的包还没被处理」。
     *
     * <p>
     * 因此收敛点必须在本段（编排层），而不是在某个动作里：动作只知道自己的请求，
     * 只有编排层知道「这一步之后还有下一步」。
     *
     * <h2>收敛多久</h2>
     * 用 L1 自己的口径（{@link PlayerSession#DEFAULT_SERVER_SYNC_TICKS} = 2 个服务端 tick，
     * 上限 {@link PlayerSession#DEFAULT_SERVER_SYNC_TIMEOUT_MS} = 500ms）——不另立一套等待语义。
     * 最后一步不等（没有下一步要收敛）。等待时长写进该步的段记录（{@code settleMs}），
     * 让「等了多久」可见而不是隐式。
     *
     * <p>
     * <b>哪些步骤后要等（第二轮实机修正）</b>：<b>除 {@code read.*} 之外全等</b>。
     * 首版只对 {@code player.*} 等，结果 {@code scene.player.pose} → {@code player.move}
     * 这个组合照样翻车：pose 走 {@code setPositionAndUpdate}（S08）把<b>服务端</b>玩家挪到新位置，
     * 而<b>客户端</b>要收到 S08 才会跟过去；不等待时 move 拿着<b>旧</b>客户端坐标发 C03，
     * 服务端 {@code processPlayer} 判定不符并把玩家拽回（实测 {@code movedServerBlocks=0}，
     * 客户端反被拉走 2 格）。
     *
     * <p>
     * 因此判定按「这一步有没有写」而不是「是不是 L1」：{@code scene.*} 同样会触发原版同步出口
     * （S08/S2B/S1D/S2F…），而 {@code read.*} 是纯读（无包、无世界写），对它等待纯属白花时间——
     * 那正是「便宜试错」要避免的。
     *
     * <h2>为什么是「往返」而不是「等服务端 tick」（第三轮实机修正）</h2>
     * 只等服务端 tick 不够：{@code scene.player.pose} 的 S08 是<b>服务端→客户端</b>方向，
     * 而「收到并应用入站包」发生在<b>客户端</b>的 tick 里
     * （{@code Minecraft.runTick → NetHandlerPlayClient.processReceivedPackets}）。
     * 本段跑在客户端 tick 线程上并阻塞等待——<b>客户端自己那一拍因此永远不来</b>，
     * S08 就躺在入站队列里（实测：settle 98ms 后客户端仍在旧位置）。
     * 故必须显式把入站队列推出去（{@link PlayerSession#completeClientRequest}：
     * flush 入站 + 等服务端 tick），这与 L1 动作回读前的收尾是<b>同一份实现</b>，不另立一套。
     */
    private void settleBetweenSteps(ActionContext ctx, String action, int index, int lastIndex, JsonObject rec) {
        if (index >= lastIndex) {
            return;
        }
        if (action == null || action.startsWith("read.")) {
            return;
        }
        long waited;
        try {
            EntityClientPlayerMP client = mc == null ? null : mc.thePlayer;
            NetHandlerPlayClient handler = client == null ? null : client.sendQueue;
            if (handler != null) {
                // 往返：先把入站包推出去（应用 S08/S2B/…），再等集成服把出站包处理掉
                waited = PlayerSession.completeClientRequest(handler);
            } else {
                waited = PlayerSession.awaitServerSync();
            }
        } catch (Throwable t) {
            // 收敛失败不该让整跑失败：如实记 -1，由后续步骤/判据去暴露真实后果
            CpLog.warn("编排步骤收敛等待失败（action[%d] %s）: %s", Integer.valueOf(index), action, String.valueOf(t));
            waited = -1L;
        }
        rec.addProperty("settleMs", Long.valueOf(waited));
        if (waited > 0) {
            CpLog.info("编排步骤 action[%d]（%s）后等待服务端/客户端收敛 %d ms", Integer.valueOf(index), action, Long.valueOf(waited));
        }
    }

    /** {@code criteria} 段：core 判据引擎 + 本层注入的运行期哈希来源。 */
    private JsonObject stepCriteria(ActionContext ctx) throws Exception {
        if (criteriaDoc == null) {
            // case-file.md §8 第 2 条：本 run 缺的产物从当前世界状态重新产出（如 scene-manifest.json）
            ensureSceneManifestArtifact(ctx);
            // case-file.md §8 第 3 条：observation.json 必须在判据段求值之前落盘（判据会引用它）
            writeObservation(ctx);
            JsonArray criteria = Json.optArray(plan, "criteria");
            criteriaDoc = engine(ctx).evaluate(criteria, runId(ctx));
            writeArtifact(ctx, CRITERIA_PATH, Json.toPretty(criteriaDoc), "criteria");
        }
        return criteriaDoc;
    }

    /** {@code evidence} 段：core 的证据清单核对（observation.json/criteria.json 已先行落盘）。 */
    private JsonObject stepEvidence(ActionContext ctx) throws Exception {
        if (evidenceDoc == null) {
            // 本 run 必然产出的两份清单先落盘：核对口径是「运行结束时这些产物在不在」
            // （case-file.md §7），否则期望证据里的 criteria.json / observation.json 会在这里被判红
            if (criteriaDoc == null) {
                criteriaDoc = emptyCriteriaDoc(ctx);
                writeArtifact(ctx, CRITERIA_PATH, Json.toPretty(criteriaDoc), "criteria");
            }
            writeObservation(ctx);
            JsonObject ev = Json.optObject(plan, "evidence");
            JsonArray expect = ev == null ? new JsonArray() : Json.optArray(ev, "expect");
            JsonObject verdict = engine(ctx).checkEvidence(expect);
            evidenceDoc = new JsonObject();
            evidenceDoc.addProperty("schema", "lightning.cp-evidence/1");
            evidenceDoc.addProperty("runId", runId(ctx));
            evidenceDoc.addProperty(
                "generatedAt",
                TimeSource.system()
                    .isoNow());
            evidenceDoc.add("verdict", verdict);
            evidenceDoc.addProperty("overall", Json.optString(verdict, "verdict", CriteriaEngine.Verdicts.RED));
            JsonArray items = new JsonArray();
            for (int i = 0; expect != null && i < expect.size(); i++) {
                JsonElement e = expect.get(i);
                if (e != null && e.isJsonObject()) {
                    items.add(Json.copyObject(e.getAsJsonObject()));
                }
            }
            evidenceDoc.add("expect", items);
            writeArtifact(ctx, EVIDENCE_PATH, Json.toPretty(evidenceDoc), "evidence");
        }
        return evidenceDoc;
    }

    // ------------------------------------------------------------ 收尾

    private JsonObject finalizeRun(ActionContext ctx) throws Exception {
        if (!finalized) {
            finalized = true;
            enterStage("case.finalize");
            if (variantId != null) {
                variantVerification = verifyVariant();
                variants.add(variantItem(variantId, expectRed, criteriaVerdictPairs()));
            } else {
                sweepVariants(ctx);
            }
            if (hasSegment(SEG_EVIDENCE) && evidenceDoc == null) {
                stepEvidence(ctx);
            }
            if (criteriaDoc == null) {
                criteriaDoc = emptyCriteriaDoc(ctx);
                writeArtifact(ctx, CRITERIA_PATH, Json.toPretty(criteriaDoc), "criteria");
            }
            writeObservation(ctx);
            progress(ctx, 1.0d, "done");
        }
        JsonObject result = buildResult(ctx);
        if (variantId != null && variantVerification != null && !Json.optBool(variantVerification, "ok", false)) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "负对照变体未按预期变红（expectCriteriaRed 未全部命中）", variantVerification);
        }
        if (variantFailed) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "负对照变体未按预期变红（expectCriteriaRed 未全部命中）",
                Json.object("variants", Json.copyArray(variants)));
        }
        return result;
    }

    /** 失败路径上的尽力收尾：把已有的结论与观测记录落盘，便于事后定位。 */
    private void finalizeBestEffort(ActionContext ctx) {
        if (finalized) {
            return;
        }
        finalized = true;
        try {
            if (criteriaDoc != null && ctx.artifacts() != null
                && ctx.run() != null
                && ctx.run()
                    .artifact(CRITERIA_PATH) == null) {
                writeArtifact(ctx, CRITERIA_PATH, Json.toPretty(criteriaDoc), "criteria");
            }
            writeObservation(ctx);
        } catch (Throwable t) {
            CpLog.warn("失败收尾写产物异常: %s", String.valueOf(t));
        }
    }

    private JsonObject buildResult(ActionContext ctx) {
        JsonObject o = new JsonObject();
        o.addProperty("caseId", caseFile.id());
        o.addProperty("caseSha256", caseFile.sha256());
        if (ctx.run() != null) {
            o.addProperty(
                "runId",
                ctx.run()
                    .runId());
        }
        o.addProperty("variant", variantId);
        o.add("segmentsRun", toJsonArray(segments));
        o.add("segmentsSkipped", toJsonArray(skippedSegments));
        o.add("segments", Json.copyArray(segmentRecords));
        if (deferred.size() > 0) {
            o.add("deferred", Json.copyArray(deferred));
            o.addProperty("deferredNote", "deferred: contract v1.x");
        }
        if (worldResult != null) {
            o.add("world", worldResult);
        }
        JsonObject scene = new JsonObject();
        if (manifest != null) {
            scene.addProperty("sha256", Json.optString(manifest, "sha256", null));
            scene.addProperty("sceneManifestSha256", Json.optString(manifest, "sha256", null));
            scene.addProperty("stepCount", Json.optInt(manifest, "stepCount", 0));
            scene.addProperty("blockCount", size(Json.optArray(manifest, "blocks")));
            scene.addProperty("teCount", size(Json.optArray(manifest, "tileEntities")));
            scene.addProperty("mismatchCount", size(Json.optArray(manifest, "mismatches")));
            scene.addProperty("manifestPath", SceneManifest.RUN_RELATIVE_PATH);
        } else if (regeneratedManifest != null) {
            scene.addProperty("sha256", Json.optString(regeneratedManifest, "sha256", null));
            scene.addProperty("sceneManifestSha256", Json.optString(regeneratedManifest, "sha256", null));
            scene.addProperty("manifestPath", SceneManifest.RUN_RELATIVE_PATH);
            scene.addProperty("regenerated", true);
            scene.addProperty("note", "本次 run 未执行 build 段：清单从当前世界状态重新产出（case-file.md §8 第 2 条）");
        } else {
            scene.addProperty("sha256", (String) null);
            scene.addProperty("sceneManifestSha256", (String) null);
            scene.addProperty("note", "本次 run 未执行 build 段；场景哈希见世界内 scene-manifest.json");
        }
        o.add("scene", scene);
        JsonObject criteria = new JsonObject();
        criteria.addProperty("path", CRITERIA_PATH);
        criteria.addProperty("executed", hasSegment(SEG_CRITERIA));
        criteria.addProperty("overall", criteriaDoc == null ? null : Json.optString(criteriaDoc, "overall", null));
        if (criteriaDoc != null) {
            criteria.add("counts", Json.optObject(criteriaDoc, "counts"));
        }
        o.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        evidence.addProperty("path", EVIDENCE_PATH);
        evidence.addProperty("executed", hasSegment(SEG_EVIDENCE));
        if (evidenceDoc != null) {
            evidence.addProperty("verdict", Json.optString(evidenceDoc, "overall", null));
            evidence.add("detail", Json.optObject(evidenceDoc, "verdict"));
        }
        o.add("evidence", evidence);
        o.addProperty("overall", overall());
        o.addProperty("observationPath", OBSERVATION_PATH);
        if (shotResult != null) {
            // 逐机位产物引用 + 实际渲染参数（契约 §7.3：结果含每机位产物引用与实际渲染参数）
            JsonObject shots = new JsonObject();
            shots.addProperty("executor", "shot.multi");
            shots.addProperty("cameraCount", Json.optInt(shotResult, "cameraCount", 0));
            shots.addProperty("shotCount", Json.optInt(shotResult, "shotCount", 0));
            shots.addProperty("failedCount", Json.optInt(shotResult, "failedCount", 0));
            shots.add("cameras", Json.copyArray(cameraSummaries));
            JsonArray refs = new JsonArray();
            JsonArray perCamera = Json.optArray(shotResult, "cameras");
            for (int i = 0; perCamera != null && i < perCamera.size(); i++) {
                JsonObject c = perCamera.get(i)
                    .getAsJsonObject();
                JsonObject ref = new JsonObject();
                ref.addProperty("name", Json.optString(c, "name", null));
                ref.addProperty("ok", Boolean.valueOf(Json.optBool(c, "ok", false)));
                ref.addProperty("file", Json.optString(c, "file", null));
                ref.addProperty("metaFile", Json.optString(c, "metaFile", null));
                ref.addProperty("tilesDir", Json.optString(c, "tilesDir", null));
                ref.addProperty("renderMode", Json.optString(c, "renderMode", null));
                ref.addProperty("lighting", Json.optString(c, "lighting", null));
                ref.addProperty("worldTime", Long.valueOf(Json.optLong(c, "worldTime", -1L)));
                refs.add(ref);
            }
            shots.add("artifacts", refs);
            o.add("shots", shots);
        }
        if (captureSpec != null || captureArmed) {
            JsonObject capture = new JsonObject();
            if (captureSpec != null) {
                capture.add("spec", captureSpec.toJson());
                capture.addProperty("lighting", CameraSpecs.resolveLighting(null, captureSpec));
                capture.addProperty("renderMode", CameraSpecs.resolveRenderMode(null, captureSpec));
            }
            capture.addProperty("armed", Boolean.valueOf(captureArmed));
            o.add("capture", capture);
        }
        if (variants.size() > 0) {
            // case-file.md §8 第 5 条：变体结论写入结果 variants:[{id, allExpectedRed, criteria:[...]}]
            o.add("variants", Json.copyArray(variants));
        }
        if (variantVerification != null) {
            o.add("variantVerification", variantVerification);
        }
        JsonArray warnings = Json.optArray(plan, "warnings");
        o.addProperty("warningCount", warnings == null ? 0 : warnings.size());
        if (warnings != null) {
            o.add("warnings", Json.copyArray(warnings));
        }
        if (failure != null) {
            o.add("failure", failure);
        }
        if (ctx.run() != null) {
            JsonArray arts = ctx.run()
                .artifactsJson();
            o.add("artifacts", arts);
            o.addProperty("artifactCount", arts.size());
        }
        return o;
    }

    /** 合并结论：criteria 与 evidence 任一红/错即 red。 */
    private String overall() {
        boolean red = false;
        if (criteriaDoc != null) {
            red |= !CriteriaEngine.Verdicts.GREEN
                .equals(Json.optString(criteriaDoc, "overall", CriteriaEngine.Verdicts.RED));
        }
        if (evidenceDoc != null) {
            red |= !CriteriaEngine.Verdicts.GREEN
                .equals(Json.optString(evidenceDoc, "overall", CriteriaEngine.Verdicts.RED));
        }
        if (failure != null) {
            red = true;
        }
        if (criteriaDoc == null && evidenceDoc == null && failure == null) {
            return CriteriaEngine.Verdicts.GREEN;
        }
        return red ? CriteriaEngine.Verdicts.RED : CriteriaEngine.Verdicts.GREEN;
    }

    // ------------------------------------------------------------ 变体

    private void applyVariant(String id) {
        CaseFile.Variant variant = null;
        for (CaseFile.Variant v : caseFile.variants()) {
            if (v.id()
                .equals(id)) {
                variant = v;
                break;
            }
        }
        if (variant == null) {
            throw CpException.param("未知变体 id", "variant", "用例未声明该变体: " + id + "（已声明 " + variantIds() + "）");
        }
        String prefix = "variants[" + id + "].mutate";
        JsonObject mutated = variant.applyTo(caseFile.raw(), prefix);
        CaseFile mutatedFile = new CaseParser().parse(mutated, Json.toJson(mutated));
        // 变体产物文档的二次校验：补丁适用性判定必须关掉——这份文档已经是补丁结果，
        // 再应用同一补丁必然「什么都没改」，用 ENFORCE 会把自己的产物判成非法（见 VariantCheck）。
        new CaseValidator().plan(mutatedFile, CaseValidator.VariantCheck.SKIP);
        caseFile = mutatedFile;
        variantId = id;
        expectRed = variant.expectCriteriaRed();
        CpLog.info("已应用负对照变体 %s（expectCriteriaRed=%s）", id, expectRed.toString());
    }

    /**
     * 未指定 {@code variant} 时的变体扫描（case-file.md §8 第 5 条：整跑后顺带执行全部变体，
     * 结论写入结果 {@code variants:[{id, allExpectedRed, criteria:[...]}]}）。
     *
     * <h2>为什么判据类变体不重建世界</h2>
     * 变体只有「改判据参数」时，{@code world}/{@code build} 输入与原用例逐字节相同；而重建是幂等的
     * （同一输入 → 同一场景哈希），因此对同一世界状态求值 <b>等价于</b>整跑一遍，且不会把世界留在
     * 变体状态、不会污染本 run 的产物。改到 {@code world}/{@code build} 段的变体则需要真实重建，
     * 未指定 {@code variant} 时本版<b>不</b>执行它们（在结果里标 {@code evaluated:false} 并给出原因，
     * 请用 {@code variant:"<id>"} 单独执行）——这是与 §8 第 5 条的已知偏差，单独登记。
     */
    private void sweepVariants(ActionContext ctx) {
        if (!hasSegment(SEG_CRITERIA)) {
            return; // 没跑判据段，红绿无从判定
        }
        List<CaseFile.Variant> declared = caseFile.variants();
        if (declared.isEmpty()) {
            return;
        }
        JsonObject baseRaw = caseFile.raw();
        for (CaseFile.Variant v : declared) {
            JsonObject item;
            try {
                JsonObject mutated = v.applyTo(baseRaw, "variants[" + v.id() + "].mutate");
                boolean touchesScene = !eq(Json.get(baseRaw, "world"), Json.get(mutated, "world"))
                    || !eq(Json.get(baseRaw, "build"), Json.get(mutated, "build"));
                if (touchesScene) {
                    item = variantItem(v.id(), v.expectCriteriaRed(), null);
                    item.addProperty("evaluated", false);
                    item.addProperty("reason", "变体改动 world/build 段：未指定 variant 时不在整跑里重建世界（请用 variant 单独执行）");
                    CpLog.warn("变体 %s 改动世界/构建段，整跑中未执行（请用 variant 单独跑）", v.id());
                } else {
                    CaseFile mutatedFile = new CaseParser().parse(mutated, Json.toJson(mutated));
                    // 同上：这份文档已是补丁产物，适用性判定必须关掉，否则变体评估整段被误报跳过。
                    JsonObject mutatedPlan = new CaseValidator().plan(mutatedFile, CaseValidator.VariantCheck.SKIP);
                    JsonObject doc = engine(ctx)
                        .evaluate(Json.optArray(mutatedPlan, "criteria"), runId(ctx) + "#" + v.id());
                    item = variantItem(v.id(), v.expectCriteriaRed(), verdictPairs(doc));
                    JsonObject verdict = new JsonObject();
                    verdict.addProperty("allExpectedRed", Json.optBool(item, "allExpectedRed", false));
                    item.addProperty("evaluated", true);
                    if (!Json.optBool(item, "allExpectedRed", false)) {
                        variantFailed = true;
                        CpLog.warn("负对照变体 %s 未按预期变红: %s", v.id(), Json.toJson(item));
                    }
                }
            } catch (Throwable t) {
                item = variantItem(v.id(), v.expectCriteriaRed(), null);
                item.addProperty("evaluated", false);
                item.addProperty("error", String.valueOf(t));
                CpLog.warn("变体 %s 求值异常（不影响主结论）: %s", v.id(), String.valueOf(t));
            }
            variants.add(item);
        }
    }

    /**
     * 组一条变体结论（{@code {id, variantId, expectCriteriaRed, allExpectedRed, criteria:[{id,verdict,...}]}}）。
     *
     * <p>
     * 字段里同时给 {@code id} 与 {@code variantId}、结论里带 {@code criteria[].verdict}：
     * 调用方（含只看作业 JSON 的验收脚本）不必知道结论挂在哪个字段下，按 id 找子树即可拿到逐条红绿。
     *
     * @param pairs 判据结论对（{@code {id,type,verdict,detail}}）；null 表示未求值
     */
    private JsonObject variantItem(String id, List<String> expectCriteriaRed, JsonArray pairs) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("variantId", id);
        JsonArray expected = new JsonArray();
        for (String s : expectCriteriaRed) {
            Json.add(expected, s);
        }
        o.add("expectCriteriaRed", expected);
        o.addProperty("evaluated", pairs != null);
        JsonArray notRed = new JsonArray();
        JsonArray missing = new JsonArray();
        if (pairs == null) {
            o.addProperty("allExpectedRed", (Boolean) null);
        } else {
            for (String cid : expectCriteriaRed) {
                String verdict = null;
                for (int i = 0; i < pairs.size(); i++) {
                    JsonObject c = pairs.get(i)
                        .getAsJsonObject();
                    if (cid.equals(Json.optString(c, "id", null))) {
                        verdict = Json.optString(c, "verdict", null);
                        break;
                    }
                }
                if (verdict == null) {
                    Json.add(missing, cid);
                } else if (!CriteriaEngine.Verdicts.RED.equals(verdict)) {
                    Json.add(notRed, cid);
                }
            }
            o.addProperty("allExpectedRed", notRed.size() == 0 && missing.size() == 0 && expectCriteriaRed.size() > 0);
            o.add("criteria", Json.copyArray(pairs));
        }
        o.add("notRed", notRed);
        o.add("missing", missing);
        return o;
    }

    /** 从本次判据结论里取 {@code {id,type,verdict,detail}} 对。 */
    private JsonArray criteriaVerdictPairs() {
        return verdictPairs(criteriaDoc);
    }

    private static JsonArray verdictPairs(JsonObject criteriaDoc) {
        JsonArray out = new JsonArray();
        JsonArray arr = criteriaDoc == null ? null : Json.optArray(criteriaDoc, "criteria");
        for (int i = 0; arr != null && i < arr.size(); i++) {
            JsonElement e = arr.get(i);
            if (e == null || !e.isJsonObject()) {
                continue;
            }
            JsonObject c = e.getAsJsonObject();
            JsonObject p = new JsonObject();
            p.addProperty("id", Json.optString(c, "id", null));
            p.addProperty("type", Json.optString(c, "type", null));
            p.addProperty("verdict", Json.optString(c, "verdict", null));
            p.addProperty("detail", Json.optString(c, "detail", ""));
            out.add(p);
        }
        return out;
    }

    private static boolean eq(JsonElement a, JsonElement b) {
        if (a == null && b == null) {
            return true;
        }
        return a != null && a.equals(b);
    }

    /** 变体断言：{@code expectCriteriaRed} 列的判据必须变红。 */
    private JsonObject verifyVariant() {
        JsonObject o = new JsonObject();
        o.addProperty("variantId", variantId);
        JsonArray expected = new JsonArray();
        for (String s : expectRed) {
            Json.add(expected, s);
        }
        o.add("expectCriteriaRed", expected);
        JsonObject actual = new JsonObject();
        JsonArray notRed = new JsonArray();
        JsonArray missing = new JsonArray();
        if (criteriaDoc != null) {
            JsonArray arr = Json.optArray(criteriaDoc, "criteria");
            for (String id : expectRed) {
                String verdict = null;
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    JsonObject c = arr.get(i)
                        .getAsJsonObject();
                    if (id.equals(Json.optString(c, "id", null))) {
                        verdict = Json.optString(c, "verdict", null);
                        break;
                    }
                }
                if (verdict == null) {
                    Json.add(missing, id);
                    actual.addProperty(id, (String) null);
                } else {
                    actual.addProperty(id, verdict);
                    if (!CriteriaEngine.Verdicts.RED.equals(verdict)) {
                        Json.add(notRed, id);
                    }
                }
            }
        } else {
            for (String id : expectRed) {
                Json.add(missing, id);
            }
        }
        o.add("actual", actual);
        o.add("notRed", notRed);
        o.add("missing", missing);
        boolean ok = notRed.size() == 0 && missing.size() == 0 && expectRed.size() > 0;
        o.addProperty("ok", ok);
        o.addProperty("detail", ok ? "全部期望判据已变红" : "未变红: " + notRed + "，缺失: " + missing);
        return o;
    }

    // ------------------------------------------------------------ 工具

    private CriteriaEngine engine(ActionContext ctx) {
        if (engine == null) {
            engine = new CriteriaEngine(
                ctx.artifacts(),
                ctx.run(),
                runtime == null ? null : runtime.events(),
                hashSource(),
                teSource(),
                TimeSource.system());
        }
        return engine;
    }

    /**
     * 运行期 TE 状态来源（{@code te-state-equals} 判据的唯一外部数据，1.2 运行期轨）。
     *
     * <p>
     * 与 {@link #hashSource()} 同一接线模式：core 只负责「拿状态 → 按 RFC 6901 指针取值 → 比较」，
     * 「状态从哪来」由本层注入。这里把请求转给 {@link TeDescribers}——它按注册顺序问每个族描述器
     * （LP 管道 / AE2 部件），第一个认领该 TE 的胜出；<b>没有</b>描述器认领（位置没 TE、或整合包里
     * 没有对应模组）时返回 null，判据据此报 {@code error}（视同 red 单列）。
     *
     * <p>
     * 每次求值都实读世界：判据段可能在任何时刻跑（按段续跑、变体扫描），缓存一个 TE 快照会把
     * 「世界漂移」这件事藏起来。
     */
    private CriteriaEngine.RuntimeTeSource teSource() {
        return new CriteriaEngine.RuntimeTeSource() {

            @Override
            public TeState describe(int x, int y, int z) {
                WorldServer world = WorldRuntime.serverWorld();
                if (world == null) {
                    return null;
                }
                return TeDescribers.describe(world, x, y, z);
            }
        };
    }

    /**
     * 运行期哈希来源（{@code world-hash-equals} 判据的唯一外部数据）。
     *
     * <p>
     * 首次构建哈希：本 run 的 {@link #manifest}；本 run 没跑 build 段时取世界内
     * {@code scene-manifest.json}（按段续跑场景）。当前哈希：服务端世界<b>实读</b>同一批位置后的
     * 规范化哈希——两边都不是缓存值。
     */
    private CriteriaEngine.RuntimeHashSource hashSource() {
        return new CriteriaEngine.RuntimeHashSource() {

            @Override
            public String sceneHashFirstBuild() {
                JsonObject m = firstBuildManifest();
                return m == null ? null : Json.optString(m, "sha256", null);
            }

            @Override
            public String sceneHashCurrent() {
                return SceneManifestStore.readBackHash(WorldRuntime.serverWorld(), firstBuildManifest());
            }
        };
    }

    private JsonObject firstBuildManifest() {
        if (manifest != null) {
            return manifest;
        }
        JsonObject w = Json.optObject(plan, "world");
        String folder = w == null ? null : Json.optString(w, "folder", null);
        return mc == null || folder == null ? null : SceneManifestStore.read(mc.mcDataDir, folder);
    }

    /**
     * 保证本 run 目录里有 {@code world/scene-manifest.json}（case-file.md §8 第 2 条）。
     *
     * <p>
     * 本 run 跑过 build 段时产物已在；没跑（按段续跑）时从<b>当前世界状态</b>重新产出：
     * 位置集合取世界内最新清单，方块/方块实体的值一律实读，重算规范化 sha256 后落本 run 目录。
     * 存档目录里的清单<b>不</b>被覆盖——那是「构建记录」，也是 {@code world-hash-equals} 的首次哈希来源。
     *
     * <p>
     * 重新产出的清单只作为本 run 的产物/证据，<b>不</b>参与判据的「首次构建哈希」
     * （否则幂等判据会拿世界跟它自己比，永远绿）。
     */
    private void ensureSceneManifestArtifact(ActionContext ctx) {
        if (ctx.run() == null || ctx.artifacts() == null) {
            return;
        }
        if (ctx.run()
            .artifact(SceneManifest.RUN_RELATIVE_PATH) != null) {
            return;
        }
        JsonObject w = Json.optObject(plan, "world");
        String folder = w == null ? null : Json.optString(w, "folder", null);
        WorldServer world = WorldRuntime.serverWorld();
        JsonObject stored = mc == null || folder == null ? null : SceneManifestStore.read(mc.mcDataDir, folder);
        JsonObject regenerated = null;
        if (stored != null && world != null) {
            regenerated = SceneManifest.rebuildFromWorld(world, stored);
        }
        if (regenerated == null && world != null) {
            regenerated = SceneManifest.rebuildFromWorld(world, planDerivedManifestStub());
        }
        if (regenerated == null) {
            CpLog.warn("本 run 缺 %s 且无法从世界状态重新产出（世界未加载或无构建记录）", SceneManifest.RUN_RELATIVE_PATH);
            return;
        }
        regeneratedManifest = regenerated;
        writeArtifact(ctx, SceneManifest.RUN_RELATIVE_PATH, Json.toPretty(regenerated), "scene-manifest");
        CpLog.info("已从当前世界状态重新产出场景清单（按段续跑）：%s", Json.optString(regenerated, "sha256", null));
    }

    /** 没有世界内清单时的位置兜底：直接用用例 build 段声明的坐标。 */
    private JsonObject planDerivedManifestStub() {
        JsonArray steps = Json.optArray(plan, "build");
        if (steps == null || steps.size() == 0) {
            return null;
        }
        JsonObject w = Json.optObject(plan, "world");
        JsonObject stub = new JsonObject();
        stub.addProperty("schema", SceneManifest.SCHEMA);
        if (w != null) {
            for (String key : new String[] { "folder", "seed", "void", "settleTicks" }) {
                JsonElement v = Json.get(w, key);
                if (v != null) {
                    stub.add(key, Json.copy(v));
                }
            }
        }
        JsonArray blocks = new JsonArray();
        JsonArray tes = new JsonArray();
        for (int i = 0; i < steps.size(); i++) {
            JsonElement e = steps.get(i);
            if (e == null || !e.isJsonObject()) {
                continue;
            }
            JsonObject step = e.getAsJsonObject();
            String op = Json.optString(step, "op", null);
            if ("block".equals(op)) {
                int[] at = ints(Json.optArray(step, "at"));
                if (at != null) {
                    blocks.add(SceneManifest.blockEntry(at, 0, 0, Json.optString(step, "id", null)));
                }
            } else if ("te".equals(op)) {
                int[] at = ints(Json.optArray(step, "at"));
                if (at != null) {
                    tes.add(SceneManifest.teEntry(at, SceneManifest.ABSENT));
                }
            }
        }
        stub.addProperty("stepCount", steps.size());
        // 与 SceneBuilder.finish 同一口径（同一 pos 后写覆盖）——这份存根也是清单的
        // 数据入口之一（readBack 按它的位置集合实读），不能在这里留下重复 pos。
        stub.add("blocks", SceneManifest.manifestBlocks(blocks));
        stub.add("tileEntities", SceneManifest.manifestTes(tes));
        return stub;
    }

    private static int[] ints(JsonArray a) {
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            out[i] = a.get(i)
                .getAsInt();
        }
        return out;
    }

    private void writeObservation(ActionContext ctx) {
        if (ctx.run() == null || ctx.artifacts() == null) {
            return;
        }
        if (ctx.run()
            .artifact(OBSERVATION_PATH) != null) {
            return;
        }
        ObservationCollector.Input in = new ObservationCollector.Input();
        in.mc = mc;
        in.run = ctx.run();
        in.caseFile = caseFile;
        in.plan = plan;
        in.manifest = manifest != null ? manifest : firstBuildManifest();
        in.criteria = criteriaDoc;
        in.deferred = deferred;
        in.variant = variantVerification;
        in.failure = failure;
        // 1.1：注入机位摘要（observation-record.md §2 第 4 条）——camera 记首个机位，cameras[] 记全部
        in.cameras = Json.copyArray(cameraSummaries);
        in.captureSpec = captureSpec;
        in.shotResult = shotResult;
        ObservationRecord record = ObservationCollector.collect(in);
        writeArtifact(ctx, OBSERVATION_PATH, record.toPrettyString(), "observation");
    }

    private JsonObject emptyCriteriaDoc(ActionContext ctx) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", Contract.SCHEMA_CRITERIA);
        o.addProperty("runId", runId(ctx));
        o.addProperty(
            "generatedAt",
            TimeSource.system()
                .isoNow());
        o.addProperty("overall", CriteriaEngine.Verdicts.GREEN);
        JsonObject counts = new JsonObject();
        counts.addProperty(CriteriaEngine.Verdicts.GREEN, 0);
        counts.addProperty(CriteriaEngine.Verdicts.RED, 0);
        counts.addProperty(CriteriaEngine.Verdicts.ERROR, 0);
        o.add("counts", counts);
        o.add("criteria", new JsonArray());
        o.addProperty("note", "本次 run 未执行 criteria 段");
        return o;
    }

    private void writeArtifact(ActionContext ctx, String relPath, String text, String role) {
        if (ctx.artifacts() == null || ctx.run() == null) {
            return;
        }
        ctx.artifacts()
            .writeArtifact(ctx.run(), relPath, text.getBytes(StandardCharsets.UTF_8), role);
    }

    private void writeCaseArtifacts(ActionContext ctx, ArtifactStore.Run run) {
        if (ctx.artifacts() == null || run == null) {
            return;
        }
        String text = caseFile.rawText();
        ctx.artifacts()
            .writeArtifact(run, "case.json", text.getBytes(StandardCharsets.UTF_8), "case");
    }

    private void recordSegment(ActionContext ctx, String name, String status, JsonObject detail) {
        JsonObject o = new JsonObject();
        o.addProperty("segment", name);
        o.addProperty("status", status);
        o.addProperty("runId", runId(ctx));
        o.addProperty(
            "jobId",
            ctx.job() == null ? null
                : ctx.job()
                    .jobId());
        o.addProperty(
            "recordedAt",
            TimeSource.system()
                .isoNow());
        if (segmentStarted && segmentStartMillis > 0) {
            o.addProperty("durationMs", Long.valueOf(System.currentTimeMillis() - segmentStartMillis));
        }
        if (detail != null) {
            o.add("detail", Json.copyObject(detail));
        }
        segmentRecords.add(o);
        try {
            Path dir = ctx.runDir() == null ? null
                : ctx.runDir()
                    .resolve("segments");
            if (dir != null) {
                Files.createDirectories(dir);
                Files.write(
                    dir.resolve(name + ".json"),
                    Json.toPretty(o)
                        .getBytes(StandardCharsets.UTF_8));
                if (ctx.artifacts() != null && ctx.run() != null) {
                    ctx.artifacts()
                        .registerArtifact(ctx.run(), "segments/" + name + ".json", "segment");
                }
            }
        } catch (Exception e) {
            throw CpException.io("写段记录失败: segments/" + name + ".json", e);
        }
    }

    private boolean hasSegment(String name) {
        return segments.contains(name);
    }

    private String runId(ActionContext ctx) {
        return ctx.run() == null ? null
            : ctx.run()
                .runId();
    }

    private double fractionOfStep() {
        return segIndex / (double) Math.max(1, segments.size());
    }

    private String variantIds() {
        List<String> ids = new ArrayList<String>();
        for (CaseFile.Variant v : caseFile.variants()) {
            ids.add(v.id());
        }
        return ids.toString();
    }

    private static boolean contains(JsonArray a, String v) {
        for (int i = 0; i < a.size(); i++) {
            if (a.get(i)
                .getAsString()
                .equals(v)) {
                return true;
            }
        }
        return false;
    }

    private static JsonArray toJsonArray(List<String> list) {
        JsonArray a = new JsonArray();
        for (String s : list) {
            Json.add(a, s);
        }
        return a;
    }

    private static int[] toIntArray(JsonArray a) {
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            out[i] = a.get(i)
                .getAsInt();
        }
        return out;
    }

    private static int size(JsonArray a) {
        return a == null ? 0 : a.size();
    }
}
