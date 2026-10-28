package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.use_item}（scene，同步）：<b>使用手持物品</b>（右键使用）。
 *
 * <h2>两条分支，都由原版自己选</h2>
 * 走客户端玩家控制器的两个方法，判断逻辑不复制：
 * <ul>
 * <li><b>对空气用</b>（{@code mode:"air"}，默认在视线未命中任何东西时）：
 * {@code PlayerControllerMP.sendUseItem(player, world, stack)}——它发
 * {@code C08PacketPlayerBlockPlacement(-1,-1,-1, 255, stack, 0,0,0)} 并在客户端本地跑
 * {@code Item.useItemRightClick}（原版 {@code Minecraft.func_147121_ag} 的 {@code flag} 分支）；
 * 服务端在 {@code processPlayerBlockPlacement} 的 {@code side==255} 分支里走
 * {@code ItemInWorldManager.tryUseItem}（食物/弓/末影珍珠/桶…都在这条路上）。</li>
 * <li><b>对方块用</b>（{@code mode:"block"}）：{@code PlayerControllerMP.onPlayerRightClick(...)}
 * ——发 C08 带真实坐标与命中偏移，并在客户端本地跑 {@code onItemUseFirst}/{@code onBlockActivated}/
 * {@code tryPlaceItemIntoWorld}。</li>
 * </ul>
 * 因此「用了物品」这件事的<b>结果由原版产生</b>：物品的 use 返回值、消耗、耐久、NBT 变化、
 * 服务端的 Forge 事件与游戏模式分支全部照常。本动作不自行调用 {@code Item.useItemRightClick}。
 *
 * <h2>与 {@code player.place_block}、{@code player.interact} 的分工</h2>
 * 三者都走 C08，区别在<b>意图与断言口径</b>：
 * <ul>
 * <li>{@code player.use_item}：断言<b>手持物品自身的 state 变化</b>（count/耐久/NBT）；
 * 它的 L1 义是「玩家按了右键用东西」；</li>
 * <li>{@code player.place_block}：断言<b>世界多了一格</b>（before/after 逐格读回）；</li>
 * <li>{@code player.interact}：断言<b>方块或实体的交互产物</b>（容器被打开 / 实体被交互）。</li>
 * </ul>
 * 三者不是同一动作的别名（D1：自述要与行为一致），因此各自独立注册、各自有示例。
 *
 * <h2>视线</h2>
 * 默认用服务端权威玩家的真实 yaw/pitch 发射线（与玩家按右键时 {@code Minecraft} 用的
 * {@code objectMouseOver} 同一口径）。{@code at} 给出时改瞄该格（朝向仍由真实朝向决定，
 * 因此 {@code at} 必须落在当前视线能打到的位置——打不到就会被服务端的距离校验拒掉，
 * 那是这条路径的真实后果）。
 */
public final class UseItemAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.use_item";

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        net.minecraft.client.multiplayer.PlayerControllerMP controller = PlayerSession.requireController(NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);
        EntityPlayerMP server = PlayerSession.serverPlayer();
        if (server == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object("action", NAME, "hint", "先进世界：world.rebuild 或 case.run 的 world 段"));
        }

        String mode = ctx.optString("mode", null);
        if (mode != null) {
            mode = mode.trim()
                .toLowerCase(java.util.Locale.ROOT);
        }
        double reach = ctx.has("reach") ? PlayerSession.optNumberPublic(ctx, "reach")
            .doubleValue() : PlayerSession.SERVER_REACH;
        if (reach <= 0.0D || reach > 64.0D) {
            throw CpException.param("reach 非法", "reach", "须在 (0,64]，收到 " + reach);
        }

        ItemStack beforeStack = server.getHeldItem();
        JsonObject beforeHeld = PlayerSession.heldRead(server);
        JsonObject beforePose = PlayerSession.poseRead(server);
        String beforeUseState = useStateToken(server);
        PlayerSession.Sight sight = PlayerSession.sight(server, reach, false);

        boolean wantBlock;
        if ("air".equals(mode)) {
            wantBlock = false;
        } else if ("block".equals(mode)) {
            wantBlock = true;
            if (sight == null || !sight.blockHit()) {
                throw new CpException(
                    ErrorCodes.STATE,
                    NAME + "：mode=block 但当前视线没有命中任何方块（先 player.look 或 player.move 把玩家摆到能打到目标的位置）",
                    Json.object(
                        "action",
                        NAME,
                        "sight",
                        PlayerSession.sightRead(sight),
                        "hint",
                        "用 mode:air（默认分支）对方块外的空处用物品，或先用 player.look {lookAt:[x,y,z]} 瞄准"));
            }
        } else if (mode == null) {
            wantBlock = sight != null && sight.blockHit();
        } else {
            throw CpException.param("mode 非法", "mode", "只允许 air | block，收到: " + mode);
        }

        boolean used;
        String branch;
        JsonObject target = new JsonObject();
        if (wantBlock) {
            int[] bp = sight.blockPos();
            float[] off = PlayerSession.hitOffsets(sight);
            target.add("block", PlayerSession.posArray(bp[0], bp[1], bp[2]));
            target.addProperty("side", Integer.valueOf(sight.side()));
            used = controller.onPlayerRightClick(
                client,
                client.worldObj,
                beforeStack,
                bp[0],
                bp[1],
                bp[2],
                sight.side(),
                sight.hit.hitVec);
            branch = "onPlayerRightClick";
        } else {
            target.addProperty("block", (String) null);
            if (beforeStack == null || beforeStack.getItem() == null) {
                // 手上没东西：原版 Minecraft.func_147121_ag 在 flag 分支前就有 itemstack1 != null 的门，
                // 因此「空手对空气右键」在原版里什么都不会发生。这里如实照做并显式说明——
                // 静默照发一个 C08 是「看起来一样但不一样」的假路径。
                JsonObject o = new JsonObject();
                o.addProperty("mode", "air");
                o.addProperty("branch", "none");
                o.addProperty("handEmpty", Boolean.valueOf(true));
                o.add("target", target);
                o.add("before", beforeHeld);
                o.add("after", PlayerSession.heldRead(server));
                o.addProperty("used", Boolean.valueOf(false));
                // 空手对空气：原版在此情形**不发包**，因此无需等服务端（如实写 0）。
                o.addProperty("serverSyncWaitedMs", Long.valueOf(0L));
                o.addProperty("observed", Boolean.valueOf(false));
                o.addProperty(
                    "notObservedReason",
                    "手上没有物品：原版客户端在 func_147121_ag 的 air 分支前有 itemstack1 != null 的门，"
                        + "空手对空气右键不产生任何包与效果。要让本动作产生行为，先 scene.inventory.write 或先捡起一件物品");
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.CASE_SEGMENT,
                    NAME + "：空手对空气，原版不产生行为（如实报告，未发假包）",
                    Json.object("handEmpty", Boolean.valueOf(true)));
                return PlayerSession.decorated(NAME, "use-item", o, server);
            }
            used = controller.sendUseItem(client, client.worldObj, beforeStack);
            branch = "sendUseItem";
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        JsonObject afterHeld = PlayerSession.heldRead(server);
        ItemStack afterStack = server.getHeldItem();
        JsonObject o = new JsonObject();
        o.addProperty("mode", wantBlock ? "block" : "air");
        o.addProperty("branch", branch);
        o.add("target", target);
        o.add("sight", PlayerSession.sightRead(sight));
        o.add("before", beforeHeld);
        o.add("after", afterHeld);
        o.addProperty("used", Boolean.valueOf(used));
        o.add("stackChange", stackChange(beforeStack, afterStack));
        // 「用了一次物品」的可观察产物有两类，任一即算观察到：
        // ① 手持物品自身的变化（数量/耐久/NBT）——消耗品、工具；
        // ② 玩家进入/退出「使用中」状态（isUsingItem / getItemInUse）——弓、食物、药水
        // 这类物品的 useItemRightClick 只**开始**使用，实际效果要等持续时长结束。
        // 首轮实机用弓验证时只查①，于是 used=true 而 observed=false —— 那是读数口径太窄，
        // 不是物品没反应（弓确实开始拉了）。这里把②补上，让 observed 说真话。
        String afterUseState = useStateToken(server);
        boolean useStateChanged = !beforeUseState.equals(afterUseState);
        boolean observed = stackChanged(beforeStack, afterStack) || useStateChanged;
        JsonObject useState = new JsonObject();
        useState.addProperty("before", beforeUseState);
        useState.addProperty("after", afterUseState);
        useState.addProperty("changed", Boolean.valueOf(useStateChanged));
        useState.addProperty("scope", "isUsingItem + 使用中物品的注册名（弓/食物/药水的「开始使用」在这里可见；" + "消耗品的数量/耐久变化见 stackChange）");
        o.add("useState", useState);
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                used ? "useItemRightClick 返回 true 但物品栈与使用状态都没变：该物品在这个上下文里没有可观察效果"
                    + "（这与「动作失败」是两回事——动作按玩家路径执行了，是物品本身没反应）"
                    : "原版客户端判定这次右键没有产生物品消耗/变化（sendUseItem 返回 false）："
                        + "多为该物品没有 useItemRightClick 行为，或手上物品在 air 分支的门之前就被排除了");
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.sendUseItem / onPlayerRightClick（C08PacketPlayerBlockPlacement），"
                + "服务端分支分别是 NetHandlerPlayServer 的 side==255 与 activateBlockOrUseItem；"
                + "观察对象是「手持物品自身的变化」——世界方块变化由 player.place_block / player.interact 断言");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：" + branch + " used=" + used + " observed=" + observed,
            Json.object("branch", branch, "used", Boolean.valueOf(used), "observed", Boolean.valueOf(observed)));
        JsonObject decorated = PlayerSession.decorated(NAME, "use-item", o, server);
        decorated.add("poseBefore", beforePose);
        return decorated;
    }

    /**
     * 「玩家此刻是否在持续使用某物品」的可比较标识。
     *
     * <p>
     * 原版把这件事记在 {@code EntityPlayer.itemInUse}（配 {@code itemInUseCount}），
     * 对外只有 {@code isUsingItem()} / {@code getItemInUse()} / {@code getItemInUseCount()} 三个读数口。
     * 本方法把它们拼成一个可 {@code equals} 的字符串——用它做 before/after 比较，
     * 就得到「这次右键让玩家进入了/退出了使用中状态」这条可判定的观察。
     *
     * <p>
     * 认不出的物品给 {@code "using:unknown"} 而不是省略，免得「用了但认不出是什么」被当成「没用」。
     */
    static String useStateToken(EntityPlayerMP server) {
        if (server == null) {
            return "no-server";
        }
        try {
            if (!server.isUsingItem()) {
                return "idle";
            }
            ItemStack using = server.getItemInUse();
            String id = using == null || using.getItem() == null ? "unknown"
                : String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(using.getItem()));
            return "using:" + id + ":" + server.getItemInUseCount();
        } catch (Throwable t) {
            return "unreadable:" + t.getClass()
                .getName();
        }
    }

    /** 物品栈变化读数。 */
    static JsonObject stackChange(ItemStack before, ItemStack after) {
        JsonObject o = new JsonObject();
        o.add("before", PlayerSession.stackRead(before));
        o.add("after", PlayerSession.stackRead(after));
        int bc = before == null || before.getItem() == null ? 0 : before.stackSize;
        int ac = after == null || after.getItem() == null ? 0 : after.stackSize;
        o.addProperty("countDelta", Integer.valueOf(ac - bc));
        int bd = before == null || before.getItem() == null ? -1 : before.getItemDamage();
        int ad = after == null || after.getItem() == null ? -1 : after.getItemDamage();
        o.addProperty("damageDelta", Integer.valueOf(ad - bd));
        o.addProperty("changed", Boolean.valueOf(stackChanged(before, after)));
        return o;
    }

    /** 物品栈是否发生了可观察变化（id/meta/count/NBT 任一）。 */
    static boolean stackChanged(ItemStack before, ItemStack after) {
        boolean bEmpty = before == null || before.getItem() == null;
        boolean aEmpty = after == null || after.getItem() == null;
        if (bEmpty && aEmpty) {
            return false;
        }
        if (bEmpty != aEmpty) {
            return true;
        }
        if (before.getItem() != after.getItem()) {
            return true;
        }
        if (before.stackSize != after.stackSize) {
            return true;
        }
        if (before.getItemDamage() != after.getItemDamage()) {
            return true;
        }
        String bt = before.getTagCompound() == null ? null
            : before.getTagCompound()
                .toString();
        String at = after.getTagCompound() == null ? null
            : after.getTagCompound()
                .toString();
        return bt == null ? at != null : !bt.equals(at);
    }

    /**
     * C08 的常量：对方块外使用时的 sentinel（见原版 {@code PlayerControllerMP.sendUseItem}：
     * {@code new C08PacketPlayerBlockPlacement(-1,-1,-1, 255, ...)}）。
     *
     * <p>
     * 本动作不自己拼包（走 {@code sendUseItem}），这里留作自述与审计的常量锚点。
     */
    public static final int AIR_SENTINEL = 255;
}
