package com.lightning.mod.client.meshcapture.parts;

import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件提供者调用上下文：一格（世界坐标）+ 该格方块与 meta。
 *
 * <p>
 * 权威盒接口（{@code getSelectedBoundingBoxFromPool} 等）仅客户端可用（契约 §7 说明），
 * 因此 {@link #world} 在真实导出路径恒为客户端世界 {@code mc.theWorld}。
 *
 * <p>
 * {@link #bakedQuads}（可空）：该格<strong>客户端烘焙四边形</strong>（块局部 [0,1]³
 * 快照），真实导出路径由 {@code MeshCaptureService} 逐格捕获循环在
 * {@code TessellatorCaptureState.endBlock} 后传入；为 null 时档 3 几何推断提供者自行现场烘焙
 * （{@code parts/inferred/CellQuadBaker}，挂点见该类注释）。
 */
@SideOnly(Side.CLIENT)
public final class PartProviderContext {

    public final World world;
    public final int x;
    public final int y;
    public final int z;
    public final Block block;
    public final int meta;
    /** 可空：该格烘焙四边形快照（块局部 [0,1]³）；档 3 几何推断的输入。 */
    public final List<CapturedQuad> bakedQuads;

    public PartProviderContext(World world, int x, int y, int z, Block block, int meta) {
        this(world, x, y, z, block, meta, null);
    }

    public PartProviderContext(World world, int x, int y, int z, Block block, int meta, List<CapturedQuad> bakedQuads) {
        this.world = world;
        this.x = x;
        this.y = y;
        this.z = z;
        this.block = block;
        this.meta = meta;
        this.bakedQuads = bakedQuads;
    }
}
