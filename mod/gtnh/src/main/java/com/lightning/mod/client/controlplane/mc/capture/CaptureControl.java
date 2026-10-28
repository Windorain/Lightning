package com.lightning.mod.client.controlplane.mc.capture;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CaptureSession;
import com.lightning.mod.client.controlplane.core.Tier;

/**
 * 捕获会话在 mc 层的门控入口（contract.md §7.3）。
 *
 * <p>
 * 世界写动作的 {@code onBegin} 只需要调一句 {@link #assertWorldWriteAllowed(ActionContext)}——
 * 判定本身（含「开场作业可穿透」的语义）在 core 的 {@link CaptureSession} 里，单测覆盖。
 */
public final class CaptureControl {

    private CaptureControl() {}

    /** 调用方作业 id（无作业时为 null）。 */
    public static String jobId(ActionContext ctx) {
        return ctx == null || ctx.job() == null ? null
            : ctx.job()
                .jobId();
    }

    /**
     * 世界写动作入口的门控。
     *
     * @throws com.lightning.mod.client.controlplane.core.CpException CP-STATE-001：捕获会话期间由别的作业发起
     */
    public static void assertWorldWriteAllowed(ActionContext ctx) {
        CaptureSession.assertWorldWriteAllowed(jobId(ctx));
    }

    /** 会话快照（结果留痕）。 */
    public static JsonObject status() {
        JsonObject o = CaptureSession.status();
        o.addProperty("requiredTier", Tier.FORENSIC.id());
        return o;
    }
}
