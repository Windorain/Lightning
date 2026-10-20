package com.lightning.mod.client.controlplane.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

/**
 * 控制面常驻 HTTP 服务（contract.md §1.1-§1.3）。
 *
 * <p>
 * 职责被压到最小：绑定端口（含 {@code preferred+1..+127} 回退）、把请求交给 {@link Router}、
 * 写 {@code <mcDataDir>/controlplane/server.json}、幂等停止。所有端点语义都在 Router 与
 * {@link CoreEndpoints} 里，因此本类可以「起服务 → 打 HTTP → 断言」地整体测试。
 *
 * <p>
 * 线程边界（contract.md §1.8）：HTTP 线程只解析/鉴权/入队/读文件。服务线程池是有限的守护线程，
 * 不会阻塞 JVM 退出；真正的 MC 状态改动由 tick 线程的 {@code JobQueue.drainOne()} 完成。
 */
public final class ControlPlaneServer {

    /** 构造配置。 */
    public static final class Config {

        private int preferredPort = Contract.DEFAULT_PORT;
        private String bindAddress = Contract.DEFAULT_BIND;
        private Path dataDir;
        private String contractVersion = Contract.VERSION;
        private TokenStore tokens;
        private Router router;
        private EventStream events;
        private Consumer<String> logger;
        private int httpThreads = 4;

        private Config() {}

        /** 新建构造器。 */
        public static Builder builder() {
            return new Builder();
        }

        /** 首选端口。 */
        public int preferredPort() {
            return preferredPort;
        }

        /** 绑定地址。 */
        public String bindAddress() {
            return bindAddress;
        }

        /** 数据目录（{@code server.json} 落在这里）。 */
        public Path dataDir() {
            return dataDir;
        }

        /** 契约版本。 */
        public String contractVersion() {
            return contractVersion;
        }

        /** token 仓库。 */
        public TokenStore tokens() {
            return tokens;
        }

        /** 路由。 */
        public Router router() {
            return router;
        }

        /** 事件流水。 */
        public EventStream events() {
            return events;
        }

        /** 日志口。 */
        public Consumer<String> logger() {
            return logger;
        }

        /** HTTP 线程数（&le;0 表示用 JDK 默认的单线程调度）。 */
        public int httpThreads() {
            return httpThreads;
        }

        /** 配置构造器。 */
        public static final class Builder {

            private final Config c = new Config();

            /** 首选端口（默认 23057）。 */
            public Builder port(int p) {
                c.preferredPort = p;
                return this;
            }

            /** 绑定地址（默认 127.0.0.1）。 */
            public Builder bind(String addr) {
                c.bindAddress = addr;
                return this;
            }

            /** 数据目录（必填）。 */
            public Builder dataDir(Path dir) {
                c.dataDir = dir;
                return this;
            }

            /** 契约版本。 */
            public Builder contractVersion(String v) {
                c.contractVersion = v;
                return this;
            }

            /** token 仓库。 */
            public Builder tokens(TokenStore t) {
                c.tokens = t;
                return this;
            }

            /** 路由。 */
            public Builder router(Router r) {
                c.router = r;
                return this;
            }

            /** 事件流水。 */
            public Builder events(EventStream e) {
                c.events = e;
                return this;
            }

            /** 日志口。 */
            public Builder logger(Consumer<String> l) {
                c.logger = l;
                return this;
            }

            /** HTTP 线程数。 */
            public Builder httpThreads(int n) {
                c.httpThreads = n;
                return this;
            }

            /** 构造。 */
            public Config build() {
                return c;
            }
        }
    }

    /** 请求体大小上限（8 MiB）：控制面只收 JSON 参数，超过即拒。 */
    public static final int MAX_BODY_BYTES = 8 * 1024 * 1024;

    private final Config config;
    private final TimeSource time;

    private HttpServer httpServer;
    private ExecutorService executor;
    private int lastBoundPort;
    private long startedAtMillis;
    private JsonObject serverJson;

    /**
     * 进程正常退出时的 <b>best-effort 清理</b>（契约 §3.4 路径 5；由上层装配，本层不认识输入设施）。
     *
     * <p>
     * 【#166 DR-3】此前 {@link #installShutdownHook()} 的钩子**只调 {@code stop()}**，而机读面
     * （{@code input.state.lifecycle.cleanupPaths}）与契约 §3.4 都宣称「进程正常退出 ⇒ 尽力投递抬起」
     * ⇒ 自述说了一条没有代码的路径。现在钩子在**同一条**既有线程上先跑这里注册的清理，再停服务；
     * 它不新增订阅者、不抢线程，也不碰 GL（清理体只写 Java 事件队列）。
     */
    private volatile Runnable shutdownCleanup;

    /** 构造。 */
    public ControlPlaneServer(Config config) {
        this(config, TimeSource.system());
    }

    /** 全参构造（时间源可注入，便于测试）。 */
    public ControlPlaneServer(Config config, TimeSource time) {
        if (config == null) {
            throw new IllegalArgumentException("配置不能为 null");
        }
        this.config = config;
        this.time = time == null ? TimeSource.system() : time;
    }

    /**
     * 启动（幂等：已启动则直接返回）。
     *
     * @throws IOException 端口全部不可用或地址非法
     */
    public synchronized void start() throws IOException {
        if (httpServer != null) {
            return;
        }
        String bind = config.bindAddress == null || config.bindAddress.isEmpty() ? Contract.DEFAULT_BIND
            : config.bindAddress;
        if (!isLoopback(bind)) {
            warn("绑定非回环地址 " + bind + "（contract.md §1.2 要求显式配置并留痕）");
        }
        int preferred = clampPort(config.preferredPort);
        IOException last = null;
        for (int i = 0; i < Contract.MAX_PORT_ATTEMPTS; i++) {
            long candidate = (long) preferred + i;
            if (candidate > 65535L) {
                break;
            }
            int port = (int) candidate;
            HttpServer server = null;
            try {
                server = HttpServer.create(new InetSocketAddress(bind, port), 0);
                server.createContext("/", new RootHandler());
                ExecutorService pool = newExecutor();
                if (pool != null) {
                    server.setExecutor(pool);
                }
                server.start();
                this.httpServer = server;
                this.executor = pool;
                this.lastBoundPort = server.getAddress()
                    .getPort();
                this.startedAtMillis = time.millis();
                if (preferred != 0 && this.lastBoundPort != preferred) {
                    warn("首选端口 " + preferred + " 不可用，已绑定 " + this.lastBoundPort);
                }
                writeServerJson();
                emit(EventStream.Kinds.SERVER_START, "控制面已启动，端口 " + this.lastBoundPort);
                return;
            } catch (IOException e) {
                last = e;
                if (server != null) {
                    try {
                        server.stop(0);
                    } catch (RuntimeException ignored) {
                        // 启动失败后的清理失败无需上报
                    }
                }
                if (isBindFailure(e) && candidate < 65535L) {
                    continue;
                }
                throw e;
            }
        }
        throw last != null ? last
            : new IOException("控制面无法绑定端口（自 " + preferred + " 起已尝试 " + Contract.MAX_PORT_ATTEMPTS + " 次）");
    }

    /** 停止（幂等；可安全地挂到 JVM shutdown hook）。 */
    public synchronized void stop() {
        if (httpServer == null) {
            return;
        }
        try {
            httpServer.stop(0);
        } catch (RuntimeException e) {
            warn("停止 HTTP 服务异常: " + e);
        }
        httpServer = null;
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        emit(EventStream.Kinds.SERVER_STOP, "控制面已停止");
    }

    /**
     * 注册进程退出时的 best-effort 清理（在 {@link #installShutdownHook()} **之前**调用）。
     *
     * <p>
     * 由上层（{@code mc/ControlPlaneBootstrap}）注入输入设施的尽力释放：{@code core} 层不依赖
     * {@code mc} 层（全树 {@code core/*.java} 对 {@code mc.*} 零 import），因此这里只留一个
     * 与 {@code CoreEndpoints.AboutContributor} 同款的回调口。
     *
     * @param cleanup 清理体；允许抛（钩子整段吞掉并只 WARN 一次）；{@code null} = 无清理
     */
    public void setShutdownCleanup(Runnable cleanup) {
        this.shutdownCleanup = cleanup;
    }

    /**
     * 执行 shutdown hook 的**清理段**（钩子线程上跑；与 {@link #installShutdownHook()} 同一条线程）。
     *
     * <p>
     * <b>整段 try/catch，吞掉一切异常并只 WARN 一次</b>：退出路径上任何异常都不许阻止 {@code stop()}
     * 与 JVM 退出（best-effort 的语义就是「尽力，失败只留痕」）。异常只记类型与消息，不打印栈——
     * 退出时的栈没有诊断价值，反而可能拖慢退出。
     */
    public void runShutdownCleanup() {
        Runnable cleanup = shutdownCleanup;
        if (cleanup == null) {
            return;
        }
        try {
            cleanup.run();
        } catch (Throwable t) {
            warn("进程退出时的 best-effort 清理失败（已忽略，退出不受影响）: " + t);
        }
    }

    /** 注册 JVM 关闭钩子（contract.md §9：无 FML 客户端停止事件可用）。 */
    public void installShutdownHook() {
        Runtime.getRuntime()
            .addShutdownHook(new Thread(new Runnable() {

                @Override
                public void run() {
                    // best-effort 输入清理在前（§3.4 路径 5）：抬起事件越早写进队列越可能被消化
                    runShutdownCleanup();
                    stop();
                }
            }, "lightning-controlplane-shutdown"));
    }

    /** 是否运行中。 */
    public synchronized boolean isRunning() {
        return httpServer != null;
    }

    /** 实际绑定端口；未启动时返回上次绑定值（初始 0）。 */
    public synchronized int boundPort() {
        return lastBoundPort;
    }

    /** 绑定地址。 */
    public String bindAddress() {
        return config.bindAddress == null ? Contract.DEFAULT_BIND : config.bindAddress;
    }

    /** 启动时刻（毫秒）。 */
    public synchronized long startedAtMillis() {
        return startedAtMillis;
    }

    /** 已运行毫秒数；未启动返回 0。 */
    public synchronized long uptimeMillis() {
        return httpServer == null ? 0L : Math.max(0L, time.millis() - startedAtMillis);
    }

    /** {@code server.json} 路径。 */
    public Path serverJsonPath() {
        return serverJsonPath(config.dataDir);
    }

    /** 最近一次写入的 {@code server.json} 内容（未启动时为 null）。 */
    public synchronized JsonObject serverJson() {
        return serverJson == null ? null : Json.copyObject(serverJson);
    }

    /** 配置。 */
    public Config config() {
        return config;
    }

    /** {@code <dataDir>/server.json}。 */
    public static Path serverJsonPath(Path dataDir) {
        return Paths.get(dataDir == null ? "." : dataDir.toString(), "server.json");
    }

    // ------------------------------------------------------------ 内部

    private void writeServerJson() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", Contract.SCHEMA_SERVER);
        o.addProperty("port", lastBoundPort);
        o.addProperty("bind", bindAddress());
        o.addProperty("boundAt", time.isoNow());
        o.addProperty("contractVersion", config.contractVersion);
        o.addProperty("prefix", Contract.PREFIX);
        o.addProperty("pid", pid());
        Path file = serverJsonPath();
        try {
            Path parent = file.toAbsolutePath()
                .getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.write(
                file,
                Json.toPretty(o)
                    .getBytes(StandardCharsets.UTF_8));
            TokenStore.restrictToOwner(file);
            serverJson = o;
        } catch (IOException e) {
            warn("写 server.json 失败（服务继续运行）: " + e.getMessage());
            serverJson = o;
        }
    }

    private ExecutorService newExecutor() {
        if (config.httpThreads <= 0) {
            return null;
        }
        final AtomicInteger n = new AtomicInteger();
        ThreadFactory tf = new ThreadFactory() {

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "lightning-controlplane-http-" + n.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        };
        return Executors.newFixedThreadPool(config.httpThreads, tf);
    }

    private static long pid() {
        try {
            String name = java.lang.management.ManagementFactory.getRuntimeMXBean()
                .getName();
            int at = name.indexOf('@');
            return Long.parseLong(at > 0 ? name.substring(0, at) : name);
        } catch (RuntimeException e) {
            return -1L;
        }
    }

    private void emit(String kind, String message) {
        if (config.events != null) {
            config.events.append(
                EventStream.LEVEL_INFO,
                kind,
                null,
                null,
                message,
                Json.object("port", lastBoundPort, "bind", bindAddress()));
        }
    }

    private void warn(String message) {
        if (config.logger != null) {
            config.logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }

    private static int clampPort(int p) {
        if (p < 0) {
            return 0;
        }
        return Math.min(p, 65535);
    }

    private static boolean isLoopback(String addr) {
        try {
            return InetAddress.getByName(addr)
                .isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    private static boolean isBindFailure(IOException e) {
        Throwable t = e;
        while (t != null) {
            if (t instanceof BindException) {
                return true;
            }
            String m = t.getMessage();
            if (m != null) {
                String lower = m.toLowerCase(Locale.ROOT);
                if (lower.contains("address already in use") || lower.contains("eaddrinuse")
                    || lower.contains("cannot assign requested address")) {
                    return true;
                }
            }
            t = t.getCause();
        }
        return false;
    }

    /** 唯一处理器：把 HttpExchange 翻成 {@link Router.Request}，再把 {@link Router.Result} 写回去。 */
    private final class RootHandler implements HttpHandler {

        @Override
        public void handle(HttpExchange ex) throws IOException {
            try {
                addCors(ex);
                String method = ex.getRequestMethod();
                if ("OPTIONS".equalsIgnoreCase(method)) {
                    ex.sendResponseHeaders(204, -1);
                    return;
                }
                Router.Request req = buildRequest(ex);
                Router.Result res = config.router == null
                    ? Router.Result.error(503, ErrorCodes.EXEC_FAILED, "控制面路由未装配", null)
                    : config.router.handle(req);
                write(ex, res);
            } catch (CpException e) {
                write(ex, Router.Result.error(e.httpStatus(), e.code(), e.detail(), e.context()));
            } catch (Throwable t) {
                warn("HTTP 处理异常: " + t);
                write(ex, Router.Result.error(500, ErrorCodes.EXEC_FAILED, "HTTP 处理异常: " + t, null));
            } finally {
                ex.close();
            }
        }
    }

    private Router.Request buildRequest(HttpExchange ex) {
        URI uri = ex.getRequestURI();
        String rawPath = uri.getRawPath() == null ? "/" : uri.getRawPath();
        Map<String, String> query = parseQuery(uri.getRawQuery());
        String auth = ex.getRequestHeaders()
            .getFirst("Authorization");
        String token = bearer(auth);
        if (token == null) {
            token = Router.percentDecode(query.get("token"));
        }
        String body = readBody(ex);
        return Router.Request.builder()
            .method(ex.getRequestMethod())
            .path(rawPath)
            .query(query)
            .body(body)
            .token(token)
            .remote(
                ex.getRemoteAddress() == null ? null
                    : ex.getRemoteAddress()
                        .toString())
            .build();
    }

    private static String bearer(String header) {
        if (header == null) {
            return null;
        }
        String h = header.trim();
        if (h.regionMatches(true, 0, "Bearer ", 0, 7)) {
            String t = h.substring(7)
                .trim();
            return t.isEmpty() ? null : t;
        }
        return null;
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        if (rawQuery == null || rawQuery.isEmpty()) {
            return out;
        }
        for (String part : rawQuery.split("&")) {
            if (part.isEmpty()) {
                continue;
            }
            int eq = part.indexOf('=');
            String k = eq < 0 ? part : part.substring(0, eq);
            String v = eq < 0 ? "" : part.substring(eq + 1);
            String key = Router.percentDecode(k);
            if (!out.containsKey(key)) {
                out.put(key, Router.percentDecode(v));
            }
        }
        return out;
    }

    private static String readBody(HttpExchange ex) {
        try {
            InputStream in = ex.getRequestBody();
            if (in == null) {
                return null;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n == 0) {
                    continue;
                }
                if (bos.size() + n > MAX_BODY_BYTES) {
                    throw new CpException(
                        ErrorCodes.VALID_PARAM,
                        "请求体过大（上限 " + MAX_BODY_BYTES + " 字节）",
                        new Fields().add("body", "过大")
                            .toContext());
                }
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw CpException.io("读取请求体失败", e);
        }
    }

    private void write(HttpExchange ex, Router.Result res) throws IOException {
        byte[] body = res.rawBody() != null ? res.rawBody() : Json.toBytes(res.envelope());
        ex.getResponseHeaders()
            .set("Content-Type", res.contentType());
        ex.getResponseHeaders()
            .set("Cache-Control", "no-store");
        if (res.status() == 204) {
            ex.sendResponseHeaders(204, -1);
            return;
        }
        ex.sendResponseHeaders(res.status(), body.length);
        OutputStream os = ex.getResponseBody();
        try {
            os.write(body);
            os.flush();
        } finally {
            os.close();
        }
    }

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
}
