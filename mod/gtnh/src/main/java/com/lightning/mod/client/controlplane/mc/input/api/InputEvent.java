package com.lightning.mod.client.controlplane.mc.input.api;

/**
 * 一次输入事件（字段名即契约：**只增不改**）。
 *
 * <p>
 * 本类是运行时与集成之间的接口面之一，**先于两侧实现落定**——
 * 三方并行时谁都不许改它的字段名或语义；新增字段是 v1 允许的增量，改名/删除属于破坏变更。
 *
 * <p>
 * 线程：只在**客户端 tick 线程**构造与消费（{@code contract.md} §8 第 1 条）。HTTP 线程不得触碰。
 *
 * <h2>字段口径</h2>
 * <ul>
 * <li>{@code kind}：{@code "key"} | {@code "char"} | {@code "mouse"} | {@code "move"} | {@code "wheel"}；</li>
 * <li>{@code key}/{@code keyCode}：{@code kind=key} 的键位描述名与 LWJGL 键码（两者给其一，解析结果必须一致）；</li>
 * <li>{@code state}：{@code kind=key|mouse} 的 {@code "down"}/{@code "up"}；</li>
 * <li>{@code codepoint}：已提交字符码点，缺省 0（**键位与字符分离建模**，见 §2.2）；</li>
 * <li>{@code button}：{@code kind=mouse} 的 0/1/2（LWJGL 编号）；</li>
 * <li>{@code x}/{@code y}：{@code kind=move} 的 **GUI 缩放坐标**（换算由设施负责，调用方不猜口径）；</li>
 * <li>{@code dx}/{@code dy}：{@code kind=move} 且 {@code op=relative} 时的世界视角增量；</li>
 * <li>{@code amount}：{@code kind=wheel} 的 ±整数档（小数会被累积取整吞掉）。</li>
 * </ul>
 */
public final class InputEvent {

    /** 事件种类：键。 */
    public static final String KIND_KEY = "key";
    /** 事件种类：字符。 */
    public static final String KIND_CHAR = "char";
    /** 事件种类：鼠标按钮。 */
    public static final String KIND_MOUSE = "mouse";
    /** 事件种类：鼠标移动/定位。 */
    public static final String KIND_MOVE = "move";
    /** 事件种类：滚轮。 */
    public static final String KIND_WHEEL = "wheel";

    /** 状态：按下。 */
    public static final String STATE_DOWN = "down";
    /** 状态：抬起。 */
    public static final String STATE_UP = "up";

    /** 事件种类，见 KIND_*。 */
    public String kind;
    /** 键位描述名（{@code kind=key}）。 */
    public String key;
    /** LWJGL 键码（{@code kind=key}）。 */
    public Integer keyCode;
    /** {@code down}/{@code up}（{@code kind=key|mouse}）。 */
    public String state;
    /** 已提交字符码点（{@code kind=key|char}），缺省 0。 */
    public Integer codepoint;
    /** 鼠标按钮 0/1/2（{@code kind=mouse}）。 */
    public Integer button;
    /** GUI 缩放坐标 X（{@code kind=move}）。 */
    public Double x;
    /** GUI 缩放坐标 Y（{@code kind=move}）。 */
    public Double y;
    /** 世界视角增量 X（{@code kind=move} 且 op=relative）。 */
    public Double dx;
    /** 世界视角增量 Y（{@code kind=move} 且 op=relative）。 */
    public Double dy;
    /** 滚轮档位（{@code kind=wheel}）。 */
    public Double amount;

    /** 空事件（供序列化/测试构造）。 */
    public InputEvent() {}

    /** 便捷构造：键按下/抬起。 */
    public static InputEvent key(String keyName, int keyCode, boolean down, Integer codepoint) {
        InputEvent e = new InputEvent();
        e.kind = KIND_KEY;
        e.key = keyName;
        e.keyCode = Integer.valueOf(keyCode);
        e.state = down ? STATE_DOWN : STATE_UP;
        e.codepoint = codepoint == null ? Integer.valueOf(0) : codepoint;
        return e;
    }

    /** 便捷构造：鼠标按钮。 */
    public static InputEvent button(int button, boolean down) {
        InputEvent e = new InputEvent();
        e.kind = KIND_MOUSE;
        e.button = Integer.valueOf(button);
        e.state = down ? STATE_DOWN : STATE_UP;
        return e;
    }

    /** 便捷构造：鼠标定位（GUI 缩放坐标）。 */
    public static InputEvent move(double guiX, double guiY) {
        InputEvent e = new InputEvent();
        e.kind = KIND_MOVE;
        e.x = Double.valueOf(guiX);
        e.y = Double.valueOf(guiY);
        return e;
    }

    /** 便捷构造：滚轮。 */
    public static InputEvent wheel(double amount) {
        InputEvent e = new InputEvent();
        e.kind = KIND_WHEEL;
        e.amount = Double.valueOf(amount);
        return e;
    }
}
