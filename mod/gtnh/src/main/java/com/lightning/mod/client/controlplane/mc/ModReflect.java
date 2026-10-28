package com.lightning.mod.client.controlplane.mc;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * 模组族（LP / AE2）的反射触达工具：控制面的 LP/AE2 补全器与描述器一律经本类访问模组类型。
 *
 * <h2>为什么全反射</h2>
 * <ol>
 * <li><b>LP</b> 在本树只是 {@code runtimeOnlyNonPublishable} 依赖（{@code compileClasspath} 不含 LP，
 * 见 {@code dependencies.gradle}）——写 {@code import logisticspipes...} 直接编译失败；</li>
 * <li><b>AE2</b> 虽然对 GT5U 继承链有 {@code compileOnly} 依赖，但整合包里可以没有 AE2：硬 import 会在
 * 类加载期抛 {@link NoClassDefFoundError}，连「注册动作本身」都炸。既有部件探针
 * （{@code meshcapture.parts.probe.Ae2PartProbe}，已删除）同样一律反射，本类沿用该口径。</li>
 * </ol>
 *
 * <p>
 * 因此「缺席」是<b>正常状态</b>而非异常：{@link #isPresent} 为假时调用方（{@link ModTeFamilies}）
 * 跳过注册并打 WARN，契约里查不到该族补全器时报 {@code CP-VALID-002} 并附缺席原因。
 *
 * <p>
 * 每个方法都吞掉反射异常并返回 null/默认值——探不到就说探不到，不制造半可用状态。
 */
public final class ModReflect {

    private ModReflect() {}

    /**
     * 加载类（不初始化：{@code initialize=false}，避免触发静态块的副作用）。
     *
     * @return 类对象；不在运行期 classpath 上时返回 null
     */
    public static Class<?> cls(String name) {
        try {
            return Class.forName(name, false, ModReflect.class.getClassLoader());
        } catch (Throwable t) {
            return null;
        }
    }

    /** 类是否在运行期 classpath 上。 */
    public static boolean isPresent(String name) {
        return cls(name) != null;
    }

    /** 全部候选类都在场才为真（用于「这一族可用吗」的整体判定）。 */
    public static boolean allPresent(String... names) {
        for (String n : names) {
            if (!isPresent(n)) {
                return false;
            }
        }
        return true;
    }

    /**
     * 触达并加载一个类：{@code initialize=true}。
     *
     * <p>
     * 与 {@link #cls} 的区别是它会跑静态初始化——LP 的 {@code LogisticsBlockGenericPipe.pipes}
     * 映射、AE2 的 {@code AEApi} 单例都在静态块/预初始化里就位，读这些字段前必须先真正加载类。
     *
     * @return 类对象；加载失败（含静态块抛错）时返回 null
     */
    public static Class<?> load(String name) {
        try {
            return Class.forName(name, true, ModReflect.class.getClassLoader());
        } catch (Throwable t) {
            return null;
        }
    }

    /** 类名：null 安全（{@code <null>} 占位）。 */
    public static String nameOf(Object o) {
        return o == null ? "<null>"
            : o.getClass()
                .getName();
    }

    /**
     * 物品的注册名（{@code modid:name}）——1.7.10 的权威物品注册表是 {@code Item.itemRegistry}。
     *
     * <p>
     * LP/AE2 的补全器与描述器都用它做「输出里的物品身份」，异常一律吞掉并返回 null：
     * 注册名取不到时调用方给 {@code null} 字段（描述器契约：缺席用显式 null），不抛异常。
     */
    public static String itemId(net.minecraft.item.Item item) {
        if (item == null) {
            return null;
        }
        Object name;
        try {
            name = net.minecraft.item.Item.itemRegistry.getNameForObject(item);
        } catch (Throwable t) {
            return null;
        }
        String s = name == null ? null : String.valueOf(name);
        return s == null || s.isEmpty() || "null".equals(s) ? null : s;
    }

    /** 物品栈的注册名（meta 非 0 时补 {@code @meta}）；不可解析回落到类名。 */
    public static String itemId(net.minecraft.item.ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return null;
        }
        String base = itemId(stack.getItem());
        if (base == null) {
            base = stack.getItem()
                .getClass()
                .getName();
        }
        return stack.getItemDamage() == 0 ? base : base + "@" + stack.getItemDamage();
    }

    /** 取静态字段（沿继承链回退；含 {@code setAccessible} 兜底）。 */
    public static Object staticField(String className, String field) {
        Class<?> c = load(className);
        return c == null ? null : readField(c, null, field);
    }

    /** 取实例字段（沿继承链回退；含 {@code setAccessible} 兜底）。 */
    public static Object field(Object target, String field) {
        return target == null ? null : readField(target.getClass(), target, field);
    }

    /**
     * 找形如 {@code name(arg0, rest...)} 的方法：第 0 个参数类型可从 {@code arg0} 赋值，
     * 其余参数类型与 {@code restTypes} 精确相等，参数个数也一样。
     *
     * <p>
     * 用例：LP 的 {@code LogisticsBlockGenericPipe.placePipe(CoreUnroutedPipe, World, int, int, int, Block, int)}
     * —— 第 0 个参数类型 {@code CoreUnroutedPipe} 编译期写不出来，只能按实际 pipe 实例的类向上找。
     */
    public static Method methodAssignableFirst(Class<?> owner, String name, Class<?> arg0, Class<?>... restTypes) {
        if (owner == null || arg0 == null) {
            return null;
        }
        for (Method m : owner.getMethods()) {
            if (!m.getName()
                .equals(name)) {
                continue;
            }
            Class<?>[] ps = m.getParameterTypes();
            if (ps.length != restTypes.length + 1) {
                continue;
            }
            if (!ps[0].isAssignableFrom(arg0)) {
                continue;
            }
            boolean rest = true;
            for (int i = 0; i < restTypes.length; i++) {
                if (ps[i + 1] != restTypes[i]) {
                    rest = false;
                    break;
                }
            }
            if (rest) {
                return m;
            }
        }
        return null;
    }

    /** 按参数类型取方法（沿继承链回退）。 */
    public static Method method(Class<?> owner, String name, Class<?>... paramTypes) {
        if (owner == null) {
            return null;
        }
        Class<?> c = owner;
        while (c != null && c != Object.class) {
            try {
                return c.getMethod(name, paramTypes);
            } catch (NoSuchMethodException e) {
                c = c.getSuperclass();
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    /**
     * 找形如 {@code name(单参数)} 且该参数类型可从 {@code argClass} 赋值的方法。
     *
     * <p>
     * 用例：LP 的 {@code LogisticsTileGenericPipe.initialize(CoreUnroutedPipe)} ——
     * {@code CoreUnroutedPipe} 只在运行期存在，编译期写不出该 {@code Class} 字面量，
     * 故按实际实例的类向上找可赋值参数。
     */
    public static Method assignableMethod(Class<?> owner, String name, Class<?> argClass) {
        if (owner == null || argClass == null) {
            return null;
        }
        for (Method m : owner.getMethods()) {
            if (!m.getName()
                .equals(name)) {
                continue;
            }
            Class<?>[] ps = m.getParameterTypes();
            if (ps.length == 1 && ps[0].isAssignableFrom(argClass)) {
                return m;
            }
        }
        return null;
    }

    /** 调用无参实例方法；失败返回 null。 */
    public static Object call(Object target, String name) {
        return call(target, name, new Class<?>[0]);
    }

    /** 调用实例方法（{@code paramTypes} 精确定位）；失败返回 null。 */
    public static Object call(Object target, String name, Class<?>[] paramTypes, Object... args) {
        if (target == null) {
            return null;
        }
        Method m = method(target.getClass(), name, paramTypes);
        if (m == null) {
            return null;
        }
        try {
            return m.invoke(target, args);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 调用静态方法；失败返回 null。 */
    public static Object callStatic(Class<?> owner, String name, Class<?>[] paramTypes, Object... args) {
        Method m = method(owner, name, paramTypes);
        if (m == null) {
            return null;
        }
        try {
            return m.invoke(null, args);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 异常的单行摘要（{@code 类名: message}；反射失败时常见 {@code InvocationTargetException} 已剥壳）。 */
    public static String describe(Throwable t) {
        if (t == null) {
            return "null";
        }
        Throwable cause = t.getCause() == null ? t : t.getCause();
        return cause.getClass()
            .getName() + ": "
            + cause.getMessage();
    }

    /** 剥掉反射包装异常，便于把模组自身的报错原样带出去。 */
    public static Throwable unwrap(Throwable t) {
        Throwable cur = t;
        while (cur instanceof java.lang.reflect.InvocationTargetException && cur.getCause() != null) {
            cur = cur.getCause();
        }
        return cur;
    }

    private static Object readField(Class<?> start, Object target, String field) {
        Class<?> c = start;
        while (c != null && c != Object.class) {
            try {
                Field f = c.getDeclaredField(field);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException e) {
                c = c.getSuperclass();
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }
}
