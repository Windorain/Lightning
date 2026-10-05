package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@code CP-VALID-002} 的逐字段错误累加器（contract §3：{@code context.fields} 逐字段说明）。
 *
 * <p>
 * 解析器与校验器在遍历输入时把「哪个字段、为什么不合法」逐条记入本对象，
 * 遍历结束后一次性抛出，避免只报第一个错误导致调用方来回试错。
 */
public final class Fields {

    private final JsonArray arr = new JsonArray();

    /** 记一条字段错误。 */
    public Fields add(String field, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("field", field);
        o.addProperty("reason", reason);
        arr.add(o);
        return this;
    }

    /** 条件记错：{@code ok} 为 false 时记录。 */
    public Fields reject(boolean ok, String field, String reason) {
        if (!ok) {
            add(field, reason);
        }
        return this;
    }

    /** 是否已经记过错误。 */
    public boolean isEmpty() {
        return arr.size() == 0;
    }

    /** 已记录的条数。 */
    public int size() {
        return arr.size();
    }

    /** 逐字段错误数组。 */
    public JsonArray toJson() {
        return arr;
    }

    /** 构造 {@code {"fields":[...]}} 形式的错误 context。 */
    public JsonObject toContext() {
        JsonObject ctx = new JsonObject();
        ctx.add("fields", arr);
        return ctx;
    }

    /**
     * 有错误时抛 {@link CpException}（码 {@link ErrorCodes#VALID_PARAM}，context 携带全部字段错误）。
     *
     * <p>
     * message 里附上前三条错误的「字段 原因」摘要，便于只看日志就能定位；
     * 完整清单始终在 {@code context.fields}。
     *
     * @param message 概述信息
     */
    public void throwIfAny(String message) {
        if (!isEmpty()) {
            throw new CpException(ErrorCodes.VALID_PARAM, message + summary(), toContext());
        }
    }

    /** 前三条错误的摘要（用于异常 message）。 */
    public String summary() {
        StringBuilder sb = new StringBuilder();
        int n = Math.min(3, arr.size());
        for (int i = 0; i < n; i++) {
            JsonObject o = arr.get(i)
                .getAsJsonObject();
            sb.append(i == 0 ? "：" : "；");
            sb.append(
                o.get("field")
                    .getAsString())
                .append(' ')
                .append(
                    o.get("reason")
                        .getAsString());
        }
        if (arr.size() > n) {
            sb.append("；…");
        }
        return sb.toString();
    }
}
