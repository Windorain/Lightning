package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.multiplayer.PlayerControllerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.place_block}（scene，同步）：<b>放置方块</b>——玩家手持方块对着某面右键。
 *
 * <h2>走的是哪条玩家路径</h2>
 * 与 {@code player.interact} 同一个原版出口 {@code PlayerControllerMP.onPlayerRightClick}，
 * 但语义与断言不同：本动作的 L1 义是「玩家把手里的方块<b>摆</b>到了世界上」，
 * 因此它的 {@code returns} 以<b>逐格 before/after 方块读回</b>为主，
 * 并如实报告「手里少了一个」。
 *
 * <h2>{@code at} 与 {@code side} 的语义</h2>
 * {@code at} 是<b>被右键的那个方块</b>（不是新方块要出现的位置），{@code side} 是右键命中的面；
 * 新方块出现在 {@code at} 沿 {@code side} 方向偏移一格处——这正是原版
 * {@code ItemBlock.onItemUse} 的放置规则（{@code NetHandlerPlayServer.processPlayerBlockPlacement}
 * 里那段 {@code if (l == 0) --j; …} 是同一套偏移）。因此：
 * <ul>
 * <li>{@code side:1}（顶面）⇒ 新方块在 {@code (x, y+1, z)}；</li>
 * <li>{@code side:0}（底面）⇒ {@code (x, y-1, z)}；{@code side:2/3} ⇒ z∓1；{@code side:4/5} ⇒ x∓1。</li>
 * </ul>
 * <b>默认目标格</b>：不给 {@code at} 时用玩家脚下那一格的地板（玩家所在格向下找第一格非空气）
 * 的顶面——这是「站着往脚下放」的自然口径，且不需要任何瞄准。
 * 给了 {@code at} 就按 {@code at}+{@code side} 来。
 *
 * <h2>为什么这里要 <b>真实朝向</b> 而不是只发个包</h2>
 * {@code onPlayerRightClick} 的客户端本地预测会跑 {@code ItemBlock.tryPlaceItemIntoWorld}，
 * 而服务端会让 {@code ItemInWorldManager.activateBlockOrUseItem} 再跑一遍权威放置。
 * 两遍都由原版产生结果（含 {@code isCreative()} 的「不扣物品」分支、Forge 的
 * {@code PlayerInteractEvent}、{@code Block.canPlaceBlockAt} 判定），本动作一处都不复制。
 */
public final class PlaceBlockAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.place_block";

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

        // 手持必须是方块物品——原版 PlayerControllerMP.onPlayerRightClick 里
        // 「放着地」的那条路要求 itemStackIn.getItem() instanceof ItemBlock。
        ItemStack held = server.getHeldItem();
        if (held == null || held.getItem() == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：手上没有物品，无法放置（放置的前提是手持一个方块物品）",
                Json.object(
                    "action",
                    NAME,
                    "held",
                    PlayerSession.heldRead(server),
                    "hint",
                    "先 scene.inventory.write 给快捷栏某一格一个方块物品，再 player.hold_slot 选到它（或直接写在 currentItem 那一格）"));
        }
        if (!(held.getItem() instanceof net.minecraft.item.ItemBlock)) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：手持物品不是方块（不可放置）",
                Json.object(
                    "action",
                    NAME,
                    "heldItem",
                    String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(held.getItem())),
                    "hint",
                    "换成方块物品（如 minecraft:stone / minecraft:torch / minecraft:chest）"));
        }

        int[] at = optBlockPos(ctx, "at");
        Integer sideParam = ctx.has("side") ? Integer.valueOf(ctx.optInt("side", 1)) : null;
        if (sideParam != null && (sideParam.intValue() < 0 || sideParam.intValue() > 5)) {
            throw CpException.param("side 非法", "side", "须在 0..5（0=下 1=上 2=北 3=南 4=西 5=东），收到 " + sideParam);
        }

        int x;
        int y;
        int z;
        int side;
        if (at != null) {
            x = at[0];
            y = at[1];
            z = at[2];
            side = sideParam == null ? 1 : sideParam.intValue();
        } else {
            // 无 at：用玩家脚下地板那一格的顶面
            int px = (int) Math.floor(server.posX);
            int pz = (int) Math.floor(server.posZ);
            int py = (int) Math.floor(server.posY);
            int floorY = Integer.MIN_VALUE;
            for (int yy = py; yy >= Math.max(0, py - 8); yy--) {
                net.minecraft.block.Block b = world.getBlock(px, yy, pz);
                if (b != null && b.getMaterial() != net.minecraft.block.material.Material.air) {
                    floorY = yy;
                    break;
                }
            }
            if (floorY == Integer.MIN_VALUE) {
                throw new CpException(
                    ErrorCodes.STATE,
                    NAME + "：玩家脚下 8 格内没有地板，无法确定放置目标（给 at:[x,y,z] 明确指定被右键的方块）",
                    Json.object(
                        "action",
                        NAME,
                        "playerPos",
                        PlayerSession.doubleArray(server.posX, server.posY, server.posZ),
                        "hint",
                        "先 scene.player.pose 或 player.move 到有地板的位置，或直接给 at"));
            }
            x = px;
            y = floorY;
            z = pz;
            side = 1;
        }

        // 目标格（新方块将出现的位置），按原版的 side 偏移规则
        int[] targetPos = offset(x, y, z, side);
        JsonObject beforeBlock = PlayerSession.blockRead(world, targetPos[0], targetPos[1], targetPos[2]);
        JsonObject atBefore = PlayerSession.blockRead(world, x, y, z);
        ItemStack heldBefore = held;
        int countBefore = held.stackSize;

        double distSq = PlayerSession.serverReachSquared(server, x, y, z);
        double limitSq = PlayerSession.serverReachLimitSquared();
        boolean inReach = distSq >= 0.0D && distSq <= limitSq;

        // 命中点：给该面的中心（原版对着面中心右键的常见命中）
        net.minecraft.util.Vec3 hitVec = faceCenter(x, y, z, side);

        boolean placed;
        try {
            placed = controller.onPlayerRightClick(client, client.worldObj, heldBefore, x, y, z, side, hitVec);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                NAME + "：onPlayerRightClick 抛出异常: " + t,
                Json.object("action", NAME, "at", PlayerSession.posArray(x, y, z), "side", Integer.valueOf(side)),
                t);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        JsonObject afterBlock = PlayerSession.blockRead(world, targetPos[0], targetPos[1], targetPos[2]);
        JsonObject atAfter = PlayerSession.blockRead(world, x, y, z);
        ItemStack heldAfter = server.getHeldItem();
        boolean placedObserved = PlayerInteractAction.blockChanged(beforeBlock, afterBlock);

        JsonObject o = new JsonObject();
        o.add("at", PlayerSession.posArray(x, y, z));
        o.addProperty("side", Integer.valueOf(side));
        o.add("target", PlayerSession.posArray(targetPos[0], targetPos[1], targetPos[2]));
        o.add("atBefore", atBefore);
        o.add("atAfter", atAfter);
        o.add("before", beforeBlock);
        o.add("after", afterBlock);
        o.addProperty("placed", Boolean.valueOf(placed));
        o.addProperty("blockAppeared", Boolean.valueOf(placedObserved));
        o.addProperty("distanceSquared", Double.valueOf(round(distSq)));
        o.addProperty("serverReachLimitSquared", Double.valueOf(round(limitSq)));
        o.addProperty("inServerReach", Boolean.valueOf(inReach));
        o.addProperty(
            "heldItemId",
            String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(heldBefore.getItem())));
        o.add("heldBefore", PlayerSession.stackRead(heldBefore));
        o.add("heldAfter", PlayerSession.stackRead(heldAfter));
        o.add("heldChange", UseItemAction.stackChange(heldBefore, heldAfter));
        o.addProperty("heldCountBefore", Integer.valueOf(countBefore));
        o.addProperty("heldCountAfter", Integer.valueOf(heldAfter == null ? 0 : heldAfter.stackSize));
        JsonObject gameMode = new JsonObject();
        if (server.theItemInWorldManager != null) {
            gameMode.addProperty("isCreative", Boolean.valueOf(server.theItemInWorldManager.isCreative()));
        }
        o.add("gameMode", gameMode);
        boolean observed = placedObserved;
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            StringBuilder why = new StringBuilder();
            if (!inReach) {
                why.append(
                    "被右键的方块超出服务端交互距离（d²=" + round(distSq)
                        + " > "
                        + round(limitSq)
                        + "，服务端 processPlayerBlockPlacement 会跳过放置）；");
            }
            if (beforeBlock.get("blockId") != null && beforeBlock.get("blockId")
                .getAsInt() != 0) {
                why.append("目标格已有方块（" + beforeBlock.get("id") + "），放置不会发生；");
            }
            if (why.length() == 0) {
                why.append(
                    "目标格仍是空气：多为该方块在此位置不可放置（canPlaceBlockAt / 需要支撑 / 需要特殊上下文），"
                        + "或服务端把这次放置拒了。plced=false 且持有数未变时，通常是被 canPlaceBlockAt 拒；"
                        + "持有数变了而目标格仍空说明放在别处了——对照 atAfter");
            }
            o.addProperty("notObservedReason", why.toString());
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.onPlayerRightClick（C08PacketPlayerBlockPlacement），"
                + "服务端在 NetHandlerPlayServer.processPlayerBlockPlacement 的 else 分支跑 "
                + "ItemInWorldManager.activateBlockOrUseItem → ItemBlock.tryPlaceItemIntoWorld；"
                + "创造模式不会扣物品（原版 isCreative 分支），因此 heldChange 在创造模式下为空是正常的");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：目标格 " + targetPos[0] + "," + targetPos[1] + "," + targetPos[2] + " 出现方块=" + observed,
            Json.object(
                "at",
                PlayerSession.posArray(x, y, z),
                "target",
                PlayerSession.posArray(targetPos[0], targetPos[1], targetPos[2]),
                "observed",
                Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "place-block", o, server);
    }

    /** 按 side 偏移一格（与原版 {@code processPlayerBlockPlacement} 的偏移规则逐字一致）。 */
    static int[] offset(int x, int y, int z, int side) {
        switch (side) {
            case 0:
                return new int[] { x, y - 1, z };
            case 1:
                return new int[] { x, y + 1, z };
            case 2:
                return new int[] { x, y, z - 1 };
            case 3:
                return new int[] { x, y, z + 1 };
            case 4:
                return new int[] { x - 1, y, z };
            case 5:
                return new int[] { x + 1, y, z };
            default:
                return new int[] { x, y, z };
        }
    }

    /** 某面的中心点（命中点）。 */
    static net.minecraft.util.Vec3 faceCenter(int x, int y, int z, int side) {
        switch (side) {
            case 0:
                return net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y, z + 0.5D);
            case 1:
                return net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y + 1.0D, z + 0.5D);
            case 2:
                return net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y + 0.5D, z);
            case 3:
                return net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y + 0.5D, z + 1.0D);
            case 4:
                return net.minecraft.util.Vec3.createVectorHelper(x, y + 0.5D, z + 0.5D);
            case 5:
                return net.minecraft.util.Vec3.createVectorHelper(x + 1.0D, y + 0.5D, z + 0.5D);
            default:
                return net.minecraft.util.Vec3.createVectorHelper(x + 0.5D, y + 1.0D, z + 0.5D);
        }
    }

    /** 取方块坐标参数 {@code [x,y,z]}。 */
    private static int[] optBlockPos(ActionContext ctx, String name) {
        JsonArray a = ctx.optArray(name);
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

    private static double round(double v) {
        return Math.round(v * 1000.0D) / 1000.0D;
    }
}
