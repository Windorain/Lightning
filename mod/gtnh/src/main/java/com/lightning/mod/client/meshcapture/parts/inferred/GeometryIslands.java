package com.lightning.mod.client.meshcapture.parts.inferred;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;
import com.lightning.mod.client.meshcapture.parts.PartBox;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.6 几何推断的岛扩组核心 —— {@code web/src/pure/aabb.ts} 的 mod 侧 Java 移植
 * （契约 {@code format-parts-contract.md} §7.1 档 3、§4 inferred 行）。
 *
 * <p>
 * 移植对照（逐条）：
 * <ul>
 * <li>{@code DEFAULT_VERTEX_THRESHOLD = 0.01} → {@link #VERTEX_THRESHOLD}（共点/共边判定容差）；</li>
 * <li>标准四边形（4 顶点）→ 共享边（≥2 共点）<strong>单跳</strong>扩组
 * （{@code findEdgeAdjacentGroup}，L189–205：只扩一跳，防漏进相邻部件）→ {@link #partition} 标准分支。
 * mod 侧捕获产物恒为 4 顶点（{@code GL_TRIANGLES} 在录制层已展开为伪四边形 {@code (v0,v1,v2,v2)}），
 * 故"非标"判定 = 伪四边形探测（末两顶点共点）→ {@link #isStandard}；</li>
 * <li>三角面/非标 → 共点 BFS 扩<strong>整岛</strong>（{@code findConnectedQuadGroup}，L151–168）
 * → {@link #partition} 非标分支；</li>
 * <li>法线匹配 {@code dot > 0.999}（{@code findPartByNormal}，L228–260）→ {@link #NORMAL_MATCH_DOT}：
 * web 侧用于"命中面法线 → 候选四边形"定位，mod 侧导出无命中语义，移植落点为
 * <strong>退化（零面积）四边形剔除</strong>——法线长度 {@code < 1e-10} 的四边形不作为岛种子
 * （aabb.ts L237 同款跳过），避免零法线面把不相关几何黏成一岛；</li>
 * <li>{@code computeQuadsAABB}（L37–64）→ {@link Island#computeBox()}；</li>
 * <li>{@code ensureMinThickness}（L264–291，平面撑 0.1）→ {@link #ensureMinThickness}。</li>
 * </ul>
 *
 * <p>
 * <strong>已知误判（移植自 web 侧，交付说明必须声明）</strong>：贴合部件并一——凡共享顶点
 * （≤0.01）的四边形会被 BFS 并成同一"部件岛"；纯几何、无语义（不知道哪一岛是"线缆"）。
 *
 * <p>
 * 输入四边形顶点坐标 = <strong>0–1 方块局部 Y-up</strong>（捕获产物在
 * {@code TessellatorCaptureState.endBlock} 已归一化到块局部契约）。
 */
@SideOnly(Side.CLIENT)
final class GeometryIslands {

    /** 共点/共边判定容差（= aabb.ts DEFAULT_VERTEX_THRESHOLD）。 */
    static final double VERTEX_THRESHOLD = 0.01;
    /** 法线匹配阈值（= aabb.ts findPartByNormal 的 dot > 0.999）。 */
    static final double NORMAL_MATCH_DOT = 0.999;
    /** 零法线剔除阈值（= aabb.ts computeQuadNormal 的 len < 1e-10）。 */
    private static final double NORMAL_ZERO = 1.0E-10;
    /** 平面最小厚度（= aabb.ts MIN_THICKNESS）。 */
    static final double MIN_THICKNESS = 0.1;

    private GeometryIslands() {}

    /** 一个部件岛 = 一组四边形下标（输入顺序）。 */
    static final class Island {

        final List<Integer> quadIndices;

        Island(List<Integer> quadIndices) {
            this.quadIndices = quadIndices;
        }

        /**
         * 岛内全部顶点的 AABB（0–1 方块局部；未做 min-thickness）。
         * 每四边形先经 {@link AlphaTightener} 收紧到可见（非透明）区域——原版火把侧立面是
         * 撑满整格的 alpha 斜面，原始顶点盒 ≈ 整格毫无信息量（p16 实证，见 AlphaTightener 类注释）；
         * 不可收紧（无材质/UV 退化）的四边形回退原始顶点盒。
         */
        PartBox computeBox(List<QuadGeom> quads) {
            double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY, minZ = Double.POSITIVE_INFINITY;
            double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY, maxZ = Double.NEGATIVE_INFINITY;
            for (int idx : quadIndices) {
                QuadGeom q = quads.get(idx);
                double[] tight = AlphaTightener.tightenedBounds(q.verts, q.uv, q.materialKey);
                if (tight != null) {
                    if (tight[0] < minX) minX = tight[0];
                    if (tight[1] < minY) minY = tight[1];
                    if (tight[2] < minZ) minZ = tight[2];
                    if (tight[3] > maxX) maxX = tight[3];
                    if (tight[4] > maxY) maxY = tight[4];
                    if (tight[5] > maxZ) maxZ = tight[5];
                    continue;
                }
                for (int vi = 0; vi < 4; vi++) {
                    double[] v = q.verts[vi];
                    if (v[0] < minX) minX = v[0];
                    if (v[1] < minY) minY = v[1];
                    if (v[2] < minZ) minZ = v[2];
                    if (v[0] > maxX) maxX = v[0];
                    if (v[1] > maxY) maxY = v[1];
                    if (v[2] > maxZ) maxZ = v[2];
                }
            }
            return new PartBox(minX, minY, minZ, maxX, maxY, maxZ, PartBox.KIND_VISUAL);
        }
    }

    /** 内部四边形几何：4 顶点 xyz + sprite 局部 uv + 材质键 + 标准/非标 + 单位法线。 */
    static final class QuadGeom {

        final double[][] verts = new double[4][3];
        final double[][] uv = new double[4][2];
        final String materialKey;
        final boolean standard;
        final double[] normal;

        QuadGeom(double[][] verts, double[][] uv, String materialKey, boolean standard, double[] normal) {
            for (int i = 0; i < 4; i++) {
                this.verts[i] = verts[i];
                this.uv[i] = uv[i];
            }
            this.materialKey = materialKey;
            this.standard = standard;
            this.normal = normal;
        }
    }

    /**
     * 捕获产物 → 内部几何。伪四边形（三角展开，末两顶点共点）判为非标；零面积四边形法线为
     * {@code null}（岛种子剔除判据，调用方决定跳过还是保留）。UV 随顶点携带（sprite 局部 [0,1]，
     * 供 {@link AlphaTightener} 收紧 alpha 透明面；真实导出路径 UV 已被 attachMaterials 归一化，
     * 探针烘焙路径由 CellQuadBaker 同样归一化——两路径一致）。
     */
    static QuadGeom fromCaptured(CapturedQuad q) {
        double[][] verts = new double[4][3];
        double[][] uv = new double[4][2];
        List<CapturedVertex> src = q.vertices;
        for (int i = 0; i < 4; i++) {
            CapturedVertex v = src.get(Math.min(i, src.size() - 1));
            verts[i] = new double[] { v.x, v.y, v.z };
            uv[i] = new double[] { v.u, v.v };
        }
        // GL_TRIANGLES 展开为 (v0,v1,v2,v2) 伪四边形 ⇒ 末两顶点共点即非标（aabb.ts "vertices.length !== 4" 的移植）
        boolean standard = dist(verts[2], verts[3]) > VERTEX_THRESHOLD;
        return new QuadGeom(verts, uv, q.materialKey, standard, computeNormal(verts));
    }

    /** 叉积法线（首三顶点，= aabb.ts computeQuadNormal）；零面积 ⇒ null。 */
    private static double[] computeNormal(double[][] v) {
        double ax = v[1][0] - v[0][0], ay = v[1][1] - v[0][1], az = v[1][2] - v[0][2];
        double bx = v[2][0] - v[0][0], by = v[2][1] - v[0][1], bz = v[2][2] - v[0][2];
        double nx = ay * bz - az * by;
        double ny = az * bx - ax * bz;
        double nz = ax * by - ay * bx;
        double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < NORMAL_ZERO) {
            return null;
        }
        return new double[] { nx / len, ny / len, nz / len };
    }

    /** 法线匹配（= aabb.ts findPartByNormal 的 dot > 0.999 判据）。 */
    static boolean normalsMatch(double[] a, double[] b) {
        if (a == null || b == null) {
            return false;
        }
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > NORMAL_MATCH_DOT;
    }

    private static double dist(double[] a, double[] b) {
        double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** 共点（= aabb.ts quadsShareVertex）。 */
    private static boolean shareVertex(QuadGeom a, QuadGeom b) {
        for (double[] va : a.verts) {
            for (double[] vb : b.verts) {
                if (dist(va, vb) <= VERTEX_THRESHOLD) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 共边 = ≥2 共点（= aabb.ts quadsShareEdge）。 */
    private static boolean shareEdge(QuadGeom a, QuadGeom b) {
        int shared = 0;
        for (double[] va : a.verts) {
            for (double[] vb : b.verts) {
                if (dist(va, vb) <= VERTEX_THRESHOLD) {
                    shared++;
                    if (shared >= 2) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * 全部四边形分区为部件岛（aabb.ts {@code findPartFromHit} 的导出侧整格推广：web 从命中四边形扩一个
     * 部件，导出侧按输入顺序逐种子扩岛直到全覆盖——同一扩组规则，无新增语义）：
     * <ul>
     * <li>种子 = 标准四边形 ⇒ 岛 = 种子 + 与种子<strong>共边的标准四边形（单跳，不递归）</strong>；</li>
     * <li>种子 = 非标 ⇒ 岛 = 共点 BFS <strong>整岛</strong>（对任意四边形传递闭包）；</li>
     * <li>零法线退化四边形不作种子（aabb.ts L237 跳过）；全部退化 ⇒ 返回空列表（调用方走"无几何"兜底）。</li>
     * </ul>
     */
    static List<Island> partition(List<QuadGeom> quads) {
        List<Island> islands = new ArrayList<Island>();
        int n = quads.size();
        boolean[] visited = new boolean[n];
        for (int seed = 0; seed < n; seed++) {
            if (visited[seed] || quads.get(seed).normal == null) {
                continue;
            }
            List<Integer> group = new ArrayList<Integer>();
            if (quads.get(seed).standard) {
                // 标准：单跳共边扩组（aabb.ts findEdgeAdjacentGroup：种子 + 与种子共边的标准四边形）
                group.add(Integer.valueOf(seed));
                visited[seed] = true;
                for (int i = 0; i < n; i++) {
                    if (i == seed || visited[i]) {
                        continue;
                    }
                    if (!quads.get(i).standard) {
                        continue;
                    }
                    if (shareEdge(quads.get(seed), quads.get(i))) {
                        group.add(Integer.valueOf(i));
                        visited[i] = true;
                    }
                }
            } else {
                // 非标：共点 BFS 整岛（aabb.ts findConnectedQuadGroup）
                ArrayDeque<Integer> queue = new ArrayDeque<Integer>();
                queue.add(Integer.valueOf(seed));
                visited[seed] = true;
                while (!queue.isEmpty()) {
                    int cur = queue.poll()
                        .intValue();
                    group.add(Integer.valueOf(cur));
                    for (int i = 0; i < n; i++) {
                        if (visited[i]) {
                            continue;
                        }
                        if (shareVertex(quads.get(cur), quads.get(i))) {
                            visited[i] = true;
                            queue.add(Integer.valueOf(i));
                        }
                    }
                }
            }
            islands.add(new Island(group));
        }
        return islands;
    }

    /**
     * 平面撑厚（= aabb.ts ensureMinThickness）：任一轴厚度 ≈ 0 ⇒ 该轴绕中心各撑 {@code MIN_THICKNESS/2}。
     */
    static PartBox ensureMinThickness(PartBox box) {
        double[] min = { box.min[0], box.min[1], box.min[2] };
        double[] max = { box.max[0], box.max[1], box.max[2] };
        for (int i = 0; i < 3; i++) {
            double d = max[i] - min[i];
            if (d < 0.001) {
                double c = (min[i] + max[i]) / 2.0;
                min[i] = c - MIN_THICKNESS / 2.0;
                max[i] = c + MIN_THICKNESS / 2.0;
            }
        }
        return new PartBox(min, max, box.kind);
    }
}
