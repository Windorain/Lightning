package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.Minecraft;
import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.gui.inventory.GuiContainer;
import net.minecraft.client.gui.inventory.GuiInventory;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code player.gui}（scene，同步）：<b>开关玩家界面</b>——开/关背包与机器 GUI。
 *
 * <h2>为什么「开界面」是玩家操作（L1）而不是布景（L0）</h2>
 * 界面的打开在原版里有两条路，本动作只走玩家那条：
 * <ul>
 * <li><b>玩家路径</b>（本动作）：{@code gui:"inventory"} 复刻原版
 * {@code Minecraft.runTick} 里 {@code keyBindInventory} 的处理——
 * 发 {@code C16PacketClientStatus(OPEN_INVENTORY_ACHIEVEMENT)} 并
 * {@code displayGuiScreen(new GuiInventory(thePlayer))}；界面根部的
 * {@code GuiContainer.initGui()} 会把 {@code thePlayer.openContainer} 设成它的 {@code inventorySlots}。
 * {@code gui:"container"} 走的则是 {@code player.interact} 的右键容器路径，
 * 由服务端 {@code S2DPacketOpenWindow} 决定客户端显示哪个界面。</li>
 * <li>{@code gui:"close"}：{@code EntityClientPlayerMP.closeScreen()}——发
 * {@code C0DPacketCloseWindow(windowId)} 并关掉界面（原版 ESC 的处理）。</li>
 * </ul>
 *
 * <h2>机器 GUI（GT/AE2 等）</h2>
 * 模组的机器界面同样经服务端 {@code IGuiHandler} / {@code openGui} 发 S2D 打开，
 * 因此对机器方块走 {@code gui:"container", at:[x,y,z]} 即可——<b>不需要</b>本动作认识任何具体模组。
 * 开出来的是什么界面，返回值的 {@code screenClass} 会如实给出。
 *
 * <h2>范围外（裁决 3）</h2>
 * <b>GUI 内非槽位按钮点击</b>（如机器模式按钮、JEI 面板）不在本任务范围。
 * 本动作只负责「开/关」，不点按钮；槽位收放由 {@code player.slot_click} 负责。
 * 若 F2 教程样本实际需要点按钮，应当场切独立单子，不混进这里。
 *
 * <h2>与无人值守的关系</h2>
 * 打开的 {@code GuiContainer} 的 {@code doesGuiPauseGame()} 返回 false（原版口径），
 * 因此界面开着时集成服照常 tick——{@code player.slot_click} 可以在界面开着时继续工作。
 * 但界面会吃掉 {@code SceneSessionGuard} 之外的按键，因此本动作<b>不</b>把界面留着不管：
 * 调用方用完应显式 {@code gui:"close"}（状态转换由请求驱动，#96 §8.4）。
 */
public final class PlayerGuiAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.gui";

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);
        EntityPlayerMP server = PlayerSession.serverPlayer();
        if (server == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object("action", NAME, "hint", "先进世界：world.rebuild 或 case.run 的 world 段"));
        }
        Minecraft mc = WorldRuntime.mc();

        String gui = ctx.optString("gui", null);
        if (gui == null || gui.trim()
            .isEmpty()) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "缺少 gui 参数",
                Json.object(
                    "fields",
                    Json.object(
                        "gui",
                        "必填：inventory（玩家背包）| container（右键打开 at 处的容器/机器）| close（关闭当前界面）| open（只读：报告当前界面与容器，不改变任何状态）")));
        }
        gui = gui.trim()
            .toLowerCase(java.util.Locale.ROOT);

        String screenBefore = screenName(mc);
        int windowBefore = server.openContainer == null ? 0 : server.openContainer.windowId;
        String containerBefore = server.openContainer == null ? null
            : server.openContainer.getClass()
                .getName();

        String actionTaken;
        switch (gui) {
            case "open": {
                // 只读报告（与其余三支并列，便于调用方在一次调用里拿到「现在开着什么」）
                actionTaken = "report";
                break;
            }
            case "inventory": {
                // 原版 Minecraft.runTick 里 keyBindInventory 的处理（逐字复刻那条路径）
                handler.addToSendQueue(
                    new net.minecraft.network.play.client.C16PacketClientStatus(
                        net.minecraft.network.play.client.C16PacketClientStatus.EnumState.OPEN_INVENTORY_ACHIEVEMENT));
                mc.displayGuiScreen(new GuiInventory(client));
                actionTaken = "open-inventory";
                break;
            }
            case "close": {
                if (mc.currentScreen == null) {
                    // 已经关着了：如实报告，不假装做了事
                    actionTaken = "already-closed";
                    break;
                }
                // 原版 ESC 的处理：EntityClientPlayerMP.closeScreen 发 C0DPacketCloseWindow 并关界面
                client.closeScreen();
                mc.displayGuiScreen(null);
                actionTaken = "close";
                break;
            }
            case "container": {
                // 打开容器/机器界面要走右键路径（服务端才认），这里转发到同一实现并复用其结果形态
                JsonObject params = new JsonObject();
                params.addProperty("target", "block");
                if (ctx.has("at")) {
                    params.add("at", Json.copy(Json.get(ctx.params(), "at")));
                }
                com.google.gson.JsonElement reach = Json.get(ctx.params(), "reach");
                if (reach != null) {
                    params.add("reach", Json.copy(reach));
                }
                JsonObject interact = new PlayerInteractAction().execute(ctx.withParams(params));
                long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);
                JsonObject o = new JsonObject();
                o.addProperty("gui", gui);
                o.addProperty("actionTaken", "open-container");
                o.add("interact", interact);
                o.addProperty("screenBefore", screenBefore);
                o.addProperty("screenAfter", screenName(mc));
                o.addProperty("windowIdBefore", Integer.valueOf(windowBefore));
                o.addProperty("containerClassBefore", containerBefore);
                o.addProperty(
                    "windowIdAfter",
                    Integer.valueOf(server.openContainer == null ? 0 : server.openContainer.windowId));
                o.addProperty(
                    "containerClassAfter",
                    server.openContainer == null ? null
                        : server.openContainer.getClass()
                            .getName());
                boolean opened = !guiEquals(interact.getAsJsonObject("container"), "containerOpened", false);
                o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
                o.addProperty("observed", Boolean.valueOf(opened));
                if (!opened) {
                    o.addProperty(
                        "notObservedReason",
                        "右键后 openContainer 未变：该方块不是容器/机器，或服务端因距离拒了这次右键"
                            + "（processPlayerBlockPlacement 的 dist）。细节见 interact 字段");
                }
                o.addProperty("screenClass", screenName(mc));
                o.addProperty(
                    "containerClass",
                    server.openContainer == null ? null
                        : server.openContainer.getClass()
                            .getName());
                o.addProperty(
                    "pathNote",
                    "gui:container 复用 player.interact 的方块分支（C08 → activateBlockOrUseItem → "
                        + "mod 的 openGui → S2DPacketOpenWindow → 客户端 displayGuiScreen），"
                        + "因此打开的是服务端认的界面，不是客户端自己 new 一个");
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.CASE_SEGMENT,
                    NAME + "：open-container observed=" + opened,
                    Json.object("observed", Boolean.valueOf(opened)));
                return PlayerSession.decorated(NAME, "gui-open-container", o, server);
            }
            default:
                throw CpException.param("gui 非法", "gui", "只允许 inventory | container | close | open，收到: " + gui);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        String screenAfter = screenName(mc);
        Container open = server.openContainer;
        JsonObject o = new JsonObject();
        o.addProperty("gui", gui);
        o.addProperty("actionTaken", actionTaken);
        o.addProperty("screenBefore", screenBefore);
        o.addProperty("screenAfter", screenAfter);
        o.addProperty("screenClass", screenAfter);
        o.addProperty(
            "guiClass",
            mc == null || mc.currentScreen == null ? null
                : mc.currentScreen.getClass()
                    .getName());
        o.addProperty("guiIsContainer", Boolean.valueOf(mc != null && mc.currentScreen instanceof GuiContainer));
        o.addProperty(
            "guiPausesGame",
            Boolean.valueOf(mc != null && mc.currentScreen != null && mc.currentScreen.doesGuiPauseGame()));
        o.addProperty("windowIdBefore", Integer.valueOf(windowBefore));
        o.addProperty("containerClassBefore", containerBefore);
        o.addProperty("windowIdAfter", Integer.valueOf(open == null ? 0 : open.windowId));
        o.addProperty(
            "containerClassAfter",
            open == null ? null
                : open.getClass()
                    .getName());
        o.addProperty(
            "slotCount",
            Integer.valueOf(open == null || open.inventorySlots == null ? 0 : open.inventorySlots.size()));
        o.addProperty(
            "slotMeaning",
            SlotClickAction
                .slotMeaning(open, open == null || open.inventorySlots == null ? 0 : open.inventorySlots.size()));

        boolean observed;
        switch (actionTaken) {
            case "open-inventory":
                // **创造模式打开的是 GuiContainerCreative（原版如此）**，不是 GuiInventory。
                // 首轮实机验收时把判据写成「instanceof GuiInventory」，于是创造模式下明明界面开出来了
                // 却报 observed=false —— 那是判据太窄，不是动作失败（实测：screenAfter 已是
                // GuiContainerCreative，而 observed 假红）。因此这里接受两者，
                // 并在返回值里如实给出到底是哪一个（creatorMode 字段）。
                observed = screenAfter != null && mc != null
                    && mc.currentScreen instanceof GuiContainer
                    && (mc.currentScreen instanceof GuiInventory
                        || mc.currentScreen instanceof net.minecraft.client.gui.inventory.GuiContainerCreative);
                break;
            case "close":
                observed = screenAfter == null;
                break;
            case "already-closed":
                observed = true;
                break;
            default:
                observed = true; // report
                break;
        }
        o.addProperty(
            "creatorModeInventory",
            Boolean.valueOf(
                mc != null && mc.currentScreen instanceof net.minecraft.client.gui.inventory.GuiContainerCreative));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "open-inventory 后 currentScreen 不是玩家背包界面（GuiInventory / GuiContainerCreative）"
                    + "——多为 displayGuiScreen 被 GuiOpenEvent 拦下；或 close 后 currentScreen 仍非空"
                    + "（多为有别的界面把自己弹回来）；screenAfter="
                    + screenAfter);
        }
        o.addProperty(
            "pathNote",
            "gui:inventory 复刻原版 Minecraft.runTick 的 keyBindInventory 分支"
                + "（C16PacketClientStatus(OPEN_INVENTORY_ACHIEVEMENT) + displayGuiScreen(new GuiInventory(thePlayer))）；"
                + "gui:close 走 EntityClientPlayerMP.closeScreen()（C0DPacketCloseWindow，原版 ESC 的处理）。"
                + "范围外：GUI 内非槽位按钮点击（机器模式按钮等）不在本动作内，见契约 §4.6");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：" + actionTaken + " screen " + screenBefore + " → " + screenAfter,
            Json.object(
                "actionTaken",
                actionTaken,
                "screenBefore",
                screenBefore,
                "screenAfter",
                screenAfter,
                "observed",
                Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "gui-" + actionTaken, o, server);
    }

    /** 当前界面类名；无界面返回 null。 */
    private static String screenName(Minecraft mc) {
        return mc == null || mc.currentScreen == null ? null
            : mc.currentScreen.getClass()
                .getName();
    }

    private static boolean guiEquals(JsonObject o, String key, boolean def) {
        if (o == null) {
            return def;
        }
        com.google.gson.JsonElement e = Json.get(o, key);
        return e == null || e.isJsonNull() ? def : e.getAsBoolean();
    }
}
