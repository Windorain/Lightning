package com.lightning.mod.client.controlplane.mc.input.observe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateProvider;

/**
 * {@code input.state} 的**动作层**断言（注册落地后）。
 *
 * <h2>这一组防的是什么</h2>
 * {@code InputStateProviderImpl.state()} 在非 tick 线程上被误用时返回
 * {@code {ok:false, error:{code,message,context}}}（{@code contract.md} §3 冻结的**协议级**错误信封）。
 * 而动作的返回值会被 core 包成 {@code {ok:true, data:<返回值>}}——原样透传就会变成
 * <b>HTTP 200 + ok:true</b>，把一次失败报成成功（本仓明令要防的「静默红」）。
 *
 * <p>
 * 因此动作层必须把该形态转成真正的 {@link CpException}。本测试用**注入的桩**覆盖它——
 * 不需要客户端、不需要 tick 线程，因此这条判据在任何环境下都能跑（不会因为「跑不了实机」而空转）。
 */
public class InputStateActionTest {

    /** 返回固定响应体的桩（模拟观察侧的提供方）。 */
    private static final class Stub implements InputStateProvider {

        private final JsonObject out;
        private int calls;

        Stub(JsonObject out) {
            this.out = out;
        }

        @Override
        public JsonObject state() {
            calls++;
            return out;
        }
    }

    private static JsonObject snapshot() {
        JsonObject o = new JsonObject();
        o.addProperty("implemented", Boolean.TRUE);
        o.addProperty("family", "input");
        o.addProperty("means", "input");
        return o;
    }

    /** 正常快照**逐字**透传（动作层不得改写提供方的任何字段）。 */
    @Test
    public void normalSnapshotPassesThroughUnchanged() {
        JsonObject snap = snapshot();
        Stub stub = new Stub(snap);
        JsonObject got = new InputStateAction(stub).execute(null);
        assertSame("动作层只做边界适配，不得复制/改写快照", snap, got);
        assertFalse("正常 data 里不该被塞进 ok/error", got.has("ok"));
        assertEquals(1, stub.calls);
    }

    /** 协议级错误信封必须变成**真正的**错误（否则 HTTP 200 + ok:true 会把红跑读成绿跑）。 */
    @Test
    public void failedEnvelopeBecomesARealError() {
        JsonObject failed = Json.parseStrictObject(
            "{\"ok\":false,\"error\":{\"code\":\"CP-STATE-001\"," + "\"message\":\"输入状态快照必须在客户端 tick 线程取得\","
                + "\"context\":{\"thread\":\"cp-http-worker\",\"requiredThread\":\"client-tick\"}}}");
        try {
            new InputStateAction(new Stub(failed)).execute(null);
            fail("失败信封必须抛 CpException，不得作为成功返回");
        } catch (CpException e) {
            assertEquals("错误码必须逐字来自提供方", ErrorCodes.STATE, e.code());
            assertEquals("输入状态快照必须在客户端 tick 线程取得", e.detail());
            assertNotNull("context 必须保留", e.context());
            assertEquals(
                "cp-http-worker",
                e.context()
                    .get("thread")
                    .getAsString());
            assertEquals("httpStatus 必须按错误码映射（不是 200）", ErrorCodes.httpStatus(ErrorCodes.STATE), e.httpStatus());
            assertTrue("HTTP 状态码必须是非 2xx", e.httpStatus() >= 400);
        }
    }

    /**
     * <b>负对照</b>：形似但不是错误的对象不得被误判。
     *
     * <p>
     * 三种「像」的情形都要放行：{@code ok:true}、只有 {@code error} 没有 {@code ok}、
     * {@code error} 不是对象。判据收紧到「{@code ok} 是布尔假 <b>且</b> {@code error} 是对象」，
     * 因此不会把合法的快照吃掉——若把这条判据放宽（例如只看 {@code has("error")}），
     * 一个恰好带 {@code error} 字段的合法快照就会被误判成失败。
     */
    @Test
    public void lookalikesAreNotMistakenForAnError() {
        JsonObject okTrue = Json.parseStrictObject("{\"ok\":true,\"error\":\"note\"}");
        assertSame(okTrue, new InputStateAction(new Stub(okTrue)).execute(null));

        JsonObject errorOnly = Json.parseStrictObject("{\"error\":{\"code\":\"CP-STATE-001\"}}");
        assertSame("没有 ok 键 ⇒ 不是协议信封，不得按错误处理", errorOnly, new InputStateAction(new Stub(errorOnly)).execute(null));

        JsonObject errorNotObject = Json.parseStrictObject("{\"ok\":false,\"error\":\"boom\"}");
        assertSame(
            "ok:false 但 error 不是对象 ⇒ 不匹配本族冻结的错误形态，按 data 透传（不猜）",
            errorNotObject,
            new InputStateAction(new Stub(errorNotObject)).execute(null));
    }

    /** 提供方返回 {@code null} = 实现缺陷，必须是显式失败，不得当成「空状态」。 */
    @Test
    public void nullBodyIsAnImplementationDefectNotASuccess() {
        try {
            new InputStateAction(new Stub(null)).execute(null);
            fail("null 响应体必须显式失败");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                e.detail(),
                e.detail()
                    .contains("null"));
        }
    }

    /** 动作名只有一处真值（{@code api} 面），观察面与能力真值表共用它。 */
    @Test
    public void actionNameComesFromTheApiFace() {
        assertEquals("input.state", InputStateProvider.ACTION_NAME);
        assertEquals(InputStateProvider.ACTION_NAME, InputStateAction.NAME);
    }

    /** 自描述：observe 级、不需 confirm、{@code since=1.8}、{@code means=input}。 */
    @Test
    public void descriptorIsObserveAndCarriesMeans() {
        ActionDescriptor d = InputStateAction.descriptor();
        assertEquals(InputStateProvider.ACTION_NAME, d.name());
        assertEquals(Tier.OBSERVE, d.tier());
        assertFalse("observe 级不得要求 confirm", d.writable());
        assertEquals("1.8", d.since());
        assertEquals("input", d.means());
        assertEquals(
            "input",
            d.toJson()
                .get("means")
                .getAsString());
        assertFalse(
            "自描述里不得声称本动作可写",
            d.toJson()
                .get("writable")
                .getAsBoolean());
        assertTrue(
            "说明必须写明「唯一能力声明口」，否则调用方会去读散文",
            d.description()
                .contains("唯一能力声明口"));
    }
}
