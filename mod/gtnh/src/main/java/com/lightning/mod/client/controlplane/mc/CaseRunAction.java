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
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;
import com.lightning.mod.client.controlplane.mc.capture.ShotExecutor;

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

    /** 段名：捕获会话（PR-2）。 */
    public static final String SEG_CAPTURE = "capture";

    /** 段名：场景构建。 */
    public static final String SEG_BUILD = "build";

    /** 段名：机位拍摄（PR-2）。 */
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

    /** capture 段解析出的会话（PR-2）。 */
    private CaptureSpec captureSpec;
    private boolean captureArmed;
    /** 本用例声明了哪些机位（cameras 段的规范化数组）。 */
    private JsonArray captureCameras;

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
        for (String s : Arrays.asList(SEG_WORLD, SEG_CAPTURE, SEG_BUILD, SEG_CAMERAS, SEG_CRITERIA, SEG_EVIDENCE)) {
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
        }
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

    /** {@code world} 段：同 {@code world.rebuild} 的实现（{@link WorldRebuildRunner}），不带构建段。 */
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
     * 产出不同形态的产物，这正是契约 §4 要禁止的分叉。
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

    /** {@code build} 段：{@link SceneBuilder}（与 {@code world.rebuild} 的 build 段同一实现）。 */
    private JsonObject stepBuild(ActionContext ctx) throws Exception {
        JsonObject w = Json.optObject(plan, "world");
        String folder = Json.optString(w, "folder", null);
        long seed = Json.optLong(w, "seed", 0L);
        int settle = Json.optInt(w, "settleTicks", 60);
        JsonArray steps = Json.optArray(plan, "build");
        if (builder == null) {
            builder = new SceneBuilder(steps, folder, seed, true, settle);
            CpLog.info(
                "case.build 段开始：%s，%d 步，静置 %d tick",
                folder,
                Integer.valueOf(builder.stepCount()),
                Integer.valueOf(settle));
        }
        WorldServer world = WorldRuntime.serverWorld();
        JsonObject m = builder.tick(world);
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

    /** {@code criteria} 段：core 判据引擎 + 本层注入的运行期哈希来源。 */
    private JsonObject stepCriteria(ActionContext ctx) throws Exception {
        if (criteriaDoc == null) {
            // case-file.md §8.2：本 run 缺的产物从当前世界状态重新产出（如 scene-manifest.json）
            ensureSceneManifestArtifact(ctx);
            // case-file.md §8.3：observation.json 必须在判据段求值之前落盘（判据会引用它）
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
            scene.addProperty("note", "本次 run 未执行 build 段：清单从当前世界状态重新产出（case-file.md §8.2）");
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
            // 逐机位产物引用 + 实际渲染参数（契约 §4.1：结果含每机位产物引用与实际渲染参数）
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
            // case-file.md §8.5：变体结论写入结果 variants:[{id, allExpectedRed, criteria:[...]}]
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
     * 未指定 {@code variant} 时的变体扫描（case-file.md §8.5：整跑后顺带执行全部变体，
     * 结论写入结果 {@code variants:[{id, allExpectedRed, criteria:[...]}]}）。
     *
     * <h2>为什么判据类变体不重建世界</h2>
     * 变体只有「改判据参数」时，{@code world}/{@code build} 输入与原用例逐字节相同；而重建是幂等的
     * （同一输入 → 同一场景哈希），因此对同一世界状态求值 <b>等价于</b>整跑一遍，且不会把世界留在
     * 变体状态、不会污染本 run 的产物。改到 {@code world}/{@code build} 段的变体则需要真实重建，
     * 未指定 {@code variant} 时本版<b>不</b>执行它们（在结果里标 {@code evaluated:false} 并给出原因，
     * 请用 {@code variant:"<id>"} 单独执行）——这是与 §8.5 的已知偏差，交付报告里单列。
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
                TimeSource.system());
        }
        return engine;
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
     * 保证本 run 目录里有 {@code world/scene-manifest.json}（case-file.md §8.2）。
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
        stub.add("blocks", blocks);
        stub.add("tileEntities", tes);
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
        // PR-2：注入机位摘要（observation-record.md §2.4）——camera 记首个机位，cameras[] 记全部
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
