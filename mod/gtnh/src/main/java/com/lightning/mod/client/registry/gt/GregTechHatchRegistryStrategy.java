package com.lightning.mod.client.registry.gt;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;
import com.lightning.mod.core.registry.gt.GtRenderProfiles;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * GT5U 多方块仓室：{@code gregtech.api.metatileentity.implementations.MTEHatch} 及其子类（消声仓、能源/动力仓、流体仓、物品总线、维护仓等）。
 * <p>
 * 与 {@code MTEHatch#getTexture} 一致：渲染面为「非正面」时仅 {@code MACHINE_CASINGS} 外壳一层；为「正面」时
 * {@code getTexturesActive}/{@code getTexturesInactive} 返回多层（基底 + overlay）。导出为与多方块主机相同的
 * {@code faces.all}（侧面）+ {@code faces.-z}（正面朝北时的叠加层），见
 * {@link GtBlockMachinesRegistryPolicy#writeMetaTileShellFrontFaceLayersEntry}；基底层带
 * {@code materialResolve.type=neighborShellBlock}，
 * Wiki 渲染时按体素邻格查 block_registry 条目取壳材质，不导出邻块映射表。
 */
@SideOnly(Side.CLIENT)
public final class GregTechHatchRegistryStrategy implements MetaTileBlockRegistryStrategy {

    @Override
    public boolean matches(Block block, String registryId, int meta) {
        if (!GregTechMetaTileRegistry.isGregTechBlockMachines(block, registryId)
            || !GregTechMetaTileRegistry.isMetaTileSlotRegistered(meta)) {
            return false;
        }
        Object mte = GregTechMetaTileRegistry.tryGetMetaTileEntity(meta);
        return GregTechMetaTileRegistry.isMetaTileEntityHatch(mte);
    }

    @Override
    public void writeBlockRegistryEntry(JsonObject entry, Block block, String registryId, int meta, Minecraft mc) {
        GtBlockMachinesRegistryPolicy
            .writeMetaTileShellFrontFaceLayersEntry(entry, block, meta, GtRenderProfiles.DEFAULT, mc, true);
    }
}
