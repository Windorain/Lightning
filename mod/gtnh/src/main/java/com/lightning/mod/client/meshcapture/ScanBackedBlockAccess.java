package com.lightning.mod.client.meshcapture;

import java.util.HashMap;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.init.Blocks;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.IBlockAccess;
import net.minecraft.world.World;
import net.minecraft.world.biome.BiomeGenBase;
import net.minecraftforge.common.util.ForgeDirection;

import com.lightning.mod.core.sampling.VoxelSample;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * {@link IBlockAccess} wrapper that serves scan-time block identities
 * and metadata for positions inside the captured structure. Queries
 * outside the structure return air/0, preventing leakage from the
 * live client world into scan-time geometry.
 *
 * <p>
 * This fixes per-cell rendering for blocks that query
 * {@code blockAccess} during {@code renderBlockByRenderType} — e.g.
 * redstone wire (power level via getBlockMetadata, neighbor connections
 * via getBlock), repeaters, comparators, and any mod block whose
 * geometry depends on world state rather than TE data alone.
 */
@SideOnly(Side.CLIENT)
final class ScanBackedBlockAccess implements IBlockAccess {

    private final World delegate;
    private final Map<String, CellSnapshot> scanCells;

    private static final class CellSnapshot {

        final Block block;
        final int meta;

        CellSnapshot(Block block, int meta) {
            this.block = block;
            this.meta = meta;
        }
    }

    ScanBackedBlockAccess(World delegate, int[][][][] worldCoords, int[][][] cellGrid, VoxelSample[] cellTypes) {
        this.delegate = delegate;
        int sizeZ = worldCoords.length;
        int sizeRow = worldCoords[0].length;
        int sizeCol = worldCoords[0][0].length;
        int cellCount = sizeZ * sizeRow * sizeCol;
        this.scanCells = new HashMap<>(cellCount * 2);
        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    int ti = cellGrid[zi][ri][ci];
                    if (ti == 0) continue;
                    int[] wc = worldCoords[zi][ri][ci];
                    VoxelSample vs = cellTypes[ti];
                    Block b = Block.getBlockFromName(vs.registryId);
                    if (b == null || b == Blocks.air) continue;
                    scanCells.put(key(wc[0], wc[1], wc[2]), new CellSnapshot(b, vs.meta));
                }
            }
        }
    }

    private static String key(int x, int y, int z) {
        return x + "," + y + "," + z;
    }

    @Override
    public Block getBlock(int x, int y, int z) {
        CellSnapshot cs = scanCells.get(key(x, y, z));
        if (cs != null) return cs.block;
        return Blocks.air;
    }

    @Override
    public int getBlockMetadata(int x, int y, int z) {
        CellSnapshot cs = scanCells.get(key(x, y, z));
        if (cs != null) return cs.meta;
        return 0;
    }

    @Override
    public TileEntity getTileEntity(int x, int y, int z) {
        return delegate.getTileEntity(x, y, z);
    }

    @Override
    public boolean isAirBlock(int x, int y, int z) {
        return getBlock(x, y, z).isAir(this, x, y, z);
    }

    @Override
    public int getLightBrightnessForSkyBlocks(int x, int y, int z, int lightValue) {
        return delegate.getLightBrightnessForSkyBlocks(x, y, z, lightValue);
    }

    @Override
    public BiomeGenBase getBiomeGenForCoords(int x, int z) {
        return delegate.getBiomeGenForCoords(x, z);
    }

    @Override
    public int getHeight() {
        return delegate.getHeight();
    }

    @Override
    public boolean extendedLevelsInChunkCache() {
        return delegate.extendedLevelsInChunkCache();
    }

    @Override
    public boolean isSideSolid(int x, int y, int z, ForgeDirection side, boolean _default) {
        Block b = getBlock(x, y, z);
        return b.isSideSolid(this, x, y, z, side);
    }

    @Override
    public int isBlockProvidingPowerTo(int x, int y, int z, int side) {
        return 0;
    }
}
