package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonObject;

/**
 * 捕获会话标志（contract.md §4.1 / case-file.md §4）：{@code capture.begin} 之后、
 * {@code capture.end} 之前，<b>禁止一切世界写动作</b>（违规 {@code CP-STATE-001}）。
 *
 * <h2>为什么要这个标志</h2>
 * 取证拍摄的前提是「世界在拍摄期间不再变化」——一张图里出现半建成的场景，事后无法从产物判断
 * 是渲染问题还是世界漂移。因此会话期间把世界写动作挡在门外，比事后靠哈希对账更早暴露。
 *
 * <h2>作业归属（{@code armedByJobId}）</h2>
 * 会话必须能被<b>开它的那个作业</b>穿过：{@code case.run} 的 capture 段在 build 段<b>之前</b>
 * 开场（契约的执行序是 {@code world→capture→build→cameras→evidence}），若不加区分，
 * 它自己的 build 段会被自己开的会话挡掉。故判定是「会话已开 <b>且</b> 调用方不是开场者」——
 * 外层捕获会话仍然拦得住任何别的作业（互斥队列保证同一时刻只有一个动作，所以「别的作业」
 * 等价于「一次后续的独立动作」）。
 *
 * <h2>线程</h2>
 * 标志只在客户端 tick 线程被读写（动作在 tick 线程排空，contract §1.8），但动作之间可能隔着
 * tick 边界，故字段用 {@code volatile} 并让判定/变更在 {@link CaptureSession} 的类锁内进行。
 */
public final class CaptureSession {

    /** 当前会话（null = 未开场）。 */
    private static volatile Holder holder;

    private CaptureSession() {}

    /** 会话记录。 */
    private static final class Holder {

        private final String jobId;
        private final String action;
        private final String armedAt;
        private final long armedAtSeq;

        Holder(String jobId, String action, String armedAt, long armedAtSeq) {
            this.jobId = jobId;
            this.action = action;
            this.armedAt = armedAt;
            this.armedAtSeq = armedAtSeq;
        }
    }

    /** 是否有捕获会话在进行。 */
    public static boolean isArmed() {
        return holder != null;
    }

    /**
     * {@link #isArmed()} 的**不抛**形态（{@code captureArmed} 的单一实现点）。
     *
     * <p>
     * 【#166 DR-12】{@code input.state} 与四个可写动作的 {@code consumer.captureArmed} 都从这里取值：
     * 同一个量只有一处实现，且这里吞掉一切异常回 {@code false}——能力/结果面**不得**因为一次
     * 状态读取失败而把整个响应体打断（异常在这里只意味着「判不出布防」⇒ 如实回未布防是唯一
     * 不回滚能力的取值，且该字段在契约里是「供调用方自行决定是否在取证期间注入」的提示，不是门）。
     */
    public static boolean isArmedSafely() {
        try {
            return isArmed();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 开场者作业 id；未开场返回 null。 */
    public static String armedByJobId() {
        Holder h = holder;
        return h == null ? null : h.jobId;
    }

    /**
     * 会话状态快照（事件与结果留痕用）。
     *
     * @return {@code {armed, by, action, since, seq}}；未开场时 {@code armed=false}
     */
    public static JsonObject status() {
        Holder h = holder;
        JsonObject o = new JsonObject();
        o.addProperty("armed", h != null);
        if (h != null) {
            o.addProperty("by", h.jobId);
            o.addProperty("action", h.action);
            o.addProperty("since", h.armedAt);
            o.addProperty("seq", Long.valueOf(h.armedAtSeq));
        }
        return o;
    }

    /**
     * 开场（{@code capture.begin}）。
     *
     * @param jobId  开场作业 id，可为 null
     * @param action 开场动作名，可为 null
     * @param at     ISO-8601 时刻
     * @param seq    事件序号（留痕用）
     * @throws CpException {@code CP-STATE-001}：已有会话（重复 begin 不做隐式续期）
     */
    public static synchronized void begin(String jobId, String action, String at, long seq) {
        if (holder != null) {
            throw new CpException(
                ErrorCodes.STATE,
                "捕获会话已在进行（由 " + holder.jobId
                    + " 于 "
                    + holder.armedAt
                    + " 开启）：重复 capture.begin 不做隐式续期，"
                    + "请先 capture.end",
                status());
        }
        holder = new Holder(jobId, action, at, seq);
    }

    /**
     * 释放（{@code capture.end}）。
     *
     * @return 是否确实释放了一个会话（false = 本来就没开场，按幂等成功处理）
     */
    public static synchronized boolean end() {
        if (holder == null) {
            return false;
        }
        holder = null;
        return true;
    }

    /**
     * 世界写动作入口的前置检查（contract.md §4.1）。
     *
     * @param jobId 调用方作业 id，可为 null
     * @throws CpException {@code CP-STATE-001}：会话期间由<b>别的</b>作业发起的世界写
     */
    public static void assertWorldWriteAllowed(String jobId) {
        Holder h = holder;
        if (h == null) {
            return;
        }
        if (h.jobId != null && h.jobId.equals(jobId)) {
            return;
        }
        throw new CpException(
            ErrorCodes.STATE,
            "捕获会话进行中（由 " + h.jobId + " 开启）：此期间禁止一切世界写动作（capture.end 后才放行）",
            status());
    }

    /** 仅供单测：清零会话。 */
    static synchronized void resetForTest() {
        holder = null;
    }
}
