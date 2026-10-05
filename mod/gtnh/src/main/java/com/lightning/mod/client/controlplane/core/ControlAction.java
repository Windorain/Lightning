package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 动作实现接口（mc 层实现，core 层只定义契约）。
 *
 * <p>
 * 实现跑在客户端 tick 线程（contract.md §1.8），因此可以直接触碰 MC 状态；
 * HTTP 线程只负责鉴权/入队。返回值即 {@code GET /cp/v1/jobs/{id}} 里 {@code result} 字段的内容。
 *
 * <p>
 * 可预期的失败请抛 {@link CpException}（错误码会被原样带进作业的 {@code error}），
 * 其余异常会被统一记为 CP-EXEC-001。
 */
public interface ControlAction {

    /**
     * 执行动作。
     *
     * @param ctx 入参、作业句柄、事件回调与产物目录
     * @return 结果对象；返回 null 视为空对象
     */
    JsonObject execute(ActionContext ctx);
}
