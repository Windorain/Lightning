package com.lightning.mod.core.scan;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.core.export.PackVersionProbe;
import com.lightning.mod.core.sampling.IBlockSampler;
import com.lightning.mod.core.sampling.VoxelSample;

/**
 * 选区扫描 → 中间态（{@code geometryPhase=scan}）：仅逻辑 {@code cellTypes}、{@code cellGrid}、
 * {@code worldGrid} 与世界 {@code scanBounds}，无几何、无 {@code blockPalette}。须由客户端
 * {@link com.lightning.mod.client.meshcapture.MeshCaptureService} 烘焙为 {@code geometryPhase=baked}。
 * <p>
 * 不写根级 {@code schemaVersion}；{@code cellTypes} 不写 {@code shellMaterialId}。
 */
public final class StructureScan {

    private StructureScan() {}

    public static JsonObject scanToStructureJson(World world, int minX, int minY, int minZ, int maxX, int maxY,
        int maxZ, String structureId, IBlockSampler sampler, EntityPlayerMP authorPlayer) {
        int ax = Math.min(minX, maxX), bx = Math.max(minX, maxX);
        int ay = Math.min(minY, maxY), by = Math.max(minY, maxY);
        int az = Math.min(minZ, maxZ), bz = Math.max(minZ, maxZ);

        int sizeCol = bx - ax + 1;
        int sizeRow = by - ay + 1;
        int sizeZ = bz - az + 1;

        List<VoxelSample> paletteList = new ArrayList<>();
        paletteList.add(new VoxelSample("air", 0));
        Map<String, Integer> paletteIndex = new HashMap<>();
        paletteIndex.put(new VoxelSample("air", 0).cellTypeDedupeKey(), 0);

        int[][][] cellGrid = new int[sizeZ][sizeRow][sizeCol];

        for (int zi = 0; zi < sizeZ; zi++) {
            int z = az + zi;
            for (int ri = 0; ri < sizeRow; ri++) {
                int y = by - ri;
                for (int ci = 0; ci < sizeCol; ci++) {
                    int x = ax + ci;
                    VoxelSample s = sampler.sample(world, x, y, z);
                    String k = s.cellTypeDedupeKey();
                    Integer idx = paletteIndex.get(k);
                    if (idx == null) {
                        idx = paletteList.size();
                        paletteList.add(s);
                        paletteIndex.put(k, idx);
                    }
                    cellGrid[zi][ri][ci] = idx;
                }
            }
        }

        JsonObject root = new JsonObject();
        root.addProperty("geometryPhase", "scan");
        root.addProperty("mode", "multiblock");
        root.addProperty("id", structureId);
        root.addProperty("label", structureId);
        root.addProperty("author", authorPlayer != null ? authorPlayer.getCommandSenderName() : "server");
        root.addProperty("gtnhVersion", PackVersionProbe.tryPackVersionString());
        root.add("description", JsonNull.INSTANCE);
        JsonObject src = new JsonObject();
        src.addProperty("note", "StructureDataExporter scan");
        root.add("source", src);

        JsonArray cellTypes = new JsonArray();
        for (VoxelSample s : paletteList) {
            JsonObject t = new JsonObject();
            t.addProperty("registryId", s.registryId);
            t.addProperty("meta", s.meta);
            if (s.facing != null && !s.facing.isEmpty()) {
                t.addProperty("facing", s.facing);
            }
            if (s.tileNbt != null) {
                try {
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    CompressedStreamTools.writeCompressed(s.tileNbt, baos);
                    t.addProperty(
                        "tileNbtB64",
                        Base64.getEncoder()
                            .encodeToString(baos.toByteArray()));
                } catch (Exception ignored) {
                    /* 跳过无法序列化的 TE */
                }
            }
            cellTypes.add(t);
        }
        root.add("cellTypes", cellTypes);

        JsonObject scanBounds = new JsonObject();
        scanBounds.addProperty("minX", ax);
        scanBounds.addProperty("maxY", by);
        scanBounds.addProperty("minZ", az);
        root.add("scanBounds", scanBounds);

        JsonArray cellGridJson = new JsonArray();
        JsonArray worldGridJson = new JsonArray();
        for (int zi = 0; zi < sizeZ; zi++) {
            int z = az + zi;
            JsonArray rows = new JsonArray();
            JsonArray wrows = new JsonArray();
            for (int ri = 0; ri < sizeRow; ri++) {
                int y = by - ri;
                JsonArray cols = new JsonArray();
                JsonArray wcols = new JsonArray();
                for (int ci = 0; ci < sizeCol; ci++) {
                    int x = ax + ci;
                    cols.add(new JsonPrimitive(cellGrid[zi][ri][ci]));
                    if (cellGrid[zi][ri][ci] == 0) {
                        wcols.add(JsonNull.INSTANCE);
                    } else {
                        JsonObject w = new JsonObject();
                        w.addProperty("x", x);
                        w.addProperty("y", y);
                        w.addProperty("z", z);
                        wcols.add(w);
                    }
                }
                rows.add(cols);
                wrows.add(wcols);
            }
            cellGridJson.add(rows);
            worldGridJson.add(wrows);
        }
        root.add("cellGrid", cellGridJson);
        root.add("worldGrid", worldGridJson);

        return root;
    }
}
