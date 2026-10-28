package com.lightning.mod.client.controlplane.mc.input.api;

import com.google.gson.JsonObject;

/**
 * 能力与状态的发现面（能力面字段见 §6）：<b>实现归观察侧</b>，**注册归集成侧**
 * （{@code input.state} 动作由注册侧装配进动作面）。
 *
 * <p>
 * 口径（§6）：返回值必须让调用方**仅凭它**判断「当前能不能做、做到哪一步、做不到时谁的问题」——
 * 至少含：支持的动作族、键位标识口径、字符范围与限制、坐标口径与缩放参数、当前消费链、
 * 键盘队列深度、持键表、错误码清单、以及**未实现项**（{@code notImplemented}）。
 *
 * <p>
 * <b>禁止</b>用默认值把「未实现」伪装成「已具备」：没有真值的字段要么不出现，要么如实标注
 * （§6 末条）。
 */
public interface InputStateProvider {

    /**
     * 动作名（注册时填入）。
     *
     * <p>
     * 常量放在 {@code api} 包而不是某个实现类里：观察面动作（{@code mc.input.observe.InputStateAction}，
     * 上层）与能力真值表（{@code mc.input.InputCapabilities}，下层）都要用它，而
     * <b>下层不得反向依赖上层</b>。放在双方都允许依赖的 {@code api} 面，动作名就只有一处真值。
     */
    String ACTION_NAME = "input.state";

    /** 组装 {@code input.state} 的响应体（在客户端 tick 线程调用）。 */
    JsonObject state();
}
