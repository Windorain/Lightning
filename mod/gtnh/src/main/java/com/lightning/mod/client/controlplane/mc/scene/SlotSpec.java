package com.lightning.mod.client.controlplane.mc.scene;

import java.util.Locale;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code scene.inventory.write} 的单槽条目解析（<b>纯逻辑</b>，不碰 MC 类型，因此可离线单测）。
 *
 * <h2>为什么把解析从动作里拆出来</h2>
 * 写槽位本身必然要碰 {@code IInventory}（有世界环境才能跑），但「条目长什么样、哪些字段互斥、
 * 越界的量怎么报错」是纯粹的数据问题。拆出来之后，错误路径可以在单测里逐条锁住
 * （契约 §1.5「失败显式」：写错字段名/给错类型不能静默变成默认值）。
 *
 * <h2>条目形态</h2>
 * 
 * <pre>
 * { "slot": 1, "id": "minecraft:torch", "meta": 0, "count": 16, "nbt": "{...}" }
 * { "slot": 1, "id": "air" }                                  // 清空该槽
 * { "slot": 1, "battery": "Battery_RE_LV_Lithium", "charge": "full" }   // #117 供电布景
 * { "slot": 5, "material": "Silicon", "prefix": "dust", "count": 1 }    // #122 配方输入
 * </pre>
 *
 * <h2>三条互斥纪律（#117 新增两条 + #122 新增一条，都是「失败显式」而非静默修正）</h2>
 * <ol>
 * <li>{@code battery} ⟂ {@code id}：{@code battery} 走 GT 自己的 {@code ItemList} 取栈
 * （见 {@link com.lightning.mod.client.controlplane.mc.GtItemList}），再给 {@code id} 就自相矛盾；</li>
 * <li>{@code charge} ⟂ {@code nbt}：<b>这条是契约纪律，不是实现挑刺</b>。GT 电池的充电状态确实存在
 * NBT 键 {@code GT.ItemCharge} 上，但「写这个键」就是逐字段拼模组状态——正是契约 §6.4 禁止的
 * 「看起来对、实际从未经过模组序列化路径」。要满充电池必须走 {@code charge}（经物品自己的
 * {@code IElectricItemManager}，由模组自己写 NBT）。同时给 {@code nbt} 等于给了一条绕过该纪律的后门，
 * 故直接拒绝。</li>
 * <li><b>#122 新增</b>：{@code material}+{@code prefix} 走 GT 自己的材料/形态表
 * （{@link com.lightning.mod.client.controlplane.mc.GtStacks}），因此与 {@code id}、{@code battery}
 * 都互斥，且 {@code meta} 也互斥（meta 由「材料 + 形态」编码出来，是 GT 的实现细节）。
 * <b>为什么需要它</b>：配方输入绝大多数是材料形态（三氯硅烷配方要 {@code dust × Silicon}），
 * 而 {@code ItemList} 里<b>没有</b> {@code Silicon} 这类常量——只靠 {@code id}+{@code meta}
 * 就得让用例自己算 meta 编码，那既不可读也不稳（GT 调编码即失效）。</li>
 * </ol>
 *
 * <p>
 * 另外 {@code charge} 要求 {@code count == 1}：GT 的电力物品自身条款就是
 * {@code aStack.stackSize != 1} 时拒绝充放（{@code MetaBaseItem.charge/discharge}），
 * 与其在运行期静默充不进，不如在参数期说清楚。
 */
public final class SlotSpec {

    /** 参数名：槽位下标。 */
    public static final String PARAM_SLOT = "slot";

    /** 参数名：物品注册名。 */
    public static final String PARAM_ID = "id";

    /** 参数名：GT ItemList 常量名（电池等）。 */
    public static final String PARAM_BATTERY = "battery";

    /** 参数名：GT 材料名（#122，配方输入）。 */
    public static final String PARAM_MATERIAL = "material";

    /** 参数名：GT 物品形态名（{@code OrePrefixes} 的字段名，如 {@code dust}；#122）。 */
    public static final String PARAM_PREFIX = "prefix";

    /** 参数名：meta/damage。 */
    public static final String PARAM_META = "meta";

    /** 参数名：数量。 */
    public static final String PARAM_COUNT = "count";

    /** 参数名：SNBT 文本。 */
    public static final String PARAM_NBT = "nbt";

    /** 参数名：充电口径。 */
    public static final String PARAM_CHARGE = "charge";

    /** 单槽数量上界（与原版槽位一致）。 */
    public static final int MAX_COUNT = 64;

    /** meta 上界（1.7.10 物品 damage 是 short 域）。 */
    public static final int MAX_META = 32767;

    /**
     * 充电口径。
     *
     * <p>
     * {@code FULL}/{@code EMPTY} 与显式数量三种取值；三种都经物品自己的 {@code IElectricItemManager}
     * 执行（见 {@link com.lightning.mod.client.controlplane.mc.ElectricItems}），
     * <b>不</b>直接写 NBT。
     */
    public static final class Charge {

        /** 口径。 */
        public enum Mode {
            /** 不充电（条目没给 charge）。 */
            NONE,
            /** 充到该物品的最大电量。 */
            FULL,
            /** 放到 0。 */
            EMPTY,
            /** 充/放到指定 EU。 */
            AMOUNT
        }

        /** 不充电。 */
        public static final Charge NONE = new Charge(Mode.NONE, 0L);

        /** 口径。 */
        public final Mode mode;

        /** {@link Mode#AMOUNT} 时的目标电量（EU）；其余模式为 0。 */
        public final long amount;

        private Charge(Mode mode, long amount) {
            this.mode = mode;
            this.amount = amount;
        }

        /** 是否不充电。 */
        public boolean isNone() {
            return mode == Mode.NONE;
        }

        /** 单行描述（日志/读回用）。 */
        public String describe() {
            switch (mode) {
                case FULL:
                    return "full";
                case EMPTY:
                    return "empty";
                case AMOUNT:
                    return Long.toString(amount);
                default:
                    return "none";
            }
        }

        /**
         * 解析 {@code charge} 字段：{@code "full"} | {@code "empty"} | 非负整数（EU）。
         *
         * @param e   字段值（可为 null → {@link #NONE}）
         * @param ctx 字段路径前缀（错误上下文）
         */
        public static Charge parse(JsonElement e, String ctx) {
            if (e == null || e.isJsonNull()) {
                return NONE;
            }
            if (!e.isJsonPrimitive()) {
                throw CpException
                    .param("charge 非法", ctx + "." + PARAM_CHARGE, "只接受 \"full\" | \"empty\" | 非负整数（EU），收到 " + e);
            }
            if (e.getAsJsonPrimitive()
                .isNumber()) {
                double d = e.getAsDouble();
                if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.floor(d)) {
                    throw CpException.param("charge 非法", ctx + "." + PARAM_CHARGE, "整数 EU 值，收到 " + e);
                }
                if (d < 0) {
                    throw CpException.param("charge 非法", ctx + "." + PARAM_CHARGE, "不得为负，收到 " + e);
                }
                return new Charge(Mode.AMOUNT, (long) d);
            }
            String s = e.getAsString()
                .trim()
                .toLowerCase(Locale.ROOT);
            if ("full".equals(s)) {
                return new Charge(Mode.FULL, 0L);
            }
            if ("empty".equals(s)) {
                return new Charge(Mode.EMPTY, 0L);
            }
            throw CpException.param(
                "charge 非法",
                ctx + "." + PARAM_CHARGE,
                "只接受 \"full\" | \"empty\" | 非负整数（EU），收到 \"" + e.getAsString() + "\"");
        }
    }

    /** 槽位下标；缺失时为 {@link Integer#MIN_VALUE}（由调用方报「缺少 slot」以保持既有报错口径）。 */
    public final int slot;

    /** 是否清空该槽（既没给 {@code battery} 也没给有效 {@code id}）。 */
    public final boolean clear;

    /** 物品注册名；{@code clear} 或 {@code battery} 形式时为 null。 */
    public final String id;

    /** GT ItemList 常量名；未给时为 null。 */
    public final String battery;

    /** GT 材料名（#122）；未给时为 null。 */
    public final String material;

    /** GT 形态名（#122）；未给时为 null。 */
    public final String prefix;

    /** meta/damage。 */
    public final int meta;

    /** 数量。 */
    public final int count;

    /** SNBT 文本（可为 null）。 */
    public final String nbt;

    /** 充电口径。 */
    public final Charge charge;

    private SlotSpec(int slot, boolean clear, String id, String battery, String material, String prefix, int meta,
        int count, String nbt, Charge charge) {
        this.slot = slot;
        this.clear = clear;
        this.id = id;
        this.battery = battery;
        this.material = material;
        this.prefix = prefix;
        this.meta = meta;
        this.count = count;
        this.nbt = nbt;
        this.charge = charge;
    }

    /**
     * 解析一个槽位条目。
     *
     * @param entry 条目（不可为 null）
     * @param where 字段路径前缀，如 {@code slots[0]}
     * @throws CpException {@code CP-VALID-002}，逐字段说明
     */
    public static SlotSpec parse(JsonObject entry, String where) {
        JsonObject e = entry == null ? new JsonObject() : entry;
        Fields fields = new Fields();

        Integer slot = null;
        JsonElement slotEl = Json.get(e, PARAM_SLOT);
        if (slotEl == null) {
            fields.add(where + "." + PARAM_SLOT, "必填（整数槽位下标）");
        } else if (!slotEl.isJsonPrimitive() || !slotEl.getAsJsonPrimitive()
            .isNumber()) {
                fields.add(where + "." + PARAM_SLOT, "须为整数（收到 " + slotEl + "）");
            } else {
                double d = slotEl.getAsDouble();
                if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.floor(d)) {
                    fields.add(where + "." + PARAM_SLOT, "须为整数（收到 " + slotEl + "）");
                } else {
                    slot = Integer.valueOf((int) d);
                }
            }

        String rawId = trimmed(Json.optString(e, PARAM_ID, null));
        String battery = trimmed(Json.optString(e, PARAM_BATTERY, null));
        String material = trimmed(Json.optString(e, PARAM_MATERIAL, null));
        String prefix = trimmed(Json.optString(e, PARAM_PREFIX, null));
        String nbt = Json.get(e, PARAM_NBT) == null ? null : Json.optString(e, PARAM_NBT, null);
        Charge charge = Charge.parse(Json.get(e, PARAM_CHARGE), where);
        boolean metaPresent = Json.get(e, PARAM_META) != null;
        int meta = Json.optInt(e, PARAM_META, 0);
        int count = Json.optInt(e, PARAM_COUNT, 1);

        if (rawId != null && battery != null) {
            fields.add(where + "." + PARAM_BATTERY, "与 " + PARAM_ID + " 互斥（battery 自己决定物品）");
        }
        // #122：material 是第三种「由模组自己决定物品」的写法（材料 + 形态 → GT 的 ore dict 产出）。
        // 它与前两种都互斥，且 meta 也互斥——meta 是「材料子 id + 形态位」编码出来的实现细节。
        if (material != null && rawId != null) {
            fields.add(where + "." + PARAM_MATERIAL, "与 " + PARAM_ID + " 互斥（material 自己决定物品）");
        }
        if (material != null && battery != null) {
            fields.add(where + "." + PARAM_MATERIAL, "与 " + PARAM_BATTERY + " 互斥（两者都自己决定物品）");
        }
        if (material != null && metaPresent) {
            fields.add(
                where + "." + PARAM_META,
                "与 " + PARAM_MATERIAL + " 互斥：meta 由「材料 + 形态」经 GT 自己的 ore dict 编码产出，不要另给");
        }
        if (material != null && prefix == null) {
            fields.add(where + "." + PARAM_PREFIX, "给 " + PARAM_MATERIAL + " 时必填（GT 的形态名，如 dust / cell / ingot）");
        }
        if (prefix != null && material == null) {
            fields.add(where + "." + PARAM_MATERIAL, "给 " + PARAM_PREFIX + " 时必填（形态必须配一个材料）");
        }
        if (!charge.isNone() && nbt != null) {
            fields.add(
                where + "." + PARAM_NBT,
                "与 " + PARAM_CHARGE + " 互斥：充电状态必须经物品自己的电力 API 写入（契约 §6.4 禁止逐字段 NBT 回填），" + "nbt 会绕过这条纪律");
        }

        boolean clear = material == null && battery == null && (rawId == null || isAir(rawId));
        if (clear) {
            // 清空条目：count/meta/nbt 与「把槽清成空」无关，沿用既有语义直接忽略（不收紧既有校验）。
            // 但 charge 不能忽略——「要一格满充电池」与「清空这一格」矛盾，静默忽略会造出假绿。
            if (!charge.isNone()) {
                fields.add(where + "." + PARAM_CHARGE, "与清空语义矛盾：" + PARAM_ID + " 给 air（或未给）表示清空该槽，此时没有可充电的物品");
            }
        } else {
            if (!charge.isNone() && count != 1) {
                fields.add(
                    where + "." + PARAM_COUNT,
                    "用 " + PARAM_CHARGE + " 时须为 1（GT 的电力物品在 stackSize != 1 时拒绝充放），收到 " + count);
            }
            if (count < 1 || count > MAX_COUNT) {
                fields.add(where + "." + PARAM_COUNT, "须在 1.." + MAX_COUNT + "（清空请用 id=air），收到 " + count);
            }
            if (metaPresent && (meta < 0 || meta > MAX_META)) {
                fields.add(where + "." + PARAM_META, "须在 0.." + MAX_META + "，收到 " + meta);
            }
        }

        fields.throwIfAny("槽位条目非法");
        return new SlotSpec(
            slot == null ? Integer.MIN_VALUE : slot.intValue(),
            clear,
            clear || battery != null || material != null ? null : rawId,
            battery,
            material,
            prefix,
            meta,
            count,
            nbt,
            charge);
    }

    /** 是否「空气」（清空语义；与 {@code InventoryWriteAction} 既有口径一致）。 */
    static boolean isAir(String id) {
        String s = id.trim();
        return "air".equalsIgnoreCase(s) || "minecraft:air".equalsIgnoreCase(s) || "0".equals(s);
    }

    private static String trimmed(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
