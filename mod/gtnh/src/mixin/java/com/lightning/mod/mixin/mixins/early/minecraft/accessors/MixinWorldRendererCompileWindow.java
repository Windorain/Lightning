package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.WorldRenderer;
import net.minecraft.entity.EntityLivingBase;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.CaptureChannel;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 「忠实复现捕获层」1.0（捕获保真）：区块编译窗口钩子——包住 {@link WorldRenderer#updateRenderer} 整个方法，
 * 开 {@link CaptureChannel#BLOCK_COMPILE} 录窗（归属键 = 渲染器 16³ 段角 posX/posY/posZ，tag 带 chunk 坐标）。
 * <p>
 * 为什么存在：现行捕获在「真实渲染循环」下对区块编译窗口无任何钩子，静态几何流入无法按编译批次归属；
 * 本窗口让编译期顶点带上通道与归属，并提供 zeroFlow 检测（窗口开着但零几何流入 = 静默漏录信号）。
 * <p>
 * 1.7.10 编译期坐标系（forgeSrc 实证，build/rfg/minecraft-src WorldRenderer.java）：编译循环内
 * {@code preRenderBlocks} 调用 {@code Tessellator.instance.setTranslation(-posX,-posY,-posZ)}（:267），
 * 块以世界坐标渲染（{@code renderBlockByRenderType(block, j3, l2, i3)} :207），编译结束 offset 归零（:281）。
 * 故缓冲内坐标 = 世界坐标 + offset，顶点去 offset 即世界坐标——录窗层按此做 floor 分箱，
 * 首个窗口另有一条 INFO 自证日志（惯例：窗口开启 / 首顶点原始坐标 / 推导世界坐标 / Tessellator offset）。
 * <p>
 * 纯观察论证：本 Mixin 只开/关录窗，不改 {@code needsUpdate}、不改渲染列表、不改 Tessellator 状态；
 * 录窗总开关（{@link TessellatorCaptureState#areWindowsArmed()}）未打开时零行为。
 * {@code needsUpdate == false} 时方法体整体跳过，对应地也不开窗（避免空转窗口制造 zeroFlow 噪音）。
 */
@Mixin(WorldRenderer.class)
public abstract class MixinWorldRendererCompileWindow {

    @Shadow
    public int posX;

    @Shadow
    public int posY;

    @Shadow
    public int posZ;

    @Shadow
    public boolean needsUpdate;

    @Inject(method = "updateRenderer", at = @At("HEAD"))
    private void sde$openBlockCompileWindow(EntityLivingBase entity, CallbackInfo ci) {
        if (!TessellatorCaptureState.areWindowsArmed() || !this.needsUpdate) {
            return;
        }
        TessellatorCaptureState.beginWindow(
            CaptureChannel.BLOCK_COMPILE,
            this.posX,
            this.posY,
            this.posZ,
            "chunk(" + (this.posX >> 4) + "," + (this.posZ >> 4) + ")");
    }

    @Inject(method = "updateRenderer", at = @At("RETURN"))
    private void sde$closeBlockCompileWindow(EntityLivingBase entity, CallbackInfo ci) {
        if (!TessellatorCaptureState.areWindowsArmed()) {
            return;
        }
        TessellatorCaptureState.endWindow();
    }
}
