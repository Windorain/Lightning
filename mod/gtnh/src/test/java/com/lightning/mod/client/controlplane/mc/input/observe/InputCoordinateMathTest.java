package com.lightning.mod.client.controlplane.mc.input.observe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

/**
 * {@link InputCoordinateMath} 的纯算术自检（零 MC/LWJGL 依赖）。
 *
 * <h2>为什么值得单独钉死</h2>
 * 坐标换算是「注入没生效」类事故里最难查的一环：三套口径（GUI 缩放 / SDL 窗口 / 事件行）之间是
 * 一次 Y 翻转加两次缩放，任一处写错都表现为「点了但没反应」，而事件确实投递成功了
 * （{@code delivered} 全绿）。契约 §2.4 第 4 条把成功定义收窄成「回读等于请求值（±1）」，
 * 本测试就是那条判据的算术底座。
 *
 * <p>
 * 头号锚点用 P0 实机定案的<b>事故输入本身</b>：注入 SDL {@code (426,322)} ⇒ 实读
 * {@code (426,158)}（{@code paths-lwjgl3ify.md}），而 {@code 480 - 322 = 158} 正是
 * {@code Mouse.getY() = displayHeight - sdlY} 这条实测关系。
 */
public class InputCoordinateMathTest {

    /** P0 实机的显示尺寸（{@code Display=854x480}）。 */
    private static final int DISPLAY_W = 854;

    /** 同上。 */
    private static final int DISPLAY_H = 480;

    // ------------------------------------------------------------ 实测关系锚点

    /** P0：{@code sdlY=322}、{@code h=480} ⇒ 事件行 {@code 158}，且可逆。 */
    @Test
    public void p0IncidentSdlToEventYFlip() {
        assertEquals(158, InputCoordinateMath.eventYFromSdlY(322, 480));
        assertEquals(322, InputCoordinateMath.sdlYFromEventY(158, 480));
    }

    /** 翻转是 involution（写成 {@code sdlY - displayHeight} 会红）。 */
    @Test
    public void yFlipIsInvolution() {
        for (int h : new int[] { 240, 480, 720, 1080 }) {
            for (int y = 0; y <= h; y += 7) {
                assertEquals(y, InputCoordinateMath.sdlYFromEventY(InputCoordinateMath.eventYFromSdlY(y, h), h));
            }
        }
    }

    // ------------------------------------------------------------ 缩放尺寸（对齐原版 ScaledResolution）

    /** 显式档位：854×480 + {@code guiScale=1} ⇒ 1:1。 */
    @Test
    public void explicitScaleOneAt854x480IsOneToOne() {
        int[] s = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 1);
        assertEquals(854, s[0]);
        assertEquals(480, s[1]);
        assertEquals(1, s[2]);
    }

    /**
     * 自动档（{@code guiScale=0}）：854×480 ⇒ 倍率 <b>2</b>（缩放尺寸 427×240）。
     *
     * <p>
     * 推导：{@code 854/2=427>=320} 且 {@code 480/2=240>=240} 成立 ⇒ 试 2；{@code 854/3=284<320}
     * 停 ⇒ 倍率 2（偶数，不触发「奇数退一档」）。把 854×480 当成 1:1 是最容易犯的换算错误，
     * 故与上一条测试并列钉死。
     */
    @Test
    public void autoScaleAt854x480IsTwo() {
        int[] s = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        assertEquals(427, s[0]);
        assertEquals(240, s[1]);
        assertEquals(2, s[2]);
    }

    /** 自动档：1920×1080 ⇒ 倍率 4（{@code 1920/4=480>=320}、{@code 1080/4=270>=240}）。 */
    @Test
    public void autoScaleAt1920x1080IsFour() {
        int[] s = InputCoordinateMath.scaledSize(1920, 1080, 0);
        assertEquals(4, s[2]);
        assertEquals(480, s[0]);
        assertEquals(270, s[1]);
    }

    /** 自动档倍率为奇数时退一档（原版行为）：1280×800 ⇒ 候选 3 ⇒ 退到 2。 */
    @Test
    public void autoScaleDropsOddFactor() {
        int[] s = InputCoordinateMath.scaledSize(1280, 800, 0);
        assertEquals(2, s[2]);
        assertEquals(640, s[0]);
        assertEquals(400, s[1]);
    }

    /** 显式档位直接采用（不参与 auto 循环），余数上取整。 */
    @Test
    public void explicitScaleUsesCeiling() {
        int[] s = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 3);
        assertEquals(3, s[2]);
        assertEquals(285, s[0]);
        assertEquals(160, s[1]);
    }

    /** 显示尺寸非正时不得除零：退回 1×1 且倍率 1。 */
    @Test
    public void nonPositiveDisplayDoesNotDivideByZero() {
        int[] s = InputCoordinateMath.scaledSize(0, -5, 0);
        assertEquals(1, s[0]);
        assertEquals(1, s[1]);
        assertEquals(1, s[2]);
    }

    // ------------------------------------------------------------ 回读（事件行 → GUI）

    /** 1:1、事件行 {@code (426,322)} ⇒ GUI {@code (426,322)}（P0 那组数读回来一模一样）。 */
    @Test
    public void readbackAtOneToOneReproducesRequestedCoordinates() {
        int[] gui = InputCoordinateMath.scaledMouse(426, 322, 854, 480, DISPLAY_W, DISPLAY_H);
        assertNotNull(gui);
        assertEquals(426, gui[0]);
        assertEquals(322, gui[1]);
    }

    /**
     * 自动档（427×240、{@code h-s = 240}）：事件行 {@code (200,120)} ⇒ GUI {@code (100,-120)}。
     *
     * <p>
     * 负值不是缺陷而是口径的必然结果：{@code Mouse.getY()} 的值域是 {@code [0,h]}，而 GUI 有效域只有
     * {@code [0,s-1] = [0,239]}；{@code getY() < h-s} 的像素在 GUI 里根本没有对应行。
     * 因此 {@code input.mouse op:move} 的请求侧必须先经 {@link InputCoordinateMath#clampToScale}
     * 夹取（本测试同时在 {@code clampToScale} 上钉死上界），回读侧则如实给出这个越界读数。
     */
    @Test
    public void readbackAtAutoScaleTwo() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        int[] gui = InputCoordinateMath.scaledMouse(200, 120, size[0], size[1], DISPLAY_W, DISPLAY_H);
        assertEquals(100, gui[0]);
        assertEquals(-120, gui[1]);
    }

    /** 显示尺寸非正 ⇒ 返回 {@code null}（不许用 0 冒充「就在原点」）。 */
    @Test
    public void scaledMouseRefusesWhenDisplayInvalid() {
        assertNull(InputCoordinateMath.scaledMouse(10, 10, 854, 480, 0, 480));
        assertNull(InputCoordinateMath.scaledMouse(10, 10, 854, 480, 854, 0));
    }

    /** {@link InputCoordinateMath#readbackGuiY} 必须与 {@link InputCoordinateMath#scaledMouse} 同源。 */
    @Test
    public void readbackGuiYMatchesScaledMouse() {
        for (int eventY = 0; eventY <= 480; eventY += 13) {
            assertEquals(
                InputCoordinateMath.scaledMouse(0, eventY, 1, 240, 1, 480)[1],
                InputCoordinateMath.readbackGuiY(eventY, 240, 480));
        }
    }

    // ------------------------------------------------------------ 投递（GUI → 事件行 → SDL）与往返

    /**
     * 1:1：请求 GUI {@code (426,322)} ⇒ 事件行 {@code (426,322)}、SDL {@code (426,158)}，
     * 回读精确等于请求值。
     */
    @Test
    public void guiToSdlRoundTripAtOneToOne() {
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(426, 322, 854, 480, DISPLAY_W, DISPLAY_H, 426, 322);
        assertNotNull(p);
        assertEquals(426, p.eventX);
        assertEquals(322, p.eventY);
        assertEquals(426, p.sdlX);
        assertEquals(480 - 322, p.sdlY);
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
    }

    /**
     * 自动档（427×240）：请求 GUI {@code (100,60)} 的换算链。
     *
     * <p>
     * {@code eventY = 300}（{@code h-s = 240} ⇒ {@code mouseY = 60+240}）⇒ {@code sdlY = 480-300 = 180}；
     * 回读 {@code guiY = 300 - 240 = 60} 精确等于请求值。这是「{@code h>s} 时同一 GUI 行覆盖多个
     * 像素行」的实证：只要落在容差内，契约 §2.4 第 4 条就判成功。
     */
    @Test
    public void guiToSdlRoundTripAtAutoScaleTwo() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        assertEquals(427, size[0]);
        assertEquals(240, size[1]);
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(100, 60, size[0], size[1], DISPLAY_W, DISPLAY_H, 200, 300);
        assertNotNull(p);
        assertEquals(200, p.eventX);
        assertEquals(300, p.eventY);
        assertEquals(180, p.sdlY);
        assertEquals(60, InputCoordinateMath.readbackGuiY(p.eventY, size[1], DISPLAY_H));
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
    }

    /** 换算被拒（缩放尺寸非正）⇒ {@code null}，而不是编一组坐标。 */
    @Test
    public void guiToSdlRefusesWhenScaledInvalid() {
        assertNull(InputCoordinateMath.sdlFromGui(10, 10, 0, 240, DISPLAY_W, DISPLAY_H));
        assertNull(InputCoordinateMath.sdlFromGui(10, 10, 427, 0, DISPLAY_W, DISPLAY_H));
        assertNull(InputCoordinateMath.project(1, 2, 0, 0, DISPLAY_W, DISPLAY_H));
    }

    /**
     * 往返一致性是<b>全域</b>性质：逐行遍历 scaledHeight，判据取契约 §2.4 第 4 条本身（±1）。
     *
     * <p>
     * 不要求逐行精确相等：回读式子含不可消除的离散偏置（{@code eventY=displayHeight} 时回读
     * {@code -1}），且 {@code h/s} 有余数时行宽 2 或 3 不等 ⇒ 恒等映射在数学上不存在。
     * 能证明的正是契约冻结的那条：全域都落在容差内。
     */
    @Test
    public void guiToSdlRoundTripHoldsForEveryGuiRow() {
        assertRoundTripForEveryRow(DISPLAY_W, DISPLAY_H, 0, 100);
    }

    /** 通用性：多种「显示尺寸 × 缩放档位」组合下全域往返成立（取整误差不得累积）。 */
    @Test
    public void guiToSdlRoundTripAcrossDisplayAndScaleCombinations() {
        int[][] combos = { { 854, 480, 0 }, { 854, 480, 1 }, { 854, 480, 2 }, { 854, 480, 3 }, { 1280, 720, 0 },
            { 1280, 720, 4 }, { 1920, 1080, 0 }, { 1920, 1080, 2 }, { 1920, 1080, 4 }, { 2560, 1440, 0 },
            { 1024, 768, 0 }, { 800, 600, 0 } };
        for (int[] combo : combos) {
            assertRoundTripForEveryRow(combo[0], combo[1], combo[2], 7);
        }
    }

    /**
     * 逆映射必须取<b>最小误差</b>行：若存在更接近的行而没被选到，判失败。
     *
     * <p>
     * 这条比 ±1 更严，用来挡住「逆映射写得比容差还松」的退化解法（例如恒返回 0 也能过部分行的
     * ±1，但会在全域大面积失败）。
     */
    @Test
    public void inversePicksMinimumErrorRow() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        for (int guiY = 0; guiY < size[1]; guiY++) {
            int chosen = InputCoordinateMath.eventYFromGuiY(guiY, size[1], DISPLAY_H);
            int chosenError = Math.abs(InputCoordinateMath.readbackGuiY(chosen, size[1], DISPLAY_H) - guiY);
            for (int candidate = 0; candidate <= DISPLAY_H; candidate++) {
                int error = Math.abs(InputCoordinateMath.readbackGuiY(candidate, size[1], DISPLAY_H) - guiY);
                if (error < chosenError) {
                    fail(
                        "guiY=" + guiY
                            + " 选到误差 "
                            + chosenError
                            + " 的 eventY="
                            + chosen
                            + "，"
                            + "而 eventY="
                            + candidate
                            + " 误差仅 "
                            + error);
                }
            }
        }
    }

    /** 逐行核对：{@code guiY → SDL → 事件行 → 回读} 必须落在 {@code guiY} ±1。 */
    private static void assertRoundTripForEveryRow(int displayWidth, int displayHeight, int guiScale, int guiX) {
        int[] size = InputCoordinateMath.scaledSize(displayWidth, displayHeight, guiScale);
        for (int guiY = 0; guiY < size[1]; guiY++) {
            int[] sdl = InputCoordinateMath.sdlFromGui(guiX, guiY, size[0], size[1], displayWidth, displayHeight);
            int eventY = InputCoordinateMath.eventYFromSdlY(sdl[1], displayHeight);
            int readback = InputCoordinateMath.readbackGuiY(eventY, size[1], displayHeight);
            if (Math.abs(readback - guiY) > 1) {
                fail(
                    "往返超出 ±1：display=" + displayWidth
                        + "x"
                        + displayHeight
                        + " scale="
                        + size[2]
                        + " guiY="
                        + guiY
                        + " ⇒ sdlY="
                        + sdl[1]
                        + " eventY="
                        + eventY
                        + " 回读="
                        + readback);
            }
        }
    }

    // ------------------------------------------------------------ 夹取与自校准判据

    /** GUI 轴夹取到 {@code [0, scaled-1]}。 */
    @Test
    public void clampToScaleClampsBothEnds() {
        assertEquals(0, InputCoordinateMath.clampToScale(-7, 427));
        assertEquals(426, InputCoordinateMath.clampToScale(427, 427));
        assertEquals(426, InputCoordinateMath.clampToScale(99999, 427));
        assertEquals(0, InputCoordinateMath.clampToScale(5, 0));
    }

    /**
     * 事件行轴的夹取上界是 {@code displayExtent}（不是 {@code -1}，也不是 GUI 轴的上界）。
     *
     * <p>
     * 混用会把坐标压到左上角附近——症状与「换算写错」完全一样，故两个方法必须分开断言。
     */
    @Test
    public void clampToDisplayUsesEventRowUpperBound() {
        assertEquals(0, InputCoordinateMath.clampToDisplay(-1, 480));
        assertEquals(480, InputCoordinateMath.clampToDisplay(480, 480));
        assertEquals(480, InputCoordinateMath.clampToDisplay(99999, 480));
        assertEquals(0, InputCoordinateMath.clampToDisplay(5, 0));
        // 与 GUI 轴不同：GUI 轴的上界是 extent-1
        assertEquals(479, InputCoordinateMath.clampToScale(480, 480));
    }

    /** 自校准判据：±1 容差内为真，差 2 为假（契约 §2.4 第 4 条的唯一成功定义）。 */
    @Test
    public void readbackToleranceIsOne() {
        assertTrue(InputCoordinateMath.readbackMatches(426, 322, 426, 322, 1));
        assertTrue(InputCoordinateMath.readbackMatches(426, 322, 427, 321, 1));
        assertFalse(InputCoordinateMath.readbackMatches(426, 322, 428, 322, 1));
        assertFalse(InputCoordinateMath.readbackMatches(426, 322, 426, 324, 1));
        assertTrue(InputCoordinateMath.readbackMatches(426, 322, 428, 322, 2));
    }

    // ------------------------------------------------------------ Projection 留痕

    /** {@code toJson()} 必须三套坐标一次给全，且口径写在字段里。 */
    @Test
    public void projectionJsonCarriesAllThreeSpaces() {
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(426, 322, 854, 480, DISPLAY_W, DISPLAY_H, 426, 322);
        String json = p.toJson()
            .toString();
        assertTrue(json.contains("\"space\":\"gui-scaled\""));
        assertTrue(json.contains("\"space\":\"sdl-window\""));
        assertTrue(json.contains("\"space\":\"event-queue\""));
        assertTrue(json.contains("eventY = displayHeight - sdlY"));
        assertTrue(json.contains("readback"));
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
    }

    /** 没有回读时自校准必须 {@code null}（不可判），不是 {@code false}（实测不符）。 */
    @Test
    public void selfCalibrationIsNullWithoutReadback() {
        InputCoordinateMath.Projection p = InputCoordinateMath.project(426, 322, 854, 480, DISPLAY_W, DISPLAY_H);
        assertNull(p.selfCalibrated(1));
        assertFalse(p.hasReadback);
        assertTrue(
            p.toJson()
                .get("selfCalibrated")
                .isJsonNull());
    }

    /** 回读与请求不符时自校准为 {@code false}（明确失败，不是「不可判」）。 */
    @Test
    public void selfCalibrationFalseOnMismatch() {
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(426, 322, 854, 480, DISPLAY_W, DISPLAY_H, 100, 100);
        assertEquals(Boolean.FALSE, p.selfCalibrated(1));
    }
}
