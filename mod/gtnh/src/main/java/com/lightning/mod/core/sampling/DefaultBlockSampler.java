package com.lightning.mod.core.sampling;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.init.Blocks;
import net.minecraft.world.World;

import cpw.mods.fml.common.registry.GameRegistry;

/** 默认：仅 {@link World#getBlock} + {@link World#getBlockMetadata}，不读 TileEntity。 */
public class DefaultBlockSampler implements IBlockSampler {

    @Override
    public VoxelSample sample(World world, int x, int y, int z) {
        Block block = world.getBlock(x, y, z);
        if (block == null || block == Blocks.air || block.getMaterial() == Material.air) {
            return new VoxelSample("air", 0);
        }
        int meta = world.getBlockMetadata(x, y, z);
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
        String id = uid == null ? ("unknown:" + block.getUnlocalizedName()) : uid.toString();
        return new VoxelSample(id, meta);
    }
}
