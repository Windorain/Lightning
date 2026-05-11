package com.lightning.mod.client.automation;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.List;
import java.util.Queue;

import net.minecraft.client.AnvilConverterException;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.world.storage.ISaveFormat;
import net.minecraft.world.storage.SaveFormatComparator;

import org.apache.logging.log4j.Level;

import com.lightning.mod.config.SdeAutomationConfig;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import cpw.mods.fml.relauncher.Side;

/**
 * 主菜单自动进入列表首存档；入世界后从配置文件按行发聊天指令；队列耗尽后可选删文件并 shutdown。
 * <p>
 * 为便于无人值守，使用 {@link Minecraft#launchIntegratedServer} 直接加载，不会弹出 Forge
 * {@code GuiOldSaveLoadConfirm}；开发档如需备份提示请改用手动选世界。
 */
public final class SdeClientAutomationTickHandler {

    private boolean autoJoinAttempted;
    private boolean commandFileConsumed;
    /** 仅当启动时指令文件确实存在时才在队列结束后退出并清理，避免「无文件」仍 shutdown。 */
    private boolean shutdownWhenQueueDone;
    private Queue<String> pendingCommands;
    private int ticksUntilNextCommand;
    private boolean loggedMissingFile;
    private boolean automationTerminalHandled;

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent e) {
        if (e.side != Side.CLIENT || e.phase != TickEvent.Phase.END) {
            return;
        }
        if (!SdeAutomationConfig.autoLoadFirstSingleplayerWorld) {
            return;
        }

        Minecraft mc = Minecraft.getMinecraft();

        if (mc.theWorld == null && mc.currentScreen instanceof GuiMainMenu && !autoJoinAttempted) {
            tryAutoJoinFirstWorld(mc);
            return;
        }

        if (mc.theWorld == null || mc.thePlayer == null) {
            return;
        }

        if (!commandFileConsumed) {
            loadCommandFileOnce(mc);
            commandFileConsumed = true;
            ticksUntilNextCommand = 0;
        }

        if (pendingCommands == null) {
            return;
        }

        if (pendingCommands.isEmpty()) {
            finishAutomation(mc);
            return;
        }

        if (ticksUntilNextCommand > 0) {
            ticksUntilNextCommand--;
            return;
        }

        String line = pendingCommands.poll();
        if (line != null) {
            String msg = normalizeChatLine(line);
            FMLLog.info("[SDE] automation chat: %s", msg);
            mc.thePlayer.sendChatMessage(msg);
        }
        ticksUntilNextCommand = Math.max(0, SdeAutomationConfig.commandDelayTicks);
    }

    private void tryAutoJoinFirstWorld(Minecraft mc) {
        autoJoinAttempted = true;
        ISaveFormat loader = mc.getSaveLoader();
        List<?> raw;
        try {
            raw = loader.getSaveList();
        } catch (AnvilConverterException ex) {
            FMLLog.log(Level.WARN, ex, "[SDE] automation: 无法枚举存档列表");
            return;
        }
        if (raw == null || raw.isEmpty()) {
            FMLLog.warning("[SDE] automation: 无存档可加载，跳过自动进档");
            return;
        }
        @SuppressWarnings("unchecked")
        List<SaveFormatComparator> saves = (List<SaveFormatComparator>) (List<?>) raw;
        Collections.sort(saves);

        SaveFormatComparator first = saves.get(0);
        String folder = first.getFileName();
        String display = first.getDisplayName();
        if (display == null || display.isEmpty()) {
            display = folder;
        }
        if (!loader.canLoadWorld(folder)) {
            FMLLog.warning("[SDE] automation: canLoadWorld 为 false: %s", folder);
            return;
        }

        FMLLog.info("[SDE] automation: 正在加载首个存档 folder=%s display=%s", folder, display);
        mc.displayGuiScreen(null);
        try {
            mc.launchIntegratedServer(folder, display, null);
        } catch (Throwable t) {
            FMLLog.log(Level.WARN, t, "[SDE] automation: launchIntegratedServer 失败");
        }
    }

    private void loadCommandFileOnce(Minecraft mc) {
        File path = resolveCommandFile(mc);
        if (!path.isFile()) {
            if (!loggedMissingFile) {
                loggedMissingFile = true;
                FMLLog.info("[SDE] automation: 指令文件不存在，不执行队列且不自动退出: %s", path.getAbsolutePath());
            }
            pendingCommands = new ArrayDeque<>();
            shutdownWhenQueueDone = false;
            return;
        }
        shutdownWhenQueueDone = true;
        try {
            List<String> lines = Files.readAllLines(path.toPath(), StandardCharsets.UTF_8);
            pendingCommands = new ArrayDeque<>();
            for (String line : lines) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith("#")) {
                    continue;
                }
                pendingCommands.add(t);
            }
            FMLLog.info("[SDE] automation: 自 %s 载入 %d 条指令", path.getName(), pendingCommands.size());
        } catch (Exception ex) {
            FMLLog.log(Level.WARN, ex, "[SDE] automation: 读取指令文件失败");
            pendingCommands = new ArrayDeque<>();
            shutdownWhenQueueDone = false;
        }
    }

    private static File resolveCommandFile(Minecraft mc) {
        String p = SdeAutomationConfig.automationCommandFile.trim();
        if (p.isEmpty()) {
            return new File(mc.mcDataDir, "sde_automation_commands.txt");
        }
        File abs = new File(p);
        if (abs.isAbsolute()) {
            return abs;
        }
        return new File(mc.mcDataDir, p);
    }

    private static String normalizeChatLine(String line) {
        String t = line.trim();
        if (t.startsWith("/")) {
            return t;
        }
        return "/" + t;
    }

    private void finishAutomation(Minecraft mc) {
        if (automationTerminalHandled) {
            return;
        }
        automationTerminalHandled = true;

        if (!shutdownWhenQueueDone) {
            return;
        }

        File path = resolveCommandFile(mc);
        if (SdeAutomationConfig.cleanupCommandFileAfterRun && path.isFile()) {
            try {
                if (!path.delete()) {
                    FMLLog.warning("[SDE] automation: 未能删除指令文件: %s", path.getAbsolutePath());
                }
            } catch (Exception ex) {
                FMLLog.log(Level.WARN, ex, "[SDE] automation: 删除指令文件异常");
            }
        }

        if (SdeAutomationConfig.exitGameAfterCommands) {
            FMLLog.info("[SDE] automation: 指令队列已空，退出游戏");
            mc.shutdown();
        }
    }
}
