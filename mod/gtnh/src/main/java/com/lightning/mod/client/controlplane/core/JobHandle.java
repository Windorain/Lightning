package com.lightning.mod.client.controlplane.core;

/**
 * 作业句柄：动作实现能看到的作业视图。
 *
 * <p>
 * 动作只通过它上报进度与关联 run；状态机的其余部分由 {@link JobQueue} 独占，
 * 避免动作实现把作业推进到非法状态。
 */
public interface JobHandle {

    /** 作业标识（{@code GET /cp/v1/jobs/{jobId}} 的键）。 */
    String jobId();

    /** 作业序号（进程内单调递增，同时用于 run 目录名末尾的 {@code jobSeq}）。 */
    long seq();

    /** 动作名。 */
    String action();

    /**
     * 提交本作业的调用方权限级（contract.md §1.5）。
     *
     * <p>
     * 动作实现需要它来做<b>按内容升格</b>的判定：{@code case.run} 的静态级是 {@code scene}，
     * 但用例含 {@code cameras} 段时必须由 {@code forensic} 级调用方发起（case-file.md §4）——
     * 这个判定只能在这里拿到「实际是哪一级」之后做。
     */
    Tier tier();

    /**
     * 上报进度。
     *
     * @param fraction 0..1，越界会被夹取
     * @param message  人读说明，可为 null
     */
    void progress(double fraction, String message);

    /** 关联一个 run（{@link ActionContext#beginRun} 内部调用）。 */
    void attachRun(String runId);
}
