package com.lightning.mod.core.registry.gt;

import net.minecraft.block.Block;

/**
 * Dump 路径可选上下文：方块 + 注册名 + meta（mID 或世界 meta）+ 已解析的 MTE。
 */
public final class GregTechRegistryMatchContext {

    public final Block block;
    public final String registryId;
    public final int meta;
    /** {@code METATILEENTITIES[meta]}，可能为 {@code null} */
    public final Object metaTileEntity;

    public GregTechRegistryMatchContext(Block block, String registryId, int meta, Object metaTileEntity) {
        this.block = block;
        this.registryId = registryId;
        this.meta = meta;
        this.metaTileEntity = metaTileEntity;
    }
}
