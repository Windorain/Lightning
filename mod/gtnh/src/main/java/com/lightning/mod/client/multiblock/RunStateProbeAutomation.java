package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.automation.SdeClientAutomationTickHandler;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T0.3 探针的无人值守入口。
 * <p>
 * 触发方式：在 {@code <mcDataDir>} 放一个 {@code sde_runstate_probe.json}，然后 {@code gradlew runClient}。
 * 存在触发文件时本类接管客户端 tick：等游戏到主菜单（或按配置进世界）→ 跑探针 → 结果落盘 → 退出游戏。
 * <strong>全程零人工交互，GUI 可显示但不需要任何点击。</strong>
 * <p>
 * 触发文件内容（全部可选）：
 * 
 * <pre>
 * {
 *   "world": "none",                     // none（默认，主菜单直接跑）| first-save（复用自动化设施进首个存档）
 *   "exit": true,                        // 跑完是否 Minecraft.shutdown()（默认 true）
 *   "cleanupTrigger": true,              // 跑完是否删除触发文件（默认 true）
 *   "targets": [
 *     { "fqcn": "gregtech...MTEElectricBlastFurnace", "plan": "BUILD", "escapeHatch": false },
 *     { "fqcn": "gregtech...MTEExoFoundry",            "plan": "NONE",  "escapeHatch": true  }
 *   ]
 * }
 * </pre>
 * 
 * <strong>为什么默认 {@code world=none}</strong>：探针自带 {@link ProbeDummyWorld}，不需要真实世界；而在本环境里进
 * 现有存档会撞上 FML 的「缺失映射 / ID rematch」{@code StartupQuery} 确认框（它以 GUI 阻塞 Server 线程，而
 * {@code Minecraft.launchIntegratedServer} 又在 Client 线程里 sleep 等世界，二者互等成死锁），并且确认后会改写该存档的
 * 物品 ID 映射表。因此默认不进世界；需要进世界时用 {@code first-save}，并配合 {@code -Dfml.queryResult=confirm} 自动应答。
 * <p>
 * 触发文件不存在时，本类不产生任何行为（既有 {@code /sde export} 与自动化路径逐字节不受影响）。
 */
@SideOnly(Side.CLIENT)
public final class RunStateProbeAutomation {

    private static final String WORLD_MODE_NONE = "none";
    private static final String WORLD_MODE_FIRST_SAVE = "first-save";

    /** 等待主菜单出现的上限（tick）；约 60 s。 */
    private static final int MAX_WAIT_MENU_TICKS = 1200;
    /** 主菜单出现后再等一会儿，让资源（贴图图集）完全就绪。 */
    private static final int MENU_SETTLE_TICKS = 40;
    /** {@code first-save} 模式下等待世界出现的上限（tick）。 */
    private static final int MAX_WAIT_WORLD_TICKS = 1200;
    /** 世界出现后先让它稳定一会儿（tick）。 */
    private static final int WORLD_SETTLE_TICKS = 40;

    private static boolean finished;
    private static int ticks;
    private static int worldTicks;

    private static boolean configLoaded;
    private static boolean exitAfterRun = true;
    private static boolean cleanupTrigger = true;
    private static String worldMode = WORLD_MODE_NONE;
    private static List<ProbeTarget> overrideTargets;
    private static boolean joinAttempted;

    private RunStateProbeAutomation() {}

    /** 触发文件是否存在。仅做一次文件系统探测，开销可忽略。 */
    public static boolean isRequested(Minecraft mc) {
        return mc != null && RunStateProbeRunner.triggerFile(mc)
            .isFile();
    }

    public static void tick(Minecraft mc) {
        if (finished) {
            return;
        }
        ticks++;
        loadConfigOnce(mc);

        boolean inWorld = mc.theWorld != null && mc.thePlayer != null;
        if (inWorld) {
            worldTicks++;
            if (worldTicks < WORLD_SETTLE_TICKS) {
                return;
            }
        } else if (WORLD_MODE_FIRST_SAVE.equals(worldMode)) {
            if (!joinAttempted) {
                joinAttempted = true;
                if (mc.currentScreen instanceof GuiMainMenu) {
                    FMLLog.info("[SDE][T0.3] 无人值守探针：复用自动化设施加载首个存档（world=first-save）");
                    try {
                        mc.displayGuiScreen(null);
                        SdeClientAutomationTickHandler.joinFirstSingleplayerWorld(mc);
                    } catch (Throwable t) {
                        FMLLog.log(Level.WARN, t, "[SDE][T0.3] 自动进档失败，继续等待");
                    }
                } else {
                    FMLLog.info("[SDE][T0.3] 当前不在主菜单，跳过自动进档");
                }
            }
            if (ticks < MAX_WAIT_WORLD_TICKS) {
                return;
            }
            FMLLog.warning("[SDE][T0.3] 等待世界超时（%d tick），改为在主菜单状态执行探针", Integer.valueOf(ticks));
        } else {
            if (!(mc.currentScreen instanceof GuiMainMenu)) {
                if (ticks < MAX_WAIT_MENU_TICKS) {
                    return;
                }
                FMLLog.warning("[SDE][T0.3] 等待主菜单超时（%d tick），直接执行探针", Integer.valueOf(ticks));
            } else if (ticks < MENU_SETTLE_TICKS) {
                return;
            }
        }

        finished = true;
        runOnce(mc);
    }

    private static void loadConfigOnce(Minecraft mc) {
        if (configLoaded) {
            return;
        }
        configLoaded = true;
        File trigger = RunStateProbeRunner.triggerFile(mc);
        try {
            JsonObject cfg = readConfig(trigger);
            if (cfg == null) {
                return;
            }
            if (cfg.has("exit")) {
                exitAfterRun = cfg.get("exit")
                    .getAsBoolean();
            }
            if (cfg.has("cleanupTrigger")) {
                cleanupTrigger = cfg.get("cleanupTrigger")
                    .getAsBoolean();
            }
            if (cfg.has("world")) {
                String w = cfg.get("world")
                    .getAsString();
                if (WORLD_MODE_FIRST_SAVE.equalsIgnoreCase(w) || WORLD_MODE_NONE.equalsIgnoreCase(w)) {
                    worldMode = w.toLowerCase(java.util.Locale.ROOT);
                } else {
                    FMLLog.warning("[SDE][T0.3] 未知 world 模式 %s，回退为 %s", w, WORLD_MODE_NONE);
                }
            }
            overrideTargets = parseTargets(cfg);
        } catch (Throwable t) {
            FMLLog.log(Level.WARN, t, "[SDE][T0.3] 触发文件解析失败，使用默认配置");
        }
    }

    private static void runOnce(Minecraft mc) {
        File trigger = RunStateProbeRunner.triggerFile(mc);
        if (overrideTargets != null && !overrideTargets.isEmpty()) {
            ProbeTarget.defaultsOverride = overrideTargets;
        }

        JsonObject environment = new JsonObject();
        environment.addProperty("worldMode", worldMode);
        environment.addProperty("worldJoined", mc.theWorld != null && mc.thePlayer != null);
        environment.addProperty(
            "currentScreen",
            mc.currentScreen == null ? "null"
                : mc.currentScreen.getClass()
                    .getName());

        try {
            JsonObject result = RunStateProbeRunner.runAndWrite(mc, environment);
            FMLLog.info(
                "[SDE][T0.3] 探针完成：runIndex=%s worldMode=%s 世界已加载=%s 输出=%s",
                String.valueOf(result.get("runIndex")),
                worldMode,
                String.valueOf(environment.get("worldJoined")),
                result.get("runDir")
                    .getAsString());
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][T0.3] 探针执行失败");
            writeFailure(mc, t);
        } finally {
            ProbeTarget.defaultsOverride = null;
            if (cleanupTrigger && trigger.isFile()) {
                if (!trigger.delete()) {
                    FMLLog.warning("[SDE][T0.3] 未能删除触发文件: %s", trigger.getAbsolutePath());
                }
            }
            if (exitAfterRun) {
                FMLLog.info("[SDE][T0.3] 退出游戏");
                mc.shutdown();
            }
        }
    }

    private static JsonObject readConfig(File trigger) throws Exception {
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(trigger), StandardCharsets.UTF_8)) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[2048];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            String text = sb.toString()
                .trim();
            if (text.isEmpty()) {
                return null;
            }
            JsonElement parsed = new JsonParser().parse(text);
            return parsed != null && parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        }
    }

    private static List<ProbeTarget> parseTargets(JsonObject cfg) {
        if (!cfg.has("targets") || !cfg.get("targets")
            .isJsonArray()) {
            return null;
        }
        JsonArray arr = cfg.getAsJsonArray("targets");
        List<ProbeTarget> out = new ArrayList<ProbeTarget>();
        for (JsonElement e : arr) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject o = e.getAsJsonObject();
            String fqcn = o.has("fqcn") ? o.get("fqcn")
                .getAsString() : null;
            if (fqcn == null) {
                continue;
            }
            String simple = fqcn.substring(fqcn.lastIndexOf('.') + 1);
            String planText = o.has("plan") ? o.get("plan")
                .getAsString() : "BUILD";
            ProbeTarget.StructurePlan plan = "NONE".equalsIgnoreCase(planText) ? ProbeTarget.StructurePlan.NONE
                : ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH;
            boolean escape = !o.has("escapeHatch") || o.get("escapeHatch")
                .getAsBoolean();
            ProbeTarget t = ProbeTarget.resolve(fqcn, simple, plan, escape);
            if (t == null) {
                FMLLog.warning("[SDE][T0.3] 触发文件里的目标无法在 METATILEENTITIES 中解析: %s", fqcn);
            } else {
                out.add(t);
            }
        }
        return out;
    }

    private static void writeFailure(Minecraft mc, Throwable t) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("probe", "T0.3 run-state reachability");
            o.addProperty("status", "failed");
            o.addProperty(
                "failure",
                t.getClass()
                    .getName() + ": "
                    + t.getMessage());
            o.addProperty("atEpochMs", System.currentTimeMillis());
            File dir = RunStateProbeRunner.outputDir(mc);
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return;
            }
            RunStateProbeRunner.writeJson(new File(dir, "failure-" + System.currentTimeMillis() + ".json"), o);
        } catch (Throwable ignored) {
            // 失败落盘的二次失败无能为力
        }
    }
}
