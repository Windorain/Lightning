package com.lightning.mod.client.controlplane.mc;

import java.util.function.Consumer;

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

    /** 注入 core 的日志口：core 的消息已带 {@code [SDE][CP]} 前缀。 */
    public static Consumer<String> coreSink() {
        return new Consumer<String>() {

            @Override
            public void accept(String message) {
                raw(message);
            }
        };
    }
}
