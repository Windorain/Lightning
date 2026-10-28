package com.lightning.mod.client.controlplane.core;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

/**
 * 端点路由：路径匹配 → 鉴权 → 权限级 → confirm → 分派 → 统一响应信封（contract.md §3/§6/§2 第 1–4 条）。
 *
 * <p>
 * 顺序是刻意的：<b>先鉴权再解析请求体</b>（不给未认证调用方任何解析反馈），
 * <b>权限级足够才检查 confirm</b>（拒绝原因从不放大权限）。可写级动作（scene 及以上）
 * 缺 {@code "confirm": true} 一律 {@code CP-CONFIRM-001}，与「不存在空 token 放行」同属不可放宽的边界。
 *
 * <p>
 * 处理器只产出 data（{@link Result#ok}）或原始字节（{@link Result#raw}，产物下载用），
 * 信封由本类统一封装；任何处理器异常都会被转成 {@code {"ok":false,"error":{...}}}，绝不泄漏栈到响应里。
 */
public final class Router {

    /** 端点处理器。 */
    public interface Handler {

        /** 处理请求；返回 {@link Result}。抛 {@link CpException} 表示契约级失败。 */
        Result handle(Request req) throws Exception;
    }

    /** 权限级解析器：默认取路由固定级；动作端点按动作自描述解析。 */
    public interface TierResolver {

        /** 求本次请求所需的权限级。 */
        Tier resolve(Request req, JsonObject body);
    }

    /** 一次 HTTP 请求（由 {@link ControlPlaneServer} 构造，测试可直接构造）。 */
    public static final class Request {

        private final String method;
        private final String path;
        private final Map<String, String> query;
        private final String bodyText;
        private final String token;
        private final String remoteAddress;

        private Map<String, String> pathParams = new LinkedHashMap<String, String>();
        private JsonObject body;
        private boolean bodyParsed;
        private Tier tier = Tier.OBSERVE;

        private Request(Builder b) {
            this.method = b.method == null ? "GET" : b.method.toUpperCase(java.util.Locale.ROOT);
            this.path = b.path == null ? "/" : b.path;
            this.query = b.query;
            this.bodyText = b.bodyText;
            this.token = b.token;
            this.remoteAddress = b.remoteAddress;
            this.body = b.body;
            this.bodyParsed = b.body != null;
        }

        /** 新建构造器。 */
        public static Builder builder() {
            return new Builder();
        }

        /** HTTP 方法（大写）。 */
        public String method() {
            return method;
        }

        /** 原始路径（百分号编码未解码；匹配时逐段解码）。 */
        public String path() {
            return path;
        }

        /** 查询参数（键 → 首个值）。 */
        public Map<String, String> query() {
            return query;
        }

        /** 取查询参数，缺失返回 null。 */
        public String query(String name) {
            return query == null ? null : query.get(name);
        }

        /** 取布尔查询参数（{@code true}/{@code 1} 为真），缺失/非法用默认值。 */
        public boolean queryBool(String name, boolean def) {
            String v = query(name);
            if (v == null) {
                return def;
            }
            return "true".equalsIgnoreCase(v) || "1".equals(v) || "yes".equalsIgnoreCase(v);
        }

        /** 取整数查询参数，缺失/非法用默认值。 */
        public int queryInt(String name, int def) {
            long v = queryLong(name, def);
            return v > Integer.MAX_VALUE ? def : (int) v;
        }

        /** 取长整数查询参数，缺失/非法用默认值。 */
        public long queryLong(String name, long def) {
            String v = query(name);
            if (v == null || v.trim()
                .isEmpty()) {
                return def;
            }
            try {
                return Long.parseLong(v.trim());
            } catch (NumberFormatException e) {
                return def;
            }
        }

        /** 路径占位符（{@code {name}} / {@code {path...}}）捕获值。 */
        public String pathParam(String name) {
            return pathParams == null ? null : pathParams.get(name);
        }

        /** 全部路径占位符。 */
        public Map<String, String> pathParams() {
            return pathParams;
        }

        /** 请求体原文，可为 null。 */
        public String bodyText() {
            return bodyText;
        }

        /**
         * 已解析的请求体；无请求体返回 null。
         *
         * @throws CpException CP-VALID-002：不是合法 JSON 对象
         */
        public JsonObject parseBody() {
            if (bodyParsed) {
                return body;
            }
            bodyParsed = true;
            if (bodyText == null || bodyText.trim()
                .isEmpty()) {
                body = null;
                return null;
            }
            try {
                body = Json.parseStrictObject(bodyText);
            } catch (JsonSyntaxException e) {
                throw new CpException(
                    ErrorCodes.VALID_PARAM,
                    "请求体不是合法 JSON 对象",
                    new Fields().add("body", e.getMessage())
                        .toContext());
            }
            return body;
        }

        /** 请求体；未解析或非对象时返回 null。 */
        public JsonObject body() {
            return body;
        }

        /** 出示的 token（Authorization 头或 {@code ?token=}），可为 null。 */
        public String token() {
            return token;
        }

        /** 对端地址（日志用）。 */
        public String remoteAddress() {
            return remoteAddress;
        }

        /** 内部：路由匹配时填写路径占位符。 */
        void setPathParams(Map<String, String> params) {
            this.pathParams = params;
        }

        /** 内部：鉴权通过后填写调用方权限级（动作据此做运行期升格检查）。 */
        void setTier(Tier t) {
            this.tier = t;
        }

        /**
         * 调用方权限级（鉴权期解析出的实际级）。
         *
         * <p>
         * 动作实现需要它来做<b>按内容升格</b>的判定（{@code case.run} 含 cameras 段时要求
         * forensic）；未鉴权路径下为 {@link Tier#OBSERVE}（最保守）。
         */
        public Tier tier() {
            return tier;
        }

        /** 请求体是否为 {@code "confirm": true}。 */
        public boolean confirmed() {
            JsonObject b = body;
            if (b == null || !b.has("confirm")) {
                return false;
            }
            JsonElement c = b.get("confirm");
            return c.isJsonPrimitive() && c.getAsJsonPrimitive()
                .isBoolean() && c.getAsBoolean();
        }

        /** 请求构造器。 */
        public static final class Builder {

            private String method = "GET";
            private String path = "/";
            private Map<String, String> query = new LinkedHashMap<String, String>();
            private String bodyText;
            private JsonObject body;
            private String token;
            private String remoteAddress;

            /** 方法。 */
            public Builder method(String m) {
                this.method = m;
                return this;
            }

            /** 路径（原始形式，可含占位符目标值）。 */
            public Builder path(String p) {
                this.path = p;
                return this;
            }

            /** 追加查询参数。 */
            public Builder query(String name, String value) {
                this.query.put(name, value);
                return this;
            }

            /** 设置查询参数表（覆盖）。 */
            public Builder query(Map<String, String> q) {
                if (q != null) {
                    this.query.putAll(q);
                }
                return this;
            }

            /** 请求体原文。 */
            public Builder body(String text) {
                this.bodyText = text;
                return this;
            }

            /** 已解析请求体。 */
            public Builder body(JsonObject body) {
                this.body = body;
                this.bodyText = Json.toJson(body);
                return this;
            }

            /** 出示的 token。 */
            public Builder token(String t) {
                this.token = t;
                return this;
            }

            /** 对端地址。 */
            public Builder remote(String addr) {
                this.remoteAddress = addr;
                return this;
            }

            /** 构造。 */
            public Request build() {
                return new Request(this);
            }
        }
    }

    /** 端点响应。 */
    public static final class Result {

        private final int status;
        private final JsonElement envelope;
        private final byte[] raw;
        private final String contentType;

        private Result(int status, JsonElement envelope, byte[] raw, String contentType) {
            this.status = status;
            this.envelope = envelope;
            this.raw = raw;
            this.contentType = contentType;
        }

        /** 200 + 成功信封。 */
        public static Result ok(JsonElement data) {
            return ok(200, data);
        }

        /** 指定状态码 + 成功信封。 */
        public static Result ok(int status, JsonElement data) {
            return new Result(status, Envelope.ok(data), null, "application/json; charset=utf-8");
        }

        /** 指定状态码 + 失败信封。 */
        public static Result error(int status, String code, String message, JsonObject context) {
            return new Result(status, Envelope.error(code, message, context), null, "application/json; charset=utf-8");
        }

        /** 原始字节响应（产物下载）。 */
        public static Result raw(byte[] body, String contentType) {
            return new Result(200, null, body, contentType == null ? "application/octet-stream" : contentType);
        }

        /** 状态码。 */
        public int status() {
            return status;
        }

        /** 信封（JSON 响应时有值）。 */
        public JsonElement envelope() {
            return envelope;
        }

        /** 原始响应体（原始字节响应时有值）。 */
        public byte[] rawBody() {
            return raw;
        }

        /** Content-Type。 */
        public String contentType() {
            return contentType;
        }

        /** 是否 JSON 信封响应。 */
        public boolean isJson() {
            return envelope != null;
        }
    }

    /** 一条路由。 */
    public static final class Route {

        private final String method;
        private final String pattern;
        private final String[] segments;
        private final Tier tier;
        private final TierResolver tierResolver;
        private final Handler handler;
        private final ActionRegistry actionRegistry;

        Route(String method, String pattern, Tier tier, TierResolver tierResolver, Handler handler,
            ActionRegistry actionRegistry) {
            this.method = method;
            this.pattern = pattern;
            this.segments = split(pattern);
            this.tier = tier;
            this.tierResolver = tierResolver;
            this.handler = handler;
            this.actionRegistry = actionRegistry;
        }

        /** HTTP 方法。 */
        public String method() {
            return method;
        }

        /** 注册用的路径模板。 */
        public String pattern() {
            return pattern;
        }

        /** 固定权限级（动作端点为最低级，真实级由 {@link #requiredTier} 求）。 */
        public Tier tier() {
            return tier;
        }

        /** 本次请求所需权限级。 */
        public Tier requiredTier(Request req, JsonObject body) {
            if (tierResolver != null) {
                Tier t = tierResolver.resolve(req, body);
                return t == null ? Tier.OBSERVE : t;
            }
            return tier == null ? Tier.OBSERVE : tier;
        }

        /** 关联的动作注册表（动作端点非空）。 */
        public ActionRegistry actionRegistry() {
            return actionRegistry;
        }
    }

    private final TokenStore tokens;
    private final EventStream events;
    private final Consumer<String> logger;
    private final List<Route> routes = new ArrayList<Route>();

    /** 构造。 */
    public Router(TokenStore tokens, EventStream events, Consumer<String> logger) {
        this.tokens = tokens == null ? new TokenStore("", "", "") : tokens;
        this.events = events;
        this.logger = logger;
    }

    // ------------------------------------------------------------ 注册

    /** 注册 GET 路由。 */
    public Route get(String pattern, Tier tier, Handler handler) {
        return register("GET", pattern, tier, null, handler, null);
    }

    /** 注册 POST 路由（固定权限级）。 */
    public Route post(String pattern, Tier tier, Handler handler) {
        return register("POST", pattern, tier, null, handler, null);
    }

    /**
     * 注册动作端点：权限级取自动作自描述（{@code {name}} 占位符）。
     *
     * <p>
     * 未知动作按 observe 处理（先鉴权、后报 404），避免用「权限级不足」泄漏动作是否存在。
     */
    public Route postAction(String pattern, final ActionRegistry registry, Handler handler) {
        TierResolver resolver = new TierResolver() {

            @Override
            public Tier resolve(Request req, JsonObject body) {
                ActionDescriptor d = registry == null ? null : registry.descriptor(req.pathParam("name"));
                return d == null ? Tier.OBSERVE : d.tier();
            }
        };
        return register("POST", pattern, Tier.OBSERVE, resolver, handler, registry);
    }

    /** 通用注册。 */
    public Route register(String method, String pattern, Tier tier, TierResolver tierResolver, Handler handler,
        ActionRegistry actionRegistry) {
        if (pattern == null || !pattern.startsWith("/")) {
            throw new IllegalArgumentException("路由模板须以 / 开头: " + pattern);
        }
        if (handler == null) {
            throw new IllegalArgumentException("处理器不能为 null: " + pattern);
        }
        Route r = new Route(
            method.toUpperCase(java.util.Locale.ROOT),
            pattern,
            tier,
            tierResolver,
            handler,
            actionRegistry);
        routes.add(r);
        return r;
    }

    /** 已注册路由（按注册顺序）。 */
    public List<Route> routes() {
        return new ArrayList<Route>(routes);
    }

    // ------------------------------------------------------------ 分派

    /**
     * 处理一次请求（永不抛异常）。
     *
     * @return 状态码 + 信封（或原始字节）
     */
    public Result handle(Request req) {
        Route route = null;
        Map<String, String> captures = null;
        for (Route r : routes) {
            if (!r.method.equals(req.method())) {
                continue;
            }
            Map<String, String> c = new LinkedHashMap<String, String>();
            if (match(r, req.path(), c)) {
                route = r;
                captures = c;
                break;
            }
        }
        if (route == null) {
            for (Route r : routes) {
                Map<String, String> c = new LinkedHashMap<String, String>();
                if (match(r, req.path(), c)) {
                    return Result.error(
                        405,
                        ErrorCodes.VALID_UNKNOWN,
                        "方法不允许: " + req.method() + " " + req.path() + "（该端点只接受 " + r.method + "）",
                        null);
                }
            }
            return Result.error(404, ErrorCodes.VALID_UNKNOWN, "未知端点: " + req.method() + " " + req.path(), null);
        }
        req.setPathParams(captures);

        // 1) 认证
        Tier actual = tokens.tierOf(req.token());
        if (actual == null) {
            reject(req, ErrorCodes.AUTH_MISSING, "token 缺失或错误");
            return Result.error(401, ErrorCodes.AUTH_MISSING, "未认证：token 缺失或错误", null);
        }

        // 2) 解析请求体（鉴权之后，避免给未认证调用方任何解析反馈）
        JsonObject body;
        try {
            body = req.parseBody();
        } catch (CpException e) {
            reject(req, e.code(), e.detail());
            return new Result(e.httpStatus(), Envelope.error(e), null, "application/json; charset=utf-8");
        }

        // 3) 授权
        Tier required = route.requiredTier(req, body);
        if (!actual.covers(required)) {
            reject(req, ErrorCodes.AUTH_INSUFFICIENT, "需要 " + required.id() + "，实际 " + actual.id());
            return new Result(
                ErrorCodes.httpStatus(ErrorCodes.AUTH_INSUFFICIENT),
                Envelope.error(CpException.insufficientTier(required, actual)),
                null,
                "application/json; charset=utf-8");
        }
        // 调用方权限级随请求下发：动作可据此做「按内容升格」的运行期判定（case.run + cameras 段）
        req.setTier(actual);

        // 4) confirm（仅可写级动作）
        if (required.isWritable() && !req.confirmed()) {
            String action = req.pathParam("name") == null ? route.pattern : req.pathParam("name");
            reject(req, ErrorCodes.CONFIRM_REQUIRED, "动作 " + action + " 需要 \"confirm\": true");
            return new Result(
                400,
                Envelope.error(CpException.confirmRequired(action, required)),
                null,
                "application/json; charset=utf-8");
        }

        // 5) 分派
        try {
            Result r = route.handler.handle(req);
            return r == null ? Result.ok(new JsonObject()) : r;
        } catch (CpException e) {
            warn("端点失败 " + req.method() + " " + req.path() + ": " + e.detail());
            return new Result(e.httpStatus(), Envelope.error(e), null, "application/json; charset=utf-8");
        } catch (Throwable t) {
            warn("端点异常 " + req.method() + " " + req.path() + ": " + t);
            JsonObject ctx = new JsonObject();
            ctx.addProperty(
                "exception",
                t.getClass()
                    .getName());
            ctx.addProperty("endpoint", req.method() + " " + req.path());
            return Result.error(500, ErrorCodes.EXEC_FAILED, "端点内部错误: " + t, ctx);
        }
    }

    // ------------------------------------------------------------ 匹配

    private static boolean match(Route route, String path, Map<String, String> captures) {
        String[] parts = split(path);
        String[] pat = route.segments;
        int i = 0;
        for (; i < pat.length; i++) {
            String p = pat[i];
            boolean catchAll = p.startsWith("{") && p.endsWith("...}");
            if (catchAll) {
                if (i >= parts.length) {
                    return false;
                }
                String name = p.substring(1, p.length() - 4);
                StringBuilder rest = new StringBuilder();
                for (int k = i; k < parts.length; k++) {
                    if (k > i) {
                        rest.append('/');
                    }
                    rest.append(percentDecode(parts[k]));
                }
                captures.put(name, rest.toString());
                return true;
            }
            if (i >= parts.length) {
                return false;
            }
            if (p.startsWith("{") && p.endsWith("}")) {
                String name = p.substring(1, p.length() - 1);
                String v = percentDecode(parts[i]);
                if (v.isEmpty()) {
                    return false;
                }
                captures.put(name, v);
            } else if (!p.equals(percentDecode(parts[i]))) {
                return false;
            }
        }
        return i == parts.length;
    }

    private static String[] split(String path) {
        String p = path == null ? "/" : path;
        while (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        if (p.startsWith("/")) {
            p = p.substring(1);
        }
        if (p.isEmpty()) {
            return new String[0];
        }
        return p.split("/", -1);
    }

    /**
     * 百分号解码（{@code +} 不视为空格，因为用在路径段上）。
     *
     * @param s 原始片段
     * @return 解码后的 UTF-8 字符串；解码失败时原样返回
     */
    public static String percentDecode(String s) {
        if (s == null || s.indexOf('%') < 0) {
            return s;
        }
        try {
            return URLDecoder.decode(s.replace("+", "%2B"), "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return s;
        } catch (IllegalArgumentException e) {
            return s;
        }
    }

    /** 判定 MIME 类型（产物下载用）。 */
    public static String contentTypeOf(String path) {
        String p = path == null ? "" : path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".json") || p.endsWith(".jsonl")) {
            return "application/json; charset=utf-8";
        }
        if (p.endsWith(".txt") || p.endsWith(".log") || p.endsWith(".md") || p.endsWith(".csv")) {
            return "text/plain; charset=utf-8";
        }
        if (p.endsWith(".png")) {
            return "image/png";
        }
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (p.endsWith(".webp")) {
            return "image/webp";
        }
        return "application/octet-stream";
    }

    /** 把 UTF-8 文本按 RFC 7230 风格标注长度（供服务器写响应）。 */
    public static byte[] bytesOf(String s) {
        return (s == null ? "" : s).getBytes(StandardCharsets.UTF_8);
    }

    private void reject(Request req, String code, String why) {
        if (events != null) {
            events.append(
                EventStream.LEVEL_WARN,
                EventStream.Kinds.ACTION_REJECT,
                req.pathParam("name"),
                null,
                "拒绝 " + req.method() + " " + req.path() + "：" + why,
                Json.object("code", code, "reason", why));
        }
    }

    private void warn(String message) {
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }
}
