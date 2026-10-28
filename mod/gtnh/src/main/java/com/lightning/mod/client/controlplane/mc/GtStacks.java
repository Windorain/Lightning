package com.lightning.mod.client.controlplane.mc;

import java.util.Locale;

import net.minecraft.item.ItemStack;

import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * GT 自己的物品取用入口之二：<b>材料 + 形态</b>（{@code Materials.Silicon.getDust(1)} 那一路）。
 *
 * <h2>为什么 {@link GtItemList} 不够（联证发现的能力缺口）</h2>
 * {@link GtItemList} 只能取「GT 给过 {@code ItemList} 常量」的东西（机器、电池、若干杂项）。
 * 但配方输入里绝大多数是<b>材料形态</b>：三氯硅烷配方要 {@code OrePrefixes.dust × Materials.Silicon}
 * （GT5U {@code loaders/postload/recipes/ChemicalRecipes.java:4236}），而 {@code ItemList} 里
 * <b>没有</b> {@code Silicon} 这个常量——dust 类物品的 meta 是「材料子 id + 形态位」编码出来的
 * 实现细节，用例不该也不能自己算。
 *
 * <p>
 * 本类因此走 GT 自己的两个公开入口：
 * {@code OrePrefixes.getPrefix(name)}（形态）与 {@code Materials.get(name)}（材料），
 * 再交给 {@code GTOreDictUnificator.get(prefix, material, amount)} 产出物品栈——<b>与 GT 配方加载器
 * 同一路径</b>，因此「用例投进去的东西」与「配方认的东西」不可能不一致。
 *
 * <h2>纪律：不硬编码 meta、不猜名字</h2>
 * 与 {@link GtItemList} 同口径（见其类注释）：数字 meta 是 GT 的实现细节，常量名/材料名才是它的公开面。
 * 材料名用 {@code Materials.get} 的<b>规范化匹配</b>（容忍 {@code _GT5U} 后缀、大小写与分隔符差异，
 * 与 {@link GtFluids} 同一口径）；查不到即 {@code CP-VALID-002} 并附样本，不静默产出一个空栈。
 */
public final class GtStacks {

    /** GT 形态表类。 */
    static final String GT_ORE_PREFIXES_CLASS = "gregtech.api.enums.OrePrefixes";

    /** GT 材料表类。 */
    static final String GT_MATERIALS_CLASS = "gregtech.api.enums.Materials";

    /** GT 的 ore dict 统一化入口（材料形态物品的唯一权威产出路径）。 */
    static final String GT_ORE_DICT_CLASS = "gregtech.api.util.GTOreDictUnificator";

    /** 材料表的空材料常量名（{@code Materials.get} 查不到时回落到的那个）。 */
    static final String NULL_MATERIAL_FIELD = "_NULL";

    /** 单次最多列出的相近材料名条数。 */
    static final int MAX_SUGGESTIONS = 8;

    private GtStacks() {}

    /** GT 材料形态通道是否可用（三个类都在场）。 */
    public static boolean available() {
        return ModReflect.allPresent(GT_ORE_PREFIXES_CLASS, GT_MATERIALS_CLASS, GT_ORE_DICT_CLASS);
    }

    /** 环境缺席原因；可用时返回 null。 */
    public static String absenceReason() {
        if (available()) {
            return null;
        }
        return "GT 材料/形态表不在运行期 classpath 上（缺 " + GT_ORE_PREFIXES_CLASS
            + " / "
            + GT_MATERIALS_CLASS
            + " / "
            + GT_ORE_DICT_CLASS
            + " 之一）";
    }

    /**
     * 按「材料 + 形态」取物品栈。
     *
     * @param material 材料名（{@code Silicon}、{@code HydrochloricAcid}；大小写与 {@code _GT5U} 后缀不敏感）
     * @param prefix   形态名（{@code dust} / {@code cell} / {@code ingot} …，即 {@code OrePrefixes} 的名字）
     * @param amount   数量（≥1）
     * @param where    参数路径前缀（错误上下文用）
     * @return 物品栈（非 null，且 {@code getItem() != null}）
     * @throws CpException {@code CP-VALID-002} 名字查不到；{@code CP-STATE-001} GT 缺席
     */
    public static ItemStack resolve(String material, String prefix, int amount, String where) {
        if (!available()) {
            throw new CpException(
                ErrorCodes.STATE,
                absenceReason() + "，无法按「材料 + 形态」取物品",
                Json.object("material", material, "prefix", prefix));
        }
        Class<?> prefixes = ModReflect.cls(GT_ORE_PREFIXES_CLASS);
        Class<?> materials = ModReflect.cls(GT_MATERIALS_CLASS);
        Class<?> unificator = ModReflect.cls(GT_ORE_DICT_CLASS);

        Object prefixObj = ModReflect.callStatic(prefixes, "getPrefix", new Class<?>[] { String.class }, prefix);
        if (prefixObj == null) {
            throw CpException.param(
                "未知物品形态",
                where + ".prefix",
                "GT 的 OrePrefixes 里没有该形态: " + prefix
                    + "（常用：dust / cell / ingot / plate / nugget；"
                    + "形态名即 OrePrefixes 的字段名，大小写敏感）");
        }
        Object materialObj = materialByName(materials, material);
        if (materialObj == null) {
            throw CpException.param(
                "未知 GT 材料",
                where + ".material",
                "GT 的 Materials 里没有该材料: " + material + "（" + materialHint(materials, material) + "）");
        }
        Object stack = ModReflect.callStatic(
            unificator,
            "get",
            new Class<?>[] { prefixes, Object.class, long.class },
            prefixObj,
            materialObj,
            Long.valueOf(Math.max(1L, amount)));
        if (!(stack instanceof ItemStack) || ((ItemStack) stack).getItem() == null) {
            throw CpException.param(
                "该材料没有这种形态",
                where,
                "Materials." + material
                    + " 不生成 "
                    + prefix
                    + " 形态（GT 对该材料关掉了这个 prefix；换一个形态，或改用 id+meta / itemList 写法）");
        }
        return (ItemStack) stack;
    }

    /** 材料表里找材料（原样 → {@code _GT5U} → 规范化匹配）；找不到或歧义返回 null。 */
    static Object materialByName(Class<?> materials, String name) {
        String raw = name == null ? "" : name.trim();
        if (raw.isEmpty()) {
            return null;
        }
        Object nullMaterial = ModReflect.staticField(GT_MATERIALS_CLASS, NULL_MATERIAL_FIELD);
        Object m = lookup(materials, raw, nullMaterial);
        if (m != null) {
            return m;
        }
        m = lookup(materials, raw + "_GT5U", nullMaterial);
        if (m != null) {
            return m;
        }
        Object map = ModReflect.callStatic(materials, "getMaterialsMap", new Class<?>[0]);
        if (!(map instanceof java.util.Map)) {
            return null;
        }
        String want = GtFluids.normalize(raw);
        Object hit = null;
        for (Object entryObj : ((java.util.Map<?, ?>) map).entrySet()) {
            java.util.Map.Entry<?, ?> e = (java.util.Map.Entry<?, ?>) entryObj;
            String key = e.getKey() == null ? null : String.valueOf(e.getKey());
            if (key == null || !GtFluids.normalize(key)
                .equals(want)) {
                continue;
            }
            Object v = e.getValue();
            if (v == null || v == nullMaterial) {
                continue;
            }
            if (hit != null) {
                return null; // 歧义：宁可报「查不到」也不猜一个
            }
            hit = v;
        }
        return hit;
    }

    /** {@code Materials.get(name)}，并把「回落到的空材料」当成查不到。 */
    private static Object lookup(Class<?> materials, String name, Object nullMaterial) {
        Object v = ModReflect.callStatic(materials, "get", new Class<?>[] { String.class }, name);
        if (v == null || v == nullMaterial) {
            return null;
        }
        return v;
    }

    /** 相近材料名提示（只在报错路径上遍历全表）。 */
    static String materialHint(Class<?> materials, String needle) {
        Object map = ModReflect.callStatic(materials, "getMaterialsMap", new Class<?>[0]);
        if (!(map instanceof java.util.Map)) {
            return "材料表不可读，请查 GT 源码 gregtech/api/enums/Materials.java";
        }
        String key = GtFluids.normalize(needle);
        java.util.List<String> hits = new java.util.ArrayList<String>();
        for (Object k : ((java.util.Map<?, ?>) map).keySet()) {
            String s = k == null ? null : String.valueOf(k);
            if (s == null) {
                continue;
            }
            String flat = GtFluids.normalize(s);
            if (!key.isEmpty() && (flat.contains(key) || key.contains(flat))) {
                hits.add(s);
                if (hits.size() >= MAX_SUGGESTIONS) {
                    break;
                }
            }
        }
        if (hits.isEmpty()) {
            return "相近名: （无）——请查 GT 源码 gregtech/api/enums/Materials.java";
        }
        java.util.Collections.sort(hits);
        return "相近名: " + hits;
    }

    /** 形态名的规范形（小写去分隔符），仅用于错误提示里的比较。 */
    static String normalizePrefix(String s) {
        return s == null ? ""
            : s.trim()
                .toLowerCase(Locale.ROOT);
    }
}
