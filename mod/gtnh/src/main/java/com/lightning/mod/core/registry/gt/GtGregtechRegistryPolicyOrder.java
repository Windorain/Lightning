package com.lightning.mod.core.registry.gt;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import com.lightning.mod.core.registry.BlockRegistryWorldPolicy;

/**
 * GregTech 注册策略顺序（从窄到宽、首轮命中即停）：与全量 dump 及世界采样<strong>共用同一列表</strong>。
 * <ol>
 * <li>{@link GtBlockMachinesWorldPolicy} — {@code gregtech:gt.blockmachines}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockFrameBox}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockGlass1}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockTintedIndustrialGlass}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockCyclotronCoils}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockSheetMetal}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockReinforced}</li>
 * <li>{@link GtBlockClassWorldPolicy} — {@code BlockCasingsAbstract}</li>
 * </ol>
 * 须与 {@link com.lightning.mod.client.registry.BlockRegistryPolicies} 中 GregTech 段顺序一致；完整列表（含
 * BartWorks）见
 * {@link com.lightning.mod.core.registry.AddonModsRegistryPolicyOrder}。profile 常量见
 * {@link GtRenderProfiles}。
 */
public final class GtGregtechRegistryPolicyOrder {

    public static final GtBlockMachinesWorldPolicy MACHINES_WORLD = new GtBlockMachinesWorldPolicy();

    public static final GtBlockClassWorldPolicy FRAME_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockFrameBox");
    public static final GtBlockClassWorldPolicy GLASS_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockGlass1");
    public static final GtBlockClassWorldPolicy GLASS_TINTED_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockTintedIndustrialGlass");
    public static final GtBlockClassWorldPolicy COIL_CYCLOTRON_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockCyclotronCoils");
    public static final GtBlockClassWorldPolicy SHEET_METAL_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockSheetMetal");
    public static final GtBlockClassWorldPolicy REINFORCED_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockReinforced");
    public static final GtBlockClassWorldPolicy CASING_SOLID_WORLD = new GtBlockClassWorldPolicy(
        "gregtech.common.blocks.BlockCasingsAbstract");

    private static final List<BlockRegistryWorldPolicy> ORDERED_WORLD = Collections.unmodifiableList(
        Arrays.asList(
            MACHINES_WORLD,
            FRAME_WORLD,
            GLASS_WORLD,
            GLASS_TINTED_WORLD,
            COIL_CYCLOTRON_WORLD,
            SHEET_METAL_WORLD,
            REINFORCED_WORLD,
            CASING_SOLID_WORLD));

    private GtGregtechRegistryPolicyOrder() {}

    /** 与客户端 dump 链顺序相同，供世界采样遍历。 */
    public static List<BlockRegistryWorldPolicy> orderedWorldPolicies() {
        return ORDERED_WORLD;
    }
}
