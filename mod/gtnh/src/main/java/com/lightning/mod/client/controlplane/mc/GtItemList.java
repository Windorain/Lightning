package com.lightning.mod.client.controlplane.mc;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import net.minecraft.item.ItemStack;

import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * GT 自己的物品清单入口：{@code gregtech.api.enums.ItemList} 常量 → {@link ItemStack}。
 *
 * <h2>为什么走 ItemList 而不是硬编码「物品注册名 + meta」</h2>
 * GT 的每一台机器/每一个电池在 {@code ItemList} 里都有一个常量，注册时由 GT 自己
 * {@code set(...)} 上真实的 {@link ItemStack}（机器：{@code LoaderMetaTileEntities}；
 * 电池：{@code MetaGeneratedItem01}）。用例写常量名（{@code Machine_LV_ChemicalReactor}、
 * {@code Battery_RE_LV_Lithium}）而不是写数字 meta，好处是：
 * <ul>
 * <li>GT 侧调 meta 时用例不用改——数字是 GT 的实现细节，常量名是它的公开面；</li>
 * <li>错误路径可自描述：常量名写错时能把 ItemList 里的相近名字列出来，让用例作者一次改对；</li>
 * <li>{@code ItemList.get(long)} 返回的是<b>副本</b>（{@code GTUtility.copyAmount(...)}），
 * 因此本类返回的栈可以安全地被后续充电/写入修改，不会污染 GT 的注册表原型。</li>
 * </ul>
 *
 * <h2>全反射</h2>
 * 与 LP/AE2 族同一口径（见 {@link ModReflect} 与 {@link ModTeFamilies}）：GT 在本树是
 * {@code compileOnly} 依赖，整合包里也可以缺——硬 import 会在类加载期抛
 * {@link NoClassDefFoundError}，连控制面自身都起不来。缺席时本类的方法返回
 * {@code CP-STATE-001}（环境问题），而不是静默当成「没有这个常量」。
 */
public final class GtItemList {

    /** ItemList 类名。 */
    static final String ITEM_LIST_CLASS = "gregtech.api.enums.ItemList";

    /** 候选名提示里最多列出的条数。 */
    private static final int MAX_SUGGESTIONS = 8;

    private GtItemList() {}

    /** GT 的 ItemList 是否在运行期 classpath 上。 */
    public static boolean available() {
        return ModReflect.cls(ITEM_LIST_CLASS) != null;
    }

    /** {@link GtMachineParams.ItemListLookup} 的生产实现。 */
    public static GtMachineParams.ItemListLookup lookup() {
        return GtItemList::contains;
    }

    /** ItemList 里是否有该常量（大小写敏感，与 Java 枚举同名）。 */
    public static boolean contains(String constantName) {
        return constant(constantName) != null;
    }

    /**
     * 取该 ItemList 常量对应的物品栈。
     *
     * @param constantName ItemList 常量名，如 {@code Machine_LV_ChemicalReactor}
     * @param amount       数量（≥1）
     * @return 物品栈（非 null，且 {@code getItem() != null}）
     * @throws CpException {@code CP-VALID-002} 常量名不存在或未注册物品；{@code CP-STATE-001} GT 缺席
     */
    public static ItemStack get(String constantName, long amount) {
        Class<?> cls = ModReflect.load(ITEM_LIST_CLASS);
        if (cls == null || !cls.isEnum()) {
            throw new CpException(
                ErrorCodes.STATE,
                "GregTech 不在运行期 classpath 上（缺 " + ITEM_LIST_CLASS + "），无法按 ItemList 常量取物品",
                Json.object("constant", constantName, "hint", "该族缺席；确认整合包含 GT5-Unofficial"));
        }
        Object constant = constant(constantName);
        if (constant == null) {
            throw CpException.param("GT ItemList 里没有该常量", "machine", constantName + "（" + hint(constantName) + "）");
        }
        ItemStack stack = invokeGet(constant, constantName, amount);
        if (stack == null || stack.getItem() == null) {
            throw CpException.param(
                "该 ItemList 常量还没有绑定物品",
                "machine",
                constantName + " 在当前 GT 版本/配置下未注册（ItemList.get 返回空栈）——换一个常量，或改用 item+meta 形式");
        }
        return stack;
    }

    /**
     * 相近常量名提示：按「去掉分隔符后是否包含输入」排序，最多 {@link #MAX_SUGGESTIONS} 条。
     *
     * <p>
     * 只在<b>报错路径</b>上调用（要遍历全部枚举常量），不参与正常路径的性能。
     */
    public static String hint(String needle) {
        List<String> names = constants();
        if (names.isEmpty()) {
            return "ItemList 不可用";
        }
        String key = normalize(needle);
        List<String> hits = new ArrayList<String>();
        if (!key.isEmpty()) {
            for (String n : names) {
                if (normalize(n).contains(key)) {
                    hits.add(n);
                    if (hits.size() >= MAX_SUGGESTIONS) {
                        break;
                    }
                }
            }
            if (hits.isEmpty()) {
                for (String n : names) {
                    if (n.toLowerCase(Locale.ROOT)
                        .contains(key.toLowerCase(Locale.ROOT))) {
                        hits.add(n);
                        if (hits.size() >= MAX_SUGGESTIONS) {
                            break;
                        }
                    }
                }
            }
        }
        if (hits.isEmpty()) {
            // 仍然给一组「最常见的入口」，免得错误信息只有「没有」两个字
            for (String n : names) {
                if (n.startsWith("Machine_") || n.startsWith("Battery_") || n.startsWith("Energy_")) {
                    hits.add(n);
                    if (hits.size() >= MAX_SUGGESTIONS) {
                        break;
                    }
                }
            }
        }
        return hits.isEmpty() ? "可用常量请查 GT 源码 gregtech/api/enums/ItemList.java" : "相近名: " + hits;
    }

    // ------------------------------------------------------------ 内部

    /** 枚举常量对象；找不到（或 GT 缺席）返回 null。 */
    private static Object constant(String name) {
        Class<?> cls = ModReflect.cls(ITEM_LIST_CLASS);
        if (cls == null || name == null) {
            return null;
        }
        Object[] all = cls.getEnumConstants();
        if (all == null) {
            return null;
        }
        for (Object o : all) {
            if (o instanceof Enum && ((Enum<?>) o).name()
                .equals(name)) {
                return o;
            }
        }
        return null;
    }

    /** 全部常量名（GT 缺席时返回空表）。 */
    private static List<String> constants() {
        List<String> out = new ArrayList<String>();
        Class<?> cls = ModReflect.cls(ITEM_LIST_CLASS);
        if (cls == null) {
            return out;
        }
        Object[] all = cls.getEnumConstants();
        if (all == null) {
            return out;
        }
        for (Object o : all) {
            if (o instanceof Enum) {
                out.add(((Enum<?>) o).name());
            }
        }
        return out;
    }

    /**
     * 调 {@code ItemList.get(long, Object...)}。
     *
     * <p>
     * 不走 {@link ModReflect#call}：它会吞掉异常，而「GT 自己的取物路径抛错」必须原样带出去
     * （失败显式）。变参方法在反射里就是 {@code (long, Object[])} 两个形参。
     */
    private static ItemStack invokeGet(Object constant, String name, long amount) {
        Method m = ModReflect.method(constant.getClass(), "get", long.class, Object[].class);
        if (m == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "找不到 ItemList.get(long, Object...) —— GT 版本不符（常量 " + name + "）");
        }
        try {
            Object r = m.invoke(constant, Long.valueOf(Math.max(1L, amount)), new Object[0]);
            return r instanceof ItemStack ? (ItemStack) r : null;
        } catch (Throwable t) {
            Throwable real = ModReflect.unwrap(t);
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "ItemList." + name + ".get(...) 抛出: " + ModReflect.describe(real),
                Json.object("constant", name),
                real);
        }
    }

    /** 去掉下划线并大写，用于「长得像」匹配。 */
    private static String normalize(String s) {
        return s == null ? ""
            : s.replace("_", "")
                .toUpperCase(Locale.ROOT);
    }
}
