package com.lightning.mod.client.registry.gt;

import net.minecraft.world.World;

import com.lightning.mod.client.export.GtTextureResolver;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * GT 仓室：通过 GT5U {@code MTEHatch#getTexture}（侧面壳层）解析与 {@code material_registry} 一致的 locator，供
 * {@code palette.shellMaterialId}。
 * 不使用邻格方块推断。
 */
@SideOnly(Side.CLIENT)
public final class HatchShellMaterialSampler {

    private HatchShellMaterialSampler() {}

    /**
     * @param x,y,z 仓室方块世界坐标
     * @return 规范化 locator；失败时 {@code null}
     */
    public static String tryResolveNeighborShellLocator(World world, int x, int y, int z) {
        return GtTextureResolver.tryResolveHatchShellMaterialLocatorFromWorld(world, x, y, z);
    }
}
