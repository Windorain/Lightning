package com.lightning.mod.client.export;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

import javax.imageio.ImageIO;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 「横向多面子图带 ⇒ 只取该面那一列」的纯几何/像素判定（Gitea #9）。
 *
 * <h2>为什么需要它</h2>
 * 有一类模组（首个实证是 IC2 2.2.828）把<b>同一个方块的多个面并排放进一张 PNG</b>：一张
 * {@code 384×32} 的带子 = 12 个 {@code 32×32} 的「面」，图集里注册的却是<b>每个面一个 sprite</b>
 * （{@code ic2:generator/blockNuclearReactor:0..5}），而 sprite 自己只拿带子里的第
 * {@code subIndex % count} 列（IC2 {@code BlockTextureStitched.loadSubImage}：{@code size = 高 /
 * animationLength; count = 宽 / size; index = subIndex % count}，随后 {@code width = height = size}）。
 * <p>
 * 我方导出对这类材质<b>没有「横向多面」这个维度</b>（{@code kind} 只有 static16/animated），
 * 于是「按 locator 读磁盘 PNG」拿到的是<b>整条带</b>，而文档里的 UV 是该面 sprite 的局部 [0,1]
 * ⇒ 整条带被横压到一个面上（#9 的「一排排黄黑竖条」）。本类只负责三件事：读 PNG 头拿尺寸、
 * 从材质键里取面号、按面号算出该取第几列；裁切本身也是<b>逐像素搬运，不调用任何缩放 API</b>。
 *
 * <h2>与游戏自身对齐的口径</h2>
 * <ul>
 * <li><b>列号只来自「含 {@code :面号} 的原始材质键 / sprite 注册名」</b>，绝不来自
 * {@link ExportTextureLocator#normalizeLocatorForBundle} 之后的 locator —— 后者把 {@code :0..15}
 * 当世界 meta 剥掉了（{@code stripWorldMetaSuffixInPathForBundle}），面号在那里已经不存在；</li>
 * <li>列号 = {@code faceIndex % count}，{@code count = PNG 宽 / 格宽}，与 IC2 的
 * {@code index %= count} 同口径；</li>
 * <li><b>竖向动画条不在此列</b>：本类只在 {@code PNG 高 == 格高} 时成立（竖向多帧的 {@code 高 = 格高 × 帧数}），
 * 动画条的整条保留是既有且正确行为（导出侧要靠它出 {@code animation} 帧序）。</li>
 * </ul>
 *
 * <p>
 * <b>本类零 MC 依赖</b>（只有 AWT/ImageIO），故 {@code src/test} 的纯 JVM 单测可直接覆盖判定边界。
 */
@SideOnly(Side.CLIENT)
public final class TextureStripCrop {

    /** PNG 文件签名：{@code 89 50 4E 47 0D 0A 1A 0A}。 */
    private static final byte[] PNG_SIGNATURE = new byte[] { (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };

    /**
     * 面号上界（含）。IC2 实测最大 11（{@code BlockMultiID} 的 {@code active * 6 + side}），留到 3 位数余量；
     * 再大的尾段数字按「不是面号」处理（例如 GregTech 的 {@code mID} 四位数），避免把 mID 误当面号。
     */
    static final int MAX_FACE_INDEX = 63;

    private TextureStripCrop() {}

    /**
     * 只读 PNG 的 IHDR 块拿 {@code {width, height}}（<b>不解码像素</b>，故常规材质零成本）。
     *
     * @return 尺寸数组；非 PNG / 结构不完整 / 尺寸非正时返回 {@code null}
     */
    public static int[] readPngSize(byte[] png) {
        if (png == null || png.length < 24) {
            return null;
        }
        for (int i = 0; i < PNG_SIGNATURE.length; i++) {
            if (png[i] != PNG_SIGNATURE[i]) {
                return null;
            }
        }
        // 8 字节签名 + 4 字节长度 + 4 字节类型 = IHDR 必在偏移 8..15
        if (png[12] != 'I' || png[13] != 'H' || png[14] != 'D' || png[15] != 'R') {
            return null;
        }
        int width = readInt32(png, 16);
        int height = readInt32(png, 20);
        if (width <= 0 || height <= 0) {
            return null;
        }
        return new int[] { width, height };
    }

    private static int readInt32(byte[] b, int offset) {
        return ((b[offset] & 0xff) << 24) | ((b[offset + 1] & 0xff) << 16)
            | ((b[offset + 2] & 0xff) << 8)
            | (b[offset + 3] & 0xff);
    }

    /**
     * 从图集注册名 / 材质键（{@code ns:path:N}）尾段取面号。
     * <p>
     * 只认「{@code ns:path} 之后还有<b>唯一一个</b> {@code :} 且其右侧全是十进制」的形态（与
     * {@link ExportTextureLocator#stripWorldMetaSuffixInPathForBundle} 的语法口径对称，但<b>保留</b>数值），
     * 且数值必须落在 {@code 0..MAX_FACE_INDEX}。
     *
     * @return 面号；不匹配时 {@code -1}
     */
    public static int faceIndexFromName(String name) {
        if (name == null || name.isEmpty()) {
            return -1;
        }
        int ns = name.indexOf(':');
        if (ns < 0) {
            return -1;
        }
        int suffix = name.indexOf(':', ns + 1);
        if (suffix < 0 || name.indexOf(':', suffix + 1) >= 0) {
            return -1;
        }
        String tail = name.substring(suffix + 1);
        int len = tail.length();
        if (len == 0 || len > 6) {
            return -1;
        }
        for (int i = 0; i < len; i++) {
            char c = tail.charAt(i);
            if (c < '0' || c > '9') {
                return -1;
            }
        }
        int value;
        try {
            value = Integer.parseInt(tail, 10);
        } catch (NumberFormatException e) {
            return -1;
        }
        if (value < 0 || value > MAX_FACE_INDEX) {
            return -1;
        }
        return value;
    }

    /**
     * 判定「这张磁盘 PNG 是不是 {@code iconWidth × iconHeight} 格的横向多面带」，是则给出该取第几列。
     *
     * <p>
     * 成立条件（缺一不可，全部来自 sprite 与 PNG 的<b>实测</b>尺寸，不猜）：
     * <ol>
     * <li>{@code iconWidth == iconHeight}（方形格；IC2 {@code loadSubImage} 就是这么设的）；</li>
     * <li>{@code pngHeight == iconHeight} ⇒ <b>不是</b>竖向多帧（竖条 {@code pngHeight = iconHeight × 帧数}）；</li>
     * <li>{@code pngWidth > iconWidth} 且 {@code pngWidth % iconWidth == 0} ⇒ 横向正好 {@code count ≥ 2} 格；</li>
     * <li>{@code faceIndex ≥ 0}（拿不到面号就不裁——宁可按现状整图，也不猜第 0 列）。</li>
     * </ol>
     *
     * @return 列号（{@code faceIndex % count}）；不成立时 {@code -1}
     */
    public static int columnIndexForFace(int pngWidth, int pngHeight, int iconWidth, int iconHeight, int faceIndex) {
        if (pngWidth <= 0 || pngHeight <= 0 || iconWidth <= 0 || iconHeight <= 0) {
            return -1;
        }
        if (faceIndex < 0) {
            return -1;
        }
        if (iconWidth != iconHeight) {
            return -1;
        }
        if (pngHeight != iconHeight) {
            return -1;
        }
        if (pngWidth <= iconWidth || pngWidth % iconWidth != 0) {
            return -1;
        }
        int count = pngWidth / iconWidth;
        if (count < 2) {
            return -1;
        }
        /*
         * 2 列带要按游戏自身的特例走：IC2 BlockTextureStitched.loadSubImage:128-137 对 count==2 的
         * 分支是 index /= 6（= 6 面 × 2 变体，inactive/active 各占一列），不是 index %= count。
         * 实测 IC2 2.2.828 里确有 2 列带：wiring/cable/blockDetectorCable 与 blockSplitterCable
         * （32×16 = 2 × 16px），BlockCable 注册的 subIndex 是 0..5 ⇒ 用 % 会把 5 个面取到不存在的第 2 列。
         * 其它 mod 的 2 列带语义无从查证，按同一约定处理并在契约里写明（本批未实机验证电缆）。
         */
        if (count == 2) {
            int column = faceIndex / 6;
            return column < count ? column : count - 1;
        }
        return faceIndex % count;
    }

    /**
     * 裁出第 {@code columnIndex} 列（{@code cellWidth × cellHeight}），<b>逐像素复制、无重采样</b>。
     *
     * @throws IOException PNG 解码失败或裁列越界（调用方应回退整图，不得产出半截图）
     */
    public static byte[] cropColumn(byte[] png, int columnIndex, int cellWidth, int cellHeight) throws IOException {
        BufferedImage src;
        try (InputStream in = new ByteArrayInputStream(png)) {
            src = ImageIO.read(in);
        }
        if (src == null) {
            throw new IOException("PNG 解码失败（ImageIO.read 返回 null）");
        }
        int x0 = columnIndex * cellWidth;
        if (columnIndex < 0 || cellWidth <= 0
            || cellHeight <= 0
            || x0 + cellWidth > src.getWidth()
            || cellHeight > src.getHeight()) {
            throw new IOException(
                String.format(
                    Locale.ROOT,
                    "裁列越界：图 %dx%d，列 %d，格 %dx%d",
                    Integer.valueOf(src.getWidth()),
                    Integer.valueOf(src.getHeight()),
                    Integer.valueOf(columnIndex),
                    Integer.valueOf(cellWidth),
                    Integer.valueOf(cellHeight)));
        }
        BufferedImage dst = new BufferedImage(cellWidth, cellHeight, BufferedImage.TYPE_INT_ARGB);
        int[] row = new int[cellWidth];
        for (int y = 0; y < cellHeight; y++) {
            src.getRGB(x0, y, cellWidth, 1, row, 0, cellWidth);
            dst.setRGB(0, y, cellWidth, 1, row, 0, cellWidth);
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ImageIO.write(dst, "PNG", bos);
        return bos.toByteArray();
    }
}
