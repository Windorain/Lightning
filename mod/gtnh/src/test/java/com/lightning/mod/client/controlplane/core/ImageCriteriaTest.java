package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Random;

import javax.imageio.ImageIO;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonObject;

/**
 * {@link ImageCriteria} 与判据引擎两个图像判据的单测（case-file.md §5，1.1）。
 *
 * <p>
 * 夹具<b>全部程序生成</b>（不落二进制进仓）：
 * <ul>
 * <li>纯色图 → {@code image-not-uniform} 必须<b>红</b>（黑屏/全白假图的等价物）；</li>
 * <li>噪声图 → 必须<b>绿</b>；</li>
 * <li>尺寸判据只看头，不解码像素。</li>
 * </ul>
 */
public class ImageCriteriaTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path solid(int w, int h, int argb, String name) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.setRGB(x, y, argb);
            }
        }
        Path p = tmp.newFolder("solid")
            .toPath()
            .resolve(name);
        ImageIO.write(img, "png", p.toFile());
        return p;
    }

    private Path noise(int w, int h, long seed, String name) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Random r = new Random(seed);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.setRGB(x, y, 0xFF000000 | r.nextInt(0xFFFFFF));
            }
        }
        Path p = tmp.newFolder("noise")
            .toPath()
            .resolve(name);
        ImageIO.write(img, "png", p.toFile());
        return p;
    }

    /** 尺寸读头：纯色图也读得出（不解码像素）。 */
    @Test
    public void sizeReadsPngHeader() throws IOException {
        Path p = solid(37, 19, 0xFF102030, "a.png");
        ImageCriteria.SizeResult r = ImageCriteria.size(p);
        assertTrue(r.error, r.readable);
        assertEquals(37, r.width);
        assertEquals(19, r.height);
    }

    /** 纯色图的主色占比是 1.0。 */
    @Test
    public void solidImageIsUniform() throws IOException {
        Path p = solid(64, 48, 0xFF000000, "black.png");
        ImageCriteria.UniformityResult r = ImageCriteria.uniformity(p);
        assertTrue(r.error, r.readable);
        assertEquals(64 * 48, r.sampled);
        assertEquals(1.0d, r.dominantRatio, 1.0e-9d);
        assertEquals(0xFF000000, r.dominantColor);
        assertTrue(r.strategy.contains("full-scan"));
    }

    /** 噪声图的主色占比远低于阈值。 */
    @Test
    public void noiseImageIsNotUniform() throws IOException {
        Path p = noise(64, 48, 42L, "noise.png");
        ImageCriteria.UniformityResult r = ImageCriteria.uniformity(p);
        assertTrue(r.error, r.readable);
        assertTrue("噪声图主色占比应远低于 1: " + r.dominantRatio, r.dominantRatio < 0.1d);
    }

    /** 判据求值：纯色图 → 红。 */
    @Test
    public void notUniformCriterionIsRedOnSolidImage() throws IOException {
        Path p = solid(32, 32, 0xFFFFFFFF, "white.png");
        ImageCriteria.setRunDir(p.getParent());
        try {
            JsonObject verdict = ImageCriteria.evaluateNotUniform(
                params(
                    "path",
                    p.getFileName()
                        .toString()));
            assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(verdict, "verdict", null));
            assertTrue(
                Json.optString(verdict, "detail", ""),
                Json.optString(verdict, "detail", "")
                    .contains("近似纯色"));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 判据求值：噪声图 → 绿。 */
    @Test
    public void notUniformCriterionIsGreenOnNoiseImage() throws IOException {
        Path p = noise(64, 64, 7L, "noise.png");
        ImageCriteria.setRunDir(p.getParent());
        try {
            JsonObject verdict = ImageCriteria.evaluateNotUniform(
                params(
                    "path",
                    p.getFileName()
                        .toString()));
            assertEquals(
                Json.optString(verdict, "detail", ""),
                CriteriaEngine.Verdicts.GREEN,
                Json.optString(verdict, "verdict", null));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 阈值可被 params 提升/降低：0.5 的阈值下「半黑半白」也算纯色。 */
    @Test
    public void thresholdIsHonoured() throws IOException {
        BufferedImage img = new BufferedImage(40, 10, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 10; y++) {
            for (int x = 0; x < 40; x++) {
                img.setRGB(x, y, x < 30 ? 0xFF000000 : 0xFFFFFFFF);
            }
        }
        Path dir = tmp.newFolder("half")
            .toPath();
        Path p = dir.resolve("half.png");
        ImageIO.write(img, "png", p.toFile());
        ImageCriteria.setRunDir(dir);
        try {
            JsonObject strict = ImageCriteria.evaluateNotUniform(params("path", "half.png"));
            assertEquals(CriteriaEngine.Verdicts.GREEN, Json.optString(strict, "verdict", null)); // 主色 75% < 98%
            JsonObject loose = params("path", "half.png");
            loose.addProperty("maxSameColorRatio", 0.5d);
            JsonObject r = ImageCriteria.evaluateNotUniform(loose);
            assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(r, "verdict", null));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 阈值非法 → error（判据自身无法求值）。 */
    @Test
    public void invalidThresholdIsError() {
        JsonObject p = params("path", "x.png");
        p.addProperty("maxSameColorRatio", 1.5d);
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            Json.optString(ImageCriteria.evaluateNotUniform(p), "verdict", null));
    }

    /** 产物缺失 → error（连断言都做不了）。 */
    @Test
    public void missingArtifactIsError() {
        JsonObject p = params("path", "definitely-missing.png");
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            Json.optString(ImageCriteria.evaluateNotUniform(p), "verdict", null));
        JsonObject size = params("path", "definitely-missing.png");
        size.addProperty("width", 10);
        size.addProperty("height", 10);
        assertEquals(CriteriaEngine.Verdicts.ERROR, Json.optString(ImageCriteria.evaluateSize(size), "verdict", null));
    }

    /** 尺寸判据：命中 → 绿；不符 → 红。 */
    @Test
    public void sizeCriterionVerdicts() throws IOException {
        Path p = solid(120, 80, 0xFF00FF00, "sized.png");
        ImageCriteria.setRunDir(p.getParent());
        try {
            JsonObject ok = params("path", "sized.png");
            ok.addProperty("width", 120);
            ok.addProperty("height", 80);
            assertEquals(
                CriteriaEngine.Verdicts.GREEN,
                Json.optString(ImageCriteria.evaluateSize(ok), "verdict", null));
            JsonObject bad = params("path", "sized.png");
            bad.addProperty("width", 121);
            bad.addProperty("height", 80);
            JsonObject r = ImageCriteria.evaluateSize(bad);
            assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(r, "verdict", null));
            assertTrue(
                Json.optString(r, "detail", ""),
                Json.optString(r, "detail", "")
                    .contains("120x80"));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 非图像文件读头失败（不是 PNG）。 */
    @Test
    public void nonImageFileIsNotReadable() throws IOException {
        File f = tmp.newFile("not-an-image.png");
        java.nio.file.Files.write(f.toPath(), "hello".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        ImageCriteria.SizeResult r = ImageCriteria.size(f.toPath());
        assertFalse(r.readable);
        assertTrue(r.error, r.error != null && !r.error.isEmpty());
    }

    /**
     * 判据引擎接线：两个新类型在 TYPES 里且能求值（不报「未知判据类型」）。
     *
     * <p>
     * 走<b>真实 run 目录</b>（{@link ArtifactStore}）：引擎按 run 目录注入求值上下文，
     * 判据里的相对路径因此能被解析——这也是 mc 层 {@code case.run} 的实际路径。
     */
    @Test
    public void engineDispatchesImageCriteria() throws IOException {
        Path runRoot = tmp.newFolder("runs")
            .toPath();
        ArtifactStore store = new ArtifactStore(runRoot, TimeSource.fixed("2026-10-06T12:00:00+08:00", "t", 0L), null);
        ArtifactStore.Run run = store.createRun("image-criteria", 1L);
        Path dir = run.dir();
        BufferedImage img = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                img.setRGB(x, y, 0xFF123456);
            }
        }
        Path png = dir.resolve("shots");
        java.nio.file.Files.createDirectories(png);
        ImageIO.write(
            img,
            "png",
            png.resolve("engine.png")
                .toFile());

        CriteriaEngine engine = new CriteriaEngine(store, run, null, null);
        JsonObject size = new JsonObject();
        size.addProperty("id", "size");
        size.addProperty("type", CriteriaEngine.TYPE_IMAGE_SIZE_EQUALS);
        JsonObject sizeParams = params("path", "shots/engine.png");
        sizeParams.addProperty("width", 16);
        sizeParams.addProperty("height", 16);
        size.add("params", sizeParams);
        JsonObject sizeVerdict = engine.evaluateOne(size, 0);
        assertEquals(
            Json.optString(sizeVerdict, "detail", ""),
            CriteriaEngine.Verdicts.GREEN,
            Json.optString(sizeVerdict, "verdict", null));

        JsonObject notUniform = new JsonObject();
        notUniform.addProperty("id", "n");
        notUniform.addProperty("type", CriteriaEngine.TYPE_IMAGE_NOT_UNIFORM);
        notUniform.add("params", params("path", "shots/engine.png"));
        JsonObject uniformVerdict = engine.evaluateOne(notUniform, 1);
        assertEquals(
            Json.optString(uniformVerdict, "detail", ""),
            CriteriaEngine.Verdicts.RED,
            Json.optString(uniformVerdict, "verdict", null));
    }

    // ------------------------------------------------------------ image-uniform（1.2，反转）

    /** 纯色图 → 绿（近纯色断言成立）。 */
    @Test
    public void uniformCriterionIsGreenOnSolidImage() throws IOException {
        Path p = solid(48, 32, 0xFF102030, "solid.png");
        ImageCriteria.setRunDir(p.getParent());
        try {
            JsonObject verdict = ImageCriteria.evaluateUniform(
                params(
                    "path",
                    p.getFileName()
                        .toString()));
            assertEquals(
                Json.optString(verdict, "detail", ""),
                CriteriaEngine.Verdicts.GREEN,
                Json.optString(verdict, "verdict", null));
            assertTrue(
                Json.optString(verdict, "detail", ""),
                Json.optString(verdict, "detail", "")
                    .contains("近似纯色"));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 噪声图 → 红（画面里有结构，距离门没生效）。 */
    @Test
    public void uniformCriterionIsRedOnNoiseImage() throws IOException {
        Path p = noise(64, 48, 11L, "noise.png");
        ImageCriteria.setRunDir(p.getParent());
        try {
            JsonObject verdict = ImageCriteria.evaluateUniform(
                params(
                    "path",
                    p.getFileName()
                        .toString()));
            assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(verdict, "verdict", null));
            assertTrue(
                Json.optString(verdict, "detail", ""),
                Json.optString(verdict, "detail", "")
                    .contains("不够纯色"));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 阈值可被 params 调低：主色 75% 的图在 0.5 阈值下算纯色，在 0.9 阈值下不算。 */
    @Test
    public void uniformThresholdIsHonoured() throws IOException {
        BufferedImage img = new BufferedImage(40, 10, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 10; y++) {
            for (int x = 0; x < 40; x++) {
                img.setRGB(x, y, x < 30 ? 0xFF000000 : 0xFFFFFFFF);
            }
        }
        Path dir = tmp.newFolder("half-uniform")
            .toPath();
        ImageIO.write(
            img,
            "png",
            dir.resolve("half.png")
                .toFile());
        ImageCriteria.setRunDir(dir);
        try {
            JsonObject loose = params("path", "half.png");
            loose.addProperty("minSameColorRatio", 0.5d);
            assertEquals(
                CriteriaEngine.Verdicts.GREEN,
                Json.optString(ImageCriteria.evaluateUniform(loose), "verdict", null));
            JsonObject strict = params("path", "half.png");
            strict.addProperty("minSameColorRatio", 0.9d);
            assertEquals(
                CriteriaEngine.Verdicts.RED,
                Json.optString(ImageCriteria.evaluateUniform(strict), "verdict", null));
        } finally {
            ImageCriteria.clearRunDir();
        }
    }

    /** 阈值非法 / 产物缺失 → error；缺失 path → error。 */
    @Test
    public void uniformInvalidInputsAreErrors() {
        JsonObject bad = params("path", "x.png");
        bad.addProperty("minSameColorRatio", -0.1d);
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            Json.optString(ImageCriteria.evaluateUniform(bad), "verdict", null));
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            Json.optString(ImageCriteria.evaluateUniform(params("path", "missing.png")), "verdict", null));
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            Json.optString(ImageCriteria.evaluateUniform(new JsonObject()), "verdict", null));
    }

    /** 引擎接线：image-uniform 在注册表里且被正确分派（纯色图 → 绿）。 */
    @Test
    public void engineDispatchesImageUniform() throws IOException {
        Path runRoot = tmp.newFolder("runs-uniform")
            .toPath();
        ArtifactStore store = new ArtifactStore(runRoot, TimeSource.fixed("2026-10-06T12:00:00+08:00", "t", 0L), null);
        ArtifactStore.Run run = store.createRun("image-uniform", 1L);
        Path png = run.dir()
            .resolve("shots");
        java.nio.file.Files.createDirectories(png);
        BufferedImage img = new BufferedImage(24, 24, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 24; y++) {
            for (int x = 0; x < 24; x++) {
                img.setRGB(x, y, 0xFF8899AA);
            }
        }
        ImageIO.write(
            img,
            "png",
            png.resolve("far.png")
                .toFile());

        CriteriaEngine engine = new CriteriaEngine(store, run, null, null);
        JsonObject criterion = new JsonObject();
        criterion.addProperty("id", "far-uniform");
        criterion.addProperty("type", CriteriaEngine.TYPE_IMAGE_UNIFORM);
        criterion.add("params", params("path", "shots/far.png"));
        JsonObject verdict = engine.evaluateOne(criterion, 0);
        assertEquals(
            Json.optString(verdict, "detail", ""),
            CriteriaEngine.Verdicts.GREEN,
            Json.optString(verdict, "verdict", null));
    }

    private static JsonObject params(String k, String v) {
        JsonObject o = new JsonObject();
        o.addProperty(k, v);
        return o;
    }
}
