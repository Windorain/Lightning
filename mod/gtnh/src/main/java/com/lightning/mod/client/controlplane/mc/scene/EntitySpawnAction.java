package com.lightning.mod.client.controlplane.mc.scene;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityList;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.entity.spawn}（scene，同步）：在托管世界里生成实体，含掉落物（用于构造「拾取」的输入）。
 *
 * <h2>层归属（#96 §4.1，本动作是 L0）</h2>
 * 本动作<b>直接把实体放进世界</b>，不经玩家路径：它不是「玩家扔出了物品」的证据。
 * 与「拾取」（#101，L1：掉落 → 真实走到跟前 → 拾起）互补——L0 负责<b>布置输入</b>，
 * L1 负责<b>验证玩家行为引发的结果</b>。#96 §4.2：L0 的产物不能当作 L1 的证据。
 *
 * <h2>两类条目</h2>
 * <ul>
 * <li><b>掉落物</b>：给 {@code item}（物品 id，如 {@code minecraft:stone}）而不是 {@code entity}，
 * 世界侧落一个 {@link EntityItem}；可带 {@code meta}/{@code count}/{@code nbt}；</li>
 * <li><b>一般实体</b>：给 {@code entity}（{@code EntityList} 注册名，如 {@code minecraft:zombie}、
 * {@code minecraft:item}），可带 {@code nbt}（与 {@code EntityList.createEntityFromNBT} 同口径）。</li>
 * </ul>
 * {@code entity} 与 {@code item} 互斥且必须给一个；两者都给或都不给都是 {@code CP-VALID-002}。
 *
 * <h2>为什么落到服务端权威世界</h2>
 * 见 {@link L0Session} 类注释：客户端 {@code WorldClient} 是只读投影，往它身上 spawn 的实体
 * 不会被服务端承认（也不会进权威世界的 {@code loadedEntityList}）。服务端 spawn 之后，
 * 客户端由原版实体跟踪器（S0F/S15…）自然收到——这才是「世界里真有一个实体」。
 *
 * <h2>NBT 口径</h2>
 * {@code nbt} 是 <b>SNBT 文本</b>（原版 {@code /give}/{@code /summon} 的写法，即
 * {@code net.minecraft.nbt.JsonToNBT}），<b>不是</b> JSON 对象。两者语法相近但不同：
 * SNBT 的字符串值可裸写（{@code {display:{Name:foo}}}），JSON 必须加引号；数字后缀
 * （{@code 1b}/{@code 1.0f}）也是 SNBT 独有。自述里写明这一点，免得调用方按 JSON 写。
 * 解析失败即 {@code CP-VALID-002} 并带 SNBT 异常原文。
 *
 * <h2>托管世界是虚空——四条实测事实（会让「生成了但没看见」）</h2>
 * <ol>
 * <li><b>没落脚的实体会坠出世界</b>：1.7.10 的 {@code Entity.outOfWorld()} 在
 * {@code posY < -64} 时直接 {@code kill()}。虚空世界只有构建段放下的那几块方块，
 * 停在半空的实体几秒内就没了。要实体留住，先放一块地板（{@code block} 步）再把实体放在其上方。</li>
 * <li><b>会走路的实体会走出地板</b>：1.7.10 <b>没有 {@code NoAI} 标签</b>（那是 1.8+ 的），
 * 用 NBT 钉住 AI 在这里无效——猪/牛会游荡，几秒内就可能走出小平台并坠落。
 * 要稳定布景请给足够大的地板，或只放不游走的实体（掉落物、
 * {@code ArmorStand} 之类），或把 AI 钉住这件事当作 L1 行为另行验证。</li>
 * <li><b>同种掉落物会合并</b>：{@code EntityItem} 在 {@code combineItems} 距离内把同 item+meta
 * 的栈并成一个。<b>因此 {@code entityCounts} 报的是「实体个数」而不是「你调了几次」</b>——
 * 在同一坐标连调 3 次石头各 1 个，结果往往只有 1 个实体、count=3 的那一栈。</li>
 * <li><b>玩家脚下的掉落物会被自动拾取</b>：{@code EntityItem.onUpdate} 直接调
 * {@code player.inventory.addItemStackToInventory}。若实体生成在玩家身上，下一次玩家 tick
 * 就进背包了——那时再清场自然是 0 个。要验证「清掉落物」，把实体放在离玩家一格以上处。</li>
 * </ol>
 * 另外「物品/实体 id 未知」在入口即拒（{@code CP-VALID-002}），不会静默变成 0 个。
 *
 * <p>
 * <b>读回口径的边界</b>：{@code entityCounts} 读的是服务端世界的 {@code loadedEntityList}，
 * 而服务端世界跑在自己的线程上（见 {@link L0Session} 的跨线程说明）。因此这些计数是
 * <b>指示性快照</b>而不是原子的账目——上面四条动态行为叠加后，两次相邻调用读到的数会不同。
 * 需要精确对账时以单次调用返回的 {@code spawned[]}/{@code removed[]} 为准（那是本动作自己造成的变化）。
 */
public final class EntitySpawnAction implements ControlAction {

    /** 单次调用最多生成的实体数（防一次请求打出成千上万实体把世界卡死）。 */
    public static final int MAX_ENTITIES = 256;

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.entity.spawn");

        JsonArray entries = ctx.optArray("entities");
        JsonObject single = ctx.optObject("entity");
        List<JsonObject> specs = new ArrayList<JsonObject>();
        if (entries != null) {
            for (int i = 0; i < entries.size(); i++) {
                JsonElement e = entries.get(i);
                if (e == null || !e.isJsonObject()) {
                    throw CpException.param("实体条目非法", "entities[" + i + "]", "须为 object");
                }
                specs.add(e.getAsJsonObject());
            }
        }
        if (single != null) {
            specs.add(single);
        }
        if (specs.isEmpty()) {
            throw CpException.param("缺少实体定义", "entities", "给 entities[] 或 entity{} 之一（不可都缺）");
        }
        if (specs.size() > MAX_ENTITIES) {
            throw CpException.param("实体数超出上限", "entities", "单次最多 " + MAX_ENTITIES + " 个，收到 " + specs.size() + "（分批调用）");
        }

        double[] origin = optPos(ctx, "pos");
        JsonArray spawned = new JsonArray();
        JsonArray failed = new JsonArray();
        for (int i = 0; i < specs.size(); i++) {
            JsonObject spec = specs.get(i);
            String where = "entities[" + i + "]";
            try {
                spawned.add(spawnOne(world, spec, origin, where));
            } catch (CpException e) {
                throw e;
            } catch (Throwable t) {
                JsonObject f = new JsonObject();
                f.addProperty("index", Integer.valueOf(i));
                f.addProperty("error", String.valueOf(t));
                failed.add(f);
                CpLog.warn("实体生成失败（%s）: %s", where, String.valueOf(t));
            }
        }

        JsonObject o = new JsonObject();
        o.addProperty("requested", Integer.valueOf(specs.size()));
        o.addProperty("spawnedCount", Integer.valueOf(spawned.size()));
        o.add("spawned", spawned);
        o.add("failed", failed);
        o.addProperty("dimension", Integer.valueOf(world.provider == null ? 0 : world.provider.dimensionId));
        JsonArray counts = entityCounts(world, specs);
        o.add("entityCounts", counts);
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.entity.spawn：" + spawned.size() + "/" + specs.size() + " 个实体",
            Json.object(
                "requested",
                Integer.valueOf(specs.size()),
                "spawnedCount",
                Integer.valueOf(spawned.size()),
                "failedCount",
                Integer.valueOf(failed.size())));
        return L0Session.decorated("scene.entity.spawn", o, world, mc);
    }

    // ------------------------------------------------------------ 单条生成

    /**
     * 造一般实体：无 NBT 走 {@code EntityList.createEntityByName}，有 NBT 走
     * {@code EntityList.createEntityFromNBT}（它按 {@code id} 标签选类，是原版 {@code /summon}
     * 的路径）。
     *
     * <p>
     * 为什么不走「先建实体再 {@code readEntityFromNBT}」：1.7.10 里那个方法是
     * {@code protected}，外部类调不到；而 {@code EntityList.createEntityFromNBT} 正好是原版
     * 为这条路径准备的公开入口（{@code /summon} 用的就是它），既绕开访问控制又保证是原版语义。
     */
    private Entity spawnEntityWithNbt(WorldServer world, String entityId, NBTTagCompound tag, String where) {
        // 1.7.10 的注册名不带 minecraft: 前缀（实测：minecraft:zombie 查不到，Zombie 才行）。
        // 这里先把调用方给的名字解析成注册表里的原始键，再把原始键交给原版 API——
        // 宽容只发生在匹配阶段，交给原版的一定是它的原生键，不改变原版行为。
        String key = RegistryNames.resolveEntityKey(entityId, where + ".entity");
        Entity entity;
        if (tag != null) {
            // NBT 路径要求 id 标签，且必须与显式给的 entity 一致（不一致即调用方写错了）
            if (!tag.hasKey("id")) {
                throw CpException.param("NBT 缺少 id 标签", where + ".nbt", "带 nbt 生成实体时，SNBT 里必须有 id:\"<实体注册名>\"");
            }
            String nbtId = tag.getString("id");
            if (!RegistryNames.sameEntity(key, nbtId)) {
                throw CpException.param(
                    "entity 与 nbt.id 不一致",
                    where + ".nbt",
                    "entity=" + entityId + "（解析为 " + key + "），nbt.id=" + nbtId);
            }
            // createEntityFromNBT 按 id 标签自己查表，故把标签里的 id 规范成解析后的原始键
            tag.setString("id", key);
            try {
                entity = EntityList.createEntityFromNBT(tag, world);
            } catch (Throwable t) {
                throw CpException.param("NBT 生成实体失败", where + ".nbt", String.valueOf(t));
            }
        } else {
            entity = EntityList.createEntityByName(key, world);
        }
        if (entity == null) {
            throw CpException.param(
                "实体构造返回 null",
                where + ".entity",
                "注册名 " + key + " 已登记但 createEntityByName/createEntityFromNBT 返回 null（该实体类可能没有无参构造或构造抛异常）");
        }
        return entity;
    }

    /**
     * 把 SNBT 合入 {@link ItemStack}（{@code Count}/{@code Damage}/{@code tag} 三键，原版 {@code /give} 口径）。
     *
     * <p>
     * {@code id} 键被忽略——物品身份由 {@code item} 参数给，两条来源不一致只会带来歧义。
     */
    static void applyItemNbt(ItemStack stack, NBTTagCompound snbt, String where) {
        if (snbt.hasKey("Count")) {
            int count = snbt.getInteger("Count");
            if (count < 1 || count > 64) {
                throw CpException.param("NBT 里的数量非法", where + ".nbt.Count", "须在 1..64，收到 " + count);
            }
            stack.stackSize = count;
        }
        if (snbt.hasKey("Damage")) {
            stack.setItemDamage(snbt.getInteger("Damage"));
        }
        if (snbt.hasKey("tag")) {
            NBTTagCompound inner = snbt.getCompoundTag("tag");
            if (inner != null) {
                stack.setTagCompound(inner);
            }
        } else if (snbt.hasKey("tagCompound")) {
            NBTTagCompound inner = snbt.getCompoundTag("tagCompound");
            if (inner != null) {
                stack.setTagCompound(inner);
            }
        }
    }

    private JsonObject spawnOne(WorldServer world, JsonObject spec, double[] origin, String where) {
        String entityId = trimToNull(Json.optString(spec, "entity", null));
        String itemId = trimToNull(Json.optString(spec, "item", null));
        if (entityId != null && itemId != null) {
            throw CpException.param("entity 与 item 互斥", where, "二者只能给一个（item 是掉落物的简写）");
        }
        if (entityId == null && itemId == null) {
            throw CpException.param("缺少 entity 或 item", where, "必须给 entity（注册名）或 item（掉落物）");
        }
        double[] pos = optPos(spec, "pos");
        if (pos == null) {
            if (origin == null) {
                throw CpException.param("缺少坐标", where + ".pos", "条目与顶层都没有 pos：须给 [x,y,z]");
            }
            pos = origin.clone();
        }
        // 逐条自校验坐标：越界必须在入口就拒，而不是让服务端在 setPosition 里静默 clamp
        checkPos(pos, where + ".pos");
        NBTTagCompound tag = parseNbt(Json.optString(spec, "nbt", null), where + ".nbt");

        Entity entity;
        if (itemId != null) {
            ItemStack stack = buildItemStack(spec, itemId, where);
            if (tag != null) {
                // 掉落物的 NBT 就是 ItemStack 的 NBT（原版 /give 口径：{id,Count,Damage,tag}）
                applyItemNbt(stack, tag, where);
            }
            entity = new EntityItem(world, pos[0], pos[1], pos[2], stack);
            // 原版 EntityItem 构造只设位置；显式清零速度，免得带出随机初速（可复现性）
            entity.motionX = 0.0d;
            entity.motionY = 0.0d;
            entity.motionZ = 0.0d;
        } else {
            entity = spawnEntityWithNbt(world, entityId, tag, where);
            float yaw = (float) Json.optLong(spec, "yaw", 0L);
            float pitch = (float) Json.optLong(spec, "pitch", 0L);
            entity.rotationYaw = yaw;
            entity.rotationPitch = pitch;
        }
        // NBT 里可能带 Pos 标签，会把实体挪走——统一在最后把位置钉回请求值
        entity.setPosition(pos[0], pos[1], pos[2]);
        boolean ok = world.spawnEntityInWorld(entity);
        JsonObject o = new JsonObject();
        o.addProperty("ok", Boolean.valueOf(ok));
        o.addProperty("entityId", EntityList.getEntityString(entity));
        o.addProperty(
            "class",
            entity.getClass()
                .getName());
        o.addProperty("entityIdNum", Integer.valueOf(entity.getEntityId()));
        o.add("pos", dblArray(pos));
        if (entity instanceof EntityItem) {
            ItemStack stack = ((EntityItem) entity).getEntityItem();
            o.add("item", stackSummary(stack));
        }
        o.addProperty("nbtApplied", Boolean.valueOf(tag != null));
        return o;
    }

    /** 由 {@code item}/{@code meta}/{@code count} 造物品栈（与原版 {@code /give} 同解析路径）。 */
    private ItemStack buildItemStack(JsonObject spec, String itemId, String where) {
        Item item = resolveItem(itemId, where + ".item");
        int meta = Json.optInt(spec, "meta", 0);
        int count = Json.optInt(spec, "count", 1);
        if (count < 1 || count > 64) {
            throw CpException.param("掉落物数量非法", where + ".count", "须在 1..64，收到 " + count);
        }
        if (meta < 0 || meta > 32767) {
            throw CpException.param("meta 非法", where + ".meta", "须在 0..32767，收到 " + meta);
        }
        return new ItemStack(item, count, meta);
    }

    /**
     * 解析物品注册名：{@code GameRegistry.findItem} 优先，回落 {@code Item.itemRegistry}。
     *
     * <p>
     * 与 {@code SceneBuilder.resolveBlock} 同一套两级解析，保证「1.7.10 注册名不等于现代
     * {@code namespace:path}」这件事只有一处口径。
     */
    static Item resolveItem(String id, String field) {
        String s = id.trim();
        String modId = "minecraft";
        String name = s;
        int colon = s.indexOf(':');
        if (colon > 0) {
            modId = s.substring(0, colon);
            name = s.substring(colon + 1);
        }
        Item item = null;
        try {
            item = cpw.mods.fml.common.registry.GameRegistry.findItem(modId, name);
        } catch (Throwable t) {
            CpLog.warn("GameRegistry.findItem(%s,%s) 失败: %s", modId, name, String.valueOf(t));
        }
        if (item == null) {
            try {
                item = (Item) Item.itemRegistry.getObject(s);
            } catch (Throwable t) {
                CpLog.warn("itemRegistry.getObject(%s) 失败: %s", s, String.valueOf(t));
            }
        }
        if (item == null) {
            throw CpException.param("未知物品", field, "注册表里没有该物品: " + id + "（尝试 " + modId + ":" + name + "）");
        }
        return item;
    }

    /**
     * 解析 SNBT（原版 {@code JsonToNBT}，与 {@code /give}/{@code /summon} 同一解析器）。
     *
     * @throws CpException CP-VALID-002 SNBT 非法或根不是 compound
     */
    static NBTTagCompound parseNbt(String snbt, String field) {
        if (snbt == null || snbt.trim()
            .isEmpty()) {
            return null;
        }
        Object parsed;
        try {
            parsed = net.minecraft.nbt.JsonToNBT.func_150315_a(snbt);
        } catch (Throwable t) {
            throw CpException.param("NBT 解析失败", field, "SNBT 非法（不是 JSON 对象）：" + t.getMessage());
        }
        if (!(parsed instanceof NBTTagCompound)) {
            throw CpException.param(
                "NBT 根节点非法",
                field,
                "SNBT 根须为 compound（以 { 开头），收到 " + parsed.getClass()
                    .getName());
        }
        return (NBTTagCompound) parsed;
    }

    // ------------------------------------------------------------ 结果统计

    /**
     * 生成后实读：世界现有多少实体，以及本次关注的注册名/物品各命中多少（读面兜底）。
     *
     * <p>
     * 关注项的 key 用<b>规范化后的注册名</b>（{@link RegistryNames#normalize}）匹配——调用方写
     * {@code minecraft:zombie} 而世界里读到的是原生 {@code Zombie}，直接字符串比较会恒得 0
     * （假绿：明明生成成功了却报 count=0）。这里两侧都规范化，因此「关注项 → 实读计数」这条
     * 对照链在现代写法与原生写法下都成立。
     *
     * <p>
     * <b>计数口径是「实体个数」</b>，不是「调用次数」也不是「物品总数」：原版
     * {@code EntityItem.combineItems} 会把同 item+meta 的近距离掉落物并成一个栈，因此同一坐标
     * 连调多次同种掉落物，这里只会看到 1 个实体。要按栈总量核对请读 {@code spawned[].item.count}。
     */
    private JsonArray entityCounts(WorldServer world, List<JsonObject> specs) {
        List<String> wanted = new ArrayList<String>();
        for (JsonObject spec : specs) {
            String id = trimToNull(Json.optString(spec, "entity", null));
            if (!isBlank(id)) {
                // 解析成注册表原始键，让返回值里的 key 就是世界里真实用的那个名字
                id = RegistryNames.resolveEntityKey(id, "entities[].entity");
            } else {
                String item = trimToNull(Json.optString(spec, "item", null));
                if (isBlank(item)) {
                    continue;
                }
                id = "Item[" + item + ":" + Json.optInt(spec, "meta", 0) + "]";
            }
            if (!wanted.contains(id)) {
                wanted.add(id);
            }
        }
        JsonArray out = new JsonArray();
        java.util.Map<String, Integer> byKey = new java.util.LinkedHashMap<String, Integer>();
        int total = 0;
        for (Entity e : world.loadedEntityList) {
            if (e == null) {
                continue;
            }
            total++;
            String key = RegistryNames.entityKeyOf(e);
            Integer prev = byKey.get(key);
            byKey.put(key, Integer.valueOf(prev == null ? 1 : prev.intValue() + 1));
        }
        for (String key : wanted) {
            JsonObject c = new JsonObject();
            c.addProperty("key", key);
            int n = 0;
            if (key.startsWith("Item[")) {
                // 掉落物按「物品 + meta」计数：注册名（Item）粒度太粗，答不出「这个石头掉了几个」
                String itemId = key.substring("Item[".length(), key.lastIndexOf(':'));
                int meta = Integer.parseInt(key.substring(key.lastIndexOf(':') + 1, key.length() - 1));
                for (Entity e : world.loadedEntityList) {
                    if (itemMatches(e, itemId, true, meta)) {
                        n++;
                    }
                }
            } else {
                Integer exact = byKey.get(key);
                if (exact != null) {
                    n = exact.intValue();
                } else {
                    for (java.util.Map.Entry<String, Integer> en : byKey.entrySet()) {
                        if (RegistryNames.sameEntity(en.getKey(), key)) {
                            n += en.getValue()
                                .intValue();
                        }
                    }
                }
            }
            c.addProperty("count", Integer.valueOf(n));
            out.add(c);
        }
        JsonObject all = new JsonObject();
        all.addProperty("key", "*");
        all.addProperty("count", Integer.valueOf(total));
        all.addProperty("note", "world.loadedEntityList 总数（含玩家、掉落物与模组实体）");
        out.add(all);
        return out;
    }

    /** 掉落物实体是否匹配「物品 + meta」。 */
    static boolean itemMatches(Entity e, String itemId, boolean hasMeta, int meta) {
        if (!(e instanceof EntityItem)) {
            return false;
        }
        ItemStack stack = ((EntityItem) e).getEntityItem();
        if (stack == null || stack.getItem() == null) {
            return false;
        }
        String id = Item.itemRegistry.getNameForObject(stack.getItem());
        if (!itemId.equals(id)) {
            return false;
        }
        return !hasMeta || stack.getItemDamage() == meta;
    }

    private static JsonObject stackSummary(ItemStack stack) {
        JsonObject o = new JsonObject();
        if (stack == null) {
            return o;
        }
        o.addProperty("id", Item.itemRegistry.getNameForObject(stack.getItem()));
        o.addProperty("itemId", Integer.valueOf(Item.getIdFromItem(stack.getItem())));
        o.addProperty("meta", Integer.valueOf(stack.getItemDamage()));
        o.addProperty("count", Integer.valueOf(stack.stackSize));
        o.addProperty("nbtPresent", Boolean.valueOf(stack.getTagCompound() != null));
        return o;
    }

    // ------------------------------------------------------------ 参数小工具

    private static String trimToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim()
            .isEmpty();
    }

    /** 读 {@code [x,y,z]}；缺失返回 null，形态非法抛 CP-VALID-002。 */
    static double[] optPos(ActionContext ctx, String name) {
        return optPos(ctx.params(), name);
    }

    /** 读对象里的 {@code [x,y,z]}；缺失返回 null，形态非法抛 CP-VALID-002。 */
    static double[] optPos(JsonObject o, String name) {
        JsonArray a = Json.optArray(o, name);
        if (a == null) {
            return null;
        }
        if (a.size() != 3) {
            throw CpException.param("坐标参数非法", name, "须为 [x,y,z] 三个数");
        }
        double[] out = new double[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()
                || !v.getAsJsonPrimitive()
                    .isNumber()) {
                throw CpException.param("坐标分量非法", name + "[" + i + "]", "须为数值");
            }
            out[i] = v.getAsDouble();
        }
        return out;
    }

    /** 坐标越界检查（与 CaseValidator 的世界边界同口径：y 0..255、水平 ±3×10^7）。 */
    static void checkPos(double[] pos, String field) {
        if (pos[1] < -64.0d || pos[1] > 320.0d) {
            throw CpException.param("y 越界", field + "[1]", "须在 -64..320（1.7.10 世界高度 0..255，留了余量给实体悬空），收到 " + pos[1]);
        }
        for (int i = 0; i < 3; i += 2) {
            if (Math.abs(pos[i]) > 30000000.0d) {
                throw CpException.param("水平坐标越界", field + "[" + i + "]", "绝对值上限 30000000，收到 " + pos[i]);
            }
        }
        for (double v : pos) {
            if (Double.isNaN(v) || Double.isInfinite(v)) {
                throw CpException.param("坐标分量非法", field, "含 NaN/Infinity");
            }
        }
    }

    static JsonArray dblArray(double[] v) {
        JsonArray a = new JsonArray();
        for (double d : v) {
            Json.add(a, Double.valueOf(Math.round(d * 1000.0d) / 1000.0d));
        }
        return a;
    }
}
