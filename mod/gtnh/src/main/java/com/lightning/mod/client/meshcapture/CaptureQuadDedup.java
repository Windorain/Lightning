package com.lightning.mod.client.meshcapture;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * 调色板条目内部的四边形精确去重（捕获兜底，与跨格签名去重是两件事）。
 *
 * <h2>为什么需要它（粒度差）</h2>
 *
 * <p>
 * 捕获层既有的去重是<b>跨格</b>的：逐格烘焙时把整格几何算成一个内容签名，只把签名相同的<b>不同格</b>
 * 合并成同一条调色板条目。而一个 {@code CapturedBlockInstance} 的顶点流是「{@code beginBlock} →
 * 该格全部渲染阶段 → {@code endBlock}」一次性收齐的：两个渲染 pass 若都返回 true 且画出同一套几何，
 * 那套几何在<b>同一条目内部</b>就会出现两遍——跨格签名从结构上永远看不到它（同一个格、同一条条目）。
 * 后果与「多 pass 重复录制」同族：导出件体积翻倍，半透明贴图双重混合使颜色加深。
 *
 * <h2>保守策略：宁可多留一片，也不静默改几何</h2>
 *
 * <p>
 * 只在<b>完全确定</b>两片逐字段相同时才抑制，且保留<b>首个</b>出现的那一片。判等的三条纪律：
 *
 * <ol>
 * <li><b>键集闭集</b>：quad 的键必须<b>恰好</b>是 {@code materialIndex + vertices}，顶点的键必须<b>恰好</b>是
 * {@code x/y/z/u/v/brightness/color}。多出任何一个键（写端新增了字段）⇒ 整份几何<b>一律放行</b>：判等端
 * 不认识那个字段，就没有资格判断"两片相同"。</li>
 * <li><b>按原文精确比较</b>：每个字段取 JSON 原文（不经过 {@code getAsDouble}/{@code getAsLong} 往返），
 * 逐字符比较。整数字段（{@code materialIndex}/{@code brightness}/{@code color}）还必须<b>是整数字面量</b>
 * （形如 {@code -?\d+}）：写成 {@code 1.5} 这类非整数即无法判等 ⇒ 放行。{@code -0.0} 与 {@code 0.0}
 * 原文不同 ⇒ 视为不同片（同一纪律：宁可放过）。</li>
 * <li><b>失败即放行</b>：形态不认识、字段不是 JSON 数字、读数抛异常——一律返回 0 且<b>不改动</b>几何。
 * 去重绝不以「丢几何」为代价。</li>
 * </ol>
 *
 * <p>
 * 刻意<b>不</b>复用 {@code geometrySignature}（跨格签名）：它为「同一套几何出现在不同格」而设计，会排序顶点、
 * 把坐标量化到 4 位小数、且只看参与签名的字段，用来判「条目内这两片是不是同一片」会把近似几何误判成重复。
 *
 * <p>
 * <b>作用面</b>：只被场景导出的条目几何路径（{@code MeshCaptureService.exportEntryGeometry}）调用。诊断 dump
 * 与多方块变体数据集的口径是「如实全量 + 计数」，由 `CaptureDumpAssemblerTest#duplicateQuadsAreCountedButNotDropped` 这类判据锁着，不经本类。
 */
public final class CaptureQuadDedup {

    /**
     * 判等支持的 <b>quad 键闭集</b>。
     *
     * <p>
     * 写端（{@code bakedQuadsGeometryFromCapture}）产出必须落在这一闭集内；写端新增字段而本类没跟上的话，
     * 去重会整体放行（安全方向失效但不丢几何），并由单测的「生产形状漂移棘轮」把这件事<b>判红</b>。
     */
    private static final Set<String> SUPPORTED_QUAD_KEYS = Collections
        .unmodifiableSet(new HashSet<String>(Arrays.asList("materialIndex", "vertices")));

    /** 判等支持的 <b>顶点键闭集</b>（顺序无关；比较顺序由 {@link #VERTEX_FIELDS_IN_COMPARE_ORDER} 固定）。 */
    private static final Set<String> SUPPORTED_VERTEX_KEYS = Collections
        .unmodifiableSet(new HashSet<String>(Arrays.asList("x", "y", "z", "u", "v", "brightness", "color")));

    /** 顶点字段的<b>比较顺序</b>（固定顺序只是为了让键串稳定，不代表对顶点排序）。 */
    private static final String[] VERTEX_FIELDS_IN_COMPARE_ORDER = { "x", "y", "z", "u", "v", "brightness", "color" };

    /** 必须是整数字面量的顶点字段（分数/指数写法无法判等 ⇒ 放行）。 */
    private static final Set<String> INTEGER_VERTEX_FIELDS = Collections
        .unmodifiableSet(new HashSet<String>(Arrays.asList("brightness", "color")));

    private CaptureQuadDedup() {}

    /** 判等支持的 quad 键闭集（只读；供形状漂移棘轮对照写端产出）。 */
    public static Set<String> supportedQuadKeys() {
        return SUPPORTED_QUAD_KEYS;
    }

    /** 判等支持的顶点键闭集（只读；供形状漂移棘轮对照写端产出）。 */
    public static Set<String> supportedVertexKeys() {
        return SUPPORTED_VERTEX_KEYS;
    }

    /**
     * 抑制 {@code geometry.quads} 里全字段完全相同的重复四边形，保留首个。
     *
     * @param geometry {@code bakedQuadsJsonV1} 几何对象（原地修改；{@code null} 视为无操作）
     * @return 被抑制的重复四边形数；0 表示没有重复，或判定条件不满足而<b>全部放行</b>
     */
    public static int suppressExactDuplicates(JsonObject geometry) {
        try {
            return suppressExactDuplicatesOrZero(geometry);
        } catch (RuntimeException e) {
            // 判定过程本身出错 ⇒ 放行（几何尚未被改动：只在末尾整体替换 quads 数组）
            return 0;
        }
    }

    private static int suppressExactDuplicatesOrZero(JsonObject geometry) {
        if (geometry == null || !geometry.has("quads")) {
            return 0;
        }
        JsonElement quadsElement = geometry.get("quads");
        if (quadsElement == null || !quadsElement.isJsonArray()) {
            return 0;
        }
        JsonArray quads = quadsElement.getAsJsonArray();
        int total = quads.size();
        if (total < 2) {
            return 0;
        }

        // 第一遍：为每一片生成"原文键"。任一形态不符 ⇒ 全部放行（什么都不改）
        String[] keys = new String[total];
        for (int i = 0; i < total; i++) {
            String key = exactKeyOrNull(quads.get(i));
            if (key == null) {
                return 0;
            }
            keys[i] = key;
        }

        // 第二遍：保留首次出现的片（相对顺序不变）
        JsonArray kept = new JsonArray();
        Set<String> seen = new HashSet<String>(total * 2);
        int suppressed = 0;
        for (int i = 0; i < total; i++) {
            JsonElement q = quads.get(i);
            if (seen.add(keys[i])) {
                kept.add(q);
            } else {
                suppressed++;
            }
        }
        if (suppressed == 0) {
            return 0;
        }
        // 整体替换 quads 数组（gson 2.2.4 不提供 JsonArray#remove/set）
        geometry.add("quads", kept);
        return suppressed;
    }

    /**
     * 一片四边形的全字段原文键；任何「不认识 / 不精确」的情况返回 {@code null}（⇒ 整份几何放行）。
     *
     * @param quadElement 待判定的四边形（必须是对象）
     */
    private static String exactKeyOrNull(JsonElement quadElement) {
        if (quadElement == null || !quadElement.isJsonObject()) {
            return null;
        }
        JsonObject quad = quadElement.getAsJsonObject();
        if (!SUPPORTED_QUAD_KEYS.equals(keySetOf(quad))) {
            // 键集超出闭集（写端新增了字段）或缺键 ⇒ 不判等
            return null;
        }
        String materialIndexLiteral = integerLiteralOrNull(quad.get("materialIndex"));
        if (materialIndexLiteral == null) {
            return null;
        }
        JsonElement vertsElement = quad.get("vertices");
        if (vertsElement == null || !vertsElement.isJsonArray()) {
            return null;
        }
        JsonArray verts = vertsElement.getAsJsonArray();

        StringBuilder sb = new StringBuilder(160);
        sb.append(materialIndexLiteral)
            .append('|')
            .append(verts.size());
        for (int i = 0; i < verts.size(); i++) {
            JsonElement vElement = verts.get(i);
            if (vElement == null || !vElement.isJsonObject()) {
                return null;
            }
            JsonObject v = vElement.getAsJsonObject();
            if (!SUPPORTED_VERTEX_KEYS.equals(keySetOf(v))) {
                return null;
            }
            sb.append('{');
            for (int f = 0; f < VERTEX_FIELDS_IN_COMPARE_ORDER.length; f++) {
                String field = VERTEX_FIELDS_IN_COMPARE_ORDER[f];
                JsonElement value = v.get(field);
                String literal = INTEGER_VERTEX_FIELDS.contains(field) ? integerLiteralOrNull(value)
                    : numberLiteralOrNull(value);
                if (literal == null) {
                    return null;
                }
                sb.append(field)
                    .append('=')
                    .append(literal)
                    .append(',');
            }
            sb.append('}');
        }
        return sb.toString();
    }

    /** 对象的键集合（gson 2.2.4 没有 {@code keySet()}，只能遍历 {@code entrySet()}）。 */
    private static Set<String> keySetOf(JsonObject o) {
        Set<String> keys = new HashSet<String>();
        for (java.util.Map.Entry<String, JsonElement> e : o.entrySet()) {
            keys.add(e.getKey());
        }
        return keys;
    }

    /**
     * 整数字面量原文：必须是 JSON 数字、且原文形如 {@code -?\d+}（不含小数点/指数）。
     *
     * <p>
     * 用原文而不是 {@code getAsLong()}：后者会把 {@code 1.5} 截成 {@code 1}，于是「分数不同的两片」会被误判
     * 成同一片。非整数/非数字一律返回 {@code null}（⇒ 放行）。
     */
    private static String integerLiteralOrNull(JsonElement e) {
        String raw = numberLiteralOrNull(e);
        if (raw == null) {
            return null;
        }
        int start = raw.startsWith("-") ? 1 : 0;
        if (start >= raw.length()) {
            return null;
        }
        for (int i = start; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c < '0' || c > '9') {
                return null;
            }
        }
        return raw;
    }

    /** 数字字面量原文（任意合法 JSON 数字形态）。非数字/取不到原文 ⇒ {@code null}。 */
    private static String numberLiteralOrNull(JsonElement e) {
        if (e == null || !e.isJsonPrimitive()) {
            return null;
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        if (!p.isNumber()) {
            return null;
        }
        String raw;
        try {
            raw = p.getAsString();
        } catch (RuntimeException ex) {
            return null;
        }
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        // 原文必须真能被解析成数（畸形数值如 "1e" / "abc" 一律放行）
        try {
            Double.parseDouble(raw);
        } catch (NumberFormatException ex) {
            return null;
        }
        return raw;
    }
}
