package com.lightning.mod.client.controlplane.mc.capture;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 投影偏移 tiling 的纯数值自检：网格（{@link TilePlan}）与像窗（{@link TileProjection}）。
 *
 * <h2>为什么值得单独钉死</h2>
 * r3 真机事故：机位 persp-tiled 声明 resolution 1920×1080、tile 2×2，真实窗口 854×480，
 * 执行器算出网格 2×2 而投影覆写自己又算了一遍算出 1×1，自检当场判失败（{@code CP-EXEC-001}）。
 * 根因是「同一件事算两遍、且输入不同源」，不是像素比不自洽。本测试用<b>事故输入本身</b>钉死
 * 「网格 = 2×2」，并按几何定义（整图的竖直视场 = 机位 fov / 正交视高，水平按整图宽高比推）独立验证
 * 每一片的像窗正好是它在整图里的那一格——不依赖被测实现自己的中间量。
 *
 * <p>
 * 这些都是纯计算类（不碰 GL/MC），能在无 LWJGL、无客户端的纯 JVM 单测里真跑，不像
 * {@code CameraSpecTest#projectionOffsetMath} 那样因 {@code Class.forName} 失败而 SKIP。
 */
public class TilePlanTest {

    /** 事故现场的真实窗口尺寸（真机日志：{@code 真实窗口 854x480}）。 */
    private static final int BASE_W = 854;

    private static final int BASE_H = 480;

    // ------------------------------------------------------------ 网格

    /**
     * 头号回归：854×480 窗口 + 1920×1080@2×2 声明 ⇒ 网格必须就是 2×2。
     *
     * <p>
     * 换算：单片 {@code 1920/2 × 1080/2 = 960×540}；像素比 {@code sx = 960/854 = 1.12412}、
     * {@code sy = 540/480 = 1.125}，两轴差 0.08% ⇒ {@code round(sy/sx) = 1} ⇒ 不追加划分。
     */
    @Test
    public void incidentInputKeepsDeclaredTwoByTwoGrid() {
        TilePlan plan = TilePlan.of(1920, 1080, 2, 2, BASE_W, BASE_H);
        assertEquals(2, plan.cols());
        assertEquals(2, plan.rows());
        assertEquals(2, plan.requestedCols());
        assertEquals(2, plan.requestedRows());
        assertEquals(960, plan.pieceWidth());
        assertEquals(540, plan.pieceHeight());
        assertEquals(4, plan.tileCount());
        assertTrue(plan.tiled());
        assertEquals("2x2", plan.describe());
    }

    /** 拼接结果逐像素对齐：各片像素之和 == resolution，且相邻片首尾相接（无重叠、无缺口）。 */
    @Test
    public void tilesCoverTheWholeResolutionExactly() {
        TilePlan plan = TilePlan.of(1920, 1080, 2, 2, BASE_W, BASE_H);
        long pixels = 0L;
        for (int row = 1; row <= plan.rows(); row++) {
            long rowPixels = 0L;
            for (int col = 1; col <= plan.cols(); col++) {
                pixels += (long) plan.spanX(col) * plan.spanY(row);
                rowPixels += plan.spanX(col);
                assertEquals(plan.spanX(col) * (col - 1), plan.offsetX(col));
            }
            assertEquals(1920L, rowPixels);
            assertEquals(plan.spanY(row) * (row - 1), plan.offsetY(row));
        }
        assertEquals(1920L * 1080L, pixels);
    }

    /** 余数归末列/末行：不能被网格整除时也不能丢像素（窗口与目标像素比 1:1 ⇒ 不触发追加）。 */
    @Test
    public void remainderGoesToTheLastColumnAndRow() {
        TilePlan plan = TilePlan.of(1000, 1000, 3, 3, 1000, 1000);
        assertEquals(3, plan.cols());
        assertEquals(3, plan.rows());
        assertEquals(333, plan.pieceWidth());
        assertEquals(333, plan.pieceHeight());
        assertEquals(333, plan.spanX(1));
        assertEquals(334, plan.spanX(3));
        assertEquals(334, plan.spanY(3));
        assertEquals(1000, plan.spanX(1) + plan.spanX(2) + plan.spanX(3));
        assertEquals(1000, plan.spanY(1) + plan.spanY(2) + plan.spanY(3));
        assertEquals(1000, plan.offsetX(3) + plan.spanX(3));
        assertEquals(1000, plan.offsetY(3) + plan.spanY(3));
    }

    /** 单轴追加：两轴像素比差得远时才切分（横切 4 段 / 竖切 10 段两条分支各验一次）。 */
    @Test
    public void axisMismatchAppendsSingleAxisSplits() {
        assertArrayEquals(new int[] { 1, 1 }, TilePlan.extraSplit(960, 540, BASE_W, BASE_H));
        assertArrayEquals(new int[] { 1, 10 }, TilePlan.extraSplit(500, 1000, 1000, 200));
        assertArrayEquals(new int[] { 4, 1 }, TilePlan.extraSplit(2000, 500, 1000, 1000));

        TilePlan vertical = TilePlan.of(500, 1000, 1, 1, 1000, 200);
        assertEquals(1, vertical.cols());
        assertEquals(10, vertical.rows());
        assertEquals(1, vertical.requestedCols());
        assertEquals(1, vertical.requestedRows());
        assertEquals(500, vertical.pieceWidth());
        assertEquals(100, vertical.pieceHeight());
        assertEquals(1000, 10 * vertical.spanY(1));

        TilePlan horizontal = TilePlan.of(2000, 500, 1, 1, 1000, 1000);
        assertEquals(4, horizontal.cols());
        assertEquals(1, horizontal.rows());
        assertEquals(500, horizontal.pieceWidth());
        assertEquals(500, horizontal.pieceHeight());
        assertEquals(2000, 4 * horizontal.spanX(1));
    }

    /** 不拼接的机位（r3 的 persp-main/ortho-top：1280×720@1×1）必须保持 1×1。 */
    @Test
    public void singleShotStaysSingle() {
        TilePlan plan = TilePlan.of(1280, 720, 1, 1, BASE_W, BASE_H);
        assertEquals(1, plan.cols());
        assertEquals(1, plan.rows());
        assertFalse(plan.tiled());
        assertEquals(1280, plan.spanX(1));
        assertEquals(720, plan.spanY(1));
        assertEquals(0, plan.offsetX(1));
        assertEquals(0, plan.offsetY(1));
    }

    // ------------------------------------------------------------ 像窗（透视）

    /**
     * 每一片的投影像窗必须<b>正好</b>是它在整图里的那一格。
     *
     * <p>
     * 期望值不取被测实现的中间量，而是按定义现算：整图竖直半视场 {@code tan(fov/2)}、水平半视场
     * {@code tan(fov/2)·targetW/targetH}；某格在整图 NDC 里占 {@code [u_lo,u_hi]×[v_lo,v_hi]}，
     * 则格角对应的视线在改造后的矩阵下必须落在视口边界 ±1，窗外视线必须越界。
     */
    @Test
    public void perspectiveTileWindowIsExactlyItsSlice() {
        int targetW = 1920;
        int targetH = 1080;
        double fov = 70.0d;
        TilePlan plan = TilePlan.ofGrid(targetW, targetH, 2, 2);
        double tanY = Math.tan(Math.toRadians(fov) / 2.0d);
        double tanX = tanY * targetW / (double) targetH;
        for (int row = 1; row <= plan.rows(); row++) {
            for (int col = 1; col <= plan.cols(); col++) {
                int bufW = plan.spanX(col);
                int bufH = plan.spanY(row);
                float[] m = perspectiveBase(fov, bufW, bufH);
                TileProjection.applyPerspectiveTile(m, plan, col, row, bufW, bufH);
                double[] u = ndcWindow(plan.offsetX(col), bufW, targetW);
                double[] v = ndcWindowY(plan.offsetY(row), bufH, targetH);
                double d = 1.0d;
                // 像窗四角 ⇔ 视口四边
                assertEquals(-1.0d, ndcX(m, u[0] * tanX * d, d), 1e-5d);
                assertEquals(1.0d, ndcX(m, u[1] * tanX * d, d), 1e-5d);
                assertEquals(-1.0d, ndcY(m, v[0] * tanY * d, d), 1e-5d);
                assertEquals(1.0d, ndcY(m, v[1] * tanY * d, d), 1e-5d);
                // 窗内任意点都在视口内
                for (int k = 0; k <= 4; k++) {
                    double t = k / 4.0d;
                    double xu = u[0] + (u[1] - u[0]) * t;
                    double yv = v[0] + (v[1] - v[0]) * t;
                    assertTrue(ndcX(m, xu * tanX * d, d) >= -1.0d - 1e-5d);
                    assertTrue(ndcX(m, xu * tanX * d, d) <= 1.0d + 1e-5d);
                    assertTrue(ndcY(m, yv * tanY * d, d) >= -1.0d - 1e-5d);
                    assertTrue(ndcY(m, yv * tanY * d, d) <= 1.0d + 1e-5d);
                }
                // 窗外的两侧都越界（挡住「放大方向搞反」「平移漏了整图中心那一半」这两类错图）
                assertTrue(ndcX(m, (u[0] - 0.2d) * tanX * d, d) < -1.0d);
                assertTrue(ndcX(m, (u[1] + 0.2d) * tanX * d, d) > 1.0d);
                assertTrue(ndcY(m, (v[0] - 0.2d) * tanY * d, d) < -1.0d);
                assertTrue(ndcY(m, (v[1] + 0.2d) * tanY * d, d) > 1.0d);
            }
        }
    }

    /** 像窗边界必须首尾相接：x 方向逐格拼满 [-1,1]，y 方向同理（顶行从 +1 往下）。 */
    @Test
    public void tileWindowsAreContiguous() {
        TilePlan plan = TilePlan.ofGrid(1920, 1080, 2, 2);
        double prevX = -1.0d;
        for (int col = 1; col <= plan.cols(); col++) {
            double[] u = ndcWindow(plan.offsetX(col), plan.spanX(col), plan.targetWidth());
            assertEquals(prevX, u[0], 0.0d);
            prevX = u[1];
        }
        assertEquals(1.0d, prevX, 0.0d);
        double prevY = 1.0d;
        for (int row = 1; row <= plan.rows(); row++) {
            double[] v = ndcWindowY(plan.offsetY(row), plan.spanY(row), plan.targetHeight());
            assertEquals(prevY, v[1], 0.0d);
            prevY = v[0];
        }
        assertEquals(-1.0d, prevY, 0.0d);
    }

    /** 1×1（分辨率覆写）必须不动矩阵：这条路径在真机上已验收通过，不能被 tiling 改造碰坏。 */
    @Test
    public void singleTileLeavesProjectionUntouched() {
        TilePlan plan = TilePlan.of(1280, 720, 1, 1, BASE_W, BASE_H);
        float[] m = perspectiveBase(70.0d, 1280, 720);
        float[] before = m.clone();
        double mag = TileProjection.applyPerspectiveTile(m, plan, 1, 1, 1280, 720);
        assertEquals(1.0d, mag, 1e-12d);
        assertArrayEquals(before, m, 0.0f);
    }

    // ------------------------------------------------------------ 像窗（正交）

    /**
     * 正交机位：像窗 == 整图里那一格，且位移是<b>常量</b>（w ≡ 1）。
     *
     * <p>
     * 这条同时是回归护栏：位移若误写进 {@code m[8]}/{@code m[9]}（乘 z 的那一列），
     * {@code m[8]·z} 会随景深线性漂移，画面被剪成梯形——{@code clipX} 在多档景深下的结果就会不一致。
     */
    @Test
    public void orthoTileWindowIsExactlyItsSlice() {
        int targetW = 1920;
        int targetH = 1080;
        double orthoHeight = 16.0d;
        double halfH = orthoHeight / 2.0d;
        double halfW = halfH * targetW / (double) targetH;
        TilePlan plan = TilePlan.ofGrid(targetW, targetH, 2, 2);
        for (int row = 1; row <= plan.rows(); row++) {
            for (int col = 1; col <= plan.cols(); col++) {
                int bufW = plan.spanX(col);
                int bufH = plan.spanY(row);
                float[] m = TileProjection.orthoMatrix(orthoHeight, bufW, bufH, 0.05d, 1000.0d);
                TileProjection.applyOrthoTile(m, plan, col, row, bufW, bufH);
                double[] u = ndcWindow(plan.offsetX(col), bufW, targetW);
                double[] v = ndcWindowY(plan.offsetY(row), bufH, targetH);
                // w 列必须保持「w ≡ 1」，z 列必须没有位移
                assertEquals(1.0d, (double) m[15], 0.0d);
                assertEquals(0.0d, (double) m[11], 0.0d);
                assertEquals(0.0d, (double) m[8], 0.0d);
                assertEquals(0.0d, (double) m[9], 0.0d);
                for (double z : new double[] { -0.5d, -50.0d, -900.0d }) {
                    assertEquals(-1.0d, orthoNdcX(m, u[0] * halfW, z), 1e-5d);
                    assertEquals(1.0d, orthoNdcX(m, u[1] * halfW, z), 1e-5d);
                    assertEquals(-1.0d, orthoNdcY(m, v[0] * halfH, z), 1e-5d);
                    assertEquals(1.0d, orthoNdcY(m, v[1] * halfH, z), 1e-5d);
                }
            }
        }
    }

    /** 1×1 正交（r3 的 ortho-top）同样是恒等变换。 */
    @Test
    public void singleOrthoTileLeavesMatrixUntouched() {
        TilePlan plan = TilePlan.of(1280, 720, 1, 1, BASE_W, BASE_H);
        float[] m = TileProjection.orthoMatrix(12.0d, 1280, 720, 0.05d, 1000.0d);
        float[] before = m.clone();
        double mag = TileProjection.applyOrthoTile(m, plan, 1, 1, 1280, 720);
        assertEquals(1.0d, mag, 1e-12d);
        assertArrayEquals(before, m, 0.0f);
    }

    /** 格位与 framebuffer 尺寸不符必须当场失败（宁可失败也不出一张格位对不上却看着正常的图）。 */
    @Test(expected = IllegalStateException.class)
    public void mismatchedBufferFails() {
        TilePlan plan = TilePlan.ofGrid(1920, 1080, 2, 2);
        float[] m = perspectiveBase(70.0d, 960, 540);
        TileProjection.applyPerspectiveTile(m, plan, 1, 1, 960, 500);
    }

    // ------------------------------------------------------------ 工具

    /** 列格位在整图 NDC 里的像窗 {@code [lo, hi]}（x 轴向右为正，与像素偏移同向）。 */
    private static double[] ndcWindow(int offsetPx, int spanPx, int target) {
        double lo = 2.0d * offsetPx / target - 1.0d;
        double hi = 2.0d * (offsetPx + spanPx) / target - 1.0d;
        return new double[] { lo, hi };
    }

    /**
     * 行格位在整图 NDC 里的像窗 {@code [lo, hi]}。
     *
     * <p>
     * 行号向下、GL 的 y 轴向上：第 1 行（顶行）占 NDC 的 {@code [1-2·span/H, 1]}，
     * 因此它与 {@link #ndcWindow} 相比多一处翻转（{@code lo} 是下边界、{@code hi} 是上边界）。
     */
    private static double[] ndcWindowY(int offsetPx, int spanPx, int target) {
        double hi = 1.0d - 2.0d * offsetPx / target;
        double lo = 1.0d - 2.0d * (offsetPx + spanPx) / target;
        return new double[] { lo, hi };
    }

    /** 原版 {@code Project.gluPerspective} 等价矩阵（只写验证需要的元素）。 */
    private static float[] perspectiveBase(double fovDeg, int bufferW, int bufferH) {
        double f = 1.0d / Math.tan(Math.toRadians(fovDeg) / 2.0d);
        double aspect = bufferW / (double) bufferH;
        float[] m = new float[16];
        m[0] = (float) (f / aspect);
        m[5] = (float) f;
        m[10] = -1.0f;
        m[11] = -1.0f;
        m[14] = -1.0f;
        m[15] = 0.0f;
        return m;
    }

    /** 透视 NDC：{@code clip.x = m[0]·x + m[8]·z}、{@code w = -z}（z = -d 在相机前方）。 */
    private static double ndcX(float[] m, double x, double d) {
        return m[0] * x / d - m[8];
    }

    /** 见 {@link #ndcX}。 */
    private static double ndcY(float[] m, double y, double d) {
        return m[5] * y / d - m[9];
    }

    /** 正交 NDC：{@code ndc.x = (m[0]·x + m[8]·z + m[12]·w) / (m[11]·z + m[15]·w)}。 */
    private static double orthoNdcX(float[] m, double x, double z) {
        return (m[0] * x + m[8] * z + m[12]) / (m[11] * z + m[15]);
    }

    /** 见 {@link #orthoNdcX}。 */
    private static double orthoNdcY(float[] m, double y, double z) {
        return (m[5] * y + m[9] * z + m[13]) / (m[11] * z + m[15]);
    }
}
