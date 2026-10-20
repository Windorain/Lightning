package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.multiplayer.PlayerControllerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.interact}（scene，同步）：<b>右键交互</b>——对方块或实体。
 *
 * <h2>与 {@code player.use_item} 的分工（D1：自述必须与行为一致）</h2>
 * 两者确实共享同一个原版出口（对方的块是 {@code onPlayerRightClick}，对实体是
 * {@code interactWithEntitySendPacket}），但<b>断言的东西不同</b>：
 * <ul>
 * <li>{@code player.use_item}：L1 义是「玩家按右键用了手里的东西」，观察对象是<b>手持物品的状态变化</b>；</li>
 * <li>{@code player.interact}（本动作）：L1 义是「玩家与这个世界里的某个东西发生了交互」，
 * 观察对象是<b>方块/实体的交互产物</b>——容器被打开（{@code openContainer} 换了）、
 * 门被开了、实体被喂了/被骑了。因此本动作的回读包含
 * {@code containerOpened}（服务端 {@code openContainer} 的类名与 windowId 变化）
 * 与实体的交互后状态，而 {@code use_item} 不含这些。</li>
 * </ul>
 * 分开注册而不是合成一个带 mode 的动作，是为了让自述、示例、返回结构各自说清自己的语义——
 * 一个「既能用物品又能开箱子」的动作，其 {@code returns} 就只能写成两者的并集，
 * 调用方反而无从判断该读哪个字段。
 *
 * <h2>实体分支与物品拾取的区别</h2>
 * 右键<b>掉落物</b>走的是 {@code EntityItem.interactFirst}（把它捡起来）——那是「拿起来」的
 * 交互路径；它与 {@link PlayerPickupAction} 的「走过去碰到」是同一件事的两条玩家入口，
 * 两条都真实存在（前者对应原版对着掉落物按右键，后者对应走过去）。本动作走前者时
 * 返回 {@code semantics:"interact-entity"}，不冒充 {@code player.pickup} 的结论。
 */
public final class PlayerInteractAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.interact";

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

        String target = ctx.optString("target", "auto");
        if (target != null) {
            target = target.trim()
                .toLowerCase(java.util.Locale.ROOT);
        }
        double reach = ctx.has("reach") ? PlayerSession.optNumberPublic(ctx, "reach")
            .doubleValue() : PlayerSession.SERVER_REACH;
        if (reach <= 0.0D || reach > 64.0D) {
            throw CpException.param("reach 非法", "reach", "须在 (0,64]，收到 " + reach);
        }
        int[] at = optBlockPos(ctx, "at");
        PlayerSession.Sight sight = at == null ? PlayerSession.sight(server, reach, true) : null;

        int openBefore = server.openContainer == null ? 0 : server.openContainer.windowId;
        String openClassBefore = server.openContainer == null ? null
            : server.openContainer.getClass()
                .getName();
        JsonObject heldBefore = PlayerSession.heldRead(server);

        String resolved;
        if ("entity".equals(target)) {
            resolved = "entity";
        } else if ("block".equals(target)) {
            resolved = "block";
        } else if ("auto".equals(target) || target == null) {
            if (at != null) {
                resolved = "block";
            } else if (sight != null && sight.entityHit()) {
                // 原版 Minecraft.func_147121_ag 的分支顺序：命中实体优先走 interactWithEntitySendPacket
                resolved = "entity";
            } else if (sight != null && sight.blockHit()) {
                resolved = "block";
            } else {
                throw new CpException(
                    ErrorCodes.STATE,
                    NAME + "：视线没有命中任何方块或实体，无法交互（先 player.look 瞄准或给 at:[x,y,z]）",
                    Json.object("action", NAME, "sight", PlayerSession.sightRead(sight)));
            }
        } else {
            throw CpException.param("target 非法", "target", "只允许 auto | block | entity，收到: " + target);
        }

        if ("entity".equals(resolved)) {
            return interactEntity(ctx, client, controller, handler, server, world, sight, target);
        }
        return interactBlock(
            ctx,
            client,
            controller,
            handler,
            server,
            world,
            at,
            sight,
            openBefore,
            openClassBefore,
            heldBefore,
            target);
    }

    // ------------------------------------------------------------ 实体分支

    private JsonObject interactEntity(ActionContext ctx, EntityClientPlayerMP client, PlayerControllerMP controller,
        NetHandlerPlayClient handler, EntityPlayerMP server, WorldServer world, PlayerSession.Sight sight,
        String target) {
        Entity entity = sight == null || sight.hit == null ? null : sight.hit.entityHit;
        if (entity == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：target=entity 但视线没有命中任何实体（先 player.look {lookAt:[…]} 或 player.move 靠近）",
                Json.object("action", NAME, "sight", PlayerSession.sightRead(sight)));
        }
        if (entity == server) {
            throw CpException.param("目标非法", "target", "不能与自己交互");
        }
        int entityId = entity.getEntityId();
        JsonObject before = PlayerDigAction.entityRead(entity);
        boolean itemEntity = entity instanceof EntityItem;
        int invBefore = PlayerSession.countInInventory(server, null, 0, false);

        boolean handled;
        try {
            // 原版 Minecraft.func_147121_ag case 1：interactWithEntitySendPacket
            handled = controller.interactWithEntitySendPacket(client, entity);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                NAME + "：interactWithEntitySendPacket 抛出异常: " + t,
                Json.object("action", NAME, "entityId", Integer.valueOf(entityId)),
                t);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        Entity after = PlayerDigAction.findEntity(world, entityId);
        int invAfter = PlayerSession.countInInventory(server, null, 0, false);
        JsonObject o = new JsonObject();
        o.addProperty("target", "entity");
        o.addProperty("requestedTarget", target);
        o.add("entity", before);
        o.add("sight", PlayerSession.sightRead(sight));
        o.addProperty("handled", Boolean.valueOf(handled));
        o.addProperty("removed", Boolean.valueOf(after == null));
        o.add("entityAfter", after == null ? null : PlayerDigAction.entityRead(after));
        o.addProperty("inventoryCountBefore", Integer.valueOf(invBefore));
        o.addProperty("inventoryCountAfter", Integer.valueOf(invAfter));
        o.add("heldBefore", PlayerSession.heldRead(server));
        o.addProperty("itemEntity", Boolean.valueOf(itemEntity));
        // observed：实体交互的可观察产物 — 实体被移除（捡起/被消耗）或背包总数变了
        boolean observed = after == null || invAfter != invBefore;
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "实体交互未产生可观察变化（实体仍在、背包总数未变）：该实体的 interactFirst 返回 false 或"
                    + "服务端因距离（processUseEntity：可见 36 / 不可见 9）拒了这次交互");
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.interactWithEntitySendPacket（C02PacketUseEntity(INTERACT)），"
                + "服务端在 NetHandlerPlayServer.processUseEntity 的 INTERACT 分支跑 playerEntity.interactWith(entity)；"
                + "对着掉落物右键会经 EntityItem.interactFirst 把它捡起来——那是「右键拿起」，"
                + "与 player.pickup（走过去碰到）是同一件事的两条玩家入口，结论不互替");
        o.addProperty(
            "guardedKick",
            "注意：原版服务端对 EntityItem/EntityXPOrb/EntityArrow 的 <b>ATTACK</b> 会踢下线（processUseEntity）；"
                + "本动作走的是 INTERACT 分支，不触发该行为");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "（实体）：handled=" + handled + " observed=" + observed,
            Json.object("entityId", Integer.valueOf(entityId), "observed", Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "interact-entity", o, server);
    }

    // ------------------------------------------------------------ 方块分支

    private JsonObject interactBlock(ActionContext ctx, EntityClientPlayerMP client, PlayerControllerMP controller,
        NetHandlerPlayClient handler, EntityPlayerMP server, WorldServer world, int[] at, PlayerSession.Sight sight,
        int openBefore, String openClassBefore, JsonObject heldBefore, String target) {
        int x;
        int y;
        int z;
        int side;
        net.minecraft.util.Vec3 hitVec;
        if (at != null) {
            x = at[0];
            y = at[1];
            z = at[2];
            if (sight != null && sight.blockHit() && sameBlock(sight.blockPos(), at)) {
                side = sight.side();
                hitVec = sight.hit.hitVec;
            } else {
                // 未瞄准：给顶面中心（原版对着方块顶部右键的常见命中点）
                side = 1;
                hitVec = net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y + 1.0D, z + 0.5D);
            }
        } else {
            int[] bp = sight.blockPos();
            x = bp[0];
            y = bp[1];
            z = bp[2];
            side = sight.side();
            hitVec = sight.hit.hitVec;
        }

        TileEntity teBefore = world.getTileEntity(x, y, z);
        boolean containerBefore = teBefore instanceof IInventory;
        JsonObject before = PlayerSession.blockRead(world, x, y, z);
        ItemStack held = server.getHeldItem();

        boolean activated;
        try {
            // 原版 Minecraft.func_147121_ag case 2：onPlayerRightClick
            activated = controller.onPlayerRightClick(client, client.worldObj, held, x, y, z, side, hitVec);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                NAME + "：onPlayerRightClick 抛出异常: " + t,
                Json.object("action", NAME, "at", PlayerSession.posArray(x, y, z), "side", Integer.valueOf(side)),
                t);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        JsonObject after = PlayerSession.blockRead(world, x, y, z);
        int openAfter = server.openContainer == null ? 0 : server.openContainer.windowId;
        String openClassAfter = server.openContainer == null ? null
            : server.openContainer.getClass()
                .getName();
        boolean containerOpened = openAfter != openBefore
            || (openClassAfter != null && !openClassAfter.equals(openClassBefore));

        JsonObject o = new JsonObject();
        o.addProperty("target", "block");
        o.addProperty("requestedTarget", target);
        o.add("at", PlayerSession.posArray(x, y, z));
        o.addProperty("side", Integer.valueOf(side));
        o.add("before", before);
        o.add("after", after);
        o.add("sight", PlayerSession.sightRead(sight));
        o.addProperty("activated", Boolean.valueOf(activated));
        o.addProperty("blockChanged", Boolean.valueOf(blockChanged(before, after)));
        o.addProperty("blockWasContainer", Boolean.valueOf(containerBefore));
        o.addProperty("containerOpened", Boolean.valueOf(containerOpened));
        JsonObject container = new JsonObject();
        container.addProperty("windowIdBefore", Integer.valueOf(openBefore));
        container.addProperty("windowIdAfter", Integer.valueOf(openAfter));
        container.addProperty("classBefore", openClassBefore);
        container.addProperty("classAfter", openClassAfter);
        container.addProperty("containerOpened", Boolean.valueOf(containerOpened));
        o.add("container", container);
        o.add("heldBefore", heldBefore);
        o.add("heldAfter", PlayerSession.heldRead(server));
        // observed：方块被激活（返回 true）就算玩家路径产生了交互——原版的 onBlockActivated 返回 true
        // 即「这次右键被这个方块吃下了」（开箱子/开门/拉杆都返回 true）
        boolean observed = activated || containerOpened || blockChanged(before, after);
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "onBlockActivated 返回 false 且方块未变、容器未开：该方块在这个面/这个手持物下没有交互行为，"
                    + "或服务端因距离（processPlayerBlockPlacement 的 dist）拒了这次右键。"
                    + "「方块没反应」不等于「动作失败」——动作按玩家路径执行了");
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.onPlayerRightClick（C08PacketPlayerBlockPlacement），"
                + "服务端在 NetHandlerPlayServer.processPlayerBlockPlacement 的 else 分支跑 "
                + "ItemInWorldManager.activateBlockOrUseItem（onItemUseFirst → onBlockActivated → tryPlaceItemIntoWorld）；"
                + "容器被打开时会经 S2DPacketOpenWindow 回到客户端，因此 containerOpened 是本动作特有的观察量");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "（方块）：" + x + "," + y + "," + z + " activated=" + activated + " containerOpened=" + containerOpened,
            Json.object(
                "at",
                PlayerSession.posArray(x, y, z),
                "activated",
                Boolean.valueOf(activated),
                "containerOpened",
                Boolean.valueOf(containerOpened)));
        return PlayerSession.decorated(NAME, "interact-block", o, server);
    }

    // ------------------------------------------------------------ 工具

    /** 两格读数是否不同（blockId/meta 任一）。 */
    static boolean blockChanged(JsonObject before, JsonObject after) {
        if (before == null || after == null) {
            return false;
        }
        int bid = before.get("blockId") == null ? -1
            : before.get("blockId")
                .getAsInt();
        int aid = after.get("blockId") == null ? -2
            : after.get("blockId")
                .getAsInt();
        int bm = before.get("meta") == null ? -1
            : before.get("meta")
                .getAsInt();
        int am = after.get("meta") == null ? -2
            : after.get("meta")
                .getAsInt();
        return bid != aid || bm != am;
    }

    private static boolean sameBlock(int[] a, int[] b) {
        return a != null && b != null && a[0] == b[0] && a[1] == b[1] && a[2] == b[2];
    }

    /** 取方块坐标参数 {@code [x,y,z]}。 */
    private static int[] optBlockPos(ActionContext ctx, String name) {
        com.google.gson.JsonArray a = ctx.optArray(name);
        if (a == null) {
            return null;
        }
        if (a.size() != 3) {
            throw CpException.param("坐标非法", name, "须为 [x,y,z] 三个数");
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            try {
                out[i] = (int) Math.floor(
                    a.get(i)
                        .getAsDouble());
            } catch (RuntimeException e) {
                throw CpException.param("坐标分量非法", name + "[" + i + "]", "须为数字");
            }
        }
        return out;
    }
}
