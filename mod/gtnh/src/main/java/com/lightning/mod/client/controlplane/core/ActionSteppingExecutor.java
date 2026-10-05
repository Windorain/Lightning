package com.lightning.mod.client.controlplane.core;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

import com.google.gson.JsonObject;

/**
 * 步进作业执行器：{@link ActionJobExecutor} 的跨 tick 对应物。
 *
 * <p>
 * 每个作业在首个 step 创建独立 {@link ActionContext} 并跨 step 复用（run 目录、事件归属一致），
 * 作业收尾（done/failed）时统一写 manifest 并销毁上下文。同步注册的 {@link ControlAction}
 * 也兼容：首个 step 内一次执行完毕——mc 层因此只需装配这一个执行器。
 */
public final class ActionSteppingExecutor implements SteppingExecutor {

    private final ActionRegistry actions;
    private final ArtifactStore artifacts;
    private final EventStream events;
    private final Consumer<String> logger;

    private final Map<String, ActionContext> contexts = new HashMap<String, ActionContext>();

    /**
     * @param actions   动作表
     * @param artifacts 产物仓库，可为 null（仅限不需要产物的装配）
     * @param events    事件流水，可为 null
     * @param logger    日志口，可为 null
     */
    public ActionSteppingExecutor(ActionRegistry actions, ArtifactStore artifacts, EventStream events,
        Consumer<String> logger) {
        this.actions = actions;
        this.artifacts = artifacts;
        this.events = events;
        this.logger = logger;
    }

    @Override
    public JsonObject step(Job job) throws Exception {
        if (actions == null) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "未装配动作注册表");
        }
        ActionRegistry.Entry entry = actions.lookup(job.action());
        if (entry == null) {
            throw CpException.unknown("动作 " + job.action());
        }
        ActionContext ctx = contexts.get(job.jobId());
        if (ctx == null) {
            ctx = new ActionContext(job, job.params(), artifacts, events, logger);
            contexts.put(job.jobId(), ctx);
        }
        try {
            JsonObject result;
            boolean finished;
            if (entry.isStepping()) {
                result = entry.steppingAction()
                    .step(ctx);
                finished = result != null;
            } else {
                result = entry.action()
                    .execute(ctx);
                finished = true;
            }
            if (!finished) {
                return null; // 未完成，保留上下文，下个 tick 继续
            }
            if (ctx.run() != null && artifacts != null) {
                artifacts.writeManifest(ctx.run());
            }
            contexts.remove(job.jobId());
            return result == null ? new JsonObject() : result;
        } catch (Throwable t) {
            // 失败同样收尾：已产生的产物落 manifest，销毁上下文防泄漏
            if (ctx.run() != null && artifacts != null) {
                artifacts.writeManifest(ctx.run());
            }
            contexts.remove(job.jobId());
            throw t;
        }
    }

    /** 仍在进行的作业上下文数（测试与诊断用）。 */
    public int activeContexts() {
        return contexts.size();
    }
}
