package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.3「变体构建 + 几何捕获」的无人值守编排与落盘。
 *
 * <h3>做什么</h3>
 * 对每台代表机：<b>全合法取值组合（通道值 0..max，0 = 契约的「未设置」）× tierSample × 两运行态</b>逐变体
 * <ol>
 * <li>真实构建（{@link MultiblockWorldBuilder}：{@code onItemUse} 放控制器 → {@code construct(hintsOnly=false)}
 * → 舱口骨架；通道取值只经 trigger 的 {@code channels} 子标签注入，绝不走 {@code getBlocksToPlace}，T0.4 R4）；</li>
 * <li>真实驱动进态（{@link VariantStateDriver}：真实 TE 路径 + 运行态机本体 + 进态三行；<b>断言</b>
 * {@code isActive()} 后才捕获；必要时用公开逃生门并标注 {@code activeMechanism}）；</li>
 * <li>逐格烘焙几何（{@link VariantGeometryBakery}）→ 全局调色板并集 + 内容签名去重（{@link GeometryPalette}，
 * 复用 {@code MeshCaptureService} 的签名机制）；</li>
 * <li>布局签名断言（构造结果 vs T1.2 独立探测的预期取值表/尺寸规则）+ 跨运行签名比对。</li>
 * </ol>
 *
 * <h3>产出</h3>
 *
 * <pre>
 * variant_capture/
 *   run-0001/
 *     manifest.json          运行身份 + 配置 + 环境（含耗时，不参与跨运行逐字节比对）
 *     machines/&lt;slug&gt;.json   每台机器的变体清单（取值组合 + 运行态 + 布局签名 + 几何签名 + 调色板引用 + 网格）
 *     palette.json           全局 blockPalette（并集 + 内容签名去重）+ materialPalette + textureBlobs + 去重统计
 *     report.json            捕获报告：失败清单（静默跳过 = 失败）、去重统计、两态差异事实、跨运行签名比对
 *   latest.json              report.json 的副本
 * </pre>
 *
 * 字段设计（T1.4 消费接口）写在 {@code report.json.dataset.fieldDesign} 与
 * {@code docs/plan/probe-variant-capture.md}。
 */
@SideOnly(Side.CLIENT)
public final class VariantCaptureRunner {

    public static final String OUTPUT_DIR = "variant_capture";
    public static final String TRIGGER_FILE = "sde_variant_capture.json";
    public static final String SCHEMA = "lightning.multiblock.variant-capture/1";
    /** 单台机器的变体数上限；超过则按契约 §9.4 的 tierSample 抽样语义抽样，并在产物 notes 里写明。 */
    public static final int DEFAULT_MAX_VARIANTS_PER_MACHINE = 2000;
    public static final long DEFAULT_GLOBAL_BUDGET_MS = 60 * 60_000L;

    public static final String RUNSTATE_IDLE = "idle";
    public static final String RUNSTATE_ACTIVE = "active";

    private VariantCaptureRunner() {}

    // ------------------------------------------------------------------ 配置

    public static final class Config {

        public boolean exit = true;
        public boolean cleanupTrigger = true;
        /** 目标机器（simpleName 或 fqcn）；空 = 默认 4 台代表机。 */
        public final List<String> machines = new ArrayList<String>();
        public int maxVariantsPerMachine = DEFAULT_MAX_VARIANTS_PER_MACHINE;
        /** 调试用：每台只处理前 N 个 (tier × 取值组合) 单元（-1 = 全部）。 */
        public int limitPerMachine = -1;
        public boolean includeThumbnails = true;
        public boolean embedTextures = true;
        public long globalBudgetMs = DEFAULT_GLOBAL_BUDGET_MS;
        /** T1.2 machines.json 的显式路径覆盖；空 = 自动取 multiblock_scan 下 run 号最大者。 */
        public String factsPath = "";
        /**
         * 状态键验证预算：位置数超过 {@link #fullVerifyUpTo} 的状态键，最多抽样这么多个位置来验证「同键同几何」。
         * 见 {@link VariantGeometryBakery} 的类注释。
         */
        public int verifyPositionsPerKey = 8;
        /** 位置数 ≤ 该值的状态键一律逐格验证（EBF 的线圈 16 格、机壳 11 格都走这条）。 */
        public int fullVerifyUpTo = 24;
    }

    public static File outputDir(Minecraft mc) {
        return new File(mc.mcDataDir, OUTPUT_DIR);
    }

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, TRIGGER_FILE);
    }

    public static Config readConfig(Minecraft mc) {
        Config c = new Config();
        File f = triggerFile(mc);
        if (!f.isFile()) return c;
        try {
            String text = readText(f).trim();
            if (text.isEmpty()) return c;
            JsonObject o = new JsonParser().parse(text)
                .getAsJsonObject();
            if (o.has("exit")) c.exit = o.get("exit")
                .getAsBoolean();
            if (o.has("cleanupTrigger")) c.cleanupTrigger = o.get("cleanupTrigger")
                .getAsBoolean();
            if (o.has("maxVariantsPerMachine")) c.maxVariantsPerMachine = o.get("maxVariantsPerMachine")
                .getAsInt();
            if (o.has("limitPerMachine")) c.limitPerMachine = o.get("limitPerMachine")
                .getAsInt();
            if (o.has("includeThumbnails")) c.includeThumbnails = o.get("includeThumbnails")
                .getAsBoolean();
            if (o.has("embedTextures")) c.embedTextures = o.get("embedTextures")
                .getAsBoolean();
            if (o.has("globalBudgetMs")) c.globalBudgetMs = o.get("globalBudgetMs")
                .getAsLong();
            if (o.has("verifyPositionsPerKey")) c.verifyPositionsPerKey = o.get("verifyPositionsPerKey")
                .getAsInt();
            if (o.has("fullVerifyUpTo")) c.fullVerifyUpTo = o.get("fullVerifyUpTo")
                .getAsInt();
            if (o.has("factsPath")) c.factsPath = o.get("factsPath")
                .getAsString();
            if (o.has("machines") && o.get("machines")
                .isJsonArray()) {
                for (JsonElement e : o.getAsJsonArray("machines")) {
                    c.machines.add(e.getAsString());
                }
            }
        } catch (Throwable t) {
            FMLLog.warning("[SDE][T1.3] 触发文件解析失败，使用默认配置: %s", t.toString());
        }
        return c;
    }

    // ------------------------------------------------------------------ 目标机

    static final class Target {

        final String fqcn;
        final String label;
        final ProbeTarget.StructurePlan plan;
        final boolean allowEscapeHatch;
        final String role;

        Target(String fqcn, String label, ProbeTarget.StructurePlan plan, boolean allowEscapeHatch, String role) {
            this.fqcn = fqcn;
            this.label = label;
            this.plan = plan;
            this.allowEscapeHatch = allowEscapeHatch;
            this.role = role;
        }
    }

    private static final Target[] DEFAULT_TARGETS = {
        new Target(
            "gregtech.common.tileentities.machines.multi.MTEElectricBlastFurnace",
            "MTEElectricBlastFurnace",
            ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH,
            true,
            "替换型通道代表（任务点名机；pinned 5.09.52.283 实测只有 coil 一个具名通道，coil+glass 的说法在本版本不成立，见报告勘误）"),
        new Target(
            "gregtech.common.tileentities.machines.multi.MTEDistillationTower",
            "MTEDistillationTower",
            ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH,
            true,
            "尺寸型通道代表（STRUCTURE_HEIGHT，getValueClamped(trigger,3,12)）"),
        new Target(
            "gregtech.common.tileentities.machines.multi.MTEBrickedBlastFurnace",
            "MTEBrickedBlastFurnace",
            ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH,
            true,
            "仅总 Tier 代表（无具名通道，maxTotalTier=1）"),
        new Target(
            "gtPlusPlus.xmod.gregtech.common.tileentities.machines.multi.production.MTEQuantumForceTransformer",
            "MTEQuantumForceTransformer",
            ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH,
            true,
            "真·多通道替换型代表（manipulator + shielding 两条替换型通道同时变化，覆盖「通道组合」轴）") };

    // ------------------------------------------------------------------ 主流程

    public static JsonObject run(Minecraft mc) throws Exception {
        Config cfg = readConfig(mc);
        long started = System.currentTimeMillis();
        File dir = outputDir(mc);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + dir.getAbsolutePath());
        }
        int previousRunIndex = previousRunIndex(dir);
        int runIndex = previousRunIndex + 1;
        File runDir = new File(dir, String.format("run-%04d", runIndex));
        File machinesDir = new File(runDir, "machines");
        if (!machinesDir.isDirectory() && !machinesDir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + machinesDir.getAbsolutePath());
        }

        File factsFile = resolveFactsFile(mc, cfg);
        GeometryPalette palette = new GeometryPalette(cfg.includeThumbnails);
        PlanCache planCache = new PlanCache();

        List<JsonObject> failures = new ArrayList<JsonObject>();
        List<JsonObject> machineSummaries = new ArrayList<JsonObject>();
        List<JsonObject> runStateFacts = new ArrayList<JsonObject>();
        List<String> notes = new ArrayList<String>();
        int totalVariants = 0;
        int totalCaptures = 0;
        int totalBuilds = 0;

        if (factsFile == null) {
            notes.add(
                "找不到 T1.2 的 machines.json（multiblock_scan/run-NNNN/），本轮的「预期取值表/尺寸规则」断言全部缺少输入，"
                    + "变体仍会真实构建+捕获，但断言会显式记为 skipped(no-facts)");
        } else {
            notes.add("T1.2 事实层输入: " + factsFile.getAbsolutePath());
        }

        for (Target t : resolveTargets(cfg)) {
            if (System.currentTimeMillis() - started > cfg.globalBudgetMs) {
                failures.add(
                    failure(t.label, "budget", "GlobalBudgetExceeded", "整轮预算 " + cfg.globalBudgetMs + " ms 耗尽，本台未执行"));
                continue;
            }
            MachineRun mr = runMachine(t, cfg, factsFile, palette, planCache, failures, started);
            if (mr == null) continue;
            ScanJson.write(new File(machinesDir, mr.slug + ".json"), mr.machineJson);
            machineSummaries.add(mr.summary);
            runStateFacts.add(mr.runStateFacts);
            totalVariants += mr.variantCount;
            totalCaptures += mr.captureCount;
            totalBuilds += mr.buildCount;
        }

        if (cfg.embedTextures) {
            palette.embedTextures();
        }
        JsonObject paletteJson = buildPaletteJson(palette);
        ScanJson.write(new File(runDir, "palette.json"), paletteJson);

        JsonObject signatureComparison = compareWithPrevious(
            dir,
            previousRunIndex,
            runDir,
            machineSummaries,
            paletteJson);

        JsonObject report = new JsonObject();
        report.addProperty("schema", SCHEMA);
        report.addProperty("task", "T1.3 变体构建 + 几何捕获");
        report.addProperty("runIndex", runIndex);
        report.addProperty("runDir", runDir.getAbsolutePath());
        report.addProperty("status", failures.isEmpty() ? "ok" : "has-failures");
        report.add("config", configJson(cfg));
        report.add("environment", environmentJson(factsFile));
        report.add("dataset", datasetFieldDesign());

        JsonObject totals = new JsonObject();
        totals.addProperty("machines", machineSummaries.size());
        totals.addProperty("builds", totalBuilds);
        totals.addProperty("variants", totalVariants);
        totals.addProperty("captures", totalCaptures);
        totals.addProperty("failureCount", failures.size());
        totals.addProperty("paletteEntries", palette.size());
        totals.addProperty("duplicateCapturesSuppressed", palette.duplicateCaptures());
        totals.addProperty("internCalls", palette.internCalls());
        totals.addProperty("elapsedMs", System.currentTimeMillis() - started);
        totals.addProperty("hatchPlanCacheHits", planCache.hits);
        totals.addProperty("hatchPlanCacheStores", planCache.stores);
        int fullVariants = 0;
        int groupedVariants = 0;
        int unstableKeys = 0;
        for (JsonObject s : machineSummaries) {
            JsonObject skv = s.getAsJsonObject("stateKeyVerification");
            if (skv == null) continue;
            fullVariants += skv.get("fullCaptureVariants")
                .getAsInt();
            groupedVariants += skv.get("anchoredCaptureVariants")
                .getAsInt();
            unstableKeys += skv.get("unstableStateKeys")
                .getAsInt();
        }
        totals.addProperty("fullCaptureVariants", fullVariants);
        totals.addProperty("anchoredCaptureVariants", groupedVariants);
        totals.addProperty("unstableStateKeys", unstableKeys);
        report.add("totals", totals);

        report.add("machines", ScanJson.objects(machineSummaries));
        report.add("paletteDedup", palette.statsJson());
        report.add("runStateFacts", ScanJson.objects(runStateFacts));
        report.add("signatureComparison", signatureComparison);
        report.add("failures", ScanJson.objects(failures));
        report.add("notes", ScanJson.strings(notes));

        ScanJson.write(new File(runDir, "report.json"), report);
        ScanJson.write(new File(dir, "latest.json"), report);
        ScanJson.write(new File(runDir, "manifest.json"), manifestJson(runIndex, runDir, started, cfg, factsFile));

        FMLLog.info(
            "[SDE][T1.3] run-%04d 完成：%d 台 / %d 变体 / %d 次捕获，调色板 %d 条（去重丢弃 %d 次），失败 %d，%d ms，输出 %s",
            Integer.valueOf(runIndex),
            Integer.valueOf(machineSummaries.size()),
            Integer.valueOf(totalVariants),
            Integer.valueOf(totalCaptures),
            Integer.valueOf(palette.size()),
            Integer.valueOf(palette.duplicateCaptures()),
            Integer.valueOf(failures.size()),
            Long.valueOf(System.currentTimeMillis() - started),
            runDir.getAbsolutePath());
        return report;
    }

    // ------------------------------------------------------------------ 单台机器

    static final class MachineRun {

        String slug;
        JsonObject machineJson;
        JsonObject summary;
        JsonObject runStateFacts;
        int variantCount;
        int captureCount;
        int buildCount;
    }

    private static MachineRun runMachine(Target t, Config cfg, File factsFile, GeometryPalette palette,
        PlanCache planCache, List<JsonObject> failures, long started) {
        MachineRun out = new MachineRun();
        out.slug = slug(t.label);

        ProbeTarget target = ProbeTarget.resolve(t.fqcn, t.label, t.plan, t.allowEscapeHatch);
        if (target == null) {
            failures.add(failure(t.label, "resolve", "TargetNotFound", "METATILEENTITIES 里找不到 " + t.fqcn));
            return null;
        }

        VariantMachineFacts.MachineFact facts = null;
        String factsError = null;
        try {
            facts = VariantMachineFacts.load(factsFile, t.label);
            if (facts == null && factsFile != null) factsError = "machines.json 里没有 " + t.label;
        } catch (Throwable e) {
            factsError = describe(e);
        }

        List<VariantMachineFacts.ChannelFact> channels = facts == null
            ? new ArrayList<VariantMachineFacts.ChannelFact>()
            : facts.channels;
        int maxTotalTier = facts == null ? 1 : Math.max(1, facts.maxTotalTier);

        List<Integer> tierSample = new ArrayList<Integer>();
        for (int i = 1; i <= maxTotalTier; i++) {
            tierSample.add(Integer.valueOf(i));
        }
        List<String> sampleNotes = new ArrayList<String>();

        // 取值组合（通道值 0..max；0 = 未设置，契约 §5.2）
        List<int[]> combos = enumerateCombos(channels);

        // 组合数上限：> maxVariantsPerMachine 时按契约 §9.4 的 tierSample 抽样语义抽样（并写进产物）
        int units = combos.size() * tierSample.size();
        if (units * 2 > cfg.maxVariantsPerMachine) {
            int budgetUnits = Math.max(1, cfg.maxVariantsPerMachine / 2);
            int keep = Math.max(1, budgetUnits / Math.max(1, combos.size()));
            tierSample = sampleEvenly(1, maxTotalTier, keep);
            sampleNotes.add(
                "组合数 " + (units * 2)
                    + " > 上限 "
                    + cfg.maxVariantsPerMachine
                    + "，按契约 tierSample 语义抽样：总 Tier 取 "
                    + tierSample
                    + "（全量域 1.."
                    + maxTotalTier
                    + "）；各通道取值域仍为全量 0..max");
            units = combos.size() * tierSample.size();
        }
        if (cfg.limitPerMachine > 0 && units > cfg.limitPerMachine) {
            sampleNotes.add(
                "调试开关 limitPerMachine=" + cfg.limitPerMachine + "：只处理前 " + cfg.limitPerMachine + " 个 (tier × 取值组合) 单元");
        }

        int tierLow = tierSample.get(0)
            .intValue();

        JsonObject machineJson = new JsonObject();
        machineJson.addProperty("schema", SCHEMA);
        machineJson.addProperty("generatedBy", "T1.3 VariantCaptureRunner（真实构建 → 真实进态 → 逐格烘焙捕获）");
        JsonObject machineObj = new JsonObject();
        machineObj.addProperty("fqcn", t.fqcn);
        machineObj.addProperty("simpleName", t.label);
        machineObj.addProperty("displayName", facts == null ? "" : facts.displayName);
        machineObj.addProperty("mteId", target.metaTileId);
        machineObj.addProperty("role", t.role);
        machineObj.addProperty("allowEscapeHatch", t.allowEscapeHatch);
        machineJson.add("machine", machineObj);
        machineJson.addProperty("factsSource", factsFile == null ? "" : factsFile.getAbsolutePath());
        if (factsError != null) machineJson.addProperty("factsError", factsError);

        JsonArray channelsJson = new JsonArray();
        for (VariantMachineFacts.ChannelFact c : channels) {
            JsonObject o = new JsonObject();
            o.addProperty("enum", c.enumName);
            o.addProperty("id", c.id);
            o.addProperty("key", c.key());
            // 呈现名取枚举名（T0.4 §5.2 的修正：capitalize(id) 会继承 casing ×3 歧义）
            o.addProperty("name", c.enumName);
            o.addProperty("kind", c.kind);
            JsonObject domain = new JsonObject();
            domain.addProperty("min", 0);
            domain.addProperty("max", c.max);
            o.add("domain", domain);
            if (c.min != null) o.addProperty("min", c.min.intValue());
            o.addProperty("max", c.max);
            o.addProperty("observedMax", c.observedMax);
            o.addProperty(
                "valueSemantics",
                "replace".equals(c.kind) ? "channel-data（0 = 未设置 → 回落总 Tier）"
                    : "clamped-offset（值 1 → 尺寸 " + (c.min == null ? 1 : c.min.intValue())
                        + "；值 k → 尺寸 min(k-1+"
                        + (c.min == null ? 1 : c.min.intValue())
                        + ", "
                        + VariantMachineFacts.sizeCeiling(c)
                        + ")）");
            o.addProperty("domainSource", c.domainSource);
            o.addProperty("discoverySource", c.discoverySource);
            o.addProperty("registryAgreement", c.registryAgreement);
            JsonArray expected = new JsonArray();
            for (VariantMachineFacts.ObservedValue v : c.observed) {
                JsonObject e = new JsonObject();
                e.addProperty("value", v.value);
                e.addProperty("blocksKey", v.blocksKey);
                ExpectedState es = ExpectedState.parse(v.blocksKey);
                e.addProperty("expectedItemId", es.itemId);
                e.addProperty("expectedMeta", es.meta);
                e.addProperty("expectedResolvable", es.resolvable);
                if (!es.resolvable) e.addProperty("expectedIssue", es.issue);
                expected.add(e);
            }
            o.add("expectedStates", expected);
            o.add("notes", ScanJson.strings(c.notes));
            channelsJson.add(o);
        }
        machineJson.add("channels", channelsJson);

        JsonObject totalTierDomain = new JsonObject();
        totalTierDomain.addProperty("min", 1);
        totalTierDomain.addProperty("max", maxTotalTier);
        totalTierDomain.addProperty("default", 1);
        totalTierDomain.addProperty("source", facts == null ? "none" : facts.tierSource);
        machineJson.add("totalTierDomain", totalTierDomain);
        machineJson.add("tierSample", ScanJson.ints(tierSample));
        machineJson.addProperty(
            "tierSamplePolicy",
            sampleNotes.isEmpty() ? "full(1..maxTotalTier)" : String.join(" ; ", sampleNotes));

        JsonArray runstates = new JsonArray();
        JsonObject idleState = new JsonObject();
        idleState.addProperty("id", RUNSTATE_IDLE);
        idleState.addProperty("name", "Idle");
        idleState.addProperty("materialSwap", false);
        runstates.add(idleState);
        JsonObject activeState = new JsonObject();
        activeState.addProperty("id", RUNSTATE_ACTIVE);
        activeState.addProperty("name", "Running");
        activeState.addProperty("materialSwap", true);
        runstates.add(activeState);
        machineJson.add("runstates", runstates);

        JsonObject gridConvention = new JsonObject();
        gridConvention.addProperty(
            "origin",
            "相对控制器放置坐标 (" + MultiblockWorldBuilder.PLACE_X
                + ","
                + MultiblockWorldBuilder.PLACE_Y
                + ","
                + MultiblockWorldBuilder.PLACE_Z
                + ") 的偏移，指向该变体包围盒的最小角 [dx,dy,dz]");
        gridConvention.addProperty(
            "cellGrid",
            "[z][row][x]；row 0 = 顶部（y 最大）；坐标 = (origin[0]+x, origin[1]+size[1]-1-row, origin[2]+z)");
        gridConvention.addProperty("value", "全局 blockPalette 下标；0 = 空气（与既有产物一致）");
        gridConvention
            .addProperty("variantKey", "<通道key>:<声明值> 按 channels 顺序用 | 连接，再按序追加 tt:<总Tier>、runstate:<id>（契约 §5.1）");
        machineJson.add("gridConvention", gridConvention);

        JsonArray variantsJson = new JsonArray();
        JsonArray assertions = new JsonArray();

        // A1 需要的基线快照：通道 c 取 1、其余取 0、tier = tierLow 时的「坐标 → 方块状态」
        Map<String, Map<String, String>> replaceBaselines = new LinkedHashMap<String, Map<String, String>>();
        JsonArray replaceValueChecks = new JsonArray();

        int variantIndex = 0;
        int buildCount = 0;
        int captureCount = 0;
        int fullCaptureVariants = 0;
        int anchoredCaptureVariants = 0;
        int sampledCaptureVariants = 0;
        int keysNewlyVerifiedTotal = 0;
        long buildMs = 0L;
        long driveMs = 0L;
        long captureMs = 0L;
        boolean truncated = cfg.limitPerMachine > 0 || !sampleNotes.isEmpty();
        int machineFailuresBefore = failures.size();
        // 状态键验证表：某个「方块状态键」只有在某次**逐格**捕获里出现的所有位置都给出同一条条目签名，
        // 且跨变体保持一致，才允许后续变体按状态共享（见 VariantGeometryBakery 的类注释）。
        Map<String, String> verifiedKeys = new LinkedHashMap<String, String>();
        TreeSet<String> unstableKeys = new TreeSet<String>();
        int unitsDone = 0;
        TreeSet<Integer> instanceOrdinalsSeen = new TreeSet<Integer>();
        Map<Integer, Integer> instanceHashToOrdinal = new LinkedHashMap<Integer, Integer>();
        int instanceReuseCount = 0;
        Map<String, JsonObject> variantsByKey = new LinkedHashMap<String, JsonObject>();

        boolean stop = false;
        for (int ti = 0; ti < tierSample.size() && !stop; ti++) {
            int tier = tierSample.get(ti)
                .intValue();
            for (int[] combo : combos) {
                if (cfg.limitPerMachine > 0 && unitsDone >= cfg.limitPerMachine) {
                    stop = true;
                    break;
                }
                unitsDone++;
                if (System.currentTimeMillis() - started > cfg.globalBudgetMs) {
                    failures.add(
                        failure(t.label, "budget", "GlobalBudgetExceeded", "整轮预算在变体循环中耗尽（已完成 " + unitsDone + " 个单元）"));
                    stop = true;
                    break;
                }

                Map<String, Integer> values = new LinkedHashMap<String, Integer>();
                for (int ci = 0; ci < channels.size(); ci++) {
                    values.put(
                        channels.get(ci)
                            .key(),
                        Integer.valueOf(combo[ci]));
                }
                ItemStack trigger = MultiblockWorldBuilder.triggerWithChannels(tier, values);
                long tBuildStart = System.currentTimeMillis();
                MultiblockWorldBuilder.BuildResult build = MultiblockWorldBuilder.build(target, trigger, planCache);
                buildCount++;
                long tBuildDone = System.currentTimeMillis();
                buildMs += tBuildDone - tBuildStart;
                String buildTag = t.label + " tt=" + tier + " " + values;

                if (build.failure != null || !build.controllerPlaced || !build.structureBuilt) {
                    failures.add(
                        failure(
                            t.label,
                            "build",
                            "BuildFailed",
                            buildTag + " → "
                                + (build.failure != null ? build.failure
                                    : "controllerPlaced=" + build.controllerPlaced
                                        + " structureBuilt="
                                        + build.structureBuilt)));
                    continue;
                }

                int ordinal;
                Integer prev = instanceHashToOrdinal.get(Integer.valueOf(build.metaTileInstanceHash));
                if (prev == null) {
                    ordinal = instanceHashToOrdinal.size() + 1;
                    instanceHashToOrdinal.put(Integer.valueOf(build.metaTileInstanceHash), Integer.valueOf(ordinal));
                    instanceOrdinalsSeen.add(Integer.valueOf(ordinal));
                } else {
                    ordinal = prev.intValue();
                    instanceReuseCount++;
                }

                VariantStateDriver.Drive drive = VariantStateDriver.drive(build);
                long tDriveDone = System.currentTimeMillis();
                driveMs += tDriveDone - tBuildDone;
                if (drive.isMultiBlockBase && !drive.serverBranchExecuted) {
                    failures.add(
                        failure(t.label, "runstate", "ServerBranchNotExecuted", buildTag + " → errorDisplayID 未变化"));
                }

                for (int si = 0; si < 2; si++) {
                    boolean active = si == 1;
                    String stateId = active ? RUNSTATE_ACTIVE : RUNSTATE_IDLE;
                    VariantStateDriver.StateResult st = active
                        ? VariantStateDriver.enterActive(build, drive, t.allowEscapeHatch)
                        : VariantStateDriver.enterIdle(build, drive);
                    if (!st.assertionPassed) {
                        failures.add(
                            failure(
                                t.label,
                                "runstate-assert",
                                "IsActiveAssertionFailed",
                                buildTag + " runstate="
                                    + stateId
                                    + " → isActive()="
                                    + st.activeObserved
                                    + "（mechanism="
                                    + st.mechanism
                                    + "）"));
                    }
                    VariantGeometryBakery.Capture cap = VariantGeometryBakery.capture(
                        build.world,
                        build.x,
                        build.y,
                        build.z,
                        palette,
                        build.player,
                        t.label,
                        verifiedKeys,
                        unstableKeys,
                        cfg.verifyPositionsPerKey,
                        cfg.fullVerifyUpTo);
                    captureCount++;
                    // 变体级捕获模式计数（互斥，便于一眼看出性能优化的作用面）：
                    // full = 该变体没有任何位置共享（完全逐格）
                    // sampled = 有位置共享，且本变体引入了新状态键（做了抽样/逐格验证）
                    // anchored = 有位置共享，且所有状态键都已验证（每键锚定 1 格 + 共享其余）
                    if (cap.positionsShared == 0) fullCaptureVariants++;
                    else if (cap.keysNewlyVerified > 0) sampledCaptureVariants++;
                    else anchoredCaptureVariants++;
                    keysNewlyVerifiedTotal += cap.keysNewlyVerified;
                    for (String m : cap.keyMismatches) {
                        failures.add(failure(t.label, "capture", "StateKeyMismatch", buildTag + " → " + m));
                    }
                    if (cap.blocksWithNoGeometry > 0) {
                        failures.add(
                            failure(
                                t.label,
                                "capture",
                                "BlockWithoutGeometry",
                                buildTag + " runstate="
                                    + stateId
                                    + " → "
                                    + cap.blocksWithNoGeometry
                                    + " 个非空气方块捕获不到四边形"));
                    }
                    if (!cap.errors.isEmpty()) {
                        failures.add(
                            failure(
                                t.label,
                                "capture",
                                "CaptureErrors",
                                buildTag + " runstate="
                                    + stateId
                                    + " → "
                                    + cap.errors.size()
                                    + " 条捕获异常，首条: "
                                    + cap.errors.get(0)));
                    }

                    String key = variantKey(channels, combo, tier, stateId);
                    JsonObject v = new JsonObject();
                    v.addProperty("index", variantIndex++);
                    v.addProperty("key", key);
                    JsonObject valuesJson = new JsonObject();
                    JsonObject effectiveJson = new JsonObject();
                    for (int ci = 0; ci < channels.size(); ci++) {
                        VariantMachineFacts.ChannelFact c = channels.get(ci);
                        valuesJson.addProperty(c.key(), combo[ci]);
                        int raw = combo[ci];
                        int eff = raw > 0 ? raw : tier;
                        eff = Math.min(eff, c.max);
                        if ("dimension".equals(c.kind) || "size".equals(c.kind)) {
                            int min = c.min == null ? 1 : c.min.intValue();
                            eff = Math.max(eff, min);
                        }
                        effectiveJson.addProperty(c.key(), eff);
                    }
                    v.add("values", valuesJson);
                    v.addProperty("totalTier", tier);
                    v.addProperty("runstate", stateId);
                    v.add("effective", effectiveJson);
                    v.addProperty("layoutSignature", cap.layoutSignature);
                    v.addProperty("geometrySignature", cap.geometrySignature);
                    v.add("grid", cap.grid);
                    v.add("paletteRefs", ScanJson.ints(cap.paletteRefs));

                    JsonObject b = new JsonObject();
                    b.addProperty("controllerPlaced", build.controllerPlaced);
                    b.addProperty("structureBuilt", build.structureBuilt);
                    b.addProperty("blocksAfterConstruct", build.blocksAfterConstruct);
                    b.addProperty("regularBlocks", cap.blockCount);
                    b.addProperty("quadCount", cap.quadCount);
                    b.addProperty("captureMode", cap.captureMode);
                    b.addProperty("positionsCaptured", cap.positionsCaptured);
                    b.addProperty("positionsShared", cap.positionsShared);
                    b.addProperty("hatchPlan", build.hatchPlanSource);
                    b.addProperty("shapeKey", build.shapeKey);
                    b.addProperty("hatchCandidateTries", build.hatchCandidateTries);
                    b.addProperty("machineFormed", build.machineFormed);
                    b.addProperty("machineFormedKnown", drive.machineFormedKnown);
                    b.addProperty("isMultiBlockBase", drive.isMultiBlockBase);
                    b.addProperty("selfDisabled", drive.selfDisabled);
                    b.addProperty("controllerInstanceOrdinal", ordinal);
                    b.addProperty("controllerInstanceReused", prev != null);
                    b.add("hatchPlacements", ScanJson.strings(build.hatchPlacements));
                    b.add("structureErrors", ScanJson.strings(build.structureErrors));
                    v.add("build", b);

                    JsonObject rs = new JsonObject();
                    rs.addProperty("requestedActive", st.requestedActive);
                    rs.addProperty("activeObserved", st.activeObserved);
                    rs.addProperty("assertionPassed", st.assertionPassed);
                    rs.addProperty("mechanism", st.mechanism);
                    rs.addProperty("maxProgressTime", st.maxProgressTime);
                    rs.addProperty("progressTime", st.progressTime);
                    rs.addProperty("errorDisplayId", st.errorDisplayId);
                    rs.addProperty("stateMachineTicks", drive.stateMachineTicks);
                    rs.addProperty("serverBranchExecuted", drive.serverBranchExecuted);
                    rs.addProperty("escapeHatchUsed", drive.escapeHatchUsed);
                    if (!drive.escapeHatchReason.isEmpty())
                        rs.addProperty("escapeHatchReason", drive.escapeHatchReason);
                    v.add("runState", rs);

                    JsonObject asserts = new JsonObject();
                    asserts.addProperty("buildOk", true);
                    asserts.addProperty("stateAssertionOk", st.assertionPassed);
                    asserts.addProperty("geometryCoverageOk", cap.blocksWithNoGeometry == 0 && cap.errors.isEmpty());
                    asserts.addProperty("instanceFresh", prev == null);
                    v.add("assertions", asserts);

                    JsonArray warnings = new JsonArray();
                    if (drive.isMultiBlockBase && !build.machineFormed) {
                        warnings.add(
                            new com.google.gson.JsonPrimitive(
                                "mMachine=false：结构被真实放置但 checkMachine 未通过（T0.3 §4.3 的遗留项）"));
                    }
                    for (String note : build.notes) {
                        warnings.add(new com.google.gson.JsonPrimitive(note));
                    }
                    TreeSet<String> multiSig = new TreeSet<String>();
                    for (TreeSet<String> sigs : cap.stateToEntrySignatures.values()) {
                        if (sigs.size() > 1) {
                            multiSig.addAll(sigs);
                        }
                    }
                    if (!multiSig.isEmpty()) {
                        warnings.add(
                            new com.google.gson.JsonPrimitive(
                                "有方块状态在同一变体内映射到多条几何（位置相关的渲染）: " + multiSig.size() + " 条"));
                    }
                    v.add("warnings", warnings);

                    variantsJson.add(v);
                    variantsByKey.put(key, v);

                    // A1 基线快照 / 差分校验：只在待机态做一次（活动态对替换型通道的方块布局无影响，
                    // 重复做只会把同一结论写两遍）。
                    if (!active) {
                        // 基线：某一替换型通道取 1、其余取 0
                        if (isSingleReplaceBaseline(channels, combo) && tier == tierLow) {
                            for (int ci = 0; ci < channels.size(); ci++) {
                                if (combo[ci] == 1) {
                                    replaceBaselines.put(
                                        channels.get(ci)
                                            .key(),
                                        worldStateMap(build.world));
                                }
                            }
                        }
                        // 校验：恰好一个替换型通道取 k ≥ 2、其余取 0、tier = tierLow（对每个 k 各校验一次）
                        if (tier == tierLow) {
                            int singleIdx = singleReplaceChannelIndexAtLeast(channels, combo, 2);
                            if (singleIdx >= 0) {
                                VariantMachineFacts.ChannelFact single = channels.get(singleIdx);
                                int k = combo[singleIdx];
                                Map<String, String> baseline = replaceBaselines.get(single.key());
                                if (baseline == null) {
                                    replaceValueChecks.add(
                                        checkResult(
                                            "A1." + single.key() + ".k" + k,
                                            "skipped",
                                            "基线（该通道 = 1）未捕获到，无法做差分"));
                                } else {
                                    ExpectedState exp = expectedStateOf(single, k);
                                    replaceValueChecks.add(
                                        diffCheck(
                                            "A1." + single.key() + ".k" + k,
                                            baseline,
                                            worldStateMap(build.world),
                                            exp,
                                            single));
                                }
                            }
                        }
                    }
                }
                captureMs += System.currentTimeMillis() - tDriveDone;
            }
        }

        machineJson.addProperty("variantCount", variantIndex);
        machineJson.add("variants", variantsJson);
        machineJson.add("variantSignatures", variantSignaturesJson(variantsJson));
        // 注意：耗时字段**不进**机器文件 —— 机器文件与 palette.json 必须跨运行逐字节一致（可重复性证据），
        // 耗时放在 report.json 的 machines[].phaseTiming 里。
        machineJson.add(
            "stateKeyVerification",
            stateKeyVerificationJson(
                verifiedKeys,
                unstableKeys,
                fullCaptureVariants,
                anchoredCaptureVariants,
                sampledCaptureVariants,
                keysNewlyVerifiedTotal,
                cfg.verifyPositionsPerKey,
                cfg.fullVerifyUpTo));

        // ---- 机器级断言
        assertions.add(
            assertion(
                "A0.channels-source",
                channels.isEmpty() && facts != null && facts.channels.isEmpty() ? "pass"
                    : (facts == null ? "skipped" : "pass"),
                facts == null ? "无 T1.2 事实层：通道清单缺失（本机按「仅总 Tier」处理）"
                    : ("通道清单来自 T1.2 machines.json：" + channels.size() + " 条")));
        assertions.add(
            assertion(
                "A1.replace-value-fidelity",
                replaceValueChecks.size() == 0 ? "skipped" : aggregateStatus(replaceValueChecks),
                replaceValueChecks.size() == 0 ? "本机没有替换型通道（或基线未捕获）" : (replaceValueChecks.size() + " 条替换型通道取值差分校验")));
        JsonObject a2 = notSetFallbackCheck(channels, tierSample, variantsByKey, truncated);
        assertions.add(a2);
        JsonObject a3 = sizeExtentCheck(channels, tierLow, variantsByKey, truncated);
        assertions.add(a3);
        assertions.add(
            assertion(
                "A4.fresh-instance",
                instanceReuseCount == 0 ? "pass" : "fail",
                "构建次数 " + buildCount
                    + "，不同 MTE 实例 "
                    + instanceOrdinalsSeen.size()
                    + " 个，实例复用 "
                    + instanceReuseCount
                    + " 次（复用即说明实例状态可能跨变体泄漏，T0.4 R5）"));
        assertions.add(
            assertion(
                "A5.state-key-verification",
                (fullCaptureVariants + sampledCaptureVariants) == 0 ? "skipped" : "pass",
                "逐格捕获变体 " + fullCaptureVariants
                    + " 个／新键抽样验证变体 "
                    + sampledCaptureVariants
                    + " 个／锚定捕获变体 "
                    + anchoredCaptureVariants
                    + " 个；已验证状态键 "
                    + verifiedKeys.size()
                    + " 个，不稳定键 "
                    + unstableKeys.size()
                    + " 个（不稳定键一律逐格捕获）"));
        for (JsonObject a : new JsonObject[] { a2, a3 }) {
            if (!"pass".equals(
                a.get("status")
                    .getAsString())
                && !"skipped".equals(
                    a.get("status")
                        .getAsString())) {
                failures.add(
                    failure(
                        t.label,
                        "assert",
                        "MachineAssertionFailed",
                        a.get("id")
                            .getAsString() + " → "
                            + a.get("detail")
                                .getAsString()));
            }
        }
        for (JsonElement e : replaceValueChecks) {
            JsonObject c = e.getAsJsonObject();
            if (!"pass".equals(
                c.get("status")
                    .getAsString())
                && !"skipped".equals(
                    c.get("status")
                        .getAsString())) {
                failures.add(
                    failure(
                        t.label,
                        "assert",
                        "ReplaceValueFidelityFailed",
                        c.get("id")
                            .getAsString() + " → "
                            + c.get("detail")
                                .getAsString()));
            }
        }
        machineJson.add("machineAssertions", assertions);
        machineJson.add("replaceValueChecks", replaceValueChecks);
        machineJson.add("notes", ScanJson.strings(sampleNotes));

        JsonObject runStateFact = runStateFact(t, variantsByKey, palette);
        out.runStateFacts = runStateFact;

        JsonObject summary = new JsonObject();
        summary.addProperty("simpleName", t.label);
        summary.addProperty("role", t.role);
        summary.addProperty("variantCount", variantIndex);
        summary.addProperty("buildCount", buildCount);
        summary.addProperty("captureCount", captureCount);
        summary.addProperty("paletteRefsUsed", paletteRefsUsed(variantsJson));
        summary.addProperty("channels", channels.size());
        summary.add("channelKeys", ScanJson.strings(channelKeys(channels)));
        summary.add("tierSample", ScanJson.ints(tierSample));
        summary.addProperty("tierSamplePolicy", sampleNotes.isEmpty() ? "full" : String.join(" ; ", sampleNotes));
        summary.addProperty("failureCount", failures.size() - machineFailuresBefore);
        summary.addProperty("machineFile", "machines/" + out.slug + ".json");
        summary.add("phaseTiming", phaseTimingJson(buildCount, buildMs, driveMs, captureMs));
        summary.add(
            "stateKeyVerification",
            stateKeyVerificationJson(
                verifiedKeys,
                unstableKeys,
                fullCaptureVariants,
                anchoredCaptureVariants,
                sampledCaptureVariants,
                keysNewlyVerifiedTotal,
                cfg.verifyPositionsPerKey,
                cfg.fullVerifyUpTo));
        summary.add("machineAssertions", assertions);

        out.machineJson = machineJson;
        out.summary = summary;
        out.variantCount = variantIndex;
        out.captureCount = captureCount;
        out.buildCount = buildCount;
        return out;
    }

    // ------------------------------------------------------------------ 断言实现

    /** A2：契约 §5.2「未设置 → 回落总 Tier」。用真实构建结果验证：全通道未设置（tt=t）与全通道显式设为 t 布局签名相同。 */
    private static JsonObject notSetFallbackCheck(List<VariantMachineFacts.ChannelFact> channels,
        List<Integer> tierSample, Map<String, JsonObject> variantsByKey, boolean truncated) {
        if (channels.isEmpty()) {
            return assertion("A2.not-set-fallback", "skipped", "本机无具名通道（仅总 Tier），无回落可验");
        }
        int checked = 0;
        int failed = 0;
        int missing = 0;
        List<String> details = new ArrayList<String>();
        for (Integer tObj : tierSample) {
            int t = tObj.intValue();
            boolean inDomain = true;
            for (VariantMachineFacts.ChannelFact c : channels) {
                if (t < 1 || t > c.max) {
                    inDomain = false;
                    break;
                }
            }
            if (!inDomain) continue;
            int[] zeros = new int[channels.size()];
            int[] setAll = new int[channels.size()];
            for (int i = 0; i < channels.size(); i++) {
                zeros[i] = 0;
                setAll[i] = t;
            }
            String kUnset = variantKey(channels, zeros, t, RUNSTATE_IDLE);
            String kSet = variantKey(channels, setAll, t, RUNSTATE_IDLE);
            JsonObject a = variantsByKey.get(kUnset);
            JsonObject b = variantsByKey.get(kSet);
            if (a == null || b == null) {
                missing++;
                if (!truncated) {
                    failed++;
                    details.add("tt=" + t + " 缺少对照变体（" + (a == null ? "unset " : "") + (b == null ? "set" : "") + "）");
                }
                continue;
            }
            checked++;
            String sa = a.get("layoutSignature")
                .getAsString();
            String sb = b.get("layoutSignature")
                .getAsString();
            if (!sa.equals(sb)) {
                failed++;
                details.add("tt=" + t + " 布局签名不同: unset=" + sa.substring(0, 12) + "… set=" + sb.substring(0, 12) + "…");
            }
        }
        String status = checked == 0 ? "skipped" : (failed == 0 ? "pass" : "fail");
        if (truncated && missing > 0 && failed == 0) status = "skipped";
        JsonObject o = assertion(
            "A2.not-set-fallback",
            status,
            "对照 " + checked
                + " 组，失败 "
                + failed
                + " 组"
                + (missing > 0 ? "，缺对照 " + missing + " 组" + (truncated ? "（本轮被 limitPerMachine/抽样截断，记为 skipped）" : "")
                    : "")
                + (details.isEmpty() ? "" : "；" + details));
        o.addProperty("checkedGroups", checked);
        o.addProperty("failedGroups", failed);
        o.addProperty("missingGroups", missing);
        return o;
    }

    /** A3：尺寸型通道的取值 → 结构尺寸规则（T1.2 §4.7 的 1 基偏移语义）。 */
    private static JsonObject sizeExtentCheck(List<VariantMachineFacts.ChannelFact> channels, int tierLow,
        Map<String, JsonObject> variantsByKey, boolean truncated) {
        VariantMachineFacts.ChannelFact sizeChannel = null;
        int sizeIdx = -1;
        for (int i = 0; i < channels.size(); i++) {
            if ("dimension".equals(channels.get(i).kind)) {
                sizeChannel = channels.get(i);
                sizeIdx = i;
                break;
            }
        }
        if (sizeChannel == null) {
            return assertion("A3.size-extent-rule", "skipped", "本机没有尺寸型通道");
        }
        JsonArray arr = new JsonArray();
        int checked = 0;
        int failed = 0;
        int missing = 0;
        List<String> details = new ArrayList<String>();
        for (int k = 1; k <= sizeChannel.max; k++) {
            int[] combo = new int[channels.size()];
            combo[sizeIdx] = k;
            String key = variantKey(channels, combo, tierLow, RUNSTATE_IDLE);
            JsonObject v = variantsByKey.get(key);
            JsonObject row = new JsonObject();
            row.addProperty("value", k);
            row.addProperty("variantKey", key);
            row.addProperty("expectedSize", VariantMachineFacts.expectedSizeFor(sizeChannel, k));
            if (v == null) {
                row.addProperty("observedSize", -1);
                row.addProperty("status", truncated ? "skipped-truncated" : "missing-variant");
                missing++;
                if (!truncated) failed++;
            } else {
                int obs = v.getAsJsonObject("grid")
                    .getAsJsonArray("size")
                    .get(1)
                    .getAsInt();
                row.addProperty("observedSize", obs);
                row.addProperty(
                    "layoutSignature",
                    v.get("layoutSignature")
                        .getAsString());
                int exp = VariantMachineFacts.expectedSizeFor(sizeChannel, k);
                boolean ok = obs == exp;
                row.addProperty("status", ok ? "pass" : "fail");
                checked++;
                if (!ok) {
                    failed++;
                    details.add("值 " + k + ": 预期 " + exp + " 实测 " + obs);
                }
            }
            arr.add(row);
        }
        JsonObject o = assertion(
            "A3.size-extent-rule",
            checked == 0 ? "skipped" : (failed == 0 ? "pass" : "fail"),
            "通道 " + sizeChannel.id
                + "（min="
                + sizeChannel.min
                + ", max="
                + sizeChannel.max
                + "）逐取值核对结构 y 尺寸：核对 "
                + checked
                + " 个取值，失败 "
                + failed
                + (missing > 0 ? "，缺 " + missing + " 个取值" : "")
                + (details.isEmpty() ? "" : "；" + details));
        o.addProperty("channel", sizeChannel.id);
        o.addProperty("sizeCeiling", VariantMachineFacts.sizeCeiling(sizeChannel));
        o.add("perValue", arr);
        return o;
    }

    /**
     * 状态键验证与捕获模式的事实（T1.4/T1.5 与调度者核对该性能优化的正确性时看这一段）。
     */
    private static JsonObject stateKeyVerificationJson(Map<String, String> verifiedKeys, TreeSet<String> unstableKeys,
        int fullVariants, int anchoredVariants, int sampledVariants, int newlyVerified, int verifyPositionsPerKey,
        int fullVerifyUpTo) {
        JsonObject o = new JsonObject();
        o.addProperty("verifiedStateKeys", verifiedKeys.size());
        o.addProperty("unstableStateKeys", unstableKeys.size());
        o.addProperty("keysNewlyVerified", newlyVerified);
        o.addProperty("fullCaptureVariants", fullVariants);
        o.addProperty("sampledCaptureVariants", sampledVariants);
        o.addProperty("anchoredCaptureVariants", anchoredVariants);
        o.addProperty("verifyPositionsPerKey", verifyPositionsPerKey);
        o.addProperty("fullVerifyUpTo", fullVerifyUpTo);
        o.addProperty(
            "rule",
            "状态键 = registryId:meta | MTE 类名 | 激活位。每个状态键在每次出现时至少锚定捕获 1 格（真实几何来源）；"
                + "位置数 ≤ fullVerifyUpTo 的键逐格验证，更大的键抽样 verifyPositionsPerKey 格验证；"
                + "抽样结果一致才允许其余位置共享；锚定捕获与已验证签名不一致 → 该键标记 unstable 并记入失败清单");
        o.addProperty("verifiedKeysSample", verifiedKeys.size() <= 12 ? String.join(" ; ", verifiedKeys.keySet()) : "");
        o.add("unstableKeys", ScanJson.strings(unstableKeys));
        return o;
    }

    private static JsonObject phaseTimingJson(int builds, long buildMs, long driveMs, long captureMs) {
        JsonObject o = new JsonObject();
        o.addProperty("builds", builds);
        o.addProperty("buildMs", buildMs);
        o.addProperty("driveMs", driveMs);
        o.addProperty("captureMs", captureMs);
        o.addProperty("totalMs", buildMs + driveMs + captureMs);
        o.addProperty(
            "perBuildMs",
            builds == 0 ? 0L : (long) Math.round((double) (buildMs + driveMs + captureMs) / (double) builds));
        return o;
    }

    /** 两态几何差异事实（有差异/无差异都要如实记录，不得编造）。 */
    private static JsonObject runStateFact(Target t, Map<String, JsonObject> variantsByKey, GeometryPalette palette) {
        JsonObject o = new JsonObject();
        o.addProperty("simpleName", t.label);
        int compared = 0;
        int geometryDiffering = 0;
        int identical = 0;
        int gridDiffering = 0;
        int structuralDiff = 0;
        int materialOnlyDiff = 0;
        TreeMap<String, Integer> mechanismHistogram = new TreeMap<String, Integer>();
        JsonArray examples = new JsonArray();
        for (Map.Entry<String, JsonObject> e : variantsByKey.entrySet()) {
            JsonObject v = e.getValue();
            if (!RUNSTATE_IDLE.equals(
                v.get("runstate")
                    .getAsString())) {
                continue;
            }
            String activeKey = e.getKey()
                .replace("|runstate:" + RUNSTATE_IDLE, "|runstate:" + RUNSTATE_ACTIVE);
            JsonObject a = variantsByKey.get(activeKey);
            if (a == null) continue;
            compared++;
            String mech = a.getAsJsonObject("runState")
                .get("mechanism")
                .getAsString();
            Integer mh = mechanismHistogram.get(mech);
            mechanismHistogram.put(mech, Integer.valueOf(mh == null ? 1 : mh.intValue() + 1));
            boolean geomSame = v.get("geometrySignature")
                .getAsString()
                .equals(
                    a.get("geometrySignature")
                        .getAsString());
            boolean layoutSame = v.get("layoutSignature")
                .getAsString()
                .equals(
                    a.get("layoutSignature")
                        .getAsString());
            if (geomSame) {
                identical++;
                continue;
            }
            geometryDiffering++;
            DiffSummary ds = gridDiff(v, a, palette);
            if (ds.differingCells > 0) gridDiffering++;
            if (!layoutSame || ds.structuralCells > 0) {
                structuralDiff++;
            } else if (ds.differingCells > 0) {
                materialOnlyDiff++;
            }
            if (examples.size() < 4) {
                JsonObject ex = new JsonObject();
                ex.addProperty("idleKey", e.getKey());
                ex.addProperty("activeKey", activeKey);
                ex.addProperty("differingCells", ds.differingCells);
                ex.addProperty("sameStateDifferentGeometryCells", ds.materialCells);
                ex.addProperty("structuralCells", ds.structuralCells);
                ex.addProperty("layoutDiffers", !layoutSame);
                ex.addProperty("materialLayerOnly", layoutSame && ds.structuralCells == 0);
                ex.addProperty("sample", ds.sample);
                examples.add(ex);
            }
        }
        o.addProperty("variantsCompared", compared);
        o.addProperty("geometryIdenticalPairs", identical);
        o.addProperty("geometryDifferingPairs", geometryDiffering);
        o.addProperty("cellGridDifferingPairs", gridDiffering);
        o.addProperty("structuralDiffPairs", structuralDiff);
        o.addProperty("materialLayerOnlyPairs", materialOnlyDiff);
        JsonObject mh = new JsonObject();
        for (Map.Entry<String, Integer> e : mechanismHistogram.entrySet()) {
            mh.addProperty(e.getKey(), e.getValue());
        }
        o.add("activeMechanismHistogram", mh);
        o.add("examples", examples);
        o.addProperty(
            "materialSwapOnly",
            geometryDiffering > 0 && structuralDiff == 0 && materialOnlyDiff == geometryDiffering);
        return o;
    }

    static final class DiffSummary {

        int differingCells;
        /** 两态下标不同、但两个条目 registryId+meta 相同（= 只换了材质/纹理层）。 */
        int materialCells;
        /** 两态下标不同且条目 registryId/meta 也不同（= 结构性差异，超出 T0.3 的裁决范围，必须如实记录）。 */
        int structuralCells;
        String sample = "";
    }

    private static DiffSummary gridDiff(JsonObject idle, JsonObject active, GeometryPalette palette) {
        DiffSummary d = new DiffSummary();
        JsonArray gi = idle.getAsJsonObject("grid")
            .getAsJsonArray("cellGrid");
        JsonArray ga = active.getAsJsonObject("grid")
            .getAsJsonArray("cellGrid");
        if (gi.size() != ga.size()) {
            d.sample = "grid 尺寸不同（结构性差异）";
            d.structuralCells = -1;
            return d;
        }
        StringBuilder sb = new StringBuilder();
        for (int z = 0; z < gi.size(); z++) {
            JsonArray ri = gi.get(z)
                .getAsJsonArray();
            JsonArray ra = ga.get(z)
                .getAsJsonArray();
            for (int row = 0; row < ri.size(); row++) {
                JsonArray ci = ri.get(row)
                    .getAsJsonArray();
                JsonArray ca = ra.get(row)
                    .getAsJsonArray();
                for (int x = 0; x < ci.size(); x++) {
                    int vi = ci.get(x)
                        .getAsInt();
                    int va = ca.get(x)
                        .getAsInt();
                    if (vi == va) continue;
                    d.differingCells++;
                    GeometryPalette.Entry ei = palette.entries()
                        .get(vi);
                    GeometryPalette.Entry ea = palette.entries()
                        .get(va);
                    boolean sameState = ei != null && ea != null
                        && ei.registryId.equals(ea.registryId)
                        && ei.meta == ea.meta;
                    if (sameState) d.materialCells++;
                    else d.structuralCells++;
                    if (sb.length() < 400) {
                        sb.append("z")
                            .append(z)
                            .append("/row")
                            .append(row)
                            .append("/x")
                            .append(x)
                            .append(": #")
                            .append(vi)
                            .append("(")
                            .append(ei == null ? "?" : ei.registryId + ":" + ei.meta)
                            .append(")")
                            .append(sameState ? "[材质层]" : "[结构层]")
                            .append("→#")
                            .append(va)
                            .append("(")
                            .append(ea == null ? "?" : ea.registryId + ":" + ea.meta)
                            .append("); ");
                    }
                }
            }
        }
        d.sample = sb.toString();
        return d;
    }

    // ------------------------------------------------------------------ 工具

    static final class ExpectedState {

        int itemId = -1;
        int meta = -1;
        boolean resolvable;
        String issue = "";
        String raw = "";

        static ExpectedState parse(String blocksKey) {
            ExpectedState s = new ExpectedState();
            s.raw = blocksKey;
            if (blocksKey == null || blocksKey.isEmpty()) {
                s.issue = "空 blocksKey";
                return s;
            }
            String t = blocksKey.trim();
            if (t.startsWith("[")) t = t.substring(1);
            if (t.endsWith("]")) t = t.substring(0, t.length() - 1);
            String[] parts = t.split(",");
            if (parts.length != 1) {
                s.issue = "参照方块集合有 " + parts.length + " 项，非唯一（无法做单值断言）";
                return s;
            }
            String p = parts[0].trim();
            int x = p.indexOf('x');
            if (x > 0) p = p.substring(0, x);
            String[] idm = p.split(":");
            if (idm.length != 2) {
                s.issue = "blocksKey 形态不可解析: " + blocksKey;
                return s;
            }
            try {
                s.itemId = Integer.parseInt(idm[0].trim());
                s.meta = Integer.parseInt(idm[1].trim());
                s.resolvable = true;
            } catch (NumberFormatException e) {
                s.issue = "blocksKey 数字解析失败: " + blocksKey;
            }
            return s;
        }
    }

    private static ExpectedState expectedStateOf(VariantMachineFacts.ChannelFact c, int value) {
        VariantMachineFacts.ObservedValue ov = c.observedAt(value);
        if (ov == null) {
            ExpectedState s = new ExpectedState();
            s.issue = "T1.2 未记录该取值（value=" + value + "）";
            return s;
        }
        return ExpectedState.parse(ov.blocksKey);
    }

    /** 世界快照：坐标 → 「方块注册名:meta」。 */
    private static Map<String, String> worldStateMap(ProbeDummyWorld world) {
        Map<String, String> out = new TreeMap<String, String>();
        for (int[] p : world.placedPositions()) {
            net.minecraft.block.Block b = world.getBlock(p[0], p[1], p[2]);
            if (b == null || b == net.minecraft.init.Blocks.air) continue;
            out.put(
                p[0] + "," + p[1] + "," + p[2],
                VariantGeometryBakery.registryIdOf(b) + ":" + world.getBlockMetadata(p[0], p[1], p[2]));
        }
        return out;
    }

    /** 差分校验：某通道 = k 的变体与基线（该通道 = 1）逐格比对，差异位置必须恰好是 T1.2 预期的那个方块状态。 */
    private static JsonObject diffCheck(String id, Map<String, String> baseline, Map<String, String> current,
        ExpectedState expected, VariantMachineFacts.ChannelFact channel) {
        TreeSet<String> positions = new TreeSet<String>();
        positions.addAll(baseline.keySet());
        positions.addAll(current.keySet());
        int diffPositions = 0;
        int matched = 0;
        int mismatched = 0;
        List<String> details = new ArrayList<String>();
        for (String pos : positions) {
            String b = baseline.get(pos);
            String c = current.get(pos);
            if (b != null && b.equals(c)) continue;
            diffPositions++;
            if (!expected.resolvable) {
                mismatched++;
                if (details.size() < 4) details.add(pos + " 预期不可解析: " + expected.issue);
                continue;
            }
            String actual = c == null ? "air" : c;
            boolean ok = stateMatches(actual, expected);
            if (ok) {
                matched++;
            } else {
                mismatched++;
                if (details.size() < 4) {
                    details.add(
                        pos + " 实测 "
                            + actual
                            + " ≠ 预期 itemId="
                            + expected.itemId
                            + ":meta="
                            + expected.meta
                            + "（"
                            + expected.raw
                            + "）");
                }
            }
        }
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("channel", channel.key());
        o.addProperty("expectedBlocksKey", expected.raw);
        o.addProperty("diffPositions", diffPositions);
        o.addProperty("matched", matched);
        o.addProperty("mismatched", mismatched);
        o.addProperty("status", diffPositions == 0 ? "fail" : (mismatched == 0 ? "pass" : "fail"));
        o.addProperty(
            "detail",
            diffPositions == 0 ? "该取值与基线无任何差异（通道注入未生效）"
                : ("差异位置 " + diffPositions
                    + "，匹配 "
                    + matched
                    + "，不匹配 "
                    + mismatched
                    + (details.isEmpty() ? "" : "；" + details)));
        return o;
    }

    /** 实测方块状态（registryId:meta 串）是否等于 T1.2 预期的「物品 id : damage」。 */
    private static boolean stateMatches(String actualState, ExpectedState expected) {
        int lastColon = actualState.lastIndexOf(':');
        if (lastColon <= 0) return false;
        String registryId = actualState.substring(0, lastColon);
        int meta;
        try {
            meta = Integer.parseInt(actualState.substring(lastColon + 1));
        } catch (NumberFormatException e) {
            return false;
        }
        Block b = Block.getBlockFromName(registryId);
        if (b == null) return false;
        // 1.7.10：GameRegistry.registerBlock 会把 ItemBlock 注册进**同一个 id 空间**（方块 id 即物品 id），
        // 因此 T1.2 的「物品 id : damage」与这里的「方块 id : meta」可直接互校。
        if (Block.getIdFromBlock(b) == expected.itemId && meta == expected.meta) return true;
        Item item = Item.getItemFromBlock(b);
        return item != null && Item.getIdFromItem(item) == expected.itemId && meta == expected.meta;
    }

    private static boolean isSingleReplaceBaseline(List<VariantMachineFacts.ChannelFact> channels, int[] combo) {
        int ones = 0;
        for (int i = 0; i < combo.length; i++) {
            if (!"replace".equals(channels.get(i).kind)) return false;
            if (combo[i] == 1) ones++;
            else if (combo[i] != 0) return false;
        }
        return ones == 1;
    }

    /**
     * 「恰好一个替换型通道取 k ≥ minK、其余取 0」→ 返回该通道下标；否则 −1。
     * 用于把「通道取值 → 真实放置的方块」逐取值核对（A1）。
     */
    private static int singleReplaceChannelIndexAtLeast(List<VariantMachineFacts.ChannelFact> channels, int[] combo,
        int minK) {
        int idx = -1;
        for (int i = 0; i < combo.length; i++) {
            if (combo[i] >= minK) {
                if (idx >= 0) return -1;
                idx = i;
            } else if (combo[i] != 0) {
                return -1;
            }
        }
        if (idx < 0) return -1;
        return "replace".equals(channels.get(idx).kind) ? idx : -1;
    }

    private static int channelIndex(List<VariantMachineFacts.ChannelFact> channels, VariantMachineFacts.ChannelFact c) {
        for (int i = 0; i < channels.size(); i++) {
            if (channels.get(i) == c) return i;
        }
        return -1;
    }

    /** 枚举取值组合：每个通道 0..max，odometer 进位（最后一维最快），顺序确定。 */
    private static List<int[]> enumerateCombos(List<VariantMachineFacts.ChannelFact> channels) {
        List<int[]> out = new ArrayList<int[]>();
        if (channels.isEmpty()) {
            out.add(new int[0]);
            return out;
        }
        int[] cur = new int[channels.size()];
        while (true) {
            out.add(cur.clone());
            int i = channels.size() - 1;
            while (i >= 0) {
                cur[i]++;
                if (cur[i] <= channels.get(i).max) break;
                cur[i] = 0;
                i--;
            }
            if (i < 0) break;
        }
        return out;
    }

    private static List<Integer> sampleEvenly(int lo, int hi, int count) {
        List<Integer> out = new ArrayList<Integer>();
        if (count <= 0) return out;
        if (count >= hi - lo + 1) {
            for (int i = lo; i <= hi; i++) {
                out.add(Integer.valueOf(i));
            }
            return out;
        }
        if (count == 1) {
            out.add(Integer.valueOf(hi));
            return out;
        }
        TreeSet<Integer> set = new TreeSet<Integer>();
        for (int i = 0; i < count; i++) {
            int v = lo + (int) Math.round((double) (hi - lo) * i / (double) (count - 1));
            set.add(Integer.valueOf(v));
        }
        out.addAll(set);
        return out;
    }

    private static String variantKey(List<VariantMachineFacts.ChannelFact> channels, int[] combo, int tier,
        String stateId) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < channels.size(); i++) {
            if (i > 0) sb.append('|');
            sb.append(
                channels.get(i)
                    .key())
                .append(':')
                .append(combo[i]);
        }
        if (channels.size() > 0) sb.append('|');
        sb.append("tt:")
            .append(tier)
            .append("|runstate:")
            .append(stateId);
        return sb.toString();
    }

    private static JsonObject variantSignaturesJson(JsonArray variants) {
        JsonObject o = new JsonObject();
        for (JsonElement e : variants) {
            JsonObject v = e.getAsJsonObject();
            o.addProperty(
                v.get("key")
                    .getAsString(),
                v.get("layoutSignature")
                    .getAsString() + "|"
                    + v.get("geometrySignature")
                        .getAsString());
        }
        return o;
    }

    private static int paletteRefsUsed(JsonArray variants) {
        TreeSet<Integer> set = new TreeSet<Integer>();
        for (JsonElement e : variants) {
            for (JsonElement r : e.getAsJsonObject()
                .getAsJsonArray("paletteRefs")) {
                set.add(Integer.valueOf(r.getAsInt()));
            }
        }
        return set.size();
    }

    private static List<String> channelKeys(List<VariantMachineFacts.ChannelFact> channels) {
        List<String> out = new ArrayList<String>();
        for (VariantMachineFacts.ChannelFact c : channels) {
            out.add(c.key());
        }
        return out;
    }

    private static String aggregateStatus(JsonArray checks) {
        int fail = 0;
        int pass = 0;
        for (JsonElement e : checks) {
            String s = e.getAsJsonObject()
                .get("status")
                .getAsString();
            if ("fail".equals(s)) fail++;
            if ("pass".equals(s)) pass++;
        }
        if (fail > 0) return "fail";
        return pass > 0 ? "pass" : "skipped";
    }

    private static JsonObject assertion(String id, String status, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("status", status);
        o.addProperty("detail", detail);
        return o;
    }

    private static JsonObject checkResult(String id, String status, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("status", status);
        o.addProperty("detail", detail);
        return o;
    }

    private static JsonObject failure(String machine, String stage, String kind, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("machine", machine);
        o.addProperty("stage", stage);
        o.addProperty("kind", kind);
        o.addProperty("message", message);
        return o;
    }

    static final class PlanCache implements MultiblockWorldBuilder.HatchPlanCache {

        final Map<String, MultiblockWorldBuilder.HatchPlan> byKey = new LinkedHashMap<String, MultiblockWorldBuilder.HatchPlan>();
        int hits;
        int stores;

        @Override
        public MultiblockWorldBuilder.HatchPlan lookup(String shapeKey) {
            MultiblockWorldBuilder.HatchPlan p = byKey.get(shapeKey);
            if (p != null) hits++;
            return p;
        }

        @Override
        public void store(MultiblockWorldBuilder.HatchPlan plan) {
            byKey.put(plan.shapeKey, plan);
            stores++;
        }
    }

    // ------------------------------------------------------------------ 落盘

    private static JsonObject buildPaletteJson(GeometryPalette palette) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.multiblock.variant-capture.palette/1");
        o.addProperty("encoding", GeometryPalette.GEOMETRY_ENCODING);
        o.addProperty("semantics", "所有变体捕获结果的并集，按内容签名全局去重；下标 0 恒为 air；同一方块状态的烘焙几何全数据集只存一份");
        o.add("stats", palette.statsJson());
        o.add("blockPalette", palette.blockPaletteJson());
        o.add("materialPalette", palette.materialPaletteJson());
        o.add("textureBlobs", palette.textureBlobsJson());
        o.add("tooltipPalette", new JsonArray());
        o.addProperty("paletteContentSha256", paletteContentSha256(palette));
        return o;
    }

    private static String paletteContentSha256(GeometryPalette palette) {
        List<String> sigs = new ArrayList<String>();
        for (GeometryPalette.Entry e : palette.entries()) {
            sigs.add(e.index + "|" + e.signature);
        }
        return sha256Hex(String.join("\n", sigs));
    }

    private static JsonObject datasetFieldDesign() {
        JsonObject o = new JsonObject();
        o.addProperty("purpose", "T1.4 因子化编码（骨架 sizeSteps + 共享差异规则表 + 变体/帧清单 + 并集调色板）的输入数据集");
        o.addProperty("perMachineFile", "machines/<slug>.json");
        o.addProperty("globalPaletteFile", "palette.json");
        o.addProperty(
            "variants[].key",
            "契约 §5.1 的变体主键：<通道key>:<声明值>（按 channels 顺序 | 连接）|tt:<总Tier>|runstate:<id>；声明值 0 = 未设置");
        o.addProperty("variants[].values", "每通道的声明值（0 = 未设置），T1.4 直接照抄进契约的 variant.values");
        o.addProperty("variants[].effective", "装配第 0 步（契约 §5.2）解析出的有效值：raw>0 取 raw，否则回落总 Tier，再按域夹取");
        o.addProperty(
            "variants[].grid",
            "{origin:[dx,dy,dz], size:[w,h,d], cellGrid:[z][row][x]}；row 0 = 顶部；值为全局 blockPalette 下标；0 = 空气");
        o.addProperty(
            "variants[].layoutSignature",
            "坐标+方块+meta 的内容签名（ProbeDummyWorld#stateSignature 同口径）：证明「构建结果与预期变体一致」");
        o.addProperty(
            "variants[].geometrySignature",
            "四边形内容签名（材质定位串 + 4 位小数顶点 + 排序 + SHA-256，T0.3 StateGeometryCapture 同口径）：跨运行可重复性判据");
        o.addProperty("variants[].paletteRefs", "该变体用到的全局调色板下标（升序去重），等价于 cellGrid 的值集合");
        o.addProperty("variants[].build", "构建事实：构造格数、舱口计划来源、形状键、MTE 实例序号（是否复用）");
        o.addProperty(
            "variants[].runState",
            "运行态事实：activeRequested/activeObserved/assertionPassed/mechanism/errorDisplayId");
        o.addProperty(
            "palette.json.blockPalette[]",
            "与既有产物同形的调色板条目（registryId/meta/renderMode/geometry{bakedQuadsJsonV1}/occludesAdjacentFaces/nbt/tooltip）；"
                + "T1.4 直接把它作为契约 inner 的根级 blockPalette");
        o.addProperty(
            "palette.json.materialPalette[]/textureBlobs[]",
            "复用 TextureBlobEmbedder 的产物；materialIndex 全数据集稳定");
        o.addProperty("machineAssertions[]", "A1 替换型通道取值保真 / A2 未设置回落总 Tier / A3 尺寸规则 / A4 实例新鲜度");
        return o;
    }

    private static JsonObject configJson(Config cfg) {
        JsonObject o = new JsonObject();
        o.addProperty("exit", cfg.exit);
        o.addProperty("cleanupTrigger", cfg.cleanupTrigger);
        o.addProperty("maxVariantsPerMachine", cfg.maxVariantsPerMachine);
        o.addProperty("limitPerMachine", cfg.limitPerMachine);
        o.addProperty("includeThumbnails", cfg.includeThumbnails);
        o.addProperty("embedTextures", cfg.embedTextures);
        o.addProperty("globalBudgetMs", cfg.globalBudgetMs);
        o.add("machines", ScanJson.strings(cfg.machines));
        return o;
    }

    private static JsonObject environmentJson(File factsFile) {
        JsonObject o = new JsonObject();
        o.addProperty("minecraftVersion", "1.7.10");
        for (String modid : new String[] { "gregtech", "structurelib", "lightning" }) {
            try {
                cpw.mods.fml.common.ModContainer mc = cpw.mods.fml.common.Loader.instance()
                    .getIndexedModList()
                    .get(modid);
                o.addProperty("mod." + modid, mc == null ? "<absent>" : mc.getVersion());
            } catch (Throwable t) {
                o.addProperty("mod." + modid, "<error>");
            }
        }
        o.addProperty("factsFile", factsFile == null ? "" : factsFile.getAbsolutePath());
        o.addProperty("worldMode", "none（主菜单态 + 自带假世界；理由见 probe-run-state.md §4.4）");
        o.addProperty(
            "stateDriving",
            "T0.3 §4.2：真实 TE 更新路径 3 tick + MTEMultiBlockBase#onPostTick 循环 + 进态三行 + isActive() 断言；"
                + "逃生门 IGregTileEntity#setActive(boolean) 仅在断言失败且允许时使用并标注 activeMechanism");
        return o;
    }

    private static JsonObject manifestJson(int runIndex, File runDir, long started, Config cfg, File factsFile) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SCHEMA);
        o.addProperty("runIndex", runIndex);
        o.addProperty("runDir", runDir.getAbsolutePath());
        o.addProperty("startedAtEpochMs", started);
        o.addProperty("api", "VariantCaptureRunner.run(Minecraft)");
        o.add("config", configJson(cfg));
        o.addProperty("factsFile", factsFile == null ? "" : factsFile.getAbsolutePath());
        return o;
    }

    private static File resolveFactsFile(Minecraft mc, Config cfg) {
        if (cfg.factsPath != null && !cfg.factsPath.trim()
            .isEmpty()) {
            File f = new File(cfg.factsPath);
            return f.isFile() ? f : null;
        }
        return VariantMachineFacts.findLatestFacts(mc.mcDataDir);
    }

    private static List<Target> resolveTargets(Config cfg) {
        List<Target> out = new ArrayList<Target>();
        if (cfg.machines.isEmpty()) {
            for (Target t : DEFAULT_TARGETS) {
                out.add(t);
            }
            return out;
        }
        for (String want : cfg.machines) {
            Target found = null;
            for (Target t : DEFAULT_TARGETS) {
                if (t.label.equals(want) || t.fqcn.equals(want)) {
                    found = t;
                    break;
                }
            }
            if (found == null) {
                found = new Target(
                    want,
                    simpleNameOf(want),
                    ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH,
                    true,
                    "用户指定");
            }
            out.add(found);
        }
        return out;
    }

    private static String simpleNameOf(String fqcnOrSimple) {
        int idx = fqcnOrSimple.lastIndexOf('.');
        return idx < 0 ? fqcnOrSimple : fqcnOrSimple.substring(idx + 1);
    }

    static String slug(String label) {
        return label.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-|-$", "");
    }

    private static int previousRunIndex(File dir) {
        int best = 0;
        File[] children = dir.listFiles();
        if (children == null) return 0;
        for (File c : children) {
            if (!c.isDirectory()) continue;
            String n = c.getName();
            if (!n.startsWith("run-")) continue;
            try {
                best = Math.max(best, Integer.parseInt(n.substring(4)));
            } catch (NumberFormatException ignored) {
                // 非 run-NNNN
            }
        }
        return best;
    }

    private static JsonObject compareWithPrevious(File dir, int previousRunIndex, File runDir,
        List<JsonObject> machineSummaries, JsonObject paletteJson) {
        JsonObject o = new JsonObject();
        o.addProperty("previousRunIndex", previousRunIndex);
        if (previousRunIndex <= 0) {
            o.addProperty("allMatch", false);
            o.addProperty("reason", "没有上一次运行可比（本次是 run-0001）");
            return o;
        }
        File prevDir = new File(dir, String.format("run-%04d", previousRunIndex));
        File prevMachines = new File(prevDir, "machines");
        File curMachines = new File(runDir, "machines");
        int comparedMachines = 0;
        int matchedMachines = 0;
        int comparedVariants = 0;
        int mismatchedVariants = 0;
        JsonArray perMachine = new JsonArray();
        for (JsonObject summary : machineSummaries) {
            String name = summary.get("simpleName")
                .getAsString();
            String slug = slug(name);
            File cur = new File(curMachines, slug + ".json");
            File prev = new File(prevMachines, slug + ".json");
            JsonObject row = new JsonObject();
            row.addProperty("simpleName", name);
            if (!prev.isFile() || !cur.isFile()) {
                row.addProperty("status", "no-previous-file");
                perMachine.add(row);
                continue;
            }
            comparedMachines++;
            try {
                Map<String, String> curSigs = readVariantSignatures(cur);
                Map<String, String> prevSigs = readVariantSignatures(prev);
                int mismatch = 0;
                for (Map.Entry<String, String> e : curSigs.entrySet()) {
                    String other = prevSigs.get(e.getKey());
                    if (other == null || !other.equals(e.getValue())) mismatch++;
                }
                comparedVariants += curSigs.size();
                mismatchedVariants += mismatch;
                row.addProperty("variants", curSigs.size());
                row.addProperty("mismatched", mismatch);
                row.addProperty("previousVariants", prevSigs.size());
                row.addProperty("allMatch", mismatch == 0 && curSigs.size() == prevSigs.size());
                row.addProperty("currentFileSha256", sha256Hex(readText(cur)));
                row.addProperty("previousFileSha256", sha256Hex(readText(prev)));
                if (mismatch == 0 && curSigs.size() == prevSigs.size()) matchedMachines++;
            } catch (Throwable e) {
                row.addProperty("status", "compare-error: " + describe(e));
            }
            perMachine.add(row);
        }
        // 调色板内容签名比对
        boolean paletteMatch = false;
        String prevPaletteSha = "";
        String curPaletteSha = paletteJson.get("paletteContentSha256")
            .getAsString();
        File prevPalette = new File(prevDir, "palette.json");
        if (prevPalette.isFile()) {
            try {
                JsonObject p = new JsonParser().parse(readText(prevPalette))
                    .getAsJsonObject();
                if (p.has("paletteContentSha256")) {
                    prevPaletteSha = p.get("paletteContentSha256")
                        .getAsString();
                    paletteMatch = prevPaletteSha.equals(curPaletteSha);
                }
            } catch (Throwable ignored) {
                // 上一次调色板不可解析 → paletteMatch 保持 false
            }
        }
        JsonObject paletteCmp = new JsonObject();
        paletteCmp.addProperty("currentSha256", curPaletteSha);
        paletteCmp.addProperty("previousSha256", prevPaletteSha);
        paletteCmp.addProperty("allMatch", paletteMatch);
        o.add("palette", paletteCmp);
        o.addProperty("comparedMachines", comparedMachines);
        o.addProperty("matchedMachines", matchedMachines);
        o.addProperty("comparedVariants", comparedVariants);
        o.addProperty("mismatchedVariants", mismatchedVariants);
        o.add("perMachine", perMachine);
        o.addProperty(
            "allMatch",
            comparedMachines > 0 && matchedMachines == comparedMachines && mismatchedVariants == 0 && paletteMatch);
        return o;
    }

    private static Map<String, String> readVariantSignatures(File machineJson) throws Exception {
        Map<String, String> out = new LinkedHashMap<String, String>();
        JsonObject root = new JsonParser().parse(readText(machineJson))
            .getAsJsonObject();
        if (root.has("variantSignatures")) {
            for (Map.Entry<String, JsonElement> e : root.getAsJsonObject("variantSignatures")
                .entrySet()) {
                out.put(
                    e.getKey(),
                    e.getValue()
                        .getAsString());
            }
            return out;
        }
        for (JsonElement e : root.getAsJsonArray("variants")) {
            JsonObject v = e.getAsJsonObject();
            out.put(
                v.get("key")
                    .getAsString(),
                v.get("layoutSignature")
                    .getAsString() + "|"
                    + v.get("geometrySignature")
                        .getAsString());
        }
        return out;
    }

    static String readText(File file) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
        }
        return sb.toString();
    }

    static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "sha256-error";
        }
    }

    static String describe(Throwable t) {
        String msg = t.getMessage();
        return t.getClass()
            .getName() + (msg == null ? "" : ": " + msg);
    }
}
