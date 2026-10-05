package com.lightning.mod.client.controlplane.core;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * v1 端点实现（contract.md §2）。所有端点都在这里注册进 {@link Router}，数据源按构造注入。
 *
 * <table>
 * <caption>端点清单</caption>
 * <tr>
 * <td>GET /cp/v1/about</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/actions</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>POST /cp/v1/actions/{name}</td>
 * <td>动作自描述</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/jobs/{id}</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/events</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/logs/tail</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/artifacts/{runId}</td>
 * <td>observe</td>
 * </tr>
 * <tr>
 * <td>GET /cp/v1/artifacts/{runId}/{path...}</td>
 * <td>observe</td>
 * </tr>
 * </table>
 *
 * <p>
 * 动作提交默认异步（202 + jobId）；{@code ?sync=true&timeoutMs=N} 时阻塞至完成，
 * 超时仍返回 202 + jobId 且**不取消**动作（contract.md §2）。产物下载返回原始字节，
 * 其余一律 JSON 信封。
 */
public final class CoreEndpoints {

    /** {@code ?sync=true} 未给 {@code timeoutMs} 时的默认等待上限（毫秒）。 */
    public static final int DEFAULT_SYNC_TIMEOUT_MS = 30000;

    /** 请求体里由控制面自己消费、不传给动作实现的字段。 */
    public static final String[] CONTROL_FIELDS = { "confirm", "sync", "timeoutMs", "token" };

    /** mod/MC/Forge 版本等只能由 mc 层提供的信息，用回调补进 {@code /about}。 */
    public interface AboutContributor {

        /** 向 about 对象补充字段（如 {@code versions}、{@code enabled}、{@code managedWorld}）。 */
        void contribute(JsonObject about);
    }

    /** 服务运行态信息（{@code ControlPlaneServer} 或测试替身提供）。 */
    public interface ServerInfo {

        /** 是否运行中。 */
        boolean running();

        /** 实际绑定端口。 */
        int boundPort();

        /** 绑定地址。 */
        String bindAddress();

        /** 已运行毫秒数。 */
        long uptimeMillis();
    }

    private final Router router;
    private final ActionRegistry actions;
    private final JobQueue queue;
    private final JobRegistry jobs;
    private final EventStream events;
    private final ArtifactStore artifacts;
    private final Path logFile;
    private final AboutContributor aboutContributor;
    private final ServerInfo serverInfo;
    private final String contractVersion;
    private final Consumer<String> logger;

    private CoreEndpoints(Builder b) {
        this.router = b.router;
        this.actions = b.actions;
        this.queue = b.queue;
        this.jobs = b.jobs;
        this.events = b.events;
        this.artifacts = b.artifacts;
        this.logFile = b.logFile;
        this.aboutContributor = b.aboutContributor;
        this.serverInfo = b.serverInfo;
        this.contractVersion = b.contractVersion;
        this.logger = b.logger;
    }

    /** 新建构造器。 */
    public static Builder builder() {
        return new Builder();
    }

    /** 把全部 v1 端点注册进 {@link Router}。 */
    public void registerAll() {
        if (router == null) {
            throw new IllegalStateException("未注入 Router");
        }
        router.get(Contract.PREFIX + "/about", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return Router.Result.ok(about());
            }
        });
        router.get(Contract.PREFIX + "/actions", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return Router.Result.ok(actions == null ? emptyActions() : actions.describeAll());
            }
        });
        router.postAction(Contract.PREFIX + "/actions/{name}", actions, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return submitAction(req);
            }
        });
        router.get(Contract.PREFIX + "/jobs/{id}", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return getJob(req);
            }
        });
        router.get(Contract.PREFIX + "/events", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return listEvents(req);
            }
        });
        router.get(Contract.PREFIX + "/logs/tail", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return tailLog(req);
            }
        });
        router.get(Contract.PREFIX + "/artifacts/{runId}", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return artifactManifest(req);
            }
        });
        router.get(Contract.PREFIX + "/artifacts/{runId}/{path...}", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return downloadArtifact(req);
            }
        });
    }

    // ------------------------------------------------------------ 端点实现

    /** {@code GET /cp/v1/about}。 */
    public JsonObject about() {
        JsonObject o = new JsonObject();
        o.addProperty("contractVersion", contractVersion == null ? Contract.VERSION : contractVersion);
        o.addProperty("prefix", Contract.PREFIX);
        o.addProperty("enabled", true);
        if (serverInfo != null) {
            o.addProperty("running", serverInfo.running());
            o.addProperty("port", serverInfo.boundPort());
            o.addProperty("bind", serverInfo.bindAddress());
            o.addProperty("uptimeMs", serverInfo.uptimeMillis());
        }
        if (queue != null) {
            o.addProperty("busy", queue.isBusy());
            Job cur = queue.current();
            o.addProperty("currentJobId", cur == null ? null : cur.jobId());
            o.addProperty("pending", queue.pendingCount());
        }
        if (events != null) {
            JsonObject e = new JsonObject();
            e.addProperty("lastSeq", events.lastSeq());
            e.addProperty("buffered", events.size());
            e.addProperty("capacity", events.capacity());
            o.add("events", e);
        }
        if (jobs != null) {
            JsonObject j = new JsonObject();
            j.addProperty("lastSeq", jobs.lastSeq());
            j.add("counts", jobs.stateCounts());
            o.add("jobs", j);
        }
        if (aboutContributor != null) {
            aboutContributor.contribute(o);
        }
        return o;
    }

    private Router.Result submitAction(Router.Request req) {
        String name = req.pathParam("name");
        if (actions == null || actions.descriptor(name) == null) {
            reject(req, ErrorCodes.VALID_UNKNOWN, "未知动作: " + name);
            throw CpException.unknown("动作 " + name);
        }
        if (queue == null) {
            throw new CpException(ErrorCodes.STATE, "作业队列未装配");
        }
        JsonObject params = stripControlFields(req.body());
        Job job;
        try {
            // 调用方权限级随作业下发：case.run 含 cameras 段时按内容升格为 forensic
            // （case-file.md §4），判定只在 tick 线程的执行期可做，故必须带上这一级。
            job = queue.submit(name, params, req.tier());
        } catch (CpException e) {
            reject(req, e.code(), e.detail());
            throw e;
        }
        boolean sync = req.queryBool("sync", false);
        if (!sync) {
            return Router.Result.ok(202, job.toJson());
        }
        long timeout = req.queryLong("timeoutMs", DEFAULT_SYNC_TIMEOUT_MS);
        boolean done = job.await(Math.max(0L, timeout));
        if (done && job.state() == Job.State.FAILED) {
            // 运行期升格失败（如 case.run 含 cameras 段但只有 scene 级）要如实回 403，
            // 不能只在作业体内失败——否则同步调用方拿到 200 + 一个「看起来跑过了」的作业。
            JsonObject err = job.error();
            if (err != null && ErrorCodes.AUTH_INSUFFICIENT.equals(Json.optString(err, "code", null))) {
                throw new CpException(
                    ErrorCodes.AUTH_INSUFFICIENT,
                    Json.optString(err, "message", "权限级不足"),
                    Json.optObject(err, "context"),
                    ErrorCodes.httpStatus(ErrorCodes.AUTH_INSUFFICIENT));
            }
        }
        JsonObject data = job.toJson();
        if (!done) {
            data.addProperty("timedOut", true);
            data.addProperty("timeoutMs", timeout);
        }
        return Router.Result.ok(done ? 200 : 202, data);
    }

    private Router.Result getJob(Router.Request req) {
        String id = req.pathParam("id");
        Job job = jobs == null ? null : jobs.get(id);
        if (job == null) {
            throw new CpException(ErrorCodes.VALID_UNKNOWN, "未知作业: " + id, null, 404);
        }
        return Router.Result.ok(job.toJson());
    }

    private Router.Result listEvents(Router.Request req) {
        if (events == null) {
            throw new CpException(ErrorCodes.STATE, "事件流水未装配");
        }
        long since = req.queryLong("since", 0L);
        int limit = req.queryInt("limit", 0);
        JsonArray arr = events.since(since, limit);
        JsonObject o = new JsonObject();
        o.add("events", arr);
        o.addProperty("count", arr.size());
        o.addProperty("lastSeq", events.lastSeq());
        o.addProperty("since", since);
        return Router.Result.ok(o);
    }

    private Router.Result tailLog(Router.Request req) {
        if (logFile == null) {
            throw new CpException(ErrorCodes.STATE, "未配置日志文件路径");
        }
        int lines = req.queryInt("lines", LogTail.DEFAULT_LINES);
        try {
            return Router.Result.ok(LogTail.tail(logFile, lines));
        } catch (FileNotFoundException e) {
            throw new CpException(ErrorCodes.IO, "日志文件不存在: " + logFile, null, 404);
        } catch (IOException e) {
            throw CpException.io("读取日志失败: " + logFile, e);
        }
    }

    private Router.Result artifactManifest(Router.Request req) {
        if (artifacts == null) {
            throw new CpException(ErrorCodes.STATE, "产物仓库未装配");
        }
        String runId = req.pathParam("runId");
        ArtifactStore.Run run = artifacts.findRun(runId);
        if (run == null) {
            throw new CpException(ErrorCodes.IO, "run 不存在: " + runId, null, 404);
        }
        JsonObject o = new JsonObject();
        o.addProperty("runId", run.runId());
        o.addProperty("caseId", run.caseId());
        o.addProperty("jobSeq", run.jobSeq());
        o.addProperty("createdAt", run.createdAt());
        o.add("artifacts", run.artifactsJson());
        o.addProperty(
            "count",
            run.artifacts()
                .size());
        return Router.Result.ok(o);
    }

    private Router.Result downloadArtifact(Router.Request req) {
        if (artifacts == null) {
            throw new CpException(ErrorCodes.STATE, "产物仓库未装配");
        }
        String runId = req.pathParam("runId");
        String rel = req.pathParam("path");
        Path target = artifacts.resolveArtifact(runId, rel);
        if (target == null) {
            throw new CpException(ErrorCodes.IO, "产物不存在: " + runId + "/" + rel, null, 404);
        }
        try {
            return Router.Result.raw(Files.readAllBytes(target), Router.contentTypeOf(rel));
        } catch (IOException e) {
            throw CpException.io("读取产物失败: " + rel, e);
        }
    }

    // ------------------------------------------------------------ 工具

    /** 去掉控制面自己消费的字段，避免动作实现看到 {@code confirm}/{@code sync} 等。 */
    public static JsonObject stripControlFields(JsonObject body) {
        JsonObject out = new JsonObject();
        if (body == null) {
            return out;
        }
        outer: for (java.util.Map.Entry<String, JsonElement> e : body.entrySet()) {
            for (String control : CONTROL_FIELDS) {
                if (control.equals(e.getKey())) {
                    continue outer;
                }
            }
            out.add(e.getKey(), e.getValue());
        }
        return out;
    }

    private static JsonObject emptyActions() {
        JsonObject o = new JsonObject();
        o.addProperty("contractVersion", Contract.VERSION);
        o.addProperty("count", 0);
        o.add("actions", new JsonArray());
        return o;
    }

    private void reject(Router.Request req, String code, String why) {
        if (events != null) {
            events.append(
                EventStream.LEVEL_WARN,
                EventStream.Kinds.ACTION_REJECT,
                req.pathParam("name"),
                null,
                "拒绝动作 " + req.pathParam("name") + "：" + why,
                Json.object("code", code, "reason", why));
        }
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " 拒绝动作 " + req.pathParam("name") + ": " + code + " " + why);
        }
    }

    /** 端点注册构造器。 */
    public static final class Builder {

        private Router router;
        private ActionRegistry actions;
        private JobQueue queue;
        private JobRegistry jobs;
        private EventStream events;
        private ArtifactStore artifacts;
        private Path logFile;
        private AboutContributor aboutContributor;
        private ServerInfo serverInfo;
        private String contractVersion = Contract.VERSION;
        private Consumer<String> logger;

        /** 路由（必填）。 */
        public Builder router(Router r) {
            this.router = r;
            return this;
        }

        /** 动作表。 */
        public Builder actions(ActionRegistry a) {
            this.actions = a;
            return this;
        }

        /** 作业队列。 */
        public Builder queue(JobQueue q) {
            this.queue = q;
            return this;
        }

        /** 作业登记表。 */
        public Builder jobs(JobRegistry j) {
            this.jobs = j;
            return this;
        }

        /** 事件流水。 */
        public Builder events(EventStream e) {
            this.events = e;
            return this;
        }

        /** 产物仓库。 */
        public Builder artifacts(ArtifactStore a) {
            this.artifacts = a;
            return this;
        }

        /** 客户端日志文件（logs/tail 数据源）。 */
        public Builder logFile(Path f) {
            this.logFile = f;
            return this;
        }

        /** about 补充信息（版本等）。 */
        public Builder about(AboutContributor c) {
            this.aboutContributor = c;
            return this;
        }

        /** 服务运行态。 */
        public Builder serverInfo(ServerInfo i) {
            this.serverInfo = i;
            return this;
        }

        /** 契约版本。 */
        public Builder contractVersion(String v) {
            this.contractVersion = v;
            return this;
        }

        /** 日志口。 */
        public Builder logger(Consumer<String> l) {
            this.logger = l;
            return this;
        }

        /** 构造。 */
        public CoreEndpoints build() {
            return new CoreEndpoints(this);
        }
    }
}
