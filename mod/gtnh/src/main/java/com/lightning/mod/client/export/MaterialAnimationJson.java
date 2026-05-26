package com.lightning.mod.client.export;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.data.AnimationMetadataSection;
import net.minecraft.util.ResourceLocation;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.mixin.interfaces.accessors.TextureAtlasSpriteAccessor;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 与 Wiki {@code MaterialAnimationSpec} 对齐的
 * JSON：{@code defaultFrametimeTicks}、{@code frameSequence[].index|timeTicks}、{@code interpolate}。
 * 优先自 {@code .png.mcmeta} 解析（可含 {@code interpolate}），否则回退 {@link AnimationMetadataSection}（与游戏运行时一致）。
 */
@SideOnly(Side.CLIENT)
public final class MaterialAnimationJson {

    private MaterialAnimationJson() {}

    public static JsonObject fromMcmetaRoot(JsonObject root) {
        if (root == null || !root.has("animation")) {
            return null;
        }
        JsonElement animEl = root.get("animation");
        if (animEl == null || !animEl.isJsonObject()) {
            return null;
        }
        JsonObject anim = animEl.getAsJsonObject();
        JsonObject out = new JsonObject();
        int defaultFt = 1;
        if (anim.has("frametime") && anim.get("frametime")
            .isJsonPrimitive()) {
            try {
                int v = anim.get("frametime")
                    .getAsInt();
                if (v >= 1) {
                    defaultFt = v;
                }
            } catch (Throwable ignored) {
                /* use 1 */
            }
        }
        out.addProperty("defaultFrametimeTicks", defaultFt);
        if (anim.has("interpolate") && anim.get("interpolate")
            .isJsonPrimitive()) {
            try {
                out.addProperty(
                    "interpolate",
                    anim.get("interpolate")
                        .getAsBoolean());
            } catch (Throwable ignored) {
                /* skip */
            }
        }
        if (anim.has("frames") && anim.get("frames")
            .isJsonArray()) {
            JsonArray seq = new JsonArray();
            JsonArray frames = anim.getAsJsonArray("frames");
            for (JsonElement item : frames) {
                if (item.isJsonPrimitive() && item.getAsJsonPrimitive()
                    .isNumber()) {
                    JsonObject o = new JsonObject();
                    o.addProperty("index", item.getAsInt());
                    seq.add(o);
                } else if (item.isJsonObject()) {
                    JsonObject fo = item.getAsJsonObject();
                    if (!fo.has("index")) {
                        continue;
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty(
                        "index",
                        fo.get("index")
                            .getAsInt());
                    if (fo.has("time")) {
                        JsonElement te = fo.get("time");
                        if (te.isJsonPrimitive() && te.getAsJsonPrimitive()
                            .isNumber()) {
                            int t = te.getAsInt();
                            if (t >= 1) {
                                o.addProperty("timeTicks", t);
                            }
                        }
                    }
                    seq.add(o);
                }
            }
            out.add("frameSequence", seq);
        }
        return out;
    }

    public static JsonObject fromAnimationMetadataSection(AnimationMetadataSection meta) {
        if (meta == null) {
            return null;
        }
        JsonObject out = new JsonObject();
        int ft = meta.getFrameTime();
        if (ft < 1) {
            ft = 1;
        }
        out.addProperty("defaultFrametimeTicks", ft);
        int n = meta.getFrameCount();
        if (n > 0) {
            JsonArray seq = new JsonArray();
            for (int i = 0; i < n; i++) {
                JsonObject o = new JsonObject();
                o.addProperty("index", meta.getFrameIndex(i));
                if (meta.frameHasTime(i)) {
                    o.addProperty("timeTicks", meta.getFrameTimeSingle(i));
                }
                seq.add(o);
            }
            out.add("frameSequence", seq);
        }
        return out;
    }

    /**
     * @param normalizedLocator {@link ExportTextureLocator#normalizeLocatorForBundle}
     */
    public static JsonObject tryResolveForMaterial(Minecraft mc, String normalizedLocator, TextureAtlasSprite spr) {
        if (mc != null && normalizedLocator != null) {
            for (ResourceLocation png : ExportTextureLocator.texturePngResourceLocationsForBundle(normalizedLocator)) {
                String path = png.getResourcePath();
                if (!path.endsWith(".png")) {
                    continue;
                }
                ResourceLocation mcmeta = new ResourceLocation(png.getResourceDomain(), path + ".mcmeta");
                try (InputStream in = mc.getResourceManager()
                    .getResource(mcmeta)
                    .getInputStream()) {
                    String raw = readUtf8(in);
                    JsonObject root = new JsonParser().parse(raw)
                        .getAsJsonObject();
                    JsonObject a = fromMcmetaRoot(root);
                    if (a != null) {
                        return a;
                    }
                } catch (IOException ignored) {
                    /* try next candidate / fallback */
                }
            }
        }
        if (spr instanceof TextureAtlasSpriteAccessor) {
            AnimationMetadataSection meta = ((TextureAtlasSpriteAccessor) spr).sde$getAnimationMetadata();
            return fromAnimationMetadataSection(meta);
        }
        return null;
    }

    static String readUtf8(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) >= 0) {
            buf.write(b, 0, n);
        }
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }
}
