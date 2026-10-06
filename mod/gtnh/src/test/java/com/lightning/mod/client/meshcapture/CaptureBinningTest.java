package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

/**
 * {@link CaptureBinning} 纯函数全边界：正负坐标、格边界、质心跨箱、残组（非法输入）。
 */
public class CaptureBinningTest {

    private static final double EPS = 1e-9;

    @Test
    public void binOfPositiveCoords() {
        assertEquals(0, CaptureBinning.binOf(0.0));
        assertEquals(0, CaptureBinning.binOf(0.5));
        assertEquals(0, CaptureBinning.binOf(0.9999999));
        assertEquals(1, CaptureBinning.binOf(1.0));
        assertEquals(15, CaptureBinning.binOf(15.99));
        assertEquals(16, CaptureBinning.binOf(16.0));
        assertEquals(1024, CaptureBinning.binOf(1024.3));
    }

    @Test
    public void binOfNegativeCoordsUsesMathFloorNotTruncation() {
        // 关键：-0.5 必须下取整到 -1（截断会错误给 0）
        assertEquals(-1, CaptureBinning.binOf(-0.5));
        assertEquals(-1, CaptureBinning.binOf(-0.0000001));
        assertEquals(-1, CaptureBinning.binOf(-1.0));
        assertEquals(-2, CaptureBinning.binOf(-1.0001));
        assertEquals(-16, CaptureBinning.binOf(-16.0));
        assertEquals(-17, CaptureBinning.binOf(-16.5));
        // -0.0 归 0 格
        assertEquals(0, CaptureBinning.binOf(-0.0));
    }

    @Test
    public void blockLocalIsVertexMinusBinCorner() {
        assertEquals(0.25, CaptureBinning.blockLocal(3.25), EPS);
        assertEquals(0.0, CaptureBinning.blockLocal(3.0), EPS);
        assertEquals(0.75, CaptureBinning.blockLocal(-0.25), EPS);
        assertEquals(0.0, CaptureBinning.blockLocal(-4.0), EPS);
        assertEquals(0.999999, CaptureBinning.blockLocal(7.999999), 1e-6);
    }

    @Test
    public void binOfPointCombinesAxesIndependently() {
        CaptureBinning.Bin b = CaptureBinning.binOfPoint(3.2, -0.1, 15.99);
        assertEquals(new CaptureBinning.Bin(3, -1, 15), b);
    }

    @Test
    public void binValueTypeEqualityAndHash() {
        assertEquals(new CaptureBinning.Bin(1, 2, 3), new CaptureBinning.Bin(1, 2, 3));
        assertEquals(new CaptureBinning.Bin(1, 2, 3).hashCode(), new CaptureBinning.Bin(1, 2, 3).hashCode());
        assertFalse(new CaptureBinning.Bin(1, 2, 3).equals(new CaptureBinning.Bin(1, 2, 4)));
        assertEquals("1,2,3", new CaptureBinning.Bin(1, 2, 3).toString());
    }

    @Test
    public void centroidBinAveragesThenFloors() {
        // 质心 (1.0, 0.5, -0.5) → (1, 0, -1)
        double[] xs = { 0.9, 1.1, 0.9, 1.1 };
        double[] ys = { 0.5, 0.5, 0.5, 0.5 };
        double[] zs = { -0.4, -0.4, -0.6, -0.6 };
        assertEquals(new CaptureBinning.Bin(1, 0, -1), CaptureBinning.centroidBin(xs, ys, zs));
    }

    @Test
    public void centroidBinExactBoundaryGoesToHigherBin() {
        // 质心恰好 8.0（格边界）→ floor(8.0) = 8
        double[] xs = { 7.5, 8.5 };
        double[] ys = { 0.0, 0.0 };
        double[] zs = { 0.0, 0.0 };
        assertEquals(new CaptureBinning.Bin(8, 0, 0), CaptureBinning.centroidBin(xs, ys, zs));
    }

    @Test
    public void spansMultipleBinsDetectsCrossingOnAnyAxis() {
        assertFalse(
            CaptureBinning
                .spansMultipleBins(new double[] { 3.1, 3.9 }, new double[] { 0.2, 0.8 }, new double[] { 5.0, 5.0 }));
        // x 跨 3/4
        assertTrue(
            CaptureBinning
                .spansMultipleBins(new double[] { 3.9, 4.1 }, new double[] { 0.2, 0.8 }, new double[] { 5.0, 5.0 }));
        // 仅 z 跨 -1/0
        assertTrue(
            CaptureBinning
                .spansMultipleBins(new double[] { 3.1, 3.9 }, new double[] { 0.2, 0.8 }, new double[] { -0.1, 0.1 }));
        // 单顶点不算跨箱
        assertFalse(CaptureBinning.spansMultipleBins(new double[] { 7.7 }, new double[] { 1.1 }, new double[] { 2.2 }));
    }

    @Test
    public void rejectsRaggedOrEmptyInput() {
        expectIllegal(new double[] {}, new double[] {}, new double[] {});
        expectIllegal(new double[] { 1.0 }, new double[] { 1.0, 2.0 }, new double[] { 1.0 });
        expectIllegal(null, new double[] { 1.0 }, new double[] { 1.0 });
    }

    private static void expectIllegal(double[] xs, double[] ys, double[] zs) {
        try {
            CaptureBinning.centroidBin(xs, ys, zs);
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // 预期
        }
        try {
            CaptureBinning.spansMultipleBins(xs, ys, zs);
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // 预期
        }
    }
}
