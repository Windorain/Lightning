package com.lightning.mod.client.registry;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.registry.gt.GtBlockClassRegistryPolicy;
import com.lightning.mod.client.registry.gt.GtBlockMachinesRegistryPolicy;
import com.lightning.mod.core.registry.AddonModsRegistryPolicyOrder;
import com.lightning.mod.core.registry.BlockRegistryJson;
import com.lightning.mod.core.registry.bartworks.BartWorksRenderProfiles;
import com.lightning.mod.core.registry.gt.GtGregtechRegistryPolicyOrder;
import com.lightning.mod.core.registry.gt.GtRenderProfiles;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 有序手工策略列表（客户端 block_registry dump）；首个 {@link BlockRegistryPolicy#matches} 胜出，否则
 * {@link BlockRegistryJson#writeUnknownEntry}。
 * <p>
 * 顺序与 {@link AddonModsRegistryPolicyOrder} 一致（GregTech 机器与方块类在前，BartWorks 等 addon 在后）。
 */
@SideOnly(Side.CLIENT)
public final class BlockRegistryPolicies {

    private static final List<BlockRegistryPolicy> ALL = Collections.unmodifiableList(
        Arrays.asList(
            new GtBlockMachinesRegistryPolicy(GtGregtechRegistryPolicyOrder.MACHINES_WORLD),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockFrameBox",
                GtRenderProfiles.FRAME,
                GtGregtechRegistryPolicyOrder.FRAME_WORLD),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockGlass1",
                GtRenderProfiles.GLASS,
                GtGregtechRegistryPolicyOrder.GLASS_WORLD,
                "glass"),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockTintedIndustrialGlass",
                GtRenderProfiles.GLASS_TINTED,
                GtGregtechRegistryPolicyOrder.GLASS_TINTED_WORLD,
                "glass"),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockCyclotronCoils",
                GtRenderProfiles.COIL_CYCLOTRON,
                GtGregtechRegistryPolicyOrder.COIL_CYCLOTRON_WORLD),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockSheetMetal",
                GtRenderProfiles.SHEET_METAL,
                GtGregtechRegistryPolicyOrder.SHEET_METAL_WORLD),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockReinforced",
                GtRenderProfiles.REINFORCED,
                GtGregtechRegistryPolicyOrder.REINFORCED_WORLD),
            new GtBlockClassRegistryPolicy(
                "gregtech.common.blocks.BlockCasingsAbstract",
                GtRenderProfiles.CASING_SOLID,
                GtGregtechRegistryPolicyOrder.CASING_SOLID_WORLD),
            new GtBlockClassRegistryPolicy(
                "bartworks.common.blocks.BWBlocksGlass",
                BartWorksRenderProfiles.GLASS,
                AddonModsRegistryPolicyOrder.BARTWORKS_GLASS_WORLD,
                "glass"),
            new GtBlockClassRegistryPolicy(
                "bartworks.common.blocks.BWBlocksGlass2",
                BartWorksRenderProfiles.GLASS2,
                AddonModsRegistryPolicyOrder.BARTWORKS_GLASS2_WORLD,
                "glass")));

    private BlockRegistryPolicies() {}

    public static List<BlockRegistryPolicy> all() {
        return ALL;
    }

    /**
     * 写入一条 Block×meta 的 block_registry 条目（key 由调用方保证未重复）。
     */
    public static void appendBlockEntry(Minecraft mc, Block block, String registryId, int meta, String key,
        JsonObject blocks) {
        JsonObject entry = new JsonObject();
        for (BlockRegistryPolicy p : ALL) {
            if (p.matches(block, registryId, meta)) {
                p.writeBlockRegistryEntry(entry, block, registryId, meta, mc);
                blocks.add(key, entry);
                return;
            }
        }
        BlockRegistryJson.writeUnknownEntry(entry, block);
        blocks.add(key, entry);
    }
}
