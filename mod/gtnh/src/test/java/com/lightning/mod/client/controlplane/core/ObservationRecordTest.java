package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link ObservationRecord} 单测：A10 要求的「仅据本文件即可解释一次观测」五要素齐备，
 * 以及 runtimeReads 的规范化 JSON 哈希口径（键序无关）。
 */
public class ObservationRecordTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private ArtifactStore store;

    @Before
    public void setUp() throws IOException {
        store = new ArtifactStore(
            tmp.newFolder("runs")
                .toPath(),
            TimeSource.fixed("t", "t", 0L),
            null);
    }

    private ObservationRecord sample() {
        JsonObject versions = new JsonObject();
        versions.addProperty("mod", "0.3");
        versions.addProperty("minecraft", "1.7.10");
        versions.addProperty("forge", "10.13.4.1614");

        JsonObject clientConfig = new JsonObject();
        clientConfig.addProperty("fovSetting", 70);
        clientConfig.addProperty("fancyGraphics", true);

        JsonObject summary = new JsonObject();
        summary.addProperty("blocks", 5);
        summary.addProperty("te", 2);
        JsonObject teSummary = new JsonObject();
        teSummary.addProperty("part", "north");
        teSummary.addProperty("mode", "extract");

        ArtifactStore.Run run = store.createRun("lp-pipe-row", 7L);
        ArtifactStore.Artifact manifest = store
            .writeText(run, "world/scene-manifest.json", "{\"blocks\":[]}", "scene-manifest");

        return ObservationRecord.builder("20261006-120000-lp-pipe-row-7", "lp-pipe-row", Hashing.sha256HexUtf8("case"))
            .createdAt("2026-10-06T12:00:00+08:00")
            .versions(versions)
            .clientConfig(clientConfig)
            .observationField("worldTime", 6000)
            .observationField("lighting", "natural")
            .observationField("renderMode", "本色")
            .read("world.sceneManifest", "5 blocks, 2 TE", summary)
            .read("te.lpPipe[65,12,64].state", "north/extract", teSummary)
            .artifact(manifest)
            .build();
    }

    @Test
    public void recordCarriesAllAnchorFields() {
        JsonObject o = sample().toJson();
        assertEquals(
            Contract.SCHEMA_OBSERVATION,
            o.get("schema")
                .getAsString());
        assertEquals(
            "20261006-120000-lp-pipe-row-7",
            o.get("runId")
                .getAsString());
        assertEquals(
            "lp-pipe-row",
            o.get("caseId")
                .getAsString());
        assertEquals(
            64,
            o.get("caseSha256")
                .getAsString()
                .length());
        assertEquals(
            "2026-10-06T12:00:00+08:00",
            o.get("createdAt")
                .getAsString());
        assertEquals(
            "1.7.10",
            o.getAsJsonObject("versions")
                .get("minecraft")
                .getAsString());
        assertEquals(
            70,
            o.getAsJsonObject("clientConfig")
                .get("fovSetting")
                .getAsInt());

        JsonObject observation = o.getAsJsonObject("observation");
        assertEquals(
            "player",
            observation.getAsJsonObject("camera")
                .get("mode")
                .getAsString());
        assertEquals(
            "perspective",
            observation.get("projection")
                .getAsString());
        assertEquals(
            6000,
            observation.get("worldTime")
                .getAsInt());
        assertEquals(
            "natural",
            observation.get("lighting")
                .getAsString());

        JsonArray reads = o.getAsJsonArray("runtimeReads");
        assertEquals(2, reads.size());
        assertEquals(
            "world.sceneManifest",
            reads.get(0)
                .getAsJsonObject()
                .get("key")
                .getAsString());
        assertEquals(
            64,
            reads.get(0)
                .getAsJsonObject()
                .get("sha256")
                .getAsString()
                .length());

        JsonArray artifacts = o.getAsJsonArray("artifacts");
        assertEquals(1, artifacts.size());
        assertEquals(
            "world/scene-manifest.json",
            artifacts.get(0)
                .getAsJsonObject()
                .get("path")
                .getAsString());
        assertEquals(
            Hashing.sha256HexUtf8("{\"blocks\":[]}"),
            artifacts.get(0)
                .getAsJsonObject()
                .get("sha256")
                .getAsString());
    }

    @Test
    public void summaryHashIsCanonicalAndKeyOrderIndependent() {
        JsonObject a = new JsonObject();
        a.addProperty("blocks", 5);
        a.addProperty("te", 2);
        JsonObject b = new JsonObject();
        b.addProperty("te", 2);
        b.addProperty("blocks", 5);

        assertEquals(ObservationRecord.hashSummary(a), ObservationRecord.hashSummary(b));
        assertEquals(Hashing.sha256HexUtf8("{\"blocks\":5,\"te\":2}"), ObservationRecord.hashSummary(a));

        // 与记录里登记的值一致
        JsonObject o = sample().toJson();
        assertEquals(
            ObservationRecord.hashSummary(a),
            o.getAsJsonArray("runtimeReads")
                .get(0)
                .getAsJsonObject()
                .get("sha256")
                .getAsString());
    }

    @Test
    public void nestedSummaryIsCanonicalisedToo() {
        JsonObject inner = new JsonObject();
        inner.addProperty("z", 1);
        inner.addProperty("a", 2);
        JsonObject outer = new JsonObject();
        outer.add("inner", inner);
        assertEquals(Hashing.sha256HexUtf8("{\"inner\":{\"a\":2,\"z\":1}}"), ObservationRecord.hashSummary(outer));
    }

    @Test
    public void manualReadAndArtifactOverloadsWork() {
        ObservationRecord r = ObservationRecord.builder("run", "case", "hash")
            .read("k", "s", "deadbeef")
            .artifact("criteria.json", "criteria", 12L, "cafe")
            .build();
        JsonObject o = r.toJson();
        assertEquals(
            "deadbeef",
            o.getAsJsonArray("runtimeReads")
                .get(0)
                .getAsJsonObject()
                .get("sha256")
                .getAsString());
        JsonObject a = o.getAsJsonArray("artifacts")
            .get(0)
            .getAsJsonObject();
        assertEquals(
            12L,
            a.get("bytes")
                .getAsLong());
        assertEquals(
            "criteria",
            a.get("role")
                .getAsString());
        assertTrue(
            r.toPrettyString()
                .contains("\n"));
        assertNotNull(r.field("versions"));
    }
}
