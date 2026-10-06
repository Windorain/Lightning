package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 世界进出机（跨 tick 状态机）。
 *
 * <h2>离开</h2>
 * {@code mc.loadWorld(null)} 是原版「保存并退到标题」的同一路径：它会 {@code initiateShutdown()} 集成服
 * 并<b>阻塞</b>等待服务端线程停机（世界已保存、region 文件句柄已释放），之后才允许动存档目录。
 * 因此 {@link #ensureLeft} 在返回 true 之前还会再等 {@link #UNLOAD_SETTLE_TICKS} 个 tick。
 *
 * <h2>进入</h2>
 * 新建世界走 {@code WorldSettings(seed, CREATIVE, mapFeatures=false, hardcore=false, FLAT)} +
 * {@link VoidWorldPreset#GENERATOR_OPTIONS}（全虚空）+ {@code enableCommands()}，再
 * {@code launchIntegratedServer}；已存在的存档走 {@code launchIntegratedServer(folder, display, null)}
 * （1.7.10 会从 {@code level.dat} 还原 {@code WorldInfo}，含种子与 generatorOptions）。
 *
 * <p>
 * 进入判据（三者同时成立）：{@code mc.theWorld != null}、{@code mc.currentScreen == null}、
 * 服务端世界与服务端玩家都已就位；随后做 {@link WorldRuntime#stabilizePlayer} 稳定化
 * （虚空世界里不这么做，玩家会直接坠出世界）。
 */
public final class WorldLoader {

    /** 离开世界后额外等待的 tick 数（等文件句柄释放）。 */
    public static final int UNLOAD_SETTLE_TICKS = 3;

    private final String folder;
    private final String displayName;
    private final Long seed;
    private final int[] base;

    private boolean launched;
    private int unloadSettleLeft;
    private int stabilizeTicks;
    private int waitTicks;

    /**
     * @param folder      托管世界目录名
     * @param displayName 展示名（仅新世界用到）
     * @param seed        新建世界用的种子；null 表示复用现有存档（种子从 level.dat 还原）
     * @param base        构建基点（玩家稳定化用）；可为 null
     */
    public WorldLoader(String folder, String displayName, Long seed, int[] base) {
        this.folder = folder;
        this.displayName = displayName == null || displayName.isEmpty() ? folder : displayName;
        this.seed = seed;
        this.base = base == null ? null : base.clone();
    }

    /** 目标目录名。 */
    public String folder() {
        return folder;
    }

    /** 进入世界后已等待的 tick 数（诊断用）。 */
    public int waitTicks() {
        return waitTicks;
    }

    /**
     * 离开当前世界（幂等）。
     *
     * @return true 表示已不在任何世界里且存档已落盘
     * @throws CpException CP-EXEC-001 离开过程异常
     */
    public boolean ensureLeft(Minecraft mc) {
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        if (mc.theWorld == null) {
            if (unloadSettleLeft > 0) {
                unloadSettleLeft--;
                return false;
            }
            // H2 读数点（默认关闭，-Dsde.cp.buildDiag=on；出处 #89 评论 1685）：会话内第二次重建时
            // 服务端线程是否还活着、有没有残留的 "Server thread"——旧实例没退役就会与新世界抢 chunk。
            if (BuildDiagnostics.diagEnabled()) {
                MinecraftServer server = null;
                String running;
                try {
                    server = MinecraftServer.getServer();
                    running = server == null ? "<server=null>" : String.valueOf(server.isServerRunning());
                } catch (Throwable t) {
                    running = "<err:" + t + ">";
                }
                int serverThreads = -1;
                try {
                    serverThreads = 0;
                    for (Thread th : Thread.getAllStackTraces()
                        .keySet()) {
                        String name = th == null ? null : th.getName();
                        if (name != null && name.contains("Server thread")) {
                            serverThreads++;
                        }
                    }
                } catch (Throwable t) {
                    serverThreads = -1;
                }
                CpLog.info(
                    "离开世界完成读数（H2）：server=%s isServerRunning=%s 存活 \"Server thread\" 线程数=%s",
                    server == null ? "null" : "id=" + System.identityHashCode(server),
                    running,
                    serverThreads < 0 ? "<统计失败>" : Integer.toString(serverThreads));
            }
            return true;
        }
        CpLog.info("离开当前世界（%s）…", String.valueOf(WorldDescriber.currentFolder(mc)));
        try {
            mc.displayGuiScreen(null);
            mc.loadWorld(null);
        } catch (Throwable t) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "离开世界失败: " + t);
        }
        try {
            mc.displayGuiScreen(new GuiMainMenu());
        } catch (Throwable t) {
            CpLog.warn("回到主菜单失败: %s", String.valueOf(t));
        }
        try {
            if (mc.getSaveLoader() != null) {
                mc.getSaveLoader()
                    .flushCache();
            }
        } catch (Throwable t) {
            CpLog.warn("flushCache 失败: %s", String.valueOf(t));
        }
        launched = false;
        stabilizeTicks = 0;
        waitTicks = 0;
        unloadSettleLeft = UNLOAD_SETTLE_TICKS;
        CpLog.info("已离开世界，等待 %d tick 让存档落盘", Integer.valueOf(UNLOAD_SETTLE_TICKS));
        return false;
    }

    /**
     * 进入目标世界（跨 tick）。
     *
     * @return 完成时的世界描述；未完成返回 null
     * @throws CpException CP-STATE-001 已在别的世界；CP-EXEC-001 启动失败
     */
    public JsonObject ensureEntered(Minecraft mc) {
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        if (!launched) {
            if (mc.theWorld != null) {
                // 服务端权威优先：客户端 WorldClient 的目录名是占位 "none"，拿它比会永远不等
                String cur = WorldDescriber.currentFolder(mc);
                if (folder.equals(cur)) {
                    launched = true; // 已在目标世界（按段续跑场景）
                } else {
                    throw new CpException(
                        ErrorCodes.STATE,
                        "已在其它世界 " + cur + "，请先离开（world.rebuild/world.rollback 会自行离开）",
                        Json.object("current", String.valueOf(cur), "expected", folder));
                }
            } else {
                launch(mc);
            }
        }
        waitTicks++;
        if (mc.theWorld == null) {
            return null;
        }
        if (mc.currentScreen != null) {
            return null; // 仍在加载界面（GuiDownloadTerrain 等）
        }
        if (!WorldRuntime.sceneReady(mc)) {
            return null; // 服务端世界或玩家尚未就位
        }
        WorldRuntime.stabilizePlayer(base);
        stabilizeTicks++;
        if (stabilizeTicks < WorldRuntime.STABILIZE_TICKS) {
            return null;
        }
        CpLog.info(
            "已进入世界 %s（等待 %d tick，服务端世界就位）",
            String.valueOf(WorldDescriber.currentFolder(mc)),
            Integer.valueOf(waitTicks));
        // H1/H2 共用读数（默认关闭，-Dsde.cp.buildDiag=on；出处 #89 评论 1685）：第二次进入时
        // serverWorld/server 的实例 hash 是否与第一次相同——换实例 = 旧对象被替换，不换 = 旧对象复用。
        if (BuildDiagnostics.diagEnabled()) {
            WorldServer serverWorld = WorldRuntime.serverWorld();
            MinecraftServer server = WorldRuntime.server();
            CpLog.info(
                "进入世界读数（H1/H2 共用）：folder=%s serverWorld=%s server=%s（与首次进入比对是否换了实例）",
                folder,
                serverWorld == null ? "null" : "id=" + System.identityHashCode(serverWorld),
                server == null ? "null" : "id=" + System.identityHashCode(server));
        }
        return WorldDescriber.describe(mc);
    }

    private void launch(Minecraft mc) {
        WorldSettings settings = null;
        if (seed != null) {
            settings = new WorldSettings(
                seed.longValue(),
                WorldSettings.GameType.CREATIVE,
                false,
                false,
                WorldType.FLAT);
            settings.func_82750_a(VoidWorldPreset.GENERATOR_OPTIONS);
            settings.enableCommands();
        }
        CpLog.info(
            "启动集成服世界 folder=%s display=%s seed=%s void=%s",
            folder,
            displayName,
            seed == null ? "(level.dat)" : seed.toString(),
            seed == null ? "(level.dat)" : VoidWorldPreset.GENERATOR_OPTIONS);
        try {
            mc.displayGuiScreen(null);
            mc.launchIntegratedServer(folder, displayName, settings);
        } catch (Throwable t) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "launchIntegratedServer 失败: " + folder + " / " + t);
        }
        launched = true;
        waitTicks = 0;
        stabilizeTicks = 0;
    }
}
