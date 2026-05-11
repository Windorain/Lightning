package com.lightning.mod.client.meshcapture;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;

import com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * Maps atlas UV to a stable sprite name (materialKey) by containment test; prefers smallest sprite area on ties.
 * MC 1.7.10 有方块与物品两套 {@link TextureMap}；绑定以 {@link TessellatorCaptureState} 顶点级快照聚合为准。
 */
@SideOnly(Side.CLIENT)
public final class MaterialKeyResolver {

    private MaterialKeyResolver() {}

    public static String resolveMidUv(double u, double v) {
        TextureMap map = Minecraft.getMinecraft()
            .getTextureMapBlocks();
        return resolveMidUv(u, v, map);
    }

    public static String resolveMidUv(double u, double v, TextureMap map) {
        if (!(map instanceof TextureMapAccessor)) {
            return "unknown";
        }
        Map<String, TextureAtlasSprite> sprites = ((TextureMapAccessor) map).sde$getMapRegisteredSprites();
        double bestArea = Double.POSITIVE_INFINITY;
        String bestName = "unknown";
        for (TextureAtlasSprite spr : sprites.values()) {
            double minU = spr.getMinU();
            double maxU = spr.getMaxU();
            double minV = spr.getMinV();
            double maxV = spr.getMaxV();
            if (u + 1e-6 >= minU && u <= maxU + 1e-6 && v + 1e-6 >= minV && v <= maxV + 1e-6) {
                double area = (maxU - minU) * (maxV - minV);
                if (area < bestArea) {
                    bestArea = area;
                    bestName = spr.getIconName();
                }
            }
        }
        return normalizeMaterialKey(bestName);
    }

    /** Strip leading {@code textures/} and trailing {@code .png} if present for Wiki locator style. */
    public static String normalizeMaterialKey(String iconName) {
        if (iconName == null || iconName.isEmpty()) {
            return "unknown";
        }
        String s = iconName;
        if (s.startsWith("textures/")) {
            s = s.substring("textures/".length());
        }
        if (s.endsWith(".png")) {
            s = s.substring(0, s.length() - 4);
        }
        s = s.replace('\\', '/');
        int c = s.indexOf(':');
        if (c >= 0) {
            String ns = s.substring(0, c);
            String path = s.substring(c + 1);
            s = ns.toLowerCase(Locale.ROOT) + ":" + path;
        }
        return s;
    }

    /** 方块/物品图集 bind；此类 UV 应由 {@link #resolveMidUv} 解析，不可用作独立贴图 fallback。 */
    public static boolean isAtlasBindMaterialKey(String domainAndPathKey) {
        if (domainAndPathKey == null || domainAndPathKey.isEmpty()) {
            return false;
        }
        String s = domainAndPathKey;
        int c = s.indexOf(':');
        if (c >= 0) {
            s = s.substring(c + 1);
        }
        return s.contains("atlas/blocks") || s.contains("atlas/items");
    }

    /** 与 {@link TessellatorCaptureState#noteTextureBind} 写入的 hint 一致（path 段经 {@link #normalizeMaterialKey}）。 */
    public static boolean isItemsAtlasBindHint(String hint) {
        if (hint == null || hint.isEmpty()) {
            return false;
        }
        String s = hint;
        int c = s.indexOf(':');
        if (c >= 0) {
            s = s.substring(c + 1);
        }
        return s.contains("atlas/items");
    }

    /**
     * 物品图集 {@link TextureMap#locationItemsTexture}；与方块图集并列存在于
     * {@link net.minecraft.client.renderer.texture.TextureManager}。
     */
    public static TextureMap getTextureMapItems(Minecraft mc) {
        if (mc == null || mc.getTextureManager() == null) {
            return null;
        }
        net.minecraft.client.renderer.texture.ITextureObject tex = mc.getTextureManager()
            .getTexture(TextureMap.locationItemsTexture);
        return tex instanceof TextureMap ? (TextureMap) tex : null;
    }

    /**
     * 按与 {@link #normalizeMaterialKey} 一致的键在图集中查找 sprite，供将图集 UV 换算为 sprite 局部 [0,1]。
     */
    public static TextureAtlasSprite findSpriteForMaterialKey(String materialKey, TextureMap map) {
        if (materialKey == null || materialKey.isEmpty() || "unknown".equals(materialKey)) {
            return null;
        }
        if (!(map instanceof TextureMapAccessor)) {
            return null;
        }
        String want = normalizeMaterialKey(materialKey);
        Map<String, TextureAtlasSprite> sprites = ((TextureMapAccessor) map).sde$getMapRegisteredSprites();
        for (TextureAtlasSprite spr : sprites.values()) {
            if (spr == null) {
                continue;
            }
            if (normalizeMaterialKey(spr.getIconName()).equals(want)) {
                return spr;
            }
        }
        return null;
    }

    /**
     * 由四边形在图集中的 UV 质心解析 {@code materialKey}，将顶点 UV 重映射为 sprite 局部 [0,1]，并写回 {@code q}。
     *
     * @return 与 {@link #normalizeMaterialKey} 一致的材质键，供采样器表注册
     */
    public static String applySpriteLocalToQuad(TessellatorCaptureState.CapturedQuad q, TextureMap textureMap) {
        /*
         * TESR/实体贴图：顶点 UV 在「当前绑定的非图集纹理」的 [0,1] 空间。若先对 blocks 图集做 resolveMidUv，
         * 质心常会误落入某 atlas 小格并被 remap，导致导出后黑块/错纹（例：箱子顶面、锁扣）。
         */
        String hint = q.bindTextureHint;
        if (hint != null && !hint.isEmpty() && !isAtlasBindMaterialKey(hint)) {
            q.materialUsesStandaloneTexture = true;
            q.materialKey = hint;
            return hint;
        }
        TextureMap activeAtlas = textureMap;
        if (hint != null && isAtlasBindMaterialKey(hint) && isItemsAtlasBindHint(hint)) {
            TextureMap items = getTextureMapItems(Minecraft.getMinecraft());
            if (items instanceof TextureMapAccessor) {
                activeAtlas = items;
            }
        }
        double su = 0, sv = 0;
        for (TessellatorCaptureState.CapturedVertex v : q.vertices) {
            su += v.u;
            sv += v.v;
        }
        int vn = q.vertices.size();
        if (vn <= 0) {
            q.materialKey = "unknown";
            return "unknown";
        }
        su /= vn;
        sv /= vn;
        String materialKey = resolveMidUv(su, sv, activeAtlas);
        TextureAtlasSprite spr = findSpriteForMaterialKey(materialKey, activeAtlas);
        if (spr == null) {
            TextureMap items = getTextureMapItems(Minecraft.getMinecraft());
            TextureMap blocks = textureMap;
            for (TextureMap tryMap : new TextureMap[] { items, blocks }) {
                if (!(tryMap instanceof TextureMapAccessor) || tryMap == activeAtlas) {
                    continue;
                }
                String mk2 = resolveMidUv(su, sv, tryMap);
                TextureAtlasSprite sp2 = findSpriteForMaterialKey(mk2, tryMap);
                if (sp2 != null) {
                    materialKey = mk2;
                    spr = sp2;
                    activeAtlas = tryMap;
                    break;
                }
            }
        }
        q.materialUsesStandaloneTexture = false;
        if ("unknown".equals(materialKey) && hint != null && !hint.isEmpty() && !isAtlasBindMaterialKey(hint)) {
            materialKey = hint;
            spr = null;
            q.materialUsesStandaloneTexture = true;
        } else {
            q.materialAtlasKind = activeAtlas == textureMap ? "blocks" : "items";
        }
        List<TessellatorCaptureState.CapturedVertex> remapped = new ArrayList<>(4);
        for (TessellatorCaptureState.CapturedVertex v : q.vertices) {
            double u = v.u;
            double vv = v.v;
            if (spr != null) {
                double minU = spr.getMinU();
                double maxU = spr.getMaxU();
                double minV = spr.getMinV();
                double maxV = spr.getMaxV();
                double du = maxU - minU;
                double dvv = maxV - minV;
                if (du > 1e-9 && dvv > 1e-9) {
                    u = (v.u - minU) / du;
                    vv = (v.v - minV) / dvv;
                }
            }
            remapped.add(
                new TessellatorCaptureState.CapturedVertex(
                    v.x,
                    v.y,
                    v.z,
                    u,
                    vv,
                    v.brightness,
                    v.colorArgb,
                    v.tessOffsetX,
                    v.tessOffsetY,
                    v.tessOffsetZ,
                    v.textureBindHintAtVertex));
        }
        q.vertices.clear();
        q.vertices.addAll(remapped);
        q.materialKey = materialKey;
        return materialKey;
    }
}
