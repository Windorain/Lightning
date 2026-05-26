package com.lightning.mod.client.registry;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.world.World;

import com.google.gson.JsonObject;
import com.lightning.mod.core.sampling.VoxelSample;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * BlockRegistry（Wiki {@code BlockEntry}）写出策略；{@link #writeBlockRegistryEntry} 仅在客户端全量 dump 中调用。
 * <p>
 * 对 {@code gregtech:gt.blockmachines}，{@link #matches} / {@link #writeBlockRegistryEntry} 的 {@code meta} 为 GT5U mID（与
 * {@code registryId@n} 中 {@code n} 一致）。
 * 世界坐标路径见 {@link com.lightning.mod.core.registry.BlockRegistryWorldPolicy}（采样侧 {@link #matches} 不校验 mID
 * 槽，由 {@link #sample} 读 Tile）。
 */
@SideOnly(Side.CLIENT)
public interface BlockRegistryPolicy {

    boolean matches(Block block, String registryId, int meta);

    /**
     * 与结构扫描共用（GregTech 策略委托 {@link com.lightning.mod.core.registry.gt.GtGregtechRegistryPolicyOrder}
     * 中对应 world policy）；无坐标 dump 路径可不调用。
     */
    VoxelSample sample(World world, int x, int y, int z);

    /** 向 {@code entry} 写入与 Wiki 契约一致的字段；不负责 material_registry。 */
    void writeBlockRegistryEntry(JsonObject entry, Block block, String registryId, int meta, Minecraft mc);
}
