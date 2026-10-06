package com.lightning.mod.client.controlplane.core;

import java.nio.file.Path;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 动作执行上下文：动作实现与 core 之间的唯一接口面。
 *
 * <p>
 * 携带四件东西（对应任务书要求）：<b>params</b>、<b>job 句柄</b>（进度与关联 id）、
 * <b>事件回调</b>（{@link #emit}）、<b>产物目录</b>（{@link #beginRun} 后由 run 目录提供）。
 * 另外提供带类型检查的参数读取，错误一律 {@code CP-VALID-002} 并逐字段说明。
 *
 * <p>
 * 生命周期：由 {@link ActionJobExecutor} 在 tick 线程内创建、一次性使用。
 */
public final class ActionContext {

    private final JobHandle job;
    private final JsonObject params;
    private final ArtifactStore artifacts;
    private final EventStream events;
    private final Consumer<String> logger;

    private ArtifactStore.Run run;

    ActionContext(JobHandle job, JsonObject params, ArtifactStore artifacts, EventStream events,
        Consumer<String> logger) {
        this.job = job;
        this.params = params == null ? new JsonObject() : params;
        this.artifacts = artifacts;
        this.events = events;
        this.logger = logger;
    }

    /** 作业句柄（进度上报与 jobId）。 */
    public JobHandle job() {
        return job;
    }

    /** 原始入参（已剔除 {@code confirm}/{@code sync}/{@code timeoutMs} 等控制字段）。 */
    public JsonObject params() {
        return params;
    }

    /** 产物仓库；未装配时返回 null（纯观察动作不需要）。 */
    public ArtifactStore artifacts() {
        return artifacts;
    }

    /** 当前 run；未调用 {@link #beginRun} 时为 null。 */
    public ArtifactStore.Run run() {
        return run;
    }

    /** 当前 run 目录；未开始 run 时为 null。 */
    public Path runDir() {
        return run == null ? null : run.dir();
    }

    /**
     * 开始一次 run（幂等）：建 run 目录并登记活动 run。
     *
     * <p>
     * 动作在读到用例 id 之后再调用，core 才能把 run 目录命名为
     * {@code <ts>-<caseId>-<jobSeq>}。重复调用返回同一 run。
     *
     * @param caseId 用例 id（run 目录名组成部分）
     * @throws CpException CP-IO-001：目录创建失败；未装配 ArtifactStore 时抛 CP-STATE-001
     */
    public ArtifactStore.Run beginRun(String caseId) {
        if (run != null) {
            return run;
        }
        if (artifacts == null) {
            throw new CpException(ErrorCodes.STATE, "未装配产物仓库，无法创建 run 目录");
        }
        long seq = job == null ? 0L : job.seq();
        run = artifacts.createRun(caseId, seq);
        if (job != null) {
            job.attachRun(run.runId());
        }
        return run;
    }

    /** 上报进度（0..1）并落一条 {@code action-progress} 事件。 */
    public void progress(double fraction, String message) {
        if (job != null) {
            job.progress(fraction, message);
        }
        JsonObject data = new JsonObject();
        data.addProperty("progress", fraction);
        emit(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_PROGRESS, message, data);
    }

    /**
     * 落一条事件。
     *
     * @param kind    事件类型，见 {@link EventStream.Kinds}
     * @param message 人读信息
     * @param data    结构化附加数据，可为 null
     * @return 事件对象；未装配 EventStream 时返回 null
     */
    public EventStream.Event emit(String kind, String message, JsonObject data) {
        if (events == null) {
            return null;
        }
        // 进度事件用 info；失败类 kind 由调用方自行选级别，这里统一 info 以免误报
        return events.append(
            EventStream.LEVEL_INFO,
            kind,
            job == null ? null : job.action(),
            job == null ? null : job.jobId(),
            message,
            data);
    }

    /** 落一条带级别的自定义事件（world-rebuild / case-segment / criteria-verdict 等）。 */
    public EventStream.Event emit(String level, String kind, String message, JsonObject data) {
        if (events == null) {
            return null;
        }
        return events
            .append(level, kind, job == null ? null : job.action(), job == null ? null : job.jobId(), message, data);
    }

    /** 写一条控制面日志（已带 {@code [SDE][CP]} 前缀）。 */
    public void log(String message) {
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }

    // ------------------------------------------------------------ 参数读取

    /** 参数是否存在且非 null。 */
    public boolean has(String name) {
        return Json.get(params, name) != null;
    }

    /** 取原始参数值；缺失返回 null。 */
    public JsonElement param(String name) {
        return Json.get(params, name);
    }

    /** 取字符串参数；必填缺失或类型不符抛 CP-VALID-002。 */
    public String requireString(String name) {
        JsonElement e = Json.get(params, name);
        if (e == null) {
            throw CpException.param("缺少必填参数", name, "必填");
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            throw CpException.param("参数类型不符", name, "应为 string");
        }
        return e.getAsString();
    }

    /** 取字符串参数，缺失时用默认值。 */
    public String optString(String name, String def) {
        return Json.optString(params, name, def);
    }

    /** 取布尔参数，缺失或类型不符用默认值。 */
    public boolean optBool(String name, boolean def) {
        return Json.optBool(params, name, def);
    }

    /** 取整数参数，缺失或类型不符用默认值。 */
    public int optInt(String name, int def) {
        return Json.optInt(params, name, def);
    }

    /** 取长整数参数，缺失或类型不符用默认值。 */
    public long optLong(String name, long def) {
        return Json.optLong(params, name, def);
    }

    /** 取对象参数；必填缺失或类型不符抛 CP-VALID-002。 */
    public JsonObject requireObject(String name) {
        JsonObject o = Json.optObject(params, name);
        if (o == null) {
            throw CpException.param("缺少必填参数或类型不符", name, "应为 object");
        }
        return o;
    }

    /** 取数组成员；必填缺失或类型不符抛 CP-VALID-002。 */
    public JsonArray requireArray(String name) {
        JsonArray a = Json.optArray(params, name);
        if (a == null) {
            throw CpException.param("缺少必填参数或类型不符", name, "应为 array");
        }
        return a;
    }

    /** 取对象参数，缺失返回 null。 */
    public JsonObject optObject(String name) {
        return Json.optObject(params, name);
    }

    /** 取数组成员，缺失返回 null。 */
    public JsonArray optArray(String name) {
        return Json.optArray(params, name);
    }
}
