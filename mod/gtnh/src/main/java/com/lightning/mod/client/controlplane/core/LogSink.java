package com.lightning.mod.client.controlplane.core;

import java.util.function.Consumer;

/**
 * 支持「带异常栈」的日志口：core 层把失败落成完整栈的唯一通道。
 *
 * <h2>为什么是 {@link Consumer}{@code <String>} 的子接口</h2>
 * core 层不能依赖 MC/FMLLog（要保持无头可测），失败日志只能经注入的日志口出去。而现有装配点
 * （{@code JobQueue} / {@code ActionSteppingExecutor} / {@code EventStream} / {@code Router} / …）
 * 的构造参数类型都是 {@code Consumer<String>}，测试里还会传 {@code null} 或 lambda。
 *
 * <p>
 * 本接口<b>继承</b> {@link Consumer}{@code <String>}，于是：
 * <ul>
 * <li>实现方（{@code CpLog.coreSink()}）返回的对象同时具备 {@link #error(Throwable, String)}；</li>
 * <li>所有既有构造点与测试不需要任何改动——{@link LogSink} 就是 {@code Consumer<String>}；</li>
 * <li>core 侧用 {@code logger instanceof LogSink} 探测：探得到就往日志里落完整栈，
 * 探不到（测试里的 lambda、旧装配）退回原来的纯文本日志，行为与改动前一致。</li>
 * </ul>
 *
 * <p>
 * 为什么不把参数类型直接改成 {@link LogSink}：那会波及 7 个类的构造签名与全部装配点，
 * 为了一件日志增强不值得（且测试里 {@code (Consumer<String>) null} 这类消歧转型会编译失败）。
 */
public interface LogSink extends Consumer<String> {

    /**
     * 记一条带完整异常栈的 ERROR 日志。
     *
     * @param t       原始异常（栈由实现方按 {@code FMLLog.log(Level.ERROR, t, msg)} 落）
     * @param message 人读信息（已含 {@code [SDE][CP]} 前缀，见 {@code Contract.LOG_PREFIX}）
     */
    void error(Throwable t, String message);
}
