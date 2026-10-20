package com.lightning.mod.core.sampling;

import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;

import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.nbt.NBTTagCompound;

import com.lightning.mod.core.registry.GregTechMetaTileRegistry;

/**
 * 单格采样结果，对应 Wiki palette 中一项（无 NBT 时默认实现）。
 * 对 {@code gregtech:gt.blockmachines}，{@link #meta} 为 GT5U MetaTile ID（mID），与 {@code block_registry} 键
 * {@code registryId@n} 对齐，见 {@link GregTechMetaTileRegistry}；
 * 其他方块为世界 block metadata（0–15）。
 * <p>
 * 可选 {@link #facing}：机器正面在世界中的外法线（Wiki {@code FaceName}，如 {@code -z}）；与 block_registry 以北为正面一致。
 * <p>
 * 可选 {@link #shellMaterialId}：GT 仓室（MTEHatch）在结构导出时由世界邻格解析的壳层材质 locator（与 {@code material_registry} 键一致）；非仓室或未解析时为
 * {@code null}。
 * <p>
 * 可选 {@link #tileNbt}：扫描时该格 {@link net.minecraft.tileentity.TileEntity#writeToNBT} 的快照，供客户端网格捕获时在假
 * {@link net.minecraft.world.IBlockAccess} 上还原 TE（如 GT ISBR）。
 */
public final class VoxelSample {

    public final String registryId;
    /** 一般为世界 meta；GT 机器块为 mID。 */
    public final int meta;
    /**
     * Wiki palette 的 {@code facing}（机器正面外法线，{@code FaceName}）；{@code null} 表示默认朝北（-z），与 block_registry 以北为正面一致。
     */
    public final String facing;
    /**
     * 仓室壳层材质 locator（与 block_registry / material_registry 一致）；仅 Hatch 扫描时可能非空。
     */
    public final String shellMaterialId;
    /**
     * 非空时表示该格有 TileEntity，且与扫描时世界状态一致（用于客户端 capture）。
     */
    public final NBTTagCompound tileNbt;
    /**
     * 渲染状态字节（Gitea #410 方向 A）：TE 的<b>渲染状态</b>按<b>模组自有同步格式</b>在扫描时刻的序列化。
     * 只在 {@code TileRenderStateProvider} 声明承载的模组族上非空（首个：LogisticsPipes 的
     * {@code PipeRenderState}——它不进 NBT，只走模组自己的同步包）。捕获侧把它回填到<b>副本</b> TE。
     */
    public final byte[] tileRenderState;
    /** {@link #tileRenderState} 的格式标识（读回时据此选提供者）；无状态时为 {@code null}。 */
    public final String tileRenderStateFormat;

    public VoxelSample(String registryId, int meta) {
        this(registryId, meta, null, null, null, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing) {
        this(registryId, meta, facing, null, null, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing, String shellMaterialId) {
        this(registryId, meta, facing, shellMaterialId, null, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing, String shellMaterialId, NBTTagCompound tileNbt) {
        this(registryId, meta, facing, shellMaterialId, tileNbt, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing, String shellMaterialId, NBTTagCompound tileNbt,
        byte[] tileRenderState, String tileRenderStateFormat) {
        this.registryId = registryId;
        this.meta = meta;
        this.facing = facing;
        this.shellMaterialId = shellMaterialId;
        this.tileNbt = tileNbt;
        this.tileRenderState = tileRenderState;
        this.tileRenderStateFormat = tileRenderStateFormat;
    }

    public static String key(String registryId, int meta) {
        return key(registryId, meta, null, null, null);
    }

    public static String key(String registryId, int meta, String facing) {
        return key(registryId, meta, facing, null, null);
    }

    public static String key(String registryId, int meta, String facing, String shellMaterialId) {
        return key(registryId, meta, facing, shellMaterialId, null);
    }

    public static String key(String registryId, int meta, String facing, String shellMaterialId,
        NBTTagCompound tileNbt) {
        return key(registryId, meta, facing, shellMaterialId, tileNbt, null, null);
    }

    /**
     * 完整键：registry / meta / facing / 壳层 / NBT 指纹 / <b>渲染状态指纹</b>。
     *
     * <p>
     * 渲染状态必须参与去重（Gitea #410）：同一根管在不同连接位上的 NBT 逐字节相同，只有渲染状态不同；
     * 若不进键，四根管会被折叠成同一个 palette 项，回填后四格全用同一种连接形状（错得看不出来）。
     */
    public static String key(String registryId, int meta, String facing, String shellMaterialId, NBTTagCompound tileNbt,
        String tileRenderStateFormat, byte[] tileRenderState) {
        String base = keyNoNbt(registryId, meta, facing, shellMaterialId);
        if (tileNbt != null) {
            base += '\0' + "nbt:" + tileNbtDigest(tileNbt);
        }
        if (tileRenderState != null && tileRenderState.length > 0) {
            base += '\0' + "rs:"
                + (tileRenderStateFormat == null ? "" : tileRenderStateFormat)
                + ':'
                + bytesDigest(tileRenderState);
        }
        return base;
    }

    private static String keyNoNbt(String registryId, int meta, String facing, String shellMaterialId) {
        String base;
        if (facing == null || facing.isEmpty()) {
            base = registryId + '\0' + meta;
        } else {
            base = registryId + '\0' + meta + '\0' + facing;
        }
        if (shellMaterialId == null || shellMaterialId.isEmpty()) {
            return base;
        }
        return base + '\0' + shellMaterialId;
    }

    /** 用于 palette 去重的短指纹（同 TE 快照视为同一 palette 项）。 */
    public static String tileNbtDigest(NBTTagCompound tag) {
        if (tag == null) {
            return "";
        }
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            CompressedStreamTools.writeCompressed(tag, baos);
            return bytesDigest(baos.toByteArray());
        } catch (Exception e) {
            return "err";
        }
    }

    /** 字节级短指纹（MD5 前 4 字节）：渲染状态参与去重时用，与 {@link #tileNbtDigest} 同口径。 */
    public static String bytesDigest(byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            return "";
        }
        try {
            byte[] d = MessageDigest.getInstance("MD5")
                .digest(bytes);
            StringBuilder sb = new StringBuilder(8);
            for (int i = 0; i < 4; i++) {
                sb.append(String.format("%02x", d[i] & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "err";
        }
    }

    public String key() {
        return key(registryId, meta, facing, shellMaterialId, tileNbt, tileRenderStateFormat, tileRenderState);
    }

    /**
     * 服务端 {@code cellTypes} 合并键：registry / meta / facing / NBT 字节；<strong>不含</strong>
     * {@link #shellMaterialId}（与扫描 JSON 字段一致，壳层不参与逻辑去重）。
     */
    public String cellTypeDedupeKey() {
        return key(registryId, meta, facing, null, tileNbt, tileRenderStateFormat, tileRenderState);
    }
}
