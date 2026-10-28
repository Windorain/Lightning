package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * {@link ExportSceneWriter} 的形态口径与确定性。
 *
 * <p>
 * 本测试锁三件事：
 *
 * <ol>
 * <li><b>形态口径唯一（形态统一）</b>：{@code world} 形态下<b>单帧即 N=1 的多帧文档</b>
 * ——两种形态因此是同一种文件；{@code auto} 保留既有隐函数（命令通道逐字节兼容用）；
 * {@code structure} 只允许单帧；</li>
 * <li><b>确定性（A3 口径）</b>：同一输入两次合并得到<b>逐字节相同</b>的字节——不写时间戳、
 * 不写绝对路径、帧序按帧号升序与录制顺序无关；</li>
 * <li><b>provenance 的取舍</b>：命令通道不传 ⇒ 产物正文<b>不含</b> provenance/exportId
 * （既有产物逐字节不变）；cp 通道传 ⇒ 出现在正确的位置（World 形态的 frames[] 与根）。</li>
 * </ol>
 */
public class ExportSceneWriterTest {

    private static Map<Integer, String> frames(int... indexes) {
        Map<Integer, String> m = new TreeMap<Integer, String>();
        for (int i : indexes) {
            m.put(Integer.valueOf(i), "{\"geometryPhase\":\"scan\",\"id\":\"s" + i + "\",\"cellGrid\":[[[0]]]}");
        }
        return m;
    }

    private static ExportSceneWriter.Meta meta() {
        ExportSceneWriter.Meta m = new ExportSceneWriter.Meta();
        m.structureId = "structuredata.exported";
        m.label = "structuredata.exported";
        m.author = "tester";
        m.gtnhVersion = "2.7.0";
        return m;
    }

    /** 单帧 + world 形态 ⇒ 多帧文档（frames[] 长度 1）——这是形态统一的口径。 */
    @Test
    public void worldShapeWritesSingleFrameAsOneFrameDocument() {
        JsonObject doc = ExportSceneWriter.buildDocument(meta(), frames(0), ExportSceneWriter.Shape.WORLD, null, null);
        assertTrue("world 形态必须有 frames[]", doc.has("frames"));
        JsonArray fr = doc.getAsJsonArray("frames");
        assertEquals("单帧即 N=1 的多帧文档", 1, fr.size());
        assertEquals(
            0,
            fr.get(0)
                .getAsJsonObject()
                .get("index")
                .getAsInt());
        assertTrue(
            "每帧必须内嵌 structure",
            fr.get(0)
                .getAsJsonObject()
                .has("structure"));
        assertTrue("playback 必须在", doc.has("playback"));
        assertFalse(
            "playback.loop 是既定事实 false",
            doc.getAsJsonObject("playback")
                .get("loop")
                .getAsBoolean());
    }

    /** auto 形态保留既有隐函数：{0} → 裸单结构；{5} → World 多帧。 */
    @Test
    public void autoShapePreservesLegacyImplicitBranch() {
        JsonObject single = ExportSceneWriter
            .buildDocument(meta(), frames(0), ExportSceneWriter.Shape.AUTO, null, null);
        assertFalse("{0} + auto ⇒ 裸单结构（无 frames）", single.has("frames"));
        assertEquals(
            "scan",
            single.get("geometryPhase")
                .getAsString());

        JsonObject other = ExportSceneWriter.buildDocument(meta(), frames(5), ExportSceneWriter.Shape.AUTO, null, null);
        assertTrue("{5} + auto ⇒ World 多帧（既有隐函数的形态分叉，本测试把它钉死）", other.has("frames"));

        JsonObject two = ExportSceneWriter
            .buildDocument(meta(), frames(0, 1), ExportSceneWriter.Shape.AUTO, null, null);
        assertTrue("两帧 + auto ⇒ World", two.has("frames"));
    }

    /** structure 形态只允许单帧；多帧必须显式报错（不隐式降级成 world）。 */
    @Test
    public void structureShapeRejectsMultipleFrames() {
        try {
            ExportSceneWriter.buildDocument(meta(), frames(0, 1), ExportSceneWriter.Shape.STRUCTURE, null, null);
            fail("多帧 + structure 应当抛 IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertTrue(
                "错误信息应说明为何不允许: " + expected.getMessage(),
                expected.getMessage()
                    .contains("恰好一帧"));
        }
        JsonObject one = ExportSceneWriter
            .buildDocument(meta(), frames(7), ExportSceneWriter.Shape.STRUCTURE, null, null);
        assertFalse("structure 形态必须是裸结构（无 frames）", one.has("frames"));
    }

    /** 空帧集必须报错，不产出一份空文档。 */
    @Test
    public void emptyFramesRejected() {
        try {
            ExportSceneWriter
                .buildDocument(meta(), new LinkedHashMap<Integer, String>(), ExportSceneWriter.Shape.WORLD, null, null);
            fail("空帧集应当抛 IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertTrue(
                expected.getMessage(),
                expected.getMessage()
                    .contains("无缓冲数据"));
        }
    }

    /**
     * 确定性：同一输入两次合并 → 逐字节相同。
     *
     * <p>
     * 这是 A3「同一固定程序执行两次，产物结构一致」在<b>单次合并</b>这一层的最小判据。
     * 若将来有人往文档正文里写时间戳或绝对路径，本测试会立刻变红。
     */
    @Test
    public void sameInputYieldsByteIdenticalDocument() {
        Map<Integer, String> input = frames(0, 3, 9);
        JsonObject a = ExportSceneWriter.buildDocument(meta(), input, ExportSceneWriter.Shape.WORLD, null, null);
        // 故意换一个迭代顺序的等价 map：TreeMap 语义保证产物帧序按帧号升序，与录制/迭代顺序无关
        Map<Integer, String> shuffled = new LinkedHashMap<Integer, String>();
        shuffled.put(Integer.valueOf(9), input.get(Integer.valueOf(9)));
        shuffled.put(Integer.valueOf(0), input.get(Integer.valueOf(0)));
        shuffled.put(Integer.valueOf(3), input.get(Integer.valueOf(3)));
        JsonObject b = ExportSceneWriter.buildDocument(meta(), shuffled, ExportSceneWriter.Shape.WORLD, null, null);

        String sa = ExportSceneWriter.compact(a);
        String sb = ExportSceneWriter.compact(b);
        assertEquals("同一帧集（不同迭代顺序）必须得到逐字节相同的文档", sa, sb);

        JsonArray fr = a.getAsJsonArray("frames");
        assertEquals(3, fr.size());
        assertEquals(
            "帧序必须是帧号升序（TreeMap 语义），与录制顺序无关",
            0,
            fr.get(0)
                .getAsJsonObject()
                .get("index")
                .getAsInt());
        assertEquals(
            3,
            fr.get(1)
                .getAsJsonObject()
                .get("index")
                .getAsInt());
        assertEquals(
            9,
            fr.get(2)
                .getAsJsonObject()
                .get("index")
                .getAsInt());
    }

    /** 命令通道不传 provenance ⇒ 正文不含 provenance/exportId（既有产物逐字节不变的前提）。 */
    @Test
    public void legacyPathWritesNoProvenance() {
        JsonObject doc = ExportSceneWriter
            .buildDocument(meta(), frames(0, 1), ExportSceneWriter.Shape.AUTO, null, null);
        assertFalse("命令通道产物不得含 provenance", doc.has(ExportSceneWriter.FIELD_PROVENANCE));
        assertFalse("命令通道产物不得含 exportId", doc.has(ExportSceneWriter.FIELD_EXPORT_ID));
        for (int i = 0; i < doc.getAsJsonArray("frames")
            .size(); i++) {
            assertFalse(
                "帧内也不得含 exportId",
                doc.getAsJsonArray("frames")
                    .get(i)
                    .getAsJsonObject()
                    .has(ExportSceneWriter.FIELD_EXPORT_ID));
        }
    }

    /** cp 通道传 provenance ⇒ World 形态进根、帧内带 exportId（「同会话同缓冲」判据读这两处）。 */
    @Test
    public void cpPathWritesProvenanceAndPerFrameExportId() {
        JsonObject prov = ExportSceneWriter.provenance(
            "run-1#demo",
            "run-1",
            ExportSceneWriter.Shape.WORLD,
            7L,
            new int[] { 0, 1 },
            new String[] { "aa", "bb" },
            true,
            null);
        JsonObject doc = ExportSceneWriter
            .buildDocument(meta(), frames(0, 1), ExportSceneWriter.Shape.WORLD, prov, "run-1#demo");
        assertTrue("World 形态的 provenance 在根上", doc.has(ExportSceneWriter.FIELD_PROVENANCE));
        JsonObject p = doc.getAsJsonObject(ExportSceneWriter.FIELD_PROVENANCE);
        assertEquals(
            "run-1#demo",
            p.get("exportId")
                .getAsString());
        assertEquals(
            7L,
            p.get("bufferGeneration")
                .getAsLong());
        assertEquals(
            "aa",
            p.getAsJsonObject("frameSha256")
                .get("0")
                .getAsString());
        assertEquals(
            "bb",
            p.getAsJsonObject("frameSha256")
                .get("1")
                .getAsString());
        for (int i = 0; i < doc.getAsJsonArray("frames")
            .size(); i++) {
            assertEquals(
                "每帧的 exportId 必须一致——C3 判据据此发现跨次拼接",
                "run-1#demo",
                doc.getAsJsonArray("frames")
                    .get(i)
                    .getAsJsonObject()
                    .get(ExportSceneWriter.FIELD_EXPORT_ID)
                    .getAsString());
        }
    }

    /** Envelope 化后的 inner 必须含 frames 与 provenance（否则消费方解包后看不到「同会话同缓冲」判据）。 */
    @Test
    public void envelopeKeepsFramesAndProvenance() throws Exception {
        JsonObject prov = ExportSceneWriter.provenance(
            "run-2#x",
            "run-2",
            ExportSceneWriter.Shape.WORLD,
            1L,
            new int[] { 0 },
            new String[] { "h" },
            false,
            null);
        JsonObject doc = ExportSceneWriter
            .buildDocument(meta(), frames(0), ExportSceneWriter.Shape.WORLD, prov, "run-2#x");
        byte[] bytes = ExportSceneWriter.serialize(doc, false);
        JsonObject env = new JsonParser().parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8))
            .getAsJsonObject();
        assertEquals(
            "Envelope",
            env.get("documentFormat")
                .getAsString());
        assertEquals(
            "gzip+base64",
            env.get("payloadEncoding")
                .getAsString());
        JsonObject metaObj = env.getAsJsonObject("meta");
        assertTrue("provenance 必须随 meta 走（否则解包后看不到 C3 判据）", metaObj.has("provenance"));
        assertEquals(
            "run-2#x",
            metaObj.get("exportId")
                .getAsString());

        // 解包 payload，验证 frames 在里面
        byte[] gz = java.util.Base64.getDecoder()
            .decode(
                env.get("payload")
                    .getAsString());
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try (java.util.zip.GZIPInputStream in = new java.util.zip.GZIPInputStream(
            new java.io.ByteArrayInputStream(gz))) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                bos.write(buf, 0, n);
            }
        }
        JsonObject inner = new JsonParser()
            .parse(new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8))
            .getAsJsonObject();
        assertTrue("frames 必须在 inner 里", inner.has("frames"));
        assertEquals(
            1,
            inner.getAsJsonArray("frames")
                .size());
    }

    /** 明文形态：documentFormat:Plain，且根上保留 provenance。 */
    @Test
    public void plainShapeCarriesDocumentFormatAndProvenance() throws Exception {
        JsonObject prov = ExportSceneWriter.provenance(
            "r#n",
            "r",
            ExportSceneWriter.Shape.STRUCTURE,
            3L,
            new int[] { 0 },
            new String[] { "z" },
            true,
            null);
        JsonObject doc = ExportSceneWriter
            .buildDocument(meta(), frames(0), ExportSceneWriter.Shape.STRUCTURE, prov, "r#n");
        byte[] bytes = ExportSceneWriter.serialize(doc, true);
        JsonObject plain = new JsonParser().parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8))
            .getAsJsonObject();
        assertEquals(
            "Plain",
            plain.get("documentFormat")
                .getAsString());
        assertTrue("裸结构形态的 provenance 在根上", plain.has("provenance"));
        assertEquals(
            "r#n",
            plain.get("exportId")
                .getAsString());
        assertNull("裸结构形态没有 meta 包装", plain.get("meta"));
    }

    /** 形态名解析：大小写不敏感、未知返回 null（不静默落到默认值）。 */
    @Test
    public void shapeParseIsStrictAboutUnknownValues() {
        assertEquals(ExportSceneWriter.Shape.WORLD, ExportSceneWriter.Shape.parse("WORLD"));
        assertEquals(ExportSceneWriter.Shape.STRUCTURE, ExportSceneWriter.Shape.parse(" structure "));
        assertEquals(ExportSceneWriter.Shape.AUTO, ExportSceneWriter.Shape.parse("auto"));
        assertNull("未知取值必须返回 null（调用方报 CP-VALID-002），不得静默用默认值", ExportSceneWriter.Shape.parse("frames"));
        assertNotNull(ExportSceneWriter.Shape.choices());
        assertTrue(
            ExportSceneWriter.Shape.choices()
                .contains("world"));
    }

    /** 写盘：目录不存在时自建；返回实际路径；文件名带 .json 后缀。 */
    @Test
    public void writeToCreatesDirectoryAndAppendsJsonSuffix() throws Exception {
        java.nio.file.Path tmp = java.nio.file.Files.createTempDirectory("sde-export-writer");
        try {
            java.io.File outDir = new java.io.File(tmp.toFile(), "nested/export");
            java.io.File written = ExportSceneWriter
                .writeTo(outDir, "demo", "{\"a\":1}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertTrue(written.isFile());
            assertEquals("demo.json", written.getName());
            assertEquals(
                "{\"a\":1}",
                new String(
                    java.nio.file.Files.readAllBytes(written.toPath()),
                    java.nio.charset.StandardCharsets.UTF_8));
        } finally {
            deleteRecursively(tmp.toFile());
        }
    }

    private static void deleteRecursively(java.io.File f) {
        java.io.File[] kids = f.listFiles();
        if (kids != null) {
            for (java.io.File k : kids) {
                deleteRecursively(k);
            }
        }
        // 尽力清理；失败不影响测试结论
        f.delete();
    }
}
