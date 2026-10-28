package com.lightning.mod.client.meshcapture;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.MeshCaptureService.CaptureToolkit;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;

/**
 * 「忠实复现捕获层」1.0 验收探针的 drain-dump 装配（纯函数，零 MC 依赖，可纯 JVM 单测）。
 * <p>
 * 输入是 {@link TessellatorCaptureState#endWindowAndDrain(List) drain 到的 TESR 窗口四边形}（按 TE 归属格分组），
 * 输出是 web 可加载的 V2 场景文档片段：{@code frames[0].structure} = {@code geometryPhase:"baked"} +
 * {@code cellGrid} + {@code blockPalette}（air 占 0 位）。几何口径与既有导出逐字一致：
 * <ul>
 * <li><strong>块局部归一化</strong>：TESR 窗口的顶点经窗口 MODELVIEW 基线（{@code inv(M0)*M_now*v}）变换后落在
 * 窗口入口系，其「去 Tessellator {@code setTranslation} 偏移」即块局部坐标 —— 与录窗分箱
 * （{@link CaptureBinning}，见 {@code tagQuadChannelAndBin}）用的是同一份顶点数学，故本类只做
 * {@code x - tessOffsetX} 减法，<strong>不</strong>套用旧 {@code LEGACY_PER_CELL} 路径的 closeness 原点启发式
 * （{@code normalizeVerticesToBlockContract}）；</li>
 * <li><strong>几何产出</strong>：复用 {@link CaptureToolkit#geometryOf}（= 现行导出
 * {@code MeshCaptureService.bakedQuadsGeometryFromCapture}），顶点字段 {@code x,y,z,u,v,brightness,color}；</li>
 * <li><strong>调色板去重</strong>：复用 {@link CaptureToolkit#signatureOfState}（与既有「同一方块状态只存一份」
 * 同一套内容签名），签名相同即共用一条 palette 条目。</li>
 * </ul>
 * <p>
 * <strong>忠实边界</strong>：本类只搬运 {@code quads}（录窗实录），不合成、不外插、不从静态数据/物品渲染兜底；
 * 录不到几何的格一律留空（{@code cellGrid} 写 0 = air）并进 {@link Assembly#missing} 显式列出。
 * <p>
 * 坐标约定：{@code cellGrid[z][row][col]}，{@code row 0 = 结构顶（最大 Y）}——与 web V2 契约
 * （{@code RuntimeDocument._fromV2CellGrid} 的 {@code structureRowToWorldY}）一致。
 */
public final class CaptureDumpAssembler {

    /** air 恒占调色板 0 位（web {@code AIR_PALETTE_INDEX}）。 */
    public static final int AIR_PALETTE_INDEX = 0;

    /** 与现行导出一致的几何编码。 */
    public static final String GEOMETRY_ENCODING = "bakedQuadsJsonV1";

    private CaptureDumpAssembler() {}

    // ------------------------------------------------------------------ 输入/输出值类型

    /** 一格录入：归属键（TE 世界整数格）+ 该格 drain 到的窗口四边形（窗口系原样，含 tessOffset）。 */
    public static final class CellInput {

        public final String label;
        public final String registryId;
        public final int meta;
        public final int x;
        public final int y;
        public final int z;
        public final List<CapturedQuad> quads;

        public CellInput(String label, String registryId, int meta, int x, int y, int z, List<CapturedQuad> quads) {
            this.label = label;
            this.registryId = registryId != null && !registryId.isEmpty() ? registryId : "unknown";
            this.meta = meta;
            this.x = x;
            this.y = y;
            this.z = z;
            this.quads = quads != null ? quads : new ArrayList<CapturedQuad>();
        }
    }

    /** 装配结果：结构片段（geometryPhase/cellGrid/blockPalette）+ 逐格诊断 + 缺格清单。 */
    public static final class Assembly {

        public final JsonObject structure;
        /**
         * 逐格：{@code {label,x,y,z,quads,paletteIndex,missing,blockLocal,blockLocalBins,inUnitCube,
         * distinctQuads,duplicateQuads}}。
         */
        public final JsonArray perCellQuads;
        /** 录不到几何的格（label@x,y,z），仅供结果 JSON 显式列出，不做任何兜底。 */
        public final List<String> missing;
        /** 含 air 在内的调色板条目数。 */
        public final int paletteEntries;
        /** 全部格「同内容四边形」重复数合计（同一几何被多次 drain 的可见度量）。 */
        public final int duplicateQuads;
        public final int sizeX;
        public final int sizeY;
        public final int sizeZ;
        public final int minX;
        public final int minY;
        public final int minZ;

        Assembly(JsonObject structure, JsonArray perCellQuads, List<String> missing, int paletteEntries,
            int duplicateQuads, int sizeX, int sizeY, int sizeZ, int minX, int minY, int minZ) {
            this.structure = structure;
            this.perCellQuads = perCellQuads;
            this.missing = missing;
            this.paletteEntries = paletteEntries;
            this.duplicateQuads = duplicateQuads;
            this.sizeX = sizeX;
            this.sizeY = sizeY;
            this.sizeZ = sizeZ;
            this.minX = minX;
            this.minY = minY;
            this.minZ = minZ;
        }
    }

    // ------------------------------------------------------------------ 归一化（纯函数）

    /** 窗口系坐标 → 块局部：减掉该顶点录制时的 Tessellator {@code setTranslation} 偏移。 */
    public static double blockLocal(double windowCoord, double tessOffset) {
        return windowCoord - tessOffset;
    }

    /**
     * 四边形外壳复制（顶点列表重建、字段全带过）：给 {@link CaptureToolkit#attachQuadMaterials} 这类会就地改写
     * 四边形的调用用，避免污染录窗 drain 的原始记录（顶点 UV 重映射不可逆）。
     */
    public static CapturedQuad copyQuad(CapturedQuad q) {
        return rebuildQuad(q, false);
    }

    /**
     * 「窗口系 → 块局部」重建：顶点坐标减去 {@link CapturedVertex#tessOffsetX/Y/Z}，其余字段（UV/亮度/颜色/
     * 材质下标/绑定提示/归属键/分箱）原样带过。与 {@code tagQuadChannelAndBin} 的分箱口径同源。
     */
    public static CapturedQuad normalizeToBlockLocal(CapturedQuad q) {
        return rebuildQuad(q, true);
    }

    private static CapturedQuad rebuildQuad(CapturedQuad q, boolean subtractTessOffset) {
        List<CapturedVertex> verts = new ArrayList<>(q.vertices.size());
        for (CapturedVertex v : q.vertices) {
            double x = v.x;
            double y = v.y;
            double z = v.z;
            double ox = 0.0;
            double oy = 0.0;
            double oz = 0.0;
            if (subtractTessOffset) {
                x = blockLocal(v.x, v.tessOffsetX);
                y = blockLocal(v.y, v.tessOffsetY);
                z = blockLocal(v.z, v.tessOffsetZ);
            } else {
                ox = v.tessOffsetX;
                oy = v.tessOffsetY;
                oz = v.tessOffsetZ;
            }
            verts.add(
                new CapturedVertex(
                    x,
                    y,
                    z,
                    v.u,
                    v.v,
                    v.brightness,
                    v.colorArgb,
                    ox,
                    oy,
                    oz,
                    v.textureBindHintAtVertex));
        }
        CapturedQuad nq = new CapturedQuad(verts);
        nq.materialKey = q.materialKey;
        nq.samplerIndex = q.samplerIndex;
        nq.bindTextureHint = q.bindTextureHint;
        nq.materialAtlasKind = q.materialAtlasKind;
        nq.materialUsesStandaloneTexture = q.materialUsesStandaloneTexture;
        nq.fromDynamicExtensionPass = q.fromDynamicExtensionPass;
        nq.channel = q.channel;
        nq.attribX = q.attribX;
        nq.attribY = q.attribY;
        nq.attribZ = q.attribZ;
        nq.binX = q.binX;
        nq.binY = q.binY;
        nq.binZ = q.binZ;
        nq.crossBin = q.crossBin;
        return nq;
    }

    // ------------------------------------------------------------------ 装配（纯函数）

    /**
     * 装配场景导出结构片段。
     *
     * @param cells  逐格实录（顺序即调色板条目顺序；含录不到几何的格，它们只进 {@code missing}）
     * @param margin 最小包围盒外扩的格子数（「周边空气」）
     */
    public static Assembly assemble(List<CellInput> cells, int margin) {
        if (cells == null || cells.isEmpty()) {
            throw new IllegalArgumentException("cells == null or empty");
        }
        if (margin < 0) {
            throw new IllegalArgumentException("margin < 0: " + margin);
        }
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        int maxZ = Integer.MIN_VALUE;
        for (CellInput c : cells) {
            minX = Math.min(minX, c.x);
            minY = Math.min(minY, c.y);
            minZ = Math.min(minZ, c.z);
            maxX = Math.max(maxX, c.x);
            maxY = Math.max(maxY, c.y);
            maxZ = Math.max(maxZ, c.z);
        }
        minX -= margin;
        minY -= margin;
        minZ -= margin;
        maxX += margin;
        maxY += margin;
        maxZ += margin;
        int sizeX = maxX - minX + 1;
        int sizeY = maxY - minY + 1;
        int sizeZ = maxZ - minZ + 1;

        int[][][] grid = new int[sizeZ][sizeY][sizeX];
        JsonArray palette = new JsonArray();
        palette.add(airPaletteEntry());
        Map<String, Integer> indexBySignature = new LinkedHashMap<>();
        JsonArray perCell = new JsonArray();
        List<String> missing = new ArrayList<>();
        int duplicateQuads = 0;

        for (CellInput c : cells) {
            JsonObject diag = new JsonObject();
            diag.addProperty("label", c.label);
            diag.addProperty("x", Integer.valueOf(c.x));
            diag.addProperty("y", Integer.valueOf(c.y));
            diag.addProperty("z", Integer.valueOf(c.z));
            diag.addProperty("registryId", c.registryId);
            diag.addProperty("quads", Integer.valueOf(c.quads.size()));
            if (c.quads.isEmpty()) {
                // 忠实边界：录不到就空着（cellGrid 保持 air），只在 missing 里显式列出，绝不兜底
                diag.addProperty("missing", Boolean.TRUE);
                diag.addProperty("paletteIndex", Integer.valueOf(-1));
                missing.add(c.label + "@" + c.x + "," + c.y + "," + c.z);
                perCell.add(diag);
                continue;
            }

            CapturedBlockInstance inst = new CapturedBlockInstance();
            for (CapturedQuad q : c.quads) {
                inst.quads.add(normalizeToBlockLocal(q));
            }
            JsonObject geometry = CaptureToolkit.geometryOf(inst);
            JsonArray tooltip = new JsonArray();
            String signature = CaptureToolkit.signatureOfState(c.registryId, c.meta, null, geometry, null);
            Integer index = indexBySignature.get(signature);
            if (index == null) {
                index = Integer.valueOf(palette.size());
                indexBySignature.put(signature, index);
                palette.add(paletteEntry(c.registryId, c.meta, geometry, tooltip));
            }
            // cellGrid[z][row][col]，row 0 = 结构顶（最大 Y）—— web V2 契约口径
            grid[c.z - minZ][maxY - c.y][c.x - minX] = index.intValue();
            diag.addProperty("missing", Boolean.FALSE);
            diag.addProperty("paletteIndex", index);
            addFrameDiagnostics(diag, inst);
            int quads = inst.quads.size();
            int distinct = distinctQuadCount(inst);
            diag.addProperty("distinctQuads", Integer.valueOf(distinct));
            diag.addProperty("duplicateQuads", Integer.valueOf(quads - distinct));
            duplicateQuads += quads - distinct;
            perCell.add(diag);
        }

        JsonObject structure = new JsonObject();
        structure.addProperty("geometryPhase", "baked");
        structure.add("cellGrid", gridToJson(grid));
        structure.add("blockPalette", palette);
        return new Assembly(
            structure,
            perCell,
            missing,
            palette.size(),
            duplicateQuads,
            sizeX,
            sizeY,
            sizeZ,
            minX,
            minY,
            minZ);
    }

    /**
     * 关窗几何「同内容四边形」去重计数：逐四边形用现行导出的几何签名（{@link CaptureToolkit#signatureOfGeometry}，
     * 4 位小数 / 四边形内顶点排序）算指纹再取集合大小。
     * <p>
     * 为什么需要：TESR 窗口的 drain 是<strong>会话内累计</strong>的——LP 管这类按「连接状态变化」重建 VBO 的渲染器
     * 会在一次会话里多次流入同一形状，累计集里因此出现同内容（甚至逐位相同）的重复四边形。本类如实全量写出
     * （不丢实录），只把重复量作为诊断暴露出来，供确认渲染是否有重叠面。
     */
    public static int distinctQuadCount(CapturedBlockInstance inst) {
        List<String> signatures = new ArrayList<>();
        for (CapturedQuad q : inst.quads) {
            CapturedBlockInstance one = new CapturedBlockInstance();
            one.quads.add(q);
            String sig = CaptureToolkit.signatureOfGeometry(CaptureToolkit.geometryOf(one));
            if (!signatures.contains(sig)) {
                signatures.add(sig);
            }
        }
        return signatures.size();
    }

    /**
     * 块局部口径自证：逐格记录归一化后顶点落在哪些整数格（{@link CaptureBinning} 同口径）与落在单位立方
     * {@code [0,1]³}（容差 1e-6）的比例。LP 管这类「窗口内不加净 GL 平移」的渲染器给的就是块局部坐标
     * （bins 0 / ±1，比例 1.0）；比例 &lt; 1 说明该格录到的顶点不在块局部系，导出几何会偏出该格——如实记录，
     * 不修正。
     */
    private static void addFrameDiagnostics(JsonObject diag, CapturedBlockInstance inst) {
        List<String> bins = new ArrayList<>();
        int total = 0;
        int inUnitCube = 0;
        for (CapturedQuad q : inst.quads) {
            for (CapturedVertex v : q.vertices) {
                total++;
                String bin = CaptureBinning.binOf(v.x) + ","
                    + CaptureBinning.binOf(v.y)
                    + ","
                    + CaptureBinning.binOf(v.z);
                if (!bins.contains(bin)) {
                    bins.add(bin);
                }
                if (isUnitInterval(v.x) && isUnitInterval(v.y) && isUnitInterval(v.z)) {
                    inUnitCube++;
                }
            }
        }
        JsonArray binArr = new JsonArray();
        for (String b : bins) {
            binArr.add(new JsonPrimitive(b));
        }
        diag.add("blockLocalBins", binArr);
        diag.addProperty("blockLocal", Boolean.valueOf(total > 0 && inUnitCube == total));
        diag.addProperty("inUnitCubeRatio", Double.valueOf(total == 0 ? 0.0 : (double) inUnitCube / (double) total));
    }

    private static boolean isUnitInterval(double t) {
        return t >= -1.0e-6 && t <= 1.0 + 1.0e-6;
    }

    // ------------------------------------------------------------------ 调色板 / 网格

    /** air 条目（恒占 0 位）：与 web fixture 同形（renderMode=BakedQuads、空 bakedQuadsJsonV1、无 tooltip）。 */
    public static JsonObject airPaletteEntry() {
        return paletteEntry("air", 0, emptyGeometry(), new JsonArray());
    }

    /** 空的 {@code bakedQuadsJsonV1} 几何。 */
    public static JsonObject emptyGeometry() {
        JsonObject geometry = new JsonObject();
        geometry.addProperty("encoding", GEOMETRY_ENCODING);
        geometry.add("quads", new JsonArray());
        return geometry;
    }

    private static JsonObject paletteEntry(String registryId, int meta, JsonObject geometry, JsonArray tooltip) {
        JsonObject p = new JsonObject();
        p.addProperty("registryId", registryId);
        p.addProperty("meta", Integer.valueOf(meta));
        p.addProperty("renderMode", "BakedQuads");
        p.add("geometry", geometry);
        p.addProperty("occludesAdjacentFaces", Boolean.FALSE);
        p.add("tooltip", tooltip);
        return p;
    }

    private static JsonArray gridToJson(int[][][] grid) {
        JsonArray out = new JsonArray();
        for (int z = 0; z < grid.length; z++) {
            JsonArray rows = new JsonArray();
            for (int row = 0; row < grid[z].length; row++) {
                JsonArray cols = new JsonArray();
                for (int col = 0; col < grid[z][row].length; col++) {
                    cols.add(new JsonPrimitive(Integer.valueOf(grid[z][row][col])));
                }
                rows.add(cols);
            }
            out.add(rows);
        }
        return out;
    }

    // ------------------------------------------------------------------ 摘要

    /** SHA-256 十六进制小写（导出文件内容摘要；纯函数，单测可对已知向量）。 */
    public static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(data);
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "sha256-error:" + String.valueOf(e);
        }
    }

    public static String sha256Hex(String utf8) {
        return sha256Hex(utf8.getBytes(StandardCharsets.UTF_8));
    }
}
