package com.lightning.mod.client.meshcapture.parts.fmp;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

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
 * FMP（ForgeMultipart/ForgeMicroblock）族权威部件提供者 —— 三档兜底流水线的<strong>档 1</strong>
 * （契约 {@code format-parts-contract.md} §7）：{@code family=fmp, tier=1, fallback=false,
 * boxProvenance=both}。
 *
 * <p>
 * 反射调用链（逐跳与历史族 API 探针 §3 一致，18 个方法实证同名可达；
 * FMP 是 Scala 编译产物，纯运行时反射，不引用 codechicken 任何编译期类型）：
 *
 * <pre>
 * world.getTileEntity(x,y,z)   → TileMultipart（含生成的 mixin 子类，如 TileMultipart_cmp$$1，按类名判定）
 * tile.jPartList()             → java.util.List&lt;TMultiPart&gt;（枚举；<strong>不要</strong>用
 *                                partMap(slot) 轮询——基类返回 null，前置探针实证）
 * part.getSlot()               → 0–26 PartMap 规范槽位（TSlottedPart 才有；无槽部件反射失败 ⇒
 *                                localId 回退 fmp:part&lt;枚举序号&gt;，契约 §4）
 * part.getSubParts()           → Iterable&lt;IndexedCuboid6&gt;（视觉/高亮盒）
 * part.getCollisionBoxes()     → Iterable&lt;Cuboid6&gt;（碰撞盒）——两套都取（§6.4）
 * part.getDrops()              → Iterable&lt;ItemStack&gt;（物品身份；size&gt;1 微方块拆多件 ⇒
 *                                items 数组逐条，「一部件≠一物品」实证）
 * </pre>
 *
 * <p>
 * 坐标系（§6.1）：Cuboid6.min/max（Vector3，public double x/y/z）<strong>原生即 0–1 方块局部</strong>
 * Y-up，直接用。
 *
 * <p>
 * 物品身份与类型键（§5，前置探针实证）：typeKey = {@code registry:damage#mat=<材料串>}——
 * 同 item 同 damage 不同材料 = 不同物品；<strong>权威身份 = 部件实际 NBT mat 串</strong>，
 * 不要用材料显示名（别名坑：材料名是别名解析，"stone" 实测解析为 ProjRed 大理石）。
 * 每条 drop 逐条进 items 数组，nbtDiscriminator 带 mat 串。
 *
 * <p>
 * 降级纪律：反射断点逐个 try-catch——某部件失败只丢该部件，整族引导失败返回空列表，绝不抛出。
 */
@SideOnly(Side.CLIENT)
public final class FmpPartProvider implements PartProvider {

    public static final int DEFAULT_PRIORITY = 120;

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
        return PartSource.FAMILY_FMP;
    }

    /** TE 是 TileMultipart（含生成的 mixin 子类，按类名包含判定，前置探针实证）。 */
    @Override
    public boolean applies(PartProviderContext ctx) {
        if (ctx == null || ctx.world == null) {
            return false;
        }
        try {
            TileEntity te = ctx.world.getTileEntity(ctx.x, ctx.y, ctx.z);
            return te != null && te.getClass()
                .getName()
                .contains("TileMultipart");
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
        List<?> partList;
        try {
            partList = (List<?>) te.getClass()
                .getMethod("jPartList")
                .invoke(te);
        } catch (Throwable t) {
            FMLLog.warning("[SDE] FmpPartProvider: jPartList failed: %s", String.valueOf(t));
            return out;
        }
        if (partList == null) {
            return out;
        }

        for (int i = 0; i < partList.size(); i++) {
            Object part = partList.get(i);
            if (part == null) {
                continue;
            }
            try {
                out.add(buildPart(part, i));
            } catch (Throwable t) {
                // 只丢该部件（§7 降级纪律）
                FMLLog.warning(
                    "[SDE] FmpPartProvider: part #%d (%s) dropped: %s",
                    Integer.valueOf(i),
                    part.getClass()
                        .getName(),
                    String.valueOf(t));
            }
        }
        return out;
    }

    /** 单部件 → PartRecord。 */
    private static PartRecord buildPart(Object part, int index) throws Exception {
        // 槽位（TSlottedPart#getSlot → PartMap 0–26 规范槽位）；无槽部件 ⇒ fmp:part<枚举序号>（§4）
        Integer slot = null;
        try {
            Object s = part.getClass()
                .getMethod("getSlot")
                .invoke(part);
            slot = Integer.valueOf(((Number) s).intValue());
        } catch (Throwable ignored) {
            // 非 TSlottedPart：无 getSlot 方法属正常情形，回退 fmp:part<N>
        }
        String localId = slot != null ? "fmp:slot" + slot : "fmp:part" + index;

        // 族类型串（如 mcr_face），进 properties（族特有扩展点，§3）
        String fmpType = null;
        try {
            fmpType = String.valueOf(
                part.getClass()
                    .getMethod("getType")
                    .invoke(part));
        } catch (Throwable ignored) {
            // 类型串缺失不阻塞
        }

        // 物品身份：getDrops 可多件（size>1 拆 4/2/1，「一部件≠一物品」实证）⇒ items 逐条
        List<ItemStack> drops = new ArrayList<ItemStack>();
        try {
            Object d = part.getClass()
                .getMethod("getDrops")
                .invoke(part);
            if (d instanceof Iterable) {
                for (Object o : (Iterable<?>) d) {
                    if (o instanceof ItemStack) {
                        drops.add((ItemStack) o);
                    }
                }
            }
        } catch (Throwable t) {
            FMLLog.warning("[SDE] FmpPartProvider: getDrops failed: %s", String.valueOf(t));
        }

        PartRecord rec = new PartRecord(
            localId,
            typeKey(drops, fmpType),
            new PartSource(PartSource.FAMILY_FMP, false, PartSource.PROVENANCE_BOTH, PartSource.TIER_FAMILY));

        // 视觉盒（getSubParts）+ 碰撞盒（getCollisionBoxes）两套都取（§6.4；接口层允许不同源）
        addCuboids(rec, part, "getSubParts", PartBox.KIND_VISUAL);
        addCuboids(rec, part, "getCollisionBoxes", PartBox.KIND_COLLISION);

        // items 数组逐条（nbtDiscriminator = "mat=<材料串>" 键值串，与契约 §10.2 proto 注释及
        // typeKey 的 `#mat=` 段同形 ⇒ PartItem.iconKey() == typeKey，web 统计行图标键直配）
        String mat = null;
        for (ItemStack drop : drops) {
            String dropMat = matString(drop);
            if (mat == null) {
                mat = dropMat;
            }
            rec.items.add(
                new PartItem(
                    registryOf(drop),
                    drop.getItemDamage(),
                    drop.stackSize,
                    dropMat == null ? null : "mat=" + dropMat));
        }

        fillDisplayAndTooltip(rec, drops, fmpType);
        if (fmpType != null) {
            rec.properties.put("fmpType", fmpType);
        }
        if (mat != null) {
            rec.properties.put("mat", mat);
        }
        return rec;
    }

    /**
     * typeKey = {@code registry:damage#mat=<材料串>}（§5；权威身份 = NBT mat 串，不是材料显示名）。
     * 多条 drop 共享同部件身份，typeKey 取首条；无 drop ⇒ 回退 fmp 类型占位（items 空数组 = 显式"无"）。
     */
    private static String typeKey(List<ItemStack> drops, String fmpType) {
        if (!drops.isEmpty()) {
            ItemStack first = drops.get(0);
            String key = registryOf(first) + ":" + first.getItemDamage();
            String mat = matString(first);
            if (mat != null) {
                key += "#mat=" + mat;
            }
            return key;
        }
        return "fmp:<no-item>:" + (fmpType == null ? "unknown" : fmpType);
    }

    private static String registryOf(ItemStack stack) {
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        return reg == null ? "<unregistered>" : reg;
    }

    /** NBT {@code mat} 键 = FMP 微方块材料串（权威身份，§5）；无 NBT/无 mat ⇒ null。 */
    private static String matString(ItemStack stack) {
        try {
            if (stack.hasTagCompound() && stack.getTagCompound()
                .hasKey("mat")) {
                return stack.getTagCompound()
                    .getString("mat");
            }
        } catch (Throwable ignored) {
            // fallthrough
        }
        return null;
    }

    /**
     * Cuboid6 盒读取（{@code getSubParts}/{@code getCollisionBoxes}）：Cuboid6.min/max =
     * Vector3（public double x/y/z），原生 0–1 方块局部，直接用（§6.1）。IndexedCuboid6 是
     * Cuboid6 子类，同一 min/max 字段布局。
     */
    private static void addCuboids(PartRecord rec, Object part, String method, String kind) {
        try {
            Object cuboids = part.getClass()
                .getMethod(method)
                .invoke(part);
            if (!(cuboids instanceof Iterable)) {
                return;
            }
            for (Object c : (Iterable<?>) cuboids) {
                if (c == null) {
                    continue;
                }
                try {
                    Object min = c.getClass()
                        .getField("min")
                        .get(c);
                    Object max = c.getClass()
                        .getField("max")
                        .get(c);
                    rec.boxes.add(
                        new PartBox(
                            vec(min, "x"),
                            vec(min, "y"),
                            vec(min, "z"),
                            vec(max, "x"),
                            vec(max, "y"),
                            vec(max, "z"),
                            kind));
                } catch (Throwable t) {
                    FMLLog.warning("[SDE] FmpPartProvider: cuboid of %s dropped: %s", method, String.valueOf(t));
                }
            }
        } catch (Throwable t) {
            // 一套盒失败只丢该套（另一套与物品身份仍产出）
            FMLLog.warning("[SDE] FmpPartProvider: %s failed: %s", method, String.valueOf(t));
        }
    }

    private static double vec(Object vector3, String axis) throws Exception {
        Field f = vector3.getClass()
            .getField(axis);
        return ((Number) f.get(vector3)).doubleValue();
    }

    /** 显示名/说明取首条 drop 物品（§3 的 {@code displayName}/{@code tooltip} 行、§8 第一优先级 = 物品 tooltip）；无 drop 回退族类型串。 */
    private static void fillDisplayAndTooltip(PartRecord rec, List<ItemStack> drops, String fmpType) {
        if (drops.isEmpty()) {
            rec.displayName = fmpType == null ? "<unknown FMP part>" : fmpType;
            rec.tooltip.add(rec.displayName);
            return;
        }
        ItemStack stack = drops.get(0);
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
