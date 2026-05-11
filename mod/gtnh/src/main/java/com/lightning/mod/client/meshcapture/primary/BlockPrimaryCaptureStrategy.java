package com.lightning.mod.client.meshcapture.primary;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 主批次捕获：在 {@link net.minecraft.client.renderer.Tessellator#startDrawingQuads()} 之后绘制方块静态几何（经
 * {@link net.minecraft.client.renderer.RenderBlocks} / ISBRH）。
 */
@SideOnly(Side.CLIENT)
public interface BlockPrimaryCaptureStrategy {

    /**
     * 数值越小越先参与检测；内置 {@link VanillaPrimaryBlockCaptureStrategy} 使用较大值作为默认兜底。
     */
    int priority();

    boolean applies(BlockPrimaryCaptureContext ctx);

    void renderPrimary(BlockPrimaryCaptureContext ctx);
}
