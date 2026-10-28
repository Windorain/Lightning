package com.lightning.mod.client.controlplane.mc.scene;

import java.util.Locale;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code scene.tank.fill} 的参数解析（<b>纯逻辑</b>，不碰 MC/GT 类型，因此可离线单测）。
 *
 * <h2>条目形态</h2>
 *
 * <pre>
 * { "at": [65, 12, 65], "fluid": "HydrochloricAcid", "amount": 3000 }
 * { "at": [65, 12, 65], "fluid": "hydrochloricacid_gt5u", "amount": 3000, "side": "UP" }
 * </pre>
 *
 * <h2>为什么 {@code amount} 与 {@code fluid} 都必须显式（不给默认值）</h2>
 * 注入是<b>状态写入</b>：给 {@code amount} 一个默认值（比如 1000）会让「我漏写了量」静默变成一次
 * 真实注入，而读回看起来完全正常——这正是契约 §7.5 共同口径第 4 条「失败显式」要挡的假绿形态。
 * 同理 {@code fluid} 无默认：默认成水/空气都会污染机器状态且不可逆（除了重建世界）。
 *
 * <h2>为什么 {@code side} 有默认值</h2>
 * 与 {@code gt-machine} 的放置面同一口径（{@code GtMachineParams.DEFAULT_SIDE = "UP"}）：
 * 面向是「从哪一面注入」，而 GT 的机器在 {@code ForgeDirection.UNKNOWN} 之外的每一面都可注入
 * （{@code MTEBasicMachine.isLiquidInput} 只排除正面），因此默认面不改变「能不能注入」这个结论。
 * 但它<b>仍然可显式给</b>：带盖（cover）的机器只有特定面能进流体，
 * 那种场景必须能指定面，否则用例无法表达。
 */
public final class TankFillSpec {

    /** 参数名：目标坐标。 */
    public static final String PARAM_AT = "at";

    /** 参数名：流体名（Forge 注册名或 GT 材料名）。 */
    public static final String PARAM_FLUID = "fluid";

    /** 参数名：注入量（mB）。 */
    public static final String PARAM_AMOUNT = "amount";

    /** 参数名：注入面（{@code ForgeDirection} 名）。 */
    public static final String PARAM_SIDE = "side";

    /** 单次注入量上界（mB）。 */
    public static final int MAX_AMOUNT = 1000000;

    /**
     * 合法的 {@code side} 名，<b>下标即 {@code ForgeDirection} 的 ordinal</b>
     * （1.7.10：0=DOWN、1=UP、2=NORTH、3=SOUTH、4=WEST、5=EAST）。
     */
    static final String[] SIDE_NAMES = { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" };

    /** {@code side} 缺省值（与 {@code gt-machine} 的放置面同口径）。 */
    public static final String DEFAULT_SIDE = "UP";

    /** 解析后的注入输入（纯值对象）。 */
    public static final class Spec {

        /** 流体名原文（未解析成 {@code Fluid}；解析在 mc 层做，见 {@code GtFluids}）。 */
        public final String fluid;

        /** 注入量（mB）。 */
        public final int amount;

        /** 注入面 ordinal（0..5）。 */
        public final int sideOrdinal;

        Spec(String fluid, int amount, int sideOrdinal) {
            this.fluid = fluid;
            this.amount = amount;
            this.sideOrdinal = sideOrdinal;
        }

        /** 注入面的 {@code ForgeDirection} 名。 */
        public String sideName() {
            return TankFillSpec.sideName(sideOrdinal);
        }

        /** 单行摘要（日志与错误上下文用）。 */
        public String describe() {
            return "fluid=" + fluid + ",amount=" + amount + ",side=" + sideName();
        }
    }

    private TankFillSpec() {}

    /**
     * 解析并校验参数。
     *
     * @param params 动作的 {@code params}（可空 → 全部记缺失）
     * @return 注入输入（非 null）
     * @throws CpException {@code CP-VALID-002}，逐字段说明
     */
    public static Spec parse(JsonObject params) {
        JsonObject p = params == null ? new JsonObject() : params;
        Fields fields = new Fields();

        String fluid = trimmed(Json.optString(p, PARAM_FLUID, null));
        if (fluid == null) {
            fields.add(PARAM_FLUID, "必填（Forge 流体注册名，或 GT 材料名如 HydrochloricAcid）");
        }

        Integer amount = intMember(p, PARAM_AMOUNT, fields);
        if (amount != null && (amount.intValue() < 1 || amount.intValue() > MAX_AMOUNT)) {
            fields.add(PARAM_AMOUNT, "须在 1.." + MAX_AMOUNT + "（mB），收到 " + amount);
        }

        String sideRaw = trimmed(Json.optString(p, PARAM_SIDE, null));
        int sideOrdinal = 1; // UP
        if (sideRaw != null) {
            int parsed = sideOrdinal(sideRaw);
            if (parsed < 0) {
                fields.add(PARAM_SIDE, "未知注入面: " + sideRaw + "（可用 " + String.join("|", SIDE_NAMES) + "，大小写不敏感）");
            } else {
                sideOrdinal = parsed;
            }
        }

        fields.throwIfAny("scene.tank.fill 参数非法");
        return new Spec(fluid, amount.intValue(), sideOrdinal);
    }

    /**
     * 解析面名（大小写不敏感）；未知返回 -1。
     *
     * <p>
     * 不用 {@code ForgeDirection.valueOf}：本类是纯逻辑层，判定表自带 ordinal 语义
     * （见 {@link #SIDE_NAMES}），不依赖 Forge 的辅助方法是否存在——与
     * {@code GtMachineParams.sideOrdinal} 同一实现纪律。
     */
    public static int sideOrdinal(String name) {
        if (name == null) {
            return -1;
        }
        String s = name.trim()
            .toUpperCase(Locale.ROOT);
        for (int i = 0; i < SIDE_NAMES.length; i++) {
            if (SIDE_NAMES[i].equals(s)) {
                return i;
            }
        }
        return -1;
    }

    /** ordinal → 名；越界返回 {@link #DEFAULT_SIDE}。 */
    public static String sideName(int ordinal) {
        return ordinal >= 0 && ordinal < SIDE_NAMES.length ? SIDE_NAMES[ordinal] : DEFAULT_SIDE;
    }

    // ------------------------------------------------------------ 工具

    /** 取整数成员；非数字/非整数/缺失都显式记错并返回 null（不静默用默认值）。 */
    private static Integer intMember(JsonObject p, String key, Fields fields) {
        JsonElement e = Json.get(p, key);
        if (e == null) {
            fields.add(key, "必填（注入量，mB，1.." + MAX_AMOUNT + "）——不给默认值：漏写量必须显式失败，" + "否则「漏写」会静默变成一次真实注入（契约 §7.5 共同口径第 4 条）");
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            fields.add(key, "须为整数（收到 " + e + "）");
            return null;
        }
        double d = e.getAsDouble();
        if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.floor(d)) {
            fields.add(key, "须为整数（收到 " + e + "）");
            return null;
        }
        return Integer.valueOf((int) d);
    }

    private static String trimmed(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
