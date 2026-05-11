package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import java.nio.FloatBuffer;

import net.minecraft.client.renderer.Tessellator;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.util.vector.Matrix4f;
import org.lwjgl.util.vector.Vector4f;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * Records vertices into {@link TessellatorCaptureState} while a capture block is active.
 */
@Mixin(Tessellator.class)
public abstract class MixinTessellatorCapture {

    private static final FloatBuffer SDE_MODELVIEW_MAT = BufferUtils.createFloatBuffer(16);

    private static final FloatBuffer SDE_TMP16 = BufferUtils.createFloatBuffer(16);

    private static final float[] SDE_INV_ARR = new float[16];

    private static final Matrix4f SDE_INV_BASE = new Matrix4f();

    private static final Matrix4f SDE_NOW = new Matrix4f();

    private static final Matrix4f SDE_DELTA = new Matrix4f();

    private static final Vector4f SDE_VH = new Vector4f();

    @Shadow
    private int rawBufferIndex;

    @Shadow
    private int[] rawBuffer;

    @Shadow
    private boolean hasTexture;

    @Shadow
    private boolean hasBrightness;

    @Shadow
    private boolean hasColor;

    @Shadow
    private double xOffset;

    @Shadow
    private double yOffset;

    @Shadow
    private double zOffset;

    /** {@link Tessellator#startDrawing(int)} 写入；{@code GL_QUADS=7}、{@code GL_TRIANGLES=4}（LWJGL2） */
    @Shadow
    private int drawMode;

    @Inject(method = "addVertex", at = @At("TAIL"))
    private void sde$afterAddVertex(double x, double y, double z, CallbackInfo ci) {
        if (!TessellatorCaptureState.isRecording() || !this.hasTexture) {
            return;
        }
        int base = this.rawBufferIndex - 8;
        if (base < 0) {
            return;
        }
        double vx = Float.intBitsToFloat(this.rawBuffer[base]);
        double vy = Float.intBitsToFloat(this.rawBuffer[base + 1]);
        double vz = Float.intBitsToFloat(this.rawBuffer[base + 2]);
        if (TessellatorCaptureState.isDynamicExtensionVertexRecording()) {
            double preX = vx;
            double preY = vy;
            double preZ = vz;
            SDE_MODELVIEW_MAT.clear();
            GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, SDE_MODELVIEW_MAT);
            if (TessellatorCaptureState.hasDynamicPassModelViewBaseline()) {
                TessellatorCaptureState.copyDynamicPassModelViewBaselineInverse(SDE_INV_ARR);
                SDE_TMP16.clear();
                SDE_TMP16.put(SDE_INV_ARR);
                SDE_TMP16.flip();
                SDE_INV_BASE.load(SDE_TMP16);
                SDE_MODELVIEW_MAT.rewind();
                SDE_NOW.load(SDE_MODELVIEW_MAT);
                Matrix4f.mul(SDE_INV_BASE, SDE_NOW, SDE_DELTA);
                SDE_VH.set((float) vx, (float) vy, (float) vz, 1.0F);
                Matrix4f.transform(SDE_DELTA, SDE_VH, SDE_VH);
                vx = SDE_VH.x;
                vy = SDE_VH.y;
                vz = SDE_VH.z;
            } else {
                vx = linMvX(SDE_MODELVIEW_MAT, preX, preY, preZ);
                vy = linMvY(SDE_MODELVIEW_MAT, preX, preY, preZ);
                vz = linMvZ(SDE_MODELVIEW_MAT, preX, preY, preZ);
            }
        }
        double u = Float.intBitsToFloat(this.rawBuffer[base + 3]);
        double v = Float.intBitsToFloat(this.rawBuffer[base + 4]);
        int color = this.hasColor ? this.rawBuffer[base + 5] : 0xFFFFFFFF;
        int brightness = this.hasBrightness ? this.rawBuffer[base + 7] : 0;
        TessellatorCaptureState.onVertexRecorded(
            vx,
            vy,
            vz,
            u,
            v,
            brightness,
            color,
            this.xOffset,
            this.yOffset,
            this.zOffset,
            this.drawMode);
    }

    /** 列主序 MODELVIEW 之上 3x3；仅在未取到入口基线时兜底 */
    private static double linMvX(FloatBuffer m, double x, double y, double z) {
        return m.get(0) * x + m.get(4) * y + m.get(8) * z;
    }

    private static double linMvY(FloatBuffer m, double x, double y, double z) {
        return m.get(1) * x + m.get(5) * y + m.get(9) * z;
    }

    private static double linMvZ(FloatBuffer m, double x, double y, double z) {
        return m.get(2) * x + m.get(6) * y + m.get(10) * z;
    }
}
