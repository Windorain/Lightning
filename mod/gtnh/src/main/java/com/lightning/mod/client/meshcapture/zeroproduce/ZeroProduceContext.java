package com.lightning.mod.client.meshcapture.zeroproduce;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironment;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 一次零产出裁决的输入：只带"这一格是什么、录到了什么、注入的是哪份副本 TE、环境事实怎么读"。
 * <p>
 * <strong>故意不带</strong>渲染器的内部状态：把兜底绑到具体模组的字段上，会让"换了接管者/换了版本"时判据静默失准。
 * 需要解释时读 {@link #environment()} 的事实快照，它同样不是身份判据。
 */
@SideOnly(Side.CLIENT)
public final class ZeroProduceContext {

    private final int cellX;
    private final int cellY;
    private final int cellZ;
    private final int worldX;
    private final int worldY;
    private final int worldZ;
    private final Block block;
    private final int meta;
    private final String registryId;
    private final int renderType;
    private final TileEntity tileEntity;
    private final int quadCount;
    private final Map<String, Integer> quadsByChannel;
    private final int dynamicVertexCount;
    private final boolean tesrStrategyAttempted;
    private final boolean specialRendererPresent;
    private final CaptureEnvironment environment;

    public ZeroProduceContext(int cellX, int cellY, int cellZ, int worldX, int worldY, int worldZ, Block block,
        int meta, String registryId, int renderType, TileEntity tileEntity, int quadCount,
        Map<String, Integer> quadsByChannel, boolean tesrStrategyAttempted, boolean specialRendererPresent,
        CaptureEnvironment environment) {
        this(
            cellX,
            cellY,
            cellZ,
            worldX,
            worldY,
            worldZ,
            block,
            meta,
            registryId,
            renderType,
            tileEntity,
            quadCount,
            quadsByChannel,
            0,
            tesrStrategyAttempted,
            specialRendererPresent,
            environment);
    }

    public ZeroProduceContext(int cellX, int cellY, int cellZ, int worldX, int worldY, int worldZ, Block block,
        int meta, String registryId, int renderType, TileEntity tileEntity, int quadCount,
        Map<String, Integer> quadsByChannel, int dynamicVertexCount, boolean tesrStrategyAttempted,
        boolean specialRendererPresent, CaptureEnvironment environment) {
        this.cellX = cellX;
        this.cellY = cellY;
        this.cellZ = cellZ;
        this.worldX = worldX;
        this.worldY = worldY;
        this.worldZ = worldZ;
        this.block = block;
        this.meta = meta;
        this.registryId = registryId;
        this.renderType = renderType;
        this.tileEntity = tileEntity;
        this.quadCount = quadCount;
        this.quadsByChannel = quadsByChannel == null ? Collections.<String, Integer>emptyMap()
            : Collections.unmodifiableMap(new LinkedHashMap<String, Integer>(quadsByChannel));
        this.dynamicVertexCount = dynamicVertexCount > 0 ? dynamicVertexCount : 0;
        this.tesrStrategyAttempted = tesrStrategyAttempted;
        this.specialRendererPresent = specialRendererPresent;
        this.environment = environment != null ? environment : CaptureEnvironment.allUnknown("no_environment");
    }

    /** 结构索引格（与 {@code cellGrid} 一致）。 */
    public int cellX() {
        return cellX;
    }

    public int cellY() {
        return cellY;
    }

    public int cellZ() {
        return cellZ;
    }

    /** 该格对应的世界方块角坐标（日志与 {@code captureIssue} 用）。 */
    public int worldX() {
        return worldX;
    }

    public int worldY() {
        return worldY;
    }

    public int worldZ() {
        return worldZ;
    }

    public Block block() {
        return block;
    }

    public int meta() {
        return meta;
    }

    /** 扫描身份（{@code namespace:path}）；{@code "air"} 表示这一格本来就没有方块。 */
    public String registryId() {
        return registryId;
    }

    /** {@code Block#getRenderType()}；{@code -1} = 没有可渲染的静态几何（几何只能来自 TESR 或模组自绘）。 */
    public int renderType() {
        return renderType;
    }

    /** 注入的<strong>副本</strong> TE（世界活动 TE 全程零写入）；为 {@code null} 表示该格没有 TE 或副本创建失败。 */
    public TileEntity tileEntity() {
        return tileEntity;
    }

    /** 本格本次捕获到的四边形数。 */
    public int quadCount() {
        return quadCount;
    }

    /**
     * 本格动态扩展相位收到的顶点数（含未闭合的）。0 = 完全无观测（例如几何只存在于显示列表里）；
     * &gt;0 而 quadCount 仍为 0 = 几何进来过、但没闭合出完整四边形。
     */
    public int dynamicVertexCount() {
        return dynamicVertexCount;
    }

    /** 按来源分的四边形数（键由捕获侧给出，仅用于日志解释，不参与裁决）。 */
    public Map<String, Integer> quadsByChannel() {
        return quadsByChannel;
    }

    /** TESR 补捕获策略是否对**这一格**求值过 {@code applies} 且为真（即真的尝试渲染过）。 */
    public boolean tesrStrategyAttempted() {
        return tesrStrategyAttempted;
    }

    /** 该格 TE 是否有特殊渲染器（由捕获侧查分派器得到；策略层不自己去查）。 */
    public boolean specialRendererPresent() {
        return specialRendererPresent;
    }

    /** 环境事实快照（会话级，只读）。 */
    public CaptureEnvironment environment() {
        return environment;
    }

    /** 这一格的方块是否有"静态几何"通道；{@code -1} 即没有。 */
    public boolean hasStaticRenderType() {
        return renderType >= 0;
    }
}
