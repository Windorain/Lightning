package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.gtnewhorizon.structurelib.alignment.constructable.IConstructable;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.GregTechAPI;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;

/**
 * T1.2 多方块枚举 + 通道/等级探测的无人值守编排与落盘。
 * <p>
 * 输出布局（{@code <mcDataDir>/multiblock_scan/}）：
 * 
 * <pre>
 * multiblock_scan/
 *   run-0001/
 *     manifest.json      本次运行的身份与预算（含耗时，不参与跨运行比对）
 *     environment.json   运行环境事实（mod 装载版本、通道注册表条目数、反射内核状态）
 *     registry.json      权威通道注册表快照（StructureLib ChannelDescription.getAll()）
 *     enumeration.json   每台多方块的枚举行（类名/显示名/本地化名/结构片段数/元素类名清单）
 *     machines.json      每台多方块的通道清单 + 总 Tier 域（硬事实层，跨运行逐字节一致）
 *     summary.json       统计 + 失败清单 + 不变量 + machines.json 的内容哈希
 *   latest.json         最近一次运行的 summary 副本
 * </pre>
 * 
 * <b>为什么 machines.json 必须逐字节可复现</b>：它是 T1.3/T1.4 的输入事实层，也是「同环境两次运行结果一致」这条
 * 自检的机器判据 —— {@code summary.json.machinesJsonSha256} 就是它的内容哈希。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockScanRunner {

    public static final String OUTPUT_DIR = "multiblock_scan";
    public static final String TRIGGER_FILE = "sde_multiblock_scan.json";

    /** 逐台机器的探测预算上限（毫秒）；超时只影响该台，记为失败，不静默跳过。 */
    public static final long DEFAULT_PER_MACHINE_BUDGET_MS = 30_000L;
    /** 整轮扫描预算上限（毫秒）；达到后停止扫描并落盘「已扫描 N / 共 M」。 */
    public static final long DEFAULT_GLOBAL_BUDGET_MS = 15 * 60_000L;

    private MultiblockScanRunner() {}

    public static File outputDir(Minecraft mc) {
        return new File(mc.mcDataDir, OUTPUT_DIR);
    }

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, TRIGGER_FILE);
    }

    // ------------------------------------------------------------------ config

    public static final class Config {

        public boolean exit = true;
        public boolean cleanupTrigger = true;
        public int limit = -1;
        public boolean channels = true;
        public boolean tiers = true;
        public long perMachineBudgetMs = DEFAULT_PER_MACHINE_BUDGET_MS;
        public long globalBudgetMs = DEFAULT_GLOBAL_BUDGET_MS;
        public List<String> onlyClasses = new ArrayList<String>();
    }

    public static Config readConfig(Minecraft mc) {
        Config c = new Config();
        File f = triggerFile(mc);
        if (!f.isFile()) return c;
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8)) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[2048];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            String text = sb.toString()
                .trim();
            if (text.isEmpty()) return c;
            JsonObject o = new JsonParser().parse(text)
                .getAsJsonObject();
            if (o.has("exit")) c.exit = o.get("exit")
                .getAsBoolean();
            if (o.has("cleanupTrigger")) c.cleanupTrigger = o.get("cleanupTrigger")
                .getAsBoolean();
            if (o.has("limit")) c.limit = o.get("limit")
                .getAsInt();
            if (o.has("channels")) c.channels = o.get("channels")
                .getAsBoolean();
            if (o.has("tiers")) c.tiers = o.get("tiers")
                .getAsBoolean();
            if (o.has("perMachineBudgetMs")) c.perMachineBudgetMs = o.get("perMachineBudgetMs")
                .getAsLong();
            if (o.has("globalBudgetMs")) c.globalBudgetMs = o.get("globalBudgetMs")
                .getAsLong();
            if (o.has("onlyClasses") && o.get("onlyClasses")
                .isJsonArray()) {
                for (com.google.gson.JsonElement e : o.getAsJsonArray("onlyClasses")) {
                    c.onlyClasses.add(e.getAsString());
                }
            }
        } catch (Throwable t) {
            FMLLog.warning("[SDE][T1.2] 触发文件解析失败，使用默认配置: %s", t.toString());
        }
        return c;
    }

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
        if (!runDir.isDirectory() && !runDir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + runDir.getAbsolutePath());
        }

        List<MultiblockChannelProbe.Failure> failures = new ArrayList<MultiblockChannelProbe.Failure>();
        List<MultiblockChannelProbe.MachineProbe> machines = MultiblockChannelProbe.enumerate();

        // onlyClasses / limit：供 Phase 3 用小子集快速迭代
        if (!cfg.onlyClasses.isEmpty()) {
            List<MultiblockChannelProbe.MachineProbe> filtered = new ArrayList<MultiblockChannelProbe.MachineProbe>();
            for (MultiblockChannelProbe.MachineProbe m : machines) {
                if (cfg.onlyClasses.contains(m.fqcn) || cfg.onlyClasses.contains(m.simpleName)) filtered.add(m);
            }
            machines = filtered;
        }
        int enumeratedTotal = machines.size();
        if (cfg.limit > 0 && machines.size() > cfg.limit) {
            machines = new ArrayList<MultiblockChannelProbe.MachineProbe>(machines.subList(0, cfg.limit));
        }

        // 通道注册表快照必须在探测之前取（探测本身不改注册表，但快照是权威数据源，先固化）
        Map<String, com.gtnewhorizon.structurelib.ChannelDescription> registry = MultiblockChannelProbe
            .channelRegistry();

        for (MultiblockChannelProbe.MachineProbe m : machines) {
            if (System.currentTimeMillis() - started > cfg.globalBudgetMs) {
                m.notes.add("整轮扫描预算耗尽，本台未探测");
                MultiblockChannelProbe.Failure f = new MultiblockChannelProbe.Failure();
                f.fqcn = m.fqcn;
                f.stage = "budget";
                f.exception = "BudgetExceeded";
                f.message = "整轮扫描预算 " + cfg.globalBudgetMs + " ms 耗尽，本台未探测";
                failures.add(f);
                continue;
            }
            probeOne(m, cfg, failures);
        }

        // 落盘
        writeRegistry(new File(runDir, "registry.json"), registry);
        writeEnumeration(new File(runDir, "enumeration.json"), machines, enumeratedTotal);
        String machinesJson = buildMachinesJson(machines);
        writeText(new File(runDir, "machines.json"), machinesJson);
        String machinesHash = sha256Hex(machinesJson.getBytes(StandardCharsets.UTF_8));

        JsonObject summary = buildSummary(
            runIndex,
            machines,
            registry,
            machinesHash,
            failures,
            enumeratedTotal,
            cfg,
            System.currentTimeMillis() - started,
            previousRunIndex,
            dir,
            MultiblockChannelProbe.countBaseTileProvidesConstructable());
        writeJson(new File(runDir, "summary.json"), summary);
        writeJson(new File(dir, "latest.json"), summary);
        writeEnvironment(new File(runDir, "environment.json"), registry, cfg);
        writeManifest(new File(runDir, "manifest.json"), runIndex, runDir, started, cfg, machines.size());

        FMLLog.info(
            "[SDE][T1.2] run-%04d 完成：枚举 %d / 探测 %d 台，失败 %d，%d ms，machines=%s，输出目录 %s",
            Integer.valueOf(runIndex),
            Integer.valueOf(enumeratedTotal),
            Integer.valueOf(machines.size()),
            Integer.valueOf(failures.size()),
            Long.valueOf(System.currentTimeMillis() - started),
            machinesHash,
            runDir.getAbsolutePath());
        return summary;
    }

    // ------------------------------------------------------------------ 逐台探测

    private static void probeOne(MultiblockChannelProbe.MachineProbe m, Config cfg,
        List<MultiblockChannelProbe.Failure> failures) {
        long machineStarted = System.currentTimeMillis();
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        IMetaTileEntity mte = m.mteId >= 0 && all != null && m.mteId < all.length ? all[m.mteId] : null;
        if (!(mte instanceof IConstructable)) {
            MultiblockChannelProbe.Failure f = new MultiblockChannelProbe.Failure();
            f.fqcn = m.fqcn;
            f.stage = "resolve";
            f.exception = "NotConstructable";
            f.message = "METATILEENTITIES[" + m.mteId + "] 不是 IConstructable";
            failures.add(f);
            return;
        }
        IConstructable multi = (IConstructable) mte;

        // 每台机器一份独立假世界：既是通道探测的坐标上下文，也是总 Tier 试探的真实建造场
        ProbeDummyWorld world = new ProbeDummyWorld();
        m.probeWorld = world;
        m.probeContext = multi;

        try {
            if (cfg.channels) {
                long before = System.currentTimeMillis();
                try {
                    MultiblockChannelProbe.probeChannels(m, multi);
                } catch (Throwable t) {
                    failures.add(MultiblockChannelProbe.failureOf(t, m.fqcn, "channels"));
                }
                if (System.currentTimeMillis() - before > cfg.perMachineBudgetMs) {
                    m.notes.add("通道探测超出单台预算 " + cfg.perMachineBudgetMs + " ms");
                }
            } else {
                m.notes.add("配置 channels=false，跳过通道探测");
            }
            if (cfg.tiers) {
                if (System.currentTimeMillis() - machineStarted > cfg.perMachineBudgetMs) {
                    MultiblockChannelProbe.Failure f = new MultiblockChannelProbe.Failure();
                    f.fqcn = m.fqcn;
                    f.stage = "tiers";
                    f.exception = "PerMachineBudgetExceeded";
                    f.message = "单台预算 " + cfg.perMachineBudgetMs + " ms 在通道探测后已耗尽，总 Tier 未探测";
                    failures.add(f);
                } else {
                    try {
                        MultiblockTierEstimator.estimate(m, multi, world);
                    } catch (Throwable t) {
                        failures.add(MultiblockChannelProbe.failureOf(t, m.fqcn, "tiers"));
                    }
                }
            } else {
                m.notes.add("配置 tiers=false，跳过总 Tier 探测");
            }
        } finally {
            m.probeWorld = null;
        }
    }

    // ------------------------------------------------------------------ 落盘

    private static void writeRegistry(File file, Map<String, com.gtnewhorizon.structurelib.ChannelDescription> registry)
        throws Exception {
        JsonObject root = new JsonObject();
        root.addProperty("source", "StructureLib ChannelDescription.getAll()/getItems()");
        root.addProperty("channelCount", registry.size());
        JsonObject channels = new JsonObject();
        for (Map.Entry<String, com.gtnewhorizon.structurelib.ChannelDescription> e : registry.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", MultiblockChannelProbe.kindOfById(e.getKey()));
            o.add("enumNames", ScanJson.strings(MultiblockChannelProbe.enumNamesForId(e.getKey())));
            o.addProperty(
                "enumNameCount",
                MultiblockChannelProbe.enumNamesForId(e.getKey())
                    .size());
            o.add(
                "descriptions",
                stringMapToJson(
                    e.getValue()
                        .getDescriptions()));
            Map<net.minecraft.item.ItemStack, Integer> items = e.getValue()
                .getItems();
            o.addProperty("itemCount", items.size());
            // 全部键做序化：ItemStack.toString() 不是稳定序，故按「值 + 名称」排序后再输出
            List<String> entries = new ArrayList<String>();
            int maxValue = 0;
            for (Map.Entry<net.minecraft.item.ItemStack, Integer> ie : items.entrySet()) {
                int v = ie.getValue() == null ? 0
                    : ie.getValue()
                        .intValue();
                if (v > maxValue) maxValue = v;
                net.minecraft.item.ItemStack s = ie.getKey();
                String name = "<null>";
                try {
                    name = s == null ? "<null>"
                        : net.minecraft.item.Item.getIdFromItem(s.getItem()) + ":"
                            + s.getItemDamage()
                            + " "
                            + String.valueOf(s.getDisplayName());
                } catch (Throwable ignored) {
                    // 名称解析失败不影响值域事实
                }
                entries.add(String.valueOf(v) + "|" + name);
            }
            Collections.sort(entries);
            o.add("items", ScanJson.strings(entries));
            o.addProperty("maxRegisteredValue", maxValue);
            channels.add(e.getKey(), o);
        }
        root.add("channels", channels);
        writeJson(file, root);
    }

    private static JsonObject stringMapToJson(Map<String, String> map) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, String> e : new TreeMap<String, String>(map).entrySet()) {
            o.addProperty(e.getKey(), e.getValue());
        }
        return o;
    }

    private static void writeEnumeration(File file, List<MultiblockChannelProbe.MachineProbe> machines,
        int enumeratedTotal) throws Exception {
        JsonObject root = new JsonObject();
        root.addProperty("enumeratedTotal", enumeratedTotal);
        root.addProperty("probedCount", machines.size());
        root.addProperty("source", "GregTechAPI.METATILEENTITIES -> instanceof IConstructable");
        JsonArray arr = new JsonArray();
        for (MultiblockChannelProbe.MachineProbe m : machines) {
            JsonObject o = new JsonObject();
            o.addProperty("mteId", m.mteId);
            o.addProperty("fqcn", m.fqcn);
            o.addProperty("simpleName", m.simpleName);
            o.addProperty("displayName", m.displayName);
            o.addProperty("localizedName", m.localizedName);
            o.addProperty("isMetaTileEntity", m.isMetaTileEntity);
            o.addProperty("isSurvivalConstructable", m.isSurvivalConstructable);
            o.addProperty("hasStructureDefinition", m.hasStructureDefinition);
            o.addProperty("structurePieceCount", m.structurePieceCount);
            o.addProperty("distinctElementCount", m.distinctElementCount);
            o.add("elementClasses", ScanJson.strings(m.elementClassNames));
            arr.add(o);
        }
        root.add("machines", arr);
        writeJson(file, root);
    }

    /** machines.json 的原文（用于计算内容哈希与跨运行逐字节比对）。 */
    private static String buildMachinesJson(List<MultiblockChannelProbe.MachineProbe> machines) {
        JsonObject root = new JsonObject();
        root.addProperty("schema", "lightning.multiblock.probe.facts/1");
        JsonArray arr = new JsonArray();
        for (MultiblockChannelProbe.MachineProbe m : machines) {
            arr.add(machineToJson(m));
        }
        root.add("machines", arr);
        return PRETTY.toJson(root) + "\n";
    }

    private static JsonObject machineToJson(MultiblockChannelProbe.MachineProbe m) {
        JsonObject o = new JsonObject();
        o.addProperty("mteId", m.mteId);
        o.addProperty("fqcn", m.fqcn);
        o.addProperty("simpleName", m.simpleName);
        o.addProperty("displayName", m.displayName);
        o.addProperty("localizedName", m.localizedName);
        o.addProperty("isSurvivalConstructable", m.isSurvivalConstructable);
        o.addProperty("hasStructureDefinition", m.hasStructureDefinition);
        o.addProperty("structurePieceCount", m.structurePieceCount);
        o.addProperty("distinctElementCount", m.distinctElementCount);

        JsonArray channels = new JsonArray();
        for (MultiblockChannelProbe.ChannelProbe p : m.channels) {
            JsonObject c = new JsonObject();
            c.addProperty("enumName", p.enumName);
            c.addProperty("id", p.id);
            c.addProperty("kind", p.kind);
            c.addProperty("discoverySource", p.discoverySource);
            c.addProperty("domainSource", p.domainSource);
            c.addProperty("elementClass", p.elementClass);
            if (p.min != null) c.addProperty("min", p.min);
            if (p.max != null) c.addProperty("max", p.max);
            else c.add("max", com.google.gson.JsonNull.INSTANCE);
            c.addProperty("distinctValues", p.distinctValues);
            c.addProperty("observedBlockStateCount", p.observedBlockStateCount);
            c.addProperty("observedMax", p.observedMax);
            c.addProperty("plateauReached", p.plateauReached);
            c.addProperty("hintListHasTrailingRepeat", p.hintListHasTrailingRepeat);
            if (p.registryItemCount != null) c.addProperty("registryItemCount", p.registryItemCount);
            if (p.registryMaxValue != null) c.addProperty("registryMaxValue", p.registryMaxValue);
            c.addProperty("registryAgreement", p.registryAgreement);
            c.addProperty("domainScope", p.domainScope);
            if (p.unknownElementObservedMax != null) {
                c.addProperty("unknownElementObservedMax", p.unknownElementObservedMax);
            }
            if (p.duplicateElementCount > 0) c.addProperty("duplicateElementCount", p.duplicateElementCount);
            JsonArray obs = new JsonArray();
            for (MultiblockChannelProbe.ChannelObservedValue v : p.observed) {
                JsonObject vo = new JsonObject();
                vo.addProperty("value", v.value);
                vo.addProperty("blockCount", v.blockCount);
                vo.addProperty("blocksKey", v.blocksKey);
                obs.add(vo);
            }
            c.add("observedValues", obs);
            if (!p.notes.isEmpty()) c.add("notes", ScanJson.strings(p.notes));
            channels.add(c);
        }
        o.add("channels", channels);

        JsonObject tier = new JsonObject();
        if (m.maxTotalTier != null) tier.addProperty("maxTotalTier", m.maxTotalTier);
        else tier.add("maxTotalTier", com.google.gson.JsonNull.INSTANCE);
        tier.addProperty("tierSource", m.tierSource);
        tier.addProperty("tierAttempts", m.tierAttempts);
        tier.addProperty("tierEstimateHitCap", m.tierEstimateHitCap);
        tier.addProperty("tierBlocksAtMax", m.tierBlocksAtMax);
        if (m.tierMutationDeltas != null && !m.tierMutationDeltas.isEmpty()) {
            tier.add("tierMutationDeltas", ScanJson.ints(m.tierMutationDeltas));
        }
        if (m.tierSecondTierTrace != null && !m.tierSecondTierTrace.isEmpty()) {
            tier.add("tierSecondTierTrace", ScanJson.strings(m.tierSecondTierTrace));
        }
        if (m.tierFailure != null) tier.addProperty("tierFailure", m.tierFailure);
        o.add("totalTier", tier);

        o.addProperty("channelProbeFailed", m.channelProbeFailed);
        if (m.channelFailure != null) o.addProperty("channelFailure", m.channelFailure);
        if (!m.unknownValueDependentElements.isEmpty()) {
            o.add("unknownValueDependentElements", ScanJson.strings(m.unknownValueDependentElements));
        }
        if (!m.notes.isEmpty()) o.add("notes", ScanJson.strings(m.notes));
        return o;
    }

    private static final com.google.gson.Gson PRETTY = new com.google.gson.GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    private static JsonObject buildSummary(int runIndex, List<MultiblockChannelProbe.MachineProbe> machines,
        Map<String, com.gtnewhorizon.structurelib.ChannelDescription> registry, String machinesHash,
        List<MultiblockChannelProbe.Failure> failures, int enumeratedTotal, Config cfg, long elapsedMs,
        int previousRunIndex, File dir, int baseTileProviderCount) throws Exception {
        JsonObject s = new JsonObject();
        s.addProperty("probe", "T1.2 multiblock enumeration + channel/tier probe");
        s.addProperty("probeSchema", 1);
        s.addProperty("runIndex", runIndex);
        s.addProperty("enumeratedTotal", enumeratedTotal);
        s.addProperty("probedCount", machines.size());
        s.addProperty("failureCount", failures.size());
        s.addProperty("elapsedMs", elapsedMs);
        s.addProperty("machinesJsonSha256", machinesHash);

        // 通道分布
        Map<String, Integer> channelHistogram = new TreeMap<String, Integer>();
        Map<String, Integer> kindHistogram = new TreeMap<String, Integer>();
        Map<String, Integer> domainSourceHistogram = new TreeMap<String, Integer>();
        Map<String, Integer> registryAgreementHistogram = new TreeMap<String, Integer>();
        List<String> onlyTotalTier = new ArrayList<String>();
        int channelEntries = 0;
        int distinctChannelKeys = 0;
        Map<String, String> distinctKeys = new TreeMap<String, String>();
        for (MultiblockChannelProbe.MachineProbe m : machines) {
            int named = 0;
            for (MultiblockChannelProbe.ChannelProbe p : m.channels) {
                channelEntries++;
                bump(channelHistogram, p.id);
                bump(kindHistogram, p.kind);
                bump(domainSourceHistogram, p.domainSource);
                bump(registryAgreementHistogram, p.registryAgreement);
                if (!"hatch".equals(p.kind)) named++;
                distinctKeys.put(p.enumName + "|" + p.id, p.id);
            }
            if (named == 0) onlyTotalTier.add(m.fqcn);
        }
        distinctChannelKeys = distinctKeys.size();
        s.addProperty("machineChannelEntries", channelEntries);
        s.addProperty("distinctChannelKeys", distinctChannelKeys);
        s.add("channelIdHistogram", intMapToJson(channelHistogram));
        s.add("channelKindHistogram", intMapToJson(kindHistogram));
        s.add("domainSourceHistogram", intMapToJson(domainSourceHistogram));
        s.add("registryAgreementHistogram", intMapToJson(registryAgreementHistogram));
        s.addProperty("onlyTotalTierCount", onlyTotalTier.size());
        s.add("onlyTotalTierMachines", ScanJson.strings(onlyTotalTier));

        // 与 BlockRenderer6343 的 GTConstructableScan 做同口径对比（两者都是「METATILEENTITIES ∩ IConstructable」）
        JsonObject comparison = new JsonObject();
        comparison.addProperty(
            "method",
            "METATILEENTITIES ∩ IConstructable（与 BlockRenderer6343 GTNEIMultiblockHandler 的 "
                + "multiblocksList 构造条件逐字一致）");
        comparison.addProperty("thisScanEnumerableCount", enumeratedTotal);
        comparison.addProperty("registeredMetaTileEntities", countMetaTiles());
        comparison.addProperty(
            "constructableRatio",
            countMetaTiles() == 0 ? "n/a" : String.valueOf(enumeratedTotal) + "/" + String.valueOf(countMetaTiles()));
        comparison.addProperty("baseTileConstructableProviderCount", baseTileProviderCount);
        comparison
            .addProperty("note", "BlockRenderer6343 的扫描结果未在本环境实测（未装该 mod）；本项给出的是同口径枚举数与全体注册数，" + "供调度者与参考实现的实际数字对表。");
        s.add("referenceImplementationComparison", comparison);

        // 不变量（给 T1.3/T1.4 与回归用）
        JsonObject invariants = new JsonObject();
        invariants.addProperty("machineCount", machines.size());
        invariants.addProperty("machinesJsonSha256", machinesHash);
        invariants.addProperty(
            "channelIdHistogramHash",
            sha256Hex(
                intMapToJson(channelHistogram).toString()
                    .getBytes(StandardCharsets.UTF_8)));
        invariants.addProperty("onlyTotalTierCount", onlyTotalTier.size());
        invariants.addProperty("failureCount", failures.size());
        s.add("invariants", invariants);

        // 失败清单（非空即明确列出）
        JsonArray fails = new JsonArray();
        for (MultiblockChannelProbe.Failure f : failures) {
            JsonObject o = new JsonObject();
            o.addProperty("fqcn", f.fqcn);
            o.addProperty("stage", f.stage);
            o.addProperty("exception", f.exception);
            o.addProperty("message", f.message);
            if (f.stackTraceHead != null) o.addProperty("stackTraceHead", f.stackTraceHead);
            fails.add(o);
        }
        s.add("failures", fails);

        // 跨运行比对（第二次起有证据）
        JsonObject cmp = new JsonObject();
        if (previousRunIndex <= 0) {
            cmp.add("previousRunIndex", com.google.gson.JsonNull.INSTANCE);
            cmp.addProperty("machinesHashMatch", false);
            cmp.addProperty("note", "本目录下没有更早的运行，无法比对（第二次运行起才有重复性证据）");
        } else {
            File prev = new File(dir, String.format("run-%04d", previousRunIndex));
            cmp.addProperty("previousRunIndex", previousRunIndex);
            cmp.addProperty("previousRunDir", prev.getAbsolutePath());
            File prevMachines = new File(prev, "machines.json");
            if (!prevMachines.isFile()) {
                cmp.addProperty("machinesHashMatch", false);
                cmp.addProperty("previousMachinesFile", "missing");
            } else {
                String prevText = readText(prevMachines);
                String prevHash = sha256Hex(prevText.getBytes(StandardCharsets.UTF_8));
                cmp.addProperty("previousMachinesJsonSha256", prevHash);
                cmp.addProperty("machinesHashMatch", prevHash.equals(machinesHash));
                File prevSummary = new File(prev, "summary.json");
                if (prevSummary.isFile()) {
                    try {
                        JsonObject ps = new JsonParser().parse(readText(prevSummary))
                            .getAsJsonObject();
                        cmp.addProperty(
                            "enumeratedTotalMatch",
                            ps.get("enumeratedTotal")
                                .getAsInt() == enumeratedTotal);
                        cmp.addProperty(
                            "probedCountMatch",
                            ps.get("probedCount")
                                .getAsInt() == machines.size());
                    } catch (Throwable t) {
                        cmp.addProperty(
                            "previousSummaryError",
                            t.getClass()
                                .getSimpleName());
                    }
                }
            }
        }
        s.add("signatureComparison", cmp);

        JsonObject budget = new JsonObject();
        budget.addProperty("channels", cfg.channels);
        budget.addProperty("tiers", cfg.tiers);
        budget.addProperty("limit", cfg.limit);
        budget.addProperty("perMachineBudgetMs", cfg.perMachineBudgetMs);
        budget.addProperty("globalBudgetMs", cfg.globalBudgetMs);
        budget.add("onlyClasses", ScanJson.strings(cfg.onlyClasses));
        s.add("config", budget);

        s.addProperty("reflectionError", MultiblockChannelProbe.REFLECTION_ERROR);
        s.addProperty("reflectionKernelFacts", MultiblockChannelProbe.REFLECTION_KERNEL_FACTS);
        s.addProperty("registryChannelCount", registry.size());
        return s;
    }

    private static void bump(Map<String, Integer> map, String key) {
        Integer cur = map.get(key);
        map.put(key, Integer.valueOf(cur == null ? 1 : cur.intValue() + 1));
    }

    /** 注册表里非 null 的 {@code IMetaTileEntity} 槽位总数（对比用的分母）。 */
    private static int countMetaTiles() {
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        if (all == null) return 0;
        int n = 0;
        for (IMetaTileEntity m : all) {
            if (m != null) n++;
        }
        return n;
    }

    private static JsonObject intMapToJson(Map<String, Integer> map) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, Integer> e : map.entrySet()) {
            o.addProperty(e.getKey(), e.getValue());
        }
        return o;
    }

    private static void writeEnvironment(File file,
        Map<String, com.gtnewhorizon.structurelib.ChannelDescription> registry, Config cfg) throws Exception {
        JsonObject o = new JsonObject();
        o.addProperty("atEpochMs", System.currentTimeMillis());
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
        o.addProperty("registryChannelCount", registry.size());
        o.addProperty("reflectionError", MultiblockChannelProbe.REFLECTION_ERROR);
        o.addProperty("reflectionKernelFacts", MultiblockChannelProbe.REFLECTION_KERNEL_FACTS);
        o.addProperty(
            "metatileEntitySlots",
            GregTechAPI.METATILEENTITIES == null ? -1 : GregTechAPI.METATILEENTITIES.length);
        o.addProperty(
            "distinctChannelEnumNames",
            MultiblockChannelProbe.enumNamesById()
                .size());
        JsonObject domainTable = new JsonObject();
        for (Map.Entry<String, List<String>> e : MultiblockChannelProbe.enumNamesById()
            .entrySet()) {
            if (e.getValue()
                .size() > 1) {
                domainTable.add(e.getKey(), ScanJson.strings(e.getValue()));
            }
        }
        o.add("duplicateChannelIds", domainTable);
        writeJson(file, o);
    }

    private static void writeManifest(File file, int runIndex, File runDir, long started, Config cfg, int probed)
        throws Exception {
        JsonObject o = new JsonObject();
        o.addProperty("probe", "T1.2 multiblock enumeration + channel/tier probe");
        o.addProperty("runIndex", runIndex);
        o.addProperty("runDir", runDir.getAbsolutePath());
        o.addProperty("startedAtEpochMs", started);
        o.addProperty("finishedAtEpochMs", System.currentTimeMillis());
        o.addProperty("probedCount", probed);
        o.addProperty("channels", cfg.channels);
        o.addProperty("tiers", cfg.tiers);
        writeJson(file, o);
    }

    // ------------------------------------------------------------------ io helpers

    private static void writeJson(File file, JsonObject json) throws Exception {
        ScanJson.write(file, json);
    }

    private static void writeText(File file, String text) throws Exception {
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(text);
        }
    }

    private static String readText(File file) throws Exception {
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        }
    }

    private static int previousRunIndex(File dir) {
        File[] children = dir.listFiles();
        int max = 0;
        if (children == null) return 0;
        for (File c : children) {
            if (!c.isDirectory()) continue;
            String n = c.getName();
            if (!n.startsWith("run-")) continue;
            try {
                max = Math.max(max, Integer.parseInt(n.substring(4)));
            } catch (NumberFormatException ignored) {
                // 非规范目录名忽略
            }
        }
        return max;
    }

    static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(data);
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
