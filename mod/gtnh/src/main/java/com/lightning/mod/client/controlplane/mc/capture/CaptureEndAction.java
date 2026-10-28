package com.lightning.mod.client.controlplane.mc.capture;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@code capture.end}（forensic，同步）：释放捕获会话（contract.md §7.3）。
 *
 * <p>
 * <b>幂等</b>：没有进行中的会话时也返回成功（{@code idempotent:true}），使调用方可以无条件在
 * 收尾路径上调用它，不用先查状态——无人值守流程里「先查再放」的写法迟早会因为中间失败而漏放。
 * 释放后世界写动作恢复放行。
 */
public final class CaptureEndAction implements ControlAction {

    @Override
    public JsonObject execute(ActionContext ctx) {
        String jobId = ctx.job() == null ? null
            : ctx.job()
                .jobId();
        String action = ctx.job() == null ? "capture.end"
            : ctx.job()
                .action();
        JsonObject o = CaptureActions.end(jobId, action);
        o.addProperty("requiredTier", Tier.FORENSIC.id());
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            Boolean.TRUE.equals(
                o.get("wasArmed")
                    .getAsBoolean()) ? "捕获会话结束（世界写动作恢复）" : "捕获会话结束（无会话，幂等）",
            CaptureActions.status());
        return o;
    }
}
