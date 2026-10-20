package com.lightning.mod.client.controlplane.mc.input;

import java.util.List;

import com.google.gson.JsonObject;

/**
 * 投递后端（表示层与投递层的分界；契约 §8.1）。
 *
 * <p>
 * 本接口是**实现面**：只承载 §1.2 白名单的五个入口，与「键位标识 / 字符 / GUI 缩放坐标 / 按钮号 /
 * 滚轮档位」这套表示层契约解耦——换注入面（换 lwjgl3ify 版本、换后端）只换本接口的实现，
 * 不动表示层。生产实现是 {@link Lwjgl3ifyInjector}；单测用记录型假实现。
 *
 * <h2>能力探测必须如实</h2>
 * {@link #available()} 与 {@link #unavailableReason()} 是本接口对外的**能力声明**：不可用时
 * 任何写方法都必须抛 {@link InputInjectionException}，调用方据此报 {@code CP-STATE-001}
 * （契约 §6.1），<b>不许</b>静默 no-op 后返回成功。
 */
public interface InputSink {

    /** 单个入口的能力探测结果。 */
    final class Entry {

        private final String name;
        private final boolean available;
        private final String reason;

        /** 全参构造。 */
        public Entry(String name, boolean available, String reason) {
            this.name = name;
            this.available = available;
            this.reason = reason;
        }

        /** 入口名（如 {@code Keyboard.addRawKeyEvent}）。 */
        public String name() {
            return name;
        }

        /** 该入口当前是否可用。 */
        public boolean available() {
            return available;
        }

        /** 不可用原因；可用时为 {@code null}。 */
        public String reason() {
            return reason;
        }

        /** {@code {name, available, reason}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("name", name);
            o.addProperty("available", available);
            o.addProperty("reason", reason);
            return o;
        }
    }

    /** 后端标识（{@code runtime.backend} 口径，如 {@code sdl}）。 */
    String backend();

    /** 五个入口整体是否可用（= 全部入口可用）。 */
    boolean available();

    /** 整体不可用的原因；可用时为 {@code null}。 */
    String unavailableReason();

    /** 逐入口的能力探测（顺序与 §1.2 白名单一致）。 */
    List<Entry> entries();

    /** 探测结论的 JSON 形态（{@code runtime} 诊断用）。 */
    JsonObject probeJson();

    /**
     * 投递一个键事件（{@code Keyboard.addRawKeyEvent}）。
     *
     * @param keyCode   LWJGL 键码
     * @param codepoint 本事件自带的已提交字符码点；{@code 0} = 不携带
     * @param down      true = 按下，false = 抬起
     */
    void key(int keyCode, int codepoint, boolean down) throws InputInjectionException;

    /** 投递一个纯字符事件（{@code Keyboard.addCharEvent}）。 */
    void character(int codepoint) throws InputInjectionException;

    /** 投递鼠标按钮（{@code Mouse.addButtonEvent}；LWJGL 编号 0/1/2）。 */
    void button(int button, boolean down) throws InputInjectionException;

    /** 投递滚轮档位（{@code Mouse.addWheelEvent}；正档 = 原版 {@code getEventDWheel} 的正向）。 */
    void wheel(double amount) throws InputInjectionException;

    /**
     * 投递鼠标移动（{@code Mouse.addMoveEvent}）。
     *
     * @param absoluteX SDL 窗口坐标 X；{@code null} = 不改绝对位置（相对移动用）
     * @param absoluteY SDL 窗口坐标 Y；{@code null} = 不改绝对位置（相对移动用）
     * @param deltaX    世界视角增量 X（{@code xrel}）
     * @param deltaY    世界视角增量 Y（{@code yrel}）
     */
    void move(Double absoluteX, Double absoluteY, double deltaX, double deltaY) throws InputInjectionException;
}
