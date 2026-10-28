package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 契约错误（contract.md §6）的载体异常。
 *
 * <p>
 * core 层一切可预期的失败都用本异常表达：{@link Router} 收到后按
 * {@link #httpStatus()} 与 {@link #code()} 生成统一错误信封
 * {@code {"ok":false,"error":{"code","message","context"}}}；动作实现里抛出的本异常
 * 会被 {@link ActionJobExecutor} 记为作业失败（{@code job.error}）。
 *
 * <p>
 * HTTP 状态码默认取 {@link ErrorCodes#httpStatus(String)}，个别场景可显式覆盖
 * （例如「产物不存在」沿用 CP-IO-001 但状态码取 404）。
 */
public class CpException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final JsonObject context;
    private final int httpStatus;

    /** 按错误码的默认 HTTP 状态码构造。 */
    public CpException(String code, String message) {
        this(code, message, null, ErrorCodes.httpStatus(code));
    }

    /** 按错误码的默认 HTTP 状态码构造，携带 context。 */
    public CpException(String code, String message, JsonObject context) {
        this(code, message, context, ErrorCodes.httpStatus(code));
    }

    /**
     * 全参构造。
     *
     * @param code       契约错误码，{@code null} 视为 CP-EXEC-001
     * @param message    人读信息
     * @param context    结构化上下文，可为 null
     * @param httpStatus HTTP 状态码，&le;0 时取错误码默认映射
     */
    public CpException(String code, String message, JsonObject context, int httpStatus) {
        super((message == null ? code : message) + (code == null ? "" : " [" + code + "]"));
        this.code = code == null ? ErrorCodes.EXEC_FAILED : code;
        this.context = context;
        this.httpStatus = httpStatus > 0 ? httpStatus : ErrorCodes.httpStatus(this.code);
    }

    /**
     * 携带原始异常的构造：{@code cause} 挂在 {@link #getCause()} 上，让失败日志能落完整栈。
     *
     * <p>
     * 契约错误（{@code CpException}）是「包装层」——例如 {@code SteppingActionBase} 把动作里冒出来的任意
     * {@code Throwable} 包成 {@code CP-EXEC-001}。若包装时丢掉原异常，失败日志里就只剩一行
     * {@code 类名: message}，栈帧全无：真机验收事故（{@code case.run} cameras 段首 step NPE）正是因此
     * 只能靠猜。故包装必须带上 cause，并<b>不改变</b>原有的 message/context 口径
     * （{@code toErrorJson()} 输出的 {@code code/message/context} 与改前逐字段一致）。
     *
     * @param cause 原始异常，可为 null
     */
    public CpException(String code, String message, JsonObject context, Throwable cause) {
        this(code, message, context, ErrorCodes.httpStatus(code));
        if (cause != null && cause != this && getCause() == null) {
            initCause(cause);
        }
    }

    /** 契约错误码。 */
    public String code() {
        return code;
    }

    /** 结构化上下文（可为 null）。 */
    public JsonObject context() {
        return context;
    }

    /** 人读信息（不含错误码后缀）。 */
    public String detail() {
        String m = getMessage();
        int i = m.lastIndexOf(" [");
        return i > 0 ? m.substring(0, i) : m;
    }

    /** 应写入 HTTP 响应的状态码。 */
    public int httpStatus() {
        return httpStatus;
    }

    /** 是否携带可用的结构化上下文。 */
    public boolean hasContext() {
        return Json.size(context) > 0;
    }

    /** 取本异常对应的 {@code {"code","message","context"}} 对象（context 为空时省略字段）。 */
    public JsonObject toErrorJson() {
        JsonObject err = new JsonObject();
        err.addProperty("code", code);
        err.addProperty("message", detail());
        if (hasContext()) {
            err.add("context", context);
        }
        return err;
    }

    /** 权限级不足。 */
    public static CpException insufficientTier(Tier required, Tier actual) {
        JsonObject ctx = new JsonObject();
        ctx.addProperty("required", required == null ? null : required.id());
        ctx.addProperty("actual", actual == null ? null : actual.id());
        return new CpException(
            ErrorCodes.AUTH_INSUFFICIENT,
            "权限级不足：需要 " + (required == null ? "?" : required.id()),
            ctx);
    }

    /** 未认证。 */
    public static CpException unauthenticated(String why) {
        return new CpException(ErrorCodes.AUTH_MISSING, "未认证：" + why);
    }

    /** 缺 confirm。 */
    public static CpException confirmRequired(String action, Tier tier) {
        JsonObject ctx = new JsonObject();
        ctx.addProperty("action", action);
        ctx.addProperty("tier", tier == null ? null : tier.id());
        ctx.addProperty("requiredField", "confirm");
        return new CpException(ErrorCodes.CONFIRM_REQUIRED, "可写动作缺少 \"confirm\": true", ctx);
    }

    /** 未知动作/端点/资源。 */
    public static CpException unknown(String what) {
        return new CpException(ErrorCodes.VALID_UNKNOWN, "未知：" + what);
    }

    /** 参数非法，携带逐字段说明。 */
    public static CpException param(String message, String field, String reason) {
        Fields f = new Fields().add(field, reason);
        return new CpException(ErrorCodes.VALID_PARAM, message, f.toContext());
    }

    /** 文件/产物读写失败。 */
    public static CpException io(String message, Throwable cause) {
        JsonObject ctx = new JsonObject();
        if (cause != null) {
            ctx.addProperty(
                "exception",
                cause.getClass()
                    .getName());
        }
        CpException e = new CpException(ErrorCodes.IO, message, Json.size(ctx) == 0 ? null : ctx);
        if (cause != null) {
            e.initCause(cause);
        }
        return e;
    }
}
