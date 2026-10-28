package com.lightning.mod.client.controlplane.mc.input.api;

import java.util.Collections;
import java.util.List;

/**
 * 输入运行时状态的只读快照（能力面字段见 §6；此处落定**最小面**，
 * 字段/方法只增不改）。
 *
 * <p>
 * 实现归运行时侧（运行时自己产生真值）；只读消费方是观察侧（把它组装成 {@code input.state} 的响应）。
 * <b>任何没有真值来源的字段都不许出现在这里</b>——宁可缺字段，也不许用默认值伪装成「已具备」（§6 末条）。
 *
 * <h2>「读不到」怎么表达（本接口的硬约定）</h2>
 * <ul>
 * <li><b>深度类</b>用 {@link #DEPTH_UNOBSERVABLE}（{@code -1}）。<b>不得</b>用 {@code 0} 冒充
 * 「没有积压」——鼠标队列深度就是这样一项：{@code org.lwjglx.input.Mouse} 没有公开的队列深度探针，
 * {@link #mouseDepth()} 因此恒返回 {@link #DEPTH_UNOBSERVABLE}，这是<b>真值</b>而不是占位
 * （契约 §4.1 / §8 第 3 条）；键盘侧的深度是可读的，走
 * {@link #keyboardQueueDepth()}（同样是 {@code -1} = 读不到）；</li>
 * <li><b>计数类</b>用 {@link #COUNT_UNKNOWN}（{@code -1L}）；</li>
 * <li><b>列表类</b>用 {@code null} 表示「本实现给不出这份明细」（与「空表 = 确实没有条目」区分开）：
 * 见 {@link #heldDetails()}。</li>
 * </ul>
 */
public interface InputStateSnapshot {

    /** 「深度不可观测/读不到」的哨兵（**不是** 0）。 */
    int DEPTH_UNOBSERVABLE = -1;

    /** 「计数无真值」的哨兵（**不是** 0）。 */
    long COUNT_UNKNOWN = -1L;

    /** 当前消费链：{@code "gui"} | {@code "world"} | {@code "none"}（由游戏决定，设施不干预）。 */
    String consumerChain();

    /** 键盘事件队列深度（实读 {@code Keyboard.getNumKeyboardEvents()}；不含 seed 时须说明口径）。 */
    int keyboardQueueDepth();

    /** 设施当前持有的键位描述名（按作业归属）。 */
    List<String> heldKeys();

    /** 设施当前持有的鼠标按钮。 */
    List<Integer> heldButtons();

    // ------------------------------------------------------------------ 只增（首批交付项）

    /**
     * 鼠标事件队列深度。
     *
     * <p>
     * 【实测】{@code org.lwjglx.input.Mouse} <b>没有</b>公开的队列深度探针（对照物：键盘侧
     * {@code Keyboard.getNumKeyboardEvents()}），因此设施<b>无法</b>独立复核鼠标事件是否真的进了队列，
     * 只能记自己的账（{@code DeliverResult.queueDepthAfter} 的鼠标侧就是这份记账）。
     *
     * <p>
     * <b>真值 = 不可观测</b>：本方法因此恒返回 {@link #DEPTH_UNOBSERVABLE}。调用方<b>不得</b>把它当 0
     * （{@code 0} 会被读成「队列空 ⇒ 没有积压」）。若将来某个后端真能给出探针，本方法返回真实非负深度，
     * 调用方无需改判据（{@code < 0} 与 {@code >= 0} 已把两种情形分得开）。
     */
    int mouseDepth();

    /**
     * {@link #deliveredThisJob()} 所归属的作业 id。
     *
     * <p>
     * 「本作业已投递 N 条」不给作业标识就无从判读（同一个数换个作业含义完全不同），故一并给出。
     * 返回 {@code null} = 本会话<b>尚无</b>任何投递 ⇒ 没有可归属的作业。
     */
    String lastJobId();

    /**
     * 最近一次投递的作业（{@link #lastJobId()}）累计已投递的事件数。
     *
     * <p>
     * 口径与「已投递」的定义一致（契约 §4.1：事件已写入 {@code Keyboard.eventQueue} / 鼠标队列）；
     * 被幂等抑制（重复 {@code down}）与整条拒绝的事件不计。详情（含到期/释放路径由设施自动投递的
     * 抬起事件是否计入）由实现类在方法注释里写明。
     *
     * @return 计数；{@link #COUNT_UNKNOWN} = 无真值（<b>不是</b> 0）；{@link #lastJobId()} 为
     *         {@code null} 时也返回 {@link #COUNT_UNKNOWN}（无可归属的作业）
     */
    long deliveredThisJob();

    /**
     * 本会话（进程内）累计已投递的事件数。
     *
     * @return 计数；{@link #COUNT_UNKNOWN} = 无真值（<b>不是</b> 0）
     */
    long deliveredThisSession();

    /**
     * 逐条持有明细（{@code held.items[]} 的真值来源）。
     *
     * <p>
     * {@link #heldKeys()}/{@link #heldButtons()} 只给「谁被持有」，本条给出<b>归属作业与期限</b>：
     * {@code jobId}/{@code heldTicks}/{@code expiresInTicks}（后者已夹到 ≥0：到期即抬起的条目不会再
     * 报负数）。
     *
     * @return 逐条明细（按持有点的插入序）；<b>{@code null}</b> = 本实现给不出明细（消费方必须如实
     *         标注不可读，而不是把它当空表）；<b>空表</b> = 确实没有任何持有条目
     */
    List<HeldDetail> heldDetails();

    /** 是否有任何持有条目（供释放路径与泄漏检查用）。 */
    default boolean hasHeld() {
        List<String> k = heldKeys();
        List<Integer> b = heldButtons();
        return (k != null && !k.isEmpty()) || (b != null && !b.isEmpty());
    }

    // ------------------------------------------------------------------ 只增（补收交付项）

    /**
     * 运行时状态机的当前态名（契约 §7：{@code "idle"} | {@code "holding"} | {@code "releasing"} | {@code "faulted"}）。
     *
     * <p>
     * 契约 §7 要求 {@code input.state} **必报** {@code state}（含 {@code faulted}），
     * 本条是它的真值来源；此前 {@code input.state} 根本没有该字段，态只嵌在 {@code hint} 字符串里。
     *
     * @return 态名（小写，与 §7 的态名同文）；<b>{@code null}</b> = 本快照不提供状态真值
     *         （消费方必须如实标注不可读，**不得**猜成 {@code "idle"}——那会把「未知」卖成「空闲」）
     */
    default String stateName() {
        return null;
    }

    /**
     * 最近一次 {@code input.mouse op:move} 的自校准结论（读回是否落在 ±1 内，契约 §2.4 第 3/4 条）。
     *
     * <p>
     * {@code input.mouse} 与 {@code input.state} 的 {@code coordinates.selfCalibrated}
     * 必须是**同一个量**（原先能力面把它硬编码成 {@code false}，与动作返回体两处真相）。
     *
     * @return {@code TRUE}/{@code FALSE} = 最近一次 move 的读回结论；<b>{@code null}</b> = 本会话
     *         **尚无 move**（「未校准」而不是「校准失败」——两者不可混同，消费方应据此给出说明）
     */
    default Boolean lastMoveCalibrated() {
        return null;
    }

    /** 空快照（未实现/无运行时时的显式空态，不是「有状态但读不出来」）。 */
    static InputStateSnapshot empty() {
        return new InputStateSnapshot() {

            @Override
            public String consumerChain() {
                return "none";
            }

            @Override
            public int keyboardQueueDepth() {
                return 0;
            }

            @Override
            public List<String> heldKeys() {
                return Collections.emptyList();
            }

            @Override
            public List<Integer> heldButtons() {
                return Collections.emptyList();
            }

            @Override
            public int mouseDepth() {
                // 空态也不许把「不可观测」写成 0：Mouse 有没有积压，本设施永远读不到
                return DEPTH_UNOBSERVABLE;
            }

            @Override
            public String lastJobId() {
                return null;
            }

            @Override
            public long deliveredThisJob() {
                return COUNT_UNKNOWN;
            }

            @Override
            public long deliveredThisSession() {
                return COUNT_UNKNOWN;
            }

            @Override
            public List<HeldDetail> heldDetails() {
                // 明细分不出来 ⇒ null（不是空表）：本快照不代表真实状态（见类型注释的「列表类」约定）
                return null;
            }
        };
    }

    /**
     * 一条持有条目的只读明细（{@code held.items[]} 的字段来源）。
     *
     * <p>
     * 存活期口径：{@code heldTicks} 从「投递按下」那一 tick 起算；{@code expiresInTicks} 是距到期
     * 剩余 tick 数，<b>已夹到 ≥0</b>（负值只能表示「已经该抬起了」，那个状态由运行时的到期机制落定，
     * 快照不该报负数）。
     */
    final class HeldDetail {

        /** {@code kind} 取值：键位持有（{@code held[].kind == "key"}）。 */
        public static final String KIND_KEY = "key";

        /** {@code kind} 取值：鼠标按钮持有（{@code held[].kind == "button"}）。 */
        public static final String KIND_BUTTON = "button";

        private final String kind;
        private final String id;
        private final String jobId;
        private final long heldTicks;
        private final long expiresInTicks;

        /**
         * 全参构造。
         *
         * @param kind           {@link #KIND_KEY} | {@link #KIND_BUTTON}
         * @param id             键位描述名 / 按钮号字符串
         * @param jobId          归属作业（{@code null} = 未归属）
         * @param heldTicks      已持 tick 数（≥0）
         * @param expiresInTicks 距到期剩余 tick（≥0；负入参按 0 处理）
         */
        public HeldDetail(String kind, String id, String jobId, long heldTicks, long expiresInTicks) {
            this.kind = kind;
            this.id = id;
            this.jobId = jobId;
            this.heldTicks = Math.max(0L, heldTicks);
            this.expiresInTicks = Math.max(0L, expiresInTicks);
        }

        /** 见 {@link #KIND_KEY}。 */
        public String kind() {
            return kind;
        }

        /** 键位描述名或按钮号字符串。 */
        public String id() {
            return id;
        }

        /** 归属作业（{@code null} = 未归属）。 */
        public String jobId() {
            return jobId;
        }

        /** 已持 tick 数（≥0）。 */
        public long heldTicks() {
            return heldTicks;
        }

        /** 距到期剩余 tick（≥0）。 */
        public long expiresInTicks() {
            return expiresInTicks;
        }

        @Override
        public String toString() {
            return "HeldDetail[" + kind
                + " "
                + id
                + " job="
                + jobId
                + " held="
                + heldTicks
                + " expiresIn="
                + expiresInTicks
                + "]";
        }
    }
}
