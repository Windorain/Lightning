package com.lightning.mod.client.meshcapture.primary;

import java.util.function.IntPredicate;

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
                // 先写 pass 再问 canRenderInPass：与区块渲染同序（区块网格构建也是先设置 pass、
                // 再调 canRenderInPass），谓词里读全局 pass 的实现看到的才是同一次决策的 pass。
                ForgeWorldRenderPassUtil.setPass(pass);
                if (!shouldRenderPass(multiRenderPassBlock, pass, b::canRenderInPass)) {
                    continue;
                }
                rb.renderBlockByRenderType(b, wx, wy, wz);
            }
        } finally {
            ForgeWorldRenderPassUtil.setPass(saved);
        }
        return true;
    }

    /**
     * 「这一 pass 该不该渲」的纯决策：不读世界、不写状态，只把两个输入合成一个布尔。
     *
     * <p>
     * 多 pass 方块必须遵循 {@link Block#canRenderInPass(int)}——游戏只在它返回 {@code true} 的 pass 里渲染该方块
     * （区块网格构建逐 pass 判断的就是它）。捕获过去无条件渲两轮、只看返回值不判，于是「只在 pass 1 渲染」的方块
     * 被录了两遍，第二遍是与第一遍逐字节相同的复制品。
     *
     * <p>
     * {@code multiRenderPassBlock == false} 的分支（GT 机器那条）保持原来的「两轮都渲、不问谓词」：
     * 这里直接返回 {@code true} 且<b>不调用</b> {@code canRenderInPass}。
     *
     * <p>
     * 谓词抛异常时按「放行」处理：宁可多录一遍，也不因为模组谓词坏掉而静默丢几何
     * （与改造前「谓词抛异常仍继续渲染」的行为一致）。
     *
     * @param multiRenderPassBlock 方块是否落在 {@code getRenderBlockPass() > 0} 的多 pass 分支
     * @param pass                 当前 pass（0 或 1）
     * @param canRenderInPass      方块的 {@link Block#canRenderInPass(int)}
     * @return {@code true} 表示应当在该 pass 调用一次 {@code renderBlockByRenderType}
     */
    static boolean shouldRenderPass(boolean multiRenderPassBlock, int pass, IntPredicate canRenderInPass) {
        if (!multiRenderPassBlock) {
            return true;
        }
        try {
            return canRenderInPass.test(pass);
        } catch (Throwable ignored) {
            return true;
        }
    }
}
