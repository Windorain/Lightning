package com.lightning.mod.client.controlplane.mc.capture;

/**
 * 「当前这一帧是不是取证拍摄帧」的只读查询口（contract.md §4.2；mixin 侧的判定入口）。
 *
 * <h2>为什么需要它</h2>
 * 拍摄帧里有些渲染必须被<b>整段</b>拦掉，而拦法写在 mixin 里。mixin 不该去解析动作的执行阶段，
 * 也不该持有 {@link ShotExecutor} 的实例状态；它只该问一句布尔。本类就是那个布尔。
 *
 * <h2>布尔来源（唯一真值，不引入第二份状态）</h2>
 * 真值就是 {@link ProjectionOverride#isArmed()}，本类<b>不</b>缓存、<b>不</b>新增开关：
 * <ul>
 * <li>置真：{@code ShotExecutor.FrameScope#arm} 在调 {@code EntityRenderer.renderWorld}
 * <b>之前</b>调 {@link ProjectionOverride#arm}；</li>
 * <li>置假：同一作用域的 {@code close()}（在 {@code finally} 里，异常路径也走到）与
 * {@link FramebufferOverride#emergencyRestore()}（tick 兜底）都调 {@link ProjectionOverride#disarm()}。</li>
 * </ul>
 * 全仓 {@link ProjectionOverride#arm} 只有这一个调用点，因此
 * {@code isShotFrameActive() == true} ⟺「一次手工驱动的取证渲染帧正在跑」。
 *
 * <h2>游戏正常帧为什么零影响</h2>
 * 游戏自身的帧从不经过 {@link ShotExecutor}：{@code arm} 不被调用 ⇒ 本查询恒为 {@code false}
 * ⇒ 调用方在第一个 {@code if} 就返回，不碰任何渲染状态。读者必须把「假」当成「什么都不做」的
 * 默认路径来写（{@code MixinRendererLivingEntityShot} 即如此）。
 *
 * <h2>线程</h2>
 * 只在客户端主线程读写（1.7.10 单机里 tick 线程 == 渲染线程，见 contract §4.2.5）。
 * 与真值 {@code ProjectionOverride.armed} 保持同样的（非 volatile 的）单线程口径。
 */
public final class CaptureRenderState {

    private CaptureRenderState() {}

    /** 当前是否处于取证拍摄帧（判定口径见类注释「布尔来源」）。 */
    public static boolean isShotFrameActive() {
        return ProjectionOverride.isArmed();
    }
}
