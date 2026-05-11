package com.lightning.mod.core.registry.gt;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.lightning.mod.core.registry.BlockRegistryWorldPolicy;
import com.lightning.mod.core.sampling.DefaultBlockSampler;
import com.lightning.mod.core.sampling.VoxelSample;

/**
 * 非 {@code gt.blockmachines} 的 GT 方块：命中即世界 meta 采样。
 */
public final class GtBlockClassWorldPolicy implements BlockRegistryWorldPolicy {

    private static final DefaultBlockSampler FALLBACK = new DefaultBlockSampler();

    private final String blockClassBinaryName;

    public GtBlockClassWorldPolicy(String blockClassBinaryName) {
        this.blockClassBinaryName = blockClassBinaryName;
    }

    public String blockClassBinaryName() {
        return blockClassBinaryName;
    }

    @Override
    public boolean matches(Block block, String registryId, int meta) {
        return GregTechBlockReflection.isInstance(block, blockClassBinaryName);
    }

    @Override
    public VoxelSample sample(World world, int x, int y, int z) {
        return FALLBACK.sample(world, x, y, z);
    }
}
