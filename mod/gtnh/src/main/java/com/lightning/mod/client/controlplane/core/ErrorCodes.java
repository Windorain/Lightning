package com.lightning.mod.client.controlplane.core;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * 契约 §6 的稳定错误码，以及「错误码 → 默认 HTTP 状态码」映射。
 *
 * <p>
 * 码值格式 {@code CP-<类>-<序>}，v1 内只增不改义。调用方可依赖码值做分支；
 * HTTP 状态码只是人读提示，个别端点会覆盖它（如产物缺失用 CP-IO-001 + 404）。
 */
public final class ErrorCodes {

    /** 未认证（token 缺失/错误）。 */
    public static final String AUTH_MISSING = "CP-AUTH-001";

    /** 权限级不足。 */
    public static final String AUTH_INSUFFICIENT = "CP-AUTH-002";

    /** 未知动作 / 未知端点 / 未知资源。 */
    public static final String VALID_UNKNOWN = "CP-VALID-001";

    /** 参数非法（{@code context.fields} 逐字段说明）。 */
    public static final String VALID_PARAM = "CP-VALID-002";

    /** 可写动作缺 {@code "confirm": true}。 */
    public static final String CONFIRM_REQUIRED = "CP-CONFIRM-001";

    /** 已有动作执行中。 */
    public static final String BUSY = "CP-BUSY-001";

    /** 前置状态不满足（如世界未加载、非托管世界）。 */
    public static final String STATE = "CP-STATE-001";

    /** 动作执行失败。 */
    public static final String EXEC_FAILED = "CP-EXEC-001";

    /** 动作超时。 */
    public static final String EXEC_TIMEOUT = "CP-EXEC-002";

    /** 产物/文件读写失败。 */
    public static final String IO = "CP-IO-001";

    private static final Map<String, Integer> HTTP_STATUS;

    static {
        Map<String, Integer> m = new HashMap<String, Integer>();
        m.put(AUTH_MISSING, 401);
        m.put(AUTH_INSUFFICIENT, 403);
        m.put(VALID_UNKNOWN, 404);
        m.put(VALID_PARAM, 400);
        m.put(CONFIRM_REQUIRED, 400);
        m.put(BUSY, 409);
        m.put(STATE, 409);
        m.put(EXEC_FAILED, 500);
        m.put(EXEC_TIMEOUT, 504);
        m.put(IO, 500);
        HTTP_STATUS = Collections.unmodifiableMap(m);
    }

    private ErrorCodes() {}

    /**
     * 取错误码的默认 HTTP 状态码。
     *
     * @param code 错误码，可为 null 或未登记
     * @return 登记的状态码；未登记返回 500
     */
    public static int httpStatus(String code) {
        Integer s = code == null ? null : HTTP_STATUS.get(code);
        return s == null ? 500 : s;
    }
}
