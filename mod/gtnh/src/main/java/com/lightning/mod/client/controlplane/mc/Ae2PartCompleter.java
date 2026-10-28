package com.lightning.mod.client.controlplane.mc;

import java.util.Locale;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * Applied Energistics 2 部件补全器（族名 {@code ae2-part}）——经 <b>AE2 自己的 addPart API</b>
 * 把部件装到既有缆上。
 *
 * <h2>params 是「放置输入」，不是 NBT 回填（contract.md §10 第 6 条）</h2>
 * AE2 的缆块（{@code appeng:BlockCableBus}）本身只是 {@code TileCableBus} 宿主，部件（缆、总线、
 * 面板、监视器…）全部挂在 {@code CableBusContainer} 里。因此 {@code params.parts[]} 声明的是
 * <b>要装什么</b>（物品 id / meta / 面），{@code params.facades[]} 声明要贴什么伪装板；
 * {@code params} 里<b>没有</b>任何 TE 字段名——逐字段回填正是契约 §10 第 6 条禁止的。
 *
 * <h2>权威调用链（源码实证，本树依赖 AE2-U rv3-beta-834）</h2>
 * <ol>
 * <li>取该位置的 TE，必须是 {@code appeng.api.parts.IPartHost}（{@code TileCableBus} 实现它，
 * {@code TileCableBus.java:203} 委派给 {@code CableBusContainer}）；不是宿主 → {@code CP-STATE-001}
 * 「缆块需由 block 步先放」；</li>
 * <li>部件：{@code IPartHost.addPart(ItemStack, ForgeDirection, EntityPlayer)}
 * （{@code api/parts/IPartHost.java:58} → {@code parts/CableBusContainer.addPart:149}；
 * {@code player=null} 表示无放置者）。该方法内部完成
 * {@code createPartFromItemStack} → {@code setSide/setCenter} → {@code setPartHostInfo} →
 * {@code addToWorld}（宿主已在世界时）→ 网格连接 → {@code markForUpdate()/markForSave()}
 * ——即 AE2 自己的放置路径，返回 null 表示放置失败；</li>
 * <li>伪装板：{@code appeng.parts.PartPlacement.isFacade(ItemStack, ForgeDirection)}
 * （{@code parts/PartPlacement.java:373}，同时支持 AE2 的 {@code IFacadeItem} 与 BuildCraft 伪装板）
 * 得到 {@code IFacadePart}，再 {@code IPartHost.getFacadeContainer().addFacade(IFacadePart)}
 * （{@code parts/CableBusContainer.java:104} → {@code facade/FacadeContainer.java:42}，
 * 正是玩家贴伪装板时走的同一路径，见 {@code PartPlacement.java:143-153}）；</li>
 * <li>收尾 {@code world.markBlockForUpdate(x,y,z)}（契约 §10 第 6 条的权威同步路径）。</li>
 * </ol>
 *
 * <h2>幂等语义</h2>
 * <ul>
 * <li>同侧<b>已有同型部件</b>（部件类相同 <b>且</b> 物品身份 {@code item+meta} 相同）→ <b>跳过该条</b>，
 * 不重复 addPart；类相同但物品身份不同（如换了颜色的缆）视为异型，拆掉重放；</li>
 * <li>同侧<b>已有异型部件</b> → 先 {@code removePart(side, false)} 再放（同一用例重复执行收敛）；
 * 伪装板同理（{@code removeFacade(host, side)} 后重贴）；</li>
 * <li>空/缺失的 {@code parts}/{@code facades} → {@code CP-VALID-002}（本步什么都没声明）；</li>
 * <li>未知 {@code side} → {@code CP-VALID-002}（大小写不敏感，见 {@link #side(String)}）；</li>
 * <li><b>顺序即声明序</b>：中心缆（{@code side:"UNKNOWN"}）请写在 {@code parts[]} 最前——AE2 的
 * {@code canAddPart} 会拿中心缆的类型校验各面部件，先放中心缆才不会白跑一趟；伪装板另要求中心缆
 * 已存在（AE2 自身的放置路径同样如此，见 {@code PartPlacement.java:147-149}）。</li>
 * </ul>
 *
 * <p>
 * <b>时序要点</b>：{@code TileCableBus.onReady()}（{@code TileCableBus.java:176}）在
 * {@code CableBusContainer.isEmpty()} 时<b>会销毁方块</b>（空缆块自毁）。因此 {@code te} 步必须紧跟
 * 放置缆块的 {@code block} 步（同一 tick 内执行），补全出一条部件后宿主才不会被自毁。
 */
public final class Ae2PartCompleter implements TeCompleter {

    /** 注册名（{@code build[i].completer} 的取值，契约 §10 第 6 条的 v1.2 注册表）。 */
    public static final String NAME = "ae2-part";

    /** 部件宿主接口——「这块到底能不能挂部件」的唯一权威判据。 */
    static final String IPART_HOST_CLASS = "appeng.api.parts.IPartHost";

    /** 伪装板接口。 */
    static final String IFACADE_PART_CLASS = "appeng.api.parts.IFacadePart";

    /** 伪装板工厂（AE2 自己的 {@code isFacade} 静态入口）。 */
    static final String PART_PLACEMENT_CLASS = "appeng.parts.PartPlacement";

    /** 缆块 TE 类（诊断/报错文案用）。 */
    static final String TILE_CABLE_BUS_CLASS = "appeng.tile.networking.TileCableBus";

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public boolean complete(WorldServer world, int x, int y, int z, JsonObject params) {
        if (world == null) {
            return false;
        }
        JsonObject p = params == null ? new JsonObject() : params;
        Class<?> hostClass = ModReflect.load(IPART_HOST_CLASS);
        if (hostClass == null) {
            throw CpException
                .param("Applied Energistics 2 不在运行期 classpath 上，无法放置部件", "params.parts", "缺少 " + IPART_HOST_CLASS);
        }
        JsonArray parts = Json.optArray(p, "parts");
        JsonArray facades = Json.optArray(p, "facades");
        boolean hasParts = parts != null && parts.size() > 0;
        boolean hasFacades = facades != null && facades.size() > 0;
        if (!hasParts && !hasFacades) {
            throw CpException
                .param("ae2-part 什么都没声明", "params.parts", "至少给一条 parts[] 或 facades[]（每条 {item, meta?, side}）");
        }
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null) {
            // 权威放置兜底（contract.md §10 第 6 条）：空缆块会在首个 tick 自毁（TileCableBus.onReady:176-185），
            // 「block 步放缆 + te 步加件」之间存在跨 tick 竞态（验收轮实测偶发 CP-STATE-001）——
            // 这里发现缆块缺失就自己补放，setBlock 创建 TE 与本步加件同 tick，竞态归零。
            net.minecraft.block.Block present = world.getBlock(x, y, z);
            if (present != null && !present.isAir(world, x, y, z)) {
                throw new CpException(
                    ErrorCodes.STATE,
                    "该位置不是 AE2 部件宿主（" + x
                        + ","
                        + y
                        + ","
                        + z
                        + " 被 "
                        + net.minecraft.item.Item.itemRegistry.getNameForObject(present)
                        + " 占用）：先清场或调整用例坐标");
            }
            net.minecraft.block.Block cable = cpw.mods.fml.common.registry.GameRegistry
                .findBlock("appliedenergistics2", "tile.BlockCableBus");
            if (cable == null) {
                throw CpException
                    .param("AE2 缆块注册名查不到（appliedenergistics2:tile.BlockCableBus）", "params.parts", "模组版本不符？");
            }
            world.setBlock(x, y, z, cable, 0, 3);
            te = world.getTileEntity(x, y, z);
        }
        if (te == null || !hostClass.isInstance(te)) {
            throw new CpException(
                ErrorCodes.STATE,
                "该位置不是 AE2 部件宿主（" + x
                    + ","
                    + y
                    + ","
                    + z
                    + " 实际 "
                    + (te == null ? "没有 TE（已尝试权威补放缆块仍失败）"
                        : te.getClass()
                            .getName())
                    + "）：可用 block 步先放缆块，或让本步缺缆时自动补放");
        }
        int added = 0;
        int skipped = 0;
        if (hasParts) {
            for (int i = 0; i < parts.size(); i++) {
                JsonObject entry = entry(parts.get(i), "params.parts[" + i + "]");
                String ctx = "params.parts[" + i + "]";
                ItemStack stack = stack(entry, ctx);
                ForgeDirection dir = side(requireSide(entry, ctx));
                if (placePart(te, stack, dir, ctx)) {
                    added++;
                } else {
                    skipped++;
                }
            }
        }
        if (hasFacades) {
            for (int i = 0; i < facades.size(); i++) {
                JsonObject entry = entry(facades.get(i), "params.facades[" + i + "]");
                String ctx = "params.facades[" + i + "]";
                ItemStack stack = stack(entry, ctx);
                ForgeDirection dir = side(requireSide(entry, ctx));
                if (placeFacade(te, stack, dir, ctx)) {
                    added++;
                } else {
                    skipped++;
                }
            }
        }
        world.markBlockForUpdate(x, y, z);
        CpLog.info(
            "ae2-part 补全 @ %d,%d,%d：新增 %d 条，幂等跳过 %d 条",
            Integer.valueOf(x),
            Integer.valueOf(y),
            Integer.valueOf(z),
            Integer.valueOf(added),
            Integer.valueOf(skipped));
        return true;
    }

    // ------------------------------------------------------------ 放置

    /**
     * 放一条部件（返回 true 表示本次真的 addPart 了，false 表示幂等跳过）。
     *
     * <p>
     * 幂等判定两级：先比<b>部件类</b>（{@code host.getPart(side).getClass()} vs 该物品
     * {@code IPartItem.createPartFromItemStack(stack).getClass()}），类相同再比<b>物品身份</b>
     * （{@code IPart.getItemStack(PartItemStack.World)} vs 请求的 {item,meta}）。两级都要过——
     * 缆的<b>颜色/材质</b>只体现在物品 meta 上，光比类会把「换色重建」误判成幂等。
     * 同侧异型则先 {@code removePart(side, false)} 清掉再放（幂等重建口径）。
     */
    private static boolean placePart(TileEntity te, ItemStack stack, ForgeDirection dir, String ctx) {
        Class<?> want = partClassOf(stack, ctx);
        Object existing = ModReflect.call(te, "getPart", new Class<?>[] { ForgeDirection.class }, dir);
        if (existing != null) {
            if (existing.getClass() == want && samePartStack(existing, stack)) {
                return false;
            }
            ModReflect
                .call(te, "removePart", new Class<?>[] { ForgeDirection.class, boolean.class }, dir, Boolean.FALSE);
        }
        Object result = ModReflect.call(
            te,
            "addPart",
            new Class<?>[] { ItemStack.class, ForgeDirection.class, net.minecraft.entity.player.EntityPlayer.class },
            stack,
            dir,
            null);
        if (result == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "AE2 addPart 失败（" + itemId(stack)
                    + " @"
                    + dir.name()
                    + "）：宿主 canAddPart 拒绝了该部件（中心缆缺失/该面已占/部件类型不被中心缆支持）");
        }
        return true;
    }

    /** 贴一条伪装板（返回 true 表示本次真的 addFacade 了，false 表示幂等跳过）。 */
    private static boolean placeFacade(TileEntity te, ItemStack stack, ForgeDirection dir, String ctx) {
        Class<?> ifaceClass = ModReflect.cls(IFACADE_PART_CLASS);
        Class<?> placementClass = ModReflect.load(PART_PLACEMENT_CLASS);
        if (ifaceClass == null || placementClass == null) {
            throw CpException.param("AE2 伪装板 API 不可用", ctx, "缺少 " + IFACADE_PART_CLASS + " 或 " + PART_PLACEMENT_CLASS);
        }
        // AE2 自己的放置路径对伪装板有「必须有中心缆」的前置判定（PartPlacement.java:147-149：
        // host.getPart(UNKNOWN) == null 直接返回 false）。绕开它就会造出 AE2 自己永远不会产生的
        // 世界状态（贴在空气上的伪装板）——那正是契约 §10 第 6 条禁止的「看起来对」。
        Object center = ModReflect.call(te, "getPart", new Class<?>[] { ForgeDirection.class }, ForgeDirection.UNKNOWN);
        if (center == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "该 AE2 缆还没有中心缆，无法贴伪装板（" + ctx
                    + "）：先在本步的 parts[] 里用 side=UNKNOWN 放中心缆"
                    + "（AE2 自身的放置路径同样要求 host.getPart(UNKNOWN) != null）");
        }
        Object facade = ModReflect.callStatic(
            placementClass,
            "isFacade",
            new Class<?>[] { ItemStack.class, ForgeDirection.class },
            stack,
            dir);
        if (facade == null || !ifaceClass.isInstance(facade)) {
            throw CpException.param(
                "不是可作伪装板的物品",
                ctx + ".item",
                itemId(stack) + " 既不是 AE2 的 IFacadeItem，也不是 BuildCraft 伪装板（PartPlacement.isFacade 返回 null）");
        }
        Object container = ModReflect.call(te, "getFacadeContainer");
        if (container == null) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "IPartHost.getFacadeContainer() 返回 null");
        }
        Object existing = ModReflect.call(container, "getFacade", new Class<?>[] { ForgeDirection.class }, dir);
        if (existing != null) {
            if (sameStack(facadeStack(existing), stack)) {
                return false;
            }
            // 同侧异型：先摘掉再贴（removeFacade(host, side)，不产出掉落物——构建期不需要）
            Class<?> hostClass = ModReflect.cls(IPART_HOST_CLASS);
            ModReflect.call(
                container,
                "removeFacade",
                new Class<?>[] { hostClass == null ? Object.class : hostClass, ForgeDirection.class },
                te,
                dir);
        }
        Object ok = ModReflect.call(container, "addFacade", new Class<?>[] { ifaceClass }, facade);
        if (!Boolean.TRUE.equals(ok)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "AE2 addFacade 失败（" + itemId(stack)
                    + " @"
                    + dir.name()
                    + "）：该面已有伪装板（FacadeContainer.addFacade 返回 false）");
        }
        return true;
    }

    /** 物品对应的部件类（{@code IPartItem.createPartFromItemStack} 的产物类）；不是部件物品则 CP-VALID-002。 */
    static Class<?> partClassOf(ItemStack stack, String ctx) {
        Item item = stack == null ? null : stack.getItem();
        if (item == null) {
            throw CpException.param("部件物品为空", ctx + ".item", "必填且须为已注册物品");
        }
        Class<?> partItemClass = ModReflect.cls("appeng.api.parts.IPartItem");
        if (partItemClass == null || !partItemClass.isInstance(item)) {
            throw CpException.param(
                "不是 AE2 部件物品",
                ctx + ".item",
                itemId(stack) + " 未实现 appeng.api.parts.IPartItem（总线/面板/缆都必须由部件物品放置）");
        }
        Object part = ModReflect.call(item, "createPartFromItemStack", new Class<?>[] { ItemStack.class }, stack);
        if (part == null) {
            throw CpException
                .param("部件构造失败", ctx + ".item", itemId(stack) + " 的 createPartFromItemStack 返回 null（meta 取值可能非法）");
        }
        return part.getClass();
    }

    // ------------------------------------------------------------ 解析

    private static JsonObject entry(JsonElement e, String ctx) {
        if (e == null || !e.isJsonObject()) {
            throw CpException.param("条目须为 object", ctx, "形如 {item:\"modid:name\", meta:0, side:\"UP\"}");
        }
        return e.getAsJsonObject();
    }

    /** 解析 {@code {item, meta?}} 为物品栈；物品缺失/未注册 → CP-VALID-002。 */
    private static ItemStack stack(JsonObject entry, String ctx) {
        String id = Json.optString(entry, "item", null);
        if (id == null || id.trim()
            .isEmpty()) {
            throw CpException.param("缺少 item", ctx + ".item", "必填：物品注册名，如 appeng:ItemPart");
        }
        id = id.trim();
        String modId = "minecraft";
        String name = id;
        int colon = id.indexOf(':');
        if (colon > 0) {
            modId = id.substring(0, colon);
            name = id.substring(colon + 1);
        }
        Item item = null;
        try {
            item = GameRegistry.findItem(modId, name);
        } catch (Throwable t) {
            CpLog.warn("GameRegistry.findItem(%s,%s) 失败: %s", modId, name, String.valueOf(t));
        }
        if (item == null) {
            try {
                Object o = Item.itemRegistry.getObject(id);
                item = o instanceof Item ? (Item) o : null;
            } catch (Throwable ignored) {
                item = null;
            }
        }
        if (item == null) {
            throw CpException.param("物品不存在", ctx + ".item", "物品注册表里没有该物品: " + id);
        }
        int meta = Json.optInt(entry, "meta", 0);
        if (meta < 0) {
            throw CpException.param("meta 非法", ctx + ".meta", "不得为负，收到 " + meta);
        }
        return new ItemStack(item, 1, meta);
    }

    /** 取 side 字段（必填）。 */
    static String requireSide(JsonObject entry, String ctx) {
        String s = Json.optString(entry, "side", null);
        if (s == null || s.trim()
            .isEmpty()) {
            throw CpException.param(
                "缺少 side",
                ctx + ".side",
                "必填：UP|DOWN|NORTH|SOUTH|WEST|EAST（大小写不敏感）；中心缆用 UNKNOWN（等价 CENTER/MIDDLE）");
        }
        if (side(s) == null) {
            throw CpException
                .param("未知 side", ctx + ".side", "收到 " + s + "，可用 DOWN|UP|NORTH|SOUTH|WEST|EAST|UNKNOWN（大小写不敏感）");
        }
        return s;
    }

    /**
     * 解析方位（<b>大小写不敏感</b>）；未知返回 {@code null}。
     *
     * <p>
     * 不用 {@code ForgeDirection.valueOf} —— 直接与 {@code VALID_DIRECTIONS} 的枚举名逐字比较，
     * 判定不依赖 Forge 版本的辅助方法是否存在。{@code UNKNOWN} 表示中心位（缆本体），
     * 额外接受 {@code CENTER}/{@code MIDDLE} 两个可读别名。
     */
    static ForgeDirection side(String name) {
        if (name == null) {
            return null;
        }
        String s = name.trim()
            .toUpperCase(Locale.ROOT);
        if (s.isEmpty()) {
            return null;
        }
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            if (d.name()
                .equals(s)) {
                return d;
            }
        }
        if ("UNKNOWN".equals(s) || "CENTER".equals(s) || "MIDDLE".equals(s)) {
            return ForgeDirection.UNKNOWN;
        }
        return null;
    }

    /** 物品注册名（{@code modid:name}，meta 非 0 时补 {@code @meta}）；不可解析返回 null。 */
    static String itemId(ItemStack stack) {
        return ModReflect.itemId(stack);
    }

    /** 伪装板自身的物品栈（幂等比较用）。 */
    private static ItemStack facadeStack(Object facade) {
        Object s = ModReflect.call(facade, "getItemStack");
        return s instanceof ItemStack ? (ItemStack) s : null;
    }

    /**
     * 已装部件与待装部件的<b>物品身份</b>是否相同（类已判等之后的第二级判定）。
     *
     * <p>
     * 用 {@code IPart.getItemStack(PartItemStack.World)}（部件在世界里的物品形态）与请求栈比
     * item+damage；对<b>缆</b>而言颜色/材质就在 damage 上，这一级不能省。读不出物品形态时
     * 返回 true（保守：类相同即视为同型，不做无谓的拆装）。
     */
    private static boolean samePartStack(Object part, ItemStack want) {
        ItemStack have = Ae2PartDescriber.partStackOf(part);
        return have == null || sameStack(have, want);
    }

    /** 两个物品栈是否同物同 meta（伪装板幂等判定）。 */
    static boolean sameStack(ItemStack a, ItemStack b) {
        if (a == null || b == null) {
            return false;
        }
        return a.getItem() == b.getItem() && a.getItemDamage() == b.getItemDamage();
    }
}
