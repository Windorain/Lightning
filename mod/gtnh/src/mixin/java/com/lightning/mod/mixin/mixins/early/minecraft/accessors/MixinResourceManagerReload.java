package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import java.util.Map;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.client.resources.SimpleReloadableResourceManager;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.export.SpriteFrameCache;
import com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor;

/**
 * 在所有资源重载 listener（含 JABBA 的 generateIcons）执行完毕后，
 * 从 TextureMap 扫描并缓存所有 sprite 帧数据，捕获程序化生成的纹理。
 */
@Mixin(
    value = SimpleReloadableResourceManager.class,
    remap = false)
public abstract class MixinResourceManagerReload {

    @Inject(method = "notifyReloadListeners", at = @At("TAIL"), remap = false)
    private void sde$captureAfterReload(CallbackInfo ci) {
        try {
            Minecraft mc = Minecraft.getMinecraft();
            if (mc == null) return;
            TextureMap blocks = mc.getTextureMapBlocks();
            if (!(blocks instanceof TextureMapAccessor)) return;
            Map<String, TextureAtlasSprite> sprites = ((TextureMapAccessor) blocks).sde$getMapRegisteredSprites();
            for (TextureAtlasSprite spr : sprites.values()) {
                try {
                    int w = spr.getIconWidth();
                    int h = spr.getIconHeight();
                    String name = spr.getIconName();
                    if (w > 0 && h > 0 && name != null && !name.isEmpty()) {
                        int[][] fd = spr.getFrameTextureData(0);
                        if (fd != null && fd.length > 0 && fd[0] != null && fd[0].length == w * h) {
                            SpriteFrameCache.put(name, w, h, fd[0]);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
    }
}
