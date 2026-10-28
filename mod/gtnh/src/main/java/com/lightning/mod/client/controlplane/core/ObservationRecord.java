package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 观测记录（{@code lightning.observation/1}，见 observation-record.md）的零 MC 依赖模型。
 *
 * <p>
 * 本类只管结构与哈希口径，<b>值</b>由 mc 层采集（版本、渲染相关客户端配置、观察条件、
 * 运行期状态摘要）。核心判据是 A10：<b>仅据本文件即可解释一次观测</b>——版本、客户端配置、
 * 观察条件、关键运行期状态摘要与哈希、产物引用与哈希，缺一不可。
 *
 * <p>
 * 哈希口径（observation-record.md §2 第 1 条）：产物 {@code sha256} 对文件字节计算（由
 * {@link ArtifactStore} 登记时算好）；{@code runtimeReads[].sha256} 对<b>摘要对象的规范化 JSON</b>
 * （键排序、无空白）计算，用 {@link #hashSummary(JsonElement)}。
 *
 * <p>
 * 1.0 阶段 {@code observation.camera/projection} 是占位值（{@code player}/{@code perspective}），
 * 1.1 起由拍摄动作填真实机位；字段一经引入不得改义（contract.md §13）。
 */
public final class ObservationRecord {

    /** 相机占位值（1.0）。 */
    public static final String PLACEHOLDER_CAMERA_MODE = "player";

    /** 投影占位值（1.0）。 */
    public static final String PLACEHOLDER_PROJECTION = "perspective";

    /** 一条「读取过的运行期状态摘要」。 */
    public static final class RuntimeRead {

        private final String key;
        private final String summary;
        private final String sha256;

        RuntimeRead(String key, String summary, String sha256) {
            this.key = key;
            this.summary = summary;
            this.sha256 = sha256;
        }

        /** 状态键（如 {@code world.sceneManifest}）。 */
        public String key() {
            return key;
        }

        /** 人读摘要。 */
        public String summary() {
            return summary;
        }

        /** 对摘要对象规范化 JSON 计算的 sha256。 */
        public String sha256() {
            return sha256;
        }

        /** {@code {key, summary, sha256}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("key", key);
            o.addProperty("summary", summary);
            o.addProperty("sha256", sha256);
            return o;
        }
    }

    private final JsonObject doc;

    private ObservationRecord(JsonObject doc) {
        this.doc = doc;
    }

    /** 新建构造器（runId/caseId/caseSha256 是记录的骨架，必填）。 */
    public static Builder builder(String runId, String caseId, String caseSha256) {
        return new Builder(runId, caseId, caseSha256);
    }

    /** 观测记录 JSON。 */
    public JsonObject toJson() {
        return Json.copyObject(doc);
    }

    /** 观测记录 JSON 文本（缩进）。 */
    public String toPrettyString() {
        return Json.toPretty(doc);
    }

    /** 取字段（供测试与调用方自检）。 */
    public JsonElement field(String name) {
        return Json.get(doc, name);
    }

    /**
     * 摘要对象的哈希（observation-record.md §2 第 1 条）：规范化 JSON（键排序、无空白）的 sha256。
     *
     * <p>
     * 同一份摘要不论字段书写顺序，哈希必须一致。
     */
    public static String hashSummary(JsonElement summary) {
        return Hashing.sha256HexUtf8(Json.canonical(summary));
    }

    /** 观测记录构造器。 */
    public static final class Builder {

        private final JsonObject doc = new JsonObject();
        private final List<RuntimeRead> reads = new ArrayList<RuntimeRead>();
        private final JsonArray artifacts = new JsonArray();

        private Builder(String runId, String caseId, String caseSha256) {
            doc.addProperty("schema", Contract.SCHEMA_OBSERVATION);
            doc.addProperty("runId", runId);
            doc.addProperty("caseId", caseId);
            doc.addProperty("caseSha256", caseSha256);
            doc.addProperty("createdAt", "");
            doc.add("versions", new JsonObject());
            doc.add("clientConfig", new JsonObject());
            JsonObject observation = new JsonObject();
            JsonObject camera = new JsonObject();
            camera.addProperty("mode", PLACEHOLDER_CAMERA_MODE);
            observation.add("camera", camera);
            observation.addProperty("projection", PLACEHOLDER_PROJECTION);
            doc.add("observation", observation);
        }

        /** 记录时间（ISO-8601 带偏移）。 */
        public Builder createdAt(String iso) {
            doc.addProperty("createdAt", iso == null ? "" : iso);
            return this;
        }

        /** 世界与模组版本：{@code {mod, minecraft, forge, mods:[...]}}。 */
        public Builder versions(JsonObject versions) {
            doc.add("versions", Json.copyObject(versions));
            return this;
        }

        /** 渲染相关客户端配置快照。 */
        public Builder clientConfig(JsonObject clientConfig) {
            doc.add("clientConfig", Json.copyObject(clientConfig));
            return this;
        }

        /** 观察条件整体覆盖（1.1 的注入机位走这里）。 */
        public Builder observation(JsonObject observation) {
            doc.add("observation", Json.copyObject(observation));
            return this;
        }

        /**
         * {@code observation} 子对象的<b>可写视图</b>（同一实例，改动即生效）。
         *
         * <p>
         * 给需要「在既有观察条件上追加字段」的采集方用（如 1.1 在 1.0 的占位 camera/projection
         * 之上补真实机位与 cameras[]）。返回的是内部实例而非副本——采集方按约定只做字段级增改，
         * 不做整体替换（整体替换用 {@link #observation(JsonObject)}）。
         */
        public JsonObject observationView() {
            JsonObject observation = Json.optObject(doc, "observation");
            if (observation == null) {
                observation = new JsonObject();
                doc.add("observation", observation);
            }
            return observation;
        }

        /**
         * 追加一条机位摘要到 {@code observation.cameras[]}（observation-record.md §2 第 4 条）。
         *
         * <p>
         * 多机位口径：{@code observation.camera} 记首个机位（会话代表），本数组追加<b>全部</b>机位的
         * {@code {name,pos,yaw,pitch,projection,resolution,tile?}} 摘要；逐机位的实际
         * renderMode/lighting/worldTime 落 {@code shots/<name>.meta.json}。数组按追加顺序（= 机位声明序）。
         */
        public Builder camera(JsonObject cameraSummary) {
            if (cameraSummary == null) {
                return this;
            }
            JsonObject observation = Json.optObject(doc, "observation");
            if (observation == null) {
                observation = new JsonObject();
                doc.add("observation", observation);
            }
            JsonArray cameras = Json.optArray(observation, "cameras");
            if (cameras == null) {
                cameras = new JsonArray();
                observation.add("cameras", cameras);
            }
            cameras.add(Json.copyObject(cameraSummary));
            return this;
        }

        /** 批量追加机位摘要（{@code cameras} 为 {@code cameras[]} 数组）。 */
        public Builder cameras(JsonArray cameraSummaries) {
            if (cameraSummaries == null) {
                return this;
            }
            for (int i = 0; i < cameraSummaries.size(); i++) {
                JsonElement e = cameraSummaries.get(i);
                if (e != null && e.isJsonObject()) {
                    camera(e.getAsJsonObject());
                }
            }
            return this;
        }

        /** 覆盖单个观察条件字段（如 {@code worldTime}/{@code lighting}/{@code renderMode}）。 */
        public Builder observationField(String name, Object value) {
            JsonObject observation = Json.optObject(doc, "observation");
            if (observation == null) {
                observation = new JsonObject();
                doc.add("observation", observation);
            }
            if (value instanceof JsonElement) {
                observation.add(name, (JsonElement) value);
            } else if (value instanceof Number) {
                observation.addProperty(name, (Number) value);
            } else if (value instanceof Boolean) {
                observation.addProperty(name, (Boolean) value);
            } else if (value != null) {
                observation.addProperty(name, String.valueOf(value));
            }
            return this;
        }

        /**
         * 登记一条运行期状态摘要。
         *
         * @param key         状态键
         * @param summary     人读摘要
         * @param summaryJson 摘要对象（哈希对象，可为 null 表示无结构摘要）
         */
        public Builder read(String key, String summary, JsonElement summaryJson) {
            reads.add(new RuntimeRead(key, summary, summaryJson == null ? null : hashSummary(summaryJson)));
            return this;
        }

        /** 登记一条**已算好哈希**的状态摘要（哈希口径由调用方负责）。 */
        public Builder read(String key, String summary, String sha256) {
            reads.add(new RuntimeRead(key, summary, sha256));
            return this;
        }

        /** 登记产物引用（哈希来自 {@link ArtifactStore} 的登记结果）。 */
        public Builder artifact(ArtifactStore.Artifact artifact) {
            if (artifact != null) {
                artifacts.add(artifact.toJson());
            }
            return this;
        }

        /** 登记产物引用（手工给值）。 */
        public Builder artifact(String path, String role, long bytes, String sha256) {
            JsonObject o = new JsonObject();
            o.addProperty("path", path);
            if (role != null) {
                o.addProperty("role", role);
            }
            o.addProperty("bytes", bytes);
            o.addProperty("sha256", sha256);
            artifacts.add(o);
            return this;
        }

        /** 构造。 */
        public ObservationRecord build() {
            JsonArray arr = new JsonArray();
            for (RuntimeRead r : reads) {
                arr.add(r.toJson());
            }
            doc.add("runtimeReads", arr);
            doc.add("artifacts", Json.copyArray(artifacts));
            return new ObservationRecord(doc);
        }
    }
}
