package com.lightning.mod.client.meshcapture.primary;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.world.World;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 单格 mesh 捕获「主批次」上下文：{@link net.minecraft.client.renderer.Tessellator#startDrawingQuads()} 之后、首次 {@code draw} 之前。
 */
@SideOnly(Side.CLIENT)
public final class BlockPrimaryCaptureContext {

    private final World world;
    private final int wx;
    private final int wy;
    private final int wz;
    private final Block block;
    private final int meta;
    private final RenderBlocks renderBlocks;
    private final float partialTicks;

    public BlockPrimaryCaptureContext(World world, int wx, int wy, int wz, Block block, int meta,
        RenderBlocks renderBlocks, float partialTicks) {
        this.world = world;
        this.wx = wx;
        this.wy = wy;
        this.wz = wz;
        this.block = block;
        this.meta = meta;
        this.renderBlocks = renderBlocks;
        this.partialTicks = partialTicks;
    }

    public World getWorld() {
        return world;
    }

    public int getWx() {
        return wx;
    }

    public int getWy() {
        return wy;
    }

    public int getWz() {
        return wz;
    }

    public Block getBlock() {
        return block;
    }

    public int getMeta() {
        return meta;
    }

    public RenderBlocks getRenderBlocks() {
        return renderBlocks;
    }

    public float getPartialTicks() {
        return partialTicks;
    }
}
