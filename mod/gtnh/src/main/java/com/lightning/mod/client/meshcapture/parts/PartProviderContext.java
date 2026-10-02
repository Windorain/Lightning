package com.lightning.mod.client.meshcapture.parts;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件提供者调用上下文：一格（世界坐标）+ 该格方块与 meta。
 *
 * <p>
 * 权威盒接口（{@code getSelectedBoundingBoxFromPool} 等）仅客户端可用（契约 §7 说明），
 * 因此 {@link #world} 在真实导出路径恒为客户端世界 {@code mc.theWorld}。
 */
@SideOnly(Side.CLIENT)
public final class PartProviderContext {

    public final World world;
    public final int x;
    public final int y;
    public final int z;
    public final Block block;
    public final int meta;

    public PartProviderContext(World world, int x, int y, int z, Block block, int meta) {
        this.world = world;
        this.x = x;
        this.y = y;
        this.z = z;
        this.block = block;
        this.meta = meta;
    }
}
