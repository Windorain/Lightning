package com.lightning.mod.core.registry;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.lightning.mod.core.sampling.VoxelSample;

/**
 * 结构扫描 / 世界采样侧策略：与 Wiki palette 体素语义对齐；{@link #sample} 在无世界坐标注册表 dump 中不会被调用。
 */
public interface BlockRegistryWorldPolicy {

    /**
     * 本策略是否声称负责该方块（白名单唯一入口）；须可在<strong>服务端</strong>调用（不依赖客户端类）。
     */
    boolean matches(Block block, String registryId, int meta);

    /**
     * 将世界坐标一格转为 {@link VoxelSample}；可与 {@link com.lightning.mod.core.sampling.DefaultBlockSampler}
     * 委托等价。
     */
    VoxelSample sample(World world, int x, int y, int z);
}
