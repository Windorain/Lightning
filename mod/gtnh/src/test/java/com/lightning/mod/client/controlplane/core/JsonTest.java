package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * gson 2.2.4 兼容层（{@link Json#copy}/{@link Json#copyObject}/{@link Json#copyArray}/
 * {@link Json#add}/{@link Json#size}/{@link Json#keys}）的语义单测。
 *
 * <p>
 * <b>注意</b>：本测试的 classpath 上是 gson 2.8.9（`testImplementation` extendsFrom
 * `implementation`），所以它<b>无法</b>发现「用了 2.8 独有 API」这类缺陷——那是
 * `gradlew gsonCompatCheck`（用运行期 2.2.4 重编译 controlplane 源集）的职责。
 * 这里锁的是另一件事：这些手写替代品必须与 gson 内建 `deepCopy()` 的行为等价
 * （原语共享、对象/数组逐成员新实例、null 归一到 JsonNull/空容器）。
 */
public class JsonTest {

    @Test
    public void copyObjectIsDeepAndIndependent() {
        JsonObject src = new JsonObject();
        src.addProperty("a", 1);
        JsonArray arr = new JsonArray();
        arr.add(new JsonPrimitive("x"));
        src.add("arr", arr);
        JsonObject nested = new JsonObject();
        nested.addProperty("b", true);
        src.add("nested", nested);

        JsonObject copy = Json.copyObject(src);
        assertEquals(Json.toJson(src), Json.toJson(copy));
        assertNotSame(src, copy);

        // 改副本不影响源（逐层独立）
        copy.addProperty("a", 2);
        copy.getAsJsonArray("arr")
            .add(new JsonPrimitive("y"));
        copy.getAsJsonObject("nested")
            .addProperty("b", false);
        assertEquals(
            1,
            src.get("a")
                .getAsInt());
        assertEquals(
            1,
            src.getAsJsonArray("arr")
                .size());
        assertTrue(
            src.getAsJsonObject("nested")
                .get("b")
                .getAsBoolean());

        // 反向：改源不影响副本
        src.addProperty("a", 9);
        assertEquals(
            2,
            copy.get("a")
                .getAsInt());
    }

    @Test
    public void copyArrayIsDeepAndIndependent() {
        JsonArray src = new JsonArray();
        JsonObject item = new JsonObject();
        item.addProperty("k", "v");
        src.add(item);
        src.add(new JsonPrimitive(7));

        JsonArray copy = Json.copyArray(src);
        assertEquals(Json.toJson(src), Json.toJson(copy));
        assertNotSame(src, copy);
        assertNotSame(
            src.get(0)
                .getAsJsonObject(),
            copy.get(0)
                .getAsJsonObject());

        copy.get(0)
            .getAsJsonObject()
            .addProperty("k", "changed");
        assertEquals(
            "v",
            src.get(0)
                .getAsJsonObject()
                .get("k")
                .getAsString());
    }

    @Test
    public void copyNullAndPrimitivesMatchGsonSemantics() {
        // null → JsonNull.INSTANCE（与 Json.copy 的文档口径一致）
        assertSame(JsonNull.INSTANCE, Json.copy(null));
        assertSame(JsonNull.INSTANCE, Json.copy(JsonNull.INSTANCE));

        // 原语不可变：与 gson 的 JsonPrimitive.deepCopy() 一样返回同一实例（共享安全）
        JsonElement p = new JsonPrimitive("s");
        assertSame(p, Json.copy(p));

        // null → 空容器（不是 null）
        assertEquals(
            0,
            Json.copyObject(null)
                .entrySet()
                .size());
        assertEquals(
            0,
            Json.copyArray(null)
                .size());
    }

    @Test
    public void addWrapsPrimitivesIntoJsonElements() {
        JsonArray a = new JsonArray();
        Json.add(a, "s");
        Json.add(a, Integer.valueOf(3));
        Json.add(a, Double.valueOf(1.5d));
        Json.add(a, true);
        assertEquals("[\"s\",3,1.5,true]", Json.toJson(a));
        assertTrue(
            a.get(1)
                .getAsJsonPrimitive()
                .isNumber());
    }

    @Test
    public void addNormalizesNullLikeGsonOverloads() {
        // gson 2.8.9 的 add(String)/add(Number) 都把 null 转成 JsonNull.INSTANCE，这里保持一致
        JsonArray a = new JsonArray();
        Json.add(a, (String) null);
        Json.add(a, (Number) null);
        assertTrue(
            a.get(0)
                .isJsonNull());
        assertTrue(
            a.get(1)
                .isJsonNull());
        assertEquals("[null,null]", Json.toJson(a));
    }

    @Test
    public void sizeAndKeysMirrorEntrySet() {
        assertEquals(0, Json.size(null));

        JsonObject o = new JsonObject();
        o.addProperty("b", 1);
        o.addProperty("a", 2);
        assertEquals(2, Json.size(o));

        List<String> keys = new ArrayList<String>(Json.keys(o));
        // 插入序（LinkedTreeMap），与 entrySet 口径一致
        assertEquals("[b, a]", keys.toString());
        assertEquals(
            2,
            Json.entries(o)
                .size());

        assertEquals(
            "[]",
            Json.keys(null)
                .toString());
    }
}
