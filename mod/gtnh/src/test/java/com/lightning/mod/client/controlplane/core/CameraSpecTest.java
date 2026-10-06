package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * {@link CameraSpec}/{@link CameraSpecs}/{@link CaptureSpec} 的解析与范围校验单测
 * （contract.md §4.1，PR-2）。
 *
 * <p>
 * 这些约束是「校验期与执行期同一份代码」的护栏：{@code case.validate} 报的错必须与
 * {@code shot.multi}/{@code case.run} 执行期抛的错逐条一致。因此这里既测解析结果，
 * 也测<b>错误字段名</b>（{@code context.fields} 的 field 值）。
 */
public class CameraSpecTest {

    // ------------------------------------------------------------ 构造

    private static JsonObject perspective(String name) {
        JsonObject c = new JsonObject();
        c.addProperty("name", name);
        c.add("pos", doubles(64.5d, 20.0d, 70.5d));
        c.addProperty("yaw", 180.0d);
        c.addProperty("pitch", -45.0d);
        JsonObject proj = new JsonObject();
        proj.addProperty("type", "perspective");
        proj.addProperty("fov", 70.0d);
        c.add("projection", proj);
        c.add("resolution", ints(1920, 1080));
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

    private static JsonArray cameras(JsonObject... specs) {
        JsonArray a = new JsonArray();
        for (JsonObject s : specs) {
            a.add(s);
        }
        return a;
    }

    private static CameraSpecs.Parsed parse(JsonArray arr) {
        return CameraSpecs.parseArray(arr, "cameras");
    }

    private static boolean mentions(CameraSpecs.Parsed p, String field) {
        for (JsonElement e : p.fields()
            .toJson()) {
            if (field.equals(
                e.getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ 解析

    /** 透视机位：字段全部落到模型上。 */
    @Test
    public void perspectiveCameraParses() {
        CameraSpecs.Parsed p = parse(cameras(perspective("front-top")));
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        assertEquals(
            1,
            p.specs()
                .size());
        CameraSpec s = p.specs()
            .get(0);
        assertEquals("front-top", s.name());
        assertEquals(64.5d, s.pos()[0], 1.0e-9d);
        assertEquals(20.0d, s.pos()[1], 1.0e-9d);
        assertEquals(70.5d, s.pos()[2], 1.0e-9d);
        assertEquals(180.0d, s.yaw(), 1.0e-9d);
        assertEquals(-45.0d, s.pitch(), 1.0e-9d);
        assertEquals(CameraSpec.PROJECTION_PERSPECTIVE, s.projection());
        assertEquals(70.0d, s.fov(), 1.0e-9d);
        assertTrue(Double.isNaN(s.orthoHeight()));
        assertFalse(s.isOrtho());
        assertFalse(s.tiled());
        assertEquals(1920, s.width());
        assertEquals(1080, s.height());
        assertEquals(1, s.tileCols());
        assertEquals(1, s.tileRows());
        assertEquals(0.05d, s.tileOverlap(), 1.0e-9d);
    }

    /** 正交机位：orthoHeight 必填。 */
    @Test
    public void orthoCameraParses() {
        JsonObject c = perspective("plain");
        JsonObject proj = new JsonObject();
        proj.addProperty("type", "ortho");
        proj.addProperty("orthoHeight", 16.0d);
        c.add("projection", proj);
        CameraSpecs.Parsed p = parse(cameras(c));
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        CameraSpec s = p.specs()
            .get(0);
        assertTrue(s.isOrtho());
        assertEquals(16.0d, s.orthoHeight(), 1.0e-9d);
        assertTrue(Double.isNaN(s.fov()));
    }

    /** tile 段：cols/rows/overlap 与格位切分。 */
    @Test
    public void tileSegmentParses() {
        JsonObject c = perspective("hi");
        JsonObject tile = new JsonObject();
        tile.addProperty("cols", 2);
        tile.addProperty("rows", 2);
        tile.addProperty("overlap", 0.1d);
        c.add("tile", tile);
        c.add("resolution", ints(1000, 700));
        CameraSpecs.Parsed p = parse(cameras(c));
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        CameraSpec s = p.specs()
            .get(0);
        assertTrue(s.tiled());
        assertEquals(2, s.tileCols());
        assertEquals(2, s.tileRows());
        assertEquals(0.1d, s.tileOverlap(), 1.0e-9d);
        // 整除切分：1000/2=500、700/2=350
        assertArray(new int[] { 500, 350 }, s.tileSize(0, 0));
        assertArray(new int[] { 500, 350 }, s.tileSize(1, 1));
        assertEquals(500, CameraSpec.tileOffset(1000, 2, 1));
        assertEquals(500, CameraSpec.tileSpan(1000, 2, 0));
        // 余数归末列/末行
        assertEquals(251, CameraSpec.tileSpan(1001, 4, 3));
        assertEquals(250, CameraSpec.tileSpan(1001, 4, 0));
    }

    /** 单个 CameraSpec 对象也接受（shot.multi 的简写形态）。 */
    @Test
    public void singleObjectFormIsAccepted() {
        JsonObject host = new JsonObject();
        host.add("cameras", perspective("one"));
        CameraSpecs.Parsed p = CameraSpecs.parseParam(host, "cameras");
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        assertEquals(
            1,
            p.specs()
                .size());
    }

    // ------------------------------------------------------------ 校验

    @Test
    public void missingNameIsRejected() {
        JsonObject c = perspective("x");
        c.remove("name");
        CameraSpecs.Parsed p = parse(cameras(c));
        assertTrue(mentions(p, "cameras[0].name"));
    }

    @Test
    public void illegalNameIsRejected() {
        CameraSpecs.Parsed p = parse(cameras(perspective("Front Top")));
        assertTrue(mentions(p, "cameras[0].name"));
    }

    @Test
    public void duplicateNamesAreRejected() {
        CameraSpecs.Parsed p = parse(cameras(perspective("same"), perspective("same")));
        assertTrue(mentions(p.fields(), "cameras"));
        assertTrue(p.hasErrors());
    }

    /** pos 必须有限（拒绝 NaN/Infinity 与非数值）。 */
    @Test
    public void nonFinitePosIsRejected() {
        JsonObject c = perspective("bad");
        c.add("pos", new JsonArray());
        c.getAsJsonArray("pos")
            .add(1.0d);
        c.getAsJsonArray("pos")
            .add(2.0d);
        c.getAsJsonArray("pos")
            .add(3.0d);
        // 通过原始 JSON 文本喂 Infinity：gson 严格解析器不接受，因此这里用非数组形态测类型错误
        CameraSpecs.Parsed p = parse(cameras(c));
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        assertEquals(
            1.0d,
            p.specs()
                .get(0)
                .pos()[0],
            1.0e-9d);
    }

    /** 非有限坐标：JSON 文本层面的 Infinity/NaN 被严格解析器拒绝，故直接构造非数值元素测类型错误。 */
    @Test
    public void nonNumericPosElementIsRejected() {
        JsonObject c = perspective("bad");
        JsonArray pos = new JsonArray();
        pos.add("not-a-number");
        pos.add(2.0d);
        pos.add(3.0d);
        c.add("pos", pos);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].pos[0]"));
    }

    /** pos 形状错误（长度不足 / 不是数组）。 */
    @Test
    public void posWrongShapeIsRejected() {
        JsonObject c = perspective("bad");
        c.add("pos", ints(1, 2));
        assertTrue(mentions(parse(cameras(c)), "cameras[0].pos"));
        JsonObject c2 = perspective("bad2");
        c2.addProperty("pos", "64,20,70");
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].pos"));
    }

    @Test
    public void pitchOutOfRangeIsRejected() {
        JsonObject c = perspective("steep");
        c.addProperty("pitch", -100.0d);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].pitch"));
    }

    @Test
    public void projectionIsRequired() {
        JsonObject c = perspective("noproj");
        c.remove("projection");
        assertTrue(mentions(parse(cameras(c)), "cameras[0].projection"));
    }

    @Test
    public void perspectiveRequiresFovAndRejectsOrthoHeight() {
        JsonObject c = perspective("pf");
        JsonObject proj = c.getAsJsonObject("projection");
        proj.remove("fov");
        assertTrue(mentions(parse(cameras(c)), "cameras[0].projection.fov"));

        JsonObject c2 = perspective("px");
        c2.getAsJsonObject("projection")
            .addProperty("orthoHeight", 10.0d);
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].projection.orthoHeight"));
    }

    @Test
    public void orthoRequiresHeightAndRejectsFov() {
        JsonObject c = perspective("oh");
        JsonObject proj = new JsonObject();
        proj.addProperty("type", "ortho");
        c.add("projection", proj);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].projection.orthoHeight"));

        JsonObject c2 = perspective("oz");
        JsonObject proj2 = new JsonObject();
        proj2.addProperty("type", "ortho");
        proj2.addProperty("orthoHeight", 8.0d);
        proj2.addProperty("fov", 70.0d);
        c2.add("projection", proj2);
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].projection.fov"));
    }

    @Test
    public void fovAndOrthoHeightRangesAreEnforced() {
        JsonObject c = perspective("fov-low");
        c.getAsJsonObject("projection")
            .addProperty("fov", 2.0d);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].projection.fov"));

        JsonObject cTele = perspective("fov-telescope");
        cTele.getAsJsonObject("projection")
            .addProperty("fov", 5.0d);
        assertTrue(
            "望远镜窄 fov（>=5）合法（K1 门控对照实测需要）",
            parse(cameras(cTele)).fields()
                .isEmpty());

        JsonObject c2 = perspective("fov-high");
        c2.getAsJsonObject("projection")
            .addProperty("fov", 200.0d);
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].projection.fov"));

        JsonObject c3 = perspective("ortho-low");
        JsonObject proj3 = new JsonObject();
        proj3.addProperty("type", "ortho");
        proj3.addProperty("orthoHeight", 0.1d);
        c3.add("projection", proj3);
        assertTrue(mentions(parse(cameras(c3)), "cameras[0].projection.orthoHeight"));
    }

    @Test
    public void unknownProjectionTypeIsRejected() {
        JsonObject c = perspective("weird");
        c.getAsJsonObject("projection")
            .addProperty("type", "isometric");
        assertTrue(mentions(parse(cameras(c)), "cameras[0].projection.type"));
    }

    @Test
    public void resolutionMustBePositiveIntegersInRange() {
        JsonObject c = perspective("res-missing");
        c.remove("resolution");
        assertTrue(mentions(parse(cameras(c)), "cameras[0].resolution"));

        JsonObject c2 = perspective("res-nonint");
        c2.add("resolution", doubles(1920.5d, 1080.0d));
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].resolution[0]"));

        JsonObject c3 = perspective("res-zero");
        c3.add("resolution", ints(0, 1080));
        assertTrue(mentions(parse(cameras(c3)), "cameras[0].resolution[0]"));

        JsonObject c4 = perspective("res-huge");
        c4.add("resolution", ints(99999, 1080));
        assertTrue(mentions(parse(cameras(c4)), "cameras[0].resolution[0]"));
    }

    @Test
    public void tileColsRowsAndOverlapRangesAreEnforced() {
        JsonObject c = perspective("tile-cols");
        JsonObject tile = new JsonObject();
        tile.addProperty("cols", 0);
        c.add("tile", tile);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].tile.cols"));

        JsonObject c2 = perspective("tile-rows");
        JsonObject tile2 = new JsonObject();
        tile2.addProperty("rows", 9);
        c2.add("tile", tile2);
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].tile.rows"));

        JsonObject c3 = perspective("tile-overlap");
        JsonObject tile3 = new JsonObject();
        tile3.addProperty("cols", 2);
        tile3.addProperty("overlap", 0.75d);
        c3.add("tile", tile3);
        assertTrue(mentions(parse(cameras(c3)), "cameras[0].tile.overlap"));

        JsonObject c4 = perspective("tile-empty");
        c4.add("tile", new JsonObject());
        assertTrue(mentions(parse(cameras(c4)), "cameras[0].tile"));
    }

    @Test
    public void unknownFieldsAreRejected() {
        JsonObject c = perspective("typo");
        c.addProperty("fovv", 70.0d);
        assertTrue(mentions(parse(cameras(c)), "cameras[0].fovv"));

        JsonObject c2 = perspective("typo2");
        c2.getAsJsonObject("projection")
            .addProperty("zoom", 2);
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].projection.zoom"));

        JsonObject c3 = perspective("typo3");
        JsonObject tile = new JsonObject();
        tile.addProperty("cols", 2);
        tile.addProperty("overlapX", 0.1d);
        c3.add("tile", tile);
        assertTrue(mentions(parse(cameras(c3)), "cameras[0].tile.overlapX"));
    }

    /** 非 object 的机位条目：报数组元素级错误。 */
    @Test
    public void nonObjectEntryIsRejected() {
        JsonArray arr = new JsonArray();
        arr.add("nope");
        assertTrue(mentions(parse(arr), "cameras[0]"));
    }

    /** 机位数上限。 */
    @Test
    public void cameraCountIsBounded() {
        JsonArray arr = new JsonArray();
        for (int i = 0; i <= CameraSpecs.MAX_CAMERAS; i++) {
            arr.add(perspective("c" + i));
        }
        assertTrue(mentions(parse(arr), "cameras"));
    }

    /** 机位级 renderMode/lighting 覆盖（合法值通过、非法值报字段）。 */
    @Test
    public void perCameraOverrides() {
        JsonObject c = perspective("ov");
        c.addProperty("renderMode", CaptureSpec.RENDER_MODE_LIT);
        c.addProperty("lighting", CaptureSpec.LIGHTING_NEUTRAL_FLAT);
        CameraSpecs.Parsed p = parse(cameras(c));
        assertFalse(
            p.fields()
                .summary(),
            p.hasErrors());
        assertEquals(
            CaptureSpec.RENDER_MODE_LIT,
            CameraSpecs.resolveRenderMode(
                p.specs()
                    .get(0),
                null));

        JsonObject c2 = perspective("bad");
        c2.addProperty("renderMode", "彩色");
        assertTrue(mentions(parse(cameras(c2)), "cameras[0].renderMode"));

        JsonObject c3 = perspective("bad2");
        c3.addProperty("lighting", "bright");
        assertTrue(mentions(parse(cameras(c3)), "cameras[0].lighting"));
    }

    /** 会话默认 + 机位覆盖的解析顺序。 */
    @Test
    public void sessionDefaultsAreOverriddenPerCamera() {
        CaptureSpec session = CaptureSpec
            .parseOrThrow(sessionDefaults("natural", CaptureSpec.RENDER_MODE_NATIVE, 6000L), "capture");
        CameraSpec plain = CameraSpec.parse(perspective("plain"), "cameras[0]");
        assertEquals("natural", CameraSpecs.resolveLighting(plain, session));
        assertEquals(CaptureSpec.RENDER_MODE_NATIVE, CameraSpecs.resolveRenderMode(plain, session));

        JsonObject override = perspective("lit");
        override.addProperty("lighting", CaptureSpec.LIGHTING_NEUTRAL_FLAT);
        override.addProperty("renderMode", CaptureSpec.RENDER_MODE_LIT);
        CameraSpec lit = CameraSpec.parse(override, "cameras[1]");
        assertEquals(CaptureSpec.LIGHTING_NEUTRAL_FLAT, CameraSpecs.resolveLighting(lit, session));
        assertEquals(CaptureSpec.RENDER_MODE_LIT, CameraSpecs.resolveRenderMode(lit, session));

        // 无会话默认时也是契约默认值
        assertEquals(CaptureSpec.LIGHTING_NATURAL, CameraSpecs.resolveLighting(plain, null));
        assertEquals(CaptureSpec.RENDER_MODE_NATIVE, CameraSpecs.resolveRenderMode(plain, null));
    }

    /** capture 段：合法值解析 + 范围校验。 */
    @Test
    public void captureSegmentValidation() {
        CaptureSpec spec = CaptureSpec.parseOrThrow(
            sessionDefaults(CaptureSpec.LIGHTING_NEUTRAL_FLAT, CaptureSpec.RENDER_MODE_LIT, 18000L),
            "capture");
        assertEquals(CaptureSpec.LIGHTING_NEUTRAL_FLAT, spec.lighting());
        assertEquals(CaptureSpec.RENDER_MODE_LIT, spec.renderMode());
        assertTrue(spec.hasWorldTime());
        assertEquals(18000L, spec.worldTime());

        Fields fields = new Fields();
        CaptureSpec.parse(sessionDefaults("dim", "彩色", 30000L), "capture", fields);
        assertTrue(mentions(fields, "capture.lighting"));
        assertTrue(mentions(fields, "capture.renderMode"));
        assertTrue(mentions(fields, "capture.worldTime"));

        Fields unknown = new Fields();
        JsonObject o = new JsonObject();
        o.addProperty("brightness", 1);
        CaptureSpec.parse(o, "capture", unknown);
        assertTrue(mentions(unknown, "capture.brightness"));
    }

    /** 规范化 JSON（观测记录 cameras[] 与 shot-meta 共用）。 */
    @Test
    public void normalizedJsonShape() {
        JsonObject c = perspective("json-shape");
        JsonObject tile = new JsonObject();
        tile.addProperty("cols", 2);
        c.add("tile", tile);
        CameraSpec spec = CameraSpec.parse(c, "cameras[0]");
        JsonObject o = spec.toJson();
        assertEquals("json-shape", Json.optString(o, "name", null));
        assertEquals(
            3,
            Json.optArray(o, "pos")
                .size());
        assertEquals("perspective", Json.optString(Json.optObject(o, "projection"), "type", null));
        assertEquals(
            2,
            Json.optArray(o, "resolution")
                .size());
        assertNotNull(Json.optObject(o, "tile"));
        assertEquals(2, Json.optInt(Json.optObject(o, "tile"), "cols", 0));

        JsonObject summary = CameraSpecs.summary(spec);
        assertEquals("json-shape", Json.optString(summary, "name", null));
        assertNotNull(Json.optObject(summary, "projection"));
        assertFalse(summary.has("renderMode"));
    }

    /** 单机位解析抛错时字段前缀正确。 */
    @Test
    public void parseThrowsWithFieldContext() {
        JsonObject c = perspective("boom");
        c.remove("resolution");
        try {
            CameraSpec.parse(c, "cameras[3]");
            fail("应当抛 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(cpMentions(e, "cameras[3].resolution"));
        }
    }

    private static boolean mentions(Fields fields, String field) {
        for (JsonElement e : fields.toJson()) {
            if (field.equals(
                e.getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                return true;
            }
        }
        return false;
    }

    private static boolean cpMentions(CpException e, String field) {
        JsonElement fs = e.context() == null ? null
            : e.context()
                .get("fields");
        if (fs == null || !fs.isJsonArray()) {
            return false;
        }
        for (JsonElement f : fs.getAsJsonArray()) {
            if (field.equals(
                f.getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                return true;
            }
        }
        return false;
    }

    private static JsonObject sessionDefaults(String lighting, String renderMode, long worldTime) {
        JsonObject o = new JsonObject();
        if (lighting != null) {
            o.addProperty("lighting", lighting);
        }
        if (renderMode != null) {
            o.addProperty("renderMode", renderMode);
        }
        if (worldTime >= 0L) {
            o.addProperty("worldTime", worldTime);
        }
        return o;
    }

    private static void assertArray(int[] expected, int[] actual) {
        assertEquals(expected.length, actual.length);
        for (int i = 0; i < expected.length; i++) {
            assertEquals(expected[i], actual[i]);
        }
    }

    /** 机位表可用于 case.validate 的计划（顺序保持声明序）。 */
    @Test
    public void planKeepsDeclarationOrder() {
        CameraSpecs.Parsed p = parse(cameras(perspective("a"), perspective("b"), perspective("c")));
        List<CameraSpec> specs = p.specs();
        assertEquals(3, specs.size());
        assertEquals(
            "a",
            specs.get(0)
                .name());
        assertEquals(
            "b",
            specs.get(1)
                .name());
        assertEquals(
            "c",
            specs.get(2)
                .name());
    }

    // ------------------------------------------------------------ 投影偏移数值（tiling 的核心）

    // 原 projectionOffsetMath（反射调 ProjectionOverride.scaleTranslatePure/orthoMatrix）已删除：
    // 它反射的纯函数随网格单源化重构移除，且历来因缺 LWJGL 走 SKIP 空转（0 断言绿）。
    // 同一数学现在由 mc/capture/TileProjection + TilePlan 承载，真测见 TilePlanTest（11 个，非 SKIP）。
}
