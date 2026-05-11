package com.lightning.mod.core.registry.bartworks;

/**
 * BartWorks 方块在 {@code block_registry} 中的 {@code renderProfile}；与 GregTech 的 {@link
 * com.lightning.mod.core.registry.gt.GtRenderProfiles} 并列，避免前缀混淆。
 * <p>
 * 贴图解析走 {@link com.lightning.mod.client.export.ExportTextureLocator} 的方块图标路径（非 MTE）。
 */
public final class BartWorksRenderProfiles {

    /** {@link #GLASS2} と区別：{@code bartworks.common.blocks.BWBlocksGlass} */
    public static final String GLASS = "bartworks.glass";

    /** {@link #GLASS} と区別：{@code bartworks.common.blocks.BWBlocksGlass2} */
    public static final String GLASS2 = "bartworks.glass2";

    private BartWorksRenderProfiles() {}
}
