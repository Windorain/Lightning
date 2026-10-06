package com.lightning.mod.client.controlplane.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

/**
 * 判据引擎（case-file.md §5）：把用例声明的判据求值为 {@code green|red|error} 结论。
 *
 * <p>
 * 求值只用 run 目录里的产物与事件流水，因此完全可单测；世界相关量（场景哈希）经
 * {@link RuntimeHashSource} 注入，保持 core 零 MC 依赖。
 *
 * <p>
 * 结论语义（case-file.md §5）：{@code error} 表示「判据自身无法求值」（例如产物缺失到连断言都做不了），
 * 它**视同 red 但单列**——{@link #evaluate} 的 {@code overall} 在出现 red 或 error 时为 red。
 */
public final class CriteriaEngine {

    /**
     * v1 判据类型注册表（顺序即文档顺序）。
     *
     * <p>
     * 与下方 {@code TYPE_*} 常量同源：既有的 5 条按原样写字面量（声明在本字段之后，简单名前向引用
     * 是编译错误），故新增的 {@code te-state-equals} 也写字面量，取值一致性由紧随其后的常量与
     * {@link CaseParserTest} 的注册表测试保证。
     */
    public static final List<String> TYPES = Collections.unmodifiableList(
        Arrays.asList(
            "artifact-exists",
            "artifact-nonempty",
            "json-field",
            "world-hash-equals",
            "event-emitted",
            ImageCriteria.TYPE_IMAGE_SIZE_EQUALS,
            ImageCriteria.TYPE_IMAGE_NOT_UNIFORM,
            "te-state-equals",
            ImageCriteria.TYPE_IMAGE_UNIFORM));

    /** 判据类型引入的契约小版本（与 contract.md §5 的 {@code since} 同口径）。 */
    public static final String SINCE_1_0 = "1.0";

    /** 见 {@link #SINCE_1_0}：PR-2（取证级动作与图像判据）。 */
    public static final String SINCE_1_1 = "1.1";

    /** 见 {@link #SINCE_1_0}：PR-3（双轨判据：{@code te-state-equals} / {@code image-uniform}）。 */
    public static final String SINCE_1_2 = "1.2";

    /** 判据结论取值。 */
    public static final class Verdicts {

        /** 满足。 */
        public static final String GREEN = "green";
        /** 不满足。 */
        public static final String RED = "red";
        /** 判据自身无法求值（视同 red 但单列）。 */
        public static final String ERROR = "error";

        private Verdicts() {}
    }

    /** 判据类型名。 */
    public static final String TYPE_ARTIFACT_EXISTS = "artifact-exists";

    /** 见 {@link #TYPE_ARTIFACT_EXISTS}。 */
    public static final String TYPE_ARTIFACT_NONEMPTY = "artifact-nonempty";

    /** 见 {@link #TYPE_ARTIFACT_EXISTS}。 */
    public static final String TYPE_JSON_FIELD = "json-field";

    /** 见 {@link #TYPE_ARTIFACT_EXISTS}。 */
    public static final String TYPE_WORLD_HASH_EQUALS = "world-hash-equals";

    /** 见 {@link #TYPE_ARTIFACT_EXISTS}。 */
    public static final String TYPE_EVENT_EMITTED = "event-emitted";

    /** 图像判据：尺寸相等（PR-2）。 */
    public static final String TYPE_IMAGE_SIZE_EQUALS = ImageCriteria.TYPE_IMAGE_SIZE_EQUALS;

    /** 图像判据：非纯色（PR-2）。 */
    public static final String TYPE_IMAGE_NOT_UNIFORM = ImageCriteria.TYPE_IMAGE_NOT_UNIFORM;

    /** TE 运行期状态判据（PR-3，运行期轨）。 */
    public static final String TYPE_TE_STATE_EQUALS = "te-state-equals";

    /** 图像判据：近纯色（PR-3，图像轨，{@code image-not-uniform} 的反转）。 */
    public static final String TYPE_IMAGE_UNIFORM = ImageCriteria.TYPE_IMAGE_UNIFORM;

    /** evidence 段核对结论的固定 id（case-file.md §7）。 */
    public static final String EVIDENCE_ID = "evidence-complete";

    /**
     * 运行期哈希读取口（mc 层实现）：{@code world-hash-equals} 判据的唯一外部数据来源。
     *
     * <p>
     * 语义是「重建后场景哈希 == 本 run 首次构建哈希」（幂等判据）；两边都取不到时判据报 error。
     */
    public interface RuntimeHashSource {

        /** 本 run 首次构建后的场景哈希。 */
        String sceneHashFirstBuild();

        /** 当前（重建后）场景哈希。 */
        String sceneHashCurrent();
    }

    /**
     * 运行期 TE 状态读取口（mc 层实现）：{@code te-state-equals} 判据的唯一外部数据来源。
     *
     * <p>
     * 分工（case-file.md §5 的双轨口径）：<b>读取</b>在 mc 层——经 {@code TeDescriber}（与补全器同族、
     * 只读不写）取 TE 的运行期状态对象；<b>求值</b>在 core——按 RFC 6901 指针取字段并与 {@code expect}
     * 比较。这样判据的红绿语义、指针语义（与 {@code json-field} 同一份 {@link Json#resolvePointer}）
     * 都只有一个定义点，且可脱离 MC 单测。
     */
    public interface RuntimeTeSource {

        /** 一条 TE 运行期状态：描述器族名 + 状态对象（整棵 JSON）。 */
        final class TeState {

            /** 描述器族名（如 {@code lp-pipe} / {@code ae2-part}）。 */
            public final String family;

            /** 描述器输出的状态对象（{@code key} 指针在这一根上解析）。 */
            public final JsonObject state;

            public TeState(String family, JsonObject state) {
                this.family = family;
                this.state = state;
            }
        }

        /**
         * 描述指定位置的 TE 运行期状态。
         *
         * @return 命中某个描述器时返回其状态；该位置没有 TE、或没有任何描述器认领它时返回 {@code null}
         *         （判据据此报 {@code error}，视同 red 单列）
         */
        TeState describe(int x, int y, int z);
    }

    private final ArtifactStore artifacts;
    private final ArtifactStore.Run run;
    private final EventStream events;
    private final RuntimeHashSource hashes;
    private final RuntimeTeSource teStates;
    private final TimeSource time;

    /**
     * @param artifacts 产物仓库（读 run 目录内文件），可为 null
     * @param run       本次 run，可为 null（此时产物类判据报 error）
     * @param events    事件流水（{@code event-emitted} 判据用），可为 null
     * @param hashes    运行期哈希来源，可为 null
     * @param teStates  运行期 TE 状态来源（{@code te-state-equals} 用），可为 null
     * @param time      时间源，可为 null（取系统时钟）
     */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events, RuntimeHashSource hashes,
        RuntimeTeSource teStates, TimeSource time) {
        this.artifacts = artifacts;
        this.run = run;
        this.events = events;
        this.hashes = hashes;
        this.teStates = teStates;
        this.time = time == null ? TimeSource.system() : time;
    }

    /** 便捷构造：无 TE 状态来源（{@code te-state-equals} 报 error）。 */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events, RuntimeHashSource hashes,
        TimeSource time) {
        this(artifacts, run, events, hashes, null, time);
    }

    /** 便捷构造：系统时钟。 */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events,
        RuntimeHashSource hashes) {
        this(artifacts, run, events, hashes, null, TimeSource.system());
    }

    /** 便捷构造：系统时钟 + TE 状态来源。 */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events, RuntimeHashSource hashes,
        RuntimeTeSource teStates) {
        this(artifacts, run, events, hashes, teStates, TimeSource.system());
    }

    /** 判据类型是否已注册。 */
    public static boolean isKnownType(String type) {
        return type != null && TYPES.contains(type);
    }

    /** 固定哈希来源（测试与「已知两边哈希」的场景用）。 */
    public static RuntimeHashSource fixedHashSource(final String first, final String current) {
        return new RuntimeHashSource() {

            @Override
            public String sceneHashFirstBuild() {
                return first;
            }

            @Override
            public String sceneHashCurrent() {
                return current;
            }
        };
    }

    /**
     * 固定 TE 状态来源（测试与「已知状态」的场景用）：对任意坐标都返回同一份状态。
     *
     * @param family 族名（写入判据 detail）
     * @param state  状态对象；{@code null} 表示「该位置没有可描述的 TE」
     */
    public static RuntimeTeSource fixedTeSource(final String family, final JsonObject state) {
        return new RuntimeTeSource() {

            @Override
            public TeState describe(int x, int y, int z) {
                return state == null ? null : new TeState(family, state);
            }
        };
    }

    /**
     * 按坐标分派的 TE 状态来源（测试用）：{@code state} 为 {@code null} 的位置返回「没有 TE」。
     *
     * @param at    目标坐标 {@code [x,y,z]}
     * @param state 命中时的状态对象
     */
    public static RuntimeTeSource teSourceAt(final int[] at, final JsonObject state) {
        return new RuntimeTeSource() {

            @Override
            public TeState describe(int x, int y, int z) {
                if (state == null || at == null || at.length != 3 || at[0] != x || at[1] != y || at[2] != z) {
                    return null;
                }
                return new TeState("test", state);
            }
        };
    }

    /**
     * 判据类型的自描述目录（{@code case-file.md §5} 的机器可读形态）。
     *
     * <p>
     * 与 {@link #TYPES} 同源、按同一顺序输出；每条含 {@code type}、{@code since}（引入的契约小版本，
     * 口径同 {@code ActionDescriptor#since}）与 {@code params}（参数说明，人读）。{@code case.validate}
     * 把它摊在结果里，调用方因此不必读源码就知道能写哪些判据——「自描述」在动作层之外也要成立。
     */
    public static JsonArray typeCatalog() {
        JsonArray out = new JsonArray();
        out.add(typeDescriptor(TYPE_ARTIFACT_EXISTS, SINCE_1_0, "path"));
        out.add(typeDescriptor(TYPE_ARTIFACT_NONEMPTY, SINCE_1_0, "path, minBytes(默认1)"));
        out.add(typeDescriptor(TYPE_JSON_FIELD, SINCE_1_0, "path, pointer(RFC 6901), expect(必填)"));
        out.add(typeDescriptor(TYPE_WORLD_HASH_EQUALS, SINCE_1_0, "—"));
        out.add(typeDescriptor(TYPE_EVENT_EMITTED, SINCE_1_0, "kind, minCount(默认1)"));
        out.add(typeDescriptor(TYPE_IMAGE_SIZE_EQUALS, SINCE_1_1, "path, width, height"));
        out.add(typeDescriptor(TYPE_IMAGE_NOT_UNIFORM, SINCE_1_1, "path, maxSameColorRatio(默认0.98)"));
        out.add(typeDescriptor(TYPE_TE_STATE_EQUALS, SINCE_1_2, "at[x,y,z], key(RFC 6901 指针，对描述器输出), expect(必填)"));
        out.add(typeDescriptor(TYPE_IMAGE_UNIFORM, SINCE_1_2, "path, minSameColorRatio(默认0.98)"));
        return out;
    }

    /** 判据类型的引入版本；未登记类型返回 {@code null}。 */
    public static String typeSince(String type) {
        JsonArray catalog = typeCatalog();
        for (int i = 0; i < catalog.size(); i++) {
            JsonObject o = catalog.get(i)
                .getAsJsonObject();
            if (Json.optString(o, "type", "")
                .equals(type)) {
                return Json.optString(o, "since", null);
            }
        }
        return null;
    }

    private static JsonObject typeDescriptor(String type, String since, String params) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        o.addProperty("since", since);
        o.addProperty("params", params);
        return o;
    }

    /**
     * 求值一整组判据，并逐条落 {@code criteria-verdict} 事件。
     *
     * @param criteria 判据数组（{@link CaseFile#criteria()} 的原样 JSON）
     * @param runId    run 标识（写入结论文档）
     * @return {@code criteria.json} 内容
     */
    public JsonObject evaluate(JsonArray criteria, String runId) {
        JsonArray results = new JsonArray();
        int green = 0;
        int red = 0;
        int error = 0;
        if (criteria != null) {
            for (int i = 0; i < criteria.size(); i++) {
                JsonElement e = criteria.get(i);
                JsonObject c = e != null && e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
                JsonObject r = evaluateOne(c, i);
                results.add(r);
                String v = Json.optString(r, "verdict", Verdicts.ERROR);
                if (Verdicts.GREEN.equals(v)) {
                    green++;
                } else if (Verdicts.RED.equals(v)) {
                    red++;
                } else {
                    error++;
                }
                if (events != null) {
                    JsonObject data = new JsonObject();
                    data.addProperty("criteriaId", Json.optString(r, "id", ""));
                    data.addProperty("criteriaType", Json.optString(r, "type", ""));
                    data.addProperty("verdict", v);
                    data.addProperty("detail", Json.optString(r, "detail", ""));
                    events.append(
                        Verdicts.GREEN.equals(v) ? EventStream.LEVEL_INFO : EventStream.LEVEL_ERROR,
                        EventStream.Kinds.CRITERIA_VERDICT,
                        null,
                        null,
                        "判据 " + Json.optString(r, "id", "") + " → " + v,
                        data);
                }
            }
        }
        JsonObject counts = new JsonObject();
        counts.addProperty(Verdicts.GREEN, green);
        counts.addProperty(Verdicts.RED, red);
        counts.addProperty(Verdicts.ERROR, error);
        JsonObject doc = new JsonObject();
        doc.addProperty("schema", Contract.SCHEMA_CRITERIA);
        doc.addProperty("runId", runId);
        doc.addProperty("generatedAt", time.isoNow());
        doc.addProperty("overall", red == 0 && error == 0 ? Verdicts.GREEN : Verdicts.RED);
        doc.add("counts", counts);
        doc.add("criteria", results);
        return doc;
    }

    /**
     * 求值单条判据。
     *
     * @param criterion {@code {id,type,params?,expect?}}
     * @param index     在数组中的下标（缺 id 时用于生成占位 id）
     * @return {@code {id, verdict, detail}}（外加 {@code type}，便于人读）
     */
    public JsonObject evaluateOne(JsonObject criterion, int index) {
        String id = Json.optString(criterion, "id", "criterion-" + index);
        String type = Json.optString(criterion, "type", null);
        JsonObject params = Json.optObject(criterion, "params");
        if (params == null) {
            params = new JsonObject();
        }
        boolean hasExpect = criterion.has("expect");
        JsonElement expect = hasExpect ? criterion.get("expect") : null;
        // 图像判据的算子只拿得到相对路径，run 目录在这里注入（求值期上下文，见 ImageCriteria）。
        // 若调用方已经指定了 run 目录（如单测直接指向夹具目录），不覆盖它——覆盖会让「判据本身」
        // 无法脱离 run 目录单独验证。
        boolean ownedRunDir = ImageCriteria.currentRunDir() == null;
        if (ownedRunDir) {
            ImageCriteria.setRunDir(run == null ? null : run.dir());
        }
        try {
            if (type == null) {
                return verdict(id, null, Verdicts.ERROR, "判据缺少 type");
            }
            if (TYPE_ARTIFACT_EXISTS.equals(type)) {
                return artifactExists(id, type, params);
            }
            if (TYPE_ARTIFACT_NONEMPTY.equals(type)) {
                return artifactNonEmpty(id, type, params);
            }
            if (TYPE_JSON_FIELD.equals(type)) {
                return jsonField(id, type, params, expect, hasExpect);
            }
            if (TYPE_WORLD_HASH_EQUALS.equals(type)) {
                return worldHashEquals(id, type);
            }
            if (TYPE_EVENT_EMITTED.equals(type)) {
                return eventEmitted(id, type, params);
            }
            if (TYPE_IMAGE_SIZE_EQUALS.equals(type)) {
                return image(id, type, ImageCriteria.evaluateSize(params));
            }
            if (TYPE_IMAGE_NOT_UNIFORM.equals(type)) {
                return image(id, type, ImageCriteria.evaluateNotUniform(params));
            }
            if (TYPE_IMAGE_UNIFORM.equals(type)) {
                return image(id, type, ImageCriteria.evaluateUniform(params));
            }
            if (TYPE_TE_STATE_EQUALS.equals(type)) {
                return teStateEquals(id, type, params, expect, hasExpect);
            }
            return verdict(id, type, Verdicts.ERROR, "未知判据类型: " + type + "（v1 支持 " + TYPES + "）");
        } catch (CpException e) {
            return verdict(id, type, Verdicts.ERROR, "判据求值失败: " + e.detail());
        } catch (RuntimeException e) {
            return verdict(id, type, Verdicts.ERROR, "判据求值异常: " + e);
        } finally {
            if (ownedRunDir) {
                ImageCriteria.clearRunDir();
            }
        }
    }

    /**
     * 逐条核对期望证据清单（case-file.md §7），产出一条 id 为 {@code evidence-complete} 的结论。
     *
     * @param expect {@code evidence.expect} 数组
     */
    public JsonObject checkEvidence(JsonArray expect) {
        if (run == null) {
            return verdict(EVIDENCE_ID, EVIDENCE_ID, Verdicts.ERROR, "run 目录未知，无法核对证据清单");
        }
        List<String> missing = new ArrayList<String>();
        int total = expect == null ? 0 : expect.size();
        for (int i = 0; i < total; i++) {
            JsonElement e = expect.get(i);
            String path = e != null && e.isJsonObject() ? Json.optString(e.getAsJsonObject(), "path", null) : null;
            if (path == null) {
                missing.add("(第 " + i + " 条缺 path)");
                continue;
            }
            Path target;
            try {
                target = ArtifactStore.resolveInRun(run.dir(), path);
            } catch (CpException ex) {
                missing.add(path + "（路径非法）");
                continue;
            }
            if (!Files.isRegularFile(target)) {
                missing.add(path);
            }
        }
        if (missing.isEmpty()) {
            return verdict(EVIDENCE_ID, EVIDENCE_ID, Verdicts.GREEN, "期望证据 " + total + " 项齐全");
        }
        JsonObject detail = new JsonObject();
        JsonArray arr = new JsonArray();
        for (String m : missing) {
            Json.add(arr, m);
        }
        detail.add("missing", arr);
        return verdict(
            EVIDENCE_ID,
            EVIDENCE_ID,
            Verdicts.RED,
            "缺少证据 " + missing.size() + "/" + total + " 项: " + missing + " " + Json.toJson(detail));
    }

    // ------------------------------------------------------------ 各判据

    private JsonObject artifactExists(String id, String type, JsonObject params) {
        String path = Json.optString(params, "path", null);
        if (path == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.path");
        }
        Path target = artifactPath(path);
        if (target == null) {
            return verdict(id, type, Verdicts.ERROR, "run 目录未知，无法检查产物: " + path);
        }
        if (!Files.isRegularFile(target)) {
            return verdict(id, type, Verdicts.RED, "产物不存在: " + path);
        }
        return verdict(id, type, Verdicts.GREEN, "产物存在: " + path + " (" + size(target) + " 字节)");
    }

    private JsonObject artifactNonEmpty(String id, String type, JsonObject params) {
        String path = Json.optString(params, "path", null);
        if (path == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.path");
        }
        long minBytes = Json.optLong(params, "minBytes", 1L);
        if (minBytes < 0) {
            return verdict(id, type, Verdicts.ERROR, "params.minBytes 不得为负");
        }
        Path target = artifactPath(path);
        if (target == null) {
            return verdict(id, type, Verdicts.ERROR, "run 目录未知，无法检查产物: " + path);
        }
        if (!Files.isRegularFile(target)) {
            return verdict(id, type, Verdicts.RED, "产物不存在: " + path);
        }
        long n = size(target);
        if (n < minBytes) {
            return verdict(id, type, Verdicts.RED, "产物过小: " + path + " " + n + " < " + minBytes + " 字节（非空断言失败）");
        }
        return verdict(id, type, Verdicts.GREEN, "产物非空: " + path + " " + n + " ≥ " + minBytes + " 字节");
    }

    private JsonObject jsonField(String id, String type, JsonObject params, JsonElement expect, boolean hasExpect) {
        String path = Json.optString(params, "path", null);
        String pointer = Json.optString(params, "pointer", null);
        if (path == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.path");
        }
        if (pointer == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.pointer（RFC 6901 指针）");
        }
        if (!hasExpect) {
            return verdict(id, type, Verdicts.ERROR, "缺少 expect");
        }
        Path target = artifactPath(path);
        if (target == null) {
            return verdict(id, type, Verdicts.ERROR, "run 目录未知，无法读取产物: " + path);
        }
        if (!Files.isRegularFile(target)) {
            return verdict(id, type, Verdicts.ERROR, "产物缺失，无法求值: " + path);
        }
        JsonElement root;
        try {
            root = Json.parseStrict(new String(Files.readAllBytes(target), StandardCharsets.UTF_8));
        } catch (IOException e) {
            return verdict(id, type, Verdicts.ERROR, "读取产物失败: " + path + " / " + e.getMessage());
        } catch (JsonSyntaxException e) {
            return verdict(id, type, Verdicts.ERROR, "产物不是合法 JSON: " + path + " / " + e.getMessage());
        }
        JsonElement actual = Json.resolvePointer(root, pointer);
        if (actual == null) {
            return verdict(id, type, Verdicts.RED, "指针未命中: " + pointer + " @ " + path);
        }
        if (!actual.equals(expect)) {
            return verdict(
                id,
                type,
                Verdicts.RED,
                "字段值不符: " + pointer + " 期望 " + Json.toJson(expect) + "，实际 " + Json.toJson(actual));
        }
        return verdict(id, type, Verdicts.GREEN, "字段命中: " + pointer + " = " + Json.toJson(actual));
    }

    private JsonObject worldHashEquals(String id, String type) {
        if (hashes == null) {
            return verdict(id, type, Verdicts.ERROR, "没有运行期哈希来源（world-hash-equals 需要 mc 层提供）");
        }
        String first = hashes.sceneHashFirstBuild();
        String current = hashes.sceneHashCurrent();
        if (first == null || current == null) {
            return verdict(id, type, Verdicts.ERROR, "场景哈希不可用（首次=" + first + "，当前=" + current + "）");
        }
        if (!first.equals(current)) {
            return verdict(id, type, Verdicts.RED, "场景哈希不一致：首次 " + first + "，当前 " + current);
        }
        return verdict(id, type, Verdicts.GREEN, "场景哈希一致（幂等）: " + first);
    }

    private JsonObject eventEmitted(String id, String type, JsonObject params) {
        String kind = Json.optString(params, "kind", null);
        if (kind == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.kind");
        }
        int minCount = Json.optInt(params, "minCount", 1);
        if (minCount < 0) {
            return verdict(id, type, Verdicts.ERROR, "params.minCount 不得为负");
        }
        if (events == null) {
            return verdict(id, type, Verdicts.ERROR, "事件流水不可用");
        }
        int n = events.countKind(kind);
        if (n < minCount) {
            return verdict(id, type, Verdicts.RED, "事件不足: kind=" + kind + " 实际 " + n + " < " + minCount);
        }
        return verdict(id, type, Verdicts.GREEN, "事件满足: kind=" + kind + " 实际 " + n + " ≥ " + minCount);
    }

    /**
     * {@code te-state-equals} 求值（PR-3，运行期轨，case-file.md §5）。
     *
     * <p>
     * 求值口径与 {@code json-field} 完全一致（同一份 {@link Json#resolvePointer}）：{@code key} 是指向
     * <b>描述器输出对象</b>的 RFC 6901 指针，{@code expect} 与之逐值比较（{@code JsonElement.equals}）。
     * 区别只有一个：被断言的 JSON 不是 run 目录里的产物，而是 mc 层在<b>当前世界</b>上经
     * {@code TeDescriber} 实读的 TE 运行期状态。
     *
     * <p>
     * 红绿分工：
     * <ul>
     * <li><b>error</b>（判据自身无法求值，视同 red 单列）：{@code at}/{@code key}/{@code expect} 缺失或非法、
     * 没有注入运行期 TE 状态来源、{@code at} 位置<b>没有描述器认领的 TE</b>；</li>
     * <li><b>red</b>：指针未命中（用例写错键名——描述器输出的是它自己的字段名）；
     * 或命中值与 {@code expect} 不等。</li>
     * </ul>
     *
     * <p>
     * 描述器输出里的「缺席」必须是显式 {@code null}（描述器契约）：这样 {@code expect: null} 是可断言的，
     * 与「键名写错」区分得开。
     */
    private JsonObject teStateEquals(String id, String type, JsonObject params, JsonElement expect, boolean hasExpect) {
        String atError = null;
        int[] at = null;
        JsonArray atArr = Json.optArray(params, "at");
        if (atArr == null) {
            atError = "缺少 params.at（[x,y,z]）";
        } else if (atArr.size() != 3) {
            atError = "params.at 须为 [x,y,z]，收到 " + atArr.size() + " 个分量";
        } else {
            at = new int[3];
            for (int i = 0; i < 3; i++) {
                JsonElement v = atArr.get(i);
                if (v == null || !v.isJsonPrimitive() || !CameraSpec.isIntegral(v) || !CameraSpec.isFinite(v)) {
                    atError = "params.at[" + i + "] 须为整数";
                    break;
                }
                at[i] = v.getAsInt();
            }
        }
        if (atError != null) {
            return verdict(id, type, Verdicts.ERROR, atError);
        }
        String key = Json.optString(params, "key", null);
        if (key == null) {
            return verdict(id, type, Verdicts.ERROR, "缺少 params.key（RFC 6901 指针，指向描述器输出）");
        }
        if (!key.isEmpty() && !key.startsWith("/")) {
            return verdict(id, type, Verdicts.ERROR, "params.key 须以 / 开头或为空串（RFC 6901）");
        }
        if (!hasExpect) {
            return verdict(id, type, Verdicts.ERROR, "缺少 expect");
        }
        if (teStates == null) {
            return verdict(id, type, Verdicts.ERROR, "没有运行期 TE 状态来源（te-state-equals 需要 mc 层提供）");
        }
        RuntimeTeSource.TeState st;
        try {
            st = teStates.describe(at[0], at[1], at[2]);
        } catch (RuntimeException e) {
            return verdict(id, type, Verdicts.ERROR, "读取 TE 运行期状态失败: " + e);
        }
        if (st == null || st.state == null) {
            return verdict(
                id,
                type,
                Verdicts.ERROR,
                "该位置没有可描述的 TE（描述器查不到 @" + at[0] + "," + at[1] + "," + at[2] + "）——检查 te 步是否已补全该位置");
        }
        JsonElement actual = Json.resolvePointer(st.state, key);
        if (actual == null) {
            return verdict(
                id,
                type,
                Verdicts.RED,
                "指针未命中: " + key + " @ te[" + at[0] + "," + at[1] + "," + at[2] + "]（族 " + st.family + "）");
        }
        if (!actual.equals(expect)) {
            return verdict(
                id,
                type,
                Verdicts.RED,
                "TE 状态不符: " + key
                    + " 期望 "
                    + Json.toJson(expect)
                    + "，实际 "
                    + Json.toJson(actual)
                    + "（族 "
                    + st.family
                    + " @"
                    + at[0]
                    + ","
                    + at[1]
                    + ","
                    + at[2]
                    + "）");
        }
        return verdict(
            id,
            type,
            Verdicts.GREEN,
            "TE 状态命中: " + key
                + " = "
                + Json.toJson(actual)
                + "（族 "
                + st.family
                + " @"
                + at[0]
                + ","
                + at[1]
                + ","
                + at[2]
                + "）");
    }

    // ------------------------------------------------------------ 工具

    /**
     * 把图像算子的结论（{@code {verdict, detail}}）并成一条判据结论。
     *
     * <p>
     * 算子只回 verdict/detail，不走 {@link #verdict} 的三参重载——红绿语义只有一处定义。
     */
    private static JsonObject image(String id, String type, JsonObject computed) {
        return verdict(
            id,
            type,
            Json.optString(computed, "verdict", Verdicts.ERROR),
            Json.optString(computed, "detail", ""));
    }

    private Path artifactPath(String relPath) {
        if (run == null) {
            return null;
        }
        return ArtifactStore.resolveInRun(run.dir(), relPath);
    }

    private static long size(Path p) {
        try {
            return Files.size(p);
        } catch (IOException e) {
            return -1L;
        }
    }

    private static JsonObject verdict(String id, String type, String verdict, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        if (type != null) {
            o.addProperty("type", type);
        }
        o.addProperty("verdict", verdict);
        o.addProperty("detail", detail == null ? "" : detail);
        return o;
    }
}
