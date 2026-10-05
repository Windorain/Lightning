package com.lightning.mod.client.controlplane.mc;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CaseFile;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code case.validate}（observe，同步）：解析用例文件并返回规范化执行计划。
 *
 * <p>
 * 参数：{@code file}（绝对路径，或相对 {@code <mcDataDir>/controlplane/cases/}）或 {@code inline}
 * （用例对象或 JSON 文本），二者互斥。返回规范化计划（分段列表、展开后的判据、期望证据、警告）
 * 或逐字段错误（{@code CP-VALID-002}）。
 *
 * <p>
 * 本动作不碰任何 MC 状态（只读文件 + 纯逻辑校验），因此调用它不会打断正在进行的场景动作。
 */
public final class CaseValidateAction implements ControlAction {

    private final ControlPlaneRuntime runtime;

    public CaseValidateAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        CaseFile file = CaseSources.resolve(ctx, runtime.casesRoot());
        JsonObject plan = CaseSources.plan(file);
        // 计划字段直接摊在 result 顶层：调用方只读 result.criteria / result.variants /
        // result.segments 就能核对计划，不必知道「计划嵌在哪个字段里」；同时保留一份 plan 便于整块取用。
        JsonObject o = plan.deepCopy();
        o.add("plan", plan);
        o.addProperty("caseId", file.id());
        o.addProperty("caseSha256", file.sha256());
        o.addProperty("source", ctx.has("file") ? "file" : "inline");
        o.addProperty("valid", true);
        o.addProperty(
            "validatedAt",
            TimeSource.system()
                .isoNow());
        JsonArray deferred = deferredSegments(file);
        if (deferred.size() > 0) {
            o.add("deferred", deferred);
            o.addProperty("deferredNote", "deferred: contract v1.x");
        }
        JsonArray warnings = Json.optArray(plan, "warnings");
        o.addProperty("warningCount", warnings == null ? 0 : warnings.size());
        return o;
    }

    /**
     * capture/cameras 段的延后说明（PR-1 只接受并透传，不解释、不执行）。
     *
     * <p>
     * 返回 {@code [{segment, reason}]}，reason 固定含 {@code deferred: contract v1.x} 字样，
     * 便于调用方按字符串判定——**不算失败**。
     */
    public static JsonArray deferredSegments(CaseFile file) {
        JsonArray out = new JsonArray();
        if (file == null) {
            return out;
        }
        com.google.gson.JsonElement capture = file.capture();
        if (capture != null && capture.isJsonObject()
            && capture.getAsJsonObject()
                .size() > 0) {
            out.add(entry("capture"));
        }
        JsonArray cameras = file.cameras();
        if (cameras != null && cameras.size() > 0) {
            out.add(entry("cameras"));
        }
        return out;
    }

    private static JsonObject entry(String segment) {
        JsonObject o = new JsonObject();
        o.addProperty("segment", segment);
        o.addProperty("reason", "deferred: contract v1.x");
        return o;
    }
}
