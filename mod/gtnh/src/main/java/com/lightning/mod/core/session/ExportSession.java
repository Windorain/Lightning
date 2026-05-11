package com.lightning.mod.core.session;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

import net.minecraft.entity.player.EntityPlayerMP;

import com.lightning.mod.core.export.PackVersionProbe;
import com.lightning.mod.core.export.PendingDumpFiles;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;
import com.lightning.mod.core.sampling.IBlockSampler;
import com.lightning.mod.core.sampling.PolicyBackedBlockSampler;
import com.lightning.mod.core.scan.StructureScan;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * 会话状态、选区、多帧缓冲与落盘（单向：世界 → 内存 JSON 串 → export 写文件）。
 * 默认 {@link IBlockSampler} 为 {@link PolicyBackedBlockSampler}；扫描产物 {@code cellTypes[].meta} 对
 * {@code gregtech:gt.blockmachines} 为 mID，见 {@link GregTechMetaTileRegistry}。
 * <p>
 * 写出文件时：<strong>单帧</strong>为 {@link StructureScan} 的中间态（{@code geometryPhase=scan}，须再经客户端
 * finalize）；<strong>多帧</strong>为 Wiki
 * {@code World} 文档（不写顶层 {@code schemaVersion}）。
 */
public final class ExportSession {

    private static final ExportSession INSTANCE = new ExportSession();
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting()
        .create();

    public static ExportSession get() {
        return INSTANCE;
    }

    private boolean inSession;
    private Integer pos1x;
    private Integer pos1y;
    private Integer pos1z;
    private Integer pos2x;
    private Integer pos2y;
    private Integer pos2z;
    private String outputName = "export";
    private String structureId = "structuredata.exported";
    private int activeFrame;
    private final Map<Integer, String> frameJson = new TreeMap<>();
    /**
     * 活动帧 / 各帧内体素备注：键为 {@link SdeCellCoords#cellKey(int, int, int)}，供 Wiki {@code sdeCellNotes} → 烘焙后
     * {@code tooltipPalette}/{@code cellTooltipGrid}。
     */
    private final Map<Integer, Map<String, String>> cellNotesByFrame = new HashMap<>();
    private IBlockSampler sampler = new PolicyBackedBlockSampler();
    private String lastAuthor = "server";
    private String lastGtnhVersion = "";
    private SdeSelectionMode selectionMode = SdeSelectionMode.CUBOID;

    private ExportSession() {}

    public void startSession() {
        inSession = true;
    }

    public void endSession() {
        inSession = false;
    }

    public boolean isInSession() {
        return inSession;
    }

    public SdeSelectionMode getSelectionMode() {
        return selectionMode;
    }

    public void setSelectionMode(SdeSelectionMode mode) {
        this.selectionMode = mode != null ? mode : SdeSelectionMode.CUBOID;
    }

    /**
     * 选区角点一；可由 {@code /sde pos1}（脚下方块，对齐 WorldEdit {@code //pos1}）、{@code /sde hpos1} 或选区工具左键等设置。
     * <p>
     * {@link SdeSelectionMode#EXTEND}：与 WorldEdit 扩展长方体类似，在已有 AABB 上并入驻入点；首次无选区时记为 1×1×1 角点。
     */
    public void setPos1Block(int x, int y, int z) {
        if (selectionMode == SdeSelectionMode.EXTEND) {
            applyExtendPoint(x, y, z);
        } else {
            pos1x = x;
            pos1y = y;
            pos1z = z;
        }
    }

    /**
     * 选区角点二；可由 {@code /sde pos2}、{@code /sde hpos2} 或选区工具右键等设置。
     * <p>
     * {@link SdeSelectionMode#EXTEND} 下语义与 pos1 相同，均为向当前选区并入该方块坐标。
     */
    public void setPos2Block(int x, int y, int z) {
        if (selectionMode == SdeSelectionMode.EXTEND) {
            applyExtendPoint(x, y, z);
        } else {
            pos2x = x;
            pos2y = y;
            pos2z = z;
        }
    }

    /**
     * WorldEdit 式 extend：新点并入选区长方体，结果存为 min→pos1、max→pos2。
     */
    private void applyExtendPoint(int x, int y, int z) {
        if (pos1x == null) {
            pos1x = x;
            pos1y = y;
            pos1z = z;
            pos2x = x;
            pos2y = y;
            pos2z = z;
            return;
        }
        if (pos2x == null) {
            pos2x = x;
            pos2y = y;
            pos2z = z;
            return;
        }
        expandAabbToInclude(x, y, z);
    }

    private void expandAabbToInclude(int x, int y, int z) {
        int mix = Math.min(pos1x, pos2x);
        int miy = Math.min(pos1y, pos2y);
        int miz = Math.min(pos1z, pos2z);
        int mxx = Math.max(pos1x, pos2x);
        int mxy = Math.max(pos1y, pos2y);
        int mxz = Math.max(pos1z, pos2z);
        mix = Math.min(mix, x);
        miy = Math.min(miy, y);
        miz = Math.min(miz, z);
        mxx = Math.max(mxx, x);
        mxy = Math.max(mxy, y);
        mxz = Math.max(mxz, z);
        pos1x = mix;
        pos1y = miy;
        pos1z = miz;
        pos2x = mxx;
        pos2y = mxy;
        pos2z = mxz;
    }

    public boolean hasCompleteSelection() {
        return pos1x != null && pos1y != null && pos1z != null && pos2x != null && pos2y != null && pos2z != null;
    }

    /** 供网络同步与客户端线框；未完成选区时 {@link SelectionSnapshot#complete} 为 false。 */
    public SelectionSnapshot getSelectionSnapshot() {
        if (!hasCompleteSelection()) {
            return SelectionSnapshot.empty(this.inSession);
        }
        int minX = Math.min(pos1x, pos2x);
        int minY = Math.min(pos1y, pos2y);
        int minZ = Math.min(pos1z, pos2z);
        int maxX = Math.max(pos1x, pos2x);
        int maxY = Math.max(pos1y, pos2y);
        int maxZ = Math.max(pos1z, pos2z);
        return new SelectionSnapshot(inSession, true, minX, minY, minZ, maxX, maxY, maxZ);
    }

    public void setOutputName(String name) {
        if (name != null && !name.isEmpty()) outputName = name;
    }

    public String getOutputName() {
        return outputName;
    }

    public void setStructureId(String id) {
        if (id != null && !id.isEmpty()) structureId = id;
    }

    public String getStructureId() {
        return structureId;
    }

    public void setActiveFrame(int n) {
        if (n >= 0) activeFrame = n;
    }

    public int getActiveFrame() {
        return activeFrame;
    }

    /** 调试用：当前已 record 的帧数 */
    public int getBufferedFrameCount() {
        return frameJson.size();
    }

    /** 当前帧、体素格备注；无则空串 */
    public String getCellNote(int frameIndex, int zSlice, int row, int column) {
        Map<String, String> m = cellNotesByFrame.get(frameIndex);
        if (m == null) {
            return "";
        }
        String k = SdeCellCoords.cellKey(zSlice, row, column);
        String v = m.get(k);
        return v != null ? v : "";
    }

    /** 保存或清除（text 空白则删） */
    public void setCellNote(int frameIndex, int zSlice, int row, int column, String text) {
        Map<String, String> m = cellNotesByFrame.get(frameIndex);
        if (m == null) {
            m = new HashMap<>();
            cellNotesByFrame.put(frameIndex, m);
        }
        String k = SdeCellCoords.cellKey(zSlice, row, column);
        if (text == null || text.trim()
            .isEmpty()) {
            m.remove(k);
        } else {
            m.put(k, text);
        }
    }

    /**
     * 将内存中的备注写入 scan 根对象（字段名 {@code sdeCellNotes}），与 {@code cellGrid} 同形语义；供客户端烘焙或再次导出。
     */
    public void applyCellNotesToScanJson(JsonObject root, int frameIndex) {
        if (root == null) {
            return;
        }
        if (!root.has("cellGrid")) {
            return;
        }
        int[] dim = readScanCellGridDimensions(root.getAsJsonArray("cellGrid"));
        if (dim == null) {
            return;
        }
        int sizeZ = dim[0], sizeRow = dim[1], sizeCol = dim[2];
        Map<String, String> m = cellNotesByFrame.get(frameIndex);
        JsonObject noteObj = new JsonObject();
        if (m != null) {
            for (Map.Entry<String, String> e : m.entrySet()) {
                int[] zrc = SdeCellCoords.tryParseCellKey(e.getKey());
                if (zrc == null) {
                    continue;
                }
                if (zrc[0] < 0 || zrc[0] >= sizeZ
                    || zrc[1] < 0
                    || zrc[1] >= sizeRow
                    || zrc[2] < 0
                    || zrc[2] >= sizeCol) {
                    continue;
                }
                String t = e.getValue();
                if (t == null || t.isEmpty()) {
                    continue;
                }
                noteObj.addProperty(e.getKey(), t);
            }
        }
        if (noteObj.entrySet()
            .isEmpty()) {
            root.remove("sdeCellNotes");
        } else {
            root.add("sdeCellNotes", noteObj);
        }
    }

    private static int[] readScanCellGridDimensions(JsonArray cellGrid) {
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

    public void setSampler(IBlockSampler sampler) {
        if (sampler != null) this.sampler = sampler;
    }

    public String statusLine() {
        return String.format(
            "session=%s sel=%s pos1=%s pos2=%s activeFrame=%d recordedFrames=%s",
            inSession,
            selectionMode,
            posStr(pos1x, pos1y, pos1z),
            posStr(pos2x, pos2y, pos2z),
            activeFrame,
            frameJson.keySet());
    }

    private static String posStr(Integer x, Integer y, Integer z) {
        if (x == null || y == null || z == null) return "null";
        return x + "," + y + "," + z;
    }

    /**
     * 将选区扫入 {@code frameJson[targetFrame]}；与活动帧解耦，不修改 {@link #activeFrame}。备注、{@code sdeCellNotes} 按
     * {@code targetFrame} 与 {@link #cellNotesByFrame} 关联。
     */
    public void recordIntoFrame(int targetFrame, EntityPlayerMP player) {
        commitScanToFrame(targetFrame, scanToStructureJsonOnly(player), player);
    }

    /**
     * 将已得到的 scan 根对象（无备注）写入指定帧；用于 cycle 等避免重复扫描。
     */
    public void commitScanToFrame(int targetFrame, JsonObject scanRoot, EntityPlayerMP player) {
        if (!hasCompleteSelection()) {
            throw new IllegalStateException("请先 /sde pos1 与 /sde pos2（或 hpos/选区工具）");
        }
        lastAuthor = player.getCommandSenderName();
        lastGtnhVersion = PackVersionProbe.tryPackVersionString();
        applyCellNotesToScanJson(scanRoot, targetFrame);
        frameJson.put(targetFrame, GSON.toJson(scanRoot));
    }

    /** 对当前选区做 scan 中间态，供 cycle 等比较用（在写入备注前）。不修改 {@link #frameJson}。 */
    public JsonObject scanToStructureJsonOnly(EntityPlayerMP player) {
        if (!hasCompleteSelection()) {
            throw new IllegalStateException("请先 /sde pos1 与 /sde pos2（或 hpos/选区工具）");
        }
        return StructureScan.scanToStructureJson(
            player.worldObj,
            pos1x,
            pos1y,
            pos1z,
            pos2x,
            pos2y,
            pos2z,
            structureId,
            sampler,
            player);
    }

    /**
     * 与 {@code GSON.toJson} 对 scan 根对象序列化，供 cycle 与首帧 {@code equals} 比较（在写入
     * sdeCellNotes 前对同一套 Gson 的字符串）。
     */
    public String jsonStringForScanCompare(JsonObject scanRoot) {
        return GSON.toJson(scanRoot);
    }

    public void record(EntityPlayerMP player) {
        recordIntoFrame(activeFrame, player);
    }

    /**
     * 写出结构 JSON 到 {@code structure_exports}（仅场景数据；注册表请用 {@link #requestRegistryDump()}）。
     */
    public String exportToFile() throws IOException {
        File dir = new File("structure_exports");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建目录: " + dir.getAbsolutePath());
        }
        File out = new File(dir, outputName + ".json");

        if (frameJson.isEmpty()) {
            throw new IllegalStateException("无缓冲数据，请先 record");
        }

        if (frameJson.size() == 1 && frameJson.containsKey(0)) {
            String json = patchFrameJsonForExport(0, frameJson.get(0));
            writeUtf8(out, json);
        } else {
            JsonObject worldDocument = new JsonObject();
            worldDocument.addProperty("id", structureId);
            worldDocument.addProperty("mode", "multiblock");
            worldDocument.addProperty("label", structureId);
            worldDocument.addProperty("author", lastAuthor);
            worldDocument.addProperty("gtnhVersion", lastGtnhVersion);
            worldDocument.add("description", JsonNull.INSTANCE);
            worldDocument.add("tooltipPalette", new JsonArray());
            JsonArray frames = new JsonArray();
            JsonParser parser = new JsonParser();
            for (Map.Entry<Integer, String> e : frameJson.entrySet()) {
                JsonObject fr = new JsonObject();
                fr.addProperty("index", e.getKey());
                JsonObject nested = parser.parse(patchFrameJsonForExport(e.getKey(), e.getValue()))
                    .getAsJsonObject();
                fr.add("structure", nested);
                frames.add(fr);
            }
            worldDocument.add("frames", frames);
            JsonObject playback = new JsonObject();
            playback.addProperty("loop", false);
            playback.addProperty("defaultFrameIndex", 0);
            worldDocument.add("playback", playback);

            writeUtf8(out, GSON.toJson(worldDocument));
        }

        return out.getAbsolutePath();
    }

    /**
     * 在 {@code structure_exports} 下落盘 {@link PendingDumpFiles#FILE_NAME}，供客户端下一 tick 起生成全量注册表 JSON。
     */
    public String requestRegistryDump() throws IOException {
        File dir = new File("structure_exports");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建目录: " + dir.getAbsolutePath());
        }
        JsonObject pendingDump = new JsonObject();
        pendingDump.addProperty("schemaVersion", PendingDumpFiles.SCHEMA_VERSION);
        pendingDump.addProperty("exportRoot", dir.getAbsolutePath());
        writeUtf8(new File(dir, PendingDumpFiles.FILE_NAME), GSON.toJson(pendingDump));
        return dir.getAbsolutePath();
    }

    private static void writeUtf8(File file, String content) throws IOException {
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(content);
        }
    }

    private String patchFrameJsonForExport(int frameIndex, String rawJson) {
        try {
            JsonObject root = new JsonParser().parse(rawJson)
                .getAsJsonObject();
            applyCellNotesToScanJson(root, frameIndex);
            return GSON.toJson(root);
        } catch (Exception e) {
            return rawJson;
        }
    }
}
