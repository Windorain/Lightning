package com.lightning.mod.client.multiblock;

import java.io.File;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonObject;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.2 多方块扫描的无人值守入口。
 * <p>
 * 触发方式：在 {@code <mcDataDir>} 放一个 {@code sde_multiblock_scan.json}，然后 {@code gradlew runClient}。
 * 存在触发文件时本类接管客户端 tick：等游戏到主菜单 → 跑扫描 → 结果落盘 → 退出游戏。
 * <strong>全程零人工交互，GUI 可显示但不需要任何点击。</strong>
 * <p>
 * 触发文件内容（全部可选）：
 * 
 * <pre>
 * {
 *   "channels": true,               // 是否探测通道（默认 true）
 *   "tiers": true,                  // 是否探测总 Tier（默认 true）
 *   "limit": -1,                    // 只探测前 N 台（-1 = 全量）
 *   "onlyClasses": ["MTEElectricBlastFurnace"],   // 只探测指定类（简单名或全限定名）
 *   "perMachineBudgetMs": 30000,    // 单台预算
 *   "globalBudgetMs": 900000,       // 整轮预算
 *   "exit": true,                   // 跑完是否 Minecraft.shutdown()（默认 true）
 *   "cleanupTrigger": true          // 跑完是否删除触发文件（默认 true）
 * }
 * </pre>
 * 
 * <b>为什么不进世界</b>：与 T0.3 同因（probe-run-state.md §4.4）—— 本环境既有存档含缺失模组，进档会与 FML
 * {@code StartupQuery} 确认框互锁并改写存档。扫描自带 {@link ProbeDummyWorld}，不需要真实世界。
 * 触发文件不存在时本类不产生任何行为，既有 {@code /sde export} 与自动化路径逐字节不受影响。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockScanAutomation {

    /** 等待主菜单出现的上限（tick）；约 60 s。 */
    private static final int MAX_WAIT_MENU_TICKS = 1200;
    /** 主菜单出现后再等一会儿，让 GT 注册表与贴图图集完全就绪。 */
    private static final int MENU_SETTLE_TICKS = 60;

    private static boolean finished;
    private static int ticks;

    private MultiblockScanAutomation() {}

    /** 触发文件是否存在。仅做一次文件系统探测，开销可忽略。 */
    public static boolean isRequested(Minecraft mc) {
        return mc != null && MultiblockScanRunner.triggerFile(mc)
            .isFile();
    }

    public static void tick(Minecraft mc) {
        if (finished) return;
        ticks++;

        if (!(mc.currentScreen instanceof GuiMainMenu)) {
            if (ticks < MAX_WAIT_MENU_TICKS) return;
            FMLLog.warning("[SDE][T1.2] 等待主菜单超时（%d tick），直接执行扫描", Integer.valueOf(ticks));
        } else if (ticks < MENU_SETTLE_TICKS) {
            return;
        }

        finished = true;
        runOnce(mc);
    }

    private static void runOnce(Minecraft mc) {
        File trigger = MultiblockScanRunner.triggerFile(mc);
        MultiblockScanRunner.Config cfg = MultiblockScanRunner.readConfig(mc);
        try {
            JsonObject summary = MultiblockScanRunner.run(mc);
            FMLLog.info(
                "[SDE][T1.2] 扫描完成：枚举 %s / 探测 %s，失败 %s，machines=%s",
                String.valueOf(summary.get("enumeratedTotal")),
                String.valueOf(summary.get("probedCount")),
                String.valueOf(summary.get("failureCount")),
                String.valueOf(summary.get("machinesJsonSha256")));
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][T1.2] 扫描执行失败");
            writeFailure(mc, t);
        } finally {
            if (cfg.cleanupTrigger && trigger.isFile()) {
                if (!trigger.delete()) {
                    FMLLog.warning("[SDE][T1.2] 未能删除触发文件: %s", trigger.getAbsolutePath());
                }
            }
            if (cfg.exit) {
                FMLLog.info("[SDE][T1.2] 退出游戏");
                mc.shutdown();
            }
        }
    }

    private static void writeFailure(Minecraft mc, Throwable t) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("probe", "T1.2 multiblock enumeration + channel/tier probe");
            o.addProperty("status", "failed");
            o.addProperty("failure", describeChain(t));
            o.addProperty("atEpochMs", System.currentTimeMillis());
            File dir = MultiblockScanRunner.outputDir(mc);
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            ScanJson.write(new File(dir, "failure-" + System.currentTimeMillis() + ".json"), o);
        } catch (Throwable ignored) {
            // 失败落盘的二次失败无能为力
        }
    }

    /** 异常链 + 栈顶若干帧写成一段文本：失败必须可诊断，不能只留一句「失败了」。 */
    static String describeChain(Throwable t) {
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
}
