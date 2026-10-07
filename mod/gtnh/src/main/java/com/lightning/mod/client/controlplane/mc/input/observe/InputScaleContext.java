package com.lightning.mod.client.controlplane.mc.input.observe;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.mc.input.InputCoordinateMath;

/**
 * 坐标上下文（缩放 / 显示尺寸 / guiScale）的<b>不可变指纹</b>与失效判定（Gitea #162 §2.4、§5.2）。
 *
 * <h2>要解决的具体失效模式</h2>
 * 「请求坐标 → 投递 → 回读」是跨 tick 的三步（{@code op:move} 之后必须等 ≥2 tick 才 {@code down}，
 * §2.4 第 5 条）。这中间窗口可以被改大小、GUI Scale 可以被改、全屏可以切换——此时
 * <ul>
 * <li>{@code ScaledResolution} 的 {@code scaledWidth/Height} 与 {@code scaleFactor} 变；</li>
 * <li>原版 {@code Minecraft.resize()} 会把 {@code displayWidth/displayHeight} 改成新窗口尺寸；</li>
 * <li>于是<b>之前那次 move 换算出的坐标不再对应同一个像素</b>。</li>
 * </ul>
 * 契约对这条只有一句硬要求：<b>不得</b>沿用失效坐标而不说明。本类就是那句「说明」的唯一来源：
 * 调用方拿两次快照的指纹一比，就能机读地判「上下文已变」。
 *
 * <h2>为什么指纹要含 {@code guiScale}</h2>
 * 只比 {@code scaledWidth/Height} 是不够的：{@code guiScale} 从 2 改到 3、窗口同时从
 * {@code 854×480} 改到 {@code 1281×720} 时，{@code scaledWidth/Height} 可能<b>一字不变</b>
 * （427×240），而 {@code Mouse.getX()/getY()}（显示像素）与 SDL 坐标全都变了。
 * 三个量一起进指纹才覆盖得住「缩放口径变化」这一类。
 *
 * <h2>线程</h2>
 * 不可变对象；只在客户端 tick 线程构造（构造入参全是 tick 线程实读的 MC/Display 值）。
 */
public final class InputScaleContext {

    /** 显示宽（像素，{@code Minecraft.displayWidth}）。 */
    public final int displayWidth;

    /** 显示高（像素）。 */
    public final int displayHeight;

    /** GUI 缩放后的宽（{@code ScaledResolution}）。 */
    public final int scaledWidth;

    /** GUI 缩放后的高。 */
    public final int scaledHeight;

    /** GUI 缩放倍率（{@code ScaledResolution.getScaleFactor()}）。 */
    public final int scaleFactor;

    /** 游戏设置里的 GUI Scale 原值（0 = 自动；留痕用，见类注释 §为什么指纹要含 guiScale）。 */
    public final int guiScaleSetting;

    /** 显示像素比（{@code Display.getPixelScaleFactor()} 口径；1.0 = 未缩放）。 */
    public final double pixelScale;

    /**
     * 真实窗口宽（{@code Display.getWidth()}；读不到时为 0）。
     *
     * <p>
     * 与 {@code displayWidth} 分开记：{@link com.lightning.mod.client.controlplane.mc.capture.ShotExecutor}
     * 在拍摄帧里会临时把 {@code mc.displayWidth} 覆写成 framebuffer 尺寸，此时前者是「本帧渲染尺寸」、
     * 后者才是「窗口尺寸」。窗口尺寸变了就是上下文变了，与渲染覆写无关。
     */
    public final int windowWidth;

    /** 真实窗口高（{@code Display.getHeight()}；读不到时为 0）。 */
    public final int windowHeight;

    /** 全量构造。 */
    public InputScaleContext(int displayWidth, int displayHeight, int scaledWidth, int scaledHeight, int scaleFactor,
        int guiScaleSetting, double pixelScale, int windowWidth, int windowHeight) {
        this.displayWidth = displayWidth;
        this.displayHeight = displayHeight;
        this.scaledWidth = scaledWidth;
        this.scaledHeight = scaledHeight;
        this.scaleFactor = scaleFactor;
        this.guiScaleSetting = guiScaleSetting;
        this.pixelScale = pixelScale;
        this.windowWidth = windowWidth;
        this.windowHeight = windowHeight;
    }

    /**
     * 是否与另一次快照处于同一坐标上下文。
     *
     * <p>
     * 逐项比较，任一项不等即判「已变」；{@code pixelScale} 用 {@code 1e-9} 容差
     * （它是 {@code double}，来自 {@code Display}，直接 {@code ==} 比会因表示误差误报）。
     * {@code previous == null}（没有上一份快照）视为「未变」——单次快照无从谈失效。
     */
    public boolean sameContext(InputScaleContext previous) {
        if (previous == null) {
            return true;
        }
        return displayWidth == previous.displayWidth && displayHeight == previous.displayHeight
            && scaledWidth == previous.scaledWidth
            && scaledHeight == previous.scaledHeight
            && scaleFactor == previous.scaleFactor
            && guiScaleSetting == previous.guiScaleSetting
            && windowWidth == previous.windowWidth
            && windowHeight == previous.windowHeight
            && Math.abs(pixelScale - previous.pixelScale) <= 1.0e-9d;
    }

    /**
     * 逐字段差异（机读；空数组 = 上下文一致）。
     *
     * <p>
     * 契约要求「不得沿用失效坐标而不说明」，只说「变了」不足以下判据（无法区分是窗口改了还是
     * GUI Scale 改了）。故给出<b>哪个字段</b>从什么变成了什么。
     */
    public com.google.gson.JsonArray diff(InputScaleContext previous) {
        com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
        if (previous == null) {
            return arr;
        }
        addIfChanged(arr, "displayWidth", previous.displayWidth, displayWidth);
        addIfChanged(arr, "displayHeight", previous.displayHeight, displayHeight);
        addIfChanged(arr, "scaledWidth", previous.scaledWidth, scaledWidth);
        addIfChanged(arr, "scaledHeight", previous.scaledHeight, scaledHeight);
        addIfChanged(arr, "scaleFactor", previous.scaleFactor, scaleFactor);
        addIfChanged(arr, "guiScaleSetting", previous.guiScaleSetting, guiScaleSetting);
        addIfChanged(arr, "windowWidth", previous.windowWidth, windowWidth);
        addIfChanged(arr, "windowHeight", previous.windowHeight, windowHeight);
        if (Math.abs(pixelScale - previous.pixelScale) > 1.0e-9d) {
            JsonObject o = new JsonObject();
            o.addProperty("field", "pixelScale");
            o.addProperty("from", previous.pixelScale);
            o.addProperty("to", pixelScale);
            arr.add(o);
        }
        return arr;
    }

    private static void addIfChanged(com.google.gson.JsonArray arr, String field, int from, int to) {
        if (from == to) {
            return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("field", field);
        o.addProperty("from", from);
        o.addProperty("to", to);
        arr.add(o);
    }

    /** 机读留痕（{@code input.state.coordinates} 的主体）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("space", "gui-scaled-request / sdl-window-delivered");
        o.addProperty("scaledWidth", scaledWidth);
        o.addProperty("scaledHeight", scaledHeight);
        o.addProperty("displayWidth", displayWidth);
        o.addProperty("displayHeight", displayHeight);
        o.addProperty("pixelScale", pixelScale);
        o.addProperty("scaleFactor", scaleFactor);
        o.addProperty("guiScaleSetting", guiScaleSetting);
        o.addProperty("windowWidth", windowWidth);
        o.addProperty("windowHeight", windowHeight);
        o.addProperty("yFlip", InputCoordinateMath.Y_FLIP);
        return o;
    }

    @Override
    public String toString() {
        return "scaled=" + scaledWidth
            + "x"
            + scaledHeight
            + " factor="
            + scaleFactor
            + " display="
            + displayWidth
            + "x"
            + displayHeight
            + " window="
            + windowWidth
            + "x"
            + windowHeight
            + " pixelScale="
            + pixelScale;
    }
}
