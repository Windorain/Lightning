package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 声明式用例文件模型（{@code lightning.case/1}，见 case-file.md）。
 *
 * <p>
 * 本类只承载「已经过严格解析」的结构：字段名、类型、默认值由 {@link CaseParser} 负责，
 * 取值范围与语义由 {@link CaseValidator} 负责。原始 JSON（{@link #raw()}）保留下来作为
 * 负对照补丁（{@link Variant#mutate()}）的基座。
 *
 * <p>
 * {@link #capture()} 与 {@link #cameras()} 在 PR-1 只做「接受并透传」，不做深校验。
 */
public final class CaseFile {

    /** world 段（case-file.md §2）。 */
    public static final class World {

        private final String folder;
        private final long seed;
        private final boolean isVoid;
        private final int[] base;
        private final int settleTicks;

        World(String folder, long seed, boolean isVoid, int[] base, int settleTicks) {
            this.folder = folder;
            this.seed = seed;
            this.isVoid = isVoid;
            this.base = base;
            this.settleTicks = settleTicks;
        }

        /** 托管世界存档目录名，必须以 {@code cp_} 开头。 */
        public String folder() {
            return folder;
        }

        /** 固定种子。 */
        public long seed() {
            return seed;
        }

        /** 是否虚空世界；v1 只允许 true（C4）。 */
        public boolean isVoid() {
            return isVoid;
        }

        /** 构建基点 {@code [x,y,z]}；未声明时为 null。 */
        public int[] base() {
            return base == null ? null : base.clone();
        }

        /** 构建后静置 tick 数（默认 60）。 */
        public int settleTicks() {
            return settleTicks;
        }

        /** 规范化 JSON。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("folder", folder);
            o.addProperty("seed", seed);
            o.addProperty("void", isVoid);
            if (base != null) {
                JsonArray a = new JsonArray();
                for (int v : base) {
                    Json.add(a, Integer.valueOf(v));
                }
                o.add("base", a);
            }
            o.addProperty("settleTicks", settleTicks);
            return o;
        }
    }

    /** 场景构建步骤（case-file.md §3）；坐标已在解析期规范化为绝对坐标。 */
    public static final class Step {

        private final JsonObject json;

        Step(JsonObject json) {
            this.json = json;
        }

        /** 判别字段：{@code clear} / {@code block} / {@code te} / {@code wait}。 */
        public String op() {
            return Json.optString(json, "op", null);
        }

        /** 规范化后的步骤 JSON（相对坐标已按 world.base 解析为绝对值）。 */
        public JsonObject json() {
            return json;
        }

        /** 取坐标字段（{@code at} / {@code from} / {@code to}）；缺失返回 null。 */
        public int[] coords(String key) {
            return intArray(Json.optArray(json, key));
        }

        /** 放置/补全位置。 */
        public int[] at() {
            return coords("at");
        }

        /** 清场起点。 */
        public int[] from() {
            return coords("from");
        }

        /** 清场终点。 */
        public int[] to() {
            return coords("to");
        }

        /** {@code block} 步的方块注册名；缺失返回 null。 */
        public String blockId() {
            return Json.optString(json, "id", null);
        }

        /** {@code block} 步的 meta（默认 0）。 */
        public int meta() {
            return Json.optInt(json, "meta", 0);
        }

        /** {@code te} 步的补全器名；缺失返回 null。 */
        public String completer() {
            return Json.optString(json, "completer", null);
        }

        /** {@code te} 步的补全器参数（缺省为空对象）。 */
        public JsonObject completerParams() {
            JsonObject o = Json.optObject(json, "params");
            return o == null ? new JsonObject() : o;
        }

        /** {@code wait} 步的 tick 数。 */
        public int ticks() {
            return Json.optInt(json, "ticks", 0);
        }

        /** 规范化 JSON。 */
        public JsonObject toJson() {
            return Json.copyObject(json);
        }
    }

    /**
     * 读面步骤（v1.3，case-file.md §4.1，issue #98）：{@code read} 段的一项。
     *
     * <p>
     * 语义是「执行读面动作 → 结果 JSON 落 run 目录的 {@code path} → 登记为产物」。
     * 它是「读面输出可被判据直接引用」（需求书 §10 B2）的载体：判据段随后用
     * {@code json-field} 的 RFC 6901 指针指到这份产物上。
     */
    public static final class ReadStep {

        private final String action;
        private final JsonObject params;
        private final String path;
        private final String role;

        ReadStep(String action, JsonObject params, String path, String role) {
            this.action = action;
            this.params = params == null ? new JsonObject() : params;
            this.path = path;
            this.role = role;
        }

        /** 读面动作名（必须是已注册的 {@code read.*} 动作）。 */
        public String action() {
            return action;
        }

        /** 动作参数（原样透传；默认值由动作实现补）。 */
        public JsonObject params() {
            return Json.copyObject(params);
        }

        /** run 目录内相对路径（结果落点，也是判据的 {@code params.path}）。 */
        public String path() {
            return path;
        }

        /** 产物角色标签；未声明时为 {@code null}（运行时按动作名派生）。 */
        public String role() {
            return role;
        }

        /** {@code {action, params, path, role?}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("action", action);
            o.add("params", Json.copyObject(params));
            o.addProperty("path", path);
            if (role != null) {
                o.addProperty("role", role);
            }
            return o;
        }
    }

    /** 判据条目（case-file.md §5）。 */
    public static final class Criterion {

        private final String id;
        private final String type;
        private final JsonObject params;
        private final JsonElement expect;
        private final boolean hasExpect;

        Criterion(String id, String type, JsonObject params, JsonElement expect, boolean hasExpect) {
            this.id = id;
            this.type = type;
            this.params = params == null ? new JsonObject() : params;
            this.expect = expect;
            this.hasExpect = hasExpect;
        }

        /** 判据 id（人工可读、结论引用它）。 */
        public String id() {
            return id;
        }

        /** 判据类型，见 {@link CriteriaEngine}.TYPES。 */
        public String type() {
            return type;
        }

        /** 判据参数。 */
        public JsonObject params() {
            return params;
        }

        /** 期望值；未声明时为 null。 */
        public JsonElement expect() {
            return expect;
        }

        /** 是否声明了 expect（区分「未声明」与「声明为 null」）。 */
        public boolean hasExpect() {
            return hasExpect;
        }

        /** 规范化 JSON（原样回显，供 {@code criteria.json} 记录判据定义）。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("type", type);
            o.add("params", params);
            if (hasExpect) {
                o.add("expect", expect);
            }
            return o;
        }
    }

    /** 负对照变体（case-file.md §6）。 */
    public static final class Variant {

        private final String id;
        private final JsonArray mutate;
        private final List<String> expectCriteriaRed;

        Variant(String id, JsonArray mutate, List<String> expectCriteriaRed) {
            this.id = id;
            this.mutate = mutate == null ? new JsonArray() : mutate;
            this.expectCriteriaRed = Collections.unmodifiableList(new ArrayList<String>(expectCriteriaRed));
        }

        /** 变体 id。 */
        public String id() {
            return id;
        }

        /** 覆盖补丁（RFC 6902 子集）。 */
        public JsonArray mutate() {
            return mutate;
        }

        /** 必须变红的判据 id 列表。 */
        public List<String> expectCriteriaRed() {
            return expectCriteriaRed;
        }

        /** 把补丁应用到用例原始 JSON，返回变体后的新文档。 */
        public JsonObject applyTo(JsonObject base) {
            return applyTo(base, "variants[" + id + "].mutate");
        }

        /**
         * 把补丁应用到用例原始 JSON，字段定位前缀由调用方给出
         * （校验器用下标形式 {@code variants[0].mutate}，与其它字段错误口径一致）。
         */
        public JsonObject applyTo(JsonObject base, String fieldPrefix) {
            JsonElement mutated = JsonPatch.apply(base, mutate, fieldPrefix);
            return mutated.isJsonObject() ? mutated.getAsJsonObject() : new JsonObject();
        }

        /** 规范化 JSON。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.add("mutate", Json.copy(mutate));
            JsonArray red = new JsonArray();
            for (String s : expectCriteriaRed) {
                Json.add(red, s);
            }
            o.add("expectCriteriaRed", red);
            return o;
        }
    }

    private final JsonObject raw;
    private final String rawText;
    private final String sha256;
    private final String schema;
    private final String id;
    private final String label;
    private final World world;
    private final List<Step> build;
    private final List<ReadStep> read;
    private final JsonElement capture;
    private final JsonArray cameras;
    private final List<Criterion> criteria;
    private final List<Variant> variants;
    private final JsonArray evidenceExpect;
    private final List<String> warnings;

    CaseFile(JsonObject raw, String rawText, String schema, String id, String label, World world, List<Step> build,
        List<ReadStep> read, JsonElement capture, JsonArray cameras, List<Criterion> criteria, List<Variant> variants,
        JsonArray evidenceExpect, List<String> warnings) {
        this.raw = raw;
        this.rawText = rawText;
        this.sha256 = Hashing.sha256HexUtf8(rawText);
        this.schema = schema;
        this.id = id;
        this.label = label;
        this.world = world;
        this.build = Collections.unmodifiableList(new ArrayList<Step>(build));
        this.read = Collections.unmodifiableList(new ArrayList<ReadStep>(read));
        this.capture = capture;
        this.cameras = cameras;
        this.criteria = Collections.unmodifiableList(new ArrayList<Criterion>(criteria));
        this.variants = Collections.unmodifiableList(new ArrayList<Variant>(variants));
        this.evidenceExpect = evidenceExpect;
        this.warnings = Collections.unmodifiableList(new ArrayList<String>(warnings));
    }

    /** 原始 JSON（补丁基座；deep copy 供调用方安全修改）。 */
    public JsonObject raw() {
        return Json.copyObject(raw);
    }

    /** 原始 JSON 文本（inline 用例时为请求体里的文本，文件用例时为文件内容）。 */
    public String rawText() {
        return rawText;
    }

    /** 用例内容 sha256（observation-record.md 的 {@code caseSha256}）。 */
    public String sha256() {
        return sha256;
    }

    /** schema 标识，必须是 {@link Contract#SCHEMA_CASE}。 */
    public String schema() {
        return schema;
    }

    /** 用例 id（run 目录名组成部分）。 */
    public String id() {
        return id;
    }

    /** 展示名。 */
    public String label() {
        return label;
    }

    /** world 段。 */
    public World world() {
        return world;
    }

    /** 场景构建步骤（有序）。 */
    public List<Step> build() {
        return build;
    }

    /** 读面步骤（有序；v1.3 起）。空列表表示用例不产读面产物。 */
    public List<ReadStep> read() {
        return read;
    }

    /** capture 段原文（PR-1 透传），未声明时为 null。 */
    public JsonElement capture() {
        return capture;
    }

    /** cameras 段原文（PR-1 透传），未声明时为 null。 */
    public JsonArray cameras() {
        return cameras;
    }

    /** 判据列表。 */
    public List<Criterion> criteria() {
        return criteria;
    }

    /** 负对照变体。 */
    public List<Variant> variants() {
        return variants;
    }

    /** 期望证据清单（{@code evidence.expect}）。 */
    public JsonArray evidenceExpect() {
        return Json.copyArray(evidenceExpect);
    }

    /** 解析期产生的警告（如 capture/cameras 透传说明）。 */
    public List<String> warnings() {
        return warnings;
    }

    /** 只回显原始 JSON（不做规范化）；规范化计划见 {@link CaseValidator#plan(CaseFile)}。 */
    public JsonObject toJson() {
        return Json.copyObject(raw);
    }

    private static int[] intArray(JsonArray a) {
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            out[i] = a.get(i)
                .getAsInt();
        }
        return out;
    }
}
