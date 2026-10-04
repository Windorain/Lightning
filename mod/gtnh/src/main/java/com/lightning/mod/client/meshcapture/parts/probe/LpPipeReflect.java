package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.item.Item;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * Gitea issue #12 验证回路的 LogisticsPipes 反射半环。
 *
 * <p>
 * LP 在本树只是 {@code runtimeOnlyNonPublishable} 依赖（{@code compileClasspath} 不含 LP），因此这里
 * <strong>一律反射</strong>触达：{@code Class.forName("logisticspipes...")} + {@code getField/getMethod}，
 * 绝不出现 LP 的编译期类型引用（import 会直接编译失败）。
 *
 * <p>
 * 覆盖两件事：
 * <ol>
 * <li><strong>真实放置</strong>：{@code LogisticsBlockGenericPipe.pipes}（Item → pipe 类映射，LP 自己
 * {@code registerPipe} 注册的权威表）里挑管道物品 → {@code LogisticsBlockGenericPipe.createPipe(item)} →
 * {@code world.setBlock(管道方块)} → {@code LogisticsTileGenericPipe.initialize(pipe)} +
 * {@code sendUpdateToClient()}（这三步就是 LP 的 {@code placePipe} 实现，见
 * {@code state/lp-jar/LBGP.txt:2271-2313}）；</li>
 * <li><strong>运行时状态读取</strong>：{@code LogisticsTileGenericPipe.pipe}、
 * {@code CoreUnroutedPipe.container}（旧版 LP 亦名 {@code CoreRoutedPipe.container}，故沿继承链回退查找）、
 * pipe 实例类名 —— 这就是 issue #12 的破坏判据（{@code container == null} ⇒ 渲染 NPE）。</li>
 * </ol>
 */
@SideOnly(Side.CLIENT)
final class LpPipeReflect {

    static final String LP_TILE_CLASS = "logisticspipes.pipes.basic.LogisticsTileGenericPipe";
    static final String LP_BLOCK_CLASS = "logisticspipes.pipes.basic.LogisticsBlockGenericPipe";
    static final String LP_SERVICE_LOCATOR_CLASS = "logisticspipes.proxy.SimpleServiceLocator";

    private LpPipeReflect() {}

    // ------------------------------------------------------------------ 可用性

    /** LP 类是否在运行时 classpath 上（编译期必然不在，故只能反射判定）。 */
    static Class<?> lpClass(String name) {
        try {
            return Class.forName(name, false, LpPipeReflect.class.getClassLoader());
        } catch (Throwable t) {
            return null;
        }
    }

    // ------------------------------------------------------------------ 放置

    /** 一条候选管道物品（Item + 其 pipe 实现类名），用于触发文件按名字挑选。 */
    static final class PipeItem {

        final Item item;
        final String registryName;
        final String pipeClassName;

        PipeItem(Item item, String registryName, String pipeClassName) {
            this.item = item;
            this.registryName = registryName;
            this.pipeClassName = pipeClassName;
        }

        JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("registry", registryName);
            o.addProperty("pipeClass", pipeClassName);
            return o;
        }
    }

    /**
     * 枚举 LP 已注册的管道物品（{@code LogisticsBlockGenericPipe.pipes} 的 keySet）。
     *
     * @throws IllegalStateException LP 不在 classpath，或映射表为空/不可读
     */
    @SuppressWarnings("unchecked")
    static List<PipeItem> listPipeItems() {
        Class<?> blockClass = lpClass(LP_BLOCK_CLASS);
        if (blockClass == null) {
            throw new IllegalStateException("运行时 classpath 上没有 " + LP_BLOCK_CLASS + "（LP 未被加载）");
        }
        List<PipeItem> out = new ArrayList<PipeItem>();
        try {
            Map<Item, Class<?>> pipes = (Map<Item, Class<?>>) blockClass.getField("pipes")
                .get(null);
            if (pipes == null) {
                throw new IllegalStateException("LogisticsBlockGenericPipe.pipes == null");
            }
            for (Map.Entry<Item, Class<?>> e : pipes.entrySet()) {
                Item item = e.getKey();
                if (item == null) {
                    continue;
                }
                String reg = String.valueOf(Item.itemRegistry.getNameForObject(item));
                String cls = e.getValue() == null ? "<null>"
                    : e.getValue()
                        .getName();
                out.add(new PipeItem(item, reg, cls));
            }
        } catch (IllegalStateException e) {
            throw e;
        } catch (Throwable t) {
            throw new IllegalStateException("读取 LogisticsBlockGenericPipe.pipes 失败: " + PartsProbeReflect.describe(t));
        }
        if (out.isEmpty()) {
            throw new IllegalStateException("LogisticsBlockGenericPipe.pipes 为空（LP 未完成注册？）");
        }
        return out;
    }

    /**
     * 按「类名关键字包含」挑一个管道物品；{@code keywords} 依序尝试（第一个命中的关键字胜出），
     * 关键字内部多个候选时取第一个。挑不到时返回 {@code null}（调用方落盘候选清单，不静默替换）。
     */
    static PipeItem pickPipeItem(List<PipeItem> items, String... keywords) {
        for (String kw : keywords) {
            for (PipeItem it : items) {
                if (it.pipeClassName.contains(kw)) {
                    return it;
                }
            }
        }
        return null;
    }

    /**
     * LP 的真实放置路径（等价于 {@code LogisticsBlockGenericPipe.placePipe}，见侦察报告 §5.4/issue #12
     * 判据）：{@code createPipe(item)} → {@code setBlock} → 取 TE → {@code initialize(pipe)} →
     * {@code sendUpdateToClient()}。
     *
     * @return 放置后的 {@link LogisticsTileGenericPipe} 实例（已 {@code initialize}）
     * @throws IllegalStateException 任一步失败（调用方落盘错误，不静默）
     */
    static TileEntity placePipe(World world, Item item, int x, int y, int z) {
        Class<?> blockClass = lpClass(LP_BLOCK_CLASS);
        if (blockClass == null) {
            throw new IllegalStateException("缺少 " + LP_BLOCK_CLASS);
        }
        try {
            Object pipe = blockClass.getMethod("createPipe", Item.class)
                .invoke(null, item);
            if (pipe == null) {
                throw new IllegalStateException("createPipe 返回 null: " + item);
            }
            Object blockObj = resolvePipeBlock();
            if (!(blockObj instanceof net.minecraft.block.Block)) {
                throw new IllegalStateException("未能解析 LP 管道方块实例（LogisticsPipes 的静态方块字段）");
            }
            net.minecraft.block.Block block = (net.minecraft.block.Block) blockObj;
            world.setBlock(x, y, z, block, 0, 3);
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null) {
                throw new IllegalStateException(
                    "setBlock 后该格没有 TE（方块类 " + block.getClass()
                        .getName() + "）");
            }
            if (!LP_TILE_CLASS.equals(
                te.getClass()
                    .getName())) {
                throw new IllegalStateException(
                    "该格 TE 不是 " + LP_TILE_CLASS
                        + "，实际 "
                        + te.getClass()
                            .getName());
            }
            Method init = findAssignableMethod(te.getClass(), "initialize", pipe.getClass());
            if (init == null) {
                throw new IllegalStateException(
                    "找不到 LogisticsTileGenericPipe.initialize(" + pipe.getClass()
                        .getName() + ") 的可用重载");
            }
            init.invoke(te, pipe);
            te.getClass()
                .getMethod("sendUpdateToClient")
                .invoke(te);
            world.markBlockForUpdate(x, y, z);
            return te;
        } catch (IllegalStateException e) {
            throw e;
        } catch (Throwable t) {
            throw new IllegalStateException(
                "LP 放置路径失败 @" + x + "," + y + "," + z + ": " + PartsProbeReflect.describe(t));
        }
    }

    /**
     * 解析 LP 管道方块实例：LP 把它放在 {@code logisticspipes.LogisticsPipes} 的静态字段上
     * （实测 1.5.28 是 {@code LogisticsPipes.LogisticsPipeBlock}，不是 {@code LogisticsBlockGenericPipe}
     * 自己的字段），字段名各版本可能不同，故按<strong>类型</strong>扫描 LP 门面类的静态字段。
     */
    static Object resolvePipeBlock() {
        Class<?> facade = lpClass("logisticspipes.LogisticsPipes");
        Class<?> blockClass = lpClass(LP_BLOCK_CLASS);
        if (facade == null || blockClass == null) {
            return null;
        }
        for (Field f : facade.getFields()) {
            if (!net.minecraft.block.Block.class.isAssignableFrom(f.getType())) {
                continue;
            }
            if (!blockClass.isAssignableFrom(f.getType())) {
                continue;
            }
            try {
                Object v = f.get(null);
                if (v instanceof net.minecraft.block.Block) {
                    return v;
                }
            } catch (Throwable ignored) {
                // 试下一个字段
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ 运行时状态

    /** {@code LogisticsTileGenericPipe.pipe}（沿继承链回退查找，兼容不同版本字段名位置）。 */
    static Object pipeOf(TileEntity te) {
        return readField(te, "pipe");
    }

    /** {@code CoreUnroutedPipe.container}（老版 LP 在 {@code CoreRoutedPipe} 上，故沿继承链回退）。 */
    static Object containerOf(Object pipe) {
        return pipe == null ? null : readField(pipe, "container");
    }

    /** 沿类继承链找 public/declared 字段（含 {@code setAccessible} 兜底）。 */
    static Object readField(Object target, String name) {
        if (target == null) {
            return null;
        }
        Class<?> c = target.getClass();
        while (c != null && c != Object.class) {
            try {
                Field f = c.getDeclaredField(name);
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

    /**
     * 找形如 {@code name(<单个参数>) } 且该参数类型可从 {@code argClass} 赋值的 public 方法。
     * <p>
     * 用例：{@code LogisticsTileGenericPipe.initialize(CoreUnroutedPipe)} —— {@code CoreUnroutedPipe}
     * 类型只在运行期存在，编译期无法写出该 {@code Class} 字面量，故按实际 pipe 实例的类向上找可赋值参数。
     */
    static Method findAssignableMethod(Class<?> owner, String name, Class<?> argClass) {
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

    /** 该 TE 是否就是 LP 管道 TE。 */
    static boolean isLpTile(TileEntity te) {
        return te != null && LP_TILE_CLASS.equals(
            te.getClass()
                .getName());
    }

    /**
     * 目标 LP TE 的运行时状态快照（issue #12 判据）：类名 + pipe 身份 + {@code container} 是否非 null。
     * <p>
     * 只读，不触碰任何方块/TE 字段（快照本身不得成为污染源）。
     */
    static JsonObject stateOf(TileEntity te) {
        JsonObject o = new JsonObject();
        o.addProperty(
            "teClass",
            te == null ? "<null>"
                : te.getClass()
                    .getName());
        Object pipe = pipeOf(te);
        o.addProperty(
            "pipeClass",
            pipe == null ? "<null>"
                : pipe.getClass()
                    .getName());
        o.addProperty("pipeNonNull", Boolean.valueOf(pipe != null));
        Object container = containerOf(pipe);
        o.addProperty("containerNonNull", Boolean.valueOf(container != null));
        o.addProperty(
            "containerClass",
            container == null ? "<null>"
                : container.getClass()
                    .getName());
        // renderer 存在性是「该格真的会走 TESR 渲染 ⇒ 缺陷可达」的前提证据，不是断言本体
        o.addProperty("tesrRegistered", Boolean.valueOf(hasSpecialRenderer(te)));
        return o;
    }

    /** {@code TileEntityRendererDispatcher.instance.hasSpecialRenderer(te)}（客户端渲染线程安全：仅查表）。 */
    static boolean hasSpecialRenderer(TileEntity te) {
        if (te == null) {
            return false;
        }
        try {
            Object disp = net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.instance;
            Object r = disp.getClass()
                .getMethod("hasSpecialRenderer", TileEntity.class)
                .invoke(disp, te);
            return Boolean.TRUE.equals(r);
        } catch (Throwable t) {
            return false;
        }
    }

    /** {@code CoreUnroutedPipe.getPipeClass()} 的类名（落盘用；失败给 {@code <unknown>}）。 */
    static String pipeClassOfPipe(Object pipe) {
        if (pipe == null) {
            return "<null>";
        }
        try {
            Object c = pipe.getClass()
                .getMethod("getPipeClass")
                .invoke(pipe);
            return c == null ? "<null>" : String.valueOf(c);
        } catch (Throwable t) {
            return pipe.getClass()
                .getName();
        }
    }

    /**
     * 运行期 LP 版本：{@code logisticspipes.LPConstants} 里第一个名字含 VERSION 的静态字符串常量。
     * <p>
     * 不硬编码字段名 —— issue body 记录的是 {@code 1.5.26-GTNH}，本树依赖是 {@code 1.5.28-GTNH}，
     * 版本常量的名字/位置在不同版本可能不同，探针只求「能落盘一个可核对的值」。
     */
    static String lpVersion() {
        Class<?> c = lpClass("logisticspipes.LPConstants");
        if (c == null) {
            c = lpClass("logisticspipes.LogisticsPipes");
        }
        if (c == null) {
            return "<lp-absent>";
        }
        for (String name : new String[] { "LP_VERSION", "VERSION", "version" }) {
            for (String owner : new String[] { "logisticspipes.LPConstants", "logisticspipes.LogisticsPipes" }) {
                Class<?> oc = lpClass(owner);
                if (oc == null) {
                    continue;
                }
                try {
                    Object v = oc.getField(name)
                        .get(null);
                    if (v != null) {
                        return String.valueOf(v);
                    }
                } catch (Throwable ignored) {
                    // 试下一个
                }
            }
        }
        // 兜底：扫静态 String 字段名含 VERSION 的
        for (Field f : c.getFields()) {
            if (f.getType() != String.class || !f.getName()
                .toUpperCase(Locale.ROOT)
                .contains("VERSION")) {
                continue;
            }
            try {
                Object v = f.get(null);
                if (v != null) {
                    return String.valueOf(v);
                }
            } catch (Throwable ignored) {
                // 继续扫
            }
        }
        return "<unknown>";
    }

    static JsonArray itemsToJson(List<PipeItem> items) {
        JsonArray a = new JsonArray();
        for (PipeItem it : items) {
            a.add(it.toJson());
        }
        return a;
    }

    static JsonPrimitive s(String v) {
        return new JsonPrimitive(v);
    }
}
