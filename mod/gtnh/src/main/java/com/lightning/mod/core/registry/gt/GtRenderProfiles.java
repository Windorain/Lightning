package com.lightning.mod.core.registry.gt;

/**
 * 与 {@code block_registry} 中 {@code renderProfile} 一一对应；每种 profile 由独立注册策略类实现。
 * <p>
 * 命名：{@code default} 兜底；{@code gregtech.*} 为 GregTech 专用。
 */
public final class GtRenderProfiles {

    /** 通用 MetaTile（机器/管道）默认纹理解析。 */
    public static final String DEFAULT = "default";

    /**
     * 多方块控制器（命中
     * {@link com.lightning.mod.client.registry.gt.GregTechMultiblockControllerRegistryStrategy}）。
     */
    public static final String MULTIBLOCK_CONTROLLER = "gregtech.multiblock.controller";

    public static final String FRAME = "gregtech.frame";
    public static final String GLASS = "gregtech.glass";
    public static final String GLASS_TINTED = "gregtech.glass.tinted";
    public static final String COIL_CYCLOTRON = "gregtech.coil.cyclotron";
    public static final String SHEET_METAL = "gregtech.sheet_metal";
    public static final String REINFORCED = "gregtech.reinforced";
    public static final String CASING_SOLID = "gregtech.casing.solid";

    private GtRenderProfiles() {}

    /**
     * {@link com.lightning.mod.client.export.ExportTextureLocator} 是否走 MTE / {@code METATILEENTITIES}
     * 路径。
     */
    public static boolean usesMetaTileEntityResolver(String renderProfile) {
        if (renderProfile == null) {
            return false;
        }
        return DEFAULT.equals(renderProfile) || MULTIBLOCK_CONTROLLER.equals(renderProfile);
    }
}
