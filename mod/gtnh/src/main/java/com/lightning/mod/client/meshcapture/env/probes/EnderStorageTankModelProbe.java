package com.lightning.mod.client.meshcapture.env.probes;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;
import com.lightning.mod.client.meshcapture.env.ModelAccessPresence;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 事实：末影储罐渲染器手里那份模型数据能不能被只读反射取到（PRESENT/ABSENT/UNKNOWN）。
 * <p>
 * 为什么需要这条事实：储罐的罐体/阀门/按钮在渲染器里是<strong>已经算好的 Java 顶点数组</strong>，绘制时只把它们编进
 * 显示列表，顶点根本不经过 {@code Tessellator}——通用 TESR 通道因此录不到它们，需要一条针对性策略把同一份顶点写进
 * 捕获窗口。而"这份数据能不能按名字取到"取决于运行期模组与基础库的字段布局，猜不得：取不到时策略必须整条不参与，
 * 让该格照常走零产出裁决与兜底。
 * <p>
 * 探针只回答可得性，<strong>不读字段值</strong>：读值会触发目标类静态初始化（即在没有资源管理器的环境里加载模型
 * 文件），也会把"探事实"变成"做渲染准备"。真正的取数发生在策略里，且只在 {@link ModelAccessPresence#PRESENT} 时发生。
 * <p>
 * 核对的是策略要用的<strong>全部</strong>访问面：渲染器上的三份模型字段（静态、类型是模型类或其数组）、模型类的
 * {@code verts}（顶点数组）与 {@code vertexMode}（int）、顶点类的 {@code vec}（x/y/z 三个 double）与 {@code uv}
 * （u/v 两个 double）。少核对一项，策略就会在渲染线程上撞空指针，而不是在这里安静地降级。
 */
@SideOnly(Side.CLIENT)
public final class EnderStorageTankModelProbe implements CaptureEnvironmentProbe {

    /** 排在既有五条自证/标签事实与箱子缓存开关（650）之后：只读、无副作用，先后不影响结果。 */
    public static final int DEFAULT_PRIORITY = 700;

    /** 储罐渲染器（三份模型的持有者）。 */
    public static final String RENDERER_CLASS = "codechicken.enderstorage.storage.liquid.EnderTankRenderer";

    /** 模型类型：顶点数组 + 顶点模式。 */
    public static final String MODEL_CLASS = "codechicken.lib.render.CCModel";

    /** 顶点类型：坐标与 UV。 */
    public static final String VERTEX_CLASS = "codechicken.lib.render.Vertex5";

    /** 渲染器上的三份模型字段名；{@code buttons} 是模型数组。 */
    public static final String[] MODEL_FIELDS = { "tankModel", "valveModel", "buttons" };

    private static final String NOTE_PREFIX = "enderstorage_tank_model: ";

    private final String rendererClassName;
    private final String modelClassName;
    private final String vertexClassName;
    private final ClassLoader loader;

    public EnderStorageTankModelProbe() {
        this(RENDERER_CLASS, MODEL_CLASS, VERTEX_CLASS, EnderStorageTankModelProbe.class.getClassLoader());
    }

    /** 单测用：换目标名与类加载器（生产路径只用无参构造）。 */
    EnderStorageTankModelProbe(String rendererClassName, String modelClassName, String vertexClassName,
        ClassLoader loader) {
        this.rendererClassName = rendererClassName;
        this.modelClassName = modelClassName;
        this.vertexClassName = vertexClassName;
        this.loader = loader != null ? loader : EnderStorageTankModelProbe.class.getClassLoader();
    }

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(CaptureProbeContext ctx) {
        return ctx != null;
    }

    @Override
    public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
        out.setTankModelAccess(inspect(out));
    }

    private ModelAccessPresence inspect(CaptureEnvironmentFacts out) {
        Class<?> rendererClass;
        Class<?> modelClass;
        Class<?> vertexClass;
        try {
            // initialize=false：只要字段签名，不跑目标类的静态初始化（那会加载模型文件）
            rendererClass = load(rendererClassName);
            modelClass = load(modelClassName);
            vertexClass = load(vertexClassName);
        } catch (ClassNotFoundException e) {
            note(out, "absent (" + e.getMessage() + ")");
            return ModelAccessPresence.ABSENT;
        } catch (Throwable t) {
            note(out, "unreadable (" + t + ")");
            return ModelAccessPresence.UNKNOWN;
        }
        try {
            checkAccessSurface(rendererClass, modelClass, vertexClass);
        } catch (NoSuchFieldException e) {
            note(out, "signature unusable (" + e.getMessage() + ")");
            return ModelAccessPresence.ABSENT;
        } catch (Throwable t) {
            note(out, "unreadable (" + t + ")");
            return ModelAccessPresence.UNKNOWN;
        }
        note(out, "present");
        return ModelAccessPresence.PRESENT;
    }

    private Class<?> load(String className) throws ClassNotFoundException {
        return Class.forName(className, false, loader);
    }

    /**
     * 核对策略真正会用到的每一处访问面；任何一处不符都抛 {@link NoSuchFieldException}（消息即缺口），
     * 由调用方统一降级成 {@link ModelAccessPresence#ABSENT}。
     */
    private static void checkAccessSurface(Class<?> rendererClass, Class<?> modelClass, Class<?> vertexClass)
        throws NoSuchFieldException {
        for (String name : MODEL_FIELDS) {
            Field field = rendererClass.getDeclaredField(name);
            if (!Modifier.isStatic(field.getModifiers())) {
                throw new NoSuchFieldException(name + " is not static");
            }
            Class<?> type = field.getType();
            boolean usable = type == modelClass || (type.isArray() && type.getComponentType() == modelClass);
            if (!usable) {
                throw new NoSuchFieldException(name + " has type " + type.getName());
            }
        }
        Field verts = modelClass.getField("verts");
        if (!verts.getType()
            .isArray()
            || verts.getType()
                .getComponentType() != vertexClass) {
            throw new NoSuchFieldException(
                "verts has type " + verts.getType()
                    .getName());
        }
        Field vertexMode = modelClass.getField("vertexMode");
        if (vertexMode.getType() != int.class) {
            throw new NoSuchFieldException(
                "vertexMode has type " + vertexMode.getType()
                    .getName());
        }
        requireDoubleFields(
            vertexClass.getField("vec")
                .getType(),
            "vec",
            new String[] { "x", "y", "z" });
        requireDoubleFields(
            vertexClass.getField("uv")
                .getType(),
            "uv",
            new String[] { "u", "v" });
    }

    /** 坐标/UV 载体：按名字取到的 public double 字段（只核签名，不读值）。 */
    private static void requireDoubleFields(Class<?> type, String ownerPath, String[] names)
        throws NoSuchFieldException {
        for (String name : names) {
            Field field = type.getField(name);
            if (field.getType() != double.class) {
                throw new NoSuchFieldException(
                    ownerPath + "."
                        + name
                        + " has type "
                        + field.getType()
                            .getName());
            }
        }
    }

    private static void note(CaptureEnvironmentFacts out, String line) {
        if (out != null) {
            out.note(NOTE_PREFIX + line);
        }
    }
}
