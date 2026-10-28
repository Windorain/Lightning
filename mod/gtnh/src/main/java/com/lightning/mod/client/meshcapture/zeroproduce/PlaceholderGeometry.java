package com.lightning.mod.client.meshcapture.zeroproduce;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.util.IIcon;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;
import com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 占位几何：一个占满整格的立方体，六个面各自使用该方块那一面的图集贴图。
 * <p>
 * <strong>坐标口径：块局部 {@code [0,1]³}</strong>（不是 {@code 0..16}）。这不是风格选择——导出契约、逐格捕获的
 * 归一化（{@code TessellatorCaptureState#endBlock}）与前端的网格装配都按"1 格 = 1 单位"消费四边形顶点，
 * 写成 {@code 0..16} 会让占位方块画成 16 格大。<strong>不要"修正"成 0..16。</strong>
 * <p>
 * <strong>不复用录制通道</strong>：占位四边形直接构造为与录制产物同形的 {@link CapturedQuad}，不经过
 * {@code Tessellator} 录制。用"再渲染一次"去造占位会把判定与渲染耦合在一起，而占位恰好是"渲染救不回来"时的兜底。
 * <p>
 * <strong>纹理回退</strong>：容器类方块的 {@code getIcon} 可能返回空。此时改用图集的 missing 图标；
 * 连 missing 图标都取不到时仍然<strong>保留几何</strong>（UV 退化为整张贴图），并如实记下
 * {@link Result#textureSource()} = {@code no_atlas_coordinates}——退化到"无几何"等于又变回静默空气。
 */
@SideOnly(Side.CLIENT)
public final class PlaceholderGeometry {

    /** 面数：数组下标即 MC 的 side 编号（{@code ForgeDirection} 序号）。 */
    public static final int SIDE_COUNT = 6;

    /** 顶点色：白（占位的观感不在这里定，呈现层按 {@code renderMode} 决定怎么画）。 */
    private static final int WHITE_ARGB = 0xFFFFFFFF;

    /** 亮度：满亮度（与占位语义一致——它不代表真实光照，只是一个可见的记号）。 */
    private static final int DEFAULT_BRIGHTNESS = 0xF000F0;

    /**
     * 六个面的四角坐标（块局部 {@code [0,1]³}），顺序与 {@link #SIDE_UV_CORNER} 一一对应。
     * 面下标 = MC side：0 = -Y、1 = +Y、2 = -Z、3 = +Z、4 = -X、5 = +X。
     */
    private static final double[][][] SIDE_CORNERS = new double[][][] {
        // 0 -Y
        { { 0.0, 0.0, 1.0 }, { 0.0, 0.0, 0.0 }, { 1.0, 0.0, 0.0 }, { 1.0, 0.0, 1.0 } },
        // 1 +Y
        { { 1.0, 1.0, 1.0 }, { 1.0, 1.0, 0.0 }, { 0.0, 1.0, 0.0 }, { 0.0, 1.0, 1.0 } },
        // 2 -Z
        { { 0.0, 1.0, 0.0 }, { 0.0, 0.0, 0.0 }, { 1.0, 0.0, 0.0 }, { 1.0, 1.0, 0.0 } },
        // 3 +Z
        { { 0.0, 1.0, 1.0 }, { 0.0, 0.0, 1.0 }, { 1.0, 0.0, 1.0 }, { 1.0, 1.0, 1.0 } },
        // 4 -X
        { { 0.0, 1.0, 1.0 }, { 0.0, 1.0, 0.0 }, { 0.0, 0.0, 0.0 }, { 0.0, 0.0, 1.0 } },
        // 5 +X
        { { 1.0, 0.0, 1.0 }, { 1.0, 0.0, 0.0 }, { 1.0, 1.0, 0.0 }, { 1.0, 1.0, 1.0 } } };

    /**
     * 每个面的四角各自取矩形哪个角（0 = 左上(uMin,vMin)、1 = 右上(uMax,vMin)、2 = 右下(uMax,vMax)、
     * 3 = 左下(uMin,vMax)）。贴图的朝向观感由呈现层负责；此处只保证 UV 落在目标矩形内、四个角各用一次。
     */
    private static final int[][] SIDE_UV_CORNER = new int[][] { { 3, 2, 1, 0 }, { 0, 1, 2, 3 }, { 3, 2, 1, 0 },
        { 0, 1, 2, 3 }, { 3, 2, 1, 0 }, { 0, 1, 2, 3 } };

    private static final String MISSING_SPRITE_NAME = "missingno";

    private PlaceholderGeometry() {}

    /** 一个面在图集里的 UV 矩形（图集坐标，不是 sprite 局部坐标——材质解析会把它们换算成局部 [0,1]）。 */
    public static final class FaceUv {

        /** 整张贴图（图集坐标取不到时的退化值）。 */
        public static final FaceUv UNIT = new FaceUv(0.0D, 1.0D, 0.0D, 1.0D);

        public final double uMin;
        public final double uMax;
        public final double vMin;
        public final double vMax;

        public FaceUv(double uMin, double uMax, double vMin, double vMax) {
            this.uMin = Math.min(uMin, uMax);
            this.uMax = Math.max(uMin, uMax);
            this.vMin = Math.min(vMin, vMax);
            this.vMax = Math.max(vMin, vMax);
        }

        public static FaceUv of(IIcon icon) {
            if (icon == null) {
                return UNIT;
            }
            return new FaceUv(icon.getMinU(), icon.getMaxU(), icon.getMinV(), icon.getMaxV());
        }
    }

    /** 一份占位几何 + 它的纹理来源（落日志用，便于人一眼看出"为什么这块占位是 missing 图标"）。 */
    public static final class Result {

        private final List<CapturedQuad> quads;
        private final String textureSource;

        Result(List<CapturedQuad> quads, String textureSource) {
            this.quads = Collections.unmodifiableList(new ArrayList<CapturedQuad>(quads));
            this.textureSource = textureSource;
        }

        public List<CapturedQuad> quads() {
            return quads;
        }

        /** {@code block_icon} / {@code missing_sprite} / {@code no_atlas_coordinates}。 */
        public String textureSource() {
            return textureSource;
        }

        /** 纹理连图集坐标都没取到（几何仍保留）。 */
        public boolean textureFallbackMissing() {
            return "no_atlas_coordinates".equals(textureSource);
        }
    }

    /**
     * 按方块六面图标构造占位几何（方块侧调用）。
     *
     * @param block      该格的方块；{@code null} 时全部走 missing 图标
     * @param meta       该格的 meta（图标可能随 meta 变化）
     * @param textureMap 方块图集；{@code null} 时 UV 退化为整张贴图
     */
    public static Result forBlock(Block block, int meta, TextureMap textureMap) {
        IIcon[] icons = new IIcon[SIDE_COUNT];
        if (block != null) {
            for (int side = 0; side < SIDE_COUNT; side++) {
                try {
                    icons[side] = block.getIcon(side, meta);
                } catch (Throwable ignored) {
                    // 个别方块在缺少世界/渲染上下文时取图标会抛错：按"取不到"处理
                    icons[side] = null;
                }
            }
        }
        TextureAtlasSprite missing = missingSprite(textureMap);
        boolean usedMissing = false;
        boolean usedFallbackUv = false;
        FaceUv[] perSide = new FaceUv[SIDE_COUNT];
        for (int side = 0; side < SIDE_COUNT; side++) {
            IIcon sprite = icons[side];
            if (sprite == null && missing != null) {
                sprite = missing;
                usedMissing = true;
            }
            if (sprite != null) {
                perSide[side] = FaceUv.of(sprite);
            } else {
                perSide[side] = FaceUv.UNIT;
                usedFallbackUv = true;
            }
        }
        String source = usedFallbackUv ? "no_atlas_coordinates" : (usedMissing ? "missing_sprite" : "block_icon");
        return new Result(cubeQuads(perSide), source);
    }

    /**
     * 纯函数：按六个面的 UV 矩形构造立方体占位几何（块局部 {@code [0,1]³}，白色）。
     *
     * @param perSide 长度 >= 6 的面 UV 表（下标 = MC side）；元素 {@code null} 或数组过短时该面用整张贴图
     */
    public static List<CapturedQuad> cubeQuads(FaceUv[] perSide) {
        List<CapturedQuad> quads = new ArrayList<CapturedQuad>(SIDE_COUNT);
        for (int side = 0; side < SIDE_COUNT; side++) {
            FaceUv uv = perSide != null && side < perSide.length && perSide[side] != null ? perSide[side] : FaceUv.UNIT;
            double[][] corners = SIDE_CORNERS[side];
            int[] uvCorner = SIDE_UV_CORNER[side];
            List<CapturedVertex> vertices = new ArrayList<CapturedVertex>(4);
            for (int i = 0; i < 4; i++) {
                double[] p = corners[i];
                double[] t = rectCorner(uv, uvCorner[i]);
                vertices.add(
                    new CapturedVertex(
                        p[0],
                        p[1],
                        p[2],
                        t[0],
                        t[1],
                        DEFAULT_BRIGHTNESS,
                        WHITE_ARGB,
                        0.0D,
                        0.0D,
                        0.0D,
                        ""));
            }
            CapturedQuad quad = new CapturedQuad(vertices);
            quad.fromDynamicExtensionPass = false;
            quads.add(quad);
        }
        return quads;
    }

    private static double[] rectCorner(FaceUv uv, int corner) {
        switch (corner) {
            case 1:
                return new double[] { uv.uMax, uv.vMin };
            case 2:
                return new double[] { uv.uMax, uv.vMax };
            case 3:
                return new double[] { uv.uMin, uv.vMax };
            default:
                return new double[] { uv.uMin, uv.vMin };
        }
    }

    /** 图集的 missing 图标；取不到返回 {@code null}（调用方保留几何并降级 UV）。 */
    private static TextureAtlasSprite missingSprite(TextureMap textureMap) {
        if (textureMap == null) {
            return null;
        }
        try {
            TextureAtlasSprite direct = textureMap.getTextureExtry(MISSING_SPRITE_NAME);
            if (direct != null) {
                return direct;
            }
        } catch (Throwable ignored) {
            // 走下面的注册表兜底
        }
        if (textureMap instanceof TextureMapAccessor) {
            try {
                Map<String, TextureAtlasSprite> sprites = ((TextureMapAccessor) textureMap)
                    .sde$getMapRegisteredSprites();
                for (TextureAtlasSprite sprite : sprites.values()) {
                    if (sprite != null && MISSING_SPRITE_NAME.equals(sprite.getIconName())) {
                        return sprite;
                    }
                }
            } catch (Throwable ignored) {
                // 注册表不可读：按"取不到"处理
            }
        }
        return null;
    }
}
