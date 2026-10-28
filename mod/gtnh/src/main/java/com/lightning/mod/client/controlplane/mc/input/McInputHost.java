package com.lightning.mod.client.controlplane.mc.input;

import java.lang.reflect.Method;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.gui.ScaledResolution;
import net.minecraft.client.settings.KeyBinding;

import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;
import org.lwjgl.opengl.Display;

/**
 * {@link InputHost} 的生产实现：只读 MC 状态，**不写**任何游戏状态。
 *
 * <h2>{@code 【禁令】} 本类绝不触碰的东西（契约 §2.9 / §3.5 / §3.6）</h2>
 * <ul>
 * <li>不调 {@code displayGuiScreen} / {@code setIngameFocus} / {@code currentScreen = ...}：
 * 「当前往哪条消费链」由游戏自己按 {@code currentScreen} 与 {@code allowUserInput} 决定，设施只如实报告；</li>
 * <li>不调 {@code KeyBinding.unPressAllKeys()}（那是原版「进 GUI」的语义，会清掉真实按键的用户状态）；</li>
 * <li>不改 {@code pauseOnLostFocus}、不改 {@code Display.displayFocused}、不 {@code setGrabbed}：
 * 「失焦」是事实，不是可以拧的开关。</li>
 * </ul>
 *
 * <h2>tick 源（为什么需要墙钟兜底，且为什么它不是「用毫秒做持有期限」）</h2>
 * 契约 §4.2 第 3 条禁止本族新增 {@code ClientTickEvent} 订阅者，因此 tick 只能由步进动作每 tick 的
 * {@code advance} 推进（{@link #advanceTick()}）。但持键的归属**跨作业**：`input.key down` 那个作业
 * 交付完就结束了，此后若没有任何输入动作在跑，就没有人在推进 tick —— 而「不允许无限期持有」的收敛要求
 * （「无期限持有是禁止的」，到期必须自动抬起）不允许出现「没人推进 ⇒ 永不收口」的按下态。
 *
 * <p>
 * 因此 {@link #clientTick()} 取二者之**大**：
 * <ol>
 * <li><b>被驱动的 tick 数</b>（精确：每个被观察到的客户端 tick +1）；</li>
 * <li><b>墙钟折算的 tick 下限</b>（{@code (nanoTime - start) / 50ms}，名义 20 TPS）。</li>
 * </ol>
 * 二者都单调不减（用 {@code nanoTime} 而非 {@code currentTimeMillis}，避免钟跳）。
 *
 * <p>
 * <b>这与契约 §3.2 不冲突</b>：那一句禁止的是「把毫秒当持有期限的判据」（客户端卡顿时毫秒不可判定），
 * 本实现仍以 **tick 计数**为判据，墙钟只用来回答「这段时间里客户端大约跑了多少 tick」。它的偏差点是
 * <b>高估</b>（客户端真被冻结时墙钟照走）——而高估的后果是**更早收口**，正是想要的收敛方向，
 * 不会把「还在按着」误报成「已松开」（后者才是危险方向）。
 */
public final class McInputHost implements InputHost {

    /** 名义 20 TPS 的一 tick 纳秒数（只用于墙钟折算 tick 下限）。 */
    private static final long NANOS_PER_TICK = 50000000L;

    /** lwjgl3ify 的 Display：唯一给出 SDL 窗口像素密度的口（不在编译期 classpath 上，故反射）。 */
    private static final String LWJGL3_DISPLAY = "org.lwjglx.opengl.Display";

    /** 像素密度 getter；解析失败后不再重试的原因见 {@link #pixelScaleMethod}。 */
    private static volatile Method pixelScaleMethod;

    /** 像素密度 getter 是否已尝试解析。 */
    private static volatile boolean pixelScaleResolved;

    private final long startNanos = System.nanoTime();
    private long drivenTicks;

    @Override
    public long clientTick() {
        long clock = (System.nanoTime() - startNanos) / NANOS_PER_TICK;
        return Math.max(drivenTicks, clock);
    }

    @Override
    public void advanceTick() {
        drivenTicks++;
    }

    /** 被驱动的 tick 数（诊断用：与 {@link #clientTick()} 的差 = 墙钟兜底贡献）。 */
    public long drivenTicks() {
        return drivenTicks;
    }

    @Override
    public boolean keyboardReadable() {
        return keyboardQueueDepth() >= 0;
    }

    @Override
    public int keyboardQueueDepth() {
        try {
            if (!Keyboard.isCreated()) {
                return -1;
            }
            return Keyboard.getNumKeyboardEvents();
        } catch (Throwable t) {
            return -1;
        }
    }

    @Override
    public String consumerChain() {
        Minecraft mc = mc();
        if (mc == null) {
            return "none";
        }
        GuiScreen screen = mc.currentScreen;
        if (screen != null) {
            return "gui";
        }
        return "world";
    }

    @Override
    public boolean worldChainActive() {
        Minecraft mc = mc();
        return mc != null && (mc.currentScreen == null || mc.currentScreen.allowUserInput);
    }

    @Override
    public String currentScreenName() {
        Minecraft mc = mc();
        if (mc == null || mc.currentScreen == null) {
            return null;
        }
        return mc.currentScreen.getClass()
            .getName();
    }

    @Override
    public boolean allowUserInput() {
        Minecraft mc = mc();
        if (mc == null) {
            return false;
        }
        // 无界面时 MC 的世界闸门成立（`currentScreen == null || allowUserInput`），故报告 true；
        // 有界面时报界面自己的 allowUserInput（§6 {@code consumer.allowUserInput}）。
        return mc.currentScreen == null || mc.currentScreen.allowUserInput;
    }

    @Override
    public boolean displayActive() {
        try {
            return Display.isActive();
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public boolean inGameHasFocus() {
        Minecraft mc = mc();
        return mc != null && mc.inGameHasFocus;
    }

    @Override
    public boolean keyBindingPressed(int keyCode) {
        KeyBinding kb = keyBindingOf(keyCode);
        try {
            return kb != null && kb.getIsKeyPressed();
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public Map<String, Integer> keyCatalog() {
        Minecraft mc = mc();
        if (mc == null || mc.gameSettings == null || mc.gameSettings.keyBindings == null) {
            return Collections.emptyMap();
        }
        Map<String, Integer> out = new LinkedHashMap<String, Integer>();
        for (KeyBinding kb : mc.gameSettings.keyBindings) {
            if (kb == null) {
                continue;
            }
            try {
                String name = kb.getKeyDescription();
                if (name != null && !out.containsKey(name)) {
                    out.put(name, Integer.valueOf(kb.getKeyCode()));
                }
            } catch (Throwable ignored) {
                // 单个键位读不到不影响整表（读不到本身也是结论，会在快照里体现为空项）
            }
        }
        return out;
    }

    @Override
    public boolean keyCatalogAvailable() {
        return !keyCatalog().isEmpty();
    }

    @Override
    public int scaledWidth() {
        return scaled()[0];
    }

    @Override
    public int scaledHeight() {
        return scaled()[1];
    }

    @Override
    public String scaledSource() {
        if (scaledSource == null) {
            // 让来源有值：来源是 scaled() 的副产物，先算一次（幂等，不写任何游戏状态）
            scaled();
        }
        return scaledSource;
    }

    @Override
    public int displayWidth() {
        Minecraft mc = mc();
        return mc == null ? 0 : mc.displayWidth;
    }

    @Override
    public int displayHeight() {
        Minecraft mc = mc();
        return mc == null ? 0 : mc.displayHeight;
    }

    @Override
    public double pixelScale() {
        Method m = pixelScaleMethod();
        if (m == null) {
            return 1.0D;
        }
        try {
            Object v = m.invoke(null);
            if (v instanceof Number && ((Number) v).doubleValue() > 0.0D) {
                return ((Number) v).doubleValue();
            }
        } catch (Throwable ignored) {
            // 取不到 ⇒ 1.0（在 pixelScaleSource 里如实标注）
        }
        return 1.0D;
    }

    @Override
    public String pixelScaleSource() {
        return pixelScaleMethod() == null ? "assumed-1（" + LWJGL3_DISPLAY + ".getPixelScaleFactor() 不可用）"
            : LWGL3_DISPLAY_METHOD_LABEL;
    }

    /** 像素密度来源的可读标签（供 {@link #pixelScaleSource()} 用）。 */
    private static final String LWGL3_DISPLAY_METHOD_LABEL = LWJGL3_DISPLAY + ".getPixelScaleFactor()";

    @Override
    public boolean mouseReadable() {
        try {
            return Mouse.isCreated();
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public int mouseX() {
        try {
            return Mouse.getX();
        } catch (Throwable t) {
            return 0;
        }
    }

    @Override
    public int mouseY() {
        try {
            return Mouse.getY();
        } catch (Throwable t) {
            return 0;
        }
    }

    // ------------------------------------------------------------------ 内部

    /** 缩放参数来源（{@link #scaled()} 的副产物，供自校准回显）。 */
    private String scaledSource;

    /**
     * GUI 缩放尺寸：优先用**当前界面自己的** {@code width/height}（这正是
     * {@code GuiScreen.handleMouseInput} 里用的那两个数，口径完全一致）；无界面时退到
     * {@code ScaledResolution}（MC 每帧的算法），再退到 framebuffer 尺寸并如实标注来源。
     */
    private int[] scaled() {
        Minecraft mc = mc();
        if (mc == null) {
            scaledSource = "unavailable: Minecraft 实例不可用";
            return new int[] { 0, 0 };
        }
        GuiScreen screen = mc.currentScreen;
        if (screen != null && screen.width > 0 && screen.height > 0) {
            scaledSource = "currentScreen(" + screen.getClass()
                .getName() + ".width/height)";
            return new int[] { screen.width, screen.height };
        }
        try {
            ScaledResolution sr = new ScaledResolution(mc, mc.displayWidth, mc.displayHeight);
            int w = sr.getScaledWidth();
            int h = sr.getScaledHeight();
            if (w > 0 && h > 0) {
                scaledSource = "ScaledResolution(scaleFactor=" + sr.getScaleFactor() + ")";
                return new int[] { w, h };
            }
        } catch (Throwable t) {
            scaledSource = "unavailable: ScaledResolution 构造失败: " + t;
        }
        scaledSource = "fallback-display（ScaledResolution 不可用，退回 framebuffer 尺寸）";
        return new int[] { mc.displayWidth, mc.displayHeight };
    }

    private static KeyBinding keyBindingOf(int keyCode) {
        Minecraft mc = mc();
        if (mc == null || mc.gameSettings == null || mc.gameSettings.keyBindings == null) {
            return null;
        }
        for (KeyBinding kb : mc.gameSettings.keyBindings) {
            if (kb != null && kb.getKeyCode() == keyCode) {
                return kb;
            }
        }
        return null;
    }

    private static Method pixelScaleMethod() {
        if (!pixelScaleResolved) {
            synchronized (McInputHost.class) {
                if (!pixelScaleResolved) {
                    try {
                        pixelScaleMethod = Class.forName(LWJGL3_DISPLAY)
                            .getMethod("getPixelScaleFactor");
                    } catch (Throwable t) {
                        pixelScaleMethod = null;
                    }
                    pixelScaleResolved = true;
                }
            }
        }
        return pixelScaleMethod;
    }

    private static Minecraft mc() {
        try {
            return Minecraft.getMinecraft();
        } catch (Throwable t) {
            return null;
        }
    }
}
