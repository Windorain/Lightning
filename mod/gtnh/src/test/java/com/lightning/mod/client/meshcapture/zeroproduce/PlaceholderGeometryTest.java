package com.lightning.mod.client.meshcapture.zeroproduce;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;
import com.lightning.mod.client.meshcapture.zeroproduce.PlaceholderGeometry.FaceUv;
import com.lightning.mod.client.meshcapture.zeroproduce.PlaceholderGeometry.Result;

/**
 * {@link PlaceholderGeometry}：占位立方体的形状与 UV 落点。
 * <p>
 * 坐标口径是<strong>块局部 {@code [0,1]³}</strong>（1 格 = 1 单位）——这是导出契约与前端装配共用的口径，
 * 用 {@code 0..16} 会让占位方块画成 16 格大。本用例把这条口径钉住。
 */
public class PlaceholderGeometryTest {

    private static final double EPS = 1e-9;

    @Test
    public void cubeHasSixQuadsOfFourVerticesInsideTheUnitCube() {
        List<CapturedQuad> quads = PlaceholderGeometry.cubeQuads(null);
        assertEquals(PlaceholderGeometry.SIDE_COUNT, quads.size());
        for (CapturedQuad q : quads) {
            assertEquals(4, q.vertices.size());
            for (CapturedVertex v : q.vertices) {
                assertTrue("x 必须在 [0,1] 内：" + v.x, v.x >= -EPS && v.x <= 1.0 + EPS);
                assertTrue("y 必须在 [0,1] 内：" + v.y, v.y >= -EPS && v.y <= 1.0 + EPS);
                assertTrue("z 必须在 [0,1] 内：" + v.z, v.z >= -EPS && v.z <= 1.0 + EPS);
                assertEquals(0xFFFFFFFF, v.colorArgb);
                assertEquals(0.0D, v.tessOffsetX, EPS);
                assertEquals(0.0D, v.tessOffsetY, EPS);
                assertEquals(0.0D, v.tessOffsetZ, EPS);
                assertEquals("", v.textureBindHintAtVertex);
            }
        }
    }

    @Test
    public void everyFaceIsAFlatAxisAlignedSquareOfTheCube() {
        List<CapturedQuad> quads = PlaceholderGeometry.cubeQuads(null);
        for (int side = 0; side < quads.size(); side++) {
            CapturedQuad q = quads.get(side);
            CapturedVertex v0 = q.vertices.get(0);
            CapturedVertex v1 = q.vertices.get(1);
            CapturedVertex v2 = q.vertices.get(2);
            CapturedVertex v3 = q.vertices.get(3);
            // 每一面都必须有一个坐标在四个角上恒定，且恒定值为 0 或 1（占满整格）
            int flat = flatAxis(q);
            if (flat < 0) {
                throw new AssertionError("面 " + side + " 不在任一坐标平面上");
            }
            double plane = coordinate(v0, flat);
            assertTrue("面 " + side + " 的平面必须是 0 或 1：" + plane, Math.abs(plane) < EPS || Math.abs(plane - 1.0D) < EPS);
            assertEquals(plane, coordinate(v1, flat), EPS);
            assertEquals(plane, coordinate(v2, flat), EPS);
            assertEquals(plane, coordinate(v3, flat), EPS);
        }
    }

    @Test
    public void uvStaysInsideTheGivenSpriteRectAndUsesEachCornerOnce() {
        FaceUv uv = new FaceUv(0.25D, 0.5D, 0.75D, 1.0D);
        FaceUv[] perSide = new FaceUv[] { uv, uv, uv, uv, uv, uv };
        List<CapturedQuad> quads = PlaceholderGeometry.cubeQuads(perSide);
        for (CapturedQuad q : quads) {
            Set<String> corners = new HashSet<String>();
            for (CapturedVertex v : q.vertices) {
                assertTrue("u 必须落在 sprite 矩形内：" + v.u, v.u >= uv.uMin - EPS && v.u <= uv.uMax + EPS);
                assertTrue("v 必须落在 sprite 矩形内：" + v.v, v.v >= uv.vMin - EPS && v.v <= uv.vMax + EPS);
                corners.add(cornerKey(v, uv));
            }
            assertEquals("四个角各用一次（纹理不被压成一条线）", 4, corners.size());
        }
    }

    @Test
    public void faceUvNormalizesSwappedBoundsAndToleratesMissingIcon() {
        FaceUv uv = new FaceUv(0.6D, 0.2D, 0.9D, 0.1D);
        assertEquals(0.2D, uv.uMin, EPS);
        assertEquals(0.6D, uv.uMax, EPS);
        assertEquals(0.1D, uv.vMin, EPS);
        assertEquals(0.9D, uv.vMax, EPS);
        assertSame(FaceUv.UNIT, FaceUv.of(null));
    }

    @Test
    public void quadsForBlockWithoutIconsStillCarryGeometry() {
        // 没有方块、没有图集：几何仍必须存在（退化到"无几何"等于又变回静默空气）
        Result result = PlaceholderGeometry.forBlock(null, 0, null);
        assertEquals(
            PlaceholderGeometry.SIDE_COUNT,
            result.quads()
                .size());
        assertTrue(result.textureFallbackMissing());
        assertEquals("no_atlas_coordinates", result.textureSource());
    }

    @Test
    public void placeholderQuadsAreNotMarkedAsDynamicPassGeometry() {
        List<CapturedQuad> quads = PlaceholderGeometry.cubeQuads(null);
        for (CapturedQuad q : quads) {
            assertFalse(q.fromDynamicExtensionPass);
            assertEquals("", q.bindTextureHint);
        }
    }

    private static int flatAxis(CapturedQuad q) {
        for (int axis = 0; axis < 3; axis++) {
            double first = coordinate(q.vertices.get(0), axis);
            boolean allSame = true;
            for (CapturedVertex v : q.vertices) {
                if (Math.abs(coordinate(v, axis) - first) > EPS) {
                    allSame = false;
                    break;
                }
            }
            if (allSame) {
                return axis;
            }
        }
        return -1;
    }

    private static double coordinate(CapturedVertex v, int axis) {
        return axis == 0 ? v.x : (axis == 1 ? v.y : v.z);
    }

    private static String cornerKey(CapturedVertex v, FaceUv uv) {
        return (Math.abs(v.u - uv.uMin) < EPS ? "L" : "R") + (Math.abs(v.v - uv.vMin) < EPS ? "T" : "B");
    }
}
