package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 步进动作实现接口（mc 层实现，core 层只定义契约）。
 *
 * <p>
 * 与 {@link ControlAction} 的差别：{@link #step} 每个 tick 被调用一次，返回 {@code null}
 * 表示未完成、下个 tick 继续；返回非 null（可为空对象）表示成功完成。用于世界加载、
 * 静置等待、用例文件执行等跨 tick 过程——它们不能在单次调用内阻塞跑完。
 *
 * <p>
 * 每个作业有独立的 {@link ActionContext}（首个 step 创建，跨 step 复用，完成后销毁），
 * 因此 {@code beginRun} 的 run 目录、事件回调在整个作业期间一致。
 */
public interface SteppingAction {

    /**
     * 推进一步（tick 线程）。
     *
     * @param ctx 本作业的持久上下文
     * @return 完成时的结果 JSON；未完成返回 null
     * @throws CpException 契约级失败；其它异常记为 CP-EXEC-001
     */
    JsonObject step(ActionContext ctx) throws Exception;
}
