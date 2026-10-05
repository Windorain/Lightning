package com.lightning.mod.client.controlplane.core;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import com.google.gson.JsonObject;

/**
 * 作业模型（contract.md §2 的 {@code GET /cp/v1/jobs/{jobId}} 数据源）。
 *
 * <p>
 * 状态机：{@code queued → running → done|failed}，单向不可逆。
 * HTTP 线程只创建（{@link State#QUEUED}）与等待（{@link #await}）；状态推进只发生在
 * {@code drainOne()} 所在的 tick 线程。
 */
public final class Job implements JobHandle {

    /** 作业状态（契约固定取值，不增不改）。 */
    public enum State {

        /** 已入队，等待 tick 线程排空。 */
        QUEUED("queued"),
        /** 执行中。 */
        RUNNING("running"),
        /** 成功结束。 */
        DONE("done"),
        /** 失败结束。 */
        FAILED("failed");

        private final String id;

        State(String id) {
            this.id = id;
        }

        /** 契约中的稳定取值。 */
        public String id() {
            return id;
        }

        /** 是否已终态。 */
        public boolean isFinished() {
            return this == DONE || this == FAILED;
        }

        /** 按稳定取值解析；未知返回 null。 */
        public static State parse(String id) {
            if (id != null) {
                for (State s : values()) {
                    if (s.id.equals(id)) {
                        return s;
                    }
                }
            }
            return null;
        }
    }

    private final long seq;
    private final String jobId;
    private final String action;
    private final JsonObject params;
    private final String submittedAt;
    private final Tier tier;
    private final CountDownLatch latch = new CountDownLatch(1);

    private volatile State state = State.QUEUED;
    private volatile double progress = 0.0d;
    private volatile String progressMessage;
    private volatile JsonObject result;
    private volatile JsonObject error;
    private volatile String startedAt;
    private volatile String endedAt;
    private volatile String runId;

    Job(long seq, String jobId, String action, JsonObject params, String submittedAt) {
        this(seq, jobId, action, params, submittedAt, Tier.OBSERVE);
    }

    Job(long seq, String jobId, String action, JsonObject params, String submittedAt, Tier tier) {
        this.seq = seq;
        this.jobId = jobId;
        this.action = action;
        this.params = params == null ? new JsonObject() : params;
        this.submittedAt = submittedAt;
        this.tier = tier == null ? Tier.OBSERVE : tier;
    }

    /**
     * 提交本作业的调用方权限级（contract.md §1.5）。
     *
     * <p>
     * 动作的<b>静态</b>权限级在 {@code ActionRegistry} 的注册项里，由路由器在鉴权期判定；
     * 而 {@code case.run} 的权限按<b>内容</b>升格（含 cameras 段的用例必须 forensic 调用，
     * case-file.md §4）——那只能在执行期判定，故把调用方实际权限随作业带到 tick 线程。
     * 未显式指定时为 {@link Tier#OBSERVE}（最保守；内部/测试路径）。
     */
    @Override
    public Tier tier() {
        return tier;
    }

    @Override
    public long seq() {
        return seq;
    }

    @Override
    public String jobId() {
        return jobId;
    }

    @Override
    public String action() {
        return action;
    }

    /** 入参（不含 confirm/sync/timeoutMs 等控制字段）。 */
    public JsonObject params() {
        return params;
    }

    /** 当前状态。 */
    public State state() {
        return state;
    }

    /** 进度 0..1。 */
    public double progress() {
        return progress;
    }

    /** 进度说明，可为 null。 */
    public String progressMessage() {
        return progressMessage;
    }

    /** 成功结果，未完成时为 null。 */
    public JsonObject result() {
        return result;
    }

    /** 失败错误对象 {@code {code,message,context?}}，未失败时为 null。 */
    public JsonObject error() {
        return error;
    }

    /** 失败错误码，未失败时为 null。 */
    public String errorCode() {
        if (error == null) {
            return null;
        }
        return Json.optString(error, "code", null);
    }

    /** 入队时刻。 */
    public String submittedAt() {
        return submittedAt;
    }

    /** 开始执行时刻，未开始为 null。 */
    public String startedAt() {
        return startedAt;
    }

    /** 结束时刻，未结束为 null。 */
    public String endedAt() {
        return endedAt;
    }

    /** 关联 run 目录名，未产生 run 时为 null。 */
    public String runId() {
        return runId;
    }

    /** 是否已终态。 */
    public boolean isFinished() {
        return state.isFinished();
    }

    @Override
    public void progress(double fraction, String message) {
        double f = fraction;
        if (Double.isNaN(f)) {
            f = 0.0d;
        }
        this.progress = Math.max(0.0d, Math.min(1.0d, f));
        this.progressMessage = message;
    }

    @Override
    public void attachRun(String runId) {
        this.runId = runId;
    }

    /** 由 {@link JobQueue} 调用：置为执行中。 */
    void markRunning(String startedAt) {
        this.startedAt = startedAt;
        this.state = State.RUNNING;
    }

    /** 由 {@link JobQueue} 调用：成功结束。 */
    void markDone(String endedAt, JsonObject result) {
        this.result = result == null ? new JsonObject() : result;
        this.endedAt = endedAt;
        this.progress = 1.0d;
        this.state = State.DONE;
        latch.countDown();
    }

    /** 由 {@link JobQueue} 调用：失败结束。 */
    void markFailed(String endedAt, JsonObject error) {
        JsonObject e = error == null ? new JsonObject() : error;
        if (!e.has("code")) {
            e.addProperty("code", ErrorCodes.EXEC_FAILED);
        }
        this.error = e;
        this.endedAt = endedAt;
        this.state = State.FAILED;
        latch.countDown();
    }

    /**
     * 等待作业结束（{@code ?sync=true} 用）。
     *
     * @param timeoutMs 最长等待毫秒；&le;0 表示只做一次即时检查
     * @return 是否已在超时前结束
     */
    public boolean await(long timeoutMs) {
        if (isFinished()) {
            return true;
        }
        try {
            if (timeoutMs <= 0) {
                return isFinished();
            }
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread()
                .interrupt();
            return isFinished();
        }
    }

    /** 作业 JSON（契约 §2 的作业状态结构）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("jobId", jobId);
        o.addProperty("seq", seq);
        o.addProperty("action", action);
        o.add("params", params);
        o.addProperty("state", state.id());
        o.addProperty("progress", progress);
        if (progressMessage != null) {
            o.addProperty("progressMessage", progressMessage);
        }
        if (runId != null) {
            o.addProperty("runId", runId);
        }
        if (result != null) {
            o.add("result", result);
        }
        if (error != null) {
            o.add("error", error);
        }
        o.addProperty("submittedAt", submittedAt);
        if (startedAt != null) {
            o.addProperty("startedAt", startedAt);
        }
        if (endedAt != null) {
            o.addProperty("endedAt", endedAt);
        }
        return o;
    }
}
