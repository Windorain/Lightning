package com.lightning.mod.client.meshcapture.parts.probe;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;

import org.apache.logging.log4j.Level;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.MeshCaptureService;
import com.lightning.mod.client.meshcapture.parts.PartCapturePipeline;
import com.lightning.mod.client.meshcapture.parts.PartCaptureResult;
import com.lightning.mod.client.meshcapture.parts.PartExportIntegrator;
import com.lightning.mod.client.meshcapture.parts.PartProviderRegistry;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.8 验收结构「建造 → 导出 → oracle 落盘」自动化（仿 T1.6/P0.2 管线骨架，独立触发文件，
 * 默认零行为变化）。外层编排 = {@code scripts/parts-acceptance/run-acceptance.ps1}
 * （npm 命令 {@code acceptance:parts}，留白 #9 拍板）。
 *
 * <pre>
 * gradlew runClientSdePipeline
 *  → 检测 <mcDataDir>/sde_parts_acceptance.json 存在 → 接管客户端 tick：
 *     ① 进专用世界（sde_parts_acceptance_world，超平坦/创造，幂等复用）
 *     ② 传送真实玩家到基点 → ③ PartsAcceptanceBuilder.resetWorld（FMP remPart 通道清场）
 *     ④ build 八分区（同步记录放置意图）→ ⑤ 等同步
 *     ⑥ EXPORT 阶段（单 tick 内）：实测 dump → 全量导出×2（幂等哈希对）→ oracle 全量落盘
 *        → 满方块-only 字节干净对照（enabled vs disabled）→ 退化导出（关 ae2 ⇒ 档 2；
 *        全关 {ae2,eio,fmp,generic} ⇒ 档 3 inferred）+ 退化 oracle（期望档位变换）
 *        → 合并语义等价实验（复用 PartsFamilyProviderProbe.MergeProbeProvider 形态）
 *        → oracle↔导出逐格核对（PartsAcceptanceVerifier）
 *     ⑦ 落 sde_parts_acceptance_result.json（结构化结果+退出码）→ 退出（不用 Runtime.halt）
 * </pre>
 *
 * 触发文件（全部可选）：{@code {"label":"...", "cleanupTrigger":true, "syncWaitTicks":60,
 * "disabledFamilies":["ae2",...]}}。{@code disabledFamilies} 存在时本轮为自定义退化轮
 * （从 INIT 起应用开关，只做单轮导出+变换 oracle 核对，跳过内建退化两步）。
 */
@SideOnly(Side.CLIENT)
public final class PartsAcceptanceAutomation {

    private static final String TRIGGER_FILE = "sde_parts_acceptance.json";
    private static final String RESULT_FILE = "sde_parts_acceptance_result.json";
    private static final String DUMP_FILE = "sde_parts_acceptance_dump.json";
    private static final String WORLD_FOLDER = "sde_parts_acceptance_world";
    private static final String WORLD_DISPLAY = "SDE Parts Acceptance World";
    private static final long TOTAL_TIMEOUT_MS = 15L * 60L * 1000L;
    private static final long PHASE_TIMEOUT_MS = 5L * 60L * 1000L;
    private static final long EXIT_WATCHDOG_MS = 60L * 1000L;

    /** 建造基点（与 P0.2 探针同一超平坦地表高度，独立世界互不干扰）。 */
    private static final int BASE_X = 64;
    private static final int BASE_Y = 12;
    private static final int BASE_Z = 64;

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .create();

    private enum Phase {
        INIT,
        JOIN,
        WAIT_WORLD,
        TELEPORT,
        BUILD,
        WAIT_SYNC,
        EXPORT,
        DONE
    }

    private static boolean active;
    private static boolean finalized;
    private static Phase phase = Phase.INIT;
    private static long startedMs;
    private static long phaseStartedMs;
    private static int phaseTicks;

    private static String label = "parts-acceptance";
    private static boolean cleanupTrigger = true;
    private static int worldSettleTicks = 40;
    private static int chunkWaitTicks = 60;
    private static int syncWaitTicks = 60;
    /** 触发文件 {@code "disabledFamilies":[...]}：自定义退化轮（空 = 全量 + 内建退化两步）。 */
    private static final Set<String> triggerDisabledFamilies = new LinkedHashSet<String>();

    private static final List<String> warnings = new ArrayList<String>();
    private static final PartsAcceptanceBuilder builder = new PartsAcceptanceBuilder();
    private static JsonObject dump;
    private static int fatalCode;

    private PartsAcceptanceAutomation() {}

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, TRIGGER_FILE);
    }

    /** 触发文件存在（或验收已在跑）时接管客户端 tick；不存在时<strong>零行为变化</strong>。 */
    public static boolean isRequested(Minecraft mc) {
        if (mc == null || finalized) {
            return false;
        }
        if (active) {
            return true;
        }
        if (triggerFile(mc).isFile()) {
            active = true;
            if (System.getProperty("fml.queryResult") == null) {
                System.setProperty("fml.queryResult", "confirm");
                FMLLog.info("[SDE][P1.8] 已补设 -Dfml.queryResult=confirm（进程内兜底）");
            }
            return true;
        }
        return false;
    }

    public static void tick(Minecraft mc) {
        if (finalized || phase == Phase.DONE) {
            return;
        }
        try {
            long now = System.currentTimeMillis();
            if (phase != Phase.INIT) {
                if (now - startedMs > TOTAL_TIMEOUT_MS) {
                    fatal(mc, "TotalTimeout", "整轮超时 " + (now - startedMs) + " ms");
                    return;
                }
                if (now - phaseStartedMs > PHASE_TIMEOUT_MS) {
                    fatal(mc, "PhaseTimeout", "阶段 " + phase + " 超时 " + (now - phaseStartedMs) + " ms");
                    return;
                }
            }
            switch (phase) {
                case INIT:
                    init(mc);
                    break;
                case JOIN:
                    join(mc);
                    break;
                case WAIT_WORLD:
                    waitWorld(mc);
                    break;
                case TELEPORT:
                    teleport(mc);
                    break;
                case BUILD:
                    build(mc);
                    break;
                case WAIT_SYNC:
                    waitSync(mc);
                    break;
                case EXPORT:
                    export(mc);
                    break;
                default:
                    break;
            }
        } catch (Throwable t) {
            fatal(mc, "Unexpected", PartsProbeReflect.describe(t));
        }
    }

    // ------------------------------------------------------------------ 各阶段

    private static void init(Minecraft mc) {
        startedMs = System.currentTimeMillis();
        phaseStartedMs = startedMs;
        try {
            JsonObject o = new JsonParser().parse(readText(triggerFile(mc)))
                .getAsJsonObject();
            if (o.has("label")) {
                label = o.get("label")
                    .getAsString();
            }
            if (o.has("cleanupTrigger")) {
                cleanupTrigger = o.get("cleanupTrigger")
                    .getAsBoolean();
            }
            if (o.has("syncWaitTicks")) {
                syncWaitTicks = o.get("syncWaitTicks")
                    .getAsInt();
            }
            if (o.has("disabledFamilies")) {
                JsonArray arr = o.getAsJsonArray("disabledFamilies");
                for (int i = 0; i < arr.size(); i++) {
                    triggerDisabledFamilies.add(
                        arr.get(i)
                            .getAsString());
                }
            }
        } catch (Throwable t) {
            warnings.add("触发文件解析失败（用默认配置继续）: " + PartsProbeReflect.describe(t));
        }
        // 自定义退化轮：从 INIT 起应用按族开关（探针/验收专用通道；默认全开生产行为不变）
        for (String fam : triggerDisabledFamilies) {
            PartProviderRegistry.setFamilyEnabledForProbe(fam, false);
        }
        FMLLog.info(
            "[SDE][P1.8] 验收建造启动 label=%s 基点=(%d,%d,%d) disabledFamilies=%s",
            label,
            Integer.valueOf(BASE_X),
            Integer.valueOf(BASE_Y),
            Integer.valueOf(BASE_Z),
            triggerDisabledFamilies);
        toPhase(Phase.JOIN);
    }

    private static void join(Minecraft mc) {
        if (mc.theWorld != null) {
            toPhase(Phase.WAIT_WORLD);
            return;
        }
        if (!(mc.currentScreen instanceof GuiMainMenu)) {
            return;
        }
        File levelDat = new File(new File(mc.mcDataDir, "saves"), WORLD_FOLDER + File.separator + "level.dat");
        mc.displayGuiScreen(null);
        if (levelDat.isFile()) {
            FMLLog.info("[SDE][P1.8] 复用专用世界 %s", WORLD_FOLDER);
            mc.launchIntegratedServer(WORLD_FOLDER, WORLD_DISPLAY, null);
        } else {
            FMLLog.info("[SDE][P1.8] 新建专用世界 %s（超平坦 + 创造 + 允许命令）", WORLD_FOLDER);
            WorldSettings ws = new WorldSettings(
                20260713L,
                WorldSettings.GameType.CREATIVE,
                false,
                false,
                WorldType.FLAT);
            ws.enableCommands();
            mc.launchIntegratedServer(WORLD_FOLDER, WORLD_DISPLAY, ws);
        }
        toPhase(Phase.WAIT_WORLD);
    }

    private static void waitWorld(Minecraft mc) {
        if (mc.theWorld == null || mc.thePlayer == null || mc.currentScreen != null) {
            return;
        }
        phaseTicks++;
        if (phaseTicks < worldSettleTicks) {
            return;
        }
        toPhase(Phase.TELEPORT);
    }

    private static void teleport(Minecraft mc) {
        MinecraftServer server = MinecraftServer.getServer();
        if (server == null || server.worldServers.length == 0) {
            return;
        }
        @SuppressWarnings("unchecked")
        List<EntityPlayerMP> players = server.getConfigurationManager().playerEntityList;
        if (players.isEmpty()) {
            phaseTicks++;
            if (phaseTicks > 200) {
                fatal(mc, "NoServerPlayer", "服务端玩家列表为空，无法传送");
            }
            return;
        }
        EntityPlayerMP player = players.get(0);
        player.setPositionAndUpdate(BASE_X + 0.5, BASE_Y + 3.0, BASE_Z + 0.5);
        FMLLog.info("[SDE][P1.8] 已传送玩家 %s 到基点", player.getCommandSenderName());
        toPhase(Phase.BUILD);
    }

    private static void build(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < chunkWaitTicks) {
            return;
        }
        MinecraftServer server = MinecraftServer.getServer();
        WorldServer world = server.worldServers[0];
        @SuppressWarnings("unchecked")
        List<EntityPlayerMP> players = server.getConfigurationManager().playerEntityList;
        EntityPlayerMP player = players.isEmpty() ? null : players.get(0);
        // 跨轮幂等清场（FMP remPart 通道；计划 §9 探针基建开放项的既定解法）→ 建造八分区
        builder.resetWorld(world, BASE_X, BASE_Y, BASE_Z);
        builder.build(world, player, BASE_X, BASE_Y, BASE_Z);
        FMLLog.info(
            "[SDE][P1.8] 建造完成：%d 个意图格，建造错误 %d 条",
            Integer.valueOf(builder.cells.size()),
            Integer.valueOf(builder.errors.size()));
        if (builder.errors.size() > 0) {
            warnings.add("建造阶段有错误（详见 dump.buildErrors）: " + builder.errors);
        }
        toPhase(Phase.WAIT_SYNC);
    }

    private static void waitSync(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < syncWaitTicks) {
            return;
        }
        toPhase(Phase.EXPORT);
    }

    // ------------------------------------------------------------------ EXPORT：导出 + oracle + 自洽核对（单 tick 内完成）

    private static void export(Minecraft mc) {
        dump = new JsonObject();
        dump.addProperty("schema", "lightning.parts-acceptance/1");
        dump.addProperty("task", "P1.8 验收结构建造器 + oracle 生成器");
        dump.addProperty("label", label);
        dump.add("buildLog", builder.buildLog);
        dump.add("buildErrors", builder.errors);

        JsonObject suites = new JsonObject();
        boolean allPass = true;
        try {
            // ⓪ 确定性图标半环：动画纹理（如 EnderIO itemItemConduit 的 .mcmeta 动画）的图集帧随
            // 游戏 tick 漂移 ⇒ 部件图标 PNG 跨进程字节不一致（p18-final2 实证唯一 diff）。
            // 导出前把方块/物品图集全部动画精灵复位到帧 0（本 EXPORT 阶段单 tick 内完成全部导出，
            // 帧不再前进）⇒ 图标字节跨轮确定。视觉-only 副作用，仅限本验收会话。
            resetTextureAnimationsForDeterministicIcons(mc);

            // ① 实测 dump（校準/诊断用：逐格 collectParts 结果 + 满方块快速否定核对）
            JsonObject measured = measureCells(mc);
            dump.add("measured", measured);
            boolean measuredOk = measured.get("failedChecks")
                .getAsInt() == 0;
            allPass &= measuredOk;

            // ② 全量 oracle（建造意图 → 契约 §11 JSON）
            JsonObject oracleFull = PartsAcceptanceOracle.generateFull(builder.cells, BASE_X, BASE_Y, BASE_Z);
            if (triggerDisabledFamilies.isEmpty()) {
                writeJson(new File(mc.mcDataDir, "sde_parts_acceptance_oracle_full.json"), PRETTY.toJson(oracleFull));

                // ③ 全量导出 ×2（同轮幂等哈希对）+ oracle↔导出逐格核对
                byte[] runA = exportStructure(mc, BASE_X, BASE_Y, BASE_Z);
                byte[] runB = exportStructure(mc, BASE_X, BASE_Y, BASE_Z);
                JsonObject idem = hashPair(runA, runB);
                idem.addProperty("what", "全量导出同轮两次（幂等）");
                dump.add("idempotencyFull", idem);
                allPass &= sha256Hex(runA).equals(sha256Hex(runB));
                writeJson(
                    new File(mc.mcDataDir, "sde_parts_acceptance_export_full_a.json"),
                    new String(runA, StandardCharsets.UTF_8));
                writeJson(
                    new File(mc.mcDataDir, "sde_parts_acceptance_export_full_b.json"),
                    new String(runB, StandardCharsets.UTF_8));
                JsonObject vFull = PartsAcceptanceVerifier.verify("full", oracleFull, parse(runA));
                suites.add("full", vFull);
                allPass &= vFull.get("pass")
                    .getAsBoolean();

                // ④ 满方块-only 字节干净对照（向后兼容硬约束：enabled vs disabled 哈希对）
                JsonObject byteClean = fullCubeByteCleanCheck(mc);
                dump.add("fullCubeByteClean", byteClean);
                allPass &= byteClean.get("pass")
                    .getAsBoolean();

                // ⑤ 退化区：关 ae2 ⇒ 档 2；全关 {ae2,eio,fmp,generic} ⇒ 档 3 inferred
                allPass &= degradedRound(mc, suites, "degraded_ae2", setOf(PartSource.FAMILY_AE2));
                allPass &= degradedRound(
                    mc,
                    suites,
                    "degraded_all",
                    setOf(
                        PartSource.FAMILY_AE2,
                        PartSource.FAMILY_ENDERIO,
                        PartSource.FAMILY_FMP,
                        PartSource.FAMILY_GENERIC));

                // ⑥ 合并语义等价实验（叠加区裁决：复用 P1.3–P1.5 合并实验形态）
                JsonObject merge = mergeExperiment(mc);
                dump.add("mergeExperiment", merge);
                allPass &= merge.get("pass")
                    .getAsBoolean();
            } else {
                // 自定义退化轮：触发文件指定的开关集合 ⇒ 单轮导出 + 变换 oracle 核对
                JsonObject oracleCustom = PartsAcceptanceOracle
                    .generateDegraded(builder.cells, BASE_X, BASE_Y, BASE_Z, triggerDisabledFamilies, mc.theWorld);
                writeJson(
                    new File(mc.mcDataDir, "sde_parts_acceptance_oracle_custom.json"),
                    PRETTY.toJson(oracleCustom));
                byte[] out = exportStructure(mc, BASE_X, BASE_Y, BASE_Z);
                writeJson(
                    new File(mc.mcDataDir, "sde_parts_acceptance_export_custom.json"),
                    new String(out, StandardCharsets.UTF_8));
                JsonObject vCustom = PartsAcceptanceVerifier.verify("custom-degraded", oracleCustom, parse(out));
                vCustom.addProperty("disabledFamilies", triggerDisabledFamilies.toString());
                suites.add("custom", vCustom);
                allPass &= vCustom.get("pass")
                    .getAsBoolean();
            }
        } catch (Throwable t) {
            warnings.add("EXPORT 阶段异常: " + PartsProbeReflect.describe(t));
            dump.addProperty("exportError", PartsProbeReflect.describe(t));
            allPass = false;
        } finally {
            // 恢复默认（全开）——探针开关绝不泄漏到生产路径
            PartProviderRegistry.clearFamilySwitchesForProbe();
        }
        dump.add("suites", suites);
        dump.addProperty("pass", Boolean.valueOf(allPass));
        if (!allPass && fatalCode == 0) {
            fatalCode = 2;
        }
        finalizeRun(mc);
    }

    /** 一轮退化导出：关指定族 → 导出 → 变换 oracle → 核对 → 恢复全开。 */
    private static boolean degradedRound(Minecraft mc, JsonObject suites, String name, Set<String> disabled)
        throws Exception {
        for (String fam : disabled) {
            PartProviderRegistry.setFamilyEnabledForProbe(fam, false);
        }
        try {
            JsonObject oracle = PartsAcceptanceOracle
                .generateDegraded(builder.cells, BASE_X, BASE_Y, BASE_Z, disabled, mc.theWorld);
            byte[] out = exportStructure(mc, BASE_X, BASE_Y, BASE_Z);
            writeJson(new File(mc.mcDataDir, "sde_parts_acceptance_oracle_" + name + ".json"), PRETTY.toJson(oracle));
            writeJson(
                new File(mc.mcDataDir, "sde_parts_acceptance_export_" + name + ".json"),
                new String(out, StandardCharsets.UTF_8));
            JsonObject v = PartsAcceptanceVerifier.verify(name, oracle, parse(out));
            v.addProperty("disabledFamilies", disabled.toString());
            suites.add(name, v);
            return v.get("pass")
                .getAsBoolean();
        } finally {
            PartProviderRegistry.clearFamilySwitchesForProbe();
        }
    }

    /**
     * 满方块-only 字节干净对照（P1.7 硬约束的验收级复验）：满方块区 4 格单独成结构，
     * 部件采集 enabled vs {@link PartExportIntegrator#setEnabledForProbe}(false) 两次导出字节一致，
     * 且 enabled 产物无任何部件字段。
     */
    private static JsonObject fullCubeByteCleanCheck(Minecraft mc) throws Exception {
        JsonObject out = new JsonObject();
        JsonArray checks = new JsonArray();
        List<int[]> cols = new ArrayList<int[]>();
        for (PartsAcceptanceBuilder.CellIntent c : builder.cells) {
            if ("full-cube".equals(c.zone)) {
                cols.add(new int[] { c.x, c.y, c.z });
            }
        }
        byte[] enabled = exportColumns(mc, cols);
        JsonObject enabledRoot = parse(enabled);
        expect(
            checks,
            !enabledRoot.has("cellPartsGrid") && !enabledRoot.has("partLists")
                && !enabledRoot.has("statsTemplate")
                && !enabledRoot.has("partIconTextures"),
            "满方块-only 导出不应有任何部件字段");
        PartExportIntegrator.setEnabledForProbe(false);
        byte[] disabled;
        try {
            disabled = exportColumns(mc, cols);
        } finally {
            PartExportIntegrator.setEnabledForProbe(true);
        }
        boolean identical = sha256Hex(enabled).equals(sha256Hex(disabled));
        expect(checks, identical, "满方块-only 导出 enabled/disabled 应字节一致");
        out.addProperty("enabledSha256", sha256Hex(enabled));
        out.addProperty("disabledSha256", sha256Hex(disabled));
        writeJson(
            new File(mc.mcDataDir, "sde_parts_acceptance_export_fullcube_only.json"),
            new String(enabled, StandardCharsets.UTF_8));
        out.add("checks", checks);
        int fails = 0;
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                fails++;
            }
        }
        out.addProperty("pass", Boolean.valueOf(fails == 0));
        return out;
    }

    /**
     * 合并语义等价实验（叠加区裁决形态，复用 PartsFamilyProviderProbe.MergeProbeProvider）：
     * 在叠加区 FMP 三微方块格注册探针级 tier-1 提供者 ⇒ 断言合并后 3+1 部件、
     * localId 命名空间零冲突、落档 1。
     */
    private static JsonObject mergeExperiment(Minecraft mc) {
        JsonObject out = new JsonObject();
        out.addProperty("suite", "mergeExperiment（叠加区合并语义等价断言）");
        JsonArray checks = new JsonArray();
        PartsAcceptanceBuilder.CellIntent fmpOverlay = null;
        for (PartsAcceptanceBuilder.CellIntent c : builder.cells) {
            if ("overlay".equals(c.zone) && c.parts.size() == 3) {
                fmpOverlay = c;
            }
        }
        if (fmpOverlay == null) {
            checks.add(new JsonPrimitive("FAIL: 未找到叠加区 FMP 三微方块格"));
        } else {
            PartsFamilyProviderProbe.MergeProbeProvider probe = new PartsFamilyProviderProbe.MergeProbeProvider(
                fmpOverlay.x,
                fmpOverlay.y,
                fmpOverlay.z);
            PartProviderRegistry.register(probe);
            PartCaptureResult r;
            try {
                r = PartCapturePipeline.collectParts(mc.theWorld, fmpOverlay.x, fmpOverlay.y, fmpOverlay.z);
            } finally {
                PartProviderRegistry.unregister(probe);
            }
            out.add("result", r.toJson());
            expect(checks, r.tier == PartSource.TIER_FAMILY, "合并格应落档 1");
            expect(checks, r.parts.size() == 4, "合并格应恰 4 部件（3 fmp + 1 探针，实际 " + r.parts.size() + "）");
            List<String> ids = new ArrayList<String>();
            boolean distinct = true;
            boolean hasProbe = false;
            int fmpCount = 0;
            for (PartRecord p : r.parts) {
                if (ids.contains(p.localId)) {
                    distinct = false;
                }
                ids.add(p.localId);
                if (p.localId.startsWith("probemerge:")) {
                    hasProbe = true;
                }
                if (p.localId.startsWith("fmp:")) {
                    fmpCount++;
                }
            }
            expect(checks, fmpCount == 3, "合并后应有 3 个 fmp 部件（实际 " + fmpCount + "）");
            expect(checks, hasProbe, "合并后应有 probemerge:0（探针提供者）");
            expect(checks, distinct, "合并后 localId 应零冲突（" + ids + "）");
            expect(checks, r.providerFailures.isEmpty(), "合并格不应有提供者失败");
        }
        out.add("checks", checks);
        int fails = 0;
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                fails++;
            }
        }
        out.addProperty("failedChecks", Integer.valueOf(fails));
        out.addProperty("pass", Boolean.valueOf(fails == 0));
        return out;
    }

    /**
     * 实测 dump：逐格跑 {@link PartCapturePipeline#collectParts}（校准与诊断用），
     * 并核对满方块快速否定（expectFullCube 格 ⇒ hostFullCube=true）。
     */
    private static JsonObject measureCells(Minecraft mc) {
        JsonObject out = new JsonObject();
        JsonArray arr = new JsonArray();
        JsonArray checks = new JsonArray();
        for (PartsAcceptanceBuilder.CellIntent c : builder.cells) {
            JsonObject cell = new JsonObject();
            JsonArray pos = new JsonArray();
            pos.add(new JsonPrimitive(Integer.valueOf(c.x)));
            pos.add(new JsonPrimitive(Integer.valueOf(c.y)));
            pos.add(new JsonPrimitive(Integer.valueOf(c.z)));
            cell.add("pos", pos);
            cell.addProperty("zone", c.zone);
            try {
                PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, c.x, c.y, c.z);
                cell.add("result", r.toJson());
                if (c.expectFullCube) {
                    expect(
                        checks,
                        r.hostFullCube,
                        "满方块格 (" + c.x + "," + c.y + "," + c.z + ") 应被快速否定（hostFullCube=true）");
                }
            } catch (Throwable t) {
                cell.addProperty("error", PartsProbeReflect.describe(t));
                checks.add(
                    new JsonPrimitive(
                        "FAIL: 实测格 (" + c.x + "," + c.y + "," + c.z + ") 异常: " + PartsProbeReflect.describe(t)));
            }
            arr.add(cell);
        }
        out.add("cells", arr);
        out.add("checks", checks);
        int fails = 0;
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                fails++;
            }
        }
        out.addProperty("failedChecks", Integer.valueOf(fails));
        return out;
    }

    // ------------------------------------------------------------------ 导出驱动（P1.7 PartsExportProbe 同款真实路径）

    /**
     * 把方块/物品纹理图集的全部动画精灵复位到帧 0（反射 TextureAtlasSprite 的
     * frameCounter/tickCounter/framesTextureData + TextureUtil.uploadTextureSub 帧 0 重传）。
     * 逐精灵容错：单个失败不影响其它（该精灵图标退回帧漂移旧行为，导出绝不中断）。
     */
    private static void resetTextureAnimationsForDeterministicIcons(Minecraft mc) {
        net.minecraft.client.renderer.texture.TextureMap[] maps = { mc.getTextureMapBlocks(),
            com.lightning.mod.client.meshcapture.MaterialKeyResolver.getTextureMapItems(mc) };
        int[] reset = { 0 };
        int[] failed = { 0 };
        for (net.minecraft.client.renderer.texture.TextureMap map : maps) {
            if (map == null) {
                continue;
            }
            try {
                if (!(map instanceof com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor)) {
                    warnings.add("动画图集复位：TextureMap 未实现 TextureMapAccessor（mixin 缺失？）");
                    continue;
                }
                Map<String, net.minecraft.client.renderer.texture.TextureAtlasSprite> sprites = ((com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor) map)
                    .sde$getMapRegisteredSprites();
                org.lwjgl.opengl.GL11.glBindTexture(org.lwjgl.opengl.GL11.GL_TEXTURE_2D, map.getGlTextureId());
                for (net.minecraft.client.renderer.texture.TextureAtlasSprite sprite : sprites.values()) {
                    try {
                        if (!sprite.hasAnimationMetadata()) {
                            continue;
                        }
                        java.lang.reflect.Field frameCounter = findField(sprite.getClass(), "frameCounter");
                        java.lang.reflect.Field tickCounter = findField(sprite.getClass(), "tickCounter");
                        java.lang.reflect.Field frames = findField(sprite.getClass(), "framesTextureData");
                        if (frameCounter == null || tickCounter == null || frames == null) {
                            failed[0]++;
                            continue;
                        }
                        frameCounter.setAccessible(true);
                        tickCounter.setAccessible(true);
                        frames.setAccessible(true);
                        List<?> frameData = (List<?>) frames.get(sprite);
                        if (frameData == null || frameData.isEmpty()) {
                            continue;
                        }
                        frameCounter.setInt(sprite, 0);
                        tickCounter.setInt(sprite, 0);
                        // GTNH 修补版 1.7.10：framesTextureData = List<int[][]>（各向异性过滤 mip 层级），
                        // 帧 0 基底 = get(0)[0]。glTexSubImage2D 只写 mip 0（GUI 图标渲染只用基底）。
                        Object frame0Obj = frameData.get(0);
                        int[] frame0 = frame0Obj instanceof int[][] ? ((int[][]) frame0Obj)[0] : (int[]) frame0Obj;
                        java.nio.IntBuffer buf = java.nio.ByteBuffer.allocateDirect(frame0.length * 4)
                            .order(java.nio.ByteOrder.nativeOrder())
                            .asIntBuffer();
                        buf.put(frame0);
                        buf.flip();
                        org.lwjgl.opengl.GL11.glTexSubImage2D(
                            org.lwjgl.opengl.GL11.GL_TEXTURE_2D,
                            0,
                            sprite.getOriginX(),
                            sprite.getOriginY(),
                            sprite.getIconWidth(),
                            sprite.getIconHeight(),
                            org.lwjgl.opengl.GL12.GL_BGRA,
                            org.lwjgl.opengl.GL12.GL_UNSIGNED_INT_8_8_8_8_REV,
                            buf);
                        reset[0]++;
                    } catch (Throwable t) {
                        failed[0]++;
                    }
                }
            } catch (Throwable t) {
                warnings.add("动画图集复位失败: " + PartsProbeReflect.describe(t));
            }
        }
        FMLLog.info("[SDE][P1.8] 动画图集复位：%d 精灵复位到帧 0，%d 失败", Integer.valueOf(reset[0]), Integer.valueOf(failed[0]));
    }

    private static java.lang.reflect.Field findField(Class<?> c, String name) {
        Class<?> cur = c;
        while (cur != null) {
            try {
                return cur.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
                cur = cur.getSuperclass();
            }
        }
        return null;
    }

    /** 建造区包围盒整体作为一个结构导出（geometryPhase=scan 文档 → 真实 finalizeStructureJson）。 */
    private static byte[] exportStructure(Minecraft mc, int bx, int by, int bz) throws Exception {
        JsonObject root = buildScanDocument(mc, bx, by, bz);
        MeshCaptureService.finalizeStructureJson(root);
        return PRETTY.toJson(root)
            .getBytes(StandardCharsets.UTF_8);
    }

    /** 指定若干世界格组成 1×1×N 单结构导出（满方块-only 对照用）。 */
    private static byte[] exportColumns(Minecraft mc, List<int[]> cols) throws Exception {
        JsonArray cellTypes = new JsonArray();
        cellTypes.add(airType());
        Map<String, Integer> typeIndex = new LinkedHashMap<String, Integer>();
        JsonArray colArr = new JsonArray();
        JsonArray wColArr = new JsonArray();
        for (int[] p : cols) {
            Block b = mc.theWorld.getBlock(p[0], p[1], p[2]);
            int meta = mc.theWorld.getBlockMetadata(p[0], p[1], p[2]);
            String reg = Block.blockRegistry.getNameForObject(b);
            String key = reg + ":" + meta;
            Integer ti = typeIndex.get(key);
            if (ti == null) {
                ti = Integer.valueOf(cellTypes.size());
                typeIndex.put(key, ti);
                JsonObject t = new JsonObject();
                t.addProperty("registryId", reg);
                t.addProperty("meta", Integer.valueOf(meta));
                cellTypes.add(t);
            }
            colArr.add(new JsonPrimitive(ti));
            JsonObject w = new JsonObject();
            w.addProperty("x", Integer.valueOf(p[0]));
            w.addProperty("y", Integer.valueOf(p[1]));
            w.addProperty("z", Integer.valueOf(p[2]));
            wColArr.add(w);
        }
        JsonArray rows = new JsonArray();
        rows.add(colArr);
        JsonArray cellGrid = new JsonArray();
        cellGrid.add(rows);
        JsonArray wRows = new JsonArray();
        wRows.add(wColArr);
        JsonArray worldGrid = new JsonArray();
        worldGrid.add(wRows);
        JsonObject root = new JsonObject();
        root.addProperty("geometryPhase", "scan");
        root.add("cellTypes", cellTypes);
        root.add("cellGrid", cellGrid);
        root.add("worldGrid", worldGrid);
        MeshCaptureService.finalizeStructureJson(root);
        return PRETTY.toJson(root)
            .getBytes(StandardCharsets.UTF_8);
    }

    /**
     * 合成建造区包围盒的 scan 文档：z∈[bz,bz+SZ)、row 0 = y=by+1（顶）、col = x-(bx+1)。
     * 空 cell = air 调色板下标 0 + worldGrid null（P1.7 探针同款形状）。
     */
    private static JsonObject buildScanDocument(Minecraft mc, int bx, int by, int bz) {
        int sx = PartsAcceptanceBuilder.SIZE_X;
        int sy = PartsAcceptanceBuilder.SIZE_Y;
        int sz = PartsAcceptanceBuilder.SIZE_Z;
        JsonArray cellTypes = new JsonArray();
        cellTypes.add(airType());
        Map<String, Integer> typeIndex = new LinkedHashMap<String, Integer>();
        JsonArray cellGrid = new JsonArray();
        JsonArray worldGrid = new JsonArray();
        for (int zi = 0; zi < sz; zi++) {
            JsonArray rows = new JsonArray();
            JsonArray wRows = new JsonArray();
            for (int ri = 0; ri < sy; ri++) {
                JsonArray colArr = new JsonArray();
                JsonArray wColArr = new JsonArray();
                int y = (by + 1) - ri;
                for (int ci = 0; ci < sx; ci++) {
                    int x = bx + 1 + ci;
                    int z = bz + zi;
                    Block b = mc.theWorld.getBlock(x, y, z);
                    if (b == null || b == net.minecraft.init.Blocks.air) {
                        colArr.add(new JsonPrimitive(Integer.valueOf(0)));
                        wColArr.add(com.google.gson.JsonNull.INSTANCE);
                        continue;
                    }
                    int meta = mc.theWorld.getBlockMetadata(x, y, z);
                    String reg = Block.blockRegistry.getNameForObject(b);
                    String key = reg + ":" + meta;
                    Integer ti = typeIndex.get(key);
                    if (ti == null) {
                        ti = Integer.valueOf(cellTypes.size());
                        typeIndex.put(key, ti);
                        JsonObject t = new JsonObject();
                        t.addProperty("registryId", reg);
                        t.addProperty("meta", Integer.valueOf(meta));
                        cellTypes.add(t);
                    }
                    colArr.add(new JsonPrimitive(ti));
                    JsonObject w = new JsonObject();
                    w.addProperty("x", Integer.valueOf(x));
                    w.addProperty("y", Integer.valueOf(y));
                    w.addProperty("z", Integer.valueOf(z));
                    wColArr.add(w);
                }
                rows.add(colArr);
                wRows.add(wColArr);
            }
            cellGrid.add(rows);
            worldGrid.add(wRows);
        }
        JsonObject root = new JsonObject();
        root.addProperty("geometryPhase", "scan");
        root.add("cellTypes", cellTypes);
        root.add("cellGrid", cellGrid);
        root.add("worldGrid", worldGrid);
        return root;
    }

    private static JsonObject airType() {
        JsonObject air = new JsonObject();
        air.addProperty("registryId", "air");
        air.addProperty("meta", Integer.valueOf(0));
        return air;
    }

    // ------------------------------------------------------------------ 收尾

    private static void finalizeRun(Minecraft mc) {
        if (finalized) {
            return;
        }
        finalized = true;
        int code = fatalCode != 0 ? fatalCode : 0;
        JsonObject result = new JsonObject();
        result.addProperty("schema", "lightning.parts-acceptance-result/1");
        result.addProperty("label", label);
        result.addProperty("startedAtEpochMs", Long.valueOf(startedMs));
        result.addProperty("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        result.addProperty("structure", "parts-acceptance");
        result.addProperty("world", WORLD_FOLDER);
        result.addProperty("intentCells", Integer.valueOf(builder.cells.size()));
        if (dump != null && dump.has("idempotencyFull")) {
            result.add("idempotencyFull", dump.getAsJsonObject("idempotencyFull"));
        }
        if (dump != null && dump.has("fullCubeByteClean")) {
            JsonObject bc = dump.getAsJsonObject("fullCubeByteClean");
            JsonObject bcSummary = new JsonObject();
            bcSummary.addProperty(
                "enabledSha256",
                bc.get("enabledSha256")
                    .getAsString());
            bcSummary.addProperty(
                "disabledSha256",
                bc.get("disabledSha256")
                    .getAsString());
            bcSummary.addProperty(
                "pass",
                bc.get("pass")
                    .getAsBoolean());
            result.add("fullCubeByteClean", bcSummary);
        }
        JsonArray suiteSummary = new JsonArray();
        if (dump != null && dump.has("suites")) {
            JsonObject suites = dump.getAsJsonObject("suites");
            for (Map.Entry<String, com.google.gson.JsonElement> e : suites.entrySet()) {
                JsonObject s = e.getValue()
                    .getAsJsonObject();
                JsonObject row = new JsonObject();
                row.addProperty("suite", e.getKey());
                row.addProperty(
                    "pass",
                    s.get("pass")
                        .getAsBoolean());
                if (s.has("failedChecks")) {
                    row.addProperty(
                        "failedChecks",
                        s.get("failedChecks")
                            .getAsInt());
                }
                if (s.has("disabledFamilies")) {
                    row.addProperty(
                        "disabledFamilies",
                        s.get("disabledFamilies")
                            .getAsString());
                }
                suiteSummary.add(row);
            }
        }
        result.add("suites", suiteSummary);
        boolean pass = dump != null && dump.has("pass")
            && dump.get("pass")
                .getAsBoolean();
        result.addProperty("status", code == 0 && pass ? "ok" : "has-failures");
        result.addProperty("exitCode", Integer.valueOf(code));
        result.add("warnings", toJsonArray(warnings));
        result.addProperty("dumpFile", new File(mc.mcDataDir, DUMP_FILE).getAbsolutePath());

        try {
            if (dump != null) {
                writeJson(new File(mc.mcDataDir, DUMP_FILE), PRETTY.toJson(dump));
            }
            writeJson(new File(mc.mcDataDir, RESULT_FILE), PRETTY.toJson(result));
            FMLLog.info("[SDE][P1.8] 验收结果落盘 status=%s exitCode=%d", result.get("status"), Integer.valueOf(code));
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][P1.8] 结果写出失败");
            code = 3;
        }

        if (cleanupTrigger) {
            File trig = triggerFile(mc);
            if (trig.isFile() && !trig.delete()) {
                FMLLog.warning("[SDE][P1.8] 未能删除触发文件: %s", trig.getAbsolutePath());
            }
        }
        requestExit(mc, code);
        phase = Phase.DONE;
    }

    private static void fatal(Minecraft mc, String kind, String message) {
        FMLLog.log(Level.ERROR, "[SDE][P1.8] 验收致命失败 [%s] %s", kind, message);
        warnings.add("FATAL " + kind + ": " + message);
        fatalCode = 3;
        if (dump == null) {
            dump = new JsonObject();
            dump.addProperty("schema", "lightning.parts-acceptance/1");
            dump.addProperty("fatal", kind + ": " + message);
        }
        finalizeRun(mc);
    }

    /** 与 T1.6/P0.2 相同的退出纪律：绝不 Runtime.halt；非 0 走 exitJava；加安全网线程。 */
    private static void requestExit(Minecraft mc, final int code) {
        Thread watchdog = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MS);
                } catch (InterruptedException ignored) {
                    return;
                }
                FMLLog.warning("[SDE][P1.8] 退出安全网触发，强制 exitJava(%d, true)", Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-parts-acceptance-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FMLLog.info("[SDE][P1.8] 请求退出游戏，退出码 %d", Integer.valueOf(code));
        if (code == 0) {
            mc.shutdown();
        } else {
            FMLCommonHandler.instance()
                .exitJava(code, false);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static Set<String> setOf(String... families) {
        Set<String> s = new LinkedHashSet<String>();
        for (String f : families) {
            s.add(f);
        }
        return s;
    }

    private static JsonObject parse(byte[] utf8) {
        return new JsonParser().parse(new String(utf8, StandardCharsets.UTF_8))
            .getAsJsonObject();
    }

    private static JsonObject hashPair(byte[] a, byte[] b) {
        JsonObject o = new JsonObject();
        o.addProperty("runASha256", sha256Hex(a));
        o.addProperty("runBSha256", sha256Hex(b));
        o.addProperty("identical", Boolean.valueOf(sha256Hex(a).equals(sha256Hex(b))));
        return o;
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte bb : d) {
                sb.append(String.format("%02x", bb & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }

    private static void toPhase(Phase next) {
        FMLLog.info("[SDE][P1.8] 阶段 %s → %s", phase, next);
        phase = next;
        phaseStartedMs = System.currentTimeMillis();
        phaseTicks = 0;
    }

    private static String readText(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static void writeJson(File f, String text) throws Exception {
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static JsonArray toJsonArray(List<String> list) {
        JsonArray a = new JsonArray();
        for (String s : list) {
            a.add(new JsonPrimitive(s));
        }
        return a;
    }
}
