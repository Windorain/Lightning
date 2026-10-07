package com.lightning.mod.client.controlplane.mc.input;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 一次坐标换算的<b>上下文值对象</b>（契约 §2.4 / §5.2）：它只持有「这次换算用的是哪组参数」
 * 以及回显用的 JSON，全部算术都<b>委托</b>给 {@link InputCoordinateMath}。
 *
 * <h2>职责边界（#165 收敛后）</h2>
 * 本类<b>不再自己算任何换算</b>：{@code framebufferX/Y}、{@code injectX/Y}、
 * {@code expectedEventX/Y}、{@code guiXFromMouse}/{@code guiYFromMouse} 全是
 * {@link InputCoordinateMath} 同名分量的一行委托。这么做的理由是一条真实事故：同一份换算曾经在
 * 本类与 {@code mc.input.observe.InputCoordinateMath} 各写一遍，而观察面那份的回读口径是<b>镜像</b>的
 * （把 LWJGL2 左下原点的 {@code Mouse.getY()} 当成了左上原点的事件行），于是「报告的读数」与
 * 「判据的读数」长期不一致——详见 {@link InputCoordinateMath} 类注释的收敛小节。
 *
 * <h2>三个坐标系（不能混用）</h2>
 * <ol>
 * <li><b>GUI 缩放坐标</b>（{@code move} 的唯一入参口径）：原点左上、Y 向下，与
 * {@code GuiScreen.mouseClicked(mouseX, mouseY, ...)} 收到的一致；</li>
 * <li><b>framebuffer 像素</b>：{@code mc.displayWidth/displayHeight} 口径，同时也是
 * {@code Mouse.getY()} 的值域（LWJGL2 左下原点）；</li>
 * <li><b>SDL 窗口坐标</b>（{@code Mouse.addMoveEvent} 吃的口径）：原点左上、Y 向下，
 * 且要除以像素密度 {@code Display.getPixelScaleFactor()}。</li>
 * </ol>
 *
 * <h2>换算链（实现见 {@link InputCoordinateMath}，此处只是同一份式子的自述）</h2>
 *
 * <pre>
 * fbX   = round(guiX * displayWidth / scaledWidth)
 * fbY   = round(displayHeight - (guiY + 1) * displayHeight / scaledHeight)
 * sdlX  = fbX / S                                    （S = pixelScale）
 * sdlY  = displayHeight - fbY / S
 * eventX = sdlX                 （P0 实机定案：eventX = injectX）
 * eventY = displayHeight - sdlY （P0 实机定案：eventY = displayHeight - injectY）
 * </pre>
 *
 * <p>
 * 前两式是 vanilla {@code GuiScreen.handleMouseInput} 的**逐行逆换算**（源码实测：
 * {@code guiX = Mouse.getEventX() * width / displayWidth}、
 * {@code guiY = height - Mouse.getEventY() * height / displayHeight - 1}）。
 *
 * <p>
 * <b>P0 实机锚点</b>：注入 SDL {@code (426,322)} ⇒ 实读事件 {@code (426,158)}（该次
 * {@code displayHeight=480}、{@code pixelScale=1.0}）。把它代进本类：{@code guiY=321} ⇒
 * {@code fbY=158} ⇒ {@code sdlY=322} ⇒ {@code eventY=158} ✓，{@code guiX=426} ⇒ {@code eventX=426} ✓
 * （契约 §6.2 示例写的请求 {@code y=322} 与读数 158 差 1，落在 §2.4 第 4 条容许的 ±1 整数量化内）。
 *
 * <p>
 * <b>诚实的边界</b>：{@code pixelScale != 1}（HiDPI）下的口径**未实机校准**（契约 §11.2 第 12 条）。
 * 换算因此把 {@code S} 显式带进读回表达式（{@link #guiXFromMouse}/{@link #guiYFromMouse} 先把观测值
 * 乘回 framebuffer 口径再走 vanilla 正换算），并把 {@code pixelScale}、两级来源与
 * {@code selfCalibrated} 一并回显——调用方可以仅凭返回值核对，而不是相信本类的注释。
 */
public final class InputCoordinates {

    private final int scaledWidth;
    private final int scaledHeight;
    private final int displayWidth;
    private final int displayHeight;
    private final double pixelScale;
    private final String scaledSource;
    private final String pixelScaleSource;

    private InputCoordinates(int scaledWidth, int scaledHeight, int displayWidth, int displayHeight, double pixelScale,
        String scaledSource, String pixelScaleSource) {
        this.scaledWidth = scaledWidth;
        this.scaledHeight = scaledHeight;
        this.displayWidth = displayWidth;
        this.displayHeight = displayHeight;
        this.pixelScale = pixelScale;
        this.scaledSource = scaledSource;
        this.pixelScaleSource = pixelScaleSource;
    }

    /**
     * 构造换算器。
     *
     * @param scaledWidth      GUI 缩放宽（{@code GuiScreen.width} 或 {@code ScaledResolution} 口径）
     * @param scaledHeight     GUI 缩放高
     * @param displayWidth     framebuffer 宽（{@code mc.displayWidth}）
     * @param displayHeight    framebuffer 高（{@code mc.displayHeight}）
     * @param pixelScale       像素密度（{@code Display.getPixelScaleFactor()}；取不到按 1 并如实标注来源）
     * @param scaledSource     缩放参数的来源说明（自校准要能看见）
     * @param pixelScaleSource 像素密度的来源说明
     */
    public static InputCoordinates of(int scaledWidth, int scaledHeight, int displayWidth, int displayHeight,
        double pixelScale, String scaledSource, String pixelScaleSource) {
        return new InputCoordinates(
            scaledWidth,
            scaledHeight,
            displayWidth,
            displayHeight,
            InputCoordinateMath.effectivePixelScale(pixelScale),
            scaledSource,
            pixelScaleSource);
    }

    /** 不可用态（尺寸非法/未取到）：任何换算方法都会抛 {@link IllegalStateException}，绝不静默给 0。 */
    public static InputCoordinates unavailable(String why) {
        return new InputCoordinates(
            0,
            0,
            0,
            0,
            InputCoordinateMath.ASSUMED_PIXEL_SCALE,
            "unavailable: " + why,
            "unavailable: " + why);
    }

    /** 换算是否可用（尺寸与像素密度齐备）。 */
    public boolean usable() {
        return scaledWidth > 0 && scaledHeight > 0 && displayWidth > 0 && displayHeight > 0 && pixelScale > 0.0D;
    }

    /** GUI 缩放宽。 */
    public int scaledWidth() {
        return scaledWidth;
    }

    /** GUI 缩放高。 */
    public int scaledHeight() {
        return scaledHeight;
    }

    /** framebuffer 宽。 */
    public int displayWidth() {
        return displayWidth;
    }

    /** framebuffer 高。 */
    public int displayHeight() {
        return displayHeight;
    }

    /** 像素密度。 */
    public double pixelScale() {
        return pixelScale;
    }

    /** 缩放参数来源。 */
    public String scaledSource() {
        return scaledSource;
    }

    /** 像素密度来源。 */
    public String pixelScaleSource() {
        return pixelScaleSource;
    }

    private void requireUsable() {
        if (!usable()) {
            throw new IllegalStateException(
                "坐标换算不可用（scaled " + scaledWidth
                    + "x"
                    + scaledHeight
                    + "，display "
                    + displayWidth
                    + "x"
                    + displayHeight
                    + "，pixelScale "
                    + pixelScale
                    + "；来源 "
                    + scaledSource
                    + " / "
                    + pixelScaleSource
                    + "）");
        }
    }

    /** GUI X → framebuffer X（委托 {@link InputCoordinateMath#framebufferX}）。 */
    public int framebufferX(double guiX) {
        requireUsable();
        return InputCoordinateMath.framebufferX(guiX, scaledWidth, displayWidth);
    }

    /** GUI Y → framebuffer Y（委托 {@link InputCoordinateMath#framebufferY}）。 */
    public int framebufferY(double guiY) {
        requireUsable();
        return InputCoordinateMath.framebufferY(guiY, scaledHeight, displayHeight);
    }

    /** GUI X → SDL 窗口 X（{@code fbX / S}）。 */
    public double injectX(double guiX) {
        requireUsable();
        return InputCoordinateMath.sdlXFromFramebuffer(framebufferX(guiX), pixelScale);
    }

    /** GUI Y → SDL 窗口 Y（{@code displayHeight - fbY / S}，原点左上、Y 向下）。 */
    public double injectY(double guiY) {
        requireUsable();
        return InputCoordinateMath.sdlYFromFramebuffer(framebufferY(guiY), displayHeight, pixelScale);
    }

    /** 投递后**预期**的事件队列 X（P0 定案：{@code eventX = injectX}）。 */
    public double expectedEventX(double guiX) {
        requireUsable();
        return InputCoordinateMath.eventXFromFramebuffer(framebufferX(guiX), pixelScale);
    }

    /** 投递后**预期**的事件队列 Y（P0 定案：{@code eventY = displayHeight - injectY}）。 */
    public double expectedEventY(double guiY) {
        requireUsable();
        return InputCoordinateMath.eventYFromFramebuffer(framebufferY(guiY), pixelScale);
    }

    /**
     * 观测到的 {@code Mouse.getX()} → GUI 缩放 X（vanilla 正换算，先乘回 framebuffer 口径）。
     *
     * <p>
     * {@code guiX = mouseX * S * scaledWidth / displayWidth}；{@code S = 1} 时退化为 vanilla 式。
     */
    public double guiXFromMouse(double mouseX) {
        requireUsable();
        return InputCoordinateMath.guiXFromEventX(mouseX, scaledWidth, displayWidth, pixelScale);
    }

    /**
     * 观测到的 {@code Mouse.getY()} → GUI 缩放 Y（vanilla 正换算，先乘回 framebuffer 口径）。
     *
     * <p>
     * {@code guiY = scaledHeight - mouseY * S * scaledHeight / displayHeight - 1}。
     */
    public double guiYFromMouse(double mouseY) {
        requireUsable();
        return InputCoordinateMath.guiYFromEventY(mouseY, scaledHeight, displayHeight, pixelScale);
    }

    /** 两个 GUI 坐标是否在 ±1 整数量化内相等（§2.4 第 4 条的 `move` 成功判据）。 */
    public static boolean withinOnePixel(double a, double b) {
        return Math.abs(a - b) <= 1.0D;
    }

    /** {@code delivered} 回显（§2.5：字段名必须能自证口径）。 */
    public JsonObject deliveredJson(double guiX, double guiY) {
        return Json.object(
            "space",
            "sdl-window",
            "x",
            Double.valueOf(injectX(guiX)),
            "y",
            Double.valueOf(injectY(guiY)),
            "pixelScale",
            Double.valueOf(pixelScale),
            "displayWidth",
            Integer.valueOf(displayWidth),
            "displayHeight",
            Integer.valueOf(displayHeight));
    }

    /** {@code requested} 回显（§2.5）。 */
    public static JsonObject requestedJson(double guiX, double guiY) {
        return Json.object("space", "gui-scaled", "x", Double.valueOf(guiX), "y", Double.valueOf(guiY));
    }

    /**
     * {@code input.state.coordinates} 的形态（§5.2 冻结字段 + 只增的自校准字段）。
     *
     * @param selfCalibrated 最近一次 {@code move} 的读回是否落在 ±1 内（无 move 时为 false）
     */
    public JsonObject toJson(boolean selfCalibrated) {
        JsonObject o = new JsonObject();
        o.addProperty("space", InputCapabilities.COORDINATE_SPACE);
        o.addProperty("scaledWidth", scaledWidth);
        o.addProperty("scaledHeight", scaledHeight);
        o.addProperty("displayWidth", displayWidth);
        o.addProperty("displayHeight", displayHeight);
        o.addProperty("pixelScale", pixelScale);
        o.addProperty("yFlip", InputCapabilities.Y_FLIP);
        o.addProperty("selfCalibrated", selfCalibrated);
        // 只增字段：自校准要能看见「这些数是谁给的」，否则读数对不上时无从定位
        o.addProperty("usable", usable());
        o.addProperty("scaledSource", scaledSource);
        o.addProperty("pixelScaleSource", pixelScaleSource);
        o.addProperty(
            "formulas",
            "fbX=round(guiX*displayWidth/scaledWidth); fbY=round(displayHeight-(guiY+1)*displayHeight/scaledHeight); "
                + "sdlX=fbX/S; sdlY=displayHeight-fbY/S; eventX=sdlX; eventY=displayHeight-sdlY");
        o.addProperty("mathOwner", InputCoordinateMath.class.getName());
        o.addProperty(
            "hiDpiNote",
            "pixelScale!=1 的口径未实机校准（契约 §11.2 第 12 条）：读回换算把观测值乘回 framebuffer 口径后再走 vanilla 正换算，"
                + "读数不符时以 move 的 readback 为准");
        return o;
    }

    @Override
    public String toString() {
        return "InputCoordinates[scaled=" + scaledWidth
            + "x"
            + scaledHeight
            + ", display="
            + displayWidth
            + "x"
            + displayHeight
            + ", pixelScale="
            + pixelScale
            + "]";
    }
}
