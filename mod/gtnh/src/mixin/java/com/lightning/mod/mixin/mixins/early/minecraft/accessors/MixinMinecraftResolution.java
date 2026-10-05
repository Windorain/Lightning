package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.Minecraft;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
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
 * 覆写结束后由 {@code ShotExecutor} 以真实尺寸再调一次本方法（那时走到下面的原逻辑）。
 *
 * <p>
 * 只覆盖 framebuffer 的创建尺寸，<b>不</b>碰 LWJGL 的 {@code Display}：窗口始终是原来那个，
 * 因此不触发窗口事件、不丢 GL 上下文、不会让玩家看到一个真实的巨型窗口。
 *
 * <h2>视口必须同时覆盖</h2>
 * {@link #lightning$viewport} 把 {@code EntityRenderer} 里那两处
 * {@code GL11.glViewport(0, 0, mc.displayWidth, mc.displayHeight)} 换成覆写尺寸。
 * 两处（{@code updateCameraAndRender} 的 HUD 段与 {@code renderWorld} 的世界段）都要换：
 * framebuffer 与视口尺寸不一致会出现「画面被裁」或「几何只画在左下角」的静默错图。
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

    /**
     * 视口尺寸跟随 framebuffer（两处调用点都覆盖）。
     *
     * <p>
     * 目标写全 {@code glViewport(IIII)V} 描述符：{@code GL11} 是 LWJGL 的类、不走 MCP 混淆，
     * 但注解处理器在缺描述符时会打印「Unable to locate method mapping」——那是噪音，
     * 写全描述符即可消掉，也让「到底改的是哪一处」在源码里可直接核对。
     */
    @Redirect(
        method = { "updateCameraAndRender", "renderWorld" },
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/opengl/GL11;glViewport(IIII)V"))
    private void lightning$viewport(int x, int y, int width, int height) {
        if (FramebufferOverride.isActive()) {
            org.lwjgl.opengl.GL11.glViewport(x, y, FramebufferOverride.width(), FramebufferOverride.height());
            return;
        }
        org.lwjgl.opengl.GL11.glViewport(x, y, width, height);
    }
}
