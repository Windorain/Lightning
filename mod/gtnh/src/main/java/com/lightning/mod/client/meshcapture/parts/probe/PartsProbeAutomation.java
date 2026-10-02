package com.lightning.mod.client.meshcapture.parts.probe;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 三族部件接口反射可达性探针 —— 无人值守入口（仿 T1.6 管线骨架，独立触发文件，默认零行为变化）。
 *
 * <pre>
 * gradlew runClientSdePipeline（或 runClient + 进程内 fml.queryResult 兜底）
 *  → 检测 <mcDataDir>/sde_parts_probe.json 存在 → 接管客户端 tick：
 *     ① 进专用干净世界（sde_parts_probe_world，超平坦/创造，幂等复用）
 *     ② 把真实玩家传送到探针基点附近（客户端需要加载该处区块才能读到 tile）
 *     ③ 服务端世界真实放置三族部件组合（PartsProbePlacement，走各族自己的添加路径 + 正常同步）
 *     ④ 等同步后从客户端世界 mc.theWorld 读取 tile，三族探针枚举部件/盒/物品身份（纯反射）
 *     ⑤ 落 sde_parts_probe_dump.json（探针数据）+ sde_parts_probe_result.json（结构化结果+退出码）
 *     ⑥ 退出（0 → mc.shutdown()；非 0 → FMLCommonHandler.exitJava；全程不用 Runtime.halt）
 * </pre>
 *
 * <p>
 * 触发文件（全部可选）：{@code {"label":"...", "cleanupTrigger":true, "syncWaitTicks":60}}。
 * 触发文件不存在时本类不产生任何行为。
 */
@SideOnly(Side.CLIENT)
public final class PartsProbeAutomation {

    private static final String TRIGGER_FILE = "sde_parts_probe.json";
    private static final String RESULT_FILE = "sde_parts_probe_result.json";
    private static final String DUMP_FILE = "sde_parts_probe_dump.json";
    private static final String WORLD_FOLDER = "sde_parts_probe_world";
    private static final String WORLD_DISPLAY = "SDE Parts Probe World";
    private static final long TOTAL_TIMEOUT_MS = 15L * 60L * 1000L;
    private static final long PHASE_TIMEOUT_MS = 3L * 60L * 1000L;
    private static final long EXIT_WATCHDOG_MS = 60L * 1000L;

    /** 探针基点（超平坦地表 y=4 上方，远离出生点强加载区之外的普通位置）。 */
    private static final int BASE_X = 64;
    private static final int BASE_Y = 12;
    private static final int BASE_Z = 64;

    private enum Phase {
        INIT,
        JOIN,
        WAIT_WORLD,
        TELEPORT,
        PLACE,
        WAIT_SYNC,
        PROBE,
        DONE
    }

    private static boolean active;
    private static boolean finalized;
    private static Phase phase = Phase.INIT;
    private static long startedMs;
    private static long phaseStartedMs;
    private static int phaseTicks;

    private static String label = "parts-probe";
    private static boolean cleanupTrigger = true;
    private static int worldSettleTicks = 40;
    private static int chunkWaitTicks = 60;
    private static int syncWaitTicks = 60;
    /** P0.3：触发文件 {@code "singleBox":true} 时追加单盒通用路径探针（默认关闭，P0.2 行为不变）。 */
    private static boolean singleBox;
    /** P1.1/P1.2：触发文件 {@code "partsPipeline":true} 时追加部件流水线探针（默认关闭；隐含 singleBox 放置）。 */
    private static boolean partsPipeline;

    private static final List<String> warnings = new ArrayList<String>();
    private static final PartsProbePlacement placement = new PartsProbePlacement();
    private static JsonObject dump;
    private static int fatalCode;

    private PartsProbeAutomation() {}

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, TRIGGER_FILE);
    }

    /** 触发文件存在（或探针已在跑）时接管客户端 tick；不存在时<strong>零行为变化</strong>。 */
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
                FMLLog.info("[SDE][P0.2] 已补设 -Dfml.queryResult=confirm（进程内兜底）");
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
                case PLACE:
                    place(mc);
                    break;
                case WAIT_SYNC:
                    waitSync(mc);
                    break;
                case PROBE:
                    probe(mc);
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
            if (o.has("singleBox")) {
                singleBox = o.get("singleBox")
                    .getAsBoolean();
            }
            if (o.has("partsPipeline")) {
                partsPipeline = o.get("partsPipeline")
                    .getAsBoolean();
                if (partsPipeline) {
                    // P1.1/P1.2 流水线探针复用 P0.3 的 11 单盒场景 ⇒ 隐含 singleBox 放置与必收族
                    singleBox = true;
                }
            }
        } catch (Throwable t) {
            warnings.add("触发文件解析失败（用默认配置继续）: " + PartsProbeReflect.describe(t));
        }
        FMLLog.info("[SDE][P0.2] 三族部件探针启动 label=%s 基点=(%d,%d,%d)", label, BASE_X, BASE_Y, BASE_Z);
        if (singleBox) {
            FMLLog.info("[SDE][P0.3] 单盒通用路径探针已启用（singleBox=true）");
        }
        if (partsPipeline) {
            FMLLog.info("[SDE][P1.1] 部件流水线探针已启用（partsPipeline=true）");
        }
        toPhase(Phase.JOIN);
    }

    private static void join(Minecraft mc) {
        if (mc.theWorld != null) {
            toPhase(Phase.WAIT_WORLD);
            return;
        }
        if (!(mc.currentScreen instanceof GuiMainMenu)) {
            return; // 仍在加载
        }
        File levelDat = new File(new File(mc.mcDataDir, "saves"), WORLD_FOLDER + File.separator + "level.dat");
        mc.displayGuiScreen(null);
        if (levelDat.isFile()) {
            FMLLog.info("[SDE][P0.2] 复用专用世界 %s", WORLD_FOLDER);
            mc.launchIntegratedServer(WORLD_FOLDER, WORLD_DISPLAY, null);
        } else {
            FMLLog.info("[SDE][P0.2] 新建专用世界 %s（超平坦 + 创造 + 允许命令）", WORLD_FOLDER);
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
        FMLLog.info(
            "[SDE][P0.2] 已进入世界: %s",
            String.valueOf(
                mc.theWorld.getWorldInfo()
                    .getWorldName()));
        toPhase(Phase.TELEPORT);
    }

    /** 把真实玩家传送到基点（客户端只加载玩家附近的区块；tile 同步依赖客户端有该区块）。 */
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
        FMLLog.info("[SDE][P0.2] 已传送玩家 %s 到基点", player.getCommandSenderName());
        toPhase(Phase.PLACE);
    }

    /** 等客户端加载基点区块后，在服务端世界真实放置三族组合。 */
    private static void place(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < chunkWaitTicks) {
            return;
        }
        MinecraftServer server = MinecraftServer.getServer();
        WorldServer world = server.worldServers[0];
        @SuppressWarnings("unchecked")
        List<EntityPlayerMP> players = server.getConfigurationManager().playerEntityList;
        EntityPlayerMP player = players.isEmpty() ? null : players.get(0);
        placement.placeAll(server, world, player, BASE_X, BASE_Y, BASE_Z);
        if (singleBox) {
            placement.placeSingleBox(world, BASE_X, BASE_Y, BASE_Z);
            FMLLog.info("[SDE][P0.3] 单盒场景放置完成（11 格）");
        }
        FMLLog.info(
            "[SDE][P0.2] 放置完成：%d 个探针方块，放置错误 %d 条",
            Integer.valueOf(placement.placed.size()),
            Integer.valueOf(placement.errors.size()));
        toPhase(Phase.WAIT_SYNC);
    }

    private static void waitSync(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < syncWaitTicks) {
            return;
        }
        toPhase(Phase.PROBE);
    }

    private static void probe(Minecraft mc) {
        dump = new JsonObject();
        dump.addProperty("schema", "lightning.parts-probe/1");
        dump.addProperty("task", "P0.2 三族部件接口反射可达性探针");
        dump.addProperty("label", label);
        dump.addProperty("generatedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        dump.addProperty(
            "note",
            "坐标系：AE2 rawPixelBoxes = 0–16 像素挂载面局部（localFrameAxes 给出局部轴→世界轴），"
                + "blockLocalBoxes = BusCollisionHelper 归一化后的 0–1 方块局部 Y-up；"
                + "EnderIO bound / FMP Cuboid6 原生即 0–1 方块局部。");
        JsonArray placedArr = new JsonArray();
        for (PartsProbePlacement.Placed p : placement.placed) {
            placedArr.add(p.posJson());
        }
        dump.add("placed", placedArr);
        dump.add("placementLog", placement.placementLog);
        dump.add("placementErrors", placement.errors);

        JsonObject families = new JsonObject();
        for (PartsProbePlacement.Placed p : placement.placed) {
            JsonObject fam;
            if (families.has(p.family)) {
                fam = families.getAsJsonObject(p.family);
            } else {
                fam = new JsonObject();
                fam.add("blocks", new JsonArray());
                families.add(p.family, fam);
            }
            JsonObject block;
            if ("ae2".equals(p.family)) {
                block = Ae2PartProbe.probeBlock(mc, p.x, p.y, p.z);
            } else if ("enderio".equals(p.family)) {
                block = EnderIoPartProbe.probeBlock(mc, p.x, p.y, p.z);
            } else if ("fmp".equals(p.family)) {
                block = FmpPartProbe.probeBlock(mc, p.x, p.y, p.z);
            } else if ("singlebox".equals(p.family)) {
                block = SingleBoxProbe.probeBlock(mc, p.x, p.y, p.z);
            } else {
                block = new JsonObject();
                block.addProperty("error", "unknown family " + p.family);
            }
            block.addProperty("label", p.label);
            JsonArray pos = new JsonArray();
            pos.add(new JsonPrimitive(Integer.valueOf(p.x)));
            pos.add(new JsonPrimitive(Integer.valueOf(p.y)));
            pos.add(new JsonPrimitive(Integer.valueOf(p.z)));
            block.add("pos", pos);
            fam.getAsJsonArray("blocks")
                .add(block);
        }
        dump.add("families", families);
        if (partsPipeline) {
            try {
                dump.add("partsPipeline", PartsPipelineProbe.runExperiments(mc, placement.placed));
            } catch (Throwable t) {
                // 流水线探针自身失败不得拖垮整个探针轮（留痕即可）
                warnings.add("partsPipeline probe failed: " + PartsProbeReflect.describe(t));
                JsonObject failed = new JsonObject();
                failed.addProperty("pass", Boolean.FALSE);
                failed.addProperty("error", PartsProbeReflect.describe(t));
                dump.add("partsPipeline", failed);
            }
        }
        finalizeRun(mc);
    }

    // ------------------------------------------------------------------ 收尾

    private static void finalizeRun(Minecraft mc) {
        if (finalized) {
            return;
        }
        finalized = true;
        int code = fatalCode != 0 ? fatalCode : 0;
        JsonObject result = new JsonObject();
        result.addProperty("schema", "lightning.parts-probe-result/1");
        result.addProperty("label", label);
        result.addProperty("startedAtEpochMs", Long.valueOf(startedMs));
        result.addProperty("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()));

        // 成败判据：三族都至少有 1 个方块读到 ≥1 个部件（放置错误或探针错误都会在 dump 留痕）
        JsonObject families = dump == null ? null : dump.getAsJsonObject("families");
        JsonArray summary = new JsonArray();
        String[] required = singleBox ? new String[] { "ae2", "enderio", "fmp", "singlebox" }
            : new String[] { "ae2", "enderio", "fmp" };
        for (String fam : required) {
            int parts = 0;
            String detail = "missing";
            if (families != null && families.has(fam)) {
                JsonArray blocks = families.getAsJsonObject(fam)
                    .getAsJsonArray("blocks");
                int okBlocks = 0;
                StringBuilder err = new StringBuilder();
                for (int i = 0; i < blocks.size(); i++) {
                    JsonObject b = blocks.get(i)
                        .getAsJsonObject();
                    int pc = b.has("partCount") ? b.get("partCount")
                        .getAsInt() : 0;
                    if (pc > 0) {
                        okBlocks++;
                        parts += pc;
                    }
                    if (b.has("errors")) {
                        JsonArray errs = b.getAsJsonArray("errors");
                        for (int j = 0; j < errs.size(); j++) {
                            if (err.length() > 0) {
                                err.append(" | ");
                            }
                            err.append(
                                errs.get(j)
                                    .getAsString());
                        }
                    }
                }
                detail = okBlocks + "/" + blocks.size() + " blocks ok" + (err.length() > 0 ? " errors: " + err : "");
                if (err.length() > 0) {
                    warnings.add(fam + ": " + err);
                }
            }
            if (fatalCode == 0 && parts == 0) {
                code = 2;
            }
            JsonObject s = new JsonObject();
            s.addProperty("family", fam);
            s.addProperty("partsRead", Integer.valueOf(parts));
            s.addProperty("detail", detail);
            summary.add(s);
        }
        // P1.1/P1.2：流水线探针 pass=false ⇒ 退出码 2（细节在 dump.partsPipeline.cells[].checks）
        if (partsPipeline) {
            JsonObject pp = dump == null ? null : dump.getAsJsonObject("partsPipeline");
            boolean ppPass = pp != null && pp.has("pass")
                && pp.get("pass")
                    .getAsBoolean();
            JsonObject s = new JsonObject();
            s.addProperty("family", "partsPipeline");
            s.addProperty("partsRead", Integer.valueOf(ppPass ? 1 : 0));
            s.addProperty(
                "detail",
                ppPass ? "expA-emptyRegistry/expB-throwingProvider/expC-genericBaseline all pass"
                    : "FAIL: see dump.partsPipeline.*.cells[].checks");
            summary.add(s);
            if (fatalCode == 0 && !ppPass) {
                code = 2;
            }
        }
        if (placement.errors.size() > 0) {
            warnings.add("放置阶段有错误（详见 dump.placementErrors）: " + placement.errors);
        }
        result.addProperty("status", code == 0 ? "ok" : "has-failures");
        result.addProperty("exitCode", Integer.valueOf(code));
        result.add("families", summary);
        result.add("warnings", toJsonArray(warnings));
        result.addProperty("dumpFile", new File(mc.mcDataDir, DUMP_FILE).getAbsolutePath());

        try {
            if (dump != null) {
                writeJson(new File(mc.mcDataDir, DUMP_FILE), dump);
            }
            writeJson(new File(mc.mcDataDir, RESULT_FILE), result);
            FMLLog.info("[SDE][P0.2] 探针结果落盘 status=%s exitCode=%d", result.get("status"), Integer.valueOf(code));
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][P0.2] 结果写出失败");
            code = 3;
        }

        if (cleanupTrigger) {
            File trig = triggerFile(mc);
            if (trig.isFile() && !trig.delete()) {
                FMLLog.warning("[SDE][P0.2] 未能删除触发文件: %s", trig.getAbsolutePath());
            }
        }
        requestExit(mc, code);
        phase = Phase.DONE;
    }

    private static void fatal(Minecraft mc, String kind, String message) {
        FMLLog.log(Level.ERROR, "[SDE][P0.2] 探针致命失败 [%s] %s", kind, message);
        warnings.add("FATAL " + kind + ": " + message);
        fatalCode = 3;
        if (dump == null) {
            dump = new JsonObject();
            dump.addProperty("schema", "lightning.parts-probe/1");
            dump.addProperty("fatal", kind + ": " + message);
        }
        finalizeRun(mc);
    }

    /** 与 T1.6 相同的退出纪律：绝不 Runtime.halt；非 0 走 FMLCommonHandler.exitJava；加安全网线程。 */
    private static void requestExit(Minecraft mc, final int code) {
        Thread watchdog = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MS);
                } catch (InterruptedException ignored) {
                    return;
                }
                FMLLog.warning("[SDE][P0.2] 退出安全网触发，强制 exitJava(%d, true)", Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-parts-probe-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FMLLog.info("[SDE][P0.2] 请求退出游戏，退出码 %d", Integer.valueOf(code));
        if (code == 0) {
            mc.shutdown();
        } else {
            FMLCommonHandler.instance()
                .exitJava(code, false);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static void toPhase(Phase next) {
        FMLLog.info("[SDE][P0.2] 阶段 %s → %s", phase, next);
        phase = next;
        phaseStartedMs = System.currentTimeMillis();
        phaseTicks = 0;
    }

    private static String readText(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static void writeJson(File f, JsonObject o) throws Exception {
        Files.write(
            f.toPath(),
            o.toString()
                .getBytes(StandardCharsets.UTF_8));
    }

    private static JsonArray toJsonArray(List<String> list) {
        JsonArray a = new JsonArray();
        for (String s : list) {
            a.add(new JsonPrimitive(s));
        }
        return a;
    }
}
