package com.lightning.mod.client.meshcapture.parts.inferred;

import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.client.Minecraft;
import net.minecraft.util.ResourceLocation;

import com.lightning.mod.client.export.ExportTextureLocator;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.6 档 3 的<strong>alpha 透明面收紧器</strong>（v2 拍板，决策记录）。
 *
 * <p>
 * <strong>背景（p16-run-1/2/3 实证）</strong>：原版 1.7.10 {@code renderTorchAtAngle} 的 4 个侧立面
 * 本身就是<strong>撑满整格的斜面四边形</strong>（如 x=0.4375 平面 y/z∈[0,1]），靠火把图标的
 * 透明像素 alpha 裁剪只显示中间细柱（+ 顶部火焰）；真实导出调色板里就是这些斜面（与探针烘焙
 * 逐顶点一致，已用绕过 {@code renderBlockByRenderType} 的直渲染对照组排除调度层注入）。
 * 因此"从烘焙几何推断盒"若直接取原始顶点 AABB，火把盒 ≈ 整格，既无信息又误导（契约 §7.3
 * 退化情形正是要避免这个）。
 *
 * <p>
 * <strong>解法</strong>：四边形顶点位置是其 UV 的仿射函数（ Tessellator 平面四边形性质）。
 * 用材质 PNG 的 alpha 掩码找出四边形实际<strong>可见</strong>的纹素区域（只统计四边形 UV 域
 * 覆盖的纹素——p16-run-5 实证：全图标统计会把 UV 域外纹素外推出盒），把这些纹素的位置角点
 * 反算回几何空间，得到有效 AABB（"视觉盒"语义与契约 §6.4 一致——盒用于悬停命中与统计，
 * 人眼可见的部分才是用户期望命中的部分）。已知留痕：
 * <ul>
 * <li>1.7.10 火把图标只有棍身纹素（火焰是粒子效果）⇒ 收紧后火把盒 = 棍柱（高 ≈0.625），
 * 正是契约 §7.3 期望的"真实小柱几何"；</li>
 * <li>半透明纹理（alpha&gt;阈值即算可见）与动画纹理（整条竖幅全帧并集）按保守处理（盒偏大不偏小）；</li>
 * <li>材质键未知 / UV 退化 / 像素不可得 ⇒ 返回 null，调用方回退原始顶点盒（永远不更糟）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
final class AlphaTightener {

    /** alpha &gt; 阈值算可见（保守：半透明也算可见，盒只会偏大不会偏小）。 */
    private static final int ALPHA_OPAQUE_THRESHOLD = 8;
    private static final int MASK_CACHE_MAX = 96;

    /** 材质键 → alpha 掩码（null 值 = 不可得，缓存负结果防重复 IO）。 */
    private static final Map<String, AlphaMask> MASK_CACHE = new LinkedHashMap<String, AlphaMask>(32, 0.75F, true) {

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, AlphaMask> eldest) {
            return size() > MASK_CACHE_MAX;
        }
    };

    private AlphaTightener() {}

    /** 一个材质的 alpha 掩码；width/height &lt;= 0 表示不可得。 */
    private static final class AlphaMask {

        final int width;
        final int height;
        final boolean[] opaque;

        AlphaMask(int width, int height, boolean[] opaque) {
            this.width = width;
            this.height = height;
            this.opaque = opaque;
        }

        static AlphaMask unavailable() {
            return new AlphaMask(0, 0, null);
        }

        boolean available() {
            return width > 0 && height > 0 && opaque != null;
        }
    }

    /**
     * 计算四边形的可见区域有效 AABB（块局部）。
     *
     * @param pos         4 顶点 xyz（{@code double[4][3]}，sprite-local UV 同序）
     * @param uv          4 顶点 uv（{@code double[4][2]}，已归一化为 sprite 局部 [0,1]）
     * @param materialKey 材质键（{@code CapturedQuad.materialKey}；null/unknown ⇒ 不可收紧）
     * @return {@code {minX,minY,minZ,maxX,maxY,maxZ}}；不可收紧 ⇒ {@code null}（调用方回退原始盒）
     */
    static double[] tightenedBounds(double[][] pos, double[][] uv, String materialKey) {
        if (materialKey == null || materialKey.isEmpty() || "unknown".equals(materialKey)) {
            return null;
        }
        AlphaMask mask = maskFor(materialKey);
        if (mask == null || !mask.available()) {
            return null;
        }

        // 位置 = UV 的仿射映射：P(u,v) = P0 + a*(u-u0) + b*(v-v0)，由前三个 UV 不共线的顶点解出
        int i0 = 0, i1 = 1, i2 = 2;
        double du1 = uv[i1][0] - uv[i0][0], dv1 = uv[i1][1] - uv[i0][1];
        double du2 = uv[i2][0] - uv[i0][0], dv2 = uv[i2][1] - uv[i0][1];
        double det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) < 1.0E-9 && pos.length >= 4) {
            // 伪四边形（三角）：v2==v3 时已用 v0/v1/v2；若仍退化，试 v0/v1/v3 组合之外的组合
            i2 = 3;
            du2 = uv[i2][0] - uv[i0][0];
            dv2 = uv[i2][1] - uv[i0][1];
            det = du1 * dv2 - du2 * dv1;
        }
        if (Math.abs(det) < 1.0E-9) {
            return null; // UV 退化（纯色四边形等）⇒ 不可收紧
        }
        double[] aCoef = new double[3];
        double[] bCoef = new double[3];
        for (int c = 0; c < 3; c++) {
            double e1 = pos[i1][c] - pos[i0][c];
            double e2 = pos[i2][c] - pos[i0][c];
            aCoef[c] = (e1 * dv2 - e2 * dv1) / det;
            bCoef[c] = (e2 * du1 - e1 * du2) / det;
        }
        double u0 = uv[i0][0], v0 = uv[i0][1];

        // 只统计四边形实际采样到的纹素（p16-run-5 实证：否则图标内四边形 UV 域之外的
        // 不透明纹素会被仿射映射外推出盒——火把顶盖 z 被错误拉到 1.0625）
        double uMin = Double.POSITIVE_INFINITY, uMax = Double.NEGATIVE_INFINITY;
        double vMin = Double.POSITIVE_INFINITY, vMax = Double.NEGATIVE_INFINITY;
        for (int vi = 0; vi < 4; vi++) {
            if (uv[vi][0] < uMin) uMin = uv[vi][0];
            if (uv[vi][0] > uMax) uMax = uv[vi][0];
            if (uv[vi][1] < vMin) vMin = uv[vi][1];
            if (uv[vi][1] > vMax) vMax = uv[vi][1];
        }

        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY, minZ = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY, maxZ = Double.NEGATIVE_INFINITY;
        boolean anyVisible = false;
        for (int ty = 0; ty < mask.height; ty++) {
            // 纹素行的 v 区间与四边形 UV 域无交 ⇒ 跳过
            double rowV0 = (double) ty / (double) mask.height;
            double rowV1 = (double) (ty + 1) / (double) mask.height;
            if (rowV1 < vMin - 1.0E-9 || rowV0 > vMax + 1.0E-9) {
                continue;
            }
            for (int tx = 0; tx < mask.width; tx++) {
                if (!mask.opaque[ty * mask.width + tx]) {
                    continue;
                }
                double colU0 = (double) tx / (double) mask.width;
                double colU1 = (double) (tx + 1) / (double) mask.width;
                if (colU1 < uMin - 1.0E-9 || colU0 > uMax + 1.0E-9) {
                    continue;
                }
                anyVisible = true;
                // 纹素 4 角（保证全可见四边形的盒与原始盒完全一致，不被纹素中心量化缩小）
                for (int cy = 0; cy <= 1; cy++) {
                    for (int cx = 0; cx <= 1; cx++) {
                        double u = (double) (tx + cx) / (double) mask.width;
                        double v = (double) (ty + cy) / (double) mask.height;
                        double px = pos[i0][0] + aCoef[0] * (u - u0) + bCoef[0] * (v - v0);
                        double py = pos[i0][1] + aCoef[1] * (u - u0) + bCoef[1] * (v - v0);
                        double pz = pos[i0][2] + aCoef[2] * (u - u0) + bCoef[2] * (v - v0);
                        if (px < minX) minX = px;
                        if (py < minY) minY = py;
                        if (pz < minZ) minZ = pz;
                        if (px > maxX) maxX = px;
                        if (py > maxY) maxY = py;
                        if (pz > maxZ) maxZ = pz;
                    }
                }
            }
        }
        if (!anyVisible) {
            return null; // 完全透明（不应发生）⇒ 回退原始盒
        }
        return new double[] { minX, minY, minZ, maxX, maxY, maxZ };
    }

    /** 材质键 → alpha 掩码（资源包 PNG 磁盘路径，与 TextureBlobEmbedder 同一优先序；带缓存）。 */
    private static AlphaMask maskFor(String materialKey) {
        synchronized (MASK_CACHE) {
            if (MASK_CACHE.containsKey(materialKey)) {
                return MASK_CACHE.get(materialKey);
            }
        }
        AlphaMask mask = loadMask(materialKey);
        synchronized (MASK_CACHE) {
            MASK_CACHE.put(materialKey, mask);
        }
        return mask;
    }

    private static AlphaMask loadMask(String materialKey) {
        try {
            String norm = ExportTextureLocator.normalizeLocatorForBundle(materialKey);
            if (norm == null) {
                return AlphaMask.unavailable();
            }
            if (norm.indexOf(':') < 0) {
                // 原版材质键无域（如 "torch_on"）：normalize 对无域输入原样返回，而
                // texturePngResourceLocationsForBundle 无域 ⇒ 空候选 ⇒ 掩码永不可得（p16-run-4 实证）。
                // 补 minecraft 域 + blocks/ 根（材质键即图标名，无显式纹理根）。
                norm = "minecraft:blocks/" + norm;
            }
            for (ResourceLocation rl : ExportTextureLocator.texturePngResourceLocationsForBundle(norm)) {
                if (rl == null) {
                    continue;
                }
                try (InputStream in = Minecraft.getMinecraft()
                    .getResourceManager()
                    .getResource(rl)
                    .getInputStream()) {
                    java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(in);
                    if (img == null) {
                        continue;
                    }
                    int w = img.getWidth();
                    int h = img.getHeight();
                    boolean[] opaque = new boolean[w * h];
                    for (int y = 0; y < h; y++) {
                        for (int x = 0; x < w; x++) {
                            int alpha = (img.getRGB(x, y) >>> 24) & 0xFF;
                            opaque[y * w + x] = alpha > ALPHA_OPAQUE_THRESHOLD;
                        }
                    }
                    return new AlphaMask(w, h, opaque);
                } catch (IOException | RuntimeException ignored) {
                    // 试下一个候选路径
                }
            }
        } catch (Throwable ignored) {
            // 掩码不可得 ⇒ 调用方回退原始盒
        }
        return AlphaMask.unavailable();
    }
}
