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
 * T1.3 变体捕获的无人值守入口。
 * <p>
 * 触发方式：在 {@code <mcDataDir>} 放一个 {@code sde_variant_capture.json}，然后 {@code gradlew runClient}。
 * 存在触发文件时接管客户端 tick：等游戏到主菜单 → 跑捕获 → 结果落盘 → {@code Minecraft.shutdown()}。
 * <strong>全程零人工交互（GUI 可显示但不需要任何点击）。</strong>
 * <p>
 * 触发文件内容（全部可选，见 {@link VariantCaptureRunner.Config}）：
 *
 * <pre>
 * {
 *   "machines": ["MTEBrickedBlastFurnace"],  // 目标机（simpleName 或 fqcn）；空 = 4 台默认代表机
 *   "limitPerMachine": -1,                   // 调试：每台只跑前 N 个 (tier × 取值组合) 单元
 *   "maxVariantsPerMachine": 2000,           // 超过则按契约 tierSample 语义抽样并写进产物 notes
 *   "includeThumbnails": true,
 *   "embedTextures": true,
 *   "factsPath": "",                         // 覆盖 T1.2 machines.json 路径
 *   "exit": true,
 *   "cleanupTrigger": true
 * }
 * </pre>
 *
 * <b>本类不改 {@code client/automation/} 下任何文件</b>：T1.2 已经把「触发文件 → 接管本 tick」的挂接点放在
 * {@link MultiblockScanAutomation} 上（那也是 {@code client/multiblock/} 包内的文件），本类只是让那个挂接点
 * 多认识一个触发文件（见 {@code MultiblockScanAutomation#isRequested/tick} 的 3 行分派）。触发文件不存在时零行为。
 */
@SideOnly(Side.CLIENT)
public final class VariantCaptureAutomation {

    /** 等待主菜单出现的上限（tick）；约 60 s。 */
    private static final int MAX_WAIT_MENU_TICKS = 1200;
    /** 主菜单出现后再等一会儿，让 GT 注册表与贴图图集完全就绪。 */
    private static final int MENU_SETTLE_TICKS = 60;

    private static boolean finished;
    private static int ticks;

    private VariantCaptureAutomation() {}

    public static boolean isRequested(Minecraft mc) {
        return mc != null && VariantCaptureRunner.triggerFile(mc)
            .isFile();
    }

    public static void tick(Minecraft mc) {
        if (finished) return;
        ticks++;

        if (!(mc.currentScreen instanceof GuiMainMenu)) {
            if (ticks < MAX_WAIT_MENU_TICKS) return;
            FMLLog.warning("[SDE][T1.3] 等待主菜单超时（%d tick），直接执行变体捕获", Integer.valueOf(ticks));
        } else if (ticks < MENU_SETTLE_TICKS) {
            return;
        }

        finished = true;
        runOnce(mc);
    }

    private static void runOnce(Minecraft mc) {
        File trigger = VariantCaptureRunner.triggerFile(mc);
        VariantCaptureRunner.Config cfg = VariantCaptureRunner.readConfig(mc);
        try {
            JsonObject report = VariantCaptureRunner.run(mc);
            FMLLog.info(
                "[SDE][T1.3] 变体捕获完成：%s 台 / %s 变体，调色板 %s 条，失败 %s，输出 %s",
                String.valueOf(
                    report.getAsJsonObject("totals")
                        .get("machines")),
                String.valueOf(
                    report.getAsJsonObject("totals")
                        .get("variants")),
                String.valueOf(
                    report.getAsJsonObject("totals")
                        .get("paletteEntries")),
                String.valueOf(
                    report.getAsJsonObject("totals")
                        .get("failureCount")),
                String.valueOf(report.get("runDir")));
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][T1.3] 变体捕获执行失败");
            writeFailure(mc, t);
        } finally {
            if (cfg.cleanupTrigger && trigger.isFile()) {
                if (!trigger.delete()) {
                    FMLLog.warning("[SDE][T1.3] 未能删除触发文件: %s", trigger.getAbsolutePath());
                }
            }
            if (cfg.exit) {
                FMLLog.info("[SDE][T1.3] 退出游戏");
                mc.shutdown();
            }
        }
    }

    private static void writeFailure(Minecraft mc, Throwable t) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("task", "T1.3 variant build + geometry capture");
            o.addProperty("status", "failed");
            o.addProperty("failure", MultiblockScanAutomation.describeChain(t));
            o.addProperty("atEpochMs", System.currentTimeMillis());
            File dir = VariantCaptureRunner.outputDir(mc);
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            ScanJson.write(new File(dir, "failure-" + System.currentTimeMillis() + ".json"), o);
        } catch (Throwable ignored) {
            // 失败落盘的二次失败无能为力
        }
    }
}
