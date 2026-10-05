package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 端到端（回环 HTTP）测试：{@link ControlPlaneServer} + {@link Router} + {@link CoreEndpoints} +
 * {@link JobQueue} 一起跑，验证契约 §2 的端点、鉴权、confirm、异步/同步作业、产物下载与日志 tail。
 *
 * <p>
 * 用 JDK 自带 {@code HttpURLConnection}，不引入任何 MC 依赖；服务绑定 0 端口（临时端口），
 * 因此可与其它测试并行。
 */
public class ControlPlaneServerTest {

    /** 一个 HTTP 响应。 */
    private static final class Resp {

        private final int status;
        private final String body;

        Resp(int status, String body) {
            this.status = status;
            this.body = body;
        }

        int status() {
            return status;
        }

        String body() {
            return body;
        }

        JsonObject json() {
            return Json.parseStrictObject(body);
        }
    }

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path dataDir;
    private TokenStore tokens;
    private EventStream events;
    private ArtifactStore store;
    private ActionRegistry actions;
    private JobRegistry jobs;
    private JobQueue queue;
    private Router router;
    private ControlPlaneServer server;
    private Path logFile;
    private Thread ticker;
    private volatile boolean ticking;

    @Before
    public void setUp() throws Exception {
        dataDir = tmp.newFolder("controlplane")
            .toPath();
        tokens = new TokenStore("obs", "scn", "for");
        events = new EventStream(dataDir.resolve("events.jsonl"), null);
        store = new ArtifactStore(dataDir.resolve("runs"), TimeSource.system(), null);
        actions = new ActionRegistry();
        jobs = new JobRegistry();
        queue = new JobQueue(jobs, events, null);

        actions.register(
            ActionDescriptor.builder("core.ping", Tier.OBSERVE)
                .description("存活回声")
                .optional("echo", ActionDescriptor.TYPE_STRING, "原样回显")
                .returns("{pong:true,echo}")
                .example("{\"echo\":\"hi\"}")
                .since("1.0")
                .build(),
            new ControlAction() {

                @Override
                public JsonObject execute(ActionContext ctx) {
                    JsonObject o = new JsonObject();
                    o.addProperty("pong", true);
                    o.addProperty("echo", ctx.optString("echo", ""));
                    return o;
                }
            });
        actions.register(
            ActionDescriptor.builder("world.rebuild", Tier.SCENE)
                .description("幂等重建托管世界")
                .returns("{world:{...}}")
                .build(),
            new ControlAction() {

                @Override
                public JsonObject execute(ActionContext ctx) {
                    ArtifactStore.Run run = ctx.beginRun("managed-world");
                    ctx.artifacts()
                        .writeText(run, "world/scene-manifest.json", "{\"blocks\":[]}", "scene-manifest");
                    ctx.emit(EventStream.Kinds.WORLD_REBUILD, "重建完成", Json.object("runId", run.runId()));
                    JsonObject o = new JsonObject();
                    o.addProperty("rebuilt", true);
                    o.addProperty("runId", run.runId());
                    return o;
                }
            });
        actions.register(
            ActionDescriptor.builder("test.slow", Tier.OBSERVE)
                .description("慢动作（同步超时用例）")
                .build(),
            new ControlAction() {

                @Override
                public JsonObject execute(ActionContext ctx) {
                    try {
                        Thread.sleep(300L);
                    } catch (InterruptedException e) {
                        Thread.currentThread()
                            .interrupt();
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty("slept", true);
                    return o;
                }
            });
        actions.register(
            ActionDescriptor.builder("test.fail", Tier.OBSERVE)
                .description("必然失败的动作")
                .build(),
            new ControlAction() {

                @Override
                public JsonObject execute(ActionContext ctx) {
                    throw new CpException(ErrorCodes.STATE, "世界未加载");
                }
            });

        queue.setExecutor(new ActionJobExecutor(actions, store, events, null));

        logFile = dataDir.resolve("logs/fml-client-latest.log");
        Files.createDirectories(logFile.getParent());
        Files.write(logFile, "line1\nline2\nline3\n".getBytes(StandardCharsets.UTF_8));

        router = new Router(tokens, events, null);
        CoreEndpoints.builder()
            .router(router)
            .actions(actions)
            .queue(queue)
            .jobs(jobs)
            .events(events)
            .artifacts(store)
            .logFile(logFile)
            .serverInfo(new CoreEndpoints.ServerInfo() {

                @Override
                public boolean running() {
                    return server != null && server.isRunning();
                }

                @Override
                public int boundPort() {
                    return server == null ? 0 : server.boundPort();
                }

                @Override
                public String bindAddress() {
                    return "127.0.0.1";
                }

                @Override
                public long uptimeMillis() {
                    return server == null ? 0L : server.uptimeMillis();
                }
            })
            .about(new CoreEndpoints.AboutContributor() {

                @Override
                public void contribute(JsonObject about) {
                    JsonObject versions = new JsonObject();
                    versions.addProperty("mod", "0.3");
                    versions.addProperty("minecraft", "1.7.10");
                    versions.addProperty("forge", "10.13.4.1614");
                    about.add("versions", versions);
                }
            })
            .build()
            .registerAll();

        server = new ControlPlaneServer(
            ControlPlaneServer.Config.builder()
                .port(0)
                .bind("127.0.0.1")
                .dataDir(dataDir)
                .tokens(tokens)
                .router(router)
                .events(events)
                .build());
        server.start();

        ticking = true;
        ticker = new Thread(new Runnable() {

            @Override
            public void run() {
                while (ticking) {
                    queue.drainOne();
                    try {
                        Thread.sleep(2L);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }, "cp-test-ticker");
        ticker.setDaemon(true);
        ticker.start();
    }

    @After
    public void tearDown() {
        ticking = false;
        if (ticker != null) {
            ticker.interrupt();
        }
        if (server != null) {
            server.stop();
        }
        // 释放 events.jsonl 句柄，避免 Windows 上 TemporaryFolder 清理失败
        events.close();
    }

    // ------------------------------------------------------------ HTTP 工具

    private String base() {
        return "http://127.0.0.1:" + server.boundPort();
    }

    private Resp request(String method, String path, String token, String body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base() + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        if (token != null) {
            c.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes(StandardCharsets.UTF_8));
            os.close();
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
        c.disconnect();
        return new Resp(status, text);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (n > 0) {
                bos.write(buf, 0, n);
            }
        }
        return bos.toByteArray();
    }

    private static JsonObject data(Resp r) {
        return r.json()
            .getAsJsonObject("data");
    }

    private String submitAndWait(String action, String token, String body) throws Exception {
        Resp submit = request("POST", Contract.PREFIX + "/actions/" + action, token, body);
        assertEquals(202, submit.status());
        String jobId = data(submit).get("jobId")
            .getAsString();
        for (int i = 0; i < 200; i++) {
            Resp job = request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null);
            assertEquals(200, job.status());
            String state = data(job).get("state")
                .getAsString();
            if ("done".equals(state) || "failed".equals(state)) {
                return jobId;
            }
            Thread.sleep(10L);
        }
        fail("作业未在 2 秒内结束: " + jobId);
        return jobId;
    }

    // ------------------------------------------------------------ 用例

    @Test
    public void serverWritesServerJsonAndAboutReportsContractInfo() throws Exception {
        assertTrue(server.isRunning());
        assertTrue(server.boundPort() > 0);

        Path serverJson = dataDir.resolve("server.json");
        assertTrue(Files.isRegularFile(serverJson));
        JsonObject sj = Json.parseStrictObject(new String(Files.readAllBytes(serverJson), StandardCharsets.UTF_8));
        assertEquals(
            server.boundPort(),
            sj.get("port")
                .getAsInt());
        assertEquals(
            Contract.VERSION,
            sj.get("contractVersion")
                .getAsString());
        assertEquals(
            "127.0.0.1",
            sj.get("bind")
                .getAsString());

        Resp unauth = request("GET", Contract.PREFIX + "/about", null, null);
        assertEquals(401, unauth.status());
        assertEquals(ErrorCodes.AUTH_MISSING, Envelope.errorCode(unauth.json()));

        Resp about = request("GET", Contract.PREFIX + "/about", "obs", null);
        assertEquals(200, about.status());
        JsonObject d = data(about);
        assertEquals(
            Contract.VERSION,
            d.get("contractVersion")
                .getAsString());
        assertEquals(
            server.boundPort(),
            d.get("port")
                .getAsInt());
        assertFalse(
            d.get("busy")
                .getAsBoolean());
        assertEquals(
            "1.7.10",
            d.getAsJsonObject("versions")
                .get("minecraft")
                .getAsString());
    }

    @Test
    public void actionsEndpointIsSelfDescribing() throws Exception {
        Resp r = request("GET", Contract.PREFIX + "/actions", "obs", null);
        assertEquals(200, r.status());
        JsonObject d = data(r);
        JsonArray list = d.getAsJsonArray("actions");
        assertEquals(4, list.size());
        JsonObject ping = null;
        for (int i = 0; i < list.size(); i++) {
            if ("core.ping".equals(
                list.get(i)
                    .getAsJsonObject()
                    .get("name")
                    .getAsString())) {
                ping = list.get(i)
                    .getAsJsonObject();
            }
        }
        assertNotNull(ping);
        assertEquals(
            "observe",
            ping.get("tier")
                .getAsString());
        assertFalse(
            ping.get("confirmRequired")
                .getAsBoolean());
        assertEquals(
            1,
            ping.getAsJsonArray("params")
                .size());
        assertEquals(
            1,
            ping.getAsJsonArray("examples")
                .size());
        assertEquals(
            "1.0",
            ping.get("since")
                .getAsString());
        assertTrue(
            ping.get("returns")
                .getAsString()
                .contains("pong"));

        // 可写级动作必须自描述为需要 confirm
        JsonObject rebuild = null;
        for (int i = 0; i < list.size(); i++) {
            if ("world.rebuild".equals(
                list.get(i)
                    .getAsJsonObject()
                    .get("name")
                    .getAsString())) {
                rebuild = list.get(i)
                    .getAsJsonObject();
            }
        }
        assertNotNull(rebuild);
        assertTrue(
            rebuild.get("confirmRequired")
                .getAsBoolean());
    }

    @Test
    public void asyncSubmitReturnsJobIdAndJobCompletesOnTickThread() throws Exception {
        Resp submit = request("POST", Contract.PREFIX + "/actions/core.ping", "obs", "{\"echo\":\"hi\"}");
        assertEquals(202, submit.status());
        JsonObject d = data(submit);
        assertNotNull(d.get("jobId"));
        String jobId = d.get("jobId")
            .getAsString();

        JsonObject job = null;
        for (int i = 0; i < 200; i++) {
            Resp r = request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null);
            assertEquals(200, r.status());
            job = data(r);
            if ("done".equals(
                job.get("state")
                    .getAsString())) {
                break;
            }
            Thread.sleep(10L);
        }
        assertNotNull(job);
        assertEquals(
            "done",
            job.get("state")
                .getAsString());
        assertEquals(
            "hi",
            job.getAsJsonObject("result")
                .get("echo")
                .getAsString());
        assertTrue(
            job.getAsJsonObject("result")
                .get("pong")
                .getAsBoolean());
        assertEquals(
            1.0d,
            job.get("progress")
                .getAsDouble(),
            1e-9);

        // confirm 等控制字段不会透传给动作
        assertFalse(
            job.getAsJsonObject("params")
                .has("confirm"));
    }

    @Test
    public void unknownJobIs404() throws Exception {
        Resp r = request("GET", Contract.PREFIX + "/jobs/j999", "obs", null);
        assertEquals(404, r.status());
        assertEquals(ErrorCodes.VALID_UNKNOWN, Envelope.errorCode(r.json()));
    }

    @Test
    public void sceneActionNeedsSceneTokenAndConfirm() throws Exception {
        Resp asObserve = request("POST", Contract.PREFIX + "/actions/world.rebuild", "obs", "{\"confirm\":true}");
        assertEquals(403, asObserve.status());
        assertEquals(ErrorCodes.AUTH_INSUFFICIENT, Envelope.errorCode(asObserve.json()));

        Resp noConfirm = request("POST", Contract.PREFIX + "/actions/world.rebuild", "scn", "{}");
        assertEquals(400, noConfirm.status());
        assertEquals(ErrorCodes.CONFIRM_REQUIRED, Envelope.errorCode(noConfirm.json()));

        String jobId = submitAndWait("world.rebuild", "scn", "{\"confirm\":true}");
        Resp job = request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null);
        assertEquals(
            "done",
            data(job).get("state")
                .getAsString());
        String runId = data(job).get("runId")
            .getAsString();
        assertNotNull(runId);
    }

    @Test
    public void busyQueueRejectsSecondSubmit() throws Exception {
        // 手工占住队列（不让 tick 线程排空），再提交应当 CP-BUSY-001
        ticking = false;
        ticker.interrupt();
        ticker.join(2000L);
        queue.submit("core.ping", new JsonObject());

        Resp second = request("POST", Contract.PREFIX + "/actions/core.ping", "obs", "{}");
        assertEquals(409, second.status());
        assertEquals(ErrorCodes.BUSY, Envelope.errorCode(second.json()));
        queue.drainOne();
    }

    @Test
    public void syncRequestBlocksUntilDone() throws Exception {
        Resp r = request(
            "POST",
            Contract.PREFIX + "/actions/core.ping?sync=true&timeoutMs=5000",
            "obs",
            "{\"echo\":\"sync\"}");
        assertEquals(200, r.status());
        JsonObject d = data(r);
        assertEquals(
            "done",
            d.get("state")
                .getAsString());
        assertEquals(
            "sync",
            d.getAsJsonObject("result")
                .get("echo")
                .getAsString());
        assertFalse(d.has("timedOut"));
    }

    @Test
    public void syncTimeoutReturns202WithJobIdAndDoesNotCancel() throws Exception {
        Resp r = request("POST", Contract.PREFIX + "/actions/test.slow?sync=true&timeoutMs=20", "obs", "{}");
        assertEquals(202, r.status());
        JsonObject d = data(r);
        String jobId = d.get("jobId")
            .getAsString();
        assertNotNull(jobId);
        assertTrue(
            d.get("timedOut")
                .getAsBoolean());

        // 动作未被取消：仍然会跑完
        JsonObject job = null;
        for (int i = 0; i < 200; i++) {
            job = data(request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null));
            if ("done".equals(
                job.get("state")
                    .getAsString())) {
                break;
            }
            Thread.sleep(10L);
        }
        assertNotNull(job);
        assertEquals(
            "done",
            job.get("state")
                .getAsString());
        assertTrue(
            job.getAsJsonObject("result")
                .get("slept")
                .getAsBoolean());
    }

    @Test
    public void failingActionIsReportedWithContractCode() throws Exception {
        String jobId = submitAndWait("test.fail", "obs", "{}");
        JsonObject job = data(request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null));
        assertEquals(
            "failed",
            job.get("state")
                .getAsString());
        assertEquals(
            ErrorCodes.STATE,
            job.getAsJsonObject("error")
                .get("code")
                .getAsString());
    }

    @Test
    public void artifactManifestDownloadAndTraversalGuard() throws Exception {
        String jobId = submitAndWait("world.rebuild", "scn", "{\"confirm\":true}");
        String runId = data(request("GET", Contract.PREFIX + "/jobs/" + jobId, "obs", null)).get("runId")
            .getAsString();

        Resp manifest = request("GET", Contract.PREFIX + "/artifacts/" + runId, "obs", null);
        assertEquals(200, manifest.status());
        JsonObject d = data(manifest);
        assertEquals(
            runId,
            d.get("runId")
                .getAsString());
        JsonArray artifacts = d.getAsJsonArray("artifacts");
        assertEquals(1, artifacts.size());
        JsonObject a = artifacts.get(0)
            .getAsJsonObject();
        assertEquals(
            "world/scene-manifest.json",
            a.get("path")
                .getAsString());
        assertEquals(
            Hashing.sha256HexUtf8("{\"blocks\":[]}"),
            a.get("sha256")
                .getAsString());

        Resp file = request("GET", Contract.PREFIX + "/artifacts/" + runId + "/world/scene-manifest.json", "obs", null);
        assertEquals(200, file.status());
        assertEquals("{\"blocks\":[]}", file.body());

        Resp missing = request("GET", Contract.PREFIX + "/artifacts/" + runId + "/nope.json", "obs", null);
        assertEquals(404, missing.status());
        assertEquals(ErrorCodes.IO, Envelope.errorCode(missing.json()));

        Resp unknownRun = request("GET", Contract.PREFIX + "/artifacts/no-such-run", "obs", null);
        assertEquals(404, unknownRun.status());

        Resp traversal = request("GET", Contract.PREFIX + "/artifacts/" + runId + "/../../tokens.json", "obs", null);
        assertTrue("路径穿越必须被拒，收到 " + traversal.status, traversal.status == 400 || traversal.status == 404);
        if (traversal.status == 400) {
            assertEquals(ErrorCodes.VALID_PARAM, Envelope.errorCode(traversal.json()));
        }
    }

    @Test
    public void logTailReadsInjectedFile() throws Exception {
        Resp r = request("GET", Contract.PREFIX + "/logs/tail?lines=2", "obs", null);
        assertEquals(200, r.status());
        JsonObject d = data(r);
        assertEquals(
            "line2\nline3",
            d.get("content")
                .getAsString());
        assertEquals(
            2,
            d.get("lines")
                .getAsInt());

        Resp missing = request("GET", Contract.PREFIX + "/logs/tail", "obs", null);
        assertEquals(200, missing.status());
        assertEquals(
            3,
            data(missing).get("lines")
                .getAsInt());
    }

    @Test
    public void eventsEndpointSupportsSinceAndLimit() throws Exception {
        submitAndWait("core.ping", "obs", "{}");
        Resp all = request("GET", Contract.PREFIX + "/events", "obs", null);
        assertEquals(200, all.status());
        JsonObject d = data(all);
        JsonArray arr = d.getAsJsonArray("events");
        assertTrue(arr.size() >= 3);
        long lastSeq = d.get("lastSeq")
            .getAsLong();
        assertTrue(lastSeq >= arr.size());

        long firstSeq = arr.get(0)
            .getAsJsonObject()
            .get("seq")
            .getAsLong();
        Resp tail = request("GET", Contract.PREFIX + "/events?since=" + firstSeq + "&limit=1", "obs", null);
        JsonArray tailArr = data(tail).getAsJsonArray("events");
        assertEquals(1, tailArr.size());
        assertTrue(
            tailArr.get(0)
                .getAsJsonObject()
                .get("seq")
                .getAsLong() > firstSeq);
    }

    @Test
    public void unknownEndpointAndMethodAreRejected() throws Exception {
        Resp r = request("GET", Contract.PREFIX + "/nope", "obs", null);
        assertEquals(404, r.status());
        Resp m = request("POST", Contract.PREFIX + "/about", "obs", "{}");
        assertEquals(405, m.status());
    }

    @Test
    public void optionsPreflightReturns204() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base() + Contract.PREFIX + "/about").openConnection();
        c.setRequestMethod("OPTIONS");
        assertEquals(204, c.getResponseCode());
        assertEquals("*", c.getHeaderField("Access-Control-Allow-Origin"));
        c.disconnect();
    }

    @Test
    public void stopIsIdempotent() {
        server.stop();
        assertFalse(server.isRunning());
        server.stop();
        assertFalse(server.isRunning());
    }

    @Test
    public void portFallbackSkipsBusyPreferredPort() throws Exception {
        ServerSocket busy = new ServerSocket();
        busy.bind(new InetSocketAddress("127.0.0.1", 0));
        int preferred = busy.getLocalPort();
        ControlPlaneServer other = null;
        try {
            other = new ControlPlaneServer(
                ControlPlaneServer.Config.builder()
                    .port(preferred)
                    .bind("127.0.0.1")
                    .dataDir(
                        tmp.newFolder("cp2")
                            .toPath())
                    .tokens(tokens)
                    .router(router)
                    .events(events)
                    .build());
            other.start();
            assertTrue(other.isRunning());
            assertTrue("应回退到 preferred+ 而非 " + preferred + "，实际 " + other.boundPort(), other.boundPort() > preferred);
        } finally {
            if (other != null) {
                other.stop();
            }
            busy.close();
        }
    }
}
