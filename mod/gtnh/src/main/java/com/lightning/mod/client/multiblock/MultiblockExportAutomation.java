package com.lightning.mod.client.multiblock;

import java.io.File;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.util.ChatComponentText;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonObject;
import com.lightning.mod.config.SdeMultiblockConfig;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.5 无人值守入口：{@code /sde multiblock} 的**客户端半环**。
 * <p>
 * 两条触发来源共用同一套执行体（{@link MultiblockExportRunner#run(Minecraft, MultiblockExportRunner.RunConfig)}）：
 * <ol>
 * <li><b>触发文件</b>：{@code <mcDataDir>/sde_multiblock.json} 存在 → 等主菜单 → 跑 → 落盘 → 可选退出。
 * 与 T1.2/T1.3 完全同构（挂接点仍在 {@link MultiblockScanAutomation#isRequested/tick}，本类不改
 * {@code client/automation/} 下任何文件）。</li>
 * <li><b>命令</b>：{@code /sde multiblock ...} 在服务端线程把请求写进
 * {@link SdeMultiblockConfig#requestExport}（common 侧，不引用任何 client 类），
 * 客户端 tick 轮询消费后执行。这样 {@code CommandSde} 不必引用 {@code @SideOnly(CLIENT)} 类。</li>
 * </ol>
 * 触发文件不存在且无待执行请求时，本类零行为。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockExportAutomation {

    /** 等待主菜单出现的上限（tick）；约 60 s。 */
    private static final int MAX_WAIT_MENU_TICKS = 1200;
    /** 主菜单出现后再等一会儿，让 GT 注册表与贴图图集完全就绪。 */
    private static final int MENU_SETTLE_TICKS = 60;

    private static boolean finished;
    private static int ticks;

    private MultiblockExportAutomation() {}

    /** 触发文件存在，或命令侧有待执行请求。 */
    public static boolean isRequested(Minecraft mc) {
        if (mc == null) return false;
        return MultiblockExportRunner.triggerFile(mc)
            .isFile() || SdeMultiblockConfig.hasPendingExport();
    }

    public static void tick(Minecraft mc) {
        if (finished) {
            // 命令路径允许同一会话里再跑一次：有待执行请求就重置状态机（否则 finished 会让第二次静默无操作）。
            if (SdeMultiblockConfig.hasPendingExport()) {
                finished = false;
                ticks = 0;
            } else {
                return;
            }
        }
        ticks++;

        // 三种等待语义：
        // ① 主菜单（触发文件模式的常态）：静置 MENU_SETTLE_TICKS 等 GT 注册表与贴图图集就绪；
        // ② 世界里（`/sde multiblock` 命令路径）：注册表/图集早已就绪，**立即执行**，不等 60 s；
        // ③ 其它屏幕（仍在加载）：最多等 MAX_WAIT_MENU_TICKS，超时报 WARN 后照跑（不静默丢弃）。
        if (mc.currentScreen instanceof GuiMainMenu) {
            if (ticks < MENU_SETTLE_TICKS) return;
        } else if (mc.theWorld == null && !SdeMultiblockConfig.hasPendingExport()) {
            if (ticks < MAX_WAIT_MENU_TICKS) return;
            FMLLog.warning("[SDE][T1.5] 等待主菜单超时（%d tick），直接执行多方块导出", Integer.valueOf(ticks));
        }

        finished = true;
        runOnce(mc);
    }

    private static void runOnce(Minecraft mc) {
        SdeMultiblockConfig.Request req = SdeMultiblockConfig.consumePending();
        File trigger = MultiblockExportRunner.triggerFile(mc);
        boolean fromTrigger = req == null && trigger.isFile();
        MultiblockExportRunner.RunConfig rc = fromTrigger ? MultiblockExportRunner.readConfig(mc)
            : new MultiblockExportRunner.RunConfig();
        if (req != null) {
            rc.machines.clear();
            for (String m : SdeMultiblockConfig.parseScope(req.scope)) rc.machines.add(m);
            rc.requestedBy = "command:" + req.requestedBy;
            rc.exit = false;
            rc.cleanupTrigger = false;
        }
        try {
            JsonObject report = MultiblockExportRunner.run(mc, rc);
            String line = "[SDE][T1.5] 导出完成：范围 " + report.get("requestedMachines")
                .getAsInt()
                + " 台 / 产物 "
                + report.get("exportedProducts")
                    .getAsInt()
                + " 份 / 失败 "
                + report.get("failureCount")
                    .getAsInt()
                + " 条 → "
                + report.get("outputDir")
                    .getAsString();
            FMLLog.info("%s", line);
            notify(mc, line);
            if (report.get("failureCount")
                .getAsInt() > 0) {
                notify(
                    mc,
                    "[SDE][T1.5] 失败清单在该目录的 " + MultiblockExportRunner.REPORT_FILE
                        + ".failures[]（不得静默跳过）："
                        + report.getAsJsonArray("failures")
                            .get(0)
                            .getAsJsonObject()
                            .get("machine")
                            .getAsString()
                        + " / "
                        + report.getAsJsonArray("failures")
                            .get(0)
                            .getAsJsonObject()
                            .get("kind")
                            .getAsString()
                        + " 等 "
                        + report.get("failureCount")
                            .getAsInt()
                        + " 条");
            }
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][T1.5] 多方块导出执行失败");
            writeFailure(mc, t);
            notify(mc, "[SDE][T1.5] 导出失败: " + t);
        } finally {
            if (fromTrigger && rc.cleanupTrigger && trigger.isFile()) {
                if (!trigger.delete()) {
                    FMLLog.warning("[SDE][T1.5] 未能删除触发文件: %s", trigger.getAbsolutePath());
                }
            }
            if (fromTrigger && rc.exit) {
                FMLLog.info("[SDE][T1.5] 退出游戏");
                mc.shutdown();
            }
        }
    }

    private static void notify(Minecraft mc, String text) {
        try {
            if (mc.thePlayer != null) mc.thePlayer.addChatMessage(new ChatComponentText(text));
        } catch (Throwable ignored) {
            // 主菜单/无玩家时只落日志
        }
    }

    private static void writeFailure(Minecraft mc, Throwable t) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("task", "T1.5 /sde multiblock export");
            o.addProperty("status", "failed");
            o.addProperty("failure", MultiblockScanAutomation.describeChain(t));
            o.addProperty("atEpochMs", System.currentTimeMillis());
            File dir = new File(mc.mcDataDir, SdeMultiblockConfig.outputDirName);
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            MultiblockExportRunner.writeJson(new File(dir, "failure-" + System.currentTimeMillis() + ".json"), o);
        } catch (Throwable ignored) {
            // 失败落盘的二次失败无能为力
        }
    }
}
