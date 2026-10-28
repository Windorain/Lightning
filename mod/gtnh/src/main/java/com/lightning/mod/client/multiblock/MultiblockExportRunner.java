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
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;
import com.lightning.mod.config.SdeMultiblockConfig;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 全量导出本体：**一条命令全量导出多方块文档**，每个多方块恰好一份文件。
 * <p>
 * 全流程（导出管线的三段交付 A/B/C）：
 * <ol>
 * <li><b>枚举（枚举事实层）</b>：读 {@code multiblock_scan/run-NNNN/machines.json}（221 台的枚举 + 通道/总 Tier 事实），
 * 由命令的范围参数过滤。</li>
 * <li><b>逐台变体构建 + 捕获（捕获数据集）</b>：复用 {@link VariantCaptureRunner#run(Minecraft, VariantCaptureRunner.Config)}
 * —— 一次运行覆盖范围内**所有**机器（共用一个并集调色板与一次纹理嵌入），产物落在
 * {@code <outputDir>/_dataset/run-NNNN/}。</li>
 * <li><b>因子化编码（因子化编码器）</b>：对数据集里的每台机器调用
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

    public static final String SCHEMA = "lightning.multiblock.export/1";
    public static final String REPORT_FILE = "export-report.json";
    /** 中间数据集子目录（相对产物目录）。 */
    public static final String DATASET_SUBDIR = "_dataset";

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    private MultiblockExportRunner() {}

    // ------------------------------------------------------------------ 运行配置

    /** 一次导出的运行参数（来自 {@code /sde multiblock} 命令或 cp 的 {@code export.multiblock} 动作）。 */
    public static final class RunConfig {

        /** 范围：simpleName 或 fqcn；空 = 全部（受 {@link #maxExportMachines} 约束）。 */
        public final List<String> machines = new ArrayList<String>();
        /** 显式通道抽样（机 simpleName → 通道 id → 0..K 连续前缀）；缺省走自动规划。 */
        public final Map<String, Map<String, List<Integer>>> channelSample = new LinkedHashMap<String, Map<String, List<Integer>>>();
        /**
         * 自毁退出 / 删触发文件：<b>老触发文件通道的遗留开关</b>（见 {@link VariantCaptureRunner.Config} 的同类字段）。
         *
         * <p>
         * 早期由 {@code sde_multiblock.json} 给出、由 {@code MultiblockExportAutomation} 消费；
         * 该通道与 {@code readConfig(mc)} 已删除，因此这里不再有写入者。
         * 保留是因为控制面通道按 contract.md §14 的纪律显式置 false
         * （{@code ExportMultiblockAction} 的 {@code rc.exit=false / rc.cleanupTrigger=false}），
         * 而这条纪律需要字段存在才能表达。
         */
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
        /** 请求者 / 来源，写进报告（cp 通道写 {@code cp:export.multiblock}）。 */
        public String requestedBy = "direct";
        /**
         * <b>产物根目录的绝对路径覆盖</b>（cp 通道用）。
         *
         * <p>
         * 早期两条通道（触发文件 / {@code /sde multiblock} 命令）的落点都是
         * {@code <mcDataDir>/<outputDirName>}；触发文件通道已删除，命令通道保留。
         * cp 的 {@code export.multiblock} 动作要求产物落<b>它自己的 run 目录</b>（单一归属），
         * 而 run 目录是绝对路径，无法用「相对 mcDataDir 的目录名」表达。因此本字段为
         * cp 通道提供覆盖口：非空时 {@code outputDirName} 被忽略，产物根直接用它。
         *
         * <p>
         * 默认 null ⇒ 命令通道的落点行为<b>逐字节不变</b>。
         */
        public java.io.File outputRootOverride = null;
        /**
         * <b>产物是否落盘</b>：{@code false} 时 {@code run()} 只计算与返回报告，
         * <b>不</b>写任何文件——用于「预算/枚举可行性试跑」与「显式校验产物形态而不落盘」。
         *
         * <p>
         * 默认 true（既有行为）。cp 通道的 {@code dryRun} 参数映射到它。
         */
        public boolean writeOutputs = true;
    }

    // ------------------------------------------------------------------ 主流程

    /**
     * 用**显式运行配置**跑一轮导出。
     *
     * <p>
     * <b>无触发文件入口</b>：{@code run(Minecraft)} 与 {@code readConfig(Minecraft)} 已随老设施删除
     * 删除（老触发文件通道 {@code sde_multiblock.json} 不再存在）。本方法是唯一入口，
     * 调用方是 {@code /sde multiblock} 的客户端半环与 cp 的 {@code export.multiblock} 动作。
     */
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

        File outDir = rc.outputRootOverride != null ? rc.outputRootOverride : new File(mc.mcDataDir, outputDirName);
        if (rc.writeOutputs && !outDir.isDirectory() && !outDir.mkdirs()) {
            throw new IllegalStateException("无法创建产物目录: " + outDir.getAbsolutePath());
        }

        List<JsonObject> failures = new ArrayList<JsonObject>();
        List<String> notes = new ArrayList<String>();
        notes.add("配置来源: " + SdeMultiblockConfig.loadedFrom());
        notes.add(
            "配置面默认值（留白登记）：structuralCompression=" + SdeMultiblockConfig.structuralCompression
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

        // ---- 1) 枚举（枚举事实层） ----
        File factsFile = VariantMachineFacts.findLatestFacts(mc.mcDataDir);
        if (factsFile == null) {
            throw new IllegalStateException("找不到枚举事实层的 machines.json（multiblock_scan/run-NNNN/）——枚举数据缺失，导出无法开始");
        }
        List<EnumEntry> all = readEnumeration(factsFile, failures);
        notes.add("枚举来源: " + factsFile.getAbsolutePath() + "（枚举事实层，共 " + all.size() + " 台多方块）");
        List<EnumEntry> scope = filterScope(all, rc.machines, maxMachines, failures);
        notes.add(
            "本次范围: " + scope.size()
                + " 台"
                + (rc.machines.isEmpty() ? "（全部）" : "（指定 " + rc.machines + "）")
                + (maxMachines > 0 ? "，maxExportMachines=" + maxMachines : ""));

        // ---- 2) 逐台变体构建 + 捕获（捕获数据集；一次运行覆盖范围内全部机器） ----
        VariantCaptureRunner.Config cap = new VariantCaptureRunner.Config();
        cap.machines.clear();
        for (EnumEntry e : scope) cap.machines.add(e.fqcn);
        cap.outputDirName = outputDirName + "/" + DATASET_SUBDIR;
        if (rc.outputRootOverride != null) {
            // cp 通道：数据集也必须落 run 目录（单一归属），
            // 因此把覆盖口一并传给捕获步骤——否则数据集会写到老路径 <mcDataDir>/sde_multiblock_exports/。
            cap.outputRootOverride = new File(rc.outputRootOverride, DATASET_SUBDIR);
        }
        cap.includeActiveRunstate = !structuralOnly;
        cap.maxVariantsPerMachine = Math.max(2, maxVariants);
        cap.globalBudgetMs = budgetMs;
        // 不设 includeThumbnails：数据集调色板恒不产出 thumbnailPNG（幂等硬约束，见 GeometryPalette.EMITS_THUMBNAIL_PNG）。
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

        // ---- dryRun：只做枚举 + 抽样规划 + 预算核算，不捕获不落盘 ----
        // 语义是「可行性试跑」：全量捕获在默认配置下是小时级，调用方需要一条便宜的路先回答
        // 「范围对不对、组合积多大、预算够不够」。它**不**假装跑过捕获——报告里 dryRun:true 显式标注，
        // 且 products[] 为空、captureTotals 缺失（不假造一份没发生过的捕获的统计）。
        if (!rc.writeOutputs) {
            JsonObject dry = baseReport(
                rc,
                outDir,
                "",
                factsFile,
                all.size(),
                scope.size(),
                maxVariants,
                maxChannelValues,
                maxMachines,
                structuralOnly,
                budgetMs,
                outputDirName);
            dry.addProperty("status", "dry-run");
            dry.addProperty("dryRun", true);
            dry.addProperty(
                "dryRunNote",
                "writeOutputs=false：只做枚举事实层 + 范围过滤 + 抽样规划 + 预算核算；" + "未执行变体捕获、未执行因子化编码、未写任何产物。因此 products[] 为空、"
                    + "captureTotals/timing.captureMs 缺失、failures[] 只含范围类失败（如未知机器名）。");
            dry.add("products", new JsonArray());
            dry.add("samplingPlan", samplingPlan);
            dry.add("failures", ScanJson.objects(failures));
            dry.add("notes", ScanJson.strings(notes));
            JsonObject timing = new JsonObject();
            timing.addProperty("captureMs", -1L);
            timing.addProperty("encodeMs", -1L);
            timing.addProperty("totalMs", Long.valueOf(System.currentTimeMillis() - started));
            dry.add("timing", timing);
            dry.addProperty("requestedMachines", Integer.valueOf(scope.size()));
            dry.addProperty("enumeratedTotal", Integer.valueOf(all.size()));
            dry.addProperty("failureCount", Integer.valueOf(failures.size()));
            dry.addProperty("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
            return dry;
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
            FMLLog.log(Level.ERROR, t, "[SDE][全量导出] 捕获数据集阶段整体失败");
        }
        if (captureReport != null) {
            // 捕获数据集的失败清单**原样并入**（不得静默跳过）
            JsonArray cf = captureReport.getAsJsonArray("failures");
            if (cf != null) {
                for (JsonElement fe : cf) {
                    JsonObject f = fe.getAsJsonObject();
                    failures.add(
                        exportFailure(
                            machineOf(f),
                            "捕获数据集-" + str(f, "stage"),
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
                        .add(exportFailure(e.simpleName, "encode", "NoDataset", "捕获数据集阶段未产出该机的数据集文件（捕获失败或未执行），无产物可编码"));
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
                    if (!rc.writeOutputs) {
                        // dryRun：只算不写。产物统计仍如实给出（否则「试跑」看不出会产出什么），
                        // 但 bytes/sha256 缺失并显式标注——不假造一份没写过的产物的哈希。
                        stats.addProperty("productFile", prodFile.getName());
                        stats.addProperty("written", false);
                        stats.addProperty("envelopeBytes", -1L);
                        stats.addProperty("envelopeSha256", (String) null);
                        stats.addProperty("dryRunNote", "writeOutputs=false：本份产物未落盘，故无 bytes/sha256");
                        products.add(stats);
                        exportedSlugs.add(e.slug);
                        continue;
                    }
                    writeJson(prodFile, envelope);
                    stats.addProperty("productFile", prodFile.getName());
                    stats.addProperty("written", true);
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
        JsonObject report = baseReport(
            rc,
            outDir,
            datasetDirPath,
            factsFile,
            all.size(),
            scope.size(),
            maxVariants,
            maxChannelValues,
            maxMachines,
            structuralOnly,
            budgetMs,
            outputDirName);
        report.addProperty("status", failures.isEmpty() ? "ok" : "has-failures");
        report.addProperty("dryRun", false);
        report.addProperty("exportedProducts", Integer.valueOf(products.size()));
        report.addProperty("failureCount", Integer.valueOf(failures.size()));
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
        // 报告本身也要落盘；dryRun 已在上面提前 return，故此处必然 writeOutputs=true。
        // 但 cp 通道可能只想要「产物 + 报告」而不想多一份 latest-export-report.json 副本——
        // 该副本是离线脚本的稳定名约定（老路径口径），cp 通道用 report.json 即可。
        writeJson(new File(outDir, REPORT_FILE), report);
        if (rc.outputRootOverride == null) {
            writeJson(new File(outDir, "latest-export-report.json"), report);
        }

        if (!SdeMultiblockConfig.keepDataset && !rc.keepDataset) {
            notes.add("keepDataset=false：中间数据集保留在 " + datasetDirPath + "（本轮未删除，避免误删证据）");
        }

        FMLLog.info(
            "[SDE][全量导出] 导出完成：范围 %d 台，产物 %d 份，失败 %d 条，捕获 %s ms，编码 %s ms → %s",
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
                "[SDE][全量导出] 失败: %s / %s / %s / %s",
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
     * <li>剩下的差额交给契约 §5.4 第 1 条的 tierSample 对齐（在捕获数据集里做，并受
     * {@code 总 Tier 上界 ≤ 收窄后最小域上界} 约束）。</li>
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

    /** 枚举事实层 machines.json 的一行（枚举数据）。 */
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
                            "枚举事实层里 " + prev
                                + " 与 "
                                + e.simpleName
                                + " 的 slug 都是 '"
                                + e.slug
                                + "'：产物文件会互相覆盖，本台被跳过（需要先解决枚举事实层的 slug 消歧）"));
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
                            "枚举事实层的数据里找不到该多方块（既不匹配 simpleName、fqcn，也不匹配 slug）"));
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

    // 注意（空 scope 的语义，行为未改；修复已登记为后续项）：
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
        rawFinal.addProperty("author", "Lightning /sde multiblock（全量导出）");
        rawFinal.addProperty("description", "多方块为主文档（一份文件 = 一台多方块）：尺寸型定骨架 + 共享差异规则表 + 每变体一帧。");
        rawFinal.addProperty("modSource", "lightning.multiblock.export");
        rawFinal.addProperty("schemaVersion", Integer.valueOf(1));
        rawFinal.addProperty("documentShape", "multiblock");
        for (Map.Entry<String, JsonElement> e : inner.entrySet()) rawFinal.add(e.getKey(), e.getValue());
        return SceneEnvelopeBuilder.toEnvelope(rawFinal);
    }

    /**
     * 报告骨架（两条路径共用：正常导出与 dryRun）。
     *
     * <p>
     * 抽出来是为了让 {@code dryRun} 报告与正式报告在<b>同一批字段</b>上给出同一批值——
     * 「试跑看到的范围/预算」与「真跑用的范围/预算」若来自两处组装，就会出现「试跑说 5 台、
     * 真跑跑 221 台」这种最难查的分叉。
     */
    static JsonObject baseReport(RunConfig rc, File outDir, String datasetDirPath, File factsFile, int enumeratedTotal,
        int scopeSize, int maxVariants, int maxChannelValues, int maxMachines, boolean structuralOnly, long budgetMs,
        String outputDirName) {
        JsonObject report = new JsonObject();
        report.addProperty("schema", SCHEMA);
        report.addProperty("task", "多方块全量导出（枚举 → 变体捕获 → 因子化编码 → 信封落盘）");
        report.addProperty("requestedBy", rc.requestedBy);
        report.addProperty("outputDir", outDir.getAbsolutePath());
        report.addProperty(
            "outputRootOverride",
            rc.outputRootOverride == null ? null : rc.outputRootOverride.getAbsolutePath());
        report.addProperty("datasetDir", datasetDirPath);
        report.addProperty("factsFile", factsFile == null ? null : factsFile.getAbsolutePath());
        report.addProperty("enumeratedTotal", Integer.valueOf(enumeratedTotal));
        report.addProperty("requestedMachines", Integer.valueOf(scopeSize));
        report.addProperty("structuralCompression", Boolean.valueOf(SdeMultiblockConfig.structuralCompression));
        report.addProperty("structuralOnly", Boolean.valueOf(structuralOnly));
        report.addProperty("effectiveMaxVariantsPerMachine", Integer.valueOf(maxVariants));
        report.addProperty("effectiveMaxChannelValues", Integer.valueOf(maxChannelValues));
        report.addProperty("effectiveMaxExportMachines", Integer.valueOf(maxMachines));
        report.add(
            "config",
            configJson(maxVariants, maxChannelValues, maxMachines, structuralOnly, budgetMs, outputDirName));
        return report;
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
        if (t != null) o.addProperty("failure", describeChain(t));
        o.addProperty("atEpochMs", Long.valueOf(System.currentTimeMillis()));
        return o;
    }

    /**
     * 异常链 + 栈顶若干帧写成一段文本：失败必须可诊断，不能只留一句「失败了」。
     *
     * <p>
     * 出处：早期由 {@code MultiblockScanAutomation.describeChain} 提供；那个类（连同
     * 老触发文件入口）已删除，而本类是那条口径的**生产消费方**（{@code export-report.json}
     * 的 {@code failures[].failure} 字段），故把这段与实现无关的诊断原语就地保留在消费方，
     * 逐字节保持同一输出格式。
     */
    private static String describeChain(Throwable t) {
        StringBuilder sb = new StringBuilder();
        Throwable cur = t;
        int guard = 0;
        while (cur != null && guard++ < 8) {
            if (sb.length() > 0) sb.append("\n<- caused by ");
            sb.append(cur.toString());
            StackTraceElement[] st = cur.getStackTrace();
            for (int i = 0; i < Math.min(st.length, 6); i++) {
                sb.append("\n    at ")
                    .append(st[i]);
            }
            cur = cur.getCause();
        }
        return sb.toString();
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
