package com.lightning.mod.client.controlplane.mc.capture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;

/**
 * {@code gui} 参数的**生产形态**回归锁（Gitea #165 实机验收 W7b 擒获的真缺陷）。
 *
 * <h2>它锁的是什么（为什么原测试全绿却功能不可用）</h2>
 * {@code ShotMultiAction} 传入的是 {@code Json.get(params, "gui")} 的返回值——一个 gson
 * {@link JsonPrimitive}，**不是** {@code String}。原实现直接 {@code String.valueOf(raw)}，
 * 对 {@code JsonPrimitive("screen")} 得到的是它的 <b>JSON 表示</b> {@code "\"screen\""}（带引号）
 * ⇒ 永远落在取值域外 ⇒ <b>{@code gui:"screen"} 从来就不可能被接受</b>。
 *
 * <p>
 * 原测试只喂 {@code String}（{@code resolveGuiMode("screen")}），因此**全绿**——这正是
 * 「测试绿但能力不可用」的形态，只有实机验收判据（W7b：带 {@code gui:screen} 的 {@code shot.multi}）
 * 才照得出来。本测试把**生产形态**钉死：任何后续改动若再退化成"只认 String"，这条就红。
 *
 * <p>
 * 另一半是**不许静默强转**：数字/布尔标量、对象、数组都必须显式 {@code CP-VALID-002}
 * （{@code contract.md} §2.1「类型即判据，不做隐式转换」）。
 */
public class ShotGuiParamTest {

    // ------------------------------------------------------------ 生产形态（本轮修复的本体）

    /** <b>核心断言</b>：{@code JsonPrimitive("screen")}（生产路径的真实形态）必须被接受。 */
    @Test
    public void jsonPrimitiveScreenIsAcceptedLikeAProductionCall() {
        assertEquals(ShotExecutor.GUI_SCREEN, ShotExecutor.resolveGuiMode(new JsonPrimitive("screen")));
    }

    /** 同上的 {@code none}，以及前后空白应被归一。 */
    @Test
    public void jsonPrimitiveNoneAndWhitespaceAreNormalised() {
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(new JsonPrimitive("none")));
        assertEquals(ShotExecutor.GUI_SCREEN, ShotExecutor.resolveGuiMode(new JsonPrimitive("  screen  ")));
    }

    /** {@link JsonNull}（JSON 里显式写 {@code null}）与"不传"同义 ⇒ 默认 {@code none}。 */
    @Test
    public void jsonNullMeansDefault() {
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(JsonNull.INSTANCE));
    }

    // ------------------------------------------------------------ 不许静默强转

    /** 数字/布尔标量不得被强转成字符串（本仓禁止静默强转）。 */
    @Test
    public void nonStringPrimitivesAreRejectedNotCoerced() {
        assertRejected(new JsonPrimitive(Integer.valueOf(3)));
        assertRejected(new JsonPrimitive(Boolean.TRUE));
    }

    /** 对象/数组同样显式拒绝（不是标量就无从归一）。 */
    @Test
    public void containersAreRejected() {
        assertRejected(new JsonObject());
        assertRejected(new JsonArray());
    }

    /** 未知字符串取值仍然拒绝（原口径不变）。 */
    @Test
    public void unknownStringsAreRejected() {
        assertRejected(new JsonPrimitive("bogus"));
        assertRejected("bogus");
    }

    // ------------------------------------------------------------ 兼容形态（原测试喂的就是它）

    /** {@code String} 形态（旧调用方/单测）保持可用；缺省仍是 {@code none}。 */
    @Test
    public void plainStringFormStillWorks() {
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(null));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode(""));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode("   "));
        assertEquals(ShotExecutor.GUI_NONE, ShotExecutor.resolveGuiMode("none"));
        assertEquals(ShotExecutor.GUI_SCREEN, ShotExecutor.resolveGuiMode("screen"));
    }

    private static void assertRejected(Object raw) {
        try {
            String got = ShotExecutor.resolveGuiMode(raw);
            fail("必须拒绝 " + raw + "（实际返回 " + got + "）");
        } catch (CpException e) {
            assertEquals("取值域外/类型不符一律 CP-VALID-002", ErrorCodes.VALID_PARAM, e.code());
            assertEquals(
                "错误上下文必须点名 gui 字段",
                "gui",
                e.context()
                    .getAsJsonArray("fields")
                    .get(0)
                    .getAsJsonObject()
                    .get("field")
                    .getAsString());
        }
    }
}
