package com.lightning.mod.client.meshcapture.parts.enderio;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
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
 * P1.4 EnderIO 族权威部件提供者 —— 三档兜底流水线的<strong>档 1</strong>（契约
 * {@code format-parts-contract.md} §7.1）：{@code family=eio, tier=1, fallback=false,
 * boxProvenance=collision-derived-visual}。
 *
 * <p>
 * 反射调用链（逐跳与历史族 API 探针 §2 一致，全部实测可达；
 * 纯运行时反射，不引用 crazypants/com.enderio 任何编译期类型）：
 *
 * <pre>
 * world.getTileEntity(x,y,z)            → TileConduitBundle（按类名判定）
 * tile.getConduits()                    → Collection&lt;IConduit&gt;（枚举）
 * conduit.getBaseConduitType()          → Class（类型键：接口简单名 → localId = eio:&lt;简单名&gt;）
 * conduit.createItem()                  → ItemStack（物品身份；typeKey = registry:damage）
 * 盒（P0.2 §2.1 重要结构发现，必须照此实现）：
 *   tile.getCollidableComponents()      → tile 级组件：芯盒（dir=UNKNOWN）由 addConduitCores 注入此处，
 *                                         按 conduitType 归属到导管；conduitType==null 的连接器
 *                                         <strong>不发射为部件</strong>（归属导管本体的盒，§5/§2.5）
 *   conduit.getCollidableComponents()   → per-conduit 组件：连接段（dir=面方向；无连接 = 空列表，
 *                                         芯盒不在其中）
 *   ⇒ 一个导管 = 1 芯（tile 级 dir=UNKNOWN）+ N 段（per-conduit dir=面），契约「每部件多子盒」覆盖
 * </pre>
 *
 * <p>
 * 坐标系（§6.1）：{@code CollidableComponent#bound}（com.enderio.core BoundingBox，public final
 * float minX..maxZ）<strong>原生即 0–1 方块局部</strong>、标准 MC 朝向，直接用。
 *
 * <p>
 * 视觉/碰撞盒（§6.4）：EnderIO <strong>只有一个几何源</strong>——碰撞直接用 {@code bound}
 * （BlockConduitBundle#addCollisionBoxesToList），选择高亮对同一 bound 做 {@code scale(1.09)}
 * （绕中心确定性推导，连接器段另一套规则但连接器不发射为部件）。因此每盒双发：kind=collision
 * 为原值、kind=visual 为 ×1.09 绕中心推导值，来源标记 {@code collision-derived-visual}。
 *
 * <p>
 * 共存纪律：applies 仅按 TileConduitBundle 类名判定，collectParts 只读本格 tile，
 * 不干扰同格其他族（框架按 §7.2 合并，localId 命名空间隔离）。
 *
 * <p>
 * 降级纪律：反射断点逐个 try-catch——某导管失败只丢该导管，整族引导失败返回空列表，绝不抛出。
 */
@SideOnly(Side.CLIENT)
public final class EnderIoPartProvider implements PartProvider {

    public static final int DEFAULT_PRIORITY = 110;

    private static final String[] BOUND_FIELDS = { "minX", "minY", "minZ", "maxX", "maxY", "maxZ" };
    /** 视觉盒推导系数（BlockConduitBundle#getSelectedBoundingBoxFromPool L957：bound.scale(1.09)）。 */
    private static final double VISUAL_SCALE = 1.09;

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
        return PartSource.FAMILY_ENDERIO;
    }

    /** TE 是 TileConduitBundle（按类名包含判定）。 */
    @Override
    public boolean applies(PartProviderContext ctx) {
        if (ctx == null || ctx.world == null) {
            return false;
        }
        try {
            TileEntity te = ctx.world.getTileEntity(ctx.x, ctx.y, ctx.z);
            return te != null && te.getClass()
                .getName()
                .contains("TileConduitBundle");
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

        // ---- 枚举（整族引导环：失败 ⇒ 空列表交档 2/3）
        Collection<?> conduits;
        try {
            conduits = (Collection<?>) te.getClass()
                .getMethod("getConduits")
                .invoke(te);
        } catch (Throwable t) {
            FMLLog.warning("[SDE] EnderIoPartProvider: getConduits failed: %s", String.valueOf(t));
            return out;
        }
        if (conduits == null) {
            return out;
        }

        // ---- tile 级组件（芯盒 dir=UNKNOWN 在此；失败只丢芯盒环，per-conduit 段环仍走）
        Collection<?> tileComps = null;
        try {
            tileComps = (Collection<?>) te.getClass()
                .getMethod("getCollidableComponents")
                .invoke(te);
        } catch (Throwable t) {
            FMLLog.warning("[SDE] EnderIoPartProvider: tile getCollidableComponents failed: %s", String.valueOf(t));
        }

        for (Object conduit : conduits) {
            if (conduit == null) {
                continue;
            }
            try {
                out.add(buildConduit(conduit, tileComps));
            } catch (Throwable t) {
                // 只丢该导管（§7.2 降级纪律）
                FMLLog.warning(
                    "[SDE] EnderIoPartProvider: conduit %s dropped: %s",
                    conduit.getClass()
                        .getName(),
                    String.valueOf(t));
            }
        }
        return out;
    }

    /** 单导管 → PartRecord（1 芯 + N 连接段多子盒）。 */
    private static PartRecord buildConduit(Object conduit, Collection<?> tileComps) throws Exception {
        Class<?> baseType = (Class<?>) conduit.getClass()
            .getMethod("getBaseConduitType")
            .invoke(conduit);
        ItemStack stack = (ItemStack) conduit.getClass()
            .getMethod("createItem")
            .invoke(conduit);

        PartRecord rec = new PartRecord(
            "eio:" + baseType.getSimpleName(),
            typeKey(stack),
            new PartSource(
                PartSource.FAMILY_ENDERIO,
                false,
                PartSource.PROVENANCE_COLLISION_DERIVED_VISUAL,
                PartSource.TIER_FAMILY));

        // ① per-conduit 连接段（dir=面方向；无连接 = 空列表）
        try {
            Collection<?> comps = (Collection<?>) conduit.getClass()
                .getMethod("getCollidableComponents")
                .invoke(conduit);
            addComponents(rec, comps, baseType, false);
        } catch (Throwable t) {
            FMLLog.warning("[SDE] EnderIoPartProvider: conduit getCollidableComponents failed: %s", String.valueOf(t));
        }
        // ② tile 级芯盒（dir=UNKNOWN 且 conduitType==本导管类型；conduitType==null 的连接器不发射）
        addComponents(rec, tileComps, baseType, true);

        fillIdentity(rec, stack);
        rec.properties.put("conduitType", baseType.getName());
        return rec;
    }

    /**
     * 把 CollidableComponent 组件归入部件盒。
     *
     * @param coresOnly true ⇒ 只收 tile 级芯盒（{@code dir == UNKNOWN}）；false ⇒ per-conduit 全收
     *                  （其组件 conduitType 本就属于本导管，dir 为面方向连接段）
     */
    private static void addComponents(PartRecord rec, Collection<?> comps, Class<?> baseType, boolean coresOnly) {
        if (comps == null) {
            return;
        }
        for (Object comp : comps) {
            if (comp == null) {
                continue;
            }
            try {
                Object compType = field(comp, "conduitType");
                if (compType == null) {
                    continue; // 连接器：不是独立物品，不发射为部件（§5/§2.5，归属导管本体）
                }
                if (compType != baseType) {
                    continue; // tile 级列表含全部导管，按类型归属过滤
                }
                Object dir = field(comp, "dir");
                if (coresOnly && dir != ForgeDirection.UNKNOWN) {
                    continue; // 芯盒环只收 dir=UNKNOWN（段在 per-conduit 环已收）
                }
                double[] b = bound(comp);
                if (b == null) {
                    continue;
                }
                rec.boxes.add(new PartBox(b[0], b[1], b[2], b[3], b[4], b[5], PartBox.KIND_COLLISION));
                // 视觉盒 = 碰撞盒绕中心 ×1.09（§6.4 确定性推导，单一几何源）
                double[] v = scaleAboutCenter(b, VISUAL_SCALE);
                rec.boxes.add(new PartBox(v[0], v[1], v[2], v[3], v[4], v[5], PartBox.KIND_VISUAL));
            } catch (Throwable t) {
                FMLLog.warning("[SDE] EnderIoPartProvider: component dropped: %s", String.valueOf(t));
            }
        }
    }

    /** CollidableComponent#bound（public final float minX..maxZ，原生 0–1 方块局部）。 */
    private static double[] bound(Object comp) throws Exception {
        Object bound = field(comp, "bound");
        if (bound == null) {
            return null;
        }
        double[] v = new double[6];
        for (int i = 0; i < BOUND_FIELDS.length; i++) {
            Field f = bound.getClass()
                .getField(BOUND_FIELDS[i]);
            v[i] = ((Number) f.get(bound)).doubleValue();
        }
        return v;
    }

    private static double[] scaleAboutCenter(double[] b, double s) {
        double[] out = new double[6];
        for (int axis = 0; axis < 3; axis++) {
            double center = (b[axis] + b[axis + 3]) / 2.0;
            double half = (b[axis + 3] - b[axis]) / 2.0 * s;
            out[axis] = center - half;
            out[axis + 3] = center + half;
        }
        return out;
    }

    private static Object field(Object target, String name) throws Exception {
        return target.getClass()
            .getField(name)
            .get(target);
    }

    /** typeKey = {@code registry:damage}（§5，conduit subtype）；无物品时回退占位。 */
    private static String typeKey(ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return "eio:<no-item>:0";
        }
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        return (reg == null ? "<unregistered>" : reg) + ":" + stack.getItemDamage();
    }

    /** 物品身份 + 显示名 + 说明（§3④⑤、§8 第一优先级 = 物品 tooltip）。 */
    private static void fillIdentity(PartRecord rec, ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            rec.displayName = "<unknown EnderIO conduit>";
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
