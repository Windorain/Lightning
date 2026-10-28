package com.lightning.mod.client.controlplane.mc.input.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一次投递的结果（字段名即契约：**只增不改**；投递语义见 input-contract.md §4.1）。
 *
 * <p>
 * 「已投递」是设施能观测到的**最后一步**；它**不是**「已处理」，更不是业务成功（§4.1 四边界）。
 */
public final class DeliverResult {

    /** 逐条拒绝的原因（非空即整条请求失败）。 */
    public static final class Rejected {

        /** 事件在本次请求里的下标。 */
        public int index;
        /** 稳定错误码（复用既有码，§5）。 */
        public String code;
        /** 人类可读原因。 */
        public String reason;

        /** 空构造（序列化用）。 */
        public Rejected() {}

        /** 全参构造。 */
        public Rejected(int index, String code, String reason) {
            this.index = index;
            this.code = code;
            this.reason = reason;
        }
    }

    /** 写进队列的事件数。 */
    public int delivered;
    /** 逐条拒绝；非空即整条请求失败。 */
    public List<Rejected> rejected = new ArrayList<Rejected>();
    /** 投递后队列深度：键盘侧=实读；鼠标侧=设施记账（须标注不可独立复核）。 */
    public int queueDepthAfter;
    /** 投递发生的客户端 tick 序号。 */
    public long deliveredAtTick;
    /** 队列满等约束说明（nullable）。 */
    public String constraintHint;

    /** 是否整条请求被拒。 */
    public boolean hasRejections() {
        return rejected != null && !rejected.isEmpty();
    }

    /** 只读拒绝清单。 */
    public List<Rejected> rejections() {
        return rejected == null ? Collections.<Rejected>emptyList() : Collections.unmodifiableList(rejected);
    }

    /** 全部接受。 */
    public static DeliverResult accepted(int delivered, int queueDepthAfter, long tick) {
        DeliverResult r = new DeliverResult();
        r.delivered = delivered;
        r.queueDepthAfter = queueDepthAfter;
        r.deliveredAtTick = tick;
        return r;
    }

    /** 整条被拒（逐条原因必须给全，不许只报第一条）。 */
    public static DeliverResult rejected(List<Rejected> rej, String hint) {
        DeliverResult r = new DeliverResult();
        r.delivered = 0;
        r.rejected = rej == null ? new ArrayList<Rejected>() : rej;
        r.constraintHint = hint;
        return r;
    }
}
