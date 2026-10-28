package com.lightning.mod.client.controlplane.mc;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

/**
 * 电力物品（电池、充电工具…）的<b>读写口</b>：一律经物品自己的 {@code IElectricItem} /
 * {@code IElectricItemManager}（IC2 API，GT 的 {@code MetaBaseItem} 自己实现了它）。
 *
 * <h2>为什么必须有这一层（而不是让用例写 NBT）</h2>
 * 「把满充 GT 电池放进机器充电槽」如果靠 {@code nbt:"{GT.ItemCharge:100000L}"} 就成了逐字段拼
 * NBT——正是契约 §10 第 6 条禁止的「看起来对、实际从未经过模组序列化路径」。GT 电池的充电状态确实存在
 * NBT 键 {@code GT.ItemCharge}（long）里，但<b>写它的权威入口</b>是 GT 自己的
 * {@code MetaBaseItem.setCharge}/{@code charge}（GT5U {@code gregtech/api/items/MetaBaseItem.java:484}，
 * 由 {@code GTModHandler.chargeElectricItem} 与 {@code ItemList.getWithCharge} 复用；
 * GT 自己的创造模式标签页也是这么灌满电池的：{@code MetaGeneratedItem.java:427}）。
 * 因此本类只暴露「按物品自己的管理器充电/放电」这一条路，NBT 由 GT 自己写。
 *
 * <h2>为什么用 {@code IElectricItemManager} 的 double 重载而不是 GT 的 int 包装</h2>
 * {@code GTModHandler.chargeElectricItem(ItemStack, int, ...)} 与 {@code ItemList.getWithCharge(...)}
 * 的充电量是 {@code int}——对 LV 电池（10 万 EU）够用，但对 {@code Energy_Cluster}（1000 亿 EU）
 * 会被 {@code Integer.MAX_VALUE}（约 21 亿）截断，「充满」就不成立了。
 * {@code IElectricItemManager.charge(ItemStack, double, int, boolean, boolean)} 的充电量是
 * {@code double}，配合 {@code aIgnoreTransferLimit=true} 可以一次灌满任意等级——
 * 且它正是 GT 自己的 {@code MetaBaseItem.charge} 实现（GT 的 {@code getManager(stack)} 返回 {@code this}）。
 *
 * <h2>「是不是电力物品」的判据照抄 GT</h2>
 * GT 的机器方块、{@code gt.metaitem.01} 的<b>每一个</b>子类型都实现了 {@code IElectricItem}
 * （{@code MetaBaseItem} 就是实现类），所以「instanceof IElectricItem」<b>不足以</b>判定
 * 「这东西能充电」——GT 自己的 {@code GTModHandler.isElectricItem} 还要求
 * {@code getTier(stack) < Integer.MAX_VALUE}（非电力物品的 tier 恒为 {@code Integer.MAX_VALUE}）。
 * 本类照抄该判据，并额外要求 {@code getMaxCharge > 0}：否则「给一块石头充电」会被静默当成成功。
 */
public final class ElectricItems {

    /** IC2 的电力物品接口（{@code MetaBaseItem} 实现之）。 */
    static final String IEC2_ELECTRIC_ITEM = "ic2.api.item.IElectricItem";

    /** IC2 的特殊电力物品接口：{@code getManager(stack)} 返回物品自己的管理器（GT 走这条）。 */
    static final String IEC2_SPECIAL_ELECTRIC_ITEM = "ic2.api.item.ISpecialElectricItem";

    /** IC2 的电力物品管理器接口。 */
    static final String IEC2_ELECTRIC_ITEM_MANAGER = "ic2.api.item.IElectricItemManager";

    /** IC2 的全局管理器持有者（非特殊物品走它的静态字段 {@code manager}）。 */
    static final String IEC2_ELECTRIC_ITEM_HOLDER = "ic2.api.item.ElectricItem";

    private ElectricItems() {}

    /** IC2 的电力 API 是否在运行期 classpath 上。 */
    public static boolean available() {
        return ModReflect.cls(IEC2_ELECTRIC_ITEM) != null && ModReflect.cls(IEC2_ELECTRIC_ITEM_MANAGER) != null;
    }

    /** 该接口类（用于类型判定）；IC2 缺席时为 null。 */
    static Class<?> electricItemInterface() {
        return ModReflect.cls(IEC2_ELECTRIC_ITEM);
    }

    /**
     * 是不是「可充放的电力物品」。
     *
     * <p>
     * {@code instanceof IElectricItem} <b>且</b> {@code tier < Integer.MAX_VALUE} <b>且</b>
     * {@code maxCharge > 0}——见类注释（前两条照抄 GT，第三条防「0 容量也算成功」）。
     */
    public static boolean isElectric(ItemStack stack) {
        Class<?> iface = electricItemInterface();
        if (iface == null || stack == null || stack.getItem() == null || !iface.isInstance(stack.getItem())) {
            return false;
        }
        Integer tier = tier(stack);
        Long max = maxCharge(stack);
        return tier != null && tier.intValue() < Integer.MAX_VALUE && max != null && max.longValue() > 0L;
    }

    /** 当前电量（EU）；不可读返回 null。 */
    public static Long chargeOf(ItemStack stack) {
        Object manager = manager(stack);
        if (manager == null) {
            return null;
        }
        return asLong(ModReflect.call(manager, "getCharge", new Class<?>[] { ItemStack.class }, stack));
    }

    /** 最大电量（EU）；不可读返回 null。 */
    public static Long maxCharge(ItemStack stack) {
        Item item = stack == null ? null : stack.getItem();
        if (item == null) {
            return null;
        }
        return asLong(ModReflect.call(item, "getMaxCharge", new Class<?>[] { ItemStack.class }, stack));
    }

    /** 电压等级（IC2 的 tier）；不可读返回 null。 */
    public static Integer tier(ItemStack stack) {
        Item item = stack == null ? null : stack.getItem();
        if (item == null) {
            return null;
        }
        Object v = ModReflect.call(item, "getTier", new Class<?>[] { ItemStack.class }, stack);
        return v instanceof Number ? Integer.valueOf(((Number) v).intValue()) : null;
    }

    /** 是否可对外供电（IC2 {@code canProvideEnergy}）；不可读返回 null。 */
    public static Boolean canProvideEnergy(ItemStack stack) {
        Item item = stack == null ? null : stack.getItem();
        if (item == null) {
            return null;
        }
        Object v = ModReflect.call(item, "canProvideEnergy", new Class<?>[] { ItemStack.class }, stack);
        return v instanceof Boolean ? (Boolean) v : null;
    }

    /**
     * 充电，返回实际充入量（EU）；未充入返回 0。
     *
     * <p>
     * {@code aIgnoreTransferLimit=true} + {@code aTier=Integer.MAX_VALUE}：一次调用即可灌满任何等级
     * （见类注释）；{@code simulate=true} 用于只问「能充多少」。
     */
    public static long charge(ItemStack stack, long amount, boolean simulate) {
        Object manager = manager(stack);
        if (manager == null || amount <= 0L) {
            return 0L;
        }
        Object r = ModReflect.call(
            manager,
            "charge",
            new Class<?>[] { ItemStack.class, double.class, int.class, boolean.class, boolean.class },
            stack,
            Double.valueOf((double) amount),
            Integer.valueOf(Integer.MAX_VALUE),
            Boolean.TRUE,
            Boolean.valueOf(simulate));
        Long v = asLong(r);
        return v == null ? 0L : v.longValue();
    }

    /**
     * 放电，返回实际放出量（EU）。
     *
     * <p>
     * {@code aBatteryAlike=true}：要求物品自身可供电（GT 的 {@code canProvideEnergy}），这正是
     * 「电池」与「耗电工具」的分界。
     */
    public static long discharge(ItemStack stack, long amount, boolean simulate) {
        Object manager = manager(stack);
        if (manager == null || amount <= 0L) {
            return 0L;
        }
        Object r = ModReflect.call(
            manager,
            "discharge",
            new Class<?>[] { ItemStack.class, double.class, int.class, boolean.class, boolean.class, boolean.class },
            stack,
            Double.valueOf((double) amount),
            Integer.valueOf(Integer.MAX_VALUE),
            Boolean.TRUE,
            Boolean.TRUE,
            Boolean.valueOf(simulate));
        Long v = asLong(r);
        return v == null ? 0L : v.longValue();
    }

    // ------------------------------------------------------------ 内部

    /**
     * 物品自己的电力管理器。
     *
     * <p>
     * GT 的 {@code MetaBaseItem} 实现 {@code ISpecialElectricItem}，其 {@code getManager(stack)}
     * 返回 {@code this}（{@code MetaBaseItem.java:658}）——即 GT 电池的充放全由 GT 自己的实现处理。
     * 非特殊物品（IC2 原生电池/工具）回落到 IC2 的全局 {@code ElectricItem.manager}
     * （GT 自己的 {@code ItemGTToolbox.getElectricManager} 也是这么分派的）。
     */
    private static Object manager(ItemStack stack) {
        Item item = stack == null ? null : stack.getItem();
        if (item == null) {
            return null;
        }
        Class<?> special = ModReflect.cls(IEC2_SPECIAL_ELECTRIC_ITEM);
        if (special != null && special.isInstance(item)) {
            Object m = ModReflect.call(item, "getManager", new Class<?>[] { ItemStack.class }, stack);
            if (m != null) {
                return m;
            }
        }
        return ModReflect.staticField(IEC2_ELECTRIC_ITEM_HOLDER, "manager");
    }

    private static Long asLong(Object v) {
        if (!(v instanceof Number)) {
            return null;
        }
        double d = ((Number) v).doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? null : Long.valueOf((long) d);
    }
}
