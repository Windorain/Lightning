package com.lightning.mod.client.controlplane.mc;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.SteppingAction;

/**
 * 步进动作骨架：把「总超时 + 阶段超时 + 阶段名 + 收尾」这些每个动作都要做的事收在一处。
 *
 * <h2>契约</h2>
 * <ul>
 * <li>{@link #advance(ActionContext)} 每 tick 调用一次；返回 null 表示未完成、
 * 返回对象表示完成（该对象即作业 {@code result}）；</li>
 * <li>超时一律 {@code CP-EXEC-002}（区分总超时/阶段超时，并带阶段名与已耗时，便于不依赖日志定位）；</li>
 * <li>{@link #onFinish(ActionContext)} 在完成、失败、异常三条路径上都会被调用一次
 * （守卫还原、临时状态回收写在这里，不要写在 {@code advance} 的返回分支上）；</li>
 * <li>总超时默认 5 分钟、阶段超时默认 2 分钟，均可由动作参数 {@code totalTimeoutMs} /
 * {@code stageTimeoutMs} 覆盖（<b>不能</b>叫 {@code timeoutMs}：那是控制面自己消费的字段，
 * 会被 {@code CoreEndpoints} 从动作参数里剔除）；</li>
 * <li><b>一个实例只服务一个作业</b>：注册时用工厂（{@code ActionRegistry.registerStepping} 的
 * {@code Supplier} 重载），{@link com.lightning.mod.client.controlplane.core.ActionSteppingExecutor}
 * 每作业取一次实例。子类把作业级状态放在字段里即可，不必在 {@link #onBegin} 里手工清零——
 * 实例复用会被 {@link #step} 当场判为 {@code CP-EXEC-001}（宁可当场失败，也不要把上一次的结果
 * 再交一次）。</li>
 * </ul>
 */
public abstract class SteppingActionBase implements SteppingAction {

    /** 总超时默认值（毫秒）。 */
    public static final long DEFAULT_TOTAL_TIMEOUT_MS = 5L * 60L * 1000L;

    /**
     * 阶段超时默认值（毫秒）。
     *
     * <p>
     * 取 3 分钟：最长的一个阶段是「进入托管世界」（集成服启动 + 世界下发），GTNH 客户端上
     * 数十秒是常态，2 分钟偏紧；而任何单阶段真超过 3 分钟基本等价于卡死，应当以
     * {@code CP-EXEC-002} 暴露出来（阶段超时会带阶段名与耗时，不依赖翻日志）。
     */
    public static final long DEFAULT_STAGE_TIMEOUT_MS = 3L * 60L * 1000L;

    /** 覆盖总超时的参数名。 */
    public static final String PARAM_TOTAL_TIMEOUT = "totalTimeoutMs";

    /** 覆盖阶段超时的参数名。 */
    public static final String PARAM_STAGE_TIMEOUT = "stageTimeoutMs";

    private boolean begun;
    private boolean finished;
    private String begunJobId;
    private final ProgressThrottle throttle = new ProgressThrottle();
    private long startedAt;
    private long totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
    private long stageTimeoutMs = DEFAULT_STAGE_TIMEOUT_MS;
    private long stageStartedAt;
    private String stage = "init";

    @Override
    public final JsonObject step(ActionContext ctx) {
        try {
            guardJobIdentity(ctx);
            if (!begun) {
                begun = true;
                begunJobId = ctx.job() == null ? null
                    : ctx.job()
                        .jobId();
                startedAt = now();
                stageStartedAt = startedAt;
                totalTimeoutMs = positive(ctx.optLong(PARAM_TOTAL_TIMEOUT, DEFAULT_TOTAL_TIMEOUT_MS));
                stageTimeoutMs = positive(ctx.optLong(PARAM_STAGE_TIMEOUT, DEFAULT_STAGE_TIMEOUT_MS));
                onBegin(ctx);
            }
            checkTimeouts(ctx);
            JsonObject result = advance(ctx);
            if (result == null) {
                return null;
            }
            finished = true;
            return result;
        } catch (CpException e) {
            finished = true;
            throw e;
        } catch (Throwable t) {
            finished = true;
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "动作执行异常（阶段 " + stage + "）: " + t,
                Json.object(
                    "stage",
                    stage,
                    "stageElapsedMs",
                    Long.valueOf(now() - stageStartedAt),
                    "exception",
                    t.getClass()
                        .getName()));
        } finally {
            if (finished) {
                try {
                    onFinish(ctx);
                } catch (Throwable t) {
                    CpLog.warn("动作收尾异常（阶段 %s）: %s", stage, String.valueOf(t));
                }
            }
        }
    }

    /**
     * 实例复用防线（见类注释）。
     *
     * <p>
     * 已收尾的实例不该再被 step；被另一个作业 step 更不行——那意味着注册表把同一个有状态实例
     * 分给了多个作业，动作会把上一个作业的字段（段记录、runId、结论）当成自己的。此时宁可抛
     * {@code CP-EXEC-001}，也不要静默返回上一次的结果（实测事故：后三个 {@code case.run} 的 result
     * 与第一个逐字段相同、且没有自己的 run 目录，从结果 JSON 上看不出任何异常）。
     */
    private void guardJobIdentity(ActionContext ctx) {
        String jobId = ctx == null || ctx.job() == null ? null
            : ctx.job()
                .jobId();
        if (!begun) {
            return;
        }
        if (finished) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "步进动作实例已收尾，不能再推进（作业 " + jobId + "）：每个作业须取新实例",
                Json.object("jobId", jobId, "begunJobId", begunJobId, "stage", stage));
        }
        if (begunJobId != null && jobId != null && !begunJobId.equals(jobId)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "步进动作实例被跨作业复用（" + begunJobId
                    + " → "
                    + jobId
                    + "）："
                    + "注册时请用工厂重载 ActionRegistry.registerStepping(descriptor, Supplier)，让每个作业拿新实例",
                Json.object("jobId", jobId, "begunJobId", begunJobId, "stage", stage));
        }
    }

    /** 首个 step 时调用一次：解析参数、开 run 目录、进入首阶段。 */
    protected abstract void onBegin(ActionContext ctx) throws Exception;

    /** 每个 step 调用；返回 null 表示未完成。 */
    protected abstract JsonObject advance(ActionContext ctx) throws Exception;

    /** 收尾（完成/失败/异常都会调用一次）；默认无操作。 */
    protected void onFinish(ActionContext ctx) {}

    /** 切到新阶段（重置阶段超时计时）。 */
    protected final void enterStage(String name) {
        this.stage = name == null ? "unnamed" : name;
        this.stageStartedAt = now();
    }

    /** 当前阶段名。 */
    protected final String stage() {
        return stage;
    }

    /** 本阶段已经过的 tick 数（阶段计时用的近似值，按 50ms/tick 折算）。 */
    protected final long stageElapsedMs() {
        return now() - stageStartedAt;
    }

    /** 总超时（毫秒）。 */
    protected final long totalTimeoutMs() {
        return totalTimeoutMs;
    }

    /** 阶段超时（毫秒）。 */
    protected final long stageTimeoutMs() {
        return stageTimeoutMs;
    }

    /** 上报进度（0..1）；按 {@link ProgressThrottle} 节流，避免逐 tick 写事件。 */
    protected final void progress(ActionContext ctx, double fraction, String message) {
        if (!throttle.shouldReport(fraction)) {
            return;
        }
        try {
            ctx.progress(fraction, message);
        } catch (Throwable t) {
            CpLog.warn("进度上报失败: %s", String.valueOf(t));
        }
    }

    private void checkTimeouts(ActionContext ctx) {
        long now = now();
        long totalElapsed = now - startedAt;
        if (totalTimeoutMs > 0 && totalElapsed > totalTimeoutMs) {
            throw new CpException(
                ErrorCodes.EXEC_TIMEOUT,
                "动作总超时（阶段 " + stage + "，已耗时 " + totalElapsed + "ms > " + totalTimeoutMs + "ms）",
                Json.object(
                    "stage",
                    stage,
                    "elapsedMs",
                    Long.valueOf(totalElapsed),
                    "totalTimeoutMs",
                    Long.valueOf(totalTimeoutMs),
                    "jobId",
                    ctx.job() == null ? null
                        : ctx.job()
                            .jobId()));
        }
        long stageElapsed = now - stageStartedAt;
        if (stageTimeoutMs > 0 && stageElapsed > stageTimeoutMs) {
            throw new CpException(
                ErrorCodes.EXEC_TIMEOUT,
                "动作阶段超时（阶段 " + stage + "，已耗时 " + stageElapsed + "ms > " + stageTimeoutMs + "ms）",
                Json.object(
                    "stage",
                    stage,
                    "stageElapsedMs",
                    Long.valueOf(stageElapsed),
                    "stageTimeoutMs",
                    Long.valueOf(stageTimeoutMs)));
        }
    }

    private static long positive(long v) {
        return v > 0 ? v : 0L;
    }

    private static long now() {
        return System.currentTimeMillis();
    }
}
