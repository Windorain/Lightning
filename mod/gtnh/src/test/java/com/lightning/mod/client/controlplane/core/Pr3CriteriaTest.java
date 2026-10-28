package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.file.Path;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * 1.2 判据的单测（case-file.md §5 的双轨口径）：{@code te-state-equals}（运行期轨）与
 * {@code image-uniform}（图像轨）的<b>解析/校验</b>与<b>求值接线</b>。
 *
 * <p>
 * 求值侧全程用 core 的 {@link CriteriaEngine.RuntimeTeSource} 假源：真实 TE 读取在 mc 层的
 * {@code TeDescriber} 里（无 MC 不能单测），但「拿状态 → RFC 6901 取指针 → 与 expect 比较 → 红/绿/error」
 * 这条链路完全是 core 的，正是本测试覆盖的对象。
 */
public class Pr3CriteriaTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // ------------------------------------------------------------ 注册表与自描述

    /** 两条新判据在注册表里，且自描述给出 since=1.2。 */
    @Test
    public void registryAndCatalogCarryPr3Types() {
        assertTrue(CriteriaEngine.isKnownType(CriteriaEngine.TYPE_TE_STATE_EQUALS));
        assertTrue(CriteriaEngine.isKnownType(CriteriaEngine.TYPE_IMAGE_UNIFORM));
        assertTrue(CriteriaEngine.TYPES.contains("te-state-equals"));
        assertTrue(CriteriaEngine.TYPES.contains("image-uniform"));

        assertEquals(CriteriaEngine.SINCE_1_2, CriteriaEngine.typeSince(CriteriaEngine.TYPE_TE_STATE_EQUALS));
        assertEquals(CriteriaEngine.SINCE_1_2, CriteriaEngine.typeSince(CriteriaEngine.TYPE_IMAGE_UNIFORM));
        assertEquals(CriteriaEngine.SINCE_1_1, CriteriaEngine.typeSince(CriteriaEngine.TYPE_IMAGE_NOT_UNIFORM));
        assertEquals(CriteriaEngine.SINCE_1_0, CriteriaEngine.typeSince(CriteriaEngine.TYPE_JSON_FIELD));
        assertNull(CriteriaEngine.typeSince("nope"));

        // 自描述目录与 TYPES 同源同序：逐条对上，不重复不遗漏
        JsonArray catalog = CriteriaEngine.typeCatalog();
        assertEquals(CriteriaEngine.TYPES.size(), catalog.size());
        for (int i = 0; i < catalog.size(); i++) {
            JsonObject d = catalog.get(i)
                .getAsJsonObject();
            assertEquals(CriteriaEngine.TYPES.get(i), Json.optString(d, "type", null));
            assertNotNull(Json.optString(d, "since", null));
            assertNotNull(Json.optString(d, "params", null));
        }
    }

    // ------------------------------------------------------------ 校验（case.validate 路径）

    /** 格式齐备的 te-state-equals 通过校验，且参数原样进计划。 */
    @Test
    public void planAcceptsWellFormedTeStateEquals() {
        JsonObject c = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        JsonObject plan = CaseValidator.validate(Json.toJson(minimalCase(c)));
        JsonObject norm = plan.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject();
        assertEquals(CriteriaEngine.TYPE_TE_STATE_EQUALS, Json.optString(norm, "type", null));
        assertEquals("/connections/UP", Json.optString(Json.optObject(norm, "params"), "key", null));
        assertEquals(
            64,
            Json.optObject(norm, "params")
                .getAsJsonArray("at")
                .get(2)
                .getAsInt());
        assertTrue(norm.has("expect"));
    }

    /** at/key/expect 三者缺一都报 CP-VALID-002，且逐字段指出。 */
    @Test
    public void planRejectsTeStateEqualsWithoutAtKeyExpect() {
        JsonObject noAt = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        noAt.getAsJsonObject("params")
            .remove("at");
        assertTrue(mentions(planError(noAt), "criteria[0].params.at"));

        JsonObject noKey = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        noKey.getAsJsonObject("params")
            .remove("key");
        assertTrue(mentions(planError(noKey), "criteria[0].params.key"));

        JsonObject noExpect = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        noExpect.remove("expect");
        assertTrue(mentions(planError(noExpect), "criteria[0].expect"));

        JsonObject badKey = teCriterion(new int[] { 65, 12, 64 }, "connections/UP", new JsonPrimitive(true));
        assertTrue(mentions(planError(badKey), "criteria[0].params.key"));

        JsonObject badAt = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        JsonArray two = new JsonArray();
        two.add(65);
        two.add(12);
        badAt.getAsJsonObject("params")
            .add("at", two);
        assertTrue(mentions(planError(badAt), "criteria[0].params.at"));

        // y 越界（1.7.10 世界高度 0..255）
        JsonObject badY = teCriterion(new int[] { 65, 999, 64 }, "/connections/UP", new JsonPrimitive(true));
        assertTrue(mentions(planError(badY), "criteria[0].params.at"));
    }

    /** image-uniform：minSameColorRatio 缺省补 0.98；越界报错。 */
    @Test
    public void planFillsImageUniformDefaultAndRejectsBadRatio() {
        JsonObject crit = new JsonObject();
        crit.addProperty("id", "u");
        crit.addProperty("type", CriteriaEngine.TYPE_IMAGE_UNIFORM);
        JsonObject params = new JsonObject();
        params.addProperty("path", "shots/far.png");
        crit.add("params", params);
        JsonObject plan = CaseValidator.validate(Json.toJson(minimalCase(crit)));
        JsonObject norm = plan.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject();
        assertEquals(
            ImageCriteria.DEFAULT_MIN_SAME_COLOR_RATIO,
            Json.optObject(norm, "params")
                .get("minSameColorRatio")
                .getAsDouble(),
            1.0e-9d);

        params.addProperty("minSameColorRatio", 1.5d);
        assertTrue(mentions(planError(crit), "criteria[0].params.minSameColorRatio"));
    }

    // ------------------------------------------------------------ 求值（运行期轨）

    /** 指针命中且值相等 → 绿。 */
    @Test
    public void engineGreenWhenPointerMatches() {
        CriteriaEngine engine = engineWith(lpState());
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true)), 0);
        assertEquals(
            Json.optString(verdict, "detail", ""),
            CriteriaEngine.Verdicts.GREEN,
            Json.optString(verdict, "verdict", null));
        assertTrue(
            Json.optString(verdict, "detail", ""),
            Json.optString(verdict, "detail", "")
                .contains("lp-pipe"));
    }

    /** 指针命中但值不等 → 红，detail 同时给期望与实际。 */
    @Test
    public void engineRedWhenValueDiffers() {
        CriteriaEngine engine = engineWith(lpState());
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/DOWN", new JsonPrimitive(true)), 0);
        assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(verdict, "verdict", null));
        String detail = Json.optString(verdict, "detail", "");
        assertTrue(detail, detail.contains("期望") && detail.contains("实际"));
    }

    /** 指针未命中（键名写错）→ 红（与 json-field 同一口径）。 */
    @Test
    public void engineRedOnPointerMiss() {
        CriteriaEngine engine = engineWith(lpState());
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/SIDEWAYS", new JsonPrimitive(true)), 0);
        assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(verdict, "verdict", null));
        assertTrue(
            Json.optString(verdict, "detail", ""),
            Json.optString(verdict, "detail", "")
                .contains("指针未命中"));
    }

    /**
     * 描述器用<b>显式 null</b> 表示「这一面没有部件」：{@code expect: null} 因此可断言为绿，
     * 而键不存在仍是红（两者必须区分得开，否则契约里的「缺席用显式 null」形同虚设）。
     */
    @Test
    public void explicitNullIsGreenButMissingKeyIsRed() {
        JsonObject state = new JsonObject();
        JsonObject parts = new JsonObject();
        parts.add("DOWN", JsonNull.INSTANCE);
        state.add("parts", parts);
        CriteriaEngine engine = engineWith(state);
        JsonObject nullVerdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/parts/DOWN", JsonNull.INSTANCE), 0);
        assertEquals(
            Json.optString(nullVerdict, "detail", ""),
            CriteriaEngine.Verdicts.GREEN,
            Json.optString(nullVerdict, "verdict", null));
        JsonObject missVerdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/parts/UP", JsonNull.INSTANCE), 0);
        assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(missVerdict, "verdict", null));
    }

    /** 没有注入运行期来源 → error（判据自身无法求值，视同 red 单列）。 */
    @Test
    public void engineErrorWithoutTeSource() {
        CriteriaEngine engine = new CriteriaEngine(null, null, null, null);
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true)), 0);
        assertEquals(CriteriaEngine.Verdicts.ERROR, Json.optString(verdict, "verdict", null));
        assertTrue(
            Json.optString(verdict, "detail", ""),
            Json.optString(verdict, "detail", "")
                .contains("没有运行期 TE 状态来源"));
    }

    /** 该位置没有描述器认领的 TE（描述器查不到）→ error。 */
    @Test
    public void engineErrorWhenNoTeAtPosition() {
        CriteriaEngine engine = engineWithSource(lpStateAt(new int[] { 1, 2, 3 }));
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true)), 0);
        assertEquals(CriteriaEngine.Verdicts.ERROR, Json.optString(verdict, "verdict", null));
        assertTrue(
            Json.optString(verdict, "detail", ""),
            Json.optString(verdict, "detail", "")
                .contains("没有可描述的 TE"));
    }

    /** 描述器抛错 → error（观察设施失败不该把用例执行炸掉）。 */
    @Test
    public void engineErrorWhenSourceThrows() {
        CriteriaEngine engine = new CriteriaEngine(null, null, null, null, new CriteriaEngine.RuntimeTeSource() {

            @Override
            public CriteriaEngine.RuntimeTeSource.TeState describe(int x, int y, int z) {
                throw new IllegalStateException("boom");
            }
        });
        JsonObject verdict = engine
            .evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true)), 0);
        assertEquals(CriteriaEngine.Verdicts.ERROR, Json.optString(verdict, "verdict", null));
        assertTrue(
            Json.optString(verdict, "detail", ""),
            Json.optString(verdict, "detail", "")
                .contains("读取 TE 运行期状态失败"));
    }

    /** at/expect 非法 → error（不给假红绿）。 */
    @Test
    public void engineErrorOnMalformedParams() {
        CriteriaEngine engine = engineWith(lpState());
        JsonObject noExpect = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        noExpect.remove("expect");
        assertEquals(CriteriaEngine.Verdicts.ERROR, Json.optString(engine.evaluateOne(noExpect, 0), "verdict", null));

        JsonObject badAt = teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true));
        JsonArray at = new JsonArray();
        at.add("x");
        at.add(12);
        at.add(64);
        badAt.getAsJsonObject("params")
            .add("at", at);
        assertTrue(
            Json.optString(engine.evaluateOne(badAt, 0), "detail", ""),
            Json.optString(engine.evaluateOne(badAt, 0), "detail", "")
                .contains("params.at"));
    }

    /** 空指针串表示根对象本身（RFC 6901）：可用来整树比较。 */
    @Test
    public void emptyPointerComparesWholeState() {
        JsonObject state = lpState();
        CriteriaEngine engine = engineWith(state);
        JsonObject verdict = engine.evaluateOne(teCriterion(new int[] { 65, 12, 64 }, "", state), 0);
        assertEquals(
            Json.optString(verdict, "detail", ""),
            CriteriaEngine.Verdicts.GREEN,
            Json.optString(verdict, "verdict", null));
    }

    /** 汇总：运行期轨判红时 overall 变红（判据语义与既有判据一致）。 */
    @Test
    public void overallTurnsRedOnTeMismatch() throws IOException {
        Path runRoot = tmp.newFolder("runs")
            .toPath();
        ArtifactStore store = new ArtifactStore(runRoot, TimeSource.fixed("2026-10-06T12:00:00+08:00", "t", 0L), null);
        ArtifactStore.Run run = store.createRun("pr3", 1L);
        CriteriaEngine engine = new CriteriaEngine(
            store,
            run,
            null,
            null,
            CriteriaEngine.fixedTeSource("lp-pipe", lpState()));
        JsonArray criteria = new JsonArray();
        criteria.add(teCriterion(new int[] { 65, 12, 64 }, "/connections/UP", new JsonPrimitive(true)));
        criteria.add(teCriterion(new int[] { 65, 12, 64 }, "/connections/DOWN", new JsonPrimitive(true)));
        JsonObject doc = engine.evaluate(criteria, run.runId());
        assertEquals(CriteriaEngine.Verdicts.RED, Json.optString(doc, "overall", null));
        assertEquals(
            1,
            doc.getAsJsonObject("counts")
                .get(CriteriaEngine.Verdicts.GREEN)
                .getAsInt());
        assertEquals(
            1,
            doc.getAsJsonObject("counts")
                .get(CriteriaEngine.Verdicts.RED)
                .getAsInt());
    }

    // ------------------------------------------------------------ 夹具

    /** 假 LP 管道状态（与 LpPipeDescriber 的输出同形，只取本测试要断言的字段）。 */
    private static JsonObject lpState() {
        JsonObject o = new JsonObject();
        o.addProperty("te", "logisticspipes.pipes.basic.LogisticsTileGenericPipe");
        o.addProperty("pipeType", "logisticspipes:pipe_basic");
        o.addProperty("initialized", true);
        JsonObject conn = new JsonObject();
        conn.addProperty("DOWN", false);
        conn.addProperty("UP", true);
        conn.addProperty("NORTH", false);
        conn.addProperty("SOUTH", false);
        conn.addProperty("WEST", false);
        conn.addProperty("EAST", false);
        o.add("connections", conn);
        return o;
    }

    private static CriteriaEngine.RuntimeTeSource lpStateAt(final int[] at) {
        return CriteriaEngine.teSourceAt(at, lpState());
    }

    private static CriteriaEngine engineWith(JsonObject state) {
        return engineWithSource(CriteriaEngine.fixedTeSource("lp-pipe", state));
    }

    private static CriteriaEngine engineWithSource(CriteriaEngine.RuntimeTeSource source) {
        return new CriteriaEngine(null, null, null, null, source);
    }

    private static JsonObject teCriterion(int[] at, String key, JsonElement expect) {
        JsonObject o = new JsonObject();
        o.addProperty("id", "te");
        o.addProperty("type", CriteriaEngine.TYPE_TE_STATE_EQUALS);
        JsonObject params = new JsonObject();
        JsonArray a = new JsonArray();
        for (int v : at) {
            a.add(v);
        }
        params.add("at", a);
        params.addProperty("key", key);
        o.add("params", params);
        o.add("expect", expect);
        return o;
    }

    /** 最小可校验用例（世界 + 一条判据 + 空证据清单）。 */
    private static JsonObject minimalCase(JsonObject criterion) {
        JsonObject c = new JsonObject();
        c.addProperty("schema", Contract.SCHEMA_CASE);
        c.addProperty("id", "pr3");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_pr3");
        world.addProperty("seed", 20261006L);
        world.addProperty("void", true);
        c.add("world", world);
        JsonArray criteria = new JsonArray();
        criteria.add(criterion);
        c.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        evidence.add("expect", new JsonArray());
        c.add("evidence", evidence);
        return c;
    }

    private static CpException planError(JsonObject criterion) {
        try {
            CaseValidator.validate(Json.toJson(minimalCase(criterion)));
            fail("应当校验失败");
            return null;
        } catch (CpException e) {
            return e;
        }
    }

    private static boolean mentions(CpException e, String fieldFragment) {
        if (e == null || e.context() == null) {
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
}
