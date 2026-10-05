package com.lightning.mod.client.controlplane.mc;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Job;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code core.status}（observe，同步）：版本、世界加载态、忙闲、事件流水游标、最近作业。
 *
 * <p>
 * 本动作是「调用方先看清现场」的入口：拿到它就能决定是重进世界、先回滚，还是干等忙闲。
 */
public final class StatusAction implements ControlAction {

    /** 返回的最近作业条数。 */
    public static final int RECENT_JOBS = 5;

    private final ControlPlaneRuntime runtime;

    public StatusAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        JsonObject o = new JsonObject();
        o.addProperty("contractVersion", Contract.VERSION);
        o.add("versions", VersionInfo.aboutVersions());

        Minecraft mc = WorldRuntime.mc();
        JsonObject world = WorldDescriber.describe(mc);
        o.add("world", world);

        JsonObject server = new JsonObject();
        if (runtime != null && runtime.server() != null) {
            server.addProperty(
                "running",
                runtime.server()
                    .isRunning());
            server.addProperty(
                "port",
                runtime.server()
                    .boundPort());
            server.addProperty(
                "bind",
                runtime.server()
                    .bindAddress());
            server.addProperty(
                "uptimeMs",
                runtime.server()
                    .uptimeMillis());
        } else {
            server.addProperty("running", false);
        }
        o.add("server", server);

        o.addProperty("busy", runtime != null && runtime.busy());
        Job cur = runtime == null ? null : runtime.currentJob();
        o.addProperty("currentJobId", cur == null ? null : cur.jobId());
        o.addProperty("currentAction", cur == null ? null : cur.action());
        o.addProperty(
            "pending",
            runtime == null || runtime.queue() == null ? 0
                : runtime.queue()
                    .pendingCount());

        String probe = ProbeActivity.firstActive(mc);
        o.addProperty("probeActive", probe != null);
        o.addProperty("probe", probe);
        o.addProperty("managedWorld", mc != null && mc.theWorld != null && Json.optBool(world, "managed", false));

        if (runtime != null && runtime.events() != null) {
            JsonObject ev = new JsonObject();
            ev.addProperty(
                "lastSeq",
                runtime.events()
                    .lastSeq());
            ev.addProperty(
                "buffered",
                runtime.events()
                    .size());
            ev.addProperty(
                "capacity",
                runtime.events()
                    .capacity());
            ev.addProperty(
                "serverStartSeq",
                runtime.events()
                    .countKind(EventStream.Kinds.SERVER_START));
            o.add("events", ev);
        }
        if (runtime != null && runtime.jobs() != null) {
            JsonObject jobs = new JsonObject();
            jobs.addProperty(
                "lastSeq",
                runtime.jobs()
                    .lastSeq());
            jobs.addProperty(
                "count",
                runtime.jobs()
                    .size());
            jobs.add(
                "counts",
                runtime.jobs()
                    .stateCounts());
            jobs.add(
                "recent",
                runtime.jobs()
                    .recent(RECENT_JOBS));
            o.add("jobs", jobs);
        }

        JsonObject snapshots = new JsonObject();
        if (runtime != null) {
            List<String> ids = SnapshotStore.listIds(runtime.mcDataDir());
            snapshots.addProperty("count", ids.size());
            snapshots.addProperty("latest", ids.isEmpty() ? null : ids.get(ids.size() - 1));
            Path root = runtime.snapshotsRoot();
            snapshots.addProperty("root", root.toString());
            snapshots.addProperty("rootExists", Files.isDirectory(root));
        }
        o.add("snapshots", snapshots);

        JsonObject paths = new JsonObject();
        if (runtime != null) {
            paths.addProperty(
                "dataDir",
                runtime.dataDir()
                    .toString());
            paths.addProperty(
                "casesRoot",
                runtime.casesRoot()
                    .toString());
            paths.addProperty(
                "runsRoot",
                runtime.artifacts() == null ? null
                    : runtime.artifacts()
                        .runsRoot()
                        .toString());
        }
        o.add("paths", paths);

        if (runtime != null && runtime.artifacts() != null) {
            JsonArray runs = new JsonArray();
            List<String> ids = runtime.artifacts()
                .listRunIds();
            int from = Math.max(0, ids.size() - 5);
            for (int i = ids.size() - 1; i >= from; i--) {
                runs.add(ids.get(i));
            }
            o.add("recentRuns", runs);
        }
        return o;
    }
}
