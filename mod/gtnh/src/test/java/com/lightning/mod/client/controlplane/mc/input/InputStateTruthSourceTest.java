package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CaptureSession;
import com.lightning.mod.client.controlplane.mc.input.InputTestDoubles.FakeHost;
import com.lightning.mod.client.controlplane.mc.input.InputTestDoubles.FakeSink;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;
import com.lightning.mod.client.controlplane.mc.input.observe.InputScaleContext;
import com.lightning.mod.client.controlplane.mc.input.observe.InputStateProviderImpl;
import com.lightning.mod.client.controlplane.mc.input.observe.TickObservation;

/**
 * 「同一个量只有一处真值」的机读防线（Gitea #166 的 DR-6 / DR-11 / DR-12）。
 *
 * <h2>为什么这些断言必须存在</h2>
 * 本仓反复被惩罚的失效模式是**两处真相**：同一个量被两个端点各算一遍，其中一处慢慢变成常量。
 * {@code input.state.coordinates.selfCalibrated} 此前被硬编码成 {@code false}，而 {@code input.mouse}
 * 的同一个字段取自运行时 ⇒ 一次真的自校准成功时，能力面仍在说 false（调用方据此会认为换算不可信）。
 * 三条断言分别把三处收口钉住：
 * <ol>
 * <li>{@code coordinates.selfCalibrated}（能力面）与运行时记录同源，且「尚无 move」与「校准失败」分得开；</li>
 * <li>{@code input.state.state} 报运行时的真实态（契约 §7 必报项），失败信封的 {@code context.state} 同源；</li>
 * <li>四个可写动作的 {@code consumer.captureArmed} 与 {@code input.state} 同源（D-2 的补偿措施）。</li>
 * </ol>
 */
public class InputStateTruthSourceTest {

    private FakeHost host;
    private FakeSink sink;
    private InputRuntimeImpl rt;

    @Before
    public void setUp() {
        host = new FakeHost();
        sink = new FakeSink(host);
        rt = InputRuntimeImpl.create(host, sink);
    }

    /** 满配探测（坐标上下文齐、键位目录齐、五个注入入口齐）。 */
    private static TickObservation probe() {
        return TickObservation.builder()
            .threadName("Client thread")
            .atNanos(1L)
            .keyboardQueueDepth(1)
            .keyboardQueueCapacity(256)
            .mouse(426, 322)
            .context(new InputScaleContext(854, 480, 854, 480, 1, 0, 1.0d, 854, 480))
            .keyBinding("key.forward", 17)
            .keyCodeRange(0, 255)
            .runtime("1.7.10", "10.13.4.1614", "3.0.8", "sdl")
            .injector("Keyboard.addRawKeyEvent")
            .injector("Keyboard.addCharEvent")
            .injector("Mouse.addMoveEvent")
            .injector("Mouse.addButtonEvent")
            .injector("Mouse.addWheelEvent")
            .build();
    }

    private JsonObject state() {
        return InputStateProviderImpl.assemble(probe(), rt, Boolean.TRUE);
    }

    /** 单条事件批（本文件只投递一条）。 */
    private static List<InputEvent> one(InputEvent e) {
        return Collections.singletonList(e);
    }

    // ------------------------------------------------------------ DR-6

    /**
     * 【#166 DR-6 守卫】{@code input.state.coordinates.selfCalibrated} 必须报**运行时记录的那一次**
     * move 的读回结论；修复前它是硬编码 {@code false} ⇒ 本用例在修复前必红。
     */
    @Test
    public void selfCalibratedComesFromTheRuntimeRecord() {
        // 尚无 move：false + 明说是「未校准」而不是「校准失败」
        JsonObject before = state().getAsJsonObject("coordinates");
        assertFalse(
            "尚无 move ⇒ 不许声称已自校准",
            before.get("selfCalibrated")
                .getAsBoolean());
        assertNotNull("尚无 move ⇒ 必须给出说明（「未校准」与「校准失败」不可混同）", before.get("selfCalibratedNote"));
        assertTrue(
            before.get("selfCalibratedNote")
                .getAsString()
                .contains("no-move-yet"));

        // 一次成功的 move 之后：能力面必须跟着变 true（同一实现点）
        rt.recordCalibration(true);
        JsonObject after = state().getAsJsonObject("coordinates");
        assertTrue(
            "运行时记录了成功的自校准 ⇒ input.state 的 selfCalibrated 必须是 true（不许继续硬编码 false）",
            after.get("selfCalibrated")
                .getAsBoolean());

        // 一次失败的自校准：必须如实回 false（而不是「未校准」）
        rt.recordCalibration(false);
        JsonObject failed = state().getAsJsonObject("coordinates");
        assertFalse(
            failed.get("selfCalibrated")
                .getAsBoolean());
    }

    // ------------------------------------------------------------ DR-11

    /** 【#166 DR-11 守卫】契约 §7 要求 {@code input.state} 必报 {@code state}（含 faulted）。 */
    @Test
    public void stateIsReportedFromTheRuntimeStateMachine() {
        assertEquals(
            "空闲态必须如实报 idle",
            "idle",
            state().get("state")
                .getAsString());

        // 产生持有点 ⇒ holding（态由运行时自己产生，本类只转发）
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        assertEquals(
            "有持有点 ⇒ holding",
            "holding",
            state().get("state")
                .getAsString());

        rt.releaseAll();
        assertEquals(
            "释放后回到 idle",
            "idle",
            state().get("state")
                .getAsString());
    }

    /** 线程失败的失败信封必须给出 {@code context.state}（契约 §7）；拿不到真值时如实落 null + 说明。 */
    @Test
    public void threadFailureContextCarriesTheCurrentState() {
        InputStateProviderImpl provider = new InputStateProviderImpl(rt, new InputStateProviderImpl.TickProbe() {

            @Override
            public TickObservation probe() {
                return InputStateTruthSourceTest.probe();
            }
        }, new InputStateProviderImpl.TickThreadCheck() {

            @Override
            public Boolean isTickThread() {
                return Boolean.FALSE;
            }
        });
        rt.deliver(one(InputEvent.key("key.forward", 17, true, Integer.valueOf(0))), "j1");
        JsonObject envelope = provider.state();
        assertFalse(
            envelope.get("ok")
                .getAsBoolean());
        JsonObject ctx = envelope.getAsJsonObject("error")
            .getAsJsonObject("context");
        assertEquals(
            "失败信封必须给出当前态（§7）",
            "holding",
            ctx.get("state")
                .getAsString());
    }

    // ------------------------------------------------------------ DR-12

    /**
     * 【#166 DR-12 守卫】四个可写动作共用的 {@code consumer} 必须带 {@code captureArmed}
     * （D-2 的补偿措施：取证布防期间不拒输入，由调用方据本字段自行决定）。
     */
    @Test
    public void writableActionConsumerReportsCaptureArmed() {
        JsonObject c = InputSupport.consumer(host);
        assertTrue("四个可写动作的 consumer 必须带 captureArmed（修复前只有 input.state 有）", c.has("captureArmed"));
        assertEquals(
            "取值必须与 input.state 同一实现点（CaptureSession）",
            CaptureSession.isArmed(),
            c.get("captureArmed")
                .getAsBoolean());
    }
}
