package com.lightning.mod.client.meshcapture;

import java.nio.FloatBuffer;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.util.vector.Matrix4f;
import org.lwjgl.util.vector.Vector4f;

/**
 * 「忠实复现捕获层」PR-1 的 MODELVIEW 基线逆变换数学（{@code inv(M0) * M_now * v}），供两个顶点录制
 * Mixin（{@code MixinTessellatorCapture} / {@code MixinDirectTessellatorCapture}）与 TESR 录窗
 * Mixin（{@code MixinTesrDispatcherWindow}）共用同一份实现。
 * <p>
 * 为什么存在：TESR 录窗期间流入的顶点处于「窗口开启帧」的 MODELVIEW 系（相机相对世界系）下，
 * 坐标还原沿用既有动态扩展基线机制（见 {@code TileEntitySpecialRendererPostRenderStrategy} 的用法），
 * 只是改为录窗生命周期接入。抽成共享类避免两个 Mixin 各抄一份矩阵数学。
 * <p>
 * 纯观察论证：只读 GL_MODELVIEW（{@code glGetFloat} 是只读查询），不写任何 GL 状态；
 * 矩阵数学在栈/静态缓冲上进行，不影响被渲染内容。
 * <p>
 * 线程假设：与 {@code MixinTessellatorCapture} 既有实现相同——渲染线程串行使用静态缓冲；
 * Angelica 工作线程并发录制时的隔离在 PR-2 编排层处理（本类不改变既有假设）。
 */
public final class CaptureModelViewDelta {

    private static final FloatBuffer MAT = BufferUtils.createFloatBuffer(16);
    private static final FloatBuffer TMP16 = BufferUtils.createFloatBuffer(16);
    private static final Matrix4f M_NOW = new Matrix4f();
    private static final Matrix4f M_INV_BASE = new Matrix4f();
    private static final Matrix4f M_DELTA = new Matrix4f();
    private static final Matrix4f M_INVERT_SRC = new Matrix4f();
    private static final Matrix4f M_INVERT_DST = new Matrix4f();
    private static final Vector4f VH = new Vector4f();

    private CaptureModelViewDelta() {}

    /**
     * 快照当前 GL_MODELVIEW 并求逆，输出列主序 16 项（供录窗开启时作为基线 {@code inv(M0)}）。
     *
     * @return false = 矩阵不可逆或快照失败（调用方应放弃基线并如实记录原始坐标）
     */
    public static boolean snapshotInverseCurrentModelView(float[] outColumnMajor16) {
        if (outColumnMajor16 == null || outColumnMajor16.length < 16) {
            return false;
        }
        try {
            MAT.clear();
            GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, MAT);
            MAT.rewind();
            M_INVERT_SRC.load(MAT);
            if (Matrix4f.invert(M_INVERT_SRC, M_INVERT_DST) == null) {
                return false;
            }
            TMP16.clear();
            M_INVERT_DST.store(TMP16);
            TMP16.flip();
            TMP16.get(outColumnMajor16);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * {@code v' = inv(M0) * M_now * v}：{@code invBaselineColumnMajor16} 是窗口开启时快照的基线逆，
     * {@code M_now} 是本调用时实时读取的 GL_MODELVIEW。坐标原地写回 {@code xyzInOut}（长度 ≥3）。
     * 与 {@code MixinTessellatorCapture} 既有动态扩展路径同一份数学（Matrix4f 列主序 load/mul/transform）。
     */
    public static void transformByBaselineDelta(float[] invBaselineColumnMajor16, double[] xyzInOut) {
        TMP16.clear();
        TMP16.put(invBaselineColumnMajor16);
        TMP16.flip();
        M_INV_BASE.load(TMP16);
        MAT.clear();
        GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, MAT);
        MAT.rewind();
        M_NOW.load(MAT);
        Matrix4f.mul(M_INV_BASE, M_NOW, M_DELTA);
        VH.set((float) xyzInOut[0], (float) xyzInOut[1], (float) xyzInOut[2], 1.0F);
        Matrix4f.transform(M_DELTA, VH, VH);
        xyzInOut[0] = VH.x;
        xyzInOut[1] = VH.y;
        xyzInOut[2] = VH.z;
    }
}
