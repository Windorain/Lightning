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
