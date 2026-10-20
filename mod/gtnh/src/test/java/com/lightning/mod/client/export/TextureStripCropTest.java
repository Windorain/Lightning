package com.lightning.mod.client.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import javax.imageio.ImageIO;

import org.junit.Test;

/**
 * 横向多面子图带裁列判据（Gitea #9，方案 A）。
 *
 * <p>
 * 覆盖三件事，缺一都不足以支撑实机结论：
 * <ol>
 * <li><b>判定边界</b>：什么时候该裁（横带 + 方形格 + 高 == 格高 + 宽整除 + 有面号）、什么时候<b>不该</b>裁
 * （正方形单图 / 竖向动画条 / 宽不整除 / 格非方形 / 拿不到面号）；</li>
 * <li><b>面号来源</b>：只认「含 {@code :面号} 的原始材质键」；{@code ExportTextureLocator} 归一化后的
 * locator 已经没有面号，本类不得假装能从那里取（负对照在 {@link #normalizeLocatorLosesFaceIndex()}）；</li>
 * <li><b>像素保真</b>：裁出来的是原图的<b>整块像素</b>，不是重采样结果（#9 的观感修复全靠这一条，若偷偷缩放
 * 就会得到「糊但形状对」的假修复）。</li>
 * </ol>
 *
 * <p>
 * 另有一条<b>装配守卫</b>（{@link #embedderReconcilesDiskPngBeforeFramesFallback()}）：纯函数判据全绿也可能
 * 根本没被生产代码调用（仓库通则：新承载行为的判据至少有一条走生产装配），故直接读
 * {@code TextureBlobEmbedder.java} 断言「磁盘命中后、sprite 帧数据兜底前」确实调用了本类。
 * 源码读取先做 CRLF 归一化（本仓 {@code core.autocrlf=true}，新鲜检出是 CRLF）。
 */
public class TextureStripCropTest {

    // ------------------------------------------------------------ PNG 尺寸（只读 IHDR）

    @Test
    public void readPngSizeReadsHeaderOnly() throws IOException {
        byte[] png = pngOf(384, 32);
        int[] size = TextureStripCrop.readPngSize(png);
        assertNotNull("IHDR 可读", size);
        assertEquals("宽", 384, size[0]);
        assertEquals("高", 32, size[1]);
    }

    @Test
    public void readPngSizeRejectsNonPng() {
        assertNull("空数组", TextureStripCrop.readPngSize(null));
        byte[] notPng = "not a png at all, definitely not".getBytes(StandardCharsets.US_ASCII);
        assertNull("普通字节", TextureStripCrop.readPngSize(notPng));
        byte[] truncated = new byte[] { (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13 };
        assertNull("截断（不足 IHDR）", TextureStripCrop.readPngSize(truncated));
        byte[] gzip = new byte[] { 0x1f, (byte) 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0 };
        assertNull("gzip 头", TextureStripCrop.readPngSize(gzip));
    }

    // ------------------------------------------------------------ 面号来源

    @Test
    public void faceIndexFromIconNameReadsTrailingFaceNumber() {
        // IC2：BlockMetaData 注册 ic2:<folder>/<name>:<side>；BlockMultiID 注册 ...:<active*6+side>
        assertEquals(3, TextureStripCrop.faceIndexFromName("ic2:generator/blockNuclearReactor:3"));
        assertEquals(0, TextureStripCrop.faceIndexFromName("ic2:reactor/blockReactorChamber:0"));
        assertEquals(11, TextureStripCrop.faceIndexFromName("ic2:reactor/blockReactorChamber:11"));
        assertEquals("已带纹理根的形态同样成立", 5, TextureStripCrop.faceIndexFromName("ic2:blocks/generator/x:5"));
    }

    @Test
    public void faceIndexFromNameRejectsNonFaceSuffixes() {
        assertEquals("无尾段", -1, TextureStripCrop.faceIndexFromName("minecraft:stone"));
        assertEquals("只有命名空间冒号", -1, TextureStripCrop.faceIndexFromName("minecraft:blocks/stone"));
        assertEquals("尾段非数字", -1, TextureStripCrop.faceIndexFromName("ic2:generator/blockNuclearReactor:side"));
        assertEquals("多段冒号", -1, TextureStripCrop.faceIndexFromName("ic2:a:b:3"));
        assertEquals("空尾段", -1, TextureStripCrop.faceIndexFromName("ic2:generator/x:"));
        assertEquals("窄号", -1, TextureStripCrop.faceIndexFromName("ic2:generator/x:-1"));
        assertEquals("空串", -1, TextureStripCrop.faceIndexFromName(""));
        assertEquals("null", -1, TextureStripCrop.faceIndexFromName(null));
    }

    @Test
    public void faceIndexFromNameRejectsGregTechMetaIdRange() {
        // GregTech 的 mID 是四位数：可以合法出现在图标名尾段，但它不是「面号」，不得被当成列号。
        assertTrue("mID 超出面号域", 3050 > TextureStripCrop.MAX_FACE_INDEX);
        assertEquals(-1, TextureStripCrop.faceIndexFromName("gregtech:gt.blockmachines:3050"));
        assertEquals(-1, TextureStripCrop.faceIndexFromName("gregtech:gt.blockmachines:15682"));
        assertEquals(
            "面号上界内仍可用",
            TextureStripCrop.MAX_FACE_INDEX,
            TextureStripCrop.faceIndexFromName("ic2:generator/x:63"));
        assertEquals("超过上界即不是面号", -1, TextureStripCrop.faceIndexFromName("ic2:generator/x:64"));
    }

    @Test
    public void normalizeLocatorLosesFaceIndex() {
        // 这一条把缺陷的成因钉住：归一化 locator 把 :3 当世界 meta 剥掉 ⇒ 面号在那里不存在。
        String normalized = ExportTextureLocator.normalizeLocatorForBundle("ic2:generator/blockNuclearReactor:3");
        assertEquals("归一化后 locator 已无面号", "ic2:blocks/generator/blockNuclearReactor", normalized);
        assertEquals("因此不得从归一化 locator 取面号", -1, TextureStripCrop.faceIndexFromName(normalized));
        assertEquals("原始材质键才是权威", 3, TextureStripCrop.faceIndexFromName("ic2:generator/blockNuclearReactor:3"));
    }

    // ------------------------------------------------------------ 该不该裁（判定边界）

    @Test
    public void horizontalStripIsCroppedToItsOwnColumn() {
        // 核反应堆带 384×32 = 12 × 32，面号 0..5
        assertEquals(0, TextureStripCrop.columnIndexForFace(384, 32, 32, 32, 0));
        assertEquals(3, TextureStripCrop.columnIndexForFace(384, 32, 32, 32, 3));
        assertEquals(5, TextureStripCrop.columnIndexForFace(384, 32, 32, 32, 5));
        // IC2 的 index %= count：面号越界时回绕（与游戏自身同口径）
        assertEquals(3, TextureStripCrop.columnIndexForFace(384, 32, 32, 32, 15));
        // 核反应仓带 192×32 = 6 × 32，面号 0..11（inactive/active 各 6）
        assertEquals(0, TextureStripCrop.columnIndexForFace(192, 32, 32, 32, 0));
        assertEquals(5, TextureStripCrop.columnIndexForFace(192, 32, 32, 32, 5));
        assertEquals("active 首面回绕到第 0 列", 0, TextureStripCrop.columnIndexForFace(192, 32, 32, 32, 6));
        assertEquals("active 第 2 面 ⇒ 第 1 列", 1, TextureStripCrop.columnIndexForFace(192, 32, 32, 32, 7));
        assertEquals(11 % 6, TextureStripCrop.columnIndexForFace(192, 32, 32, 32, 11));
        // 16px 格的一般形态
        assertEquals(2, TextureStripCrop.columnIndexForFace(48, 16, 16, 16, 2));
    }

    @Test
    public void singleFaceTextureIsLeftAlone() {
        assertEquals("正方形单图（宽 == 格宽）不动", -1, TextureStripCrop.columnIndexForFace(32, 32, 32, 32, 0));
        assertEquals(-1, TextureStripCrop.columnIndexForFace(16, 16, 16, 16, 3));
        assertEquals("既有 IC2 单图对照物 blockreactorvessel.png", -1, TextureStripCrop.columnIndexForFace(16, 16, 16, 16, 0));
    }

    @Test
    public void verticalAnimationStripIsLeftAlone() {
        // 竖向动画条：高 = 格高 × 帧数（这里 32×128 = 4 帧）⇒ 不得裁（动画要靠整条）
        assertEquals(-1, TextureStripCrop.columnIndexForFace(32, 128, 32, 32, 0));
        // 动画 + 多列的混合形态：整条保留优先（本批只处理「高 == 格高」的纯横带）
        assertEquals(-1, TextureStripCrop.columnIndexForFace(384, 128, 32, 32, 3));
    }

    /**
     * IC2 2.2.828 里**真实存在**的竖向多帧贴图（全量口径：jar 内 18 张，全部是流体）。
     *
     * <p>
     * 实测（`ic2-2.2.828-dev.jar` 全量扫描，清单 `temp/pb-ic2-fix/ic2-vertical-strips.json`）：
     * {@code fluids/*_still} = 16×512（32 帧）、{@code fluids/*_flow} = 32×1024（32 帧）；
     * 除它们之外，IC2 的 {@code .mcmeta} 只有 2 张**物品**贴图 + {@code pack.mcmeta} ⇒
     * <b>IC2 没有「竖向动画条 + 方块面 sprite」这种复合形态</b>（{@code BlockTextureStitched} 的
     * {@code animationLength} 分支要求 {@code mcmeta.frameHeight>0}，而方块贴图无 mcmeta）。
     * 这组断言把「真出现这种形态也不裁」钉住：两个形状都是 {@code 高 ≠ 格高}，故命中竖向条分支。
     */
    @Test
    public void ic2RealFluidAnimationStripsAreLeftAlone() {
        // fluids/*_still：16×512（32 帧）—— 若被误当横带（16 <= 16）或误用「高整除宽」粗判都会出错
        assertEquals(-1, TextureStripCrop.columnIndexForFace(16, 512, 16, 16, 0));
        // fluids/*_flow：32×1024（32 帧）—— 高整除宽成立（1024 % 32 == 0），但高 ≠ 格高 ⇒ 必须不裁
        assertEquals(-1, TextureStripCrop.columnIndexForFace(32, 1024, 32, 32, 3));
        // 反面对照：同一张 flow 的「单帧」形态（32×32）本来就不该裁（宽 == 格宽）
        assertEquals(-1, TextureStripCrop.columnIndexForFace(32, 32, 32, 32, 3));
    }

    /**
     * 2 列带按游戏特例取列：IC2 {@code loadSubImage} 对 {@code count==2} 走 {@code index /= 6}
     * （6 面 × inactive/active 各一列），**不是** {@code index %= count}。
     *
     * <p>
     * 实测 IC2 2.2.828 的 2 列带只有两张：{@code wiring/cable/blockDetectorCable} 与
     * {@code wiring/cable/blockSplitterCable}（32×16 = 2 × 16px）；{@code BlockCable} 注册的
     * subIndex 是 0..5 ⇒ 若按 {@code % 2} 会取到不存在的第 2 列（面图错）。本判据把口径钉住，
     * 并显式断言它与 {@code % 2} 不同（负对照）。
     */
    @Test
    public void twoColumnStripFollowsGameDivideBySixRule() {
        // 32×16 = 2 列 × 16px；subIndex 0..5 全在第 0 列（% 2 会给 0,1,0,1,0,1 —— 错）
        for (int face = 0; face <= 5; face++) {
            assertEquals("面号 " + face + " 应取第 0 列", 0, TextureStripCrop.columnIndexForFace(32, 16, 16, 16, face));
        }
        // 12 态的 2 列带（subIndex 6..11 = active）落在第 1 列
        for (int face = 6; face <= 11; face++) {
            assertEquals("面号 " + face + " 应取第 1 列", 1, TextureStripCrop.columnIndexForFace(32, 16, 16, 16, face));
        }
        // 负对照：把规则写成 % count 时，面号 1 会得 1，与游戏口径 0 不同
        assertEquals("游戏口径", 0, TextureStripCrop.columnIndexForFace(32, 16, 16, 16, 1));
        assertTrue("与 % count 的取值确实不同（否则本判据没有判别力）", 0 != (1 % (32 / 16)));
        // 越界面号收敛到最后一列，不会越界抛错
        assertEquals(1, TextureStripCrop.columnIndexForFace(32, 16, 16, 16, 63));
    }

    @Test
    public void mismatchedOrUnknownShapesAreLeftAlone() {
        assertEquals("宽不整除格宽", -1, TextureStripCrop.columnIndexForFace(100, 32, 32, 32, 0));
        assertEquals("非方形格", -1, TextureStripCrop.columnIndexForFace(384, 32, 32, 16, 0));
        assertEquals("拿不到面号就不裁（不猜第 0 列）", -1, TextureStripCrop.columnIndexForFace(384, 32, 32, 32, -1));
        assertEquals("零尺寸", -1, TextureStripCrop.columnIndexForFace(0, 0, 32, 32, 0));
        assertEquals(-1, TextureStripCrop.columnIndexForFace(384, 32, 0, 0, 0));
    }

    // ------------------------------------------------------------ 像素保真（不重采样）

    @Test
    public void cropColumnCopiesPixelsWithoutResampling() throws IOException {
        int count = 12;
        int cell = 32;
        int width = count * cell;
        BufferedImage src = new BufferedImage(width, cell, BufferedImage.TYPE_INT_ARGB);
        for (int x = 0; x < width; x++) {
            for (int y = 0; y < cell; y++) {
                // 每列一个主色，列内带坐标纹理：只要能对上像素，就说明是整数搬运而不是缩放
                int r = (x / cell) * 20 + 5;
                int g = y;
                int b = x % cell;
                src.setRGB(x, y, 0xff000000 | (r << 16) | (g << 8) | b);
            }
        }
        byte[] png = toPng(src);

        int column = TextureStripCrop.columnIndexForFace(width, cell, cell, cell, 7);
        assertEquals(7, column);
        byte[] cropped = TextureStripCrop.cropColumn(png, column, cell, cell);

        BufferedImage out = ImageIO.read(new java.io.ByteArrayInputStream(cropped));
        assertNotNull("裁切产物可解码", out);
        assertEquals("宽 = 格宽", cell, out.getWidth());
        assertEquals("高 = 格高", cell, out.getHeight());
        for (int y = 0; y < cell; y++) {
            for (int x = 0; x < cell; x++) {
                assertEquals(
                    "像素 (" + x + "," + y + ") 逐点等于源带第 " + column + " 列的同一像素",
                    src.getRGB(column * cell + x, y),
                    out.getRGB(x, y));
            }
        }
    }

    @Test
    public void cropColumnRejectsOutOfRangeColumn() throws IOException {
        byte[] png = pngOf(384, 32);
        try {
            TextureStripCrop.cropColumn(png, 12, 32, 32);
            fail("越界列必须抛错（否则会产出半截图/空图）");
        } catch (IOException expected) {
            assertTrue(
                "错误消息要能看出越界",
                expected.getMessage()
                    .contains("越界"));
        }
    }

    // ------------------------------------------------------------ 装配守卫

    /**
     * 生产代码确实调用了本类：{@code TextureBlobEmbedder} 的<b>磁盘命中分支</b>必须在对账后返回，
     * 且该调用出现在 sprite 帧数据兜底（{@code getFrameTextureData}）<b>之前</b>，并且拿到的是<b>原始</b>材质键。
     *
     * <p>
     * 这一条防的是「纯函数全绿但没人调用」的假绿：#9 的修复点是 loadTexturePngBytes 的磁盘优先分支，
     * 如果裁列逻辑被插到帧数据兜底之后，IC2 的磁盘命中会直接 return，裁列永远走不到。
     * <p>
     * 断言跑在<b>压缩空白后</b>的源码上（把连续空白折叠成单空格）：spotless 可能重排长调用的换行，
     * 判据不该因此变红；压缩不改变先后顺序，故位置断言仍然有效。源码先做 CRLF 归一化。
     */
    @Test
    public void embedderReconcilesDiskPngBeforeFramesFallback() throws IOException {
        String flat = flattenedEmbedderSource();
        int diskHit = flat.indexOf("tryLoadPngForNormalizedLocator(rm, locator)");
        int crop = flat.indexOf("cropHorizontalStripColumnIfAny(fromDisk, locator, standalone, spriteAtlas, null)");
        int frames = flat.indexOf("getFrameTextureData(0)");
        assertTrue("找不到磁盘首探点（源码形态变了，需同步本判据）", diskHit >= 0);
        assertTrue("磁盘命中后未按面号对账（#9 修复点缺失）", crop >= 0);
        assertTrue("找不到 sprite 帧数据兜底点", frames >= 0);
        assertTrue("裁列必须发生在磁盘命中之后", crop > diskHit);
        assertTrue("裁列必须发生在帧数据兜底之前（否则磁盘命中直接 return，裁列成死代码）", crop < frames);
        assertTrue("辅助函数本尊必须在同类内定义", flat.contains("private static byte[] cropHorizontalStripColumnIfAny("));
        assertTrue("磁盘优先策略的说明（保留动画竖条）必须仍在类注释里", flat.contains("优先读资源包 PNG"));
        assertTrue(
            "同一函数内的其余 disk 出口（sprite 图标名 / items 重试）也必须过同一道对账",
            countOccurrences(flat, "cropHorizontalStripColumnIfAny(") >= 4);
    }

    /** 面号只从「含 {@code :面号} 的原始材质键 / sprite 注册名」取，不来自归一化 locator。 */
    @Test
    public void cropperIsCalledWithRawMaterialKeyNotNormalizedLocator() throws IOException {
        String flat = flattenedEmbedderSource();
        assertTrue("面号优先取自 sprite 注册名", flat.contains("TextureStripCrop.faceIndexFromName(spr.getIconName())"));
        assertTrue("原始材质键作兜底", flat.contains("TextureStripCrop.faceIndexFromName(materialKey)"));
        assertTrue(
            "不得拿 normalizeLocatorForBundle 的结果去取面号",
            !flat.contains("faceIndexFromName(ExportTextureLocator.normalizeLocatorForBundle"));
        assertTrue(
            "也不得拿归一化 locator 去查 sprite（查不到含 :面号 的 sprite）",
            !flat.contains("findSpriteForMaterialKey(ExportTextureLocator.normalizeLocatorForBundle"));
    }

    private static String flattenedEmbedderSource() throws IOException {
        Path source = exportSource("TextureBlobEmbedder.java");
        String text = new String(Files.readAllBytes(source), StandardCharsets.UTF_8);
        return text.replace("\r\n", "\n")
            .replaceAll("\\s+", " ");
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        int from = 0;
        while (true) {
            int at = haystack.indexOf(needle, from);
            if (at < 0) {
                return count;
            }
            count++;
            from = at + needle.length();
        }
    }

    // ------------------------------------------------------------ 工具

    private static Path exportSource(String fileName) {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("src/main/java/com/lightning/mod/client/export")
                .resolve(fileName);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        fail("找不到 src/main/java/com/lightning/mod/client/export/" + fileName);
        return null;
    }

    private static byte[] pngOf(int width, int height) throws IOException {
        BufferedImage img = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        return toPng(img);
    }

    private static byte[] toPng(BufferedImage img) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ImageIO.write(img, "PNG", bos);
        return bos.toByteArray();
    }
}
