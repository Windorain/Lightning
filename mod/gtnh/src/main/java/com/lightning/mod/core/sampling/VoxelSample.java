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

    public VoxelSample(String registryId, int meta) {
        this(registryId, meta, null, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing) {
        this(registryId, meta, facing, null, null);
    }

    public VoxelSample(String registryId, int meta, String facing, String shellMaterialId) {
        this(registryId, meta, facing, shellMaterialId, null);
    }

    public VoxelSample(String registryId, int meta, String facing, String shellMaterialId, NBTTagCompound tileNbt) {
        this.registryId = registryId;
        this.meta = meta;
        this.facing = facing;
        this.shellMaterialId = shellMaterialId;
        this.tileNbt = tileNbt;
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
        String base = keyNoNbt(registryId, meta, facing, shellMaterialId);
        if (tileNbt == null) {
            return base;
        }
        return base + '\0' + "nbt:" + tileNbtDigest(tileNbt);
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
            byte[] d = MessageDigest.getInstance("MD5")
                .digest(baos.toByteArray());
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
        return key(registryId, meta, facing, shellMaterialId, tileNbt);
    }

    /**
     * 服务端 {@code cellTypes} 合并键：registry / meta / facing / NBT 字节；<strong>不含</strong>
     * {@link #shellMaterialId}（与扫描 JSON 字段一致，壳层不参与逻辑去重）。
     */
    public String cellTypeDedupeKey() {
        return key(registryId, meta, facing, null, tileNbt);
    }
}
