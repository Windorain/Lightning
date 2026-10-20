package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

/**
 * {@link InputCoordinateMath}（#165 收敛后的<b>唯一</b>坐标算术实现点）的纯算术自检（零 MC/LWJGL 依赖）。
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
 * {@code Mouse.getY() = displayHeight - sdlY} 这条实测关系；请求的 GUI 行是 {@code 321}
 * （把事件行 158 折回 GUI 空间得到的行，契约 §6.2 示例写的 322 与它差 1，落在 ±1 容差内）。
 *
 * <p>
 * <b>#165 的教训也在这里钉死</b>：被删掉的观察侧实现把回读写成了「事件行减去一个常量」
 * （{@code guiY = mouseY - (displayHeight - scaledHeight)}），等价于把 LWJGL2 左下原点的
 * {@code Mouse.getY()} 当成左上原点的事件行。{@link #readbackAtAutoScaleTwo} 就是那条断言：
 * 同一个事件行 {@code 120}，正确口径给 GUI {@code 179}，镜像口径给 {@code -120}（GUI 域外）。
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
        assertEquals(158.0D, InputCoordinateMath.eventYFromSdlY(322, 480), 0.0D);
        assertEquals(322.0D, InputCoordinateMath.sdlYFromEventY(158, 480), 0.0D);
    }

    /** 翻转是 involution（写成 {@code sdlY - displayHeight} 会红）。 */
    @Test
    public void yFlipIsInvolution() {
        for (int h : new int[] { 240, 480, 720, 1080 }) {
            for (int y = 0; y <= h; y += 7) {
                assertEquals(
                    (double) y,
                    InputCoordinateMath.sdlYFromEventY(InputCoordinateMath.eventYFromSdlY(y, h), h),
                    0.0D);
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

    /**
     * P0 锚点：1:1 上下文里事件行 {@code (426,158)} ⇒ GUI {@code (426,321)}。
     *
     * <p>
     * {@code 158} 正是「注入 SDL 322」实读到的 {@code Mouse.getY()}；{@code 321} 是那次请求的 GUI 行。
     * 这条断言把「回读等于请求值」钉在<b>GUI 空间</b>：事件行 {@code 158} 与请求的 {@code 321}
     * 相差 163，绝不是同一套刻度（镜像实现给的是 {@code 158}，即把事件行原样当 GUI 行）。
     */
    @Test
    public void readbackAtOneToOneReproducesRequestedCoordinates() {
        int[] gui = InputCoordinateMath.scaledMouse(426, 158, 854, 480, DISPLAY_W, DISPLAY_H, 1.0D);
        assertNotNull(gui);
        assertEquals(426, gui[0]);
        assertEquals(321, gui[1]);
    }

    /**
     * 自动档（427×240）：事件行 {@code (200,120)} ⇒ GUI {@code (100,179)}。
     *
     * <p>
     * 事件行 {@code 120} 在 LWJGL2 口径里是「离屏幕下沿 120 像素」；{@code S=1} 时它对应的 SDL y 是
     * {@code 480-120=360}（屏幕靠下 2/3 处），故 GUI 行 {@code 240 - 120*240/480 - 1 = 179} 也在靠下
     * 位置——两者位置一致、刻度不同。镜像口径会给出 {@code -120}（GUI 域外），这正是 #165 收敛前
     * {@code input.state.coordinates.observedNowGui} 报错值的原因。
     */
    @Test
    public void readbackAtAutoScaleTwo() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        assertEquals(427, size[0]);
        assertEquals(240, size[1]);
        int[] gui = InputCoordinateMath.scaledMouse(200, 120, size[0], size[1], DISPLAY_W, DISPLAY_H, 1.0D);
        assertNotNull(gui);
        assertEquals(100, gui[0]);
        assertEquals(179, gui[1]);
    }

    /**
     * 原版投影在事件行 {@code == displayHeight}（SDL 最上一行）时给出 {@code -1}：
     * 本类<b>照抄</b>这个口径（{@code EntityRenderer} 的 {@code -1} 是原版行为），不夹到 0。
     *
     * <p>
     * 它不会污染判据：投递的离散逆落在 {@code [displayHeight - displayHeight/scaledHeight, displayHeight-1]}，
     * 到不了 {@code displayHeight}（见 {@link #deliveredEventRowIsMinimumErrorInverse}）。把它夹成 0
     * 反而会让「回读 -1」这种真实读数被伪装成「第 0 行」。
     */
    @Test
    public void topEdgeReadbackStaysMinusOneLikeVanilla() {
        assertEquals(-1, InputCoordinateMath.readbackGuiY(480, 480, 480, 1.0D));
        assertEquals(0, InputCoordinateMath.readbackGuiY(479, 480, 480, 1.0D));
    }

    /** 显示尺寸非正 ⇒ 返回 {@code null}（不许用 0 冒充「就在原点」）。 */
    @Test
    public void scaledMouseRefusesWhenDisplayInvalid() {
        assertNull(InputCoordinateMath.scaledMouse(10, 10, 854, 480, 0, 480, 1.0D));
        assertNull(InputCoordinateMath.scaledMouse(10, 10, 854, 480, 854, 0, 1.0D));
    }

    /** {@link InputCoordinateMath#readbackGuiY} 必须与 {@link InputCoordinateMath#scaledMouse} 同源。 */
    @Test
    public void readbackGuiYMatchesScaledMouse() {
        for (int eventY = 0; eventY <= 480; eventY += 13) {
            assertEquals(
                InputCoordinateMath.scaledMouse(0, eventY, 1, 240, 1, 480, 1.0D)[1],
                InputCoordinateMath.readbackGuiY(eventY, 240, 480, 1.0D));
        }
    }

    /** 像素密度非正按 1 处理（唯一归一化点在 {@link InputCoordinateMath#effectivePixelScale}）。 */
    @Test
    public void nonPositivePixelScaleFallsBackToOne() {
        assertEquals(1.0D, InputCoordinateMath.effectivePixelScale(0.0D), 0.0D);
        assertEquals(1.0D, InputCoordinateMath.effectivePixelScale(-2.0D), 0.0D);
        assertEquals(1.25D, InputCoordinateMath.effectivePixelScale(1.25D), 0.0D);
        // 分母被归一化 ⇒ 不产生 Infinity/NaN
        assertEquals(158.0D, InputCoordinateMath.eventYFromFramebuffer(158, 0.0D), 0.0D);
    }

    // ------------------------------------------------------------ 投递（GUI → 事件行 → SDL）与往返

    /**
     * 1:1（P0 那组数）：请求 GUI {@code (426,321)} ⇒ framebuffer {@code 158} ⇒ SDL {@code (426,322)}
     * ⇒ 事件行 {@code 158}；回读 {@code (426,321)} 精确等于请求值，自校准为真。
     */
    @Test
    public void guiToSdlRoundTripAtOneToOne() {
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(426, 321, 854, 480, DISPLAY_W, DISPLAY_H, 1.0D, 426, 158);
        assertNotNull(p);
        assertEquals(426, p.eventX);
        assertEquals(158, p.eventY);
        assertEquals(426, p.sdlX);
        assertEquals(322, p.sdlY);
        assertEquals(426, p.readbackGuiX);
        assertEquals(321, p.readbackGuiY);
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
    }

    /**
     * 自动档（427×240）：请求 GUI {@code (100,60)} 的换算链。
     *
     * <p>
     * {@code fbY = round(480 - 61*480/240) = 358}（事件行）⇒ {@code sdlY = 480-358 = 122}；
     * 回读 {@code guiY = 240 - 358*240/480 - 1 = 60} 精确等于请求值。这是「{@code h>s} 时同一 GUI 行
     * 覆盖 {@code h/s=2} 个事件行」的实证：事件行 {@code 358/359} 都落回 GUI 行 60。
     */
    @Test
    public void guiToSdlRoundTripAtAutoScaleTwo() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        assertEquals(427, size[0]);
        assertEquals(240, size[1]);
        InputCoordinateMath.Projection p = InputCoordinateMath
            .projectAgainstReadback(100, 60, size[0], size[1], DISPLAY_W, DISPLAY_H, 1.0D, 200, 358);
        assertNotNull(p);
        assertEquals(200, p.eventX);
        assertEquals(358, p.eventY);
        assertEquals(122, p.sdlY);
        assertEquals(60, InputCoordinateMath.readbackGuiY(p.eventY, size[1], DISPLAY_H, 1.0D));
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
    }

    /** 换算被拒（缩放/显示尺寸非正）⇒ {@code null}，而不是编一组坐标。 */
    @Test
    public void guiToSdlRefusesWhenScaledInvalid() {
        assertNull(InputCoordinateMath.sdlFromGui(10, 10, 0, 240, DISPLAY_W, DISPLAY_H, 1.0D));
        assertNull(InputCoordinateMath.sdlFromGui(10, 10, 427, 0, DISPLAY_W, DISPLAY_H, 1.0D));
        assertNull(InputCoordinateMath.sdlFromGui(10, 10, 427, 240, 0, DISPLAY_H, 1.0D));
        assertNull(InputCoordinateMath.project(1, 2, 0, 0, DISPLAY_W, DISPLAY_H, 1.0D));
    }

    /**
     * 往返一致性是<b>全域</b>性质：逐行遍历 scaledHeight，判据取契约 §2.4 第 4 条本身（±1）。
     *
     * <p>
     * 不要求逐行精确相等：回读式子含不可消除的离散偏置（{@code eventY=displayHeight} 时回读
     * {@code -1}），且 {@code h/s} 有余数时行宽不等 ⇒ 恒等映射在数学上不存在。
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
     * 投递用的离散逆必须取<b>最小误差</b>行：若存在更接近的行而没被选到，判失败。
     *
     * <p>
     * 这条比 ±1 更严，用来挡住「逆映射写得比容差还松」的退化解法（例如恒返回 0 也能过部分行的
     * ±1，但会在全域大面积失败）。收敛后这个逆是<b>闭式</b>的（{@code framebufferY} 就是
     * {@code guiY → 事件行} 的逆，不再需要原来的「±2 窗口逐行打分」搜索）。
     */
    @Test
    public void deliveredEventRowIsMinimumErrorInverse() {
        int[] size = InputCoordinateMath.scaledSize(DISPLAY_W, DISPLAY_H, 0);
        for (int guiY = 0; guiY < size[1]; guiY++) {
            int chosen = InputCoordinateMath.eventYFromGuiY(guiY, size[1], DISPLAY_H, 1.0D);
            int chosenError = Math.abs(InputCoordinateMath.readbackGuiY(chosen, size[1], DISPLAY_H, 1.0D) - guiY);
            for (int candidate = 0; candidate <= DISPLAY_H; candidate++) {
                int error = Math.abs(InputCoordinateMath.readbackGuiY(candidate, size[1], DISPLAY_H, 1.0D) - guiY);
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

    /**
     * 逐行核对：{@code guiY → 事件行 → 回读} 必须落在 {@code guiY} ±1。
     *
     * <p>
     * {@code scaledHeight <= displayHeight} 时进一步断言<b>精确</b>相等：事件行取的是实数逆的
     * 四舍五入，而回读对事件行的斜率是 {@code scaledHeight/displayHeight ≤ 1}，故回读误差
     * {@code ≤ 0.5} —— 四舍五入回来必然还是同一行。这条比契约的 ±1 更严，作为回归锁更有价值。
     */
    private static void assertRoundTripForEveryRow(int displayWidth, int displayHeight, int guiScale, int guiX) {
        int[] size = InputCoordinateMath.scaledSize(displayWidth, displayHeight, guiScale);
        for (int guiY = 0; guiY < size[1]; guiY++) {
            int eventY = InputCoordinateMath.eventYFromGuiY(guiY, size[1], displayHeight, 1.0D);
            int readback = InputCoordinateMath.readbackGuiY(eventY, size[1], displayHeight, 1.0D);
            if (Math.abs(readback - guiY) > 1) {
                fail(
                    "往返超出 ±1：display=" + displayWidth
                        + "x"
                        + displayHeight
                        + " scale="
                        + size[2]
                        + " guiY="
                        + guiY
                        + " ⇒ eventY="
                        + eventY
                        + " 回读="
                        + readback);
            }
            if (size[1] <= displayHeight) {
                assertEquals(
                    "display=" + displayWidth + "x" + displayHeight + " scale=" + size[2] + " guiY=" + guiY,
                    guiY,
                    readback);
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
            .projectAgainstReadback(426, 321, 854, 480, DISPLAY_W, DISPLAY_H, 1.0D, 426, 158);
        String json = p.toJson()
            .toString();
        assertTrue(json.contains("\"space\":\"gui-scaled\""));
        assertTrue(json.contains("\"space\":\"sdl-window\""));
        assertTrue(json.contains("\"space\":\"event-queue\""));
        assertTrue(json.contains("eventY = displayHeight - sdlY"));
        assertTrue(json.contains("readback"));
        assertEquals(Boolean.TRUE, p.selfCalibrated(1));
        // eventSpaceMatches 比的是「投影出的事件行」与「实读事件行」——同空间，故为真；
        // 它<b>不</b>表示「事件行 == 请求的 GUI 行」（158 vs 321），判据空间由 selfCalibratedSpace 写明
        assertEquals(Boolean.TRUE, p.eventSpaceMatches(1));
        assertTrue("事件行与请求的 GUI 行不是同一个数", p.eventY != p.guiY);
        assertEquals(
            "gui-scaled",
            p.toJson()
                .get("selfCalibratedSpace")
                .getAsString());
    }

    /** 没有回读时自校准必须 {@code null}（不可判），不是 {@code false}（实测不符）。 */
    @Test
    public void selfCalibrationIsNullWithoutReadback() {
        InputCoordinateMath.Projection p = InputCoordinateMath.project(426, 321, 854, 480, DISPLAY_W, DISPLAY_H, 1.0D);
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
            .projectAgainstReadback(426, 321, 854, 480, DISPLAY_W, DISPLAY_H, 1.0D, 100, 100);
        assertEquals(Boolean.FALSE, p.selfCalibrated(1));
    }
}
