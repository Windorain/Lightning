package com.lightning.mod.client.controlplane.mc.capture;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CaptureSession;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.CpLog;

/**
 * 捕获会话（contract.md §7.3 的 {@code capture.begin}/{@code capture.end}）的公共实现。
 *
 * <p>
 * 单独抽出来的理由：{@code case.run} 的 capture 段与 {@code capture.begin}/{@code capture.end}
 * 两条入口必须<b>共用同一份</b>会话语义——重复 begin 的 {@code CP-STATE-001}、未 begin 的 end
 * 幂等 ok、以及「开场作业可穿透」的判定（见 {@link CaptureSession}）。若各写一份，
 * 「动作路径能开、用例路径开不了」这类不一致几乎必然出现。
 */
public final class CaptureActions {

    private CaptureActions() {}

    /** 会话开场（返回留痕对象）。 */
    public static JsonObject begin(String jobId, String action, String cameraCountNote) {
        String at = TimeSource.system()
            .isoNow();
        CaptureSession.begin(jobId, action, at, 0L);
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.capture-session/1");
        o.addProperty("began", Boolean.TRUE);
        o.addProperty("jobId", jobId);
        o.addProperty("action", action);
        o.addProperty("beganAt", at);
        o.addProperty("armed", Boolean.TRUE);
        o.addProperty("contractVersion", Contract.VERSION);
        if (cameraCountNote != null) {
            o.addProperty("note", cameraCountNote);
        }
        CpLog.info("捕获会话开场：job=%s action=%s（此后禁止一切世界写动作）", jobId, action);
        return o;
    }

    /**
     * 会话释放（幂等）。
     *
     * @return {@code {ended, wasArmed, armed}}
     */
    public static JsonObject end(String jobId, String action) {
        JsonObject before = CaptureSession.status();
        boolean armed = CaptureSession.isArmed();
        boolean released = CaptureSession.end();
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.capture-session/1");
        o.addProperty("ended", Boolean.valueOf(released));
        o.addProperty("wasArmed", Boolean.valueOf(armed));
        o.addProperty("idempotent", Boolean.valueOf(!released));
        o.addProperty("requestedBy", jobId);
        o.addProperty("action", action);
        o.addProperty("armed", Boolean.FALSE);
        o.addProperty("contractVersion", Contract.VERSION);
        if (!released) {
            // 未 begin 的 end：按契约幂等成功，但如实留痕「本来就没会话」
            o.addProperty("note", "没有进行中的捕获会话：capture.end 幂等成功（未做任何变更）");
            CpLog.info("捕获会话 end（无会话，幂等）: job=%s", jobId);
        } else {
            CpLog.info("捕获会话释放：job=%s（世界写动作恢复放行）", jobId);
        }
        o.add("previous", before);
        return o;
    }

    /** 结果里附带的会话快照。 */
    public static JsonObject status() {
        JsonObject o = CaptureSession.status();
        o.addProperty("requiredTier", Tier.FORENSIC.id());
        return o;
    }

    /** JSON 便捷读（结果拼装用）。 */
    public static String string(JsonObject o, String key) {
        return Json.optString(o, key, null);
    }
}
