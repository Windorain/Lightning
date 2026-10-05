package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

/**
 * HTTP 响应信封（contract.md §2）。
 *
 * <p>
 * 成功：{@code {"ok": true, "data": ...}}；失败：{@code {"ok": false, "error": {"code","message","context"}}}。
 * 只有本类负责信封形状，端点处理器只产出 data；这样「信封一致性」可被单点测试。
 */
public final class Envelope {

    private Envelope() {}

    /** 成功信封；{@code data} 为 null 时写成 JSON null。 */
    public static JsonObject ok(JsonElement data) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.add("data", data == null ? JsonNull.INSTANCE : data);
        return o;
    }

    /** 失败信封。 */
    public static JsonObject error(String code, String message, JsonObject context) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code == null ? ErrorCodes.EXEC_FAILED : code);
        err.addProperty("message", message == null ? "" : message);
        if (Json.size(context) > 0) {
            err.add("context", context);
        }
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.add("error", err);
        return o;
    }

    /** 失败信封（取自异常）。 */
    public static JsonObject error(CpException e) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.add("error", e.toErrorJson());
        return o;
    }

    /** 是否成功信封。 */
    public static boolean isOk(JsonElement e) {
        return e != null && e.isJsonObject()
            && e.getAsJsonObject()
                .has("ok")
            && e.getAsJsonObject()
                .get("ok")
                .getAsBoolean();
    }

    /** 取成功信封的 data；非成功信封返回 null。 */
    public static JsonElement data(JsonElement e) {
        if (!isOk(e)) {
            return null;
        }
        return e.getAsJsonObject()
            .get("data");
    }

    /** 取失败信封的错误码；非失败信封返回 null。 */
    public static String errorCode(JsonElement e) {
        if (e == null || !e.isJsonObject()) {
            return null;
        }
        JsonObject o = e.getAsJsonObject();
        if (!o.has("error") || !o.get("error")
            .isJsonObject()) {
            return null;
        }
        JsonElement c = o.getAsJsonObject("error")
            .get("code");
        return c == null || c.isJsonNull() ? null : c.getAsString();
    }
}
