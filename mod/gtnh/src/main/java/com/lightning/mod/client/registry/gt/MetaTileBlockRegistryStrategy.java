package com.lightning.mod.client.registry.gt;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/** {@code gregtech:gt.blockmachines} 内层有序链：首轮 {@link #matches} 命中即停。 */
@SideOnly(Side.CLIENT)
public interface MetaTileBlockRegistryStrategy {

    boolean matches(Block block, String registryId, int meta);

    void writeBlockRegistryEntry(JsonObject entry, Block block, String registryId, int meta, Minecraft mc);
}
