package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.client.Minecraft;

import org.apache.logging.log4j.Level;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;
import com.lightning.mod.config.SdeMultiblockConfig;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.5 本体：**一条命令全量导出多方块文档**，每个多方块恰好一份文件。
 * <p>
 * 全流程（导出管线的三段交付 A/B/C）：
 * <ol>
 * <li><b>枚举（T1.2）</b>：读 {@code multiblock_scan/run-NNNN/machines.json}（221 台的枚举 + 通道/总 Tier 事实），
 * 由命令的范围参数过滤。</li>
 * <li><b>逐台变体构建 + 捕获（T1.3）</b>：复用 {@link VariantCaptureRunner#run(Minecraft, VariantCaptureRunner.Config)}
 * —— 一次运行覆盖范围内**所有**机器（共用一个并集调色板与一次纹理嵌入），产物落在
 * {@code <outputDir>/_dataset/run-NNNN/}。</li>
 * <li><b>因子化编码（T1.4）</b>：对数据集里的每台机器调用
 * {@link MultiblockFactorizer#factorize}（与离线驱动共用同一个编码器与同一个
 * {@link MultiblockDatasetCodec} 读取器）。</li>
 * <li><b>信封落盘</b>：既有 {@link SceneEnvelopeBuilder}（gzip+base64），每个多方块一份
 * {@code <slug>.multiblock.json}。</li>
 * </ol>
 * <p>
 * <b>与 {@code /sde export} 完全独立</b>：不同目录（{@link SdeMultiblockConfig#outputDirName} vs
 * {@code structure_exports}/会话产物）、不同产物格式、不触碰 {@code ExportSession}。
 * <p>
 * <b>失败可诊断</b>：任何一台失败都落 {@code export-report.json.failures[]}（哪台、哪个阶段、异常链 + 栈顶帧），
 * 其余机器继续；**静默跳过 = 失败**（命令完成后逐条打印失败清单）。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockExportRunner {

    public static final String TRIGGER_FILE = "sde_multiblock.json";
    public static final String SCHEMA = "lightning.multiblock.export/1";
    public static final String REPORT_FILE = "export-report.json";
    /** 中间数据集子目录（相对产物目录）。 */
    public static final String DATASET_SUBDIR = "_dataset";

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    private MultiblockExportRunner() {}

    // ------------------------------------------------------------------ 运行配置

    /** 一次导出的运行参数（来自触发文件或 {@code /sde multiblock} 的范围参数）。 */
    public static final class RunConfig {

        /** 范围：simpleName 或 fqcn；空 = 全部（受 {@link #maxExportMachines} 约束）。 */
        public final List<String> machines = new ArrayList<String>();
        /** 显式通道抽样（机 simpleName → 通道 id → 0..K 连续前缀）；缺省走自动规划。 */
        public final Map<String, Map<String, List<Integer>>> channelSample = new LinkedHashMap<String, Map<String, List<Integer>>>();
        public boolean exit = true;
        public boolean cleanupTrigger = true;
        /** -1 = 用配置默认值。 */
        public int maxVariantsPerMachine = -1;
        public int maxChannelValues = -1;
        public int maxExportMachines = -1;
        public int structuralOnly = -1;
        public long globalBudgetMs = -1;
        public String outputDirName = "";
        public boolean keepDataset = true;
        /** 请求者（命令）/来源（触发文件），写进报告。 */
        public String requestedBy = "trigger-file";
    }

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, TRIGGER_FILE);
    }

    public static RunConfig readConfig(Minecraft mc) {
        RunConfig c = new RunConfig();
        File f = triggerFile(mc);
        if (!f.isFile()) return c;
        try {
            JsonObject o = new JsonParser().parse(VariantCaptureRunner.readText(f))
                .getAsJsonObject();
            if (o.has("exit")) c.exit = o.get("exit")
                .getAsBoolean();
            if (o.has("cleanupTrigger")) c.cleanupTrigger = o.get("cleanupTrigger")
                .getAsBoolean();
            if (o.has("maxVariantsPerMachine")) c.maxVariantsPerMachine = o.get("maxVariantsPerMachine")
                .getAsInt();
            if (o.has("maxChannelValues")) c.maxChannelValues = o.get("maxChannelValues")
                .getAsInt();
            if (o.has("maxExportMachines")) c.maxExportMachines = o.get("maxExportMachines")
                .getAsInt();
            if (o.has("structuralOnly")) c.structuralOnly = o.get("structuralOnly")
                .getAsBoolean() ? 1 : 0;
            if (o.has("globalBudgetMs")) c.globalBudgetMs = o.get("globalBudgetMs")
                .getAsLong();
            if (o.has("outputDirName")) c.outputDirName = o.get("outputDirName")
                .getAsString();
            if (o.has("keepDataset")) c.keepDataset = o.get("keepDataset")
                .getAsBoolean();
            if (o.has("requestedBy")) c.requestedBy = o.get("requestedBy")
                .getAsString();
            if (o.has("machines") && o.get("machines")
                .isJsonArray()) {
                for (JsonElement e : o.getAsJsonArray("machines")) c.machines.add(e.getAsString());
            }
            if (o.has("channelSample") && o.get("channelSample")
                .isJsonObject()) {
                for (Map.Entry<String, JsonElement> me : o.getAsJsonObject("channelSample")
                    .entrySet()) {
                    if (!me.getValue()
                        .isJsonObject()) continue;
                    Map<String, List<Integer>> perMachine = new LinkedHashMap<String, List<Integer>>();
                    for (Map.Entry<String, JsonElement> ce : me.getValue()
                        .getAsJsonObject()
                        .entrySet()) {
                        if (!ce.getValue()
                            .isJsonArray()) continue;
                        List<Integer> vals = new ArrayList<Integer>();
                        for (JsonElement ve : ce.getValue()
                            .getAsJsonArray()) vals.add(Integer.valueOf(ve.getAsInt()));
                        perMachine.put(ce.getKey(), vals);
                    }
                    c.channelSample.put(me.getKey(), perMachine);
                }
            }
        } catch (Throwable t) {
            FMLLog.warning("[SDE][T1.5] 触发文件解析失败，使用默认配置: %s", t.toString());
        }
        return c;
    }

    // ------------------------------------------------------------------ 主流程

    /** 触发文件入口（无人值守）。 */
    public static JsonObject run(Minecraft mc) throws Exception {
        return run(mc, readConfig(mc));
    }

    public static JsonObject run(Minecraft mc, RunConfig rc) throws Exception {
        SdeMultiblockConfig.load(new File(new File(mc.mcDataDir, "config"), "sde_multiblock.cfg"));
        long started = System.currentTimeMillis();
        int maxVariants = rc.maxVariantsPerMachine >= 0 ? rc.maxVariantsPerMachine
            : SdeMultiblockConfig.maxVariantsPerMachine;
        int maxChannelValues = rc.maxChannelValues >= 0 ? rc.maxChannelValues : SdeMultiblockConfig.maxChannelValues;
        int maxMachines = rc.maxExportMachines >= 0 ? rc.maxExportMachines : SdeMultiblockConfig.maxExportMachines;
        boolean structuralOnly = rc.structuralOnly >= 0 ? rc.structuralOnly == 1 : SdeMultiblockConfig.structuralOnly;
        long budgetMs = rc.globalBudgetMs >= 0 ? rc.globalBudgetMs : SdeMultiblockConfig.globalBudgetMs;
        String outputDirName = rc.outputDirName != null && !rc.outputDirName.trim()
            .isEmpty() ? rc.outputDirName.trim() : SdeMultiblockConfig.outputDirName;

        File outDir = new File(mc.mcDataDir, outputDirName);
        if (!outDir.isDirectory() && !outDir.mkdirs()) {
            throw new IllegalStateException("无法创建产物目录: " + outDir.getAbsolutePath());
        }

        List<JsonObject> failures = new ArrayList<JsonObject>();
        List<String> notes = new ArrayList<String>();
        notes.add("配置来源: " + SdeMultiblockConfig.loadedFrom());
        notes.add(
            "配置面默认值（留白 #6）：structuralCompression=" + SdeMultiblockConfig.structuralCompression
                + " maxChannelValues="
                + maxChannelValues
                + " maxVariantsPerMachine="
                + maxVariants
                + " maxExportMachines="
                + maxMachines
                + " structuralOnly="
                + structuralOnly
                + " globalBudgetMs="
                + budgetMs);

        // ---- 1) 枚举（T1.2 事实层） ----
        File factsFile = VariantMachineFacts.findLatestFacts(mc.mcDataDir);
        if (factsFile == null) {
            throw new IllegalStateException("找不到 T1.2 的 machines.json（multiblock_scan/run-NNNN/）——枚举数据缺失，导出无法开始");
        }
        List<EnumEntry> all = readEnumeration(factsFile, failures);
        notes.add("枚举来源: " + factsFile.getAbsolutePath() + "（T1.2，共 " + all.size() + " 台多方块）");
        List<EnumEntry> scope = filterScope(all, rc.machines, maxMachines, failures);
        notes.add(
            "本次范围: " + scope.size()
                + " 台"
                + (rc.machines.isEmpty() ? "（全部）" : "（指定 " + rc.machines + "）")
                + (maxMachines > 0 ? "，maxExportMachines=" + maxMachines : ""));

        // ---- 2) 逐台变体构建 + 捕获（T1.3；一次运行覆盖范围内全部机器） ----
        VariantCaptureRunner.Config cap = new VariantCaptureRunner.Config();
        cap.machines.clear();
        for (EnumEntry e : scope) cap.machines.add(e.fqcn);
        cap.outputDirName = outputDirName + "/" + DATASET_SUBDIR;
        cap.includeActiveRunstate = !structuralOnly;
        cap.maxVariantsPerMachine = Math.max(2, maxVariants);
        cap.globalBudgetMs = budgetMs;
        // 不设 includeThumbnails：T1.3 调色板恒不产出 thumbnailPNG（幂等硬约束，见 GeometryPalette.EMITS_THUMBNAIL_PNG）。
        cap.embedTextures = SdeMultiblockConfig.embedTextures;
        cap.factsPath = factsFile.getAbsolutePath();
        cap.exit = false;
        cap.cleanupTrigger = false;

        // 安全兜底：为没有显式抽样的机器自动规划通道域（组合积 > 上限时收窄最宽的轴）
        JsonArray samplingPlan = new JsonArray();
        int narrowedMachines = 0;
        for (EnumEntry e : scope) {
            Map<String, List<Integer>> explicit = rc.channelSample.get(e.simpleName);
            if (explicit != null) {
                cap.channelSample.put(e.simpleName, explicit);
                JsonObject row = new JsonObject();
                row.addProperty("simpleName", e.simpleName);
                row.addProperty("source", "explicit");
                row.add("channelSample", sampleJson(explicit));
                samplingPlan.add(row);
                continue;
            }
            VariantMachineFacts.MachineFact facts = null;
            try {
                facts = VariantMachineFacts.load(factsFile, e.simpleName);
            } catch (Throwable t) {
                failures.add(
                    exportFailure(e.simpleName, "plan", "FactsUnreadable", "无法读取该机的通道事实，抽样规划跳过（将按全量域捕获）: " + t, t));
            }
            if (facts == null) continue;
            PlanResult pr = planSample(facts, maxVariants, maxChannelValues, !structuralOnly);
            if (pr.sample.isEmpty()) continue;
            cap.channelSample.put(e.simpleName, pr.sample);
            narrowedMachines++;
            JsonObject row = new JsonObject();
            row.addProperty("simpleName", e.simpleName);
            row.addProperty("source", "auto");
            row.addProperty("reason", pr.reason);
            row.addProperty("fullCombos", Long.valueOf(pr.fullCombos));
            row.addProperty("plannedCombos", Long.valueOf(pr.plannedCombos));
            row.addProperty("maxTotalTier", Integer.valueOf(facts.maxTotalTier));
            row.add("channelSample", sampleJson(pr.sample));
            samplingPlan.add(row);
            notes.add("自动兜底抽样：" + e.simpleName + " —— " + pr.reason);
        }
        if (narrowedMachines > 0) {
            notes.add(
                "本轮有 " + narrowedMachines
                    + " 台机器的通道域被安全上限收窄（组合积超 maxVariantsPerMachine="
                    + maxVariants
                    + "）；被收窄通道的真实域与「只覆盖声明域」这一事实已写进数据集与被收窄通道的 notes。");
        }
        JsonObject captureReport = null;
        String datasetDirPath = "";
        Throwable captureFailure = null;
        try {
            captureReport = VariantCaptureRunner.run(mc, cap);
            datasetDirPath = captureReport.get("runDir")
                .getAsString();
        } catch (Throwable t) {
            captureFailure = t;
            FMLLog.log(Level.ERROR, t, "[SDE][T1.5] T1.3 捕获阶段整体失败");
        }
        if (captureReport != null) {
            // T1.3 的失败清单**原样并入**（不得静默跳过）
            JsonArray cf = captureReport.getAsJsonArray("failures");
            if (cf != null) {
                for (JsonElement fe : cf) {
                    JsonObject f = fe.getAsJsonObject();
                    failures.add(
                        exportFailure(
                            machineOf(f),
                            "t1.3-" + str(f, "stage"),
                            str(f, "kind"),
                            str(f, "message"),
                            null));
                }
            }
        }

        // ---- 3) 因子化编码 + 4) 信封落盘 ----
        JsonArray products = new JsonArray();
        List<String> exportedSlugs = new ArrayList<String>();
        long encodeMs = 0L;
        if (captureReport != null) {
            File datasetDir = new File(datasetDirPath);
            File machinesDir = new File(datasetDir, "machines");
            File[] files = machinesDir.listFiles();
            Map<String, File> bySlug = new LinkedHashMap<String, File>();
            if (files != null) {
                for (File f : files) {
                    if (!f.isFile() || !f.getName()
                        .endsWith(".json")) continue;
                    bySlug.put(
                        f.getName()
                            .substring(
                                0,
                                f.getName()
                                    .length() - 5),
                        f);
                }
            }
            MultiblockDatasetCodec codec = null;
            try {
                codec = new MultiblockDatasetCodec(datasetDir);
            } catch (Throwable t) {
                failures.add(exportFailure("-", "encode", "DatasetUnreadable", String.valueOf(t.getMessage()), t));
            }
            for (EnumEntry e : scope) {
                if (codec == null) break;
                File mf = bySlug.get(e.slug);
                if (mf == null) {
                    failures
                        .add(exportFailure(e.simpleName, "encode", "NoDataset", "T1.3 未产出该机的数据集文件（捕获阶段失败或未执行），无产物可编码"));
                    continue;
                }
                long t0 = System.currentTimeMillis();
                try {
                    MultiblockFactorizer.MachineIn mi = codec.readMachine(mf, e.slug);
                    if (mi.variants.isEmpty()) {
                        failures.add(
                            exportFailure(e.simpleName, "encode", "NoVariants", "数据集里该机 0 个变体（组织/抽样后无可用组合），产物不可生成"));
                        continue;
                    }
                    JsonObject doc;
                    JsonObject stats;
                    if (SdeMultiblockConfig.structuralCompression) {
                        MultiblockFactorizer.Result res = MultiblockFactorizer.factorize(mi);
                        doc = res.innerBody;
                        stats = res.stats;
                    } else {
                        MultiblockExpandedWriter.Out out = MultiblockExpandedWriter.build(mi);
                        doc = out.innerBody;
                        stats = out.stats;
                    }
                    stats.addProperty("sourceSlug", e.slug);
                    stats.addProperty("datasetFile", mf.getName());
                    JsonObject envelope = envelope(mi, doc);
                    File prodFile = new File(outDir, e.slug + ".multiblock.json");
                    writeJson(prodFile, envelope);
                    stats.addProperty("productFile", prodFile.getName());
                    stats.addProperty("envelopeBytes", Long.valueOf(prodFile.length()));
                    stats.addProperty("envelopeSha256", VariantCaptureRunner.sha256Hex(readText(prodFile)));
                    products.add(stats);
                    exportedSlugs.add(e.slug);
                } catch (MultiblockFactorizer.FactorizeException fe) {
                    // 编码失败：定位到具体原因（通道/位置/变体），继续其余机器
                    failures.add(exportFailure(e.simpleName, "encode", "FactorizeException", fe.getMessage(), fe));
                } catch (Throwable t) {
                    failures.add(
                        exportFailure(
                            e.simpleName,
                            "encode",
                            t.getClass()
                                .getSimpleName(),
                            String.valueOf(t.getMessage()),
                            t));
                } finally {
                    encodeMs += System.currentTimeMillis() - t0;
                }
            }
        } else if (captureFailure != null) {
            failures.add(
                exportFailure(
                    "-",
                    "capture",
                    "CaptureRunFailed",
                    String.valueOf(captureFailure.getMessage()),
                    captureFailure));
        }

        // ---- 报告 ----
        JsonObject report = new JsonObject();
        report.addProperty("schema", SCHEMA);
        report.addProperty("task", "T1.5 /sde multiblock 导出（枚举 → 变体捕获 → 因子化编码 → 信封落盘）");
        report.addProperty("status", failures.isEmpty() ? "ok" : "has-failures");
        report.addProperty("requestedBy", rc.requestedBy);
        report.addProperty("outputDir", outDir.getAbsolutePath());
        report.addProperty("datasetDir", datasetDirPath);
        report.addProperty("factsFile", factsFile.getAbsolutePath());
        report.addProperty("enumeratedTotal", Integer.valueOf(all.size()));
        report.addProperty("requestedMachines", Integer.valueOf(scope.size()));
        report.addProperty("exportedProducts", Integer.valueOf(products.size()));
        report.addProperty("failureCount", Integer.valueOf(failures.size()));
        report.addProperty("structuralCompression", Boolean.valueOf(SdeMultiblockConfig.structuralCompression));
        report.addProperty("structuralOnly", Boolean.valueOf(structuralOnly));
        report.addProperty("effectiveMaxVariantsPerMachine", Integer.valueOf(maxVariants));
        report.addProperty("effectiveMaxChannelValues", Integer.valueOf(maxChannelValues));
        report.addProperty("effectiveMaxExportMachines", Integer.valueOf(maxMachines));
        report.add(
            "config",
            configJson(maxVariants, maxChannelValues, maxMachines, structuralOnly, budgetMs, outputDirName));
        JsonObject timing = new JsonObject();
        timing.addProperty(
            "captureMs",
            captureReport == null ? -1L
                : captureReport.getAsJsonObject("totals")
                    .get("elapsedMs")
                    .getAsLong());
        timing.addProperty("encodeMs", Long.valueOf(encodeMs));
        timing.addProperty("totalMs", Long.valueOf(System.currentTimeMillis() - started));
        report.add("timing", timing);
        if (captureReport != null) {
            report.add("captureTotals", captureReport.getAsJsonObject("totals"));
            JsonArray msum = captureReport.getAsJsonArray("machines");
            JsonArray perMachine = new JsonArray();
            if (msum != null) {
                for (JsonElement me : msum) {
                    JsonObject s = me.getAsJsonObject();
                    JsonObject row = new JsonObject();
                    row.addProperty("simpleName", str(s, "simpleName"));
                    row.addProperty(
                        "variants",
                        s.get("variantCount")
                            .getAsInt());
                    row.addProperty(
                        "builds",
                        s.get("buildCount")
                            .getAsInt());
                    row.addProperty(
                        "channels",
                        s.get("channels")
                            .getAsInt());
                    row.addProperty("tierSamplePolicy", str(s, "tierSamplePolicy"));
                    JsonObject pt = s.getAsJsonObject("phaseTiming");
                    if (pt != null) row.add("phaseTiming", pt);
                    perMachine.add(row);
                }
            }
            report.add("capturePerMachine", perMachine);
        }
        report.add("products", products);
        report.add("samplingPlan", samplingPlan);
        report.add("failures", ScanJson.objects(failures));
        report.add("notes", ScanJson.strings(notes));
        report.addProperty("exportedSlugs", String.join(",", exportedSlugs));
        report.addProperty("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        writeJson(new File(outDir, REPORT_FILE), report);
        writeJson(new File(outDir, "latest-export-report.json"), report);

        if (!SdeMultiblockConfig.keepDataset && !rc.keepDataset) {
            notes.add("keepDataset=false：中间数据集保留在 " + datasetDirPath + "（本轮未删除，避免误删证据）");
        }

        FMLLog.info(
            "[SDE][T1.5] 导出完成：范围 %d 台，产物 %d 份，失败 %d 条，捕获 %s ms，编码 %s ms → %s",
            Integer.valueOf(scope.size()),
            Integer.valueOf(products.size()),
            Integer.valueOf(failures.size()),
            captureReport == null ? "-"
                : String.valueOf(
                    captureReport.getAsJsonObject("totals")
                        .get("elapsedMs")),
            Long.valueOf(encodeMs),
            outDir.getAbsolutePath());
        for (JsonObject f : failures) {
            FMLLog.warning(
                "[SDE][T1.5] 失败: %s / %s / %s / %s",
                str(f, "machine"),
                str(f, "stage"),
                str(f, "kind"),
                str(f, "message"));
        }
        return report;
    }

    // ------------------------------------------------------------------ 抽样规划

    static final class PlanResult {

        final Map<String, List<Integer>> sample = new LinkedHashMap<String, List<Integer>>();
        String reason = "";
        long fullCombos;
        long plannedCombos;
    }

    /**
     * 自动兜底抽样：某些机器的组合积（∏(域+1) × 总 Tier × 运行态）大到一次运行跑不完，
     * 而契约要求「声明集合 = ∏域 × tierSample × 运行态」—— 所以**只能收窄域**（声明域被如实标注，
     * 不假装覆盖）。策略刻意保持简单且确定：
     * <ol>
     * <li>{@code maxChannelValues&gt;0} 时先把每条通道收到 0..该值；</li>
     * <li>只要 {@code ∏(域+1) × 运行态 &gt; 上限}：把**当前域最宽**的通道折半（下界 1，保持 0..K 连续前缀）；</li>
     * <li>剩下的差额交给契约 §9.4 的 tierSample 抽样（在 T1.3 里做，并受
     * {@code 总 Tier 上界 ≤ 收窄后最小域上界} 约束，见 T1.4 报告 §8 开放项 5）。</li>
     * </ol>
     * 折半优先砍最宽的轴 → 牺牲的是"取值最多"的那条通道（LSC 这类机器上通常是尺寸型/玻璃），
     * 该事实写进报告 {@code samplingPlan} 与产物 notes。
     */
    static PlanResult planSample(VariantMachineFacts.MachineFact facts, int maxVariants, int maxChannelValues,
        boolean includeActive) {
        PlanResult pr = new PlanResult();
        int runstates = includeActive ? 2 : 1;
        List<VariantMachineFacts.ChannelFact> chs = new ArrayList<VariantMachineFacts.ChannelFact>();
        for (VariantMachineFacts.ChannelFact c : facts.channels) {
            if ("hatch".equals(c.kind)) continue;
            chs.add(c);
        }
        Map<String, Integer> dom = new LinkedHashMap<String, Integer>();
        for (VariantMachineFacts.ChannelFact c : chs) {
            int d = Math.max(0, c.max);
            if (maxChannelValues > 0) d = Math.min(d, maxChannelValues);
            dom.put(c.key(), Integer.valueOf(d));
        }
        pr.fullCombos = product(dom);
        long combos = pr.fullCombos;
        while (combos * runstates > Math.max(1, maxVariants)) {
            VariantMachineFacts.ChannelFact pick = null;
            int best = 1;
            for (VariantMachineFacts.ChannelFact c : chs) {
                int d = dom.get(c.key())
                    .intValue();
                if (d <= 1) continue;
                if (d > best) {
                    best = d;
                    pick = c;
                }
            }
            if (pick == null) break;
            dom.put(pick.key(), Integer.valueOf(Math.max(1, best / 2)));
            combos = product(dom);
        }
        pr.plannedCombos = combos;
        for (VariantMachineFacts.ChannelFact c : chs) {
            int d = dom.get(c.key())
                .intValue();
            if (d < Math.max(0, c.max)) pr.sample.put(c.key(), prefix(d));
        }
        if (pr.sample.isEmpty()) {
            pr.reason = "无需收窄（组合积 " + pr.fullCombos + " × 运行态 " + runstates + " ≤ 上限 " + maxVariants + "）";
        } else {
            pr.reason = "组合积 " + pr.fullCombos
                + " → "
                + pr.plannedCombos
                + "（× 运行态 "
                + runstates
                + "，上限 "
                + maxVariants
                + "）：收窄通道 "
                + pr.sample.keySet();
        }
        return pr;
    }

    private static long product(Map<String, Integer> dom) {
        long p = 1;
        for (Integer d : dom.values()) {
            p *= (d.intValue() + 1L);
            if (p > 1L << 40) return p;
        }
        return p;
    }

    static JsonObject sampleJson(Map<String, List<Integer>> sample) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, List<Integer>> e : sample.entrySet()) {
            JsonArray a = new JsonArray();
            for (Integer v : e.getValue()) a.add(p(v.intValue()));
            o.add(e.getKey(), a);
        }
        return o;
    }

    // ------------------------------------------------------------------ 枚举

    /** T1.2 machines.json 的一行（枚举数据）。 */
    static final class EnumEntry {

        String simpleName = "";
        String fqcn = "";
        String displayName = "";
        String slug = "";
    }

    static List<EnumEntry> readEnumeration(File machinesJson, List<JsonObject> failures) throws Exception {
        List<EnumEntry> out = new ArrayList<EnumEntry>();
        JsonObject root = MultiblockDatasetCodec.readObject(machinesJson);
        JsonArray machines = root.getAsJsonArray("machines");
        if (machines == null) return out;
        Map<String, String> seen = new LinkedHashMap<String, String>();
        for (JsonElement me : machines) {
            JsonObject m = me.getAsJsonObject();
            EnumEntry e = new EnumEntry();
            e.simpleName = str(m, "simpleName");
            e.fqcn = str(m, "fqcn");
            e.displayName = str(m, "displayName");
            e.slug = VariantCaptureRunner.slug(e.simpleName);
            String prev = seen.get(e.slug);
            if (prev != null) {
                // slug 碰撞 = 两台机器会写到同一份产物文件 → **必须报失败**，不得静默跳过。
                if (failures != null) {
                    failures.add(
                        exportFailure(
                            e.simpleName,
                            "scope",
                            "DuplicateSlug",
                            "T1.2 枚举里 " + prev
                                + " 与 "
                                + e.simpleName
                                + " 的 slug 都是 '"
                                + e.slug
                                + "'：产物文件会互相覆盖，本台被跳过（需要先解决 T1.2 的 slug 消歧）"));
                }
                continue;
            }
            seen.put(e.slug, e.simpleName);
            out.add(e);
        }
        return out;
    }

    /** 范围过滤：名字/fqcn 命中；不存在的名字**报失败**（不得静默忽略）。 */
    static List<EnumEntry> filterScope(List<EnumEntry> all, List<String> want, int maxMachines,
        List<JsonObject> failures) {
        List<EnumEntry> out = new ArrayList<EnumEntry>();
        if (want == null || want.isEmpty()) {
            for (EnumEntry e : all) out.add(e);
        } else {
            for (String w : want) {
                EnumEntry hit = null;
                for (EnumEntry e : all) {
                    if (e.simpleName.equalsIgnoreCase(w) || e.fqcn.equalsIgnoreCase(w) || e.slug.equalsIgnoreCase(w)) {
                        hit = e;
                        break;
                    }
                }
                if (hit == null) {
                    failures.add(
                        exportFailure(
                            w,
                            "scope",
                            "UnknownMachine",
                            "T1.2 枚举数据里找不到该多方块（既不匹配 simpleName、fqcn，也不匹配 slug）"));
                    continue;
                }
                if (!out.contains(hit)) out.add(hit);
            }
        }
        if (maxMachines > 0 && out.size() > maxMachines) {
            List<EnumEntry> cut = new ArrayList<EnumEntry>();
            for (int i = 0; i < maxMachines; i++) cut.add(out.get(i));
            return cut;
        }
        return out;
    }

    // 注意（空 scope 的语义，行为未改；修复已登记 issue）：
    // 本方法把 want 为空/null 解释为「不过滤」⇒ 一次 `scope=` 残缺或空触发文件会**静默导出全量**
    // （枚举全量 221 台，估算 ≈32h@默认上限），而不是报错、也不是"什么都不导出"。
    // 与之配套的变体捕获半环（VariantCaptureRunner#resolveTargets）对「空」的解释不同：空 machines
    // 落到 DEFAULT_TARGETS（4 台代表机）。两个 runner 的空值语义不一致，于是空 scope 会造成
    // 「导出 221 台、捕获只跑 4 台」的白跑。要修必须统一"空 = 报错"或"空 = 同一份默认子集"。

    // ------------------------------------------------------------------ 落盘与工具

    static JsonObject envelope(MultiblockFactorizer.MachineIn mi, JsonObject inner) {
        JsonObject rawFinal = new JsonObject();
        rawFinal.addProperty("id", mi.id);
        rawFinal.addProperty("mode", "multiblock");
        rawFinal.addProperty("label", mi.displayName);
        rawFinal.addProperty("author", "Lightning T1.5 /sde multiblock");
        rawFinal.addProperty("description", "多方块为主文档（一份文件 = 一台多方块）：尺寸型定骨架 + 共享差异规则表 + 每变体一帧。");
        rawFinal.addProperty("modSource", "lightning.t1.5");
        rawFinal.addProperty("schemaVersion", Integer.valueOf(1));
        rawFinal.addProperty("documentShape", "multiblock");
        for (Map.Entry<String, JsonElement> e : inner.entrySet()) rawFinal.add(e.getKey(), e.getValue());
        return SceneEnvelopeBuilder.toEnvelope(rawFinal);
    }

    static JsonObject configJson(int maxVariants, int maxChannelValues, int maxMachines, boolean structuralOnly,
        long budgetMs, String outputDirName) {
        JsonObject o = new JsonObject();
        o.addProperty("structuralCompression", Boolean.valueOf(SdeMultiblockConfig.structuralCompression));
        o.addProperty("maxChannelValues", Integer.valueOf(maxChannelValues));
        o.addProperty("maxVariantsPerMachine", Integer.valueOf(maxVariants));
        o.addProperty("maxExportMachines", Integer.valueOf(maxMachines));
        o.addProperty("structuralOnly", Boolean.valueOf(structuralOnly));
        o.addProperty("outputDirName", outputDirName);
        o.addProperty("globalBudgetMs", Long.valueOf(budgetMs));
        o.addProperty("includeThumbnails", Boolean.valueOf(GeometryPalette.EMITS_THUMBNAIL_PNG));
        o.addProperty(
            "thumbnailPNGPolicy",
            "恒不产出：GPU 渲染像素跨运行不稳定，违反产物逐字节幂等（契约：docs/contracts/format-multiblock-doc.md §6.3）");
        o.addProperty("embedTextures", Boolean.valueOf(SdeMultiblockConfig.embedTextures));
        return o;
    }

    static JsonObject exportFailure(String machine, String stage, String kind, String message) {
        return exportFailure(machine, stage, kind, message, null);
    }

    static JsonObject exportFailure(String machine, String stage, String kind, String message, Throwable t) {
        JsonObject o = new JsonObject();
        o.addProperty("machine", machine == null ? "-" : machine);
        o.addProperty("stage", stage);
        o.addProperty("kind", kind);
        o.addProperty("message", message == null ? "" : message);
        if (t != null) o.addProperty("failure", MultiblockScanAutomation.describeChain(t));
        o.addProperty("atEpochMs", Long.valueOf(System.currentTimeMillis()));
        return o;
    }

    private static String machineOf(JsonObject failureEntry) {
        String m = str(failureEntry, "machine");
        return m.isEmpty() ? "-" : m;
    }

    static String str(JsonObject o, String key) {
        return o != null && o.has(key)
            && !o.get(key)
                .isJsonNull() ? o.get(key)
                    .getAsString() : "";
    }

    static void writeJson(File f, JsonElement e) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("mkdir " + parent);
        }
        OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        try {
            w.write(PRETTY.toJson(e));
            w.write('\n');
        } finally {
            w.close();
        }
    }

    static String readText(File f) throws IOException {
        try {
            return VariantCaptureRunner.readText(f);
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    /** 供诊断：把一次产物统计写成一行文本。 */
    static String productLine(JsonObject stats) {
        return str(stats, "machine") + " N="
            + stats.get("variants")
                .getAsInt()
            + " 规则="
            + stats.getAsJsonObject("rules")
                .get("total")
                .getAsInt();
    }

    /** 显式声明的取值清单（'0..K 连续前缀'）——触发文件与自动规划共用。 */
    static List<Integer> prefix(int k) {
        List<Integer> vals = new ArrayList<Integer>();
        for (int i = 0; i <= k; i++) vals.add(Integer.valueOf(i));
        return vals;
    }

    static JsonPrimitive p(int v) {
        return new JsonPrimitive(Integer.valueOf(v));
    }
}
