package com.lightning.mod.client.controlplane.mc.input.observe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.mc.input.InputCapabilities;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;
import com.lightning.mod.client.controlplane.mc.input.api.InputRuntime;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateSnapshot;
import com.lightning.mod.client.controlplane.mc.input.api.ReleaseResult;

/**
 * {@code input.state} 的**两个实机缺陷**的离线回归锁（Gitea #165，实机窗口 L-2 / L-3）。
 *
 * <h2>为什么这两条必须有锁</h2>
 * 它们都属于「看起来正常的默认值」族——离线测试全绿、调用方据此做错决策：
 * <ul>
 * <li><b>L-2</b>：`keyboardCapacity` 实测报 **1**，而契约 §5.2 冻结 **256**。根因是探针把队列的
 * {@code Collection.size()}（当前条数 = seed 哨兵）当成了**容量**。量纲混淆不会让任何测试变红，
 * 只会让读的人以为「这个队列只有 1 格」。</li>
 * <li><b>L-3</b>：`actions` 报 **`[]`**，而五个动作**已注册**（同一个响应里 `implemented:true`）。
 * 能力发现面自称已实现却报不出任何动作名——正好与 §5.1 第 4 条「本动作是本族**唯一**的能力声明口」
 * 冲突。</li>
 * </ul>
 *
 * <p>
 * 两条判据都刻意断言**原始实测读数被如实留痕**（{@code keyboardCapacityRawRead}），
 * 因为「按契约常量上报」只有在同时公开「实读到的是什么」时才是诚实，否则就变成了隐藏。
 */
public class InputStateConsistencyTest {

    /** 最小运行时桩：只有 {@code snapshot()} 会被组装路径用到，其余方法不会被调用。 */
    private static final class Stub implements InputRuntime {

        @Override
        public DeliverResult deliver(List<InputEvent> events, String jobId) {
            throw new UnsupportedOperationException("本测试不投递");
        }

        @Override
        public ReleaseResult releaseJob(String jobId) {
            throw new UnsupportedOperationException("本测试不释放");
        }

        @Override
        public ReleaseResult releaseAll() {
            throw new UnsupportedOperationException("本测试不释放");
        }

        @Override
        public InputStateSnapshot snapshot() {
            return InputStateSnapshot.empty();
        }
    }

    private static JsonObject state(int keyboardCapacity, boolean withRuntime) {
        TickObservation obs = TickObservation.builder()
            .threadName("InputStateConsistencyTest")
            .atNanos(1L)
            .keyboardQueueDepth(InputCapabilities.KEYBOARD_SEED_BASELINE)
            .keyboardQueueCapacity(keyboardCapacity)
            .build();
        return InputStateProviderImpl.assemble(obs, withRuntime ? new Stub() : null, Boolean.TRUE);
    }

    private static JsonObject queues(JsonObject data) {
        return data.getAsJsonObject("queues");
    }

    // ------------------------------------------------------------------ L-2

    /**
     * <b>L-2</b>：集合的 {@code size()} 绝不能被当成容量——它就是实机读到的那个 1。
     *
     * <p>
     * 断言三件事：报契约冻结值、留下原始读数、source 说明为什么没按实读值报。
     */
    @Test
    public void liveReadingOfOneIsNotReportedAsCapacity() {
        JsonObject q = queues(state(1, true));
        assertEquals(
            "实机读到的 1 是「当前条数」口径，不是容量；必须按契约 §5.2 的冻结值上报",
            256,
            q.get("keyboardCapacity")
                .getAsInt());
        assertTrue(
            "必须能查出这个 256 不是实读值",
            q.get("keyboardCapacitySource")
                .getAsString()
                .contains("契约"));
        assertTrue("原始读数必须如实留痕（按常量上报也要让人看见实读到了什么）", q.has("keyboardCapacityRawRead"));
        assertEquals(
            1,
            q.get("keyboardCapacityRawRead")
                .getAsInt());
    }

    /** 基线以下的一切读数都不可信（容量必然大于 seed 基线）——0 与负数同样落契约常量。 */
    @Test
    public void implausibleCapacitiesAllFallBackToTheContractConstant() {
        for (int v : new int[] { 0, -1, InputCapabilities.KEYBOARD_SEED_BASELINE }) {
            JsonObject q = queues(state(v, true));
            assertEquals(
                "capacity=" + v + " 不可能是容量（容量必然 > seed 基线 " + InputCapabilities.KEYBOARD_SEED_BASELINE + "）",
                256,
                q.get("keyboardCapacity")
                    .getAsInt());
        }
    }

    /** 真读得到（定长数组 length）时才按实读值报，并写明来源。 */
    @Test
    public void realArrayLengthIsReportedAsACapacityWithItsSource() {
        JsonObject q = queues(state(512, true));
        assertEquals(
            512,
            q.get("keyboardCapacity")
                .getAsInt());
        assertTrue(
            q.get("keyboardCapacitySource")
                .getAsString()
                .contains("实读"));
        assertFalse("真读得到时不该出现「原始读数不可信」的留痕", q.has("keyboardCapacityRawRead"));
    }

    // ------------------------------------------------------------------ L-3

    /**
     * <b>L-3</b>：已注册时 {@code actions} 必须是本族能力真值表里那份清单，且与契约 §5.1 第 4 条
     * 「唯一能力声明口」自洽。
     */
    @Test
    public void actionsMatchesTheFamilyTruthTableWhenRegistered() {
        JsonObject data = state(256, true);
        assertTrue(
            "运行时有值 ⇒ implemented 必须为真",
            data.get("implemented")
                .getAsBoolean());

        Set<String> got = new TreeSet<String>();
        JsonArray actions = data.getAsJsonArray("actions");
        for (int i = 0; i < actions.size(); i++) {
            got.add(
                actions.get(i)
                    .getAsString());
        }
        Set<String> want = new TreeSet<String>();
        for (int i = 0; i < InputCapabilities.registeredActionsJson()
            .size(); i++) {
            want.add(
                InputCapabilities.registeredActionsJson()
                    .get(i)
                    .getAsString());
        }
        assertEquals("actions 必须逐条等于本族能力真值表（不许恒空、也不许自成一套）", want, got);
        assertEquals("契约 1.8 的输入族有五个动作", 5, got.size());
        assertEquals(
            "五个动作名逐个核对",
            new TreeSet<String>(
                Arrays.asList("input.key", "input.mouse", "input.text", "input.release", "input.state")),
            got);
    }

    /** §5.2 末条的自洽要求：未实现（无运行时）时 {@code actions} 必须是空数组。 */
    @Test
    public void actionsStaysEmptyWhenNotImplemented() {
        JsonObject data = state(256, false);
        assertFalse(
            data.get("implemented")
                .getAsBoolean());
        assertEquals(
            "未实现态不许报出动作名（否则能力面自相矛盾）",
            0,
            data.getAsJsonArray("actions")
                .size());
        assertTrue(
            "未实现态的 keyCatalog 也必须是空对象",
            data.getAsJsonObject("keyCatalog")
                .entrySet()
                .isEmpty());
        List<String> ignored = new ArrayList<String>();
        assertTrue(
            "未实现态必须有 notImplemented 说明",
            data.getAsJsonArray("notImplemented")
                .size() > 0);
        assertEquals(0, ignored.size());
    }
}
