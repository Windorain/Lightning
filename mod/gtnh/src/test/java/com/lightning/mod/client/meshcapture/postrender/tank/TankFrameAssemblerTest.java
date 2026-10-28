package com.lightning.mod.client.meshcapture.postrender.tank;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Placement;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Quad;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Vertex;

/**
 * {@link TankFrameAssembler}：顶点分组、朝向/阀门旋转、UV 偏移与原点平移的算术。
 * <p>
 * 每条判据都对着真渲染器的同一式写（朝向 {@code -90*(rotation+2)}、阀门绕 Z 过 {@code y=0.4165}、按钮按频率取
 * {@code 0.25} 步长、阀门 owned 档 {@code 13/64}），因此这里红了通常意味着"复现的算术与渲染器不一致"，而不是断言写错。
 */
public class TankFrameAssemblerTest {

    private static final double EPS = 1e-9;

    @Test
    public void vertexGroupSizeFollowsTheGlMode() {
        assertEquals(4, TankFrameAssembler.vertexGroupSize(TankFrameAssembler.VERTEX_MODE_QUADS));
        assertEquals(3, TankFrameAssembler.vertexGroupSize(TankFrameAssembler.VERTEX_MODE_TRIANGLES));
        assertEquals(0, TankFrameAssembler.vertexGroupSize(0));
        assertEquals(0, TankFrameAssembler.vertexGroupSize(9));
    }

    @Test
    public void yawDegreesMatchesTheRendererRotationExpression() {
        assertEquals(-180.0, TankFrameAssembler.yawDegrees(0), EPS);
        assertEquals(-270.0, TankFrameAssembler.yawDegrees(1), EPS);
        assertEquals(-360.0, TankFrameAssembler.yawDegrees(2), EPS);
        assertEquals(-450.0, TankFrameAssembler.yawDegrees(3), EPS);
    }

    @Test
    public void triangleModelExpandsToPseudoQuadsWithDuplicatedThirdVertex() {
        Vertex[] verts = new Vertex[] { v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 0, 0), v(1, 1, 0), v(0, 1, 0) };
        List<Quad> quads = TankFrameAssembler
            .assemble(verts, TankFrameAssembler.VERTEX_MODE_TRIANGLES, placement(2, 0.0), false, 0.0, 0.0);
        assertEquals("两个三角形 → 两个伪四边形", 2, quads.size());
        for (Quad quad : quads) {
            assertEquals(4, quad.vertices.length);
            assertTrue("第 4 点必须与第 3 点重合（捕获层对三角形的既有展开口径）", quad.vertices[2] == quad.vertices[3]);
        }
    }

    @Test
    public void quadModelKeepsFourDistinctVertices() {
        Vertex[] verts = new Vertex[] { v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), v(0, 0, 1), v(1, 0, 1),
            v(1, 1, 1), v(0, 1, 1) };
        List<Quad> quads = TankFrameAssembler
            .assemble(verts, TankFrameAssembler.VERTEX_MODE_QUADS, placement(2, 0.0), false, 0.0, 0.0);
        assertEquals(2, quads.size());
        assertNotSame(quads.get(0).vertices[2], quads.get(0).vertices[3]);
    }

    @Test
    public void unknownVertexModeProducesNothing() {
        Vertex[] verts = new Vertex[] { v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0) };
        assertTrue(
            TankFrameAssembler.assemble(verts, 0, placement(2, 0.0), false, 0.0, 0.0)
                .isEmpty());
        assertTrue(
            TankFrameAssembler.assemble(verts, 9, placement(2, 0.0), false, 0.0, 0.0)
                .isEmpty());
        assertTrue(
            TankFrameAssembler
                .assemble(new Vertex[0], TankFrameAssembler.VERTEX_MODE_QUADS, placement(2, 0.0), false, 0.0, 0.0)
                .isEmpty());
    }

    @Test
    public void buttonUvOffsetReadsTheFreqNibblesHighToLow() {
        int freq = (10 << 8) | (5 << 4) | 3;
        double[] first = TankFrameAssembler.buttonUvOffset(freq, 0);
        assertEquals(0.25 * (10 % 4), first[0], EPS);
        assertEquals(0.25 * (10 / 4), first[1], EPS);
        double[] second = TankFrameAssembler.buttonUvOffset(freq, 1);
        assertEquals(0.25 * (5 % 4), second[0], EPS);
        assertEquals(0.25 * (5 / 4), second[1], EPS);
        double[] third = TankFrameAssembler.buttonUvOffset(freq, 2);
        assertEquals(0.25 * (3 % 4), third[0], EPS);
        assertEquals(0.0, third[1], EPS);
        double[] undyed = TankFrameAssembler.buttonUvOffset(0, 0);
        assertEquals(0.0, undyed[0], EPS);
        assertEquals(0.0, undyed[1], EPS);
    }

    @Test
    public void valveUvOffsetSelectsTheOwnedTier() {
        assertEquals(0.0, TankFrameAssembler.valveUvOffset(false)[0], EPS);
        assertEquals(0.0, TankFrameAssembler.valveUvOffset(false)[1], EPS);
        assertEquals(0.0, TankFrameAssembler.valveUvOffset(true)[0], EPS);
        assertEquals(13.0 / 64.0, TankFrameAssembler.valveUvOffset(true)[1], EPS);
    }

    @Test
    public void placeAppliesValveRotationThenYawThenBlockOrigin() {
        // 阀门角 90°：点 (0.1, 0.4165, 0) 绕 (0, 0.4165, 0) 的 Z 轴转到 (-0.0, 0.5165, 0)
        Placement identityYaw = placement(2, 90.0);
        Vertex placed = TankFrameAssembler
            .place(v(0.1, TankFrameAssembler.VALVE_PIVOT_Y, 0.0), identityYaw, true, 0.0, 0.0);
        assertEquals(0.5, placed.x, 1e-9);
        assertEquals(TankFrameAssembler.VALVE_PIVOT_Y + 0.1, placed.y, EPS);
        assertEquals(0.5, placed.z, 1e-9);

        // 同一顶点不走阀门旋转：保持原坐标
        Vertex unrotated = TankFrameAssembler
            .place(v(0.1, TankFrameAssembler.VALVE_PIVOT_Y, 0.0), identityYaw, false, 0.0, 0.0);
        assertEquals(0.6, unrotated.x, EPS);
        assertEquals(TankFrameAssembler.VALVE_PIVOT_Y, unrotated.y, EPS);
    }

    @Test
    public void placeHalfTurnsTheModelAroundTheBlockCentre() {
        // rotation 0 → 偏航 -180°：模型 x/z 取反
        Vertex placed = TankFrameAssembler.place(v(0.25, 0.5, -0.75), placement(0, 0.0), false, 0.0, 0.0);
        assertEquals(0.5 - 0.25, placed.x, EPS);
        assertEquals(0.5, placed.y, EPS);
        assertEquals(0.5 + 0.75, placed.z, EPS);

        // rotation 2 → 偏航 -360°：恒等
        Vertex same = TankFrameAssembler.place(v(0.25, 0.5, -0.75), placement(2, 0.0), false, 0.0, 0.0);
        assertEquals(0.75, same.x, EPS);
        assertEquals(0.5, same.y, EPS);
        assertEquals(-0.25, same.z, EPS);
    }

    @Test
    public void placeOffsetsUvAndAddsTheWorldCorner() {
        Placement far = new Placement(2, 0.0, 10, 20, 30);
        Vertex placed = TankFrameAssembler.place(v(0.0, 0.0, 0.0), far, false, 0.5, 0.25);
        assertEquals(10.5, placed.x, EPS);
        assertEquals(20.0, placed.y, EPS);
        assertEquals(30.5, placed.z, EPS);
        assertEquals(0.5, placed.u, EPS);
        assertEquals(0.25, placed.v, EPS);
    }

    private static Vertex v(double x, double y, double z) {
        return new Vertex(x, y, z, 0.0, 0.0);
    }

    private static Placement placement(int rotation, double valveDegrees) {
        return new Placement(rotation, valveDegrees, 0, 0, 0);
    }
}
