package com.lightning.mod.client.meshcapture;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.util.ResourceLocation;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.meshcapture.finish.BlockCaptureFinishContext;
import com.lightning.mod.client.meshcapture.finish.BlockCaptureFinishRegistry;

import cpw.mods.fml.common.FMLLog;

/**
 * 录制 {@link Tessellator#addVertex}：按当前 {@link Tessellator} draw mode 组批——{@code GL_QUADS} 每 4 顶点一面；
 * {@code GL_TRIANGLES} 每 3 顶点一面，并展开为 Wiki 兼容的伪四边形 {@code (v0,v1,v2,v2)}。
 * <p>
 * <strong>导出契约（与 Wiki 一致）</strong>：{@link #endBlock} 写入的顶点为<strong>块局部</strong>，相对当前方块最小角
 * [0,1]³。变换两步：
 * <ol>
 * <li>减 Tessellator {@code setTranslation}：缓冲内 xyz = addVertex 入参 + (xOffset,yOffset,zOffset)（见 MCP Tessellator）。</li>
 * <li>按 {@link CaptureCoordinatePolicy}：默认路径下<strong>每个四边形</strong>在两种原点下对 {@code [0,1]³} 的贴近程度选原点：对该 quad 的顶点（已去
 * Tessellator
 * offset）分别尝试减 {@code (0,0,0)} 与减世界角 {@code (wx,wy,wz)}，取使「到单位立方惩罚和」更小者；平票时取 {@code (0,0,0)}。</li>
 * </ol>
 * 使用<strong>全局</strong> {@link Frame} 而非 {@link ThreadLocal}，以便 GTNH Angelica 等
 * {@code @ThreadSafeISBRH(perThread = true)} 在<strong>工作线程</strong>写入 Tessellator 时仍能命中录制状态。
 */
public final class TessellatorCaptureState {

    private static final Frame CAPTURE = new Frame();

    /** {@link net.minecraft.client.model.ModelRenderer#render} 当前 scale 参数，供 glCallList 内联路径使用 */
    private static volatile float activeModelRendererScale = 0.0625F;

    private static final double BOUNDS_ASSERT_LO = -0.06;

    private static final double BOUNDS_ASSERT_HI = 1.06;

    private static final boolean ASSERT_BLOCK_LOCAL_BOUNDS = Boolean
        .parseBoolean(System.getProperty("sde.assertBlockLocalBounds", "false"));

    private TessellatorCaptureState() {}

    public static boolean isRecording() {
        return CAPTURE.active;
    }

    /**
     * @param blockX/Y/Z      结构索引格（与 cellGrid 一致）
     * @param worldBlockX/Y/Z 该格对应的世界方块角坐标（整数）
     * @param captureBlock    当前烘焙的方块（可为 null，则策略仅依赖 registryKey/renderType）
     * @param registryKey     与 palette 一致，如 {@code minecraft:stone}
     */
    public static void beginBlock(int blockX, int blockY, int blockZ, String instanceLabel, int worldBlockX,
        int worldBlockY, int worldBlockZ, Block captureBlock, int blockMeta, int renderType, String registryKey) {
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            f.blockX = blockX;
            f.blockY = blockY;
            f.blockZ = blockZ;
            f.instanceLabel = instanceLabel;
            f.worldBlockX = worldBlockX;
            f.worldBlockY = worldBlockY;
            f.worldBlockZ = worldBlockZ;
            f.captureBlock = captureBlock;
            f.blockMeta = blockMeta;
            f.renderType = renderType;
            f.registryKey = registryKey != null ? registryKey : "";
            f.lastBoundTextureKey = "";
            f.quadsForBlock.clear();
            f.currentQuadVerts.clear();
            f.dynamicExtensionVertexRecording = false;
            f.dynamicExtensionInverseMvAtRenderStartValid = false;
            f.active = true;
        }
    }

    /**
     * 由 {@code TextureManager#bindTexture} mixin 在捕获激活时更新「当前 bind」；每个顶点在 {@link #onVertexRecorded} 时复制到
     * {@link CapturedVertex#textureBindHintAtVertex}，闭合四边形时再聚合为 {@link CapturedQuad#bindTextureHint}。
     */
    public static void noteTextureBind(ResourceLocation loc) {
        synchronized (CAPTURE) {
            if (!CAPTURE.active || loc == null) {
                return;
            }
            String dom = loc.getResourceDomain();
            if (dom == null || dom.isEmpty()) {
                dom = "minecraft";
            }
            String path = loc.getResourcePath();
            if (path == null) {
                path = "";
            }
            CAPTURE.lastBoundTextureKey = dom + ":" + MaterialKeyResolver.normalizeMaterialKey(path);
        }
    }

    /**
     * 仅在本帧 {@link #beginBlock} 激活且正在执行动态扩展顶点录制（如 {@code renderTileEntityAt}）时为 true。
     */
    public static void beginDynamicExtensionVertexPhase() {
        synchronized (CAPTURE) {
            if (CAPTURE.active) {
                CAPTURE.dynamicExtensionVertexRecording = true;
            }
        }
    }

    public static void endDynamicExtensionVertexPhase() {
        synchronized (CAPTURE) {
            CAPTURE.dynamicExtensionVertexRecording = false;
            CAPTURE.dynamicExtensionInverseMvAtRenderStartValid = false;
        }
    }

    /** 为 true 时 {@link net.minecraft.client.model.ModelRenderer} 走内联绘制，且 Tessellator 顶点做相对 MODELVIEW 变换。 */
    public static boolean isDynamicExtensionVertexRecording() {
        synchronized (CAPTURE) {
            return CAPTURE.active && CAPTURE.dynamicExtensionVertexRecording;
        }
    }

    /**
     * 动态扩展入口处的 {@code inv(GL_MODELVIEW)}（列主序 16 项），用于 {@code inv(M0) * M_now * v}。
     */
    public static void armDynamicPassModelViewBaselineInverse(float[] inverseColumnMajor16) {
        synchronized (CAPTURE) {
            if (CAPTURE.active && inverseColumnMajor16 != null && inverseColumnMajor16.length >= 16) {
                System.arraycopy(inverseColumnMajor16, 0, CAPTURE.dynamicExtensionInverseMvAtRenderStart, 0, 16);
                CAPTURE.dynamicExtensionInverseMvAtRenderStartValid = true;
            }
        }
    }

    public static boolean hasDynamicPassModelViewBaseline() {
        synchronized (CAPTURE) {
            return CAPTURE.active && CAPTURE.dynamicExtensionInverseMvAtRenderStartValid;
        }
    }

    public static void copyDynamicPassModelViewBaselineInverse(float[] outColumnMajor16) {
        synchronized (CAPTURE) {
            System.arraycopy(CAPTURE.dynamicExtensionInverseMvAtRenderStart, 0, outColumnMajor16, 0, 16);
        }
    }

    /** @deprecated 使用 {@link #beginDynamicExtensionVertexPhase()} */
    @Deprecated
    public static void beginTesrPostVertexPhase() {
        beginDynamicExtensionVertexPhase();
    }

    /** @deprecated 使用 {@link #endDynamicExtensionVertexPhase()} */
    @Deprecated
    public static void endTesrPostVertexPhase() {
        endDynamicExtensionVertexPhase();
    }

    /** @deprecated 使用 {@link #isDynamicExtensionVertexRecording()} */
    @Deprecated
    public static boolean isTesrPostRecording() {
        return isDynamicExtensionVertexRecording();
    }

    /** @deprecated 使用 {@link #armDynamicPassModelViewBaselineInverse(float[])} */
    @Deprecated
    public static void armTesrModelViewBaselineInverse(float[] inverseColumnMajor16) {
        armDynamicPassModelViewBaselineInverse(inverseColumnMajor16);
    }

    /** @deprecated 使用 {@link #hasDynamicPassModelViewBaseline()} */
    @Deprecated
    public static boolean hasTesrModelViewBaseline() {
        return hasDynamicPassModelViewBaseline();
    }

    /** @deprecated 使用 {@link #copyDynamicPassModelViewBaselineInverse(float[])} */
    @Deprecated
    public static void copyTesrModelViewBaselineInverse(float[] outColumnMajor16) {
        copyDynamicPassModelViewBaselineInverse(outColumnMajor16);
    }

    public static void setActiveModelRendererScale(float scale) {
        activeModelRendererScale = scale;
    }

    public static float getActiveModelRendererScale() {
        return activeModelRendererScale;
    }

    public static int currentBlockRecordedQuadCount() {
        synchronized (CAPTURE) {
            if (!CAPTURE.active) {
                return 0;
            }
            return CAPTURE.quadsForBlock.size();
        }
    }

    public static void endBlock(CapturedBlockInstance target) {
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            flushPartialQuad(f);
            BlockCaptureFinishRegistry.runAll(
                new BlockCaptureFinishContext(
                    f.registryKey,
                    f.captureBlock,
                    f.blockMeta,
                    f.renderType,
                    f.quadsForBlock));
            normalizeVerticesToBlockContract(f);
            f.active = false;
            target.x = f.blockX;
            target.y = f.blockY;
            target.z = f.blockZ;
            target.label = f.instanceLabel;
            target.quads.addAll(f.quadsForBlock);
            f.quadsForBlock.clear();
        }
    }

    private static void normalizeVerticesToBlockContract(Frame f) {
        if (f.quadsForBlock.isEmpty()) {
            return;
        }
        CaptureCoordinatePolicy.Kind kind = CaptureCoordinatePolicy
            .resolve(f.captureBlock, f.blockMeta, f.renderType, f.registryKey);

        List<CapturedQuad> rebuilt = new ArrayList<>(f.quadsForBlock.size());
        for (CapturedQuad q : f.quadsForBlock) {
            double[] origin = resolveOriginForQuad(q, f, kind);
            double ox = origin[0];
            double oy = origin[1];
            double oz = origin[2];
            List<CapturedVertex> nv = new ArrayList<>(4);
            for (CapturedVertex v : q.vertices) {
                double x0 = v.x - v.tessOffsetX;
                double y0 = v.y - v.tessOffsetY;
                double z0 = v.z - v.tessOffsetZ;
                double xf = x0 - ox;
                double yf = y0 - oy;
                double zf = z0 - oz;
                if (ASSERT_BLOCK_LOCAL_BOUNDS) {
                    assertBlockLocalVertex(f.registryKey, f.renderType, kind, xf, yf, zf);
                }
                nv.add(
                    new CapturedVertex(
                        xf,
                        yf,
                        zf,
                        v.u,
                        v.v,
                        v.brightness,
                        v.colorArgb,
                        0.0,
                        0.0,
                        0.0,
                        v.textureBindHintAtVertex));
            }
            CapturedQuad nq = new CapturedQuad(nv);
            nq.materialKey = q.materialKey;
            nq.samplerIndex = q.samplerIndex;
            nq.bindTextureHint = q.bindTextureHint;
            nq.materialAtlasKind = q.materialAtlasKind;
            nq.materialUsesStandaloneTexture = q.materialUsesStandaloneTexture;
            nq.fromDynamicExtensionPass = q.fromDynamicExtensionPass;
            rebuilt.add(nq);
        }
        f.quadsForBlock.clear();
        f.quadsForBlock.addAll(rebuilt);
    }

    /**
     * 坐标落在 {@code [0,1]} 内代价为 0，否则为到该区间边界的平方距离（可微、对称，便于比较两种原点）。
     */
    private static double unitIntervalPenalty(double t) {
        if (t < 0.0) {
            return t * t;
        }
        if (t > 1.0) {
            double e = t - 1.0;
            return e * e;
        }
        return 0.0;
    }

    /**
     * 对该 quad 各顶点在减 {@code (ox,oy,oz)} 后，累计到 {@code [0,1]³} 的偏离惩罚（越小越贴近块局部契约）。
     */
    private static double closenessCostToUnitCube(List<CapturedVertex> verts, double ox, double oy, double oz) {
        double cost = 0.0;
        for (CapturedVertex v : verts) {
            double x = v.x - v.tessOffsetX - ox;
            double y = v.y - v.tessOffsetY - oy;
            double z = v.z - v.tessOffsetZ - oz;
            cost += unitIntervalPenalty(x) + unitIntervalPenalty(y) + unitIntervalPenalty(z);
        }
        return cost;
    }

    /**
     * 为单个四边形选择减去的原点：在 {@code (0,0,0)} 与 {@code (wx,wy,wz)} 间取使 {@link #closenessCostToUnitCube} 更小者；平票取零原点。
     */
    private static double[] resolveOriginForQuad(CapturedQuad q, Frame f, CaptureCoordinatePolicy.Kind kind) {
        if (kind == CaptureCoordinatePolicy.Kind.ALREADY_BLOCK_LOCAL) {
            return new double[] { 0.0, 0.0, 0.0 };
        }
        double wx = f.worldBlockX;
        double wy = f.worldBlockY;
        double wz = f.worldBlockZ;
        double c0 = closenessCostToUnitCube(q.vertices, 0.0, 0.0, 0.0);
        double cw = closenessCostToUnitCube(q.vertices, wx, wy, wz);
        if (cw < c0) {
            return new double[] { wx, wy, wz };
        }
        return new double[] { 0.0, 0.0, 0.0 };
    }

    /**
     * 各顶点在 {@link #onVertexRecorded} 时快照的 bind；闭合四边形时聚合成 {@link CapturedQuad#bindTextureHint}（多数票，平票取顶点顺序先出现者）。
     */
    private static String aggregateBindHintsForQuad(List<CapturedVertex> verts) {
        if (verts.isEmpty()) {
            return "";
        }
        List<String> hints = new ArrayList<>(verts.size());
        for (CapturedVertex v : verts) {
            String h = v.textureBindHintAtVertex;
            hints.add(h != null ? h : "");
        }
        String h0 = hints.get(0);
        boolean allSame = true;
        for (String h : hints) {
            if (!h0.equals(h)) {
                allSame = false;
                break;
            }
        }
        if (allSame) {
            return h0;
        }
        Map<String, Integer> counts = new HashMap<>();
        for (String h : hints) {
            if (h.isEmpty()) {
                continue;
            }
            Integer n = counts.get(h);
            counts.put(h, n == null ? 1 : n + 1);
        }
        if (counts.isEmpty()) {
            return "";
        }
        int max = 0;
        for (int c : counts.values()) {
            max = Math.max(max, c);
        }
        for (String h : hints) {
            if (!h.isEmpty() && counts.get(h) == max) {
                return h;
            }
        }
        return "";
    }

    private static void assertBlockLocalVertex(String registryKey, int renderType, CaptureCoordinatePolicy.Kind kind,
        double x, double y, double z) {
        if (x < BOUNDS_ASSERT_LO || y < BOUNDS_ASSERT_LO
            || z < BOUNDS_ASSERT_LO
            || x > BOUNDS_ASSERT_HI
            || y > BOUNDS_ASSERT_HI
            || z > BOUNDS_ASSERT_HI) {
            FMLLog.warning(
                "[SDE] assertBlockLocalBounds: vertex (" + x
                    + ","
                    + y
                    + ","
                    + z
                    + ") outside [0,1] for "
                    + registryKey
                    + " renderType="
                    + renderType
                    + " kind="
                    + kind);
        }
    }

    public static void onVertexRecorded(double x, double y, double z, double u, double v, int brightness, int colorArgb,
        double tessOffsetX, double tessOffsetY, double tessOffsetZ, int tessellatorDrawMode) {
        synchronized (CAPTURE) {
            Frame fr = CAPTURE;
            if (!fr.active) {
                return;
            }
            String bindSnap = fr.lastBoundTextureKey != null ? fr.lastBoundTextureKey : "";
            CapturedVertex cv = new CapturedVertex(
                x,
                y,
                z,
                u,
                v,
                brightness,
                colorArgb,
                tessOffsetX,
                tessOffsetY,
                tessOffsetZ,
                bindSnap);
            fr.currentQuadVerts.add(cv);
            boolean triangleMode = tessellatorDrawMode == GL11.GL_TRIANGLES;
            int need = triangleMode ? 3 : 4;
            if (fr.currentQuadVerts.size() == need) {
                List<CapturedVertex> forQuad = new ArrayList<>(fr.currentQuadVerts);
                if (triangleMode) {
                    CapturedVertex c2 = forQuad.get(2);
                    forQuad.add(
                        new CapturedVertex(
                            c2.x,
                            c2.y,
                            c2.z,
                            c2.u,
                            c2.v,
                            c2.brightness,
                            c2.colorArgb,
                            c2.tessOffsetX,
                            c2.tessOffsetY,
                            c2.tessOffsetZ,
                            c2.textureBindHintAtVertex));
                }
                CapturedQuad cq = new CapturedQuad(forQuad);
                cq.bindTextureHint = aggregateBindHintsForQuad(forQuad);
                cq.fromDynamicExtensionPass = fr.dynamicExtensionVertexRecording;
                fr.quadsForBlock.add(cq);
                fr.currentQuadVerts.clear();
            }
        }
    }

    private static void flushPartialQuad(Frame f) {
        if (!f.currentQuadVerts.isEmpty()) {
            f.currentQuadVerts.clear();
        }
    }

    private static final class Frame {

        volatile boolean active;
        int blockX;
        int blockY;
        int blockZ;
        int worldBlockX;
        int worldBlockY;
        int worldBlockZ;
        String instanceLabel = "";
        Block captureBlock;
        int blockMeta;
        int renderType;
        String registryKey = "";
        /** 最近一次 {@link #noteTextureBind}；顶点录制时写入 {@link CapturedVertex#textureBindHintAtVertex} */
        String lastBoundTextureKey = "";
        /** {@link #beginDynamicExtensionVertexPhase} 与当前 {@link #beginBlock} 捕获块对齐 */
        boolean dynamicExtensionVertexRecording;
        final float[] dynamicExtensionInverseMvAtRenderStart = new float[16];
        boolean dynamicExtensionInverseMvAtRenderStartValid;
        final List<CapturedQuad> quadsForBlock = new ArrayList<>();
        final List<CapturedVertex> currentQuadVerts = new ArrayList<>();
    }

    public static final class CapturedVertex {

        public final double x;
        public final double y;
        public final double z;
        public final double u;
        public final double v;
        public final int brightness;
        /** 与 MC 1.7.10 Tessellator 小端一致：{@code alpha<<24|blue<<16|green<<8|red}（非 0xAARRGGBB 直观顺序） */
        public final int colorArgb;
        /** 录制该顶点时 Tessellator 的 x/y/zOffset；缓冲内坐标 = addVertex 入参 + offset */
        public final double tessOffsetX;
        public final double tessOffsetY;
        public final double tessOffsetZ;
        /**
         * 该顶点调用 {@link Tessellator#addVertex} 时，由 {@link #noteTextureBind} 记录下的最近一次 bind（与四边形
         * {@link CapturedQuad#bindTextureHint} 的聚合来源一致）。
         */
        public final String textureBindHintAtVertex;

        public CapturedVertex(double x, double y, double z, double u, double v, int brightness, int colorArgb,
            double tessOffsetX, double tessOffsetY, double tessOffsetZ, String textureBindHintAtVertex) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.u = u;
            this.v = v;
            this.brightness = brightness;
            this.colorArgb = colorArgb;
            this.tessOffsetX = tessOffsetX;
            this.tessOffsetY = tessOffsetY;
            this.tessOffsetZ = tessOffsetZ;
            this.textureBindHintAtVertex = textureBindHintAtVertex != null ? textureBindHintAtVertex : "";
        }
    }

    public static final class CapturedQuad {

        public final List<CapturedVertex> vertices;
        public String materialKey = "unknown";
        public int samplerIndex;
        /**
         * 由四顶点 {@link CapturedVertex#textureBindHintAtVertex} 聚合（多数票）；domain:path，path 已 normalize。
         */
        public String bindTextureHint = "";
        /**
         * 图集材质：与 {@code materialPalette[].atlas} 一致（{@code blocks} / {@code items}）；独立贴图时由采样器写
         * {@code atlas:null}，本字段可忽略。
         */
        public String materialAtlasKind = "blocks";
        /** {@link MaterialKeyResolver#applySpriteLocalToQuad}：材质来自非图集 bind，采样器不写 blocks 图集 */
        public boolean materialUsesStandaloneTexture;
        /** 四边形闭合时处于动态扩展顶点录制（{@link Frame#dynamicExtensionVertexRecording}） */
        public boolean fromDynamicExtensionPass;

        public CapturedQuad(List<CapturedVertex> vertices) {
            this.vertices = vertices;
        }
    }

    public static final class CapturedBlockInstance {

        public int x;
        public int y;
        public int z;
        public String label;
        public final List<CapturedQuad> quads = new ArrayList<>();
    }
}
