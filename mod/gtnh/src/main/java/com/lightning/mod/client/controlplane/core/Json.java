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

    /**
     * 序列化用 Gson。
     *
     * <h2>为什么必须 {@code serializeNulls()}</h2>
     * Gson 默认<b>丢弃</b>值为 {@code JsonNull} 的成员（{@code serializeNulls} 为 false 时的
     * {@code JsonObject} 序列化行为，2.2.4 与 2.13.2 实测一致）。这与本项目的显式性纪律直接冲突：
     * <ul>
     * <li>{@code TeDescriber} 的实现纪律明写「缺席用显式 {@code null}」——否则 {@code expect: null}
     * 这类断言会与「键名写错」混淆（求值侧把「键不存在」判红）；</li>
     * <li>「失败显式」：读数里的「这一面是空的」与「这个字段我没读」必须分得开。</li>
     * </ul>
     * 实测症状（实机验收擒获）：{@code read.te} / {@code scene-manifest.teReads} 里
     * 显式写入的 {@code null} 成员在落盘后<b>整个键消失</b>，于是内存里判据看得见的
     * 「显式缺席」在产物里变成了「键不存在」——同一份状态在两条路径上含义不同。
     *
     * <p>
     * 打开它<b>只影响显式写 null 的成员</b>：{@link #object(Object...)} 仍在构造期跳过 null 值
     * （「不传即省略」的可选字段惯用法照旧），{@code CpException.toErrorJson()} 等按需省略
     * {@code context} 的写法也不受影响。{@link #canonical} 是手写序列化器、本来就输出 {@code null}，
     * 因此哈希口径与本次改动无关（改动前后一致）。
     */
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping()
        .serializeNulls()
        .create();

    /** 见 {@link #GSON}：缩进版同样必须 {@code serializeNulls()}。 */
    private static final Gson GSON_PRETTY = new GsonBuilder().disableHtmlEscaping()
        .serializeNulls()
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

    /** 紧凑 JSON 文本（显式 {@code null} 成员<b>保留</b>为 {@code null}，见 {@link #GSON}）。 */
    public static String toJson(JsonElement e) {
        return GSON.toJson(e == null ? JsonNull.INSTANCE : e);
    }

    /** 缩进 JSON 文本（落盘用，便于人读与 diff；{@code null} 成员保留口径同 {@link #toJson}）。 */
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

    /**
     * 取整数成员，缺失/类型不符返回默认值。
     *
     * <p>
     * <b>这是「宽容读」</b>（读自己写出来的 JSON 时用）：值不是数字时拿默认值，是数字时按 gson 语义取值。
     * <b>不得</b>用它读调用方传来的参数——gson 的 {@code getAsInt()} 会把 {@code 1.5} 截断成 {@code 1}、
     * 把 {@code "3"} 解析成 {@code 3}、把 {@code true} 当成 {@code 1}，且<b>不抛异常</b>
     * （静默强转）。参数一律走 {@link #strictInt(JsonObject, String, int)}。
     */
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

    /**
     * 取长整数成员，缺失/类型不符返回默认值（与 {@link #optInt} 同为「宽容读」，理由见该方法的说明）。
     */
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

    // ------------------------------------------------------------ TYPE_INT 严格取值

    /**
     * 严格取整数成员（{@code TYPE_INT} 语义，全仓统一的严格口径）。
     *
     * <h2>接受 / 拒绝（这是契约可见行为，与 {@code contract.md} §4 的对照表逐行一致）</h2>
     *
     * <table>
     * <caption>TYPE_INT 取值口径</caption>
     * <tr>
     * <td>接受</td>
     * <td>{@code 3}、{@code 3.0}、{@code -7}（JSON 数值且<b>值精确为整数</b>，在 int 范围内）</td>
     * </tr>
     * <tr>
     * <td>接受</td>
     * <td>键不存在，或值为 JSON {@code null} ⇒ 用默认值（= 「未提供」，与 {@code ActionContext.has} 同口径）</td>
     * </tr>
     * <tr>
     * <td>拒绝</td>
     * <td>非整数数值 {@code 1.5} / {@code -0.5}、布尔 {@code true}、字符串 {@code "3"}、超 int 范围</td>
     * </tr>
     * </table>
     *
     * <p>
     * 为什么不用 gson 的 {@code getAsInt()}：它经 {@code LazilyParsedNumber.intValue()} / {@code BigDecimal}
     * 直接<b>截断</b>（{@code 1.5 → 1}）、把字符串<b>解析</b>（{@code "3" → 3}）、把布尔<b>当 1</b>，且不抛异常
     * ⇒ 「调用方写了 1.5、动作按 1 执行、回报 1」，是一处全动作面的静默失真。本方法把「类型即判据」显式化：
     * 不做任何隐式转换，值不合就 {@code CP-VALID-002}，并在 {@code context.fields} 里逐项说明
     * 「收到的值与类型、期望类型、为什么拒绝」，另带 {@code hint}。
     *
     * @param o   JSON 对象
     * @param key 成员名（错误消息与 context 里都用它作字段名）
     * @param def 未提供（缺键或 JSON null）时的默认值
     * @throws CpException CP-VALID-002：值存在但不是精确整数
     */
    public static int strictInt(JsonObject o, String key, int def) {
        JsonElement e = get(o, key);
        if (e == null) {
            return def;
        }
        return strictIntElement(e, key);
    }

    /** 严格取长整数成员；口径与 {@link #strictInt} 相同，只是范围是 long。 */
    public static long strictLong(JsonObject o, String key, long def) {
        JsonElement e = get(o, key);
        if (e == null) {
            return def;
        }
        return strictLongElement(e, key);
    }

    /**
     * 严格整数（元素形态）：合法返回其值，否则抛 {@code CP-VALID-002}。
     *
     * <p>
     * 供「参数不是顶层成员」的场景使用（如 {@code frames:[int...]} 的元素、{@code expectFrames.frames[]}）。
     */
    public static int strictIntElement(JsonElement e, String field) {
        String why = integralRejectReason(e);
        if (why != null) {
            throw intParamError(field, e, why, "int");
        }
        try {
            return new BigDecimal(e.getAsString()).intValueExact();
        } catch (ArithmeticException | NumberFormatException ex) {
            throw intParamError(field, e, "超出 int 可表示范围", "int");
        }
    }

    /** 严格长整数（元素形态）：口径与 {@link #strictIntElement} 相同。 */
    public static long strictLongElement(JsonElement e, String field) {
        String why = integralRejectReason(e);
        if (why != null) {
            throw intParamError(field, e, why, "int");
        }
        try {
            return new BigDecimal(e.getAsString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException ex) {
            throw intParamError(field, e, "超出 long 可表示范围", "int");
        }
    }

    /**
     * 「为什么这个值不是一个精确整数」；合法时返回 {@code null}。
     *
     * <p>
     * 存在的理由：有些调用点要<b>累加</b>逐字段错误后一次性抛出（{@code Fields} 口径，见
     * {@code export.scene} 的 {@code frames[]} 校验），不能一遇错就抛。本方法给它们一个可累加的判据，
     * 判定规则与 {@link #strictIntElement} <b>共用同一处实现</b>（不另抄一份规则）。
     */
    public static String integralRejectReason(JsonElement e) {
        if (e == null || e.isJsonNull()) {
            return "缺失";
        }
        if (!e.isJsonPrimitive()) {
            return "期望 JSON 数值（精确整数），收到 " + typeName(e);
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        if (p.isBoolean()) {
            return "期望 JSON 数值（精确整数），收到布尔 " + e.getAsString() + "（布尔不做 0/1 转换）";
        }
        if (p.isString()) {
            return "期望 JSON 数值（精确整数），收到字符串 \"" + e.getAsString() + "\"（字符串不做解析）";
        }
        BigDecimal bd;
        try {
            bd = new BigDecimal(e.getAsString());
        } catch (RuntimeException ex) {
            return "期望 JSON 数值（精确整数），收到无法按十进制精确表示的数值 " + e.getAsString();
        }
        if (bd.stripTrailingZeros()
            .scale() > 0) {
            return "期望精确整数，收到带小数的数值 " + e.getAsString() + "（不做截断）";
        }
        return null;
    }

    /** 参数类型不符的 {@code CP-VALID-002}（context.fields 含 field/reason/received/receivedType/expected + hint）。 */
    private static CpException intParamError(String field, JsonElement received, String reason, String expected) {
        JsonObject f = new JsonObject();
        f.addProperty("field", field);
        f.addProperty("reason", reason);
        f.addProperty("received", received == null ? null : received.toString());
        f.addProperty("receivedType", typeName(received));
        f.addProperty("expected", expected);
        JsonArray fields = new JsonArray();
        fields.add(f);
        JsonObject ctx = new JsonObject();
        ctx.add("fields", fields);
        ctx.addProperty(
            "hint",
            "TYPE_INT 参数要求 JSON 数值且值精确为整数（如 3 / 3.0）；不接受小数、字符串数字与布尔（契约 §4）。" + "确实需要小数请改用声明为 number 的参数");
        return new CpException(
            ErrorCodes.VALID_PARAM,
            "参数类型不符: " + field
                + " 期望 "
                + expected
                + "（精确整数），收到 "
                + (received == null ? "null" : received.toString())
                + "（类型 "
                + typeName(received)
                + "）",
            ctx);
    }

    /** JSON 值的类型名（错误上下文用；不用 gson 的 {@code JsonElement} 类名，人读优先）。 */
    public static String typeName(JsonElement e) {
        if (e == null || e.isJsonNull()) {
            return "null";
        }
        if (e.isJsonArray()) {
            return "array";
        }
        if (e.isJsonObject()) {
            return "object";
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        if (p.isBoolean()) {
            return "boolean";
        }
        if (p.isString()) {
            return "string";
        }
        return "number";
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

    /**
     * 深拷贝（{@link JsonElement} 的 null 安全包装）。
     *
     * <p>
     * **不要**用 {@code JsonElement.deepCopy()}：那是 gson 2.8.2+ 的 API，运行期 2.2.4 里
     * 该方法 (a) 在 {@code JsonElement} 上是包私有的、(b) 在 {@code JsonObject}/{@code JsonArray}
     * 上也非 public —— 调用点能编译、游戏内必崩。这里手写等价递归：
     * 原语不可变（gson 的 {@code JsonPrimitive.deepCopy()} 同样返回 this），
     * 对象/数组逐成员深拷。
     */
    public static JsonElement copy(JsonElement e) {
        if (e == null || e.isJsonNull()) {
            return JsonNull.INSTANCE;
        }
        if (e.isJsonArray()) {
            return copyArray(e.getAsJsonArray());
        }
        if (e.isJsonObject()) {
            return copyObject(e.getAsJsonObject());
        }
        return e;
    }

    /** 深拷贝对象；null 返回空对象。 */
    public static JsonObject copyObject(JsonObject o) {
        JsonObject out = new JsonObject();
        if (o != null) {
            for (Map.Entry<String, JsonElement> en : o.entrySet()) {
                out.add(en.getKey(), copy(en.getValue()));
            }
        }
        return out;
    }

    /** 深拷贝数组；null 返回空数组。 */
    public static JsonArray copyArray(JsonArray a) {
        JsonArray out = new JsonArray();
        if (a != null) {
            for (int i = 0; i < a.size(); i++) {
                out.add(copy(a.get(i)));
            }
        }
        return out;
    }

    /**
     * 追加一个字符串元素。
     *
     * <p>
     * {@code JsonArray.add(String)} 是 gson 2.8+ 的重载，运行期 2.2.4 只有
     * {@code add(JsonElement)} —— 直接用会在游戏内抛 {@code NoSuchMethodError}。
     * null 一并按 gson 的口径归一为 {@link JsonNull#INSTANCE}（而非 "值为 null 的原语"）。
     */
    public static void add(JsonArray a, String v) {
        a.add(v == null ? JsonNull.INSTANCE : new JsonPrimitive(v));
    }

    /** 追加一个数值元素（{@code add(Number)} 同为 2.8+ 重载，null 同样归一为 JsonNull）。 */
    public static void add(JsonArray a, Number v) {
        a.add(v == null ? JsonNull.INSTANCE : new JsonPrimitive(v));
    }

    /** 追加一个布尔元素（{@code add(Boolean)} 同为 2.8+ 重载）。 */
    public static void add(JsonArray a, boolean v) {
        a.add(new JsonPrimitive(Boolean.valueOf(v)));
    }

    // ------------------------------------------------------------ 规范化

    /**
     * 规范化 JSON 文本：对象键按字典序排序、无任何空白。
     *
     * <p>
     * 用于 observation-record.md §2 第 1 条的「摘要对象规范化 JSON 哈希」口径——
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
        List<String> keys = keys(o);
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
                .entrySet()
                .isEmpty();
    }

    /** 对象成员数（{@code JsonObject.size()} 是 2.8.6+ API，改用 entrySet）。 */
    public static int size(JsonObject o) {
        return o == null ? 0
            : o.entrySet()
                .size();
    }

    /** 对象转有序键列表（调试输出用）。 */
    public static List<String> keys(JsonObject o) {
        if (o == null) {
            return Collections.emptyList();
        }
        List<String> out = new ArrayList<String>(
            o.entrySet()
                .size());
        for (Map.Entry<String, JsonElement> en : o.entrySet()) {
            out.add(en.getKey());
        }
        return out;
    }

    /** 遍历成员（等价 {@code entrySet}，收敛 import）。 */
    public static Set<Map.Entry<String, JsonElement>> entries(JsonObject o) {
        return o == null ? Collections.<Map.Entry<String, JsonElement>>emptySet() : o.entrySet();
    }
}
