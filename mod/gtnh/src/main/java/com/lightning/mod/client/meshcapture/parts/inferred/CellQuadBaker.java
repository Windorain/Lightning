package com.lightning.mod.client.meshcapture.parts.inferred;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.world.World;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.meshcapture.MaterialKeyResolver;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderContext;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderRegistry;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureContext;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureRegistry;

import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 档 3 的<strong>按需烘焙器</strong>：当调用方（探针等）没有现成捕获产物时，为单格现场烘焙
 * 客户端四边形（与 {@code MeshCaptureService} 逐格捕获循环同一条主捕获 + 后渲染调度链）。
 *
 * <p>
 * <strong>挂点口径（既有决策记录）</strong>：几何推断在 mod 侧的执行位置 =
 * {@code PartCapturePipeline.collectParts} 档 3 分支，由 {@code InferredGeometryPartProvider}
 * 消费四边形。四边形来源分两层：
 * <ol>
 * <li><strong>真实导出路径</strong>：{@code MeshCaptureService} 逐格捕获循环内，
 * {@code TessellatorCaptureState.endBlock(inst)} 产出的块局部四边形经
 * {@code PartProviderContext.bakedQuads} 直接传入（同一烘焙产物，零重复渲染）；</li>
 * <li><strong>无捕获产物路径</strong>（探针直接调 {@code collectParts(world,x,y,z)}）：
 * 由本类现场烘焙一格（同一套 primary/postrender 注册表调度，语义与导出烘焙一致）。</li>
 * </ol>
 * 盒永远是<strong>导出时快照</strong>（契约 §2 核心事实），web 端不重算（§12 硬约束）。
 */
@SideOnly(Side.CLIENT)
public final class CellQuadBaker {

    private CellQuadBaker() {}

    /**
     * 现场烘焙一格的客户端四边形（块局部 [0,1]³，同 {@code MeshCaptureService} 捕获契约）。
     * 绝不抛出：任何失败返回空列表（调用方走"无几何"退化兜底）。
     */
    static List<CapturedQuad> bake(World world, int x, int y, int z, Block block, int meta) {
        List<CapturedQuad> out = new ArrayList<CapturedQuad>();
        if (world == null || block == null) {
            return out;
        }
        try {
            RenderBlocks rb = new RenderBlocks(world);
            rb.renderAllFaces = true;

            GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
            String registryKey = uid == null ? block.getUnlocalizedName() : uid.toString();

            CapturedBlockInstance inst = new CapturedBlockInstance();
            TessellatorCaptureState.beginBlock(
                x,
                y,
                z,
                registryKey + '\0' + "meta:" + meta,
                x,
                y,
                z,
                block,
                meta,
                block.getRenderType(),
                registryKey);
            Tessellator tess = Tessellator.instance;
            tess.startDrawingQuads();
            BlockPrimaryCaptureRegistry.dispatch(new BlockPrimaryCaptureContext(world, x, y, z, block, meta, rb, 0.0F));
            tess.draw();

            MeshCaptureBlockPostRenderRegistry
                .dispatch(new MeshCaptureBlockPostRenderContext(world, x, y, z, block, meta, rb, 0.0F));
            int quadsBeforeDraw = TessellatorCaptureState.currentBlockRecordedQuadCount();
            try {
                tess.draw();
            } catch (Throwable ignored) {
                /* 动态路径常已在内部 drawInstance；此时不再处于绘制中 */
            }
            if (quadsBeforeDraw == 0) {
                GL11.glPushMatrix();
                try {
                    rb.renderBlockAsItem(block, meta, 1.0F);
                } catch (Throwable ignored) {
                    /* 少数方块在库存路径下可能抛错 */
                } finally {
                    GL11.glPopMatrix();
                }
            }
            TessellatorCaptureState.endBlock(inst);
            // 与 MeshCaptureService 捕获循环同序：endBlock 后做材质解析（materialKey + sprite 局部 UV），
            // 档 3 的 AlphaTightener 依赖同一数据形态（真实导出路径 = attachMaterials 之后的四边形）
            net.minecraft.client.renderer.texture.TextureMap textureMap = Minecraft.getMinecraft()
                .getTextureMapBlocks();
            for (CapturedQuad q : inst.quads) {
                try {
                    MaterialKeyResolver.applySpriteLocalToQuad(q, textureMap);
                } catch (Throwable ignored) {
                    // 单四边形材质解析失败 ⇒ materialKey 保持 unknown，AlphaTightener 回退原始盒
                }
            }
            out.addAll(inst.quads);
        } catch (Throwable ignored) {
            // 烘焙失败 ⇒ 空几何，由提供者走"无几何"退化兜底（档 3 永远有结果）
        }
        return out;
    }

    /** 仅客户端世界可用（权威盒/渲染接口仅客户端，契约 §7 说明）。 */
    static World clientWorld() {
        return Minecraft.getMinecraft().theWorld;
    }

    /**
     * 探针专用（parts/probe 验证分支）：现场烘焙并返回原始四边形快照（顶点级 dump 用）。
     * 生产路径不得调用（生产输入 = MeshCaptureService 捕获产物，经 bakedQuads 传入）。
     */
    public static List<CapturedQuad> bakeForProbe(World world, int x, int y, int z, Block block, int meta) {
        return bake(world, x, y, z, block, meta);
    }

    /**
     * 探针专用（对照实验）：绕过 {@code renderBlockByRenderType} 调度层（ForgeRelocation 变换 /
     * ISBRH / mixin 注入），直接调 {@code rb.renderBlockTorch} 烘焙火把，顶点级 dump 用。
     * 用于定位「火把侧立面四边形在全量导出/探针烘焙中均被拉伸」的注入点——对照组。
     */
    public static List<CapturedQuad> bakeTorchDirectForProbe(World world, int x, int y, int z, Block block, int meta) {
        List<CapturedQuad> out = new ArrayList<CapturedQuad>();
        if (world == null || block == null) {
            return out;
        }
        try {
            RenderBlocks rb = new RenderBlocks(world);
            rb.renderAllFaces = true;
            GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
            String registryKey = uid == null ? block.getUnlocalizedName() : uid.toString();
            CapturedBlockInstance inst = new CapturedBlockInstance();
            TessellatorCaptureState.beginBlock(
                x,
                y,
                z,
                registryKey + '\0' + "meta:" + meta,
                x,
                y,
                z,
                block,
                meta,
                block.getRenderType(),
                registryKey);
            Tessellator tess = Tessellator.instance;
            tess.startDrawingQuads();
            rb.renderBlockTorch(block, x, y, z);
            tess.draw();
            TessellatorCaptureState.endBlock(inst);
            out.addAll(inst.quads);
        } catch (Throwable ignored) {
            // 对照实验失败 ⇒ 空（dump 里可见）
        }
        return out;
    }
}
