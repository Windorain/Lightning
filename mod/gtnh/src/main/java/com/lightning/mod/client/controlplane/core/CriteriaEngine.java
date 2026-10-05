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

    /** v1 判据类型注册表（顺序即文档顺序）。 */
    public static final List<String> TYPES = Collections.unmodifiableList(
        Arrays.asList("artifact-exists", "artifact-nonempty", "json-field", "world-hash-equals", "event-emitted"));

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

    private final ArtifactStore artifacts;
    private final ArtifactStore.Run run;
    private final EventStream events;
    private final RuntimeHashSource hashes;
    private final TimeSource time;

    /**
     * @param artifacts 产物仓库（读 run 目录内文件），可为 null
     * @param run       本次 run，可为 null（此时产物类判据报 error）
     * @param events    事件流水（{@code event-emitted} 判据用），可为 null
     * @param hashes    运行期哈希来源，可为 null
     * @param time      时间源，可为 null（取系统时钟）
     */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events, RuntimeHashSource hashes,
        TimeSource time) {
        this.artifacts = artifacts;
        this.run = run;
        this.events = events;
        this.hashes = hashes;
        this.time = time == null ? TimeSource.system() : time;
    }

    /** 便捷构造：系统时钟。 */
    public CriteriaEngine(ArtifactStore artifacts, ArtifactStore.Run run, EventStream events,
        RuntimeHashSource hashes) {
        this(artifacts, run, events, hashes, TimeSource.system());
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
            return verdict(id, type, Verdicts.ERROR, "未知判据类型: " + type + "（v1 支持 " + TYPES + "）");
        } catch (CpException e) {
            return verdict(id, type, Verdicts.ERROR, "判据求值失败: " + e.detail());
        } catch (RuntimeException e) {
            return verdict(id, type, Verdicts.ERROR, "判据求值异常: " + e);
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
            arr.add(m);
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

    // ------------------------------------------------------------ 工具

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
