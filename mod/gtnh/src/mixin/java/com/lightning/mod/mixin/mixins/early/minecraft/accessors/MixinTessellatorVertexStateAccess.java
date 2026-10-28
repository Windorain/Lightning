package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.renderer.Tessellator;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 「忠实复现捕获层」1.0：{@link Tessellator} 顶点状态只读访问器。
 * <p>
 * 为什么存在：{@code MixinDirectTessellatorCapture} 需要读 GTNHLib {@code DirectTessellator} 从
 * {@code Tessellator} 继承的私有实例字段（textureU/textureV/color/brightness/hasXxx/offset/drawMode）。
 * Mixin 0.8.5 的 {@code @Shadow} 预处理只查目标类<strong>自身声明</strong>的字段（实测：跨类层次 shadow
 * 直接 MixinApplyError 崩启动），故对继承字段走「基类访问器接口 + 实例强转」这条标准路径：
 * 访问器打在基类 {@code Tessellator} 上，所有子类实例天然实现本接口。
 * <p>
 * 纯观察论证：全部是只读 getter，无任何写路径。
 */
@Mixin(Tessellator.class)
public interface MixinTessellatorVertexStateAccess {

    @Accessor("textureU")
    double sde$textureU();

    @Accessor("textureV")
    double sde$textureV();

    @Accessor("brightness")
    int sde$brightness();

    @Accessor("color")
    int sde$color();

    @Accessor("hasColor")
    boolean sde$hasColor();

    @Accessor("hasTexture")
    boolean sde$hasTexture();

    @Accessor("hasBrightness")
    boolean sde$hasBrightness();

    @Accessor("xOffset")
    double sde$xOffset();

    @Accessor("yOffset")
    double sde$yOffset();

    @Accessor("zOffset")
    double sde$zOffset();

    @Accessor("drawMode")
    int sde$drawMode();
}
