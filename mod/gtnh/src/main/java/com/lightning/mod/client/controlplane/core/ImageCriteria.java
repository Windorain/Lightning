package com.lightning.mod.client.controlplane.core;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 图像判据的两个算子（case-file.md §5，PR-2）：{@code image-size-equals} 与 {@code image-not-uniform}。
 *
 * <h2>为什么放在 core</h2>
 * 两个算子只读 run 目录里的 PNG，用 JDK 的 {@code javax.imageio}——没有 MC 依赖，因此可以在
 * 纯 JVM 单测里用程序生成的 PNG 夹具覆盖（纯色图必须红、噪声图必须绿）。渲染侧的可信度最终靠
 * 这两条判据守住：截图「失败也可能返回非 null」这类坑，判据是最后一道防线。
 *
 * <h2>两条判据的分工</h2>
 * <ul>
 * <li>{@code image-size-equals}：只读 PNG 头（{@link ImageReader#getWidth(int)}），不解码像素——
 * 分辨率覆写/拼接是否真的生效，用它断言；</li>
 * <li>{@code image-not-uniform}：解码像素后统计主色占比，占比 ≥ 阈值即判红——防黑屏/全白
 * 「假图」（渲染崩了、相机埋在方块里、framebuffer 没内容时都会得到纯色图）。</li>
 * </ul>
 *
 * <p>
 * 两个算子返回 {@code {verdict, detail}}（{@link CriteriaEngine.Verdicts} 的取值），由
 * {@link CriteriaEngine} 原样并入判据结论——判据的 red/green/error 语义因此只有一处定义。
 */
public final class ImageCriteria {

    /** 判据类型：尺寸相等。 */
    public static final String TYPE_IMAGE_SIZE_EQUALS = "image-size-equals";

    /** 判据类型：非纯色。 */
    public static final String TYPE_IMAGE_NOT_UNIFORM = "image-not-uniform";

    /** {@code maxSameColorRatio} 默认值（case-file.md §5）。 */
    public static final double DEFAULT_MAX_SAME_COLOR_RATIO = 0.98d;

    /** 全图逐像素统计的像素数上限：超过则转网格采样（防大图判据拖住 tick 线程）。 */
    public static final long MAX_FULL_SCAN_PIXELS = 4L * 1024L * 1024L;

    private ImageCriteria() {}

    /** {@code image-size-equals} 的结果。 */
    public static final class SizeResult {

        /** 实际宽度；不可读时 -1。 */
        public final int width;

        /** 实际高度；不可读时 -1。 */
        public final int height;

        /** 读头成功与否（文件缺失/不是 PNG → false）。 */
        public final boolean readable;

        /** 失败原因（readable 为 true 时为 null）。 */
        public final String error;

        SizeResult(int width, int height, boolean readable, String error) {
            this.width = width;
            this.height = height;
            this.readable = readable;
            this.error = error;
        }
    }

    /** {@code image-not-uniform} 的结果。 */
    public static final class UniformityResult {

        /** 总参与统计的像素数。 */
        public final int sampled;

        /** 主色像素数。 */
        public final int dominantCount;

        /** 主色 ARGB 值。 */
        public final int dominantColor;

        /** 主色占比（0..1）。 */
        public final double dominantRatio;

        /** 采样策略说明（写进 detail，判据结论可自证口径）。 */
        public final String strategy;

        /** 解码成功与否。 */
        public final boolean readable;

        /** 失败原因（readable 为 true 时为 null）。 */
        public final String error;

        UniformityResult(int sampled, int dominantCount, int dominantColor, double dominantRatio, String strategy,
            boolean readable, String error) {
            this.sampled = sampled;
            this.dominantCount = dominantCount;
            this.dominantColor = dominantColor;
            this.dominantRatio = dominantRatio;
            this.strategy = strategy;
            this.readable = readable;
            this.error = error;
        }
    }

    /**
     * 只读 PNG 头取尺寸（不解码全图）。
     *
     * @param file 目标文件；不存在/不是图像时 {@code readable=false} 且 {@code error} 说明原因
     */
    public static SizeResult size(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return new SizeResult(-1, -1, false, "产物不存在");
        }
        ImageInputStream in = null;
        try {
            in = ImageIO.createImageInputStream(file.toFile());
            if (in == null) {
                return new SizeResult(-1, -1, false, "无法打开图像输入流（ImageIO 无可用读取器？）");
            }
            Iterator<ImageReader> it = ImageIO.getImageReaders(in);
            if (it == null || !it.hasNext()) {
                return new SizeResult(-1, -1, false, "不是 ImageIO 能识别的图像格式（期望 PNG）");
            }
            ImageReader reader = it.next();
            try {
                reader.setInput(in, true, true);
                return new SizeResult(reader.getWidth(0), reader.getHeight(0), true, null);
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            return new SizeResult(-1, -1, false, "读取图像头失败: " + e.getMessage());
        } catch (RuntimeException e) {
            return new SizeResult(-1, -1, false, "读取图像头异常: " + e);
        } finally {
            closeQuietly(in);
        }
    }

    /**
     * 统计主色占比（{@code image-not-uniform} 的核心）。
     *
     * <p>
     * 像素数 ≤ {@link #MAX_FULL_SCAN_PIXELS} 时逐像素统计；超过时按网格采样
     * （步长 {@code round(sqrt(像素数/上限))}，避免读满一张 8K 图）。无论走哪条路径，
     * {@code strategy} 都会记录实际口径并落进判据 detail。
     */
    public static UniformityResult uniformity(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return new UniformityResult(0, 0, 0, 0.0d, "n/a", false, "产物不存在");
        }
        BufferedImage img;
        try (InputStream in = Files.newInputStream(file)) {
            img = ImageIO.read(in);
        } catch (IOException e) {
            return new UniformityResult(0, 0, 0, 0.0d, "n/a", false, "解码图像失败: " + e.getMessage());
        } catch (RuntimeException e) {
            return new UniformityResult(0, 0, 0, 0.0d, "n/a", false, "解码图像异常: " + e);
        }
        if (img == null) {
            return new UniformityResult(0, 0, 0, 0.0d, "n/a", false, "不是 ImageIO 能解码的图像（期望 PNG）");
        }
        int w = img.getWidth();
        int h = img.getHeight();
        if (w <= 0 || h <= 0) {
            return new UniformityResult(0, 0, 0, 0.0d, "n/a", false, "图像尺寸非法: " + w + "x" + h);
        }
        Map<Integer, int[]> counts = new HashMap<Integer, int[]>();
        long pixels = (long) w * (long) h;
        String strategy;
        if (pixels <= MAX_FULL_SCAN_PIXELS) {
            strategy = "full-scan " + w + "x" + h + " (" + pixels + " px)";
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    tally(counts, img.getRGB(x, y));
                }
            }
        } else {
            int step = (int) Math.max(1L, Math.round(Math.sqrt(pixels / (double) MAX_FULL_SCAN_PIXELS)));
            strategy = "grid-sampling step=" + step + " of " + w + "x" + h + " (" + pixels + " px)";
            for (int y = 0; y < h; y += step) {
                for (int x = 0; x < w; x += step) {
                    tally(counts, img.getRGB(x, y));
                }
            }
        }
        int sampled = 0;
        int bestColor = 0;
        int bestCount = 0;
        for (Map.Entry<Integer, int[]> e : counts.entrySet()) {
            int n = e.getValue()[0];
            sampled += n;
            if (n > bestCount) {
                bestCount = n;
                bestColor = e.getKey()
                    .intValue();
            }
        }
        double ratio = sampled == 0 ? 0.0d : bestCount / (double) sampled;
        return new UniformityResult(sampled, bestCount, bestColor, ratio, strategy, true, null);
    }

    /**
     * {@code image-size-equals} 求值。
     *
     * @param params {@code {path,width,height}}
     * @return {@code {verdict, detail}}
     */
    public static JsonObject evaluateSize(JsonObject params) {
        String path = Json.optString(params, "path", null);
        if (path == null || path.trim()
            .isEmpty()) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "缺少 params.path");
        }
        Long width = integral(params, "width");
        Long height = integral(params, "height");
        if (width == null || height == null) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "params.width/height 必填且须为正整数");
        }
        if (width.longValue() <= 0L || height.longValue() <= 0L) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "params.width/height 须为正整数（收到 " + width + "x" + height + "）");
        }
        SizeResult r = size(resolve(path));
        if (!r.readable) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "无法读取图像尺寸: " + r.error + "（" + path + "）");
        }
        if (r.width != width.longValue() || r.height != height.longValue()) {
            return verdict(
                CriteriaEngine.Verdicts.RED,
                "图像尺寸不符: " + path + " 期望 " + width + "x" + height + "，实际 " + r.width + "x" + r.height);
        }
        return verdict(CriteriaEngine.Verdicts.GREEN, "图像尺寸符合: " + path + " = " + r.width + "x" + r.height);
    }

    /**
     * {@code image-not-uniform} 求值。
     *
     * @param params {@code {path,maxSameColorRatio?}}
     * @return {@code {verdict, detail}}
     */
    public static JsonObject evaluateNotUniform(JsonObject params) {
        String path = Json.optString(params, "path", null);
        if (path == null || path.trim()
            .isEmpty()) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "缺少 params.path");
        }
        double maxRatio = DEFAULT_MAX_SAME_COLOR_RATIO;
        JsonElement ratioEl = Json.get(params, "maxSameColorRatio");
        if (ratioEl != null) {
            if (!ratioEl.isJsonPrimitive() || !ratioEl.getAsJsonPrimitive()
                .isNumber()) {
                return verdict(CriteriaEngine.Verdicts.ERROR, "params.maxSameColorRatio 须为数值");
            }
            double v = ratioEl.getAsDouble();
            if (Double.isNaN(v) || Double.isInfinite(v) || v < 0.0d || v > 1.0d) {
                return verdict(CriteriaEngine.Verdicts.ERROR, "params.maxSameColorRatio 须在 0..1，收到 " + v);
            }
            maxRatio = v;
        }
        UniformityResult r = uniformity(resolve(path));
        if (!r.readable) {
            return verdict(CriteriaEngine.Verdicts.ERROR, "无法解码图像: " + r.error + "（" + path + "）");
        }
        String detail = String.format(
            Locale.ROOT,
            "%s 主色 #%08X 占 %d/%d = %.6f，阈值 %.6f，采样=%s",
            path,
            Integer.valueOf(r.dominantColor),
            Integer.valueOf(r.dominantCount),
            Integer.valueOf(r.sampled),
            Double.valueOf(r.dominantRatio),
            Double.valueOf(maxRatio),
            r.strategy);
        if (r.dominantRatio >= maxRatio) {
            return verdict(CriteriaEngine.Verdicts.RED, "图像近似纯色（黑屏/全白假图嫌疑）: " + detail);
        }
        return verdict(CriteriaEngine.Verdicts.GREEN, "图像非纯色: " + detail);
    }

    // ------------------------------------------------------------ 产物路径解析

    /**
     * 判据求值期的 run 目录（core 的图像算子不知道 run 目录，由 {@link CriteriaEngine} 注入）。
     *
     * <p>
     * 用 {@link ThreadLocal} 而不是实例字段：判据引擎可能被不同线程使用（单测并行/未来的
     * 后台求值），而 run 目录是「当前求值上下文」的属性。
     */
    private static final ThreadLocal<Path> RUN_DIR = new ThreadLocal<Path>();

    /** 设置当前线程的 run 目录。 */
    public static void setRunDir(Path dir) {
        RUN_DIR.set(dir);
    }

    /** 当前线程已设置的 run 目录；未设置返回 null（{@link CriteriaEngine} 据此决定是否覆盖）。 */
    public static Path currentRunDir() {
        return RUN_DIR.get();
    }

    /** 清除当前线程的 run 目录。 */
    public static void clearRunDir() {
        RUN_DIR.remove();
    }

    /** 解析产物路径：绝对路径原样，相对路径按当前 run 目录解析（防穿越同 {@link ArtifactStore}）。 */
    public static Path resolve(String relPath) {
        Path p = Paths.get(relPath);
        if (p.isAbsolute()) {
            return p;
        }
        Path base = RUN_DIR.get();
        if (base == null) {
            return p;
        }
        try {
            return ArtifactStore.resolveInRun(base, relPath);
        } catch (CpException e) {
            return p;
        }
    }

    // ------------------------------------------------------------ 工具

    /** 判据结论 {@code {verdict, detail}}。 */
    private static JsonObject verdict(String verdict, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("verdict", verdict);
        o.addProperty("detail", detail);
        return o;
    }

    /** 整数参数；缺失/非法返回 null。 */
    private static Long integral(JsonObject o, String key) {
        JsonElement e = Json.get(o, key);
        if (!CameraSpec.isIntegral(e) || !CameraSpec.isFinite(e)) {
            return null;
        }
        return Long.valueOf(e.getAsLong());
    }

    private static void tally(Map<Integer, int[]> counts, int argb) {
        Integer key = Integer.valueOf(argb);
        int[] slot = counts.get(key);
        if (slot == null) {
            counts.put(key, new int[] { 1 });
        } else {
            slot[0]++;
        }
    }

    private static void closeQuietly(ImageInputStream in) {
        if (in != null) {
            try {
                in.close();
            } catch (IOException ignored) {
                // 关闭失败不影响判据结论
            }
        }
    }
}
