package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 作业执行器：由 tick 线程调用，真正跑动作实现。
 *
 * <p>
 * 把「调度」与「执行」分开是为了让 {@link JobQueue} 可以纯 JVM 单测（注入假执行器），
 * 而真实执行路径（查动作表、建 run 目录、写 manifest）留在 {@link ActionJobExecutor}。
 */
public interface JobExecutor {

    /**
     * 执行作业（在 tick 线程内同步完成）。
     *
     * @param job 已置为 running 的作业
     * @return 动作结果；抛 {@link CpException} 表示契约级失败，抛其它异常记为 CP-EXEC-001
     */
    JsonObject execute(Job job) throws Exception;
}
