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
import com.lightning.mod.client.export.BlockThumbnailRenderer;
import com.lightning.mod.client.export.ExportTextureLocator;
import com.lightning.mod.client.export.MaterialAnimationJson;
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
     * TE 捕获模式。默认（以及除 {@code inplace} 外的任何值）=「副本 TE」：按扫描 NBT 造一份副本 TE 注入后处理
     * 渲染，<strong>世界活动 TE 全程零写入</strong>。
     * <p>
     * {@code -Dsde.teCaptureMode=inplace} 恢复 issue #12 之前的旧行为（备份活动 TE → 就地
     * {@code readFromNBT(扫描 NBT)} → finally 回滚），<strong>仅供 issue #12 复现/证伪的负对照使用，严禁默认
     * 启用</strong>：LogisticsPipes 的 {@code LogisticsTileGenericPipe.readFromNBT} 非幂等（每次读 NBT 都重建
     * pipe，而 {@code bindPipe()} 有 {@code if (pipeBound) return;} 一次性绑定守卫），第二次及以后读 NBT 建出的
     * pipe 永远绑不上容器（{@code pipe.container} 永久为 null）→ 导出结束后正常渲染 NPE 崩溃客户端；读备份回滚
     * 同样修不回来（再读一次 NBT 只会再建一个绑不上的 pipe）。
     */
    private static final boolean TE_CAPTURE_INPLACE = "inplace".equals(
        System.getProperty("sde.teCaptureMode", "copy")
            .trim()
            .toLowerCase(Locale.ROOT));

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

        for (int zi = 0; zi < sizeZ; zi++) {
            for (int ri = 0; ri < sizeRow; ri++) {
                for (int ci = 0; ci < sizeCol; ci++) {
                    int ti = cellGrid[zi][ri][ci];
                    if (ti == 0) {
                        remapped[zi][ri][ci] = 0;
                        continue;
                    }
                    VoxelSample vs = cellTypes[ti];
                    int wx = worldCoords[zi][ri][ci][0];
                    int wy = worldCoords[zi][ri][ci][1];
                    int wz = worldCoords[zi][ri][ci][2];

                    Block b = world.getBlock(wx, wy, wz);
                    if (b == null || b == Blocks.air) {
                        remapped[zi][ri][ci] = 0;
                        continue;
                    }
                    String label = captureLabel(vs, b, world, wx, wy, wz);
                    CapturedBlockInstance inst = new CapturedBlockInstance();
                    int blockMeta = vs != null ? vs.meta : world.getBlockMetadata(wx, wy, wz);
                    int renderType = b.getRenderType();

                    // Gitea issue #12：**不得**对世界活动 TE 做 readFromNBT。LogisticsPipes 等模组的
                    // readFromNBT 非幂等：LogisticsTileGenericPipe.readFromNBT 每次都重建 pipe 对象，而
                    // bindPipe() 有 `if (pipeBound) return;` 一次性绑定守卫（pipeBound 只在构造期为 false），
                    // 于是第二次及以后读 NBT 建出的 pipe 永远绑不上容器（container 永久为 null）→ 导出结束后
                    // 正常渲染 NPE 崩溃客户端；"读备份回滚"也修不回来（再读一次只会再建一个绑不上的 pipe）。
                    // 默认路径：活动 TE 全程零写入，改为按扫描 NBT 造一份「副本 TE」注入后处理渲染。
                    TileEntity teForCapture = world.getTileEntity(wx, wy, wz);
                    boolean teIsMultipart = false;
                    TileEntity teForRender = teForCapture;
                    NBTTagCompound legacyInplaceBackup = null;
                    if (teForCapture != null && vs != null && vs.tileNbt != null) {
                        // 以下两步均为只读：判定/诊断只读活动 TE 的类，不写任何字段
                        teIsMultipart = MultipartNbtStateUtil.isTileMultipart(teForCapture);
                        MultipartNbtStateUtil.diagnoseReadFromNbtOverride(teForCapture);
                        if (TE_CAPTURE_INPLACE) {
                            // 负对照（-Dsde.teCaptureMode=inplace；issue #12 复现/证伪专用，严禁默认启用）：
                            // 旧行为 = 备份活动 TE → 就地 readFromNBT(扫描 NBT) → finally 回滚
                            legacyInplaceBackup = new NBTTagCompound();
                            teForCapture.writeToNBT(legacyInplaceBackup);
                            applyTileNbtInPlace(teForCapture, vs.tileNbt, teIsMultipart);
                        } else {
                            // 副本创建失败时返回 null：该格显式跳过 TE 渲染，绝不回退查活动 TE
                            teForRender = createCaptureTileEntityCopy(world, vs.tileNbt, teForCapture, teIsMultipart);
                        }
                    }
                    try {
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
                            attachMaterials(inst, textureMap, samplers);
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
                    } finally {
                        if (legacyInplaceBackup != null) {
                            // 只有 inplace 负对照路径需要回滚；默认副本路径对活动 TE 零写入，故无回滚段
                            restoreTileEntityInPlace(teForCapture, legacyInplaceBackup, teIsMultipart);
                        }
                    }
                }
            }
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
     *
     * @param teIsMultipart 是否多部件格（判定基于活动 TE 的类，只读）
     */
    private static TileEntity createCaptureTileEntityCopy(World world, NBTTagCompound tileNbt, TileEntity liveTe,
        boolean teIsMultipart) {
        try {
            NBTTagCompound toApply = captureNbtWithCoords(tileNbt, liveTe);
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
            return copyTe;
        } catch (Throwable t) {
            FMLLog.warning("[SDE] 捕获副本 TE 创建失败（该格跳过 TE 渲染；活动 TE 不受影响）: %s", String.valueOf(t));
            return null;
        }
    }

    /** 扫描 NBT 的副本 + 该格 x/y/z 三键（与旧就地逻辑补键行为一致，不动原 NBT）。 */
    private static NBTTagCompound captureNbtWithCoords(NBTTagCompound tileNbt, TileEntity liveTe) {
        NBTTagCompound toApply = (NBTTagCompound) tileNbt.copy();
        toApply.setInteger("x", liveTe.xCoord);
        toApply.setInteger("y", liveTe.yCoord);
        toApply.setInteger("z", liveTe.zCoord);
        return toApply;
    }

    /**
     * 旧行为（{@code -Dsde.teCaptureMode=inplace} 负对照专用，严禁默认启用）：对<strong>活动 TE</strong>就地
     * {@code readFromNBT(扫描 NBT)}。LP 等模组的 readFromNBT 非幂等，就地改写会永久改坏世界里的 TE
     * （Gitea issue #12），此处刻意保留原样以便复现/证伪该缺陷。
     */
    private static void applyTileNbtInPlace(TileEntity te, NBTTagCompound tileNbt, boolean teIsMultipart) {
        NBTTagCompound toApply = captureNbtWithCoords(tileNbt, te);
        try {
            te.readFromNBT(toApply);
        } catch (Throwable ignored) {
            /* 个别模组 NBT 不兼容时仍走原 TE */
        }
        if (teIsMultipart) {
            MultipartNbtStateUtil.loadPartStatesFromNbt(te, toApply);
        }
    }

    /** 旧行为（inplace 负对照专用）的回滚：把备份 NBT 读回活动 TE（对非幂等 readFromNBT 同样修不回来）。 */
    private static void restoreTileEntityInPlace(TileEntity te, NBTTagCompound backup, boolean teIsMultipart) {
        try {
            te.readFromNBT(backup);
        } catch (Throwable ignored) {
            /* 尽力恢复 */
        }
        if (teIsMultipart) {
            MultipartNbtStateUtil.loadPartStatesFromNbt(te, backup);
        }
    }

    private static JsonObject emptyGeometryJson() {
        JsonObject geometry = new JsonObject();
        geometry.addProperty("encoding", "bakedQuadsJsonV1");
        geometry.add("quads", new JsonArray());
        return geometry;
    }

    /**
     * T1.3 公共捕获工具：把「条目内容签名」与「烘焙几何条目构造」两件设施以<strong>纯新增</strong>的方式提升为公共
     * 工具，供 {@code com.lightning.mod.client.multiblock} 的变体捕获复用，避免 {@code StateGeometryCapture} 那种
     * 「按同口径重写一份」造成两套签名长期漂移（T0.3 移交建议 #2）。
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
        public static void attachQuadMaterials(CapturedBlockInstance inst, TextureMap textureMap, MaterialTable table) {
            attachMaterials(inst, textureMap, table.inner);
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
                String paletteAtlasKind) {
                return inner.indexForMaterial(materialKey, blocksTextureMap, standaloneFileTexture, paletteAtlasKind);
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
            out[i] = new VoxelSample(id, meta, facing, null, tileNbt);
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

    private static void attachMaterials(CapturedBlockInstance inst, TextureMap textureMap, SamplerTable samplers) {
        for (CapturedQuad q : inst.quads) {
            String materialKey = MaterialKeyResolver.applySpriteLocalToQuad(q, textureMap);
            String atlasKind = q.materialUsesStandaloneTexture ? null : q.materialAtlasKind;
            q.samplerIndex = samplers
                .indexForMaterial(materialKey, textureMap, q.materialUsesStandaloneTexture, atlasKind);
        }
    }

    static final class SamplerTable {

        private final List<JsonObject> list = new ArrayList<>();
        private final Map<String, Integer> indexByKey = new LinkedHashMap<>();

        int indexForMaterial(String materialKey, TextureMap blocksTextureMap, boolean standaloneFileTexture,
            String paletteAtlasKind) {
            String atlasBand = standaloneFileTexture ? "file" : ("items".equals(paletteAtlasKind) ? "items" : "blocks");
            String cacheKey = standaloneFileTexture ? materialKey + "\0__sde_file_tex" : materialKey + "\0" + atlasBand;
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
