package com.lightning.mod.server.web;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.lightning.mod.core.export.PendingDumpFiles;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import cpw.mods.fml.common.FMLLog;

/**
 * SDE 内嵌 HTTP：classpath 静态工作台 + {@code /api/v1/*} REST。
 * 1.7.10 无 {@code MinecraftServer.addScheduledTask}；API 仅读写 {@code structure_exports/} 与工作区 JSON，在 HTTP 线程执行并对工作区加锁。
 */
public final class SdeWebServer {

    private static final Gson GSON_PRETTY = new GsonBuilder().setPrettyPrinting()
        .create();
    private static final Gson GSON = new Gson();
    private static final String WORKSPACE_FILE = "_sde_workspace.json";
    private static final String WEB_ROOT_PREFIX = "assets/lightning/web/";
    /** 工作区 JSON 并发读写（HTTP 线程直接访问文件，1.7.10 无 MC 主线程队列 API） */
    private static final Object WORKSPACE_IO_LOCK = new Object();

    /** 首选端口被占用时，依次尝试 preferred、preferred+1、… 的次数上限 */
    private static final int MAX_PORT_BIND_ATTEMPTS = 128;

    private static SdeWebServer instance;

    private HttpServer httpServer;
    private String token = "";
    private int port;

    private SdeWebServer() {}

    public static synchronized SdeWebServer getInstance() {
        if (instance == null) {
            instance = new SdeWebServer();
        }
        return instance;
    }

    public static synchronized void start(int port, String authToken) throws IOException {
        getInstance().doStart(port, authToken == null ? "" : authToken);
    }

    public static synchronized void stopServer() {
        if (instance != null && instance.httpServer != null) {
            instance.httpServer.stop(0);
            instance.httpServer = null;
        }
    }

    public static boolean isRunning() {
        return instance != null && instance.httpServer != null;
    }

    public static int getBoundPort() {
        return instance == null ? 0 : instance.port;
    }

    public static String getToken() {
        return instance == null ? "" : instance.token;
    }

    private void doStart(int preferredPort, String authToken) throws IOException {
        stopServer();
        this.token = authToken;
        int base = Math.max(1, Math.min(preferredPort, 65535));
        IOException last = null;
        for (int i = 0; i < MAX_PORT_BIND_ATTEMPTS; i++) {
            long candidate = (long) base + i;
            if (candidate > 65535L) {
                break;
            }
            int tryPort = (int) candidate;
            try {
                HttpServer server = HttpServer.create(new InetSocketAddress(tryPort), 0);
                server.createContext("/", new RootHandler());
                server.setExecutor(null);
                server.start();
                this.httpServer = server;
                this.port = tryPort;
                if (tryPort != base) {
                    FMLLog.info("[SDE] Web: 首选端口 %d 不可用，已绑定 %d", base, tryPort);
                }
                return;
            } catch (IOException e) {
                last = e;
                if (isBindFailure(e) && i < MAX_PORT_BIND_ATTEMPTS - 1 && candidate < 65535L) {
                    continue;
                }
                throw e;
            }
        }
        if (last != null) {
            throw last;
        }
        throw new IOException("SDE Web: 无法绑定端口（自 " + base + " 起已尝试至 65535 或达 " + MAX_PORT_BIND_ATTEMPTS + " 次）");
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
                if (lower.contains("address already in use") || lower.contains("in use")
                    || lower.contains("eaddrinuse")) {
                    return true;
                }
            }
            t = t.getCause();
        }
        return false;
    }

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, OPTIONS");
        ex.getResponseHeaders()
            .add("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }

    private boolean isAuthorized(HttpExchange ex) {
        if (token.isEmpty()) return true;
        String auth = ex.getRequestHeaders()
            .getFirst("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            return token.equals(
                auth.substring(7)
                    .trim());
        }
        String q = ex.getRequestURI()
            .getQuery();
        if (q != null) {
            for (String part : q.split("&")) {
                int i = part.indexOf('=');
                if (i > 0 && "token".equals(part.substring(0, i))) {
                    try {
                        return token.equals(java.net.URLDecoder.decode(part.substring(i + 1), "UTF-8"));
                    } catch (java.io.UnsupportedEncodingException e) {
                        return false;
                    }
                }
            }
        }
        return false;
    }

    private final class RootHandler implements HttpHandler {

        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            try {
                if ("OPTIONS".equals(ex.getRequestMethod())) {
                    ex.sendResponseHeaders(204, -1);
                    return;
                }
                String path = ex.getRequestURI()
                    .getPath();
                if (path == null) path = "/";
                if (path.startsWith("/api/v1")) {
                    if (!isAuthorized(ex)) {
                        sendJson(ex, 401, error("未授权"));
                        return;
                    }
                    handleApi(ex, path);
                } else {
                    handleStatic(ex, path);
                }
            } catch (Exception e) {
                sendJson(ex, 500, error(e.getMessage()));
            }
        }
    }

    private static JsonObject error(String msg) {
        JsonObject o = new JsonObject();
        o.addProperty("error", msg == null ? "error" : msg);
        return o;
    }

    /**
     * 允许 UTF-8 文件名（含中文）；仍禁止路径分隔与 “..”，{@link #readExportJson} 再用 canonical 路径防穿越。
     */
    private static boolean isSafeExportFileName(String name) {
        if (name == null || name.isEmpty()) return false;
        if (name.contains("..") || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) return false;
        if (name.indexOf('\0') >= 0) return false;
        if (!name.endsWith(".json")) return false;
        if (WORKSPACE_FILE.equals(name) || PendingDumpFiles.FILE_NAME.equals(name)) return false;
        return true;
    }

    private void handleApi(HttpExchange ex, String path) throws Exception {
        String method = ex.getRequestMethod();
        if ("GET".equals(method) && "/api/v1/ping".equals(path)) {
            JsonObject o = new JsonObject();
            o.addProperty("ok", true);
            sendJson(ex, 200, o);
            return;
        }
        if ("GET".equals(method) && "/api/v1/exports".equals(path)) {
            JsonArray files = listExportFiles();
            JsonObject o = new JsonObject();
            o.add("files", files);
            sendJson(ex, 200, o);
            return;
        }
        if ("GET".equals(method) && path.startsWith("/api/v1/exports/")) {
            String name = path.substring("/api/v1/exports/".length());
            if (!isSafeExportFileName(name)) {
                sendJson(ex, 400, error("非法文件名"));
                return;
            }
            JsonElement data = readExportJson(name);
            sendJson(ex, 200, data);
            return;
        }
        if ("GET".equals(method) && "/api/v1/workspace/document".equals(path)) {
            JsonObject doc;
            synchronized (WORKSPACE_IO_LOCK) {
                doc = readWorkspaceDocument();
            }
            sendJson(ex, 200, doc);
            return;
        }
        if ("PUT".equals(method) && "/api/v1/workspace/document".equals(path)) {
            String body = readBodyUtf8(ex);
            JsonElement el = new JsonParser().parse(body);
            if (!el.isJsonObject()) {
                sendJson(ex, 400, error("PUT 体须为 JSON 对象"));
                return;
            }
            final JsonObject toWrite = el.getAsJsonObject();
            synchronized (WORKSPACE_IO_LOCK) {
                writeWorkspaceDocument(toWrite);
            }
            sendJson(ex, 200, new JsonObject());
            return;
        }
        if ("PATCH".equals(method) && "/api/v1/workspace/document".equals(path)) {
            String body = readBodyUtf8(ex);
            JsonObject root = new JsonParser().parse(body)
                .getAsJsonObject();
            if (!root.has("patch") || !root.get("patch")
                .isJsonObject()) {
                sendJson(ex, 400, error("PATCH 体须含 patch 对象"));
                return;
            }
            JsonObject merged;
            synchronized (WORKSPACE_IO_LOCK) {
                merged = patchWorkspaceDocument(
                    root.get("patch")
                        .getAsJsonObject());
            }
            sendJson(ex, 200, merged);
            return;
        }
        sendJson(ex, 404, error("未知 API"));
    }

    private static String readBodyUtf8(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line)
                .append('\n');
            return sb.toString();
        }
    }

    private void handleStatic(HttpExchange ex, String path) throws IOException {
        if (!"GET".equals(ex.getRequestMethod()) && !"HEAD".equals(ex.getRequestMethod())) {
            sendJson(ex, 405, error("Method Not Allowed"));
            return;
        }
        String rel = path;
        if (rel.isEmpty() || "/".equals(rel)) {
            rel = "/index.html";
        }
        if (!rel.startsWith("/")) rel = "/" + rel;
        if (rel.contains("..")) {
            sendJson(ex, 403, error("Forbidden"));
            return;
        }
        String resourcePath = WEB_ROOT_PREFIX + rel.substring(1);
        InputStream in = SdeWebServer.class.getClassLoader()
            .getResourceAsStream(resourcePath);
        if (in == null) {
            sendJson(ex, 404, error("Not Found: " + rel));
            return;
        }
        byte[] data = readAllBytes(in);
        in.close();
        String ctype = guessContentType(rel);
        ex.getResponseHeaders()
            .set("Content-Type", ctype);
        if ("HEAD".equals(ex.getRequestMethod())) {
            ex.sendResponseHeaders(200, -1);
            return;
        }
        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    private static byte[] readAllBytes(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static String guessContentType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static void sendJson(HttpExchange ex, int code, JsonElement json) throws IOException {
        byte[] data = GSON.toJson(json)
            .getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders()
            .set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    private static java.io.File exportDir() {
        return new java.io.File("structure_exports");
    }

    private static java.io.File workspaceFile() {
        return new java.io.File(exportDir(), WORKSPACE_FILE);
    }

    private JsonArray listExportFiles() throws IOException {
        java.io.File dir = exportDir();
        if (!dir.isDirectory()) {
            return new JsonArray();
        }
        java.io.File[] all = dir.listFiles();
        if (all == null) {
            return new JsonArray();
        }
        List<java.io.File> list = new ArrayList<>();
        for (java.io.File f : all) {
            if (f.isFile() && f.getName()
                .endsWith(".json")) {
                String n = f.getName();
                if (WORKSPACE_FILE.equals(n)) continue;
                if (PendingDumpFiles.FILE_NAME.equals(n)) continue;
                list.add(f);
            }
        }
        list.sort(Comparator.comparing(java.io.File::getName));
        JsonArray arr = new JsonArray();
        for (java.io.File f : list) {
            JsonObject o = new JsonObject();
            o.addProperty("name", f.getName());
            o.addProperty("size", f.length());
            arr.add(o);
        }
        return arr;
    }

    private JsonElement readExportJson(String name) throws IOException {
        java.io.File f = new java.io.File(exportDir(), name);
        if (!f.isFile() || !f.getCanonicalPath()
            .startsWith(exportDir().getCanonicalPath())) {
            throw new IOException("文件不存在");
        }
        String text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        return new JsonParser().parse(text);
    }

    private JsonObject readWorkspaceDocument() throws IOException {
        java.io.File f = workspaceFile();
        if (!f.isFile()) {
            return new JsonObject();
        }
        String text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        JsonElement el = new JsonParser().parse(text);
        return el.isJsonObject() ? el.getAsJsonObject() : new JsonObject();
    }

    private void writeWorkspaceDocument(JsonObject doc) throws IOException {
        java.io.File dir = exportDir();
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建目录");
        }
        Files.write(
            workspaceFile().toPath(),
            GSON_PRETTY.toJson(doc)
                .getBytes(StandardCharsets.UTF_8));
    }

    private JsonObject patchWorkspaceDocument(JsonObject patch) throws IOException {
        JsonObject base = readWorkspaceDocument();
        for (Map.Entry<String, JsonElement> e : patch.entrySet()) {
            base.add(e.getKey(), e.getValue());
        }
        writeWorkspaceDocument(base);
        return base;
    }
}
