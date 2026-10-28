package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 步进作业执行器：每次 {@link #step} 只推进一小步（tick 线程调用），返回 {@code null} 表示未完成、
 * 下个 tick 继续；返回非 null（可为空对象）表示成功完成。
 *
 * <p>
 * 存在理由：世界加载、静置等待、用例文件执行都是跨多个 tick 的过程，不能像 {@link JobExecutor}
 * 那样在一次调用内同步跑完——阻塞 tick 线程会冻结整个客户端。进度由实现侧直接调用
 * {@link Job#progress(double, String)} 更新。
 */
public interface SteppingExecutor {

    /**
     * 推进一步（tick 线程）。
     *
     * @param job 处于 running 态的作业
     * @return 完成时的结果 JSON；未完成返回 null
     * @throws CpException 契约级失败；其它异常记为 CP-EXEC-001
     */
    JsonObject step(Job job) throws Exception;
}
