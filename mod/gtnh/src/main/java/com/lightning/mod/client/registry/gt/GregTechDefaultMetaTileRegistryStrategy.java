package com.lightning.mod.client.registry.gt;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.lightning.mod.core.registry.GregTechMetaTileRegistry;
import com.lightning.mod.core.registry.gt.GtRenderProfiles;
import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/** 其余 MetaTile（管道、普通机器等）兜底；链末位。 */
@SideOnly(Side.CLIENT)
public final class GregTechDefaultMetaTileRegistryStrategy implements MetaTileBlockRegistryStrategy {

    @Override
    public boolean matches(Block block, String registryId, int meta) {
        return GregTechMetaTileRegistry.isGregTechBlockMachines(block, registryId)
            && GregTechMetaTileRegistry.isMetaTileSlotRegistered(meta);
    }

    @Override
    public void writeBlockRegistryEntry(JsonObject entry, Block block, String registryId, int meta, Minecraft mc) {
        GtBlockMachinesRegistryPolicy.writeSimpleCubeEntry(entry, block, meta, GtRenderProfiles.DEFAULT, mc);
    }
}
