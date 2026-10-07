package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;
import com.lightning.mod.client.controlplane.mc.capture.CaptureDiagAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureDiagSession;
import com.lightning.mod.client.controlplane.mc.read.ReadRunAction;
import com.lightning.mod.client.controlplane.mc.scene.L0Session;

/**
 * {@code TYPE_INT} 参数的<b>严格</b>取值口径（Gitea #131）。离线锁死，不依赖 MC 实例。
 *
 * <h2>为什么必须离线锁死</h2>
 *
 * 缺陷形态是<b>静默</b>的：{@code {"limit":1.5}} 在改造前是 exit 0 + 回显 {@code 1}——没有错误、没有
 * {@code context}、没有任何提示（根因见 {@code Json.java:238} 的 gson 宽松取值）。实机跑一次「绿的」
 * 反而证明不了任何东西，所以判据必须落在纯 JVM 可复算的取值点上。
 *
 * <h2>判据结构（三层，缺一不可）</h2>
 *
 * <ol>
 * <li><b>取值表逐行</b>：{@code 3}/{@code 3.0}/{@code -7} 接受；{@code 1.5}/{@code -0.5}/{@code true}/
 * {@code "3"}/超范围拒绝；缺键与显式 {@code null} 走默认值（{@code contract.md} §2.1 的对照表）；</li>
 * <li><b>全动作面机械扫</b>：遍历注册表里全部动作，凡自述声明 {@code TYPE_INT} 的参数，喂
 * {@code 1.5}/{@code "3"}/{@code true}/超范围都必须报错——把纪律变成机械可验的，而不是逐动作自觉；</li>
 * <li><b>两条既有反例真调动作</b>：{@code read.run limit:1.5} 与 {@code capture.diag maxEvents/margin:1.5}
 * 走真实动作入口（改前分别是 exit 0 与静默截断）。</li>
 * </ol>
 *
 * <p>
 * 反向护栏同样重要：声明为 {@code number} 的参数（{@code yaw}/{@code pitch}/{@code distance}/{@code health}…）
 * 必须<b>照旧接受小数</b>——收紧要收在 {@code int} 上，不能顺手把 number 也扣住。
 */
public class IntParamStrictnessTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** 全类复用的产物仓库（见 {@link #store()}）。 */
    private ArtifactStore sharedStore;

    // ------------------------------------------------------------ 取值表（contract.md §2.1）

    /** 接受：精确整数（含 {@code 3.0} 这种「数值精确为整数」的写法）。 */
    @Test
    public void acceptsExactIntegersIncludingTrailingZeroForm() {
        assertEquals(3, Json.strictInt(obj("p", new JsonPrimitive(3)), "p", -1));
        assertEquals(3, Json.strictInt(obj("p", new JsonPrimitive(3.0d)), "p", -1));
        assertEquals(-7, Json.strictInt(obj("p", new JsonPrimitive(-7)), "p", -1));
        assertEquals(300, Json.strictInt(objRaw("p", "3e2"), "p", -1));
        assertEquals(
            2147483647,
            Json.strictInt(obj("p", new JsonPrimitive(Integer.valueOf(Integer.MAX_VALUE))), "p", -1));
        assertEquals(
            -2147483648,
            Json.strictInt(obj("p", new JsonPrimitive(Integer.valueOf(Integer.MIN_VALUE))), "p", -1));
    }

    /** 缺键与显式 {@code null} 都是「未提供」⇒ 默认值（契约 §2.1 明写，不是沉默行为）。 */
    @Test
    public void missingAndExplicitNullUseDefault() {
        assertEquals(42, Json.strictInt(new JsonObject(), "p", 42));
        JsonObject withNull = new JsonObject();
        withNull.add("p", com.google.gson.JsonNull.INSTANCE);
        assertEquals(42, Json.strictInt(withNull, "p", 42));
        assertEquals(42L, Json.strictLong(withNull, "p", 42L));
    }

    /** 拒绝：非整数数值不截断、字符串不解析、布尔不当 1、超范围不放行。 */
    @Test
    public void rejectsFractionStringBooleanAndOutOfRange() {
        String[] expectedReasonFragment = { "带小数的数值", "带小数的数值", "布尔", "字符串", "超出 int" };
        Object[] bad = { Double.valueOf(1.5d), Double.valueOf(-0.5d), Boolean.TRUE, "3", Long.valueOf(2147483648L) };
        for (int i = 0; i < bad.length; i++) {
            Object v = bad[i];
            JsonObject p = new JsonObject();
            addRaw(p, "p", v);
            try {
                int got = Json.strictInt(p, "p", -1);
                fail("必须拒绝 " + v + "（实际返回 " + got + "）");
            } catch (CpException e) {
                assertEquals("错误码必须是既有的参数非法码", ErrorCodes.VALID_PARAM, e.code());
                String ctx = Json.toJson(e.context());
                assertTrue("context 必须含字段名: " + ctx, ctx.contains("\"field\":\"p\""));
                assertTrue("context 必须含收到的值: " + ctx, ctx.contains("\"received\""));
                assertTrue("context 必须含收到的类型: " + ctx, ctx.contains("\"receivedType\""));
                assertTrue("context 必须含期望类型: " + ctx, ctx.contains("\"expected\":\"int\""));
                assertTrue("context 必须含 hint: " + ctx, ctx.contains("\"hint\""));
                assertTrue("拒绝原因必须说清是哪一类（" + v + "）: " + ctx, ctx.contains(expectedReasonFragment[i]));
                assertTrue(
                    "message 必须含参数名与收到的值: " + e.detail(),
                    e.detail()
                        .contains("p")
                        && e.detail()
                            .contains(String.valueOf(v)));
            }
        }
        // 布尔与字符串尤其要证明「没有走 gson 的宽松取值」：true 曾是 1、"3" 曾是 3
        assertEquals(
            "布尔不得当 1",
            "期望 JSON 数值（精确整数），收到布尔 true（布尔不做 0/1 转换）",
            Json.integralRejectReason(new JsonPrimitive(Boolean.TRUE)));
        assertEquals(
            "字符串数字不得被解析",
            "期望 JSON 数值（精确整数），收到字符串 \"3\"（字符串不做解析）",
            Json.integralRejectReason(new JsonPrimitive("3")));
    }

    /** {@code array}/{@code object} 形态同样拒绝（类型不符，而不是「取默认值」）。 */
    @Test
    public void rejectsArrayAndObjectShapes() {
        for (com.google.gson.JsonElement e : new com.google.gson.JsonElement[] { new JsonArray(), new JsonObject() }) {
            try {
                Json.strictIntElement(e, "p");
                fail("必须拒绝 " + e);
            } catch (CpException ex) {
                assertEquals(ErrorCodes.VALID_PARAM, ex.code());
            }
        }
    }

    /** {@code long} 通道同口径：{@code 1.5} 不放行，{@code 3.0} 放行。 */
    @Test
    public void longChannelUsesTheSameRule() {
        assertEquals(3L, Json.strictLong(obj("p", new JsonPrimitive(3.0d)), "p", -1L));
        assertEquals(9223372036854775807L, Json.strictLong(objRaw("p", "9223372036854775807"), "p", -1L));
        try {
            Json.strictLong(obj("p", new JsonPrimitive(1.5d)), "p", -1L);
            fail("long 通道不得接受 1.5");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
    }

    // ------------------------------------------------------------ 全动作面机械扫

    /**
     * 契约级纪律（#131 建议的「全局契约检查」）：<b>凡自述声明 {@code TYPE_INT} 的参数，取值必须严格</b>。
     *
     * <p>
     * 只扫声明，不猜实现：动作可以只读其中一部分参数，但「读的时候用什么口径」是共用的那一条路径
     * （{@link ActionContext#optInt}）。因此只要这条路径严格，全动作面就机械成立——
     * 本用例把它跑成事实而不是信念。
     */
    @Test
    public void everyDeclaredTypeIntParamIsStrictAtTheContextBoundary() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        assertTrue("动作目录为空，本扫法失去意义", registry.size() > 0);

        int checked = 0;
        for (String action : registry.names()) {
            ActionDescriptor d = registry.descriptor(action);
            for (ActionDescriptor.Param p : d.params()) {
                if (!ActionDescriptor.TYPE_INT.equals(p.type())) {
                    continue;
                }
                checked++;
                String field = action + "." + p.name();
                // 接受侧：精确整数与 3.0
                assertEquals(field + " 必须接受 3", 3, ctx(action, p.name(), new JsonPrimitive(3)).optInt(p.name(), 7777));
                assertEquals(
                    field + " 必须接受 3.0（值精确为整数）",
                    3,
                    ctx(action, p.name(), new JsonPrimitive(3.0d)).optInt(p.name(), 7777));
                // 缺省侧
                assertEquals(field + " 缺省必须回落到自述 default/内部默认", 7777, ctx(action, null, null).optInt(p.name(), 7777));
                // 拒绝侧
                Object[] bad = { Double.valueOf(1.5d), "3", Boolean.TRUE, Long.valueOf(3000000000L) };
                for (Object v : bad) {
                    try {
                        int got = ctx(action, p.name(), raw(v)).optInt(p.name(), 7777);
                        fail(field + " 必须拒绝 " + v + "（实际返回 " + got + "）");
                    } catch (CpException e) {
                        assertEquals(field + " 拒绝 " + v + " 的错误码", ErrorCodes.VALID_PARAM, e.code());
                        String c = Json.toJson(e.context());
                        assertTrue(field + " 的错误 context 必须点名该字段: " + c, c.contains("\"field\":\"" + p.name() + "\""));
                    }
                }
            }
        }
        assertTrue("一个 TYPE_INT 参数都没扫到 ⇒ 判据是空转的（契约 1.7 的 43 个动作里必有）", checked > 0);
    }

    /**
     * 反向护栏：声明为 {@code number} 的参数照旧接受小数。
     *
     * <p>
     * 这一条防的是「收 int 顺手把 number 也扣住」——那会把 {@code yaw}/{@code distance}/{@code health}
     * 这类合法调用判红，属过度收紧。{@code number} 的实际读取路径是
     * {@link L0Session#optNumber(ActionContext, String, double)} / {@code PlayerSession.optNumberPublic}。
     */
    @Test
    public void declaredNumberParamsStillAcceptFractions() {
        assertEquals(
            1.5d,
            L0Session.optNumber(ctx("scene.player.pose", "yaw", new JsonPrimitive(1.5d)), "yaw", 0.0d),
            0.0d);
        assertEquals(
            Double.valueOf(-22.5d),
            com.lightning.mod.client.controlplane.mc.player.PlayerSession
                .optNumberPublic(ctx("player.look", "pitch", new JsonPrimitive(-22.5d)), "pitch"));
    }

    // ------------------------------------------------------------ 两条既有反例（真调动作）

    /**
     * 反例一（#131 原文）：{@code read.run limit:1.5} 改前 exit 0 且回显 {@code 1}，现在必须显式报错。
     *
     * <p>
     * 走真实动作入口：{@link ReadRunAction#execute(ActionContext)} 第一件读参数的事就是 {@code limit}，
     * 因此这条断言覆盖的正是实机那条路径（无需世界，只需一个产物仓库）。
     */
    @Test
    public void readRunRejectsFractionalLimit() throws IOException {
        try {
            new ReadRunAction().execute(ctx("read.run", "limit", new JsonPrimitive(1.5d)));
            fail("read.run limit:1.5 必须 CP-VALID-002（改前是 exit 0 + 回显 1）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertNotNull(e.context());
            assertTrue(
                "必须逐字段说明是 limit 与它的形状",
                Json.toJson(e.context())
                    .contains("\"field\":\"limit\""));
        }
        // 对照组：整数 limit 照常走完（说明上面的报错不是「read.run 整体坏了」）
        JsonObject ok = new ReadRunAction().execute(ctx("read.run", "limit", new JsonPrimitive(2)));
        assertEquals("read.run", Json.optString(ok, "action", null));
    }

    /**
     * 反例二（#131 原文）：{@code capture.diag maxEvents/margin:1.5} 改前静默截断成 {@code 1}，现在必须报错，
     * 且<b>不得改动观察条件</b>（参数笔误不该顺带布防/撤防/清零——现场比读数贵）。
     */
    @Test
    public void captureDiagRejectsFractionalMarginBeforeTouchingSession() {
        CaptureDiagSession.resetForTesting();
        try {
            JsonArray at = new JsonArray();
            JsonArray cell = new JsonArray();
            cell.add(new JsonPrimitive(513));
            cell.add(new JsonPrimitive(4));
            cell.add(new JsonPrimitive(-647));
            at.add(cell);
            JsonObject params = new JsonObject();
            params.addProperty("dump", true);
            params.add("at", at);
            params.addProperty("margin", 1.5d);
            new CaptureDiagAction().execute(contextOf(params));
            fail("capture.diag margin:1.5 必须 CP-VALID-002（改前被截断成 1 后照常执行）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                "必须点名 margin",
                Json.toJson(e.context())
                    .contains("\"field\":\"margin\""));
        } finally {
            assertFalse("参数被拒时不得顺手布防", CaptureDiagSession.isArmed());
            assertFalse("参数被拒时不得留下「曾布防」痕迹", CaptureDiagSession.everArmed());
            CaptureDiagSession.resetForTesting();
        }
    }

    /** {@code read.capture maxEvents:1.5} 同样必须报错（#131 复核表里的第二行）。 */
    @Test
    public void readCaptureRejectsFractionalMaxEvents() {
        try {
            new com.lightning.mod.client.controlplane.mc.read.ReadCaptureAction()
                .execute(ctx("read.capture", "maxEvents", new JsonPrimitive(1.5d)));
            fail("read.capture maxEvents:1.5 必须 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                "必须点名 maxEvents",
                Json.toJson(e.context())
                    .contains("\"field\":\"maxEvents\""));
        }
    }

    // ------------------------------------------------------------ 工具

    private ActionContext ctx(String action, String name, JsonPrimitive value) {
        JsonObject p = new JsonObject();
        if (name != null) {
            p.add(name, value);
        }
        return contextOf(p);
    }

    /** 造一个带真实产物仓库的上下文（read.run 需要 store；其余动作忽略它）。 */
    private ActionContext contextOf(JsonObject params) {
        return new ActionContext(null, params, store(), null, null);
    }

    /** 单例产物仓库：{@link TemporaryFolder} 的 {@code newFolder} 同名只能建一次，故建一次复用。 */
    private ArtifactStore store() {
        if (sharedStore == null) {
            try {
                sharedStore = new ArtifactStore(
                    tmp.newFolder("runs")
                        .toPath(),
                    TimeSource.fixed("2026-10-07T12:00:00+08:00", "20261007-120000", 1000L),
                    null);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }
        return sharedStore;
    }

    private static JsonObject obj(String name, JsonPrimitive v) {
        JsonObject o = new JsonObject();
        o.add(name, v);
        return o;
    }

    /** 原样文本入 JSON（{@code 3e2} / 超大整数这类「只有文本才能准确表达」的值）。 */
    private static JsonObject objRaw(String name, String jsonText) {
        JsonObject o = new JsonObject();
        o.add(name, new com.google.gson.JsonParser().parse(jsonText));
        return o;
    }

    /** 按 Java 值的真实 JSON 类型构造原语（{@code "3"} 必须是字符串，不是数字）。 */
    private static JsonPrimitive raw(Object v) {
        if (v instanceof Boolean) {
            return new JsonPrimitive((Boolean) v);
        }
        if (v instanceof String) {
            return new JsonPrimitive((String) v);
        }
        return new JsonPrimitive((Number) v);
    }

    private static void addRaw(JsonObject o, String name, Object v) {
        o.add(name, raw(v));
    }
}
