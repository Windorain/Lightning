package com.lightning.mod.client.controlplane.mc.capture;

/**
 * 显示尺寸覆写（高分辨率截图 / tile 渲染）的<b>渲染态持有者</b>，由 mixin 与 {@link ShotExecutor} 共用。
 *
 * <h2>为什么要覆写显示尺寸</h2>
 * {@code EntityRenderer.renderWorld} 在每帧开头执行
 * {@code GL11.glViewport(0, 0, mc.displayWidth, mc.displayHeight)}，而
 * {@code mc.getFramebuffer()} 是 {@code Minecraft.updateFramebufferSize()} 按
 * {@code mc.displayWidth/Height} 建的。也就是说「渲染分辨率」在这套代码里只有一个来源：
 * {@code mc.displayWidth/Height}。想要 3840×2160 的图，就必须在这两个字段上做文章。
 *
 * <h2>怎么做（不动真实窗口）</h2>
 * 不碰 LWJGL 的 {@code Display}，只在<b>渲染期</b>把 {@code mc.displayWidth/Height} 指向目标分辨率、
 * 让 framebuffer 按目标尺寸重建，渲染结束后还原这两个字段并重建回真实尺寸。窗口本身从不改变，
 * 因此不会触发窗口事件、不会丢失 GL 上下文。
 *
 * <h2>两个覆写面的分工</h2>
 * <ul>
 * <li>{@link #begin} / {@link #end}：framebuffer 的创建尺寸（{@code updateFramebufferSize} 的入口）；</li>
 * <li>{@code ProjectionOverride.viewportWidth()} / {@code viewportHeight()}：GL 视口尺寸
 * （{@code renderWorld}/{@code updateCameraAndRender} 里 {@code glViewport} 的入口）。</li>
 * </ul>
 *
 * <p>
 * <b>两者必须一起生效</b>：只改一个会得到「视口比 framebuffer 大」（画面被裁）或
 * 「几何只画在左下角一小块」（视口比 framebuffer 小），两种都是静默错图。本类因此把「当前是否
 * 在渲染覆写态」作为唯一开关（渲染覆写态由 {@link ProjectionOverride#isArmed()} 表达）。
 *
 * <h2>线程</h2>
 * 只在客户端主线程读写；{@link #begin}/{@link #end} 成对出现在 {@link ShotExecutor} 的
 * try/finally 里。
 */
public final class FramebufferOverride {

    /** 渲染覆写态的 framebuffer 尺寸；0 表示不在覆写态。 */
    private static int width;
    private static int height;

    private FramebufferOverride() {}

    /** 是否处于渲染覆写态。 */
    public static boolean isActive() {
        return width > 0 && height > 0;
    }

    /** 覆盖尺寸宽；不在覆写态返回 0。 */
    public static int width() {
        return width;
    }

    /** 覆盖尺寸高；不在覆写态返回 0。 */
    public static int height() {
        return height;
    }

    /**
     * 进入覆写态。
     *
     * <p>
     * 只登记尺寸，<b>不</b>动 {@code mc.displayWidth}——那一步由
     * {@link ShotExecutor#applyBufferSize} 负责（它同时要把「先保存真实尺寸」这件事做掉，
     * 否则还原时无真值可用）。
     */
    public static void begin(int w, int h) {
        width = Math.max(1, w);
        height = Math.max(1, h);
    }

    /** 退出覆写态。 */
    public static void end() {
        width = 0;
        height = 0;
    }

    /**
     * 帧结束时的尺寸还原钩子（由 {@code ClientTickEvent} 兜底调用）。
     *
     * <p>
     * 正常路径上 {@link ShotExecutor} 会自己还原；这里只是「动作异常退出也绝不留覆写态」的兜底：
     * 覆写态一旦泄漏到下一个游戏帧，玩家会看到一张被放大的画面（几何只占左下角），
     * 这比动作失败本身更难排查。
     */
    public static void emergencyRestore() {
        width = 0;
        height = 0;
        ProjectionOverride.disarm();
    }

    /** 渲染覆写态下的 framebuffer 宽（供 mixin 建 FBO 用）。 */
    public static int framebufferWidth() {
        return width;
    }

    /** 见 {@link #framebufferWidth}。 */
    public static int framebufferHeight() {
        return height;
    }

    /**
     * 当前应该使用的 GL 视口宽度。
     *
     * @param displayWidth 当前 {@code mc.displayWidth}
     */
    public static int visibleWidth(int displayWidth) {
        return isActive() ? width : displayWidth;
    }

    /** 当前应该使用的 GL 视口高度。 */
    public static int visibleHeight(int displayHeight) {
        return isActive() ? height : displayHeight;
    }

    /** 留痕文本。 */
    public static String describe() {
        return isActive() ? width + "x" + height : "none";
    }
}
