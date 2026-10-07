package com.lightning.mod.client.controlplane.mc.input.api;

import java.util.Collections;
import java.util.List;

/**
 * 输入运行时状态的只读快照（Gitea #162 冻结件 §9.3 引用了该类型；此处落定**最小面**，
 * 字段/方法只增不改）。
 *
 * <p>
 * 实现归 T2-A（运行时自己产生真值）；只读消费方是 T2-B（把它组装成 {@code input.state} 的响应）。
 * <b>任何没有真值来源的字段都不许出现在这里</b>——宁可缺字段，也不许用默认值伪装成「已具备」（§11.2 第 17 条）。
 */
public interface InputStateSnapshot {

    /** 当前消费链：{@code "gui"} | {@code "world"} | {@code "none"}（由游戏决定，设施不干预）。 */
    String consumerChain();

    /** 键盘事件队列深度（实读 {@code Keyboard.getNumKeyboardEvents()}；不含 seed 时须说明口径）。 */
    int keyboardQueueDepth();

    /** 设施当前持有的键位描述名（按作业归属）。 */
    List<String> heldKeys();

    /** 设施当前持有的鼠标按钮。 */
    List<Integer> heldButtons();

    /** 是否有任何持有条目（供释放路径与泄漏检查用）。 */
    default boolean hasHeld() {
        List<String> k = heldKeys();
        List<Integer> b = heldButtons();
        return (k != null && !k.isEmpty()) || (b != null && !b.isEmpty());
    }

    /** 空快照（未实现/无运行时时的显式空态，不是「有状态但读不出来」）。 */
    static InputStateSnapshot empty() {
        return new InputStateSnapshot() {

            @Override
            public String consumerChain() {
                return "none";
            }

            @Override
            public int keyboardQueueDepth() {
                return 0;
            }

            @Override
            public List<String> heldKeys() {
                return Collections.emptyList();
            }

            @Override
            public List<Integer> heldButtons() {
                return Collections.emptyList();
            }
        };
    }
}
