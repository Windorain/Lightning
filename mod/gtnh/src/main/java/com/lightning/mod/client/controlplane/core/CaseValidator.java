package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 用例校验器：产出「规范化执行计划」（case-file.md §9 的 {@code case.validate} 数据源）。
 *
 * <p>
 * 分工：{@link CaseParser} 负责「字段名/类型/未知字段」，本类负责「取值范围、判据参数完备性、
 * 证据清单与负对照补丁的可执行性」。所有问题累计后一次性抛 {@code CP-VALID-002}
 * （{@code context.fields} 逐字段说明）。
 *
 * <p>
 * 规范化点是运行器的<b>唯一输入</b>：坐标已展开为绝对坐标、默认值已补齐（{@code settleTicks=60}、
 * {@code meta=0}、{@code minBytes=1}、{@code minCount=1}），因此交互路径与无人值守路径不会因为
 * 「谁负责填默认值」而产生偏差。
 */
public final class CaseValidator {

    /**
     * 变体补丁适用性判定模式（{@link #plan(CaseFile, VariantCheck)}）。
     *
     * <h2>为什么需要两种模式</h2>
     * 「补丁必须改变用例内容」这条判定只在<b>原始</b>用例文件上成立：空转的负对照会制造恒绿假断言，
     * 必须拦住。但变体执行路径（{@code case.run} 的 {@code variant} 参数与整跑后的变体扫描）会
     * <b>先</b>把补丁应用到用例上，再拿<b>产物文档</b>过一遍校验——在那份文档上补丁本来就是幂等的，
     * 再应用一次必然「什么都没改」。同一判定用在这里就是误报（实测：冒烟 A8 的负对照
     * {@code neg-manifest-missing} 被判成「补丁未改变用例内容」，变体评估整段被跳过，A8 假红）。
     * 原始文件的那一遍校验由 {@code CaseSources.resolve} 用 {@link #ENFORCE} 完成，因此产物文档
     * 这一遍用 {@link #SKIP} 是安全的。
     */
    public enum VariantCheck {

        /** 补丁必须改变用例内容（空转即 CP-VALID-002）；用于<b>原始</b>用例文件。 */
        ENFORCE,
        /** 不判定适用性：文档本身已是补丁产物；用于变体执行路径的二次校验。 */
        SKIP
    }

    /** 1.7.10 世界高度范围。 */
    public static final int MIN_Y = 0;

    /** 见 {@link #MIN_Y}。 */
    public static final int MAX_Y = 255;

    /** 水平坐标绝对值上限（与原版世界边界一致）。 */
    public static final int MAX_HORIZONTAL = 30000000;

    /** 1.7.10 方块 meta 取值上限。 */
    public static final int MAX_META = 15;

    /**
     * 用例执行段（case-file.md §8；段序即执行序）。
     *
     * <p>
     * PR-2 起 {@code capture}/{@code cameras} 不再是「延后段」，而是真实执行段：{@code capture}
     * 段建立捕获会话（{@code capture.begin}），{@code cameras} 段逐机位拍摄，证据段收尾时释放。
     * 因此在 {@code build} 之后、{@code criteria} 之前插入两段——{@code world→capture→build} 的
     * 契约口径是「capture 段包住 build 之后的区间」，而会话标志对开场作业自身放行，故把 capture
     * 排在 build 之前即可同时满足「build 在会话内」与「build 写出世界后立刻受保护」。
     */
    public static final List<String> SEGMENTS;

    static {
        List<String> s = new ArrayList<String>();
        s.add("world");
        s.add("capture");
        s.add("build");
        s.add("cameras");
        s.add("criteria");
        s.add("evidence");
        SEGMENTS = java.util.Collections.unmodifiableList(s);
    }

    /** 解析并校验，返回规范化计划。 */
    public static JsonObject validate(String text) {
        CaseFile file = new CaseParser().parse(text);
        return new CaseValidator().plan(file);
    }

    /**
     * 产出规范化执行计划。
     *
     * @throws CpException CP-VALID-002：存在逐字段问题
     */
    public JsonObject plan(CaseFile file) {
        return plan(file, VariantCheck.ENFORCE);
    }

    /**
     * 产出规范化执行计划。
     *
     * @param variantCheck 变体补丁适用性判定模式；文档本身已是补丁产物时用
     *                     {@link VariantCheck#SKIP}（见该枚举的说明）
     * @throws CpException CP-VALID-002：存在逐字段问题
     */
    public JsonObject plan(CaseFile file, VariantCheck variantCheck) {
        VariantCheck check = variantCheck == null ? VariantCheck.ENFORCE : variantCheck;
        Fields fields = new Fields();
        List<String> warnings = new ArrayList<String>(file.warnings());

        JsonObject world = validateWorld(file, fields);
        JsonArray build = validateBuild(file, fields, warnings);
        JsonObject capture = validateCapture(file, fields);
        JsonArray cameras = validateCameras(file, fields, warnings);
        JsonArray criteria = validateCriteria(file, fields);
        JsonArray evidence = validateEvidence(file, fields);
        JsonArray variants = validateVariants(file, criteria, fields, check);
        if (build.size() == 0) {
            warnings.add("build 段为空：世界将只有种子与虚空地形");
        }
        if (cameras != null && cameras.size() > 0) {
            // case-file.md §4：含 cameras 段的用例必须 forensic 调用（运行期升格检查，见 CaseRunAction）
            warnings.add("cameras 段非空：case.run 需 forensic 级 token（运行期按内容升格校验，CP-AUTH-002）");
        }

        fields.throwIfAny("用例执行计划非法（" + fields.size() + " 处）");

        JsonObject plan = new JsonObject();
        plan.addProperty("schema", Contract.SCHEMA_CASE);
        plan.addProperty("id", file.id());
        if (file.label() != null) {
            plan.addProperty("label", file.label());
        }
        plan.addProperty("caseSha256", file.sha256());
        plan.add("world", world);
        JsonArray segments = new JsonArray();
        for (String s : SEGMENTS) {
            Json.add(segments, s);
        }
        plan.add("segments", segments);
        plan.add("build", build);
        if (capture != null) {
            plan.add("capture", capture);
        }
        if (cameras != null) {
            plan.add("cameras", cameras);
        }
        plan.add("criteria", criteria);
        plan.add("variants", variants);
        JsonObject ev = new JsonObject();
        ev.add("expect", evidence);
        plan.add("evidence", ev);
        JsonArray warnArr = new JsonArray();
        for (String w : warnings) {
            Json.add(warnArr, w);
        }
        plan.add("warnings", warnArr);
        return plan;
    }

    // ------------------------------------------------------------ 各段

    private JsonObject validateWorld(CaseFile file, Fields fields) {
        CaseFile.World w = file.world();
        JsonObject out = w.toJson();
        int[] base = w.base();
        if (base != null) {
            checkCoords(base, "world.base", fields);
        }
        return out;
    }

    private JsonArray validateBuild(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray out = new JsonArray();
        List<CaseFile.Step> steps = file.build();
        for (int i = 0; i < steps.size(); i++) {
            CaseFile.Step step = steps.get(i);
            String ctx = "build[" + i + "]";
            String op = step.op();
            JsonObject json = step.json();
            if (op == null) {
                fields.add(ctx + ".op", "缺失");
                continue;
            }
            switch (op) {
                case "clear": {
                    int[] from = step.from();
                    int[] to = step.to();
                    if (from == null) {
                        fields.add(ctx + ".from", "缺失或非法");
                    } else {
                        checkCoords(from, ctx + ".from", fields);
                    }
                    if (to == null) {
                        fields.add(ctx + ".to", "缺失或非法");
                    } else {
                        checkCoords(to, ctx + ".to", fields);
                    }
                    if (from != null && to != null) {
                        for (int k = 0; k < 3; k++) {
                            if (from[k] > to[k]) {
                                fields.add(ctx, "清场范围非法：第 " + k + " 轴 from " + from[k] + " > to " + to[k]);
                                break;
                            }
                        }
                    }
                    break;
                }
                case "block": {
                    int[] at = step.at();
                    if (at == null) {
                        fields.add(ctx + ".at", "缺失或非法");
                    } else {
                        checkCoords(at, ctx + ".at", fields);
                    }
                    String blockId = step.blockId();
                    if (blockId != null && blockId.indexOf(':') < 0) {
                        warnings.add(ctx + ".id 未带命名空间（" + blockId + "），按 minecraft: 前缀处理");
                    }
                    int meta = step.meta();
                    if (meta < 0 || meta > MAX_META) {
                        fields.add(ctx + ".meta", "须在 0.." + MAX_META + "，收到 " + meta);
                    }
                    break;
                }
                case "te": {
                    int[] at = step.at();
                    if (at == null) {
                        fields.add(ctx + ".at", "缺失或非法");
                    } else {
                        checkCoords(at, ctx + ".at", fields);
                    }
                    String completer = step.completer();
                    if (completer == null || completer.trim()
                        .isEmpty()) {
                        fields.add(ctx + ".completer", "缺失或为空");
                    }
                    break;
                }
                case "wait": {
                    int ticks = step.ticks();
                    if (ticks < 0) {
                        fields.add(ctx + ".ticks", "不得为负");
                    }
                    break;
                }
                default:
                    fields.add(ctx + ".op", "未知 op: " + op);
            }
            JsonObject item = Json.copyObject(json);
            item.addProperty("index", i);
            out.add(item);
        }
        return out;
    }

    private JsonArray validateCriteria(CaseFile file, Fields fields) {
        JsonArray out = new JsonArray();
        List<CaseFile.Criterion> criteria = file.criteria();
        for (int i = 0; i < criteria.size(); i++) {
            CaseFile.Criterion c = criteria.get(i);
            String ctx = "criteria[" + i + "]";
            JsonObject params = Json.copyObject(c.params());
            String type = c.type();
            if (type == null) {
                fields.add(ctx + ".type", "缺失");
                continue;
            }
            switch (type) {
                case CriteriaEngine.TYPE_ARTIFACT_EXISTS:
                    requirePathParam(params, ctx, fields);
                    break;
                case CriteriaEngine.TYPE_ARTIFACT_NONEMPTY: {
                    requirePathParam(params, ctx, fields);
                    if (params.has("minBytes")) {
                        JsonElement mb = params.get("minBytes");
                        if (!mb.isJsonPrimitive() || !mb.getAsJsonPrimitive()
                            .isNumber()) {
                            fields.add(ctx + ".params.minBytes", "须为整数");
                        } else if (mb.getAsLong() < 0) {
                            fields.add(ctx + ".params.minBytes", "不得为负");
                        }
                    } else {
                        params.addProperty("minBytes", 1);
                    }
                    break;
                }
                case CriteriaEngine.TYPE_JSON_FIELD: {
                    requirePathParam(params, ctx, fields);
                    String pointer = Json.optString(params, "pointer", null);
                    if (pointer == null) {
                        fields.add(ctx + ".params.pointer", "必填（RFC 6901 指针，如 /a/b/0）");
                    } else if (!pointer.isEmpty() && !pointer.startsWith("/")) {
                        fields.add(ctx + ".params.pointer", "指针须以 / 开头或为空串");
                    }
                    if (!c.hasExpect()) {
                        fields.add(ctx + ".expect", "json-field 必填");
                    }
                    break;
                }
                case CriteriaEngine.TYPE_WORLD_HASH_EQUALS:
                    break;
                case CriteriaEngine.TYPE_EVENT_EMITTED: {
                    String kind = Json.optString(params, "kind", null);
                    if (kind == null || kind.trim()
                        .isEmpty()) {
                        fields.add(ctx + ".params.kind", "必填");
                    }
                    if (params.has("minCount")) {
                        JsonElement mc = params.get("minCount");
                        if (!mc.isJsonPrimitive() || !mc.getAsJsonPrimitive()
                            .isNumber()) {
                            fields.add(ctx + ".params.minCount", "须为整数");
                        } else if (mc.getAsLong() < 0) {
                            fields.add(ctx + ".params.minCount", "不得为负");
                        }
                    } else {
                        params.addProperty("minCount", 1);
                    }
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_SIZE_EQUALS: {
                    requirePathParam(params, ctx, fields);
                    requirePositiveInt(params, "width", ctx, fields);
                    requirePositiveInt(params, "height", ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_NOT_UNIFORM: {
                    requirePathParam(params, ctx, fields);
                    requireRatio(params, "maxSameColorRatio", ImageCriteria.DEFAULT_MAX_SAME_COLOR_RATIO, ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_UNIFORM: {
                    requirePathParam(params, ctx, fields);
                    requireRatio(params, "minSameColorRatio", ImageCriteria.DEFAULT_MIN_SAME_COLOR_RATIO, ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_TE_STATE_EQUALS: {
                    // 运行期轨判据：at/key/expect 三者缺一不可（求值在 mc 侧，见 CaseRunAction 的注入）
                    int[] at = ints(params, "at");
                    if (at == null) {
                        fields.add(ctx + ".params.at", "必填，且须为 [x,y,z] 三个整数（绝对坐标）");
                    } else {
                        checkCoords(at, ctx + ".params.at", fields);
                    }
                    String key = Json.optString(params, "key", null);
                    if (key == null) {
                        fields.add(ctx + ".params.key", "必填（RFC 6901 指针，指向 TE 描述器输出，如 /connections/UP）");
                    } else if (!key.isEmpty() && !key.startsWith("/")) {
                        fields.add(ctx + ".params.key", "指针须以 / 开头或为空串");
                    }
                    if (!c.hasExpect()) {
                        fields.add(ctx + ".expect", "te-state-equals 必填");
                    }
                    break;
                }
                default:
                    fields.add(ctx + ".type", "未知判据类型: " + type);
            }
            JsonObject item = new JsonObject();
            item.addProperty("id", c.id());
            item.addProperty("type", type);
            item.add("params", params);
            if (c.hasExpect()) {
                item.add("expect", c.expect());
            }
            out.add(item);
        }
        return out;
    }

    /**
     * {@code capture} 段（case-file.md §4）：会话默认光照/渲染模式与拍摄时刻。
     *
     * @return 规范化后的 capture 对象；文档未声明该段或声明为 null 时返回 null
     */
    private JsonObject validateCapture(CaseFile file, Fields fields) {
        JsonElement raw = file.capture();
        if (raw == null || raw.isJsonNull()) {
            return null;
        }
        if (!raw.isJsonObject()) {
            fields.add("capture", "须为 object {lighting?,renderMode?,worldTime?}");
            return null;
        }
        JsonObject capture = raw.getAsJsonObject();
        CaptureSpec spec = CaptureSpec.parse(capture, "capture", fields);
        return spec == null ? null : spec.toJson();
    }

    /**
     * {@code cameras} 段（contract.md §4.1）：机位表的解析与范围校验。
     *
     * <p>
     * 与 {@code shot.multi} 执行期用的是 {@link CameraSpecs} 的同一份判定——校验器只是把
     * 字段错误并进本次累计，不另写一套规则。
     *
     * @return 规范化后的机位数组；未声明返回 null
     */
    private JsonArray validateCameras(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray raw = file.cameras();
        if (raw == null) {
            return null;
        }
        CameraSpecs.Parsed parsed = CameraSpecs.parseArray(raw, "cameras");
        merge(fields, parsed.fields());
        if (parsed.specs()
            .isEmpty()) {
            warnings.add("cameras 段为空数组：本 run 不产截图");
        }
        return CameraSpecs.toJson(parsed.specs());
    }

    /** 把子解析器累计的字段错误并进本次累计。 */
    static void merge(Fields target, Fields from) {
        if (from == null || from.isEmpty()) {
            return;
        }
        for (JsonElement e : from.toJson()) {
            if (e != null && e.isJsonObject()) {
                JsonObject o = e.getAsJsonObject();
                target.add(Json.optString(o, "field", "?"), Json.optString(o, "reason", "?"));
            }
        }
    }

    private JsonArray validateEvidence(CaseFile file, Fields fields) {
        JsonArray src = file.evidenceExpect();
        JsonArray out = new JsonArray();
        Set<String> seen = new LinkedHashSet<String>();
        for (int i = 0; i < src.size(); i++) {
            String ctx = "evidence.expect[" + i + "]";
            JsonElement e = src.get(i);
            if (e == null || !e.isJsonObject()) {
                fields.add(ctx, "条目须为 object");
                continue;
            }
            JsonObject item = e.getAsJsonObject();
            String path = Json.optString(item, "path", null);
            if (path == null || path.trim()
                .isEmpty()) {
                fields.add(ctx + ".path", "必填");
                continue;
            }
            checkRelPath(path, ctx + ".path", fields);
            if (!seen.add(path)) {
                fields.add(ctx + ".path", "重复的证据路径: " + path);
            }
            out.add(Json.copyObject(item));
        }
        return out;
    }

    private JsonArray validateVariants(CaseFile file, JsonArray criteria, Fields fields, VariantCheck check) {
        JsonArray out = new JsonArray();
        Set<String> criteriaIds = new LinkedHashSet<String>();
        for (int i = 0; i < criteria.size(); i++) {
            criteriaIds.add(
                Json.optString(
                    criteria.get(i)
                        .getAsJsonObject(),
                    "id",
                    ""));
        }
        JsonObject raw = file.raw();
        List<CaseFile.Variant> variants = file.variants();
        for (int i = 0; i < variants.size(); i++) {
            CaseFile.Variant v = variants.get(i);
            String ctx = "variants[" + i + "]";
            JsonObject mutated = null;
            try {
                mutated = v.applyTo(raw, ctx + ".mutate");
            } catch (CpException e) {
                // SKIP 模式下补丁报错不算问题：文档已是补丁产物，remove/replace 这类补丁再应用
                // 必然撞「目标不存在」，而原始文件那一遍（ENFORCE）已经判过它的可执行性。
                if (check != VariantCheck.SKIP) {
                    JsonElement fs = e.context() == null ? null
                        : e.context()
                            .get("fields");
                    if (fs != null && fs.isJsonArray()) {
                        for (JsonElement fe : fs.getAsJsonArray()) {
                            if (fe.isJsonObject()) {
                                fields.add(
                                    Json.optString(fe.getAsJsonObject(), "field", ctx + ".mutate"),
                                    Json.optString(fe.getAsJsonObject(), "reason", "补丁非法"));
                            }
                        }
                    } else {
                        fields.add(ctx + ".mutate", e.detail());
                    }
                }
            }
            if (check == VariantCheck.ENFORCE && mutated != null && mutated.equals(raw)) {
                fields.add(ctx + ".mutate", "补丁未改变用例内容（负对照将是空的）");
            }
            for (String id : v.expectCriteriaRed()) {
                if (!criteriaIds.contains(id)) {
                    fields.add(ctx + ".expectCriteriaRed", "未知判据 id: " + id);
                }
            }
            JsonObject item = new JsonObject();
            item.addProperty("id", v.id());
            item.add("mutate", Json.copy(v.mutate()));
            JsonArray red = new JsonArray();
            for (String id : v.expectCriteriaRed()) {
                Json.add(red, id);
            }
            item.add("expectCriteriaRed", red);
            item.addProperty("appliedSha256", mutated == null ? null : Hashing.sha256HexUtf8(Json.toJson(mutated)));
            item.addProperty("applicable", mutated != null);
            out.add(item);
        }
        return out;
    }

    // ------------------------------------------------------------ 工具

    private static void requirePathParam(JsonObject params, String ctx, Fields fields) {
        String path = Json.optString(params, "path", null);
        if (path == null || path.trim()
            .isEmpty()) {
            fields.add(ctx + ".params.path", "必填");
            return;
        }
        checkRelPath(path, ctx + ".params.path", fields);
    }

    /** 正整数参数（图像尺寸类判据用）；缺失或非法均记错。 */
    private static void requirePositiveInt(JsonObject params, String key, String ctx, Fields fields) {
        String field = ctx + ".params." + key;
        if (!params.has(key)) {
            fields.add(field, "必填（正整数像素）");
            return;
        }
        JsonElement e = params.get(key);
        if (!CameraSpec.isIntegral(e) || !CameraSpec.isFinite(e)) {
            fields.add(field, "须为整数");
            return;
        }
        if (e.getAsLong() <= 0L) {
            fields.add(field, "须为正整数，收到 " + e.getAsLong());
        }
    }

    /**
     * 0..1 图像阈值参数（图像纯色类判据用）：缺失补默认值，非法记错。
     *
     * <p>
     * 判定复用 {@link ImageCriteria#ratioError}——校验期与求值期必须是同一套规则，否则会出现
     * 「计划校验通过、运行期判 error」的错位。
     */
    private static void requireRatio(JsonObject params, String key, double def, String ctx, Fields fields) {
        if (!params.has(key)) {
            params.addProperty(key, def);
            return;
        }
        String err = ImageCriteria.ratioError(params, key);
        if (err != null) {
            fields.add(ctx + ".params." + key, err.replace("params." + key + " ", ""));
        }
    }

    /** 取 {@code [x,y,z]} 整数三元组；缺失或非法返回 null。 */
    private static int[] ints(JsonObject o, String key) {
        JsonArray a = Json.optArray(o, key);
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement e = a.get(i);
            if (e == null || !e.isJsonPrimitive() || !CameraSpec.isIntegral(e) || !CameraSpec.isFinite(e)) {
                return null;
            }
            out[i] = e.getAsInt();
        }
        return out;
    }

    private static void checkRelPath(String path, String field, Fields fields) {
        try {
            ArtifactStore.resolveInRun(java.nio.file.Paths.get("."), path);
        } catch (CpException e) {
            JsonElement fs = e.context() == null ? null
                : e.context()
                    .get("fields");
            String reason = e.detail();
            if (fs != null && fs.isJsonArray()
                && fs.getAsJsonArray()
                    .size() > 0) {
                reason = Json.optString(
                    fs.getAsJsonArray()
                        .get(0)
                        .getAsJsonObject(),
                    "reason",
                    reason);
            }
            fields.add(field, reason);
        }
    }

    private static void checkCoords(int[] v, String field, Fields fields) {
        if (v[1] < MIN_Y || v[1] > MAX_Y) {
            fields.add(field, "y 须在 " + MIN_Y + ".." + MAX_Y + "，收到 " + v[1]);
        }
        for (int k = 0; k < 3; k += 2) {
            if (v[k] < -MAX_HORIZONTAL || v[k] > MAX_HORIZONTAL) {
                fields.add(field, "水平坐标超出世界边界: " + v[k]);
                break;
            }
        }
    }
}
