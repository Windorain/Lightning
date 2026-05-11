package com.lightning.mod.client.meshcapture;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.IBlockAccess;
import net.minecraft.world.World;
import net.minecraft.world.biome.BiomeGenBase;
import net.minecraftforge.common.util.ForgeDirection;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 结构索引坐标 {@code (x,y,z)} 与 {@link com.lightning.mod.core.scan.StructureScan} /
 * {@code MeshCaptureService} 循环一致；
 * 映射到世界格后委托 {@link World}。查询<strong>不限制</strong>在 cellGrid 体积内：邻格用真实世界坐标查询。
 * <p>
 * AE2 {@code CableRenderHelper} / {@code PartCable#renderStatic} 向 {@link RenderBlocks} 传入的是 {@code TileEntity}
 * 的<strong>世界</strong>
 * 坐标；若对本类一律做 {@link #structToWorld}，会把世界坐标误当结构索引再映射，导致几何为 0（运行时可见 {@code rawVertexCount==0}）。
 * 约定：仅当 {@code (x,y,z)} 落在结构体索引包围盒内时按结构坐标映射，否则视为已是世界坐标并直接查 {@link World}。
 */
@SideOnly(Side.CLIENT)
public final class WorldDelegatingBlockAccess implements IBlockAccess {

    private final World world;
    private final int minX;
    private final int minY;
    private final int minZ;
    private final int maxX;
    private final int maxY;
    private final int maxZ;
    /** 与 scanBounds 一致：{@code minX, maxY, minZ} */
    private final int originX;
    private final int originTopY;
    private final int originZ;

    public WorldDelegatingBlockAccess(World world, int minX, int minY, int minZ, int maxX, int maxY, int maxZ,
        int scanMinX, int scanMaxY, int scanMinZ) {
        this.world = world;
        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.maxX = maxX;
        this.maxY = maxY;
        this.maxZ = maxZ;
        this.originX = scanMinX;
        this.originTopY = scanMaxY;
        this.originZ = scanMinZ;
    }

    public boolean isStructCoordInVolume(int x, int y, int z) {
        return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
    }

    /**
     * 结构格 {@code (structX, structY, structZ)} → 世界格，与 StructureScan 中 ax, by, az 及 cellGrid 索引一致。
     */
    public void structToWorld(int structX, int structY, int structZ, int[] out) {
        int ri = maxY - structY;
        out[0] = originX + (structX - minX);
        out[1] = originTopY - ri;
        out[2] = originZ + (structZ - minZ);
    }

    /** 将本访问上的一次查询坐标转为世界格：结构索引内则映射，否则原样视为世界坐标。 */
    private void queryToWorld(int x, int y, int z, int[] out) {
        if (isStructCoordInVolume(x, y, z)) {
            structToWorld(x, y, z, out);
        } else {
            out[0] = x;
            out[1] = y;
            out[2] = z;
        }
    }

    @Override
    public Block getBlock(int x, int y, int z) {
        int[] w = new int[3];
        queryToWorld(x, y, z, w);
        return world.getBlock(w[0], w[1], w[2]);
    }

    @Override
    public TileEntity getTileEntity(int x, int y, int z) {
        int[] w = new int[3];
        queryToWorld(x, y, z, w);
        return world.getTileEntity(w[0], w[1], w[2]);
    }

    @Override
    public int getLightBrightnessForSkyBlocks(int x, int y, int z, int side) {
        int[] w = new int[3];
        queryToWorld(x, y, z, w);
        return world.getLightBrightnessForSkyBlocks(w[0], w[1], w[2], side);
    }

    @Override
    public int getBlockMetadata(int x, int y, int z) {
        int[] w = new int[3];
        queryToWorld(x, y, z, w);
        return world.getBlockMetadata(w[0], w[1], w[2]);
    }

    @Override
    public int isBlockProvidingPowerTo(int x, int y, int z, int side) {
        return 0;
    }

    @Override
    public boolean isAirBlock(int x, int y, int z) {
        return getBlock(x, y, z).isAir(this, x, y, z);
    }

    @Override
    public BiomeGenBase getBiomeGenForCoords(int x, int z) {
        int wx;
        int wz;
        if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
            wx = originX + (x - minX);
            wz = originZ + (z - minZ);
        } else {
            wx = x;
            wz = z;
        }
        return world.getBiomeGenForCoords(wx, wz);
    }

    @Override
    public int getHeight() {
        return world.getHeight();
    }

    @Override
    public boolean extendedLevelsInChunkCache() {
        return world.extendedLevelsInChunkCache();
    }

    @Override
    public boolean isSideSolid(int x, int y, int z, ForgeDirection side, boolean _default) {
        Block b = getBlock(x, y, z);
        return b.isSideSolid(this, x, y, z, side);
    }
}
