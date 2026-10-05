package com.lightning.mod.client.controlplane.core;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

import com.google.gson.JsonObject;

/**
 * 步进作业执行器：{@link ActionJobExecutor} 的跨 tick 对应物。
 *
 * <p>
 * 每个作业在首个 step 创建独立 {@link ActionContext} <b>与独立的动作实例</b>，两者一起跨 step
 * 复用（run 目录、事件归属、动作阶段状态一致），作业收尾（done/failed）时统一写 manifest 并销毁。
 * 同步注册的 {@link ControlAction} 也兼容：首个 step 内一次执行完毕——mc 层因此只需装配这一个执行器。
 *
 * <h2>为什么动作实例也必须按作业取</h2>
 * 步进实现对象就是作业级状态的容器（阶段、run 句柄、段记录、结论……）。注册表若只有一个实例，
 * 第二个作业会接着第一个作业的状态跑（实测：连续 4 个 {@code case.run} 后三个直接把第一个作业的
 * 结果又交了一次，且没有自己的 run 目录）。因此这里在作业首个 step 调
 * {@link ActionRegistry.Entry#newSteppingAction()} 取实例并<b>关在本作业内</b>，
 * 作业结束（成功或失败）随上下文一起丢弃。
 */
public final class ActionSteppingExecutor implements SteppingExecutor {

    /** 一个作业的执行会话：上下文 + 该作业专属的动作实例。 */
    private static final class Session {

        /** 作业上下文（跨 step 复用）。 */
        private final ActionContext ctx;

        /** 该作业专属的步进动作实例；同步注册项为 null。 */
        private final SteppingAction action;

        Session(ActionContext ctx, SteppingAction action) {
            this.ctx = ctx;
            this.action = action;
        }
    }

    private final ActionRegistry actions;
    private final ArtifactStore artifacts;
    private final EventStream events;
    private final Consumer<String> logger;

    private final Map<String, Session> sessions = new HashMap<String, Session>();

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
        Session session = sessions.get(job.jobId());
        if (session == null) {
            SteppingAction action = null;
            if (entry.isStepping()) {
                action = entry.newSteppingAction();
                if (action == null) {
                    throw new CpException(ErrorCodes.EXEC_FAILED, "步进动作工厂返回 null: " + job.action());
                }
            }
            session = new Session(new ActionContext(job, job.params(), artifacts, events, logger), action);
            sessions.put(job.jobId(), session);
        }
        ActionContext ctx = session.ctx;
        try {
            JsonObject result;
            boolean finished;
            if (entry.isStepping()) {
                result = session.action.step(ctx);
                finished = result != null;
            } else {
                result = entry.action()
                    .execute(ctx);
                finished = true;
            }
            if (!finished) {
                return null; // 未完成，保留上下文与动作实例，下个 tick 继续
            }
            if (ctx.run() != null && artifacts != null) {
                artifacts.writeManifest(ctx.run());
            }
            sessions.remove(job.jobId());
            return result == null ? new JsonObject() : result;
        } catch (Throwable t) {
            // 失败同样收尾：已产生的产物落 manifest，销毁会话（上下文 + 动作实例）防泄漏
            if (ctx.run() != null && artifacts != null) {
                artifacts.writeManifest(ctx.run());
            }
            sessions.remove(job.jobId());
            throw t;
        }
    }

    /** 仍在进行的作业会话数（测试与诊断用）。 */
    public int activeContexts() {
        return sessions.size();
    }
}
