package com.lightning.mod.client.export;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.imageio.ImageIO;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.client.resources.IResourceManager;
import net.minecraft.util.ResourceLocation;

import org.lwjgl.opengl.GL11;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.MaterialKeyResolver;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 将 {@code materialPalette} 中每条材质的像素写入根级 {@code textureBlobs}（标准 Base64 PNG 字节）并设置
 * {@code textureBlobIndex}，供 Wiki 单文件消费。与 {@link ExportTextureLocator#normalizeLocatorForBundle} /
 * {@link ExportBundleClient} 的资源路径规则一致；优先读资源包 PNG（保留动画竖条），失败时再尝试图集 sprite 帧缓冲。
 * <p>
 * <b>横向多面子图带</b>（Gitea #9）：磁盘命中后必须与 sprite 对账一次——PNG 是 {@code iconW × iconH} 格的横带时，
 * 只留「该面」那一列（{@link TextureStripCrop}），否则整条带会被下游当作一个面横压到面上（IC2 核反应堆/核反应仓
 * 的「一排排黄黑竖条」）。竖向动画条（{@code 高 = iconH × 帧数}）不受影响：整条保留是既有且正确的行为。
 */
@SideOnly(Side.CLIENT)
public final class TextureBlobEmbedder {

    /** 与 Wiki 预览占位一致；无材质槽时仍须非空池以满足 Wiki 校验 */
    private static final String PNG_BASE64_PLACEHOLDER = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJ0lEQVR4nGNkwAH+M/zHKs7EQCJgGtVABGDEFd6MDIxDxQ9Mw0ADACTzBB1zL3aeAAAAAElFTkSuQmCC";

    private static byte[] cachedPlaceholderPng;

    private static byte[] getPlaceholderPngBytes() {
        if (cachedPlaceholderPng == null) {
            cachedPlaceholderPng = java.util.Base64.getDecoder()
                .decode(PNG_BASE64_PLACEHOLDER);
        }
        return cachedPlaceholderPng;
    }

    private TextureBlobEmbedder() {}

    public static void embedIntoDocument(JsonObject documentRoot) throws Exception {
        Minecraft mc = Minecraft.getMinecraft();
        TextureMap blocksAtlas = mc.getTextureMapBlocks();
        IResourceManager rm = mc.getResourceManager();

        List<JsonArray> palettes = new ArrayList<>();
        collectMaterialPalettes(documentRoot, palettes);
        if (palettes.isEmpty()) {
            JsonArray only = new JsonArray();
            only.add(new JsonPrimitive(PNG_BASE64_PLACEHOLDER));
            documentRoot.add("textureBlobs", only);
            return;
        }

        JsonArray blobs = new JsonArray();
        Map<String, Integer> shaToIndex = new HashMap<>();

        for (JsonArray palette : palettes) {
            for (JsonElement el : palette) {
                if (!el.isJsonObject()) {
                    continue;
                }
                JsonObject m = el.getAsJsonObject();
                if (!m.has("locator")) {
                    throw new IOException("materialPalette 条目缺少 locator");
                }
                String locator = m.get("locator")
                    .getAsString();
                boolean standalone = m.has("atlas") && m.get("atlas")
                    .isJsonNull();
                String atlasStr = "blocks";
                if (m.has("atlas") && m.get("atlas")
                    .isJsonPrimitive()) {
                    atlasStr = m.get("atlas")
                        .getAsString();
                }
                TextureMap itemsAtlas = MaterialKeyResolver.getTextureMapItems(mc);
                TextureMap spriteAtlas = standalone ? blocksAtlas
                    : ("items".equals(atlasStr) && itemsAtlas != null ? itemsAtlas : blocksAtlas);

                byte[] png = loadTexturePngBytes(locator, standalone, spriteAtlas, rm);
                String sha = sha256Hex(png);
                Integer idx = shaToIndex.get(sha);
                if (idx == null) {
                    idx = blobs.size();
                    shaToIndex.put(sha, idx);
                    blobs.add(
                        new JsonPrimitive(
                            java.util.Base64.getEncoder()
                                .encodeToString(png)));
                }
                m.addProperty("textureBlobIndex", idx.intValue());
            }
        }

        if (blobs.size() == 0) {
            blobs.add(new JsonPrimitive(PNG_BASE64_PLACEHOLDER));
        }

        documentRoot.add("textureBlobs", blobs);
    }

    private static void collectMaterialPalettes(JsonObject root, List<JsonArray> out) {
        if (root.has("frames")) {
            addPaletteIfPresent(root, out);
            return;
        }
        addPaletteIfPresent(root, out);
    }

    private static void addPaletteIfPresent(JsonObject structureOrRoot, List<JsonArray> out) {
        if (structureOrRoot.has("materialPalette")) {
            out.add(structureOrRoot.getAsJsonArray("materialPalette"));
        }
    }

    private static byte[] loadTexturePngBytes(String locator, boolean standalone, TextureMap spriteAtlas,
        IResourceManager rm) throws Exception {
        if (locator == null || locator.isEmpty() || "unknown".equals(locator)) {
            return getPlaceholderPngBytes();
        }

        byte[] fromDisk = tryLoadPngForNormalizedLocator(rm, locator);
        if (fromDisk != null) {
            byte[] column = cropHorizontalStripColumnIfAny(fromDisk, locator, standalone, spriteAtlas, null);
            return column != null ? column : fromDisk;
        }

        TextureAtlasSprite spr = null;
        TextureMap foundIn = null;

        if (!standalone) {
            for (TextureMap m : atlasProbeOrderForSpriteLookup(locator, spriteAtlas)) {
                spr = MaterialKeyResolver.findSpriteForMaterialKey(locator, m);
                if (spr != null) {
                    foundIn = m;
                    break;
                }
            }
            if (spr != null) {
                /*
                 * 图集 stitch 上传后，无动画 sprite 会 clearFramesTextureData。
                 * 无论 frameCount 是否为 0，都尝试提取帧数据；异常/空数据则走磁盘回退。
                 * Angelica 可能在 clear 后仍保留一帧，因此不依赖 frameCount 判断。
                 */
                int w = spr.getIconWidth();
                int h = spr.getIconHeight();
                if (w > 0 && h > 0) {
                    try {
                        int[][] fd = spr.getFrameTextureData(0);
                        if (fd != null && fd.length > 0 && fd[0] != null && fd[0].length == w * h) {
                            return rgbaArrayToPng(fd[0], w, h);
                        }
                    } catch (Exception ignored) {
                        // clearFramesTextureData emptied the frame list
                    }
                }
                String iconName = spr.getIconName();
                if (iconName != null && !iconName.isEmpty()) {
                    String fromIcon = ExportTextureLocator.iconNameToLocator(iconName);
                    fromDisk = tryLoadPngForNormalizedLocator(rm, fromIcon);
                    if (fromDisk != null) {
                        byte[] column = cropHorizontalStripColumnIfAny(
                            fromDisk,
                            fromIcon,
                            standalone,
                            spriteAtlas,
                            spr);
                        return column != null ? column : fromDisk;
                    }
                    /*
                     * normalizeLocatorForBundle 对无显式纹理根（blocks/items/…）的路径默认补 blocks/。
                     * 若 sprite 实际位于物品图集，则上述磁盘探测落在 textures/blocks/… 找不到文件。
                     * 此处补一次显式 items/ 路径的重试。
                     */
                    if (foundIn == MaterialKeyResolver.getTextureMapItems(Minecraft.getMinecraft())) {
                        int c = fromIcon.indexOf(':');
                        if (c >= 0) {
                            String ns = fromIcon.substring(0, c);
                            String path = fromIcon.substring(c + 1);
                            fromDisk = tryLoadPng(rm, new ResourceLocation(ns, "textures/items/" + path + ".png"));
                            if (fromDisk != null) {
                                byte[] column = cropHorizontalStripColumnIfAny(
                                    fromDisk,
                                    fromIcon,
                                    standalone,
                                    spriteAtlas,
                                    spr);
                                return column != null ? column : fromDisk;
                            }
                        }
                    }
                }
            }
        }

        // GPU atlas readback: primary fallback for procedurally generated textures
        // (e.g. JABBA replaceTextureData uploads to GPU without preserving CPU frame data).
        // Runs BEFORE SpriteFrameCache because the cache may contain stale pre-merge data.
        if (!standalone && spr != null) {
            try {
                TextureMap activeAtlas = foundIn != null ? foundIn : spriteAtlas;
                byte[] gpu = readSpriteFromGpuAtlas(spr, activeAtlas);
                if (gpu != null) return gpu;
            } catch (Exception ignored) {}
        }

        // Final fallback: cached frame data saved before clearFramesTextureData
        if (!standalone) {
            int[] cached = SpriteFrameCache.get(locator);
            if (cached == null && spr != null) {
                String iconName = spr.getIconName();
                if (iconName != null) {
                    cached = SpriteFrameCache.get(iconName);
                }
            }
            if (cached != null) {
                int w = spr != null ? spr.getIconWidth() : (int) Math.sqrt(cached.length);
                int h = spr != null ? spr.getIconHeight() : (int) Math.sqrt(cached.length);
                if (w > 0 && h > 0 && cached.length == w * h) {
                    return rgbaArrayToPng(cached, w, h);
                }
            }
        }

        FMLLog.warning(
            "[SDE] TextureBlobEmbedder: 无法从磁盘或图集得到像素，使用占位 PNG（locator=%s, standalone=%s）",
            locator,
            Boolean.valueOf(standalone));
        return getPlaceholderPngBytes();
    }

    /**
     * 磁盘 PNG 若是一张<b>横向多面子图带</b>，只留「该面」那一列（Gitea #9，方案 A）。
     * <p>
     * <b>面号从哪来</b>：只认「含 {@code :面号} 的原始材质键 / sprite 注册名」（{@code spr.getIconName()} 优先，
     * 入参 raw locator 兜底）。<b>绝不能</b>取自 {@link ExportTextureLocator#normalizeLocatorForBundle} 之后的
     * locator——它把 {@code :0..15} 当世界 meta 剥掉了，面号在那里已经不存在（这正是缺陷的成因之一）。
     * <p>
     * 判定与裁切口径见 {@link TextureStripCrop}（方形格 / {@code pngHeight == iconHeight} / 宽整除 / 列号
     * {@code faceIndex % count}）。任何一步不成立都返回 {@code null}，调用方原样使用磁盘字节——即「不确定就不裁」，
     * 不猜第 0 列。
     *
     * @param diskPng     {@code tryLoadPng*} 读出的原始 PNG 字节
     * @param materialKey 原材料键（含 {@code :面号}）；同时用于 sprite 查找与面号兜底
     * @param knownSprite 已经查到的 sprite（可空；给了就不再重复查表）
     * @return 该面那一列的 PNG；不适用/失败时 {@code null}
     */
    private static byte[] cropHorizontalStripColumnIfAny(byte[] diskPng, String materialKey, boolean standalone,
        TextureMap spriteAtlas, TextureAtlasSprite knownSprite) {
        int[] size = TextureStripCrop.readPngSize(diskPng);
        if (size == null) {
            return null;
        }
        int pngWidth = size[0];
        int pngHeight = size[1];
        /*
         * 便宜的前置过滤：只有「宽 > 高 且 高整除宽」才可能是横向多面带。
         * 常规正方形贴图在此直接返回，不触发 sprite 全表查找（导出可能有上千条材质）。
         */
        if (pngWidth <= pngHeight || pngWidth % pngHeight != 0) {
            return null;
        }
        if (standalone) {
            return null;
        }
        TextureAtlasSprite spr = knownSprite;
        if (spr == null) {
            for (TextureMap m : atlasProbeOrderForSpriteLookup(materialKey, spriteAtlas)) {
                spr = MaterialKeyResolver.findSpriteForMaterialKey(materialKey, m);
                if (spr != null) {
                    break;
                }
            }
        }
        if (spr == null) {
            return null;
        }
        int faceIndex = TextureStripCrop.faceIndexFromName(spr.getIconName());
        if (faceIndex < 0) {
            faceIndex = TextureStripCrop.faceIndexFromName(materialKey);
        }
        int iconWidth = spr.getIconWidth();
        int iconHeight = spr.getIconHeight();
        int column = TextureStripCrop.columnIndexForFace(pngWidth, pngHeight, iconWidth, iconHeight, faceIndex);
        if (column < 0) {
            return null;
        }
        try {
            byte[] cropped = TextureStripCrop.cropColumn(diskPng, column, iconWidth, iconHeight);
            FMLLog.info(
                "[SDE] TextureBlobEmbedder: 横向多面子图带按面号裁列 locator=%s 带=%dx%d 面号=%d 列=%d/%d 格=%dx%d",
                materialKey,
                Integer.valueOf(pngWidth),
                Integer.valueOf(pngHeight),
                Integer.valueOf(faceIndex),
                Integer.valueOf(column),
                Integer.valueOf(pngWidth / iconWidth),
                Integer.valueOf(iconWidth),
                Integer.valueOf(iconHeight));
            return cropped;
        } catch (Exception e) {
            FMLLog.warning(
                "[SDE] TextureBlobEmbedder: 横向多面带裁列失败，回退整图（locator=%s, %dx%d, %s）",
                materialKey,
                Integer.valueOf(pngWidth),
                Integer.valueOf(pngHeight),
                e.toString());
            return null;
        }
    }

    /** Read sprite pixels from the GPU atlas texture via glGetTexImage. */
    private static byte[] readSpriteFromGpuAtlas(TextureAtlasSprite spr, TextureMap atlas) {
        int texId = atlas.getGlTextureId();
        if (texId <= 0) return null;
        int prevTex = GL11.glGetInteger(GL11.GL_TEXTURE_BINDING_2D);
        GL11.glBindTexture(GL11.GL_TEXTURE_2D, texId);
        try {
            int atlasW = GL11.glGetTexLevelParameteri(GL11.GL_TEXTURE_2D, 0, GL11.GL_TEXTURE_WIDTH);
            int atlasH = GL11.glGetTexLevelParameteri(GL11.GL_TEXTURE_2D, 0, GL11.GL_TEXTURE_HEIGHT);
            if (atlasW <= 0 || atlasH <= 0) return null;
            java.nio.IntBuffer buf = java.nio.ByteBuffer.allocateDirect(atlasW * atlasH * 4)
                .order(java.nio.ByteOrder.nativeOrder())
                .asIntBuffer();
            GL11.glGetTexImage(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
            int[] full = new int[atlasW * atlasH];
            buf.get(full);
            // Sprite UV bounds
            int px = Math.max(0, (int) Math.floor(spr.getMinU() * atlasW));
            int py = Math.max(0, (int) Math.floor(spr.getMinV() * atlasH));
            int pw = Math.min(atlasW - px, (int) Math.ceil(spr.getMaxU() * atlasW) - px);
            int ph = Math.min(atlasH - py, (int) Math.ceil(spr.getMaxV() * atlasH) - py);
            if (pw <= 0 || ph <= 0) return null;
            int[] sub = new int[pw * ph];
            for (int row = 0; row < ph; row++) {
                System.arraycopy(full, (py + row) * atlasW + px, sub, row * pw, pw);
            }
            // Flip RGBA → ARGB for BufferedImage
            for (int i = 0; i < sub.length; i++) {
                int c = sub[i];
                int a = (c >> 24) & 0xff;
                int r = (c >> 0) & 0xff;
                int g = (c >> 8) & 0xff;
                int b = (c >> 16) & 0xff;
                sub[i] = (a << 24) | (r << 16) | (g << 8) | b;
            }
            return rgbaArrayToPng(sub, pw, ph);
        } catch (Exception e) {
            FMLLog.info("[SDE] GPU atlas readback failed for %s: %s", spr.getIconName(), e.toString());
            return null;
        } finally {
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, prevTex);
        }
    }

    /**
     * GregTech {@code materialicons/} 精灵在物品图集；其它材质按 palette 主选图集再试另一套。
     */
    private static List<TextureMap> atlasProbeOrderForSpriteLookup(String locator, TextureMap primary) {
        List<TextureMap> out = new ArrayList<>(2);
        Minecraft mc = Minecraft.getMinecraft();
        TextureMap blocks = mc.getTextureMapBlocks();
        TextureMap items = MaterialKeyResolver.getTextureMapItems(mc);
        String norm = ExportTextureLocator.normalizeLocatorForBundle(locator);
        if (norm != null) {
            int c = norm.indexOf(':');
            if (c >= 0) {
                String path = norm.substring(c + 1);
                if (path.startsWith("materialicons/")) {
                    addUniqueAtlas(out, items);
                    addUniqueAtlas(out, blocks);
                    return out;
                }
            }
        }
        addUniqueAtlas(out, primary != null ? primary : blocks);
        TextureMap other = primary == blocks || primary == null ? items : blocks;
        addUniqueAtlas(out, other);
        return out;
    }

    private static void addUniqueAtlas(List<TextureMap> out, TextureMap m) {
        if (m == null) {
            return;
        }
        for (TextureMap x : out) {
            if (x == m) {
                return;
            }
        }
        out.add(m);
    }

    private static byte[] tryLoadPngForNormalizedLocator(IResourceManager rm, String locator) {
        String norm = ExportTextureLocator.normalizeLocatorForBundle(locator);
        if (norm == null) {
            return null;
        }
        for (ResourceLocation rl : ExportTextureLocator.texturePngResourceLocationsForBundle(norm)) {
            byte[] b = tryLoadPng(rm, rl);
            if (b != null) {
                return b;
            }
        }
        return null;
    }

    private static byte[] tryLoadPng(IResourceManager rm, ResourceLocation rl) {
        if (rl == null) {
            return null;
        }
        try (InputStream in = rm.getResource(rl)
            .getInputStream()) {
            return readAll(in);
        } catch (IOException ignored) {
            return null;
        }
    }

    private static byte[] rgbaArrayToPng(int[] argb, int w, int h) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        img.setRGB(0, 0, w, h, argb, 0, w);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ImageIO.write(img, "PNG", bos);
        return bos.toByteArray();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
