package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.Minecraft;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.controlplane.mc.capture.FramebufferOverride;

/**
 * 渲染分辨率覆写（高分辨率截图 / tile 渲染）的注入点（contract.md §4.2.4 的「分辨率覆写」）。
 *
 * <h2>为什么必须注入 {@code updateFramebufferSize}</h2>
 * {@code Minecraft.updateFramebufferSize()} 是 framebuffer 尺寸的<b>唯一</b>来源：
 * 
 * <pre>
 * private void updateFramebufferSize() {
 *     this.framebufferMc.createBindFramebuffer(this.displayWidth, this.displayHeight);
 *     ...
 * }
 * </pre>
 * 
 * 而 {@code mc.displayWidth/Height} 又由 {@code updateDisplay()} 从真实窗口尺寸每帧刷新，
 * 所以「直接改字段」拿不到 3840×2160 的 framebuffer。这里的做法是：在
 * {@link FramebufferOverride} 处于覆写态时，<b>取消</b>本方法并替它按覆写尺寸建一次 framebuffer；
 * 覆写结束后由 {@code ShotExecutor} 以真实尺寸再调一次本方法（那时 {@link FramebufferOverride}
 * 已退出覆写态，注入直接返回，方法照原逻辑执行）。
 *
 * <p>
 * 只覆盖 framebuffer 的创建尺寸，<b>不</b>碰 LWJGL 的 {@code Display}：窗口始终是原来那个，
 * 因此不触发窗口事件、不丢 GL 上下文、不会让玩家看到一个真实的巨型窗口。
 *
 * <h2>视口正确性由 displayWidth 覆写保证（本类没有、也不需要有 glViewport 重定向）</h2>
 * {@code EntityRenderer.renderWorld} 每帧开头的
 * {@code GL11.glViewport(0, 0, mc.displayWidth, mc.displayHeight)} 读的就是
 * {@code mc.displayWidth/Height}，而 {@code ShotExecutor.FrameScope#arm} 在进入覆写态时已经把这两个
 * 字段指向目标尺寸（覆写结束再还原）⇒ <b>视口自动与这里建出的 framebuffer 同尺寸</b>，
 * 不需要任何第二处注入。
 *
 * <p>
 * <b>历史（已删除的死代码，勿再引入）</b>：本类曾有一个 {@code @Redirect} 直接拦 {@code GL11.glViewport}
 * 并把宽高换成覆写尺寸，声称「两处 {@code glViewport} 调用点都要换」。它<b>从未注入成功</b>：
 * {@code GL11} 是 LWJGL 的类、不经过 MCP 混淆，注解处理器在编译期报
 * {@code Unable to determine descriptor} / {@code Unable to locate method mapping for @At(INVOKE...)}
 * （3 条警告），生成的 refmap 里没有对应条目，运行期日志里也从未出现 {@code ->@Redirect} 记录。
 * 真正让视口正确的是 {@code mc.displayWidth/Height} 覆写；那条 redirect 既没起作用，又把
 * 「视口是怎么对的」指向了错误的地方，故整条删除。
 * 真机可核对的自证：{@code ShotExecutor.FrameScope#probeRenderTarget} 输出的
 * {@code viewport=[0,0,W,H]} 与覆写尺寸一致（r4 修黑后实测 {@code viewport=[0,0,1280,720]}）。
 *
 * <p>
 * <b>教训</b>：拦 LWJGL（或任何非 MC 混淆命名空间）的调用时，{@code @At} 的 target 必须显式
 * {@code remap = false}（对照 {@code MixinModelRendererCapture} 对 {@code GL11.glCallList} 的写法），
 * 否则注解处理器定位不到映射、注入静默失效——编译期只有警告，运行期只有「什么都没发生」。
 */
@Mixin(Minecraft.class)
public abstract class MixinMinecraftResolution {

    /** 取消原尺寸的 framebuffer 建立，改用覆写尺寸。 */
    @Inject(method = "updateFramebufferSize", at = @At("HEAD"), cancellable = true)
    private void lightning$framebufferSize(CallbackInfo ci) {
        if (!FramebufferOverride.isActive()) {
            return;
        }
        Minecraft mc = (Minecraft) (Object) this;
        mc.getFramebuffer()
            .createBindFramebuffer(FramebufferOverride.width(), FramebufferOverride.height());
        ci.cancel();
    }
}
