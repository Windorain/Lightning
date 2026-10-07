package com.lightning.mod.client.controlplane.mc.input;

/**
 * 注入面不可用的**显式**失败（不是「悄悄没投递」）。
 *
 * <p>
 * 契约 §6.1 把「能力未就绪」归到 {@code CP-STATE-001}（前置状态不满足），因此本异常只带
 * {@code code} + 人读原因，由动作层翻译成 {@code CpException}；队列满/入口缺席都走这里，
 * <b>绝不</b>返回「投递了 0 条但绿」。
 */
public final class InputInjectionException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String code;

    /** 用契约错误码 + 原因构造。 */
    public InputInjectionException(String code, String reason) {
        super(reason);
        this.code = code;
    }

    /** 用契约错误码 + 原因 + 原始异常构造（反射调用失败等）。 */
    public InputInjectionException(String code, String reason, Throwable cause) {
        super(reason, cause);
        this.code = code;
    }

    /** 契约错误码（{@code CP-STATE-001} 等）。 */
    public String code() {
        return code;
    }
}
