package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.gtnewhorizon.gtnhlib.client.renderer.DirectTessellator;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;
import com.lightning.mod.client.meshcapture.CaptureModelViewDelta;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 「忠实复现捕获层」1.0：GTNHLib {@link DirectTessellator} 通道的顶点录制。
 * <p>
 * 为什么存在：GTNHLib 的 {@code TessellatorRedirector} 把所有 {@code Tessellator.instance} GETSTATIC 改写为
 * {@code TessellatorManager.get()}；LP 管等几何经 {@code DirectTessellator.startCapturing()}（推 DirectTessellator
 * 上栈）流入，而 {@code DirectTessellator} <strong>覆写</strong> {@code addVertex}——覆写方法的调用不进入基类方法体，
 * 故 {@code MixinTessellatorCapture}（注入基类 {@code addVertex@TAIL}）对该通道天然不触发：
 * 这既是现行捕获的缺口，也保证了本 Mixin 与基类注入<strong>不可能重复计数</strong>（去重论证）。
 * <p>
 * 顶点数据提取（按 DirectTessellator 类实际结构，证据行号以 GTNHLib 源码为准）：
 * 它的存储不是 vanilla rawBuffer——{@code addVertex}（:145-159）把 {@code (float)(x+xOffset)} 等经
 * {@code VertexFormat.writeToBuffer0} 直接写进 native ByteBuffer；uv/color/brightness 是该顶点写入时从
 * <strong>继承自 Tessellator 的实例字段</strong>取的：{@code textureU/textureV}（{@code setTextureUV} :173-174 赋值）、
 * {@code color}（{@code setColorRGBA} :233 赋值）、{@code brightness}（{@code setBrightness} :248 赋值）、
 * {@code hasTexture/hasColor/hasBrightness}（各 setter 置位）。这些字段是基类私有字段，Mixin 0.8.5 的
 * {@code @Shadow} 只查目标类自身声明（实测跨类层次 shadow 直接 MixinApplyError 崩启动），故经
 * {@link MixinTessellatorVertexStateAccess}（打在基类上的只读访问器接口）读取，
 * 即可完整还原 vanilla 顶点五元组，无需下探 native 缓冲。缺失项：normal（导出契约不需要）。
 * <p>
 * 纯观察论证：只读实例字段与录窗状态，不触碰 format/writePtr/vertexCount，不调用
 * {@code TessellatorManager.startCapturing()}（推栈会改变返回给游戏的对象，已禁止）；录窗未打开时
 * 仅置一次性自检位（证明钩子活着），零其它行为。
 */
@Mixin(DirectTessellator.class)
public abstract class MixinDirectTessellatorCapture {

    private static final float[] SDE_INV_ARR = new float[16];

    private static final double[] SDE_XYZ = new double[3];

    @Inject(method = "addVertex", at = @At("TAIL"))
    private void sde$afterDirectAddVertex(double x, double y, double z, CallbackInfo ci) {
        // 一次性自检：任何 DirectTessellator 顶点到达即证明钩子生效（录窗外也置位；
        // 无 DirectTessellator 流量的会话保持 false，由探针负责把它升级为硬判据）
        CaptureDiagnostics.noteDirectTessellatorVertex();
        MixinTessellatorVertexStateAccess acc = (MixinTessellatorVertexStateAccess) this;
        if (!TessellatorCaptureState.isRecording() || !acc.sde$hasTexture()) {
            return;
        }
        double xOffset = acc.sde$xOffset();
        double yOffset = acc.sde$yOffset();
        double zOffset = acc.sde$zOffset();
        // DirectTessellator.addVertex 写入缓冲的是 (float)(x+offset)——按缓冲实际值记录（忠实复现）
        SDE_XYZ[0] = (float) (x + xOffset);
        SDE_XYZ[1] = (float) (y + yOffset);
        SDE_XYZ[2] = (float) (z + zOffset);
        if (TessellatorCaptureState.isModelViewTransformArmed()
            && TessellatorCaptureState.hasActiveModelViewBaseline()) {
            TessellatorCaptureState.copyActiveModelViewBaselineInverse(SDE_INV_ARR);
            CaptureModelViewDelta.transformByBaselineDelta(SDE_INV_ARR, SDE_XYZ);
        }
        double u = acc.sde$textureU();
        double v = acc.sde$textureV();
        int colorArgb = acc.sde$hasColor() ? acc.sde$color() : 0xFFFFFFFF;
        int brightness = acc.sde$hasBrightness() ? acc.sde$brightness() : 0;
        TessellatorCaptureState.onVertexRecorded(
            SDE_XYZ[0],
            SDE_XYZ[1],
            SDE_XYZ[2],
            u,
            v,
            brightness,
            colorArgb,
            xOffset,
            yOffset,
            zOffset,
            acc.sde$drawMode());
    }
}
