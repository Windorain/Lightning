package com.lightning.mod.client.controlplane.mc.player;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.item.EntityItem;
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
 * {@code player.pickup}（scene，步进）：<b>拾取掉落物</b>——「拿到物品」之 L1 义。
 *
 * <h2>两义标注</h2>
 * 「拿到物品」有两义，两面都做、<b>按层标注</b>：
 * <table border="1">
 * <caption>两义对照</caption>
 * <tr>
 * <th>义</th>
 * <th>动作</th>
 * <th>层</th>
 * <th>怎么拿到</th>
 * </tr>
 * <tr>
 * <td><b>给</b></td>
 * <td>{@code scene.inventory.write}</td>
 * <td>{@code L0}</td>
 * <td>直接把 {@code {id,meta,count,nbt}} 写进槽位——布景、构造输入</td>
 * </tr>
 * <tr>
 * <td><b>拾取</b></td>
 * <td>{@code player.pickup}（本动作）</td>
 * <td>{@code L1}</td>
 * <td>世界里已有掉落物实体，玩家<b>走过去碰它</b>，由原版
 * {@code EntityItem.onCollideWithPlayer → InventoryPlayer.addItemStackToInventory} 收进背包</td>
 * </tr>
 * </table>
 * 本动作的返回值带 {@code layer:"L1"} + {@code semantics:"pickup"}，与 L0 的
 * {@code layer:"L0"} + {@code semantics:"give"} 成对；两层结论不互替——
 * {@code scene.inventory.write} 的写入<b>不是</b>「捡起来了」的证据，本动作的拾取<b>不是</b>
 * 「布景输入」的替代品。
 *
 * <h2>怎么「走过去」（真实移动路径，不是瞬移）</h2>
 * 本动作内部用 {@link PlayerMoveAction} 的同一条移动原语（原版 {@code AABB} 碰撞推进 +
 * {@code EntityClientPlayerMP.sendMotionUpdates()}），把玩家逐 tick 走到掉落物处，
 * 然后<b>让服务端自己发现碰撞</b>：服务端 {@code EntityPlayer.onUpdate} 每 tick 对
 * 玩家包围盒外扩 {@code (1.0, 0.5, 1.0)} 内的实体调 {@code onCollideWithPlayer}，
 * 掉落物因此被收进 {@code InventoryPlayer}。本动作<b>不</b>调用
 * {@code addItemStackToInventory}，也<b>不</b>直接改背包——那会让它变成 L0。
 *
 * <h2>为什么是步进动作</h2>
 * 拾取必须等：①掉落物的 {@code delayBeforeCanPickup}（原版 {@code dropPlayerItem} 设 40 tick）
 * 归零；②足够多的服务端 tick 让碰撞检测真的发生。一次调用内跑不完，
 * 因此本动作在若干 tick 内推进，每 tick 走一小步并检查「背包里是否已经多了该物品」，
 * 拿到了就立刻返回（不空转到超时）。
 *
 * <h2>失败显式（负场景）</h2>
 * 走过来但没捡到（掉落物还在、背包没变）⇒ {@code observed:false} + 逐项原因
 * （{@code delayBeforeCanPickup} 未到 / 背包满 / 玩家没真的走到 / 掉落物已消失）。
 * 进程不受影响，可继续试错（探索模式纪律）。
 */
public final class PlayerPickupAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.pickup";

    /** 每 tick 移动的格数（同 {@link PlayerMoveAction#STEP_PER_TICK}）。 */
    public static final double STEP_PER_TICK = PlayerMoveAction.STEP_PER_TICK;

    /** 默认最大 tick 数。 */
    public static final int DEFAULT_MAX_TICKS = 200;

    /** 被视为「已到达」的水平距离（掉落物的拾取半径是玩家包围盒外扩 1 格，这里取 0.8 稳妥落入）。 */
    public static final double REACH_DISTANCE = 0.8D;

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        PlayerSession.requireController(NAME);
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

        Integer entityIdParam = ctx.has("entityId") ? Integer.valueOf(ctx.optInt("entityId", -1)) : null;
        String itemId = ctx.optString("item", null);
        int meta = ctx.optInt("meta", 0);
        boolean matchMeta = ctx.has("meta");
        int maxTicks = ctx.optInt("maxTicks", DEFAULT_MAX_TICKS);
        if (maxTicks < 1 || maxTicks > 12000) {
            throw CpException.param("maxTicks 非法", "maxTicks", "须在 1..12000，收到 " + maxTicks);
        }
        boolean approach = ctx.optBool("approach", true);

        if (entityIdParam == null && (itemId == null || itemId.trim()
            .isEmpty())) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "缺少拾取目标",
                Json.object(
                    "fields",
                    Json.object(
                        "entityId",
                        "给 entityId（scene.entity.spawn 的返回值里有）",
                        "item",
                        "或给 item:\"minecraft:stone\"（可配 meta）",
                        "note",
                        "两者必居其一；都给时先按 entityId 找，找不到再按 item 找")));
        }

        // 目标掉落物：优先 entityId，回落 item(+meta)
        EntityItem targetItem = null;
        if (entityIdParam != null) {
            Entity e = PlayerDigAction.findEntity(world, entityIdParam.intValue());
            if (e instanceof EntityItem) {
                targetItem = (EntityItem) e;
            } else if (e != null) {
                throw CpException.param(
                    "entityId 指向的不是掉落物",
                    "entityId",
                    "该实体是 " + e.getClass()
                        .getName() + "（player.pickup 只处理 EntityItem；右键交互实体请用 player.interact）");
            }
        }
        List<EntityItem> candidates = new ArrayList<EntityItem>();
        if (targetItem == null) {
            candidates.addAll(findItems(world, itemId, matchMeta ? Integer.valueOf(meta) : null));
            if (candidates.isEmpty()) {
                throw new CpException(
                    ErrorCodes.STATE,
                    NAME + "：世界里没有匹配的掉落物",
                    Json.object(
                        "action",
                        NAME,
                        "entityId",
                        entityIdParam,
                        "item",
                        itemId,
                        "meta",
                        matchMeta ? Integer.valueOf(meta) : null,
                        "hint",
                        "先用 scene.entity.spawn {item:\"minecraft:stone\",count:1,pos:[…]} 造一个掉落物（那是 L0 布景，"
                            + "构造本动作的输入），再调本动作拾取"));
            }
            // 最近的优先
            candidates.sort((a, b) -> Double.compare(distSq(server, a), distSq(server, b)));
            targetItem = candidates.get(0);
        }

        int targetId = targetItem.getEntityId();
        ItemStack stack = targetItem.getEntityItem();
        String targetItemId = stack == null ? null
            : String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(stack.getItem()));
        int targetMeta = stack == null ? 0 : stack.getItemDamage();
        int targetCount = stack == null ? 0 : stack.stackSize;

        int invBefore = PlayerSession.countInInventory(server, targetItemId, targetMeta, false);
        JsonArray invArrBefore = PlayerSession.inventoryRead(server);
        JsonObject poseBefore = PlayerSession.poseRead(server);

        // 逐 tick 靠近，并让服务端在自己 tick 里发现碰撞（拾取由服务端 EntityPlayer.onUpdate 触发）
        int steps = 0;
        boolean picked = false;
        int blockedTicks = 0;
        for (int i = 0; i < maxTicks; i++) {
            Entity live = PlayerDigAction.findEntity(world, targetId);
            if (live == null) {
                // 掉落物消失 = 已被拾取（或过期/合并）
                picked = true;
                break;
            }
            int nowInv = PlayerSession.countInInventory(server, targetItemId, targetMeta, false);
            if (nowInv > invBefore) {
                picked = true;
                break;
            }
            if (approach) {
                // 「是否同层」必须按**服务端空间**比较：客户端 posY 与服务端 posY 差一个
                // S08 约定偏移（1.7.10：客户端 posY = 服务端 posY + 1.62，见 PlayerSession.clientYOffset）。
                // 首轮实测用客户端 posY 比，于是同层被误判成「差 1.62 层」，插入向下走，
                // 玩家斜着走、卡在地板边缘并横向漂出平台（终点 x=62.69，平台是 63..70）。
                double levelDiff = live.posY - server.posY;
                double targetY = Math.abs(levelDiff) > 1.0D ? live.posY : server.posY;
                // 水平距离够近了就不再走（剩下交给服务端的碰撞拾取）
                double dx = live.posX - server.posX;
                double dz = live.posZ - server.posZ;
                double horiz = Math.sqrt(dx * dx + dz * dz);
                if (horiz <= REACH_DISTANCE) {
                    // 已到拾取半径内：不动，只把位置发一次让服务端有机会做碰撞检测
                    client.sendMotionUpdates();
                } else {
                    double moved;
                    try {
                        moved = PlayerSession
                            .stepTowardServer(client, server, live.posX, targetY, live.posZ, STEP_PER_TICK);
                    } catch (Throwable t) {
                        throw new CpException(
                            ErrorCodes.EXEC_FAILED,
                            NAME + "：靠近过程中移动失败（第 " + (i + 1) + " tick）: " + t,
                            Json.object(
                                "action",
                                NAME,
                                "entityId",
                                Integer.valueOf(targetId),
                                "tick",
                                Integer.valueOf(i + 1)),
                            t);
                    }
                    if (moved < 1.0E-4D) {
                        blockedTicks++;
                    } else {
                        blockedTicks = 0;
                    }
                    if (blockedTicks >= 20) {
                        break; // 被方块挡住：如实停手并报 notObserved，不硬穿
                    }
                }
            } else {
                // 不移动也要把位置发一次，让服务端有机会做碰撞检测
                try {
                    client.sendMotionUpdates();
                } catch (Throwable t) {
                    throw new CpException(
                        ErrorCodes.EXEC_FAILED,
                        NAME + "：客户端位置包发送失败（第 " + (i + 1) + " tick）: " + t,
                        Json.object("action", NAME, "tick", Integer.valueOf(i + 1)),
                        t);
                }
            }
            steps++;
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        EntityItem leftover = (EntityItem) PlayerDigAction.findEntity(world, targetId);
        int invAfter = PlayerSession.countInInventory(server, targetItemId, targetMeta, false);
        boolean stackGone = leftover == null;
        // observed：L1 说「捡起来了」，可观察的权威证据是背包里该物品多了（或掉落物实体没了）
        boolean observed = invAfter > invBefore || stackGone;
        // picked 必须由**最终观察**决定，而不是只看循环里有没有当场撞见：
        // 首轮实测里掉落物在动作收尾之后的服务端 tick 才被收掉，循环没撞见 → picked=false
        // 而 observed=true —— 同一个结果里两个字段互相矛盾，读的人不知道该信哪个。
        // 现在两者同源：picked 即「最终观察到了拾取」（循环内的当场撞见只是更早的同一个结论）。
        picked = observed || picked;

        JsonObject o = new JsonObject();
        o.addProperty("entityId", Integer.valueOf(targetId));
        o.addProperty("itemId", targetItemId);
        o.addProperty("meta", Integer.valueOf(targetMeta));
        o.addProperty("stackCount", Integer.valueOf(targetCount));
        o.add("poseBefore", poseBefore);
        o.add("poseAfter", PlayerSession.poseRead(server));
        o.addProperty("ticks", Integer.valueOf(steps));
        o.addProperty("maxTicks", Integer.valueOf(maxTicks));
        o.addProperty("approach", Boolean.valueOf(approach));
        o.addProperty("inventoryCountBefore", Integer.valueOf(invBefore));
        o.addProperty("inventoryCountAfter", Integer.valueOf(invAfter));
        o.addProperty("inventoryDelta", Integer.valueOf(invAfter - invBefore));
        o.addProperty("itemEntityGone", Boolean.valueOf(stackGone));
        o.addProperty("picked", Boolean.valueOf(picked));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        o.add("inventoryBefore", invArrBefore);
        o.add("inventoryAfter", PlayerSession.inventoryRead(server));
        o.addProperty("remainingItemEntities", Integer.valueOf(findItems(world, null, null).size()));
        if (targetItem != null && targetItem.delayBeforeCanPickup > 0 && !observed) {
            o.addProperty("delayBeforeCanPickup", Integer.valueOf(targetItem.delayBeforeCanPickup));
        }
        if (!observed) {
            StringBuilder why = new StringBuilder();
            // 玩家自己被推离/掉出场景是最容易被误判成「拾取没生效」的形态：实测里僵尸把玩家
            // 从平台上推下去（终点 x=58, y=7.5，而平台是 63..70），于是动作永远走不到掉落物那儿。
            // 这种情况必须**单独说清**，否则调用方会去怀疑拾取实现本身。
            double fellBy = poseBefore == null || poseBefore.get("pos") == null ? 0.0D
                : poseBefore.get("pos")
                    .getAsJsonArray()
                    .get(1)
                    .getAsDouble() - (server == null ? 0.0D : server.posY);
            if (fellBy > 2.0D) {
                why.append(
                    "**玩家自己掉了 " + round(fellBy)
                        + " 格**（起点 y="
                        + (poseBefore == null || poseBefore.get("pos") == null ? "?"
                            : poseBefore.get("pos")
                                .getAsJsonArray()
                                .get(1))
                        + " → 终点 y="
                        + round(server == null ? 0.0D : server.posY)
                        + "）：多为离开了平台边缘或掉进虚空。拾取要求玩家真的走到掉落物旁边，"
                        + "掉下去就走不到了——先确保有落脚平台（L0 铺地板），并清掉会把玩家推开的实体"
                        + "（scene.entity.clear）");
            }
            if (leftover != null) {
                why.append("掉落物仍在世界");
                if (leftover.delayBeforeCanPickup > 0) {
                    why.append(
                        "（delayBeforeCanPickup=" + leftover.delayBeforeCanPickup + " 尚未归零——原版扔出/生成的物品有拾取延迟，多给几 tick）");
                }
                double d = Math.sqrt(distSq(server, leftover));
                why.append("；与玩家的距离 " + round(d) + " 格");
                if (d > 1.6D) {
                    why.append("（服务端按玩家包围盒外扩 1 格判定碰撞，距离过远时不会触发拾取：" + "多为被方块挡住走不过去、掉落物悬空，或玩家被推离）");
                }
            }
            if (invAfter == invBefore) {
                why.append("；背包内该物品数量未变（也可能是背包已满——addItemStackToInventory 失败）");
            }
            o.addProperty("notObservedReason", why.toString());
        }
        o.addProperty(
            "layerNote",
            "L1「拾取」：走玩家移动路径靠近，由服务端 EntityItem.onCollideWithPlayer → "
                + "EntityPlayer.inventory.addItemStackToInventory 收进背包。"
                + "与 L0 的 scene.inventory.write（semantics:\"give\"）是两义，两层结论不互替（L0 构造输入、L1 验证行为）");
        o.addProperty(
            "pathNote",
            "本动作不调用 addItemStackToInventory、不直接改背包——那会把它降级成 L0。"
                + "它只做两件事：①按原版碰撞推进玩家并让客户端发 C03（EntityClientPlayerMP.sendMotionUpdates）；"
                + "②等。拾取本身由服务端 EntityPlayer.onUpdate 的 collideWithPlayer 触发。"
                + "因此「捡到了」这件事的产物来自玩家路径");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：entityId=" + targetId + " 拾取=" + observed + "（背包 " + invBefore + " → " + invAfter + "）",
            Json.object(
                "entityId",
                Integer.valueOf(targetId),
                "inventoryDelta",
                Integer.valueOf(invAfter - invBefore),
                "observed",
                Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "pickup", o, server);
    }

    /** 世界里匹配的掉落物（{@code item} 为 null 即全部掉落物）。 */
    private static List<EntityItem> findItems(WorldServer world, String itemId, Integer meta) {
        List<EntityItem> out = new ArrayList<EntityItem>();
        if (world == null || world.loadedEntityList == null) {
            return out;
        }
        for (Object o : world.loadedEntityList) {
            if (!(o instanceof EntityItem)) {
                continue;
            }
            EntityItem it = (EntityItem) o;
            ItemStack s = it.getEntityItem();
            if (s == null || s.getItem() == null) {
                continue;
            }
            if (itemId != null && !itemId.trim()
                .isEmpty()) {
                String id = String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(s.getItem()));
                if (!itemId.trim()
                    .equals(id)) {
                    continue;
                }
                if (meta != null && s.getItemDamage() != meta.intValue()) {
                    continue;
                }
            }
            out.add(it);
        }
        return out;
    }

    private static double distSq(EntityPlayerMP player, EntityItem item) {
        double dx = item.posX - player.posX;
        double dy = item.posY - player.posY;
        double dz = item.posZ - player.posZ;
        return dx * dx + dy * dy + dz * dz;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0D) / 1000.0D;
    }
}
