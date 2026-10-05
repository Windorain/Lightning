package com.lightning.mod.client.controlplane.core;

import java.io.IOException;
import java.io.Reader;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

/**
 * Gson 之上的 JSON 工具：严格解析、序列化、深拷贝、规范化与 RFC 6901 指针。
 *
 * <p>
 * 控制面所有外部输入（HTTP 请求体、用例文件）都走 {@link #parseStrict(String)}：
 * 贪心的 Gson 默认解析器会接受单引号、裸键名、注释、尾随垃圾与 NaN，这些在「防笔误静默」
 * 的要求下都必须报错（case-file.md §9）。本实现另拒绝重复键名。
 */
public final class Json {

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping()
        .create();

    private static final Gson GSON_PRETTY = new GsonBuilder().disableHtmlEscaping()
        .setPrettyPrinting()
        .create();

    private Json() {}

    // ------------------------------------------------------------------ 解析

    /**
     * 严格解析 JSON 文本（见类注释）。
     *
     * @throws JsonSyntaxException 语法错误、重复键、空文档或尾随垃圾
     */
    public static JsonElement parseStrict(String text) {
        if (text == null) {
            throw new JsonSyntaxException("JSON 文本为 null");
        }
        return parseStrict(new StringReader(text));
    }

    /** 严格解析 JSON（{@link Reader} 版本）。 */
    public static JsonElement parseStrict(Reader reader) {
        JsonReader r = new JsonReader(reader);
        r.setLenient(false);
        try {
            JsonElement root = readValue(r);
            if (r.peek() != JsonToken.END_DOCUMENT) {
                throw new JsonSyntaxException("JSON 文档末尾存在多余内容");
            }
            return root;
        } catch (JsonSyntaxException e) {
            throw e;
        } catch (IOException e) {
            throw new JsonSyntaxException("JSON 解析失败: " + e.getMessage(), e);
        } finally {
            try {
                r.close();
            } catch (IOException ignored) {
                // 关闭失败不影响解析结果
            }
        }
    }

    /** 严格解析并要求根为对象。 */
    public static JsonObject parseStrictObject(String text) {
        JsonElement e = parseStrict(text);
        if (!e.isJsonObject()) {
            throw new JsonSyntaxException("JSON 根节点须为对象");
        }
        return e.getAsJsonObject();
    }

    private static JsonElement readValue(JsonReader r) throws IOException {
        JsonToken t = r.peek();
        switch (t) {
            case BEGIN_OBJECT:
                return readObject(r);
            case BEGIN_ARRAY:
                return readArray(r);
            case STRING:
                return new JsonPrimitive(r.nextString());
            case NUMBER:
                return new JsonPrimitive(new BigDecimal(r.nextString()));
            case BOOLEAN:
                return new JsonPrimitive(r.nextBoolean());
            case NULL:
                r.nextNull();
                return JsonNull.INSTANCE;
            default:
                throw new JsonSyntaxException("意外的 JSON 记号: " + t);
        }
    }

    private static JsonObject readObject(JsonReader r) throws IOException {
        r.beginObject();
        JsonObject o = new JsonObject();
        Set<String> seen = new LinkedHashSet<String>();
        while (r.hasNext()) {
            String name = r.nextName();
            if (!seen.add(name)) {
                throw new JsonSyntaxException("重复的键名: " + name);
            }
            o.add(name, readValue(r));
        }
        r.endObject();
        return o;
    }

    private static JsonArray readArray(JsonReader r) throws IOException {
        r.beginArray();
        JsonArray a = new JsonArray();
        while (r.hasNext()) {
            a.add(readValue(r));
        }
        r.endArray();
        return a;
    }

    // ------------------------------------------------------------ 序列化

    /** 紧凑 JSON 文本。 */
    public static String toJson(JsonElement e) {
        return GSON.toJson(e == null ? JsonNull.INSTANCE : e);
    }

    /** 缩进 JSON 文本（落盘用，便于人读与 diff）。 */
    public static String toPretty(JsonElement e) {
        return GSON_PRETTY.toJson(e == null ? JsonNull.INSTANCE : e);
    }

    /** 紧凑 JSON 的 UTF-8 字节。 */
    public static byte[] toBytes(JsonElement e) {
        return toJson(e).getBytes(StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------ 构造

    /** 新空对象。 */
    public static JsonObject object() {
        return new JsonObject();
    }

    /** 新空数组。 */
    public static JsonArray array() {
        return new JsonArray();
    }

    /** 由键值对构造对象（值为 null 时省略该键，便于可选字段）。 */
    public static JsonObject object(Object... keyValuePairs) {
        JsonObject o = new JsonObject();
        for (int i = 0; i + 1 < keyValuePairs.length; i += 2) {
            String k = String.valueOf(keyValuePairs[i]);
            Object v = keyValuePairs[i + 1];
            if (v == null) {
                continue;
            }
            if (v instanceof JsonElement) {
                o.add(k, (JsonElement) v);
            } else if (v instanceof String) {
                o.addProperty(k, (String) v);
            } else if (v instanceof Boolean) {
                o.addProperty(k, (Boolean) v);
            } else if (v instanceof Number) {
                o.addProperty(k, (Number) v);
            } else {
                o.addProperty(k, String.valueOf(v));
            }
        }
        return o;
    }

    // ------------------------------------------------------------ 取值

    /** 取成员；不存在或为 JSON null 时返回 null。 */
    public static JsonElement get(JsonObject o, String key) {
        if (o == null || key == null || !o.has(key)) {
            return null;
        }
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? null : e;
    }

    /** 取字符串成员，缺失/类型不符返回默认值。 */
    public static String optString(JsonObject o, String key, String def) {
        JsonElement e = get(o, key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : def;
    }

    /** 取整数成员，缺失/类型不符返回默认值。 */
    public static int optInt(JsonObject o, String key, int def) {
        JsonElement e = get(o, key);
        if (e == null || !e.isJsonPrimitive()) {
            return def;
        }
        try {
            return e.getAsInt();
        } catch (RuntimeException ex) {
            return def;
        }
    }

    /** 取长整数成员，缺失/类型不符返回默认值。 */
    public static long optLong(JsonObject o, String key, long def) {
        JsonElement e = get(o, key);
        if (e == null || !e.isJsonPrimitive()) {
            return def;
        }
        try {
            return e.getAsLong();
        } catch (RuntimeException ex) {
            return def;
        }
    }

    /** 取布尔成员，缺失/类型不符返回默认值。 */
    public static boolean optBool(JsonObject o, String key, boolean def) {
        JsonElement e = get(o, key);
        if (e == null || !e.isJsonPrimitive()
            || !e.getAsJsonPrimitive()
                .isBoolean()) {
            return def;
        }
        return e.getAsBoolean();
    }

    /** 取对象成员，缺失/类型不符返回 null。 */
    public static JsonObject optObject(JsonObject o, String key) {
        JsonElement e = get(o, key);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : null;
    }

    /** 取数组成员，缺失/类型不符返回 null。 */
    public static JsonArray optArray(JsonObject o, String key) {
        JsonElement e = get(o, key);
        return e != null && e.isJsonArray() ? e.getAsJsonArray() : null;
    }

    /** 深拷贝（{@link JsonElement#deepCopy()} 的 null 安全包装）。 */
    public static JsonElement copy(JsonElement e) {
        return e == null ? JsonNull.INSTANCE : e.deepCopy();
    }

    /** 深拷贝对象。 */
    public static JsonObject copyObject(JsonObject o) {
        return o == null ? new JsonObject() : o.deepCopy();
    }

    // ------------------------------------------------------------ 规范化

    /**
     * 规范化 JSON 文本：对象键按字典序排序、无任何空白。
     *
     * <p>
     * 用于 observation-record.md §2.1 的「摘要对象规范化 JSON 哈希」口径——
     * 同一份摘要不论字段书写顺序，哈希必须一致。
     */
    public static String canonical(JsonElement e) {
        StringBuilder sb = new StringBuilder();
        writeCanonical(e == null ? JsonNull.INSTANCE : e, sb);
        return sb.toString();
    }

    private static void writeCanonical(JsonElement e, StringBuilder sb) {
        if (e.isJsonNull()) {
            sb.append("null");
            return;
        }
        if (e.isJsonPrimitive()) {
            sb.append(toJson(e));
            return;
        }
        if (e.isJsonArray()) {
            sb.append('[');
            JsonArray a = e.getAsJsonArray();
            for (int i = 0; i < a.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                writeCanonical(a.get(i), sb);
            }
            sb.append(']');
            return;
        }
        JsonObject o = e.getAsJsonObject();
        List<String> keys = new ArrayList<String>(o.keySet());
        Collections.sort(keys);
        sb.append('{');
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            String k = keys.get(i);
            sb.append(toJson(new JsonPrimitive(k)))
                .append(':');
            writeCanonical(o.get(k), sb);
        }
        sb.append('}');
    }

    // ------------------------------------------------------------ JSON 指针

    /** RFC 6901 指针转义：{@code ~} → {@code ~0}，{@code /} → {@code ~1}。 */
    public static String pointerEscape(String token) {
        return token == null ? ""
            : token.replace("~", "~0")
                .replace("/", "~1");
    }

    /** RFC 6901 指针反转义（必须先 ~1 再 ~0）。 */
    public static String pointerUnescape(String token) {
        return token == null ? ""
            : token.replace("~1", "/")
                .replace("~0", "~");
    }

    /**
     * 按 RFC 6901 解析指针。
     *
     * @param root    根节点
     * @param pointer 指针，{@code ""} 表示根自身；非 {@code /} 开头视为非法
     * @return 命中的节点；任一步缺失返回 {@code null}
     */
    public static JsonElement resolvePointer(JsonElement root, String pointer) {
        if (root == null || pointer == null) {
            return null;
        }
        if (pointer.isEmpty()) {
            return root;
        }
        if (!pointer.startsWith("/")) {
            return null;
        }
        JsonElement cur = root;
        String[] tokens = pointer.substring(1)
            .split("/", -1);
        for (String raw : tokens) {
            String token = pointerUnescape(raw);
            if (cur.isJsonObject()) {
                JsonObject o = cur.getAsJsonObject();
                if (!o.has(token)) {
                    return null;
                }
                cur = o.get(token);
            } else if (cur.isJsonArray()) {
                JsonArray a = cur.getAsJsonArray();
                if ("-".equals(token)) {
                    return null;
                }
                int idx = parseIndex(token);
                if (idx < 0 || idx >= a.size()) {
                    return null;
                }
                cur = a.get(idx);
            } else {
                return null;
            }
        }
        return cur;
    }

    /** 解析数组下标；非法返回 -1。 */
    public static int parseIndex(String token) {
        if (token == null || token.isEmpty()) {
            return -1;
        }
        if (token.length() > 1 && token.charAt(0) == '0') {
            return -1;
        }
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            if (c < '0' || c > '9') {
                return -1;
            }
        }
        try {
            return Integer.parseInt(token);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 是否为空对象（无成员）。 */
    public static boolean isEmptyObject(JsonElement e) {
        return e != null && e.isJsonObject()
            && e.getAsJsonObject()
                .size() == 0;
    }

    /** 对象转有序键列表（调试输出用）。 */
    public static List<String> keys(JsonObject o) {
        if (o == null) {
            return Collections.emptyList();
        }
        return new ArrayList<String>(o.keySet());
    }

    /** 遍历成员（等价 {@code entrySet}，收敛 import）。 */
    public static Set<Map.Entry<String, JsonElement>> entries(JsonObject o) {
        return o == null ? Collections.<Map.Entry<String, JsonElement>>emptySet() : o.entrySet();
    }
}
