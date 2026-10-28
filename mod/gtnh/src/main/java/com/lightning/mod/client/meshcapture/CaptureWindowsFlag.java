package com.lightning.mod.client.meshcapture;

/**
 * 「忠实复现捕获层」1.0 录窗布防的 JVM 属性解析：{@code -Dsde.captureWindows=on}。
 * <p>
 * 为什么单独成类：属性取值口径是布防的**唯一**外部输入，必须是可纯 JVM 单测的小纯函数
 * （本类不引用任何 {@code net.minecraft.*}/{@code cpw.mods.*} 类型，见
 * {@code src/test/java/com/lightning/mod/client/meshcapture/CaptureWindowsFlagTest.java}）。
 * 布防副作用（{@link TessellatorCaptureState#armWindows()} /
 * {@link CaptureDiagnostics#beginSession()}）留在挂点（{@code ClientProxy.initNetwork()}），
 * 解析与副作用分离。
 * <p>
 * 口径：只有 {@code on} 为开，<strong>大小写不敏感</strong>且忽略两端空白
 * （{@code on} / {@code ON} / {@code On} / {@code " on "} 均开）。其余一切取值——
 * 未设置（{@code null}）、空串、纯空白、{@code off}、以及 {@code true}/{@code 1}/{@code yes}
 * 等杂值——一律为<strong>关</strong>。诊断开关宁可漏开、不可误开：录窗会改变渲染路径的观察条件，
 * 只能由唯一一个成文的字面量开启（{@code true}/{@code 1} 不受支持是刻意的，不是遗漏）。
 */
public final class CaptureWindowsFlag {

    /** 布防录窗总开关的 JVM 属性名。 */
    public static final String PROPERTY = "sde.captureWindows";

    private CaptureWindowsFlag() {}

    /**
     * 纯函数：判定属性取值是否要求布防录窗。
     *
     * @param raw 属性原始取值（{@code System.getProperty} 的结果，可为 {@code null}）
     * @return 仅当取值去空白后等于（忽略大小写）{@code on} 时为 {@code true}
     */
    public static boolean isOn(String raw) {
        return raw != null && "on".equalsIgnoreCase(raw.trim());
    }
}
