package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * G1（{@code input-contract.md} §9.2 / {@code case-file.md} §3.2）静态校验面的单测：
 * 用例文件的 {@code action} 段如何表达「跨帧的输入固定程序」。
 *
 * <h2>这一层判什么</h2>
 * ①{@code action} 段接受输入族步进动作（{@code input.key} / {@code input.mouse}）——白名单是
 * {@link CaseValidator#ACTION_STEPPING_INPUT_ACTIONS}（唯一来源，执行期取同一份）；
 * ②顶层 {@code holdTicks}（D-3）的取值域与<b>适用性</b>：精确整数 1..1200、只对输入族步进动作、
 * 且只对会持有的那两种动作形态（{@code input.key action=tap} / {@code input.mouse op=click}）；
 * ③不适用字段<b>显式拒绝</b>（同步动作写 {@code holdTicks}、{@code params} 内写 {@code holdTicks}）；
 * ④旧禁令不变：{@code core.shutdown} 仍被 {@link CaseValidator#ACTION_FORBIDDEN} 挡在编排之外。
 *
 * <p>
 * 执行期（真的跨 tick 推进、真的释放持键）由
 * {@code CaseActionSteppingDriverTest} 覆盖；两者合起来才是「静态与执行期同源」。
 */
public class CaseActionHoldTicksTest {

    // ------------------------------------------------------------ ① 输入族步进动作进编排段

    /** 输入族步进动作带顶层 {@code holdTicks} 被接受，且规范化计划原样回显它（顶层，不在 params 内）。 */
    @Test
    public void topLevelHoldTicksIsAcceptedAndEchoedInPlan() {
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWith(inputKey("tap", 20), "action/0-hold-w.json")));
        JsonObject step = Json.optArray(plan, "action")
            .get(0)
            .getAsJsonObject();
        assertEquals(20, Json.optInt(step, "holdTicks", -1));
        assertNull("holdTicks 不得落进 params（D-3：它是编排属性，不是动作参数）", Json.get(Json.optObject(step, "params"), "holdTicks"));
    }

    /** 取值域的上下边界都接受：1（同一次调用内 down+up）与 1200（设施持有上限）。 */
    @Test
    public void holdTicksBoundariesAreAccepted() {
        for (int v : new int[] { 1, 1200 }) {
            JsonObject plan = CaseValidator.validate(Json.toJson(caseWith(inputKey("tap", v), "action/0-hold.json")));
            assertEquals(
                v,
                Json.optInt(
                    Json.optArray(plan, "action")
                        .get(0)
                        .getAsJsonObject(),
                    "holdTicks",
                    -1));
        }
    }

    /** 输入族的同步动作（{@code input.text}/{@code input.release}/{@code input.state}）照旧接受（它们是同步动作）。 */
    @Test
    public void inputSyncActionsAreAcceptedWithoutHoldTicks() {
        JsonArray steps = new JsonArray();
        steps.add(step("input.text", "action/0-text.json", params("text", "hi"), null, null));
        steps.add(step("input.release", "action/1-release.json", null, null, null));
        steps.add(step("input.state", "action/2-state.json", null, null, null));
        steps.add(step("input.mouse", "action/3-move.json", params("op", "move"), null, null));
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWithSteps(steps)));
        assertEquals(
            4,
            Json.optArray(plan, "action")
                .size());
    }

    /** 白名单是显式的、可核对的（不是散落在代码里的魔法字符串），且只含输入族步进动作。 */
    @Test
    public void steppingWhitelistIsExplicit() {
        assertTrue(CaseValidator.ACTION_STEPPING_INPUT_ACTIONS.contains("input.key"));
        assertTrue(CaseValidator.ACTION_STEPPING_INPUT_ACTIONS.contains("input.mouse"));
        assertFalse(CaseValidator.ACTION_STEPPING_INPUT_ACTIONS.contains("core.shutdown"));
        assertFalse(CaseValidator.ACTION_STEPPING_INPUT_ACTIONS.contains("world.rebuild"));
        assertEquals(1200, CaseValidator.MAX_STEP_HOLD_TICKS);
        assertEquals("holdTicks", CaseValidator.FIELD_HOLD_TICKS);
    }

    // ------------------------------------------------------------ ③ holdTicks 取值域

    /** 越界（0 / 负数 / 1201）逐条拒绝，且错误落在既有错误码 + 字段上下文上。 */
    @Test
    public void outOfRangeHoldTicksIsRejectedPerValue() {
        for (int v : new int[] { 0, -1, 1201, 100000 }) {
            JsonObject context = planError(caseWith(inputKey("tap", v), "action/0-hold.json"));
            assertTrue("holdTicks=" + v + " 应被拒并指名字段", mentionsField(context, "action[0].holdTicks"));
            assertTrue("错误说明应给出取值域", fieldsText(context).contains("1.." + CaseValidator.MAX_STEP_HOLD_TICKS));
        }
    }

    /** 非整数（1.5 / 字符串 / 布尔）逐条拒绝——不做截断、不做解析（与全仓 TYPE_INT 同口径）。 */
    @Test
    public void nonIntegerHoldTicksIsRejected() {
        JsonArray bad = new JsonArray();
        bad.add(new JsonPrimitive(Double.valueOf(1.5D)));
        bad.add(new JsonPrimitive("20"));
        bad.add(new JsonPrimitive(Boolean.TRUE));
        for (int i = 0; i < bad.size(); i++) {
            JsonObject c = caseWith(inputKey("tap", 1), "action/0-hold.json");
            c.getAsJsonArray("action")
                .get(0)
                .getAsJsonObject()
                .add("holdTicks", bad.get(i));
            assertTrue("非整数 holdTicks " + bad.get(i) + " 应被拒", mentionsField(planError(c), "action[0].holdTicks"));
        }
    }

    // ------------------------------------------------------------ ③' 不适用字段必须显式拒绝

    /** 同步动作写 {@code holdTicks}：不适用 ⇒ 显式拒绝（不许静默忽略）。 */
    @Test
    public void holdTicksOnSyncActionIsExplicitlyRejected() {
        JsonObject c = caseWith(step("scene.player.pose", "action/0-pose.json", params("pos", "x"), 20, null), null);
        JsonObject context = planError(c);
        assertTrue(mentionsField(context, "action[0].holdTicks"));
        assertTrue("拒绝理由应说明「不适用」而非「越界」", fieldsText(context).contains("不适用"));
    }

    /** {@code params} 内出现 {@code holdTicks}：两处真值来源不明 ⇒ 拒绝（input-contract §9.2 第 2 条）。 */
    @Test
    public void holdTicksInsideParamsIsRejected() {
        JsonObject step = inputKey("tap", 20);
        step.getAsJsonObject("params")
            .addProperty("holdTicks", 20);
        JsonObject context = planError(caseWith(step, "action/0-hold.json"));
        assertTrue(mentionsField(context, "action[0].params.holdTicks"));
    }

    /** 只在 {@code params} 里写（顶层没写）同样拒绝：D-3 的位置是契约，不是风格。 */
    @Test
    public void holdTicksOnlyInsideParamsIsAlsoRejected() {
        JsonObject step = inputKey("tap", null);
        step.getAsJsonObject("params")
            .addProperty("holdTicks", 20);
        JsonObject context = planError(caseWith(step, "action/0-hold.json"));
        assertTrue(mentionsField(context, "action[0].params.holdTicks"));
    }

    /** {@code input.key} 的 {@code action} 不是 {@code tap}：该形态不持有 ⇒ 顶层 holdTicks 无真值来源。 */
    @Test
    public void holdTicksOnNonTapKeyIsRejected() {
        for (String action : new String[] { "down", "up", null }) {
            JsonObject step = inputKey(action, 20);
            JsonObject context = planError(caseWith(step, "action/0-key.json"));
            assertTrue("action=" + action + " 时 holdTicks 不适用", mentionsField(context, "action[0].holdTicks"));
        }
    }

    /** {@code input.mouse} 的 {@code op} 不是 {@code click}：同理不适用。 */
    @Test
    public void holdTicksOnNonClickMouseIsRejected() {
        for (String op : new String[] { "move", "relative", "down", "up", "wheel", null }) {
            JsonObject step = step("input.mouse", "action/0-mouse.json", params("op", op), 20, null);
            JsonObject context = planError(caseWith(step, "action/0-mouse.json"));
            assertTrue("op=" + op + " 时 holdTicks 不适用", mentionsField(context, "action[0].holdTicks"));
        }
    }

    /** {@code input.mouse op=click} 的顶层 {@code holdTicks} 合法（跨帧点击）。 */
    @Test
    public void holdTicksOnClickMouseIsAccepted() {
        JsonObject plan = CaseValidator.validate(
            Json.toJson(caseWith(step("input.mouse", "action/0-click.json", params("op", "click"), 2, null), null)));
        assertEquals(
            2,
            Json.optInt(
                Json.optArray(plan, "action")
                    .get(0)
                    .getAsJsonObject(),
                "holdTicks",
                -1));
    }

    // ------------------------------------------------------------ ④ 旧禁令不变

    /** 收尾原语仍不得进编排段（ACTION_FORBIDDEN 口径不变，G1 不动它）。 */
    @Test
    public void shutdownIsStillForbiddenInActionSegment() {
        JsonObject context = planError(
            caseWith(step("core.shutdown", "action/0-shutdown.json", null, null, null), null));
        assertTrue(mentionsField(context, "action[0].action"));
        assertTrue(CaseValidator.ACTION_FORBIDDEN.contains("core.shutdown"));
    }

    /** 读面段仍只许 {@code read.*}：输入是写，不能混进读面（{@code READ_ACTION_PREFIX} 不变）。 */
    @Test
    public void readSegmentStillRejectsInputActions() {
        JsonObject c = minimalCase();
        JsonArray read = new JsonArray();
        JsonObject r = new JsonObject();
        r.addProperty("action", "input.key");
        JsonObject params = new JsonObject();
        params.addProperty("key", "key.forward");
        params.addProperty("action", "tap");
        r.add("params", params);
        r.addProperty("path", "read/0-input.json");
        read.add(r);
        c.add("read", read);
        assertTrue(mentionsField(planError(c), "read[0].action"));
    }

    /** 没写 {@code holdTicks} 的旧用例：规范化计划里<b>不出现</b>该键（纯增量，A3 基准不失效）。 */
    @Test
    public void planWithoutHoldTicksIsNotPolluted() {
        JsonObject plan = CaseValidator.validate(
            Json.toJson(
                caseWith(step("scene.player.pose", "action/0-pose.json", params("pos", "x"), null, null), null)));
        JsonObject step = Json.optArray(plan, "action")
            .get(0)
            .getAsJsonObject();
        assertNull(Json.get(step, "holdTicks"));
        assertNotNull(step.get("params"));
    }

    /**
     * 别的动作自己的 {@code params.holdTicks} 不受 G1 约束：{@code params} 是<b>动作的</b>参数空间。
     *
     * <p>
     * 这条是实机资产逼出来的：回归用例 {@code test/cases/regression/l1-orchestration.json} 里
     * {@code player.dig} 用 {@code params.holdTicks:1}（它自己的合法动作参数）。把「params 里不许有
     * holdTicks」当成全局规则会让那份既有用例凭空非法——那是用一个编排层字段名越界否决动作参数域。
     */
    @Test
    public void otherActionsOwnParamsHoldTicksIsNotConstrained() {
        JsonObject dig = step("player.dig", "action/0-dig.json", digParams(), null, null);
        JsonObject plan = CaseValidator.validate(Json.toJson(caseWith(dig, null)));
        assertEquals(
            1,
            Json.optInt(
                Json.optObject(
                    Json.optArray(plan, "action")
                        .get(0)
                        .getAsJsonObject(),
                    "params"),
                "holdTicks",
                -1));
    }

    private static JsonObject digParams() {
        JsonObject p = new JsonObject();
        JsonArray at = new JsonArray();
        at.add(65);
        at.add(12);
        at.add(64);
        p.add("at", at);
        p.addProperty("holdTicks", 1);
        return p;
    }

    // ------------------------------------------------------------ 夹具

    private static JsonObject minimalCase() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", "lightning.case/1");
        c.addProperty("id", "action-holdticks");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_action_holdticks");
        world.addProperty("seed", 1);
        world.addProperty("void", true);
        c.add("world", world);
        JsonArray criteria = new JsonArray();
        JsonObject crit = new JsonObject();
        crit.addProperty("id", "artifact-present");
        crit.addProperty("type", "artifact-exists");
        JsonObject cp = new JsonObject();
        cp.addProperty("path", "action/0-hold.json");
        crit.add("params", cp);
        criteria.add(crit);
        c.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        evidence.add("expect", new JsonArray());
        c.add("evidence", evidence);
        return c;
    }

    private static JsonObject caseWith(JsonObject step, String unusedPath) {
        JsonArray steps = new JsonArray();
        steps.add(step);
        return caseWithSteps(steps);
    }

    private static JsonObject caseWithSteps(JsonArray steps) {
        JsonObject c = minimalCase();
        c.add("action", steps);
        return c;
    }

    /** {@code input.key} 步：{@code action} 为 null 表示故意不写该键（测「形态不适用」）。 */
    private static JsonObject inputKey(String action, Integer holdTicks) {
        JsonObject params = new JsonObject();
        params.addProperty("key", "key.forward");
        if (action != null) {
            params.addProperty("action", action);
        }
        return step("input.key", "action/0-hold.json", params, holdTicks, null);
    }

    private static JsonObject step(String action, String path, JsonObject params, Integer holdTicks,
        JsonObject expect) {
        JsonObject s = new JsonObject();
        s.addProperty("action", action);
        s.add("params", params == null ? new JsonObject() : params);
        s.addProperty("path", path);
        if (holdTicks != null) {
            // 顶层：与 params 并列（D-3）
            s.addProperty("holdTicks", holdTicks.intValue());
        }
        if (expect != null) {
            s.add("expect", expect);
        }
        return s;
    }

    private static JsonObject params(String k, String v) {
        JsonObject p = new JsonObject();
        if (v == null) {
            p.add(k, com.google.gson.JsonNull.INSTANCE);
        } else {
            p.addProperty(k, v);
        }
        return p;
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
            String name = Json.optString(
                fields.get(i)
                    .getAsJsonObject(),
                "field",
                "");
            if (name.equals(field) || name.startsWith(field + ".") || name.startsWith(field + "[")) {
                return true;
            }
        }
        return false;
    }

    private static String fieldsText(JsonObject context) {
        JsonArray fields = Json.optArray(context, "fields");
        return fields == null ? "" : fields.toString();
    }
}
