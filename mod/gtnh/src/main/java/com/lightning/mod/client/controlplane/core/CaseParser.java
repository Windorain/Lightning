package com.lightning.mod.client.controlplane.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;

/**
 * 用例文件解析器（{@code lightning.case/1}，case-file.md §1/§9）。
 *
 * <p>
 * 默认<b>严格模式</b>：未知顶层字段与段内未知字段一律报错（防笔误静默），JSON 本身也用
 * {@link Json#parseStrict(String)} 严格解析（拒绝单引号、裸键名、注释、重复键、尾随垃圾）。
 * 宽松模式（{@code strict=false}）把未知字段降级为警告，供外部工具做前向兼容读取。
 *
 * <p>
 * 参数与结构的错误全部累计后一次性抛 {@code CP-VALID-002}，{@code context.fields} 逐字段说明，
 * 避免调用方来回试错。<b>取值范围</b>与<b>判据语义</b>校验在 {@link CaseValidator}。
 *
 * <p>
 * {@code capture}/{@code cameras} 段在 PR-1 只做「接受并透传」，并附一条说明性警告
 * （case-file.md §4：报「该段由契约 v1.x 提供」而非报错）。
 */
public final class CaseParser {

    /** 允许的顶层字段。 */
    public static final Set<String> TOP_LEVEL_FIELDS = unmodifiable(
        "schema",
        "id",
        "label",
        "world",
        "build",
        "read",
        "capture",
        "cameras",
        "criteria",
        "variants",
        "evidence");

    /** world 段允许的字段。 */
    public static final Set<String> WORLD_FIELDS = unmodifiable("folder", "seed", "void", "base", "settleTicks");

    /** 各 op 允许的字段。 */
    public static final Set<String> STEP_FIELDS_CLEAR = unmodifiable("op", "from", "to", "offset");

    /** 见 {@link #STEP_FIELDS_CLEAR}。 */
    public static final Set<String> STEP_FIELDS_BLOCK = unmodifiable("op", "at", "id", "meta", "offset");

    /** 见 {@link #STEP_FIELDS_CLEAR}。 */
    public static final Set<String> STEP_FIELDS_TE = unmodifiable("op", "at", "completer", "params", "offset");

    /** 见 {@link #STEP_FIELDS_CLEAR}。 */
    public static final Set<String> STEP_FIELDS_WAIT = unmodifiable("op", "ticks");

    /** 判据条目的允许字段。 */
    public static final Set<String> CRITERION_FIELDS = unmodifiable("id", "type", "params", "expect");

    /** {@code read} 段步骤的允许字段（v1.3，issue #98）。 */
    public static final Set<String> READ_STEP_FIELDS = unmodifiable("action", "params", "path", "role");

    /** 变体条目的允许字段。 */
    public static final Set<String> VARIANT_FIELDS = unmodifiable("id", "mutate", "expectCriteriaRed");

    /** evidence 段的允许字段。 */
    public static final Set<String> EVIDENCE_FIELDS = unmodifiable("expect");

    /** evidence.expect 条目的允许字段。 */
    public static final Set<String> EVIDENCE_ITEM_FIELDS = unmodifiable("path", "role");

    /** 用例 id 的合法形态。 */
    public static final String ID_PATTERN = "[a-z0-9-]+";

    /** 用例 id 与 run 目录名共用，长度上限防路径过长。 */
    public static final int MAX_ID_LENGTH = 64;

    /** 用例文件大小上限（防误喂大文件；1 MiB 足够描述任何场景）。 */
    public static final long MAX_FILE_BYTES = 1024L * 1024L;

    /** 相对坐标字面量：{@code base+[dx,dy,dz]}。 */
    private static final java.util.regex.Pattern BASE_OFFSET = java.util.regex.Pattern
        .compile("^base\\s*\\+\\s*\\[\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\]$");

    private final boolean strict;

    /** 严格模式解析器。 */
    public CaseParser() {
        this(true);
    }

    /**
     * @param strict true：未知字段报错；false：未知字段记为警告
     */
    public CaseParser(boolean strict) {
        this.strict = strict;
    }

    /** 是否严格模式。 */
    public boolean strict() {
        return strict;
    }

    /**
     * 解析用例文件文本。
     *
     * @throws CpException CP-VALID-002（逐字段错误）；CP-IO-001（读取失败，见 {@link #parseFile}）
     */
    public CaseFile parse(String text) {
        JsonElement el;
        try {
            el = Json.parseStrict(text);
        } catch (JsonSyntaxException e) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "用例文件不是合法 JSON",
                new Fields().add("<json>", e.getMessage())
                    .toContext());
        }
        if (!el.isJsonObject()) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "用例文件根节点须为对象",
                new Fields().add("<root>", "应为 object")
                    .toContext());
        }
        return parse(el.getAsJsonObject(), text == null ? "" : text);
    }

    /**
     * 解析已解析为对象的用例（inline 场景）。
     *
     * @param json    用例对象
     * @param rawText 原始文本，用于 {@code caseSha256}；为 null 时用紧凑序列化
     */
    public CaseFile parse(JsonObject json, String rawText) {
        JsonObject o = json == null ? new JsonObject() : json;
        String text = rawText == null ? Json.toJson(o) : rawText;
        Fields fields = new Fields();
        List<String> warnings = new ArrayList<String>();

        checkUnknown(o, TOP_LEVEL_FIELDS, "", fields, warnings);

        String schema = stringOf(o, "schema", "schema", fields);
        if (schema == null) {
            fields.add("schema", "必填");
        } else if (!Contract.SCHEMA_CASE.equals(schema)) {
            fields.add("schema", "须为 " + Contract.SCHEMA_CASE + "，收到 " + schema);
        }

        String id = stringOf(o, "id", "id", fields);
        if (id == null) {
            fields.add("id", "必填");
        } else if (id.length() > MAX_ID_LENGTH) {
            fields.add("id", "长度不得超过 " + MAX_ID_LENGTH);
        } else if (!id.matches(ID_PATTERN)) {
            fields.add("id", "须匹配 " + ID_PATTERN);
        }

        String label = Json.optString(o, "label", null);

        CaseFile.World world = parseWorld(o, fields, warnings);
        List<CaseFile.Step> build = parseBuild(o, world, fields, warnings);
        List<CaseFile.ReadStep> read = parseRead(o, fields, warnings);
        JsonElement capture = parseCapture(o, fields, warnings);
        JsonArray cameras = parseCameras(o, fields, warnings);
        List<CaseFile.Criterion> criteria = parseCriteria(o, fields, warnings);
        JsonArray evidence = parseEvidence(o, fields, warnings);
        List<CaseFile.Variant> variants = parseVariants(o, fields, warnings);

        if (o.has("criteria") && criteria.isEmpty()) {
            fields.add("criteria", "至少一条判据");
        }

        fields.throwIfAny("用例文件非法（" + fields.size() + " 处）");
        if (world == null) {
            // 理论上不会到达：parseWorld 已经把错误记入 fields
            throw new CpException(ErrorCodes.VALID_PARAM, "world 段缺失");
        }
        return new CaseFile(
            o,
            text,
            schema == null ? Contract.SCHEMA_CASE : schema,
            id == null ? "case" : id,
            label,
            world,
            build,
            read,
            capture,
            cameras,
            criteria,
            variants,
            evidence == null ? new JsonArray() : evidence,
            warnings);
    }

    /**
     * 读取并解析用例文件（UTF-8）。
     *
     * @throws CpException CP-IO-001 读取失败；CP-VALID-002 内容非法
     */
    public CaseFile parseFile(Path file) {
        if (file == null) {
            throw CpException.io("用例文件路径为空", null);
        }
        try {
            long size = Files.size(file);
            if (size > MAX_FILE_BYTES) {
                throw CpException.param("用例文件过大", "file", size + " 字节 > " + MAX_FILE_BYTES);
            }
            String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            return parse(text);
        } catch (IOException e) {
            throw CpException.io("读取用例文件失败: " + file, e);
        }
    }

    // ------------------------------------------------------------ 各段解析

    private CaseFile.World parseWorld(JsonObject o, Fields fields, List<String> warnings) {
        JsonObject w = Json.optObject(o, "world");
        if (w == null) {
            fields.add("world", "必填且须为 object");
            return null;
        }
        checkUnknown(w, WORLD_FIELDS, "world", fields, warnings);

        String folder = stringOf(w, "folder", "world.folder", fields);
        if (folder == null) {
            fields.add("world.folder", "必填");
        } else if (!folder.startsWith(Contract.MANAGED_WORLD_PREFIX)) {
            fields.add("world.folder", "托管世界目录须以 " + Contract.MANAGED_WORLD_PREFIX + " 开头");
        }

        Long seed = longOf(w, "seed", "world.seed", fields);
        if (seed == null) {
            fields.add("world.seed", "必填且须为整数");
        }

        boolean hasVoid = w.has("void");
        boolean isVoid = Json.optBool(w, "void", false);
        if (!hasVoid) {
            fields.add("world.void", "必填（v1 只允许 true）");
        } else if (!isVoid) {
            fields.add("world.void", "v1 只允许 true（C4：控制面只操作虚空托管世界）");
        }

        int[] base = null;
        if (w.has("base")) {
            base = coordsOf(w, "base", "world.base", null, fields, false);
        }

        int settle = Json.optInt(w, "settleTicks", 60);
        if (w.has("settleTicks") && !isIntegral(w.get("settleTicks"))) {
            fields.add("world.settleTicks", "须为整数");
        } else if (settle < 0) {
            fields.add("world.settleTicks", "不得为负");
        }

        return new CaseFile.World(folder, seed == null ? 0L : seed.longValue(), isVoid, base, settle);
    }

    private List<CaseFile.Step> parseBuild(JsonObject o, CaseFile.World world, Fields fields, List<String> warnings) {
        List<CaseFile.Step> out = new ArrayList<CaseFile.Step>();
        if (!o.has("build")) {
            return out;
        }
        JsonArray arr = Json.optArray(o, "build");
        if (arr == null) {
            fields.add("build", "须为 array");
            return out;
        }
        int[] base = world == null ? null : world.base();
        for (int i = 0; i < arr.size(); i++) {
            String ctx = "build[" + i + "]";
            JsonElement e = arr.get(i);
            if (!e.isJsonObject()) {
                fields.add(ctx, "步骤须为 object");
                continue;
            }
            JsonObject step = e.getAsJsonObject();
            String op = stringOf(step, "op", ctx + ".op", fields);
            if (op == null) {
                fields.add(ctx + ".op", "必填");
                continue;
            }
            op = op.toLowerCase(Locale.ROOT);
            switch (op) {
                case "clear":
                    checkUnknown(step, STEP_FIELDS_CLEAR, ctx, fields, warnings);
                    out.add(parseClear(step, ctx, base, fields));
                    break;
                case "block":
                    checkUnknown(step, STEP_FIELDS_BLOCK, ctx, fields, warnings);
                    out.add(parseBlock(step, ctx, base, fields));
                    break;
                case "te":
                    checkUnknown(step, STEP_FIELDS_TE, ctx, fields, warnings);
                    out.add(parseTe(step, ctx, base, fields));
                    break;
                case "wait":
                    checkUnknown(step, STEP_FIELDS_WAIT, ctx, fields, warnings);
                    out.add(parseWait(step, ctx, fields));
                    break;
                default:
                    fields.add(ctx + ".op", "未知 op: " + op + "（v1 支持 clear/block/te/wait）");
            }
        }
        return out;
    }

    private CaseFile.Step parseClear(JsonObject step, String ctx, int[] base, Fields fields) {
        JsonObject norm = new JsonObject();
        norm.addProperty("op", "clear");
        int[] from = coordsOf(step, "from", ctx + ".from", base, fields, true);
        int[] to = coordsOf(step, "to", ctx + ".to", base, fields, true);
        if (from != null) {
            norm.add("from", intArray(from));
        }
        if (to != null) {
            norm.add("to", intArray(to));
        }
        return new CaseFile.Step(norm);
    }

    private CaseFile.Step parseBlock(JsonObject step, String ctx, int[] base, Fields fields) {
        JsonObject norm = new JsonObject();
        norm.addProperty("op", "block");
        int[] at = coordsOf(step, "at", ctx + ".at", base, fields, true);
        if (at != null) {
            norm.add("at", intArray(at));
        }
        String blockId = stringOf(step, "id", ctx + ".id", fields);
        if (blockId == null) {
            fields.add(ctx + ".id", "必填");
        } else if (blockId.trim()
            .isEmpty()) {
                fields.add(ctx + ".id", "不得为空");
            } else {
                norm.addProperty("id", blockId);
            }
        if (step.has("meta") && !isIntegral(step.get("meta"))) {
            fields.add(ctx + ".meta", "须为整数");
        }
        norm.addProperty("meta", Json.optInt(step, "meta", 0));
        return new CaseFile.Step(norm);
    }

    private CaseFile.Step parseTe(JsonObject step, String ctx, int[] base, Fields fields) {
        JsonObject norm = new JsonObject();
        norm.addProperty("op", "te");
        int[] at = coordsOf(step, "at", ctx + ".at", base, fields, true);
        if (at != null) {
            norm.add("at", intArray(at));
        }
        String completer = stringOf(step, "completer", ctx + ".completer", fields);
        if (completer == null) {
            fields.add(ctx + ".completer", "必填");
        } else {
            norm.addProperty("completer", completer);
        }
        JsonObject params = Json.optObject(step, "params");
        if (step.has("params") && params == null) {
            fields.add(ctx + ".params", "须为 object");
        }
        norm.add("params", Json.copyObject(params));
        return new CaseFile.Step(norm);
    }

    private CaseFile.Step parseWait(JsonObject step, String ctx, Fields fields) {
        JsonObject norm = new JsonObject();
        norm.addProperty("op", "wait");
        if (!step.has("ticks")) {
            fields.add(ctx + ".ticks", "必填");
        } else if (!isIntegral(step.get("ticks"))) {
            fields.add(ctx + ".ticks", "须为整数");
        }
        norm.addProperty("ticks", Json.optInt(step, "ticks", 0));
        return new CaseFile.Step(norm);
    }

    /**
     * 解析 {@code capture} 段（case-file.md §4）。
     *
     * <p>
     * PR-2 起本段是<b>真实执行段</b>的参数（捕获会话默认值）：未知字段照旧报错（§9），
     * 类型与取值范围由 {@link CaseValidator#validateCapture} 用 {@link CaptureSpec} 校验；
     * 这里只做「须为 object + 未知字段」这一层。
     *
     * @return 规范化后的对象；未声明返回 null
     */
    private JsonObject parseCapture(JsonObject o, Fields fields, List<String> warnings) {
        JsonElement capture = Json.get(o, "capture");
        if (capture == null) {
            return null;
        }
        if (!capture.isJsonObject()) {
            fields.add("capture", "须为 object {lighting?,renderMode?,worldTime?}");
            return null;
        }
        JsonObject obj = capture.getAsJsonObject();
        checkUnknown(obj, CaptureSpec.FIELDS, "capture", fields, warnings);
        return Json.copyObject(obj);
    }

    /**
     * 解析 {@code cameras} 段（机位表，contract.md §4.1）。
     *
     * <p>
     * 这里只做「须为 array」与元素「须为 object」；字段级校验（机位名唯一、pos 有限值、
     * 投影二选一、resolution 正整数、tile 1..8、overlap 0..0.5）统一由 {@link CaseValidator}
     * 走 {@link CameraSpecs} 完成——避免解析期与校验期两套规则。
     *
     * @return 原样深拷的机位数组；未声明返回 null
     */
    private JsonArray parseCameras(JsonObject o, Fields fields, List<String> warnings) {
        JsonArray cameras = Json.optArray(o, "cameras");
        if (cameras == null) {
            if (o.has("cameras")) {
                fields.add("cameras", "须为 array（机位表 [CameraSpec]）");
            }
            return null;
        }
        for (int i = 0; i < cameras.size(); i++) {
            JsonElement e = cameras.get(i);
            if (e == null || !e.isJsonObject()) {
                fields.add("cameras[" + i + "]", "机位须为 object（CameraSpec，见 contract.md §4.1）");
            }
        }
        return Json.copyArray(cameras);
    }

    /**
     * 解析 {@code read} 段（v1.3，issue #98）：读面步骤清单。
     *
     * <p>
     * 每步 {@code {action:"read.blocks", params:{…}, path:"read/blocks.json", role?}}：
     * 执行该读面动作，把结果 JSON 落 run 目录的 {@code path} 并登记为产物。
     * 「读面输出可被判据直接引用」（需求书 §10 B2）的物质基础就是这一段——
     * 没有它，读面只能由调用方在用例之外单独调，判据永远看不到读数。
     *
     * <p>
     * 这里只做「须为 array + 元素须为 object + 未知字段」，字段级校验（动作名必须已注册且是
     * {@code read.*}、path 合法且不与既有产物冲突）在 {@link CaseValidator}。
     *
     * @return 原样深拷的读面步骤；未声明返回空列表（不是 null：调用方按「段为空」处理）
     */
    private List<CaseFile.ReadStep> parseRead(JsonObject o, Fields fields, List<String> warnings) {
        List<CaseFile.ReadStep> out = new ArrayList<CaseFile.ReadStep>();
        if (!o.has("read")) {
            return out;
        }
        JsonArray arr = Json.optArray(o, "read");
        if (arr == null) {
            fields.add("read", "须为 array（读面步骤 [{action,params?,path,role?}]）");
            return out;
        }
        for (int i = 0; i < arr.size(); i++) {
            String ctx = "read[" + i + "]";
            JsonElement e = arr.get(i);
            if (e == null || !e.isJsonObject()) {
                fields.add(ctx, "步骤须为 object {action,params?,path,role?}");
                continue;
            }
            JsonObject step = e.getAsJsonObject();
            checkUnknown(step, READ_STEP_FIELDS, ctx, fields, warnings);
            String action = stringOf(step, "action", ctx + ".action", fields);
            if (action == null) {
                fields.add(ctx + ".action", "必填（读面动作名，如 read.blocks）");
            }
            String path = stringOf(step, "path", ctx + ".path", fields);
            if (path == null) {
                fields.add(ctx + ".path", "必填（run 目录内相对路径，如 read/blocks.json）");
            }
            JsonObject params = Json.optObject(step, "params");
            if (step.has("params") && params == null) {
                fields.add(ctx + ".params", "须为 object");
            }
            String role = stringOf(step, "role", ctx + ".role", fields);
            out.add(
                new CaseFile.ReadStep(action, params == null ? new JsonObject() : Json.copyObject(params), path, role));
        }
        return out;
    }

    private List<CaseFile.Criterion> parseCriteria(JsonObject o, Fields fields, List<String> warnings) {
        List<CaseFile.Criterion> out = new ArrayList<CaseFile.Criterion>();
        if (!o.has("criteria")) {
            fields.add("criteria", "必填");
            return out;
        }
        JsonArray arr = Json.optArray(o, "criteria");
        if (arr == null) {
            fields.add("criteria", "须为 array");
            return out;
        }
        Set<String> seen = new HashSet<String>();
        for (int i = 0; i < arr.size(); i++) {
            String ctx = "criteria[" + i + "]";
            JsonElement e = arr.get(i);
            if (!e.isJsonObject()) {
                fields.add(ctx, "判据须为 object");
                continue;
            }
            JsonObject c = e.getAsJsonObject();
            checkUnknown(c, CRITERION_FIELDS, ctx, fields, warnings);
            String cid = stringOf(c, "id", ctx + ".id", fields);
            if (cid == null) {
                fields.add(ctx + ".id", "必填");
            } else if (!seen.add(cid)) {
                fields.add(ctx + ".id", "判据 id 重复: " + cid);
            }
            String type = stringOf(c, "type", ctx + ".type", fields);
            if (type == null) {
                fields.add(ctx + ".type", "必填");
            } else if (!CriteriaEngine.isKnownType(type)) {
                fields.add(ctx + ".type", "未知判据类型: " + type + "（v1 支持 " + CriteriaEngine.TYPES + "）");
            }
            JsonObject params = Json.optObject(c, "params");
            if (c.has("params") && params == null) {
                fields.add(ctx + ".params", "须为 object");
            }
            boolean hasExpect = c.has("expect");
            out.add(
                new CaseFile.Criterion(
                    cid == null ? "criterion-" + i : cid,
                    type,
                    params,
                    hasExpect ? Json.copy(c.get("expect")) : null,
                    hasExpect));
        }
        return out;
    }

    private JsonArray parseEvidence(JsonObject o, Fields fields, List<String> warnings) {
        if (!o.has("evidence")) {
            fields.add("evidence", "必填");
            return new JsonArray();
        }
        JsonObject ev = Json.optObject(o, "evidence");
        if (ev == null) {
            fields.add("evidence", "须为 object");
            return new JsonArray();
        }
        checkUnknown(ev, EVIDENCE_FIELDS, "evidence", fields, warnings);
        JsonArray expect = Json.optArray(ev, "expect");
        if (expect == null) {
            fields.add("evidence.expect", "必填且须为 array");
            return new JsonArray();
        }
        if (expect.size() == 0) {
            warnings.add("evidence.expect 为空：运行时不会产生 evidence-complete 判据");
        }
        JsonArray out = new JsonArray();
        for (int i = 0; i < expect.size(); i++) {
            String ctx = "evidence.expect[" + i + "]";
            JsonElement e = expect.get(i);
            if (!e.isJsonObject()) {
                fields.add(ctx, "条目须为 object");
                continue;
            }
            JsonObject item = e.getAsJsonObject();
            checkUnknown(item, EVIDENCE_ITEM_FIELDS, ctx, fields, warnings);
            String path = stringOf(item, "path", ctx + ".path", fields);
            if (path == null) {
                fields.add(ctx + ".path", "必填");
            }
            out.add(Json.copyObject(item));
        }
        return out;
    }

    private List<CaseFile.Variant> parseVariants(JsonObject o, Fields fields, List<String> warnings) {
        List<CaseFile.Variant> out = new ArrayList<CaseFile.Variant>();
        if (!o.has("variants")) {
            return out;
        }
        JsonArray arr = Json.optArray(o, "variants");
        if (arr == null) {
            fields.add("variants", "须为 array");
            return out;
        }
        Set<String> seen = new HashSet<String>();
        for (int i = 0; i < arr.size(); i++) {
            String ctx = "variants[" + i + "]";
            JsonElement e = arr.get(i);
            if (!e.isJsonObject()) {
                fields.add(ctx, "变体须为 object");
                continue;
            }
            JsonObject v = e.getAsJsonObject();
            checkUnknown(v, VARIANT_FIELDS, ctx, fields, warnings);
            String vid = stringOf(v, "id", ctx + ".id", fields);
            if (vid == null) {
                fields.add(ctx + ".id", "必填");
            } else if (!seen.add(vid)) {
                fields.add(ctx + ".id", "变体 id 重复: " + vid);
            }
            JsonArray mutate = Json.optArray(v, "mutate");
            if (v.has("mutate") && mutate == null) {
                fields.add(ctx + ".mutate", "须为 array");
            }
            if (mutate == null) {
                fields.add(ctx + ".mutate", "必填");
            }
            JsonArray red = Json.optArray(v, "expectCriteriaRed");
            if (v.has("expectCriteriaRed") && red == null) {
                fields.add(ctx + ".expectCriteriaRed", "须为 array");
            }
            List<String> redIds = new ArrayList<String>();
            if (red != null) {
                if (red.size() == 0) {
                    fields.add(ctx + ".expectCriteriaRed", "至少列一条必须变红的判据（否则负对照无意义）");
                }
                for (int k = 0; k < red.size(); k++) {
                    JsonElement r = red.get(k);
                    if (!r.isJsonPrimitive() || !r.getAsJsonPrimitive()
                        .isString()) {
                        fields.add(ctx + ".expectCriteriaRed[" + k + "]", "须为字符串");
                        continue;
                    }
                    redIds.add(r.getAsString());
                }
            } else {
                fields.add(ctx + ".expectCriteriaRed", "必填");
            }
            out.add(new CaseFile.Variant(vid == null ? "variant-" + i : vid, mutate, redIds));
        }
        return out;
    }

    // ------------------------------------------------------------ 小工具

    private void checkUnknown(JsonObject o, Set<String> allowed, String prefix, Fields fields, List<String> warnings) {
        // JsonObject.keySet() 是 gson 2.8+ API，运行期 2.2.4 没有：走 Json.keys(entrySet)
        for (String key : Json.keys(o)) {
            if (allowed.contains(key)) {
                continue;
            }
            String field = prefix.isEmpty() ? key : prefix + "." + key;
            if (strict) {
                fields.add(field, "未知字段（严格模式）");
            } else {
                warnings.add("未知字段已忽略: " + field);
            }
        }
    }

    private static String stringOf(JsonObject o, String key, String field, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            fields.add(field, "须为 string");
            return null;
        }
        return e.getAsString();
    }

    private static Long longOf(JsonObject o, String key, String field, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            return null;
        }
        if (!isIntegral(e)) {
            fields.add(field, "须为整数");
            return null;
        }
        try {
            return Long.valueOf(e.getAsLong());
        } catch (RuntimeException ex) {
            fields.add(field, "超出 64 位整数范围");
            return null;
        }
    }

    private static boolean isIntegral(JsonElement e) {
        if (e == null || !e.isJsonPrimitive()
            || !e.getAsJsonPrimitive()
                .isNumber()) {
            return false;
        }
        String s = e.getAsString();
        return s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0;
    }

    /**
     * 解析坐标字段。
     *
     * <p>
     * 三种写法：绝对 {@code [x,y,z]}；{@code "@base"} + 同步骤 {@code offset:[dx,dy,dz]}；
     * 字面量 {@code "base+[dx,dy,dz]"}。解析结果一律是绝对坐标（case-file.md §3）。
     */
    private int[] coordsOf(JsonObject host, String key, String field, int[] base, Fields fields,
        boolean allowRelative) {
        JsonElement e = Json.get(host, key);
        if (e == null) {
            fields.add(field, "必填");
            return null;
        }
        if (e.isJsonArray()) {
            return int3(e.getAsJsonArray(), field, fields);
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            fields.add(field, "须为 [x,y,z] 或 \"@base\"/\"base+[dx,dy,dz]\" 写法");
            return null;
        }
        String s = e.getAsString()
            .trim();
        if (!allowRelative) {
            fields.add(field, "此处只接受绝对坐标 [x,y,z]");
            return null;
        }
        int[] off;
        if ("@base".equals(s)) {
            JsonArray offset = Json.optArray(host, "offset");
            if (offset == null) {
                fields.add(field + ".offset", "\"@base\" 必须配 offset:[dx,dy,dz]");
                return null;
            }
            off = int3(offset, field + ".offset", fields);
            if (off == null) {
                return null;
            }
        } else {
            java.util.regex.Matcher m = BASE_OFFSET.matcher(s);
            if (!m.matches()) {
                fields.add(field, "坐标写法非法: " + s);
                return null;
            }
            off = new int[] { Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)),
                Integer.parseInt(m.group(3)) };
        }
        if (base == null) {
            fields.add(field, "使用相对坐标但 world.base 未声明");
            return null;
        }
        return new int[] { base[0] + off[0], base[1] + off[1], base[2] + off[2] };
    }

    private static int[] int3(JsonArray a, String field, Fields fields) {
        if (a.size() != 3) {
            fields.add(field, "须为 3 个整数，收到 " + a.size() + " 个");
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement e = a.get(i);
            if (!isIntegral(e)) {
                fields.add(field + "[" + i + "]", "须为整数");
                return null;
            }
            out[i] = e.getAsInt();
        }
        return out;
    }

    private static JsonArray intArray(int[] v) {
        JsonArray a = new JsonArray();
        for (int x : v) {
            Json.add(a, Integer.valueOf(x));
        }
        return a;
    }

    private static Set<String> unmodifiable(String... names) {
        return java.util.Collections.unmodifiableSet(new HashSet<String>(Arrays.asList(names)));
    }

    /** 供外部工具读取 {@code criteria} 类型表（转发 {@link CriteriaEngine}）。 */
    public static JsonArray criterionTypesJson() {
        JsonArray arr = new JsonArray();
        for (String t : CriteriaEngine.TYPES) {
            arr.add(new JsonPrimitive(t));
        }
        return arr;
    }
}
