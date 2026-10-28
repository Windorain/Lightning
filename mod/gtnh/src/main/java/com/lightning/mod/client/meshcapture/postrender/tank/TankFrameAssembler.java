package com.lightning.mod.client.meshcapture.postrender.tank;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 末影储罐框架几何的<strong>纯函数装配层</strong>：模型顶点 → 方块局部四边形。
 * <p>
 * 这里只有显式输入、显式输出，不读 GL 状态、不碰 {@code Tessellator}、不做反射，因此可以脱离游戏单测。策略壳负责
 * "把模型数据按名字取出来"和"把结果写进捕获窗口"，本类负责中间那段可以算错的算术：顶点分组、朝向旋转、阀门旋转、
 * UV 偏移与方块原点平移。
 * <p>
 * <strong>与真渲染器等价的口径</strong>（逐条对应它的绘制次序）：
 * <ol>
 * <li>模型坐标先绕 Y 轴转 {@code -90 * (rotation + 2)} 度，再平移 {@code (+0.5, 0, +0.5)} 到方块空间，最后加世界角——
 * 对应 {@code glTranslated(x + 0.5, y, z + 0.5)} + {@code glRotatef(-90 * (rotation + 2), 0, 1, 0)}；</li>
 * <li>阀门多一段"绕 Z 轴、过点 (0, {@link #VALVE_PIVOT_Y}, 0)"的旋转，角度取当前静态角（不插值）——对应真渲染器在
 * 阀门绘制前的那对 {@code glTranslated} + {@code glRotatef(angle, 0, 0, 1)}；</li>
 * <li>按钮的 UV 按频率分色偏移，阀门按归属（owned）选 UV 档——对应 {@code UVTranslationButtons[colour]} 与
 * {@code UVTvalveOwned/NotOwned}。</li>
 * </ol>
 * <p>
 * <strong>三角形模型也在这里变成四边形</strong>：模型若是 {@code GL_TRIANGLES}（{@code vertexMode == 4}），每个三角形
 * 按捕获层既有口径展开成伪四边形 {@code (v0, v1, v2, v2)}。因此本类的输出与"真渲染器把同一份顶点写进 Tessellator"
 * 在捕获层的产物逐顶点相同，而不是另一种近似。
 */
public final class TankFrameAssembler {

    /** 阀门旋转中心的高度（模型空间，{@code 0.4165}）；与真渲染器的旋转中心同值。 */
    public static final double VALVE_PIVOT_Y = 0.4165;

    /** {@code GL_QUADS}：每 4 顶点一个面。 */
    public static final int VERTEX_MODE_QUADS = 7;

    /** {@code GL_TRIANGLES}：每 3 顶点一个面，捕获层展开为伪四边形。 */
    public static final int VERTEX_MODE_TRIANGLES = 4;

    /** 阀门 owned 档的 V 偏移（{@code 13/64}）；未归属档为 0。 */
    public static final double VALVE_OWNED_DV = 13.0 / 64.0;

    private TankFrameAssembler() {}

    /** 一个模型顶点：模型空间坐标 + 该模型自己的 UV。 */
    public static final class Vertex {

        public final double x;
        public final double y;
        public final double z;
        public final double u;
        public final double v;

        public Vertex(double x, double y, double z, double u, double v) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.u = u;
            this.v = v;
        }
    }

    /** 一个待写出的四边形：4 个顶点，已套用摆位与 UV 偏移；三角形来源的第 4 点与第 3 点重合。 */
    public static final class Quad {

        public final Vertex[] vertices;

        public Quad(Vertex[] vertices) {
            this.vertices = vertices;
        }
    }

    /** 一次摆放：朝向 + 阀门静态角 + 世界角。 */
    public static final class Placement {

        public final int rotation;
        public final double valveDegrees;
        public final int worldX;
        public final int worldY;
        public final int worldZ;

        public Placement(int rotation, double valveDegrees, int worldX, int worldY, int worldZ) {
            this.rotation = rotation;
            this.valveDegrees = valveDegrees;
            this.worldX = worldX;
            this.worldY = worldY;
            this.worldZ = worldZ;
        }
    }

    /**
     * 该顶点模式的顶点组大小：四边形 4、三角形 3、其它 0（不认识 ⇒ 调用方不得写出任何几何）。
     */
    public static int vertexGroupSize(int vertexMode) {
        if (vertexMode == VERTEX_MODE_QUADS) {
            return 4;
        }
        if (vertexMode == VERTEX_MODE_TRIANGLES) {
            return 3;
        }
        return 0;
    }

    /** 朝向角（度）：与真渲染器的 {@code glRotatef(-90 * (rotation + 2), 0, 1, 0)} 同式。 */
    public static double yawDegrees(int rotation) {
        return -90.0 * (rotation + 2);
    }

    /**
     * 按钮 UV 偏移：与真渲染器的 {@code UVTranslationButtons[colour]} 同式，其中 colour 是频率里对应那一位的颜色
     * （{@code freq} 从高到低每 4 位一枚按钮）。
     */
    public static double[] buttonUvOffset(int freq, int buttonIndex) {
        int colour = (freq >> (8 - 4 * buttonIndex)) & 0xF;
        return new double[] { 0.25 * (colour % 4), 0.25 * (colour / 4) };
    }

    /** 阀门 UV 偏移：owned → {@code (0, 13/64)}，否则 {@code (0, 0)}。 */
    public static double[] valveUvOffset(boolean owned) {
        return new double[] { 0.0, owned ? VALVE_OWNED_DV : 0.0 };
    }

    /**
     * 把一个模型的顶点按顶点组切成四边形，并套用摆位与 UV 偏移。
     *
     * @param valveSection {@code true} 表示这是会随阀门角旋转的那份模型
     * @return 四边形列表；顶点模式不认识时返回空列表（整段不产出）
     */
    public static List<Quad> assemble(Vertex[] verts, int vertexMode, Placement placement, boolean valveSection,
        double du, double dv) {
        int group = vertexGroupSize(vertexMode);
        if (verts == null || verts.length == 0 || group == 0 || placement == null) {
            return Collections.emptyList();
        }
        List<Quad> out = new ArrayList<Quad>(verts.length / group);
        for (int i = 0; i + group <= verts.length; i += group) {
            Vertex[] quad = new Vertex[4];
            for (int k = 0; k < group; k++) {
                quad[k] = place(verts[i + k], placement, valveSection, du, dv);
            }
            if (group == 3) {
                quad[3] = quad[2];
            }
            out.add(new Quad(quad));
        }
        return out;
    }

    /** 单个顶点：阀门旋转 → 朝向旋转 → 平移；UV 偏移按传入的 du/dv 加上。 */
    public static Vertex place(Vertex v, Placement placement, boolean valveSection, double du, double dv) {
        double x = v.x;
        double y = v.y;
        double z = v.z;
        if (valveSection) {
            double[] rotated = rotateAboutZ(x, y, z, placement.valveDegrees, VALVE_PIVOT_Y);
            x = rotated[0];
            y = rotated[1];
            z = rotated[2];
        }
        double[] yawed = rotateAboutY(x, y, z, yawDegrees(placement.rotation));
        return new Vertex(
            yawed[0] + 0.5 + placement.worldX,
            yawed[1] + placement.worldY,
            yawed[2] + 0.5 + placement.worldZ,
            v.u + du,
            v.v + dv);
    }

    /** 绕 Y 轴旋转（右手系，与 GL 的 {@code glRotatef(angle, 0, 1, 0)} 同向），角度单位为度。 */
    public static double[] rotateAboutY(double x, double y, double z, double degrees) {
        if (degrees == 0.0) {
            return new double[] { x, y, z };
        }
        double r = Math.toRadians(degrees);
        double cos = Math.cos(r);
        double sin = Math.sin(r);
        return new double[] { x * cos + z * sin, y, -x * sin + z * cos };
    }

    /** 绕过 {@code (0, pivotY, 0)} 的 Z 轴旋转（与 GL 的 {@code glRotatef(angle, 0, 0, 1)} 同向），角度单位为度。 */
    public static double[] rotateAboutZ(double x, double y, double z, double degrees, double pivotY) {
        if (degrees == 0.0) {
            return new double[] { x, y, z };
        }
        double r = Math.toRadians(degrees);
        double cos = Math.cos(r);
        double sin = Math.sin(r);
        double py = y - pivotY;
        return new double[] { x * cos - py * sin, x * sin + py * cos + pivotY, z };
    }
}
