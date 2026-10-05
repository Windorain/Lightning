package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link CriteriaEngine} 单测：v1 五条判据的 green/red/error 语义、负对照（能红）与证据清单核对。
 */
public class CriteriaEngineTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private ArtifactStore store;
    private ArtifactStore.Run run;
    private EventStream events;
    private CriteriaEngine engine;

    @Before
    public void setUp() throws IOException {
        store = new ArtifactStore(
            tmp.newFolder("runs")
                .toPath(),
            TimeSource.fixed("t", "t", 0L),
            null);
        run = store.createRun("c", 1L);
        events = new EventStream(64, null, null);
        engine = new CriteriaEngine(store, run, events, CriteriaEngine.fixedHashSource("h1", "h1"));
    }

    // ------------------------------------------------------------ 工具

    private static JsonObject criterion(String id, String type, JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("type", type);
        o.add("params", params == null ? new JsonObject() : params);
        return o;
    }

    private static JsonObject params(String k, String v) {
        JsonObject o = new JsonObject();
        o.addProperty(k, v);
        return o;
    }

    private static String verdict(JsonObject result) {
        return result.get("verdict")
            .getAsString();
    }

    private String detail(JsonObject result) {
        return result.get("detail")
            .getAsString();
    }

    // ------------------------------------------------------------ artifact-exists

    @Test
    public void artifactExistsGreenAndRed() {
        store.writeText(run, "observation.json", "{}", "observation");
        assertEquals(
            CriteriaEngine.Verdicts.GREEN,
            verdict(engine.evaluateOne(criterion("c1", "artifact-exists", params("path", "observation.json")), 0)));
        assertEquals(
            CriteriaEngine.Verdicts.RED,
            verdict(engine.evaluateOne(criterion("c2", "artifact-exists", params("path", "missing.json")), 1)));

        // 缺 params.path 属于判据定义错误 → error
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(engine.evaluateOne(criterion("c3", "artifact-exists", new JsonObject()), 2)));
    }

    // ------------------------------------------------------------ artifact-nonempty

    @Test
    public void artifactNonEmptyHonoursMinBytes() {
        store.writeText(run, "empty.txt", "", "data");
        store.writeText(run, "small.txt", "abc", "data");

        JsonObject minBytes = params("path", "small.txt");
        minBytes.addProperty("minBytes", 4);
        assertEquals(
            CriteriaEngine.Verdicts.RED,
            verdict(engine.evaluateOne(criterion("c1", "artifact-nonempty", minBytes), 0)));

        JsonObject ok = params("path", "small.txt");
        ok.addProperty("minBytes", 3);
        assertEquals(
            CriteriaEngine.Verdicts.GREEN,
            verdict(engine.evaluateOne(criterion("c2", "artifact-nonempty", ok), 1)));

        // 默认 minBytes = 1：空文件必红（V2 非空断言）
        assertEquals(
            CriteriaEngine.Verdicts.RED,
            verdict(engine.evaluateOne(criterion("c3", "artifact-nonempty", params("path", "empty.txt")), 2)));
    }

    // ------------------------------------------------------------ json-field

    @Test
    public void jsonFieldGreenRedAndError() {
        JsonObject doc = new JsonObject();
        JsonArray blocks = new JsonArray();
        JsonObject b = new JsonObject();
        b.addProperty("id", "minecraft:stone");
        blocks.add(b);
        doc.add("blocks", blocks);
        store.writeText(run, "world/scene-manifest.json", Json.toJson(doc), "scene-manifest");

        JsonObject p = params("path", "world/scene-manifest.json");
        p.addProperty("pointer", "/blocks/0/id");
        JsonObject green = criterion("c1", "json-field", p);
        green.addProperty("expect", "minecraft:stone");
        assertEquals(CriteriaEngine.Verdicts.GREEN, verdict(engine.evaluateOne(green, 0)));

        JsonObject wrongValue = criterion("c2", "json-field", p);
        wrongValue.addProperty("expect", "minecraft:dirt");
        assertEquals(CriteriaEngine.Verdicts.RED, verdict(engine.evaluateOne(wrongValue, 1)));

        JsonObject missingPointer = params("path", "world/scene-manifest.json");
        missingPointer.addProperty("pointer", "/blocks/9/id");
        JsonObject red = criterion("c3", "json-field", missingPointer);
        red.addProperty("expect", "x");
        assertEquals(CriteriaEngine.Verdicts.RED, verdict(engine.evaluateOne(red, 2)));
        assertTrue(detail(engine.evaluateOne(red, 2)).contains("指针未命中"));

        JsonObject missingFile = params("path", "nope.json");
        missingFile.addProperty("pointer", "/a");
        JsonObject err = criterion("c4", "json-field", missingFile);
        err.addProperty("expect", 1);
        assertEquals(CriteriaEngine.Verdicts.ERROR, verdict(engine.evaluateOne(err, 3)));

        store.writeText(run, "broken.json", "{not json", "data");
        JsonObject broken = params("path", "broken.json");
        broken.addProperty("pointer", "/a");
        JsonObject err2 = criterion("c5", "json-field", broken);
        err2.addProperty("expect", 1);
        assertEquals(CriteriaEngine.Verdicts.ERROR, verdict(engine.evaluateOne(err2, 4)));

        // 缺 expect
        assertEquals(CriteriaEngine.Verdicts.ERROR, verdict(engine.evaluateOne(criterion("c6", "json-field", p), 5)));
    }

    // ------------------------------------------------------------ world-hash-equals

    @Test
    public void worldHashEqualsGreenRedAndError() {
        CriteriaEngine same = new CriteriaEngine(store, run, events, CriteriaEngine.fixedHashSource("abc", "abc"));
        assertEquals(
            CriteriaEngine.Verdicts.GREEN,
            verdict(same.evaluateOne(criterion("c1", "world-hash-equals", null), 0)));

        CriteriaEngine diff = new CriteriaEngine(store, run, events, CriteriaEngine.fixedHashSource("abc", "def"));
        assertEquals(
            CriteriaEngine.Verdicts.RED,
            verdict(diff.evaluateOne(criterion("c2", "world-hash-equals", null), 1)));

        CriteriaEngine noSource = new CriteriaEngine(store, run, events, null);
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(noSource.evaluateOne(criterion("c3", "world-hash-equals", null), 2)));

        CriteriaEngine nullHash = new CriteriaEngine(store, run, events, CriteriaEngine.fixedHashSource(null, null));
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(nullHash.evaluateOne(criterion("c4", "world-hash-equals", null), 3)));
    }

    // ------------------------------------------------------------ event-emitted

    @Test
    public void eventEmittedCountsFromStream() {
        events.append(EventStream.LEVEL_INFO, EventStream.Kinds.WORLD_REBUILD, "a");
        events.append(EventStream.LEVEL_INFO, EventStream.Kinds.WORLD_REBUILD, "b");

        JsonObject p = params("kind", EventStream.Kinds.WORLD_REBUILD);
        p.addProperty("minCount", 2);
        assertEquals(
            CriteriaEngine.Verdicts.GREEN,
            verdict(engine.evaluateOne(criterion("c1", "event-emitted", p), 0)));

        JsonObject p2 = params("kind", EventStream.Kinds.WORLD_REBUILD);
        p2.addProperty("minCount", 3);
        assertEquals(CriteriaEngine.Verdicts.RED, verdict(engine.evaluateOne(criterion("c2", "event-emitted", p2), 1)));

        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(engine.evaluateOne(criterion("c3", "event-emitted", new JsonObject()), 2)));

        CriteriaEngine noEvents = new CriteriaEngine(store, run, null, null);
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(noEvents.evaluateOne(criterion("c4", "event-emitted", params("kind", "x")), 3)));
    }

    // ------------------------------------------------------------ 未知类型与汇总

    @Test
    public void unknownTypeIsErrorVerdict() {
        JsonObject r = engine.evaluateOne(criterion("c1", "looks-nice", null), 0);
        assertEquals(CriteriaEngine.Verdicts.ERROR, verdict(r));
        assertTrue(detail(r).contains("未知判据类型"));
    }

    @Test
    public void aggregateIsRedWhenAnyRedOrError() {
        store.writeText(run, "ok.txt", "x", "data");
        JsonArray criteria = new JsonArray();
        criteria.add(criterion("a", "artifact-exists", params("path", "ok.txt")));
        JsonObject doc = engine.evaluate(criteria, run.runId());
        assertEquals(
            "green",
            doc.get("overall")
                .getAsString());
        assertEquals(
            1,
            doc.getAsJsonObject("counts")
                .get("green")
                .getAsInt());

        criteria.add(criterion("b", "artifact-exists", params("path", "missing.txt")));
        doc = engine.evaluate(criteria, run.runId());
        assertEquals(
            "red",
            doc.get("overall")
                .getAsString());
        assertEquals(
            1,
            doc.getAsJsonObject("counts")
                .get("red")
                .getAsInt());
        assertEquals(
            Contract.SCHEMA_CRITERIA,
            doc.get("schema")
                .getAsString());

        // error 视同 red 但单列
        criteria.add(criterion("c", "world-hash-equals", null));
        CriteriaEngine noHash = new CriteriaEngine(store, run, events, null);
        doc = noHash.evaluate(criteria, run.runId());
        assertEquals(
            "red",
            doc.get("overall")
                .getAsString());
        assertEquals(
            1,
            doc.getAsJsonObject("counts")
                .get("error")
                .getAsInt());
    }

    @Test
    public void evaluateEmitsCriteriaVerdictEvents() {
        store.writeText(run, "ok.txt", "x", "data");
        JsonArray criteria = new JsonArray();
        criteria.add(criterion("a", "artifact-exists", params("path", "ok.txt")));
        criteria.add(criterion("b", "artifact-exists", params("path", "missing.txt")));
        engine.evaluate(criteria, run.runId());
        assertEquals(2, events.countKind(EventStream.Kinds.CRITERIA_VERDICT));
    }

    // ------------------------------------------------------------ 负对照：引擎必须能红

    @Test
    public void negativeControlProducesRed() {
        // 正例：产物存在 → green
        store.writeText(
            run,
            "world/scene-manifest.json",
            "{\"blocks\":[{\"id\":\"minecraft:stone\"}]}",
            "scene-manifest");
        JsonObject p = params("path", "world/scene-manifest.json");
        p.addProperty("pointer", "/blocks/0/id");
        JsonObject c = criterion("field", "json-field", p);
        c.addProperty("expect", "minecraft:stone");
        assertEquals(CriteriaEngine.Verdicts.GREEN, verdict(engine.evaluateOne(c, 0)));

        // 负对照：把产物换掉（等价于变体补丁删掉那一步）→ 必须变红
        store.writeText(run, "world/scene-manifest.json", "{\"blocks\":[]}", "scene-manifest");
        JsonObject p2 = params("path", "world/scene-manifest.json");
        p2.addProperty("pointer", "/blocks/0/id");
        JsonObject c2 = criterion("field", "json-field", p2);
        c2.addProperty("expect", "minecraft:stone");
        assertEquals(CriteriaEngine.Verdicts.RED, verdict(engine.evaluateOne(c2, 0)));

        // 非空断言的负对照：清空文件 → 红
        JsonObject nonEmpty = params("path", "world/scene-manifest.json");
        nonEmpty.addProperty("minBytes", 1);
        store.writeText(run, "world/scene-manifest.json", "", "scene-manifest");
        assertEquals(
            CriteriaEngine.Verdicts.RED,
            verdict(engine.evaluateOne(criterion("nonempty", "artifact-nonempty", nonEmpty), 1)));
    }

    // ------------------------------------------------------------ evidence

    @Test
    public void evidenceCompleteGreenAndRed() {
        store.writeText(run, "observation.json", "{}", "observation");
        store.writeText(run, "criteria.json", "{}", "criteria");
        JsonArray expect = new JsonArray();
        expect.add(item("observation.json"));
        expect.add(item("criteria.json"));
        JsonObject green = engine.checkEvidence(expect);
        assertEquals(
            CriteriaEngine.EVIDENCE_ID,
            green.get("id")
                .getAsString());
        assertEquals(CriteriaEngine.Verdicts.GREEN, verdict(green));

        expect.add(item("world/scene-manifest.json"));
        JsonObject red = engine.checkEvidence(expect);
        assertEquals(CriteriaEngine.Verdicts.RED, verdict(red));
        assertTrue(detail(red).contains("scene-manifest.json"));
    }

    @Test
    public void evidenceWithoutRunIsError() {
        CriteriaEngine noRun = new CriteriaEngine(store, null, events, null);
        JsonArray expect = new JsonArray();
        expect.add(item("a.json"));
        assertEquals(CriteriaEngine.Verdicts.ERROR, verdict(noRun.checkEvidence(expect)));
    }

    @Test
    public void criteriaReferencingTraversalPathIsError() {
        JsonObject p = params("path", "../../tokens.json");
        assertEquals(
            CriteriaEngine.Verdicts.ERROR,
            verdict(engine.evaluateOne(criterion("c", "artifact-exists", p), 0)));
    }

    private static JsonObject item(String path) {
        JsonObject o = new JsonObject();
        o.addProperty("path", path);
        return o;
    }

    /** 保留一个未使用告警抑制点：说明 run 目录确实落在临时目录内。 */
    @Test
    public void runDirectoryLivesUnderRunsRoot() {
        Path dir = run.dir();
        assertTrue(
            dir.toString()
                .replace('\\', '/')
                .contains("/runs/"));
        assertTrue(Files.isDirectory(dir));
    }
}
