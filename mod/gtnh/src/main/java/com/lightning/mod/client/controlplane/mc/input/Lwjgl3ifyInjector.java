package com.lightning.mod.client.controlplane.mc.input;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ErrorCodes;

/**
 * §1.2 白名单的投递后端：<b>全反射</b>调用 lwjgl3ify 的 Java 侧事件队列。
 *
 * <h2>为什么必须反射（编译可见性）</h2>
 * 本 mod 的编译期 classpath 上**没有** {@code org/lwjglx/**}（lwjgl3ify 的 {@code -api} 制品只含
 * {@code me/eigenraven/lwjgl3ify/api/**}），而写 {@code org.lwjgl.input.Keyboard.addRawKeyEvent}
 * 又编译不过（1.7.10 的 lwjgl 壳里没有该方法，RFB 重定向**只改类名不改方法名**）。字符串类名不受
 * 重映射影响，且在运行期 classpath 上 ⇒ 反射是契约 §1.2 允许的两条路之一（本实现选它，
 * 另一条是加 {@code compileOnly} 的 lwjgl3ify {@code dev} 依赖，本单**不采用**以免动构建文件）。
 *
 * <h2>白名单（只有这五个入口写队列）</h2>
 * <ul>
 * <li>{@code org.lwjglx.input.Keyboard.addRawKeyEvent(Keyboard$KeyEvent)}</li>
 * <li>{@code org.lwjglx.input.Keyboard.addCharEvent(int, int)}</li>
 * <li>{@code org.lwjglx.input.Mouse.addMoveEvent(SDL_MouseMotionEvent)}</li>
 * <li>{@code org.lwjglx.input.Mouse.addButtonEvent(int, boolean)}</li>
 * <li>{@code org.lwjglx.input.Mouse.addWheelEvent(double)}</li>
 * </ul>
 * 这五个方法只写 Java 侧队列/数组，<b>不调用任何 SDL 函数</b>，因而不动用户桌面的鼠标、不抢焦点。
 *
 * <h2>{@code 【禁令】} 绝不调用的入口（契约 §1.2 禁令表，逐条落在下面这段注释里）</h2>
 * <ul>
 * <li>{@code Mouse.setGrabbed(boolean)}：走 {@code SDL_WarpMouseInWindow} +
 * {@code SDL_SetWindowRelativeMouseMode}——真实抓取系统光标、切换相对模式；</li>
 * <li>{@code Mouse.setCursorPosition(int,int)}：走 {@code SDL_WarpMouseInWindow}——**真的搬动用户桌面光标**；</li>
 * <li>{@code Mouse.setNativeCursor} / {@code setCursorIcon}：走 {@code SDL_CreateSystemCursor} /
 * {@code SDL_SetCursor}——改系统光标；</li>
 * <li>直写 {@code Keyboard.sdlKeyPressedArray} / {@code Mouse.sdlMouseButtonFlags}：每帧被
 * {@code SDL_PumpEvents} 覆写，存活 &lt; 1 帧（实测无效）；</li>
 * <li>直写 {@code Keyboard.eventQueue}（含 {@code clear()}）：绕过 REPEAT 过滤，且 {@code clear()}
 * 会清掉静态 seed 哨兵 ⇒ 此后 {@code getEventKey()}/{@code getEventCharacter()}/{@code isRepeatEvent()}
 * 对 {@code peek()} 解引用 **NPE**；</li>
 * <li>自行 {@code Mouse.next()} 排空队列：会与游戏抢占同一队列（先手赢）；</li>
 * <li>单独使用 {@code InputEvents.injectKeyEvent/injectTextEvent}：不进 vanilla 队列，只到
 * {@code KeyboardListener} 与实现该接口的 {@code currentScreen}（真实按键是「两路都发」）；</li>
 * <li>反射改写 {@code Display.displayFocused} / 强制 {@code Display.isActive()}。</li>
 * </ul>
 * 本类不引用上述任何符号（连字符串常量都没有），因此「禁令」在字节码层面就是零命中。
 *
 * <h2>构造器陷阱（实现的义务，§2.2 第 4 条）</h2>
 * {@code Keyboard.KeyEvent} 的 {@code key} 字段对 {@code KEY_ESCAPE/HOME/NUMLOCK/CAPITAL/SCROLL/
 * LCONTROL/LSHIFT/LMETA/LMENU/RCONTROL/RSHIFT/RMETA/RMENU} 会改用 {@code keyNonScancode}
 * （{@code shouldTreatAsScancode(key)} 为 false 时取第二个参数）。生产者侧 {@code addSdlKeyEvent}
 * 对两个参数传同一值，本实现照做 ⇒ <b>保证</b>投递后 {@code Keyboard.getEventKey()} 等于调用方给的
 * 键码，调用方不需要知道这条。
 */
public final class Lwjgl3ifyInjector implements InputSink {

    /** 键盘门面（运行期由 lwjgl3ify 提供）。 */
    private static final String CLS_KEYBOARD = "org.lwjglx.input.Keyboard";

    /** 鼠标门面（运行期由 lwjgl3ify 提供）。 */
    private static final String CLS_MOUSE = "org.lwjglx.input.Mouse";

    /** 键事件载体。 */
    private static final String CLS_KEY_EVENT = "org.lwjglx.input.Keyboard$KeyEvent";

    /** 键状态枚举（{@code PRESS}/{@code RELEASE}/{@code REPEAT}）。 */
    private static final String CLS_KEY_STATE = "org.lwjglx.input.Keyboard$KeyState";

    /** SDL 鼠标移动结构体（{@code lwjgl-sdl} 提供；注意**不是** GLFW）。 */
    private static final String CLS_MOTION = "org.lwjgl.sdl.SDL_MouseMotionEvent";

    /** 后端标识（契约 §1.1：SDL，不是 GLFW）。 */
    private static final String BACKEND = "sdl";

    private final Method addRawKeyEvent;
    private final Method addCharEvent;
    private final Method addMoveEvent;
    private final Method addButtonEvent;
    private final Method addWheelEvent;
    private final Constructor<?> keyEventCtor;
    private final Object pressState;
    private final Object releaseState;
    private final Class<?> motionClass;
    private final Method motionCalloc;
    private final Method motionFree;
    private final List<Entry> entries;
    private final String unavailableReason;

    private Lwjgl3ifyInjector(Method addRawKeyEvent, Method addCharEvent, Method addMoveEvent, Method addButtonEvent,
        Method addWheelEvent, Constructor<?> keyEventCtor, Object pressState, Object releaseState, Class<?> motionClass,
        Method motionCalloc, Method motionFree, List<Entry> entries, String unavailableReason) {
        this.addRawKeyEvent = addRawKeyEvent;
        this.addCharEvent = addCharEvent;
        this.addMoveEvent = addMoveEvent;
        this.addButtonEvent = addButtonEvent;
        this.addWheelEvent = addWheelEvent;
        this.keyEventCtor = keyEventCtor;
        this.pressState = pressState;
        this.releaseState = releaseState;
        this.motionClass = motionClass;
        this.motionCalloc = motionCalloc;
        this.motionFree = motionFree;
        this.entries = Collections.unmodifiableList(new ArrayList<Entry>(entries));
        this.unavailableReason = unavailableReason;
    }

    /** 用 mod 自己的类加载器探测（生产路径）。 */
    public static Lwjgl3ifyInjector create() {
        return probe(Lwjgl3ifyInjector.class.getClassLoader());
    }

    /**
     * 用指定类加载器探测（单测注入「什么都找不到」的加载器，验证能力探测的**如实**性）。
     *
     * <p>
     * 逐入口独立探测：键盘整体缺席与「鼠标移动结构体缺席」是两种不同的降级，必须分别可见
     * （§1.3 的能力定位就是「到达游戏自己的路由 + 如实报告边界」）。
     */
    public static Lwjgl3ifyInjector probe(ClassLoader loader) {
        List<Entry> entries = new ArrayList<Entry>(5);

        Class<?> keyboard = load(loader, CLS_KEYBOARD);
        Class<?> mouse = load(loader, CLS_MOUSE);

        // 1) addRawKeyEvent + KeyEvent 构造器 + KeyState 枚举（三者缺一即该入口不可用）
        Method rawKey = null;
        Constructor<?> ctor = null;
        Object press = null;
        Object release = null;
        String rawKeyReason = null;
        if (keyboard == null) {
            rawKeyReason = "类不可用: " + CLS_KEYBOARD;
        } else {
            Class<?> keyEvent = load(loader, CLS_KEY_EVENT);
            Class<?> keyState = load(loader, CLS_KEY_STATE);
            if (keyEvent == null) {
                rawKeyReason = "类不可用: " + CLS_KEY_EVENT;
            } else if (keyState == null) {
                rawKeyReason = "类不可用: " + CLS_KEY_STATE;
            } else {
                try {
                    rawKey = keyboard.getMethod("addRawKeyEvent", keyEvent);
                    ctor = keyEvent.getConstructor(int.class, int.class, int.class, keyState, long.class);
                    press = enumConstant(keyState, "PRESS");
                    release = enumConstant(keyState, "RELEASE");
                } catch (Throwable t) {
                    rawKey = null;
                    rawKeyReason = "签名不符: " + t;
                }
            }
        }
        entries.add(new Entry("Keyboard.addRawKeyEvent", rawKey != null, rawKeyReason));

        // 2) addCharEvent
        Method charEvent = null;
        String charReason = null;
        if (keyboard == null) {
            charReason = "类不可用: " + CLS_KEYBOARD;
        } else {
            try {
                charEvent = keyboard.getMethod("addCharEvent", int.class, int.class);
            } catch (Throwable t) {
                charReason = "签名不符: " + t;
            }
        }
        entries.add(new Entry("Keyboard.addCharEvent", charEvent != null, charReason));

        // 3) addMoveEvent（SDL 结构体）
        Method moveEvent = null;
        Class<?> motion = load(loader, CLS_MOTION);
        Method calloc = null;
        Method free = null;
        String moveReason = null;
        if (mouse == null) {
            moveReason = "类不可用: " + CLS_MOUSE;
        } else if (motion == null) {
            moveReason = "结构体类不可用: " + CLS_MOTION;
        } else {
            try {
                calloc = motion.getMethod("calloc");
                free = motion.getMethod("free");
                moveEvent = mouse.getMethod("addMoveEvent", motion);
            } catch (Throwable t) {
                moveEvent = null;
                moveReason = "签名不符: " + t;
            }
        }
        entries.add(new Entry("Mouse.addMoveEvent", moveEvent != null, moveReason));

        // 4) addButtonEvent
        Method buttonEvent = null;
        String buttonReason = null;
        if (mouse == null) {
            buttonReason = "类不可用: " + CLS_MOUSE;
        } else {
            try {
                buttonEvent = mouse.getMethod("addButtonEvent", int.class, boolean.class);
            } catch (Throwable t) {
                buttonReason = "签名不符: " + t;
            }
        }
        entries.add(new Entry("Mouse.addButtonEvent", buttonEvent != null, buttonReason));

        // 5) addWheelEvent
        Method wheelEvent = null;
        String wheelReason = null;
        if (mouse == null) {
            wheelReason = "类不可用: " + CLS_MOUSE;
        } else {
            try {
                wheelEvent = mouse.getMethod("addWheelEvent", double.class);
            } catch (Throwable t) {
                wheelReason = "签名不符: " + t;
            }
        }
        entries.add(new Entry("Mouse.addWheelEvent", wheelEvent != null, wheelReason));

        StringBuilder missing = new StringBuilder();
        for (Entry e : entries) {
            if (!e.available()) {
                if (missing.length() > 0) {
                    missing.append("；");
                }
                missing.append(e.name())
                    .append(" → ")
                    .append(e.reason());
            }
        }
        String reason = missing.length() == 0 ? null : missing.toString();
        return new Lwjgl3ifyInjector(
            rawKey,
            charEvent,
            moveEvent,
            buttonEvent,
            wheelEvent,
            ctor,
            press,
            release,
            motion,
            calloc,
            free,
            entries,
            reason);
    }

    private static Class<?> load(ClassLoader loader, String name) {
        try {
            return Class.forName(name, false, loader == null ? Lwjgl3ifyInjector.class.getClassLoader() : loader);
        } catch (Throwable t) {
            return null;
        }
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static Object enumConstant(Class<?> enumClass, String name) {
        return Enum.valueOf((Class<? extends Enum>) enumClass.asSubclass(Enum.class), name);
    }

    @Override
    public String backend() {
        return BACKEND;
    }

    @Override
    public boolean available() {
        return unavailableReason == null;
    }

    @Override
    public String unavailableReason() {
        return unavailableReason;
    }

    @Override
    public List<Entry> entries() {
        return entries;
    }

    @Override
    public JsonObject probeJson() {
        JsonObject o = new JsonObject();
        o.addProperty("backend", BACKEND);
        o.addProperty("available", available());
        o.addProperty("reason", unavailableReason);
        JsonArray a = new JsonArray();
        for (Entry e : entries) {
            a.add(e.toJson());
        }
        o.add("entries", a);
        return o;
    }

    @Override
    public void key(int keyCode, int codepoint, boolean down) throws InputInjectionException {
        require(
            addRawKeyEvent != null && keyEventCtor != null && pressState != null && releaseState != null,
            "Keyboard.addRawKeyEvent");
        try {
            // 两个键参数给同一值：见类注释「构造器陷阱」——这是设施的**义务**（§2.2 第 4 条），
            // 否则对 KEY_ESCAPE/NUMLOCK/修饰键一族，getEventKey() 会与调用方给的值不等。
            Object event = keyEventCtor.newInstance(
                Integer.valueOf(keyCode),
                Integer.valueOf(keyCode),
                Integer.valueOf(codepoint),
                down ? pressState : releaseState,
                Long.valueOf(System.nanoTime()));
            addRawKeyEvent.invoke(null, event);
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "Keyboard.addRawKeyEvent 调用失败: " + t, t);
        }
    }

    @Override
    public void character(int codepoint) throws InputInjectionException {
        require(addCharEvent != null, "Keyboard.addCharEvent");
        try {
            // key 参数传 0：MC 侧只取 getEventCharacter()（GuiScreen.handleKeyboardInput 的
            // keyTyped(Keyboard.getEventCharacter(), Keyboard.getEventKey())），键位那一半由
            // input.key 承担（键位与字符分离建模，§2.1）。
            addCharEvent.invoke(null, Integer.valueOf(0), Integer.valueOf(codepoint));
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "Keyboard.addCharEvent 调用失败: " + t, t);
        }
    }

    @Override
    public void button(int button, boolean down) throws InputInjectionException {
        require(addButtonEvent != null, "Mouse.addButtonEvent");
        try {
            addButtonEvent.invoke(null, Integer.valueOf(button), Boolean.valueOf(down));
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "Mouse.addButtonEvent 调用失败: " + t, t);
        }
    }

    @Override
    public void wheel(double amount) throws InputInjectionException {
        require(addWheelEvent != null, "Mouse.addWheelEvent");
        try {
            addWheelEvent.invoke(null, Double.valueOf(amount));
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "Mouse.addWheelEvent 调用失败: " + t, t);
        }
    }

    @Override
    public void move(Double absoluteX, Double absoluteY, double deltaX, double deltaY) throws InputInjectionException {
        require(addMoveEvent != null && motionClass != null && motionCalloc != null, "Mouse.addMoveEvent");
        Object event = null;
        try {
            // calloc + setter + free：结构体是原生内存，**必须**在 finally 里 free（否则每帧泄漏一块）
            event = motionCalloc.invoke(null);
            if (absoluteX != null) {
                setStruct(event, "x", absoluteX.doubleValue());
            }
            if (absoluteY != null) {
                setStruct(event, "y", absoluteY.doubleValue());
            }
            setStruct(event, "xrel", deltaX);
            setStruct(event, "yrel", deltaY);
            addMoveEvent.invoke(null, event);
        } catch (InputInjectionException e) {
            throw e;
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "Mouse.addMoveEvent 调用失败: " + t, t);
        } finally {
            if (event != null && motionFree != null) {
                try {
                    motionFree.invoke(event);
                } catch (Throwable ignored) {
                    // 释放失败不影响本次投递结论（结果里已有 available/reason 可判读）
                }
            }
        }
    }

    private void require(boolean ok, String entry) throws InputInjectionException {
        if (!ok) {
            throw new InputInjectionException(
                ErrorCodes.STATE,
                "注入面不可用（" + entry + "）：" + (unavailableReason == null ? "未知原因" : unavailableReason));
        }
    }

    /**
     * 写入 SDL 结构体字段：按 setter 的参数类型自适应 {@code float}/{@code double}/{@code int}/{@code short}。
     *
     * <p>
     * 取值方式与 P0 已验证的实现一致（按名字找「单参且返回结构体自身」的方法），因为它对
     * lwjgl-sdl 的 {@code Struct} 生成代码是稳的：每个字段都有 {@code x()} 取值器与 {@code x(float)}
     * 设值器，只有后者满足「单参」。
     */
    private static void setStruct(Object struct, String field, double value) throws InputInjectionException {
        Method setter = null;
        for (Method m : struct.getClass()
            .getMethods()) {
            if (!m.getName()
                .equals(field) || m.getParameterTypes().length != 1) {
                continue;
            }
            if (m.getReturnType() == struct.getClass()) {
                setter = m;
                break;
            }
            if (setter == null && m.getReturnType() != void.class) {
                setter = m;
            }
        }
        if (setter == null) {
            throw new InputInjectionException(ErrorCodes.STATE, "SDL 结构体无 setter: " + field);
        }
        Class<?> p = setter.getParameterTypes()[0];
        Object arg;
        if (p == float.class) {
            arg = Float.valueOf((float) value);
        } else if (p == double.class) {
            arg = Double.valueOf(value);
        } else if (p == int.class) {
            arg = Integer.valueOf((int) Math.round(value));
        } else if (p == short.class) {
            arg = Short.valueOf((short) Math.round(value));
        } else {
            throw new InputInjectionException(ErrorCodes.STATE, "SDL 结构体字段类型不支持: " + field + " → " + p);
        }
        try {
            setter.invoke(struct, arg);
        } catch (Throwable t) {
            throw new InputInjectionException(ErrorCodes.STATE, "SDL 结构体字段写入失败: " + field + " → " + t, t);
        }
    }
}
