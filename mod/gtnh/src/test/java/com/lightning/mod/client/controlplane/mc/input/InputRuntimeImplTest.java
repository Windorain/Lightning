package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl.AutoRelease;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl.Outcome;
import com.lightning.mod.client.controlplane.mc.input.InputTestDoubles.FakeHost;
import com.lightning.mod.client.controlplane.mc.input.InputTestDoubles.FakeSink;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateSnapshot;
import com.lightning.mod.client.controlplane.mc.input.api.ReleaseResult;

/**
 * 输入运行时（{@link InputRuntimeImpl}）的离线单测：状态机、到期自动抬起、幂等释放、按作业隔离、
 * 队列满的**非阻塞**拒绝、faulted 的产生与复位、物理并发的如实报告（契约 §3 / §4 / §7）。
 *
 * <p>
 * 全部用 {@link FakeHost}/{@link FakeSink} 驱动，<b>不需要客户端</b>——包括 tick 推进（假 host 的
 * tick 是确定性的，不掺墙钟）。
 */
public class InputRuntimeImplTest {

    private FakeHost host;
    private FakeSink sink;
    private InputRuntimeImpl rt;

    @Before
    public void setUp() {
        host = new FakeHost();
        sink = new FakeSink(host);
        rt = InputRuntimeImpl.create(host, sink);
    }

    // ------------------------------------------------------------------ 状态机

    /** idle → holding → releasing → idle（§7 的主链）。 */
    @Test
    public void stateMachineWalksIdleHoldingReleasingIdle() {
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
        DeliverResult r = rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertFalse(r.hasRejections());
        assertEquals(1, r.delivered);
        assertEquals(InputRuntimeImpl.State.HOLDING, rt.state());

        InputStateSnapshot snap = rt.snapshot();
        assertTrue(snap.hasHeld());
        assertEquals(
            1,
            snap.heldKeys()
                .size());
        assertEquals(
            "key.forward",
            snap.heldKeys()
                .get(0));
        assertTrue(
            snap.heldButtons()
                .isEmpty());

        ReleaseResult rr = rt.releaseAll();
        assertEquals(1, rr.released);
        assertEquals(
            Integer.valueOf(17),
            rr.keyCodeList()
                .get(0));
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
        assertFalse(
            rt.snapshot()
                .hasHeld());
        // 投递序：down 在前、up 在后
        assertEquals(2, sink.writes.size());
        assertEquals("key:17:down", sink.writes.get(0));
        assertEquals("key:17:up", sink.writes.get(1));
    }

    /** 释放幂等：第二次释放 count=0（不是错误，§3.3）。 */
    @Test
    public void releaseAllIsIdempotent() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(1, rt.releaseAll().released);
        ReleaseResult second = rt.releaseAll();
        assertEquals(0, second.released);
        assertEquals(
            0,
            second.keyCodeList()
                .size());
    }

    /** {@code up} 一个不在持键表中的键：仍投递抬起（无害），返回 wasHeld:false（§3.3）。 */
    @Test
    public void upWhenNotHeldIsIdempotentButStillDelivered() {
        DeliverResult r = rt.deliver(one(InputEvent.key("key.forward", 17, false, Integer.valueOf(0))), "j1");
        assertEquals(1, r.delivered);
        assertFalse(r.hasRejections());
        Outcome o = rt.lastOutcomes()
            .get(0);
        assertFalse(o.wasHeld);
        assertTrue(o.delivered);
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
        assertEquals("key:17:up", sink.writes.get(0));
    }

    /**
     * {@code down} 一个已在持键表中的键：幂等成功，<b>不重投</b>第二条件按下事件（§3.3）。
     *
     * <p>
     * 重投会让「按下」变成两次边沿，{@code KeyBinding.onTick} 的 {@code pressTime} 会多计——
     * 这条断言就是防它。
     */
    @Test
    public void duplicateDownIsIdempotentAndDoesNotDoublePress() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        host.advanceTick();
        DeliverResult second = rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j2");
        assertFalse(second.hasRejections());
        assertEquals(0, second.delivered);
        assertTrue(
            rt.lastOutcomes()
                .get(0).alreadyHeld);
        assertEquals("只投递过一次按下", 1, sink.count("key:17:down"));
    }

    /** 按作业隔离：{@code releaseJob} 只清本作业的条目（§3.1.2）。 */
    @Test
    public void releaseJobOnlyClearsItsOwnEntries() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        host.advanceTick();
        rt.deliver(one(InputEvent.key("key.jump", 57, true, Integer.valueOf(0))), "j2");
        assertEquals(
            2,
            rt.heldEntries()
                .size());

        ReleaseResult rr = rt.releaseJob("j1");
        assertEquals(1, rr.released);
        assertEquals("j1", rr.jobId);
        assertFalse(rt.isHeld(InputRuntimeImpl.HOLD_KEY, "key.forward"));
        assertTrue(rt.isHeld(InputRuntimeImpl.HOLD_KEY, "key.jump"));
        assertEquals(InputRuntimeImpl.State.HOLDING, rt.state());

        assertEquals(1, rt.releaseAll().released);
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
    }

    /** 全清跨作业；释放明细带 jobId 与实际持有 tick 数（§6.2）。 */
    @Test
    public void releaseAllReportsPerEntryDetails() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        for (int i = 0; i < 5; i++) {
            rt.tick();
        }
        ReleaseResult rr = rt.releaseAll();
        assertEquals(1, rr.released);
        assertNull("releaseAll 的 jobId 为 null（跨作业）", rr.jobId);
        InputRuntimeImpl.ReleasedDetail d = rt.lastReleased()
            .get(0);
        assertEquals("key", d.kind);
        assertEquals("key.forward", d.id);
        assertEquals("j1", d.jobId);
        assertEquals(5L, d.heldTicks);
        assertEquals("explicit-release", d.reason);
    }

    // ------------------------------------------------------------------ 到期自动抬起

    /** 单条目上限 1200 tick：到期由设施自动投递抬起并报 {@code autoReleased}（§3.2 / D-4）。 */
    @Test
    public void holdsExpireAtCapAndAutoRelease() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        InputRuntimeImpl.HeldEntry e = rt.heldEntries()
            .get(0);
        assertEquals(0L, e.heldSinceTick);
        assertEquals(InputCapabilities.HOLD_TICKS_MAX, e.expiresAtTick);

        List<AutoRelease> due = new ArrayList<AutoRelease>();
        for (int i = 1; i <= InputCapabilities.HOLD_TICKS_MAX; i++) {
            List<AutoRelease> step = rt.tick();
            if (i < InputCapabilities.HOLD_TICKS_MAX) {
                assertTrue("未到期前不得抬起（tick " + i + "）", step.isEmpty());
            } else {
                due.addAll(step);
            }
        }
        assertEquals(1, due.size());
        assertEquals("expired", due.get(0).reason);
        assertEquals("key.forward", due.get(0).id);
        assertEquals(InputCapabilities.HOLD_TICKS_MAX, due.get(0).heldTicks);
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
        assertEquals(
            0,
            rt.heldEntries()
                .size());
        assertEquals("键在到期时被抬起", 1, sink.count("key:17:up"));
        assertEquals(
            1,
            rt.autoReleased()
                .size());
    }

    /** {@code tap}/{@code click} 的 holdTicks 收窄到期时刻；且只许**缩短**，不许越过设施上限。 */
    @Test
    public void planExpiryNarrowsButNeverLengthens() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertTrue(rt.planExpiry("j1", InputRuntimeImpl.HOLD_KEY, "key.forward", 3));
        assertEquals(
            3L,
            rt.heldEntries()
                .get(0).expiresAtTick);
        assertFalse("不得把到期时刻推长（上限即 1200）", rt.planExpiry("j1", InputRuntimeImpl.HOLD_KEY, "key.forward", 1200));
        assertEquals(
            3L,
            rt.heldEntries()
                .get(0).expiresAtTick);
        assertFalse("不是本作业的条目不得被改", rt.planExpiry("j9", InputRuntimeImpl.HOLD_KEY, "key.forward", 1));

        rt.tick();
        assertEquals(
            0,
            rt.tick()
                .size());
        assertEquals("第 3 个 tick 才到期", 0, sink.count("key:17:up"));
        assertEquals(
            1,
            rt.tick()
                .size());
        assertEquals(1, sink.count("key:17:up"));
    }

    /** 鼠标按钮与键同样有上限与到期（持有点按 kind 区分）。 */
    @Test
    public void buttonHoldsAlsoExpire() {
        rt.deliver(one(InputEvent.button(0, true)), "j1");
        assertEquals(InputRuntimeImpl.State.HOLDING, rt.state());
        assertTrue(rt.planExpiry("j1", InputRuntimeImpl.HOLD_BUTTON, "0", 2));
        rt.tick();
        assertEquals(0, sink.count("button:0:up"));
        assertEquals(
            1,
            rt.tick()
                .size());
        assertEquals(1, sink.count("button:0:up"));
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
    }

    // ------------------------------------------------------------------ 队列满与 faulted

    /**
     * 队列满 ⇒ 立刻 {@code CP-STATE-001}，<b>非阻塞</b>（本测试同时证明「没有任何事件被写出去」，
     * 即没有部分成功还报绿）。
     */
    @Test
    public void queueFullIsRejectedImmediatelyWithoutPartialDelivery() {
        host.keyboardDepth = InputCapabilities.KEYBOARD_QUEUE_CAPACITY - 1;
        List<InputEvent> batch = new ArrayList<InputEvent>();
        batch.add(InputEvent.key("key.forward", 17, true, Integer.valueOf(0)));
        batch.add(InputEvent.key("key.forward", 17, false, Integer.valueOf(0)));
        DeliverResult r = rt.deliver(batch, "j1");
        assertTrue(r.hasRejections());
        assertEquals(0, r.delivered);
        assertEquals(
            ErrorCodes.STATE,
            r.rejections()
                .get(0).code);
        assertTrue(r.constraintHint, r.constraintHint.contains("capacity") && r.constraintHint.contains("requested=2"));
        assertTrue("拒绝后不得写任何事件", sink.writes.isEmpty());
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
    }

    /** 键盘探针不可用 ⇒ 不假装「没有冲突」：深度报 -1（不是 0），提示词说明不可独立复核。 */
    @Test
    public void unreadableQueueIsReportedAsMinusOneNotZero() {
        host.keyboardReadable = false;
        assertEquals(-1, rt.keyboardDepth());
        assertEquals(
            -1,
            rt.snapshot()
                .keyboardQueueDepth());
        DeliverResult r = rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(1, r.delivered);
        assertNotNull(r.constraintHint);
        assertTrue(r.constraintHint, r.constraintHint.contains("不可独立复核"));
    }

    /**
     * 底层静默丢（{@code addRawKeyEvent} 对队列满吞异常）⇒ 投递后复核必须发现并进入 faulted（§4.4 第 3 条）；
     * faulted 态下任何非释放请求显式失败，{@code input.release} 无条件复位（§7）。
     */
    @Test
    public void silentDropFaultsAndReleaseResetsUnconditionally() {
        sink.silentDrop = true;
        DeliverResult r = rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertTrue(r.hasRejections());
        assertEquals(
            ErrorCodes.STATE,
            r.rejections()
                .get(0).code);
        assertEquals(InputRuntimeImpl.State.FAULTED, rt.state());
        assertTrue(
            rt.faultedReason(),
            rt.faultedReason()
                .contains("silent-drop"));

        DeliverResult again = rt.deliver(one(InputEvent.key("key.forward", 17, false, Integer.valueOf(0))), "j1");
        assertTrue(again.hasRejections());
        assertEquals(
            ErrorCodes.STATE,
            again.rejections()
                .get(0).code);
        assertTrue(
            again.rejections()
                .get(0).reason,
            again.rejections()
                .get(0).reason.contains("faulted"));

        rt.releaseAll();
        assertEquals(InputRuntimeImpl.State.IDLE, rt.state());
        assertNull(rt.faultedReason());
    }

    /** 队列深度低于 seed 基线 = 队列被本设施之外的代码清空 ⇒ faulted（§7 的 observed-queue-divergence）。 */
    @Test
    public void queueClearedExternallyFaults() {
        host.keyboardDepth = 0;
        rt.tick();
        assertEquals(InputRuntimeImpl.State.FAULTED, rt.state());
        assertTrue(
            rt.faultedReason(),
            rt.faultedReason()
                .contains("observed-queue-divergence"));
    }

    // ------------------------------------------------------------------ 物理并发（如实报告）

    /** 键盘侧可判：队列深度超出「seed + 自身记账」⇒ 有非本设施的事件 ⇒ {@code "true"}。 */
    @Test
    public void physicalConcurrentKeyboardIsDetectedAndReported() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(Boolean.FALSE, rt.physicalConcurrentKeyboard());
        assertFalse((Boolean) rt.physicalConcurrentFor(false));

        // 真实物理按键（或进程内另一个注入者）在队列里留下额外事件
        host.keyboardDepth = InputCapabilities.KEYBOARD_SEED_BASELINE + 2;
        rt.tick();
        assertEquals(Boolean.TRUE, rt.physicalConcurrentKeyboard());
        assertEquals(Boolean.TRUE, rt.physicalConcurrentFor(false));
    }

    /** 鼠标侧无公开探针 ⇒ **只能** {@code "unobservable"}，禁止编造 false（§3.6 第 3 条）。 */
    @Test
    public void physicalConcurrentMouseSideIsUnobservable() {
        assertEquals(InputCapabilities.MOUSE_QUEUE_DEPTH, rt.physicalConcurrentFor(true));
        assertEquals("unobservable", rt.physicalConcurrentFor(true));
    }

    // ------------------------------------------------------------------ 结构校验与快照

    /** 结构性非法事件逐条拒绝（细节口径由 {@link InputParamsTest} 覆盖，这里锁运行时这一层）。 */
    @Test
    public void structurallyInvalidEventsAreRejectedPerEvent() {
        List<InputEvent> bad = new ArrayList<InputEvent>();
        InputEvent unknownKind = new InputEvent();
        unknownKind.kind = "teleport";
        bad.add(unknownKind);
        InputEvent badWheel = InputEvent.wheel(0.0D);
        bad.add(badWheel);
        InputEvent badButton = InputEvent.button(3, true);
        bad.add(badButton);
        DeliverResult r = rt.deliver(bad, "j1");
        assertTrue(r.hasRejections());
        assertEquals(
            3,
            r.rejections()
                .size());
        assertEquals(0, r.delivered);
        for (DeliverResult.Rejected x : r.rejections()) {
            assertEquals(ErrorCodes.VALID_PARAM, x.code);
        }
        assertTrue(sink.writes.isEmpty());
    }

    /** 快照的真值来源：消费链、持键、以及 {@code gameBindingPressed} 的**回读**（不是推测）。 */
    @Test
    public void snapshotAndHeldReadbackTellTheTruth() {
        host.chain = "gui";
        host.screen = "net.minecraft.client.gui.GuiChat";
        host.allowUserInput = false;
        host.worldChain = false;
        host.bindingPressed = false;
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");

        InputStateSnapshot snap = rt.snapshot();
        assertEquals("gui", snap.consumerChain());
        assertTrue(snap.hasHeld());
        assertEquals(
            1,
            snap.heldKeys()
                .size());

        com.google.gson.JsonObject held = rt.heldJson();
        assertEquals(
            1,
            held.get("count")
                .getAsInt());
        com.google.gson.JsonObject item = held.get("items")
            .getAsJsonArray()
            .get(0)
            .getAsJsonObject();
        assertEquals(
            "key.forward",
            item.get("id")
                .getAsString());
        assertEquals(
            "j1",
            item.get("jobId")
                .getAsString());
        assertEquals(
            InputCapabilities.HOLD_TICKS_MAX,
            item.get("expiresInTicks")
                .getAsLong());
        assertFalse(
            "游戏内绑定态是回读值：进 GUI 会 unPressAllKeys，逻辑持有与绑定态会分叉（§3.6 第 4 条）",
            item.get("gameBindingPressed")
                .getAsBoolean());
    }

    /**
     * 快照的只增字段（#165）：逐条持有明细（{@code jobId}/{@code heldTicks}/{@code expiresInTicks}）、
     * 投递计数、以及「鼠标队列深度 = 不可观测」的真值表达。
     */
    @Test
    public void snapshotCarriesHeldDetailsAndDeliveryCounts() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        host.advanceTick();
        host.advanceTick();
        InputStateSnapshot snap = rt.snapshot();

        assertEquals("j1", snap.lastJobId());
        assertEquals(1L, snap.deliveredThisJob());
        assertEquals(1L, snap.deliveredThisSession());
        // 鼠标侧没有公开队列深度探针 ⇒ 真值是「不可观测」，**不是** 0
        assertEquals(InputStateSnapshot.DEPTH_UNOBSERVABLE, snap.mouseDepth());

        List<InputStateSnapshot.HeldDetail> details = snap.heldDetails();
        assertNotNull(details);
        assertEquals(1, details.size());
        InputStateSnapshot.HeldDetail d = details.get(0);
        assertEquals(InputStateSnapshot.HeldDetail.KIND_KEY, d.kind());
        assertEquals("key.forward", d.id());
        assertEquals("j1", d.jobId());
        assertEquals(2L, d.heldTicks());
        assertEquals(InputCapabilities.HOLD_TICKS_MAX - 2L, d.expiresInTicks());
        // 扁平视图与明细同源（同一趟循环派生，不许打架）
        assertEquals(
            "key.forward",
            snap.heldKeys()
                .get(0));
        assertTrue(
            snap.heldButtons()
                .isEmpty());
    }

    /** 从未投递 ⇒ 没有可归属的作业：{@code deliveredThisJob} 落 {@code COUNT_UNKNOWN}（不是 0）。 */
    @Test
    public void countsWithoutAnyJobAreUnknownNotZero() {
        InputStateSnapshot snap = rt.snapshot();
        assertNull(snap.lastJobId());
        assertEquals(InputStateSnapshot.COUNT_UNKNOWN, snap.deliveredThisJob());
        // 会话计数有真值：确实还没投过任何事件 ⇒ 0 是真读数，不是编造
        assertEquals(0L, snap.deliveredThisSession());
        assertEquals(
            InputStateSnapshot.COUNT_UNKNOWN,
            InputStateSnapshot.empty()
                .deliveredThisSession());
        assertNull(
            InputStateSnapshot.empty()
                .heldDetails());
        assertEquals(
            InputStateSnapshot.DEPTH_UNOBSERVABLE,
            InputStateSnapshot.empty()
                .mouseDepth());
        assertFalse(
            InputStateSnapshot.empty()
                .hasHeld());
    }

    /**
     * 投递计数把释放/到期路径自动投递的抬起事件也算进去（契约 §4.1 的「已投递」= 写进队列）；
     * 被幂等抑制的重复 {@code down} 不计。
     */
    @Test
    public void deliveryCountsIncludeAutoReleaseUps() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(1L, rt.deliveredThisSession());
        // 重复 down 被幂等抑制 ⇒ 队列里没有第二条事件 ⇒ 计数不动
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(1L, rt.deliveredThisSession());

        assertTrue(rt.planExpiry("j1", InputRuntimeImpl.HOLD_KEY, "key.forward", 1));
        rt.tick();
        assertEquals(1, sink.count("key:17:up"));
        assertEquals("按下 + 到期抬起 = 2 条写进队列", 2L, rt.deliveredThisSession());
        assertEquals(2L, rt.deliveredForJob("j1"));
        assertEquals(
            2L,
            rt.snapshot()
                .deliveredThisSession());
        assertEquals(
            2L,
            rt.snapshot()
                .deliveredThisJob());
    }

    /** {@code expiresInTicks} 到 0 就不再为负（过期但尚未被结算的窗口里也不许报负数）。 */
    @Test
    public void expiresInTicksNeverGoesNegative() {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        rt.heldEntries()
            .get(0).expiresAtTick = 1L;
        host.advanceTick();
        host.advanceTick();
        InputStateSnapshot.HeldDetail d = rt.snapshot()
            .heldDetails()
            .get(0);
        assertEquals(0L, d.expiresInTicks());
        assertEquals(2L, d.heldTicks());

        // 负入参同样夹到 0（构造器即真值边界）
        InputStateSnapshot.HeldDetail clamped = new InputStateSnapshot.HeldDetail(
            InputStateSnapshot.HeldDetail.KIND_KEY,
            "k",
            null,
            -5L,
            -3L);
        assertEquals(0L, clamped.heldTicks());
        assertEquals(0L, clamped.expiresInTicks());
    }

    /** 线程纪律：首次调用绑定 tick 线程，之后跨线程调用必须**显式失败**（HTTP 线程不得碰 MC 状态）。 */
    @Test
    public void crossThreadUseIsRefused() throws Exception {
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertTrue(rt.onOwnerThread());
        final Throwable[] captured = new Throwable[1];
        Thread other = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    rt.tick();
                } catch (Throwable t) {
                    captured[0] = t;
                }
            }
        });
        other.start();
        other.join();
        assertNotNull("跨线程推进必须抛异常", captured[0]);
        assertTrue(captured[0] instanceof IllegalStateException);
    }

    /** 未实现清单与边界声明必须能机读（T2-B 组装 `input.state.notImplemented` 取它）。 */
    @Test
    public void boundaryAndNotImplementedAreMachineReadable() {
        assertTrue(
            rt.notImplementedJson()
                .size() > 0);
        com.google.gson.JsonObject b = rt.boundaryJson();
        assertEquals(
            "unobservable",
            b.get("mouseQueueDepth")
                .getAsString());
        assertEquals(
            "not-promised",
            b.get("crash")
                .getAsString());
        assertEquals(
            "no-hook",
            b.get("worldUnload")
                .getAsString());
        assertEquals(
            "unavailable",
            b.get("cancel")
                .getAsString());
    }

    private static List<InputEvent> one(InputEvent e) {
        List<InputEvent> l = new ArrayList<InputEvent>(1);
        l.add(e);
        return l;
    }
}
