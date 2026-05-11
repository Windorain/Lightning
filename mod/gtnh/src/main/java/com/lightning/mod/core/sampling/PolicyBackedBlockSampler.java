package com.lightning.mod.core.sampling;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.init.Blocks;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import com.lightning.mod.core.registry.BlockRegistryWorldPolicies;
import com.lightning.mod.core.registry.BlockRegistryWorldPolicy;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * 按 {@link BlockRegistryWorldPolicies} 首个 {@link BlockRegistryWorldPolicy#matches} 采样，否则回退 {@link DefaultBlockSampler}。
 */
public final class PolicyBackedBlockSampler implements IBlockSampler {

    private static final DefaultBlockSampler FALLBACK = new DefaultBlockSampler();

    @Override
    public VoxelSample sample(World world, int x, int y, int z) {
        Block block = world.getBlock(x, y, z);
        if (block == null || block == Blocks.air || block.getMaterial() == Material.air) {
            return new VoxelSample("air", 0);
        }
        int meta = world.getBlockMetadata(x, y, z);
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
        String registryId = uid == null ? ("unknown:" + block.getUnlocalizedName()) : uid.toString();
        VoxelSample vs;
        for (BlockRegistryWorldPolicy p : BlockRegistryWorldPolicies.all()) {
            if (p.matches(block, registryId, meta)) {
                vs = p.sample(world, x, y, z);
                return attachTileNbt(world, x, y, z, vs);
            }
        }
        vs = FALLBACK.sample(world, x, y, z);
        return attachTileNbt(world, x, y, z, vs);
    }

    private static VoxelSample attachTileNbt(World world, int x, int y, int z, VoxelSample vs) {
        if (vs == null || "air".equals(vs.registryId)) {
            return vs;
        }
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null) {
            return vs;
        }
        NBTTagCompound tag = new NBTTagCompound();
        te.writeToNBT(tag);
        return new VoxelSample(vs.registryId, vs.meta, vs.facing, vs.shellMaterialId, tag);
    }
}
