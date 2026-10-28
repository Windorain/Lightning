package com.lightning.mod.client.controlplane.mc.input.observe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link InputScaleContext} 的上下文失效判定自检（零 MC 依赖）。
 *
 * <p>
 * 契约要求「缩放/窗口变化后<b>不得</b>沿用失效坐标而不说明」。本测试把三类真实变化各钉一条，
 * 并逐条证伪「只比 scaledWidth/Height 就够了」这一直觉——那正是最容易漏掉的一类：
 * <b>guiScale 与窗口同时变大</b>时缩放尺寸可以一字不变。
 */
public class InputScaleContextTest {

    /** 基准上下文（854×480、guiScale 2 ⇒ 427×240）。 */
    private static InputScaleContext base() {
        return new InputScaleContext(854, 480, 427, 240, 2, 2, 1.0d, 854, 480);
    }

    /** 自身比较恒「同上下文」。 */
    @Test
    public void identicalContextIsSame() {
        assertTrue(base().sameContext(base()));
        assertEquals(
            0,
            base().diff(base())
                .size());
    }

    /** 没有上一份快照 ⇒ 未变（单次快照无从谈失效）。 */
    @Test
    public void nullPreviousIsTreatedAsSame() {
        assertTrue(base().sameContext(null));
        assertEquals(
            0,
            base().diff(null)
                .size());
    }

    /** 窗口变大 + guiScale 从 2 变 3，而缩放尺寸恰好不变 ⇒ 仍必须判「已变」。 */
    @Test
    public void scaleSettingChangeIsDetectedEvenWhenScaledSizeUnchanged() {
        InputScaleContext before = new InputScaleContext(854, 480, 427, 240, 2, 2, 1.0d, 854, 480);
        // 1281/3 = 427、720/3 = 240 ⇒ scaledWidth/Height/scaleFactor 全同，只有 display/window/guiScale 变
        InputScaleContext after = new InputScaleContext(1281, 720, 427, 240, 3, 3, 1.0d, 1281, 720);
        assertFalse(after.sameContext(before));
        JsonArray diff = after.diff(before);
        assertTrue(diff.size() >= 4);
        assertTrue(hasField(diff, "displayWidth"));
        assertTrue(hasField(diff, "displayHeight"));
        assertTrue(hasField(diff, "guiScaleSetting"));
        assertTrue(hasField(diff, "windowWidth"));
        assertTrue(hasField(diff, "windowHeight"));
    }

    /** 像素比变化（DPI 切换）也必须判「已变」——double 比较要有容差但不能无限宽。 */
    @Test
    public void pixelScaleChangeIsDetected() {
        InputScaleContext a = new InputScaleContext(854, 480, 427, 240, 2, 2, 1.0d, 854, 480);
        InputScaleContext b = new InputScaleContext(854, 480, 427, 240, 2, 2, 1.25d, 854, 480);
        assertFalse(a.sameContext(b));
        assertTrue(hasField(b.diff(a), "pixelScale"));
        // 1e-12 级差在容差内（Display 读数的抖动不该判失效）
        InputScaleContext c = new InputScaleContext(854, 480, 427, 240, 2, 2, 1.0d + 1.0e-12d, 854, 480);
        assertTrue(a.sameContext(c));
    }

    /** {@code toJson()} 必须给出契约 §6 要求的全部坐标参数 + Y 翻转口径。 */
    @Test
    public void toJsonCarriesContractFields() {
        JsonObject o = base().toJson();
        assertTrue(o.has("space"));
        assertTrue(o.has("scaledWidth"));
        assertTrue(o.has("scaledHeight"));
        assertTrue(o.has("displayWidth"));
        assertTrue(o.has("displayHeight"));
        assertTrue(o.has("pixelScale"));
        assertTrue(o.has("scaleFactor"));
        assertTrue(o.has("guiScaleSetting"));
        assertTrue(o.has("windowWidth"));
        assertTrue(o.has("windowHeight"));
        assertEquals(
            "eventY = displayHeight - sdlY",
            o.get("yFlip")
                .getAsString());
        assertEquals(
            427,
            o.get("scaledWidth")
                .getAsInt());
    }

    /** diff 的每一项都给出「哪个字段、从什么、到什么」，而不是只说「变了」。 */
    @Test
    public void diffEntriesCarryFieldFromTo() {
        InputScaleContext before = new InputScaleContext(854, 480, 427, 240, 2, 2, 1.0d, 854, 480);
        InputScaleContext after = new InputScaleContext(1280, 720, 640, 360, 2, 2, 1.0d, 1280, 720);
        JsonArray diff = after.diff(before);
        for (int i = 0; i < diff.size(); i++) {
            JsonObject e = diff.get(i)
                .getAsJsonObject();
            assertTrue(e.has("field"));
            assertTrue(e.has("from"));
            assertTrue(e.has("to"));
        }
        JsonObject dw = entry(diff, "displayWidth");
        assertEquals(
            854,
            dw.get("from")
                .getAsInt());
        assertEquals(
            1280,
            dw.get("to")
                .getAsInt());
    }

    private static boolean hasField(JsonArray arr, String field) {
        return entry(arr, field) != null;
    }

    private static JsonObject entry(JsonArray arr, String field) {
        for (int i = 0; i < arr.size(); i++) {
            JsonObject o = arr.get(i)
                .getAsJsonObject();
            if (field.equals(
                o.get("field")
                    .getAsString())) {
                return o;
            }
        }
        return null;
    }
}
