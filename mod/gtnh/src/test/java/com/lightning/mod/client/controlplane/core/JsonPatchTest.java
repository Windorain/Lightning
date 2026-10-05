package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link JsonPatch} 单测：RFC 6902 子集（replace/add/remove）在对象与数组上的语义与失败路径。
 */
public class JsonPatchTest {

    private static JsonObject doc() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", Contract.SCHEMA_CASE);
        o.addProperty("id", "demo");
        JsonObject world = new JsonObject();
        world.addProperty("seed", 1);
        o.add("world", world);
        JsonArray build = new JsonArray();
        build.add(step("clear"));
        build.add(step("block"));
        build.add(step("wait"));
        o.add("build", build);
        return o;
    }

    private static JsonObject step(String op) {
        JsonObject s = new JsonObject();
        s.addProperty("op", op);
        return s;
    }

    private static JsonArray ops(String op, String path, Object value) {
        JsonArray a = new JsonArray();
        JsonObject o = new JsonObject();
        o.addProperty("op", op);
        o.addProperty("path", path);
        if (value != null) {
            if (value instanceof String) {
                o.addProperty("value", (String) value);
            } else if (value instanceof Number) {
                o.addProperty("value", (Number) value);
            } else {
                o.add("value", (com.google.gson.JsonElement) value);
            }
        }
        a.add(o);
        return a;
    }

    private static JsonObject apply(JsonObject base, JsonArray ops) {
        return JsonPatch.apply(base, ops, "variants[0].mutate")
            .getAsJsonObject();
    }

    @Test
    public void replaceObjectMember() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_REPLACE, "/id", "renamed"));
        assertEquals(
            "renamed",
            out.get("id")
                .getAsString());
    }

    @Test
    public void addNewMemberAndNestedPath() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_ADD, "/label", "展示名"));
        assertEquals(
            "展示名",
            out.get("label")
                .getAsString());

        JsonObject out2 = apply(doc(), ops(JsonPatch.OP_ADD, "/world/base", ints(64, 12, 64)));
        assertEquals(
            3,
            out2.getAsJsonObject("world")
                .getAsJsonArray("base")
                .size());
    }

    @Test
    public void removeMemberAndArrayElement() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_REMOVE, "/world", null));
        assertFalse(out.has("world"));

        JsonObject out2 = apply(doc(), ops(JsonPatch.OP_REMOVE, "/build/1", null));
        assertEquals(
            2,
            out2.getAsJsonArray("build")
                .size());
        assertEquals(
            "clear",
            out2.getAsJsonArray("build")
                .get(0)
                .getAsJsonObject()
                .get("op")
                .getAsString());
        assertEquals(
            "wait",
            out2.getAsJsonArray("build")
                .get(1)
                .getAsJsonObject()
                .get("op")
                .getAsString());
    }

    @Test
    public void addInsertsAtIndexPreservingOrder() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_ADD, "/build/1", step("te")));
        JsonArray build = out.getAsJsonArray("build");
        assertEquals(4, build.size());
        assertEquals("clear", opAt(build, 0));
        assertEquals("te", opAt(build, 1));
        assertEquals("block", opAt(build, 2));
        assertEquals("wait", opAt(build, 3));
    }

    @Test
    public void addWithDashAppendsAndAtSizeAppends() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_ADD, "/build/-", step("te")));
        assertEquals("te", opAt(out.getAsJsonArray("build"), 3));

        JsonObject out2 = apply(doc(), ops(JsonPatch.OP_ADD, "/build/3", step("te")));
        assertEquals("te", opAt(out2.getAsJsonArray("build"), 3));
    }

    @Test
    public void replaceArrayElement() {
        JsonObject out = apply(doc(), ops(JsonPatch.OP_REPLACE, "/build/2", step("wait2")));
        assertEquals("wait2", opAt(out.getAsJsonArray("build"), 2));
    }

    @Test
    public void replaceMissingTargetFails() {
        CpException e = expectFail(doc(), ops(JsonPatch.OP_REPLACE, "/nope", 1));
        assertEquals(ErrorCodes.VALID_PARAM, e.code());
        assertTrue(fieldList(e).contains("variants[0].mutate[0].path"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("replace"));
    }

    @Test
    public void removeMissingTargetFails() {
        CpException e = expectFail(doc(), ops(JsonPatch.OP_REMOVE, "/build/9", null));
        assertTrue(fieldList(e).contains("variants[0].mutate[0].path"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("越界"));
    }

    @Test
    public void addBeyondArraySizeFails() {
        CpException e = expectFail(doc(), ops(JsonPatch.OP_ADD, "/build/9", step("x")));
        assertTrue(fieldList(e).contains("variants[0].mutate[0].path"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("add"));
    }

    @Test
    public void removeRootIsRejected() {
        expectFail(doc(), ops(JsonPatch.OP_REMOVE, "", null));
    }

    @Test
    public void replaceRootReplacesWholeDocument() {
        com.google.gson.JsonElement out = JsonPatch.apply(doc(), ops(JsonPatch.OP_REPLACE, "", "scalar"), "p");
        assertTrue(out.isJsonPrimitive());
        assertEquals("scalar", out.getAsString());
    }

    @Test
    public void unsupportedOpIsRejected() {
        CpException e = expectFail(doc(), ops("move", "/id", "x"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("replace/add/remove"));
    }

    @Test
    public void missingValueIsRejected() {
        expectFail(doc(), ops(JsonPatch.OP_ADD, "/label", null));
        JsonArray withValue = ops(JsonPatch.OP_REMOVE, "/id", "x");
        expectFail(doc(), withValue);
    }

    @Test
    public void pointerEscapesTildeAndSlash() {
        JsonObject base = new JsonObject();
        JsonObject nested = new JsonObject();
        nested.addProperty("a/b", 1);
        nested.addProperty("c~d", 2);
        base.add("weird", nested);

        JsonObject out = apply(base, ops(JsonPatch.OP_REPLACE, "/weird/a~1b", 10));
        assertEquals(
            10,
            out.getAsJsonObject("weird")
                .get("a/b")
                .getAsInt());
        JsonObject out2 = apply(base, ops(JsonPatch.OP_REPLACE, "/weird/c~0d", 20));
        assertEquals(
            20,
            out2.getAsJsonObject("weird")
                .get("c~d")
                .getAsInt());
    }

    @Test
    public void originalDocumentIsNotMutated() {
        JsonObject base = doc();
        apply(base, ops(JsonPatch.OP_REMOVE, "/build/0", null));
        assertEquals(
            3,
            base.getAsJsonArray("build")
                .size());
        assertEquals(
            "demo",
            base.get("id")
                .getAsString());
    }

    @Test
    public void multipleOpsApplyInOrder() {
        JsonArray a = new JsonArray();
        a.addAll(ops(JsonPatch.OP_ADD, "/label", "l"));
        a.addAll(ops(JsonPatch.OP_REMOVE, "/label", null));
        JsonObject out = apply(doc(), a);
        assertFalse(out.has("label"));
    }

    @Test
    public void indexPathWithLeadingZeroIsRejected() {
        expectFail(doc(), ops(JsonPatch.OP_REMOVE, "/build/01", null));
    }

    // ------------------------------------------------------------ 三级含数组路径
    //
    // 回归背景（真机冒烟 A8）：变体补丁 `replace /criteria/0/params/path` 被执行期报
    // 「补丁未改变用例内容」。定位结论是**调用方二次校验**的问题（已补的文档上再应用同一补丁必然
    // 空转），不是 JsonPatch 的下降逻辑；但这族路径（对象 → 数组下标 → 对象 → 成员）此前没有直接
    // 单测，先在这里把它钉死，免得下次再被误判。

    /** 与冒烟用例同形的文档：{@code criteria[].params.path}。 */
    private static JsonObject criteriaDoc() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", Contract.SCHEMA_CASE);
        o.addProperty("id", "cp-smoke-basic");
        JsonArray criteria = new JsonArray();
        criteria.add(criterion("scene-manifest-exists", "artifact-exists", "world/scene-manifest.json"));
        criteria.add(criterion("observation-nonempty", "artifact-nonempty", "observation.json"));
        o.add("criteria", criteria);
        JsonObject evidence = new JsonObject();
        JsonArray expect = new JsonArray();
        JsonObject item = new JsonObject();
        item.addProperty("path", "world/scene-manifest.json");
        item.addProperty("role", "scene-manifest");
        expect.add(item);
        evidence.add("expect", expect);
        o.add("evidence", evidence);
        return o;
    }

    private static JsonObject criterion(String id, String type, String path) {
        JsonObject c = new JsonObject();
        c.addProperty("id", id);
        c.addProperty("type", type);
        JsonObject params = new JsonObject();
        params.addProperty("path", path);
        c.add("params", params);
        return c;
    }

    private static JsonObject criteriaParams(JsonObject doc, int index) {
        return doc.getAsJsonArray("criteria")
            .get(index)
            .getAsJsonObject()
            .getAsJsonObject("params");
    }

    /** 断言基线文档没被 {@link JsonPatch#apply} 改过（深比较）。 */
    private static void assertBaseUntouched(JsonObject base) {
        assertEquals("入参文档不被修改", Json.canonical(criteriaDoc()), Json.canonical(base));
    }

    @Test
    public void replaceThirdLevelPathThroughArrayIndex() {
        JsonObject base = criteriaDoc();
        JsonObject out = apply(base, ops(JsonPatch.OP_REPLACE, "/criteria/0/params/path", "world/absent.json"));
        assertEquals(
            "world/absent.json",
            criteriaParams(out, 0).get("path")
                .getAsString());
        assertEquals(
            "observation.json",
            criteriaParams(out, 1).get("path")
                .getAsString());
        // 文档其余部分逐字段不变：规范化 JSON 比较（键序无关）
        JsonObject expected = Json.copyObject(criteriaDoc());
        criteriaParams(expected, 0).addProperty("path", "world/absent.json");
        assertEquals("除 /criteria/0/params/path 外文档必须逐字段不变", Json.canonical(expected), Json.canonical(out));
        assertBaseUntouched(base);
    }

    @Test
    public void addThirdLevelPathThroughArrayIndex() {
        JsonObject base = criteriaDoc();
        JsonObject out = apply(base, ops(JsonPatch.OP_ADD, "/criteria/0/params/minBytes", 1));
        assertEquals(
            1,
            criteriaParams(out, 0).get("minBytes")
                .getAsInt());
        JsonObject expected = Json.copyObject(criteriaDoc());
        criteriaParams(expected, 0).addProperty("minBytes", 1);
        assertEquals(Json.canonical(expected), Json.canonical(out));
        assertBaseUntouched(base);
    }

    @Test
    public void removeThirdLevelPathThroughArrayIndex() {
        JsonObject base = criteriaDoc();
        JsonObject out = apply(base, ops(JsonPatch.OP_REMOVE, "/criteria/0/params/path", null));
        assertFalse(criteriaParams(out, 0).has("path"));
        JsonObject expected = Json.copyObject(criteriaDoc());
        criteriaParams(expected, 0).remove("path");
        assertEquals(Json.canonical(expected), Json.canonical(out));
        assertBaseUntouched(base);
    }

    @Test
    public void replaceArrayElementNestedInObjectInsideArray() {
        // 对象 → 数组 → 对象 → 数组 → 元素：replaceNode 必须逐层把新数组写回祖先
        JsonObject base = criteriaDoc();
        JsonObject first = base.getAsJsonArray("criteria")
            .get(0)
            .getAsJsonObject();
        first.getAsJsonObject("params")
            .add("at", ints(64, 12, 64));

        JsonObject out = apply(base, ops(JsonPatch.OP_REPLACE, "/criteria/0/params/at/1", 20));
        assertEquals(
            20,
            criteriaParams(out, 0).getAsJsonArray("at")
                .get(1)
                .getAsInt());
        assertEquals(
            64,
            criteriaParams(out, 0).getAsJsonArray("at")
                .get(0)
                .getAsInt());
        assertEquals(
            64,
            criteriaParams(out, 0).getAsJsonArray("at")
                .get(2)
                .getAsInt());
        assertEquals(
            "observation.json",
            criteriaParams(out, 1).get("path")
                .getAsString());
    }

    @Test
    public void replaceArrayElementUnderObjectKeepsSiblingsAndAncestors() {
        JsonObject out = apply(
            criteriaDoc(),
            ops(JsonPatch.OP_REPLACE, "/criteria/0", criterion("x", "artifact-exists", "a.json")));
        JsonArray criteria = out.getAsJsonArray("criteria");
        assertEquals(2, criteria.size());
        assertEquals(
            "x",
            criteria.get(0)
                .getAsJsonObject()
                .get("id")
                .getAsString());
        assertEquals(
            "observation-nonempty",
            criteria.get(1)
                .getAsJsonObject()
                .get("id")
                .getAsString());
        assertEquals(
            Contract.SCHEMA_CASE,
            out.get("schema")
                .getAsString());
        assertEquals(
            1,
            out.getAsJsonObject("evidence")
                .getAsJsonArray("expect")
                .size());
    }

    @Test
    public void testOpIsRejectedRatherThanSilentlyIgnored() {
        // RFC 6902 的 test 不在 v1 子集里；必须显式报错，不能静默 no-op（静默 = 假绿）
        CpException e = expectFail(criteriaDoc(), ops("test", "/criteria/0/params/path", "world/scene-manifest.json"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("replace/add/remove"));
    }

    /** 根就是数组时，重建后的数组必须写回根（replaceNode 的空指针分支）。 */
    @Test
    public void replaceElementOfRootArrayWritesBackToRoot() {
        JsonArray base = new JsonArray();
        base.add(step("clear"));
        base.add(step("block"));
        com.google.gson.JsonElement out = JsonPatch.apply(base, ops(JsonPatch.OP_REPLACE, "/1", step("wait")), "p");
        assertTrue(out.isJsonArray());
        JsonArray arr = out.getAsJsonArray();
        assertEquals(2, arr.size());
        assertEquals("clear", opAt(arr, 0));
        assertEquals("wait", opAt(arr, 1));
        assertEquals(
            "入参数组不被修改",
            "block",
            base.get(1)
                .getAsJsonObject()
                .get("op")
                .getAsString());
    }

    /** 根数组上的 remove 同样要写回根。 */
    @Test
    public void removeElementOfRootArrayWritesBackToRoot() {
        JsonArray base = new JsonArray();
        base.add(step("clear"));
        base.add(step("block"));
        com.google.gson.JsonElement out = JsonPatch.apply(base, ops(JsonPatch.OP_REMOVE, "/0", null), "p");
        assertTrue(out.isJsonArray());
        JsonArray arr = out.getAsJsonArray();
        assertEquals(1, arr.size());
        assertEquals("block", opAt(arr, 0));
        assertEquals(2, base.size());
    }

    private static String opAt(JsonArray build, int i) {
        return build.get(i)
            .getAsJsonObject()
            .get("op")
            .getAsString();
    }

    private static JsonArray ints(int... v) {
        JsonArray a = new JsonArray();
        for (int x : v) {
            a.add(x);
        }
        return a;
    }

    private static CpException expectFail(JsonObject base, JsonArray ops) {
        try {
            apply(base, ops);
            fail("应当抛 CpException");
            return null;
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            return e;
        }
    }

    private static String fieldList(CpException e) {
        return e.context() == null ? ""
            : Json.toJson(
                e.context()
                    .get("fields"));
    }
}
