package com.lightning.mod.client.controlplane.mc.input.observe;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonObject;

/**
 * 一次「客户端 tick 线程只读探测」的全部读数（Gitea #162 §9.3：T2-B 拥有的只读探针）。
 *
 * <p>
 * 本类<b>只装数据、不做 IO</b>：真值由 {@link InputStateProviderImpl} 在客户端 tick 线程实读后填进来，
 * 组装 {@code input.state} 的算术（含「哪一项没有真值来源」）全部可测——见
 * {@code InputStateProviderImplTest}。这条分工就是契约 §9.3 与 {@code contract.md} §9 的线程纪律落到
 * 代码上的形态：<b>HTTP 线程只能碰本对象，不能碰 MC 对象</b>。
 *
 * <h2>为什么 {@code nullable} 字段一律用包装类型 / {@code -1} 而不是 0</h2>
 * 「读不到」与「读到 0」是两件事（§11.2 第 17 条不许用默认值伪装）。例如
 * {@code keyboardQueueDepth = -1} 表示「探针不可用」，组装时必须落成
 * {@code "unobservable"} 而不是 {@code 0}（{@code 0} 会被读成「队列空 ⇒ 无冲突」）。
 */
public final class TickObservation {

    /** 「读不到」的哨兵（队列深度 / 鼠标坐标）。 */
    public static final int UNREADABLE = -1;

    /** 客户端 tick 线程的线程名（HTTP 线程名形如 {@code cp-http-worker*}）。 */
    public final String threadName;

    /** 探测时刻（{@code System.nanoTime()}，耗时留痕用）。 */
    public final long atNanos;

    /** 键盘事件队列深度（{@code Keyboard.getNumKeyboardEvents()}）；{@link #UNREADABLE} = 读不到。 */
    public final int keyboardQueueDepth;

    /** 键盘队列容量（{@code Keyboard.eventQueue} 的容量）；{@link #UNREADABLE} = 读不到。 */
    public final int keyboardQueueCapacity;

    /** 实读 {@code Mouse.getX()}（显示像素）；{@link #UNREADABLE} = 读不到。 */
    public final int mouseX;

    /** 实读 {@code Mouse.getY()}（显示像素）；{@link #UNREADABLE} = 读不到。 */
    public final int mouseY;

    /**
     * 回读的 GUI 缩放坐标 X（由 {@code com.lightning.mod.client.controlplane.mc.input.InputCoordinateMath#scaledMouse}
     * 算出）；{@link #UNREADABLE} = 读不到。
     */
    public final int mouseGuiX;

    /** 回读的 GUI 缩放坐标 Y。 */
    public final int mouseGuiY;

    /** 当前屏幕（{@code mc.currentScreen}）全限定类名；null = 无屏幕。 */
    public final String currentScreenClass;

    /** 当前屏幕是否接受用户输入（{@code GuiScreen.allowUserInput}）；null = 无屏幕/读不到。 */
    public final Boolean currentScreenAllowUserInput;

    /** {@code Minecraft.inGameHasFocus}；null = 读不到。 */
    public final Boolean inGameHasFocus;

    /** {@code Display.isActive()}；null = 读不到。 */
    public final Boolean displayActive;

    /** 坐标上下文（缩放/显示尺寸/像素比指纹）。 */
    public final InputScaleContext context;

    /** 键位目录：{@code 描述名 → LWJGL 键码}（保持注册顺序）。 */
    public final Map<String, Integer> keyCatalog;

    /**
     * {@code KeyBinding} 回读：{@code 描述名 → pressed}（§3.6 第 4 条要求回读，供调用方判读
     * 「设施的逻辑持有」与「游戏内绑定态」的分叉；<b>不得</b>据此自动重投）。
     */
    public final Map<String, Boolean> keyPressedByDescription;

    /** 字符投递路由是否可达（world 链）；null = 未验证。 */
    public final Boolean textRouteWorld;

    /** 字符投递路由是否可达（gui 链）；null = 未验证。 */
    public final Boolean textRouteGui;

    /** 支持的字符范围闭区间（空数组 = 未声明任何范围）。 */
    public final List<int[]> textRanges;

    /** 运行期键码域（{@code [min,max]}，由 {@code Keyboard.KEY_*} 常量实读）；null = 读不到。 */
    public final int[] keyCodeRange;

    /** 运行期标识：mc / forge / lwjgl3ify / backend；值为 null 的项由组装侧落成「未读取」。 */
    public final String runtimeMc;

    /** Forge 版本（见 {@link #runtimeMc}）。 */
    public final String runtimeForge;

    /** lwjgl3ify 版本（见 {@link #runtimeMc}）。 */
    public final String runtimeLwjgl3ify;

    /** 输入后端标识（见 {@link #runtimeMc}）。 */
    public final String runtimeBackend;

    /** 运行期实读可用的注入入口名（{@code Class.forName} 逐方法探测）。 */
    public final List<String> injectors;

    /** 探针自身的诊断/告警（如「{@code Keyboard} 类不可解析」），组装时进 {@code warnings}。 */
    public final List<String> warnings;

    private TickObservation(Builder b) {
        this.threadName = b.threadName;
        this.atNanos = b.atNanos;
        this.keyboardQueueDepth = b.keyboardQueueDepth;
        this.keyboardQueueCapacity = b.keyboardQueueCapacity;
        this.mouseX = b.mouseX;
        this.mouseY = b.mouseY;
        this.mouseGuiX = b.mouseGuiX;
        this.mouseGuiY = b.mouseGuiY;
        this.currentScreenClass = b.currentScreenClass;
        this.currentScreenAllowUserInput = b.currentScreenAllowUserInput;
        this.inGameHasFocus = b.inGameHasFocus;
        this.displayActive = b.displayActive;
        this.context = b.context;
        this.keyCatalog = Collections.unmodifiableMap(new LinkedHashMap<String, Integer>(b.keyCatalog));
        this.keyPressedByDescription = Collections
            .unmodifiableMap(new LinkedHashMap<String, Boolean>(b.keyPressedByDescription));
        this.textRouteWorld = b.textRouteWorld;
        this.textRouteGui = b.textRouteGui;
        this.textRanges = Collections.unmodifiableList(new ArrayList<int[]>(b.textRanges));
        this.keyCodeRange = b.keyCodeRange == null ? null : new int[] { b.keyCodeRange[0], b.keyCodeRange[1] };
        this.runtimeMc = b.runtimeMc;
        this.runtimeForge = b.runtimeForge;
        this.runtimeLwjgl3ify = b.runtimeLwjgl3ify;
        this.runtimeBackend = b.runtimeBackend;
        this.injectors = Collections.unmodifiableList(new ArrayList<String>(b.injectors));
        this.warnings = Collections.unmodifiableList(new ArrayList<String>(b.warnings));
    }

    /** 新建 builder。 */
    public static Builder builder() {
        return new Builder();
    }

    /** 键盘队列深度是否可读。 */
    public boolean keyboardDepthReadable() {
        return keyboardQueueDepth != UNREADABLE && keyboardQueueDepth >= 0;
    }

    /** 鼠标坐标是否可读。 */
    public boolean mouseReadable() {
        return mouseX != UNREADABLE && mouseY != UNREADABLE;
    }

    /** GUI 缩放回读是否可用。 */
    public boolean guiReadbackReadable() {
        return mouseGuiX != UNREADABLE && mouseGuiY != UNREADABLE;
    }

    /** 探针结果的可变构造器（只在 tick 线程里用一次）。 */
    public static final class Builder {

        private String threadName;
        private long atNanos;
        private int keyboardQueueDepth = UNREADABLE;
        private int keyboardQueueCapacity = UNREADABLE;
        private int mouseX = UNREADABLE;
        private int mouseY = UNREADABLE;
        private int mouseGuiX = UNREADABLE;
        private int mouseGuiY = UNREADABLE;
        private String currentScreenClass;
        private Boolean currentScreenAllowUserInput;
        private Boolean inGameHasFocus;
        private Boolean displayActive;
        private InputScaleContext context;
        private final Map<String, Integer> keyCatalog = new LinkedHashMap<String, Integer>();
        private final Map<String, Boolean> keyPressedByDescription = new LinkedHashMap<String, Boolean>();
        private Boolean textRouteWorld;
        private Boolean textRouteGui;
        private final List<int[]> textRanges = new ArrayList<int[]>();
        private int[] keyCodeRange;
        private String runtimeMc;
        private String runtimeForge;
        private String runtimeLwjgl3ify;
        private String runtimeBackend;
        private final List<String> injectors = new ArrayList<String>();
        private final List<String> warnings = new ArrayList<String>();

        /** tick 线程名。 */
        public Builder threadName(String v) {
            this.threadName = v;
            return this;
        }

        /** 探测时刻。 */
        public Builder atNanos(long v) {
            this.atNanos = v;
            return this;
        }

        /** 键盘队列深度。 */
        public Builder keyboardQueueDepth(int v) {
            this.keyboardQueueDepth = v;
            return this;
        }

        /** 键盘队列容量。 */
        public Builder keyboardQueueCapacity(int v) {
            this.keyboardQueueCapacity = v;
            return this;
        }

        /** 鼠标显示像素坐标。 */
        public Builder mouse(int x, int y) {
            this.mouseX = x;
            this.mouseY = y;
            return this;
        }

        /** 鼠标 GUI 缩放坐标（回读）。 */
        public Builder mouseGui(int x, int y) {
            this.mouseGuiX = x;
            this.mouseGuiY = y;
            return this;
        }

        /** 当前屏幕类名（null = 无屏幕）。 */
        public Builder currentScreen(String className, Boolean allowUserInput) {
            this.currentScreenClass = className;
            this.currentScreenAllowUserInput = allowUserInput;
            return this;
        }

        /** {@code inGameHasFocus}。 */
        public Builder inGameHasFocus(Boolean v) {
            this.inGameHasFocus = v;
            return this;
        }

        /** {@code Display.isActive()}。 */
        public Builder displayActive(Boolean v) {
            this.displayActive = v;
            return this;
        }

        /** 坐标上下文。 */
        public Builder context(InputScaleContext v) {
            this.context = v;
            return this;
        }

        /** 追加一条键位绑定。 */
        public Builder keyBinding(String description, int keyCode) {
            if (description != null && !description.isEmpty()) {
                this.keyCatalog.put(description, Integer.valueOf(keyCode));
            }
            return this;
        }

        /** 追加一条 {@code KeyBinding} 回读（{@code pressed}；null = 该绑定本次未读到）。 */
        public Builder keyPressed(String description, Boolean pressed) {
            if (description != null && !description.isEmpty()) {
                this.keyPressedByDescription.put(description, pressed);
            }
            return this;
        }

        /** 字符路由可达性。 */
        public Builder textRoute(Boolean world, Boolean gui) {
            this.textRouteWorld = world;
            this.textRouteGui = gui;
            return this;
        }

        /** 追加一个字符范围闭区间。 */
        public Builder textRange(int from, int to) {
            this.textRanges.add(new int[] { from, to });
            return this;
        }

        /** 运行期键码域。 */
        public Builder keyCodeRange(int min, int max) {
            this.keyCodeRange = new int[] { min, max };
            return this;
        }

        /** 运行期标识。 */
        public Builder runtime(String mc, String forge, String lwjgl3ify, String backend) {
            this.runtimeMc = mc;
            this.runtimeForge = forge;
            this.runtimeLwjgl3ify = lwjgl3ify;
            this.runtimeBackend = backend;
            return this;
        }

        /** 追加一个实读可用的注入入口名。 */
        public Builder injector(String name) {
            if (name != null && !name.isEmpty()) {
                this.injectors.add(name);
            }
            return this;
        }

        /** 追加一条探针告警。 */
        public Builder warn(String message) {
            if (message != null && !message.isEmpty()) {
                this.warnings.add(message);
            }
            return this;
        }

        /** 构建（不可变）。 */
        public TickObservation build() {
            return new TickObservation(this);
        }
    }

    /** 空探测（完全没有 tick 线程读数时的显式空态，不是「有状态但读不出来」）。 */
    public static TickObservation empty(String threadName) {
        return builder().threadName(threadName)
            .build();
    }

    /** 诊断用的一行摘要。 */
    public String describe() {
        JsonObject o = new JsonObject();
        o.addProperty("thread", threadName);
        o.addProperty("keyboardDepth", keyboardQueueDepth);
        o.addProperty("screen", currentScreenClass);
        o.addProperty("mouse", mouseX + "," + mouseY);
        return o.toString();
    }
}
