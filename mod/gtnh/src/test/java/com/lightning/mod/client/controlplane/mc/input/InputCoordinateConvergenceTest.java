package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * <b>坐标算术的交叉核对</b>（Gitea #165）：证明「同一份换算只有一处实现」这件事在<b>数值上</b>成立，
 * 并把「事件行空间与 GUI 行空间不是同一套刻度」写成显式断言。
 *
 * <h2>为什么要有这个文件</h2>
 * #165 之前，同一套 Y 翻转 + 缩放换算有<b>两处独立实现</b>（{@link InputCoordinates} 与
 * {@code mc.input.observe.InputCoordinateMath}），而两处的回读口径是<b>镜像</b>的：观察侧把
 * {@code Mouse.getY()}（LWJGL2 左下原点）当成了左上原点的事件行。结果是「投递侧判据」与
 * 「观察侧读数」长期对不上，且两边各自的单测都绿（自洽不能代替真值）。
 * 收敛后 {@link InputCoordinates} 只持有上下文并<b>全部委托</b>给 {@link InputCoordinateMath}；
 * 本测试在网格上逐点比对两者的对外方法——任何人若把算术再塞回 {@code InputCoordinates}（哪怕只是
 * 一次「顺手重写」），这里立刻变红。
 *
 * <h2>网格覆盖</h2>
 * <ul>
 * <li>显示尺寸：854×480、1280×720、1920×1080、2560×1440、1024×768、800×600、640×480；</li>
 * <li>{@code guiScale ∈ {0(自动), 1, 2, 3}}；</li>
 * <li>像素密度 {@code S ∈ {1.0, 1.25, 2.0}}（HiDPI 下的口径未实机校准，但「两处实现必须同值」与
 * 实机与否无关）；</li>
 * <li>每条组合上的若干 {@code (x,y)}：四角/中心/末行/非整除点（末行与非整除点最容易暴露取整分歧）。</li>
 * </ul>
 *
 * <h2>显式断言：两个空间<b>不</b>许被合并成「相等」</h2>
 * <ol>
 * <li>{@code eventY != guiY}：事件行（{@code Mouse.getY()} 值域）与 GUI 行<b>永远不是同一个索引</b>
 * （实测与推导都如此：{@code eventY = displayHeight - sdlY}，而 GUI 行是左上原点的行号）；</li>
 * <li>「回读等于请求值」只在 <b>GUI 空间</b>成立：{@code readbackGuiY(eventYFromGuiY(row)) == row}
 * （本网格上还是<b>精确</b>相等，不只是 ±1）；</li>
 * <li>{@code h == s}（1:1）时相邻 GUI 行的事件行恰好<b>差 1 格</b>；{@code h > s} 时相邻 GUI 行
 * 差 {@code h/s ≥ 2} 格（同一 GUI 行覆盖多个事件行）——这就是「差一格」的可机读形态。</li>
 * </ol>
 */
public class InputCoordinateConvergenceTest {

    /** 显示尺寸网格（含 P0 实机的 854×480）。 */
    private static final int[][] DISPLAYS = { { 854, 480 }, { 1280, 720 }, { 1920, 1080 }, { 2560, 1440 },
        { 1024, 768 }, { 800, 600 }, { 640, 480 } };

    /** GUI Scale 网格：0 = 自动。 */
    private static final int[] GUI_SCALES = { 0, 1, 2, 3 };

    /** 像素密度网格（1.0 = 未缩放；1.25/2.0 = HiDPI 口径）。 */
    private static final double[] PIXEL_SCALES = { 1.0D, 1.25D, 2.0D };

    // ------------------------------------------------------------ 交叉核对

    /**
     * 网格上逐点核对：{@link InputCoordinates} 的每一个对外换算方法都与
     * {@link InputCoordinateMath} 的对应方法<b>同值</b>，且都等于「坐标定律」本身逐式展开的结果。
     *
     * <p>
     * 定律（P0 实机定案，见 {@link InputCoordinateMath} 类注释）：
     * {@code fbX = round(guiX*dw/sw)}、{@code fbY = round(dh-(guiY+1)*dh/sh)}、
     * {@code injectX = fbX/S}、{@code injectY = dh - fbY/S}、
     * {@code eventX = injectX}、{@code eventY = dh - injectY}。
     */
    @Test
    public void everyCoordinatesMethodMatchesTheSingleImplementation() {
        int checked = 0;
        for (int[] display : DISPLAYS) {
            int dw = display[0];
            int dh = display[1];
            for (int guiScale : GUI_SCALES) {
                int[] size = InputCoordinateMath.scaledSize(dw, dh, guiScale);
                int sw = size[0];
                int sh = size[1];
                for (double s : PIXEL_SCALES) {
                    InputCoordinates c = InputCoordinates.of(sw, sh, dw, dh, s, "cross-check", "cross-check");
                    assertTrue(c.usable());
                    for (double[] p : points(sw, sh)) {
                        double x = p[0];
                        double y = p[1];
                        int fbX = InputCoordinateMath.framebufferX(x, sw, dw);
                        int fbY = InputCoordinateMath.framebufferY(y, sh, dh);

                        // 1) 两处实现对同一入参给出同一结果（委托后仍逐方法核对：防止有人「顺手重写」回去）
                        assertEquals(InputCoordinateMath.framebufferX(x, sw, dw), c.framebufferX(x));
                        assertEquals(InputCoordinateMath.framebufferY(y, sh, dh), c.framebufferY(y));
                        assertEquals(InputCoordinateMath.sdlXFromFramebuffer(fbX, s), c.injectX(x), 0.0D);
                        assertEquals(InputCoordinateMath.sdlYFromFramebuffer(fbY, dh, s), c.injectY(y), 0.0D);
                        assertEquals(InputCoordinateMath.eventXFromFramebuffer(fbX, s), c.expectedEventX(x), 0.0D);
                        assertEquals(InputCoordinateMath.eventYFromFramebuffer(fbY, s), c.expectedEventY(y), 0.0D);
                        assertEquals(InputCoordinateMath.guiXFromEventX(fbX, sw, dw, s), c.guiXFromMouse(fbX), 0.0D);
                        assertEquals(InputCoordinateMath.guiYFromEventY(fbY, sh, dh, s), c.guiYFromMouse(fbY), 0.0D);

                        // 2) 两处实现都等于「定律逐式展开」的结果（防「一起写错」）
                        int lawFbX = (int) Math.round(x * (double) dw / (double) sw);
                        int lawFbY = (int) Math.round((double) dh - (y + 1.0D) * (double) dh / (double) sh);
                        assertEquals(lawFbX, fbX);
                        assertEquals(lawFbY, fbY);
                        double lawInjectX = (double) lawFbX / s;
                        double lawInjectY = (double) dh - (double) lawFbY / s;
                        double lawEventY = (double) lawFbY / s;
                        assertEquals(lawInjectX, c.injectX(x), 0.0D);
                        assertEquals(lawInjectY, c.injectY(y), 0.0D);
                        assertEquals(lawInjectX, c.expectedEventX(x), 0.0D);
                        assertEquals(lawEventY, c.expectedEventY(y), 0.0D);
                        // 定律的两条关系式：eventX == injectX 逐位成立；eventY == displayHeight - injectY
                        // 只能到浮点容差——把一对已经做过一次减法的值再减一次会有 1 ULP 级舍入，
                        // 这正是自校准判据用「±1 整数行」而不是「浮点相等」的原因。
                        assertEquals(c.injectX(x), c.expectedEventX(x), 0.0D);
                        assertEquals(
                            "eventY = displayHeight - injectY（浮点意义）",
                            lawEventY,
                            (double) dh - c.injectY(y),
                            1.0e-9D);
                        checked++;
                    }
                }
            }
        }
        assertTrue("网格点太少（实跑 " + checked + " 点），覆盖不足", checked >= 600);
    }

    /** 事件行回读：整数口径与实数口径同值（同一份算术，不许两套取整）。 */
    @Test
    public void integerReadbackMatchesRealValuedReadback() {
        for (int[] display : DISPLAYS) {
            int dw = display[0];
            int dh = display[1];
            for (int guiScale : GUI_SCALES) {
                int[] size = InputCoordinateMath.scaledSize(dw, dh, guiScale);
                for (int eventY = 0; eventY <= dh; eventY += 5) {
                    assertEquals(
                        (int) Math.round(InputCoordinateMath.guiYFromEventY(eventY, size[1], dh, 1.0D)),
                        InputCoordinateMath.readbackGuiY(eventY, size[1], dh, 1.0D));
                    assertEquals(
                        (int) Math.round(InputCoordinateMath.guiXFromEventX(eventY, size[0], dw, 1.0D)),
                        InputCoordinateMath.readbackGuiX(eventY, size[0], dw, 1.0D));
                }
            }
        }
    }

    // ------------------------------------------------------------ 显式断言：两个空间不相等

    /**
     * 事件行与 GUI 行<b>不是同一个索引</b>，且「回读等于请求值」只在 GUI 空间成立。
     *
     * <p>
     * 逐 GUI 行断言三件事：{@code readbackGuiY(eventYFromGuiY(row)) == row}（GUI 空间精确成立）、
     * {@code eventY != row}（事件行空间恒不相等）、以及相邻 GUI 行的事件行间距 = {@code dh/sh}
     * （{@code h == s} 时恰好 1 格；{@code h > s} 时 ≥ 2 格 ⇒ 事件行轴更细，同一 GUI 行覆盖多个
     * 事件行）。这三条合起来就是「差一格」的机读形态，谁把它们合并成「相等」，这里就红。
     */
    @Test
    public void eventRowSpaceAndGuiRowSpaceAreNotTheSameAxis() {
        for (int[] display : DISPLAYS) {
            int dw = display[0];
            int dh = display[1];
            for (int guiScale : GUI_SCALES) {
                int[] size = InputCoordinateMath.scaledSize(dw, dh, guiScale);
                int sh = size[1];
                String ctx = "display=" + dw + "x" + dh + " scale=" + size[2] + " scaled=" + size[0] + "x" + sh;
                int lastEventY = -1;
                int minGap = Integer.MAX_VALUE;
                int maxGap = 0;
                for (int guiY = 0; guiY < sh; guiY++) {
                    int eventY = InputCoordinateMath.eventYFromGuiY(guiY, sh, dh, 1.0D);
                    // (1) GUI 空间：回读精确等于请求行（契约判据所在的空间）
                    assertEquals(ctx + " guiY=" + guiY, guiY, InputCoordinateMath.readbackGuiY(eventY, sh, dh, 1.0D));
                    // (2) 事件行空间：恒不相等（两个空间的索引不是同一个量）
                    assertNotEquals(ctx + " guiY=" + guiY + "：事件行不得与 GUI 行合并", guiY, eventY);
                    if (lastEventY >= 0) {
                        int gap = Math.abs(eventY - lastEventY);
                        minGap = Math.min(minGap, gap);
                        maxGap = Math.max(maxGap, gap);
                    }
                    lastEventY = eventY;
                }
                assertTrue(ctx + "：相邻 GUI 行的事件行间距必须 ≥ 1", minGap >= 1);
                if (sh == dh) {
                    assertEquals(ctx + "：1:1 时相邻 GUI 行的事件行恰好差 1 格", 1, maxGap);
                } else {
                    assertTrue(ctx + "：h > s 时事件行轴更细（同一 GUI 行覆盖 ≥2 个事件行），实测最大间距 " + maxGap, maxGap >= 2);
                }
            }
        }
    }

    /** P0 实机锚点在<a>收敛后</a>仍然逐式成立（854×480、guiScale 1、S=1）。 */
    @Test
    public void p0AnchorHoldsOnTheSingleImplementation() {
        InputCoordinates c = InputCoordinates.of(854, 480, 854, 480, 1.0D, "currentScreen", "getPixelScaleFactor");
        // 请求 GUI (426,321) ⇒ framebuffer 158 ⇒ SDL 322 ⇒ 事件行 158（实测：注入 SDL(426,322) 读回 (426,158)）
        assertEquals(158, c.framebufferY(321.0D));
        assertEquals(322.0D, c.injectY(321.0D), 0.0D);
        assertEquals(158.0D, c.expectedEventY(321.0D), 0.0D);
        assertEquals(158, InputCoordinateMath.eventYFromGuiY(321, 480, 480, 1.0D));
        assertEquals(322, InputCoordinateMath.sdlFromGui(426, 321, 854, 480, 854, 480, 1.0D)[1]);
        // 回读：实读事件 (426,158) ⇒ GUI 321（与请求一致，落在 ±1 内）
        assertEquals(321.0D, c.guiYFromMouse(158.0D), 0.0D);
        assertTrue(InputCoordinates.withinOnePixel(c.guiYFromMouse(158.0D), 321.0D));
        // framebufferX/Y 与 eventX/Y 是 X 轴无翻转、Y 轴有翻转的两条链，别把 X 也翻一次
        assertEquals(426.0D, c.injectX(426.0D), 0.0D);
        assertEquals(426.0D, c.expectedEventX(426.0D), 0.0D);
    }

    /** 覆盖点：四角、中心、末行、非整除点（取整分歧最容易出现在这些位置）。 */
    private static double[][] points(int sw, int sh) {
        return new double[][] { { 0.0D, 0.0D }, { 0.0D, sh - 1.0D }, { sw - 1.0D, 0.0D }, { sw - 1.0D, sh - 1.0D },
            { sw / 2.0D, sh / 2.0D }, { 1.0D, 2.0D }, { sw / 3.0D, sh / 3.0D }, { sw - 2.0D, sh - 3.0D } };
    }
}
