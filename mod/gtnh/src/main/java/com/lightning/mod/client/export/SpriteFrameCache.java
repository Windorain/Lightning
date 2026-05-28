package com.lightning.mod.client.export;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 在 {@code clearFramesTextureData} 之前保存 sprite 帧像素，
 * 供 {@link TextureBlobEmbedder} 在图集上传后仍能读取程序化生成的纹理。
 */
@SideOnly(Side.CLIENT)
public final class SpriteFrameCache {

    private static final Map<String, int[]> CACHE = new ConcurrentHashMap<>();

    private SpriteFrameCache() {}

    private static String normalizeKey(String iconName) {
        if (iconName == null) return null;
        int c = iconName.indexOf(':');
        if (c >= 0) {
            return iconName.substring(0, c)
                .toLowerCase(java.util.Locale.ROOT) + iconName.substring(c);
        }
        return iconName;
    }

    public static void put(String iconName, int w, int h, int[] argb) {
        if (iconName == null || iconName.isEmpty() || argb == null || argb.length != w * h) return;
        int[] copy = new int[argb.length];
        System.arraycopy(argb, 0, copy, 0, argb.length);
        CACHE.put(normalizeKey(iconName), copy);
    }

    public static int[] get(String iconName) {
        return CACHE.get(normalizeKey(iconName));
    }
}
