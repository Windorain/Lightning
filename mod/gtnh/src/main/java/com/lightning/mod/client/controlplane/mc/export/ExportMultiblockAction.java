package com.lightning.mod.client.controlplane.mc.export;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SteppingActionBase;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.multiblock.MultiblockExportRunner;
import com.lightning.mod.config.SdeMultiblockConfig;

/**
 * {@code export.multiblock}（scene，步进）：{@code /sde multiblock} 的 cp 等价动作——枚举 → 变体构建+捕获 →
 * 因子化编码 → 逐台信封，产物落<b>本 run 目录</b>并登记哈希清单（Gitea #102 裁决 5/6）。
 *
 * <h2>与命令通道的关系（D2）</h2>
 *
 * 本动作<b>不重写</b>任何导出逻辑：它直接调 {@link MultiblockExportRunner#run(Minecraft, MultiblockExportRunner.RunConfig)}
 * ——与 {@code /sde multiblock} 命令、与触发文件通道<b>同一个执行体</b>。搬迁只做了两件事：
 *
 * <ol>
 * <li><b>落点覆盖</b>：{@code RunConfig.outputRootOverride = run 目录}（含 T1.3 数据集也落 run 目录）；
 * 老路径 {@code <mcDataDir>/sde_multiblock_exports/} 在 cp 通道<b>不再被写</b>（裁决 6 单一归属）；</li>
 * <li><b>产物登记</b>：跑完后逐份 {@link ArtifactStore#registerArtifact}，使 C5「产物可发现」成立。</li>
 * </ol>
 *
 * <p>
 * 因为执行体是同一个，「同一语义经 API 与经命令执行结果一致」（#96 §10-D2）在这里是机械成立的；
 * 差别只有落点与清单登记，故 D2 的产物比对口径是「<b>解 Envelope → 取 inner → 规范化 JSON 的 sha256</b>」
 * （{@code docs/control-plane/dual-channel-consistency.md} §2.2），不做文件字节比对。
 *
 * <h2>为什么默认不逐份登记 dataset（Q2）</h2>
 *
 * 全量 221 台的 {@code machines/*.json} 会产生数百条清单项，而它们的价值在于「可离线复算捕获」，
 * 不在「逐份可下载」。因此默认 {@code dataset:"manifest-only"}：只登记数据集的身份件
 * （{@code manifest.json} / {@code palette.json} / {@code report.json}），逐台明细留在磁盘上。
 * 需要逐份证据时显式写 {@code dataset:"all"}。
 *
 * <h2>长跑（R2-3 / 时间预算分工）</h2>
 *
 * {@code globalBudgetMs}（既有配置，默认 4h）是<b>业务预算</b>：超时后剩余机器进失败清单（不静默跳过），
 * 产物里如实记录。{@code totalTimeoutMs}/{@code stageTimeoutMs} 是<b>作业看门狗</b>：超时抛 {@code CP-EXEC-002}。
 * 两者分工明确，默认把看门狗关掉（{@code 0} = 不限）——本动作天然长跑，由它自己的 progress 上报与
 * {@code globalBudgetMs} 兜底。
 *
 * <h2>无世界也能跑（R2-3 的取舍）</h2>
 *
 * 本动作的捕获路径自带 {@code ProbeDummyWorld}（不进真实世界），因此主菜单下也能执行——
 * 这与 #104 之前那条触发文件驱动的入口（{@code MultiblockExportAutomation}，已随 #104 删除）
 * 的行为一致。自述里写明这一点，不假装要求世界。
 *
 * <h2>前置枚举事实与已知缺口（V11）</h2>
 *
 * 本动作<b>硬依赖</b> {@code multiblock_scan/run-NNNN/machines.json}（T1.2 的枚举事实层）。
 * 产出它的 {@code MultiblockScanRunner} 按 V11 裁决保留（是生产件），但 #104 删除了它唯一的
 * 触发入口（{@code MultiblockScanAutomation} + {@code sde_multiblock_scan.json}），
 * 而 cp 侧<b>没有</b>对应的自描述动作 ⇒ 目前没有自描述通道可以生成该事实。
 * 这是 #104 <b>显式登记</b>的已知缺口，不是静默遗漏（见 #104 交付报告）。
 */
public final class ExportMultiblockAction extends SteppingActionBase {

    /** 动作名。 */
    public static final String NAME = "export.multiblock";

    /** 产物子目录（run 目录内相对路径）。 */
    public static final String DIR = "export";

    /** 数据集子目录名（与 {@code MultiblockExportRunner.DATASET_SUBDIR} 同源）。 */
    public static final String DATASET_SUBDIR = MultiblockExportRunner.DATASET_SUBDIR;

    /** 报告文件名（与 runner 同源）。 */
    public static final String REPORT_FILE = MultiblockExportRunner.REPORT_FILE;

    /** role 常量。 */
    public static final String ROLE_PRODUCT = "multiblock";
    /** role 常量。 */
    public static final String ROLE_REPORT = "multiblock-report";
    /** role 常量。 */
    public static final String ROLE_DATASET = "multiblock-dataset";

    /** 数据集登记档位。 */
    public enum DatasetMode {

        /** 只登记身份件（manifest/palette/report）——默认。 */
        MANIFEST_ONLY("manifest-only"),
        /** 逐份登记全部数据集文件。 */
        ALL("all"),
        /** 一份都不登记（只落磁盘）。 */
        NONE("none");

        private final String id;

        DatasetMode(String id) {
            this.id = id;
        }

        /** 稳定字符串。 */
        public String id() {
            return id;
        }

        /** 解析档位名；未知返回 null（调用方负责报 CP-VALID-002）。 */
        public static DatasetMode parse(String s) {
            if (s == null) {
                return null;
            }
            String v = s.trim()
                .toLowerCase(java.util.Locale.ROOT);
            for (DatasetMode m : values()) {
                if (m.id.equals(v)) {
                    return m;
                }
            }
            return null;
        }

        /** 全部合法取值（自述用）。 */
        public static String choices() {
            StringBuilder sb = new StringBuilder();
            for (DatasetMode m : values()) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append(m.id);
            }
            return sb.toString();
        }
    }

    private MultiblockExportRunner.RunConfig rc;
    private File exportDir;
    private File datasetDir;
    private DatasetMode datasetMode;
    private JsonObject report;
    private JsonArray artifacts;
    private long startedAt;

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        this.startedAt = System.currentTimeMillis();
        Minecraft mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "客户端不可用（Minecraft 实例为 null）",
                Json.object("action", NAME, "hint", "本动作在主菜单或世界中均可执行（捕获自带 ProbeDummyWorld），但需要客户端实例"));
        }

        // ---- 参数 ----
        JsonArray machinesArr = ctx.optArray("machines");
        List<String> machines = new ArrayList<String>();
        if (machinesArr != null) {
            for (int i = 0; i < machinesArr.size(); i++) {
                JsonElement e = machinesArr.get(i);
                if (e == null || !e.isJsonPrimitive()
                    || !e.getAsJsonPrimitive()
                        .isString()) {
                    throw CpException
                        .param("machines 元素类型不符", "machines[" + i + "]", "须为字符串（simpleName / fqcn / slug）");
                }
                String s = e.getAsString()
                    .trim();
                if (!s.isEmpty() && !machines.contains(s)) {
                    machines.add(s);
                }
            }
        }
        // R3-3：空 scope 的语义在两个 runner 里不一致（一个「全量」一个「默认 4 台」），
        // 因此 cp 动作**必须**显式要求范围，不复刻「空 = 全量」这个危险默认。
        if (machines.isEmpty()) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "machines 必填且不得为空：本动作不复刻「空 scope = 全量 221 台」这个危险默认（R3-3）",
                Json.object(
                    "action",
                    NAME,
                    "field",
                    "machines",
                    "hint",
                    "显式写 [\"all\"] 表示全量（自述里写明台数），或写具体机器名清单；"
                        + "空清单会让 MultiblockExportRunner 与 VariantCaptureRunner 对「空」给出不同解释，造成白跑",
                    "allToken",
                    "all"));
        }
        boolean allRequested = machines.size() == 1 && "all".equalsIgnoreCase(machines.get(0));
        if (allRequested) {
            // 「all」不是 runner 认识的机器名，它的语义就是「不过滤」⇒ 传空清单
            machines.clear();
        }

        int limit = ctx.optInt("limit", 0);
        if (limit < 0) {
            throw CpException.param("limit 非法", "limit", "须 ≥ 0（0 = 不限制），收到 " + limit);
        }
        int maxVariantsPerMachine = ctx.optInt("maxVariantsPerMachine", SdeMultiblockConfig.maxVariantsPerMachine);
        int maxChannelValues = ctx.optInt("maxChannelValues", 0);
        boolean structuralOnly = ctx.optBool("structuralOnly", false);
        long globalBudgetMs = ctx.optLong("globalBudgetMs", 0L);
        boolean keepDataset = ctx.optBool("keepDataset", true);
        boolean dryRun = ctx.optBool("dryRun", false);
        String modeStr = ctx.optString("dataset", null);
        this.datasetMode = modeStr == null || modeStr.trim()
            .isEmpty() ? DatasetMode.MANIFEST_ONLY : DatasetMode.parse(modeStr);
        if (datasetMode == null) {
            throw CpException.param(
                "dataset 取值非法",
                "dataset",
                "合法取值 " + DatasetMode.choices() + "（默认 manifest-only），收到 \"" + modeStr + "\"");
        }

        // ---- run + 落点（裁决 6：单一归属，只落 run 目录） ----
        ArtifactStore.Run run = ctx.beginRun("export-multiblock");
        this.exportDir = run.resolve(DIR)
            .toFile();
        this.datasetDir = new File(exportDir, DATASET_SUBDIR);
        if (!dryRun && !exportDir.isDirectory() && !exportDir.mkdirs()) {
            throw CpException.io("无法创建产物目录: " + exportDir.getAbsolutePath(), null);
        }
        this.artifacts = new JsonArray();

        // ---- 运行配置（与命令通道同一执行体的同一配置对象） ----
        this.rc = new MultiblockExportRunner.RunConfig();
        rc.machines.clear();
        rc.machines.addAll(machines);
        rc.outputRootOverride = exportDir;
        rc.writeOutputs = !dryRun;
        rc.requestedBy = "cp:" + NAME;
        rc.exit = false;
        rc.cleanupTrigger = false;
        rc.keepDataset = keepDataset;
        rc.structuralOnly = structuralOnly ? 1 : 0;
        if (maxVariantsPerMachine > 0) {
            rc.maxVariantsPerMachine = maxVariantsPerMachine;
        }
        if (maxChannelValues > 0) {
            rc.maxChannelValues = maxChannelValues;
        }
        // R3-1：limit 走 RunConfig 显式字段（runner 的 `>= 0 ? rc : 配置` 范式），
        // 而不是命令通道那条「先赋静态字段再被 load() 覆盖」的路（既有缺陷，本单顺手修）。
        if (limit > 0) {
            rc.maxExportMachines = limit;
        }
        if (globalBudgetMs > 0) {
            rc.globalBudgetMs = globalBudgetMs;
        }

        ctx.emit(
            EventStream.LEVEL_INFO,
            ExportSceneSupport.KIND_EXPORT,
            "多方块导出开始（范围 " + (allRequested ? "all" : machines.toString()) + "，dryRun=" + dryRun + "）",
            Json.object(
                "action",
                NAME,
                "runId",
                run.runId(),
                "machines",
                allRequested ? "all" : machines.toString(),
                "limit",
                Integer.valueOf(limit),
                "dryRun",
                Boolean.valueOf(dryRun),
                "datasetMode",
                datasetMode.id(),
                "outputRoot",
                exportDir.getAbsolutePath()));

        enterStage("export");
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        if (!"export".equals(stage())) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "未知阶段: " + stage());
        }
        Minecraft mc = WorldRuntime.mc();
        // 同一次 advance 内跑完整个 runner（它自己是同步的、按机器循环）；
        // 本动作注册为步进是为了「作业级 run + 可被看门狗超时 + 收尾统一落 manifest」，
        // 而不是为了把 runner 拆成逐 tick（那需要改 T1.3 的内部状态机，超出本单范围）。
        progress(ctx, 0.05d, "执行枚举 → 捕获 → 编码 → 落盘（同 /sde multiblock 的执行体）");
        // 前置条件显式化（C6/自述纪律：缺前提要「显式报错 + 可执行的下一步」，不要让它掉进
        // runner 的 IllegalStateException 变成 CP-EXEC-001 的裸异常）。
        // T1.2 的枚举事实（machines.json）是**上游步骤的产物**，没有任何「顺手替你扫一遍」的余地：
        // 扫描要遍历 221 台机器的构建，是分钟级长跑，应当由调用方显式发起。
        File facts = com.lightning.mod.client.multiblock.VariantMachineFacts.findLatestFacts(mc.mcDataDir);
        if (facts == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "多方块导出缺前置枚举数据：找不到 multiblock_scan/run-NNNN/machines.json（T1.2 的产物）",
                Json.object(
                    "action",
                    NAME,
                    "stage",
                    "export",
                    "expected",
                    "multiblock_scan/run-*/machines.json",
                    "scanDir",
                    new File(mc.mcDataDir, com.lightning.mod.client.multiblock.MultiblockScanRunner.OUTPUT_DIR)
                        .getAbsolutePath(),
                    "hint",
                    "先产出一份 T1.2 枚举事实（multiblock_scan/run-*/machines.json），再调用本动作；" + "本动作不代为发起扫描（那是分钟级长跑，应由调用方显式决定）。"
                        + "⚠️ Gitea #104 已删除老触发文件入口（sde_multiblock_scan.json + MultiblockScanAutomation），"
                        + "当前**没有**任何自描述动作可以生成该枚举事实——这是 #104 显式登记的已知缺口（V11），"
                        + "见 #104 交付报告「已知缺口与新单建议」；在那之前只能借助已有磁盘上的 machines.json。",
                    "note",
                    "命令通道 /sde multiblock 有同一前置条件——这不是 cp 侧的额外要求，而是同一条管线的同一个上游"));
        }
        this.report = MultiblockExportRunner.run(mc, rc);

        enterStage("register");
        ArtifactStore store = ctx.artifacts();
        ArtifactStore.Run run = ctx.run();
        boolean dryRun = !rc.writeOutputs;

        int products = Json.optInt(report, "exportedProducts", 0);
        JsonArray productStats = Json.optArray(report, "products");

        if (!dryRun) {
            // ① 逐台信封（role=multiblock）：登记形态与 runner 报告里的 stats 一一对应
            if (productStats != null) {
                for (int i = 0; i < productStats.size(); i++) {
                    JsonObject st = productStats.get(i)
                        .getAsJsonObject();
                    String file = Json.optString(st, "productFile", null);
                    if (file == null || file.isEmpty()) {
                        continue;
                    }
                    ArtifactStore.Artifact a = store.registerArtifact(run, DIR + "/" + file, ROLE_PRODUCT);
                    artifacts.add(artifactJson(a, Json.optString(st, "machine", null), null));
                }
            }
            // ② 报告
            File reportFile = new File(exportDir, REPORT_FILE);
            if (reportFile.isFile()) {
                ArtifactStore.Artifact a = store.registerArtifact(run, DIR + "/" + REPORT_FILE, ROLE_REPORT);
                artifacts.add(artifactJson(a, null, "failureCount=" + Json.optInt(report, "failureCount", 0)));
            }
            // ③ 数据集（按档位）
            artifacts.addAll(registerDataset(store, run));
        }

        JsonObject result = new JsonObject();
        result.addProperty("schema", ExportSceneSupport.SCHEMA_MULTIBLOCK_RESULT);
        result.addProperty("contractVersion", Contract.VERSION);
        result.addProperty("action", NAME);
        result.addProperty("runId", run == null ? null : run.runId());
        result.addProperty("dryRun", dryRun);
        result.addProperty("datasetMode", datasetMode.id());
        result.addProperty("outputRoot", exportDir.getAbsolutePath());
        result.addProperty("datasetDir", datasetDir.getAbsolutePath());
        result.addProperty("requestedMachines", Json.optInt(report, "requestedMachines", 0));
        result.addProperty("enumeratedTotal", Json.optInt(report, "enumeratedTotal", 0));
        result.addProperty("exportedProducts", products);
        result.addProperty("failureCount", Json.optInt(report, "failureCount", 0));
        result.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - startedAt));
        result.add("artifacts", artifacts);
        result.addProperty("artifactCount", artifacts.size());
        result.add("config", Json.copyObject(Json.optObject(report, "config")));
        result.add("timing", Json.copyObject(Json.optObject(report, "timing")));
        result.add("failures", Json.copyArray(Json.optArray(report, "failures")));
        result.add("samplingPlan", Json.copyArray(Json.optArray(report, "samplingPlan")));
        result.add("notes", Json.copyArray(Json.optArray(report, "notes")));
        result.addProperty("report", DIR + "/" + REPORT_FILE);
        result.addProperty(
            "note",
            "与 /sde multiblock 共用同一执行体（MultiblockExportRunner.run）；差别只有落点（本 run 目录）与清单登记。"
                + "产物逐字节不含 runId/时间戳/绝对路径（格式契约硬约束），故两次运行产物可逐字节比对（D2/A3）。"
                + "globalBudgetMs 是业务预算（超时剩余机器进 failures[]，不静默跳过）；totalTimeoutMs/stageTimeoutMs 是作业看门狗。");
        if (Json.optInt(report, "failureCount", 0) > 0) {
            ctx.emit(
                EventStream.LEVEL_WARN,
                ExportSceneSupport.KIND_EXPORT,
                "多方块导出有 " + Json.optInt(report, "failureCount", 0) + " 条失败（见 failures[]，不静默跳过）",
                Json.object("action", NAME, "failureCount", Integer.valueOf(Json.optInt(report, "failureCount", 0))));
        }
        enterStage("done");
        progress(ctx, 1.0d, "多方块导出完成（产物 " + products + " 份，登记 " + artifacts.size() + " 项）");
        return result;
    }

    /** 数据集登记：按档位决定逐份还是只登记身份件。 */
    private JsonArray registerDataset(ArtifactStore store, ArtifactStore.Run run) {
        JsonArray out = new JsonArray();
        if (datasetMode == DatasetMode.NONE || !datasetDir.isDirectory()) {
            return out;
        }
        String prefix = DIR + "/" + DATASET_SUBDIR + "/";
        // 数据集根下的身份件（manifest/palette/report/latest）
        String[] identity = { "manifest.json", "palette.json", "report.json" };
        String runDirName = null;
        File[] runDirs = datasetDir.listFiles();
        if (runDirs != null) {
            for (File d : runDirs) {
                if (d.isDirectory() && d.getName()
                    .startsWith("run-")) {
                    runDirName = d.getName();
                    break;
                }
            }
        }
        if (runDirName == null) {
            return out;
        }
        for (String f : identity) {
            File target = new File(new File(datasetDir, runDirName), f);
            if (!target.isFile()) {
                continue;
            }
            try {
                ArtifactStore.Artifact a = store.registerArtifact(run, prefix + runDirName + "/" + f, ROLE_DATASET);
                out.add(artifactJson(a, null, "dataset:" + runDirName));
            } catch (CpException e) {
                CpLog.warn("[SDE][CP] export.multiblock 数据集身份件登记失败 %s: %s", f, e.detail());
            }
        }
        if (datasetMode != DatasetMode.ALL) {
            return out;
        }
        // ALL：递归登记全部数据集文件（逐台 machines/*.json 也在内）
        try {
            Path root = new File(datasetDir, runDirName).toPath();
            List<Path> files = new ArrayList<Path>();
            Files.walk(root)
                .filter(Files::isRegularFile)
                .forEach(files::add);
            java.util.Collections.sort(files);
            for (Path p : files) {
                String rel = prefix + runDirName
                    + "/"
                    + root.relativize(p)
                        .toString()
                        .replace('\\', '/');
                if (run.artifact(rel) != null) {
                    continue; // 身份件已登记
                }
                try {
                    out.add(
                        artifactJson(store.registerArtifact(run, rel, ROLE_DATASET), null, "dataset:" + runDirName));
                } catch (CpException e) {
                    CpLog.warn("[SDE][CP] export.multiblock 数据集登记失败 %s: %s", rel, e.detail());
                }
            }
        } catch (java.io.IOException e) {
            CpLog.warn("[SDE][CP] export.multiblock 数据集枚举失败: %s", String.valueOf(e));
        }
        return out;
    }

    private static JsonObject artifactJson(ArtifactStore.Artifact a, String machine, String note) {
        JsonObject o = new JsonObject();
        o.addProperty("path", a.path());
        o.addProperty("bytes", a.bytes());
        o.addProperty("sha256", a.sha256());
        o.addProperty("role", a.role());
        if (machine != null && !machine.isEmpty()) {
            o.addProperty("machine", machine);
        }
        if (note != null) {
            o.addProperty("note", note);
        }
        return o;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        if (report == null) {
            CpLog.warn("[SDE][CP] export.multiblock 收尾：未产出报告（阶段 %s）——产物可能不完整，已落 manifest 供核对", stage());
        }
    }
}
