package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 用例 {@code read} 段（v1.3）的解析与校验单测。
 *
 * <p>
 * 这一段是「读面输出可被判据直接引用」（case-file.md §3.1 第 6 条）的物质基础：没有它，
 * 判据段跑在本 run 的产物上，而读面读数在别处——「可判定」就成了空话。
 * 这里锁住它的<b>形态与拒绝口径</b>（解析、前缀纪律、路径纪律、重名防护）；
 * 执行期（真的调动作、真的落盘）由 runClient 实测覆盖。
 */
public class CaseReadSegmentTest {

    // ------------------------------------------------------------ 解析

    /** 读面步骤被原样解析：action/params/path/role 一个不少。 */
    @Test
    public void readStepsAreParsed() {
        CaseFile f = new CaseParser().parse(Json.toJson(caseWithRead()));
        assertEquals(
            2,
            f.read()
                .size());

        CaseFile.ReadStep first = f.read()
            .get(0);
        assertEquals("read.blocks", first.action());
        assertEquals("read/blocks.json", first.path());
        assertEquals("read-blocks", first.role());
        assertEquals(
            3,
            Json.optArray(first.params(), "from")
                .size());

        CaseFile.ReadStep second = f.read()
            .get(1);
        assertEquals("read.diff", second.action());
        assertEquals("read/diff.json", second.path());
    }

    /** 未声明 read 段时是空列表（不是 null）——调用方按「段为空」处理。 */
    @Test
    public void absentReadSegmentYieldsEmptyList() {
        JsonObject c = minimalCase();
        CaseFile f = new CaseParser().parse(Json.toJson(c));
        assertNotNull(f.read());
        assertEquals(
            0,
            f.read()
                .size());
    }

    /** 规范化计划的 read 段带 index，且与用例声明同序。 */
    @Test
    public void planCarriesReadStepsWithIndex() {
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWithRead()));
        JsonArray read = Json.optArray(plan, "read");
        assertNotNull(read);
        assertEquals(2, read.size());
        assertEquals(
            0,
            Json.optInt(
                read.get(0)
                    .getAsJsonObject(),
                "index",
                -1));
        assertEquals(
            "read.blocks",
            Json.optString(
                read.get(0)
                    .getAsJsonObject(),
                "action",
                null));
        // 段序：read 在 build 之后、cameras 之前
        JsonArray segments = Json.optArray(plan, "segments");
        int buildIdx = indexOf(segments, "build");
        int readIdx = indexOf(segments, "read");
        int camerasIdx = indexOf(segments, "cameras");
        assertTrue("read 必须在 build 之后（读的是成品场景）", readIdx > buildIdx);
        assertTrue("read 必须在 criteria 之前（产物先落，判据才能引用）", readIdx < indexOf(segments, "criteria"));
        assertTrue(camerasIdx > readIdx);
    }

    /** 空 read 段给 warning 而不是错误（用的是 read 段但写空了，调用方该被提醒）。 */
    @Test
    public void emptyReadSegmentWarns() {
        JsonObject c = caseWithRead();
        c.add("read", new JsonArray());
        JsonObject plan = CaseValidator.validate(Json.toJson(c));
        assertTrue(
            Json.optArray(plan, "warnings")
                .toString()
                .contains("read 段为空"));
    }

    // ------------------------------------------------------------ 拒绝口径

    /** 读面段只放 read.* 动作：写动作必须走 build 段（静态可查的只读纪律落点）。 */
    @Test
    public void nonReadActionIsRejected() {
        JsonObject c = caseWithRead();
        c.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .addProperty("action", "world.rebuild");
        assertTrue(mentionsField(planError(c), "read[0].action"));
    }

    /** 未知字段报错（严格模式，防笔误静默）。 */
    @Test
    public void unknownReadStepFieldIsRejected() {
        JsonObject c = caseWithRead();
        c.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .addProperty("out", "read/x.json");
        assertTrue(mentionsField(planError(c), "read[0].out"));
    }

    /** 缺 action / 缺 path 逐字段报错。 */
    @Test
    public void missingActionAndPathAreRejected() {
        JsonObject c = caseWithRead();
        JsonObject step = c.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject();
        step.remove("action");
        assertTrue(mentionsField(planError(c), "read[0].action"));

        JsonObject c2 = caseWithRead();
        c2.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .remove("path");
        assertTrue(mentionsField(planError(c2), "read[0].path"));
    }

    /** 路径重复要报错：后一步会静默覆盖前一步，判据引用哪一份就说不清了。 */
    @Test
    public void duplicateReadPathIsRejected() {
        JsonObject c = caseWithRead();
        c.getAsJsonArray("read")
            .get(1)
            .getAsJsonObject()
            .addProperty("path", "read/blocks.json");
        assertTrue(mentionsField(planError(c), "read[1].path"));
    }

    /** 不得与运行器自身产物重名（否则会踩掉 criteria.json 之类的记账文件）。 */
    @Test
    public void readPathMustNotShadowRunnerArtifacts() {
        for (String reserved : new String[] { "manifest.json", "criteria.json", "evidence.json", "observation.json" }) {
            JsonObject c = caseWithRead();
            c.getAsJsonArray("read")
                .get(0)
                .getAsJsonObject()
                .addProperty("path", reserved);
            assertTrue("应拒绝重名: " + reserved, mentionsField(planError(c), "read[0].path"));
        }
    }

    /** 路径穿越（绝对路径 / ..）被拒（复用 ArtifactStore.resolveInRun 的同一套判定）。 */
    @Test
    public void readPathTraversalIsRejected() {
        JsonObject c = caseWithRead();
        c.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .addProperty("path", "../outside.json");
        assertTrue(mentionsField(planError(c), "read[0].path"));

        JsonObject c2 = caseWithRead();
        c2.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .addProperty("path", "/absolute.json");
        assertTrue(mentionsField(planError(c2), "read[0].path"));
    }

    /** read 段本身形态非法（不是数组 / 元素不是对象）报错。 */
    @Test
    public void malformedReadSegmentIsRejected() {
        JsonObject c = caseWithRead();
        c.addProperty("read", "not-an-array");
        assertTrue(mentionsField(planError(c), "read"));

        JsonObject c2 = caseWithRead();
        JsonArray arr = new JsonArray();
        arr.add("not-an-object");
        c2.add("read", arr);
        assertTrue(mentionsField(planError(c2), "read[0]"));
    }

    /** params 不是对象报错（读面参数必须显式结构化）。 */
    @Test
    public void nonObjectParamsIsRejected() {
        JsonObject c = caseWithRead();
        c.getAsJsonArray("read")
            .get(0)
            .getAsJsonObject()
            .addProperty("params", "oops");
        assertTrue(mentionsField(planError(c), "read[0].params"));
    }

    /** 变体可以打补丁到 read 段（负对照「读数变了判据该红」的基础）。 */
    @Test
    public void variantCanPatchReadParams() {
        JsonObject c = caseWithRead();
        JsonObject variants = new JsonObject();
        JsonArray arr = new JsonArray();
        JsonObject v = new JsonObject();
        v.addProperty("id", "neg-blocks-empty");
        JsonArray mutate = new JsonArray();
        JsonObject p = new JsonObject();
        p.addProperty("op", "replace");
        p.addProperty("path", "/read/0/params/from/0");
        p.addProperty("value", -64);
        mutate.add(p);
        v.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("blocks-field");
        v.add("expectCriteriaRed", red);
        arr.add(v);
        variants.add("expect", arr);
        c.add("variants", arr);

        JsonObject plan = CaseValidator.validate(Json.toJson(c));
        JsonObject vp = Json.optArray(plan, "variants")
            .get(0)
            .getAsJsonObject();
        assertTrue("补丁应可用", Json.optBool(vp, "applicable", false));
    }

    // ------------------------------------------------------------ 夹具

    private static JsonObject minimalCase() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", "lightning.case/1");
        c.addProperty("id", "read-seg");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_read_seg");
        world.addProperty("seed", 1);
        world.addProperty("void", true);
        c.add("world", world);
        JsonArray criteria = new JsonArray();
        JsonObject crit = new JsonObject();
        crit.addProperty("id", "blocks-field");
        crit.addProperty("type", "json-field");
        JsonObject params = new JsonObject();
        params.addProperty("path", "read/blocks.json");
        params.addProperty("pointer", "/volume");
        crit.add("params", params);
        crit.addProperty("expect", 1);
        criteria.add(crit);
        c.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        evidence.add("expect", new JsonArray());
        c.add("evidence", evidence);
        return c;
    }

    private static JsonObject caseWithRead() {
        JsonObject c = minimalCase();
        JsonArray read = new JsonArray();

        JsonObject s1 = new JsonObject();
        s1.addProperty("action", "read.blocks");
        JsonObject p1 = new JsonObject();
        JsonArray from = new JsonArray();
        from.add(64);
        from.add(12);
        from.add(64);
        JsonArray to = new JsonArray();
        to.add(65);
        to.add(13);
        to.add(65);
        p1.add("from", from);
        p1.add("to", to);
        s1.add("params", p1);
        s1.addProperty("path", "read/blocks.json");
        s1.addProperty("role", "read-blocks");
        read.add(s1);

        JsonObject s2 = new JsonObject();
        s2.addProperty("action", "read.diff");
        JsonObject p2 = new JsonObject();
        p2.addProperty("expectManifestFile", "cp_read_seg");
        s2.add("params", p2);
        s2.addProperty("path", "read/diff.json");
        read.add(s2);

        c.add("read", read);
        return c;
    }

    private static int indexOf(JsonArray arr, String value) {
        for (int i = 0; i < arr.size(); i++) {
            if (value.equals(
                arr.get(i)
                    .getAsString())) {
                return i;
            }
        }
        return -1;
    }

    private static JsonObject planError(JsonObject c) {
        try {
            CaseValidator.validate(Json.toJson(c));
            fail("应报 CP-VALID-002");
            return null;
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            return e.context();
        }
    }

    private static boolean mentionsField(JsonObject context, String field) {
        JsonArray fields = Json.optArray(context, "fields");
        for (int i = 0; fields != null && i < fields.size(); i++) {
            JsonObject f = fields.get(i)
                .getAsJsonObject();
            String name = Json.optString(f, "field", "");
            if (name.equals(field) || name.startsWith(field + ".") || name.startsWith(field + "[")) {
                return true;
            }
        }
        return false;
    }
}
