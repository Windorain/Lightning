package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * {@code capture}/{@code cameras} 作为<b>真实执行段</b>的校验单测（case-file.md §4、contract.md §4.1，PR-2）。
 *
 * <p>
 * 覆盖三件事：
 * <ol>
 * <li>段序与段清单（{@code world→capture→build→read→export→cameras→criteria→evidence}）——capture 必须在
 * build 之前，否则「build 阶段世界未受保护」；</li>
 * <li>{@code capture}/{@code cameras} 的字段校验走 {@link CameraSpecs}/{@link CaptureSpec} 同一份判定
 * （错误字段名逐条可核对）；</li>
 * <li>与负对照（{@link CaseValidator.VariantCheck}）的交互：补丁改到 cameras/capture 段时，
 * ENFORCE 与 SKIP 两种模式都要仍然工作。</li>
 * </ol>
 */
public class CaseCaptureSegmentsTest {

    // ------------------------------------------------------------ 用例构造

    private static JsonObject caseJson() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", Contract.SCHEMA_CASE);
        c.addProperty("id", "capture-segments");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_capture_segments");
        world.addProperty("seed", 7L);
        world.addProperty("void", true);
        world.add("base", ints(64, 12, 64));
        c.add("world", world);

        JsonArray build = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("op", "block");
        block.addProperty("at", "base+[0,0,0]");
        block.addProperty("id", "minecraft:stone");
        build.add(block);
        c.add("build", build);

        JsonObject capture = new JsonObject();
        capture.addProperty("lighting", CaptureSpec.LIGHTING_NEUTRAL_FLAT);
        capture.addProperty("renderMode", CaptureSpec.RENDER_MODE_NATIVE);
        capture.addProperty("worldTime", 6000);
        c.add("capture", capture);

        c.add("cameras", cameras());

        JsonArray criteria = new JsonArray();
        criteria.add(
            criterion("shot-size", CriteriaEngine.TYPE_IMAGE_SIZE_EQUALS, sizeParams("shots/front.png", 1920, 1080)));
        criteria
            .add(criterion("shot-not-blank", CriteriaEngine.TYPE_IMAGE_NOT_UNIFORM, params("path", "shots/front.png")));
        c.add("criteria", criteria);

        JsonObject evidence = new JsonObject();
        JsonArray expect = new JsonArray();
        expect.add(evidenceItem("observation.json", "observation"));
        expect.add(evidenceItem("shots/front.png", "shot"));
        evidence.add("expect", expect);
        c.add("evidence", evidence);
        return c;
    }

    private static JsonArray cameras() {
        JsonArray arr = new JsonArray();
        JsonObject front = new JsonObject();
        front.addProperty("name", "front");
        front.add("pos", doubles(64.5d, 20.0d, 70.5d));
        front.addProperty("yaw", 180.0d);
        front.addProperty("pitch", -45.0d);
        JsonObject proj = new JsonObject();
        proj.addProperty("type", "perspective");
        proj.addProperty("fov", 70.0d);
        front.add("projection", proj);
        front.add("resolution", ints(1920, 1080));
        arr.add(front);

        JsonObject tiled = new JsonObject();
        tiled.addProperty("name", "hi-res");
        tiled.add("pos", doubles(64.5d, 20.0d, 70.5d));
        tiled.addProperty("yaw", 180.0d);
        tiled.addProperty("pitch", -20.0d);
        JsonObject ortho = new JsonObject();
        ortho.addProperty("type", "ortho");
        ortho.addProperty("orthoHeight", 16.0d);
        tiled.add("projection", ortho);
        tiled.add("resolution", ints(3840, 2160));
        JsonObject tile = new JsonObject();
        tile.addProperty("cols", 2);
        tile.addProperty("rows", 2);
        tile.addProperty("overlap", 0.05d);
        tiled.add("tile", tile);
        arr.add(tiled);
        return arr;
    }

    private static JsonObject criterion(String id, String type, JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("type", type);
        o.add("params", params);
        return o;
    }

    private static JsonObject params(String k, String v) {
        JsonObject o = new JsonObject();
        o.addProperty(k, v);
        return o;
    }

    private static JsonObject sizeParams(String path, int w, int h) {
        JsonObject o = params("path", path);
        o.addProperty("width", w);
        o.addProperty("height", h);
        return o;
    }

    private static JsonObject evidenceItem(String path, String role) {
        JsonObject o = new JsonObject();
        o.addProperty("path", path);
        o.addProperty("role", role);
        return o;
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

    private static CaseFile parse(JsonObject o) {
        return new CaseParser().parse(Json.toJson(o));
    }

    private static JsonObject plan(JsonObject o) {
        return new CaseValidator().plan(parse(o));
    }

    private static String fieldList(CpException e) {
        return e.context() == null ? ""
            : Json.toJson(
                e.context()
                    .get("fields"));
    }

    private static CpException planError(JsonObject o) {
        try {
            plan(o);
            fail("应当 CP-VALID-002");
            return null;
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            return e;
        }
    }

    // ------------------------------------------------------------ 用例

    /**
     * 段清单与段序。
     *
     * <p>
     * 契约口径：capture 在 build 之前（会话包住 build 之后的区间）；v1.3 起 read 在 build 之后；
     * **v1.6（Gitea #102）起 export 在 read 之后、cameras 之前**——顺序的理由不是风格：
     * C4 要求「导出件与实拍、观测记录同一 run」，且导出读的是<b>已构建完成</b>的世界状态，
     * 而 cameras 段会改动渲染状态（投影/光照覆写）。先导出再拍摄，导出件反映的是「本 run 构建出的
     * 那个世界」，而不是「拍摄过程干预后的世界」。
     */
    @Test
    public void segmentOrderIsContractOrder() {
        JsonObject plan = plan(caseJson());
        JsonArray segments = plan.getAsJsonArray("segments");
        assertEquals(CaseValidator.SEGMENTS.size(), segments.size());
        assertEquals(
            "world",
            segments.get(0)
                .getAsString());
        assertEquals(
            "capture",
            segments.get(1)
                .getAsString());
        assertEquals(
            "build",
            segments.get(2)
                .getAsString());
        assertEquals(
            "read",
            segments.get(3)
                .getAsString());
        assertEquals(
            "v1.6（#102）：export 在 read 之后、cameras 之前",
            "export",
            segments.get(4)
                .getAsString());
        assertEquals(
            "cameras",
            segments.get(5)
                .getAsString());
        assertEquals(
            "criteria",
            segments.get(6)
                .getAsString());
        assertEquals(
            "evidence",
            segments.get(7)
                .getAsString());
        // 规范化段清单与执行期段清单必须同源
        for (int i = 0; i < segments.size(); i++) {
            assertEquals(
                CaseValidator.SEGMENTS.get(i),
                segments.get(i)
                    .getAsString());
        }
    }

    /** capture/cameras 段被规范化（投影二选一展开、默认值补齐）。 */
    @Test
    public void captureAndCamerasAreNormalized() {
        JsonObject plan = plan(caseJson());
        JsonObject capture = Json.optObject(plan, "capture");
        assertNotNull(capture);
        assertEquals(CaptureSpec.LIGHTING_NEUTRAL_FLAT, Json.optString(capture, "lighting", null));
        assertEquals(6000L, Json.optLong(capture, "worldTime", -1L));

        JsonArray cameras = Json.optArray(plan, "cameras");
        assertEquals(2, cameras.size());
        JsonObject front = cameras.get(0)
            .getAsJsonObject();
        assertEquals("front", Json.optString(front, "name", null));
        assertEquals("perspective", Json.optString(Json.optObject(front, "projection"), "type", null));
        JsonObject tiled = cameras.get(1)
            .getAsJsonObject();
        assertEquals("ortho", Json.optString(Json.optObject(tiled, "projection"), "type", null));
        assertEquals(2, Json.optInt(Json.optObject(tiled, "tile"), "cols", 0));
    }

    /** 含 cameras 段时计划里给出「需 forensic」的警告（运行期升格的可读提示）。 */
    @Test
    public void planWarnsAboutForensicRequirement() {
        JsonObject plan = plan(caseJson());
        JsonArray warnings = Json.optArray(plan, "warnings");
        boolean warned = false;
        for (int i = 0; warnings != null && i < warnings.size(); i++) {
            if (warnings.get(i)
                .getAsString()
                .contains("forensic")) {
                warned = true;
            }
        }
        assertTrue("应提示 cameras 段需要 forensic 级: " + warnings, warned);
    }

    /** 无机位时不产生该警告（不是所有用例都需要取证级）。 */
    @Test
    public void noForensicWarningWithoutCameras() {
        JsonObject c = caseJson();
        c.remove("cameras");
        JsonObject plan = plan(c);
        JsonArray warnings = Json.optArray(plan, "warnings");
        for (int i = 0; warnings != null && i < warnings.size(); i++) {
            assertFalse(
                warnings.get(i)
                    .getAsString(),
                warnings.get(i)
                    .getAsString()
                    .contains("forensic"));
        }
        assertFalse(plan.has("cameras"));
    }

    // ------------------------------------------------------------ 字段错误

    @Test
    public void cameraFieldErrorsCarryFullPath() {
        JsonObject c = caseJson();
        c.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("projection")
            .remove("fov");
        CpException e = planError(c);
        assertTrue(fieldList(e), fieldList(e).contains("cameras[0].projection.fov"));
    }

    @Test
    public void duplicateCameraNamesAreRejected() {
        JsonObject c = caseJson();
        c.getAsJsonArray("cameras")
            .get(1)
            .getAsJsonObject()
            .addProperty("name", "front");
        CpException e = planError(c);
        assertTrue(fieldList(e), fieldList(e).contains("机位名重复"));
    }

    @Test
    public void unknownCameraFieldIsRejected() {
        JsonObject c = caseJson();
        c.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .addProperty("zoom", 2.0d);
        CpException e = planError(c);
        assertTrue(fieldList(e), fieldList(e).contains("cameras[0].zoom"));
    }

    @Test
    public void captureFieldErrorsAreRejected() {
        JsonObject c = caseJson();
        c.getAsJsonObject("capture")
            .addProperty("lighting", "very-bright");
        CpException e = planError(c);
        assertTrue(fieldList(e), fieldList(e).contains("capture.lighting"));

        JsonObject c2 = caseJson();
        c2.getAsJsonObject("capture")
            .addProperty("worldTime", 99999);
        assertTrue(fieldList(planError(c2)), fieldList(planError(c2)).contains("capture.worldTime"));

        JsonObject c3 = caseJson();
        c3.getAsJsonObject("capture")
            .addProperty("typo", 1);
        assertTrue(fieldList(planError(c3)), fieldList(planError(c3)).contains("capture.typo"));
    }

    /** cameras 不是数组、capture 不是对象：结构错误（不是静默忽略）。 */
    @Test
    public void cameraAndCaptureShapeErrorsAreRejected() {
        JsonObject c = caseJson();
        c.addProperty("cameras", "front");
        assertTrue(fieldList(planError(c)), fieldList(planError(c)).contains("cameras"));

        JsonObject c2 = caseJson();
        c2.addProperty("capture", true);
        CpException e = planError(c2);
        assertTrue(fieldList(e), fieldList(e).contains("capture"));
    }

    // ------------------------------------------------------------ 图像判据校验

    @Test
    public void imageSizeCriterionRequiresPositiveIntegers() {
        JsonObject c = caseJson();
        JsonObject params = c.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params");
        params.remove("width");
        assertTrue(fieldList(planError(c)), fieldList(planError(c)).contains("criteria[0].params.width"));

        JsonObject c2 = caseJson();
        c2.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .addProperty("height", -1);
        assertTrue(fieldList(planError(c2)), fieldList(planError(c2)).contains("criteria[0].params.height"));
    }

    /** maxSameColorRatio 缺省补齐 0.98；越界报错。 */
    @Test
    public void imageNotUniformDefaultRatioAndRange() {
        JsonObject plan = plan(caseJson());
        JsonObject params = plan.getAsJsonArray("criteria")
            .get(1)
            .getAsJsonObject()
            .getAsJsonObject("params");
        assertEquals(
            ImageCriteria.DEFAULT_MAX_SAME_COLOR_RATIO,
            params.get("maxSameColorRatio")
                .getAsDouble(),
            1.0e-9d);

        JsonObject c = caseJson();
        c.getAsJsonArray("criteria")
            .get(1)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .addProperty("maxSameColorRatio", 1.5d);
        assertTrue(fieldList(planError(c)), fieldList(planError(c)).contains("criteria[1].params.maxSameColorRatio"));
    }

    /** 图像判据的 path 也要做防穿越（与其它产物类判据同口径）。 */
    @Test
    public void imageCriterionPathTraversalIsRejected() {
        JsonObject c = caseJson();
        c.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject()
            .getAsJsonObject("params")
            .addProperty("path", "../../escape.png");
        CpException e = planError(c);
        assertTrue(fieldList(e), fieldList(e).contains("criteria[0].params.path"));
    }

    // ------------------------------------------------------------ 与负对照的交互

    /** 变体改 cameras 段：ENFORCE 下补丁适用（真改了内容），计划里反映补丁后的值。 */
    @Test
    public void variantTouchingCamerasAppliesUnderEnforce() {
        JsonObject c = caseJson();
        JsonArray variants = new JsonArray();
        JsonObject variant = new JsonObject();
        variant.addProperty("id", "no-cameras");
        JsonArray mutate = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("op", JsonPatch.OP_REPLACE);
        op.addProperty("path", "/cameras/0/resolution");
        op.add("value", ints(320, 240));
        mutate.add(op);
        variant.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("shot-size");
        variant.add("expectCriteriaRed", red);
        variants.add(variant);
        c.add("variants", variants);

        JsonObject plan = plan(c);
        JsonObject v = plan.getAsJsonArray("variants")
            .get(0)
            .getAsJsonObject();
        assertTrue(
            v.get("applicable")
                .getAsBoolean());
        // 主计划的 cameras 仍是原值（补丁只作用于变体文档）
        assertEquals(
            1920,
            plan.getAsJsonArray("cameras")
                .get(0)
                .getAsJsonObject()
                .getAsJsonArray("resolution")
                .get(0)
                .getAsInt());
    }

    /** 变体产物文档（已打补丁）再跑 SKIP：不误报「补丁未改变用例内容」，且 cameras 取补丁后的值。 */
    @Test
    public void variantProductDocumentPassesUnderSkip() {
        JsonObject c = caseJson();
        JsonArray variants = new JsonArray();
        JsonObject variant = new JsonObject();
        variant.addProperty("id", "small-res");
        JsonArray mutate = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("op", JsonPatch.OP_REPLACE);
        op.addProperty("path", "/cameras/0/resolution/0");
        op.addProperty("value", 640);
        mutate.add(op);
        variant.add("mutate", mutate);
        JsonArray red = new JsonArray();
        red.add("shot-size");
        variant.add("expectCriteriaRed", red);
        variants.add(variant);
        c.add("variants", variants);

        CaseFile file = parse(c);
        JsonObject mutated = file.variants()
            .get(0)
            .applyTo(file.raw(), "variants[0].mutate");
        CaseFile mutatedFile = new CaseParser().parse(mutated, Json.toJson(mutated));
        JsonObject plan = new CaseValidator().plan(mutatedFile, CaseValidator.VariantCheck.SKIP);
        assertEquals(
            "变体的 cameras 必须用补丁后的值求值",
            640,
            plan.getAsJsonArray("cameras")
                .get(0)
                .getAsJsonObject()
                .getAsJsonArray("resolution")
                .get(0)
                .getAsInt());

        // ENFORCE 会把这份文档误报成「空转变体」——这正是 SKIP 存在的理由
        try {
            new CaseValidator().plan(mutatedFile, CaseValidator.VariantCheck.ENFORCE);
            fail("已补过的文档在 ENFORCE 下必须报空转变体");
        } catch (CpException e) {
            assertTrue(
                e.detail(),
                e.detail()
                    .contains("补丁未改变用例内容"));
        }
    }

    /** SKIP 仍要拦住 cameras 段自身的字段问题（不许把段校验整段关掉）。 */
    @Test
    public void skipModeStillRejectsCameraFieldProblems() {
        JsonObject c = caseJson();
        c.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .addProperty("yaw", 999.0d);
        c.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .addProperty("pitch", 100.0d);
        try {
            new CaseValidator().plan(parse(c), CaseValidator.VariantCheck.SKIP);
            fail("SKIP 只放宽变体适用性，机位范围仍须 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(fieldList(e), fieldList(e).contains("cameras[0].pitch"));
        }
    }

    /** 计划的 cameras 数组是深拷：调用方改动不会污染解析结果。 */
    @Test
    public void planCamerasAreCopied() {
        JsonObject plan = plan(caseJson());
        JsonElement before = plan.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("resolution")
            .get(0);
        plan.getAsJsonArray("cameras")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("resolution")
            .set(0, new com.google.gson.JsonPrimitive(1));
        JsonObject plan2 = plan(caseJson());
        assertEquals(
            before.getAsInt(),
            plan2.getAsJsonArray("cameras")
                .get(0)
                .getAsJsonObject()
                .getAsJsonArray("resolution")
                .get(0)
                .getAsInt());
    }
}
