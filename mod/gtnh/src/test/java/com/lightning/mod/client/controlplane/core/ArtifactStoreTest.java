package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonObject;

/**
 * {@link ArtifactStore} 单测：run 目录命名、产物登记（bytes/sha256）、manifest 落盘与防路径穿越。
 */
public class ArtifactStoreTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private ArtifactStore store() throws IOException {
        return new ArtifactStore(
            tmp.newFolder("runs")
                .toPath(),
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "20261006-120000", 1000L),
            null);
    }

    @Test
    public void sha256MatchesKnownVector() {
        // FIPS 180-4 参考向量
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ArtifactStore.sha256Hex("abc".getBytes(StandardCharsets.UTF_8)));
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ArtifactStore.sha256Hex(new byte[0]));
    }

    @Test
    public void createRunUsesTimestampCaseIdAndJobSeq() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run run = s.createRun("lp-pipe-row", 7L);
        assertEquals("20261006-120000-lp-pipe-row-7", run.runId());
        assertEquals("lp-pipe-row", run.caseId());
        assertEquals(7L, run.jobSeq());
        assertTrue(Files.isDirectory(run.dir()));
        assertEquals("2026-10-06T12:00:00+08:00", run.createdAt());
    }

    @Test
    public void createRunNeverReusesExistingDirectory() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run first = s.createRun("c", 1L);
        ArtifactStore.Run second = s.createRun("c", 1L);
        assertEquals("20261006-120000-c-1", first.runId());
        assertEquals("20261006-120000-c-1-2", second.runId());
        assertFalse(
            first.dir()
                .equals(second.dir()));
    }

    @Test
    public void writeArtifactRegistersBytesAndSha() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run run = s.createRun("c", 1L);
        byte[] payload = "{\"a\":1}".getBytes(StandardCharsets.UTF_8);
        ArtifactStore.Artifact a = s.writeArtifact(run, "world/scene.json", payload, "scene-manifest");

        assertEquals("world/scene.json", a.path());
        assertEquals(payload.length, a.bytes());
        assertEquals(Hashing.sha256Hex(payload), a.sha256());
        assertEquals("scene-manifest", a.role());
        assertTrue(Files.isRegularFile(run.resolve("world/scene.json")));
        assertEquals(
            1,
            run.artifacts()
                .size());
    }

    @Test
    public void registerArtifactComputesHashOfExistingFile() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run run = s.createRun("c", 2L);
        Path file = run.resolve("observation.json");
        Files.write(file, "hello".getBytes(StandardCharsets.UTF_8));
        ArtifactStore.Artifact a = s.registerArtifact(run, "observation.json", "observation");
        assertEquals(5L, a.bytes());
        assertEquals(Hashing.sha256HexUtf8("hello"), a.sha256());
    }

    @Test
    public void manifestJsonListsAllArtifactsAndSurvivesReload() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run run = s.createRun("case-a", 3L);
        s.writeArtifact(run, "criteria.json", "{}".getBytes(StandardCharsets.UTF_8), "criteria");
        s.writeText(run, "observation.json", "{\"schema\":\"x\"}", "observation");
        Path manifest = s.writeManifest(run);
        assertTrue(Files.isRegularFile(manifest));

        JsonObject m = Json.parseStrictObject(new String(Files.readAllBytes(manifest), StandardCharsets.UTF_8));
        assertEquals(
            Contract.SCHEMA_MANIFEST,
            m.get("schema")
                .getAsString());
        assertEquals(
            "case-a",
            m.get("caseId")
                .getAsString());
        assertEquals(
            2,
            m.getAsJsonArray("artifacts")
                .size());

        // 换一个 store 实例（模拟重启后）仍能从磁盘还原清单
        ArtifactStore reopened = new ArtifactStore(s.runsRoot(), TimeSource.fixed("x", "y", 0L), null);
        ArtifactStore.Run loaded = reopened.findRun(run.runId());
        assertNotNull(loaded);
        assertEquals(
            2,
            loaded.artifacts()
                .size());
        assertNotNull(loaded.artifact("criteria.json"));
        assertEquals(
            Hashing.sha256HexUtf8("{}"),
            loaded.artifact("criteria.json")
                .sha256());
    }

    @Test
    public void resolveArtifactRejectsTraversalAndUnknownRuns() throws IOException {
        ArtifactStore s = store();
        ArtifactStore.Run run = s.createRun("c", 4L);
        s.writeText(run, "a.txt", "ok", "misc");

        assertTrue(s.resolveArtifact(run.runId(), "a.txt") != null);

        for (String bad : new String[] { "../secret.txt", "a/../../secret.txt", "/etc/passwd", "..\\secret.txt" }) {
            try {
                s.resolveArtifact(run.runId(), bad);
                fail("应当拒绝越界路径: " + bad);
            } catch (CpException e) {
                assertEquals(ErrorCodes.VALID_PARAM, e.code());
                assertEquals(400, e.httpStatus());
            }
        }
        assertNull(s.resolveArtifact("no-such-run", "a.txt"));
        assertNull(s.resolveArtifact("../outside", "a.txt"));
        assertNull(s.resolveArtifact(run.runId(), "missing.txt"));
    }

    @Test
    public void listRunIdsIsSorted() throws IOException {
        Path root = tmp.newFolder("runs2")
            .toPath();
        ArtifactStore s = new ArtifactStore(root, TimeSource.ticking(0L, 1000L), null);
        s.createRun("b", 1L);
        s.createRun("a", 2L);
        List<String> ids = s.listRunIds();
        assertEquals(2, ids.size());
        assertTrue(
            ids.get(0)
                .compareTo(ids.get(1)) < 0);
    }
}
