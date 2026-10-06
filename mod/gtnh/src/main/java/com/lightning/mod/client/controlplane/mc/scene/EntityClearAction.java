package com.lightning.mod.client.controlplane.mc.scene;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityList;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.entity.clear}（scene，同步）：清除范围内实体（含掉落物），让场景回到干净状态。
 *
 * <h2>与 {@code world.rebuild} 的分工（hermetic 纪律）</h2>
 * 验收类固定程序的<b>起世界</b>手段是 {@code world.rebuild}（虚空重建，契约 §6.3 与
 * case-file.md §8.8 的 hermetic 纪律）——它连存档目录一起换掉，残留不可能跨轮存活。
 * 本动作是<b>轮内</b>的清场原语：同一轮里想「换个实体布局再来一次」时用它，比整轮重建快得多。
 * <b>它不构成 hermetic 保证</b>：不清方块、不清背包、不重置天气时间，因此不能替代起手重建。
 *
 * <h2>选择条件</h2>
 * <ul>
 * <li>{@code box}：{@code [[minx,miny,minz],[maxx,maxy,maxz]]}，按实体包围盒中心落在盒内判定；</li>
 * <li>{@code entity}：只清该注册名（{@code EntityList} 名；<b>1.7.10 的原生键不带
 * {@code minecraft:} 前缀</b>，如 {@code Item}/{@code Zombie}；{@code minecraft:item} 这类现代写法
 * 也接受——解析走 {@link RegistryNames}，宽容只发生在匹配阶段）；</li>
 * <li>{@code item}：只清掉落物里物品为该项的（可带 {@code meta}；不给 meta 即不限）；</li>
 * <li>{@code includePlayers}：是否连玩家一起清（<b>默认 false</b>——清掉自己会让后续
 * 无人值守流程卡在无玩家状态，必须是显式选择）。</li>
 * </ul>
 * 三者可组合（交集），全不给即「清掉世界里除玩家外的全部实体」。
 *
 * <h2>为什么用 {@code removeEntity} 而不是 {@code setDead}</h2>
 * {@code setDead()} 只是打标记，实体要到服务端本 tick 的清扫阶段才真正离场，而那个阶段已经过了
 * 本动作的执行点——调用方紧接着读 {@code loadedEntityList} 会读到「还在」。{@code removeEntity}
 * 会当场把实体摘出世界（含 {@code setDead} + 卸载钩子），因此清场「调用即生效」，
 * 不需要额外 tick 才能观察到。
 */
public final class EntityClearAction implements ControlAction {

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.entity.clear");

        double[][] box = optBox(ctx);
        String entityId = trimToNull(ctx.optString("entity", null));
        String itemId = trimToNull(ctx.optString("item", null));
        boolean hasMeta = ctx.has("meta");
        int meta = ctx.optInt("meta", 0);
        boolean includePlayers = ctx.optBool("includePlayers", false);

        if (entityId != null && itemId != null) {
            throw CpException.param("entity 与 item 互斥", "item", "二者只能给一个（item 是掉落物的过滤简写）");
        }
        if (itemId != null) {
            // 物品注册名非法必须在入口就报，而不是「过滤掉 0 个」静默成功
            EntitySpawnAction.resolveItem(itemId, "item");
        }
        // 同理：不存在的实体名过滤出 0 个是假绿，入口直接拒。
        // 解析成注册表原始键（1.7.10 的键不带 minecraft: 前缀，实测 minecraft:item 查不到而 Item 才行）
        String matchEntityId = entityId == null ? null : RegistryNames.resolveEntityKey(entityId, "entity");

        List<Entity> hits = new ArrayList<Entity>();
        for (Entity e : new ArrayList<Entity>(world.loadedEntityList)) {
            if (e == null) {
                continue;
            }
            if (e instanceof EntityPlayer && !includePlayers) {
                continue;
            }
            if (!inBox(box, e)) {
                continue;
            }
            if (matchEntityId != null && !RegistryNames.sameEntity(matchEntityId, RegistryNames.entityKeyOf(e))) {
                continue;
            }
            if (itemId != null && !EntitySpawnAction.itemMatches(e, itemId, hasMeta, meta)) {
                continue;
            }
            hits.add(e);
        }

        JsonArray removed = new JsonArray();
        for (Entity e : hits) {
            JsonObject r = summarize(e);
            try {
                world.removeEntity(e);
                r.addProperty("removed", Boolean.valueOf(e.isDead));
            } catch (Throwable t) {
                r.addProperty("removed", Boolean.FALSE);
                r.addProperty("error", String.valueOf(t));
            }
            removed.add(r);
        }

        JsonObject o = new JsonObject();
        o.addProperty("removedCount", Integer.valueOf(removed.size()));
        o.add("removed", removed);
        o.add(
            "selector",
            Json.object(
                "box",
                box == null ? null : boxArray(box),
                "entity",
                matchEntityId,
                "item",
                itemId,
                "meta",
                hasMeta ? Integer.valueOf(meta) : null,
                "includePlayers",
                Boolean.valueOf(includePlayers)));
        o.addProperty("remainingEntities", Integer.valueOf(countRemaining(world, includePlayers)));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.entity.clear：移除 " + removed.size() + " 个实体",
            Json.object(
                "removedCount",
                Integer.valueOf(removed.size()),
                "includePlayers",
                Boolean.valueOf(includePlayers)));
        return L0Session.decorated("scene.entity.clear", o, world, mc);
    }

    // ------------------------------------------------------------ 判定

    private static boolean inBox(double[][] box, Entity e) {
        if (box == null) {
            return true;
        }
        double cx = (e.boundingBox.minX + e.boundingBox.maxX) / 2.0d;
        double cy = (e.boundingBox.minY + e.boundingBox.maxY) / 2.0d;
        double cz = (e.boundingBox.minZ + e.boundingBox.maxZ) / 2.0d;
        return cx >= box[0][0] && cx <= box[1][0]
            && cy >= box[0][1]
            && cy <= box[1][1]
            && cz >= box[0][2]
            && cz <= box[1][2];
    }

    private static int countRemaining(WorldServer world, boolean includePlayers) {
        int n = 0;
        for (Entity e : world.loadedEntityList) {
            if (e == null) {
                continue;
            }
            if (e instanceof EntityPlayer && !includePlayers) {
                continue;
            }
            n++;
        }
        return n;
    }

    private static JsonObject summarize(Entity e) {
        JsonObject o = new JsonObject();
        o.addProperty("entityId", EntityList.getEntityString(e));
        o.addProperty(
            "class",
            e.getClass()
                .getName());
        o.addProperty("entityIdNum", Integer.valueOf(e.getEntityId()));
        JsonArray pos = new JsonArray();
        Json.add(pos, Double.valueOf(Math.round(e.posX * 1000.0d) / 1000.0d));
        Json.add(pos, Double.valueOf(Math.round(e.posY * 1000.0d) / 1000.0d));
        Json.add(pos, Double.valueOf(Math.round(e.posZ * 1000.0d) / 1000.0d));
        o.add("pos", pos);
        if (e instanceof EntityItem) {
            ItemStack stack = ((EntityItem) e).getEntityItem();
            if (stack != null && stack.getItem() != null) {
                o.addProperty("item", Item.itemRegistry.getNameForObject(stack.getItem()));
                o.addProperty("meta", Integer.valueOf(stack.getItemDamage()));
                o.addProperty("count", Integer.valueOf(stack.stackSize));
            }
        }
        return o;
    }

    // ------------------------------------------------------------ 参数

    /** 读 {@code [[minx,miny,minz],[maxx,maxy,maxz]]}；缺失返回 null，非法抛 CP-VALID-002。 */
    private static double[][] optBox(ActionContext ctx) {
        JsonArray a = ctx.optArray("box");
        if (a == null) {
            return null;
        }
        if (a.size() != 2) {
            throw CpException.param("box 参数非法", "box", "须为 [[minx,miny,minz],[maxx,maxy,maxz]]");
        }
        JsonObject holder = new JsonObject();
        holder.add("min", a.get(0));
        holder.add("max", a.get(1));
        double[] min = EntitySpawnAction.optPos(holder, "min");
        double[] max = EntitySpawnAction.optPos(holder, "max");
        if (min == null || max == null) {
            throw CpException.param("box 参数非法", "box", "两端都须为 [x,y,z] 三个数");
        }
        for (int i = 0; i < 3; i++) {
            if (min[i] > max[i]) {
                throw CpException.param("box 范围非法", "box", "第 " + i + " 轴 min " + min[i] + " > max " + max[i]);
            }
        }
        EntitySpawnAction.checkPos(min, "box[0]");
        EntitySpawnAction.checkPos(max, "box[1]");
        return new double[][] { min, max };
    }

    private static JsonArray boxArray(double[][] box) {
        JsonArray a = new JsonArray();
        a.add(EntitySpawnAction.dblArray(box[0]));
        a.add(EntitySpawnAction.dblArray(box[1]));
        return a;
    }

    private static String trimToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
