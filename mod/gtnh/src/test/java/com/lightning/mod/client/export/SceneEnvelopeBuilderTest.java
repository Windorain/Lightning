package com.lightning.mod.client.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.GZIPInputStream;

import org.junit.Test;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

/**
 * {@link SceneEnvelopeBuilder} 的纯 JVM 单测（#82 修复锁）：
 * frames 分支与非 frames 分支都搬运成对 idioms（{@code tooltipPalette} + {@code cellTooltipGrid}）；
 * 文档本来没有该字段时不凭空产出（{@code copyIfPresent} 字节干净）。
 * <p>
 * 修复前：frames 分支只搬 {@code tooltipPalette}，根级 {@code cellTooltipGrid} 在信封内整层丢失。
 */
public class SceneEnvelopeBuilderTest {

    private static final Gson GSON = new Gson();

    /** 解信封：payload = gzip+base64 的 inner JSON。 */
    private static JsonObject decodeInner(JsonObject envelope) throws Exception {
        assertEquals(
            "Envelope",
            envelope.get("documentFormat")
                .getAsString());
        assertEquals(
            "gzip+base64",
            envelope.get("payloadEncoding")
                .getAsString());
        byte[] gz = Base64.getDecoder()
            .decode(
                envelope.get("payload")
                    .getAsString());
        // JDK8 兼容：不用 InputStream.readAllBytes（Java 9+）
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(gz))) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = gis.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
        }
        return GSON.fromJson(new String(bos.toByteArray(), StandardCharsets.UTF_8), JsonObject.class);
    }

    private static JsonObject framesDoc(boolean withTooltips) {
        JsonObject doc = new JsonObject();
        doc.addProperty("id", "frames-doc");
        doc.add("frames", new com.google.gson.JsonArray());
        if (withTooltips) {
            com.google.gson.JsonArray pal = new com.google.gson.JsonArray();
            pal.add(new com.google.gson.JsonPrimitive("流体存储总线"));
            doc.add("tooltipPalette", pal);
            com.google.gson.JsonArray cell = new com.google.gson.JsonArray();
            com.google.gson.JsonArray row = new com.google.gson.JsonArray();
            row.add(new com.google.gson.JsonPrimitive(0));
            cell.add(row);
            com.google.gson.JsonArray slice = new com.google.gson.JsonArray();
            slice.add(cell);
            doc.add("cellTooltipGrid", slice);
        }
        return doc;
    }

    @Test
    public void framesBranchCarriesCellTooltipGrid() throws Exception {
        JsonObject env = SceneEnvelopeBuilder.toEnvelope(framesDoc(true));
        JsonObject inner = decodeInner(env);
        // #82 修复锁：成对 idioms 两个字段都进 inner（修复前只有 tooltipPalette）
        assertTrue(inner.has("tooltipPalette"));
        assertTrue("frames 分支必须搬运 cellTooltipGrid", inner.has("cellTooltipGrid"));
        assertEquals(
            0,
            inner.getAsJsonArray("cellTooltipGrid")
                .get(0)
                .getAsJsonArray()
                .get(0)
                .getAsJsonArray()
                .get(0)
                .getAsInt());
    }

    @Test
    public void framesBranchByteCleanWithoutTooltips() throws Exception {
        JsonObject env = SceneEnvelopeBuilder.toEnvelope(framesDoc(false));
        JsonObject inner = decodeInner(env);
        assertFalse("无成对 idioms 的文档不得凭空产出 tooltipPalette", inner.has("tooltipPalette"));
        assertFalse("无成对 idioms 的文档不得凭空产出 cellTooltipGrid", inner.has("cellTooltipGrid"));
    }

    @Test
    public void nonFramesBranchRegression() throws Exception {
        // 非 frames（baked/单一结构）分支：既有行为回归锁（该分支 :73 本就搬 cellTooltipGrid）
        JsonObject doc = new JsonObject();
        doc.addProperty("geometryPhase", "baked");
        doc.addProperty("id", "baked-doc");
        com.google.gson.JsonArray pal = new com.google.gson.JsonArray();
        doc.add("tooltipPalette", pal);
        com.google.gson.JsonArray grid = new com.google.gson.JsonArray();
        doc.add("cellTooltipGrid", grid);
        JsonObject inner = decodeInner(SceneEnvelopeBuilder.toEnvelope(doc));
        assertTrue(inner.has("tooltipPalette"));
        assertTrue(inner.has("cellTooltipGrid"));
    }
}
