package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link CaseParser} / {@link CaseValidator} 单测：严格模式、相对坐标展开、capture/cameras 透传、
 * 判据参数校验、规范化计划与负对照补丁。
 */
public class CaseParserTest {

    // ------------------------------------------------------------ 用例构造

    private static JsonObject caseJson() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", Contract.SCHEMA_CASE);
        c.addProperty("id", "lp-pipe-row");
        c.addProperty("label", "LP 四格管道参照");

        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_lp_pipe_row");
        world.addProperty("seed", 20261006L);
        world.addProperty("void", true);
        world.add("base", ints(64, 12, 64));
        world.addProperty("settleTicks", 60);
        c.add("world", world);

        JsonArray build = new JsonArray();
        JsonObject clear = new JsonObject();
        clear.addProperty("op", "clear");
        clear.add("from", ints(64, 12, 64));
        clear.add("to", ints(67, 15, 64));
        build.add(clear);

        JsonObject block = new JsonObject();
        block.addProperty("op", "block");
        block.addProperty("at", "@base");
        block.add("offset", ints(1, 0, 0));
        block.addProperty("id", "minecraft:stone");
        block.addProperty("meta", 0);
        build.add(block);

        JsonObject te = new JsonObject();
        te.addProperty("op", "te");
        te.addProperty("at", "base+[2,0,0]");
        te.addProperty("completer", "lp-pipe");
        JsonObject teParams = new JsonObject();
        teParams.addProperty("side", "north");
        te.add("params", teParams);
        build.add(te);

        JsonObject wait = new JsonObject();
        wait.addProperty("op", "wait");
        wait.addProperty("ticks", 20);
        build.add(wait);
        c.add("build", build);

        JsonObject capture = new JsonObject();
        capture.addProperty("lighting", "neutral-flat");
        capture.addProperty("renderMode", "参与光照");
        capture.addProperty("worldTime", 6000);
        c.add("capture", capture);

        JsonArray cameras = new JsonArray();
        JsonObject cam = new JsonObject();
        cam.addProperty("name", "front");
        cam.add("pos", doubles(64.5d, 20.0d, 70.5d));
        cam.addProperty("yaw", 180.0d);
        cam.addProperty("pitch", -45.0d);
        JsonObject camProj = new JsonObject();
        camProj.addProperty("type", "ortho");
        camProj.addProperty("orthoHeight", 16.0d);
        cam.add("projection", camProj);
        cam.add("resolution", ints(1920, 1080));
        cameras.add(cam);
        c.add("cameras", cameras);

        JsonArray criteria = new JsonArray();
        criteria.add(criterion("manifest", "artifact-exists", params("path", "world/scene-manifest.json")));
        JsonObject nonEmpty = params("path", "observation.json");
        nonEmpty.addProperty("minBytes", 2);
        criteria.add(criterion("nonempty", "artifact-nonempty", nonEmpty));
        JsonObject field = params("path", "world/scene-manifest.json");
        field.addProperty("pointer", "/blocks/0/id");
        JsonObject fieldCriterion = criterion("field", "json-field", field);
        fieldCriterion.addProperty("expect", "minecraft:stone");
        criteria.add(fieldCriterion);
        criteria.add(criterion("idem", "world-hash-equals", new JsonObject()));
        JsonObject evt = params("kind", "world-rebuild");
        evt.addProperty("minCount", 1);
        criteria.add(criterion("evt", "event-emitted", evt));
        c.add("criteria", criteria);

        JsonArray variants = new JsonArray();
        JsonObject variant = new JsonObject();
        variant.addProperty("id", "no-block");
        JsonArray mutate = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("op", "remove");
        op.addProperty("path", "/build/1");
        mutate.add(op);
        variant.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("field");
        variant.add("expectCriteriaRed", red);
        variants.add(variant);
        c.add("variants", variants);

        JsonObject evidence = new JsonObject();
        JsonArray expect = new JsonArray();
        expect.add(evidenceItem("observation.json", "observation"));
        expect.add(evidenceItem("criteria.json", "criteria"));
        evidence.add("expect", expect);
        c.add("evidence", evidence);
        return c;
    }

    private static JsonArray ints(int... v) {
        JsonArray a = new JsonArray();
        for (int x : v) {
            a.add(x);
        }
        return a;
    }

    private static JsonArray doubles(double... v) {
        JsonArray a = new JsonArray();
        for (double x : v) {
            a.add(x);
        }
        return a;
    }

    private static JsonObject params(String k, String v) {
        JsonObject o = new JsonObject();
        o.addProperty(k, v);
        return o;
    }

    private static JsonObject criterion(String id, String type, JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("type", type);
        o.add("params", params);
        return o;
    }

    private static JsonObject evidenceItem(String path, String role) {
        JsonObject o = new JsonObject();
        o.addProperty("path", path);
        o.addProperty("role", role);
        return o;
    }

    private static String text(JsonObject o) {
        return Json.toJson(o);
    }

    private static CpException parseError(JsonObject o) {
        try {
            new CaseParser().parse(text(o));
            fail("应当解析失败");
            return null;
        } catch (CpException e) {
            return e;
        }
    }

    private static boolean mentionsField(CpException e, String fieldFragment) {
        if (e.context() == null) {
            return false;
        }
        JsonArray fields = e.context()
            .getAsJsonArray("fields");
        for (int i = 0; i < fields.size(); i++) {
            if (fields.get(i)
                .getAsJsonObject()
                .get("field")
                .getAsString()
                .contains(fieldFragment)) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ 解析

    @Test
    public void parsesFullCaseAndKeepsRawForPatching() {
        String json = text(caseJson());
        CaseFile f = new CaseParser().parse(json);

        assertEquals(Contract.SCHEMA_CASE, f.schema());
        assertEquals("lp-pipe-row", f.id());
        assertEquals("LP 四格管道参照", f.label());
        assertEquals(
            "cp_lp_pipe_row",
            f.world()
                .folder());
        assertEquals(
            20261006L,
            f.world()
                .seed());
        assertTrue(
            f.world()
                .isVoid());
        assertEquals(
            60,
            f.world()
                .settleTicks());
        assertEquals(
            4,
            f.build()
                .size());
        assertEquals(
            5,
            f.criteria()
                .size());
        assertEquals(
            1,
            f.variants()
                .size());
        assertEquals(
            2,
            f.evidenceExpect()
                .size());
        assertEquals(Hashing.sha256HexUtf8(json), f.sha256());
        assertTrue(
            f.raw()
                .has("build"));
    }

    @Test
    public void relativeCoordinatesAreResolvedAgainstWorldBase() {
        CaseFile f = new CaseParser().parse(text(caseJson()));
        List<CaseFile.Step> steps = f.build();
        assertEquals(
            "clear",
            steps.get(0)
                .op());
        assertArrayEqualsInts(
            new int[] { 64, 12, 64 },
            steps.get(0)
                .from());
        assertArrayEqualsInts(
            new int[] { 67, 15, 64 },
            steps.get(0)
                .to());
        assertArrayEqualsInts(
            new int[] { 65, 12, 64 },
            steps.get(1)
                .at());
        assertArrayEqualsInts(
            new int[] { 66, 12, 64 },
            steps.get(2)
                .at());
        assertEquals(
            "lp-pipe",
            steps.get(2)
                .completer());
        assertEquals(
            "north",
            steps.get(2)
                .completerParams()
                .get("side")
                .getAsString());
        assertEquals(
            20,
            steps.get(3)
                .ticks());
    }

    @Test
    public void relativeCoordinateWithoutBaseIsRejected() {
        JsonObject c = caseJson();
        c.getAsJsonObject("world")
            .remove("base");
        CpException e = parseError(c);
        assertEquals(ErrorCodes.VALID_PARAM, e.code());
        assertTrue(mentionsField(e, "build[1].at"));
    }

    @Test
    public void captureAndCamerasAreParsedAsRealSegments() {
        CaseFile f = new CaseParser().parse(text(caseJson()));
        assertNotNull(f.capture());
        assertEquals(
            "neutral-flat",
            f.capture()
                .getAsJsonObject()
                .get("lighting")
                .getAsString());
        assertNotNull(f.cameras());
        assertEquals(
            "front",
            f.cameras()
                .get(0)
                .getAsJsonObject()
                .get("name")
                .getAsString());
        // 段本身不再报「1.0 透传」警告（1.1 起是真实执行段）
        for (String w : f.warnings()) {
            assertFalse("不应再出现 defer 口径的警告: " + w, w.contains("v1.x"));
        }
        // 规范化计划：capture/cameras 是执行段，投影二选一已展开
        JsonObject plan = new CaseValidator().plan(f);
        assertTrue(
            plan.getAsJsonArray("segments")
                .toString()
                .contains("cameras"));
        assertEquals(
            "ortho",
            plan.getAsJsonArray("cameras")
                .get(0)
                .getAsJsonObject()
                .getAsJsonObject("projection")
                .get("type")
                .getAsString());
    }

    @Test
    public void unknownTopLevelFieldIsAnErrorInStrictMode() {
        JsonObject c = caseJson();
        c.addProperty("typoField", 1);
        CpException e = parseError(c);
        assertEquals(ErrorCodes.VALID_PARAM, e.code());
        assertTrue(mentionsField(e, "typoField"));
    }

    @Test
    public void unknownStepFieldAndOpAreErrors() {
        JsonObject c = caseJson();
        c.getAsJsonArray("build")
            .get(0)
            .getAsJsonObject()
            .addProperty("whoops", 1);
        assertTrue(mentionsField(parseError(c), "build[0].whoops"));

        JsonObject c2 = caseJson();
        c2.getAsJsonArray("build")
            .get(3)
            .getAsJsonObject()
            .addProperty("op", "teleport");
        assertTrue(mentionsField(parseError(c2), "build[3].op"));
    }

    @Test
    public void lenientModeDowngradesUnknownFieldsToWarnings() {
        JsonObject c = caseJson();
        c.addProperty("typoField", 1);
        CaseFile f = new CaseParser(false).parse(text(c));
        assertEquals("lp-pipe-row", f.id());
        boolean warned = false;
        for (String w : f.warnings()) {
            if (w.contains("typoField")) {
                warned = true;
            }
        }
        assertTrue(warned);
    }

    @Test
    public void jsonSyntaxIsStrict() {
        String withSingleQuotes = "{'schema':'lightning.case/1'}";
        try {
            new CaseParser().parse(withSingleQuotes);
            fail("单引号 JSON 必须被拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
        String duplicateKey = "{\"schema\":\"lightning.case/1\",\"schema\":\"lightning.case/1\"}";
        try {
            new CaseParser().parse(duplicateKey);
            fail("重复键名必须被拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
    }

    @Test
    public void schemaIdFolderAndVoidAreValidated() {
        JsonObject wrongSchema = caseJson();
        wrongSchema.addProperty("schema", "lightning.case/2");
        assertTrue(mentionsField(parseError(wrongSchema), "schema"));

        JsonObject badId = caseJson();
        badId.addProperty("id", "LP Pipe Row");
        assertTrue(mentionsField(parseError(badId), "id"));

        JsonObject badFolder = caseJson();
        badFolder.getAsJsonObject("world")
            .addProperty("folder", "saves/lp");
        assertTrue(mentionsField(parseError(badFolder), "world.folder"));

        JsonObject solidWorld = caseJson();
        solidWorld.getAsJsonObject("world")
            .addProperty("void", false);
        assertTrue(mentionsField(parseError(solidWorld), "world.void"));

        JsonObject noCriteria = caseJson();
        noCriteria.remove("criteria");
        assertTrue(mentionsField(parseError(noCriteria), "criteria"));

        JsonObject noEvidence = caseJson();
        noEvidence.remove("evidence");
        assertTrue(mentionsField(parseError(noEvidence), "evidence"));
    }

    @Test
    public void unknownCriterionTypeIsRejectedAtParseTime() {
        JsonObject c = caseJson();
        c.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .addProperty("type", "looks-nice");
        assertTrue(mentionsField(parseError(c), "criteria[0].type"));
    }

    @Test
    public void parseFileReadsUtf8FromDisk() throws Exception {
        java.nio.file.Path file = java.nio.file.Files.createTempFile("case", ".json");
        try {
            java.nio.file.Files.write(file, text(caseJson()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            CaseFile f = new CaseParser().parseFile(file);
            assertEquals("lp-pipe-row", f.id());
        } finally {
            java.nio.file.Files.deleteIfExists(file);
        }
    }

    /**
     * {@code caseSha256} 与检出平台换行无关：CRLF 与 LF 的同一份用例必须同哈希，
     * 且等于规范实现 {@link Hashing#sha256HexUtf8Lf(String)} 的值。
     */
    @Test
    public void sha256IsLineEndingIndependentAndUsesCanonicalLfText() {
        String lf = new com.google.gson.GsonBuilder().setPrettyPrinting()
            .create()
            .toJson(caseJson())
            .replace("\r\n", "\n");
        String crlf = lf.replace("\n", "\r\n");
        assertTrue("夹具必须是多行文本，否则换行归一化没有被覆盖", lf.indexOf('\n') >= 0);
        assertTrue("夹具必须真的含 CRLF", crlf.indexOf("\r\n") >= 0);

        CaseFile a = new CaseParser().parse(lf);
        CaseFile b = new CaseParser().parse(crlf);
        assertEquals("LF 与 CRLF 文本必须得到同一个 caseSha256", a.sha256(), b.sha256());
        assertEquals("caseSha256 必须等于 UTF-8 文本 CRLF→LF 归一后的 sha256", Hashing.sha256HexUtf8Lf(lf), a.sha256());
        assertFalse(
            "原始字节哈希必须与归一哈希不同（否则本用例证明不了归一化真的生效）",
            Hashing.sha256HexUtf8(crlf)
                .equals(Hashing.sha256HexUtf8(lf)));
    }

    // ------------------------------------------------------------ 规范化计划

    @Test
    public void planIsNormalizedWithDefaultsFilled() {
        CaseFile f = new CaseParser().parse(text(caseJson()));
        JsonObject plan = new CaseValidator().plan(f);

        assertEquals(
            "lp-pipe-row",
            plan.get("id")
                .getAsString());
        assertEquals(
            f.sha256(),
            plan.get("caseSha256")
                .getAsString());
        assertEquals(
            CaseValidator.SEGMENTS.size(),
            plan.getAsJsonArray("segments")
                .size());
        assertTrue(plan.has("capture"));
        assertTrue(plan.has("cameras"));
        // v1.3：read 段进计划，且未声明时是空数组（不是缺字段）
        assertTrue(plan.has("read"));
        assertEquals(
            0,
            plan.getAsJsonArray("read")
                .size());

        JsonObject world = plan.getAsJsonObject("world");
        assertEquals(
            60,
            world.get("settleTicks")
                .getAsInt());
        assertEquals(
            3,
            world.getAsJsonArray("base")
                .size());

        JsonObject blockStep = plan.getAsJsonArray("build")
            .get(1)
            .getAsJsonObject();
        assertEquals(
            1,
            blockStep.get("index")
                .getAsInt());
        assertEquals(
            "minecraft:stone",
            blockStep.get("id")
                .getAsString());
        assertEquals(
            0,
            blockStep.get("meta")
                .getAsInt());

        JsonObject nonEmpty = plan.getAsJsonArray("criteria")
            .get(1)
            .getAsJsonObject();
        assertEquals(
            2,
            nonEmpty.getAsJsonObject("params")
                .get("minBytes")
                .getAsInt());
        JsonObject evt = plan.getAsJsonArray("criteria")
            .get(4)
            .getAsJsonObject();
        assertEquals(
            1,
            evt.getAsJsonObject("params")
                .get("minCount")
                .getAsInt());
    }

    @Test
    public void planFillsDefaultMinBytesAndMinCount() {
        JsonObject c = caseJson();
        c.getAsJsonArray("criteria")
            .get(1)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .remove("minBytes");
        c.getAsJsonArray("criteria")
            .get(4)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .remove("minCount");
        JsonObject plan = new CaseValidator().plan(new CaseParser().parse(text(c)));
        assertEquals(
            1,
            plan.getAsJsonArray("criteria")
                .get(1)
                .getAsJsonObject()
                .getAsJsonObject("params")
                .get("minBytes")
                .getAsInt());
        assertEquals(
            1,
            plan.getAsJsonArray("criteria")
                .get(4)
                .getAsJsonObject()
                .getAsJsonObject("params")
                .get("minCount")
                .getAsInt());
    }

    @Test
    public void planRejectsOutOfRangeCoordinatesAndBadMeta() {
        JsonObject c = caseJson();
        c.getAsJsonArray("build")
            .get(1)
            .getAsJsonObject()
            .add("at", ints(65, 300, 64));
        assertTrue(mentionsField(planError(c), "build[1].at"));

        JsonObject c2 = caseJson();
        c2.getAsJsonArray("build")
            .get(1)
            .getAsJsonObject()
            .addProperty("meta", 99);
        assertTrue(mentionsField(planError(c2), "build[1].meta"));

        JsonObject c3 = caseJson();
        JsonObject badClear = c3.getAsJsonArray("build")
            .get(0)
            .getAsJsonObject();
        badClear.add("to", ints(60, 15, 64));
        assertTrue(mentionsField(planError(c3), "build[0]"));
    }

    @Test
    public void planRejectsCriteriaWithoutRequiredParams() {
        JsonObject c = caseJson();
        c.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .remove("path");
        assertTrue(mentionsField(planError(c), "criteria[0].params.path"));

        JsonObject c2 = caseJson();
        c2.getAsJsonArray("criteria")
            .get(2)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .remove("pointer");
        assertTrue(mentionsField(planError(c2), "criteria[2].params.pointer"));

        // json-field 缺 expect
        JsonObject c3 = caseJson();
        c3.getAsJsonArray("criteria")
            .get(2)
            .getAsJsonObject()
            .remove("expect");
        assertTrue(mentionsField(planError(c3), "criteria[2].expect"));

        // event-emitted 缺 kind
        JsonObject c4 = caseJson();
        c4.getAsJsonArray("criteria")
            .get(4)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .remove("kind");
        assertTrue(mentionsField(planError(c4), "criteria[4].params.kind"));
    }

    @Test
    public void planRejectsEvidencePathTraversal() {
        JsonObject c = caseJson();
        c.getAsJsonObject("evidence")
            .getAsJsonArray("expect")
            .get(0)
            .getAsJsonObject()
            .addProperty("path", "../../tokens.json");
        assertTrue(mentionsField(planError(c), "evidence.expect[0].path"));
    }

    @Test
    public void planRecordsVariantPatchApplication() {
        JsonObject plan = new CaseValidator().plan(new CaseParser().parse(text(caseJson())));
        JsonObject v = plan.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject();
        assertEquals(
            "no-block",
            v.get("id")
                .getAsString());
        assertTrue(
            v.get("applicable")
                .getAsBoolean());
        assertEquals(
            64,
            v.get("appliedSha256")
                .getAsString()
                .length());
        assertEquals(
            "field",
            v.getAsJsonArray("expectCriteriaRed")
                .get(0)
                .getAsString());
    }

    @Test
    public void variantPatchErrorsAreReportedPerField() {
        JsonObject c = caseJson();
        JsonObject op = c.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("mutate")
            .get(0)
            .getAsJsonObject();
        op.addProperty("path", "/build/99");
        assertTrue(mentionsField(planError(c), "variants[0].mutate"));

        JsonObject c2 = caseJson();
        c2.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("expectCriteriaRed")
            .set(0, new com.google.gson.JsonPrimitive("nope"));
        assertTrue(mentionsField(planError(c2), "variants[0].expectCriteriaRed"));
    }

    @Test
    public void noopVariantPatchIsRejected() {
        JsonObject c = caseJson();
        JsonObject v = c.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject();
        JsonArray mutate = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("op", "replace");
        op.addProperty("path", "/label");
        op.addProperty("value", "LP 四格管道参照");
        mutate.add(op);
        v.add("mutate", mutate);
        assertTrue(mentionsField(planError(c), "variants[0].mutate"));
    }

    @Test
    public void emptyBuildSegmentYieldsWarningNotError() {
        JsonObject c = caseJson();
        c.remove("build");
        // 变体补丁依赖 /build/1，这里一并移除，保持用例自洽
        c.remove("variants");
        CaseFile f = new CaseParser().parse(text(c));
        JsonObject plan = new CaseValidator().plan(f);
        assertEquals(
            0,
            plan.getAsJsonArray("build")
                .size());
        boolean warned = false;
        for (int i = 0; i < plan.getAsJsonArray("warnings")
            .size(); i++) {
            if (plan.getAsJsonArray("warnings")
                .get(i)
                .getAsString()
                .contains("build 段为空")) {
                warned = true;
            }
        }
        assertTrue(warned);
    }

    @Test
    public void validatorStaticEntryValidatesText() {
        JsonObject plan = CaseValidator.validate(text(caseJson()));
        assertEquals(
            "lp-pipe-row",
            plan.get("id")
                .getAsString());
    }

    @Test
    public void evidenceItemWithoutPathIsRejected() {
        JsonObject c = caseJson();
        c.getAsJsonObject("evidence")
            .getAsJsonArray("expect")
            .get(0)
            .getAsJsonObject()
            .remove("path");
        assertTrue(mentionsField(parseError(c), "evidence.expect[0].path"));
    }

    @Test
    public void planCarriesCriteriaTypesRegistry() {
        assertTrue(CriteriaEngine.isKnownType("artifact-exists"));
        assertTrue(CriteriaEngine.isKnownType("event-emitted"));
        // 1.1 追加的两个图像判据
        assertTrue(CriteriaEngine.isKnownType("image-size-equals"));
        assertTrue(CriteriaEngine.isKnownType("image-not-uniform"));
        // 1.2 追加的双轨判据（运行期轨 + 图像轨）
        assertTrue(CriteriaEngine.isKnownType("te-state-equals"));
        assertTrue(CriteriaEngine.isKnownType("image-uniform"));
        assertFalse(CriteriaEngine.isKnownType("nope"));
        assertEquals(9, CriteriaEngine.TYPES.size());
    }

    /**
     * 判据类型自描述的<b>内容</b>锁（从「只锁数量」升级为「逐条 type/since/params 一致」）。
     *
     * <h2>为什么必须锁内容</h2>
     * 原断言只写 {@code assertEquals(9, CriteriaEngine.TYPES.size())}——改名、改 {@code since}、
     * 改 {@code params} 描述<b>都不会变红</b>（曾属「数量锁而非内容锁」）。
     * 而自描述端点是<b>唯一权威</b>（{@code case.validate} 的 {@code criteriaTypes} 就是它的原样投影，
     * docs 与测试都必须向它对齐）：描述错了比没有描述更糟——调用方会照着错的 {@code params} 写用例。
     *
     * <h2>三方对账是哪三方</h2>
     * <ol>
     * <li><b>自描述端点</b>（唯一权威）：{@link CriteriaEngine#typeCatalog()}——{@code case.validate}
     * 把它摊在 {@code result.criteriaTypes}；</li>
     * <li><b>注册表</b>：{@link CriteriaEngine#TYPES}（{@link CaseParser#parseCriteria} 用它判
     * 「未知判据类型」）；</li>
     * <li><b>契约文档</b>：{@code docs/control-plane/case-file.md §5} 的判据表。</li>
     * </ol>
     * 前两方由本测试机械锁死（同序、同集合、逐条 {@code since} 与 {@code params} 与下表一致）；
     * 第三方（文档）无法在本进程里读，改由 {@code test/criteria/criteria-types.json} 落一份
     * <b>从端点导出的快照</b>，并附 {@code test/criteria/README.md} 的对账方法——文档漂移因此
     * 是一次可执行的比对，而不是靠人记得改。
     */
    @Test
    public void criteriaTypeCatalogContentIsLocked() {
        JsonArray catalog = CriteriaEngine.typeCatalog();
        // ① 与注册表同序同集合（自描述是权威，注册表必须逐字对齐）
        assertEquals("自描述条数必须等于注册表条数", CriteriaEngine.TYPES.size(), catalog.size());
        for (int i = 0; i < catalog.size(); i++) {
            JsonObject d = catalog.get(i)
                .getAsJsonObject();
            assertEquals(
                "第 " + i + " 条自描述的 type 必须与 TYPES[" + i + "] 逐字相同（顺序即文档顺序）",
                CriteriaEngine.TYPES.get(i),
                Json.optString(d, "type", null));
            assertNotNull("自描述缺 since: " + Json.toJson(d), Json.optString(d, "since", null));
            assertFalse(
                "自描述缺 params 说明: " + Json.toJson(d),
                Json.optString(d, "params", "")
                    .trim()
                    .isEmpty());
            // since 必须是契约小版本形态（与 contract.md §13 第 4 条的 since 同口径）
            assertTrue(
                "since 形态非法（应为 x.y）: " + Json.optString(d, "since", null),
                Json.optString(d, "since", "")
                    .matches("\\d+\\.\\d+"));
        }
        // ② 逐条内容锁：type → since 的完整映射（改 since 必须同时改这里与文档）
        assertEquals("1.0", CriteriaEngine.typeSince("artifact-exists"));
        assertEquals("1.0", CriteriaEngine.typeSince("artifact-nonempty"));
        assertEquals("1.0", CriteriaEngine.typeSince("json-field"));
        assertEquals("1.0", CriteriaEngine.typeSince("world-hash-equals"));
        assertEquals("1.0", CriteriaEngine.typeSince("event-emitted"));
        assertEquals("1.1", CriteriaEngine.typeSince("image-size-equals"));
        assertEquals("1.1", CriteriaEngine.typeSince("image-not-uniform"));
        assertEquals("1.2", CriteriaEngine.typeSince("te-state-equals"));
        assertEquals("1.2", CriteriaEngine.typeSince("image-uniform"));
        assertNull("未登记类型必须返回 null", CriteriaEngine.typeSince("nope"));
        // ③ 逐条 params 锁：params 说明里出现的参数名必须与校验器实际接受的参数一致
        // （描述错了比没有描述更糟——调用方会照错的说明写用例）
        assertEquals("path", paramsOf("artifact-exists"));
        assertEquals("path, minBytes(默认1)", paramsOf("artifact-nonempty"));
        assertEquals("path, pointer(RFC 6901), expect(必填)", paramsOf("json-field"));
        assertEquals("—", paramsOf("world-hash-equals"));
        assertEquals("kind, minCount(默认1)", paramsOf("event-emitted"));
        assertEquals("path, width, height", paramsOf("image-size-equals"));
        assertEquals("path, maxSameColorRatio(默认0.98)", paramsOf("image-not-uniform"));
        assertEquals("at[x,y,z], key(RFC 6901 指针，对描述器输出), expect(必填)", paramsOf("te-state-equals"));
        assertEquals("path, minSameColorRatio(默认0.98)", paramsOf("image-uniform"));
    }

    /** 取某判据类型的自描述 {@code params} 串。 */
    private static String paramsOf(String type) {
        JsonArray catalog = CriteriaEngine.typeCatalog();
        for (int i = 0; i < catalog.size(); i++) {
            JsonObject d = catalog.get(i)
                .getAsJsonObject();
            if (type.equals(Json.optString(d, "type", null))) {
                return Json.optString(d, "params", null);
            }
        }
        return null;
    }

    /**
     * 每个已注册判据类型都能被 {@code case.validate} 的 {@code criteriaTypes} 看到（验收第 3 条）。
     *
     * <p>
     * 这条断言的是「新增判据类型逐项在 {@code case.validate} 输出中可见，无漂移」：
     * 自描述端点是唯一权威，{@code case.validate} 必须把它<b>原样</b>摊出来（不是子集、不是改写）。
     */
    @Test
    public void validateExposesEveryCriteriaType() {
        JsonArray catalog = CriteriaEngine.typeCatalog();
        JsonArray fromPlan = CaseParser.criterionTypesJson();
        assertEquals(CriteriaEngine.TYPES.size(), fromPlan.size());
        for (int i = 0; i < catalog.size(); i++) {
            String type = Json.optString(
                catalog.get(i)
                    .getAsJsonObject(),
                "type",
                null);
            boolean found = false;
            for (int k = 0; k < fromPlan.size(); k++) {
                if (type.equals(
                    fromPlan.get(k)
                        .getAsString())) {
                    found = true;
                    break;
                }
            }
            assertTrue("case.validate 的 criteriaTypes 缺该类型: " + type, found);
        }
    }

    private static void assertArrayEqualsInts(int[] expected, int[] actual) {
        assertNotNull(actual);
        assertEquals(3, actual.length);
        assertEquals(expected[0], actual[0]);
        assertEquals(expected[1], actual[1]);
        assertEquals(expected[2], actual[2]);
    }

    private static CpException planError(JsonObject o) {
        CaseFile f = new CaseParser().parse(text(o));
        try {
            new CaseValidator().plan(f);
            fail("应当校验失败");
            return null;
        } catch (CpException e) {
            return e;
        }
    }
}
