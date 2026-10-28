package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

/**
 * 条目内四边形精确去重（捕获兜底）的判据。
 *
 * <p>
 * 起点是一个结构性事实：一个 {@code CapturedBlockInstance} 的顶点流由「{@code beginBlock} → 该格全部渲染阶段
 * → {@code endBlock}」一次收齐，因此两个渲染 pass 都合法、且画出同一套几何的方块会把同一套面录进
 * <b>同一条目内部</b>——跨格签名（整格几何一个签名）看不到它，导出件因此体积翻倍、半透明面双重混合。
 *
 * <p>
 * 判据分四块：
 *
 * <ol>
 * <li><b>正例走生产装配</b>：用真实录窗 API 录同一格的两轮几何，再经场景导出烘焙的条目几何入口
 * （{@link MeshCaptureService#exportEntryGeometry}）产出——即落盘前的同一条路径——断言重复片被抑制、且
 * 保留下来的是<b>首个</b>那一片；</li>
 * <li><b>负对照一律保留</b>：不同材质、UV 差 1e-5、亮度/颜色不同、顶点绕序不同、位置不同，以及
 * <b>键集超出判等闭集</b>（quad 附加键 / 顶点附加键）、<b>分数字段</b>、<b>畸形数值</b>；</li>
 * <li><b>生产形状漂移棘轮</b>：真实写端产出的 quad/顶点键集必须<b>恰好</b>等于判等端声明的闭集——
 * 写端将来加字段而判等端没跟上，这里判红；</li>
 * <li><b>作用面锁定</b>：同一份捕获实例，变体数据集通道（{@code CaptureToolkit.geometryOf}）保留重复片
 * （它的口径是「如实全量」），只有场景导出条目几何才抑制。</li>
 * </ol>
 */
public class CaptureQuadDedupTest {

    private static final int GL_QUADS = 7;

    /** 一轮四顶点 = 一片四边形：入参是世界坐标 + UV 起点（tessOffset 恒 0）。 */
    private static void recordQuad(double wx, double wy, double wz, double u0, double v0, int brightness, int color) {
        double[][] locals = { { 0.0, 0.0 }, { 1.0, 0.0 }, { 1.0, 1.0 }, { 0.0, 1.0 } };
        for (int i = 0; i < locals.length; i++) {
            TessellatorCaptureState.onVertexRecorded(
                wx + locals[i][0],
                wy + locals[i][1],
                wz,
                u0 + locals[i][0],
                v0 + locals[i][1],
                brightness,
                color,
                0,
                0,
                0,
                GL_QUADS);
        }
    }

    @Before
    public void setUp() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
        CaptureDiagnostics.resetForTesting(true);
    }

    @After
    public void tearDown() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
        CaptureDiagnostics.resetForTesting(false);
    }

    /**
     * 在真实的逐格录窗里录一个方块格。每个元素是一轮四顶点的参数
     * {@code {wx, wy, wz, u0, v0, brightness, color}}；返回该格实例（与生产路径同形）。
     */
    private static CapturedBlockInstance captureOneCell(double[]... rounds) {
        TessellatorCaptureState.beginBlock(0, 0, 0, "cell", 10, 64, -3, null, 0, 0, "minecraft:stone");
        for (int i = 0; i < rounds.length; i++) {
            double[] q = rounds[i];
            recordQuad(q[0], q[1], q[2], q[3], q[4], (int) q[5], (int) q[6]);
        }
        CapturedBlockInstance inst = new CapturedBlockInstance();
        TessellatorCaptureState.endBlock(inst);
        return inst;
    }

    private static int quadCount(JsonObject geometry) {
        JsonArray quads = geometry.getAsJsonArray("quads");
        return quads == null ? 0 : quads.size();
    }

    private static JsonObject quadAt(JsonObject geometry, int i) {
        return geometry.getAsJsonArray("quads")
            .get(i)
            .getAsJsonObject();
    }

    private static double vertexField(JsonObject quad, int vertexIndex, String field) {
        return quad.getAsJsonArray("vertices")
            .get(vertexIndex)
            .getAsJsonObject()
            .get(field)
            .getAsDouble();
    }

    private static Set<String> keysOf(JsonObject o) {
        Set<String> keys = new HashSet<String>();
        for (java.util.Map.Entry<String, JsonElement> e : o.entrySet()) {
            keys.add(e.getKey());
        }
        return keys;
    }

    // ------------------------------------------------------------------ 正例（走生产装配）

    /** 同一格两轮画出同一套几何 ⇒ 条目里只剩一片，且留下的就是第一片。 */
    @Test
    public void twoPassSameGeometryIsSuppressedAndTheFirstIsKept() {
        double[] face = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        CapturedBlockInstance twice = captureOneCell(face, face);
        assertEquals("前提：录窗确实把两轮几何收进了同一个实例（这是缺陷的结构来源）", 2, twice.quads.size());

        JsonObject deduped = MeshCaptureService.exportEntryGeometry(twice, null);
        assertEquals("条目内重复片必须被抑制到只剩一片", 1, quadCount(deduped));

        JsonObject single = MeshCaptureService.exportEntryGeometry(captureOneCell(face), null);
        assertEquals(1, quadCount(single));
        assertEquals(
            "抑制后的几何必须与单轮录制的几何同内容签名",
            MeshCaptureService.CaptureToolkit.signatureOfGeometry(single),
            MeshCaptureService.CaptureToolkit.signatureOfGeometry(deduped));
        assertEquals("顶点与材质字段必须原样保留（不量化、不排序）", quadAt(single, 0).toString(), quadAt(deduped, 0).toString());
    }

    /** 幂等：已经去重过的几何再走一遍不产生任何改动（返回 0 = 零抑制）。 */
    @Test
    public void dedupIsIdempotent() {
        double[] face = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        JsonObject geometry = MeshCaptureService.exportEntryGeometry(captureOneCell(face, face, face), null);
        assertEquals(1, quadCount(geometry));
        String before = geometry.toString();
        assertEquals(0, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(before, geometry.toString());
    }

    /** 负对照：顶点完全相同、材质下标不同的两片必须都保留——不同材质不是重复。 */
    @Test
    public void quadsWithDifferentMaterialAreBothKept() {
        double[] face = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        CapturedBlockInstance inst = captureOneCell(face, face);
        CapturedQuad second = inst.quads.get(1);
        second.samplerIndex = 7;
        assertEquals("不同材质的同形片必须都保留", 2, quadCount(MeshCaptureService.exportEntryGeometry(inst, null)));
    }

    /** 负对照：UV 只差 1e-5 的两片必须都保留（跨格签名会把它们量化成同一个值 ⇒ 不能用它判重）。 */
    @Test
    public void nearDuplicateUvIsNotSuppressed() {
        CapturedBlockInstance inst = captureOneCell(
            new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF },
            new double[] { 10.0, 64.0, -3.0, 0.00001, 0.0, 240, 0xFFFFFFFF });
        assertEquals(2, inst.quads.size());
        assertEquals(
            "量化到 4 位小数的跨格签名会把这两片视为同一几何，条目内判重必须保留两片",
            2,
            quadCount(MeshCaptureService.exportEntryGeometry(inst, null)));
    }

    /** 负对照：亮度差 1、颜色差 1 的两片必须都保留。 */
    @Test
    public void differentBrightnessOrColorIsNotSuppressed() {
        assertEquals(
            "亮度差 1 不是重复",
            2,
            quadCount(
                MeshCaptureService.exportEntryGeometry(
                    captureOneCell(
                        new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF },
                        new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 241, 0xFFFFFFFF }),
                    null)));
        assertEquals(
            "颜色差 1 不是重复",
            2,
            quadCount(
                MeshCaptureService.exportEntryGeometry(
                    captureOneCell(
                        new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF },
                        new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFE }),
                    null)));
    }

    /** 负对照：同一组顶点、不同顶点顺序（另一套绕序）不是重复——判重不做四边形内排序。 */
    @Test
    public void rotatedVertexOrderIsNotSuppressed() {
        TessellatorCaptureState.beginBlock(0, 0, 0, "cell", 10, 64, -3, null, 0, 0, "minecraft:stone");
        recordQuad(10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF);
        // 同一组四个顶点，绕序整体旋转一位（起点从 (0,0) 变成 (1,0)）
        TessellatorCaptureState.onVertexRecorded(11.0, 64.0, -3.0, 1.0, 0.0, 240, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(11.0, 65.0, -3.0, 1.0, 1.0, 240, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(10.0, 65.0, -3.0, 0.0, 1.0, 240, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        CapturedBlockInstance inst = new CapturedBlockInstance();
        TessellatorCaptureState.endBlock(inst);
        assertEquals(2, inst.quads.size());
        assertEquals("顶点顺序不同的两片必须都保留（判重不得重排顶点）", 2, quadCount(MeshCaptureService.exportEntryGeometry(inst, null)));
    }

    /** 负对照：位置不同的两片（同材质、同 UV、同亮度）都保留——只有真正重合的才算重复。 */
    @Test
    public void differentPositionsAreNotSuppressed() {
        CapturedBlockInstance inst = captureOneCell(
            new double[] { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF },
            new double[] { 10.0, 65.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF });
        assertEquals(2, quadCount(MeshCaptureService.exportEntryGeometry(inst, null)));
    }

    /**
     * 顺序与「保留首个」：三轮里第一轮与第三轮完全相同 ⇒ 剩两片，第一片是 a、第二片仍是 b
     * （去重不得改变其余片的相对顺序，否则法线/材质顺位会漂移）。
     */
    @Test
    public void keepsFirstOccurrenceAndPreservesRelativeOrder() {
        double[] a = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        double[] b = { 10.0, 64.0, -3.0, 0.0, 1.0, 240, 0xFFFFFFFF };
        CapturedBlockInstance inst = captureOneCell(a, b, a);
        assertEquals(3, inst.quads.size());

        JsonObject geometry = MeshCaptureService.exportEntryGeometry(inst, null);
        assertEquals(2, quadCount(geometry));
        assertEquals("保留的必须是首个 a（v 起点 0）", 0.0, vertexField(quadAt(geometry, 0), 0, "v"), 0.0);
        assertEquals("b 的相对位置不变（仍在 a 之后）", 1.0, vertexField(quadAt(geometry, 1), 0, "v"), 0.0);
    }

    // ------------------------------------------------------------------ 保守策略（键集 / 数值形态）

    /** 判等只认闭集内的键：quad 多一个键 ⇒ 整份几何放行（两片都留），且不改动几何。 */
    @Test
    public void extraQuadKeyDisablesDeduplication() {
        JsonObject geometry = exactPairGeometry();
        // 给两片同时加同一个附加键：几何仍然"看起来重复"，但判等端不认识该键 ⇒ 必须放行
        for (int i = 0; i < 2; i++) {
            quadAt(geometry, i).addProperty("tint", 3);
        }
        String before = geometry.toString();
        assertEquals("键集超出闭集 ⇒ 不得抑制", 0, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(2, quadCount(geometry));
        assertEquals("放行时不得改动几何", before, geometry.toString());
    }

    /** 顶点多一个键 ⇒ 同样放行。 */
    @Test
    public void extraVertexKeyDisablesDeduplication() {
        JsonObject geometry = exactPairGeometry();
        for (int i = 0; i < 2; i++) {
            for (int v = 0; v < 4; v++) {
                quadAt(geometry, i).getAsJsonArray("vertices")
                    .get(v)
                    .getAsJsonObject()
                    .addProperty("w", 1.0);
            }
        }
        assertEquals("顶点键集超出闭集 ⇒ 不得抑制", 0, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(2, quadCount(geometry));
    }

    /** 整数字段写成小数（哪怕是相同的小数）⇒ 无法判等 ⇒ 放行（getAsLong 截断会误压）。 */
    @Test
    public void fractionalIntegerFieldDisablesDeduplication() {
        JsonObject brightness = exactPairGeometry();
        for (int i = 0; i < 2; i++) {
            for (int v = 0; v < 4; v++) {
                quadAt(brightness, i).getAsJsonArray("vertices")
                    .get(v)
                    .getAsJsonObject()
                    .addProperty("brightness", 240.5d);
            }
        }
        assertEquals("分数亮度无法精确判等 ⇒ 放行", 0, CaptureQuadDedup.suppressExactDuplicates(brightness));
        assertEquals(2, quadCount(brightness));

        JsonObject material = exactPairGeometry();
        for (int i = 0; i < 2; i++) {
            quadAt(material, i).addProperty("materialIndex", 1.5d);
        }
        assertEquals("分数材质下标无法精确判等 ⇒ 放行", 0, CaptureQuadDedup.suppressExactDuplicates(material));
        assertEquals(2, quadCount(material));
    }

    /** 畸形数值（非数字/不可解析）⇒ 不抛异常、不放压、几何逐字节不变。 */
    @Test
    public void malformedNumericNeverThrowsAndNeverSuppresses() {
        JsonObject geometry = exactPairGeometry();
        for (int i = 0; i < 2; i++) {
            quadAt(geometry, i).getAsJsonArray("vertices")
                .get(0)
                .getAsJsonObject()
                .addProperty("x", "not-a-number");
        }
        String before = geometry.toString();
        assertEquals("畸形数值 ⇒ 放行", 0, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(before, geometry.toString());

        // 非对象四边形 / quads 不是数组 / 缺字段：全部放行，且不抛
        JsonObject quadsNotArray = new JsonObject();
        quadsNotArray.addProperty("quads", "oops");
        assertEquals(0, CaptureQuadDedup.suppressExactDuplicates(quadsNotArray));

        JsonObject missingField = new JsonParser()
            .parse(
                "{\"quads\":[{\"materialIndex\":0,\"vertices\":[{\"x\":0}]},"
                    + "{\"materialIndex\":0,\"vertices\":[{\"x\":0}]}]}")
            .getAsJsonObject();
        assertEquals("缺字段 ⇒ 放行", 0, CaptureQuadDedup.suppressExactDuplicates(missingField));
        assertEquals(
            2,
            missingField.getAsJsonArray("quads")
                .size());

        assertEquals(0, CaptureQuadDedup.suppressExactDuplicates(null));
        JsonObject noQuads = new JsonObject();
        noQuads.addProperty("encoding", "bakedQuadsJsonV1");
        assertEquals(0, CaptureQuadDedup.suppressExactDuplicates(noQuads));
    }

    /** 正常同形两片仍必须被压：证明上面那些「放行」不是因为判据整体失效（负对照的反面）。 */
    @Test
    public void wellFormedDuplicatesAreStillSuppressed() {
        JsonObject geometry = exactPairGeometry();
        assertEquals("同形两片 ⇒ 压一片", 1, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(1, quadCount(geometry));
    }

    /** 手写一对"完全同形"的四边形（键集恰为判等闭集）。 */
    private static JsonObject exactPairGeometry() {
        String quad = "{\"materialIndex\":3,\"vertices\":["
            + "{\"x\":0.5,\"y\":0,\"z\":1,\"u\":0,\"v\":0,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":0.5,\"y\":0,\"z\":1,\"u\":1,\"v\":0,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":1,\"y\":1,\"z\":1,\"u\":1,\"v\":1,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":0,\"y\":1,\"z\":1,\"u\":0,\"v\":1,\"brightness\":240,\"color\":16777215}]}";
        return new JsonParser().parse("{\"quads\":[" + quad + "," + quad + "]}")
            .getAsJsonObject();
    }

    /** 纯函数判据（不经录窗）：完全相同的两片被抑制；仅坐标为 -0.0/0.5 的两片按原文判为不同 ⇒ 保留。 */
    @Test
    public void exactDuplicateSuppressedButSignedZeroKept() {
        String quad = "{\"materialIndex\":3,\"vertices\":["
            + "{\"x\":0.5,\"y\":0,\"z\":1,\"u\":0,\"v\":0,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":0.5,\"y\":0,\"z\":1,\"u\":1,\"v\":0,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":1,\"y\":1,\"z\":1,\"u\":1,\"v\":1,\"brightness\":240,\"color\":16777215},"
            + "{\"x\":0,\"y\":1,\"z\":1,\"u\":0,\"v\":1,\"brightness\":240,\"color\":16777215}]}";
        String negZeroQuad = quad.replaceAll("\"x\":0\\.5", "\"x\":-0.0");
        JsonObject geometry = new JsonParser().parse("{\"quads\":[" + quad + "," + quad + "," + negZeroQuad + "]}")
            .getAsJsonObject();
        assertEquals("两片完全相同 ⇒ 抑制一片", 1, CaptureQuadDedup.suppressExactDuplicates(geometry));
        assertEquals(
            "剩下的两片是「首个 quad」与「-0.0 那片」",
            2,
            geometry.getAsJsonArray("quads")
                .size());
        assertEquals(0.5, vertexField(quadAt(geometry, 0), 0, "x"), 0.0);
        assertEquals(-0.0, vertexField(quadAt(geometry, 1), 0, "x"), 0.0);
    }

    // ------------------------------------------------------------------ 棘轮

    /**
     * <b>生产形状漂移棘轮</b>：真实写端（{@code exportEntryGeometry} → {@code bakedQuadsGeometryFromCapture}）
     * 产出的 quad / 顶点键集必须<b>恰好</b>等于判等端声明的闭集。
     *
     * <p>
     * 为什么必须有它：判等端对"键集超出闭集"是故意放行的（保守方向），于是写端加字段**不会**让任何行为测试
     * 变红——去重会静默退化成空转。这条棘轮把"写端形状 = 判等端认识的形状"变成可判红的事实。
     */
    @Test
    public void productionWriterShapeMatchesTheSupportedClosedSet() {
        double[] face = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        // 两片互不相同的几何：这样条目里会留下**多片**，可以逐片逐顶点检查（不是只看第 0 片）
        double[] other = { 10.0, 65.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        JsonObject geometry = MeshCaptureService.exportEntryGeometry(captureOneCell(face, other), null);
        assertEquals("前提：写端确实产出了多片几何（逐片检查才有意义）", 2, quadCount(geometry));

        int checkedVertices = 0;
        for (int qi = 0; qi < quadCount(geometry); qi++) {
            JsonObject quad = quadAt(geometry, qi);
            assertEquals(
                "写端 quad 键集必须恰等于判等端闭集（写端加字段 ⇒ 这里红，判等端必须跟上）：第 " + qi + " 片",
                CaptureQuadDedup.supportedQuadKeys(),
                keysOf(quad));
            JsonArray verts = quad.getAsJsonArray("vertices");
            assertTrue("前提：每片都有顶点", verts.size() > 0);
            for (int vi = 0; vi < verts.size(); vi++) {
                assertEquals(
                    "写端顶点键集必须恰等于判等端闭集（写端加字段 ⇒ 这里红）：第 " + qi + " 片第 " + vi + " 个顶点",
                    CaptureQuadDedup.supportedVertexKeys(),
                    keysOf(
                        verts.get(vi)
                            .getAsJsonObject()));
                checkedVertices++;
            }
        }
        assertEquals("必须真的检查到全部顶点（防条件性加字段漏检）", 8, checkedVertices);

        // 闭集不能是空壳：真实写端产出在这个形状上确实能被判等去重
        CapturedBlockInstance twice = captureOneCell(face, face);
        assertEquals(
            "在写端真实形状上，重复片必须真的被抑制（否则「闭集对上了但判据空转」）",
            1,
            quadCount(MeshCaptureService.exportEntryGeometry(twice, null)));
    }

    /**
     * 作用面锁定：同一份捕获实例，变体数据集通道（{@code CaptureToolkit.geometryOf}）**保留**重复片，
     * 只有场景导出条目几何（{@code exportEntryGeometry}）抑制——两者口径不同是刻意的。
     */
    @Test
    public void variantDatasetKeepsDuplicatesWhileExportDedupes() {
        double[] face = { 10.0, 64.0, -3.0, 0.0, 0.0, 240, 0xFFFFFFFF };
        CapturedBlockInstance inst = captureOneCell(face, face);

        JsonObject variantGeometry = MeshCaptureService.CaptureToolkit.geometryOf(inst);
        assertEquals("变体数据集口径是「如实全量」⇒ 重复片保留", 2, quadCount(variantGeometry));

        JsonObject exportGeometry = MeshCaptureService.exportEntryGeometry(inst, null);
        assertEquals("场景导出条目几何 ⇒ 重复片抑制", 1, quadCount(exportGeometry));

        assertTrue(
            "两条通道产出的第一片内容必须一致（去重不改变保留下来的几何）",
            quadAt(variantGeometry, 0).toString()
                .equals(quadAt(exportGeometry, 0).toString()));
    }
}
