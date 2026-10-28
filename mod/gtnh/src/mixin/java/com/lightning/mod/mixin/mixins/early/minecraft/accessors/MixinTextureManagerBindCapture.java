package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.util.ResourceLocation;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 录制期间记录当前绑定的纹理，供 {@link com.lightning.mod.client.meshcapture.MaterialKeyResolver}
 * 在 UV 无法落入方块图集时回退（TESR / 实体贴图等）。
 */
@Mixin(TextureManager.class)
public abstract class MixinTextureManagerBindCapture {

    @Inject(method = "bindTexture", at = @At("HEAD"))
    private void sde$noteBind(ResourceLocation resource, CallbackInfo ci) {
        TessellatorCaptureState.noteTextureBind(resource);
    }
}
