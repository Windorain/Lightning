package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.EntityRenderer;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.controlplane.mc.capture.ProjectionOverride;

/**
 * 控制面取证相机的投影注入点（contract.md §4.2.3/§4.2.4）。
 *
 * <h2>为什么是这个点（1.7.10 没有官方 hook）</h2>
 * {@code EntityRenderer.setupCameraTransform(float, int)} 是<b>每帧唯一</b>把世界投影矩阵写进 GL 的地方：
 * 
 * <pre>
 * GL11.glMatrixMode(GL_PROJECTION);
 * GL11.glLoadIdentity();
 * ... anaglyph / cameraZoom 平移 ...
 * Project.gluPerspective(fov, (float)mc.displayWidth / mc.displayHeight, 0.05F, farPlane * 2.0F);
 * GL11.glMatrixMode(GL_MODELVIEW);
 * ... orientCamera（相机位置与朝向来自 mc.renderViewEntity）...
 * </pre>
 * 
 * 在它的 {@code RETURN} 点，投影栈顶正好是「原版透视矩阵」，而 MODELVIEW 还没被
 * {@code orientCamera} 动过——此时替换投影栈顶，既拿到原版已经算好的立体/缩放平移量，
 * 又不会打乱模型视图矩阵。冻结分支（{@code bug-fix}）的 {@code IngameShotCapture} 走的是
 * 「挪玩家 + {@code gameSettings.fovSetting}」路线，没有投影覆写能力；本类是在 controlplane 包内
 * 按契约重写的注入点。
 *
 * <p>
 * 正交机位（{@code projection.type=ortho}）在这里不再复用原版矩阵，而是整块换成
 * {@link ProjectionOverride#writeOrthoMatrixToCurrentProjection()} 算出的正交矩阵——原版世界渲染
 * 根本没有正交路径（只有 GUI 的 {@code setupOverlayRendering} 用 {@code glOrtho}）。
 *
 * <p>
 * 未处于覆写态时本注入<b>什么都不做</b>（一次静态布尔判断），因此对正常游戏帧是零影响。
 */
@Mixin(EntityRenderer.class)
public abstract class MixinEntityRendererProjection {

    @Inject(method = "setupCameraTransform", at = @At("RETURN"))
    private void lightning$overrideProjection(float partialTicks, int pass, CallbackInfo ci) {
        if (!ProjectionOverride.isArmed()) {
            return;
        }
        if (ProjectionOverride.isOrtho()) {
            ProjectionOverride.writeOrthoMatrixToCurrentProjection();
        } else {
            ProjectionOverride.applyToCurrentProjectionMatrix();
        }
    }
}
