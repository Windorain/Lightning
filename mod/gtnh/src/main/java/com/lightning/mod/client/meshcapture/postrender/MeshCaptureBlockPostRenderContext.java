package com.lightning.mod.client.meshcapture.postrender;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 单格 mesh 捕获在「主方块绘制之后、{@code Tessellator#draw} 之前」的后处理渲染上下文。
 */
@SideOnly(Side.CLIENT)
public final class MeshCaptureBlockPostRenderContext {

    private final World world;
    private final int wx;
    private final int wy;
    private final int wz;
    private final Block block;
    private final int meta;
    private final RenderBlocks renderBlocks;
    private final float partialTicks;

    private TileEntity tileEntityResolved;
    private boolean tileEntityLookupDone;

    public MeshCaptureBlockPostRenderContext(World world, int wx, int wy, int wz, Block block, int meta,
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

    /** 懒查，避免非 multipart 格的无谓 TE 查询。 */
    public TileEntity getTileEntity() {
        if (!tileEntityLookupDone) {
            tileEntityResolved = world.getTileEntity(wx, wy, wz);
            tileEntityLookupDone = true;
        }
        return tileEntityResolved;
    }
}
