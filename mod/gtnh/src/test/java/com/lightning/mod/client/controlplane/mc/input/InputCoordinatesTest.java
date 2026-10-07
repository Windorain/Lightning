package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonObject;

/**
 * 坐标换算的纯函数边界（契约 §2.4 / §2.5 / §5.2）。
 *
 * <p>
 * 这一层必须离线钉死，因为它是「{@code move} 到底点到哪」的唯一判据，而实机上唯一的对照是
 * {@code move} 的 {@code readback} 自校准——换算公式错了，实机只会表现为「点空」，
 * 与「GUI 命中集时序不对」不可区分。
 *
 * <h2>P0 实机锚点（把实测数据变成回归锁）</h2>
 * 注入 SDL {@code (426,322)} ⇒ 实读事件 {@code (426,158)}（{@code displayHeight=480}、
 * {@code pixelScale=1.0}）。本测试把这条读数钉在
 * {@link #p0AnchorIsReproduced()}：它同时约束了 Y 翻转与 {@code -1} 偏移（对应请求 {@code guiY=321}，
 * 与契约示例写的 322 差 1，落在 §2.4 第 4 条容许的 ±1 内）。
 */
public class InputCoordinatesTest {

    /** P0 实测锚点：854x480 / GUI scale 1 / pixelScale 1。 */
    @Test
    public void p0AnchorIsReproduced() {
        InputCoordinates c = InputCoordinates.of(854, 480, 854, 480, 1.0D, "test", "test");
        // 请求 GUI (426,321) ⇒ framebuffer 158 ⇒ SDL 322 ⇒ 事件口径 158
        assertEquals(426, c.framebufferX(426.0D));
        assertEquals(158, c.framebufferY(321.0D));
        assertEquals(426.0D, c.injectX(426.0D), 0.0001D);
        assertEquals(322.0D, c.injectY(321.0D), 0.0001D);
        // 契约 §2.4 第 2 条的两条定案式
        assertEquals(c.injectX(426.0D), c.expectedEventX(426.0D), 0.0001D);
        assertEquals(158.0D, c.expectedEventY(321.0D), 0.0001D);
        // 回读：实读事件 (426,158) ⇒ 逆推回 GUI (426,321)
        assertEquals(426.0D, c.guiXFromMouse(426.0D), 0.0001D);
        assertEquals(321.0D, c.guiYFromMouse(158.0D), 0.0001D);
        assertTrue(InputCoordinates.withinOnePixel(c.guiYFromMouse(158.0D), 321.0D));
    }

    /** GUI scale 2（scaled = display/2）：往返必须精确，且 Y 翻转 + 缩放的复合关系正确。 */
    @Test
    public void guiScaleTwoRoundTrips() {
        InputCoordinates c = InputCoordinates.of(427, 240, 854, 480, 1.0D, "currentScreen", "test");
        assertEquals(200, c.framebufferX(100.0D));
        // fbY = 480 - (100+1) * 480/240 = 480 - 202 = 278
        assertEquals(278, c.framebufferY(100.0D));
        // SDL 窗口坐标（原点左下）= 480 - 278 = 202
        assertEquals(202.0D, c.injectY(100.0D), 0.0001D);
        // 事件口径 = (injectX, displayHeight - injectY)
        assertEquals(278.0D, c.expectedEventY(100.0D), 0.0001D);
        // 回读把事件口径折回 GUI 坐标
        assertEquals(100.0D, c.guiXFromMouse(200.0D), 0.0001D);
        assertEquals(100.0D, c.guiYFromMouse(278.0D), 0.0001D);
    }

    /**
     * HiDPI（pixelScale=2）：投递口径要除以像素密度，而回读要把观测值乘回 framebuffer 口径，
     * 否则往返会差一个 S 倍（这正是契约 §11.2 第 12 条「其它 GUI Scale / 分辨率下的换算需自校准」的落点）。
     */
    @Test
    public void hiDpiScaleIsAppliedBothWays() {
        InputCoordinates c = InputCoordinates.of(854, 480, 1708, 960, 2.0D, "currentScreen", "getPixelScaleFactor");
        assertEquals(200, c.framebufferX(100.0D));
        assertEquals(758, c.framebufferY(100.0D));
        assertEquals(100.0D, c.injectX(100.0D), 0.0001D);
        assertEquals(581.0D, c.injectY(100.0D), 0.0001D);
        assertEquals(100.0D, c.expectedEventX(100.0D), 0.0001D);
        assertEquals(379.0D, c.expectedEventY(100.0D), 0.0001D);
        assertEquals(100.0D, c.guiXFromMouse(100.0D), 0.0001D);
        assertEquals(100.0D, c.guiYFromMouse(379.0D), 0.0001D);
    }

    /** ±1 整数量化是 `move` 的唯一成功判据（§2.4 第 4 条）。 */
    @Test
    public void withinOnePixelBoundary() {
        assertTrue(InputCoordinates.withinOnePixel(100.0D, 100.0D));
        assertTrue(InputCoordinates.withinOnePixel(100.0D, 101.0D));
        assertTrue(InputCoordinates.withinOnePixel(100.0D, 99.0D));
        assertFalse(InputCoordinates.withinOnePixel(100.0D, 102.0D));
        assertFalse(InputCoordinates.withinOnePixel(100.0D, 98.0D));
    }

    /** 不可用态：换算**抛异常**而不是静默给 0（静默给 0 会变成「投递到左上角」的假成功）。 */
    @Test
    public void unavailableRefusesToConvert() {
        InputCoordinates c = InputCoordinates.unavailable("无显示尺寸");
        assertFalse(c.usable());
        try {
            c.framebufferX(1.0D);
            fail("不可用态必须拒绝换算");
        } catch (IllegalStateException expected) {
            assertTrue(
                expected.getMessage(),
                expected.getMessage()
                    .contains("不可用"));
        }
    }

    /** 非法像素密度回退到 1.0（并在来源里可见），尺寸为 0 时整体不可用。 */
    @Test
    public void degenerateInputsAreVisibleNotSilent() {
        InputCoordinates zeroScale = InputCoordinates.of(854, 480, 854, 480, 0.0D, "test", "assumed-1");
        assertTrue(zeroScale.usable());
        assertEquals(1.0D, zeroScale.pixelScale(), 0.0001D);
        InputCoordinates noScreen = InputCoordinates.of(0, 0, 854, 480, 1.0D, "unavailable", "test");
        assertFalse(noScreen.usable());
    }

    /** 回显（§5.2）：换算的**全部参数**必须在 JSON 里可见，调用方才能自校准。 */
    @Test
    public void jsonExposesEveryParameter() {
        InputCoordinates c = InputCoordinates.of(854, 480, 854, 480, 1.0D, "currentScreen", "getPixelScaleFactor");
        JsonObject o = c.toJson(false);
        assertEquals(
            854,
            o.get("scaledWidth")
                .getAsInt());
        assertEquals(
            480,
            o.get("scaledHeight")
                .getAsInt());
        assertEquals(
            854,
            o.get("displayWidth")
                .getAsInt());
        assertEquals(
            480,
            o.get("displayHeight")
                .getAsInt());
        assertEquals(
            1.0D,
            o.get("pixelScale")
                .getAsDouble(),
            0.0001D);
        assertEquals(
            InputCapabilities.Y_FLIP,
            o.get("yFlip")
                .getAsString());
        assertFalse(
            o.get("selfCalibrated")
                .getAsBoolean());
        assertTrue(
            o.get("formulas")
                .getAsString()
                .contains("sdlY=displayHeight-fbY/S"));
        assertEquals(
            "gui-scaled",
            InputCoordinates.requestedJson(1.0D, 2.0D)
                .get("space")
                .getAsString());
        assertEquals(
            "sdl-window",
            c.deliveredJson(1.0D, 2.0D)
                .get("space")
                .getAsString());
    }
}
