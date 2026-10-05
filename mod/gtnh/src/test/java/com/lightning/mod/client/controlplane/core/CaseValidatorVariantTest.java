package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 变体补丁适用性判定（{@link CaseValidator.VariantCheck}）单测。
 *
 * <h2>回归背景（真机冒烟 A8）</h2>
 * 变体 {@code neg-manifest-missing}（{@code replace /criteria/0/params/path}）在变体执行路径上被判
 * 「{@code variants[0].mutate 补丁未改变用例内容（负对照将是空的）} [CP-VALID-002]」，
 * {@code sweepVariants} 把这个 CpException 吞成 {@code evaluated:false} + {@code error}，
 * 于是负对照「未变红」、A8 假红（整跑 A4 同时是绿的，说明补丁在原始文件上完全可用）。
 *
 * <p>
 * 根因不在 {@link JsonPatch} 的路径下降（同一补丁在原始文件上第一次应用是成功的，见
 * {@link JsonPatchTest} 的三级含数组路径用例），而在<b>调用方对已经补过的文档又跑了一遍完整校验</b>：
 * 补丁在产物文档上必然幂等，「什么都没改」于是撞上「空转变体」这道防线。
 */
public class CaseValidatorVariantTest {

    // ------------------------------------------------------------ 用例构造

    /** 与冒烟用例同形的用例：一个 artifact-exists 判据 + 一个改它 params.path 的负对照变体。 */
    private static JsonObject smokeCase() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", Contract.SCHEMA_CASE);
        c.addProperty("id", "cp-smoke-basic");
        c.addProperty("label", "控制面冒烟（单测同形）");

        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_smoke_basic");
        world.addProperty("seed", 20261006L);
        world.addProperty("void", true);
        world.add("base", ints(64, 12, 64));
        world.addProperty("settleTicks", 60);
        c.add("world", world);

        JsonArray build = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("op", "block");
        block.addProperty("at", "base+[0,0,0]");
        block.addProperty("id", "minecraft:stone");
        block.addProperty("meta", 0);
        build.add(block);
        c.add("build", build);

        JsonArray criteria = new JsonArray();
        JsonObject criterion = new JsonObject();
        criterion.addProperty("id", "scene-manifest-exists");
        criterion.addProperty("type", "artifact-exists");
        JsonObject params = new JsonObject();
        params.addProperty("path", "world/scene-manifest.json");
        criterion.add("params", params);
        criteria.add(criterion);
        c.add("criteria", criteria);

        JsonArray variants = new JsonArray();
        JsonObject variant = new JsonObject();
        variant.addProperty("id", "neg-manifest-missing");
        JsonArray mutate = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("op", JsonPatch.OP_REPLACE);
        op.addProperty("path", "/criteria/0/params/path");
        op.addProperty("value", "world/absent-scene-manifest.json");
        mutate.add(op);
        variant.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("scene-manifest-exists");
        variant.add("expectCriteriaRed", red);
        variants.add(variant);
        c.add("variants", variants);

        JsonObject evidence = new JsonObject();
        JsonArray expect = new JsonArray();
        JsonObject item = new JsonObject();
        item.addProperty("path", "criteria.json");
        item.addProperty("role", "criteria");
        expect.add(item);
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

    private static CaseFile parse(JsonObject o) {
        return new CaseParser().parse(Json.toJson(o));
    }

    /** 变体产物文档：与 {@code CaseRunAction} 的 applyVariant/sweepVariants 构造方式一致。 */
    private static JsonObject mutatedDoc() {
        CaseFile file = parse(smokeCase());
        return file.variants()
            .get(0)
            .applyTo(file.raw(), "variants[0].mutate");
    }

    private static String criteriaPath(JsonObject doc) {
        return doc.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .get("path")
            .getAsString();
    }

    private static JsonObject criteriaParams(JsonObject doc) {
        return doc.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params");
    }

    private static String fieldList(CpException e) {
        return e.context() == null ? ""
            : Json.toJson(
                e.context()
                    .get("fields"));
    }

    // ------------------------------------------------------------ 用例

    @Test
    public void pristineCasePatchIsApplicableUnderEnforce() {
        JsonObject plan = new CaseValidator().plan(parse(smokeCase()));
        JsonObject v = plan.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject();
        assertTrue(
            v.get("applicable")
                .getAsBoolean());
        assertEquals(
            64,
            v.get("appliedSha256")
                .getAsString()
                .length());
    }

    /**
     * 已有文档上再跑 ENFORCE：必然误报——这条用例把「误报会长什么样」钉住，防止有人把 SKIP 模式去掉。
     */
    @Test
    public void alreadyMutatedCaseTripsApplicabilityGuardUnderEnforce() {
        JsonObject mutated = mutatedDoc();
        assertEquals("world/absent-scene-manifest.json", criteriaPath(mutated));
        try {
            new CaseValidator().plan(parse(mutated));
            fail("已补过的文档在 ENFORCE 下必须报「补丁未改变用例内容」（这正是 A8 假红的来源）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(fieldList(e), fieldList(e).contains("variants[0].mutate"));
            assertTrue(
                e.detail(),
                e.detail()
                    .contains("补丁未改变用例内容"));
        }
    }

    /**
     * 变体执行路径用的 SKIP：不判适用性，其余照常——
     * ①不抛；②判据取的是<b>补丁后</b>的 params（变体必须在自己的文档上求值）；③补丁标记为可执行。
     */
    @Test
    public void alreadyMutatedCasePassesUnderSkip() {
        JsonObject mutated = mutatedDoc();
        JsonObject plan = new CaseValidator().plan(parse(mutated), CaseValidator.VariantCheck.SKIP);
        assertEquals(
            "变体的判据必须用补丁后的值求值",
            "world/absent-scene-manifest.json",
            plan.getAsJsonArray("criteria")
                .get(0)
                .getAsJsonObject()
                .getAsJsonObject("params")
                .get("path")
                .getAsString());
        JsonObject v = plan.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject();
        // replace 在产物文档上可执行（目标成员在），只是不再产生改动：applicable 只表示「补丁可执行」
        assertTrue(
            v.get("applicable")
                .getAsBoolean());
        assertEquals(
            64,
            v.get("appliedSha256")
                .getAsString()
                .length());
    }

    /** SKIP 只放过适用性判定，不许放过其它字段问题（否则等于把校验整段关掉）。 */
    @Test
    public void skipModeStillRejectsOtherFieldProblems() {
        JsonObject mutated = mutatedDoc();
        criteriaParams(mutated).addProperty("path", "../../escape.json");
        try {
            new CaseValidator().plan(parse(mutated), CaseValidator.VariantCheck.SKIP);
            fail("SKIP 只放宽变体适用性，判据路径越界仍须 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(fieldList(e), fieldList(e).contains("criteria[0].params.path"));
        }
    }

    /** 未指定模式时行为等同 ENFORCE（默认不许放宽）。 */
    @Test
    public void nullModeDefaultsToEnforce() {
        JsonObject mutated = mutatedDoc();
        try {
            new CaseValidator().plan(parse(mutated), null);
            fail("plan(file, null) 必须按 ENFORCE 处理");
        } catch (CpException e) {
            assertTrue(
                e.detail(),
                e.detail()
                    .contains("补丁未改变用例内容"));
        }
    }
}
