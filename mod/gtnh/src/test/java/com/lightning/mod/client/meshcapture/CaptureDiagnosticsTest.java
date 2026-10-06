package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * {@link CaptureDiagnostics}：收集语义 + 诊断 JSON 结构（写出 → 读回断言字段）。
 * gson 只用 2.2.4 兼容 API（JsonParser().parse / JsonObject.get / JsonArray.get）。
 */
public class CaptureDiagnosticsTest {

    @Before
    public void setUp() {
        CaptureDiagnostics.resetForTesting(true);
    }

    @After
    public void tearDown() {
        CaptureDiagnostics.resetForTesting(false);
    }

    @Test
    public void collectsWindowEventsAndZeroFlow() {
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest", 0);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest", 7);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.BLOCK_COMPILE, 0, 0, 0, "chunk(0,0)", 42);

        JsonObject root = CaptureDiagnostics.toJson();
        assertEquals(
            CaptureDiagnostics.SCHEMA,
            root.get("schema")
                .getAsString());
        JsonObject tesr = root.getAsJsonObject("channels")
            .getAsJsonObject("TESR");
        assertEquals(
            2,
            tesr.get("windows")
                .getAsInt());
        assertEquals(
            7,
            tesr.get("quads")
                .getAsInt());
        assertEquals(
            1,
            tesr.get("zeroFlowWindows")
                .getAsInt());

        JsonArray events = root.getAsJsonArray("windowEvents");
        assertEquals(3, events.size());
        JsonObject e0 = events.get(0)
            .getAsJsonObject();
        assertEquals(
            "TESR",
            e0.get("channel")
                .getAsString());
        assertEquals(
            10,
            e0.get("attrX")
                .getAsInt());
        assertEquals(
            -3,
            e0.get("attrZ")
                .getAsInt());
        assertTrue(
            e0.get("zeroFlow")
                .getAsBoolean());
        assertEquals(
            "TileEntityChest",
            e0.get("tag")
                .getAsString());
    }

    @Test
    public void aggregatesQuadsByAttrAndBin() {
        CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 1, 2, 3, 1, 2, 3, false);
        CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 1, 2, 3, 4, 2, 3, true);
        CaptureDiagnostics.noteQuad(CaptureChannel.BLOCK_COMPILE, 0, 0, 0, 1, 2, 3, false);

        JsonObject root = CaptureDiagnostics.toJson();
        JsonArray byAttr = root.getAsJsonArray("quadsByAttr");
        assertEquals(2, byAttr.size());
        JsonObject first = byAttr.get(0)
            .getAsJsonObject();
        assertEquals(
            "TESR",
            first.get("channel")
                .getAsString());
        assertEquals(
            1,
            first.get("x")
                .getAsInt());
        assertEquals(
            2,
            first.get("quads")
                .getAsInt());

        JsonArray byBin = root.getAsJsonArray("quadsByBin");
        assertEquals(3, byBin.size());
        assertEquals(
            1,
            root.get("crossBinQuads")
                .getAsInt());
    }

    @Test
    public void directTessellatorHookSelfCheck() {
        assertFalse(CaptureDiagnostics.isDirectTessellatorHookEverSeen());
        CaptureDiagnostics.noteDirectTessellatorVertex();
        assertTrue(CaptureDiagnostics.isDirectTessellatorHookEverSeen());
        JsonObject root = CaptureDiagnostics.toJson();
        assertTrue(
            root.get("directTessellatorHookActive")
                .getAsBoolean());
        assertEquals(
            1,
            root.get("directTessellatorVertexCount")
                .getAsInt());
    }

    @Test
    public void disabledSessionCollectsNothingButSelfCheckStillWorks() {
        CaptureDiagnostics.resetForTesting(false);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 1, 2, 3, "t", 0);
        CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 1, 2, 3, 1, 2, 3, false);
        CaptureDiagnostics.noteDirectTessellatorVertex();

        JsonObject root = CaptureDiagnostics.toJson();
        assertEquals(
            0,
            root.getAsJsonObject("channels")
                .getAsJsonObject("TESR")
                .get("windows")
                .getAsInt());
        assertEquals(
            0,
            root.getAsJsonArray("windowEvents")
                .size());
        assertEquals(
            0,
            root.get("directTessellatorVertexCount")
                .getAsInt());
        // 自检位不受启用态影响（它证明的是 Mixin 活着，不是诊断在开）
        assertTrue(
            root.get("directTessellatorHookActive")
                .getAsBoolean());
    }

    @Test
    public void selfProofLinesCollected() {
        CaptureDiagnostics.noteSelfProof("[SDE][capture] BLOCK_COMPILE 首窗口开启 attr=(0,0,0)");
        JsonArray lines = CaptureDiagnostics.toJson()
            .getAsJsonArray("selfProofLines");
        assertEquals(1, lines.size());
        assertTrue(
            lines.get(0)
                .getAsString()
                .contains("首窗口开启"));
    }

    @Test
    public void writeThenReadBackAssertsFields() throws Exception {
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 5, 6, 7, "te", 3);
        CaptureDiagnostics.noteDirectTessellatorVertex();
        CaptureDiagnostics.noteSelfProof("proof-line");

        Path out = Files.createTempFile("sde-capture-diag", ".json");
        try {
            CaptureDiagnostics.write(out);
            String text = new String(Files.readAllBytes(out), StandardCharsets.UTF_8);
            JsonObject root = new JsonParser().parse(text)
                .getAsJsonObject();
            assertEquals(
                CaptureDiagnostics.SCHEMA,
                root.get("schema")
                    .getAsString());
            assertTrue(
                root.get("directTessellatorHookActive")
                    .getAsBoolean());
            assertEquals(
                3,
                root.getAsJsonObject("channels")
                    .getAsJsonObject("TESR")
                    .get("quads")
                    .getAsInt());
            assertEquals(
                1,
                root.getAsJsonArray("windowEvents")
                    .size());
            assertEquals(
                1,
                root.getAsJsonArray("selfProofLines")
                    .size());
        } finally {
            Files.deleteIfExists(out);
        }
    }
}
