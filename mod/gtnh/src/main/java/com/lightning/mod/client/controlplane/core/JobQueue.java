package com.lightning.mod.client.controlplane.core;

import java.util.function.Consumer;

import com.google.gson.JsonObject;

/**
 * 单动作互斥作业队列（contract.md §1.7/§1.8）。
 *
 * <p>
 * 线程模型是这套设计的核心约束：HTTP 线程只做 {@link #submit}（入队即返回 jobId），
 * 真正的执行由客户端 tick 线程调用 {@link #drainOne()} 完成——1.7.10 里 MC 状态只能在客户端线程触碰。
 *
 * <p>
 * 互斥语义：同一时刻只允许一个动作在队（queued）或在跑（running）。执行中或队列非空时再提交
 * 一律 {@code CP-BUSY-001}（v1 没有声明可并发的动作）。同步等待由 {@link Job#await(long)} 在
 * HTTP 线程侧完成，超时不取消动作。
 */
public final class JobQueue {

    private final JobRegistry registry;
    private final EventStream events;
    private final TimeSource time;
    private final Consumer<String> logger;
    private final Object lock = new Object();

    private JobExecutor executor;
    private SteppingExecutor stepper;
    private Job current;

    /** 默认构造（后续用 {@link #setExecutor} 装配执行器）。 */
    public JobQueue(JobRegistry registry, EventStream events, TimeSource time, Consumer<String> logger) {
        this.registry = registry == null ? new JobRegistry() : registry;
        this.events = events;
        this.time = time == null ? TimeSource.system() : time;
        this.logger = logger;
    }

    /** 便捷构造：系统时钟。 */
    public JobQueue(JobRegistry registry, EventStream events, Consumer<String> logger) {
        this(registry, events, TimeSource.system(), logger);
    }

    /** 装配执行器（mc 层在启动时注入 {@link ActionJobExecutor}）。 */
    public void setExecutor(JobExecutor executor) {
        this.executor = executor;
    }

    /**
     * 装配步进执行器（跨 tick 动作）。装配后 {@link #drainOne()} 走步进语义：
     * running 态作业在每个 tick 继续推进，直到 {@link SteppingExecutor#step} 返回非 null。
     * 与 {@link #setExecutor} 互斥——装配步进器后同步执行器不再被调用。
     */
    public void setStepper(SteppingExecutor stepper) {
        this.stepper = stepper;
    }

    /**
     * 入队一个动作（HTTP 线程调用）。
     *
     * @return 已入队的作业（状态 queued）
     * @throws CpException CP-BUSY-001：已有动作在队或在跑
     */
    public Job submit(String action, JsonObject params) {
        return submit(action, params, Tier.OBSERVE);
    }

    /**
     * 入队一个动作（HTTP 线程调用），并记录提交方权限级。
     *
     * <p>
     * 权限级是 {@code case.run} 运行期升格检查（含 cameras 段的用例必须 forensic 调用，
     * case-file.md §4）的唯一数据来源：鉴权在 HTTP 线程完成，动作在 tick 线程执行，
     * 两者的桥就是作业对象上的这个字段。
     *
     * @param tier 提交方权限级；null 视为 {@link Tier#OBSERVE}
     * @throws CpException CP-BUSY-001：已有动作在队或在跑
     */
    public Job submit(String action, JsonObject params, Tier tier) {
        synchronized (lock) {
            if (current != null) {
                JsonObject ctx = new JsonObject();
                ctx.addProperty("busyJobId", current.jobId());
                ctx.addProperty("busyAction", current.action());
                ctx.addProperty(
                    "busyState",
                    current.state()
                        .id());
                throw new CpException(ErrorCodes.BUSY, "已有动作在执行：" + current.action(), ctx);
            }
            Job job = registry.create(action, params, time.isoNow(), tier);
            current = job;
            if (events != null) {
                events.append(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.ACTION_SUBMIT,
                    action,
                    job.jobId(),
                    "动作入队",
                    Json.copyObject(job.params()));
            }
            return job;
        }
    }

    /**
     * 排空/推进当前作业（tick 线程调用；每个 tick 调一次即可）。
     *
     * <p>
     * 同步模式（{@link #setExecutor}）：queued 作业在本调用内执行完。步进模式（{@link #setStepper}）：
     * 作业保持 running 跨 tick 推进，{@link SteppingExecutor#step} 返回非 null 才收尾。
     *
     * @return 本次是否真的推进了一个作业
     */
    public boolean drainOne() {
        Job job;
        boolean starting;
        synchronized (lock) {
            if (current == null) {
                return false;
            }
            job = current;
            starting = job.state() == Job.State.QUEUED;
            if (!starting && (job.state() != Job.State.RUNNING || stepper == null)) {
                return false;
            }
            if (starting) {
                job.markRunning(time.isoNow());
            }
        }
        if (starting) {
            emit(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_START, job, "动作开始", null);
        }
        try {
            JsonObject result;
            if (stepper != null) {
                result = stepper.step(job);
                if (result == null) {
                    return true; // 未完成，下个 tick 继续
                }
            } else {
                if (executor == null) {
                    throw new CpException(ErrorCodes.EXEC_FAILED, "未装配作业执行器");
                }
                result = executor.execute(job);
            }
            job.markDone(time.isoNow(), result);
            JsonObject data = new JsonObject();
            data.addProperty(
                "state",
                job.state()
                    .id());
            if (job.runId() != null) {
                data.addProperty("runId", job.runId());
            }
            emit(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_DONE, job, "动作完成", data);
        } catch (CpException e) {
            job.markFailed(time.isoNow(), e.toErrorJson());
            emit(EventStream.LEVEL_ERROR, EventStream.Kinds.ACTION_FAIL, job, "动作失败: " + e.detail(), e.toErrorJson());
            warn("动作失败 " + job.action() + "#" + job.jobId() + ": " + e.detail());
        } catch (Throwable t) {
            JsonObject err = new JsonObject();
            err.addProperty("code", ErrorCodes.EXEC_FAILED);
            err.addProperty("message", "动作执行异常: " + t);
            JsonObject ctx = new JsonObject();
            ctx.addProperty(
                "exception",
                t.getClass()
                    .getName());
            err.add("context", ctx);
            job.markFailed(time.isoNow(), err);
            emit(EventStream.LEVEL_ERROR, EventStream.Kinds.ACTION_FAIL, job, "动作异常: " + t, err);
            warn("动作异常 " + job.action() + "#" + job.jobId() + ": " + t);
        } finally {
            synchronized (lock) {
                if (job.isFinished()) {
                    current = null;
                }
            }
        }
        return true;
    }

    /** 是否有动作在队或在跑。 */
    public boolean isBusy() {
        synchronized (lock) {
            return current != null;
        }
    }

    /** 当前在队/在跑的作业；空闲时返回 null。 */
    public Job current() {
        synchronized (lock) {
            return current;
        }
    }

    /** 待执行作业数：0 或 1（互斥语义决定）。 */
    public int pendingCount() {
        synchronized (lock) {
            return current == null ? 0 : 1;
        }
    }

    /** 作业登记表。 */
    public JobRegistry registry() {
        return registry;
    }

    private void emit(String level, String kind, Job job, String message, JsonObject data) {
        if (events != null) {
            events.append(level, kind, job.action(), job.jobId(), message, data);
        }
    }

    private void warn(String message) {
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }
}
