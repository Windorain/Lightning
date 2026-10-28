package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 用例 {@code action} 段（v1.6）的解析与校验单测。
 *
 * <h2>这一段为什么是 L2 的落点</h2>
 * L2 的定义是「L0/L1 的<b>有序编排</b>，可重放、<b>逐步断言</b>」。在本段之前，
 * 用例能表达的世界写只有 {@code build} 段的四种构建 op——{@code scene.*}（L0）与
 * {@code player.*}（L1）一步也进不了固定程序。本段把接缝封上：逐条执行用例声明的任意
 * <b>同步</b>动作，产物落 run 目录，{@code expect} 非空时当场断言。
 *
 * <p>
 * 这里锁住它的<b>形态与拒绝口径</b>（解析、段序、路径纪律、收尾原语禁令、逐步断言形态）；
 * 执行期（真的调动作、真的落盘、真的逐步断言）由 runClient 实测覆盖。
 */
public class CaseActionSegmentTest {

    // ------------------------------------------------------------ 解析

    /** 编排步骤被原样解析：action/params/path/role/expect 一个不少。 */
    @Test
    public void actionStepsAreParsed() {
        CaseFile f = new CaseParser().parse(Json.toJson(caseWithAction()));
        assertEquals(
            2,
            f.action()
                .size());

        CaseFile.ActionStep first = f.action()
            .get(0);
        assertEquals("scene.player.pose", first.action());
        assertEquals("action/0-pose.json", first.path());
        assertEquals("scene-player-pose", first.role());
        assertEquals(
            3,
            Json.optArray(first.params(), "pos")
                .size());
        assertTrue(first.hasExpect());
        assertEquals(
            true,
            first.expect()
                .get("/after/isFlying")
                .getAsBoolean());

        CaseFile.ActionStep second = f.action()
            .get(1);
        assertEquals("player.place_block", second.action());
        assertEquals("action/1-place.json", second.path());
        assertFalse("未声明 expect 时 hasExpect 必须为 false", second.hasExpect());
    }

    /** 未声明 action 段时是空列表（不是 null）——调用方按「段为空」处理。 */
    @Test
    public void absentActionSegmentYieldsEmptyList() {
        JsonObject c = minimalCase();
        CaseFile f = new CaseParser().parse(Json.toJson(c));
        assertNotNull(f.action());
        assertEquals(
            0,
            f.action()
                .size());
    }

    /**
     * 段序：{@code action} 在 {@code read} 之后、{@code cameras} 之前。
     *
     * <p>
     * 两个约束都是有理由的，不是随手排的：
     * <ul>
     * <li>在 {@code read} 之后：读面读的是「成品场景」，编排要改世界就该发生在读数之后
     * （否则读数说的是改动前的世界，而调用方以为它说的是当前的）；</li>
     * <li>在 {@code cameras} 之前：截图与判据必须说同一个世界——编排若排在拍摄之后，
     * 截图里的世界与 criteria 段读到的世界就不是一回事了。</li>
     * </ul>
     */
    @Test
    public void actionSegmentSitsBetweenReadAndCameras() {
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWithAction()));
        JsonArray segments = Json.optArray(plan, "segments");
        int readIdx = indexOf(segments, "read");
        int actionIdx = indexOf(segments, "action");
        int camerasIdx = indexOf(segments, "cameras");
        assertTrue("action 必须在 read 之后", actionIdx > readIdx);
        assertTrue("action 必须在 cameras 之前（截图与判据必须说同一个世界）", actionIdx < camerasIdx);
        // 规范化段清单与执行期段清单必须同源
        for (int i = 0; i < segments.size(); i++) {
            assertEquals(
                CaseValidator.SEGMENTS.get(i),
                segments.get(i)
                    .getAsString());
        }
    }

    /** 规范化计划的 action 段带 index，且与用例声明同序。 */
    @Test
    public void planCarriesActionStepsWithIndex() {
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWithAction()));
        JsonArray action = Json.optArray(plan, "action");
        assertNotNull(action);
        assertEquals(2, action.size());
        assertEquals(
            0,
            Json.optInt(
                action.get(0)
                    .getAsJsonObject(),
                "index",
                -1));
        assertEquals(
            "scene.player.pose",
            Json.optString(
                action.get(0)
                    .getAsJsonObject(),
                "action",
                null));
        assertEquals(
            1,
            Json.optInt(
                action.get(1)
                    .getAsJsonObject(),
                "index",
                -1));
    }

    /** 空 action 段给 warning 而不是错误（声明了但写空了，多半是笔误）。 */
    @Test
    public void emptyActionSegmentWarns() {
        JsonObject c = caseWithAction();
        c.add("action", new JsonArray());
        JsonObject plan = CaseValidator.validate(Json.toJson(c));
        assertTrue(
            Json.optArray(plan, "warnings")
                .toString()
                .contains("action 段为空"));
    }

    /** 编排段<b>不限</b>动作名前缀：L0（scene.）与 L1（player.）都要能进用例。 */
    @Test
    public void actionSegmentAcceptsBothL0AndL1ActionNames() {
        JsonObject c = minimalCase();
        JsonArray action = new JsonArray();
        action.add(step("scene.inventory.write", "action/0-give.json", null));
        action.add(step("player.place_block", "action/1-place.json", null));
        action.add(step("read.blocks", "action/2-read.json", null));
        c.add("action", action);
        JsonObject plan = CaseValidator.validate(Json.toJson(c));
        assertEquals(
            3,
            Json.optArray(plan, "action")
                .size());
    }

    // ------------------------------------------------------------ 拒绝口径

    /** 收尾原语不得编入固定程序：它会让本作业后续段不再执行。 */
    @Test
    public void shutdownActionIsRejectedInActionSegment() {
        JsonObject c = minimalCase();
        JsonArray action = new JsonArray();
        action.add(step("core.shutdown", "action/0-shutdown.json", null));
        c.add("action", action);
        assertTrue(mentionsField(planError(c), "action[0].action"));
    }

    /** 收尾原语的禁令名单是可核对的（不是散落在代码里的魔法字符串）。 */
    @Test
    public void forbiddenActionListIsExplicit() {
        assertTrue(CaseValidator.ACTION_FORBIDDEN.contains("core.shutdown"));
        assertFalse(CaseValidator.ACTION_FORBIDDEN.contains("scene.player.pose"));
    }

    /** 未知字段报错（严格模式，防笔误静默）。 */
    @Test
    public void unknownActionStepFieldIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .addProperty("out", "action/x.json");
        assertTrue(mentionsField(planError(c), "action[0].out"));
    }

    /** 缺 action / 缺 path 逐字段报错。 */
    @Test
    public void missingActionAndPathAreRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .remove("action");
        assertTrue(mentionsField(planError(c), "action[0].action"));

        JsonObject c2 = caseWithAction();
        c2.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .remove("path");
        assertTrue(mentionsField(planError(c2), "action[0].path"));
    }

    /** 路径重复要报错：后一步会静默覆盖前一步，判据引用哪一份就说不清了。 */
    @Test
    public void duplicateActionPathIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(1)
            .getAsJsonObject()
            .addProperty("path", "action/0-pose.json");
        assertTrue(mentionsField(planError(c), "action[1].path"));
    }

    /** 不得与运行器自身产物重名（否则会踩掉 criteria.json 之类的记账文件）。 */
    @Test
    public void actionPathMustNotShadowRunnerArtifacts() {
        for (String reserved : new String[] { "manifest.json", "criteria.json", "evidence.json", "observation.json" }) {
            JsonObject c = caseWithAction();
            c.getAsJsonArray("action")
                .get(0)
                .getAsJsonObject()
                .addProperty("path", reserved);
            assertTrue("应拒绝重名: " + reserved, mentionsField(planError(c), "action[0].path"));
        }
    }

    /** 路径穿越（绝对路径 / ..）被拒（复用 ArtifactStore.resolveInRun 的同一套判定）。 */
    @Test
    public void actionPathTraversalIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .addProperty("path", "../outside.json");
        assertTrue(mentionsField(planError(c), "action[0].path"));

        JsonObject c2 = caseWithAction();
        c2.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .addProperty("path", "/absolute.json");
        assertTrue(mentionsField(planError(c2), "action[0].path"));
    }

    /** action 段本身形态非法（不是数组 / 元素不是对象）报错。 */
    @Test
    public void malformedActionSegmentIsRejected() {
        JsonObject c = caseWithAction();
        c.addProperty("action", "not-an-array");
        assertTrue(mentionsField(planError(c), "action"));

        JsonObject c2 = caseWithAction();
        JsonArray arr = new JsonArray();
        arr.add("not-an-object");
        c2.add("action", arr);
        assertTrue(mentionsField(planError(c2), "action[0]"));
    }

    /** params 不是对象报错（编排参数必须显式结构化）。 */
    @Test
    public void nonObjectParamsIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .addProperty("params", "oops");
        assertTrue(mentionsField(planError(c), "action[0].params"));
    }

    // ------------------------------------------------------------ 逐步断言形态

    /** expect 必须是对象（{指针: 期望值}）。 */
    @Test
    public void nonObjectExpectIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .addProperty("expect", "oops");
        assertTrue(mentionsField(planError(c), "action[0].expect"));
    }

    /** 空 expect 是错误：空断言集恒绿（恒绿假断言是明确要防的失效模式）。 */
    @Test
    public void emptyExpectIsRejected() {
        JsonObject c = caseWithAction();
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .add("expect", new JsonObject());
        assertTrue(mentionsField(planError(c), "action[0].expect"));
    }

    /** 指针必须以 / 开头（或为空串 = 整棵结果对象）；否则报错。 */
    @Test
    public void badExpectPointerIsRejected() {
        JsonObject c = caseWithAction();
        JsonObject expect = new JsonObject();
        expect.addProperty("after/isFlying", true);
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .add("expect", expect);
        assertTrue(mentionsField(planError(c), "action[0].expect"));
    }

    /** 空串指针合法（表示「整棵结果对象」，与 json-field 的空指针同口径）。 */
    @Test
    public void emptyPointerExpectIsAccepted() {
        JsonObject c = caseWithAction();
        JsonObject expect = new JsonObject();
        expect.addProperty("", "anything");
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .add("expect", expect);
        JsonObject plan = CaseValidator.validate(Json.toJson(c));
        assertEquals(
            1,
            Json.size(
                Json.optArray(plan, "action")
                    .get(0)
                    .getAsJsonObject()
                    .getAsJsonObject("expect")));
    }

    /** 单步断言条数有上限（防一次编排写出上万条断言）。 */
    @Test
    public void tooManyStepAssertionsAreRejected() {
        JsonObject c = caseWithAction();
        JsonObject expect = new JsonObject();
        for (int i = 0; i <= CaseValidator.MAX_STEP_EXPECT; i++) {
            expect.addProperty("/k" + i, i);
        }
        c.getAsJsonArray("action")
            .get(0)
            .getAsJsonObject()
            .add("expect", expect);
        assertTrue(mentionsField(planError(c), "action[0].expect"));
    }

    /** 变体可以打补丁到 action 段（负对照「编排参数变了判据该红」的基础）。 */
    @Test
    public void variantCanPatchActionParams() {
        JsonObject c = caseWithAction();
        JsonArray variants = new JsonArray();
        JsonObject v = new JsonObject();
        v.addProperty("id", "neg-pose-flipped");
        JsonArray mutate = new JsonArray();
        JsonObject p = new JsonObject();
        p.addProperty("op", "replace");
        p.addProperty("path", "/action/0/params/pos/0");
        p.addProperty("value", -64);
        mutate.add(p);
        v.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("blocks-field");
        v.add("expectCriteriaRed", red);
        variants.add(v);
        c.add("variants", variants);

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
        c.addProperty("id", "action-seg");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_action_seg");
        world.addProperty("seed", 1);
        world.addProperty("void", true);
        c.add("world", world);
        JsonArray criteria = new JsonArray();
        JsonObject crit = new JsonObject();
        crit.addProperty("id", "blocks-field");
        crit.addProperty("type", "json-field");
        JsonObject params = new JsonObject();
        params.addProperty("path", "action/0-pose.json");
        params.addProperty("pointer", "/observed");
        crit.add("params", params);
        crit.addProperty("expect", true);
        criteria.add(crit);
        c.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        evidence.add("expect", new JsonArray());
        c.add("evidence", evidence);
        return c;
    }

    private static JsonObject caseWithAction() {
        JsonObject c = minimalCase();
        JsonArray action = new JsonArray();

        JsonObject expect = new JsonObject();
        expect.addProperty("/after/isFlying", true);
        expect.addProperty("/observed", true);
        action.add(step("scene.player.pose", "action/0-pose.json", expect));

        action.add(step("player.place_block", "action/1-place.json", null));

        c.add("action", action);
        return c;
    }

    private static JsonObject step(String action, String path, JsonObject expect) {
        JsonObject s = new JsonObject();
        s.addProperty("action", action);
        JsonObject params = new JsonObject();
        JsonArray pos = new JsonArray();
        pos.add(64.5d);
        pos.add(13.0d);
        pos.add(64.5d);
        params.add("pos", pos);
        s.add("params", params);
        s.addProperty("path", path);
        s.addProperty("role", action.replace('.', '-'));
        if (expect != null) {
            s.add("expect", expect);
        }
        return s;
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
