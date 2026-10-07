package com.lightning.mod.client.controlplane.mc.input.observe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.mc.capture.ShotExecutor;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputRuntime;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateSnapshot;
import com.lightning.mod.client.controlplane.mc.input.api.ReleaseResult;

/**
 * {@code input.state} 字段组装与「无真值不得编造」的负例自检（零 MC 状态读取；只喂桩数据）。
 *
 * <h2>为什么负例是主角</h2>
 * 假绿的头号形态是「用默认值把未知伪装成已知」：{@code keyboardDepth:0} 看上去像「队列空 ⇒ 无物理
 * 冲突」，{@code physicalConcurrent:false} 看上去像「已确认没有真实输入」，{@code actions:[]}
 * 看上去像「本族没有动作」。因此每个字段都配一条<b>没有真值</b>时的断言：必须是 {@code null} /
 * {@code "unobservable"} / 显式的未实现说明，而不是某个看起来正常的默认值。
 */
public class InputStateProviderImplTest {

    // ------------------------------------------------------------ 桩

    /** 最小 {@link InputStateSnapshot} 桩。 */
    private static final class Snap implements InputStateSnapshot {

        private final String chain;
        private final int depth;
        private final List<String> keys;
        private final List<Integer> buttons;
        /** {@code null} = 本快照给不出逐条明细（{@link InputStateSnapshot#heldDetails()} 的「不可得」形态）。 */
        private final List<HeldDetail> details;
        private final String lastJobId;
        private final long deliveredThisJob;
        private final long deliveredThisSession;

        /** 便捷构造：无明细、无投递真值（计数落 {@link InputStateSnapshot#COUNT_UNKNOWN}）。 */
        Snap(String chain, int depth, List<String> keys, List<Integer> buttons) {
            this(
                chain,
                depth,
                keys,
                buttons,
                null,
                null,
                InputStateSnapshot.COUNT_UNKNOWN,
                InputStateSnapshot.COUNT_UNKNOWN);
        }

        Snap(String chain, int depth, List<String> keys, List<Integer> buttons, List<HeldDetail> details,
            String lastJobId, long deliveredThisJob, long deliveredThisSession) {
            this.chain = chain;
            this.depth = depth;
            this.keys = keys;
            this.buttons = buttons;
            this.details = details;
            this.lastJobId = lastJobId;
            this.deliveredThisJob = deliveredThisJob;
            this.deliveredThisSession = deliveredThisSession;
        }

        @Override
        public String consumerChain() {
            return chain;
        }

        @Override
        public int keyboardQueueDepth() {
            return depth;
        }

        @Override
        public List<String> heldKeys() {
            return keys == null ? new ArrayList<String>() : keys;
        }

        @Override
        public List<Integer> heldButtons() {
            return buttons == null ? new ArrayList<Integer>() : buttons;
        }

        @Override
        public int mouseDepth() {
            // 真值 = 不可观测（Mouse 无公开队列深度探针）；**不是** 0
            return DEPTH_UNOBSERVABLE;
        }

        @Override
        public String lastJobId() {
            return lastJobId;
        }

        @Override
        public long deliveredThisJob() {
            return deliveredThisJob;
        }

        @Override
        public long deliveredThisSession() {
            return deliveredThisSession;
        }

        @Override
        public List<HeldDetail> heldDetails() {
            return details;
        }
    }

    /** 最小 {@link InputRuntime} 桩（投递/释放不参与 input.state 的组装，故只回快照）。 */
    private static final class Rt implements InputRuntime {

        private final InputStateSnapshot snap;
        private final boolean throwOnSnapshot;

        Rt(InputStateSnapshot snap) {
            this(snap, false);
        }

        Rt(InputStateSnapshot snap, boolean throwOnSnapshot) {
            this.snap = snap;
            this.throwOnSnapshot = throwOnSnapshot;
        }

        @Override
        public DeliverResult deliver(List<com.lightning.mod.client.controlplane.mc.input.api.InputEvent> events,
            String jobId) {
            return DeliverResult.accepted(events == null ? 0 : events.size(), 1, 42L);
        }

        @Override
        public ReleaseResult releaseJob(String jobId) {
            return ReleaseResult.none(42L, jobId);
        }

        @Override
        public ReleaseResult releaseAll() {
            return ReleaseResult.none(42L, null);
        }

        @Override
        public InputStateSnapshot snapshot() {
            if (throwOnSnapshot) {
                throw new IllegalStateException("boom");
            }
            return snap;
        }
    }

    /** 满配探测：队列深度 1（只有 seed）、无屏幕、坐标上下文齐、五个注入入口齐、键码域齐。 */
    private static TickObservation.Builder richProbe() {
        return TickObservation.builder()
            .threadName("Client thread")
            .atNanos(1L)
            .keyboardQueueDepth(1)
            .keyboardQueueCapacity(256)
            .mouse(426, 322)
            // 回读值 = InputRuntimeProbe 用唯一实现算出的 GUI 行：854x480 1:1 下 Mouse.getY()=322
            // ⇒ guiY = 480 - 322*480/480 - 1 = 157（#165 收敛前那份镜像实现给的是 322，是错值）
            .mouseGui(426, 157)
            .currentScreen(null, null)
            .inGameHasFocus(Boolean.TRUE)
            .displayActive(Boolean.FALSE)
            .context(new InputScaleContext(854, 480, 854, 480, 1, 0, 1.0d, 854, 480))
            .keyBinding("key.forward", 17)
            .keyPressed("key.forward", Boolean.FALSE)
            .keyCodeRange(0, 255)
            .runtime("1.7.10", "10.13.4.1614", "3.0.8", "sdl")
            .injector("Keyboard.addRawKeyEvent")
            .injector("Keyboard.addCharEvent")
            .injector("Mouse.addMoveEvent")
            .injector("Mouse.addButtonEvent")
            .injector("Mouse.addWheelEvent");
    }

    private static JsonObject state(TickObservation.Builder probe, InputRuntime runtime, Boolean tickThread) {
        TickObservation obs = probe == null ? TickObservation.empty("cp-http-worker") : probe.build();
        InputStateProviderImpl p = new InputStateProviderImpl(runtime, () -> obs, () -> tickThread);
        return p.state();
    }

    private static JsonObject state(TickObservation.Builder probe, InputRuntime runtime) {
        return state(probe, runtime, Boolean.TRUE);
    }

    // ------------------------------------------------------------ 基本形状

    /** 满配时字段齐、状态自洽：实读值原样出现，seed 基线与口径文本同在。 */
    @Test
    public void fullProbeExposesRealReadings() {
        JsonObject d = state(richProbe(), new Rt(new Snap("world", 1, null, null, null, "j7", 3L, 9L)));
        assertTrue(
            d.get("implemented")
                .getAsBoolean());
        assertEquals(
            "input",
            d.get("family")
                .getAsString());
        assertEquals(
            "input",
            d.get("means")
                .getAsString());
        assertEquals(
            1,
            d.getAsJsonObject("queues")
                .get("keyboardDepth")
                .getAsInt());
        assertEquals(
            1,
            d.getAsJsonObject("queues")
                .get("keyboardSeedBaseline")
                .getAsInt());
        assertEquals(
            256,
            d.getAsJsonObject("queues")
                .get("keyboardCapacity")
                .getAsInt());
        assertEquals(
            "unobservable",
            d.getAsJsonObject("queues")
                .get("mouseDepth")
                .getAsString());
        // 投递计数（#165 起有真值来源）：真值原样给出，并附归属作业
        assertEquals(
            3L,
            d.getAsJsonObject("queues")
                .get("deliveredThisJob")
                .getAsLong());
        assertEquals(
            9L,
            d.getAsJsonObject("queues")
                .get("deliveredThisSession")
                .getAsLong());
        assertEquals(
            "j7",
            d.getAsJsonObject("queues")
                .get("deliveredJobId")
                .getAsString());
        assertEquals(
            "world",
            d.getAsJsonObject("consumer")
                .get("chain")
                .getAsString());
        assertEquals(
            17,
            d.getAsJsonObject("keyCatalog")
                .get("key.forward")
                .getAsInt());
        assertEquals(
            0,
            d.getAsJsonArray("keyCodeRange")
                .get(0)
                .getAsInt());
        assertEquals(
            255,
            d.getAsJsonArray("keyCodeRange")
                .get(1)
                .getAsInt());
        assertEquals(
            5,
            d.getAsJsonObject("runtime")
                .getAsJsonArray("injectors")
                .size());
        assertEquals(
            "3.0.8",
            d.getAsJsonObject("runtime")
                .get("lwjgl3ify")
                .getAsString());
        assertEquals(
            1200,
            d.getAsJsonObject("limits")
                .get("holdTicksMax")
                .getAsInt());
        assertEquals(
            2,
            d.getAsJsonObject("hitSet")
                .get("minSettleTicks")
                .getAsInt());
        assertEquals(
            4,
            d.getAsJsonArray("errors")
                .size());
        assertTrue(
            d.getAsJsonObject("thread")
                .get("verified")
                .getAsBoolean());
    }

    /**
     * 坐标块必须给全契约 §5.2 的参数，并把回读口径（{@code Mouse.getX/getY} 的值域 =
     * {@code displayHeight - sdlY}）与实读值一并给出。
     */
    @Test
    public void coordinatesBlockCarriesScaleAndReadbackPolicy() {
        JsonObject c = state(richProbe(), new Rt(new Snap("world", 1, null, null))).getAsJsonObject("coordinates");
        assertEquals(
            854,
            c.get("scaledWidth")
                .getAsInt());
        assertEquals(
            480,
            c.get("scaledHeight")
                .getAsInt());
        assertEquals(
            854,
            c.get("displayWidth")
                .getAsInt());
        assertEquals(
            1.0d,
            c.get("pixelScale")
                .getAsDouble(),
            0.0d);
        assertEquals(
            "eventY = displayHeight - sdlY",
            c.get("yFlip")
                .getAsString());
        JsonObject cal = c.getAsJsonObject("selfCalibration");
        assertTrue(
            cal.get("readbackSource")
                .getAsString()
                .contains("Mouse.getX/getY"));
        assertEquals(
            1,
            cal.get("tolerance")
                .getAsInt());
        assertEquals(
            "event-queue",
            cal.get("compareSpace")
                .getAsString());
        // 探测里 mouse=(426,322)：值域就是 displayHeight - sdlY，故 y 原样 322
        JsonObject raw = cal.getAsJsonObject("observedNowRaw");
        assertEquals(
            "event-queue",
            raw.get("space")
                .getAsString());
        assertEquals(
            426,
            raw.get("x")
                .getAsInt());
        assertEquals(
            322,
            raw.get("y")
                .getAsInt());
        assertTrue(
            raw.get("derivation")
                .getAsString()
                .contains("latestY"));
        JsonObject gui = cal.getAsJsonObject("observedNowGui");
        assertEquals(
            426,
            gui.get("x")
                .getAsInt());
        // 1:1 上下文（854x480、pixelScale=1）下 Mouse.getY()=322 ⇒ GUI 行 157
        // （guiY = scaledHeight - mouseY*S*scaledHeight/displayHeight - 1，与 EntityRenderer 同式）。
        // 【实测锚点】注入 SDL 322 ⇒ 事件行 158 ⇒ GUI 行 321：322 在这里是**SDL** 值而不是 GUI 行；
        // #165 收敛前观察侧把事件行当 GUI 行，报的正是 322（错值），故这条断言是收敛的回归锁。
        assertEquals(
            157,
            gui.get("y")
                .getAsInt());
        assertTrue(
            gui.get("derivation")
                .getAsString()
                .contains("EntityRenderer"));
    }

    /**
     * 负例（核心）：<b>没有真值不许编造</b>。
     *
     * <p>
     * 空探测 + 无运行时 ⇒ 深度不得落 0（要落 {@code null} 并给说明）、物理并发不得落
     * {@code false}（要落 {@code unobservable}）、动作数组为空、键位目录为空对象、
     * 字符范围为空且路由为 false、{@code notImplemented} 非空、消费链为 {@code null} + 说明。
     */
    @Test
    public void missingTruthIsNeverFakedAsDefaultValue() {
        JsonObject d = state(null, null);
        assertFalse(
            d.get("implemented")
                .getAsBoolean());
        assertEquals(
            0,
            d.getAsJsonArray("actions")
                .size());
        assertEquals(
            0,
            d.getAsJsonObject("keyCatalog")
                .entrySet()
                .size());
        assertFalse(
            d.getAsJsonObject("text")
                .get("supported")
                .getAsBoolean());
        assertEquals(
            0,
            d.getAsJsonObject("text")
                .getAsJsonArray("ranges")
                .size());
        assertFalse(
            d.getAsJsonObject("text")
                .getAsJsonObject("route")
                .get("world")
                .getAsBoolean());
        assertFalse(
            d.getAsJsonObject("text")
                .getAsJsonObject("route")
                .get("verified")
                .getAsBoolean());

        JsonObject q = d.getAsJsonObject("queues");
        assertTrue(
            q.get("keyboardDepth")
                .isJsonNull());
        assertEquals(
            "unobservable",
            q.get("mouseDepth")
                .getAsString());
        // 投递计数：无运行时 ⇒ **null**（不是 0：「本会话一条都没投」是编造），并给出无真值的说明
        assertTrue(
            q.get("deliveredThisJob")
                .isJsonNull());
        assertTrue(
            q.get("deliveredThisSession")
                .isJsonNull());
        assertTrue(q.has("deliveredThisJobNote"));
        assertTrue(q.has("deliveredThisSessionNote"));

        assertEquals(
            "unobservable",
            d.getAsJsonObject("physical")
                .get("concurrent")
                .getAsString());
        assertTrue(
            d.getAsJsonObject("consumer")
                .get("chain")
                .isJsonNull());
        assertTrue(
            d.getAsJsonObject("consumer")
                .has("chainNote"));
        assertEquals(
            0,
            d.getAsJsonObject("held")
                .get("count")
                .getAsInt());
        assertTrue(
            d.getAsJsonObject("held")
                .has("note"));
        assertTrue(
            d.getAsJsonArray("notImplemented")
                .size() > 0);
        assertTrue(
            d.getAsJsonArray("notImplemented")
                .toString()
                .contains("deliveredThisJob"));
    }

    /** {@code keyCodeRange} 读不到时落 {@code null} + 未实现说明，<b>不</b>写猜值（负例优先）。 */
    @Test
    public void keyCodeRangeIsNotGuessed() {
        // 无探测 ⇒ 没有键码域真值
        JsonObject none = state(null, new Rt(new Snap("world", 1, null, null)));
        assertTrue(
            none.get("keyCodeRange")
                .isJsonNull());
        assertTrue(
            none.getAsJsonArray("notImplemented")
                .toString()
                .contains("keyCodeRange"));
        // 有真值 ⇒ 原样给出区间
        JsonObject real = state(richProbe(), new Rt(new Snap("world", 1, null, null)));
        assertEquals(
            0,
            real.getAsJsonArray("keyCodeRange")
                .get(0)
                .getAsInt());
    }

    // ------------------------------------------------------------ 物理并发（键盘侧判定）

    /** 深度 == seed 基线 ⇒ {@code false}（唯一能判「无冲突」的情形）。 */
    @Test
    public void physicalConcurrentFalseWhenDepthEqualsSeedBaseline() {
        JsonObject p = state(richProbe().keyboardQueueDepth(1), new Rt(new Snap("world", 1, null, null)))
            .getAsJsonObject("physical");
        assertEquals(
            "false",
            p.get("concurrent")
                .getAsString());
        assertEquals(
            "Keyboard.getNumKeyboardEvents",
            p.get("keyboardProbe")
                .getAsString());
    }

    /** 深度 > seed 基线 ⇒ {@code true}（真实物理输入；不仲裁、不屏蔽，只报告）。 */
    @Test
    public void physicalConcurrentTrueWhenDepthExceedsBaseline() {
        JsonObject p = state(richProbe().keyboardQueueDepth(3), new Rt(new Snap("world", 1, null, null)))
            .getAsJsonObject("physical");
        assertEquals(
            "true",
            p.get("concurrent")
                .getAsString());
        assertTrue(
            p.get("reason")
                .getAsString()
                .contains("3"));
    }

    /** 无运行时或探针不可读 ⇒ {@code unobservable}，<b>绝不</b>落 {@code false} 冒充「没有冲突」。 */
    @Test
    public void physicalConcurrentNeverFakedAsFalse() {
        // 探针读不到深度
        JsonObject a = state(TickObservation.builder(), new Rt(new Snap("world", 1, null, null)))
            .getAsJsonObject("physical");
        assertEquals(
            "unobservable",
            a.get("concurrent")
                .getAsString());
        // 运行时缺席（无法扣除自身未消费投递）
        JsonObject b = state(richProbe().keyboardQueueDepth(2), null).getAsJsonObject("physical");
        assertEquals(
            "unobservable",
            b.get("concurrent")
                .getAsString());
        // 鼠标侧恒不可判，且必须给出理由
        assertEquals(
            "unobservable",
            a.get("mouseConcurrent")
                .getAsString());
        assertTrue(a.has("mouseNote"));
    }

    // ------------------------------------------------------------ 持键回读

    /**
     * 持键条目给全 §5.2 的字段：{@code kind}/{@code id}/{@code jobId}/{@code heldTicks}/
     * {@code expiresInTicks}/{@code gameBindingPressed}（#165 起后三项有真值来源）。
     */
    @Test
    public void heldItemsCarryOwnerAndExpiry() {
        TickObservation.Builder probe = richProbe().keyPressed("key.forward", Boolean.TRUE);
        List<InputStateSnapshot.HeldDetail> details = new ArrayList<InputStateSnapshot.HeldDetail>();
        details.add(
            new InputStateSnapshot.HeldDetail(InputStateSnapshot.HeldDetail.KIND_KEY, "key.forward", "j1", 5L, 1195L));
        details.add(new InputStateSnapshot.HeldDetail(InputStateSnapshot.HeldDetail.KIND_BUTTON, "0", "j2", 2L, 1198L));
        InputRuntime rt = new Rt(
            new Snap(
                "world",
                1,
                Arrays.asList("key.forward"),
                Arrays.asList(Integer.valueOf(0)),
                details,
                "j1",
                1L,
                1L));
        JsonObject held = state(probe, rt).getAsJsonObject("held");
        assertEquals(
            2,
            held.get("count")
                .getAsInt());
        assertTrue(
            held.get("detailsReadable")
                .getAsBoolean());
        JsonArray items = held.getAsJsonArray("items");
        JsonObject key = items.get(0)
            .getAsJsonObject();
        assertEquals(
            "key",
            key.get("kind")
                .getAsString());
        assertEquals(
            "key.forward",
            key.get("id")
                .getAsString());
        assertEquals(
            "j1",
            key.get("jobId")
                .getAsString());
        assertEquals(
            5L,
            key.get("heldTicks")
                .getAsLong());
        assertEquals(
            1195L,
            key.get("expiresInTicks")
                .getAsLong());
        assertTrue(
            key.get("gameBindingPressed")
                .getAsBoolean());
        JsonObject btn = items.get(1)
            .getAsJsonObject();
        assertEquals(
            "button",
            btn.get("kind")
                .getAsString());
        assertEquals(
            "0",
            btn.get("id")
                .getAsString());
        assertEquals(
            "j2",
            btn.get("jobId")
                .getAsString());
        assertEquals(
            1198L,
            btn.get("expiresInTicks")
                .getAsLong());
        assertTrue(
            btn.get("gameBindingPressed")
                .isJsonNull());
    }

    /**
     * 快照给不出逐条明细（{@code heldDetails() == null}）时：仍然报「谁被持有」，但
     * {@code jobId}/{@code heldTicks}/{@code expiresInTicks} 落 <b>null</b> 并整块标注不可读——
     * <b>不</b>用 0 冒充「刚按下、1200 tick 后到期」。
     */
    @Test
    public void heldItemsWithoutDetailsAreMarkedUnreadableNotZero() {
        InputRuntime rt = new Rt(new Snap("world", 1, Arrays.asList("key.forward"), Arrays.asList(Integer.valueOf(0))));
        JsonObject held = state(richProbe(), rt).getAsJsonObject("held");
        assertFalse(
            held.get("detailsReadable")
                .getAsBoolean());
        assertTrue(
            held.get("detailsNote")
                .getAsString()
                .contains("heldDetails"));
        assertEquals(
            2,
            held.get("count")
                .getAsInt());
        JsonObject key = held.getAsJsonArray("items")
            .get(0)
            .getAsJsonObject();
        assertEquals(
            "key.forward",
            key.get("id")
                .getAsString());
        assertTrue(
            key.get("jobId")
                .isJsonNull());
        assertTrue(
            key.get("heldTicks")
                .isJsonNull());
        assertTrue(
            key.get("expiresInTicks")
                .isJsonNull());
    }

    /** 无运行时 ⇒ 持键 count=0 且明说是「未知的诚实空态」，不是「已确认无持有」。 */
    @Test
    public void heldWithoutRuntimeIsExplicitlyUnknown() {
        JsonObject held = state(richProbe(), null).getAsJsonObject("held");
        assertEquals(
            0,
            held.get("count")
                .getAsInt());
        assertFalse(
            held.get("detailsReadable")
                .getAsBoolean());
        assertTrue(
            held.get("note")
                .getAsString()
                .contains("未知"));
    }

    /** 运行时快照自身抛异常时，不许把异常当「空状态」以外的任何东西：仍如实给 notImplemented。 */
    @Test
    public void runtimeSnapshotFailureDegradesHonestly() {
        JsonObject d = state(richProbe(), new Rt(null, true));
        assertTrue(
            d.get("implemented")
                .getAsBoolean());
        assertTrue(
            d.getAsJsonObject("consumer")
                .get("chain")
                .isJsonNull());
        assertEquals(
            0,
            d.getAsJsonObject("held")
                .get("count")
                .getAsInt());
        // 快照读不到 ⇒ 计数也不许落 0
        assertTrue(
            d.getAsJsonObject("queues")
                .get("deliveredThisSession")
                .isJsonNull());
    }

    /**
     * {@code runtime == null}（未装配）：计数与明细一律「不可读」——<b>不</b>落 0、<b>不</b>把
     * {@code mouseDepth} 当成 0。
     */
    @Test
    public void nullRuntimeIsNotTreatedAsZeroState() {
        JsonObject d = state(richProbe(), null);
        JsonObject q = d.getAsJsonObject("queues");
        assertTrue(
            q.get("deliveredThisJob")
                .isJsonNull());
        assertTrue(
            q.get("deliveredThisSession")
                .isJsonNull());
        assertTrue(
            q.get("deliveredJobId")
                .isJsonNull());
        assertEquals(
            "unobservable",
            q.get("mouseDepth")
                .getAsString());
        JsonObject held = d.getAsJsonObject("held");
        assertEquals(
            0,
            held.get("count")
                .getAsInt());
        assertFalse(
            held.get("detailsReadable")
                .getAsBoolean());
        assertTrue(held.has("note"));
    }

    // ------------------------------------------------------------ 线程

    /** 判定为「不是 tick 线程」⇒ {@code ok:false} 的 CP-STATE-001 失败体，且不返回任何能力字段。 */
    @Test
    public void nonTickThreadFailsWithState001() {
        JsonObject o = state(richProbe(), new Rt(new Snap("world", 1, null, null)), Boolean.FALSE);
        assertFalse(
            o.get("ok")
                .getAsBoolean());
        JsonObject err = o.getAsJsonObject("error");
        assertEquals(
            "CP-STATE-001",
            err.get("code")
                .getAsString());
        assertEquals(
            "client-tick",
            err.getAsJsonObject("context")
                .get("requiredThread")
                .getAsString());
        assertFalse(o.has("data"));
        assertFalse(o.has("implemented"));
    }

    /** 线程判定不可用 ⇒ 仍返回快照，但 {@code thread.verified=false}（「未验证」≠「已验证为假」）。 */
    @Test
    public void unverifiedThreadIsReportedAsUnverified() {
        JsonObject d = state(richProbe(), new Rt(new Snap("world", 1, null, null)), null);
        assertFalse(
            d.getAsJsonObject("thread")
                .get("verified")
                .getAsBoolean());
        assertTrue(
            d.getAsJsonObject("thread")
                .has("note"));
        assertTrue(
            d.get("implemented")
                .getAsBoolean());
    }

    // ------------------------------------------------------------ 缺口清单与 GUI 参数

    /** {@code injectors} 不满五个时必须留一条「白名单不是存在性证据」的缺口说明。 */
    @Test
    public void partialInjectorsAreReportedAsGap() {
        TickObservation obs = TickObservation.builder()
            .threadName("Client thread")
            .keyboardQueueDepth(1)
            .runtime("1.7.10", "10.13.4.1614", null, "sdl")
            .injector("Keyboard.addRawKeyEvent")
            .build();
        JsonObject d = InputStateProviderImpl.assemble(obs, new Rt(new Snap("world", 1, null, null)), Boolean.TRUE);
        assertEquals(
            "unknown",
            d.getAsJsonObject("runtime")
                .get("lwjgl3ify")
                .getAsString());
        assertTrue(
            d.getAsJsonArray("notImplemented")
                .toString()
                .contains("白名单"));
    }

    /** {@code Runtime.injectors} 只报实读可解析项：五个齐时不额外加缺口。 */
    @Test
    public void completeInjectorsDoNotAddWhitelistGap() {
        JsonObject d = state(richProbe(), new Rt(new Snap("world", 1, null, null)));
        assertFalse(
            d.getAsJsonArray("notImplemented")
                .toString()
                .contains("白名单"));
    }

    // ------------------------------------------------------------ gui 参数取值域

    /** {@code gui} 缺省/空串 ⇒ {@code none}（既有调用方不受影响）。 */
    @Test
    public void guiParamDefaultsToNone() {
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(null));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(""));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode("none"));
        assertEquals(ShotExecutor.GUI_SCREEN, ShotExecutor.resolveGuiMode("screen"));
    }

    /** 取值域外必须显式 {@code CP-VALID-002}，不许静默当默认值（本仓已定的失效模式）。 */
    @Test
    public void guiParamOutOfDomainIsRejected() {
        for (String bad : new String[] { "hud", "SCREEN", "true", "both", "screens" }) {
            try {
                ShotExecutor.resolveGuiMode(bad);
                fail("应拒绝 gui=" + bad);
            } catch (CpException e) {
                assertEquals("CP-VALID-002", e.code());
                assertTrue(
                    e.getMessage()
                        .contains("gui"));
            }
        }
    }

    /** {@code resolveGuiMode} 的空白处理是确定行为：前后空白被 trim 后参与判定。 */
    @Test
    public void guiParamTrimsSurroundingWhitespace() {
        assertEquals(ShotExecutor.GUI_SCREEN, ShotExecutor.resolveGuiMode(" screen "));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode("  none"));
    }

    // ------------------------------------------------------------ 可读性（字段名自证口径）

    /** 声明的能力/不承诺项必须机读：轮询面不覆盖、崩溃不承诺、离图无钩子、取消不存在。 */
    @Test
    public void nonPromisesAreMachineReadable() {
        JsonObject d = state(richProbe(), new Rt(new Snap("world", 1, null, null)));
        assertTrue(
            d.get("pollSurface")
                .getAsString()
                .startsWith("not-covered"));
        JsonObject lc = d.getAsJsonObject("lifecycle");
        assertEquals(
            "not-promised",
            lc.get("crash")
                .getAsString());
        assertEquals(
            "no-hook",
            lc.get("worldUnload")
                .getAsString());
        assertEquals(
            "unavailable",
            lc.get("cancel")
                .getAsString());
        assertEquals(
            5,
            lc.getAsJsonArray("cleanupPaths")
                .size());
        assertEquals(
            "best-effort",
            lc.getAsJsonArray("cleanupPaths")
                .get(4)
                .getAsJsonObject()
                .get("strength")
                .getAsString());
        // wheel.sign 未实机校准 ⇒ 不许当作已定口径
        JsonObject wheel = d.getAsJsonObject("wheel");
        assertEquals(
            "notch",
            wheel.get("unit")
                .getAsString());
        assertFalse(
            wheel.get("signVerified")
                .getAsBoolean());
    }

    /** 未实现的族必须自洽：`implemented:false` 时 `notImplemented` 非空（§5.2 的硬要求）。 */
    @Test
    public void notImplementedIsNonEmptyWhenUnimplemented() {
        JsonObject d = state(null, null);
        JsonElement ne = d.get("notImplemented");
        assertNotNull(ne);
        assertTrue(
            ne.getAsJsonArray()
                .size() >= 5);
    }
}
