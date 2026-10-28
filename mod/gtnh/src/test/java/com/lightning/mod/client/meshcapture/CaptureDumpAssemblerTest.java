package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.meshcapture.CaptureDumpAssembler.Assembly;
import com.lightning.mod.client.meshcapture.CaptureDumpAssembler.CellInput;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;

/**
 * {@link CaptureDumpAssembler} 的纯 JVM 单测：块局部归一化（坐标映射）、cellGrid/palette 装配、air 占位、
 * 缺格如实留空、调色板去重、SHA-256 摘要。
 * <p>
 * 零 MC 依赖：只构造录窗层的数据类型（{@link CapturedQuad}/{@link CapturedVertex}）与一条真实
 * {@link TessellatorCaptureState#endWindowAndDrain} 的 drain 记录，不触碰任何渲染器/世界对象。
 */
public class CaptureDumpAssemblerTest {

    private static final int GL_QUADS = 7;

    /** 一个朝 +Z 的单位四边形（块局部 [0,1]²），窗口系坐标 = 块局部 + tessOffset。 */
    private static CapturedQuad quadAt(double offsetX, double offsetY, double offsetZ) {
        return quadFrame(offsetX, offsetY, offsetZ, offsetX, offsetY, offsetZ);
    }

    /** 窗口系坐标起点与 Tessellator {@code setTranslation} 分离：归一化后 = coord - offset。 */
    private static CapturedQuad quadFrame(double coordX, double coordY, double coordZ, double offsetX, double offsetY,
        double offsetZ) {
        double[][] corners = { { 0.0, 0.0, 1.0 }, { 1.0, 0.0, 1.0 }, { 1.0, 1.0, 1.0 }, { 0.0, 1.0, 1.0 } };
        double[][] uvs = { { 0.0, 0.0 }, { 1.0, 0.0 }, { 1.0, 1.0 }, { 0.0, 1.0 } };
        List<CapturedVertex> verts = new ArrayList<CapturedVertex>();
        for (int i = 0; i < 4; i++) {
            verts.add(
                new CapturedVertex(
                    corners[i][0] + coordX,
                    corners[i][1] + coordY,
                    corners[i][2] + coordZ,
                    uvs[i][0],
                    uvs[i][1],
                    240,
                    0xFFFFFFFF,
                    offsetX,
                    offsetY,
                    offsetZ,
                    "minecraft:atlas/blocks"));
        }
        CapturedQuad q = new CapturedQuad(verts);
        q.bindTextureHint = "minecraft:atlas/blocks";
        q.materialKey = "minecraft:stone";
        q.samplerIndex = 3;
        return q;
    }

    /** 相机相对系样例：顶点落在 (8,6,0) 一带（去 offset 后仍不在块局部），模拟内部自带 GL 平移的 TESR。 */
    private static List<CapturedQuad> cameraRelativeQuad() {
        List<CapturedVertex> verts = new ArrayList<CapturedVertex>();
        double[][] corners = { { 0.0, 0.0, 0.0 }, { 1.0, 0.0, 0.0 }, { 1.0, 1.0, 0.0 }, { 0.0, 1.0, 0.0 } };
        for (int i = 0; i < 4; i++) {
            verts.add(
                new CapturedVertex(
                    8.0 + corners[i][0],
                    6.0 + corners[i][1],
                    corners[i][2],
                    0.0,
                    0.0,
                    240,
                    0xFFFFFFFF,
                    0.0,
                    0.0,
                    0.0,
                    "minecraft:atlas/blocks"));
        }
        CapturedQuad q = new CapturedQuad(verts);
        q.samplerIndex = 1;
        List<CapturedQuad> l = new ArrayList<CapturedQuad>();
        l.add(q);
        return l;
    }

    private static CellInput cell(String label, String registryId, int meta, int x, int y, int z,
        List<CapturedQuad> quads) {
        return new CellInput(label, registryId, meta, x, y, z, quads);
    }

    private static List<CapturedQuad> oneQuad(double offsetX, double offsetY, double offsetZ) {
        List<CapturedQuad> l = new ArrayList<CapturedQuad>();
        l.add(quadAt(offsetX, offsetY, offsetZ));
        return l;
    }

    private static Assembly assembleTwoCells(List<CapturedQuad> pipeQuads, List<CapturedQuad> chestQuads) {
        List<CellInput> cells = new ArrayList<CellInput>();
        cells.add(cell("pipe-1", "LogisticsPipes:pipe.BasicLogisticsPipe", 0, 65, 12, 64, pipeQuads));
        cells.add(cell("chest-1", "minecraft:chest", 0, 68, 12, 64, chestQuads));
        return CaptureDumpAssembler.assemble(cells, 1);
    }

    private static int gridAt(Assembly a, int x, int y, int z) {
        JsonArray grid = a.structure.getAsJsonArray("cellGrid");
        int zi = z - a.minZ;
        int row = (a.minY + a.sizeY - 1) - y; // row 0 = 结构顶（最大 Y）
        return grid.get(zi)
            .getAsJsonArray()
            .get(row)
            .getAsJsonArray()
            .get(x - a.minX)
            .getAsInt();
    }

    @Before
    public void setUp() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
    }

    @After
    public void tearDown() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
    }

    // ------------------------------------------------------------------ 归一化（坐标映射）

    @Test
    public void blockLocalSubtractsTessellatorOffset() {
        assertEquals(0.25, CaptureDumpAssembler.blockLocal(65.25, 65.0), 0.0);
        assertEquals(-3.5, CaptureDumpAssembler.blockLocal(-3.5, 0.0), 0.0);
        assertEquals(0.0, CaptureDumpAssembler.blockLocal(64.0, 64.0), 0.0);
    }

    @Test
    public void normalizeToBlockLocalKeepsUvColorMaterialAndClearsOffset() {
        CapturedQuad q = quadAt(65.0, 12.0, 64.0);
        CapturedQuad n = CaptureDumpAssembler.normalizeToBlockLocal(q);
        assertEquals(4, n.vertices.size());
        CapturedVertex v0 = n.vertices.get(0);
        assertEquals(0.0, v0.x, 1e-9);
        assertEquals(0.0, v0.y, 1e-9);
        assertEquals(1.0, v0.z, 1e-9);
        assertEquals(0.0, v0.tessOffsetX, 1e-9);
        assertEquals(0.0, v0.tessOffsetZ, 1e-9);
        // UV/亮度/颜色/材质下标/绑定提示原样带过
        assertEquals(0.0, v0.u, 1e-9);
        assertEquals(240, v0.brightness);
        assertEquals(0xFFFFFFFF, v0.colorArgb);
        assertEquals(3, n.samplerIndex);
        assertEquals("minecraft:atlas/blocks", n.bindTextureHint);
        assertEquals("minecraft:stone", n.materialKey);
        // 原四边形不被改写（copy 语义）
        assertEquals(65.0, q.vertices.get(0).x, 1e-9);
        assertEquals(65.0, q.vertices.get(0).tessOffsetX, 1e-9);
    }

    /**
     * 端到端（纯 JVM）：真实录窗 drain → 装配 → 调色板几何。窗口系坐标（块局部 + Tessellator 平移 65/12/64）
     * 必须落回块局部 {@code [0,1]}（bins 0,0,0）——与录窗分箱同一份顶点数学。
     */
    @Test
    public void drainedWindowQuadsAssembleToBlockLocalGeometry() {
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 65, 12, 64, "TileEntityLogisticsPipe");
        double[][] corners = { { 0.0, 0.0, 1.0 }, { 1.0, 0.0, 1.0 }, { 1.0, 1.0, 1.0 }, { 0.0, 1.0, 1.0 } };
        for (double[] c : corners) {
            TessellatorCaptureState.onVertexRecorded(
                c[0] + 65.0,
                c[1] + 12.0,
                c[2] + 64.0,
                0.0,
                0.0,
                240,
                0xFFFFFFFF,
                65.0,
                12.0,
                64.0,
                GL_QUADS);
        }
        List<CapturedQuad> drained = new ArrayList<CapturedQuad>();
        assertEquals(1, TessellatorCaptureState.endWindowAndDrain(drained));
        assertEquals(1, drained.size());
        assertEquals("TESR", drained.get(0).channel.name());

        Assembly a = assembleTwoCells(drained, new ArrayList<CapturedQuad>());
        JsonObject entry = a.structure.getAsJsonArray("blockPalette")
            .get(1)
            .getAsJsonObject();
        JsonArray quads = entry.getAsJsonObject("geometry")
            .getAsJsonArray("quads");
        assertEquals(1, quads.size());
        JsonArray verts = quads.get(0)
            .getAsJsonObject()
            .getAsJsonArray("vertices");
        assertEquals(4, verts.size());
        assertEquals(
            0.0,
            verts.get(0)
                .getAsJsonObject()
                .get("x")
                .getAsDouble(),
            1e-9);
        assertEquals(
            0.0,
            verts.get(0)
                .getAsJsonObject()
                .get("y")
                .getAsDouble(),
            1e-9);
        assertEquals(
            1.0,
            verts.get(0)
                .getAsJsonObject()
                .get("z")
                .getAsDouble(),
            1e-9);
        assertEquals(
            1.0,
            verts.get(2)
                .getAsJsonObject()
                .get("x")
                .getAsDouble(),
            1e-9);
        assertEquals(
            1.0,
            verts.get(2)
                .getAsJsonObject()
                .get("y")
                .getAsDouble(),
            1e-9);

        JsonObject diag = a.perCellQuads.get(0)
            .getAsJsonObject();
        assertTrue(
            diag.get("blockLocal")
                .getAsBoolean());
        assertEquals(
            1.0,
            diag.get("inUnitCubeRatio")
                .getAsDouble(),
            1e-9);
        assertEquals(
            "0,0,1",
            diag.getAsJsonArray("blockLocalBins")
                .get(0)
                .getAsString());
    }

    /** 顶点字段与现行导出同形：x,y,z,u,v,brightness,color（brightness 可选但本口径一律写出）。 */
    @Test
    public void geometryVertexFieldsMatchExistingExportContract() {
        Assembly a = assembleTwoCells(oneQuad(65.0, 12.0, 64.0), new ArrayList<CapturedQuad>());
        JsonObject v = a.structure.getAsJsonArray("blockPalette")
            .get(1)
            .getAsJsonObject()
            .getAsJsonObject("geometry")
            .getAsJsonArray("quads")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("vertices")
            .get(1)
            .getAsJsonObject();
        assertEquals(
            1.0,
            v.get("x")
                .getAsDouble(),
            1e-9);
        assertEquals(
            0.0,
            v.get("y")
                .getAsDouble(),
            1e-9);
        assertEquals(
            1.0,
            v.get("z")
                .getAsDouble(),
            1e-9);
        assertEquals(
            1.0,
            v.get("u")
                .getAsDouble(),
            1e-9);
        assertEquals(
            0.0,
            v.get("v")
                .getAsDouble(),
            1e-9);
        assertEquals(
            240,
            v.get("brightness")
                .getAsInt());
        assertEquals(
            0xFFFFFFFF,
            v.get("color")
                .getAsInt());
        assertEquals(
            3,
            a.structure.getAsJsonArray("blockPalette")
                .get(1)
                .getAsJsonObject()
                .getAsJsonObject("geometry")
                .getAsJsonArray("quads")
                .get(0)
                .getAsJsonObject()
                .get("materialIndex")
                .getAsInt());
    }

    // ------------------------------------------------------------------ air 占位 / cellGrid / palette

    @Test
    public void airOccupiesPaletteIndexZero() {
        Assembly a = assembleTwoCells(oneQuad(65.0, 12.0, 64.0), new ArrayList<CapturedQuad>());
        JsonArray palette = a.structure.getAsJsonArray("blockPalette");
        assertEquals(2, a.paletteEntries);
        JsonObject air = palette.get(0)
            .getAsJsonObject();
        assertEquals(
            "air",
            air.get("registryId")
                .getAsString());
        assertEquals(
            0,
            air.get("meta")
                .getAsInt());
        assertEquals(
            "BakedQuads",
            air.get("renderMode")
                .getAsString());
        assertEquals(
            CaptureDumpAssembler.GEOMETRY_ENCODING,
            air.getAsJsonObject("geometry")
                .get("encoding")
                .getAsString());
        assertEquals(
            0,
            air.getAsJsonObject("geometry")
                .getAsJsonArray("quads")
                .size());
        assertFalse(
            air.get("occludesAdjacentFaces")
                .getAsBoolean());
        assertEquals(
            0,
            air.getAsJsonArray("tooltip")
                .size());
        assertFalse(air.has("nbt"));
        assertEquals(
            "baked",
            a.structure.get("geometryPhase")
                .getAsString());
    }

    @Test
    public void cellGridCoversBoundingBoxPlusMarginWithAirAround() {
        Assembly a = assembleTwoCells(oneQuad(65.0, 12.0, 64.0), oneQuad(68.0, 12.0, 64.0));
        // 包围盒 x[65,68] y[12,12] z[64,64]，外扩 1 格
        assertEquals(6, a.sizeX);
        assertEquals(3, a.sizeY);
        assertEquals(3, a.sizeZ);
        assertEquals(64, a.minX);
        assertEquals(11, a.minY);
        assertEquals(63, a.minZ);

        assertEquals(1, gridAt(a, 65, 12, 64));
        assertEquals(2, gridAt(a, 68, 12, 64));
        // 周边空气 = 0（air 占位）
        assertEquals(0, gridAt(a, 64, 12, 64));
        assertEquals(0, gridAt(a, 65, 11, 64));
        assertEquals(0, gridAt(a, 65, 13, 64));
        assertEquals(0, gridAt(a, 65, 12, 63));
        assertEquals(0, gridAt(a, 65, 12, 65));
        assertEquals(0, gridAt(a, 69, 12, 64));
        // 网格形状与尺寸一致（逐行逐列同形）
        JsonArray grid = a.structure.getAsJsonArray("cellGrid");
        assertEquals(3, grid.size());
        for (int z = 0; z < grid.size(); z++) {
            JsonArray rows = grid.get(z)
                .getAsJsonArray();
            assertEquals(3, rows.size());
            for (int r = 0; r < rows.size(); r++) {
                assertEquals(
                    6,
                    rows.get(r)
                        .getAsJsonArray()
                        .size());
            }
        }
        // row 0 = 结构顶（最大 Y）：y=13 的行必须全空
        JsonArray topRow = grid.get(0)
            .getAsJsonArray()
            .get(0)
            .getAsJsonArray();
        for (int i = 0; i < topRow.size(); i++) {
            assertEquals(
                0,
                topRow.get(i)
                    .getAsInt());
        }
    }

    // ------------------------------------------------------------------ 忠实边界：缺格 / 去重

    @Test
    public void duplicateQuadsAreCountedButNotDropped() {
        // 同一窗口几何重复 drain（VBO 多次重建）：如实全量写出，只把重复量作为诊断暴露
        List<CapturedQuad> twice = new ArrayList<CapturedQuad>();
        twice.add(quadAt(65.0, 12.0, 64.0));
        twice.add(quadAt(65.0, 12.0, 64.0));
        Assembly a = assembleTwoCells(twice, new ArrayList<CapturedQuad>());
        JsonObject d0 = a.perCellQuads.get(0)
            .getAsJsonObject();
        assertEquals(
            2,
            d0.get("quads")
                .getAsInt());
        assertEquals(
            1,
            d0.get("distinctQuads")
                .getAsInt());
        assertEquals(
            1,
            d0.get("duplicateQuads")
                .getAsInt());
        assertEquals(1, a.duplicateQuads);
        assertEquals(
            2,
            a.structure.getAsJsonArray("blockPalette")
                .get(1)
                .getAsJsonObject()
                .getAsJsonObject("geometry")
                .getAsJsonArray("quads")
                .size());
    }

    @Test
    public void cellsWithoutDrainedGeometryStayAirAndAreListedAsMissing() {
        Assembly a = assembleTwoCells(new ArrayList<CapturedQuad>(), new ArrayList<CapturedQuad>());
        assertEquals(1, a.paletteEntries); // 只有 air
        assertEquals(2, a.missing.size());
        assertEquals("pipe-1@65,12,64", a.missing.get(0));
        assertEquals("chest-1@68,12,64", a.missing.get(1));
        assertEquals(0, gridAt(a, 65, 12, 64));
        assertEquals(0, gridAt(a, 68, 12, 64));
        JsonObject d0 = a.perCellQuads.get(0)
            .getAsJsonObject();
        assertTrue(
            d0.get("missing")
                .getAsBoolean());
        assertEquals(
            -1,
            d0.get("paletteIndex")
                .getAsInt());
        assertEquals(
            0,
            d0.get("quads")
                .getAsInt());
    }

    @Test
    public void identicalGeometrySharesOnePaletteEntry() {
        // 同一方块状态（registryId + meta）+ 同一几何 ⇒ 共用一条 palette 条目（与现行导出去重同口径）
        List<CellInput> cells = new ArrayList<CellInput>();
        cells.add(cell("pipe-1", "LogisticsPipes:pipe.BasicLogisticsPipe", 0, 65, 12, 64, oneQuad(65.0, 12.0, 64.0)));
        cells.add(cell("pipe-2", "LogisticsPipes:pipe.BasicLogisticsPipe", 0, 66, 12, 64, oneQuad(66.0, 12.0, 64.0)));
        Assembly a = CaptureDumpAssembler.assemble(cells, 1);
        assertEquals(2, a.paletteEntries);
        assertEquals(1, gridAt(a, 65, 12, 64));
        assertEquals(1, gridAt(a, 66, 12, 64));
    }

    @Test
    public void differentGeometryGetsItsOwnPaletteEntry() {
        double[] shift = { 0.5, 0.5, 0.5 };
        List<CapturedQuad> other = oneQuad(65.0, 12.0, 64.0);
        CapturedQuad q = other.get(0);
        q.vertices.clear();
        CapturedQuad base = quadAt(65.0, 12.0, 64.0);
        for (CapturedVertex v : base.vertices) {
            q.vertices.add(
                new CapturedVertex(
                    v.x + shift[0],
                    v.y + shift[1],
                    v.z + shift[2],
                    v.u,
                    v.v,
                    v.brightness,
                    v.colorArgb,
                    v.tessOffsetX,
                    v.tessOffsetY,
                    v.tessOffsetZ,
                    v.textureBindHintAtVertex));
        }
        Assembly a = assembleTwoCells(oneQuad(65.0, 12.0, 64.0), other);
        assertEquals(3, a.paletteEntries);
        assertEquals(1, gridAt(a, 65, 12, 64));
        assertEquals(2, gridAt(a, 68, 12, 64));
    }

    @Test
    public void registryIdAndMetaLandOnPaletteEntry() {
        List<CellInput> cells = new ArrayList<CellInput>();
        cells.add(cell("pipe-1", "LogisticsPipes:pipe.BasicLogisticsPipe", 0, 65, 12, 64, oneQuad(65.0, 12.0, 64.0)));
        Assembly a = CaptureDumpAssembler.assemble(cells, 0);
        assertEquals(1, a.sizeX);
        assertEquals(1, a.sizeY);
        assertEquals(1, a.sizeZ);
        JsonObject entry = a.structure.getAsJsonArray("blockPalette")
            .get(1)
            .getAsJsonObject();
        assertEquals(
            "LogisticsPipes:pipe.BasicLogisticsPipe",
            entry.get("registryId")
                .getAsString());
        assertEquals(
            0,
            entry.get("meta")
                .getAsInt());
        assertEquals(
            "BakedQuads",
            entry.get("renderMode")
                .getAsString());
        assertFalse(
            entry.get("occludesAdjacentFaces")
                .getAsBoolean());
        assertEquals(
            0,
            entry.getAsJsonArray("tooltip")
                .size());
    }

    @Test
    public void emptyCellsRejected() {
        try {
            CaptureDumpAssembler.assemble(new ArrayList<CellInput>(), 1);
            fail("空格集必须显式拒绝（无从推导 cellGrid 尺寸）");
        } catch (IllegalArgumentException expected) {
            // 预期
        }
        try {
            CaptureDumpAssembler.assemble(oneCellList(), -1);
            fail("负 margin 必须显式拒绝");
        } catch (IllegalArgumentException expected) {
            // 预期
        }
    }

    private static List<CellInput> oneCellList() {
        List<CellInput> cells = new ArrayList<CellInput>();
        cells.add(cell("pipe-1", "LogisticsPipes:pipe.BasicLogisticsPipe", 0, 65, 12, 64, oneQuad(65.0, 12.0, 64.0)));
        return cells;
    }

    @Test
    public void offCellGeometryIsReportedNotFixed() {
        // 相机相对系的窗口（如原版箱 TESR：渲染器内部自己加平移）落在块局部之外：如实记录，不修正
        Assembly a = assembleTwoCells(cameraRelativeQuad(), new ArrayList<CapturedQuad>());
        JsonObject diag = a.perCellQuads.get(0)
            .getAsJsonObject();
        assertFalse(
            diag.get("blockLocal")
                .getAsBoolean());
        assertEquals(
            0.0,
            diag.get("inUnitCubeRatio")
                .getAsDouble(),
            1e-9);
        assertEquals(
            "8,6,0",
            diag.getAsJsonArray("blockLocalBins")
                .get(0)
                .getAsString());
        // 几何仍原样写出（只搬运实录，不兜底、不修正）
        assertEquals(
            1,
            a.structure.getAsJsonArray("blockPalette")
                .get(1)
                .getAsJsonObject()
                .getAsJsonObject("geometry")
                .getAsJsonArray("quads")
                .size());
        assertNotNull(a.perCellQuads.get(0));
    }

    // ------------------------------------------------------------------ 摘要

    @Test
    public void sha256HexMatchesKnownVectors() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            CaptureDumpAssembler.sha256Hex(""));
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            CaptureDumpAssembler.sha256Hex("abc"));
        assertEquals(
            CaptureDumpAssembler.sha256Hex("abc"),
            CaptureDumpAssembler.sha256Hex("abc".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
}
