package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.input.InputTestDoubles.FakeHost;

/**
 * 参数口径的离线锁（契约 §2.2 / §2.3 / §2.6 / §2.3 第 5 条 / §2.8）。
 *
 * <p>
 * 「非法参数逐条拒绝」是交付物之一，而它最容易退化成「第一条就中断」或「静默忽略不适用字段」——
 * 两种退化在本仓都有前科（{@code TYPE_INT} 松散转换、不适用字段静默忽略）。这里逐条钉住。
 */
public class InputParamsTest {

    /** 只在断言里用的动作片段（{@code CpException} 是非受检异常，lambda 直接用）。 */
    private interface Case {

        void run();
    }

    private final FakeHost host = new FakeHost();

    // ------------------------------------------------------------------ input.key

    /** 合法形态：描述名 + tap + holdTicks 都被接受，并解析出键码。 */
    @Test
    public void keyAcceptsCatalogNameAndTapHoldTicks() {
        InputKeyAction.Plan plan = InputKeyAction
            .parse(params("key", "key.forward", "action", "tap", "holdTicks", Integer.valueOf(20)), host);
        assertEquals("key.forward", plan.key.name);
        assertEquals(17, plan.key.code);
        assertEquals("tap", plan.action);
        assertEquals(20, plan.holdTicks);
        assertEquals(0, plan.codepoint);
    }

    /** int 形态给的是 LWJGL 键码；目录里有该键码时回填描述名。 */
    @Test
    public void keyAcceptsRawKeyCode() {
        InputKeyAction.Plan plan = InputKeyAction.parse(params("key", Integer.valueOf(57), "action", "down"), host);
        assertEquals(57, plan.key.code);
        assertEquals("key.jump", plan.key.name);
        assertEquals(1, plan.holdTicks);
    }

    /** 未知键位标识 ⇒ CP-VALID-002 且必须给出**完整键位目录**（不得只报「未知」）。 */
    @Test
    public void unknownKeyNameIsRejectedWithCatalog() {
        CpException e = expectParam(() -> InputKeyAction.parse(params("key", "key.fly", "action", "down"), host));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("key.fly"));
        assertNotNullField(e, "key");
        assertTrue(
            "必须给出完整键位目录（§2.2 第 1 条）",
            e.context()
                .has("registered"));
        assertEquals(
            3,
            e.context()
                .getAsJsonArray("registered")
                .size());
        assertTrue(
            e.context()
                .has("keyCodeRange"));
    }

    /** 键码越域（负数、>255）与字符串数字都拒（字符串形态只认注册表里的描述名）。 */
    @Test
    public void keyCodeOutOfRangeAndNumericStringAreRejected() {
        expectParam(() -> InputKeyAction.parse(params("key", Integer.valueOf(999), "action", "down"), host));
        expectParam(() -> InputKeyAction.parse(params("key", Integer.valueOf(-1), "action", "down"), host));
        expectParam(() -> InputKeyAction.parse(params("key", "17", "action", "down"), host));
    }

    /** {@code action} 取值域外/缺失 ⇒ 拒。 */
    @Test
    public void keyActionDomainIsEnforced() {
        expectParam(() -> InputKeyAction.parse(params("key", "key.forward", "action", "press"), host));
        expectParam(() -> InputKeyAction.parse(params("key", "key.forward"), host));
    }

    /** 不适用字段（down/up 带 holdTicks）必须**显式拒绝**，不许静默忽略（§2.2 第 6 条）。 */
    @Test
    public void holdTicksOnNonTapIsExplicitlyRejected() {
        CpException e = expectParam(
            () -> InputKeyAction
                .parse(params("key", "key.forward", "action", "down", "holdTicks", Integer.valueOf(40)), host));
        assertNotNullField(e, "holdTicks");
        assertTrue(
            e.detail(),
            e.detail()
                .contains("不适用"));
    }

    /** {@code holdTicks} 越界（0 / 1201）与非法类型（1.5、字符串）都拒（§2.2 / §3.2）。 */
    @Test
    public void holdTicksBoundsAreEnforced() {
        expectParam(
            () -> InputKeyAction
                .parse(params("key", "key.forward", "action", "tap", "holdTicks", Integer.valueOf(0)), host));
        expectParam(
            () -> InputKeyAction
                .parse(params("key", "key.forward", "action", "tap", "holdTicks", Integer.valueOf(1201)), host));
        // 边界内接受
        assertEquals(
            1200,
            InputKeyAction.parse(
                params("key", "key.forward", "action", "tap", "holdTicks", Integer.valueOf(1200)),
                host).holdTicks);
        // 非整数数值：TYPE_INT 语义**不截断**
        expectParam(
            () -> InputKeyAction
                .parse(params("key", "key.forward", "action", "tap", "holdTicks", Double.valueOf(1.5D)), host));
        expectParam(() -> InputKeyAction.parse(params("key", "key.forward", "action", "tap", "holdTicks", "3"), host));
    }

    /** {@code codepoint} 越域 ⇒ 拒（0..0xFFFF）。 */
    @Test
    public void codepointBoundsAreEnforced() {
        expectParam(
            () -> InputKeyAction
                .parse(params("key", "key.forward", "action", "down", "codepoint", Integer.valueOf(70000)), host));
        assertEquals(
            65535,
            InputKeyAction.parse(
                params("key", "key.forward", "action", "down", "codepoint", Integer.valueOf(65535)),
                host).codepoint);
    }

    // ------------------------------------------------------------------ input.mouse

    /** 逐 op 的必填/禁用表（§2.3）：禁用参数传了即拒，且逐字段给出理由。 */
    @Test
    public void mousePerOpApplicabilityTableIsEnforced() {
        // move 不接受 button
        CpException e1 = expectParam(
            () -> InputMouseAction.parse(
                params("op", "move", "x", Integer.valueOf(1), "y", Integer.valueOf(2), "button", Integer.valueOf(0))));
        assertNotNullField(e1, "button");
        // move 缺 y
        CpException e2 = expectParam(() -> InputMouseAction.parse(params("op", "move", "x", Integer.valueOf(1))));
        assertNotNullField(e2, "y");
        // relative 不接受 x，且缺 dy
        CpException e3 = expectParam(
            () -> InputMouseAction.parse(params("op", "relative", "dx", Integer.valueOf(1), "x", Integer.valueOf(1))));
        assertNotNullField(e3, "x");
        assertNotNullField(e3, "dy");
        // down/up 不接受坐标与 holdTicks
        CpException e4 = expectParam(
            () -> InputMouseAction
                .parse(params("op", "down", "button", Integer.valueOf(0), "holdTicks", Integer.valueOf(3))));
        assertNotNullField(e4, "holdTicks");
        // click 接受 holdTicks，但不接受 amount
        expectParam(
            () -> InputMouseAction
                .parse(params("op", "click", "button", Integer.valueOf(0), "amount", Integer.valueOf(1))));
        // wheel 不接受 button
        expectParam(
            () -> InputMouseAction
                .parse(params("op", "wheel", "amount", Integer.valueOf(1), "button", Integer.valueOf(0))));
    }

    /** op 取值域外 ⇒ 拒（契约只冻结六个 op，未定义 op 不许静默 no-op）。 */
    @Test
    public void mouseOpDomainIsEnforced() {
        CpException e = expectParam(() -> InputMouseAction.parse(params("op", "drag", "button", Integer.valueOf(0))));
        assertNotNullField(e, "op");
    }

    /** 滚轮：零档、非整数、越界（|amount|>8）一律拒（§2.3 第 5 条）。 */
    @Test
    public void wheelRejectsZeroFractionAndOutOfRange() {
        expectParam(() -> InputMouseAction.parse(params("op", "wheel", "amount", Integer.valueOf(0))));
        expectParam(() -> InputMouseAction.parse(params("op", "wheel", "amount", Integer.valueOf(9))));
        expectParam(() -> InputMouseAction.parse(params("op", "wheel", "amount", Double.valueOf(1.5D))));
        assertEquals(8, InputMouseAction.parse(params("op", "wheel", "amount", Integer.valueOf(8))).amount);
        assertEquals(-8, InputMouseAction.parse(params("op", "wheel", "amount", Integer.valueOf(-8))).amount);
    }

    /** 按钮编号是 LWJGL 的 0/1/2，不是 SDL 的 1/2/3（§2.6）。 */
    @Test
    public void buttonNumberingIsLwjglNotSdl() {
        assertEquals(0, InputMouseAction.parse(params("op", "down", "button", Integer.valueOf(0))).button);
        expectParam(() -> InputMouseAction.parse(params("op", "down", "button", Integer.valueOf(3))));
        expectParam(() -> InputMouseAction.parse(params("op", "up", "button", Integer.valueOf(-1))));
    }

    /** click 的 holdTicks 越界 ⇒ 拒；边界内接受。 */
    @Test
    public void clickHoldTicksBoundsAreEnforced() {
        expectParam(
            () -> InputMouseAction
                .parse(params("op", "click", "button", Integer.valueOf(0), "holdTicks", Integer.valueOf(0))));
        expectParam(
            () -> InputMouseAction
                .parse(params("op", "click", "button", Integer.valueOf(0), "holdTicks", Integer.valueOf(1201))));
        assertEquals(
            2,
            InputMouseAction
                .parse(params("op", "click", "button", Integer.valueOf(1), "holdTicks", Integer.valueOf(2))).holdTicks);
    }

    /** 相对与绝对不可混用/不可互换（§2.5）：move 只吃 x/y，relative 只吃 dx/dy。 */
    @Test
    public void relativeAndAbsoluteAreNotInterchangeable() {
        assertEquals(
            5.0D,
            InputMouseAction.parse(params("op", "relative", "dx", Integer.valueOf(5), "dy", Integer.valueOf(0))).dx,
            0.0001D);
        expectParam(
            () -> InputMouseAction.parse(
                params("op", "move", "x", Integer.valueOf(1), "y", Integer.valueOf(2), "dx", Integer.valueOf(1))));
    }

    // ------------------------------------------------------------------ input.text

    /**
     * 文本的能力真值：路由未就绪 ⇒ 任何非空请求走 {@code CP-STATE-001}（动作里那条门）；
     * 声明范围为空 ⇒ 逐字符校验器把**每个**字符都判为范围外（不许静默丢弃/替换）。
     */
    @Test
    public void textRouteNotReadyAndRangesAreEmpty() {
        assertFalse("本单的真相：文本路由两路都没打通", InputTextAction.textRouteReady());
        assertFalse(InputCapabilities.TEXT_SUPPORTED);
        assertFalse(InputCapabilities.TEXT_ROUTE_WORLD);
        assertFalse(InputCapabilities.TEXT_ROUTE_GUI);
        assertEquals(
            0,
            InputCapabilities.textRangesJson()
                .size());
    }

    /** 逐字符范围校验：条数与内容逐项可判（供 §2.8 第 3 条的「逐字符给出」用）。 */
    @Test
    public void outOfRangeReportsEveryCharacter() {
        JsonArray bad = InputTextAction.outOfRange("Hi");
        assertEquals(2, bad.size());
        JsonObject first = bad.get(0)
            .getAsJsonObject();
        assertEquals(
            0,
            first.get("index")
                .getAsInt());
        assertEquals(
            "H",
            first.get("char")
                .getAsString());
        assertEquals(
            72,
            first.get("codepoint")
                .getAsInt());
        assertTrue(
            first.get("reason")
                .getAsString()
                .length() > 0);
        assertEquals(
            105,
            bad.get(1)
                .getAsJsonObject()
                .get("codepoint")
                .getAsInt());
        assertEquals(
            0,
            InputTextAction.outOfRange("")
                .size());
    }

    // ------------------------------------------------------------------ 工具

    static JsonObject params(Object... kv) {
        JsonObject o = new JsonObject();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            String k = String.valueOf(kv[i]);
            Object v = kv[i + 1];
            if (v instanceof String) {
                o.addProperty(k, (String) v);
            } else if (v instanceof Integer) {
                o.addProperty(k, (Integer) v);
            } else if (v instanceof Double) {
                o.addProperty(k, (Double) v);
            } else if (v instanceof Boolean) {
                o.addProperty(k, (Boolean) v);
            }
        }
        return o;
    }

    private static CpException expectParam(Case c) {
        try {
            c.run();
            fail("应报 CP-VALID-002");
            return null;
        } catch (CpException e) {
            assertEquals("错误码必须是 CP-VALID-002（本族不新增错误码）", ErrorCodes.VALID_PARAM, e.code());
            assertTrue("必须带 context.fields", e.hasContext());
            return e;
        }
    }

    private static void assertNotNullField(CpException e, String field) {
        JsonArray fields = e.context()
            .getAsJsonArray("fields");
        for (int i = 0; i < fields.size(); i++) {
            if (field.equals(
                fields.get(i)
                    .getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                return;
            }
        }
        fail("context.fields 里必须包含字段 " + field + "，实际 " + Json.toJson(fields));
    }

    /** {@link Json#get} 的空值口径（错误上下文里要用它，不能 NPE）。 */
    @Test
    public void typeNameHandlesNull() {
        assertNull(Json.get(new JsonObject(), "nope"));
        assertEquals("null", Json.typeName(null));
    }
}
