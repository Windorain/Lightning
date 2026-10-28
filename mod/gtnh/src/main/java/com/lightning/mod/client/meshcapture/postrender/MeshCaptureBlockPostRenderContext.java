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

    /** 捕获路径注入的 TE 覆盖（副本 TE）；{@code hasTileEntityOverride} 为 false 时才懒查世界 TE。 */
    private final TileEntity tileEntityOverride;
    private final boolean hasTileEntityOverride;

    private TileEntity tileEntityResolved;
    private boolean tileEntityLookupDone;

    public MeshCaptureBlockPostRenderContext(World world, int wx, int wy, int wz, Block block, int meta,
        RenderBlocks renderBlocks, float partialTicks) {
        this(world, wx, wy, wz, block, meta, renderBlocks, partialTicks, null, false);
    }

    /**
     * 带 TE 覆盖的构造（既有 8 参构造签名保持兼容）。
     * <p>
     * {@code tileEntityOverride} 是该格后处理渲染要用的 TE，{@code null} 表示<strong>明确不做</strong> TE 渲染
     * （策略须判空跳过，而不是回退查世界 TE）。捕获路径用「按扫描 NBT 造出的副本 TE」走本构造，从而无需对世界
     * 活动 TE 做 {@code readFromNBT}——LogisticsPipes 等模组的 {@code readFromNBT} 非幂等（一次性绑定守卫），
     * 就地改写会永久改坏世界里的 TE。
     */
    public MeshCaptureBlockPostRenderContext(World world, int wx, int wy, int wz, Block block, int meta,
        RenderBlocks renderBlocks, float partialTicks, TileEntity tileEntityOverride) {
        this(world, wx, wy, wz, block, meta, renderBlocks, partialTicks, tileEntityOverride, true);
    }

    private MeshCaptureBlockPostRenderContext(World world, int wx, int wy, int wz, Block block, int meta,
        RenderBlocks renderBlocks, float partialTicks, TileEntity tileEntityOverride, boolean hasTileEntityOverride) {
        this.world = world;
        this.wx = wx;
        this.wy = wy;
        this.wz = wz;
        this.block = block;
        this.meta = meta;
        this.renderBlocks = renderBlocks;
        this.partialTicks = partialTicks;
        this.tileEntityOverride = tileEntityOverride;
        this.hasTileEntityOverride = hasTileEntityOverride;
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

    /**
     * 捕获路径注入的 TE 覆盖优先；未注入时懒查世界 TE，避免非 multipart 格的无谓查询。
     * <p>
     * 覆盖为 {@code null} 表示「该格明确不做 TE 渲染」：调用方须判空跳过，<strong>不得</strong>回退查世界 TE。
     */
    public TileEntity getTileEntity() {
        if (hasTileEntityOverride) {
            return tileEntityOverride;
        }
        if (!tileEntityLookupDone) {
            tileEntityResolved = world.getTileEntity(wx, wy, wz);
            tileEntityLookupDone = true;
        }
        return tileEntityResolved;
    }
}
