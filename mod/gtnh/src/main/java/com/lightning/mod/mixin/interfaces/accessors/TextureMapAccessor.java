package com.lightning.mod.mixin.interfaces.accessors;

import java.util.Map;

import net.minecraft.client.renderer.texture.TextureAtlasSprite;

/**
 * 方块 {@link net.minecraft.client.renderer.texture.TextureMap} 上已注册精灵表（与 Mixin 实现配合）。
 */
public interface TextureMapAccessor {

    Map<String, TextureAtlasSprite> sde$getMapRegisteredSprites();
}
