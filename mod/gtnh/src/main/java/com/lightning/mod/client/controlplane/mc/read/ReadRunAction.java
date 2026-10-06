package com.lightning.mod.client.controlplane.mc.read;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.run}:run 产物清单读回（observe，同步）——截图的产物入 run 清单。
 *
 * <h2>为什么需要它</h2>
 * 任务单（issue #98）的原文：「截图读面已有 {@code shot.multi} 不重建，但<b>要确认其产物入 run 清单</b>」。
 * 确认有两种做法：①读代码 ②读端点。选②——{@code GET /cp/v1/artifacts/{runId}} 只回答「某一个 run」，
 * 而「全部截图 run 的产物是否都在各自清单里」需要枚举；本动作就是这个枚举，
 * 且它同时服务「Agent 要发现自己上一轮产出了什么」这个日常需求（需求书 §5 的判据）。
 *
 * <h2>它不做的事</h2>
 * 不下载产物内容（那是 {@code GET /cp/v1/artifacts/{runId}/{path}}）；
 * 不写任何东西；不缓存（每次实读 {@code manifest.json}，磁盘上被改过就如实反映）。
 */
public final class ReadRunAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.run";

    /** 默认返回的 run 条数。 */
    public static final int DEFAULT_LIMIT = 20;

    @Override
    public JsonObject execute(ActionContext ctx) {
        ArtifactStore store = ctx.artifacts();
        if (store == null) {
            throw new CpException(ErrorCodes.STATE, "产物仓库未装配，无法读 run 清单");
        }
        int limit = ctx.optInt("limit", DEFAULT_LIMIT);
        if (limit <= 0) {
            throw CpException.param("limit 非法", "limit", "须为正整数，收到 " + limit);
        }
        String onlyRunId = ctx.optString("runId", null);
        String roleFilter = ctx.optString("role", null);
        String caseFilter = ctx.optString("caseId", null);

        List<String> runIds;
        if (onlyRunId != null && !onlyRunId.trim()
            .isEmpty()) {
            runIds = new ArrayList<String>();
            runIds.add(onlyRunId.trim());
        } else {
            runIds = store.listRunIds();
            // 最新的在后：翻到前面（默认只回最近的 limit 个）
            java.util.Collections.reverse(runIds);
        }

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-run/1");
        o.addProperty("action", NAME);
        o.addProperty(
            "runsRoot",
            store.runsRoot()
                .toString());

        JsonArray runs = new JsonArray();
        int totalArtifacts = 0;
        int matched = 0;
        int visited = 0;
        for (String runId : runIds) {
            ArtifactStore.Run run = store.findRun(runId);
            if (run == null) {
                continue;
            }
            visited++;
            if (caseFilter != null && !caseFilter.trim()
                .isEmpty()
                && !caseFilter.trim()
                    .equals(run.caseId())) {
                continue;
            }
            if (matched >= limit) {
                continue;
            }
            matched++;
            runs.add(describeRun(run, roleFilter));
            totalArtifacts += run.artifacts()
                .size();
        }

        o.addProperty("count", runs.size());
        o.addProperty("visited", visited);
        o.addProperty("available", runIds.size());
        o.addProperty("limit", limit);
        o.addProperty("artifactCount", totalArtifacts);
        o.add("runs", runs);
        o.addProperty("note", "逐 run 实读磁盘 manifest.json（不缓存）；role 过滤只影响 artifacts 数组，不影响 run 本身是否入选");
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    /** 单个 run 的描述（清单 + 磁盘一致性核对）。 */
    private static JsonObject describeRun(ArtifactStore.Run run, String roleFilter) {
        JsonObject r = new JsonObject();
        r.addProperty("runId", run.runId());
        r.addProperty("caseId", run.caseId());
        r.addProperty("jobSeq", run.jobSeq());
        r.addProperty("createdAt", run.createdAt());
        r.addProperty(
            "dir",
            run.dir()
                .toString());
        r.addProperty(
            "manifestPresent",
            Boolean.valueOf(
                Files.isRegularFile(
                    run.dir()
                        .resolve("manifest.json"))));

        JsonArray arts = new JsonArray();
        int missing = 0;
        int sizeMismatch = 0;
        for (ArtifactStore.Artifact a : run.artifacts()
            .values()) {
            if (roleFilter != null && !roleFilter.trim()
                .isEmpty()
                && !roleFilter.trim()
                    .equals(a.role())) {
                continue;
            }
            JsonObject o = a.toJson();
            // 磁盘核对：清单里的 bytes 与磁盘是否一致（被外部改动过就如实暴露，
            // 这正是「证据能不能信」的判据；也是 shot.multi 产物入清单的确认口径）
            Path file = run.dir()
                .resolve(a.path());
            boolean exists = Files.isRegularFile(file);
            o.addProperty("exists", Boolean.valueOf(exists));
            if (exists) {
                try {
                    long onDisk = Files.size(file);
                    o.addProperty("diskBytes", Long.valueOf(onDisk));
                    if (onDisk != a.bytes()) {
                        o.addProperty("diskMismatch", true);
                        sizeMismatch++;
                    }
                } catch (java.io.IOException e) {
                    o.addProperty("diskError", String.valueOf(e));
                }
            } else {
                missing++;
            }
            arts.add(o);
        }
        r.add("artifacts", arts);
        r.addProperty("artifactCount", arts.size());
        r.addProperty("missingFiles", Integer.valueOf(missing));
        r.addProperty("sizeMismatch", Integer.valueOf(sizeMismatch));

        // 截图类产物单独归一组：任务单要求的「确认截图产物入 run 清单」是一个直接可读的判据
        JsonArray shots = new JsonArray();
        for (ArtifactStore.Artifact a : run.artifacts()
            .values()) {
            String p = a.path();
            if (p.startsWith("shots/")) {
                shots.add(
                    Json.object("path", p, "role", a.role(), "sha256", a.sha256(), "bytes", Long.valueOf(a.bytes())));
            }
        }
        r.add("shotArtifacts", shots);
        r.addProperty("shotArtifactCount", shots.size());
        return r;
    }

    /** 供外部工具：run 是否「清单与磁盘完全一致」。 */
    public static boolean consistent(JsonObject runEntry) {
        return runEntry != null && Json.optInt(runEntry, "missingFiles", 0) == 0
            && Json.optInt(runEntry, "sizeMismatch", 0) == 0
            && Json.optBool(runEntry, "manifestPresent", false);
    }
}
