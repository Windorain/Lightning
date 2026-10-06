package com.lightning.mod.client.controlplane.mc;

import java.util.function.Consumer;

import com.lightning.mod.client.controlplane.core.LogSink;

import cpw.mods.fml.common.FMLLog;

/**
 * 控制面 mc 层的日志口。
 *
 * <p>
 * 契约（contract.md §9）规定控制面日志前缀为 {@code [SDE][CP]}，且 <b>core 层自己写出的每条日志
 * 都已带该前缀</b>——因此 {@link #coreSink()} 交给 core 的回调不得再补前缀，否则会重复。
 * mc 层自己打的日志用 {@link #info}/{@link #warn} 等方法，前缀由本类补上。
 *
 * <p>
 * 所有方法都吞掉内部异常：日志失败绝不影响动作执行。
 */
public final class CpLog {

    /** 契约日志前缀（含尾随空格）。 */
    public static final String PREFIX = "[SDE][CP] ";

    private CpLog() {}

    /** INFO 级日志。{@code fmt} 为 {@link FMLLog} 风格格式串。 */
    public static void info(String fmt, Object... args) {
        try {
            FMLLog.info(PREFIX + fmt, args);
        } catch (Throwable ignored) {
            // 日志失败不影响动作
        }
    }

    /** WARN 级日志。 */
    public static void warn(String fmt, Object... args) {
        try {
            FMLLog.warning(PREFIX + fmt, args);
        } catch (Throwable ignored) {
            // 日志失败不影响动作
        }
    }

    /** ERROR 级日志（带异常栈）。 */
    public static void error(Throwable t, String fmt, Object... args) {
        try {
            FMLLog.log(org.apache.logging.log4j.Level.ERROR, t, PREFIX + fmt, args);
        } catch (Throwable ignored) {
            // 日志失败不影响动作
        }
    }

    /** 打一条已带前缀的原文（core 注入用）。 */
    public static void raw(String message) {
        info("%s", message);
    }

    /**
     * 注入 core 的日志口：core 的消息已带 {@code [SDE][CP]} 前缀。
     *
     * <p>
     * 返回类型是 {@link LogSink}（{@link Consumer}{@code <String>} 的子接口）而不是裸
     * {@code Consumer<String>}：core 的失败路径用 {@code logger instanceof LogSink} 探测，
     * 探得到就把<b>完整异常栈</b>用 {@code FMLLog.log(Level.ERROR, t, msg)} 落下来，
     * 探不到（单测里的 lambda/旧装配）退回纯文本。既有装配点全部按 {@code Consumer<String>}
     * 接收，因此这个协变收窄对调用方完全兼容。
     */
    public static LogSink coreSink() {
        return new LogSink() {

            @Override
            public void accept(String message) {
                raw(message);
            }

            @Override
            public void error(Throwable t, String message) {
                CpLog.error(t, "%s", message);
            }
        };
    }
}
