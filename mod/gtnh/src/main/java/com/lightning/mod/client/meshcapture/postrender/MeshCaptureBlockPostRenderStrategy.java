package com.lightning.mod.client.meshcapture.postrender;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 主绘制完成后的补画策略：按 {@link #priority()} 升序检测 {@link #applies}，首个命中则调用
 * {@link #renderPostMainBlock} 并结束。
 */
@SideOnly(Side.CLIENT)
public interface MeshCaptureBlockPostRenderStrategy {

    /**
     * 数值越小越先参与检测。内置 Forge Multipart 动态策略使用 {@link ForgeMultipartDynamicPostRenderStrategy#DEFAULT_PRIORITY}。
     */
    int priority();

    boolean applies(MeshCaptureBlockPostRenderContext ctx);

    void renderPostMainBlock(MeshCaptureBlockPostRenderContext ctx);
}
