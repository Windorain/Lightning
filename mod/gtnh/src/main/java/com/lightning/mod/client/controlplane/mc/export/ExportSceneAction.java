package com.lightning.mod.client.controlplane.mc.export;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SteppingActionBase;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.meshcapture.MeshCaptureService;
import com.lightning.mod.core.session.ExportSceneWriter;
import com.lightning.mod.core.session.ExportSession;

/**
 * {@code export.scene}（scene，步进）：把 {@link ExportSession} 的帧缓冲导出为一份场景文件并<b>登记进 run 清单</b>
 * （Gitea #102 收口T5）。
 *
 * <h2>它替代了什么（搬迁而非新增）</h2>
 *
 * 搬迁前「导出场景文件」只有命令通道：{@code /sde export} → 服务端线程 → 写
 * {@code structure_exports/<name>.json}（CWD 相对）→ 网络包投给客户端 enrich → 客户端<b>覆盖写同名文件</b>。
 * 三个结构性问题（#97 §5-D8 / #102 R1-1/R1-2）：
 *
 * <ol>
 * <li><b>落点靠巧合</b>：服务端用 CWD 相对路径、客户端用 {@code mcDataDir}，{@code runClient} 下恰好相等；
 * 换启动方式就静默产出两份不同形态的文件；</li>
 * <li><b>同一路径被写两次</b>：覆盖前的半成品会被工作台看到；</li>
 * <li><b>产物不属于任何 run</b>：C5 无从达成。</li>
 * </ol>
 *
 * <p>
 * 本动作把这三条一起消掉：<b>在客户端 tick 线程一次写完</b>（不经过网络包，故没有「服务端写一份、
 * 客户端覆盖一份」），落点是<b>本动作 run 目录内</b>的相对路径（由 {@link ActionContext#run()} 给出），
 * 写完立即 {@link ArtifactStore#writeArtifact} 登记 sha256。
 *
 * <h2>为什么不需要网络包 / enrich 二段式（#102 §6 最小实验的结论）</h2>
 *
 * {@code /sde export} 之所以要「服务端写 scan 中间态 → 投给客户端烘焙」，是因为<b>命令跑在服务端线程</b>，
 * 而烘焙能力（{@link MeshCaptureService#finalizeStructureJson}）是 {@code @SideOnly(CLIENT)}。
 * cp 动作本来就跑在<b>客户端 tick 线程</b>，因此扫描与烘焙在同一次动作内顺序完成即可——
 * 这条推断由本单的最小实验实测确认（见证据 {@code temp/cp-export/evidence/}）。
 *
 * <h2>形态统一（R1-3，派发裁决 5）</h2>
 *
 * 本动作默认 {@code shape:"world"}：<b>单帧即 N=1 的多帧文档</b>。因此 C1（单场景文件）与 C2（多帧）
 * 产出的是<b>同一种文件</b>，两者共用一条消费方解析路径——搬迁前「{@code frame 0} 走单结构、
 * {@code frame 5} 走 World」的隐式分叉（两条烘焙代码路径，{@code liftBlockPaletteToRoot} 只在一条上做）
 * 不再能让 C1/C2 各自绿却是两种文件。需要裸 {@code StructureData} 的消费方显式写
 * {@code shape:"structure"}（仅允许单帧）。
 *
 * <h2>帧预算（C6）</h2>
 *
 * 两档预算都在<b>扫描之前</b>算（选区尺寸 × 帧数即可推算体积），超限一律 {@code CP-VALID-002} +
 * {@code context.fields}，<b>不写任何产物</b>——不静默截断、不写爆（R2-2：{@code frameJson} 存的是每帧
 * 一份完整 scan JSON 字符串，导出瞬间内存约 3 倍膨胀）。
 *
 * <h2>并发（R3-2 / 裁决 13）</h2>
 *
 * 全部所需状态在 {@code onBegin} 里经 {@link ExportSession#bufferSnapshot()} <b>一次</b>取走
 * （帧体 + 帧号 + 逐帧哈希 + 世代号 + 选区 + 身份字段都在同一临界区内），阶段推进过程中<b>不再重读</b>活动帧。
 * 因此「动作跑到一半、命令刚 record 完一帧」不会产出自相矛盾的产物。
 *
 * <h2>D2（双通道一致）</h2>
 *
 * 与命令通道 {@code cmd.exec {command:"/sde export"}} 共用 {@link ExportSceneWriter}（唯一实现），
 * 差别只有 {@code outDir}、形态与 provenance。比对口径见
 * {@code docs/control-plane/dual-channel-consistency.md} §2.2：<b>解 Envelope → 取 inner → 规范化 JSON 的
 * sha256</b>（不做文件逐字节比对——gzip 头含 MTIME，且 cp 通道多了 provenance）。
 */
public final class ExportSceneAction extends SteppingActionBase {

    /** 动作名。 */
    public static final String NAME = "export.scene";

    /** 帧数预算默认值（契约 1.6；自述与文档必须与此常量一致）。 */
    public static final int DEFAULT_MAX_FRAMES = 64;

    /** 体素预算默认值（跨全部帧的格子总数）。 */
    public static final long DEFAULT_MAX_CELLS = 2_000_000L;

    /** 单帧体素上限的绝对天花板（防「一帧就把堆吃光」；与 {@code ReadSupport.MAX_REGION_BLOCKS} 同量级）。 */
    public static final long HARD_MAX_CELLS = 48L * 48L * 48L * 64L;

    /** 帧数上限的绝对天花板（{@code SdeServerRecordScheduler.MAX_CONSECUTIVE_RECORD_TICKS} = 256）。 */
    public static final int HARD_MAX_FRAMES = 256;

    /** 产物相对路径前缀。 */
    public static final String DIR = "export";

    /** 逐帧明细子目录。 */
    public static final String FRAMES_DIR = DIR + "/frames";

    /** 主产物 role。 */
    public static final String ROLE_SCENE = "scene-export";

    /** 逐帧明细 role。 */
    public static final String ROLE_FRAME = "scene-export-frame";

    /** {@code exportId} 在产物里的字段名（与 {@link ExportSceneWriter} 同源）。 */
    public static final String FIELD_EXPORT_ID = ExportSceneWriter.FIELD_EXPORT_ID;

    /** 帧选择口径。 */
    private enum FrameSel {
        /** 缓冲内全部帧。 */
        ALL,
        /** 只导出活动帧。 */
        ACTIVE,
        /** 调用方显式给出的帧号清单。 */
        EXPLICIT
    }

    // ---- onBegin 取走的一次性状态（阶段推进期间不再重读单例） ----
    private ExportSession.Snapshot snap;
    private Map<Integer, String> frames;
    private String exportId;
    private String outName;
    private ExportSceneWriter.Shape shape;
    private boolean raw;
    private boolean includeFrames;
    private boolean keepBuffer;
    private JsonObject expectFramesParam;

    // ---- 阶段状态 ----
    private JsonObject document;
    private byte[] bytes;
    private int written;
    private JsonArray frameArtifacts;
    private long volumePerFrame;
    private long volumeTotal;

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        // ---- 1) 一次取走全部单例态（R3-2：不在阶段推进中重读活动帧） ----
        ExportSession.Buffer buf = ExportSession.get()
            .bufferSnapshot();
        this.snap = buf.snapshot();
        this.frames = buf.framesJson();

        if (frames.isEmpty()) {
            throw new CpException(
                ErrorCodes.STATE,
                "帧缓冲为空：请先 record（命令通道 cmd.exec {command:\"/sde record\"}）",
                Json.object(
                    "action",
                    NAME,
                    "recordedFrames",
                    new JsonArray(),
                    "hint",
                    "逐帧导出流程：cmd.exec pos1/pos2 设选区 → cmd.exec setframe <n> → cmd.exec record（每帧一次）"
                        + " → export.scene；多帧必须落在同一会话同一缓冲内（C3）"));
        }
        if (!snap.selectionComplete()) {
            throw new CpException(
                ErrorCodes.STATE,
                "选区不完整（pos1/pos2 未设全）：烘焙需要世界坐标，无选区无法导出",
                Json.object(
                    "action",
                    NAME,
                    "selection",
                    ExportSceneSupport.selectionJson(snap),
                    "hint",
                    "cmd.exec {command:\"/sde pos1\"} 与 {command:\"/sde pos2\"}（或用 scene.* 之外的命令设点）"));
        }

        // ---- 2) 参数 ----
        this.shape = ExportSceneSupport.parseShape(ctx, ExportSceneWriter.Shape.WORLD);
        this.raw = ctx.optBool("raw", false);
        this.includeFrames = ctx.optBool("includeFrames", true);
        this.keepBuffer = ctx.optBool("keepBuffer", true);
        this.expectFramesParam = ctx.optObject("expectFrames");
        int maxFrames = ExportSceneSupport.requireBudget(ctx, "maxFrames", DEFAULT_MAX_FRAMES, HARD_MAX_FRAMES);
        long maxCells = ExportSceneSupport.requireBudgetLong(ctx, "maxCells", DEFAULT_MAX_CELLS, HARD_MAX_CELLS);

        // 输出名：参数优先，缺省用单例态（与 /sde setname 同源）
        String name = ctx.optString("name", null);
        this.outName = ExportSceneSupport.safeName(
            name != null && !name.trim()
                .isEmpty() ? name.trim() : snap.outputName());

        // ---- 3) 帧选择 ----
        Map<Integer, String> selected = selectFrames(ctx);

        // ---- 4) 形态一致性（R1-3：口径唯一，不做隐式分叉） ----
        if (shape == ExportSceneWriter.Shape.STRUCTURE && selected.size() != 1) {
            throw CpException.param(
                "shape=structure 只允许单帧",
                "shape",
                "当前选中 " + selected.size() + " 帧；多帧请用 shape=world（默认），它把单帧也写成 N=1 的多帧文档");
        }

        // ---- 5) 帧预算（C6）：扫描之前算，超限不写任何产物 ----
        long perFrame = ExportSceneSupport.volumeOf(snap);
        long total = perFrame * selected.size();
        this.volumePerFrame = perFrame;
        this.volumeTotal = total;
        if (selected.size() > maxFrames) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "帧数超预算：" + selected.size() + " 帧 > 上限 " + maxFrames + "（不静默截断，请显式提高 maxFrames 或缩小帧集）",
                ExportSceneSupport.budgetContext("frames", selected.size(), maxFrames, perFrame, total, maxCells));
        }
        if (perFrame > maxCells) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "单帧体素超预算：" + perFrame + " 格 > 上限 " + maxCells + "（选区 " + ExportSceneSupport.sizeText(snap) + "）",
                ExportSceneSupport.budgetContext("maxCells", selected.size(), maxFrames, perFrame, total, maxCells));
        }
        if (total > maxCells) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "体素总量超预算：" + total + " 格（" + perFrame + " × " + selected.size() + " 帧）> 上限 " + maxCells,
                ExportSceneSupport.budgetContext("maxCells", selected.size(), maxFrames, perFrame, total, maxCells));
        }

        // ---- 6) expectFrames（C3 显式声明：调用方说清这次导出该包含哪些帧） ----
        ExportSceneSupport.assertExpectFrames(expectFramesParam, selected);

        // ---- 7) run + 导出标识 ----
        ArtifactStore.Run run = ctx.beginRun("export-scene");
        this.exportId = run.runId() + "#" + outName;
        this.frameArtifacts = new JsonArray();
        this.written = 0;

        ctx.emit(
            com.lightning.mod.client.controlplane.core.EventStream.LEVEL_INFO,
            ExportSceneSupport.KIND_EXPORT,
            "导出开始: " + outName + "（" + selected.size() + " 帧，形态 " + shape.id() + "）",
            Json.object(
                "exportId",
                exportId,
                "runId",
                run.runId(),
                "shape",
                shape.id(),
                "raw",
                Boolean.valueOf(raw),
                "frames",
                ExportSceneSupport.frameList(selected),
                "bufferGeneration",
                Long.valueOf(snap.bufferGeneration()),
                "volumePerFrame",
                Long.valueOf(perFrame),
                "volumeTotal",
                Long.valueOf(total),
                "selection",
                ExportSceneSupport.selectionJson(snap)));

        this.frames = new TreeMap<Integer, String>(selected);
        enterStage("scan");
    }

    /** 帧选择：{@code frames} 三形态（{@code "all"} / {@code "active"} / {@code [int...]}）。 */
    private Map<Integer, String> selectFrames(ActionContext ctx) {
        com.google.gson.JsonElement e = ctx.param("frames");
        FrameSel sel = FrameSel.ALL;
        java.util.List<Integer> explicit = new java.util.ArrayList<Integer>();
        if (e != null) {
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive()
                .isString()) {
                String s = e.getAsString()
                    .trim()
                    .toLowerCase(java.util.Locale.ROOT);
                if ("all".equals(s)) {
                    sel = FrameSel.ALL;
                } else if ("active".equals(s)) {
                    sel = FrameSel.ACTIVE;
                } else {
                    throw CpException
                        .param("frames 取值非法", "frames", "字符串形态只接受 \"all\"（默认）或 \"active\"，收到 \"" + s + "\"");
                }
            } else if (e.isJsonArray()) {
                sel = FrameSel.EXPLICIT;
                JsonArray a = e.getAsJsonArray();
                com.lightning.mod.client.controlplane.core.Fields fields = new com.lightning.mod.client.controlplane.core.Fields();
                for (int i = 0; i < a.size(); i++) {
                    com.google.gson.JsonElement v = a.get(i);
                    // Gitea #131：帧号是 int；1.5 / "1" / true 都不得静默转换（原先是 getAsInt() + isNumber 粗检）
                    String why = com.lightning.mod.client.controlplane.core.Json.integralRejectReason(v);
                    if (why != null) {
                        fields.add("frames[" + i + "]", "须为精确整数帧号：" + why);
                        continue;
                    }
                    int f = com.lightning.mod.client.controlplane.core.Json.strictIntElement(v, "frames[" + i + "]");
                    if (f < 0) {
                        fields.add("frames[" + i + "]", "帧号须 ≥ 0，收到 " + f);
                        continue;
                    }
                    if (!frames.containsKey(Integer.valueOf(f))) {
                        fields.add("frames[" + i + "]", "缓冲里没有该帧（已录帧 " + ExportSceneSupport.frameList(frames) + "）");
                        continue;
                    }
                    explicit.add(Integer.valueOf(f));
                }
                fields.throwIfAny("frames 参数非法");
                if (explicit.isEmpty()) {
                    throw CpException
                        .param("frames 参数非法", "frames", "显式帧清单为空（缓冲内已录帧 " + ExportSceneSupport.frameList(frames) + "）");
                }
            } else {
                throw CpException.param("frames 参数非法", "frames", "须为 \"all\" / \"active\" / [int...] 之一");
            }
        }

        Map<Integer, String> out = new TreeMap<Integer, String>();
        switch (sel) {
            case ALL:
                out.putAll(frames);
                break;
            case ACTIVE: {
                Integer key = Integer.valueOf(snap.activeFrame());
                String body = frames.get(key);
                if (body == null) {
                    throw new CpException(
                        ErrorCodes.STATE,
                        "活动帧 F" + snap.activeFrame() + " 不在缓冲内（已录帧 " + ExportSceneSupport.frameList(frames) + "）",
                        Json.object(
                            "action",
                            NAME,
                            "activeFrame",
                            Integer.valueOf(snap.activeFrame()),
                            "recordedFrames",
                            ExportSceneSupport.frameList(frames),
                            "hint",
                            "frames:\"active\" 要求活动帧已 record；要导出全部已录帧请用 frames:\"all\"（默认）"));
                }
                out.put(key, body);
                break;
            }
            case EXPLICIT:
            default:
                for (Integer f : explicit) {
                    out.put(f, frames.get(f));
                }
                break;
        }
        return out;
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        if ("scan".equals(stage())) {
            // 帧体已在 onBegin 取走（含逐格备注）；本阶段只做「合并成文档对象」这一步。
            // 分阶段是为了让大文档的构建与烘焙各自独立计时（帧预算已在 onBegin 拦下超限）。
            ExportSceneWriter.Meta meta = new ExportSceneWriter.Meta();
            meta.structureId = snap.structureId();
            meta.label = snap.structureId();
            meta.author = snap.lastAuthor();
            meta.gtnhVersion = snap.lastGtnhVersion();
            meta.description = null;
            JsonObject prov = ExportSceneWriter.provenance(
                exportId,
                ctx.run() == null ? null
                    : ctx.run()
                        .runId(),
                shape,
                snap.bufferGeneration(),
                snap.recordedFrames(),
                snap.frameSha256(),
                snap.inSession(),
                ExportSceneSupport.selectionJson(snap));
            this.document = ExportSceneWriter.buildDocument(meta, frames, shape, prov, exportId);
            enterStage("bake");
            progress(ctx, 0.15d, "文档已合并（" + frames.size() + " 帧）");
            return null;
        }

        if ("bake".equals(stage())) {
            Minecraft mc = WorldRuntime.mc();
            if (mc == null || mc.theWorld == null) {
                throw new CpException(
                    ErrorCodes.STATE,
                    "客户端世界不可用：烘焙需要 Minecraft.theWorld（scan 中间态里的 worldGrid 指向世界坐标）",
                    Json.object(
                        "action",
                        NAME,
                        "stage",
                        "bake",
                        "hint",
                        "先 world.rebuild 进入托管世界；导出必须在世界加载时进行（烘焙按世界坐标读方块）"));
            }
            MeshCaptureService.finalizeStructureJson(document);
            this.bytes = ExportSceneWriter.serialize(document, raw);
            enterStage("write");
            progress(ctx, 0.55d, "烘焙完成（" + bytes.length + " 字节）");
            return null;
        }

        if ("write".equals(stage())) {
            ArtifactStore store = ctx.artifacts();
            if (store == null) {
                throw new CpException(ErrorCodes.STATE, "产物仓库未装配，无法登记导出产物");
            }
            ArtifactStore.Run run = ctx.run();
            // 单一归属（裁决 6）：只落 run 目录，不写 CWD，也不写老路径 structure_exports/
            ArtifactStore.Artifact main = store.writeArtifact(run, DIR + "/" + outName + ".json", bytes, ROLE_SCENE);

            if (includeFrames) {
                for (Map.Entry<Integer, String> e : frames.entrySet()) {
                    JsonObject single = ExportSceneWriter.buildDocument(
                        metaOf(),
                        java.util.Collections.singletonMap(e.getKey(), e.getValue()),
                        ExportSceneWriter.Shape.STRUCTURE,
                        ExportSceneSupport.frameProvenance(exportId, e.getKey(), snap),
                        exportId);
                    MeshCaptureService.finalizeStructureJson(single);
                    byte[] fb = ExportSceneWriter.serialize(single, raw);
                    String rel = FRAMES_DIR + "/F" + e.getKey() + ".json";
                    ArtifactStore.Artifact fa = store.writeArtifact(run, rel, fb, ROLE_FRAME);
                    JsonObject o = new JsonObject();
                    o.addProperty("index", e.getKey());
                    o.addProperty("path", fa.path());
                    o.addProperty("bytes", fa.bytes());
                    o.addProperty("sha256", fa.sha256());
                    o.addProperty("sourceSha256", snap.frameSha256()[indexOf(e.getKey())]);
                    frameArtifacts.add(o);
                }
            }

            this.written = 1;
            enterStage("done");
            progress(ctx, 0.9d, "已写出并登记 " + (1 + frameArtifacts.size()) + " 份产物");

            JsonObject result = new JsonObject();
            result.addProperty("schema", ExportSceneSupport.SCHEMA_RESULT);
            result.addProperty("contractVersion", com.lightning.mod.client.controlplane.core.Contract.VERSION);
            result.addProperty("action", NAME);
            result.addProperty("runId", run.runId());
            result.addProperty("exportId", exportId);
            result.addProperty("name", outName);
            result.addProperty("shape", shape.id());
            result.addProperty("raw", raw);
            result.addProperty("frames", frames.size());
            result.add("frameIndexes", ExportSceneSupport.frameList(frames));
            result.addProperty("bytes", main.bytes());
            result.addProperty("sha256", main.sha256());
            result.addProperty("path", main.path());
            result.addProperty("role", ROLE_SCENE);
            result.addProperty("includeFrames", includeFrames);
            result.add("frameArtifacts", frameArtifacts);
            result.addProperty("frameArtifactCount", frameArtifacts.size());
            result.addProperty("bufferGeneration", snap.bufferGeneration());
            result.add("frameSha256", ExportSceneSupport.hashArray(snap, frames));
            result.add("selection", ExportSceneSupport.selectionJson(snap));
            result.addProperty("volumePerFrame", volumePerFrame);
            result.addProperty("volumeTotal", volumeTotal);
            result.addProperty("keepBuffer", keepBuffer);
            result.addProperty("envelope", raw ? "Plain" : "Envelope");
            result.addProperty("downloadPath", "/cp/v1/artifacts/" + run.runId() + "/" + main.path());
            result.addProperty(
                "note",
                "形态统一（R1-3）：单帧即 N=1 的多帧文档（shape=world）。产物只落本 run 目录（裁决 6 单一归属），"
                    + "工作台 ExportsListPanel 读的 structure_exports/ 看不到它——经 downloadPath 下载后喂解析器（C1）。"
                    + "C3 判据：同一产物内全部帧的 exportId 必须一致，且 provenance.recordedFrames/frameSha256 必须与 "
                    + "export.session 同源同序。");

            ctx.emit(
                com.lightning.mod.client.controlplane.core.EventStream.LEVEL_INFO,
                ExportSceneSupport.KIND_EXPORT,
                "导出完成: " + main.path() + "（" + main.bytes() + " 字节，" + frames.size() + " 帧）",
                Json.object(
                    "exportId",
                    exportId,
                    "runId",
                    run.runId(),
                    "path",
                    main.path(),
                    "sha256",
                    main.sha256(),
                    "bytes",
                    Long.valueOf(main.bytes()),
                    "frames",
                    ExportSceneSupport.frameList(frames),
                    "shape",
                    shape.id()));

            if (!keepBuffer) {
                CpLog.warn("[SDE][CP] export.scene 收到 keepBuffer=false，但契约 1.6 不提供隐式清缓冲（裁决 3：只增不改）——缓冲保持原样");
            }
            return result;
        }

        throw new CpException(ErrorCodes.EXEC_FAILED, "未知阶段: " + stage());
    }

    private ExportSceneWriter.Meta metaOf() {
        ExportSceneWriter.Meta meta = new ExportSceneWriter.Meta();
        meta.structureId = snap.structureId();
        meta.label = snap.structureId();
        meta.author = snap.lastAuthor();
        meta.gtnhVersion = snap.lastGtnhVersion();
        meta.description = null;
        return meta;
    }

    private int indexOf(int frame) {
        int[] arr = snap.recordedFrames();
        for (int i = 0; i < arr.length; i++) {
            if (arr[i] == frame) {
                return i;
            }
        }
        return 0;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        // 失败路径也要留下可诊断的现场（阶段名 + 帧集 + 是否写过产物），不吞掉信息
        if (ctx != null && document != null && bytes == null) {
            CpLog.warn("[SDE][CP] export.scene 收尾：文档已合并但未烘焙成功（阶段 %s）", stage());
        }
    }

    /** 供结果组装：帧号 → 内容哈希的有序对象（与 {@code export.session.frameSha256} 同源）。 */
    static Map<Integer, String> hashMapOf(ExportSession.Snapshot snap, Map<Integer, String> frames) {
        Map<Integer, String> out = new LinkedHashMap<Integer, String>();
        int[] arr = snap.recordedFrames();
        String[] hashes = snap.frameSha256();
        for (int i = 0; i < arr.length; i++) {
            if (frames.containsKey(Integer.valueOf(arr[i]))) {
                out.put(Integer.valueOf(arr[i]), hashes[i]);
            }
        }
        return out;
    }

    /** 把 UTF-8 文本写成 JSON 数组元素（gson 2.2.4 兼容：不用 {@code JsonArray.add(String)} 之外的 API）。 */
    static JsonPrimitive prim(String s) {
        return new JsonPrimitive(s);
    }

    /** 内部件：投递单文本（仅供诊断；从不登记为产物）。 */
    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** 产物落点的绝对路径（诊断用；不进产物正文）。 */
    static File abs(ArtifactStore.Run run, String rel) {
        return run.resolve(rel)
            .toFile();
    }
}
