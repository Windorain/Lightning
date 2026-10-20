package com.lightning.mod.client.meshcapture;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.init.Blocks;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.Timer;
import net.minecraft.world.World;

import org.lwjgl.opengl.GL11;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.export.BlockThumbnailRenderer;
import com.lightning.mod.client.export.ExportTextureLocator;
import com.lightning.mod.client.export.MaterialAnimationJson;
import com.lightning.mod.client.export.MaterialBlendMode;
import com.lightning.mod.client.export.NbtJsonSerializer;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;
import com.lightning.mod.client.export.TextureBlobEmbedder;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;
import com.lightning.mod.client.meshcapture.parts.ItemIndexIntegrator;
import com.lightning.mod.client.meshcapture.parts.PartCapturePipeline;
import com.lightning.mod.client.meshcapture.parts.PartCaptureResult;
import com.lightning.mod.client.meshcapture.parts.PartExportIntegrator;
import com.lightning.mod.client.meshcapture.parts.PartItem;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderContext;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderRegistry;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureContext;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureRegistry;
import com.lightning.mod.core.sampling.VoxelSample;
import com.lightning.mod.core.sampling.renderstate.TileRenderStateProviders;
import com.lightning.mod.core.session.ScanCellResolution;
import com.lightning.mod.core.session.SdeCellCoords;
import com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.ReflectionHelper;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * Client-only：读取 {@code geometryPhase=scan}，在客户端世界坐标下烘焙 BakedQuads，按几何指纹合并槽位，写出 {@code geometryPhase=baked}（无根级
 * {@code schemaVersion}，{@code blockPalette} 无 {@code tileNbtB64}）。
 */
@SideOnly(Side.CLIENT)
public final class MeshCaptureService {

    private MeshCaptureService() {}

    /**
     * TE 捕获模式：**只剩「副本 TE」一条路**（按扫描 NBT 造一份副本 TE 注入后处理渲染，
     * <strong>世界活动 TE 全程零写入</strong>）。
     *
     * <p>
     * Gitea #104 删除了老逃生开关 {@code -Dsde.teCaptureMode=inplace}（负对照专用）：issue #12 的
     * 缺陷已由副本路径永久修复，负对照的调用方（{@code LpTeRoundTripAutomation} /
     * {@code PartsExportProbe}）也随 #104 整体删除 ⇒ 开关没有任何合法的使用者，
     * 留着就是 E1「无逃生开关」的残留。删掉的是<b>开关与 inplace 分支</b>，副本路径（生产路径）不变。
     *
     * <p>
     * 为什么 inplace 从来不能是生产路径（历史实证，保留以免后人重开）：LogisticsPipes 的
     * {@code LogisticsTileGenericPipe.readFromNBT} 非幂等（每次读 NBT 都重建 pipe，而
     * {@code bindPipe()} 有 {@code if (pipeBound) return;} 一次性绑定守卫），第二次及以后读 NBT 建出的
     * pipe 永远绑不上容器（{@code pipe.container} 永久为 null）→ 导出结束后正常渲染 NPE 崩溃客户端；
     * 读备份回滚同样修不回来（再读一次 NBT 只会再建一个绑不上的 pipe）。
     */

    public static void enrichExportFile(File file) throws Exception {
        if (!file.isFile()) {
            throw new IllegalArgumentException("Not a file: " + file);
        }
        JsonParser parser = new JsonParser();
        JsonObject root;
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
            root = parser.parse(r)
                .getAsJsonObject();
        }
        finalizeStructureJson(root);
        com.google.gson.Gson gson = new com.google.gson.GsonBuilder().setPrettyPrinting()
            .create();
        try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
            new java.io.FileOutputStream(file),
            StandardCharsets.UTF_8)) {
            w.write(gson.toJson(root));
        }
    }

    /**
     * 解析网络负载 JSON，在客户端写出终态 StructureData 至 {@code structure_exports}。
     *
     * @param writeRaw {@code true} 时写出明文 Raw（含 {@code documentFormat: Raw}）；默认 {@code false} 为 Compact 信封。
     */
    public static void enrichAndWriteClientExport(String fileName, byte[] utf8Json, boolean writeRaw) throws Exception {
        JsonParser parser = new JsonParser();
        JsonObject root = parser.parse(new String(utf8Json, StandardCharsets.UTF_8))
            .getAsJsonObject();
        finalizeStructureJson(root);
        File dir = new File(Minecraft.getMinecraft().mcDataDir, "structure_exports");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + dir.getAbsolutePath());
        }
        File out = new File(dir, fileName);
        try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
            new java.io.FileOutputStream(out),
            StandardCharsets.UTF_8)) {
            if (writeRaw) {
                root.addProperty("documentFormat", "Plain");
                com.google.gson.Gson gson = new com.google.gson.GsonBuilder().setPrettyPrinting()
                    .create();
                w.write(gson.toJson(root));
            } else {
                JsonObject envelope = SceneEnvelopeBuilder.toEnvelope(root);
                w.write(new com.google.gson.Gson().toJson(envelope));
            }
        }
    }

    /**
     * 就地修改 root：单文件 {@code geometryPhase=scan} 或 World 文档内每一帧的 {@code structure} 均执行烘焙。
     */
    public static void finalizeStructureJson(JsonObject root) throws Exception {
        if (root.has("frames")) {
            SamplerTable samplers = new SamplerTable();
            JsonArray frames = root.getAsJsonArray("frames");
            List<PartExportIntegrator.StructureSink> partsSinks = new ArrayList<>();
            for (int i = 0; i < frames.size(); i++) {
                JsonObject fr = frames.get(i)
                    .getAsJsonObject();
                if (fr.has("structure")) {
                    // 物品索引表归属条目按帧定位（契约 §2.2）：帧下标取 frames[i].index，缺省退化为 i
                    int frameIndex = fr.has("index") ? fr.get("index")
                        .getAsInt() : i;
                    partsSinks.add(finalizeSingleStructure(fr.getAsJsonObject("structure"), samplers, frameIndex));
                }
            }
            root.add("materialPalette", samplers.toMaterialPalette());
            liftBlockPaletteToRoot(frames, root);
            integrateSdeCellNotesWorldRoot(root);
            if (!root.has("tooltipPalette")) {
                root.add("tooltipPalette", new com.google.gson.JsonArray());
            }
            finishPartsDocument(root, partsSinks);
            TextureBlobEmbedder.embedIntoDocument(root);
            return;
        }
        if (root.has("geometryPhase") && "scan".equals(
            root.get("geometryPhase")
                .getAsString())) {
            PartExportIntegrator.StructureSink partsSink = finalizeSingleStructure(root);
            integrateSdeCellNotesSingleBakedRoot(root);
            // #81：与 frames 分支口径一致——无逐格说明时也产出**空** tooltipPalette
            // （成对 idioms 产出侧对齐：cellTooltipGrid 无条件写出，tooltipPalette 不再缺省；
            // web 写入侧据此新建条目即可存活，见 #80）。
            if (!root.has("tooltipPalette")) {
                root.add("tooltipPalette", new com.google.gson.JsonArray());
            }
            List<PartExportIntegrator.StructureSink> partsSinks = new ArrayList<>();
            partsSinks.add(partsSink);
            finishPartsDocument(root, partsSinks);
            TextureBlobEmbedder.embedIntoDocument(root);
            return;
        }
        if (root.has("geometryPhase") && "baked".equals(
            root.get("geometryPhase")
                .getAsString())
            && !root.has("textureBlobs")) {
            TextureBlobEmbedder.embedIntoDocument(root);
        }
    }

    /**
     * 全局 blockPalette SHA-256 去重：将各帧内 blockPalette 合并到根级，各帧 cellGrid 重映射为全局下标后移除帧内 blockPalette。
     */
    private static void liftBlockPaletteToRoot(JsonArray frames, JsonObject root) {
        Map<String, Integer> sigToGlobal = new HashMap<>();
        Map<Integer, JsonObject> globalEntryByIndex = new HashMap<>();
        int nextGlobal = 1;

        Map<Integer, Map<Integer, Integer>> frameRemap = new HashMap<>();

        for (int fi = 0; fi < frames.size(); fi++) {
            JsonObject st = frames.get(fi)
                .getAsJsonObject()
                .getAsJsonObject("structure");
            if (!st.has("blockPalette")) continue;
            JsonArray localBP = st.getAsJsonArray("blockPalette");

            Map<Integer, Integer> localToGlobal = new HashMap<>();
            localToGlobal.put(Integer.valueOf(0), Integer.valueOf(0));

            for (int li = 1; li < localBP.size(); li++) {
                JsonObject entry = localBP.get(li)
                    .getAsJsonObject();
                String sig = entryEqualitySignature(entry);
                Integer gi = sigToGlobal.get(sig);
                if (gi == null) {
                    gi = Integer.valueOf(nextGlobal++);
                    sigToGlobal.put(sig, gi);
                    globalEntryByIndex.put(gi, entry);
                }
                localToGlobal.put(Integer.valueOf(li), gi);
            }
            frameRemap.put(Integer.valueOf(fi), localToGlobal);
        }

        JsonArray rootBP = new JsonArray();
        rootBP.add(airBlockPaletteEntry());
        for (int gi = 1; gi < nextGlobal; gi++) {
            rootBP.add(globalEntryByIndex.get(Integer.valueOf(gi)));
        }
        root.add("blockPalette", rootBP);

        for (int fi = 0; fi < frames.size(); fi++) {
            JsonObject fr = frames.get(fi)
                .getAsJsonObject();
            JsonObject st = fr.getAsJsonObject("structure");
            if (!st.has("cellGrid") || !st.has("blockPalette")) continue;

            JsonArray oldGrid = st.getAsJsonArray("cellGrid");
            Map<Integer, Integer> localToGlobal = frameRemap.get(Integer.valueOf(fi));
            if (localToGlobal == null) continue;

            int[][][] parsed = parseCellGrid(oldGrid);
            int[][][] remapped = new int[parsed.length][parsed[0].length][parsed[0][0].length];
            for (int zi = 0; zi < parsed.length; zi++) {
                for (int ri = 0; ri < parsed[zi].length; ri++) {
                    for (int ci = 0; ci < parsed[zi][ri].length; ci++) {
                        Integer local = Integer.valueOf(parsed[zi][ri][ci]);
                        remapped[zi][ri][ci] = localToGlobal.getOrDefault(local, Integer.valueOf(0))
                            .intValue();
                    }
                }
            }
            st.add("cellGrid", cellGridToJson(remapped));
            st.remove("blockPalette");
        }
    }

    /**
     * 将 scan 中 {@code sdeCellNotes} 并入库根 {@code tooltipPalette} + 各帧 {@code cellTooltipGrid}，再移除临时字段（与
     * WebStructureRenderer 一致）。
     */
    private static void integrateSdeCellNotesWorldRoot(JsonObject worldRoot) {
        if (worldRoot == null || !worldRoot.has("frames")) {
            return;
        }
        JsonArray frames = worldRoot.getAsJsonArray("frames");
        List<String> palette = new ArrayList<>();
        Map<String, Integer> stringToIndex = new HashMap<>();
        for (int i = 0; i < frames.size(); i++) {
            JsonObject fr = frames.get(i)
                .getAsJsonObject();
            if (!fr.has("structure")) {
                continue;
            }
            JsonObject st = fr.getAsJsonObject("structure");
            collectSdeNoteStringsForPalette(st.get("sdeCellNotes"), stringToIndex, palette);
        }
        if (palette.isEmpty()) {
            return;
        }
        JsonArray palJson = new JsonArray();
        for (String s : palette) {
            palJson.add(new JsonPrimitive(s));
        }
        worldRoot.add("tooltipPalette", palJson);
        for (int i = 0; i < frames.size(); i++) {
            JsonObject fr = frames.get(i)
                .getAsJsonObject();
            if (!fr.has("structure")) {
                continue;
            }
            JsonObject st = fr.getAsJsonObject("structure");
            applySdeCellNotesToBakedStructure(st, stringToIndex);
        }
    }

    private static void collectSdeNoteStringsForPalette(JsonElement sdeCellNotes, Map<String, Integer> stringToIndex,
        List<String> palette) {
        if (sdeCellNotes == null || !sdeCellNotes.isJsonObject()) {
            return;
        }
        for (Map.Entry<String, JsonElement> e : sdeCellNotes.getAsJsonObject()
            .entrySet()) {
            if (!e.getValue()
                .isJsonPrimitive()) {
                continue;
            }
            String t = e.getValue()
                .getAsString();
            if (t == null || t.isEmpty()) {
                continue;
            }
            if (!stringToIndex.containsKey(t)) {
                stringToIndex.put(t, Integer.valueOf(palette.size()));
                palette.add(t);
            }
        }
    }

    private static void applySdeCellNotesToBakedStructure(JsonObject st, Map<String, Integer> stringToIndex) {
        if (st == null || !st.has("cellGrid")) {
            return;
        }
        int[] dim = readCellGridDimensions3(st.getAsJsonArray("cellGrid"));
        if (dim == null) {
            return;
        }
        int sizeZ = dim[0], sizeRow = dim[1], sizeCol = dim[2];
        int[][][] ttg = new int[sizeZ][sizeRow][sizeCol];
        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    ttg[zi][ri][ci] = -1;
                }
            }
        }
        if (st.has("sdeCellNotes") && st.get("sdeCellNotes")
            .isJsonObject()) {
            for (Map.Entry<String, JsonElement> e : st.getAsJsonObject("sdeCellNotes")
                .entrySet()) {
                if (!e.getValue()
                    .isJsonPrimitive()) {
                    continue;
                }
                int[] zrc = SdeCellCoords.tryParseCellKey(e.getKey());
                if (zrc == null || zrc[0] < 0
                    || zrc[0] >= sizeZ
                    || zrc[1] < 0
                    || zrc[1] >= sizeRow
                    || zrc[2] < 0
                    || zrc[2] >= sizeCol) {
                    continue;
                }
                String t = e.getValue()
                    .getAsString();
                if (t == null || t.isEmpty()) {
                    continue;
                }
                Integer id = stringToIndex.get(t);
                if (id == null) {
                    continue;
                }
                ttg[zrc[0]][zrc[1]][zrc[2]] = id.intValue();
            }
        }
        st.add("cellTooltipGrid", cellGridToJson(ttg));
        st.remove("sdeCellNotes");
    }

    private static int[] readCellGridDimensions3(JsonArray cellGrid) {
        if (cellGrid == null || cellGrid.size() == 0) {
            return null;
        }
        try {
            int sizeZ = cellGrid.size();
            JsonArray row0 = cellGrid.get(0)
                .getAsJsonArray();
            int sizeRow = row0.size();
            int sizeCol = row0.get(0)
                .getAsJsonArray()
                .size();
            return new int[] { sizeZ, sizeRow, sizeCol };
        } catch (Exception e) {
            return null;
        }
    }

    private static void integrateSdeCellNotesSingleBakedRoot(JsonObject root) {
        if (root == null || !root.has("sdeCellNotes")
            || !root.get("sdeCellNotes")
                .isJsonObject()) {
            return;
        }
        List<String> palette = new ArrayList<>();
        Map<String, Integer> stringToIndex = new HashMap<>();
        collectSdeNoteStringsForPalette(root.get("sdeCellNotes"), stringToIndex, palette);
        if (palette.isEmpty()) {
            root.remove("sdeCellNotes");
            return;
        }
        JsonArray palJson = new JsonArray();
        for (String s : palette) {
            palJson.add(new JsonPrimitive(s));
        }
        root.add("tooltipPalette", palJson);
        applySdeCellNotesToBakedStructure(root, stringToIndex);
    }

    private static PartExportIntegrator.StructureSink finalizeSingleStructure(JsonObject structure) throws Exception {
        SamplerTable samplers = new SamplerTable();
        PartExportIntegrator.StructureSink partsSink = finalizeSingleStructure(structure, samplers, 0);
        structure.add("materialPalette", samplers.toMaterialPalette());
        return partsSink;
    }

    /**
     * P1.7 文档级收尾（契约 §2/§2.2/§9、部件图标）：文档含部件数据 ⇒ 写 {@code statsTemplate}
     * 默认值 + {@code partIconTextures}（iconKey → base64 PNG）+ {@code itemIndex}（物品索引表）；
     * 无部件 ⇒ 三字段完全不产出（字节干净硬约束）。
     */
    private static void finishPartsDocument(JsonObject root, List<PartExportIntegrator.StructureSink> partsSinks) {
        if (root == null || partsSinks == null || !PartExportIntegrator.isEnabled()) {
            return;
        }
        Map<String, PartItem> uniqueItems = new LinkedHashMap<>();
        boolean hasParts = false;
        List<ItemIndexIntegrator.Sink> itemIndexSinks = new ArrayList<>();
        for (PartExportIntegrator.StructureSink sink : partsSinks) {
            if (sink != null && sink.hasParts()) {
                hasParts = true;
                uniqueItems.putAll(sink.uniquePartItems());
            }
            if (sink != null) {
                itemIndexSinks.add(sink.itemIndexSink());
            }
        }
        if (!hasParts) {
            return;
        }
        root.add("statsTemplate", PartExportIntegrator.defaultStatsTemplate());
        PartExportIntegrator.embedPartIcons(root, uniqueItems);
        // 契约 §2.2 物品索引表：文档根级共享（World 跨帧一份）、按键去重、跨帧不重复；
        // 无条目 ⇒ 字段不产出（与 statsTemplate/partIconTextures 同一字节干净口径）
        JsonObject itemIndex = ItemIndexIntegrator.buildDocumentIndex(itemIndexSinks);
        if (itemIndex != null && itemIndex.entrySet()
            .size() > 0) {
            root.add(ItemIndexIntegrator.FIELD, itemIndex);
        }
    }

    private static PartExportIntegrator.StructureSink finalizeSingleStructure(JsonObject structure,
        SamplerTable samplers, int frameIndex) throws Exception {
        if (structure == null || !structure.has("cellGrid")) {
            return null;
        }
        if (!structure.has("geometryPhase") || !"scan".equals(
            structure.get("geometryPhase")
                .getAsString())) {
            return null;
        }
        if (!structure.has("cellTypes") || !structure.has("worldGrid")) {
            throw new IllegalStateException("geometryPhase=scan finalize requires cellTypes and worldGrid.");
        }
        structure.remove("capture");
        structure.remove("schemaVersion");

        World world = Minecraft.getMinecraft().theWorld;
        if (world == null) {
            throw new IllegalStateException("finalize requires Minecraft.theWorld (client).");
        }

        JsonArray cellTypesJson = structure.getAsJsonArray("cellTypes");
        JsonArray gridArr = structure.getAsJsonArray("cellGrid");
        JsonArray worldGridArr = structure.getAsJsonArray("worldGrid");
        VoxelSample[] cellTypes = parseCellTypes(cellTypesJson);
        int[][][] cellGrid = parseCellGrid(gridArr);
        int[][][][] worldCoords = parseWorldGrid(worldGridArr, cellGrid);

        int sizeZ = cellGrid.length;
        int sizeRow = cellGrid[0].length;
        int sizeCol = cellGrid[0][0].length;

        // P1.7：结构级部件落盘汇聚器（探针 A/B 开关关闭时为 null = 完全跳过部件采集）
        PartExportIntegrator.StructureSink partsSink = PartExportIntegrator.isEnabled()
            ? PartExportIntegrator.newStructureSink(frameIndex, sizeZ, sizeRow, sizeCol)
            : null;

        validateWorldGridChunks(world, cellGrid, worldCoords);

        RenderBlocks rb = new RenderBlocks(world);
        rb.renderAllFaces = true;
        rb.blockAccess = new ScanBackedBlockAccess(world, worldCoords, cellGrid, cellTypes);

        TextureMap textureMap = Minecraft.getMinecraft()
            .getTextureMapBlocks();

        /* 为每种 cellType 生成 NEI 风格的 ToolTip 文本 */
        Map<Integer, List<String>> tooltipByCellType = new HashMap<>();
        for (int ti = 1; ti < cellTypes.length; ti++) {
            VoxelSample vs = cellTypes[ti];
            try {
                Block b = Block.getBlockFromName(vs.registryId);
                if (b != null && b != Blocks.air) {
                    ItemStack stack = new ItemStack(b, 1, vs.meta);
                    if (vs.tileNbt != null && !vs.tileNbt.hasNoTags()) {
                        stack.setTagCompound((NBTTagCompound) vs.tileNbt.copy());
                    }
                    List<String> lines = stack.getTooltip(
                        Minecraft.getMinecraft().thePlayer,
                        Minecraft.getMinecraft().gameSettings.advancedItemTooltips);
                    if (lines != null && !lines.isEmpty()) {
                        tooltipByCellType.put(ti, lines);
                    }
                }
            } catch (Exception ignored) {
                // Tooltip generation failure shouldn't block export
            }
        }

        // Per-cell capture + geometry-hash dedup
        Map<String, Integer> sigToFinal = new HashMap<>();
        Map<Integer, VoxelSample> repForFinal = new HashMap<>();
        Map<Integer, JsonObject> geometryForFinal = new HashMap<>();
        Map<Integer, Boolean> opaqueForFinal = new HashMap<>();
        Map<Integer, List<String>> tooltipForFinal = new HashMap<>();
        int nextFinal = 1;
        int[][][] remapped = new int[sizeZ][sizeRow][sizeCol];
        // #127：活动世界该格已是空气、但扫描身份有块的格数（= 「世界在录制后被改动」的显式计数）。
        // 它不改变产物语义（仍按扫描身份保留），只是把「这次导出发生过世界漂移」写进日志，
        // 让「产物按录制内容忠实还原」这件事可观察，而不是静默发生。
        int worldChangedCells = 0;

        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    int ti = cellGrid[zi][ri][ci];
                    if (ti == 0) {
                        remapped[zi][ri][ci] = 0;
                        continue;
                    }
                    if (ti < 0 || ti >= cellTypes.length) {
                        throw new CpException(
                            ErrorCodes.STATE,
                            "扫描身份越界：cellGrid[" + zi
                                + "]["
                                + ri
                                + "]["
                                + ci
                                + "]="
                                + ti
                                + " 不在 cellTypes[0.."
                                + (cellTypes.length - 1)
                                + "] 之内（帧数据坏了）",
                            Json.object(
                                "action",
                                "export.scene",
                                "stage",
                                "bake",
                                "index",
                                Integer.valueOf(ti),
                                "cellTypesSize",
                                Integer.valueOf(cellTypes.length),
                                "hint",
                                "该帧的 cellGrid/cellTypes 不自洽；请重新 record（不要手工拼帧）"));
                    }
                    VoxelSample vs = cellTypes[ti];
                    int wx = worldCoords[zi][ri][ci][0];
                    int wy = worldCoords[zi][ri][ci][1];
                    int wz = worldCoords[zi][ri][ci][2];

                    // ---------------------------------------------------------------- Gitea #127 第 3 条
                    // 「保留哪些格、用什么身份」一律来自**扫描身份**（cellTypes[ti]），不再由活动世界的
                    // 回查结果决定。改造前是 `Block b = world.getBlock(...); if (b == air) remapped = 0`
                    // ——空气即静默丢块，于是同一帧、同一 frameSha256 的产物内容会随「导出时人在哪个世界」
                    // 变化（跨世界/事后导出/世界漂移都会踩到，而 C2/C3 判据全绿）。
                    // 判定是纯函数（ScanCellResolution），与「渲染仍用活动 world 实例」互不矛盾。
                    Block scanBlock = Block.getBlockFromName(vs.registryId);
                    boolean scanResolvable = scanBlock != null && scanBlock != Blocks.air;
                    Block liveBlock = world.getBlock(wx, wy, wz);
                    boolean liveIsAir = liveBlock == null || liveBlock == Blocks.air;
                    String liveRegistryId = liveIsAir ? null : registryIdOf(liveBlock);
                    ScanCellResolution.Verdict verdict = ScanCellResolution
                        .decide(vs.registryId, scanResolvable, liveIsAir, liveRegistryId);
                    if (verdict == ScanCellResolution.Verdict.SCAN_AIR) {
                        // 扫描身份就是空气：没有可保留的内容，不是丢块
                        remapped[zi][ri][ci] = 0;
                        continue;
                    }
                    if (verdict == ScanCellResolution.Verdict.SCAN_UNRESOLVED) {
                        throw new CpException(
                            ErrorCodes.STATE,
                            "扫描身份无法解析：registryId=" + vs.registryId + " 在方块注册表里找不到（该模组缺失或标本被改）",
                            Json.object(
                                "action",
                                "export.scene",
                                "stage",
                                "bake",
                                "cell",
                                cellJson(wx, wy, wz),
                                "expected",
                                Json.object("registryId", vs.registryId, "meta", Integer.valueOf(vs.meta)),
                                "hint",
                                "本格按扫描身份渲染需要该方块；缺方块时不许静默丢块、也不许换块——" + "请在装有该模组的客户端导出（或重新录制）"));
                    }
                    if (verdict == ScanCellResolution.Verdict.WORLD_MISMATCH) {
                        // 活动世界该坐标是另一个非空气方块：不许静默丢、也不许静默换块 ⇒ 显式报错，不写产物
                        throw new CpException(
                            ErrorCodes.STATE,
                            "烘焙遇世界身份冲突：录制时该格是 " + vs.registryId + "，导出时刻活动世界是 " + liveRegistryId,
                            Json.object(
                                "action",
                                "export.scene",
                                "stage",
                                "bake",
                                "cell",
                                cellJson(wx, wy, wz),
                                "expected",
                                Json.object("registryId", vs.registryId, "meta", Integer.valueOf(vs.meta)),
                                "actual",
                                Json.object("registryId", liveRegistryId),
                                "hint",
                                "帧内容按录制时刻的世界生效；该坐标已被改成别的方块 ⇒ 无法判定该用哪个身份，" + "故显式失败而不是静默换块。若该帧确实录于这个世界，请把该格还原为录制时的方块"
                                    + "（或重新 record）；本动作不写任何产物"));
                    }
                    // KEEP_SCAN_IDENTITY：身份与 meta 都取自扫描（meta 尤其重要：GT 机器格的 meta 是 mID，
                    // 不是世界 metadata；改造前那行 `vs != null ? vs.meta : world.getBlockMetadata(...)`
                    // 实际也总是走扫描侧，这里把它显式化）
                    Block b = scanBlock;
                    if (liveIsAir) {
                        worldChangedCells++;
                    }
                    String label = captureLabel(vs, b, world, wx, wy, wz);
                    CapturedBlockInstance inst = new CapturedBlockInstance();
                    int blockMeta = vs.meta;
                    int renderType = b.getRenderType();

                    // Gitea issue #12：**不得**对世界活动 TE 做 readFromNBT。LogisticsPipes 等模组的
                    // readFromNBT 非幂等：LogisticsTileGenericPipe.readFromNBT 每次都重建 pipe 对象，而
                    // bindPipe() 有 `if (pipeBound) return;` 一次性绑定守卫（pipeBound 只在构造期为 false），
                    // 于是第二次及以后读 NBT 建出的 pipe 永远绑不上容器（container 永久为 null）→ 导出结束后
                    // 正常渲染 NPE 崩溃客户端；"读备份回滚"也修不回来（再读一次只会再建一个绑不上的 pipe）。
                    // 默认路径：活动 TE 全程零写入，改为按扫描 NBT 造一份「副本 TE」注入后处理渲染。
                    //
                    // #127：副本 TE 的**来源是扫描 NBT**，因此活动 TE 只是「可用的加速/降级信息」，不是前提：
                    // 该格在活动世界里已被清空（teForCapture == null）时，仍按扫描 NBT 造副本，
                    // 否则「按扫描身份保留」会退化成「保留了块但丢了 TE 渲染」这种更隐蔽的失真。
                    TileEntity teForCapture = world.getTileEntity(wx, wy, wz);
                    boolean teIsMultipart = false;
                    TileEntity teForRender = teForCapture;
                    if (vs.tileNbt != null && !vs.tileNbt.hasNoTags()) {
                        // 以下两步均为只读：判定/诊断只读活动 TE 的类，不写任何字段
                        if (teForCapture != null) {
                            teIsMultipart = MultipartNbtStateUtil.isTileMultipart(teForCapture);
                            MultipartNbtStateUtil.diagnoseReadFromNbtOverride(teForCapture);
                        } else {
                            // 活动 TE 不在（世界被改动）：只凭扫描 NBT 的 id 判多部件（FMP 写 "savedMultipart"）
                            teIsMultipart = MultipartNbtStateUtil.isMultipartNbt(vs.tileNbt);
                        }
                        // #104 之后只剩副本路径（-Dsde.teCaptureMode=inplace 就地改写路径已随 #104 整体
                        // 删除，负对照调用方 LpTeRoundTripAutomation / PartsExportProbe 亦已删除 ⇒ 无逃生开关）：
                        // 副本创建失败时返回 null，该格显式跳过 TE 渲染，绝不回退查活动 TE
                        // （活动 TE 全程零写入是 issue #12 的修复本体）。
                        teForRender = createCaptureTileEntityCopy(
                            world,
                            vs.tileNbt,
                            teForCapture,
                            wx,
                            wy,
                            wz,
                            teIsMultipart,
                            vs.tileRenderState,
                            vs.tileRenderStateFormat);
                    }
                    // #104：老 try/finally 只剩 inplace 负对照的回滚段，随该分支一并删除；
                    // 这里保留原来的作用域（裸块）以免局部变量外泄。
                    {
                        TessellatorCaptureState
                            .beginBlock(wx, wy, wz, label, wx, wy, wz, b, blockMeta, renderType, vs.registryId);
                        Tessellator tess = Tessellator.instance;
                        tess.startDrawingQuads();
                        BlockPrimaryCaptureRegistry.dispatch(
                            new BlockPrimaryCaptureContext(
                                world,
                                wx,
                                wy,
                                wz,
                                b,
                                blockMeta,
                                rb,
                                partialTicksForMeshCapture()));
                        tess.draw();

                        // 注入副本 TE（无副本时为活动 TE / null = 与现状一致），
                        // 后处理策略经 ctx.getTileEntity() 取到的一律是副本，活动 TE 零写入
                        MeshCaptureBlockPostRenderRegistry.dispatch(
                            new MeshCaptureBlockPostRenderContext(
                                world,
                                wx,
                                wy,
                                wz,
                                b,
                                blockMeta,
                                rb,
                                partialTicksForMeshCapture(),
                                teForRender));
                        int quadsBeforeDraw = TessellatorCaptureState.currentBlockRecordedQuadCount();
                        try {
                            tess.draw();
                        } catch (Throwable ignored) {
                            /* 动态路径常已在内部 drawInstance；此时不再处于绘制中 */
                        }
                        if (quadsBeforeDraw == 0) {
                            GL11.glPushMatrix();
                            try {
                                rb.renderBlockAsItem(b, blockMeta, 1.0F);
                            } catch (Throwable ignored) {
                                /* 少数方块在库存路径下可能抛错 */
                            } finally {
                                GL11.glPopMatrix();
                            }
                        }
                        TessellatorCaptureState.endBlock(inst);
                        if (inst.quads.isEmpty()) {
                            remapped[zi][ri][ci] = 0;
                        } else {
                            attachMaterials(inst, textureMap, samplers, MaterialBlendMode.of(b));
                            JsonObject geo = bakedQuadsGeometryFromCapture(inst);

                            List<String> tt = tooltipByCellType.get(ti);
                            String sig = fullEqualitySignature(vs.registryId, vs.meta, vs.tileNbt, geo, tt);
                            Integer fin = sigToFinal.get(sig);
                            if (fin == null) {
                                fin = Integer.valueOf(nextFinal++);
                                sigToFinal.put(sig, fin);
                                repForFinal.put(fin, vs);
                                geometryForFinal.put(fin, deepCopyJsonObject(geo));
                                opaqueForFinal.put(fin, b.isOpaqueCube());
                                if (tt != null) {
                                    tooltipForFinal.put(fin, tt);
                                }
                            }
                            remapped[zi][ri][ci] = fin.intValue();

                            // P1.7：逐格一次性部件采集（契约 §7.1 三档流水线；该格烘焙四边形快照
                            // 直供档 3 几何推断，零重复渲染）。任何失败跳过该格、绝不中断导出。
                            if (partsSink != null) {
                                try {
                                    PartCaptureResult partsResult = PartCapturePipeline
                                        .collectParts(world, wx, wy, wz, inst.quads);
                                    partsSink.addCell(
                                        zi,
                                        ri,
                                        ci,
                                        partsResult,
                                        tooltipByCellType.get(Integer.valueOf(ti)),
                                        b,
                                        blockMeta);
                                } catch (Throwable t) {
                                    FMLLog.warning(
                                        "[SDE] P1.7 部件采集失败（跳过该格 (%d,%d,%d)，不中断导出）: %s",
                                        Integer.valueOf(wx),
                                        Integer.valueOf(wy),
                                        Integer.valueOf(wz),
                                        String.valueOf(t));
                                }
                            }
                        }
                    }
                }
            }
        }

        // #127：把「按扫描身份烘焙」这件事与其副作用显式留痕（世界漂移不改变语义，但必须可观察）
        if (worldChangedCells > 0) {
            FMLLog.info(
                "[SDE] 烘焙按**扫描身份**完成：%d 格在活动世界里已是空气（世界在录制后被改动）——这些格按录制内容忠实还原，未丢弃",
                Integer.valueOf(worldChangedCells));
        }

        JsonArray blockPalette = new JsonArray();
        blockPalette.add(airBlockPaletteEntry());
        for (int fi = 1; fi < nextFinal; fi++) {
            VoxelSample r = repForFinal.get(fi);
            JsonObject p = new JsonObject();
            p.addProperty("registryId", r.registryId);
            p.addProperty("meta", r.meta);
            if (r.facing != null && !r.facing.isEmpty()) {
                p.addProperty("facing", r.facing);
            }
            if (r.tileNbt != null && !r.tileNbt.hasNoTags()) {
                try {
                    String nbtJson = NbtJsonSerializer.toJson(r.tileNbt);
                    // 必须用实例 API：JsonParser.parseString 是 gson >= 2.8.6 的静态方法，
                    // 而 MC 1.7.10 运行期 gson 是 2.2.4（issue #17 验证回路实测：
                    // 静态调用 NoSuchMethodError ⇒ 整次导出中止）。
                    p.add("nbt", new JsonParser().parse(nbtJson));
                } catch (Throwable ignored) {
                    // NBT serialization failure shouldn't block geometry export。
                    // 捕获 Throwable 而非 Exception：链接错误（NoSuchMethodError、
                    // NoClassDefFoundError 等）属 Error，不许中止整次导出 —— 挂不上 NBT 只应丢这个字段。
                }
            }
            try {
                Block b = Block.getBlockFromName(r.registryId);
                if (b != null && b != Blocks.air) {
                    String thumbB64 = BlockThumbnailRenderer.renderToBase64PNG(b, r.meta);
                    if (thumbB64 != null && !thumbB64.isEmpty()) {
                        p.addProperty("thumbnailPNG", thumbB64);
                    }
                    // 契约 §2.2 层②：宿主级物品身份（Item.getItemFromBlock + damage）落盘到
                    // blockPalette 条目——仅当本结构含部件数据时写（无部件文件字节干净硬约束）
                    if (partsSink != null && partsSink.hasParts()) {
                        JsonObject hostItem = ItemIndexIntegrator.hostItemIdentity(b, r.meta);
                        if (hostItem != null) {
                            p.add(ItemIndexIntegrator.HOST_ITEM_FIELD, hostItem);
                        }
                    }
                }
            } catch (Exception ignored) {
                // Thumbnail failure shouldn't block geometry export
            }
            p.addProperty("renderMode", "BakedModel");
            p.add("geometry", deepCopyJsonObject(geometryForFinal.get(fi)));
            p.addProperty(
                "occludesAdjacentFaces",
                opaqueForFinal.getOrDefault(fi, false)
                    .booleanValue());
            List<String> tooltipLines = tooltipForFinal.get(fi);
            JsonArray ttArr = new JsonArray();
            if (tooltipLines != null) {
                for (String line : tooltipLines) {
                    ttArr.add(new JsonPrimitive(line));
                }
            }
            p.add("tooltip", ttArr);
            blockPalette.add(p);
        }

        structure.add("blockPalette", blockPalette);
        structure.add("cellGrid", cellGridToJson(remapped));
        int[][][] tooltips = new int[sizeZ][sizeRow][sizeCol];
        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    tooltips[zi][ri][ci] = -1;
                }
            }
        }
        structure.add("cellTooltipGrid", cellGridToJson(tooltips));
        // P1.7：有部件 ⇒ 写 cellPartsGrid + partLists（契约 §2）；无部件 ⇒ 两字段完全不产出（字节干净）
        if (partsSink != null) {
            partsSink.writeInto(structure);
        }
        structure.addProperty("geometryPhase", "baked");
        structure.remove("cellTypes");
        structure.remove("worldGrid");
        return partsSink;
    }

    /**
     * 按扫描 NBT 造一份<strong>副本</strong> TE 供后处理渲染使用：世界活动 TE 全程零写入（Gitea issue #12）。
     * <p>
     * 任何失败（含制出的副本类型不符）一律返回 {@code null}，捕获继续，后处理策略对 null 会跳过该格——
     * 绝不回退到活动 TE（那等于把"当前世界状态"烤进导出，且与旧就地路径的失败语义不再一致）。
     * <p>
     * <b>#127：副本的来源是扫描 NBT，不是活动 TE</b>。{@code liveTe} 只提供两件「可选加速信息」——
     * 坐标（缺省用 {@code wx/wy/wz}）与多部件判定（缺省按 NBT 的 id 判）——因此该格在活动世界里
     * 已被清空时（{@code liveTe == null}）仍然能造出副本，「按扫描身份保留」才不至于退化成
     * 「保留了块、丢了 TE 渲染」这种更隐蔽的失真。
     *
     * @param liveTe                活动世界该格的 TE（可为 null；**只读**，绝不写回）
     * @param wx/wy/wz              该格世界坐标（{@code liveTe} 为 null 时的坐标来源）
     * @param teIsMultipart         是否多部件格（活动 TE 在时基于其类判定，不在时基于扫描 NBT 的 id）
     * @param tileRenderState       扫描时刻采下的渲染状态字节（{@code null}/空 = 该格无渲染状态）
     * @param tileRenderStateFormat 渲染状态格式串（读回时据此选提供者）
     */
    private static TileEntity createCaptureTileEntityCopy(World world, NBTTagCompound tileNbt, TileEntity liveTe,
        int wx, int wy, int wz, boolean teIsMultipart, byte[] tileRenderState, String tileRenderStateFormat) {
        try {
            NBTTagCompound toApply = captureNbtWithCoords(tileNbt, liveTe, wx, wy, wz);
            // 1.7.10 静态工厂：按 NBT 的 "id" 建实例并 readFromNBT（扫描 NBT 来自 writeToNBT，含 id）
            TileEntity copyTe = TileEntity.createAndLoadEntity(toApply);
            if (teIsMultipart && !MultipartNbtStateUtil.isTileMultipart(copyTe)) {
                // FMP 把多部件 TE 的 "id" 写成 "savedMultipart"（→ MultipartSaveLoad$TileNBTContainer），
                // createAndLoadEntity 只能造出那个空壳（既非 TileMultipart 也无 part），必须走 FMP 自己的建法
                copyTe = MultipartNbtStateUtil.createMultipartCopyFromNbt(toApply);
            }
            if (copyTe == null || (teIsMultipart && !MultipartNbtStateUtil.isTileMultipart(copyTe))) {
                return null;
            }
            // createAndLoadEntity / createFromNBT 都不设置 worldObj
            copyTe.setWorldObj(world);
            if (teIsMultipart) {
                MultipartNbtStateUtil.loadPartStatesFromNbt(copyTe, toApply);
            }
            // Gitea #410 方向 A：渲染状态回填。作用对象**只能是副本**（活动 TE 全程零写入，issue #12）；
            // 回填入口是模组自己的 readData（语义 = 客户端收到同步包后的摄取），不做任何推算。
            if (tileRenderState != null && tileRenderState.length > 0) {
                if (!TileRenderStateProviders.apply(tileRenderStateFormat, copyTe, tileRenderState)) {
                    FMLLog.warning(
                        "[SDE] 渲染状态回填未生效（该格 %d,%d,%d 按无渲染状态渲染；活动 TE 未受影响）",
                        Integer.valueOf(wx),
                        Integer.valueOf(wy),
                        Integer.valueOf(wz));
                }
            }
            return copyTe;
        } catch (Throwable t) {
            FMLLog.warning("[SDE] 捕获副本 TE 创建失败（该格跳过 TE 渲染；活动 TE 不受影响）: %s", String.valueOf(t));
            return null;
        }
    }

    /**
     * 扫描 NBT 的副本 + 该格 x/y/z 三键（与旧就地逻辑补键行为一致，不动原 NBT）。
     *
     * <p>
     * 坐标优先取活动 TE（旧行为逐字不变），活动 TE 不在时取扫描格的世界坐标（#127：世界被改动后
     * 该格仍要按扫描身份渲染，坐标不能凭空消失）。
     */
    private static NBTTagCompound captureNbtWithCoords(NBTTagCompound tileNbt, TileEntity liveTe, int wx, int wy,
        int wz) {
        NBTTagCompound toApply = (NBTTagCompound) tileNbt.copy();
        toApply.setInteger("x", liveTe != null ? liveTe.xCoord : wx);
        toApply.setInteger("y", liveTe != null ? liveTe.yCoord : wy);
        toApply.setInteger("z", liveTe != null ? liveTe.zCoord : wz);
        return toApply;
    }

    private static JsonObject emptyGeometryJson() {
        JsonObject geometry = new JsonObject();
        geometry.addProperty("encoding", "bakedQuadsJsonV1");
        geometry.add("quads", new JsonArray());
        return geometry;
    }

    /**
     * T1.3 公共捕获工具：把「条目内容签名」与「烘焙几何条目构造」两件设施以<strong>纯新增</strong>的方式提升为公共
     * 工具，供 {@code com.lightning.mod.client.multiblock} 的变体捕获复用，避免「按同口径重写一份」造成两套签名长期漂移
     * （T0.3 移交建议 #2）。#104 之前 {@code StateGeometryCapture} 正是那个「重写一份」（第二套捕获实现，
     * 违反 E4①），它已按 V12 裁决整体删除；唯一捕获口径就是本类。
     * <p>
     * <b>零行为改动</b>：本嵌套类只做转发，不修改任何既有方法的可见性或实现；既有 {@code finalizeStructureJson} /
     * {@code liftBlockPaletteToRoot} 路径逐字节不变。
     * <p>
     * 复用的是三件东西：
     * <ol>
     * <li>{@code geometrySignature} / {@code entryEqualitySignature} / {@code fullEqualitySignature} —— 与既有
     * 「调色板全局去重」完全同一套内容签名（{@code L672–776}）；</li>
     * <li>{@code bakedQuadsGeometryFromCapture} / {@code airBlockPaletteEntry} —— 与既有产物完全同形的
     * {@code bakedQuadsJsonV1} 调色板条目；</li>
     * <li>{@link MaterialTable} —— 全局材质表（跨变体共享，保证 {@code materialIndex} 在整个数据集内稳定，
     * 即契约 §6.1「几何编码全文件统一」）。</li>
     * </ol>
     */
    public static final class CaptureToolkit {

        private CaptureToolkit() {}

        /** 空几何（{@code bakedQuadsJsonV1} + 空 quads）：与既有 air 条目同形。 */
        public static JsonObject airEntry() {
            return airBlockPaletteEntry();
        }

        /** 由一次「逐格捕获」的实例产出 {@code bakedQuadsJsonV1} 几何；调用前需先 {@link #attachQuadMaterials}。 */
        public static JsonObject geometryOf(CapturedBlockInstance inst) {
            return bakedQuadsGeometryFromCapture(inst);
        }

        /**
         * 给已经捕获好的四边形挂上材质下标（写入 {@link CapturedQuad#samplerIndex}）。
         * {@code table} 必须在整个数据集内共享，否则 {@code materialIndex} 会跨变体漂移。
         */
        public static void attachQuadMaterials(CapturedBlockInstance inst, TextureMap textureMap, MaterialTable table,
            String blend) {
            attachMaterials(inst, textureMap, table.inner, blend);
        }

        /** 几何内容签名（4 位小数 / 四边形内顶点排序 / 四边形间排序 / SHA-256）。 */
        public static String signatureOfGeometry(JsonObject geometry) {
            return geometrySignature(geometry);
        }

        /** 调色板条目内容签名（registryId + meta + 几何签名 + nbt + tooltip）。 */
        public static String signatureOfEntry(JsonObject entry) {
            return entryEqualitySignature(entry);
        }

        /**
         * 与 {@code finalizeSingleStructure} 内「同一方块状态只存一份」用的判据同口径的签名；{@code tileNbt} /
         * {@code tooltip} 传 {@code null} 即表示不参与签名（T1.3 的捕获数据集正是这样去重的，见报告）。
         */
        public static String signatureOfState(String registryId, int meta, NBTTagCompound tileNbt, JsonObject geometry,
            List<String> tooltip) {
            return fullEqualitySignature(registryId, meta, tileNbt, geometry, tooltip);
        }

        /** 深拷贝（避免把已入库的条目对象交给下游继续改写）。 */
        public static JsonObject copy(JsonObject src) {
            return deepCopyJsonObject(src);
        }

        /** 全数据集共享的材质表；{@link SamplerTable} 的公共门面。 */
        public static final class MaterialTable {

            private final SamplerTable inner = new SamplerTable();

            public int indexFor(String materialKey, TextureMap blocksTextureMap, boolean standaloneFileTexture,
                String paletteAtlasKind, String blend) {
                return inner
                    .indexForMaterial(materialKey, blocksTextureMap, standaloneFileTexture, paletteAtlasKind, blend);
            }

            public JsonArray toMaterialPalette() {
                return inner.toMaterialPalette();
            }

            public int size() {
                return inner.list.size();
            }
        }
    }

    private static JsonObject airBlockPaletteEntry() {
        JsonObject p = new JsonObject();
        p.addProperty("registryId", "air");
        p.addProperty("meta", 0);
        p.addProperty("renderMode", "BakedModel");
        p.add("geometry", emptyGeometryJson());
        p.addProperty("occludesAdjacentFaces", false);
        p.add("nbt", JsonNull.INSTANCE);
        p.add("tooltip", new JsonArray());
        return p;
    }

    private static String sha256Base64(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder()
                .encodeToString(digest);
        } catch (Exception e) {
            return "sha256-error";
        }
    }

    private static String geometrySignature(JsonObject geometry) {
        try {
            JsonArray quads = geometry.getAsJsonArray("quads");
            List<String> quadLines = new ArrayList<>();
            for (JsonElement qe : quads) {
                JsonObject q = qe.getAsJsonObject();
                int mat = q.get("materialIndex")
                    .getAsInt();
                JsonArray verts = q.getAsJsonArray("vertices");
                List<String> vparts = new ArrayList<>();
                for (JsonElement ve : verts) {
                    JsonObject v = ve.getAsJsonObject();
                    int br = v.has("brightness") ? v.get("brightness")
                        .getAsInt() : 0;
                    int col = v.has("color") ? v.get("color")
                        .getAsInt() : 0;
                    vparts.add(
                        String.format(
                            Locale.ROOT,
                            "%.4f,%.4f,%.4f,%.4f,%.4f,%d,%d",
                            quant4(v.get("x")),
                            quant4(v.get("y")),
                            quant4(v.get("z")),
                            quant4(v.get("u")),
                            quant4(v.get("v")),
                            br,
                            col));
                }
                Collections.sort(vparts);
                StringBuilder sb = new StringBuilder();
                sb.append(mat)
                    .append('|');
                for (String s : vparts) {
                    sb.append(s)
                        .append(';');
                }
                quadLines.add(sb.toString());
            }
            Collections.sort(quadLines);
            return sha256Base64(String.join("\n", quadLines));
        } catch (Exception e) {
            return "sig-error:" + String.valueOf(geometry);
        }
    }

    private static String fullEqualitySignature(String registryId, int meta, NBTTagCompound tileNbt,
        JsonObject geometry, List<String> tooltip) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(registryId)
                .append('\0');
            sb.append(meta)
                .append('\0');
            sb.append(geometrySignature(geometry))
                .append('\0');
            if (tileNbt != null && !tileNbt.hasNoTags()) {
                sb.append(NbtJsonSerializer.toJson(tileNbt))
                    .append('\0');
            }
            if (tooltip != null && !tooltip.isEmpty()) {
                for (String line : tooltip) {
                    sb.append(line)
                        .append('\n');
                }
            }
            return sha256Base64(sb.toString());
        } catch (Exception e) {
            return "sig-error:" + registryId + ":" + meta;
        }
    }

    private static String entryEqualitySignature(JsonObject entry) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(
                entry.get("registryId")
                    .getAsString())
                .append('\0');
            sb.append(
                entry.get("meta")
                    .getAsInt())
                .append('\0');
            JsonObject geom = entry.getAsJsonObject("geometry");
            sb.append(geometrySignature(geom))
                .append('\0');
            if (entry.has("nbt") && !entry.get("nbt")
                .isJsonNull() && !isEmptyJsonObject(entry.get("nbt"))) {
                sb.append(
                    entry.get("nbt")
                        .toString())
                    .append('\0');
            }
            if (entry.has("tooltip") && entry.get("tooltip")
                .isJsonArray()) {
                JsonArray tt = entry.getAsJsonArray("tooltip");
                for (JsonElement e : tt) {
                    sb.append(e.getAsString())
                        .append('\n');
                }
            }
            return sha256Base64(sb.toString());
        } catch (Exception e) {
            return "sig-error:" + entry.toString();
        }
    }

    private static boolean isEmptyJsonObject(JsonElement e) {
        return e.isJsonObject() && e.getAsJsonObject()
            .entrySet()
            .isEmpty();
    }

    private static double quant4(JsonElement e) {
        double x = e.getAsDouble();
        return Math.round(x * 10000.0) / 10000.0;
    }

    private static JsonObject deepCopyJsonObject(JsonObject src) {
        return new JsonParser().parse(src.toString())
            .getAsJsonObject();
    }

    private static JsonObject bakedQuadsGeometryFromCapture(CapturedBlockInstance inst) {
        JsonObject geometry = new JsonObject();
        geometry.addProperty("encoding", "bakedQuadsJsonV1");
        JsonArray quads = new JsonArray();
        for (CapturedQuad q : inst.quads) {
            JsonObject qo = new JsonObject();
            qo.addProperty("materialIndex", q.samplerIndex);
            JsonArray verts = new JsonArray();
            for (CapturedVertex v : q.vertices) {
                JsonObject vo = new JsonObject();
                vo.addProperty("x", v.x);
                vo.addProperty("y", v.y);
                vo.addProperty("z", v.z);
                vo.addProperty("u", v.u);
                vo.addProperty("v", v.v);
                vo.addProperty("brightness", v.brightness);
                vo.addProperty("color", v.colorArgb);
                verts.add(vo);
            }
            qo.add("vertices", verts);
            quads.add(qo);
        }
        geometry.add("quads", quads);
        return geometry;
    }

    private static VoxelSample[] parseCellTypes(JsonArray arr) throws Exception {
        VoxelSample[] out = new VoxelSample[arr.size()];
        for (int i = 0; i < arr.size(); i++) {
            JsonObject t = arr.get(i)
                .getAsJsonObject();
            String id = t.get("registryId")
                .getAsString();
            int meta = t.get("meta")
                .getAsInt();
            String facing = t.has("facing") ? t.get("facing")
                .getAsString() : null;
            NBTTagCompound tileNbt = null;
            if (t.has("tileNbtB64")) {
                String b64 = t.get("tileNbtB64")
                    .getAsString();
                byte[] raw = Base64.getDecoder()
                    .decode(b64);
                tileNbt = CompressedStreamTools.readCompressed(new ByteArrayInputStream(raw));
            }
            // Gitea #410 方向 A：渲染状态字节随扫描快照而来（承载族才有这两个字段）
            byte[] tileRenderState = null;
            String tileRenderStateFormat = null;
            if (t.has("tileRenderStateB64")) {
                tileRenderState = Base64.getDecoder()
                    .decode(
                        t.get("tileRenderStateB64")
                            .getAsString());
                if (t.has("tileRenderStateFormat")) {
                    tileRenderStateFormat = t.get("tileRenderStateFormat")
                        .getAsString();
                }
            }
            out[i] = new VoxelSample(id, meta, facing, null, tileNbt, tileRenderState, tileRenderStateFormat);
        }
        return out;
    }

    private static int[][][][] parseWorldGrid(JsonArray worldGridJson, int[][][] cellGrid) {
        int sizeZ = cellGrid.length;
        int sizeRow = cellGrid[0].length;
        int sizeCol = cellGrid[0][0].length;
        if (worldGridJson.size() != sizeZ) {
            throw new IllegalStateException("worldGrid z depth != cellGrid.");
        }
        int[][][][] w = new int[sizeZ][sizeRow][sizeCol][3];
        for (int zi = 0; zi < sizeZ; zi++) {
            JsonArray rows = worldGridJson.get(zi)
                .getAsJsonArray();
            if (rows.size() != sizeRow) {
                throw new IllegalStateException("worldGrid row count mismatch.");
            }
            for (int ri = 0; ri < sizeRow; ri++) {
                JsonArray cols = rows.get(ri)
                    .getAsJsonArray();
                if (cols.size() != sizeCol) {
                    throw new IllegalStateException("worldGrid col count mismatch.");
                }
                for (int ci = 0; ci < sizeCol; ci++) {
                    int ct = cellGrid[zi][ri][ci];
                    JsonElement el = cols.get(ci);
                    if (ct == 0) {
                        if (!el.isJsonNull()) {
                            throw new IllegalStateException("worldGrid must be null for air cells.");
                        }
                        w[zi][ri][ci][0] = 0;
                        w[zi][ri][ci][1] = 0;
                        w[zi][ri][ci][2] = 0;
                    } else {
                        if (!el.isJsonObject()) {
                            throw new IllegalStateException("worldGrid missing coordinates for non-air cell.");
                        }
                        JsonObject o = el.getAsJsonObject();
                        w[zi][ri][ci][0] = o.get("x")
                            .getAsInt();
                        w[zi][ri][ci][1] = o.get("y")
                            .getAsInt();
                        w[zi][ri][ci][2] = o.get("z")
                            .getAsInt();
                    }
                }
            }
        }
        return w;
    }

    private static void validateWorldGridChunks(World world, int[][][] cellGrid, int[][][][] worldCoords) {
        if (world.getChunkProvider() == null) {
            throw new IllegalStateException("Mesh capture: world has no chunk provider.");
        }
        int sizeZ = cellGrid.length;
        int sizeRow = cellGrid[0].length;
        int sizeCol = cellGrid[0][0].length;
        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    if (cellGrid[zi][ri][ci] == 0) {
                        continue;
                    }
                    int wx = worldCoords[zi][ri][ci][0];
                    int wz = worldCoords[zi][ri][ci][2];
                    if (!world.getChunkProvider()
                        .chunkExists(wx >> 4, wz >> 4)) {
                        throw new IllegalStateException(
                            "Mesh capture: chunk not loaded for world block " + wx
                                + ","
                                + worldCoords[zi][ri][ci][1]
                                + ","
                                + wz
                                + ". Load the area on the client before capture.");
                    }
                }
            }
        }
    }

    private static String captureLabel(VoxelSample vs, Block b, World world, int wx, int wy, int wz) {
        if (!"air".equals(vs.registryId)) {
            return vs.key();
        }
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(b);
        String id = uid == null ? b.getUnlocalizedName() : uid.toString();
        return id + '\0' + "meta:" + world.getBlockMetadata(wx, wy, wz);
    }

    /**
     * 活动世界方块的注册名（#127 的身份比对用）。
     *
     * <p>
     * 规则与采样器 {@code PolicyBackedBlockSampler}/{@code DefaultBlockSampler} <b>逐字一致</b>
     * （{@code GameRegistry.findUniqueIdentifierFor} 优先，缺失回落 {@code "unknown:" + unlocalizedName}）——
     * 两侧不同源就没法比，这会变成一个「永远不相等」的假报错源。
     */
    private static String registryIdOf(Block b) {
        if (b == null) {
            return null;
        }
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(b);
        return uid == null ? ("unknown:" + b.getUnlocalizedName()) : uid.toString();
    }

    /** 错误上下文里的格坐标（{@code [x,y,z]}，与结果里其它坐标字段同形）。 */
    private static JsonArray cellJson(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(Integer.valueOf(x)));
        a.add(new JsonPrimitive(Integer.valueOf(y)));
        a.add(new JsonPrimitive(Integer.valueOf(z)));
        return a;
    }

    private static int[][][] parseCellGrid(JsonArray cellGridJson) {
        int sizeZ = cellGridJson.size();
        JsonArray row0 = cellGridJson.get(0)
            .getAsJsonArray();
        int sizeRow = row0.size();
        int sizeCol = row0.get(0)
            .getAsJsonArray()
            .size();
        int[][][] grid = new int[sizeZ][sizeRow][sizeCol];
        for (int zi = 0; zi < sizeZ; zi++) {
            JsonArray rows = cellGridJson.get(zi)
                .getAsJsonArray();
            for (int ri = 0; ri < sizeRow; ri++) {
                JsonArray cols = rows.get(ri)
                    .getAsJsonArray();
                for (int ci = 0; ci < sizeCol; ci++) {
                    grid[zi][ri][ci] = cols.get(ci)
                        .getAsInt();
                }
            }
        }
        return grid;
    }

    private static JsonArray cellGridToJson(int[][][] grid) {
        JsonArray cellGridJson = new JsonArray();
        for (int zi = 0; zi < grid.length; zi++) {
            JsonArray rows = new JsonArray();
            for (int ri = 0; ri < grid[zi].length; ri++) {
                JsonArray cols = new JsonArray();
                for (int ci = 0; ci < grid[zi][ri].length; ci++) {
                    cols.add(new JsonPrimitive(grid[zi][ri][ci]));
                }
                rows.add(cols);
            }
            cellGridJson.add(rows);
        }
        return cellGridJson;
    }

    /**
     * 给一次逐格捕获的四边形挂材质下标。
     *
     * @param blend 该格方块的混合模式（{@link com.lightning.mod.client.export.MaterialBlendMode#of}）；
     *              {@code null} = 这条路径不声明（材质条目不带 `blend`，与改动前逐字一致）
     */
    private static void attachMaterials(CapturedBlockInstance inst, TextureMap textureMap, SamplerTable samplers,
        String blend) {
        for (CapturedQuad q : inst.quads) {
            String materialKey = MaterialKeyResolver.applySpriteLocalToQuad(q, textureMap);
            String atlasKind = q.materialUsesStandaloneTexture ? null : q.materialAtlasKind;
            q.samplerIndex = samplers
                .indexForMaterial(materialKey, textureMap, q.materialUsesStandaloneTexture, atlasKind, blend);
        }
    }

    static final class SamplerTable {

        private final List<JsonObject> list = new ArrayList<>();
        private final Map<String, Integer> indexByKey = new LinkedHashMap<>();

        /**
         * 取（或新建）材质槽位。
         *
         * `blend` 进**缓存键**：同一张贴图可能在两种混合语义下出现（例如玻璃与玻璃板走不同
         * pass），那时必须是两条材质、不能共用一个槽位 —— 否则其中一方的 `blend` 会被另一方的
         * 覆盖，且**没有任何报错**。
         */
        int indexForMaterial(String materialKey, TextureMap blocksTextureMap, boolean standaloneFileTexture,
            String paletteAtlasKind, String blend) {
            String atlasBand = standaloneFileTexture ? "file" : ("items".equals(paletteAtlasKind) ? "items" : "blocks");
            String baseKey = standaloneFileTexture ? materialKey + "\0__sde_file_tex" : materialKey + "\0" + atlasBand;
            String cacheKey = blend == null ? baseKey : baseKey + "\0blend:" + blend;
            Integer idx = indexByKey.get(cacheKey);
            if (idx != null) {
                return idx;
            }
            JsonObject s = new JsonObject();
            s.addProperty("texture", materialKey);
            if (standaloneFileTexture) {
                s.add("atlas", JsonNull.INSTANCE);
            } else {
                s.addProperty("atlas", atlasBand);
            }
            s.addProperty("linear", true);
            s.addProperty("useMipmaps", true);
            TextureMap kindMap = "items".equals(paletteAtlasKind)
                ? MaterialKeyResolver.getTextureMapItems(Minecraft.getMinecraft())
                : blocksTextureMap;
            if (kindMap == null || !(kindMap instanceof TextureMapAccessor)) {
                kindMap = blocksTextureMap;
            }
            String kind = inferMaterialKindForSprite(materialKey, kindMap);
            s.addProperty("kind", kind);
            if (blend != null) {
                s.addProperty("blend", blend);
            }
            if ("animated".equals(kind)) {
                TextureAtlasSprite sprAnim = MaterialKeyResolver.findSpriteForMaterialKey(materialKey, kindMap);
                String norm = ExportTextureLocator.normalizeLocatorForBundle(materialKey);
                JsonObject anim = MaterialAnimationJson.tryResolveForMaterial(Minecraft.getMinecraft(), norm, sprAnim);
                if (anim != null) {
                    s.add("animation", anim);
                }
            }
            int i = list.size();
            list.add(s);
            indexByKey.put(cacheKey, i);
            return i;
        }

        JsonArray toMaterialPalette() {
            JsonArray a = new JsonArray();
            for (JsonObject s : list) {
                JsonObject m = new JsonObject();
                m.addProperty(
                    "locator",
                    s.get("texture")
                        .getAsString());
                m.addProperty(
                    "kind",
                    s.get("kind")
                        .getAsString());
                if (s.has("blend")) {
                    m.add("blend", s.get("blend"));
                }
                if (s.has("atlas")) {
                    m.add("atlas", s.get("atlas"));
                }
                if (s.has("linear")) {
                    m.add("linear", s.get("linear"));
                }
                if (s.has("useMipmaps")) {
                    m.add("useMipmaps", s.get("useMipmaps"));
                }
                if (s.has("animation")) {
                    m.add("animation", s.get("animation"));
                }
                a.add(m);
            }
            return a;
        }
    }

    private static String inferMaterialKindForSprite(String materialKey, TextureMap textureMap) {
        TextureAtlasSprite spr = MaterialKeyResolver.findSpriteForMaterialKey(materialKey, textureMap);
        if (spr == null) {
            return "static16";
        }
        if (spr.getFrameCount() > 1) {
            return "animated";
        }
        int iw = spr.getIconWidth();
        int ih = spr.getIconHeight();
        if (iw > 0 && ih >= iw * 2 && ih % iw == 0) {
            return "animated";
        }
        return "static16";
    }

    /** {@link Minecraft#timer} 在 MCP 中为 private，供 multipart 动态插值与游戏一致。 */
    private static float partialTicksForMeshCapture() {
        try {
            Minecraft mc = Minecraft.getMinecraft();
            Timer timer = ReflectionHelper.getPrivateValue(Minecraft.class, mc, "timer", "field_71428_T");
            if (timer != null) {
                return timer.renderPartialTicks;
            }
        } catch (Throwable ignored) {
            /* ignore */
        }
        return 0.0F;
    }
}
