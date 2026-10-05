package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiChat;
import net.minecraft.client.gui.GuiIngameMenu;
import net.minecraft.client.gui.GuiScreen;

/**
 * 场景会话守卫（#55 坑 11 防护）。
 *
 * <h2>防的是什么</h2>
 * 无人值守跑场景时，客户端窗口一旦失焦，{@code EntityRenderer} 每帧都会
 * {@code displayGuiScreen(new GuiIngameMenu())} 打开暂停菜单：世界 tick 仍在跑，但玩家的
 * 输入/GUI 状态被打断，且 {@code currentScreen != null} 会让「等进世界」的判据永远不成立。
 * 为此会话期间把 {@code gameSettings.pauseOnLostFocus} 置 false（进入时保存原值，结束时还原），
 * 并且每 tick 清掉三类「自伤型」界面：
 * <ul>
 * <li>{@code GuiIngameMenu}——失焦暂停菜单；</li>
 * <li>{@code GuiChat}——误触聊天框（会吃掉后续自动指令）；</li>
 * <li>{@code cpw.mods.fml.client.GuiNotification}——FML 的模态通知（无人值守时没人点确定）。
 * 这里用<b>类名字符串</b>判定而不是 import，理由：该类属 FML 客户端包，用字符串可让本类在
 * 任何侧都能被安全加载（虽然当前只有客户端路径会触碰它）。</li>
 * </ul>
 *
 * <p>
 * <b>只清这三类</b>：{@code GuiDownloadTerrain}/{@code GuiGameOver} 等不在其列——前者是世界加载
 * 的正常一环，后者说明跑偏了（应当由失败超时暴露，而不是被静默点掉）。
 *
 * <p>
 * 守卫可重入（计数语义）：动作嵌套开场（例如 case.run 内又要求重建世界）只保存/还原一次原值。
 */
public final class SceneSessionGuard {

    private static final String FML_NOTIFICATION = "cpw.mods.fml.client.GuiNotification";

    private static int depth;
    private static Boolean savedPauseOnLostFocus;

    private SceneSessionGuard() {}

    /** 进入场景会话（幂等可重入）。 */
    public static synchronized void arm(Minecraft mc) {
        depth++;
        if (mc == null || mc.gameSettings == null) {
            return;
        }
        if (savedPauseOnLostFocus == null) {
            savedPauseOnLostFocus = Boolean.valueOf(mc.gameSettings.pauseOnLostFocus);
        }
        if (mc.gameSettings.pauseOnLostFocus) {
            mc.gameSettings.pauseOnLostFocus = false;
            CpLog.info("场景会话：已关闭 pauseOnLostFocus（会话结束还原）");
        }
    }

    /** 退出场景会话（计数归零时还原原值）。 */
    public static synchronized void release(Minecraft mc) {
        if (depth > 0) {
            depth--;
        }
        if (depth > 0) {
            return;
        }
        if (mc != null && mc.gameSettings != null && savedPauseOnLostFocus != null) {
            boolean restore = savedPauseOnLostFocus.booleanValue();
            if (mc.gameSettings.pauseOnLostFocus != restore) {
                mc.gameSettings.pauseOnLostFocus = restore;
                CpLog.info("场景会话：已还原 pauseOnLostFocus=%s", String.valueOf(restore));
            }
        }
        savedPauseOnLostFocus = null;
    }

    /** 是否有场景会话在进行。 */
    public static synchronized boolean isArmed() {
        return depth > 0;
    }

    /** 每个客户端 tick 调用：清掉自伤型界面。 */
    public static void onTick(Minecraft mc) {
        if (mc == null || !isArmed()) {
            return;
        }
        GuiScreen screen = mc.currentScreen;
        if (screen == null) {
            return;
        }
        if (isTransient(screen)) {
            CpLog.info(
                "场景会话：清除界面 %s",
                screen.getClass()
                    .getName());
            mc.displayGuiScreen(null);
        }
    }

    private static boolean isTransient(GuiScreen screen) {
        if (screen instanceof GuiIngameMenu || screen instanceof GuiChat) {
            return true;
        }
        return FML_NOTIFICATION.equals(
            screen.getClass()
                .getName());
    }
}
