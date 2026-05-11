package com.lightning.mod.client.meshcapture.primary;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.RenderBlocks;

import com.lightning.mod.client.meshcapture.ForgeWorldRenderPassUtil;
import com.lightning.mod.client.meshcapture.MeshCaptureRenderPreparation;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;

import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 默认主路径：{@link MeshCaptureRenderPreparation#beforeBlockRender}、Forge 双 pass（若需要）、
 * {@link RenderBlocks#renderBlockByRenderType}（内部再分派 ISBRH）。
 */
@SideOnly(Side.CLIENT)
public final class VanillaPrimaryBlockCaptureStrategy implements BlockPrimaryCaptureStrategy {

    public static final int DEFAULT_PRIORITY = 10_000;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(BlockPrimaryCaptureContext ctx) {
        return true;
    }

    @Override
    public void renderPrimary(BlockPrimaryCaptureContext ctx) {
        RenderBlocks rb = ctx.getRenderBlocks();
        Block b = ctx.getBlock();
        int wx = ctx.getWx();
        int wy = ctx.getWy();
        int wz = ctx.getWz();
        MeshCaptureRenderPreparation.beforeBlockRender(rb);
        if (!renderDualForgeWorldPassIfNeeded(rb, b, wx, wy, wz)) {
            rb.renderBlockByRenderType(b, wx, wy, wz);
        }
    }

    /**
     * @return {@code true} 已处理（含无法改 pass 时的单次兜底渲染）；{@code false} 由调用方单次 {@code renderBlockByRenderType}。
     */
    private static boolean renderDualForgeWorldPassIfNeeded(RenderBlocks rb, Block b, int wx, int wy, int wz) {
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(b);
        String reg = uid == null ? "" : uid.toString();
        boolean gtMachines = GregTechMetaTileRegistry.isGregTechBlockMachines(b, reg);
        boolean multiRenderPassBlock;
        try {
            multiRenderPassBlock = b.getRenderBlockPass() > 0;
        } catch (Throwable ignored) {
            multiRenderPassBlock = false;
        }
        if (!gtMachines && !multiRenderPassBlock) {
            return false;
        }
        if (!ForgeWorldRenderPassUtil.canSetPass()) {
            rb.renderBlockByRenderType(b, wx, wy, wz);
            return true;
        }
        int saved = ForgeWorldRenderPassUtil.getPass();
        try {
            for (int pass = 0; pass <= 1; pass++) {
                if (multiRenderPassBlock) {
                    try {
                        b.canRenderInPass(pass);
                    } catch (Throwable ignored) {
                        /* 与区块渲染一致 */
                    }
                }
                ForgeWorldRenderPassUtil.setPass(pass);
                rb.renderBlockByRenderType(b, wx, wy, wz);
            }
        } finally {
            ForgeWorldRenderPassUtil.setPass(saved);
        }
        return true;
    }
}
