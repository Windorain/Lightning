package com.lightning.mod.client.meshcapture;

import net.minecraft.block.Block;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 网格捕获后顶点归一化到「块局部 [0,1]³」契约时采用的策略。
 * <p>
 * {@link #STANDARD_BLOCK_ORIGIN}：由 {@link TessellatorCaptureState} 对每个 quad 在减 {@code (0,0,0)} 与减世界角之间按贴近
 * {@code [0,1]³} 的代价择一。
 */
@SideOnly(Side.CLIENT)
public final class CaptureCoordinatePolicy {

    public enum Kind {

        /**
         * 默认：每 quad 在减 {@code (0,0,0)} 与减世界角 {@code (worldBlockX,Y,Z)} 间按贴近 {@code [0,1]³} 的代价择一（见
         * TessellatorCaptureState）。
         */
        STANDARD_BLOCK_ORIGIN,
        /** 调用链已把坐标落在块局部；仅减 Tessellator offset，不再减世界角点。 */
        ALREADY_BLOCK_LOCAL,
    }

    private CaptureCoordinatePolicy() {}

    /**
     * @param registryKey {@code VoxelSample.registryId}，如 {@code minecraft:stone}
     */
    public static Kind resolve(Block block, int meta, int renderType, String registryKey) {
        if (registryKey != null) {
            Kind k = resolveByRegistry(registryKey, block, meta, renderType);
            if (k != null) {
                return k;
            }
        }

        if (block != null) {
            Kind k = resolveByBlock(block, meta, renderType);
            if (k != null) {
                return k;
            }
        }

        return Kind.STANDARD_BLOCK_ORIGIN;
    }

    /** 表驱动占位：后续按 mod 前缀或 id 返回 {@link Kind#ALREADY_BLOCK_LOCAL} 等。 */
    private static Kind resolveByRegistry(String registryKey, Block block, int meta, int renderType) {
        return null;
    }

    private static Kind resolveByBlock(Block block, int meta, int renderType) {
        return null;
    }
}
