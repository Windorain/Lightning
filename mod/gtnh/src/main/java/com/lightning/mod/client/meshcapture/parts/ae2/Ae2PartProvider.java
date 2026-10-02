package com.lightning.mod.client.meshcapture.parts.ae2;

import java.lang.reflect.Constructor;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.Entity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.AxisAlignedBB;
import net.minecraftforge.common.util.ForgeDirection;

import com.lightning.mod.client.meshcapture.parts.PartBox;
import com.lightning.mod.client.meshcapture.parts.PartItem;
import com.lightning.mod.client.meshcapture.parts.PartProvider;
import com.lightning.mod.client.meshcapture.parts.PartProviderContext;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.3 AE2 族权威部件提供者 —— 三档兜底流水线的<strong>档 1</strong>（契约
 * {@code format-parts-contract.md} §7.1）：{@code family=ae2, tier=1, fallback=false,
 * boxProvenance=both}。
 *
 * <p>
 * 反射调用链（与 P0.2 探针 {@code docs/plan/probe-family-apis.md} §1 逐跳一致，全部实测可达；
 * 纯运行时反射，不引用 appeng 任何编译期类型）：
 *
 * <pre>
 * world.getTileEntity(x,y,z)                       → TileCableBus（客户端实际是生成的 layer 子类，
 *                                                    如 LayerIEnergyConnected_TileCableBus，按类名判定）
 * tile.getPart(ForgeDirection) × 7（UNKNOWN=中心线缆） → IPart（枚举格内部件）
 * part.getBoxes(IPartCollisionHelper)              → 盒；helper = BusCollisionHelper 公开构造器
 *                                                    (List, side, entity, visual)，visual=true/false 两遍
 *                                                    （§6.4 两盒都取；helper 输出已是 0–1 方块局部，
 *                                                    直接用，禁止自做变换）
 * part.getItemStack(PartItemStack.World)           → ItemStack（物品身份；typeKey = registry:damage，
 *                                                    :16/:80/:220 实证）
 * tile.getFacadeContainer().getFacade(ForgeDirection) × 6 面 → IFacadePart（facade 不在 getPart 枚举里，
 *                                                    P0.2 §1.5#2，本轮补这一跳）
 * facade.getBoxes(IPartCollisionHelper, Entity)    → facade 盒（IFacadePart 签名，与 IPart 不同）
 * facade.getItemStack()                            → facade 物品（无参，与 IPart 不同）
 * </pre>
 *
 * <p>
 * localId：{@code ae2:<FACE>}（UNKNOWN 保持原名，契约 §4）；facade = {@code ae2:facade:<FACE>}。
 * 显示名/说明取部件物品 tooltip（§8 第一优先级，复用 MeshCaptureService 同款 getTooltip 机制）。
 *
 * <p>
 * 降级纪律：反射断点逐个 try-catch——某部件/某面失败只丢该部件，整族引导失败（类缺失）返回空列表
 * （交档 2/档 3），绝不抛出。
 *
 * <p>
 * 已知开放项（P0.2 §1.5#3，本轮不实现）：升级卡（importBus 等 NBT 内容）不在
 * {@code getItemStack(World)} 里体现，计数到升级卡粒度需解析部件 NBT（{@code IPart#writeToNBT}）。
 * TODO(P1.3-open): 升级卡 NBT 解析，作为附加 items 条目。
 */
@SideOnly(Side.CLIENT)
public final class Ae2PartProvider implements PartProvider {

    public static final int DEFAULT_PRIORITY = 100;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public int tier() {
        return PartSource.TIER_FAMILY;
    }

    @Override
    public String family() {
        return PartSource.FAMILY_AE2;
    }

    /**
     * TE 是 TileCableBus（含客户端生成的 layer 子类，如 LayerIEnergyConnected_TileCableBus，
     * 按类名包含判定，P0.2 §1.1 实证）。
     */
    @Override
    public boolean applies(PartProviderContext ctx) {
        if (ctx == null || ctx.world == null) {
            return false;
        }
        try {
            TileEntity te = ctx.world.getTileEntity(ctx.x, ctx.y, ctx.z);
            return te != null && te.getClass()
                .getName()
                .contains("TileCableBus");
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public List<PartRecord> collectParts(PartProviderContext ctx) {
        List<PartRecord> out = new ArrayList<PartRecord>();
        if (ctx == null || ctx.world == null) {
            return out;
        }
        TileEntity te = ctx.world.getTileEntity(ctx.x, ctx.y, ctx.z);
        if (te == null) {
            return out;
        }

        // ---- 整族引导（一环失败 = 整族不可用 ⇒ 空列表交档 2/3；不抛出）
        final Class<?> helperIface;
        final Constructor<?> bchCtor;
        final Class<?> partItemStackEnum;
        final Object worldStackType;
        try {
            helperIface = Class.forName("appeng.api.parts.IPartCollisionHelper");
            Class<?> bchClass = Class.forName("appeng.parts.BusCollisionHelper");
            bchCtor = bchClass.getConstructor(List.class, ForgeDirection.class, Entity.class, boolean.class);
            partItemStackEnum = Class.forName("appeng.api.parts.PartItemStack");
            @SuppressWarnings({ "unchecked", "rawtypes" })
            Object wst = Enum.valueOf((Class<? extends Enum>) partItemStackEnum, "World");
            worldStackType = wst;
        } catch (Throwable t) {
            FMLLog.warning("[SDE] Ae2PartProvider: bootstrap failed (family unavailable): %s", String.valueOf(t));
            return out;
        }

        // ---- 部件枚举：getPart(ForgeDirection) × 7（UNKNOWN=中心线缆）
        for (ForgeDirection side : ForgeDirection.values()) {
            Object part;
            try {
                part = te.getClass()
                    .getMethod("getPart", ForgeDirection.class)
                    .invoke(te, side);
            } catch (Throwable t) {
                FMLLog.warning("[SDE] Ae2PartProvider: getPart(%s) failed: %s", side.name(), String.valueOf(t));
                continue;
            }
            if (part == null) {
                continue;
            }
            try {
                out.add(buildPart(part, side, helperIface, bchCtor, partItemStackEnum, worldStackType));
            } catch (Throwable t) {
                // 只丢该部件（§7.2 降级纪律）
                FMLLog.warning("[SDE] Ae2PartProvider: part at %s dropped: %s", side.name(), String.valueOf(t));
            }
        }

        // ---- facade 枚举（P0.2 §1.5#2：不在 getPart 里，另走 IFacadeContainer）
        try {
            Object fc = te.getClass()
                .getMethod("getFacadeContainer")
                .invoke(te);
            for (ForgeDirection side : ForgeDirection.values()) {
                if (side == ForgeDirection.UNKNOWN) {
                    continue;
                }
                Object facade;
                try {
                    facade = fc.getClass()
                        .getMethod("getFacade", ForgeDirection.class)
                        .invoke(fc, side);
                } catch (Throwable t) {
                    FMLLog.warning("[SDE] Ae2PartProvider: getFacade(%s) failed: %s", side.name(), String.valueOf(t));
                    continue;
                }
                if (facade == null) {
                    continue;
                }
                try {
                    out.add(buildFacade(facade, side, helperIface, bchCtor));
                } catch (Throwable t) {
                    FMLLog.warning("[SDE] Ae2PartProvider: facade at %s dropped: %s", side.name(), String.valueOf(t));
                }
            }
        } catch (Throwable t) {
            // facade 容器缺失/失败只丢 facade 环，部件环结果保留
            FMLLog.warning("[SDE] Ae2PartProvider: facade container unavailable: %s", String.valueOf(t));
        }
        return out;
    }

    /** 单个挂载部件（含中心线缆）→ PartRecord。 */
    private static PartRecord buildPart(Object part, ForgeDirection side, Class<?> helperIface, Constructor<?> bchCtor,
        Class<?> partItemStackEnum, Object worldStackType) throws Exception {
        Object stackObj = part.getClass()
            .getMethod("getItemStack", partItemStackEnum)
            .invoke(part, worldStackType);
        ItemStack stack = (ItemStack) stackObj;

        PartRecord rec = new PartRecord(
            "ae2:" + side.name(),
            typeKey(stack),
            new PartSource(PartSource.FAMILY_AE2, false, PartSource.PROVENANCE_BOTH, PartSource.TIER_FAMILY));
        addBoxes(rec, part, side, helperIface, bchCtor);
        fillIdentity(rec, stack);
        return rec;
    }

    /** 单个 facade → PartRecord（{@code ae2:facade:<FACE>}；IFacadePart 签名与 IPart 不同）。 */
    private static PartRecord buildFacade(Object facade, ForgeDirection side, Class<?> helperIface,
        Constructor<?> bchCtor) throws Exception {
        ItemStack stack = (ItemStack) facade.getClass()
            .getMethod("getItemStack")
            .invoke(facade);

        PartRecord rec = new PartRecord(
            "ae2:facade:" + side.name(),
            typeKey(stack),
            new PartSource(PartSource.FAMILY_AE2, false, PartSource.PROVENANCE_BOTH, PartSource.TIER_FAMILY));
        // IFacadePart#getBoxes(IPartCollisionHelper, Entity) —— 与 IPart#getBoxes(helper) 签名不同
        addFacadeBoxes(rec, facade, side, helperIface, bchCtor);
        fillIdentity(rec, stack);
        rec.properties.put("kind", "facade");
        return rec;
    }

    /**
     * 盒（§6.4 两盒都取）：{@code part.getBoxes(helper)} × visual=true/false 两遍；helper =
     * BusCollisionHelper 公开构造器，输出已是 0–1 方块局部 Y-up，直接用（§6.1，禁止自做变换）。
     */
    private static void addBoxes(PartRecord rec, Object part, ForgeDirection side, Class<?> helperIface,
        Constructor<?> bchCtor) {
        addBoxesVia(rec, part, side, helperIface, bchCtor, true);
        addBoxesVia(rec, part, side, helperIface, bchCtor, false);
    }

    private static void addBoxesVia(PartRecord rec, Object part, ForgeDirection side, Class<?> helperIface,
        Constructor<?> bchCtor, boolean visual) {
        try {
            List<AxisAlignedBB> boxes = new ArrayList<AxisAlignedBB>();
            Object helper = bchCtor.newInstance(boxes, side, null, Boolean.valueOf(visual));
            part.getClass()
                .getMethod("getBoxes", helperIface)
                .invoke(part, helper);
            String kind = visual ? PartBox.KIND_VISUAL : PartBox.KIND_COLLISION;
            for (AxisAlignedBB bb : boxes) {
                rec.boxes.add(new PartBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, kind));
            }
        } catch (Throwable t) {
            // 一盒失败只丢该盒（另一盒与物品身份仍产出）
            FMLLog.warning(
                "[SDE] Ae2PartProvider: getBoxes(%s,%s) failed: %s",
                side.name(),
                visual ? "visual" : "collision",
                String.valueOf(t));
        }
    }

    /** facade 盒：{@code IFacadePart#getBoxes(IPartCollisionHelper, Entity)}，entity=null。 */
    private static void addFacadeBoxes(PartRecord rec, Object facade, ForgeDirection side, Class<?> helperIface,
        Constructor<?> bchCtor) {
        for (boolean visual : new boolean[] { true, false }) {
            try {
                List<AxisAlignedBB> boxes = new ArrayList<AxisAlignedBB>();
                Object helper = bchCtor.newInstance(boxes, side, null, Boolean.valueOf(visual));
                facade.getClass()
                    .getMethod("getBoxes", helperIface, Entity.class)
                    .invoke(facade, helper, null);
                String kind = visual ? PartBox.KIND_VISUAL : PartBox.KIND_COLLISION;
                for (AxisAlignedBB bb : boxes) {
                    rec.boxes.add(new PartBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, kind));
                }
            } catch (Throwable t) {
                FMLLog.warning(
                    "[SDE] Ae2PartProvider: facade getBoxes(%s,%s) failed: %s",
                    side.name(),
                    visual ? "visual" : "collision",
                    String.valueOf(t));
            }
        }
    }

    /** typeKey = {@code registry:damage}（§5，:16/:80/:220 实证）；无物品时回退 &lt;unknown&gt; 占位。 */
    private static String typeKey(ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return "ae2:<no-item>:0";
        }
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        return (reg == null ? "<unregistered>" : reg) + ":" + stack.getItemDamage();
    }

    /** 物品身份 + 显示名 + 说明（§3④⑤、§8 第一优先级 = 物品 tooltip）。 */
    private static void fillIdentity(PartRecord rec, ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            // items 留空数组 = 显式"无"（§3）；显示名回退占位
            rec.displayName = "<unknown AE2 part>";
            rec.tooltip.add(rec.displayName);
            return;
        }
        rec.items.add(PartItem.fromStack(stack));
        try {
            rec.displayName = stack.getDisplayName();
        } catch (Throwable t) {
            rec.displayName = stack.getUnlocalizedName();
        }
        try {
            Minecraft mc = Minecraft.getMinecraft();
            if (mc.thePlayer != null) {
                @SuppressWarnings("unchecked")
                List<String> lines = stack.getTooltip(mc.thePlayer, mc.gameSettings.advancedItemTooltips);
                if (lines != null) {
                    rec.tooltip.addAll(lines);
                }
            }
        } catch (Throwable ignored) {
            // Tooltip generation failure shouldn't block export
        }
        if (rec.tooltip.isEmpty() && rec.displayName != null) {
            rec.tooltip.add(rec.displayName);
        }
    }
}
