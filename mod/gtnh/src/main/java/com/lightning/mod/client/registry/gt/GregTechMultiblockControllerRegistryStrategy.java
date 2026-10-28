package com.lightning.mod.client.registry.gt;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 多方块主机：{@code METATILEENTITIES[mId]} 为 GT5U {@code MTEMultiBlockBase} 子类（如 EBF）；须在默认策略之前注册。
 */
@SideOnly(Side.CLIENT)
public final class GregTechMultiblockControllerRegistryStrategy implements MetaTileBlockRegistryStrategy {

    @Override
    public boolean matches(Block block, String registryId, int meta) {
        if (!GregTechMetaTileRegistry.isGregTechBlockMachines(block, registryId)
            || !GregTechMetaTileRegistry.isMetaTileSlotRegistered(meta)) {
            return false;
        }
        Object mte = GregTechMetaTileRegistry.tryGetMetaTileEntity(meta);
        return GregTechMetaTileRegistry.isMetaTileEntityMultiblockController(mte);
    }

    @Override
    public void writeBlockRegistryEntry(JsonObject entry, Block block, String registryId, int meta, Minecraft mc) {
        GtBlockMachinesRegistryPolicy.writeMultiblockControllerEntry(entry, block, meta, mc);
    }
}
