package com.lightning.mod.core.registry.gt;

import java.lang.reflect.Method;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.init.Blocks;
import net.minecraft.world.World;

import com.lightning.mod.core.registry.BlockRegistryWorldPolicy;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;
import com.lightning.mod.core.sampling.DefaultBlockSampler;
import com.lightning.mod.core.sampling.VoxelSample;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * {@code gregtech:gt.blockmachines}：{@link #sample} 从 Tile 读 mID。
 */
public final class GtBlockMachinesWorldPolicy implements BlockRegistryWorldPolicy {

    private static final DefaultBlockSampler FALLBACK = new DefaultBlockSampler();

    private static final String HATCH_SHELL_SAMPLER = "com.lightning.mod.client.registry.gt.HatchShellMaterialSampler";

    @Override
    public boolean matches(Block block, String registryId, int meta) {
        return GregTechMetaTileRegistry.isGregTechBlockMachines(block, registryId);
    }

    @Override
    public VoxelSample sample(World world, int x, int y, int z) {
        Block block = world.getBlock(x, y, z);
        if (block == null || block == Blocks.air || block.getMaterial() == Material.air) {
            return FALLBACK.sample(world, x, y, z);
        }
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
        String registryId = uid == null ? ("unknown:" + block.getUnlocalizedName()) : uid.toString();
        if (GregTechMetaTileRegistry.isGregTechBlockMachines(block, registryId)) {
            Integer mId = GregTechMetaTileRegistry.tryGetMetaTileIdAt(world, x, y, z);
            if (mId != null) {
                String facing = GregTechMetaTileRegistry.tryGetFrontFacingWikiFaceNameAt(world, x, y, z);
                Object mte = GregTechMetaTileRegistry.tryGetMetaTileEntity(mId.intValue());
                String shellMaterialId = null;
                if (GregTechMetaTileRegistry.isMetaTileEntityHatch(mte)) {
                    shellMaterialId = tryClientHatchShellMaterial(world, x, y, z);
                }
                return new VoxelSample(registryId, mId, facing, shellMaterialId);
            }
        }
        return FALLBACK.sample(world, x, y, z);
    }

    /**
     * 客户端 {@link HatchShellMaterialSampler}；核心模块不直接依赖 client 类。
     */
    private static String tryClientHatchShellMaterial(World world, int x, int y, int z) {
        try {
            Class<?> c = Class.forName(HATCH_SHELL_SAMPLER, false, GtBlockMachinesWorldPolicy.class.getClassLoader());
            Method m = c.getMethod("tryResolveNeighborShellLocator", World.class, int.class, int.class, int.class);
            Object r = m.invoke(null, world, x, y, z);
            return r instanceof String ? (String) r : null;
        } catch (Throwable ignored) {
            return null;
        }
    }
}
