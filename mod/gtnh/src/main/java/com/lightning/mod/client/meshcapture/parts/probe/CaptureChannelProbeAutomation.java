package com.lightning.mod.client.meshcapture.parts.probe;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.init.Blocks;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 「忠实复现捕获层」PR-1 验收探针：真实客户端世界 + 真实渲染循环（<strong>不</strong>逐格驱动任何渲染器），
 * 验证三条新录窗通道确实录到几何、DirectTessellator 钩子确实生效、zeroFlow/自证诊断确实产出。
 *
 * <pre>
 * gradlew runClient25
 *  → 检测 &lt;mcDataDir&gt;/sde_capture_channel_probe.json → 接管客户端 tick：
 *     ① 进专用世界（sde_capture_channel_probe_world，超平坦/创造，幂等复用）
 *     ② CaptureDiagnostics.beginSession() + TessellatorCaptureState.armWindows()（一次设定观察条件）
 *     ③ 传送玩家到基点西侧、面向 +X（正对受控区域）
 *     ④ 服务端走 LP 权威链放 2 根 LP 管 + 原版 setBlock 放 1 个箱子
 *     ⑤ 等同步 → 客户端 markBlockRangeForRenderUpdate 触发游戏自身重编译调度（允许的观察条件设定）
 *     ⑥ 跑若干真实帧（真实游戏渲染循环；TESR 逐帧窗口 + 区块编译窗口自然开闭）
 *     ⑦ 汇总诊断 JSON：每通道四边形数、按归属格聚合（管格/箱格）、zeroFlow、
 *        directTessellatorHookActive、自证日志行 → 落盘 → 按退出码退出（0 成功 / 非 0 失败 + 原因）
 * </pre>
 *
 * 触发文件（全部可选）：{@code {"label":"...", "cleanupTrigger":true, "runTicks":120,
 * "syncWaitTicks":60, "baseX":64,"baseY":12,"baseZ":64}}。
 * 触发文件不存在时本类<strong>零行为变化</strong>（不注册任何开销）。
 *
 * 判据（静默漏录不可接受的落地）：
 * <ul>
 * <li>LP 管已被真实放置且首帧 VBO 编译必然产生 DirectTessellator 流量 ⇒
 * {@code directTessellatorHookActive} 必须为 true，且至少一根管格的 TESR 通道四边形数 &gt; 0
 * （证明 MixinDirectTessellatorCapture 生效，否则 GTNHLib 通道几何静默丢失）；</li>
 * <li>markBlocksForUpdate 后区块编译窗口数 &gt; 0 且总四边形数 &gt; 0（证明 C1 钩子生效）；</li>
 * <li>箱格的 TESR 通道四边形数 &gt; 0（箱模型首个 display-list 编译帧经 vanilla Tessellator 流入）；</li>
 * <li>坐标系自证日志行非空（P0 惯例）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class CaptureChannelProbeAutomation {

    private static final String TRIGGER_FILE = "sde_capture_channel_probe.json";
    private static final String RESULT_FILE = "sde_capture_channel_probe_result.json";
    private static final String WORLD_FOLDER = "sde_capture_channel_probe_world";
    private static final String WORLD_DISPLAY = "SDE Capture Channel Probe World";

    private static final long TOTAL_TIMEOUT_MS = 8L * 60L * 1000L;
    private static final long PHASE_TIMEOUT_MS = 3L * 60L * 1000L;
    private static final long EXIT_WATCHDOG_MS = 120L * 1000L;

    private enum Phase {
        INIT,
        JOIN,
        WAIT_WORLD,
        TELEPORT,
        PLACE,
        WAIT_SYNC,
        ORIENT_MARK,
        RUN_FRAMES,
        DONE
    }

    /** 一格受控放置（kind: pipe / chest）。 */
    private static final class Placed {

        final String label;
        final String kind;
        final int x;
        final int y;
        final int z;

        Placed(String label, String kind, int x, int y, int z) {
            this.label = label;
            this.kind = kind;
            this.x = x;
            this.y = y;
            this.z = z;
        }
    }

    private static boolean active;
    private static boolean finalized;
    private static Phase phase = Phase.INIT;
    private static long startedMs;
    private static long phaseStartedMs;
    private static int phaseTicks;
    private static int framesLeft;
    private static int requestedExitCode = -1;

    private static String label = "capture-channel-probe";
    private static boolean cleanupTrigger = true;
    private static int worldSettleTicks = 40;
    private static int chunkWaitTicks = 60;
    private static int syncWaitTicks = 60;
    private static int runTicks = 120;
    private static int baseX = 64;
    private static int baseY = 12;
    private static int baseZ = 64;

    private static final List<Placed> placed = new ArrayList<Placed>();
    private static final List<String> warnings = new ArrayList<String>();
    private static JsonObject result;
    private static JsonObject plan;

    private CaptureChannelProbeAutomation() {}

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
                FMLLog.info("[SDE][capture-probe] 已补设 -Dfml.queryResult=confirm（进程内兜底）");
            }
            installExitRecorder();
            return true;
        }
        return false;
    }

    /** 退出路径留痕：与结果 JSON 对账「探针自己请求的退出码」。 */
    private static void installExitRecorder() {
        try {
            Runtime.getRuntime()
                .addShutdownHook(new Thread(new Runnable() {

                    @Override
                    public void run() {
                        try {
                            JsonObject o = new JsonObject();
                            o.addProperty("schema", "lightning.capture-channel-probe-exit/1");
                            o.addProperty("requestedExitCode", Integer.valueOf(requestedExitCode));
                            Files.write(
                                new File(Minecraft.getMinecraft().mcDataDir, "sde_capture_channel_probe_exit.json")
                                    .toPath(),
                                o.toString()
                                    .getBytes(StandardCharsets.UTF_8));
                        } catch (Throwable ignored) {
                            // 退出路径上的写出失败不影响判据
                        }
                    }
                }, "sde-capture-channel-probe-exit-recorder"));
        } catch (Throwable t) {
            warnings.add("退出记录器安装失败（不影响断言）: " + PartsProbeReflect.describe(t));
        }
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
                case ORIENT_MARK:
                    orientMark(mc);
                    break;
                case RUN_FRAMES:
                    runFrames(mc);
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
            JsonObject o = new JsonParser()
                .parse(new String(Files.readAllBytes(triggerFile(mc).toPath()), StandardCharsets.UTF_8))
                .getAsJsonObject();
            if (o.has("label")) {
                label = o.get("label")
                    .getAsString();
            }
            if (o.has("cleanupTrigger")) {
                cleanupTrigger = o.get("cleanupTrigger")
                    .getAsBoolean();
            }
            if (o.has("runTicks")) {
                runTicks = o.get("runTicks")
                    .getAsInt();
            }
            if (o.has("syncWaitTicks")) {
                syncWaitTicks = o.get("syncWaitTicks")
                    .getAsInt();
            }
            if (o.has("baseX")) {
                baseX = o.get("baseX")
                    .getAsInt();
            }
            if (o.has("baseY")) {
                baseY = o.get("baseY")
                    .getAsInt();
            }
            if (o.has("baseZ")) {
                baseZ = o.get("baseZ")
                    .getAsInt();
            }
        } catch (Throwable t) {
            warnings.add("触发文件解析失败（用默认配置继续）: " + PartsProbeReflect.describe(t));
        }
        // 观察条件一次设定：诊断会话 + 录窗总开关（此后不再反复操纵）
        CaptureDiagnostics.beginSession();
        TessellatorCaptureState.armWindows();
        // 无人值守实测坑：游戏窗口失焦时 MC 会自动打开暂停菜单（GuiIngameMenu），
        // 单机暂停 → 服务端停 tick → 放置/同步/真实帧全部停摆（探针曾在 WAIT_WORLD 卡死超时）。
        // 关掉「失焦即暂停」属于观察条件一次设定（游戏设置项，非渲染行为操纵）。
        if (mc.gameSettings != null && mc.gameSettings.pauseOnLostFocus) {
            mc.gameSettings.pauseOnLostFocus = false;
            FMLLog.info("[SDE][capture-probe] 已关 pauseOnLostFocus（防无人值守失焦自动暂停）");
        }
        FMLLog.info(
            "[SDE][capture-probe] 捕获通道验收探针启动 label=%s 基点=(%d,%d,%d) runTicks=%d",
            label,
            Integer.valueOf(baseX),
            Integer.valueOf(baseY),
            Integer.valueOf(baseZ),
            Integer.valueOf(runTicks));
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
            FMLLog.info("[SDE][capture-probe] 复用专用世界 %s", WORLD_FOLDER);
            mc.launchIntegratedServer(WORLD_FOLDER, WORLD_DISPLAY, null);
        } else {
            FMLLog.info("[SDE][capture-probe] 新建专用世界 %s（超平坦 + 创造 + 允许命令）", WORLD_FOLDER);
            WorldSettings ws = new WorldSettings(
                20261006L,
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
        if (mc.theWorld == null || mc.thePlayer == null) {
            return;
        }
        if (mc.currentScreen != null) {
            phaseTicks++;
            if (phaseTicks == 1 || phaseTicks % 100 == 0) {
                FMLLog.info(
                    "[SDE][capture-probe] 世界已进但界面未关（%s），等待中",
                    mc.currentScreen.getClass()
                        .getName());
            }
            // 无人值守兜底：卡界面 200 tick 强制关闭一次（真实渲染循环需要无界面状态）
            if (phaseTicks == 200) {
                FMLLog.warning(
                    "[SDE][capture-probe] 强制关闭卡住的界面: %s",
                    mc.currentScreen.getClass()
                        .getName());
                mc.displayGuiScreen(null);
            }
            return;
        }
        phaseTicks++;
        if (phaseTicks < worldSettleTicks) {
            return;
        }
        FMLLog.info(
            "[SDE][capture-probe] 已进入世界: %s",
            String.valueOf(
                mc.theWorld.getWorldInfo()
                    .getWorldName()));
        toPhase(Phase.TELEPORT);
    }

    private static void teleport(Minecraft mc) {
        EntityPlayerMP player = serverPlayer();
        if (player == null) {
            phaseTicks++;
            if (phaseTicks > 200) {
                fatal(mc, "NoServerPlayer", "服务端玩家列表为空，无法传送");
            }
            return;
        }
        player.setPositionAndUpdate(baseX - 4.5, baseY + 2.0, baseZ + 0.5);
        FMLLog.info("[SDE][capture-probe] 已传送玩家 %s 到基点西侧", player.getCommandSenderName());
        toPhase(Phase.PLACE);
    }

    /** 服务端：LP 权威链放 2 根管（相邻互连）+ 原版 setBlock 放 1 个箱子。 */
    private static void place(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < chunkWaitTicks) {
            return;
        }
        MinecraftServer server = MinecraftServer.getServer();
        WorldServer world = server.worldServers[0];
        placed.clear();
        plan = new JsonObject();

        try {
            List<LpPipeReflect.PipeItem> items = LpPipeReflect.listPipeItems();
            plan.add("registeredPipeItems", LpPipeReflect.itemsToJson(items));
            LpPipeReflect.PipeItem basic = LpPipeReflect
                .pickPipeItem(items, "PipeItemsBasicLogistics", "BasicLogistics", "PipeBasicLogistics", "Basic");
            if (basic == null) {
                throw new IllegalStateException(
                    "没有任何注册管道物品的 pipe 类名含 BasicLogistics/Basic（候选 " + LpPipeReflect.itemsToJson(items) + "）");
            }
            plan.add("chosenBasic", basic.toJson());

            int[][] pipeCells = { { baseX + 1, baseY, baseZ }, { baseX + 2, baseY, baseZ } };
            for (int i = 0; i < pipeCells.length; i++) {
                int x = pipeCells[i][0];
                int y = pipeCells[i][1];
                int z = pipeCells[i][2];
                clearColumn(world, x, y, z);
                TileEntity te = LpPipeReflect.placePipe(world, basic.item, x, y, z);
                if (LpPipeReflect.pipeOf(te) == null) {
                    throw new IllegalStateException("服务端放置后 pipe-" + (i + 1) + " 的 pipe 为 null（放置路径未生效）");
                }
                placed.add(new Placed("pipe-" + (i + 1), "pipe", x, y, z));
            }

            int chestX = baseX + 4;
            clearColumn(world, chestX, baseY, baseZ);
            world.setBlock(chestX, baseY, baseZ, Blocks.chest, 0, 3);
            TileEntity chestTe = world.getTileEntity(chestX, baseY, baseZ);
            if (chestTe == null) {
                throw new IllegalStateException("setBlock(箱子) 后该格没有 TE");
            }
            placed.add(new Placed("chest-1", "chest", chestX, baseY, baseZ));

            world.markBlockRangeForRenderUpdate(baseX, baseY - 1, baseZ, baseX + 6, baseY + 2, baseZ + 1);
            plan.addProperty("placedCount", Integer.valueOf(placed.size()));
        } catch (Throwable t) {
            plan.addProperty("error", PartsProbeReflect.describe(t));
            warnings.add("放置失败: " + PartsProbeReflect.describe(t));
            result = baseResult();
            result.add("placement", plan);
            result.addProperty("status", "placement-failed");
            result.addProperty("exitCode", Integer.valueOf(3));
            JsonArray checks = new JsonArray();
            checks.add(new com.google.gson.JsonPrimitive("FAIL: 受控放置失败（被测对象不存在，不能断言）"));
            result.add("checks", checks);
            writeResult(mc);
            cleanupTrigger(mc);
            requestExit(mc, 3);
            phase = Phase.DONE;
            return;
        }
        FMLLog.info("[SDE][capture-probe] 受控放置完成：%d 格（2 管 + 1 箱，服务端）", Integer.valueOf(placed.size()));
        toPhase(Phase.WAIT_SYNC);
    }

    private static void clearColumn(WorldServer world, int x, int y, int z) {
        for (int dy = -1; dy <= 2; dy++) {
            world.setBlockToAir(x, y + dy, z);
        }
    }

    private static void waitSync(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < syncWaitTicks) {
            return;
        }
        toPhase(Phase.ORIENT_MARK);
    }

    /** 让玩家正对受控区域（真实渲染循环需要视锥覆盖），并触发游戏自身的重编译调度。 */
    private static void orientMark(Minecraft mc) {
        if (mc.theWorld == null || mc.thePlayer == null) {
            return;
        }
        // 客户端 TE 同步确认（缺失只告警——断言会如实反映）
        for (Placed p : placed) {
            TileEntity te = mc.theWorld.getTileEntity(p.x, p.y, p.z);
            JsonObject cell = new JsonObject();
            cell.addProperty("label", p.label);
            cell.addProperty("x", Integer.valueOf(p.x));
            cell.addProperty("y", Integer.valueOf(p.y));
            cell.addProperty("z", Integer.valueOf(p.z));
            cell.addProperty(
                "clientTeClass",
                te == null ? "<null>"
                    : te.getClass()
                        .getName());
            plan.add("clientCell_" + p.label, cell);
            if (te == null) {
                warnings.add("客户端该格 TE 为 null: " + p.label);
            }
        }
        facePlacedArea(mc);
        // 允许的观察条件设定：markBlockRangeForRenderUpdate 触发游戏自身重编译调度（不驱动任何渲染器）。
        // 注：本 GTNH 1.7.10 变体里 World 只有 markBlockRangeForRenderUpdate（World.java:725），
        // 没有 vanilla 旧名 markBlocksForUpdate(int×6)。
        mc.theWorld.markBlockRangeForRenderUpdate(baseX - 1, baseY - 1, baseZ - 1, baseX + 6, baseY + 2, baseZ + 1);
        framesLeft = Math.max(20, runTicks);
        FMLLog.info("[SDE][capture-probe] 已定向相机并 markBlocksForUpdate，跑 %d tick 真实帧", Integer.valueOf(framesLeft));
        toPhase(Phase.RUN_FRAMES);
    }

    private static void runFrames(Minecraft mc) {
        if (mc.theWorld == null || mc.thePlayer == null) {
            return;
        }
        facePlacedArea(mc);
        framesLeft--;
        if (framesLeft > 0) {
            return;
        }
        collectAndFinish(mc);
    }

    // ------------------------------------------------------------------ 汇总与判据

    private static void collectAndFinish(Minecraft mc) {
        JsonObject diag = CaptureDiagnostics.toJson();
        JsonObject channels = diag.getAsJsonObject("channels");
        JsonArray checks = new JsonArray();

        long hookCount = diag.get("directTessellatorVertexCount")
            .getAsLong();
        boolean hookActive = diag.get("directTessellatorHookActive")
            .getAsBoolean();

        // 判据 1：DirectTessellator 钩子自检（本会话确实制造了 LP 流量，判活成立）
        expect(checks, hookActive, "directTessellatorHookActive=true（LP 管 VBO 编译流量经 MixinDirectTessellatorCapture 到达）");

        // 判据 2：至少一根管格的 TESR 通道有四边形（GTNHLib 通道几何不再静默丢失）
        JsonArray pipeCells = new JsonArray();
        long pipeTesrQuadsTotal = 0;
        for (Placed p : placed) {
            if (!"pipe".equals(p.kind)) {
                continue;
            }
            long tesr = quadCountAt(diag, "TESR", p.x, p.y, p.z);
            long bc = quadCountAt(diag, "BLOCK_COMPILE", p.x, p.y, p.z);
            pipeTesrQuadsTotal += tesr;
            JsonObject c = new JsonObject();
            c.addProperty("label", p.label);
            c.addProperty("x", Integer.valueOf(p.x));
            c.addProperty("y", Integer.valueOf(p.y));
            c.addProperty("z", Integer.valueOf(p.z));
            c.addProperty("tesrQuads", Long.valueOf(tesr));
            c.addProperty("blockCompileQuads", Long.valueOf(bc));
            pipeCells.add(c);
        }
        expect(checks, pipeTesrQuadsTotal > 0, "至少一根管格 TESR 通道四边形数>0（实际 " + pipeTesrQuadsTotal + "）");

        // 判据 3：箱格 TESR 通道有四边形（箱模型首个 display-list 编译帧经 vanilla Tessellator 流入）
        Placed chest = null;
        for (Placed p : placed) {
            if ("chest".equals(p.kind)) {
                chest = p;
            }
        }
        JsonObject chestCell = new JsonObject();
        if (chest != null) {
            long chestTesr = quadCountAt(diag, "TESR", chest.x, chest.y, chest.z);
            long chestBc = quadCountAt(diag, "BLOCK_COMPILE", chest.x, chest.y, chest.z);
            chestCell.addProperty("x", Integer.valueOf(chest.x));
            chestCell.addProperty("y", Integer.valueOf(chest.y));
            chestCell.addProperty("z", Integer.valueOf(chest.z));
            chestCell.addProperty("tesrQuads", Long.valueOf(chestTesr));
            chestCell.addProperty("blockCompileQuads", Long.valueOf(chestBc));
            expect(checks, chestTesr > 0, "箱格 TESR 通道四边形数>0（实际 " + chestTesr + "）");
        }

        // 判据 4：区块编译窗口开过且有流入
        JsonObject bc = channels.getAsJsonObject("BLOCK_COMPILE");
        long bcWindows = bc.get("windows")
            .getAsLong();
        long bcQuads = bc.get("quads")
            .getAsLong();
        expect(checks, bcWindows > 0, "BLOCK_COMPILE 窗口数>0（实际 " + bcWindows + "）");
        expect(checks, bcQuads > 0, "BLOCK_COMPILE 四边形总数>0（实际 " + bcQuads + "）");

        // 判据 5：坐标系自证日志非空
        int proofLines = diag.getAsJsonArray("selfProofLines")
            .size();
        expect(checks, proofLines > 0, "坐标系自证日志行>0（实际 " + proofLines + "）");

        int failures = countFailures(checks);
        result = baseResult();
        result.add("placement", plan);
        result.add("pipeCells", pipeCells);
        result.add("chestCell", chestCell);
        result.addProperty("directTessellatorHookActive", Boolean.valueOf(hookActive));
        result.addProperty("directTessellatorVertexCount", Long.valueOf(hookCount));
        result.add("checks", checks);
        result.addProperty("status", failures == 0 ? "ok" : "failed");
        result.addProperty("exitCode", Integer.valueOf(failures == 0 ? 0 : 1));
        result.add("diag", diag);
        writeResult(mc);
        cleanupTrigger(mc);
        requestExit(mc, failures == 0 ? 0 : 1);
        phase = Phase.DONE;
    }

    /** 从诊断 quadsByAttr 聚合里取「通道 × 格」的四边形数。 */
    private static long quadCountAt(JsonObject diag, String channel, int x, int y, int z) {
        JsonArray arr = diag.getAsJsonArray("quadsByAttr");
        long total = 0;
        for (int i = 0; i < arr.size(); i++) {
            JsonObject o = arr.get(i)
                .getAsJsonObject();
            if (!channel.equals(
                o.get("channel")
                    .getAsString())) {
                continue;
            }
            if (o.get("x")
                .getAsInt() == x
                && o.get("y")
                    .getAsInt() == y
                && o.get("z")
                    .getAsInt() == z) {
                total += o.get("quads")
                    .getAsLong();
            }
        }
        return total;
    }

    // ------------------------------------------------------------------ 小工具

    /** 把客户端相机对准受控区域中心（yaw/pitch 直接写，含 prev 消抖）。 */
    private static void facePlacedArea(Minecraft mc) {
        double px = mc.thePlayer.posX;
        double py = mc.thePlayer.posY + mc.thePlayer.getEyeHeight();
        double pz = mc.thePlayer.posZ;
        double tx = baseX + 2.0;
        double ty = baseY + 0.5;
        double tz = baseZ + 0.5;
        double dx = tx - px;
        double dy = ty - py;
        double dz = tz - pz;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.atan2(dz, dx) * 180.0 / Math.PI) - 90.0F;
        float pitch = (float) -(Math.atan2(dy, horiz) * 180.0 / Math.PI);
        mc.thePlayer.rotationYaw = yaw;
        mc.thePlayer.prevRotationYaw = yaw;
        mc.thePlayer.rotationPitch = pitch;
        mc.thePlayer.prevRotationPitch = pitch;
    }

    private static EntityPlayerMP serverPlayer() {
        MinecraftServer server = MinecraftServer.getServer();
        if (server == null || server.worldServers.length == 0) {
            return null;
        }
        @SuppressWarnings("unchecked")
        List<EntityPlayerMP> players = server.getConfigurationManager().playerEntityList;
        return players.isEmpty() ? null : players.get(0);
    }

    private static JsonObject baseResult() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.capture-channel-probe/1");
        o.addProperty("label", label);
        o.addProperty("writtenAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        JsonObject base = new JsonObject();
        base.addProperty("x", Integer.valueOf(baseX));
        base.addProperty("y", Integer.valueOf(baseY));
        base.addProperty("z", Integer.valueOf(baseZ));
        o.add("base", base);
        JsonArray warn = new JsonArray();
        for (String w : warnings) {
            warn.add(new com.google.gson.JsonPrimitive(w));
        }
        o.add("warnings", warn);
        return o;
    }

    private static void expect(JsonArray arr, boolean ok, String what) {
        arr.add(new com.google.gson.JsonPrimitive((ok ? "OK: " : "FAIL: ") + what));
    }

    private static int countFailures(JsonArray arr) {
        int n = 0;
        for (int i = 0; i < arr.size(); i++) {
            if (arr.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                n++;
            }
        }
        return n;
    }

    private static void writeResult(Minecraft mc) {
        try {
            Files.write(
                new File(mc.mcDataDir, RESULT_FILE).toPath(),
                result.toString()
                    .getBytes(StandardCharsets.UTF_8));
            FMLLog.info(
                "[SDE][capture-probe] 结果已落盘 %s（status=%s）",
                RESULT_FILE,
                result.get("status")
                    .getAsString());
        } catch (Throwable t) {
            FMLLog.log(Level.WARN, t, "[SDE][capture-probe] 结果落盘失败");
        }
    }

    private static void fatal(Minecraft mc, String kind, String message) {
        FMLLog.warning("[SDE][capture-probe] %s: %s", kind, message);
        result = baseResult();
        if (plan != null) {
            result.add("placement", plan);
        }
        result.addProperty("status", "fatal-" + kind);
        result.addProperty("exitCode", Integer.valueOf(2));
        JsonArray checks = new JsonArray();
        checks.add(new com.google.gson.JsonPrimitive("FAIL: " + kind + ": " + message));
        result.add("checks", checks);
        writeResult(mc);
        cleanupTrigger(mc);
        requestExit(mc, 2);
        phase = Phase.DONE;
    }

    private static void cleanupTrigger(Minecraft mc) {
        if (!cleanupTrigger) {
            return;
        }
        File trig = triggerFile(mc);
        if (trig.isFile() && !trig.delete()) {
            FMLLog.warning("[SDE][capture-probe] 未能删除触发文件: %s", trig.getAbsolutePath());
        }
    }

    private static void requestExit(Minecraft mc, final int code) {
        requestedExitCode = code;
        Thread watchdog = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MS);
                } catch (InterruptedException ignored) {
                    return;
                }
                FMLLog.warning("[SDE][capture-probe] 退出安全网触发，强制 exitJava(%d, true)", Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-capture-channel-probe-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FMLLog.info("[SDE][capture-probe] 请求退出游戏，退出码 %d", Integer.valueOf(code));
        if (code == 0) {
            mc.shutdown();
        } else {
            FMLCommonHandler.instance()
                .exitJava(code, false);
        }
    }

    private static void toPhase(Phase next) {
        phase = next;
        phaseTicks = 0;
        phaseStartedMs = System.currentTimeMillis();
    }
}
