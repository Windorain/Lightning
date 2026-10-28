package com.lightning.mod.client.meshcapture.zeroproduce;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 一格"没有产出几何"时的处置策略。与逐格捕获的其它策略表同构：{@link #priority()} 升序 +
 * {@link #applies(ZeroProduceContext)} 过滤 + 逐条异常隔离。
 * <p>
 * <strong>决策不是布尔</strong>：{@link Decision.Kind#PLACEHOLDER} 与 {@link Decision.Kind#DECLARED_EMPTY}
 * 都要写日志与计数，区别只在产物里是"显式占位"还是"显式空"。没有任何一条路回到"静默 0"——
 * 一个世界里存在的方块在导出件里变成空气，是这条链上最不可发现的失真。
 */
@SideOnly(Side.CLIENT)
public interface ZeroProducePolicy {

    /** 数值越小越先裁决；第一条 {@code applies} 命中的策略即为最终裁决。 */
    int priority();

    /** 本策略是否负责这一格。 */
    boolean applies(ZeroProduceContext ctx);

    /** 给出裁决。只在 {@link #applies} 为真时调用。 */
    Decision decide(ZeroProduceContext ctx);

    /** 一次零产出处置：二选一，但都带可解释的原因。 */
    final class Decision {

        public enum Kind {
            /** 落显式占位几何：产物里看得见、可解释、可计数。 */
            PLACEHOLDER,
            /** 声明"这一格本来就没有几何"：产物里仍是空，但落日志与计数。 */
            DECLARED_EMPTY
        }

        private final Kind kind;
        private final String reason;

        private Decision(Kind kind, String reason) {
            this.kind = kind;
            this.reason = reason != null && !reason.isEmpty() ? reason : "unspecified";
        }

        public static Decision placeholder(String reason) {
            return new Decision(Kind.PLACEHOLDER, reason);
        }

        public static Decision declaredEmpty(String reason) {
            return new Decision(Kind.DECLARED_EMPTY, reason);
        }

        public Kind kind() {
            return kind;
        }

        /** 原因枚举串（落日志与 {@code captureIssue.reason}，形如 {@code no_observable_geometry}）。 */
        public String reason() {
            return reason;
        }

        @Override
        public String toString() {
            return kind.name() + '(' + reason + ')';
        }
    }
}
