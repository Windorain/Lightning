package com.lightning.mod.client.controlplane.mc.capture;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@code capture.begin} / {@code capture.end}（forensic，同步）：捕获会话包围（contract.md §4.1）。
 *
 * <h2>语义</h2>
 * <ul>
 * <li>{@code begin} 之后<b>一切世界写动作</b>（{@code world.rebuild}/{@code world.snapshot}/
 * {@code world.rollback} 以及 {@code case.run} 的 build 段）被拒 {@code CP-STATE-001}；</li>
 * <li>重复 {@code begin} 也是 {@code CP-STATE-001}（不做隐式续期：否则「谁开的会话」再也说不清）；</li>
 * <li>未 {@code begin} 的 {@code end} <b>幂等成功</b>（返回值里如实标注 {@code idempotent:true}
 * 并保留 {@code previous} 快照）；</li>
 * <li>开场作业自身可以穿透（{@code case.run} 的 build 段必须能在自己开的会话里写世界）——
 * 判定在 {@link com.lightning.mod.client.controlplane.core.CaptureSession#assertWorldWriteAllowed}。</li>
 * </ul>
 *
 * <p>
 * 两个动作都注册为<b>同步</b>动作：它们只翻转一个内存标志，没有跨 tick 阶段。
 * 之所以仍能被 tick 排空器执行，是因为 {@code ActionSteppingExecutor} 兼容同步注册项。
 */
public final class CaptureBeginAction implements ControlAction {

    @Override
    public JsonObject execute(ActionContext ctx) {
        String jobId = ctx.job() == null ? null
            : ctx.job()
                .jobId();
        String action = ctx.job() == null ? "capture.begin"
            : ctx.job()
                .action();
        JsonObject o = CaptureActions.begin(jobId, action, "此后一切世界写动作被拒 CP-STATE-001，直到 capture.end");
        o.addProperty("requiredTier", Tier.FORENSIC.id());
        ctx.emit(EventStream.LEVEL_INFO, EventStream.Kinds.CASE_SEGMENT, "捕获会话开始（世界写动作已封锁）", CaptureActions.status());
        return o;
    }
}
