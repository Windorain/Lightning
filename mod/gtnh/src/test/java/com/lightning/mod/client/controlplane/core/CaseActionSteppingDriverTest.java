package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.mc.CaseRunAction.ActionStepDriver;

/**
 * {@code action} 段的跨 tick 输入步推进器的单测（{@code case-file.md} §3.2）。
 *
 * <h2>为什么测的是推进器而不是整个段</h2>
 * 段执行体的其它部分挂在客户端线程与 MC 状态上（步骤间收敛、捕获会话、观测记录），离线跑不起来；
 * 而输入步例外要证明的纪律是<b>推进的形状</b>：一次 tick 只推进一次、完成前不进入下一步骤、
 * 不 sleep/不忙等、失败与超时都释放。这些全部落在 {@link ActionStepDriver} 上，
 * 因此用一个纯 core 的假动作族 + 假输入设施把它逐条钉死。
 *
 * <h2>假设施的判据不是 getter，而是「所持按下态」</h2>
 * 释放路径有没有被走到，由 {@link FakeInput#held} 是否清空判定——「读一个布尔字段」证明不了
 * 「键没被按着」。
 */
public class CaseActionSteppingDriverTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private ArtifactStore store;
    private ActionContext ctx;
    private FakeInput input;
    private ActionRegistry registry;

    @Before
    public void setUp() throws IOException {
        store = new ArtifactStore(
            tmp.newFolder("runs")
                .toPath(),
            TimeSource.fixed("2026-10-07T00:00:00+08:00", "20261007-000000", 0L),
            null);
        ctx = new ActionContext(null, new JsonObject(), store, null, null);
        ctx.beginRun("stepping-driver");
        input = new FakeInput();
        registry = new ActionRegistry();
        input.register(registry);
    }

    // ------------------------------------------------------------ ① 旧同步步骤：同一 tick 内连跑，形状不变

    /**
     * ①同步步骤连跑与基线一致：一次 {@code advance} 跑完全部同步步骤，段记录的字段集合与顺序不变。
     *
     * <p>
     * 负对照：把输入步的「让出一拍」规则误施于同步步骤（例如每步后都 return null），本用例立刻变红
     * （一次 advance 拿不到 detail、executed 停在 1）。
     */
    @Test
    public void syncStepsStillRunInOneTickWithUnchangedRecordShape() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(syncStep("input.state", "action/0-state.json", null));
        steps.add(syncStep("input.state", "action/1-state.json", null));
        ActionStepDriver driver = driver(recordingSettle());

        JsonObject detail = driver.advance(ctx, steps);
        assertNotNull("同步步骤必须在单次 advance 内跑完", detail);
        assertEquals(2, Json.optInt(detail, "executed", -1));
        assertEquals(2, Json.optInt(detail, "declared", -1));
        JsonObject first = Json.optArray(detail, "steps")
            .get(0)
            .getAsJsonObject();
        assertEquals(
            "段记录字段集合与顺序必须与 G1 之前逐字一致",
            "[index, action, path, ok, params, artifact, settleMs]",
            Json.keys(first)
                .toString());
        assertEquals(
            true,
            first.get("ok")
                .getAsBoolean());
        assertTrue(
            "产物必须落 run 目录（同一 tick 内每一步都落）",
            Files.isRegularFile(
                ctx.run()
                    .resolve("action/0-state.json")));
        assertEquals("没碰过输入设施：收尾不得触发释放", 0, input.releaseCalls);
    }

    /** ①'同步步骤的产物内容就是动作返回值（落盘路径与引入输入步之前同一实现）。 */
    @Test
    public void syncStepArtifactContentIsTheActionResult() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(syncStep("input.state", "action/0-state.json", null));
        ActionStepDriver driver = driver(recordingSettle());
        driver.advance(ctx, steps);
        String text = new String(
            Files.readAllBytes(
                ctx.run()
                    .resolve("action/0-state.json")),
            StandardCharsets.UTF_8);
        assertTrue(text.contains("\"observed\""));
    }

    // ------------------------------------------------------------ ② 未写 holdTicks：显式定义的单次推进

    /**
     * ②未写 {@code holdTicks} 时不隐式跨帧：驱动<b>不注入</b>任何默认持有量，动作按自己的缺省
     * （{@code 1}）在<b>单次推进</b>内完成，且此后驱动不再推进它。
     *
     * <p>
     * 负对照：驱动为「没写 holdTicks 的输入步」补一个默认值（例如 20）或把它多推几拍，本用例变红
     * （{@code injectedHoldTicks} 非 null / {@code stepCalls} &gt; 1）。
     */
    @Test
    public void missingHoldTicksMeansExactlyOneAdvance() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        ActionStepDriver driver = driver(recordingSettle());

        assertNull("输入步至少占一个 tick：本 tick 结束时不返回段记录", driver.advance(ctx, steps));
        assertNull("驱动不得给未写 holdTicks 的步补默认值（缺省由动作自己说了算）", input.injectedHoldTicks);
        assertEquals("未写 holdTicks ⇒ 恰好一次推进", 1, input.keyStepCalls);
        assertEquals(1, driver.inputSteps());
        assertEquals("该步已完成（一次推进内收口）", 1, Json.optInt(driver.advance(ctx, steps), "executed", -1));
    }

    /** 写了顶层 {@code holdTicks} 时，驱动把它翻译成动作参数（唯一翻译点）。 */
    @Test
    public void topLevelHoldTicksIsTranslatedIntoActionParams() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("tap", Integer.valueOf(3), "action/0-tap.json", null));
        ActionStepDriver driver = driver(recordingSettle());
        assertNull(driver.advance(ctx, steps));
        assertEquals(3, input.injectedHoldTicks.intValue());
        assertEquals(1, input.keyStepCalls);
    }

    // ------------------------------------------------------------ ⑧ 一次 tick 只推进一次（不 sleep / 不忙等）

    /**
     * ⑧「1 tick = 1 step」：持有一拍数 N 的输入步必须恰好被 N 次 {@code advance} 推进，每次只调一次
     * {@code step()}；段在 N+1 次 advance 时才完成。
     *
     * <p>
     * 负对照：把推进实现成「在单次 advance 里循环到完成」或「sleep 掉 N 个 tick」——前者让
     * perTick 变成 [N]（而不是 N 个 1），后者让墙钟时间超过 N/2 个 MC tick，两条断言各自变红。
     */
    @Test
    public void oneAdvanceEqualsOneStepAndNoWallClockWait() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("tap", Integer.valueOf(20), "action/0-tap.json", null));
        ActionStepDriver driver = driver(recordingSettle());

        List<Integer> perTick = new ArrayList<Integer>();
        int previous = 0;
        long started = System.nanoTime();
        for (int tick = 0; tick < 20; tick++) {
            assertNull("第 " + (tick + 1) + " 拍：持有未到期，段不得完成", driver.advance(ctx, steps));
            perTick.add(Integer.valueOf(input.keyStepCalls - previous));
            previous = input.keyStepCalls;
            if (tick < 19) {
                assertEquals("持有未到期时在飞下标必须指向该步（第 " + (tick + 1) + " 拍）", 0, driver.inFlightIndex());
            }
        }
        long elapsedMs = (System.nanoTime() - started) / 1000000L;

        for (int i = 0; i < perTick.size(); i++) {
            assertEquals(
                "每次 advance 必须恰好推进一次（第 " + (i + 1) + " 拍）",
                1,
                perTick.get(i)
                    .intValue());
        }
        assertEquals(20, input.keyStepCalls);
        // 20 个 MC tick = 1000ms 的墙钟；sleep/忙等实现必然在这里露馅（留 2 倍余量）
        assertTrue("推进不得在客户端线程上 sleep/忙等（实测 " + elapsedMs + "ms）", elapsedMs < 500L);
        assertEquals("第 20 拍完成后不再有在飞实例", -1, driver.inFlightIndex());

        JsonObject detail = driver.advance(ctx, steps);
        assertNotNull("第 21 拍该完成", detail);
        assertEquals(1, Json.optInt(detail, "executed", -1));
        assertTrue(input.held.isEmpty());
    }

    /** 输入步不走进度收敛钩子（settleBetweenSteps 的墙钟等待路径，case-file.md §3.2 第 7 条）。 */
    @Test
    public void inputStepsNeverUseTheSettleHook() throws Exception {
        List<Integer> settled = new ArrayList<Integer>();
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        steps.add(syncStep("input.state", "action/1-state.json", null));
        ActionStepDriver driver = driver((c, action, index, last, rec) -> {
            settled.add(Integer.valueOf(index));
            rec.addProperty("settleMs", Long.valueOf(7L)); // 形状与生产实现一致
        });

        assertNull(driver.advance(ctx, steps)); // 第 1 拍：输入步（不得 settle）
        assertNotNull(driver.advance(ctx, steps)); // 第 2 拍：同步步
        assertEquals("settle 只允许出现在同步步骤上", "[1]", settled.toString());
    }

    // ------------------------------------------------------------ ⑦ 顺序：down → 跨帧 → 释放 → 读断言

    /**
     * ⑦顺序正确：{@code down}（第 1 拍，之后仍持有）→ 读断言看得到<b>未释放</b>态 →
     * {@code input.release} → 释放之后的读断言看到 0。
     *
     * <p>
     * 负对照：驱动在输入步完成前就往下跑（抢跑）⇒ 第 2 拍的读断言读到 0 而 {@code expect} 是 1，
     * 当场 {@code CP-EXEC-001}；或释放被提前 ⇒ 同样在第 2 拍红。
     */
    @Test
    public void downHoldObserveReleaseOrderIsPreserved() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        steps.add(syncStep("input.state", "action/1-before.json", expect("/held/count", 1)));
        steps.add(syncStep("input.release", "action/2-release.json", expect("/count", 1)));
        steps.add(syncStep("input.state", "action/3-after.json", expect("/held/count", 0)));
        ActionStepDriver driver = driver(recordingSettle());

        assertNull("第 1 拍只推进输入步", driver.advance(ctx, steps));
        assertEquals("第 1 拍结束时键仍是按下的（down 刻意保留持有）", "[down:key.forward]", input.timeline.toString());
        JsonObject detail = driver.advance(ctx, steps);
        assertNotNull("第 2 拍跑完剩余同步步骤", detail);
        assertEquals(
            "顺序：按下 → 观察（未释放）→ 抬起投递 → 释放回执 → 观察（已释放）",
            "[down:key.forward, state:1, up:key.forward, release:1, state:0]",
            input.timeline.toString());
        assertTrue("释放之后设施不再持有任何按下态", input.held.isEmpty());
        assertEquals(4, Json.optInt(detail, "executed", -1));
    }

    /** ⑦'释放之前的读断言若断言了「已释放」，必须当场红（证明断言真的能看见未释放态）。 */
    @Test
    public void observeBeforeReleaseCannotSeeReleasedState() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        steps.add(syncStep("input.state", "action/1-before.json", expect("/held/count", 0)));
        ActionStepDriver driver = driver(recordingSettle());
        assertEquals(0, driver.advance(ctx, steps) == null ? 0 : 1);
        try {
            driver.advance(ctx, steps);
            fail("释放前断言「held.count==0」必须变红");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
            assertTrue(
                Json.optArray(e.context(), "failed") != null && e.context()
                    .getAsJsonArray("failed")
                    .size() == 1);
        }
    }

    // ------------------------------------------------------------ ⑤ 段中途失败：释放路径被走到

    /**
     * ⑤段中途失败不留持键：输入步在第 2 次推进时抛 {@code CP-EXEC-001}（且此前已投递按下），
     * 驱动必须当场释放——失败返回时设施持键表为空。
     *
     * <p>
     * 负对照：删掉 {@code ActionStepDriver.advance} 的失败释放（catch → finish）⇒ {@code held} 非空，
     * 本用例变红。
     */
    @Test
    public void stepFailureReleasesHeldKeys() throws Exception {
        input.failKeyAtAdvance = 2;
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("tap", Integer.valueOf(5), "action/0-tap.json", null));
        ActionStepDriver driver = driver(recordingSettle());

        assertNull(driver.advance(ctx, steps));
        assertFalse("第 1 拍按下后仍持有", input.held.isEmpty());
        try {
            driver.advance(ctx, steps);
            fail("动作异常必须向外传播");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
            assertTrue(
                "错误消息要指到该步",
                e.detail()
                    .contains("action[0]"));
        }
        assertTrue("失败路径必须释放本段所持按下态", input.held.isEmpty());
        assertTrue(input.releaseCalls >= 1);
    }

    /** ⑤'断言失败（expect 不命中）同样走释放路径——它也是「段中途失败」。 */
    @Test
    public void expectFailureReleasesHeldKeys() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        steps.add(syncStep("input.state", "action/1-state.json", expect("/held/count", 99)));
        ActionStepDriver driver = driver(recordingSettle());
        assertNull(driver.advance(ctx, steps));
        assertFalse("失败发生时键确实是按下的（否则本用例证明不了释放）", input.held.isEmpty());
        try {
            driver.advance(ctx, steps);
            fail("断言不命中必须抛 CP-EXEC-001");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
        }
        assertTrue("断言失败的现场也不许留下按下的键", input.held.isEmpty());
    }

    // ------------------------------------------------------------ ⑥ 阶段超时：同样释放

    /**
     * ⑥阶段超时释放：输入步推进中途被抛弃（{@code CaseRunAction.onFinish} 在超时路径上就是这么调的），
     * {@code finish} 必须释放并清空在飞实例；重复调用幂等。
     *
     * <p>
     * 负对照：让 {@code finish} 只清字段不调释放钩子 ⇒ {@code held} 非空，本用例变红。
     */
    @Test
    public void timeoutAbandonmentReleasesHeldKeys() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("tap", Integer.valueOf(100), "action/0-tap.json", null));
        ActionStepDriver driver = driver(recordingSettle());
        assertNull(driver.advance(ctx, steps));
        assertFalse(input.held.isEmpty());
        assertEquals(0, driver.inFlightIndex());
        assertTrue(driver.inFlightTicks() >= 1);

        driver.finish(ctx, true); // = SteppingActionBase 超时抛出后 CaseRunAction.onFinish 的调用
        assertTrue("超时路径必须释放", input.held.isEmpty());
        assertEquals("无在飞实例", -1, driver.inFlightIndex());

        int calls = input.releaseCalls;
        driver.finish(ctx, true);
        assertEquals("收尾释放必须幂等", calls, input.releaseCalls);
    }

    /** ⑥'成功收尾也释放（作业收尾 = 契约 §3.4 路径 3），且没碰过输入设施时一次都不调。 */
    @Test
    public void segmentEndReleasesOnlyWhenInputWasTouched() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(inputKeyStep("down", null, "action/0-down.json", null));
        ActionStepDriver driver = driver(recordingSettle());
        assertNull(driver.advance(ctx, steps));
        assertNotNull(driver.advance(ctx, steps));
        driver.finish(ctx, false);
        assertTrue("作业收尾必须释放 down 留下的持有点", input.held.isEmpty());

        ActionStepDriver untouched = new ActionStepDriver(registry, recordingSettle(), (c, why) -> input.releaseAll());
        JsonArray onlySync = new JsonArray();
        onlySync.add(syncStep("input.state", "action/9-state.json", null));
        untouched.advance(ctx, onlySync);
        int calls = input.releaseCalls;
        untouched.finish(ctx, false);
        assertEquals("本段没碰过输入设施 ⇒ 收尾不得调释放（旧用例逐字节不变）", calls, input.releaseCalls);
    }

    // ------------------------------------------------------------ ④ 注册表口径：未注册 / 非输入族步进

    /** 未注册动作：{@code CP-VALID-001} 且上下文带上已注册动作名（与 read 段同一分工）。 */
    @Test
    public void unknownActionIsRejected() throws Exception {
        JsonArray steps = new JsonArray();
        steps.add(syncStep("no.such.action", "action/0-x.json", null));
        try {
            driver(recordingSettle()).advance(ctx, steps);
            fail("未注册动作必须 CP-VALID-001");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_UNKNOWN, e.code());
            assertTrue(
                "上下文要给出全部已注册动作名（口径与 read 段一致）",
                Json.optString(e.context(), "registered", "")
                    .contains("input.key"));
        }
    }

    /** 非输入族的步进动作仍拒：输入步例外只对 input.key / input.mouse 开（CP-VALID-002）。 */
    @Test
    public void nonInputSteppingActionIsStillRejected() throws Exception {
        registry.registerStepping(
            ActionDescriptor.builder("world.rebuild", Tier.SCENE)
                .description("fake")
                .build(),
            () -> c -> new JsonObject());
        JsonArray steps = new JsonArray();
        steps.add(syncStep("world.rebuild", "action/0-rebuild.json", null));
        try {
            driver(recordingSettle()).advance(ctx, steps);
            fail("非输入族步进动作必须仍被拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                "拒绝理由要指出例外只对输入族开",
                e.detail()
                    .contains("输入族"));
        }
    }

    /** 运行期兜底：{@code params} 内出现 holdTicks 时立刻拒（静态层已判，这里保证不静默注入）。 */
    @Test
    public void holdTicksInsideParamsIsRejectedAtRuntimeToo() throws Exception {
        JsonObject step = new JsonObject();
        step.addProperty("action", "input.key");
        JsonObject params = new JsonObject();
        params.addProperty("key", "key.forward");
        params.addProperty("action", "tap");
        params.addProperty("holdTicks", 5);
        step.add("params", params);
        step.addProperty("path", "action/0-x.json");
        JsonArray steps = new JsonArray();
        steps.add(step);
        try {
            driver(recordingSettle()).advance(ctx, steps);
            fail("params 内 holdTicks 必须被拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                e.detail()
                    .contains("顶层"));
        }
    }

    // ------------------------------------------------------------ 夹具

    private ActionStepDriver driver(ActionStepDriver.Settle settle) {
        return new ActionStepDriver(registry, settle, (c, why) -> input.releaseAll());
    }

    /** 生产形状的收敛钩子替身（真实实现见 {@code CaseRunAction.settleBetweenSteps}）。 */
    private static ActionStepDriver.Settle recordingSettle() {
        return (c, action, index, last, rec) -> rec.addProperty("settleMs", Long.valueOf(1L));
    }

    private static JsonObject syncStep(String action, String path, JsonObject expect) {
        JsonObject s = new JsonObject();
        s.addProperty("action", action);
        s.add("params", new JsonObject());
        s.addProperty("path", path);
        if (expect != null) {
            s.add("expect", expect);
        }
        return s;
    }

    /** {@code input.key} 步：{@code action} 为输入族动作形态，{@code holdTicks} 为顶层编排属性。 */
    private static JsonObject inputKeyStep(String action, Integer holdTicks, String path, JsonObject expect) {
        JsonObject s = new JsonObject();
        s.addProperty("action", "input.key");
        JsonObject params = new JsonObject();
        params.addProperty("key", "key.forward");
        params.addProperty("action", action);
        s.add("params", params);
        s.addProperty("path", path);
        if (holdTicks != null) {
            s.addProperty("holdTicks", holdTicks.intValue());
        }
        if (expect != null) {
            s.add("expect", expect);
        }
        return s;
    }

    private static JsonObject expect(String pointer, int value) {
        JsonObject e = new JsonObject();
        e.addProperty(pointer, value);
        return e;
    }

    /**
     * 假输入设施 + 假输入动作族。
     *
     * <p>
     * 它<b>只</b>建模两件事：设施所持按下态（{@link #held}）与时间线（{@link #timeline}）。
     * 「释放路径有没有被走到」由 {@link #held} 是否为空判定——不是读某个布尔字段。
     */
    private static final class FakeInput {

        private final Set<String> held = new LinkedHashSet<String>();
        private final List<String> timeline = new ArrayList<String>();

        private int keyStepCalls;
        private int releaseCalls;
        private Integer injectedHoldTicks;
        private int failKeyAtAdvance = -1;

        void register(ActionRegistry reg) {
            reg.registerStepping(
                ActionDescriptor.builder("input.key", Tier.SCENE)
                    .description("fake input.key（单测替身）")
                    .build(),
                () -> this::keyStep);
            reg.registerStepping(
                ActionDescriptor.builder("input.mouse", Tier.SCENE)
                    .description("fake input.mouse（单测替身）")
                    .build(),
                () -> this::keyStep);
            reg.register(
                ActionDescriptor.builder("input.state", Tier.OBSERVE)
                    .description("fake input.state（只读替身）")
                    .build(),
                this::stateStep);
            reg.register(
                ActionDescriptor.builder("input.release", Tier.SCENE)
                    .description("fake input.release（全清替身）")
                    .build(),
                this::releaseStep);
        }

        /** 步进替身：{@code holdTicks} 拍后抬起并完成；{@code down} 保留持有后立即完成。 */
        private JsonObject keyStep(ActionContext ctx) {
            keyStepCalls++;
            JsonElement hold = Json.get(ctx.params(), "holdTicks");
            if (hold != null) {
                injectedHoldTicks = Integer.valueOf(hold.getAsInt());
            }
            if (failKeyAtAdvance > 0 && keyStepCalls == failKeyAtAdvance) {
                throw new CpException(ErrorCodes.EXEC_FAILED, "fake input.key 推进失败（负对照）");
            }
            String action = Json.optString(ctx.params(), "action", null);
            int holdTicks = hold == null ? 1 : hold.getAsInt();
            if (keyStepCalls == 1) {
                held.add("key.forward");
                timeline.add("down:key.forward");
            }
            if ("down".equals(action)) {
                return result(true);
            }
            if (keyStepCalls >= holdTicks) {
                held.remove("key.forward");
                timeline.add("up:key.forward");
                return result(true);
            }
            return null;
        }

        private JsonObject result(boolean delivered) {
            JsonObject o = new JsonObject();
            o.addProperty("observed", Boolean.TRUE);
            o.addProperty("delivered", delivered ? 2 : 1);
            JsonObject h = new JsonObject();
            h.addProperty("count", held.size());
            o.add("held", h);
            return o;
        }

        private JsonObject stateStep(ActionContext ctx) {
            JsonObject o = new JsonObject();
            o.addProperty("observed", Boolean.TRUE);
            o.addProperty("state", Integer.valueOf(held.size()));
            JsonObject h = new JsonObject();
            h.addProperty("count", held.size());
            o.add("held", h);
            timeline.add("state:" + held.size());
            return o;
        }

        private JsonObject releaseStep(ActionContext ctx) {
            int n = releaseAll();
            JsonObject o = new JsonObject();
            o.addProperty("observed", Boolean.TRUE);
            o.addProperty("count", n);
            timeline.add("release:" + n);
            return o;
        }

        private int releaseAll() {
            releaseCalls++;
            int n = held.size();
            for (String k : new ArrayList<String>(held)) {
                timeline.add("up:" + k);
            }
            held.clear();
            return n;
        }
    }
}
