package com.lightning.mod.client.controlplane.mc;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CaseFile;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CriteriaEngine;
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
        JsonObject o = Json.copyObject(plan);
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
        // 判据类型的自描述（含引入版本 since）：调用方据此知道能写哪些判据类型、各自的参数形态，
        // 不必读源码或日志。与 CriteriaEngine.TYPES 同源，1.2 的两条判据 since=1.2。
        o.add("criteriaTypes", CriteriaEngine.typeCatalog());
        return o;
    }

    /**
     * 「延后段」清单（{@code deferred: contract v1.x} 口径）。
     *
     * <p>
     * 1.0 时 {@code capture}/{@code cameras} 落在这里（只接受并透传、不执行）；<b>1.1 起两段
     * 都是真实执行段</b>（{@link com.lightning.mod.client.controlplane.core.CaseValidator#SEGMENTS}
     * 已含它们），因此本方法恒返回空数组。保留方法本身是为了不动既有响应结构（契约 §13：v1 内
     * 只增不改）——调用方按「数组是否为空」判断即可，不必改代码。
     */
    public static JsonArray deferredSegments(CaseFile file) {
        return new JsonArray();
    }
}
