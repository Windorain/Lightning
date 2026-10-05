package com.lightning.mod.client.controlplane.core;

import java.util.function.Consumer;

import com.google.gson.JsonObject;

/**
 * 默认作业执行器：查动作表 → 建 {@link ActionContext} → 执行 → 收尾写 manifest。
 *
 * <p>
 * 这是 core 层与 mc 层动作实现的接缝：mc 层只注册 {@link ControlAction}，
 * 执行路径（含 run 目录与 manifest 落盘）全部由本类统一，避免每个动作各写一遍收尾逻辑。
 */
public final class ActionJobExecutor implements JobExecutor {

    private final ActionRegistry actions;
    private final ArtifactStore artifacts;
    private final EventStream events;
    private final Consumer<String> logger;

    /**
     * @param actions   动作表
     * @param artifacts 产物仓库，可为 null（仅限不需要产物的装配，如纯 ping 演示）
     * @param events    事件流水，可为 null
     * @param logger    日志口，可为 null
     */
    public ActionJobExecutor(ActionRegistry actions, ArtifactStore artifacts, EventStream events,
        Consumer<String> logger) {
        this.actions = actions;
        this.artifacts = artifacts;
        this.events = events;
        this.logger = logger;
    }

    @Override
    public JsonObject execute(Job job) {
        if (actions == null) {
            throw new CpException(ErrorCodes.EXEC_FAILED, "未装配动作注册表");
        }
        ActionRegistry.Entry entry = actions.lookup(job.action());
        if (entry == null) {
            throw CpException.unknown("动作 " + job.action());
        }
        ActionContext ctx = new ActionContext(job, job.params(), artifacts, events, logger);
        JsonObject result = entry.action()
            .execute(ctx);
        if (ctx.run() != null && artifacts != null) {
            artifacts.writeManifest(ctx.run());
        }
        return result == null ? new JsonObject() : result;
    }
}
