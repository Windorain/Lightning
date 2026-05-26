package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.data.AnimationMetadataSection;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.export.SpriteFrameCache;
import com.lightning.mod.mixin.interfaces.accessors.TextureAtlasSpriteAccessor;

@Mixin(TextureAtlasSprite.class)
public abstract class MixinTextureAtlasSprite implements TextureAtlasSpriteAccessor {

    @Shadow
    private AnimationMetadataSection animationMetadata;

    @Override
    public AnimationMetadataSection sde$getAnimationMetadata() {
        return animationMetadata;
    }

    /**
     * 兜底缓存：在 clearFramesTextureData 前保存帧数据。
     * 主缓存入口在 {@link MixinResourceManagerReload}（notifyReloadListeners TAIL），
     * 确保在 JABBA generateIcons 执行后才保存。
     */
    @Inject(method = "clearFramesTextureData", at = @At("HEAD"))
    private void sde$cacheBeforeClear(CallbackInfo ci) {
        TextureAtlasSprite self = (TextureAtlasSprite) (Object) this;
        try {
            int w = self.getIconWidth();
            int h = self.getIconHeight();
            if (w > 0 && h > 0) {
                String name = self.getIconName();
                if (name != null && !name.isEmpty()) {
                    int[][] fd = self.getFrameTextureData(0);
                    if (fd != null && fd.length > 0 && fd[0] != null && fd[0].length == w * h) {
                        SpriteFrameCache.put(name, w, h, fd[0]);
                    }
                }
            }
        } catch (Exception ignored) {
            // Frame data not accessible; skip
        }
    }
}
