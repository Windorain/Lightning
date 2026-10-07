package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;
import com.lightning.mod.client.controlplane.mc.input.api.InputRuntime;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateSnapshot;
import com.lightning.mod.client.controlplane.mc.input.api.ReleaseResult;

/**
 * 通用输入运行时的实现（Gitea #162 契约 §3 / §4 / §7；接口面由 Lead 在分叉前冻结）。
 *
 * <h2>它做什么</h2>
 * <ol>
 * <li><b>投递</b>：把 {@link InputEvent} 序列经 §1.2 白名单的五个入口写进事件队列，
 * <b>非阻塞</b>（队列满当场 {@code CP-STATE-001}，绝不在 tick 线程等队列腾空）；</li>
 * <li><b>持键表</b>：按作业归属记录「已投递按下、尚未投递抬起」的条目；每条**必有**
 * {@code expiresAtTick}（D-4：不允许无限期持有）；</li>
 * <li><b>到期自动抬起</b>：到期由设施投递抬起事件并报 {@code autoReleased}（{@code reason:"expired"}）；</li>
 * <li><b>释放</b>：{@link #releaseJob(String)} 只清本作业、{@link #releaseAll()} 全清，两者都幂等，
 * 且只清**设施自己投递过**的事件（§3.5：绝不碰 SDL 物理态、绝不 {@code unPressAllKeys}）；</li>
 * <li><b>快照</b>：{@link #snapshot()} 给出只读真值（消费链、键盘队列深度实读、持键表）；</li>
 * <li><b>如实报告冲突</b>：键盘侧用 {@code getNumKeyboardEvents()} 与自身记账之差判定
 * {@code physicalConcurrent}；鼠标侧无公开探针 ⇒ 只能 {@code "unobservable"}（§3.6，禁止编造 false）。</li>
 * </ol>
 *
 * <h2>它不做什么（逐条与契约对齐）</h2>
 * <ul>
 * <li><b>不</b>改 {@code currentScreen}/{@code allowUserInput}/{@code displayFocused}/{@code pauseOnLostFocus}；
 * 喂给错误的消费者是**真实现象**，设施如实报告（§2.10）；</li>
 * <li><b>不</b>新增 {@code ClientTickEvent} 订阅者：唯一的 tick 驱动是步进动作每 tick 的
 * {@code advance}，它调 {@link #tick()}（§9.3 第 2 条）；</li>
 * <li><b>不</b>与真实物理输入仲裁、不屏蔽、不重投（§3.6 第 2 条）；检测到「持有态与游戏内绑定态
 * 分叉」时只报告（{@code held[].gameBindingPressed} 回读），绝不自动补发（否则是按不住就无限补发的雪崩）；</li>
 * <li><b>不</b>把「已投递」写成「已处理」（§4.1）：{@code delivered} 只是写进队列的事件数。</li>
 * </ul>
 *
 * <h2>状态机（§7）</h2>
 * {@code idle} →（产生持有点）{@code holding} →（释放/到期/收尾）{@code releasing} → {@code idle}；
 * 抬起投递失败或队列被外部清空 ⇒ {@code faulted}，此后任何非释放请求都必须显式失败
 * {@code CP-STATE-001}，只有 {@code input.release} 能无条件复位到 {@code idle}（复位优先于完整性）。
 *
 * <h2>线程</h2>
 * 唯一写入者是客户端 tick 线程（{@code contract.md} §1.8）：{@link #deliver}/{@link #releaseJob}/
 * {@link #releaseAll}/{@link #tick()} 在**首次调用**时绑定调用线程，之后跨线程调用直接抛
 * {@link IllegalStateException}（HTTP 线程触碰 MC 状态是明确要防的失效模式）。{@link #snapshot()}
 * 不抛（它是只读面），但提供 {@link #onOwnerThread()} 供调用方在非 tick 线程上报
 * {@code CP-STATE-001}（§6.2 的 {@code input.state} 失败形态）。
 */
public final class InputRuntimeImpl implements InputRuntime {

    /** 设施状态（§7）。 */
    public enum State {
        /** 持键表为空且无未决投递。 */
        IDLE,
        /** 持键表非空。 */
        HOLDING,
        /** 正在投递抬起事件（瞬态，只在一 tick 内可见）。 */
        RELEASING,
        /** 所持状态与实际队列已不一致（唯一出口是 {@code input.release} 的无条件复位）。 */
        FAULTED
    }

    /** 事件种类的持有点类别。 */
    public static final String HOLD_KEY = "key";

    /** 见 {@link #HOLD_KEY}。 */
    public static final String HOLD_BUTTON = "button";

    private static volatile InputRuntimeImpl shared;

    private final InputHost host;
    private final InputSink sink;

    private volatile Thread ownerThread;

    private State state = State.IDLE;
    private String faultedReason;

    /** 持键表：键 = {@code kind|id}（物理上一个键/按钮只可能有一条），值自带作业归属。 */
    private final Map<String, HeldEntry> held = new LinkedHashMap<String, HeldEntry>();

    /** 本次会话累计投递的事件数。 */
    private long deliveredThisSession;

    /** 按作业累计投递的事件数。 */
    private final Map<String, Long> deliveredByJob = new LinkedHashMap<String, Long>();

    private String lastJobId;

    /** 已投递、尚未被观察到「本 tick 的 runTick 消费」的键盘事件数（键盘侧可独立复核）。 */
    private int pendingKeyboardEvents;

    /** 鼠标侧设施记账（无公开深度探针 ⇒ 不可独立复核，§3.6 第 3 条）。 */
    private int pendingMouseEvents;

    /** 键盘侧物理并发判定：{@code null} = 不可观测。 */
    private Boolean physicalKeyboardConcurrent;

    private List<DeliverResult.Rejected> lastRejections = new ArrayList<DeliverResult.Rejected>();
    private List<Outcome> lastOutcomes = new ArrayList<Outcome>();
    private List<ReleasedDetail> lastReleased = new ArrayList<ReleasedDetail>();
    private final List<AutoRelease> autoReleasedLog = new ArrayList<AutoRelease>();

    private boolean selfCalibrated;

    private InputRuntimeImpl(InputHost host, InputSink sink) {
        this.host = host;
        this.sink = sink;
    }

    /**
     * 进程内唯一实例（懒装配：{@link McInputHost} + {@link Lwjgl3ifyInjector}）。
     *
     * <p>
     * 装配在**首次使用**时发生，因此不在客户端里的单测/HTTP 线程不会触发任何 MC 访问。
     */
    public static InputRuntimeImpl shared() {
        InputRuntimeImpl r = shared;
        if (r == null) {
            synchronized (InputRuntimeImpl.class) {
                if (shared == null) {
                    shared = new InputRuntimeImpl(new McInputHost(), Lwjgl3ifyInjector.create());
                }
                r = shared;
            }
        }
        return r;
    }

    /** 显式装配（单测与 T2-B 的自定义装备用）。 */
    public static InputRuntimeImpl create(InputHost host, InputSink sink) {
        if (host == null || sink == null) {
            throw new IllegalArgumentException("InputHost 与 InputSink 都不能为 null");
        }
        return new InputRuntimeImpl(host, sink);
    }

    /** 观察面（T2-B 的能力声明要读它，例如 {@code runtime.injectors}）。 */
    public InputSink sink() {
        return sink;
    }

    /** MC 观察口（动作层用它解析键位目录/坐标参数）。 */
    public InputHost host() {
        return host;
    }

    // ------------------------------------------------------------------ 线程

    /** 当前是否在绑定的 tick 线程上（未绑定时恒 true）。 */
    public boolean onOwnerThread() {
        Thread t = ownerThread;
        return t == null || t == Thread.currentThread();
    }

    /** 绑定线程名（未绑定为 null），供 T2-B 组装错误上下文。 */
    public String ownerThreadName() {
        Thread t = ownerThread;
        return t == null ? null : t.getName();
    }

    private void bindOwnerThread() {
        if (ownerThread == null) {
            ownerThread = Thread.currentThread();
        }
    }

    private void assertOwnerThread() {
        if (!onOwnerThread()) {
            throw new IllegalStateException(
                "输入运行时只能在客户端 tick 线程使用（owner=" + ownerThreadName()
                    + "，current="
                    + Thread.currentThread()
                        .getName()
                    + "）；HTTP 线程不得触碰 MC 状态（contract.md §1.8）");
        }
    }

    // ------------------------------------------------------------------ tick / 到期

    /**
     * 推进一个客户端 tick 并结算到期持有（<b>唯一</b>的 tick 驱动，§9.3 第 1 条）。
     *
     * @return 本次 tick 里到期自动抬起的条目（{@code reason:"expired"}）
     */
    public List<AutoRelease> tick() {
        assertOwnerThread();
        bindOwnerThread();
        observeQueue();
        host.advanceTick();
        return expireDue();
    }

    /**
     * 结算已到期的持有（幂等）。任何交互（投递/释放/快照/tick）都会先走这一步。
     *
     * <p>
     * 到期行为：设施**自己**投递抬起事件，记 {@code autoReleased}（§3.2 / D-4）。
     * 抬起投递失败（队列满等）⇒ {@code faulted}，条目**保留**（不假装已释放），
     * 留给 {@code input.release} 的无条件复位处理。
     */
    public List<AutoRelease> expireDue() {
        long now = host.clientTick();
        List<AutoRelease> out = new ArrayList<AutoRelease>();
        Iterator<Map.Entry<String, HeldEntry>> it = held.entrySet()
            .iterator();
        while (it.hasNext()) {
            HeldEntry e = it.next()
                .getValue();
            if (e.expiresAtTick > now) {
                continue;
            }
            state = State.RELEASING;
            String failure = injectUp(e);
            long heldTicks = now - e.heldSinceTick;
            if (failure != null) {
                enterFaulted("auto-release-failed: " + failure);
                continue;
            }
            it.remove();
            AutoRelease ar = new AutoRelease(e.kind, e.id, e.jobId, heldTicks, "expired");
            out.add(ar);
            autoReleasedLog.add(ar);
            lastReleased.add(new ReleasedDetail(e.kind, e.id, e.jobId, heldTicks, e.keyCode, e.button, "expired"));
        }
        if (state == State.RELEASING) {
            state = held.isEmpty() ? State.IDLE : State.HOLDING;
        }
        return out;
    }

    /**
     * 观察队列，据此报告物理并发、并检测「队列被外部清空」这类分歧。
     *
     * <p>
     * 判据（§3.6 第 3 条）：{@code getNumKeyboardEvents()} 是公开的队列深度探针，与设施自身记账之差
     * 即非本设施投递的事件数（seed 哨兵基线为 1）。**只报告，不重投**。
     */
    private void observeQueue() {
        if (!host.keyboardReadable()) {
            // 探针不可用 ⇒ 键盘侧也不可观测，如实置 null（绝不编造 false）
            pendingKeyboardEvents = 0;
            pendingMouseEvents = 0;
            return;
        }
        noteObservedDepth(host.keyboardQueueDepth(), pendingKeyboardEvents, true);
        // 上一次投递的键盘事件已被本 tick 的 runTick 消费（输入段早于 END 阶段）⇒ 记账归零
        pendingKeyboardEvents = 0;
        pendingMouseEvents = 0;
    }

    /**
     * 把「实读队列深度」与「设施自身记账」对照（§3.6 第 3 条）。
     *
     * @param depth              实读深度
     * @param ours               设施已投递、尚未被观察到消费的事件数
     * @param faultWhenBelowSeed 深度低于 seed 哨兵时是否判 faulted（tick 路径判：那是「队列被外部清空」）
     */
    private void noteObservedDepth(int depth, int ours, boolean faultWhenBelowSeed) {
        if (depth < InputCapabilities.KEYBOARD_SEED_BASELINE) {
            if (faultWhenBelowSeed) {
                // 深度低于静态 seed 哨兵：队列被外部清空过（契约 §1.2 禁令里 clear() 的后果）
                enterFaulted(
                    "observed-queue-divergence: 键盘队列深度 " + depth
                        + " 低于 seed 基线 "
                        + InputCapabilities.KEYBOARD_SEED_BASELINE
                        + "（队列被本设施之外的代码清空）");
            }
            return;
        }
        if (depth > InputCapabilities.KEYBOARD_SEED_BASELINE + ours) {
            // 队列里多出来的事件不是本设施投递的 ⇒ 真实物理输入（或进程内另一个注入者）；只报告不重投
            physicalKeyboardConcurrent = Boolean.TRUE;
        } else if (physicalKeyboardConcurrent == null) {
            physicalKeyboardConcurrent = Boolean.FALSE;
        }
    }

    // ------------------------------------------------------------------ 投递

    @Override
    public DeliverResult deliver(List<InputEvent> events, String jobId) {
        assertOwnerThread();
        bindOwnerThread();
        long tick = host.clientTick();
        expireDue();

        if (events == null || events.isEmpty()) {
            return rejectAll(single(0, ErrorCodes.VALID_PARAM, "事件序列为空：空请求没有可判定的语义，不许静默成功"), null, tick);
        }

        if (state == State.FAULTED) {
            List<DeliverResult.Rejected> rej = new ArrayList<DeliverResult.Rejected>();
            for (int i = 0; i < events.size(); i++) {
                rej.add(
                    new DeliverResult.Rejected(
                        i,
                        ErrorCodes.STATE,
                        "输入运行时处于 faulted 态：所持状态与实际队列已不一致（原因 " + faultedReason + "）；先调 input.release 复位到 idle，设施不自动重投"));
            }
            return rejectAll(rej, "state=faulted, reason=" + faultedReason + ", released=" + releasedSummary(), tick);
        }

        // 1) 结构校验（整批先查完，逐条给出原因，避免「改一处报一处」）
        List<DeliverResult.Rejected> rejected = new ArrayList<DeliverResult.Rejected>();
        for (int i = 0; i < events.size(); i++) {
            String reason = validate(events.get(i));
            if (reason != null) {
                rejected.add(new DeliverResult.Rejected(i, ErrorCodes.VALID_PARAM, reason));
            }
        }
        if (!rejected.isEmpty()) {
            return rejectAll(rejected, "结构性参数错误：整条请求失败，未投递任何事件", tick);
        }

        // 2) 队列容量预检（§4.4 第 3 条：底层 addRawKeyEvent 对队列满**静默丢**，必须先探深度）
        int keyboardCount = 0;
        for (InputEvent e : events) {
            if (InputEvent.KIND_KEY.equals(e.kind) || InputEvent.KIND_CHAR.equals(e.kind)) {
                keyboardCount++;
            }
        }
        int depthBefore = host.keyboardReadable() ? host.keyboardQueueDepth() : -1;
        if (depthBefore >= 0) {
            // 投递前就对照一次：此刻的深度超出「seed + 自身记账」的部分只能是非本设施的事件
            // （真实物理输入或进程内另一个注入者）⇒ 如实报告并发，**不仲裁、不屏蔽、不重投**（§3.6 第 2 条）
            noteObservedDepth(depthBefore, pendingKeyboardEvents, false);
        }
        if (keyboardCount > 0 && depthBefore >= 0
            && depthBefore + keyboardCount > InputCapabilities.KEYBOARD_QUEUE_CAPACITY) {
            for (int i = 0; i < events.size(); i++) {
                rejected.add(new DeliverResult.Rejected(i, ErrorCodes.STATE, "键盘事件队列已满，拒绝投递（不做静默丢弃）"));
            }
            return rejectAll(
                rejected,
                "queue=keyboard, depth=" + depthBefore
                    + ", capacity="
                    + InputCapabilities.KEYBOARD_QUEUE_CAPACITY
                    + ", requested="
                    + keyboardCount
                    + "；底层 addRawKeyEvent 对队列满静默吞异常，设施先探深度再投递（契约 §4.4 第 3 条）",
                tick);
        }

        // 3) 逐条投递（顺序即队列顺序；跨族无全序保证，§4.3）
        List<Outcome> outcomes = new ArrayList<Outcome>(events.size());
        int delivered = 0;
        int injectedKeyboard = 0;
        for (int i = 0; i < events.size(); i++) {
            InputEvent e = events.get(i);
            Outcome o = new Outcome(i, e.kind, idOf(e), e.keyCode, e.button);
            try {
                inject(e, jobId, o, tick);
            } catch (InputInjectionException ex) {
                o.delivered = false;
                o.reason = ex.getMessage();
                outcomes.add(o);
                rejected.add(new DeliverResult.Rejected(i, ex.code(), ex.getMessage()));
                // 整条请求失败：后续事件不再投递（已投递的部分**不假装成功**，由 delivered 如实给出）
                for (int j = i + 1; j < events.size(); j++) {
                    InputEvent rest = events.get(j);
                    outcomes.add(new Outcome(j, rest.kind, idOf(rest), rest.keyCode, rest.button));
                    rejected.add(new DeliverResult.Rejected(j, ex.code(), "未投递：前序事件投递失败，整条请求失败（契约 §4.4 第 1 条）"));
                }
                lastOutcomes = outcomes;
                lastRejections = rejected;
                return finishRejected(
                    rejected,
                    "整条请求失败：投递 " + delivered + "/" + events.size() + " 条；首因 " + ex.getMessage(),
                    delivered,
                    depthBefore,
                    tick);
            }
            outcomes.add(o);
            if (o.delivered) {
                delivered++;
                if (InputEvent.KIND_KEY.equals(e.kind) || InputEvent.KIND_CHAR.equals(e.kind)) {
                    injectedKeyboard++;
                } else {
                    // 鼠标侧（按钮/移动/滚轮）都进同一条 Mouse 队列 ⇒ 一起记账（无公开深度探针）
                    pendingMouseEvents++;
                }
            }
        }
        lastOutcomes = outcomes;
        lastRejections = rejected;
        deliveredThisSession += delivered;
        if (jobId != null) {
            Long prev = deliveredByJob.get(jobId);
            deliveredByJob.put(jobId, Long.valueOf((prev == null ? 0L : prev.longValue()) + delivered));
        }
        lastJobId = jobId;
        pendingKeyboardEvents += injectedKeyboard;

        // 4) 投递后复核（键盘侧可独立复核；鼠标侧无探针 ⇒ 只能记账）
        String hint = null;
        int depthAfter = depthBefore;
        if (injectedKeyboard > 0 && depthBefore >= 0) {
            depthAfter = host.keyboardQueueDepth();
            int expected = depthBefore + injectedKeyboard;
            if (depthAfter >= 0 && depthAfter < expected) {
                enterFaulted(
                    "silent-drop: 投递 " + injectedKeyboard
                        + " 条键盘事件，但队列深度只从 "
                        + depthBefore
                        + " 变到 "
                        + depthAfter
                        + "（底层 addRawKeyEvent 对队列满静默丢异常）");
                List<DeliverResult.Rejected> rej = new ArrayList<DeliverResult.Rejected>();
                for (int i = 0; i < events.size(); i++) {
                    rej.add(
                        new DeliverResult.Rejected(
                            i,
                            ErrorCodes.STATE,
                            "投递后复核失败：事件没有全部进队列（faulted：" + faultedReason + "）"));
                }
                lastRejections = rej;
                return finishRejected(rej, "state=faulted, reason=" + faultedReason, delivered, depthAfter, tick);
            }
            if (depthAfter > expected) {
                physicalKeyboardConcurrent = Boolean.TRUE;
            }
        } else if (injectedKeyboard > 0) {
            hint = "键盘队列深度探针不可用 ⇒ 本批的「已投递」不可独立复核（设施记账）";
        } else {
            hint = "鼠标侧无公开队列深度探针 ⇒ queueDepthAfter 是设施记账（不可独立复核，契约 §3.6 第 3 条）";
        }

        DeliverResult r = new DeliverResult();
        r.delivered = delivered;
        r.queueDepthAfter = injectedKeyboard > 0 ? depthAfter : pendingMouseEvents;
        r.deliveredAtTick = tick;
        r.constraintHint = hint;
        reconcileState();
        return r;
    }

    /** 按持键表把状态机收敛到一致（idle/holding）；faulted 只能由释放复位（§7）。 */
    private void reconcileState() {
        if (state == State.FAULTED || state == State.RELEASING) {
            return;
        }
        state = held.isEmpty() ? State.IDLE : State.HOLDING;
    }

    /** 逐条投递一个事件；{@code o} 记录真实结果。 */
    private void inject(InputEvent e, String jobId, Outcome o, long tick) throws InputInjectionException {
        if (InputEvent.KIND_KEY.equals(e.kind)) {
            String key = holdKey(HOLD_KEY, o.id);
            boolean down = InputEvent.STATE_DOWN.equals(e.state);
            if (down) {
                HeldEntry existing = held.get(key);
                if (existing != null) {
                    // §3.3：down 一个已在持键表中的键 ⇒ 幂等成功，**不**重复投递第二条件按下事件
                    // （重投会让「按下」变成两次边沿，KeyBinding.onTick 的 pressTime 会多计）
                    o.delivered = false;
                    o.alreadyHeld = true;
                    o.reason = "已在持键表中（jobId=" + existing.jobId + "）：幂等成功，不重复投递";
                    return;
                }
            }
            sink.key(e.keyCode.intValue(), e.codepoint == null ? 0 : e.codepoint.intValue(), down);
            o.delivered = true;
            if (down) {
                held.put(
                    key,
                    new HeldEntry(
                        HOLD_KEY,
                        o.id,
                        e.keyCode,
                        null,
                        jobId,
                        tick,
                        tick + InputCapabilities.HOLD_TICKS_MAX));
            } else {
                HeldEntry removed = held.remove(key);
                o.wasHeld = removed != null;
                if (removed != null) {
                    lastReleased.add(
                        new ReleasedDetail(
                            removed.kind,
                            removed.id,
                            removed.jobId,
                            tick - removed.heldSinceTick,
                            removed.keyCode,
                            removed.button,
                            "delivered-up"));
                }
            }
            return;
        }
        if (InputEvent.KIND_CHAR.equals(e.kind)) {
            sink.character(e.codepoint.intValue());
            o.delivered = true;
            return;
        }
        if (InputEvent.KIND_MOUSE.equals(e.kind)) {
            String key = holdKey(HOLD_BUTTON, o.id);
            boolean down = InputEvent.STATE_DOWN.equals(e.state);
            if (down) {
                HeldEntry existing = held.get(key);
                if (existing != null) {
                    o.delivered = false;
                    o.alreadyHeld = true;
                    o.reason = "按钮已在持键表中（jobId=" + existing.jobId + "）：幂等成功，不重复投递";
                    return;
                }
            }
            sink.button(e.button.intValue(), down);
            o.delivered = true;
            if (down) {
                held.put(
                    key,
                    new HeldEntry(
                        HOLD_BUTTON,
                        o.id,
                        null,
                        e.button,
                        jobId,
                        tick,
                        tick + InputCapabilities.HOLD_TICKS_MAX));
            } else {
                HeldEntry removed = held.remove(key);
                o.wasHeld = removed != null;
                if (removed != null) {
                    lastReleased.add(
                        new ReleasedDetail(
                            removed.kind,
                            removed.id,
                            removed.jobId,
                            tick - removed.heldSinceTick,
                            removed.keyCode,
                            removed.button,
                            "delivered-up"));
                }
            }
            return;
        }
        if (InputEvent.KIND_MOVE.equals(e.kind)) {
            InputCoordinates coords = coordinates();
            if (e.dx != null || e.dy != null) {
                // relative：世界视角增量。绝对位置保持不动（读不到就传 null，表示「不改位置」）
                Double keepX = host.mouseReadable() ? Double.valueOf(host.mouseX()) : null;
                Double keepY = host.mouseReadable() ? Double.valueOf(host.mouseY()) : null;
                sink.move(
                    keepX,
                    keepY,
                    e.dx == null ? 0.0D : e.dx.doubleValue(),
                    e.dy == null ? 0.0D : e.dy.doubleValue());
                o.delivered = true;
                return;
            }
            if (!coords.usable()) {
                throw new InputInjectionException(
                    ErrorCodes.STATE,
                    "坐标换算不可用（" + coords.scaledSource() + " / " + coords.pixelScaleSource() + "）：无法把 GUI 缩放坐标换算成投递口径");
            }
            sink.move(
                Double.valueOf(coords.injectX(e.x.doubleValue())),
                Double.valueOf(coords.injectY(e.y.doubleValue())),
                0.0D,
                0.0D);
            o.delivered = true;
            return;
        }
        if (InputEvent.KIND_WHEEL.equals(e.kind)) {
            sink.wheel(e.amount.doubleValue());
            o.delivered = true;
            return;
        }
        throw new InputInjectionException(ErrorCodes.VALID_PARAM, "未知事件种类: " + e.kind);
    }

    /** 结构校验：返回拒绝原因（{@code null} = 通过）。规则逐条对应契约 §2。 */
    private static String validate(InputEvent e) {
        if (e == null) {
            return "事件为 null";
        }
        String kind = e.kind;
        if (kind == null || kind.isEmpty()) {
            return "缺 kind（允许 key|char|mouse|move|wheel）";
        }
        if (InputEvent.KIND_KEY.equals(kind)) {
            if (e.keyCode == null) {
                return "kind=key 缺 keyCode（LWJGL 键码）";
            }
            int code = e.keyCode.intValue();
            if (code < InputCapabilities.KEY_CODE_MIN || code > InputCapabilities.KEY_CODE_MAX) {
                return "keyCode 越域: " + code
                    + "（允许 "
                    + InputCapabilities.KEY_CODE_MIN
                    + ".."
                    + InputCapabilities.KEY_CODE_MAX
                    + "）";
            }
            if (!InputEvent.STATE_DOWN.equals(e.state) && !InputEvent.STATE_UP.equals(e.state)) {
                return "kind=key 的 state 取值域外: " + e.state + "（允许 down|up）";
            }
            if (e.codepoint != null && (e.codepoint.intValue() < 0 || e.codepoint.intValue() > 0xFFFF)) {
                return "codepoint 越域: " + e.codepoint + "（允许 0..65535）";
            }
            return null;
        }
        if (InputEvent.KIND_CHAR.equals(kind)) {
            if (e.codepoint == null) {
                return "kind=char 缺 codepoint";
            }
            if (e.codepoint.intValue() < 0 || e.codepoint.intValue() > 0xFFFF) {
                return "codepoint 越域: " + e.codepoint + "（允许 0..65535）";
            }
            return null;
        }
        if (InputEvent.KIND_MOUSE.equals(kind)) {
            if (e.button == null) {
                return "kind=mouse 缺 button";
            }
            int b = e.button.intValue();
            if (b < 0 || b > 2) {
                return "button 取值域外: " + b + "（LWJGL 编号 0/1/2 = 左/右/中）";
            }
            if (!InputEvent.STATE_DOWN.equals(e.state) && !InputEvent.STATE_UP.equals(e.state)) {
                return "kind=mouse 的 state 取值域外: " + e.state + "（允许 down|up）";
            }
            return null;
        }
        if (InputEvent.KIND_MOVE.equals(kind)) {
            boolean relative = e.dx != null || e.dy != null;
            if (relative) {
                if (e.x != null || e.y != null) {
                    return "相对与绝对不可混用：kind=move 同时给了 x/y 与 dx/dy（§2.5）";
                }
                return null;
            }
            if (e.x == null || e.y == null) {
                return "kind=move 缺坐标：绝对定位要给 x/y（GUI 缩放坐标），相对定位要给 dx/dy";
            }
            return null;
        }
        if (InputEvent.KIND_WHEEL.equals(kind)) {
            if (e.amount == null) {
                return "kind=wheel 缺 amount";
            }
            double a = e.amount.doubleValue();
            if (!isFinite(a)) {
                return "amount 非有限数: " + a;
            }
            if (a != Math.rint(a)) {
                return "amount 必须是非零整数档（生产侧累积取整会吞掉小数）: " + a;
            }
            if (a == 0.0D) {
                return "amount=0 是零档，无意义（不许当 no-op 绿）";
            }
            if (Math.abs(a) > InputCapabilities.WHEEL_AMOUNT_MAX) {
                return "amount 越界: " + a + "（|amount| ≤ " + InputCapabilities.WHEEL_AMOUNT_MAX + "）";
            }
            return null;
        }
        return "kind 取值域外: " + kind + "（允许 key|char|mouse|move|wheel）";
    }

    private static boolean isFinite(double v) {
        return !Double.isNaN(v) && !Double.isInfinite(v);
    }

    // ------------------------------------------------------------------ 释放

    @Override
    public ReleaseResult releaseJob(String jobId) {
        assertOwnerThread();
        bindOwnerThread();
        return releaseMatching(jobId);
    }

    @Override
    public ReleaseResult releaseAll() {
        assertOwnerThread();
        bindOwnerThread();
        // §7：faulted 态的 input.release 无条件复位到 idle（复位优先于完整性，接受丢事件）
        ReleaseResult r = releaseMatching(null);
        if (state == State.FAULTED) {
            state = held.isEmpty() ? State.IDLE : State.HOLDING;
            faultedReason = null;
        }
        return r;
    }

    private ReleaseResult releaseMatching(String jobId) {
        long tick = host.clientTick();
        List<ReleasedDetail> details = new ArrayList<ReleasedDetail>();
        int released = 0;
        // 只在有东西可释放时进入 releasing（§7：releasing 是瞬态，只在一 tick 内可见）
        if (!held.isEmpty() && state != State.FAULTED) {
            state = State.RELEASING;
        }
        Iterator<Map.Entry<String, HeldEntry>> it = held.entrySet()
            .iterator();
        while (it.hasNext()) {
            HeldEntry e = it.next()
                .getValue();
            if (jobId != null && !jobId.equals(e.jobId)) {
                continue;
            }
            String failure = injectUp(e);
            if (failure != null) {
                // 释放路径承诺「尽力抬起」：投递失败必须显式化为 faulted，不得静默留在 releasing
                enterFaulted("release-failed: " + failure);
                continue;
            }
            it.remove();
            released++;
            details.add(
                new ReleasedDetail(
                    e.kind,
                    e.id,
                    e.jobId,
                    tick - e.heldSinceTick,
                    e.keyCode,
                    e.button,
                    jobId == null ? "explicit-release" : "job-release"));
        }
        lastReleased = details;
        if (state == State.RELEASING) {
            state = held.isEmpty() ? State.IDLE : State.HOLDING;
        }
        ReleaseResult r = new ReleaseResult();
        r.released = released;
        r.releasedAtTick = tick;
        r.jobId = jobId;
        for (ReleasedDetail d : details) {
            if (HOLD_KEY.equals(d.kind)) {
                r.keyCodes.add(d.keyCode);
            } else {
                r.buttons.add(d.button);
            }
        }
        return r;
    }

    /** 投递某个持有点的抬起事件；成功返回 {@code null}，失败返回原因。 */
    private String injectUp(HeldEntry e) {
        try {
            if (HOLD_KEY.equals(e.kind)) {
                sink.key(e.keyCode.intValue(), 0, false);
                pendingKeyboardEvents++;
            } else {
                sink.button(e.button.intValue(), false);
                // 鼠标侧没有深度探针 ⇒ 只维护设施自己的记账（不可独立复核，§3.6 第 3 条）
                pendingMouseEvents++;
            }
            return null;
        } catch (InputInjectionException ex) {
            return ex.getMessage();
        } catch (Throwable t) {
            return String.valueOf(t);
        }
    }

    // ------------------------------------------------------------------ 快照与只读真值

    @Override
    public InputStateSnapshot snapshot() {
        long now = host.clientTick();
        List<String> keys = new ArrayList<String>();
        List<Integer> buttons = new ArrayList<Integer>();
        for (HeldEntry e : held.values()) {
            if (HOLD_KEY.equals(e.kind)) {
                keys.add(e.id);
            } else {
                buttons.add(e.button);
            }
        }
        return new Snapshot(
            host.consumerChain(),
            host.keyboardReadable() ? host.keyboardQueueDepth() : -1,
            keys,
            buttons,
            state,
            now);
    }

    /** 只读快照实现（多带几个只增的只读访问器，供动作层与 T2-B 组装结果）。 */
    public static final class Snapshot implements InputStateSnapshot {

        private final String consumerChain;
        private final int keyboardQueueDepth;
        private final List<String> heldKeys;
        private final List<Integer> heldButtons;
        private final State state;
        private final long tick;

        Snapshot(String consumerChain, int keyboardQueueDepth, List<String> heldKeys, List<Integer> heldButtons,
            State state, long tick) {
            this.consumerChain = consumerChain;
            this.keyboardQueueDepth = keyboardQueueDepth;
            this.heldKeys = Collections.unmodifiableList(new ArrayList<String>(heldKeys));
            this.heldButtons = Collections.unmodifiableList(new ArrayList<Integer>(heldButtons));
            this.state = state;
            this.tick = tick;
        }

        @Override
        public String consumerChain() {
            return consumerChain;
        }

        /**
         * 键盘队列深度<b>实读</b>。
         *
         * <p>
         * {@code -1} = 探针不可读（**不是** 0）：「读不到」与「空队列」必须分得开（§5.2 口径）。
         */
        @Override
        public int keyboardQueueDepth() {
            return keyboardQueueDepth;
        }

        @Override
        public List<String> heldKeys() {
            return heldKeys;
        }

        @Override
        public List<Integer> heldButtons() {
            return heldButtons;
        }

        /** 设施状态名。 */
        public String stateName() {
            return state.name()
                .toLowerCase(Locale.ROOT);
        }

        /** 快照取的 tick。 */
        public long tick() {
            return tick;
        }
    }

    /** 当前状态。 */
    public State state() {
        return state;
    }

    /** 当前状态名（小写，与 §7 的态名一致）。 */
    public String stateName() {
        return state.name()
            .toLowerCase(Locale.ROOT);
    }

    /** faulted 原因；非 faulted 为 {@code null}。 */
    public String faultedReason() {
        return faultedReason;
    }

    private void enterFaulted(String reason) {
        if (state != State.FAULTED) {
            state = State.FAULTED;
            faultedReason = reason;
            CpLog.warn("输入运行时进入 faulted 态（不自动重投）: %s", reason);
        } else if (faultedReason == null) {
            faultedReason = reason;
        }
    }

    /** 持键表快照（只读，按插入序）。 */
    public List<HeldEntry> heldEntries() {
        return Collections.unmodifiableList(new ArrayList<HeldEntry>(held.values()));
    }

    /** 某一持有点是否在表中。 */
    public boolean isHeld(String kind, String id) {
        return held.containsKey(holdKey(kind, id));
    }

    /**
     * 收窄某个持有点的到期时刻（只允许**缩短**，绝不越过 1200 tick 的设施上限）。
     *
     * <p>
     * 用途：{@code input.key}/{@code input.mouse} 的 {@code tap}/{@code click} 用 {@code holdTicks}
     * 表达「按 N 个 tick」，设施据此把该条目的到期时刻收窄到 N ⇒ 抬起由**到期机制**统一收口，
     * 动作即使异常/超时也不会留下永久按下的键（D-4 的落地形态）。
     *
     * @return 是否收窄成功（条目不存在或未变短时为 false，不算错误）
     */
    public boolean planExpiry(String jobId, String kind, String id, int holdTicks) {
        HeldEntry e = held.get(holdKey(kind, id));
        if (e == null) {
            return false;
        }
        if (jobId != null && e.jobId != null && !jobId.equals(e.jobId)) {
            return false;
        }
        long wanted = e.heldSinceTick + Math.max(1, Math.min(holdTicks, InputCapabilities.HOLD_TICKS_MAX));
        if (wanted < e.expiresAtTick) {
            e.expiresAtTick = wanted;
            return true;
        }
        return false;
    }

    /** 本次会话累计投递的事件数。 */
    public long deliveredThisSession() {
        return deliveredThisSession;
    }

    /** 某作业累计投递的事件数（无记录返回 0）。 */
    public long deliveredForJob(String jobId) {
        Long v = jobId == null ? null : deliveredByJob.get(jobId);
        return v == null ? 0L : v.longValue();
    }

    /** 最近一次投递的作业 id。 */
    public String lastJobId() {
        return lastJobId;
    }

    /** 最近一次投递的逐条结果（只在同一 tick 线程内有效，下一次投递/释放会覆盖）。 */
    public List<Outcome> lastOutcomes() {
        return Collections.unmodifiableList(lastOutcomes);
    }

    /** 最近一次投递的拒绝清单。 */
    public List<DeliverResult.Rejected> lastRejections() {
        return Collections.unmodifiableList(lastRejections);
    }

    /** 最近一次释放/到期的逐条明细（{@code input.release} 的 {@code released[]} 取它）。 */
    public List<ReleasedDetail> lastReleased() {
        return Collections.unmodifiableList(lastReleased);
    }

    /** 本次会话所有到期自动抬起的记录。 */
    public List<AutoRelease> autoReleased() {
        return Collections.unmodifiableList(autoReleasedLog);
    }

    /** 键盘侧物理并发：{@code null} = 探针不可用（不可观测）。 */
    public Boolean physicalConcurrentKeyboard() {
        return physicalKeyboardConcurrent;
    }

    /**
     * 动作返回值里的 {@code physicalConcurrent} 口径。
     *
     * @param mouseInvolved 本请求是否涉及鼠标事件（鼠标侧无公开深度探针 ⇒ 只能 {@code "unobservable"}）
     */
    public Object physicalConcurrentFor(boolean mouseInvolved) {
        if (mouseInvolved) {
            return InputCapabilities.MOUSE_QUEUE_DEPTH;
        }
        Boolean b = physicalKeyboardConcurrent;
        return b == null ? "unobservable（键盘队列深度探针不可用）" : b;
    }

    /** 最近一次 {@code move} 的读回是否落在 ±1 内（自校准，§2.4 第 3/4 条）。 */
    public boolean selfCalibrated() {
        return selfCalibrated;
    }

    /** 记录一次 {@code move} 的自校准结论（由动作层在回读后调用）。 */
    public void recordCalibration(boolean calibrated) {
        this.selfCalibrated = calibrated;
    }

    /** 当前换算参数（每次现取，尺寸随窗口/界面变化）。 */
    public InputCoordinates coordinates() {
        return InputCoordinates.of(
            host.scaledWidth(),
            host.scaledHeight(),
            host.displayWidth(),
            host.displayHeight(),
            host.pixelScale(),
            host.scaledSource(),
            host.pixelScaleSource());
    }

    /** 键盘队列深度实读；{@code -1} = 不可读。 */
    public int keyboardDepth() {
        return host.keyboardReadable() ? host.keyboardQueueDepth() : -1;
    }

    /** 鼠标侧设施记账（不可独立复核）。 */
    public int mouseAccounting() {
        return pendingMouseEvents;
    }

    /** 持键表的 JSON 形态（§5.2 {@code held}；{@code gameBindingPressed} 是回读值，不是推测）。 */
    public JsonObject heldJson() {
        long now = host.clientTick();
        JsonObject o = new JsonObject();
        o.addProperty("count", held.size());
        JsonArray items = new JsonArray();
        for (HeldEntry e : held.values()) {
            JsonObject it = new JsonObject();
            it.addProperty("kind", e.kind);
            it.addProperty("id", e.id);
            if (e.keyCode != null) {
                it.addProperty("keyCode", e.keyCode);
            }
            if (e.button != null) {
                it.addProperty("button", e.button);
            }
            it.addProperty("jobId", e.jobId);
            it.addProperty("heldTicks", now - e.heldSinceTick);
            it.addProperty("expiresAtTick", e.expiresAtTick);
            it.addProperty("expiresInTicks", Math.max(0L, e.expiresAtTick - now));
            // §3.6 第 4 条：进 GUI 会 unPressAllKeys，逻辑持有与游戏内绑定态会分叉 ⇒ **回读**该值
            it.addProperty(
                "gameBindingPressed",
                e.keyCode == null ? null : Boolean.valueOf(host.keyBindingPressed(e.keyCode.intValue())));
            items.add(it);
        }
        o.add("items", items);
        return o;
    }

    /** 释放明细的 JSON 列表（{@code input.release} 的 {@code released[]}，§6.2）。 */
    public static JsonArray releasedJson(List<ReleasedDetail> details) {
        JsonArray a = new JsonArray();
        for (ReleasedDetail d : details) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", d.kind);
            o.addProperty("id", d.id);
            if (d.keyCode != null) {
                o.addProperty("keyCode", d.keyCode);
            }
            if (d.button != null) {
                o.addProperty("button", d.button);
            }
            o.addProperty("jobId", d.jobId);
            o.addProperty("heldTicks", d.heldTicks);
            o.addProperty("reason", d.reason);
            a.add(o);
        }
        return a;
    }

    /** 到期自动抬起明细的 JSON 列表（{@code autoReleased[]}，§3.2）。 */
    public static JsonArray autoReleasedJson(List<AutoRelease> list) {
        JsonArray a = new JsonArray();
        for (AutoRelease ar : list) {
            o(a, ar);
        }
        return a;
    }

    private static void o(JsonArray a, AutoRelease ar) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", ar.kind);
        o.addProperty("id", ar.id);
        o.addProperty("jobId", ar.jobId);
        o.addProperty("heldTicks", ar.heldTicks);
        o.addProperty("reason", ar.reason);
        a.add(o);
    }

    private String releasedSummary() {
        return releasedJson(lastReleased).toString();
    }

    // ------------------------------------------------------------------ 结果载体

    /** 逐条投递结果（{@link DeliverResult} 冻结面之外的只增信息：幂等判定、抑制原因）。 */
    public static final class Outcome {

        /** 事件下标。 */
        public final int index;
        /** 事件种类。 */
        public final String kind;
        /** 持有点标识（键位描述名 / 按钮号字符串）。 */
        public final String id;
        /** LWJGL 键码（kind=key）。 */
        public final Integer keyCode;
        /** 鼠标按钮（kind=mouse）。 */
        public final Integer button;
        /** 是否真的写进了队列（幂等抑制时为 false）。 */
        public boolean delivered;
        /** {@code down} 一个已在持键表中的键/按钮（§3.3 幂等成功）。 */
        public boolean alreadyHeld;
        /** {@code up} 一个不在持键表中的键/按钮（§3.3 幂等成功）。 */
        public boolean wasHeld;
        /** 未投递/抑制的原因（nullable）。 */
        public String reason;

        Outcome(int index, String kind, String id, Integer keyCode, Integer button) {
            this.index = index;
            this.kind = kind;
            this.id = id;
            this.keyCode = keyCode;
            this.button = button;
        }
    }

    /** 一个持有点。 */
    public static final class HeldEntry {

        /** {@code "key"} | {@code "button"}。 */
        public final String kind;
        /** 键位描述名或按钮号字符串。 */
        public final String id;
        /** LWJGL 键码（kind=key）。 */
        public final Integer keyCode;
        /** 鼠标按钮号（kind=button）。 */
        public final Integer button;
        /** 归属作业。 */
        public final String jobId;
        /** 投递按下的 tick。 */
        public final long heldSinceTick;
        /** 到期 tick（**必有**：无期限持有是禁止的，§3.2 / D-4）。 */
        public long expiresAtTick;

        HeldEntry(String kind, String id, Integer keyCode, Integer button, String jobId, long heldSinceTick,
            long expiresAtTick) {
            this.kind = kind;
            this.id = id;
            this.keyCode = keyCode;
            this.button = button;
            this.jobId = jobId;
            this.heldSinceTick = heldSinceTick;
            this.expiresAtTick = expiresAtTick;
        }
    }

    /** 到期自动抬起的一条记录。 */
    public static final class AutoRelease {

        /** 见 {@link HeldEntry#kind}。 */
        public final String kind;
        /** 见 {@link HeldEntry#id}。 */
        public final String id;
        /** 归属作业。 */
        public final String jobId;
        /** 实际持有 tick 数。 */
        public final long heldTicks;
        /** 原因（本实现只用 {@code "expired"}；只增不改义）。 */
        public final String reason;

        AutoRelease(String kind, String id, String jobId, long heldTicks, String reason) {
            this.kind = kind;
            this.id = id;
            this.jobId = jobId;
            this.heldTicks = heldTicks;
            this.reason = reason;
        }
    }

    /** 一条释放明细（{@code input.release} 的 {@code released[]}，§6.2）。 */
    public static final class ReleasedDetail {

        /** 见 {@link HeldEntry#kind}。 */
        public final String kind;
        /** 见 {@link HeldEntry#id}。 */
        public final String id;
        /** 归属作业。 */
        public final String jobId;
        /** 实际持有 tick 数。 */
        public final long heldTicks;
        /** LWJGL 键码（kind=key）。 */
        public final Integer keyCode;
        /** 鼠标按钮（kind=button）。 */
        public final Integer button;
        /** {@code explicit-release} | {@code job-release} | {@code expired} | {@code delivered-up}。 */
        public final String reason;

        ReleasedDetail(String kind, String id, String jobId, long heldTicks, Integer keyCode, Integer button,
            String reason) {
            this.kind = kind;
            this.id = id;
            this.jobId = jobId;
            this.heldTicks = heldTicks;
            this.keyCode = keyCode;
            this.button = button;
            this.reason = reason;
        }
    }

    // ------------------------------------------------------------------ 内部工具

    private static String holdKey(String kind, String id) {
        return kind + "|" + id;
    }

    private static String idOf(InputEvent e) {
        if (InputEvent.KIND_KEY.equals(e.kind)) {
            return e.key != null && !e.key.isEmpty() ? e.key : "code:" + e.keyCode;
        }
        if (InputEvent.KIND_MOUSE.equals(e.kind)) {
            return String.valueOf(e.button);
        }
        return e.kind == null ? "unknown" : e.kind;
    }

    private static List<DeliverResult.Rejected> single(int index, String code, String reason) {
        List<DeliverResult.Rejected> l = new ArrayList<DeliverResult.Rejected>(1);
        l.add(new DeliverResult.Rejected(index, code, reason));
        return l;
    }

    /** 整条拒绝（{@code delivered=0}）。 */
    private DeliverResult rejectAll(List<DeliverResult.Rejected> rejected, String hint, long tick) {
        DeliverResult r = new DeliverResult();
        r.delivered = 0;
        r.rejected = rejected;
        r.queueDepthAfter = keyboardDepth();
        r.deliveredAtTick = tick;
        r.constraintHint = hint;
        lastRejections = rejected;
        return r;
    }

    private DeliverResult finishRejected(List<DeliverResult.Rejected> rejected, String hint, int delivered,
        int depthAfter, long tick) {
        DeliverResult r = new DeliverResult();
        r.delivered = delivered;
        r.rejected = rejected;
        r.queueDepthAfter = depthAfter;
        r.deliveredAtTick = tick;
        r.constraintHint = hint;
        return r;
    }

    /** 未实现清单（T2-B 组装 {@code input.state.notImplemented} 时取它，同源）。 */
    public JsonArray notImplementedJson() {
        return InputCapabilities.notImplementedJson();
    }

    /** 类别名 → 持有点类别（动作层用）。 */
    public static String holdKindOf(String eventKind) {
        if (InputEvent.KIND_KEY.equals(eventKind)) {
            return HOLD_KEY;
        }
        if (InputEvent.KIND_MOUSE.equals(eventKind)) {
            return HOLD_BUTTON;
        }
        return null;
    }

    /** 只读：本设施不知道的东西也一并说清（能力定位「到达游戏自己的路由 + 如实报告边界」）。 */
    public JsonObject boundaryJson() {
        JsonObject o = new JsonObject();
        o.addProperty("pollSurface", InputCapabilities.POLL_SURFACE);
        o.addProperty("mouseQueueDepth", InputCapabilities.MOUSE_QUEUE_DEPTH);
        o.addProperty("crash", InputCapabilities.CRASH);
        o.addProperty("worldUnload", InputCapabilities.WORLD_UNLOAD);
        o.addProperty("cancel", InputCapabilities.CANCEL);
        o.add("lifecycle", Json.object("cleanupPaths", InputCapabilities.cleanupPathsJson()));
        return o;
    }
}
