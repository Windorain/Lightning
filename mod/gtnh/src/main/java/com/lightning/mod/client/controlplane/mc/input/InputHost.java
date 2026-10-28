package com.lightning.mod.client.controlplane.mc.input;

import java.util.Map;

/**
 * 客户端侧的**只读观察面 + tick 源**（契约 §6：快照必须在客户端 tick 线程取）。
 *
 * <p>
 * 本接口是「MC 状态」与「输入运行时逻辑」之间的唯一接缝：运行时（
 * {@link InputRuntimeImpl}）全部业务逻辑只依赖本接口，因此单测可以用假实现覆盖状态机、
 * 到期抬起、幂等释放、按作业隔离与队列满路径，<b>完全不需要客户端</b>。生产实现是
 * {@link McInputHost}。
 *
 * <h2>tick 源（契约 §4.2 第 3 条：唯一 tick 驱动 = 步进动作每 tick 的 advance）</h2>
 * 本设施**不新增** {@code ClientTickEvent} 订阅者，因此「当前 tick」只能由
 * {@link #advanceTick()} 明确推进（步进动作每个 tick 的 {@code advance} 调一次）。
 * {@link #clientTick()} 必须**单调不减**：它允许实现用墙钟估计「无人驱动期间客户端实际跑过的 tick 数」
 * （见 {@link McInputHost} 的说明），但绝不允许倒退——倒退会让持键期限永远到不了。
 */
public interface InputHost {

    /**
     * 当前客户端 tick 计数（单调不减）。
     *
     * <p>
     * 口径 = tick 计数（名义 20 TPS），不是毫秒；客户端卡顿时它与墙钟不成正比（契约 §3.2）。
     */
    long clientTick();

    /** 明确推进一个客户端 tick（由唯一的 tick 驱动调用）。 */
    void advanceTick();

    /** 键盘队列深度是否可读（{@code Keyboard.getNumKeyboardEvents()}）。 */
    boolean keyboardReadable();

    /** 键盘队列深度实读；不可读返回 {@code -1}（**不是** 0，「读不到」与「空队列」必须分得开）。 */
    int keyboardQueueDepth();

    /** 当前消费链：{@code "gui"} | {@code "world"} | {@code "none"}（由游戏自己决定，设施不干预）。 */
    String consumerChain();

    /**
     * 世界链是否同样活着。
     *
     * <p>
     * {@code Minecraft.runTick} 的闸门是 {@code currentScreen == null || currentScreen.allowUserInput}
     * ⇒ 界面允许时 **GUI 链与世界链会同时消费**，「当前链」这一个值描述不了这种双活形态。
     */
    boolean worldChainActive();

    /** 当前界面类名；无界面为 {@code null}。 */
    String currentScreenName();

    /** 世界输入闸门（无界面时按 MC 语义视为允许）。 */
    boolean allowUserInput();

    /** {@code Display.isActive()}（失焦时 false；本设施只报告不干预）。 */
    boolean displayActive();

    /** {@code mc.inGameHasFocus}。 */
    boolean inGameHasFocus();

    /** 某键码对应的 KeyBinding 是否处于 pressed（持键与游戏态不一致时要能看见，§3.6 第 4 条）。 */
    boolean keyBindingPressed(int keyCode);

    /** 键位目录（描述名 → LWJGL 键码），运行期注册表实读；读不到返回空表。 */
    Map<String, Integer> keyCatalog();

    /** 键位目录是否可用。 */
    boolean keyCatalogAvailable();

    /** GUI 缩放宽（{@code GuiScreen.width} 或 {@code ScaledResolution} 口径）。 */
    int scaledWidth();

    /** GUI 缩放高。 */
    int scaledHeight();

    /** 缩放参数的来源说明（自校准用）。 */
    String scaledSource();

    /** framebuffer 宽（{@code mc.displayWidth}）。 */
    int displayWidth();

    /** framebuffer 高（{@code mc.displayHeight}）。 */
    int displayHeight();

    /** 像素密度（{@code Display.getPixelScaleFactor()}）；取不到按 1 并如实标注来源。 */
    double pixelScale();

    /** 像素密度的来源说明。 */
    String pixelScaleSource();

    /** {@code Mouse.getX()/getY()} 是否可读。 */
    boolean mouseReadable();

    /** {@code Mouse.getX()} 实读（事件队列口径）；不可读时返回值无意义，调用方须先问 {@link #mouseReadable()}。 */
    int mouseX();

    /** {@code Mouse.getY()} 实读；口径同 {@link #mouseX()}。 */
    int mouseY();
}
