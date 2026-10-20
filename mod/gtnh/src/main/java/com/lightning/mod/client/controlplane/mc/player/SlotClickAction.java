package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.multiplayer.PlayerControllerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.slot_click}（scene，同步）：<b>容器与背包槽位收放</b>——开着的那个界面里逐槽移动物品。
 *
 * <h2>走的是哪条玩家路径</h2>
 * 原版玩家点槽位的唯一出口是 {@code GuiContainer.handleMouseClick →
 * PlayerControllerMP.windowClick(windowId, slotId, button, clickType, player)}：
 * 它在<b>客户端本地</b>跑一次 {@code Container.slotClick}（本地预测），再发
 * {@code C0EPacketClickWindow}；服务端在 {@code NetHandlerPlayServer.processClickWindow} 里
 * 跑<b>权威</b>的 {@code Container.slotClick} 并回 {@code S2FPacketSetSlot}/{@code S32PacketConfirmTransaction}。
 * 本动作直接调 {@code windowClick}——本地预测与服务端权威两次都由原版产生。
 *
 * <h2>{@code clickType}（原版 {@code Container.slotClick} 的 mode 参数）</h2>
 * <table border="1">
 * <caption>点击模式</caption>
 * <tr>
 * <th>mode</th>
 * <th>名字</th>
 * <th>button</th>
 * <th>行为</th>
 * </tr>
 * <tr>
 * <td>0</td>
 * <td>{@code pick}（左键）</td>
 * <td>0</td>
 * <td>拿起/放下整摞（与光标交换）</td>
 * </tr>
 * <tr>
 * <td>1</td>
 * <td><b>{@code shift}</b>（移位点击）</td>
 * <td>0/1</td>
 * <td><b>快速移动</b>：
 * 槽内物品整摞转移到对侧容器（箱子↔背包），不经过光标。这是本动作 {@code shift:true} 走的路</td>
 * </tr>
 * <tr>
 * <td>2</td>
 * <td>{@code swap}（数字键交换）</td>
 * <td>0..8</td>
 * <td>把槽内物品与快捷栏第 button 格交换</td>
 * </tr>
 * <tr>
 * <td>3</td>
 * <td>{@code clone}（创造模式复制）</td>
 * <td>2</td>
 * <td>仅创造模式有效</td>
 * </tr>
 * <tr>
 * <td>4</td>
 * <td>{@code throw}</td>
 * <td>0/1</td>
 * <td>丢弃 1 个 / 整摞</td>
 * </tr>
 * <tr>
 * <td>5</td>
 * <td>{@code drag}</td>
 * <td>0..10</td>
 * <td>拖拽分发（0 开始 / 1 单格 / 2 均分 / …）</td>
 * </tr>
 * <tr>
 * <td>6</td>
 * <td>{@code pickup-all}</td>
 * <td>0</td>
 * <td>双击合堆</td>
 * </tr>
 * </table>
 * 本动作的自述里写死这张表（{@code clickType} 默认 0 = 左键整摞交换；{@code shift:true} 是
 * {@code clickType:1} 的简写）。<b>不猜</b>：调用方要移位点击就写 {@code shift:true} 或
 * {@code clickType:1}，本动作不按物品类型自作主张。
 *
 * <h2>槽位号从哪来</h2>
 * {@code slot} 是<b>当前 {@code openContainer} 的槽号</b>（{@code Slot.slotNumber}，
 * 即 {@code C0EPacketClickWindow} 里那个），不是 {@code InventoryPlayer} 下标——两者不同
 * （{@code ContainerPlayer} 含合成格、顺序错位；{@code ContainerChest} 前 27 格是箱子、
 * 后 36 格是玩家背包）。因此：
 * <ul>
 * <li>先用 {@link #NAME} 配 {@code gui:"open"} 或 {@code read.inventory} 拿到槽位语义；</li>
 * <li>或者给 {@code side:"container"|"player"} 让本动作<b>按 {@code Container} 的 inventory 归属</b>
 * 反查槽号——这条只在目标容器可判定时才用，且返回值里给出解析到的槽号（不静默换算）。</li>
 * </ul>
 *
 * <h2>作用对象：当前 {@code openContainer}（它<b>永远不是 null</b>）</h2>
 * {@code windowClick} 操作的是 {@code player.openContainer}。关键事实（实机首轮验收修正）：
 * <b>原版在玩家构造时就把 {@code openContainer} 设成了 {@code inventoryContainer}</b>
 * （{@code EntityPlayer:169}），因此「没开容器」这个状态在原版里<b>不存在</b>——
 * 没人开箱子时 {@code openContainer} 就是玩家自己的背包容器（{@code ContainerPlayer}）。
 *
 * <p>
 * 这条事实纠正了本动作最初的一个错误设想（「没开容器时报 CP-STATE-001」）：
 * 那个分支几乎<bd>永远不会触</bd>发，因为 {@code openContainer} 从不缺位。
 * 现在的口径是<b>如实报告作用对象</b>：{@code containerClass} / {@code windowId} /
 * {@code slotMeaning} 三个字段说清这次点击打在哪个容器上，
 * 外加 {@code containerIsPlayerInventory} 让调用方一眼看出「这是玩家自己的背包，不是外部容器」。
 * 仍保留 null 检查作为防御（模组若把 openContainer 置 null，本动作报 CP-STATE-001 而不是 NPE）。
 */
public final class SlotClickAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.slot_click";

    /** 单次最多执行的点击步数（防呆；一条结果里逐条留痕）。 */
    public static final int MAX_CLICKS = 64;

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        PlayerControllerMP controller = PlayerSession.requireController(NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);
        EntityPlayerMP server = PlayerSession.serverPlayer();
        WorldServer world = PlayerSession.serverWorld();
        if (server == null || world == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家或服务端世界不可用（未进入世界或玩家尚未加入集成服）",
                Json.object(
                    "action",
                    NAME,
                    "worldAvailable",
                    Boolean.valueOf(world != null),
                    "playerAvailable",
                    Boolean.valueOf(server != null),
                    "hint",
                    "先进世界：world.rebuild 或 case.run 的 world 段"));
        }

        Container container = server.openContainer;
        if (container == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：没有打开的容器（openContainer 为空）",
                Json.object(
                    "action",
                    NAME,
                    "hint",
                    "先开一个：player.gui {gui:\"inventory\"} 开玩家背包，或 player.interact {at:[x,y,z]} 右键容器方块"));
        }

        JsonArray clicks = ctx.optArray("clicks");
        JsonObject single = ctx.optObject("click");
        java.util.List<JsonObject> steps = new java.util.ArrayList<JsonObject>();
        if (clicks != null) {
            for (int i = 0; i < clicks.size(); i++) {
                JsonElement e = clicks.get(i);
                if (e == null || !e.isJsonObject()) {
                    throw CpException.param("点击步骤非法", "clicks[" + i + "]", "须为 object");
                }
                steps.add(e.getAsJsonObject());
            }
        }
        if (single != null) {
            steps.add(single);
        }
        // 顶层简写：直接给 slot 即一次左键点击
        if (steps.isEmpty() && ctx.has("slot")) {
            JsonObject s = new JsonObject();
            s.addProperty("slot", Integer.valueOf(ctx.optInt("slot", -1)));
            steps.add(s);
        }
        if (steps.isEmpty()) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "缺少点击步骤",
                Json.object(
                    "fields",
                    Json.object(
                        "clicks",
                        "给 clicks[{slot,clickType?,button?,shift?}] 数组",
                        "click",
                        "或单个 click 对象",
                        "slot",
                        "或顶层 slot（等价于一次左键点击）")));
        }
        if (steps.size() > MAX_CLICKS) {
            throw CpException.param("点击步数超限", "clicks", "单次最多 " + MAX_CLICKS + " 步，收到 " + steps.size());
        }

        int windowId = container.windowId;
        int slotCount = container.inventorySlots == null ? 0 : container.inventorySlots.size();
        JsonObject before = containerSnapshot(container);
        JsonObject cursorBefore = PlayerSession.stackRead(server.inventory.getItemStack());

        JsonArray results = new JsonArray();
        int executed = 0;
        for (int i = 0; i < steps.size(); i++) {
            JsonObject step = steps.get(i);
            String where = "clicks[" + i + "]";
            int slotId = Json.optInt(step, "slot", Integer.MIN_VALUE);
            if (slotId == Integer.MIN_VALUE) {
                throw CpException.param("缺少 slot", where + ".slot", "必填（当前 openContainer 的槽号）");
            }
            // -999 是原版「容器外」的合法槽号（GuiContainer.mouseClicked 在 flag1 时用它），
            // 因此下限是 -999 而不是 0；上限是 openContainer 的槽数-1。
            if (slotId < -999 || slotId >= slotCount) {
                throw CpException.param(
                    "槽位越界",
                    where + ".slot",
                    "当前容器（" + container.getClass()
                        .getName()
                        + "）有 "
                        + slotCount
                        + " 个槽，slot 须在 -999.."
                        + (slotCount - 1)
                        + "（-999 = 容器外）；收到 "
                        + slotId
                        + "。注意这是界面槽号，不是 InventoryPlayer 下标——"
                        + "用 read.inventory 或 player.gui {gui:\"open\"} 核对槽位语义");
            }
            boolean shift = Json.optBool(step, "shift", false);
            int clickType = Json.optInt(step, "clickType", shift ? 1 : 0);
            if (clickType < 0 || clickType > 6) {
                throw CpException.param(
                    where + ".clickType 非法",
                    where + ".clickType",
                    "须在 0..6（0=pick 1=shift 2=swap 3=clone 4=throw 5=drag 6=pickup-all），收到 " + clickType);
            }
            int button = Json.optInt(step, "button", 0);
            if (button < 0 || button > 10) {
                throw CpException.param(where + ".button 非法", where + ".button", "须在 0..10，收到 " + button);
            }
            Slot slot = slotAt(container, slotId);
            ItemStack predicted;
            try {
                // 原版玩家点槽位的唯一出口：本地预测 + C0EPacketClickWindow
                predicted = controller.windowClick(windowId, slotId, button, clickType, client);
            } catch (Throwable t) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    NAME + "：windowClick 抛出异常（" + where + "）: " + t,
                    Json.object(
                        "action",
                        NAME,
                        "step",
                        Integer.valueOf(i),
                        "slot",
                        Integer.valueOf(slotId),
                        "clickType",
                        Integer.valueOf(clickType),
                        "button",
                        Integer.valueOf(button)),
                    t);
            }
            executed++;
            JsonObject r = new JsonObject();
            r.addProperty("slot", Integer.valueOf(slotId));
            r.addProperty("clickType", Integer.valueOf(clickType));
            r.addProperty("button", Integer.valueOf(button));
            r.addProperty("shift", Boolean.valueOf(shift));
            r.addProperty("slotKind", slot == null ? null : slotKind(slot));
            r.addProperty(
                "slotInventory",
                slot == null || slot.inventory == null ? null
                    : slot.inventory.getClass()
                        .getName());
            r.add("predicted", PlayerSession.stackRead(predicted));
            r.add("slotAfter", PlayerSession.stackRead(slot == null ? null : slot.getStack()));
            r.add("cursorAfter", PlayerSession.stackRead(server.inventory.getItemStack()));
            results.add(r);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        JsonObject after = containerSnapshot(container);
        JsonObject cursorAfter = PlayerSession.stackRead(server.inventory.getItemStack());
        boolean slotsChanged = !before.get("slots")
            .toString()
            .equals(
                after.get("slots")
                    .toString());
        boolean cursorChanged = !cursorBefore.get("empty")
            .getAsBoolean()
            || !cursorAfter.get("empty")
                .getAsBoolean() ? !cursorBefore.toString()
                    .equals(cursorAfter.toString()) : false;
        boolean observed = slotsChanged || cursorChanged;

        JsonObject o = new JsonObject();
        o.addProperty("windowId", Integer.valueOf(windowId));
        o.addProperty(
            "containerClass",
            container.getClass()
                .getName());
        // 原版 openContainer 默认就是玩家自己的背包容器（EntityPlayer:169），不是 null。
        // 这个字段让调用方一眼看出「这次点击打在玩家背包上，还是打在外部容器上」。
        o.addProperty(
            "containerIsPlayerInventory",
            Boolean.valueOf(
                container instanceof net.minecraft.inventory.ContainerPlayer
                    || "net.minecraft.inventory.ContainerPlayer".equals(
                        container.getClass()
                            .getName())));
        o.addProperty("slotCount", Integer.valueOf(slotCount));
        o.addProperty("slotMeaning", slotMeaning(container, slotCount));
        o.addProperty("clickCount", Integer.valueOf(executed));
        o.add("clicks", results);
        o.add("before", before);
        o.add("after", after);
        JsonObject cursor = new JsonObject();
        cursor.add("before", cursorBefore);
        cursor.add("after", cursorAfter);
        cursor.addProperty("changed", Boolean.valueOf(cursorChanged));
        o.add("cursor", cursor);
        o.addProperty("slotsChanged", Boolean.valueOf(slotsChanged));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "容器逐槽与光标都没有变化：多为该槽在该 clickType 下无可移动物品（空槽左键）、" + "shift 移位的目标容器已满、或服务端拒绝了这次点击"
                    + "（processClickWindow 会校验 windowId，并且 isPlayerNotUsingContainer 为 false 时直接跳过）");
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.windowClick → Container.slotClick（本地预测）+ C0EPacketClickWindow；"
                + "服务端在 NetHandlerPlayServer.processClickWindow 跑权威 Container.slotClick 并回 "
                + "S2FPacketSetSlot/S32PacketConfirmTransaction。slot 是 openContainer 的界面槽号，"
                + "不是 InventoryPlayer 下标（契约 §4.2 的 scene.inventory.write 用后者，两者不同，勿混用）");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：" + executed + " 次点击，槽位变化=" + slotsChanged + " 光标变化=" + cursorChanged,
            Json.object(
                "clickCount",
                Integer.valueOf(executed),
                "slotsChanged",
                Boolean.valueOf(slotsChanged),
                "observed",
                Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "slot-move", o, server);
    }

    // ------------------------------------------------------------ 快照与工具

    /** 容器逐槽快照（只列非空槽，附槽位语义）。 */
    static JsonObject containerSnapshot(Container container) {
        JsonObject o = new JsonObject();
        JsonArray slots = new JsonArray();
        if (container == null || container.inventorySlots == null) {
            o.add("slots", slots);
            return o;
        }
        for (int i = 0; i < container.inventorySlots.size(); i++) {
            Slot s = container.inventorySlots.get(i);
            if (s == null) {
                continue;
            }
            ItemStack st = s.getStack();
            if (st == null || st.getItem() == null) {
                continue;
            }
            JsonObject e = PlayerSession.stackRead(st);
            e.addProperty("slot", Integer.valueOf(s.slotNumber));
            e.addProperty("index", Integer.valueOf(i));
            e.addProperty("kind", slotKind(s));
            slots.add(e);
        }
        o.add("slots", slots);
        o.addProperty("slotCount", Integer.valueOf(container.inventorySlots.size()));
        o.addProperty("windowId", Integer.valueOf(container.windowId));
        return o;
    }

    /**
     * 槽位归属的人读名（container / player / armor / crafting / other / unknown）。
     *
     * <p>
     * <b>契约：恒有返回值，绝不返回 null。</b>{@link #slotMeaning} 会遍历容器全部槽位统计归属，
     * 任何一环拿到 null 槽位都不该让整次调用炸掉——那会把「开着的容器形态有点怪」
     * 升级成一次动作失败，而调用方本来只是想读一下槽位语义。
     * 认不出的归 {@code "unknown"}：这是<b>可见的兜底</b>，不是静默当成玩家背包。
     */
    static String slotKind(Slot slot) {
        if (slot == null || slot.inventory == null) {
            return "unknown";
        }
        String cls = slot.inventory.getClass()
            .getName();
        if (cls.endsWith("InventoryPlayer")) {
            return "player";
        }
        if (cls.endsWith("InventoryCrafting") || cls.endsWith("InventoryCraftResult")) {
            return "crafting";
        }
        return "container";
    }

    /** 槽位语义说明（自述与返回值共用，避免两处口径漂移）。 */
    static String slotMeaning(Container container, int slotCount) {
        StringBuilder sb = new StringBuilder();
        sb.append("slot 是 openContainer（")
            .append(
                container == null ? "?"
                    : container.getClass()
                        .getSimpleName())
            .append("）的界面槽号，共 ")
            .append(slotCount)
            .append(" 个；");
        if (container != null && container.inventorySlots != null) {
            int player = 0;
            int other = 0;
            for (int i = 0; i < container.inventorySlots.size(); i++) {
                Slot s = container.inventorySlots.get(i);
                if (s == null) {
                    continue;
                }
                if ("player".equals(slotKind(s))) {
                    player++;
                } else {
                    other++;
                }
            }
            sb.append("其中玩家背包归属 ")
                .append(player)
                .append(" 个、其它容器归属 ")
                .append(other)
                .append(" 个（用 player.gui {gui:\"open\"} 或 read.inventory 看逐槽归属）；");
        }
        sb.append("与 scene.inventory.write 的 InventoryPlayer 下标不同，勿混用");
        return sb.toString();
    }

    /** 按槽号取 Slot；越界返回 null。 */
    static Slot slotAt(Container container, int slotId) {
        if (container == null || container.inventorySlots == null) {
            return null;
        }
        for (int i = 0; i < container.inventorySlots.size(); i++) {
            Slot s = container.inventorySlots.get(i);
            if (s != null && s.slotNumber == slotId) {
                return s;
            }
        }
        return null;
    }
}
