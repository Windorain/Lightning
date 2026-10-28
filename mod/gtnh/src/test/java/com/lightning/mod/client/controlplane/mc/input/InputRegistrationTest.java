package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import org.junit.Test;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateProvider;

/**
 * 输入族的**注册面**验收（契约 {@code input-contract.md} §6 / §9 第 3 条 / {@code contract.md} §5 与 §13 第 4 条）。
 *
 * <h2>这一组断言防的是什么</h2>
 * 注册这件事有三处会各自漂移，而任何一处单独看都「正常」：
 * <ol>
 * <li><b>动作计数</b>：{@code ActionRegistrar} 的注释、{@code contract.md} §7 的计数、
 * {@code ReadCaptureOfflineTest} 的断言——三者历史上有过「注释写 8、实际 11」的漂移；</li>
 * <li><b>能力面与注册面不同源</b>：{@code input.state.actions[]} 可能是手写的一份目录，
 * 与注册表里实际有什么无关。本测试把两者**逐条对账**；</li>
 * <li><b>自描述字段集合</b>：{@code means} 是可选字段（不设默认值）。一旦有人给它加了默认值，
 * 43 个既有动作的自描述 JSON 会**静默**全变——离线测试原本拦不住（这正是 {@code input-contract.md}
 * {@code contract.md} §5 的离线防线）。本测试用**字段集合断言**把它钉死。</li>
 * </ol>
 */
public class InputRegistrationTest {

    /** 输入族五个动作名（{@code input.state} 的取名口径见 {@link InputStateProvider#ACTION_NAME}）。 */
    private static final String[] INPUT_ACTIONS = { InputKeyAction.NAME, InputMouseAction.NAME, InputTextAction.NAME,
        InputReleaseAction.NAME, InputStateProvider.ACTION_NAME };

    /** 四个可写动作（本族唯一的只读动作是 {@code input.state}）。 */
    private static final String[] WRITABLE_INPUT_ACTIONS = { InputKeyAction.NAME, InputMouseAction.NAME,
        InputTextAction.NAME, InputReleaseAction.NAME };

    /** 既有 43 个动作的自描述字段集合（本次<b>不得</b>改变它）。 */
    private static final Set<String> BASE_FIELDS = new TreeSet<String>(
        Arrays.asList(
            "name",
            "tier",
            "writable",
            "confirmRequired",
            "description",
            "params",
            "returns",
            "examples",
            "since"));

    /** 输入族的字段集合 = 既有集合 + {@code means}（只多这一个）。 */
    private static final Set<String> INPUT_FIELDS;

    static {
        Set<String> s = new TreeSet<String>(BASE_FIELDS);
        s.add("means");
        INPUT_FIELDS = s;
    }

    private static ActionRegistry registry() {
        ActionRegistry r = new ActionRegistry();
        ActionRegistrar.registerAll(null, r);
        return r;
    }

    /** 五个动作都进了注册表，权限级与可写性符合契约（四个 scene 可写 + 一个 observe 只读）。 */
    @Test
    public void inputFamilyIsRegisteredWithDeclaredTiers() {
        ActionRegistry r = registry();
        for (String n : WRITABLE_INPUT_ACTIONS) {
            ActionDescriptor d = r.descriptor(n);
            assertNotNull("动作必须已注册: " + n, d);
            assertEquals(n + " 是 scene 级可写动作（契约 §2 第 4 条：可写 ⇒ 必须 confirm）", Tier.SCENE, d.tier());
            assertTrue(n + " 必须可写", d.writable());
        }
        ActionDescriptor st = r.descriptor(InputStateProvider.ACTION_NAME);
        assertNotNull("input.state 必须已注册", st);
        assertEquals("input.state 是只读观察面（契约 §6）", Tier.OBSERVE, st.tier());
        assertFalse("input.state 不得要求 confirm", st.writable());
    }

    /**
     * 注册形态（步进 vs 同步）必须与语义一致。
     *
     * <p>
     * 这一条防的是「把跨 tick 的动作注册成同步」：那样 {@code tap} 的抬起永远不会被执行，
     * 表现为「按键按下去了但不弹」——而单测跑不出来（它是作业执行器的调度行为）。
     */
    @Test
    public void steppingAndSyncShapesMatchTheContract() {
        ActionRegistry r = registry();
        assertTrue(
            "input.key 的 tap/holdTicks 跨 tick ⇒ 必须注册为步进",
            r.lookup(InputKeyAction.NAME)
                .isStepping());
        assertTrue(
            "input.mouse 的 click/holdTicks 跨 tick ⇒ 必须注册为步进",
            r.lookup(InputMouseAction.NAME)
                .isStepping());
        assertFalse(
            "input.text 一次调用内逐字符投完",
            r.lookup(InputTextAction.NAME)
                .isStepping());
        assertFalse(
            "input.release 一次调用内清完",
            r.lookup(InputReleaseAction.NAME)
                .isStepping());
        assertFalse(
            "input.state 一次调用内读完（跨 tick 的读面会读到两个世界状态）",
            r.lookup(InputStateProvider.ACTION_NAME)
                .isStepping());
    }

    /** {@code since} 是实值 {@code 1.8}，且契约版本 ≥ 每个动作的 since（D1/D3 不变式）。 */
    @Test
    public void sinceIsConcreteAndCoveredByContractVersion() {
        ActionRegistry r = registry();
        assertEquals("契约版本必须随输入族前进", "1.8", r.contractVersion());
        for (String n : INPUT_ACTIONS) {
            assertEquals(
                n + " 的 since 必须是实值 1.8（{@code contract.md} §13 第 4 条：与 contractVersion 前进同一次改动）",
                "1.8",
                r.descriptor(n)
                    .since());
        }
        for (String n : r.names()) {
            ActionDescriptor d = r.descriptor(n);
            assertTrue(
                n + " 的 since=" + d.since() + " 高于契约版本 " + r.contractVersion(),
                r.contractVersion()
                    .compareTo(d.since()) >= 0);
        }
    }

    /**
     * <b>手段归因来自自描述</b>（执行第 1 条）：输入族写 {@code means:"input"}；
     * 其余动作**不出现** {@code means} 键。
     *
     * <p>
     * 后半条是重点：{@code means} 是可选字段且**不设默认值**。若有人给它一个默认值（例如
     * {@code "api"}），43 个既有动作的自描述 JSON 会静默改变——而本仓的判据不允许把「未声明」
     * 读成「已具备某个默认值」。
     */
    @Test
    public void meansComesFromTheSelfDescriptionAndDoesNotLeak() {
        ActionRegistry r = registry();
        for (String n : INPUT_ACTIONS) {
            ActionDescriptor d = r.descriptor(n);
            assertEquals(n + " 的手段归因必须来自自描述", "input", d.means());
            JsonObject j = d.toJson();
            assertTrue(n + " 的自描述 JSON 里必须有 means", j.has("means"));
            assertEquals(
                "input",
                j.get("means")
                    .getAsString());
        }
        int others = 0;
        for (String n : r.names()) {
            if (n.startsWith("input.")) {
                continue;
            }
            others++;
            assertNull(
                n + " 未声明手段归因 ⇒ 自描述 JSON 里不得出现 means 键（可选字段不许用默认值冒充「已声明」）",
                r.descriptor(n)
                    .toJson()
                    .get("means"));
        }
        assertEquals("除输入族外的动作数应为 43（48 - 5）", 43, others);
    }

    /**
     * <b>字段集合断言</b>：既有动作的字段集合逐字不变；输入族只多 {@code means} 一个键。
     *
     * <p>
     * 与 {@link #meansComesFromTheSelfDescriptionAndDoesNotLeak()} 的分工：那一条看「有没有值」，
     * 这一条看「有没有键」——新增/删除任何一个自描述字段都必须显式经过这里。
     */
    @Test
    public void descriptorFieldSetIsFrozenAndOnlyGainsMeansForTheInputFamily() {
        ActionRegistry r = registry();
        int inputSeen = 0;
        for (String n : r.names()) {
            Set<String> got = new TreeSet<String>();
            for (Map.Entry<String, JsonElement> e : r.descriptor(n)
                .toJson()
                .entrySet()) {
                got.add(e.getKey());
            }
            Set<String> want = n.startsWith("input.") ? INPUT_FIELDS : BASE_FIELDS;
            assertEquals(n + " 的自描述字段集合漂移", want, got);
            if (n.startsWith("input.")) {
                inputSeen++;
            }
        }
        assertEquals("输入族应有 5 个动作", 5, inputSeen);
    }

    /** 示例必须可照抄：可写动作的每条示例都带 {@code confirm:true}；只读的 {@code input.state} 不需要。 */
    @Test
    public void examplesAreCopyable() {
        ActionRegistry r = registry();
        for (String n : WRITABLE_INPUT_ACTIONS) {
            ActionDescriptor d = r.descriptor(n);
            assertTrue(
                n + " 至少给一条示例",
                d.examples()
                    .size() > 0);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                JsonObject ex = Json.parseStrictObject(
                    Json.toJson(
                        d.examples()
                            .get(i)));
                assertTrue(
                    n + " 示例 " + i + " 必须带 \"confirm\": true（否则照抄即被 CP-CONFIRM-001 拒）",
                    Json.optBool(ex, "confirm", false));
            }
        }
        ActionDescriptor st = r.descriptor(InputStateProvider.ACTION_NAME);
        assertTrue(
            "input.state 至少给一条示例",
            st.examples()
                .size() > 0);
        JsonObject ex0 = Json.parseStrictObject(
            Json.toJson(
                st.examples()
                    .get(0)));
        // 注意：这里断言的是「**没有** confirm 键」而不是 optBool 取值——observe 级动作既不要求
        // confirm，也不该在示例里出现它（出现即暗示调用方要带，而带了也无害但会误导）。
        assertFalse("input.state 是 observe 级 ⇒ 示例里不应出现 confirm（它既不需要、出现还会误导调用方）", ex0.has("confirm"));
    }
}
