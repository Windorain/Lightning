package com.lightning.mod.core.sampling;

import net.minecraft.world.World;

/**
 * 方块解析接口：默认 {@link DefaultBlockSampler}；结构导出默认 {@link PolicyBackedBlockSampler}（与
 * {@link com.lightning.mod.core.registry.BlockRegistryWorldPolicies} 一致）。
 */
public interface IBlockSampler {

    VoxelSample sample(World world, int x, int y, int z);
}
