package com.lightning.mod.client.meshcapture.env.probes;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.init.Blocks;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.IBlockAccess;
import net.minecraft.world.biome.BiomeGenBase;
import net.minecraftforge.common.util.ForgeDirection;

import com.lightning.mod.client.meshcapture.MeshCaptureRenderPreparation;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.env.Capability;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 行为自证：主 {@code Tessellator} 顶点通道整体是否可用。
 * <p>
 * 做法是在<strong>丢弃窗口</strong>里用 {@link RenderBlocks} 画一个原版实心方块并数四边形：窗口由
 * {@link TessellatorCaptureState#beginBlock} 打开，关闭时几何写进一次性实例后随之丢弃（不落盘、不进产物）。
 * 因此本探针不改画面、不写文件，只回答"这条通道这次通不通"。
 * <p>
 * 读数为 0 时记 {@link Capability#CANNOT_CAPTURE}：连原版方块渲染都进不了录制缓冲，说明所有逐格捕获都不必再试。
 */
@SideOnly(Side.CLIENT)
public final class TessellatorVertexProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 100;

    private static final String WINDOW_TAG = "capture-env:tessellator-vertices";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(CaptureProbeContext ctx) {
        return ctx != null;
    }

    @Override
    public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
        if (!ctx.glContextAvailable()) {
            out.setCapability(Fact.TESSELLATOR_VERTICES, Capability.UNKNOWN);
            out.note("tessellator_vertices: skipped (gl_context_unavailable:" + ctx.unavailableReason() + ")");
            return;
        }
        int quads = countProbeCubeInDiscardWindow();
        out.setCapability(Fact.TESSELLATOR_VERTICES, quads > 0 ? Capability.CAN_CAPTURE : Capability.CANNOT_CAPTURE);
        out.note("tessellator_vertices: quads=" + quads);
    }

    /** 在丢弃窗口里渲染一个原版实心方块，返回录到的四边形数。 */
    private static int countProbeCubeInDiscardWindow() {
        Block probeBlock = Blocks.stone;
        CapturedBlockInstance discard = new CapturedBlockInstance();
        TessellatorCaptureState
            .beginBlock(0, 0, 0, WINDOW_TAG, 0, 0, 0, probeBlock, 0, probeBlock.getRenderType(), WINDOW_TAG);
        try {
            RenderBlocks rb = new RenderBlocks(new SingleBlockAccess(probeBlock));
            rb.renderAllFaces = true;
            MeshCaptureRenderPreparation.beforeBlockRender(rb);
            Tessellator tess = Tessellator.instance;
            boolean drawing = false;
            try {
                tess.startDrawingQuads();
                drawing = true;
            } catch (Throwable ignored) {
                // 已处于绘制态：不争夺 Tessellator，本探针只数顶点
            }
            try {
                rb.renderBlockByRenderType(probeBlock, 0, 0, 0);
            } finally {
                if (drawing) {
                    try {
                        tess.draw();
                    } catch (Throwable ignored) {
                        // 丢弃窗口里的绘制失败不影响事实判定
                    }
                }
            }
            return TessellatorCaptureState.currentBlockRecordedQuadCount();
        } finally {
            TessellatorCaptureState.endBlock(discard);
        }
    }

    /**
     * 只服务本探针的最小 {@link IBlockAccess}：在 (0,0,0) 放一个方块，其余为空。
     * 亮度给满、无电源、无生物群系变化——探针只关心"顶点有没有进缓冲"，不关心明暗。
     */
    private static final class SingleBlockAccess implements IBlockAccess {

        private final Block block;

        SingleBlockAccess(Block block) {
            this.block = block;
        }

        private static boolean atOrigin(int x, int y, int z) {
            return x == 0 && y == 0 && z == 0;
        }

        @Override
        public Block getBlock(int x, int y, int z) {
            return atOrigin(x, y, z) ? block : Blocks.air;
        }

        @Override
        public TileEntity getTileEntity(int x, int y, int z) {
            return null;
        }

        @Override
        public int getLightBrightnessForSkyBlocks(int x, int y, int z, int lightValue) {
            return 0xF000F0;
        }

        @Override
        public int getBlockMetadata(int x, int y, int z) {
            return 0;
        }

        @Override
        public int isBlockProvidingPowerTo(int x, int y, int z, int directionIn) {
            return 0;
        }

        @Override
        public boolean isAirBlock(int x, int y, int z) {
            return !atOrigin(x, y, z);
        }

        @Override
        public BiomeGenBase getBiomeGenForCoords(int x, int z) {
            return BiomeGenBase.plains;
        }

        @Override
        public int getHeight() {
            return 256;
        }

        @Override
        public boolean extendedLevelsInChunkCache() {
            return false;
        }

        @Override
        public boolean isSideSolid(int x, int y, int z, ForgeDirection side, boolean _default) {
            return atOrigin(x, y, z);
        }
    }
}
