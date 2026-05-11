package com.lightning.mod.client.meshcapture.finish;

import java.util.List;

import net.minecraft.block.Block;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * {@link com.lightning.mod.client.meshcapture.TessellatorCaptureState#endBlock} 收尾阶段上下文；
 * {@link #getQuads()} 与帧内列表为同一引用，可原地修改。
 */
@SideOnly(Side.CLIENT)
public final class BlockCaptureFinishContext {

    private final String registryKey;
    private final Block captureBlock;
    private final int blockMeta;
    private final int renderType;
    private final List<CapturedQuad> quads;

    public BlockCaptureFinishContext(String registryKey, Block captureBlock, int blockMeta, int renderType,
        List<CapturedQuad> quads) {
        this.registryKey = registryKey != null ? registryKey : "";
        this.captureBlock = captureBlock;
        this.blockMeta = blockMeta;
        this.renderType = renderType;
        this.quads = quads;
    }

    public String getRegistryKey() {
        return registryKey;
    }

    public Block getCaptureBlock() {
        return captureBlock;
    }

    public int getBlockMeta() {
        return blockMeta;
    }

    public int getRenderType() {
        return renderType;
    }

    public List<CapturedQuad> getQuads() {
        return quads;
    }
}
