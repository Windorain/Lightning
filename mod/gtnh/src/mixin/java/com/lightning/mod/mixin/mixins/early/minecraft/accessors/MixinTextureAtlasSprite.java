package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.data.AnimationMetadataSection;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;

import com.lightning.mod.mixin.interfaces.accessors.TextureAtlasSpriteAccessor;

@Mixin(TextureAtlasSprite.class)
public abstract class MixinTextureAtlasSprite implements TextureAtlasSpriteAccessor {

    @Shadow
    private AnimationMetadataSection animationMetadata;

    @Override
    public AnimationMetadataSection sde$getAnimationMetadata() {
        return animationMetadata;
    }
}
