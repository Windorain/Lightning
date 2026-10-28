package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher;
import net.minecraft.tileentity.TileEntity;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.CaptureChannel;
import com.lightning.mod.client.meshcapture.CaptureModelViewDelta;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 「忠实复现捕获层」1.0（捕获保真）：TESR 逐帧窗口钩子——包住
 * {@link TileEntityRendererDispatcher#renderTileEntity(TileEntity, float)}（1.7.10 逐帧入口，
 * forgeSrc 实证：{@code RenderGlobal.renderEntities} 每 TE 每帧调用的就是它，RenderGlobal.java:539
 * {@code TileEntityRendererDispatcher.instance.renderTileEntity(tile, f)}），开
 * {@link CaptureChannel#TESR} 录窗（归属键 = te.xCoord/yCoord/zCoord，tag = TE 类名）。
 * <p>
 * 为什么存在：LP 管等几何 TESR-only（静态编译批次里不含它们），逐帧入口是唯一能观察到它们的窗口；
 * 窗口顺带提供 zeroFlow 检测（如 VBO 重放期零流入是<strong>可解释</strong>的，但必须可见、不可静默）。
 * <p>
 * 坐标还原：复用既有 MODELVIEW 逆基线机制（{@code inv(M0)*M_now*v}，同
 * {@code TileEntitySpecialRendererPostRenderStrategy} 的动态扩展基线），但只布防<strong>窗口级基线</strong>
 * （{@link TessellatorCaptureState#armWindowModelViewBaselineInverse}），<strong>不</strong>开启旧动态扩展相位
 * ——旧相位会触发 ModelRenderer display-list 改写/内联路径，把顶点写进未在绘制态的
 * {@code Tessellator.instance} 并令模型在屏幕上消失，违反纯观察。新通道下 ModelRenderer 保持原版行为，
 * 只有真实流经 Tessellator 的顶点被记录（经基线变换到窗口入口系）。
 * <p>
 * 纯观察论证：只开/关录窗 + 只读快照 GL_MODELVIEW（glGetFloat 是只读查询）；不改 distance 判定、
 * 不改 lightmap、不改分派表；录窗总开关未打开时零行为。
 */
@Mixin(TileEntityRendererDispatcher.class)
public abstract class MixinTesrDispatcherWindow {

    private static final float[] SDE_INV16 = new float[16];

    @Inject(method = "renderTileEntity", at = @At("HEAD"))
    private void sde$openTesrWindow(TileEntity te, float partialTicks, CallbackInfo ci) {
        if (!TessellatorCaptureState.areWindowsArmed() || te == null) {
            return;
        }
        TessellatorCaptureState.beginWindow(
            CaptureChannel.TESR,
            te.xCoord,
            te.yCoord,
            te.zCoord,
            te.getClass()
                .getSimpleName());
        if (CaptureModelViewDelta.snapshotInverseCurrentModelView(SDE_INV16)) {
            TessellatorCaptureState.armWindowModelViewBaselineInverse(SDE_INV16);
        }
    }

    @Inject(method = "renderTileEntity", at = @At("RETURN"))
    private void sde$closeTesrWindow(TileEntity te, float partialTicks, CallbackInfo ci) {
        if (!TessellatorCaptureState.areWindowsArmed()) {
            return;
        }
        TessellatorCaptureState.endWindow();
    }
}
