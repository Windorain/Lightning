package com.lightning.mod.client.controlplane.core;

/**
 * 单槽「构建作业交接器」：把一次场景构建的<b>意图</b>从客户端 tick 线程交到服务端 tick 线程，
 * 再把<b>结局</b>交回客户端线程。
 *
 * <h2>为什么需要它（#89 根治，评论 1689）</h2>
 *
 * <p>
 * 缺陷现场：{@code SceneBuilder} 原来在<b>客户端 tick 线程</b>直接写服务端权威世界（逐点探针坐实
 * {@code thread=Client thread}），ctm 基线下时序竞态表现为 {@code setBlock} 的写入没有持久化
 * （写进将被丢弃的 chunk 对象是<b>最合理解释而非定论</b>）。根治 = 把构建的 tick 驱动搬到
 * <b>服务端线程</b>（本义线程），而两个线程之间唯一需要交换的就是「作业」与「结局」，
 * 本类就是这条通道。
 *
 * <h2>状态机</h2>
 *
 * <pre>
 * IDLE --trySubmit--&gt; RUNNING --take--&gt; (服务端逐 tick 推进)
 *                       |                        |
 *                       |        complete/fail/abort
 *                       v                        v
 *                 DONE | FAILED | ABORTED --poll--&gt; IDLE（槽位复位）
 * </pre>
 *
 * <ul>
 * <li>{@link State#RUNNING} 的语义是「作业在槽内」：已提交、可能已被服务端 {@link #take()} 认领
 * （认领与否由内部 {@code claimed} 标记区分，不入状态机——对调用方而言两者都是「忙」）；</li>
 * <li>{@code DONE/FAILED/ABORTED} 是「结局已就绪、待领取」；{@link #poll()} 取走结局并把槽位
 * 复位回 {@link State#IDLE}，因此<b>同一槽位可以串行服务多次构建</b>；</li>
 * <li>槽位只有一个：非 IDLE 时 {@link #trySubmit} 一律拒绝，绝不覆盖在途作业或未领取的结局。</li>
 * </ul>
 *
 * <h2>线程模型与 happens-before</h2>
 *
 * <p>
 * 两个线程各有独属的调用面：<b>客户端 tick 线程</b>调 {@link #trySubmit}/{@link #poll}
 * （顺带 {@link #discardUnclaimedOutcome}），<b>服务端 tick 线程</b>调 {@link #take}/
 * {@link #complete}/{@link #fail}/{@link #abort}。所有状态迁移都在同一把对象锁内完成，
 * 且 {@link #state} 是 {@code volatile}：
 *
 * <ul>
 * <li>{@link #trySubmit} 先在锁内写载荷字段，再写 {@code volatile state = RUNNING}；服务端
 * {@link #take} 在同一把锁内读——<b>监视器释放/获取</b>与<b>volatile 写/读</b>两条路径都给出
 * happens-before，服务端线程看到的载荷一定是构造完整的对象（载荷里那些非 final 字段的后续可见性
 * 由载荷自身负责，例如 {@code SceneBuilder} 的进度字段）；</li>
 * <li>反向（服务端 {@code complete/fail/abort} → 客户端 {@link #poll}）同理：结局在锁内写、
 * {@code volatile state} 在锁内改，客户端读到的结局与状态一致。</li>
 * </ul>
 *
 * <h2>边界（MC-free）</h2>
 *
 * <p>
 * 本类属 core 层：<b>零 {@code net.minecraft}/{@code cpw.mods} import</b>，可被 {@code src/test}
 * 下的纯 JVM 单测直接覆盖。作业载荷是 {@code Object}（+ 诊断用的 {@code String tag}），本类
 * <b>不 cast、不解析</b>它——{@code SceneBuilder} 之类的 MC 类型只许在 mc 层被放进去、取出来。
 * 失败结局携带的是「错误码 + 消息 + stack <b>字符串</b>」而非 {@code Throwable}：本层刻意不透传
 * 异常对象（它是游戏侧类型，且跨线程复活异常对象没有意义），栈以文本保真回传。
 */
public final class BuildJobMailbox {

    /** 槽位状态。 */
    public enum State {

        /** 空闲：无作业、也无未领取的结局。 */
        IDLE,

        /** 作业在槽内：已提交，可能已被服务端认领（正在服务端线程推进）。 */
        RUNNING,

        /** 已完成：结局待调用方 {@link #poll()} 领取。 */
        DONE,

        /** 已失败：结局待领取。 */
        FAILED,

        /** 已中止（如世界实例更换）：结局待领取。 */
        ABORTED;

        /** 结局是否已就绪（待领取）。 */
        public boolean settled() {
            return this == DONE || this == FAILED || this == ABORTED;
        }
    }

    /** 交接中的作业：只携带「意图」，槽位不认识任何具体类型。 */
    public static final class Job {

        private final Object payload;
        private final String tag;

        Job(Object payload, String tag) {
            this.payload = payload;
            this.tag = tag;
        }

        /** 载荷（提交方自定；本类只当它是 {@code Object}）。 */
        public Object payload() {
            return payload;
        }

        /** 作业标签（诊断用；本类不解析它）。 */
        public String tag() {
            return tag;
        }

        @Override
        public String toString() {
            return "Job[" + tag + "]";
        }
    }

    /** 作业结局：{@code DONE}/{@code FAILED}/{@code ABORTED} 三选一。 */
    public static final class Completion {

        private final State state;
        private final Object result;
        private final String errorCode;
        private final String errorMessage;
        private final String errorStack;
        private final String abortReason;

        private Completion(State state, Object result, String errorCode, String errorMessage, String errorStack,
            String abortReason) {
            this.state = state;
            this.result = result;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
            this.errorStack = errorStack;
            this.abortReason = abortReason;
        }

        /** 结局状态（恒为 {@link State#DONE}/{@link State#FAILED}/{@link State#ABORTED}）。 */
        public State state() {
            return state;
        }

        /** 是否成功完成。 */
        public boolean isDone() {
            return state == State.DONE;
        }

        /** 是否失败（服务端侧抛异常，含错误码/消息/栈文本）。 */
        public boolean isFailed() {
            return state == State.FAILED;
        }

        /** 是否中止（服务端侧主动放弃，含原因）。 */
        public boolean isAborted() {
            return state == State.ABORTED;
        }

        /** 成功时的结果载荷（调用方自定类型）；非 {@code DONE} 时为 null。 */
        public Object result() {
            return result;
        }

        /** 失败错误码；非 {@code FAILED} 时为 null。 */
        public String errorCode() {
            return errorCode;
        }

        /** 失败消息（<b>不含</b>错误码后缀，与 {@link CpException#detail()} 同口径）。 */
        public String errorMessage() {
            return errorMessage;
        }

        /** 失败栈文本（完整 {@code printStackTrace} 形态）；未提供时为 null。 */
        public String errorStack() {
            return errorStack;
        }

        /** 中止原因；非 {@code ABORTED} 时为 null。 */
        public String abortReason() {
            return abortReason;
        }
    }

    private volatile State state = State.IDLE;

    /** 以下三个字段只在 {@code synchronized} 方法内访问（state 另加 volatile 供无锁读）。 */
    private Job job;
    private boolean claimed;
    private Completion completion;

    /**
     * 提交一件作业（客户端 tick 线程调用）。
     *
     * <p>
     * 锁内先写 {@link #job}，再写 {@code volatile} 的 {@link #state}——这道 volatile 写就是交接点：
     * 服务端 {@link #take()} 一旦看到非 IDLE，随后读到的载荷字段必然可见（见类注释「线程模型」）。
     *
     * @param payload 载荷（mc 层放 {@code SceneBuilder}；core 层不解释它）
     * @param tag     作业标签（诊断用，可为 null）
     * @return 是否受理；<b>false</b> 表示槽位非 IDLE（有作业在跑，或有未领取的结局），
     *         本调用<b>不</b>改动任何已有状态（宁可拒绝，也不覆盖在途作业）
     */
    public synchronized boolean trySubmit(Object payload, String tag) {
        if (state != State.IDLE) {
            return false;
        }
        job = new Job(payload, tag);
        claimed = false;
        completion = null;
        state = State.RUNNING;
        return true;
    }

    /**
     * 认领作业（服务端 tick 线程调用）。
     *
     * <p>
     * 认领是幂等的单向动作：同一件作业只会被返回一次，第二次调用返回 null（避免服务端把同一件
     * 作业推进两遍）。结局已就绪（{@link State#DONE}/{@link State#FAILED}/{@link State#ABORTED}）
     * 时同样返回 null——此时槽位在等客户端 {@link #poll()} 领取，服务端不该再碰它。
     *
     * @return 待推进的作业；空闲、已被认领或结局待领取时返回 null
     */
    public synchronized Job take() {
        if (state != State.RUNNING || claimed || job == null) {
            return null;
        }
        claimed = true;
        return job;
    }

    /**
     * 标记作业完成（服务端 tick 线程调用）。
     *
     * @param result 结果载荷（可为 null；由调用方与 {@link #poll()} 约定类型）
     * @throws IllegalStateException 槽位不是「已认领的 RUNNING」（程序错误，响亮暴露而非静默改写状态）
     */
    public synchronized void complete(Object result) {
        requireClaimedRunning();
        completion = new Completion(State.DONE, result, null, null, null, null);
        state = State.DONE;
    }

    /**
     * 标记作业失败（服务端 tick 线程调用）。
     *
     * @param code    契约错误码（见 {@link ErrorCodes}）；null 视为 {@link ErrorCodes#EXEC_FAILED}
     * @param message 人读消息（<b>不含</b>错误码后缀；领取方会用同一码+消息重建 {@link CpException}）
     * @param stack   失败栈文本（完整 {@code printStackTrace} 形态，可为 null）
     * @throws IllegalStateException 槽位不是「已认领的 RUNNING」
     */
    public synchronized void fail(String code, String message, String stack) {
        requireClaimedRunning();
        completion = new Completion(
            State.FAILED,
            null,
            code == null ? ErrorCodes.EXEC_FAILED : code,
            message,
            stack,
            null);
        state = State.FAILED;
    }

    /**
     * 中止作业（服务端 tick 线程调用）：服务端侧主动放弃（如构建期间世界实例更换），
     * 不是「构建失败」——它表达的是「这件作业不该再写世界了」。
     *
     * @param reason 中止原因（人读，必须写清判据，如绑定的世界 identityHashCode）
     * @throws IllegalStateException 槽位不是「已认领的 RUNNING」
     */
    public synchronized void abort(String reason) {
        requireClaimedRunning();
        completion = new Completion(State.ABORTED, null, null, null, null, reason);
        state = State.ABORTED;
    }

    /**
     * 领取结局（客户端 tick 线程调用）。
     *
     * <p>
     * 领取即消费：返回非 null 的同时槽位复位回 {@link State#IDLE}，下一次 {@link #trySubmit} 因此
     * 可以立刻受理新作业。未就绪时返回 null 且不改动任何状态（调用方逐 tick 轮询即可）。
     *
     * @return 结局；未就绪（{@link State#IDLE}/{@link State#RUNNING}）时返回 null
     */
    public synchronized Completion poll() {
        if (!state.settled()) {
            return null;
        }
        Completion c = completion;
        resetIdle();
        return c;
    }

    /**
     * 丢弃「无人领取的结局」（客户端 tick 线程调用）——安全阀，不是常规路径。
     *
     * <p>
     * 为什么需要：调用方（动作）可能在结局就绪前就退出（阶段超时、动作异常、进程收尾），于是槽位
     * 永久停在 {@code DONE/FAILED/ABORTED}，后续每一次构建都会撞 {@code CP-BUSY-001}。
     * 客户端侧只有一个 tick 线程，{@link #poll()} 与 {@link #trySubmit} 不会并发，
     * 因此「结局还在且没人领」这件事是可判定的（不是竞态）：提交新作业前先调用本方法丢弃它，
     * 由调用方打 WARN 说明丢弃了什么。
     *
     * @return 是否真的丢弃了一份结局（true 时槽位已复位为 {@link State#IDLE}）
     */
    public synchronized boolean discardUnclaimedOutcome() {
        if (!state.settled()) {
            return false;
        }
        resetIdle();
        return true;
    }

    /** 当前状态（无锁读，供诊断与拒绝时的上下文用）。 */
    public State state() {
        return state;
    }

    /** 是否空闲。 */
    public boolean isIdle() {
        return state == State.IDLE;
    }

    private void requireClaimedRunning() {
        if (state != State.RUNNING || !claimed) {
            throw new IllegalStateException(
                "作业交接器状态非法：只有「已被服务端认领的 RUNNING」才能落结局，当前 state=" + state + "，claimed=" + claimed);
        }
    }

    private void resetIdle() {
        state = State.IDLE;
        job = null;
        claimed = false;
        completion = null;
    }
}
