package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import net.minecraft.block.Block;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.export.BlockThumbnailRenderer;
import com.lightning.mod.client.export.TextureBlobEmbedder;
import com.lightning.mod.client.meshcapture.MeshCaptureService;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.3：<strong>全数据集唯一的方块调色板</strong>（契约 §6.1 的「所有变体并集 + 全局内容签名去重」）。
 * <p>
 * 三条硬约束的落点：
 * <ol>
 * <li><b>并集</b>：任何变体捕获到的方块状态一律 {@link #intern} 进这一张表，不存在「每变体一份调色板」；</li>
 * <li><b>同一方块状态的烘焙几何只存一份</b>：去重键 = {@code MeshCaptureService} 既有的内容签名
 * （{@code fullEqualitySignature(registryId, meta, nbt, geometry, tooltip)}，本数据集 nbt/tooltip 传 {@code null}）；
 * 命中即复用既有条目，新捕获的几何对象直接丢弃；</li>
 * <li><b>几何编码统一</b>：全表 {@code bakedQuadsJsonV1}，材质下标指向本类持有的<strong>全局材质表</strong>
 * （{@code CaptureToolkit.MaterialTable}），因此 {@code materialIndex} 在整个数据集内稳定。</li>
 * </ol>
 * 与既有 {@code MeshCaptureService#liftBlockPaletteToRoot} 是同一套机制（同一签名函数、同一 air-0 约定、
 * 同一 {@code renderMode/geometry/occludesAdjacentFaces/nbt/tooltip} 条目形状），只是调用方换成了 T1.3 的变体循环。
 */
@SideOnly(Side.CLIENT)
public final class GeometryPalette {

    public static final String GEOMETRY_ENCODING = "bakedQuadsJsonV1";

    public static final class Entry {

        public final int index;
        public final String registryId;
        public final int meta;
        /** 与既有产物同形的调色板条目（{@code registryId/meta/renderMode/geometry/occludesAdjacentFaces/nbt/tooltip}）。 */
        public final JsonObject json;
        public final String signature;
        /** 本条目的四边形数（变体几何总量统计用；与位置无关）。 */
        public final int quadCount;
        /** 被「变体 × 位置」引用的次数（去重统计：引用数 ≫ 条目数即证明共享）。 */
        public int referenceCount;
        /** 引用过该条目的机器集合（诊断：哪个变体集合真正用到了它）。 */
        public final TreeSet<String> referencedBy = new TreeSet<String>();

        Entry(int index, String registryId, int meta, JsonObject json, String signature, int quadCount) {
            this.index = index;
            this.registryId = registryId;
            this.meta = meta;
            this.json = json;
            this.signature = signature;
            this.quadCount = quadCount;
        }
    }

    private final Map<String, Entry> bySignature = new LinkedHashMap<String, Entry>();
    private final List<Entry> entries = new ArrayList<Entry>();
    private final MeshCaptureService.CaptureToolkit.MaterialTable materials = new MeshCaptureService.CaptureToolkit.MaterialTable();
    private final boolean includeThumbnails;

    /** 同签名重复捕获次数（= 被去重掉的烘焙几何份数），硬约束 3 的机器判据之一。 */
    private int duplicateCaptures;
    /** 累计的 intern 调用次数（= 变体 × 非空气位置）。 */
    private int internCalls;

    private JsonArray materialPalette = new JsonArray();
    private JsonArray textureBlobs = new JsonArray();
    private boolean texturesEmbedded;

    public GeometryPalette(boolean includeThumbnails) {
        this.includeThumbnails = includeThumbnails;
        JsonObject air = MeshCaptureService.CaptureToolkit.airEntry();
        Entry e = new Entry(0, "air", 0, air, MeshCaptureService.CaptureToolkit.signatureOfEntry(air), 0);
        bySignature.put(e.signature, e);
        entries.add(e);
    }

    public MeshCaptureService.CaptureToolkit.MaterialTable materials() {
        return materials;
    }

    public int size() {
        return entries.size();
    }

    public int internCalls() {
        return internCalls;
    }

    public int duplicateCaptures() {
        return duplicateCaptures;
    }

    public List<Entry> entries() {
        return entries;
    }

    /**
     * 入库一个方块状态的烘焙几何；返回它的全局下标（同一内容签名只保留一份）。
     *
     * @param geometry              {@code bakedQuadsJsonV1} 几何（已挂好 {@code materialIndex}）
     * @param occludesAdjacentFaces 与既有条目同义
     * @param block                 用于缩略图渲染；可为 {@code null}（则跳过缩略图）
     * @param referencedByMachine   变体所属机器（去重统计/诊断）
     */
    public Entry intern(String registryId, int meta, JsonObject geometry, boolean occludesAdjacentFaces, Block block,
        String referencedByMachine, int quadCount) {
        internCalls++;
        String sig = MeshCaptureService.CaptureToolkit.signatureOfState(registryId, meta, null, geometry, null);
        Entry existing = bySignature.get(sig);
        if (existing != null) {
            duplicateCaptures++;
            existing.referenceCount++;
            if (referencedByMachine != null) existing.referencedBy.add(referencedByMachine);
            return existing;
        }
        JsonObject entry = new JsonObject();
        entry.addProperty("registryId", registryId);
        entry.addProperty("meta", meta);
        if (includeThumbnails && block != null) {
            try {
                String thumbB64 = BlockThumbnailRenderer.renderToBase64PNG(block, meta);
                if (thumbB64 != null && !thumbB64.isEmpty()) {
                    entry.addProperty("thumbnailPNG", thumbB64);
                }
            } catch (Throwable ignored) {
                // 缩略图失败不阻断几何导出（与既有 finalizeSingleStructure 同处置）
            }
        }
        entry.addProperty("renderMode", "BakedModel");
        entry.add("geometry", geometry);
        entry.addProperty("occludesAdjacentFaces", occludesAdjacentFaces);
        entry.add("nbt", JsonNull.INSTANCE);
        entry.add("tooltip", new JsonArray());
        Entry created = new Entry(entries.size(), registryId, meta, entry, sig, quadCount);
        created.referenceCount = 1;
        if (referencedByMachine != null) created.referencedBy.add(referencedByMachine);
        bySignature.put(sig, created);
        entries.add(created);
        return created;
    }

    /** 记录一次「复用引用」（变体里同一位置再次用到同一状态时无需重新 intern 几何，但引用计数要算）。 */
    public void noteReference(Entry entry, String referencedByMachine) {
        entry.referenceCount++;
        if (referencedByMachine != null) entry.referencedBy.add(referencedByMachine);
    }

    /** 根级 {@code blockPalette}（下标 0 恒为 air），与既有 {@code liftBlockPaletteToRoot} 输出同形。 */
    public JsonArray blockPaletteJson() {
        JsonArray out = new JsonArray();
        for (Entry e : entries) {
            out.add(e.json);
        }
        return out;
    }

    public JsonArray materialPaletteJson() {
        return materialPalette;
    }

    public JsonArray textureBlobsJson() {
        return textureBlobs;
    }

    /** 纹理嵌入（复用 {@code TextureBlobEmbedder}）：把材质表的像素写进 {@code textureBlobs} 并回填 blob 下标。 */
    public void embedTextures() throws Exception {
        if (texturesEmbedded) return;
        JsonObject root = new JsonObject();
        root.add("materialPalette", materials.toMaterialPalette());
        TextureBlobEmbedder.embedIntoDocument(root);
        this.materialPalette = root.getAsJsonArray("materialPalette");
        this.textureBlobs = root.getAsJsonArray("textureBlobs");
        texturesEmbedded = true;
    }

    /** 未被任何变体引用过的条目（契约 §6.1 第 4 条：并集是「用到的并集」，非空气条目不该有 0 引用）。 */
    public List<String> unreferencedEntries() {
        List<String> out = new ArrayList<String>();
        for (Entry e : entries) {
            if (e.index == 0) continue;
            if (e.referenceCount == 0) out.add(e.index + ":" + e.registryId + ":" + e.meta);
        }
        return out;
    }

    /** 去重统计（写进报告，作为硬约束 3 的证据）。 */
    public JsonObject statsJson() {
        int referenced = 0;
        int totalRefs = 0;
        for (Entry e : entries) {
            if (e.referenceCount > 0) referenced++;
            totalRefs += e.referenceCount;
        }
        JsonObject o = new JsonObject();
        o.addProperty("paletteEntries", entries.size());
        o.addProperty("paletteEntriesExcludingAir", entries.size() - 1);
        o.addProperty("referencedEntries", referenced);
        o.addProperty("unreferencedEntries", entries.size() - referenced);
        o.addProperty("referenceEvents", totalRefs);
        o.addProperty("internCalls", internCalls);
        o.addProperty("duplicateCapturesSuppressed", duplicateCaptures);
        o.addProperty(
            "dedupRatio",
            internCalls == 0 ? 0.0d
                : Math.round(10000.0d * (1.0d - (double) entries.size() / (double) internCalls)) / 100.0d);
        o.addProperty(
            "dedupKey",
            "MeshCaptureService#fullEqualitySignature(registryId, meta, nbt=null, geometry, tooltip=null)");
        o.addProperty("geometryEncoding", GEOMETRY_ENCODING);
        o.addProperty("materialEntries", materialPalette.size());
        o.addProperty("textureBlobs", textureBlobs.size());
        JsonArray ur = new JsonArray();
        for (String s : unreferencedEntries()) {
            ur.add(new JsonPrimitive(s));
        }
        o.add("unreferencedEntryList", ur);
        return o;
    }
}
