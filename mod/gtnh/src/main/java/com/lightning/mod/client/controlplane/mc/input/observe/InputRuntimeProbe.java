package com.lightning.mod.client.controlplane.mc.input.observe;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.ScaledResolution;
import net.minecraft.client.settings.GameSettings;
import net.minecraft.client.settings.KeyBinding;

import cpw.mods.fml.common.Loader;
import cpw.mods.fml.common.ModContainer;

/**
 * 客户端 tick 线程的<b>只读</b>探针（Gitea #162 §9.3：T2-B 拥有的只读探针）。
 *
 * <p>
 * 本类是 {@link InputStateProviderImpl.TickProbe} 的生产实现：把 MC/LWJGL 的真实读数收进一份
 * {@link TickObservation}。它<b>只读</b>——不调任何写入口（§1.2 的白名单一条都不用），
 * 也不调 {@code Mouse.setCursorPosition}/{@code setGrabbed} 一类禁用 API。
 *
 * <h2>为什么用 {@code Class.forName} 而不是直接 {@code import org.lwjglx.input.*}</h2>
 * 契约 §1.2：lwjgl3ify 的 {@code -api} 制品<b>不含</b> {@code org/lwjglx/**}（只在运行期 {@code -dev} jar 里），
 * 而 RFB 重映射把源码里的 {@code org.lwjgl.input.*} <b>改类名不改方法名</b>。因此：
 * <ul>
 * <li>{@code import org.lwjgl.input.Keyboard;} 这类<b>静态引用</b>在运行期会被重映射到
 * {@code org.lwjglx.input.Keyboard}（这是 MC 自身也用的路径），编译器能编译；</li>
 * <li>{@code Class.forName("org.lwjglx.input.Keyboard")} 这类<b>字符串字面量不被重映射</b>，
 * 因此可以按名解析出运行期真身。两条路都试，取解析得到的那个。</li>
 * </ul>
 *
 * <h2>读不到就报读不到</h2>
 * 任一反射调用失败都<b>不</b>抛给调用方，而是把该项落成 {@link TickObservation#UNREADABLE}
 * 或 {@code null}，并追加一条 {@code warnings}。组装侧据此把字段落成 {@code null}/未实现说明
 * （§11.2 第 17 条：不许用默认值伪装成「已具备」）。
 */
public final class InputRuntimeProbe implements InputStateProviderImpl.TickProbe {

    /** 候选类名（先运行期真身 lwjgl3ify，再 RFB 重映射后的名字）。 */
    private static final String[] KEYBOARD_CLASSES = { "org.lwjglx.input.Keyboard", "org.lwjgl.input.Keyboard" };

    /** 鼠标类候选名（见 {@link #KEYBOARD_CLASSES}）。 */
    private static final String[] MOUSE_CLASSES = { "org.lwjglx.input.Mouse", "org.lwjgl.input.Mouse" };

    /** 显示类候选名（lwjgl3ify 的 Display 亦在 {@code org.lwjglx.display}）。 */
    private static final String[] DISPLAY_CLASSES = { "org.lwjglx.display.Display", "org.lwjgl.display.Display",
        "org.lwjgl.opengl.Display" };

    /** 输入后端标识（契约 §1.1：本运行期是 SDL，不是 GLFW）。 */
    public static final String BACKEND_SDL = "sdl";

    private final Minecraft mc;

    /** 解析出的运行期类（null = 不可用）。 */
    private final Class<?> keyboardClass;

    /** 解析出的鼠标类。 */
    private final Class<?> mouseClass;

    /** 解析出的显示类。 */
    private final Class<?> displayClass;

    public InputRuntimeProbe(Minecraft mc) {
        this.mc = mc;
        this.keyboardClass = resolve(KEYBOARD_CLASSES);
        this.mouseClass = resolve(MOUSE_CLASSES);
        this.displayClass = resolve(DISPLAY_CLASSES);
    }

    /** 按候选名解析类（不缓存到静态字段之外；失败返回 null）。 */
    private static Class<?> resolve(String[] names) {
        for (String name : names) {
            try {
                return Class.forName(name, false, InputRuntimeProbe.class.getClassLoader());
            } catch (Throwable t) {
                // 试下一个候选；两个都失败时返回 null（调用方据此报 unobservable）
            }
        }
        return null;
    }

    @Override
    public TickObservation probe() {
        TickObservation.Builder b = TickObservation.builder()
            .threadName(
                Thread.currentThread()
                    .getName())
            .atNanos(System.nanoTime());
        readRuntime(b);
        InputScaleContext context = readContext(b);
        b.context(context);
        readKeyboardQueue(b);
        readMouse(b, context);
        readScreen(b);
        readFocus(b);
        readKeyCatalog(b);
        // 字符路由：P0 实测两条都没到达（§11.2 第 4/5 条）⇒ 如实声明 false，并留「未验证」标记
        b.textRoute(Boolean.FALSE, Boolean.FALSE);
        return b.build();
    }

    // ------------------------------------------------------------ 运行期标识

    /** 版本与注入入口实读（{@code injectors} 按 §1.2 的五个白名单逐个探测）。 */
    private void readRuntime(TickObservation.Builder b) {
        String mcVersion = null;
        String forge = null;
        String lwjgl3ify = null;
        try {
            mcVersion = Loader.MC_VERSION;
            Loader loader = Loader.instance();
            if (loader != null && loader.getModList() != null) {
                for (ModContainer c : loader.getModList()) {
                    if (c == null || c.getModId() == null) {
                        continue;
                    }
                    String id = c.getModId()
                        .toLowerCase(java.util.Locale.ROOT);
                    if ("forge".equals(id)) {
                        forge = c.getVersion();
                    } else if ("lwjgl3ify".equals(id)) {
                        lwjgl3ify = c.getVersion();
                    }
                }
            }
        } catch (Throwable t) {
            b.warn("读取运行期版本失败: " + t);
        }
        b.runtime(mcVersion, forge, lwjgl3ify, BACKEND_SDL);
        // injectors：只列实读可解析的入口（§1.2 的五项是白名单，不是存在性证据）
        if (keyboardClass != null) {
            if (hasMethod(keyboardClass, "addRawKeyEvent", 1)) {
                b.injector("Keyboard.addRawKeyEvent");
            }
            if (hasMethod(keyboardClass, "addCharEvent", 2)) {
                b.injector("Keyboard.addCharEvent");
            }
        } else {
            b.warn("Keyboard 类不可解析（两个候选名都失败）⇒ 键盘侧队列深度/键码域/字符事件均为 unobservable");
        }
        if (mouseClass != null) {
            if (hasMethod(mouseClass, "addMoveEvent", 1)) {
                b.injector("Mouse.addMoveEvent");
            }
            if (hasMethod(mouseClass, "addButtonEvent", 2)) {
                b.injector("Mouse.addButtonEvent");
            }
            if (hasMethod(mouseClass, "addWheelEvent", 1)) {
                b.injector("Mouse.addWheelEvent");
            }
        } else {
            b.warn("Mouse 类不可解析 ⇒ 鼠标侧坐标回读不可用");
        }
    }

    /** 方法是否存在（按名 + 参数个数；只用于「实读可解析」判定，不用于调用）。 */
    private static boolean hasMethod(Class<?> type, String name, int paramCount) {
        try {
            for (Method m : type.getMethods()) {
                if (m.getName()
                    .equals(name) && m.getParameterTypes().length == paramCount) {
                    return true;
                }
            }
        } catch (Throwable t) {
            return false;
        }
        return false;
    }

    // ------------------------------------------------------------ 坐标上下文

    /** 缩放/显示尺寸/guiScale/窗口尺寸/像素比。 */
    private InputScaleContext readContext(TickObservation.Builder b) {
        int displayWidth = mc == null ? 0 : mc.displayWidth;
        int displayHeight = mc == null ? 0 : mc.displayHeight;
        int guiScale = 0;
        try {
            if (mc != null && mc.gameSettings != null) {
                guiScale = mc.gameSettings.guiScale;
            }
        } catch (Throwable t) {
            b.warn("读取 gameSettings.guiScale 失败: " + t);
        }
        double pixelScale = 1.0d;
        try {
            Method m = displayClass == null ? null : displayClass.getMethod("getPixelScaleFactor");
            Object v = m == null ? null : m.invoke(null);
            if (v instanceof Number) {
                pixelScale = ((Number) v).doubleValue();
            }
        } catch (Throwable t) {
            b.warn("读取 Display.getPixelScaleFactor 失败（pixelScale 落 1.0 兜底）: " + t);
        }
        int windowWidth = 0;
        int windowHeight = 0;
        try {
            Method w = displayClass == null ? null : displayClass.getMethod("getWidth");
            Method h = displayClass == null ? null : displayClass.getMethod("getHeight");
            if (w != null && h != null) {
                Object wv = w.invoke(null);
                Object hv = h.invoke(null);
                if (wv instanceof Number && hv instanceof Number) {
                    windowWidth = ((Number) wv).intValue();
                    windowHeight = ((Number) hv).intValue();
                }
            }
        } catch (Throwable t) {
            b.warn("读取 Display 窗口尺寸失败（windowWidth/Height 落 0）: " + t);
        }
        int scaledWidth = 0;
        int scaledHeight = 0;
        int scaleFactor = 0;
        try {
            if (mc != null && displayWidth > 0 && displayHeight > 0) {
                ScaledResolution sr = new ScaledResolution(mc, displayWidth, displayHeight);
                scaledWidth = sr.getScaledWidth();
                scaledHeight = sr.getScaledHeight();
                scaleFactor = sr.getScaleFactor();
            }
        } catch (Throwable t) {
            b.warn("构造 ScaledResolution 失败: " + t);
        }
        if (scaledWidth <= 0 || scaledHeight <= 0) {
            // ScaledResolution 失败时退回纯算术（同一算法，见 InputCoordinateMath），并留痕
            int[] s = InputCoordinateMath.scaledSize(displayWidth, displayHeight, guiScale);
            scaledWidth = s[0];
            scaledHeight = s[1];
            scaleFactor = s[2];
            b.warn("ScaledResolution 未取到，scaledWidth/Height/scaleFactor 由 InputCoordinateMath 同源算法给出");
        }
        return new InputScaleContext(
            displayWidth,
            displayHeight,
            scaledWidth,
            scaledHeight,
            scaleFactor,
            guiScale,
            pixelScale,
            windowWidth,
            windowHeight);
    }

    // ------------------------------------------------------------ 队列与鼠标

    /**
     * 键盘队列深度与容量（{@code Keyboard.getNumKeyboardEvents()}、{@code Keyboard.eventQueue} 容量）。
     *
     * <p>
     * 深度是<b>含 seed 哨兵</b>的口径（lwjgl3ify {@code Keyboard.next()} 的判据是 {@code size() > 1}），
     * 组装侧会同时给出 {@code keyboardSeedBaseline}。容量优先实读 {@code eventQueue} 字段的
     * {@code size()}（生产实现是 {@code ArrayBlockingQueue(256)}），读不到才落契约常量并标注来源。
     */
    private void readKeyboardQueue(TickObservation.Builder b) {
        if (keyboardClass == null) {
            return;
        }
        try {
            Method m = keyboardClass.getMethod("getNumKeyboardEvents");
            Object v = m.invoke(null);
            if (v instanceof Number) {
                b.keyboardQueueDepth(((Number) v).intValue());
            }
        } catch (Throwable t) {
            b.warn("Keyboard.getNumKeyboardEvents 调用失败: " + t);
        }
        try {
            Field f = keyboardClass.getField("eventQueue");
            Object queue = f.get(null);
            if (queue instanceof java.util.Collection) {
                b.keyboardQueueCapacity(((java.util.Collection<?>) queue).size());
            }
        } catch (Throwable t) {
            b.warn("读取 Keyboard.eventQueue 失败（capacity 落契约常量）: " + t);
        }
        try {
            // 键码域：由 KEY_* 常量实读（契约 §2.2 第 3 条：不得靠猜）
            int min = Integer.MAX_VALUE;
            int max = Integer.MIN_VALUE;
            for (Field f : keyboardClass.getFields()) {
                if (!f.getName()
                    .startsWith("KEY_")) {
                    continue;
                }
                if (f.getType() != int.class) {
                    continue;
                }
                int code = f.getInt(null);
                if (code < min) {
                    min = code;
                }
                if (code > max) {
                    max = code;
                }
            }
            if (min <= max) {
                b.keyCodeRange(min, max);
            }
        } catch (Throwable t) {
            b.warn("实读 Keyboard.KEY_* 常量集失败（keyCodeRange 不写猜值）: " + t);
        }
    }

    /** 鼠标显示坐标与 GUI 缩放回读（{@code Mouse.getX/getY}）。 */
    private void readMouse(TickObservation.Builder b, InputScaleContext ctx) {
        if (mouseClass == null) {
            return;
        }
        int mx = TickObservation.UNREADABLE;
        int my = TickObservation.UNREADABLE;
        try {
            Method gx = mouseClass.getMethod("getX");
            Method gy = mouseClass.getMethod("getY");
            Object vx = gx.invoke(null);
            Object vy = gy.invoke(null);
            if (vx instanceof Number && vy instanceof Number) {
                mx = ((Number) vx).intValue();
                my = ((Number) vy).intValue();
                b.mouse(mx, my);
            }
        } catch (Throwable t) {
            b.warn("Mouse.getX/getY 调用失败: " + t);
        }
        if (mx == TickObservation.UNREADABLE || ctx == null) {
            return;
        }
        int[] scaled = InputCoordinateMath
            .scaledMouse(mx, my, ctx.scaledWidth, ctx.scaledHeight, ctx.displayWidth, ctx.displayHeight);
        if (scaled != null) {
            b.mouseGui(scaled[0], scaled[1]);
        }
    }

    // ------------------------------------------------------------ 消费链与焦点

    /** 当前屏幕（类名 + {@code allowUserInput}）。 */
    private void readScreen(TickObservation.Builder b) {
        try {
            Object screen = mc == null ? null : mc.currentScreen;
            if (screen == null) {
                b.currentScreen(null, null);
                return;
            }
            String name = screen.getClass()
                .getName();
            Boolean allow = null;
            try {
                Field f = findField(screen.getClass(), "allowUserInput");
                if (f != null) {
                    Object v = f.get(screen);
                    if (v instanceof Boolean) {
                        allow = (Boolean) v;
                    }
                }
            } catch (Throwable t) {
                b.warn("读取 currentScreen.allowUserInput 失败: " + t);
            }
            b.currentScreen(name, allow);
        } catch (Throwable t) {
            b.warn("读取 mc.currentScreen 失败: " + t);
        }
    }

    /** 沿类层次找字段（{@code GuiScreen.allowUserInput} 是 public 字段，但仍按名找以免版本漂移）。 */
    private static Field findField(Class<?> type, String name) {
        Class<?> t = type;
        while (t != null) {
            try {
                Field f = t.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (Throwable e) {
                t = t.getSuperclass();
            }
        }
        return null;
    }

    /** {@code inGameHasFocus} 与 {@code Display.isActive()}。 */
    private void readFocus(TickObservation.Builder b) {
        try {
            b.inGameHasFocus(mc == null ? null : Boolean.valueOf(mc.inGameHasFocus));
        } catch (Throwable t) {
            b.warn("读取 mc.inGameHasFocus 失败: " + t);
        }
        try {
            Method m = displayClass == null ? null : displayClass.getMethod("isActive");
            Object v = m == null ? null : m.invoke(null);
            if (v instanceof Boolean) {
                b.displayActive((Boolean) v);
            }
        } catch (Throwable t) {
            b.warn("读取 Display.isActive 失败: " + t);
        }
    }

    /**
     * 键位目录与 {@code KeyBinding} 回读（§2.2 第 1 条：目录的权威来源是运行期注册表）。
     *
     * <p>
     * 跳过 {@code getKeyCode() == 0}（未绑定）的项：它们不是「可注入的键位标识」，混进目录只会让
     * 调用方以为能按名注入一个不存在的键。
     */
    private void readKeyCatalog(TickObservation.Builder b) {
        try {
            if (mc == null || mc.gameSettings == null) {
                b.warn("gameSettings 不可用 ⇒ keyCatalog 为空（未实现，不是「没有键位」）");
                return;
            }
            // keyBindings 与 keyBindsHotbar 两个 public 数组（后者已含于前者，按实例去重）
            java.util.Set<Object> seen = java.util.Collections
                .newSetFromMap(new java.util.IdentityHashMap<Object, Boolean>());
            List<KeyBinding> bindings = new ArrayList<KeyBinding>();
            for (Field f : GameSettings.class.getFields()) {
                if (f.getType() != KeyBinding[].class) {
                    continue;
                }
                Object v = f.get(mc.gameSettings);
                if (!(v instanceof KeyBinding[])) {
                    continue;
                }
                for (KeyBinding kb : (KeyBinding[]) v) {
                    if (kb != null && seen.add(kb)) {
                        bindings.add(kb);
                    }
                }
            }
            if (bindings.isEmpty()) {
                b.warn("未从 GameSettings 读到任何 KeyBinding 数组字段 ⇒ keyCatalog 为空");
            }
            for (KeyBinding kb : bindings) {
                if (kb.getKeyCode() == 0) {
                    continue;
                }
                b.keyBinding(kb.getKeyDescription(), kb.getKeyCode());
                b.keyPressed(kb.getKeyDescription(), Boolean.valueOf(kb.getIsKeyPressed()));
            }
        } catch (Throwable t) {
            b.warn("读取键位注册表失败: " + t);
        }
    }
}
