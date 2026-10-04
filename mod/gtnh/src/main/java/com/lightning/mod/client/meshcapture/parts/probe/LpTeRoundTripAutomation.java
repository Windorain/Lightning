package com.lightning.mod.client.meshcapture.parts.probe;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
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

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * Gitea issue #12 端到端验证回路：<strong>真实客户端世界 + 真 LogisticsPipes 管道 TE</strong> 跑
 * {@code /sde export} 同一条捕获路径（{@link MeshCaptureService#finalizeStructureJson}），断言
 * 「导出不改变活动 TE」。
 *
 * <pre>
 * gradlew runClientSdePipeline
 *  → 检测 &lt;mcDataDir&gt;/sde_lp_te_probe.json → 接管客户端 tick：
 *     ① 进专用干净世界（sde_lp_te_probe_world，超平坦/创造，幂等复用）
 *     ② 传送真玩家到基点（客户端要加载该区块才读得到 tile）
 *     ③ 服务端走 LP 自己的放置路径（LogisticsBlockGenericPipe.pipes → createPipe → setBlock
 *        → LogisticsTileGenericPipe.initialize + sendUpdateToClient）放 4 根管道
 *     ④ 等同步 → 前置校验：每根都是真 LP 管道 TE 且 pipe/container 非 null（否则不能断言）
 *     ⑤ 导出前逐管道 writeToNBT 快照
 *     ⑥ 合成 geometryPhase=scan 文档（cellTypes 带 tileNbtB64 —— 缺陷分支进入条件）→
 *        跑真实 finalizeStructureJson（默认副本模式 = 被测修复；-Dsde.teCaptureMode=inplace = 负对照）
 *     ⑦ 真渲染线程自检（hasSpecialRenderer + renderTileEntityAt）——证明缺陷可达
 *     ⑧ runA / runB 两次独立导出 + 导出后快照 + LP 状态
 *     ⑨ <strong>立刻</strong>把断言结果 JSON 写盘（inplace 负对照下客户端可能在 1~2 秒内渲染崩溃，
 *        崩溃在后不丢证据）
 *     ⑩ 退出（0 → mc.shutdown()；非 0 → FMLCommonHandler.exitJava；60 s 安全网）
 * </pre>
 *
 * <p>
 * 触发文件（全部可选）：{@code {"label":"...", "cleanupTrigger":true, "syncWaitTicks":60,
 * "clearBeforePlace":true, "selfCheck":true, "baseX":64,"baseY":12,"baseZ":64}}。
 * 触发文件不存在时本类<strong>零行为变化</strong>。
 *
 * <p>
 * 与既有探针的边界：本类不依赖 P0.2/P1.7 的任何状态，独立触发文件、独立世界目录、独立结果文件；
 * 在 {@code SdeClientAutomationTickHandler} 里排在其它探针<strong>之前</strong>，避免与它们抢世界。
 */
@SideOnly(Side.CLIENT)
public final class LpTeRoundTripAutomation {

    private static final String TRIGGER_FILE = "sde_lp_te_probe.json";
    private static final String RESULT_FILE = "sde_lp_te_probe_result.json";
    private static final String WORLD_FOLDER = "sde_lp_te_probe_world";
    private static final String WORLD_DISPLAY = "SDE LP TE Probe World";

    private static final long TOTAL_TIMEOUT_MS = 12L * 60L * 1000L;
    private static final long PHASE_TIMEOUT_MS = 4L * 60L * 1000L;
    private static final long EXIT_WATCHDOG_MS = 60L * 1000L;

    /** 崩溃特征行（issue #12 那 8 条警告即此，见侦察报告 §1.5）。 */
    private static final String LP_FAILURE_MARKER = "MeshCaptureBlockPostRenderRegistry: strategy";

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

    /** 探针主体分步（每步一个 tick，避免长 tick 交错崩溃证据；也贴近 issue #12「崩溃在导出后 1~2 秒」的时序）。 */
    private enum Step {
        PRE,
        SELFCHECK,
        RUN_A,
        SNAP_AFTER_A,
        RUN_B,
        FINAL,
        DONE
    }

    /** 一根已放置的管道（服务端放置，客户端同步后读取）。 */
    private static final class Pipe {

        final int x;
        final int y;
        final int z;
        final String label;
        final String itemRegistry;
        final String pipeClass;

        Pipe(int x, int y, int z, String label, String itemRegistry, String pipeClass) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.label = label;
            this.itemRegistry = itemRegistry;
            this.pipeClass = pipeClass;
        }
    }

    private static boolean active;
    private static boolean finalized;
    private static Phase phase = Phase.INIT;
    private static Step step = Step.PRE;
    private static long startedMs;
    private static long phaseStartedMs;
    private static int phaseTicks;

    private static String label = "lp-te-probe";
    private static boolean cleanupTrigger = true;
    private static int worldSettleTicks = 40;
    private static int chunkWaitTicks = 60;
    private static int syncWaitTicks = 60;
    private static boolean clearBeforePlace = true;
    private static boolean selfCheck = true;
    /**
     * 捕获完成后继续跑多少 tick 再退出（默认 0 = 立刻退出）。
     * <p>
     * issue #12 的崩溃发生在「导出结束、正常渲染恢复」之后 1~2 秒 —— 探针若立刻 shutdown 就永远看不到
     * 客户端崩溃。负对照想复现崩溃必须把这个值调大（脚本默认给 100 tick ≈ 5 s）。
     */
    private static int postCaptureDwellTicks;
    private static int dwellLeft;
    private static int baseX = 64;
    private static int baseY = 12;
    private static int baseZ = 64;

    private static final List<Pipe> pipes = new ArrayList<Pipe>();
    private static final List<String> warnings = new ArrayList<String>();
    private static JsonObject result;
    private static JsonObject plan;
    private static JsonArray checks;
    private static JsonObject capture;
    private static JsonArray snapshotBefore;
    private static JsonArray snapshotAfterA;
    private static JsonArray snapshotAfterFinal;
    private static byte[] runABytes;
    private static byte[] runBBytes;

    private LpTeRoundTripAutomation() {}

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
                FMLLog.info("[SDE][issue-12] 已补设 -Dfml.queryResult=confirm（进程内兜底）");
            }
            installCrashRecorder();
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ 崩溃记录

    private static volatile String lastUncaughtThrowable;
    private static volatile String uncaughtThreadName;
    private static volatile int requestedExitCode = -1;

    /**
     * 记录未捕获异常（客户端渲染线程致命异常只有这个全局钩子能收到）与我们自己的非零退出码 ——
     * issue #12 的崩溃发生在渲染线程（{@code RenderGlobal.renderEntities}），探针自身捕获不到它。
     */
    private static void installCrashRecorder() {
        try {
            Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {

                @Override
                public void uncaughtException(Thread thread, Throwable e) {
                    lastUncaughtThrowable = PartsProbeReflect.describe(e);
                    uncaughtThreadName = thread == null ? "<null>" : thread.getName();
                    FMLLog.log(
                        Level.ERROR,
                        "[SDE][issue-12] 未捕获异常（崩溃证据）thread=%s: %s",
                        uncaughtThreadName,
                        lastUncaughtThrowable);
                }
            });
            Runtime.getRuntime()
                .addShutdownHook(new Thread(new Runnable() {

                    @Override
                    public void run() {
                        // 退出路径留痕：结果 JSON 写盘时进程还没退出，故这里再写一份极小的退出标记，
                        // 供外层脚本对账「探针自己请求的退出码」，并与进程实际退出码交叉验证。
                        try {
                            JsonObject o = new JsonObject();
                            o.addProperty("schema", "lightning.lp-te-probe-exit/1");
                            o.addProperty("requestedExitCode", requestedExitCode);
                            o.addProperty("exitFileWrittenAtEpochMs", Long.valueOf(System.currentTimeMillis()));
                            o.addProperty(
                                "uncaughtThrowable",
                                lastUncaughtThrowable == null ? "" : lastUncaughtThrowable);
                            o.addProperty(
                                "uncaughtThrowableThread",
                                uncaughtThreadName == null ? "" : uncaughtThreadName);
                            o.addProperty("postCaptureDwellTicks", Integer.valueOf(postCaptureDwellTicks));
                            o.addProperty("dwellLeftAtExit", Integer.valueOf(dwellLeft));
                            Files.write(
                                new File(Minecraft.getMinecraft().mcDataDir, "sde_lp_te_probe_exit.json").toPath(),
                                gsonBytes(o));
                        } catch (Throwable ignored) {
                            // 退出路径上的写出失败不影响判据
                        }
                    }
                }, "sde-lp-te-probe-exit-recorder"));
        } catch (Throwable t) {
            warnings.add("崩溃记录器安装失败（不影响断言）: " + PartsProbeReflect.describe(t));
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
                    fatal(mc, "PhaseTimeout", "阶段 " + phase + "/" + step + " 超时 " + (now - phaseStartedMs) + " ms");
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
                    probeStep(mc);
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
            if (o.has("worldSettleTicks")) {
                worldSettleTicks = o.get("worldSettleTicks")
                    .getAsInt();
            }
            if (o.has("chunkWaitTicks")) {
                chunkWaitTicks = o.get("chunkWaitTicks")
                    .getAsInt();
            }
            if (o.has("syncWaitTicks")) {
                syncWaitTicks = o.get("syncWaitTicks")
                    .getAsInt();
            }
            if (o.has("clearBeforePlace")) {
                clearBeforePlace = o.get("clearBeforePlace")
                    .getAsBoolean();
            }
            if (o.has("selfCheck")) {
                selfCheck = o.get("selfCheck")
                    .getAsBoolean();
            }
            if (o.has("postCaptureDwellTicks")) {
                postCaptureDwellTicks = o.get("postCaptureDwellTicks")
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
        FMLLog.info(
            "[SDE][issue-12] LP 管道 TE NBT 往返探针启动 label=%s 基点=(%d,%d,%d) teCaptureMode=%s LP版本=%s",
            label,
            Integer.valueOf(baseX),
            Integer.valueOf(baseY),
            Integer.valueOf(baseZ),
            effectiveTeCaptureMode(),
            LpPipeReflect.lpVersion());
        toPhase(Phase.JOIN);
    }

    /**
     * 本进程内 {@code MeshCaptureService} 实际会走的分支。
     * <p>
     * 注意 {@code MeshCaptureService.TE_CAPTURE_INPLACE} 是 {@code static final}（类初始化时定值），
     * 因此这里用同一口径复算用于落盘核对：探针<strong>不能</strong>运行期切换模式，负对照必须是独立进程
     * （{@code -Dsde.teCaptureMode=inplace}）。
     */
    private static String effectiveTeCaptureMode() {
        return "inplace".equals(
            System.getProperty("sde.teCaptureMode", "copy")
                .trim()
                .toLowerCase(Locale.ROOT)) ? "inplace" : "copy";
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
            FMLLog.info("[SDE][issue-12] 复用专用世界 %s", WORLD_FOLDER);
            mc.launchIntegratedServer(WORLD_FOLDER, WORLD_DISPLAY, null);
        } else {
            FMLLog.info("[SDE][issue-12] 新建专用世界 %s（超平坦 + 创造 + 允许命令）", WORLD_FOLDER);
            WorldSettings ws = new WorldSettings(
                20261004L,
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
            "[SDE][issue-12] 已进入世界: %s",
            String.valueOf(
                mc.theWorld.getWorldInfo()
                    .getWorldName()));
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
        player.setPositionAndUpdate(baseX + 0.5, baseY + 3.0, baseZ + 0.5);
        FMLLog.info("[SDE][issue-12] 已传送玩家 %s 到基点", player.getCommandSenderName());
        toPhase(Phase.PLACE);
    }

    /** 在服务端世界走 LP 自己的放置路径放管道。 */
    private static void place(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < chunkWaitTicks) {
            return;
        }
        MinecraftServer server = MinecraftServer.getServer();
        WorldServer world = server.worldServers[0];
        pipes.clear();
        plan = new JsonObject();

        try {
            List<LpPipeReflect.PipeItem> items = LpPipeReflect.listPipeItems();
            plan.add("registeredPipeItems", LpPipeReflect.itemsToJson(items));
            LpPipeReflect.PipeItem basic = LpPipeReflect
                .pickPipeItem(items, "PipeItemsBasicLogistics", "BasicLogistics", "PipeBasicLogistics", "Basic");
            LpPipeReflect.PipeItem satellite = LpPipeReflect
                .pickPipeItem(items, "PipeItemsSatelliteLogistics", "Satellite");
            if (basic == null) {
                throw new IllegalStateException(
                    "没有任何注册管道物品的 pipe 类名含 BasicLogistics/Basic（候选 " + LpPipeReflect.itemsToJson(items) + "）");
            }
            if (satellite == null) {
                warnings.add("未找到 Satellite 管道物品（issue #12 崩溃报告的 PipeItemsSatelliteLogistics）：退化为全部基础物流管");
                satellite = basic;
            }
            plan.add("chosenBasic", basic.toJson());
            plan.add("chosenSatellite", satellite.toJson());

            String[] labels = { "basic-logistics-1", "basic-logistics-2", "satellite-logistics-1",
                "satellite-logistics-2" };
            LpPipeReflect.PipeItem[] chosen = { basic, basic, satellite, satellite };
            for (int i = 0; i < labels.length; i++) {
                int x = baseX + 1 + i;
                int y = baseY;
                int z = baseZ;
                if (clearBeforePlace) {
                    for (int dy = -1; dy <= 2; dy++) {
                        world.setBlockToAir(x, y + dy, z);
                    }
                }
                TileEntity te = LpPipeReflect.placePipe(world, chosen[i].item, x, y, z);
                Object pipe = LpPipeReflect.pipeOf(te);
                JsonObject p = new JsonObject();
                p.addProperty("label", labels[i]);
                p.addProperty("x", Integer.valueOf(x));
                p.addProperty("y", Integer.valueOf(y));
                p.addProperty("z", Integer.valueOf(z));
                p.addProperty("itemRegistry", chosen[i].registryName);
                p.addProperty("placedPipeClass", LpPipeReflect.pipeClassOfPipe(pipe));
                p.addProperty("serverPipeNonNull", Boolean.valueOf(pipe != null));
                p.addProperty("serverContainerNonNull", Boolean.valueOf(LpPipeReflect.containerOf(pipe) != null));
                plan.add("placed" + i, p);
                if (pipe == null) {
                    throw new IllegalStateException("服务端放置后 " + labels[i] + " 的 pipe 为 null（放置路径未生效）");
                }
                pipes.add(new Pipe(x, y, z, labels[i], chosen[i].registryName, LpPipeReflect.pipeClassOfPipe(pipe)));
            }
            world.markBlockRangeForRenderUpdate(
                baseX,
                baseY - 1,
                baseZ,
                baseX + labels.length + 1,
                baseY + 2,
                baseZ + 1);
            plan.addProperty("placedCount", Integer.valueOf(pipes.size()));
        } catch (Throwable t) {
            plan.addProperty("error", PartsProbeReflect.describe(t));
            warnings.add("LP 放置失败: " + PartsProbeReflect.describe(t));
            result = baseResult();
            result.add("placement", plan);
            result.addProperty("status", "placement-failed");
            result.addProperty("exitCode", Integer.valueOf(3));
            result.add("checks", checksOf("FAIL: LP 管道放置失败（被测对象不存在，不能断言）"));
            writeResultAndArtifacts(mc);
            cleanupTrigger(mc);
            requestExit(mc, 3);
            phase = Phase.DONE;
            return;
        }
        FMLLog.info("[SDE][issue-12] LP 管道放置完成：%d 根（服务端）", Integer.valueOf(pipes.size()));
        toPhase(Phase.WAIT_SYNC);
    }

    private static void waitSync(Minecraft mc) {
        phaseTicks++;
        if (phaseTicks < syncWaitTicks) {
            return;
        }
        toPhase(Phase.PROBE);
    }

    // ------------------------------------------------------------------ 探针主体（分步）

    private static void probeStep(Minecraft mc) {
        World clientWorld = mc.theWorld;
        if (clientWorld == null) {
            fatal(mc, "NoClientWorld", "mc.theWorld == null（捕获硬编码需要真客户端世界）");
            return;
        }
        if (step == Step.DONE) {
            // 捕获完成后的「停留」：issue #12 的崩溃发生在导出结束、正常渲染恢复后 1~2 秒，
            // 立刻 shutdown 会让复现永远看不到崩溃（负对照靠这段停留把崩溃暴露出来）。
            if (dwellLeft > 0) {
                dwellLeft--;
                if (dwellLeft == 0) {
                    FMLLog.info("[SDE][issue-12] 捕获后停留 %d tick 结束（期间未崩溃）", Integer.valueOf(postCaptureDwellTicks));
                    finish(mc, requestedExitCode);
                }
            }
            return;
        }
        switch (step) {
            case PRE:
                stepPre(mc, clientWorld);
                break;
            case SELFCHECK:
                stepSelfCheck(mc, clientWorld);
                break;
            case RUN_A:
                stepRunA(mc, clientWorld);
                break;
            case SNAP_AFTER_A:
                stepSnapAfterA(mc, clientWorld);
                break;
            case RUN_B:
                stepRunB(mc, clientWorld);
                break;
            case FINAL:
                stepFinal(mc, clientWorld);
                break;
            default:
                break;
        }
    }

    /** 步骤 PRE：被测对象前置校验 + 导出前快照 + 文档落盘。 */
    private static void stepPre(Minecraft mc, World clientWorld) {
        result = baseResult();
        checks = new JsonArray();
        capture = new JsonObject();
        result.add("placement", plan);

        JsonArray preStates = new JsonArray();
        int preOk = 0;
        int tesrCount = 0;
        for (Pipe p : pipes) {
            TileEntity te = clientWorld.getTileEntity(p.x, p.y, p.z);
            JsonObject s = LpPipeReflect.stateOf(te);
            s.addProperty("label", p.label);
            s.addProperty("x", Integer.valueOf(p.x));
            s.addProperty("y", Integer.valueOf(p.y));
            s.addProperty("z", Integer.valueOf(p.z));
            s.addProperty("serverPipeClass", p.pipeClass);
            boolean bound = te != null && LpPipeReflect.isLpTile(te)
                && LpPipeReflect.pipeOf(te) != null
                && LpPipeReflect.containerOf(LpPipeReflect.pipeOf(te)) != null;
            if (bound) {
                preOk++;
            }
            if (s.get("tesrRegistered")
                .getAsBoolean()) {
                tesrCount++;
            }
            preStates.add(s);
        }
        result.add("clientStateBeforeCapture", preStates);

        if (preOk != pipes.size()) {
            // 被测对象没到位 ⇒ 直接判失败退出（不能拿「没触发缺陷」冒充修复有效）
            expect(
                checks,
                false,
                "被测对象前置条件：每根管道在客户端都是真 LP 管道 TE 且 pipe/container 非 null（" + preOk + "/" + pipes.size() + "）");
            result.add("checks", checks);
            result.addProperty("status", "precondition-failed");
            result.addProperty("exitCode", Integer.valueOf(3));
            result.addProperty("failedChecks", Integer.valueOf(countFailures(checks)));
            result.addProperty("pass", Boolean.FALSE);
            FMLLog.log(
                Level.ERROR,
                "[SDE][issue-12] 前置条件不成立（真 LP 管道 TE 未就绪）：%s/%s",
                Integer.valueOf(preOk),
                Integer.valueOf(pipes.size()));
            finish(mc, 3);
            return;
        }
        expect(
            checks,
            true,
            "被测对象前置条件：每根管道在客户端都是真 LP 管道 TE 且 pipe/container 非 null（" + preOk + "/" + pipes.size() + "）");

        snapshotBefore = snapshotPipeTiles(clientWorld);
        result.add("snapshotBefore", snapshotBefore);
        result.addProperty("tesrRegisteredCount", Integer.valueOf(tesrCount));

        JsonObject scanDoc = buildScanDocument(clientWorld);
        result.add("scanDocumentCellTypes", scanDoc.getAsJsonArray("cellTypes"));
        writeArtifact(mc, artifactName("scan"), gsonBytes(scanDoc));
        pendingScanDoc = scanDoc;
        FMLLog.info(
            "[SDE][issue-12] 前置校验通过（%d 根管道，TESR %d 根），快照已取，scan 文档含 tileNbtB64",
            Integer.valueOf(preOk),
            Integer.valueOf(tesrCount));
        step = Step.SELFCHECK;
    }

    private static JsonObject pendingScanDoc;

    /**
     * 步骤 SELFCHECK：在真渲染线程上用 TE 自己的 TESR 渲染一次。
     * <p>
     * 这不是断言本体，而是「缺陷确实可达」的独立证据：若被捕获的 LP 管道根本没有注册 TESR，
     * 那么无论修没修都不会有机会去碰那个 NPE —— 那样断言 5 的「无策略失败」就说明不了问题。
     * 自检会临时把 {@code staticPlayerX/Y/Z} 移到该格（与 {@link
     * com.lightning.mod.client.meshcapture.postrender.TileEntitySpecialRendererPostRenderStrategy}
     * 同一手法），只读渲染，不写世界。
     */
    private static void stepSelfCheck(Minecraft mc, World clientWorld) {
        JsonArray selfChecks = new JsonArray();
        if (!selfCheck) {
            selfChecks.add(new JsonPrimitive("skipped: 触发文件 selfCheck=false"));
            result.add("selfCheck", selfChecks);
            step = Step.RUN_A;
            return;
        }
        int rendered = 0;
        int failed = 0;
        for (Pipe p : pipes) {
            TileEntity te = clientWorld.getTileEntity(p.x, p.y, p.z);
            JsonObject o = new JsonObject();
            o.addProperty("label", p.label);
            boolean has = LpPipeReflect.hasSpecialRenderer(te);
            o.addProperty("hasSpecialRenderer", Boolean.valueOf(has));
            if (!has) {
                selfChecks.add(o);
                continue;
            }
            double spx = net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerX;
            double spy = net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerY;
            double spz = net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerZ;
            try {
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerX = p.x;
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerY = p.y;
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerZ = p.z;
                // 与捕获路径同一开关：开启动态扩展顶点录制，才能量到该 TESR 实际写了多少顶点
                int quadsBefore = com.lightning.mod.client.meshcapture.TessellatorCaptureState
                    .currentBlockRecordedQuadCount();
                com.lightning.mod.client.meshcapture.TessellatorCaptureState.beginDynamicExtensionVertexPhase();
                try {
                    net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.instance.renderTileEntityAt(
                        te,
                        (double) te.xCoord
                            - net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerX,
                        (double) te.yCoord
                            - net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerY,
                        (double) te.zCoord
                            - net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerZ,
                        0.0F);
                } finally {
                    com.lightning.mod.client.meshcapture.TessellatorCaptureState.endDynamicExtensionVertexPhase();
                }
                int quadsAfter = com.lightning.mod.client.meshcapture.TessellatorCaptureState
                    .currentBlockRecordedQuadCount();
                rendered++;
                o.addProperty("render", "ok");
                o.addProperty("tesrQuadsBefore", Integer.valueOf(quadsBefore));
                o.addProperty("tesrQuadsAfter", Integer.valueOf(quadsAfter));
                o.addProperty("tesrQuadsDelta", Integer.valueOf(quadsAfter - quadsBefore));
                o.addProperty(
                    "pipeBound",
                    Boolean.valueOf(LpPipeReflect.containerOf(LpPipeReflect.pipeOf(te)) != null));
            } catch (Throwable t) {
                failed++;
                o.addProperty("render", "throw");
                o.addProperty("renderError", PartsProbeReflect.describe(t));
                warnings.add("TESR 自检渲染失败 " + p.label + ": " + PartsProbeReflect.describe(t));
            } finally {
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerX = spx;
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerY = spy;
                net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.staticPlayerZ = spz;
            }
            selfChecks.add(o);
        }
        result.add("selfCheck", selfChecks);
        FMLLog.info("[SDE][issue-12] TESR 自检：ok=%d throw=%d", Integer.valueOf(rendered), Integer.valueOf(failed));
        step = Step.RUN_A;
    }

    /** 步骤 RUN_A：第一次真实捕获（被测路径）。 */
    private static void stepRunA(Minecraft mc, World clientWorld) {
        JsonObject snap = captureFailureSnapshot();
        int before = snap.get("failureCount")
            .getAsInt();
        // 逐格主批次诊断（只观测+原样委派默认路径，见 LpPrimaryCaptureProbeStrategy）
        LpPrimaryCaptureProbeStrategy.begin("logisticspipes.pipes.basic.LogisticsBlockGenericPipe");
        long t0 = System.currentTimeMillis();
        Throwable err = null;
        try {
            MeshCaptureService.finalizeStructureJson(pendingScanDoc);
        } catch (Throwable t) {
            err = t;
        }
        long ms = System.currentTimeMillis() - t0;
        JsonObject after = captureFailureSnapshot();
        result.add("primaryCaptureDiagnostics", LpPrimaryCaptureProbeStrategy.end());
        capture.addProperty("runAElapsedMs", Long.valueOf(ms));
        capture.addProperty(
            "runAFailureDelta",
            Integer.valueOf(
                after.get("failureCount")
                    .getAsInt() - before));
        capture.addProperty(
            "runALogFile",
            after.get("logFile")
                .getAsString());
        if (err != null) {
            capture.addProperty("runAError", PartsProbeReflect.describe(err));
            warnings.add("捕获 runA 抛异常: " + PartsProbeReflect.describe(err));
        }
        // 抛异常时也落盘文档（能否产出产物本身就是一条证据）
        runABytes = gsonBytes(pendingScanDoc);
        writeArtifact(mc, artifactName("export"), runABytes);
        FMLLog.info(
            "[SDE][issue-12] runA 捕获完成：%d ms，策略失败 +%d%s",
            Long.valueOf(ms),
            Integer.valueOf(
                capture.get("runAFailureDelta")
                    .getAsInt()),
            err == null ? "" : "（抛异常 " + PartsProbeReflect.describe(err) + "）");
        step = Step.SNAP_AFTER_A;
    }

    /** 步骤 SNAP_AFTER_A：runA 后的快照 —— 这是负对照「TE 被改坏」的第一现场。 */
    private static void stepSnapAfterA(Minecraft mc, World clientWorld) {
        snapshotAfterA = snapshotPipeTiles(clientWorld);
        result.add("snapshotAfterRunA", snapshotAfterA);
        int broken = 0;
        int nbtDrift = 0;
        for (int i = 0; i < snapshotBefore.size(); i++) {
            JsonObject b = snapshotBefore.get(i)
                .getAsJsonObject();
            JsonObject a = snapshotAfterA.get(i)
                .getAsJsonObject();
            boolean nbtSame = b.get("nbtSha256")
                .getAsString()
                .equals(
                    a.get("nbtSha256")
                        .getAsString());
            boolean containerSame = b.get("containerNonNull")
                .getAsBoolean()
                == a.get("containerNonNull")
                    .getAsBoolean();
            if (!containerSame) {
                broken++;
            }
            if (!nbtSame) {
                nbtDrift++;
            }
        }
        // 立刻落盘（负对照下 container=null 会在下一次 TE tick 触发 NPE，崩溃随时到来）
        result.add("checks", checks);
        result.add("capture", capture);
        result.addProperty("status", "in-progress");
        result.addProperty("exitCode", Integer.valueOf(2));
        writeResultAndArtifacts(mc);
        FMLLog.info(
            "[SDE][issue-12] runA 后：container 变化 %d 根，NBT 漂移 %d 根（证据已落盘）",
            Integer.valueOf(broken),
            Integer.valueOf(nbtDrift));
        step = Step.RUN_B;
    }

    /** 步骤 RUN_B：第二次独立捕获（幂等 + 「捕获后的世界再捕获」对照）。 */
    private static void stepRunB(Minecraft mc, World clientWorld) {
        JsonObject snap = captureFailureSnapshot();
        int before = snap.get("failureCount")
            .getAsInt();
        JsonObject docB = buildScanDocument(clientWorld);
        long t0 = System.currentTimeMillis();
        Throwable err = null;
        try {
            MeshCaptureService.finalizeStructureJson(docB);
        } catch (Throwable t) {
            err = t;
        }
        long ms = System.currentTimeMillis() - t0;
        JsonObject after = captureFailureSnapshot();
        capture.addProperty("runBElapsedMs", Long.valueOf(ms));
        capture.addProperty(
            "runBFailureDelta",
            Integer.valueOf(
                after.get("failureCount")
                    .getAsInt() - before));
        if (err != null) {
            capture.addProperty("runBError", PartsProbeReflect.describe(err));
        }
        runBBytes = gsonBytes(docB);
        writeArtifact(mc, artifactName("export-runB"), runBBytes);
        FMLLog.info(
            "[SDE][issue-12] runB 捕获完成：%d ms，策略失败 +%d",
            Long.valueOf(ms),
            Integer.valueOf(
                capture.get("runBFailureDelta")
                    .getAsInt()));
        step = Step.FINAL;
    }

    /** 步骤 FINAL：导出后状态 + 全部断言 + 结果落盘 + 退出。 */
    private static void stepFinal(Minecraft mc, World clientWorld) {
        snapshotAfterFinal = snapshotPipeTiles(clientWorld);
        result.add("snapshotAfter", snapshotAfterFinal);

        JsonArray postStates = new JsonArray();
        int postOk = 0;
        for (Pipe p : pipes) {
            TileEntity te = clientWorld.getTileEntity(p.x, p.y, p.z);
            JsonObject s = LpPipeReflect.stateOf(te);
            s.addProperty("label", p.label);
            boolean bound = te != null && LpPipeReflect.isLpTile(te)
                && LpPipeReflect.pipeOf(te) != null
                && LpPipeReflect.containerOf(LpPipeReflect.pipeOf(te)) != null;
            s.addProperty("bound", Boolean.valueOf(bound));
            if (bound) {
                postOk++;
            }
            postStates.add(s);
        }
        result.add("clientStateAfterCapture", postStates);

        // ---- 断言 1：逐管道 writeToNBT 字节一致 ----
        JsonArray teCmp = new JsonArray();
        boolean allSame = true;
        for (int i = 0; i < snapshotBefore.size(); i++) {
            JsonObject b = snapshotBefore.get(i)
                .getAsJsonObject();
            JsonObject a = snapshotAfterFinal.get(i)
                .getAsJsonObject();
            boolean nbtSame = b.get("nbtSha256")
                .getAsString()
                .equals(
                    a.get("nbtSha256")
                        .getAsString());
            boolean pipeSame = b.get("pipeClass")
                .getAsString()
                .equals(
                    a.get("pipeClass")
                        .getAsString());
            boolean containerSame = b.get("containerNonNull")
                .getAsBoolean()
                == a.get("containerNonNull")
                    .getAsBoolean();
            boolean bytesSame = b.get("nbtBytes")
                .getAsInt()
                == a.get("nbtBytes")
                    .getAsInt();
            boolean ok = nbtSame && pipeSame && containerSame && bytesSame;
            allSame = allSame && ok;
            JsonObject d = new JsonObject();
            d.addProperty(
                "label",
                b.get("label")
                    .getAsString());
            d.addProperty(
                "nbtSha256Before",
                b.get("nbtSha256")
                    .getAsString());
            d.addProperty(
                "nbtSha256After",
                a.get("nbtSha256")
                    .getAsString());
            d.addProperty("nbtSame", Boolean.valueOf(nbtSame));
            d.addProperty("nbtBytesSame", Boolean.valueOf(bytesSame));
            d.addProperty("pipeClassSame", Boolean.valueOf(pipeSame));
            d.addProperty("containerSame", Boolean.valueOf(containerSame));
            d.addProperty("ok", Boolean.valueOf(ok));
            teCmp.add(d);
        }
        result.add("teByteComparison", teCmp);
        expect(
            checks,
            // 注意：运行期 gson 是 MC 1.7.10 自带的 2.2.4（JsonArray.isEmpty() 到 2.8.2 才加入），
            // 故一律用 size() 判空 —— 实测 isEmpty() 会抛 NoSuchMethodError。
            allSame && snapshotBefore.size() > 0,
            "断言1：导出后每个管道活动 TE 的 writeToNBT 快照与导出前逐字节一致（N=" + snapshotBefore.size() + "）");

        // ---- 断言 2：pipe != null && pipe.container != null ----
        expect(
            checks,
            postOk == pipes.size(),
            "断言2：导出后反射读 LogisticsTileGenericPipe.pipe != null 且 pipe.container != null（" + postOk
                + "/"
                + pipes.size()
                + "）");

        // ---- 断言 3：产物含管道格 + 几何非空 ----
        JsonObject artifact = new JsonObject();
        boolean hasPipes = false;
        boolean geometryNonEmpty = false;
        try {
            JsonObject rootA = parse(runABytes);
            hasPipes = documentHasPipeCells(rootA, artifact);
            geometryNonEmpty = documentGeometryNonEmpty(rootA, artifact);
            artifact.addProperty("runASha256", sha256Hex(runABytes));
        } catch (Throwable t) {
            artifact.addProperty("artifactAError", PartsProbeReflect.describe(t));
        }
        if (runBBytes != null) {
            try {
                artifact.addProperty("runBSha256", sha256Hex(runBBytes));
                artifact
                    .addProperty("runAEqualsRunB", Boolean.valueOf(sha256Hex(runABytes).equals(sha256Hex(runBBytes))));
            } catch (Throwable t) {
                artifact.addProperty("artifactBError", PartsProbeReflect.describe(t));
            }
        }
        result.add("artifact", artifact);
        expect(checks, hasPipes, "断言3a：导出产物 blockPalette/cellGrid 含 LP 管道格");
        expect(checks, geometryNonEmpty, "断言3b：导出产物中管道格的几何非空（quads > 0）");

        // ---- 断言 4：捕获期策略失败 / 未捕获异常 ----
        int totalFailures = intOf(capture, "runAFailureDelta") + intOf(capture, "runBFailureDelta");
        expect(
            checks,
            totalFailures == 0,
            "断言4a：捕获期没有 MeshCaptureBlockPostRenderRegistry 策略失败（" + totalFailures + " 条）");
        expect(
            checks,
            lastUncaughtThrowable == null,
            "断言4b：捕获期没有未捕获异常（客户端渲染线程 NPE 即此）"
                + (lastUncaughtThrowable == null ? "" : "：[" + uncaughtThreadName + "] " + lastUncaughtThrowable));

        // ---- 断言 5：TESR 自检确实把 LP 管道渲染过（缺陷可达性前提）----
        JsonArray selfChecksArr = result.has("selfCheck") ? result.getAsJsonArray("selfCheck") : new JsonArray();
        int selfRendered = 0;
        int selfThrew = 0;
        for (int i = 0; i < selfChecksArr.size(); i++) {
            JsonObject o = selfChecksArr.get(i)
                .getAsJsonObject();
            if (o.has("render")) {
                if ("ok".equals(
                    o.get("render")
                        .getAsString())) {
                    selfRendered++;
                } else {
                    selfThrew++;
                }
            }
        }
        expect(
            checks,
            selfCheck ? (selfRendered == pipes.size()) : true,
            "断言5：真渲染线程 TESR 自检对每根管道渲染成功（" + selfRendered
                + "/"
                + pipes.size()
                + "，throw "
                + selfThrew
                + "）—— 证明缺陷路径可达、断言 4 有意义");

        result.add("checks", checks);
        int failed = countFailures(checks);
        result.addProperty("failedChecks", Integer.valueOf(failed));
        result.addProperty("pass", Boolean.valueOf(failed == 0));
        result.addProperty("status", failed == 0 ? "ok" : "has-failures");
        result.addProperty("exitCode", Integer.valueOf(failed == 0 ? 0 : 2));
        result.add("capture", capture);

        FMLLog.info(
            "[SDE][issue-12] LP 管道 TE 往返探针完成 mode=%s pass=%s failedChecks=%d",
            effectiveTeCaptureMode(),
            Boolean.valueOf(failed == 0),
            Integer.valueOf(failed));
        finish(mc, failed == 0 ? 0 : 2);
    }

    /**
     * 结果落盘 → 删触发文件 → 退出。
     * <p>
     * 若配了 {@code postCaptureDwellTicks > 0}，则<strong>先停留</strong>再退出 —— 让 issue #12 的
     * 「导出后 1~2 秒渲染 NPE 崩溃」有机会发生（崩溃会由全局未捕获异常钩子记录）。
     */
    private static void finish(Minecraft mc, int code) {
        writeResultAndArtifacts(mc);
        cleanupTrigger(mc);
        if (postCaptureDwellTicks > 0 && dwellLeft <= 0 && requestedExitCode < 0) {
            dwellLeft = postCaptureDwellTicks;
            requestedExitCode = code;
            step = Step.DONE;
            FMLLog.info(
                "[SDE][issue-12] 断言已落盘；捕获后停留 %d tick 观察渲染崩溃（issue #12 崩溃窗口）",
                Integer.valueOf(postCaptureDwellTicks));
            return;
        }
        requestExit(mc, code);
        step = Step.DONE;
    }

    // ------------------------------------------------------------------ 日志计数

    /**
     * 从日志文件数策略失败行数。
     * <p>
     * 捕获本身只经 {@code FMLLog.warning} 报错（{@code MeshCaptureBlockPostRenderRegistry} 吞异常，
     * 进程内没有计数器可读），故日志是唯一可读点；判据是「捕获前后差值」，不受历史行干扰。
     */
    private static JsonObject captureFailureSnapshot() {
        JsonObject o = new JsonObject();
        int failures = 0;
        File log = currentLogFile();
        if (log != null && log.isFile()) {
            try {
                List<String> lines = Files.readAllLines(log.toPath(), StandardCharsets.ISO_8859_1);
                for (String line : lines) {
                    if (line.contains(LP_FAILURE_MARKER)) {
                        failures++;
                    }
                }
            } catch (Throwable ignored) {
                // 日志不可读时计数保持 0；结果 JSON 里会写明 logFile 路径，不静默改判据
            }
        }
        o.addProperty("failureCount", Integer.valueOf(failures));
        o.addProperty("logFile", log == null ? "<unresolved>" : log.getAbsolutePath());
        return o;
    }

    /** 定位当前客户端日志（1.7.10 FML 写 {@code logs/fml-client-latest.log}）。 */
    private static File currentLogFile() {
        Minecraft mc = Minecraft.getMinecraft();
        if (mc == null) {
            return null;
        }
        String[] names = { "logs/fml-client-latest.log", "logs/latest.log", "logs/client.log" };
        for (String n : names) {
            File f = new File(mc.mcDataDir, n);
            if (f.isFile()) {
                return f;
            }
        }
        return null;
    }

    private static int intOf(JsonObject o, String key) {
        return o != null && o.has(key) ? o.get(key)
            .getAsInt() : 0;
    }

    // ------------------------------------------------------------------ 快照 / 扫描文档

    /** 逐管道活动 TE 的 writeToNBT 快照（gzip 字节的 SHA-256 + 字节数 + LP 绑定状态）。 */
    private static JsonArray snapshotPipeTiles(World world) {
        JsonArray arr = new JsonArray();
        for (Pipe p : pipes) {
            JsonObject o = new JsonObject();
            o.addProperty("label", p.label);
            o.addProperty("x", Integer.valueOf(p.x));
            o.addProperty("y", Integer.valueOf(p.y));
            o.addProperty("z", Integer.valueOf(p.z));
            TileEntity te = world.getTileEntity(p.x, p.y, p.z);
            if (te == null) {
                o.addProperty("missing", Boolean.TRUE);
                o.addProperty("nbtSha256", "<missing>");
                o.addProperty("nbtBytes", Integer.valueOf(-1));
                o.addProperty("pipeClass", "<null>");
                o.addProperty("containerNonNull", Boolean.FALSE);
                arr.add(o);
                continue;
            }
            String sha = "<error>";
            int bytes = -1;
            try {
                byte[] raw = nbtBytes(te);
                sha = sha256Hex(raw);
                bytes = raw.length;
            } catch (Throwable t) {
                o.addProperty("nbtError", PartsProbeReflect.describe(t));
            }
            o.addProperty(
                "teClass",
                te.getClass()
                    .getName());
            o.addProperty("nbtSha256", sha);
            o.addProperty("nbtBytes", Integer.valueOf(bytes));
            Object pipe = LpPipeReflect.pipeOf(te);
            o.addProperty(
                "pipeClass",
                pipe == null ? "<null>"
                    : pipe.getClass()
                        .getName());
            o.addProperty("containerNonNull", Boolean.valueOf(LpPipeReflect.containerOf(pipe) != null));
            arr.add(o);
        }
        return arr;
    }

    /** TE.writeToNBT → gzip → 字节（与扫描文档 {@code tileNbtB64} 同口径）。 */
    private static byte[] nbtBytes(TileEntity te) throws Exception {
        NBTTagCompound tag = new NBTTagCompound();
        te.writeToNBT(tag);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        CompressedStreamTools.writeCompressed(tag, bos);
        return bos.toByteArray();
    }

    private static String b64Gzip(NBTTagCompound tag) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        CompressedStreamTools.writeCompressed(tag, bos);
        return Base64.getEncoder()
            .encodeToString(bos.toByteArray());
    }

    /**
     * 合成 {@code geometryPhase=scan} 文档：{@code cellTypes} 每根管道都带 {@code tileNbtB64}
     * （= base64+gzip 的 {@code writeToNBT} 结果）——<strong>这是进入缺陷分支（{@code vs.tileNbt != null}）
     * 的必要条件</strong>，现有 {@code PartsExportProbe} 只写 registryId/meta，故从未触发过该分支
     * （侦察报告 §0.2）。
     *
     * <p>
     * 结构形状 1×1×N：col i 对应管道 i；worldGrid 指向真实客户端世界坐标。
     */
    private static JsonObject buildScanDocument(World world) {
        JsonArray cellTypes = new JsonArray();
        JsonObject air = new JsonObject();
        air.addProperty("registryId", "air");
        air.addProperty("meta", Integer.valueOf(0));
        cellTypes.add(air);

        JsonArray colArr = new JsonArray();
        JsonArray wColArr = new JsonArray();
        for (Pipe p : pipes) {
            TileEntity te = world.getTileEntity(p.x, p.y, p.z);
            Block b = world.getBlock(p.x, p.y, p.z);
            int meta = world.getBlockMetadata(p.x, p.y, p.z);
            String reg = Block.blockRegistry.getNameForObject(b);
            JsonObject t = new JsonObject();
            t.addProperty("registryId", reg == null ? "air" : reg);
            t.addProperty("meta", Integer.valueOf(meta));
            if (te != null) {
                try {
                    NBTTagCompound tag = new NBTTagCompound();
                    te.writeToNBT(tag);
                    t.addProperty("tileNbtB64", b64Gzip(tag));
                } catch (Throwable ex) {
                    warnings.add("管道 " + p.label + " 的 tileNbtB64 生成失败: " + PartsProbeReflect.describe(ex));
                }
            }
            cellTypes.add(t);
            colArr.add(new JsonPrimitive(Integer.valueOf(cellTypes.size() - 1)));
            JsonObject w = new JsonObject();
            w.addProperty("x", Integer.valueOf(p.x));
            w.addProperty("y", Integer.valueOf(p.y));
            w.addProperty("z", Integer.valueOf(p.z));
            wColArr.add(w);
        }

        JsonArray rows = new JsonArray();
        rows.add(colArr);
        JsonArray wRows = new JsonArray();
        wRows.add(wColArr);
        JsonArray cellGrid = new JsonArray();
        cellGrid.add(rows);
        JsonArray worldGrid = new JsonArray();
        worldGrid.add(wRows);

        JsonObject root = new JsonObject();
        root.addProperty("geometryPhase", "scan");
        root.add("cellTypes", cellTypes);
        root.add("cellGrid", cellGrid);
        root.add("worldGrid", worldGrid);
        return root;
    }

    // ------------------------------------------------------------------ 产物断言

    /**
     * 产物里「管道格」的识别：按 <strong>cellGrid 的列位置</strong>映射回我们放置的管道坐标
     * （col i ↔ pipes[i]），不看注册名大小写 —— 实测 LP 注册名是
     * {@code LogisticsPipes:logisticsPipeBlock}（大写 P），按小写子串匹配会漏。
     */
    private static boolean documentHasPipeCells(JsonObject root, JsonObject report) {
        try {
            JsonArray palette = root.getAsJsonArray("blockPalette");
            JsonArray grid = root.getAsJsonArray("cellGrid");
            JsonArray row = grid.get(0)
                .getAsJsonArray()
                .get(0)
                .getAsJsonArray();
            JsonArray slotRegs = new JsonArray();
            int nonAir = 0;
            for (int i = 0; i < row.size(); i++) {
                int slot = row.get(i)
                    .getAsInt();
                String reg = "<air>";
                if (slot > 0 && slot < palette.size()) {
                    JsonObject e = palette.get(slot)
                        .getAsJsonObject();
                    reg = e.get("registryId")
                        .getAsString();
                    if (e.has("nbt")) {
                        // 记录该槽位是否带 NBT（LP 管道的 NBT 会进 blockPalette）
                    }
                    nonAir++;
                }
                slotRegs.add(new JsonPrimitive(slot + ":" + reg));
            }
            JsonArray paletteRegs = new JsonArray();
            for (int i = 0; i < palette.size(); i++) {
                paletteRegs.add(
                    new JsonPrimitive(
                        palette.get(i)
                            .getAsJsonObject()
                            .get("registryId")
                            .getAsString()));
            }
            report.add("cellSlots", slotRegs);
            report.add("paletteRegistryIds", paletteRegs);
            report.addProperty("nonAirCells", Integer.valueOf(nonAir));
            report.addProperty("expectedPipeCells", Integer.valueOf(pipes.size()));
            return nonAir == pipes.size();
        } catch (Throwable t) {
            report.addProperty("hasPipeCellsError", PartsProbeReflect.describe(t));
            return false;
        }
    }

    /** 产物中管道槽位的几何是否非空（quads 数）。 */
    private static boolean documentGeometryNonEmpty(JsonObject root, JsonObject report) {
        try {
            JsonArray palette = root.getAsJsonArray("blockPalette");
            JsonArray grid = root.getAsJsonArray("cellGrid");
            JsonArray row = grid.get(0)
                .getAsJsonArray()
                .get(0)
                .getAsJsonArray();
            int pipeQuads = 0;
            int totalQuads = 0;
            JsonArray perCell = new JsonArray();
            for (int i = 0; i < row.size(); i++) {
                int slot = row.get(i)
                    .getAsInt();
                int q = 0;
                String reg = "<air>";
                if (slot > 0 && slot < palette.size()) {
                    JsonObject e = palette.get(slot)
                        .getAsJsonObject();
                    reg = e.get("registryId")
                        .getAsString();
                    q = countQuads(e);
                    pipeQuads += q;
                }
                totalQuads += q;
                perCell.add(new JsonPrimitive("col" + i + " slot=" + slot + " quads=" + q + " reg=" + reg));
            }
            report.add("cellQuads", perCell);
            report.addProperty("totalQuads", Integer.valueOf(totalQuads));
            report.addProperty("logisticsQuads", Integer.valueOf(pipeQuads));
            return pipeQuads > 0;
        } catch (Throwable t) {
            report.addProperty("geometryError", PartsProbeReflect.describe(t));
            return false;
        }
    }

    private static int countQuads(JsonObject paletteEntry) {
        if (!paletteEntry.has("geometry")) {
            return 0;
        }
        try {
            JsonObject geo = paletteEntry.getAsJsonObject("geometry");
            if (geo.has("quads")) {
                return geo.getAsJsonArray("quads")
                    .size();
            }
        } catch (Throwable ignored) {
            return 0;
        }
        return 0;
    }

    // ------------------------------------------------------------------ 收尾

    private static JsonObject baseResult() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.lp-te-probe-result/1");
        o.addProperty("issue", "Gitea #12：/sde export 对活动 TE 的 NBT 往返改坏 LP 管道（pipe.container=null）");
        o.addProperty("label", label);
        o.addProperty("teCaptureMode", effectiveTeCaptureMode());
        o.addProperty("teCaptureModeProperty", System.getProperty("sde.teCaptureMode", "<unset>"));
        o.addProperty("lpVersion", LpPipeReflect.lpVersion());
        o.addProperty("startedAtEpochMs", Long.valueOf(startedMs));
        o.addProperty("generatedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        return o;
    }

    private static JsonArray checksOf(String single) {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(single));
        return a;
    }

    private static void expect(JsonArray arr, boolean ok, String what) {
        arr.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
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

    /** 结果 JSON 立刻写盘（负对照下崩溃随时可能发生，先落盘再谈退出）。 */
    private static void writeResultAndArtifacts(Minecraft mc) {
        if (result == null) {
            result = baseResult();
        }
        if (lastUncaughtThrowable != null) {
            result.addProperty("uncaughtThrowable", lastUncaughtThrowable);
            result.addProperty("uncaughtThrowableThread", uncaughtThreadName);
        }
        result.add("warnings", toJsonArray(warnings));
        result.addProperty("generatedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        collectCrashReports(mc, result);
        try {
            Files.write(new File(mc.mcDataDir, RESULT_FILE).toPath(), gsonBytes(result));
            FMLLog.info(
                "[SDE][issue-12] 结果落盘 %s status=%s exitCode=%s",
                RESULT_FILE,
                result.get("status"),
                result.get("exitCode"));
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][issue-12] 结果写出失败");
        }
    }

    /** 收集本轮新生成的 crash-report 文件名（崩溃证据；issue #12 的成因即渲染 NPE 崩溃）。 */
    private static void collectCrashReports(Minecraft mc, JsonObject out) {
        try {
            File dir = new File(mc.mcDataDir, "crash-reports");
            if (!dir.isDirectory()) {
                return;
            }
            File[] files = dir.listFiles();
            if (files == null) {
                return;
            }
            JsonArray arr = new JsonArray();
            for (File f : files) {
                if (f.isFile() && f.lastModified() >= startedMs) {
                    arr.add(new JsonPrimitive(f.getName()));
                }
            }
            out.add("newCrashReports", arr);
        } catch (Throwable t) {
            warnings.add("crash-reports 扫描失败: " + PartsProbeReflect.describe(t));
        }
    }

    private static void fatal(Minecraft mc, String kind, String message) {
        FMLLog.log(Level.ERROR, "[SDE][issue-12] 探针致命失败 [%s] %s", kind, message);
        warnings.add("FATAL " + kind + ": " + message);
        if (result == null) {
            result = baseResult();
        }
        result.addProperty("fatal", kind + ": " + message);
        result.addProperty("status", "fatal");
        result.addProperty("exitCode", Integer.valueOf(3));
        JsonArray arr = checks == null ? new JsonArray() : checks;
        arr.add(new JsonPrimitive("FAIL: FATAL " + kind + " - " + message));
        result.add("checks", arr);
        result.addProperty("failedChecks", Integer.valueOf(countFailures(arr)));
        result.addProperty("pass", Boolean.FALSE);
        writeResultAndArtifacts(mc);
        cleanupTrigger(mc);
        requestExit(mc, 3);
        step = Step.DONE;
        phase = Phase.DONE;
    }

    private static void cleanupTrigger(Minecraft mc) {
        if (!cleanupTrigger) {
            return;
        }
        File trig = triggerFile(mc);
        if (trig.isFile() && !trig.delete()) {
            FMLLog.warning("[SDE][issue-12] 未能删除触发文件: %s", trig.getAbsolutePath());
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
                FMLLog.warning("[SDE][issue-12] 退出安全网触发，强制 exitJava(%d, true)", Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-lp-te-probe-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FMLLog.info("[SDE][issue-12] 请求退出游戏，退出码 %d", Integer.valueOf(code));
        if (code == 0) {
            mc.shutdown();
        } else {
            FMLCommonHandler.instance()
                .exitJava(code, false);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static void toPhase(Phase next) {
        FMLLog.info("[SDE][issue-12] 阶段 %s → %s", phase, next);
        phase = next;
        phaseStartedMs = System.currentTimeMillis();
        phaseTicks = 0;
        step = Step.PRE;
    }

    private static String artifactName(String kind) {
        return "sde_lp_te_probe_" + kind + ".json";
    }

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .create();

    private static JsonObject parse(byte[] bytes) {
        return new JsonParser().parse(new String(bytes, StandardCharsets.UTF_8))
            .getAsJsonObject();
    }

    private static byte[] gsonBytes(JsonObject o) {
        return PRETTY.toJson(o)
            .getBytes(StandardCharsets.UTF_8);
    }

    private static void writeArtifact(Minecraft mc, String name, byte[] bytes) {
        try {
            Files.write(new File(mc.mcDataDir, name).toPath(), bytes);
        } catch (Throwable t) {
            FMLLog.warning("[SDE][issue-12] 产物写出失败 %s: %s", name, String.valueOf(t));
        }
    }

    private static String readText(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static JsonArray toJsonArray(List<String> list) {
        JsonArray a = new JsonArray();
        for (String s : list) {
            a.add(new JsonPrimitive(s));
        }
        return a;
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
