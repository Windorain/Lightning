package com.lightning.mod.client.controlplane.mc;

import java.util.Locale;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code gt-machine} 补全器的参数解析与校验（<b>纯逻辑</b>，不碰任何 MC/GT 类型，因此可离线单测）。
 *
 * <h2>两种声明方式（二选一，互斥）</h2>
 * <ol>
 * <li><b>{@code machine}</b>（首选）：GT 自己的 {@code gregtech.api.enums.ItemList} 常量名，如
 * {@code Machine_LV_ChemicalReactor}。物品与 meta 一律由 GT 自己的 {@code ItemList.<X>.get(1)} 产出
 * ——没有硬编码数字，GT 侧改名/改 id 时用例无需改；</li>
 * <li><b>{@code item}+{@code meta}</b>（显式）：{@code item} 只接受 GT 机器方块的注册名
 * {@link #GT_MACHINE_BLOCK}，{@code meta} 是 MetaTileEntity id（= 物品 damage =
 * {@code GregTechAPI.METATILEENTITIES[]} 下标）。</li>
 * </ol>
 *
 * <h2>为什么 meta 必须 &gt; 0</h2>
 * GT 的放置路径只在 {@code tDamage > 0} 时建 MetaTileEntity（GT5U
 * {@code gregtech/common/blocks/ItemMachines.java:244-283}，283 版同构）；{@code tDamage == 0}
 * 只 {@code setBlock} 出一个空壳方块。因此 {@code meta=0} 不是「默认值」而是「要一个跑不起来的壳」，
 * 必须显式报错而不是静默接受。
 *
 * <h2>为什么没有 {@code nbt} 参数</h2>
 * GT 的 {@code ItemMachines.placeBlockAt} 会把 {@code ItemStack} 自己的 NBT 作为
 * {@code setInitialValuesAsNBT} 的输入（同文件 :262）。收一个任意 SNBT 就等于让用例逐字段拼 TE 状态，
 * 正是契约 §10 第 6 条禁止的「看起来对、实际从未经过模组序列化路径」——故本补全器<b>只</b>接受
 * 「放什么机器、朝哪一面」这类<b>放置输入</b>，初始状态由 GT 自己的
 * {@code createNewMetatileEntity} + {@code initDefaultModes} 产生（等价于玩家手持新机器放下）。
 */
public final class GtMachineParams {

    /**
     * GT 机器方块的注册名。
     *
     * <p>
     * 来源：{@code gregtech/common/blocks/BlockMachines.java:71-73}（构造传
     * {@code "gt.blockmachines"}）+ {@code :140-143}{@code getUnlocalizedName()} 返回同一字面量，
     * 由 {@code GTGenericBlock.java:14-19} 经 {@code GameRegistry.registerBlock(this, ItemMachines.class,
     * getUnlocalizedName())} 注册在 modid {@code gregtech} 下。
     */
    public static final String GT_MACHINE_BLOCK = "gregtech:gt.blockmachines";

    /** 参数名：ItemList 常量名。 */
    public static final String PARAM_MACHINE = "machine";

    /** 参数名：方块注册名（只接受 {@link #GT_MACHINE_BLOCK}）。 */
    public static final String PARAM_ITEM = "item";

    /** 参数名：MetaTileEntity id。 */
    public static final String PARAM_META = "meta";

    /** 参数名：放置面（{@code ForgeDirection} 名）。 */
    public static final String PARAM_SIDE = "side";

    /** MetaTileEntity id 上界：GT 用 {@code short} 承载 damage（{@code ItemMachines.java:243}）。 */
    public static final int MAX_META = 32767;

    /** {@code side} 缺省值（与探针的 {@code onItemUse} 口径一致，见 {@code MultiblockWorldBuilder.java:222}）。 */
    public static final String DEFAULT_SIDE = "UP";

    /**
     * 合法的 {@code side} 名，<b>下标即 {@code ForgeDirection} 的 ordinal</b>
     * （1.7.10：0=DOWN、1=UP、2=NORTH、3=SOUTH、4=WEST、5=EAST）。
     */
    static final String[] SIDE_NAMES = { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" };

    /** ItemList 常量存在性判定口（生产实现见 {@link GtItemList#lookup()}；单测注入 stub）。 */
    public interface ItemListLookup {

        /** {@code gregtech.api.enums.ItemList} 里是否有该常量。 */
        boolean contains(String constantName);
    }

    /** 解析后的放置输入（纯值对象）。 */
    public static final class Spec {

        /** ItemList 常量名；显式 {@code item} 形式时为 null。 */
        public final String machine;

        /** 显式方块注册名；{@code machine} 形式时为 null。 */
        public final String item;

        /** 显式形式的 MetaTileEntity id；{@code machine} 形式时为 0（由物品 damage 决定）。 */
        public final int meta;

        /** 放置面 ordinal（0..5）。 */
        public final int sideOrdinal;

        Spec(String machine, String item, int meta, int sideOrdinal) {
            this.machine = machine;
            this.item = item;
            this.meta = meta;
            this.sideOrdinal = sideOrdinal;
        }

        /** 是否走 ItemList 常量形式。 */
        public boolean byItemList() {
            return machine != null;
        }

        /** 放置面的 {@code ForgeDirection} 名。 */
        public String sideName() {
            return GtMachineParams.sideName(sideOrdinal);
        }

        /** 单行摘要（日志与错误上下文用）。 */
        public String describe() {
            return byItemList() ? "machine=" + machine + ",side=" + sideName()
                : "item=" + item + ",meta=" + meta + ",side=" + sideName();
        }
    }

    private GtMachineParams() {}

    /**
     * 解析并校验参数。
     *
     * @param params 用例 {@code te} 步的 {@code params}（可空）
     * @param lookup ItemList 存在性判定；<b>null 表示跳过存在性检查</b>（仅测试用）
     * @return 放置输入（非 null）
     * @throws com.lightning.mod.client.controlplane.core.CpException {@code CP-VALID-002}，逐字段说明
     */
    public static Spec parse(JsonObject params, ItemListLookup lookup) {
        JsonObject p = params == null ? new JsonObject() : params;
        Fields fields = new Fields();

        String machine = trimmed(Json.optString(p, PARAM_MACHINE, null));
        String item = trimmed(Json.optString(p, PARAM_ITEM, null));
        boolean metaPresent = Json.get(p, PARAM_META) != null;

        if (machine == null && item == null) {
            fields.add(
                PARAM_MACHINE,
                "必填（二选一）：GT ItemList 常量名，如 Machine_LV_ChemicalReactor；或给 " + PARAM_ITEM + "+" + PARAM_META);
        }
        if (machine != null && item != null) {
            fields.add(PARAM_MACHINE, "与 " + PARAM_ITEM + " 互斥（machine 自带你需要的物品与 meta）");
        }
        if (machine != null && metaPresent) {
            fields.add(PARAM_META, "与 " + PARAM_MACHINE + " 互斥：meta 由该 ItemList 常量自带，不要另给");
        }
        if (item != null) {
            if (!GT_MACHINE_BLOCK.equalsIgnoreCase(item)) {
                fields.add(PARAM_ITEM, "不是 GT 机器方块：只接受 " + GT_MACHINE_BLOCK + "（GT 的机器方块只有这一个），收到 " + item);
            }
            if (!metaPresent) {
                fields.add(PARAM_META, "给 " + PARAM_ITEM + " 时必填（MetaTileEntity id，1.." + MAX_META + "）");
            }
        }
        if (machine != null && lookup != null && !lookup.contains(machine)) {
            fields.add(
                PARAM_MACHINE,
                "GT ItemList 里没有该常量: " + machine + "（应形如 Machine_LV_ChemicalReactor；" + GtItemList.hint(machine) + "）");
        }

        int meta = 0;
        if (metaPresent) {
            Integer parsed = intMember(p, PARAM_META, fields);
            if (parsed != null) {
                meta = parsed.intValue();
                if (meta <= 0 || meta > MAX_META) {
                    fields.add(
                        PARAM_META,
                        "须在 1.." + MAX_META + "（meta=0 时 GT 只 setBlock 出一个没有 MetaTileEntity 的空壳，机器跑不起来），收到 " + meta);
                }
            }
        }

        String sideRaw = trimmed(Json.optString(p, PARAM_SIDE, null));
        int sideOrdinal = SIDE_NAMES.length == 0 ? 0 : 1; // UP
        if (sideRaw != null) {
            int parsed = sideOrdinal(sideRaw);
            if (parsed < 0) {
                fields.add(PARAM_SIDE, "未知放置面: " + sideRaw + "（可用 " + String.join("|", SIDE_NAMES) + "，大小写不敏感）");
            } else {
                sideOrdinal = parsed;
            }
        }

        fields.throwIfAny("gt-machine 参数非法");
        return new Spec(machine, item, meta, sideOrdinal);
    }

    /**
     * 解析放置面（大小写不敏感）；未知返回 -1。
     *
     * <p>
     * 不用 {@code ForgeDirection.valueOf}：本类是纯逻辑层，判定表自带 ordinal 语义
     * （见 {@link #SIDE_NAMES}），不依赖 Forge 的辅助方法是否存在。
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

    /** 取整数成员；非数字/非整数都显式记错并返回 null（不静默用默认值）。 */
    private static Integer intMember(JsonObject p, String key, Fields fields) {
        JsonElement e = Json.get(p, key);
        if (e == null || !e.isJsonPrimitive()
            || !e.getAsJsonPrimitive()
                .isNumber()) {
            fields.add(key, "须为整数（收到 " + (e == null ? "缺失" : e.toString()) + "）");
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
