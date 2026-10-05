package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;

/**
 * {@link StackSummary} 单测：帧数上限、cause 链展开、null/自引用安全。
 *
 * <p>
 * 这层能纯 JVM 覆盖，是因为摘要器刻意只依赖 {@code java.lang} 与 gson——事故里丢掉栈的那条路径
 * （动作失败日志/事件）本身跑在 MC 里、无法无头复现，但「栈怎么被摘要」这件事必须被钉住。
 */
public class StackSummaryTest {

    @Test
    public void nullThrowableGivesEmptySummary() {
        assertTrue(
            StackSummary.lines(null, 12)
                .isEmpty());
        assertEquals(
            0,
            StackSummary.frames(null, 12)
                .size());
        assertEquals("", StackSummary.text(null, 12));
        assertEquals("<null>", StackSummary.describe(null));
        assertNull(StackSummary.causeOf(null));
    }

    @Test
    public void framesAreCappedAndTruncationIsMarked() {
        List<String> lines = StackSummary.lines(boom("炸了"), 4);

        assertEquals("首行是异常描述", "java.lang.IllegalStateException: 炸了", lines.get(0));
        assertTrue(
            "首帧必须是抛出点",
            lines.get(1)
                .contains("boom"));
        int atLines = 0;
        for (String line : lines) {
            if (line.startsWith("  at ")) {
                atLines++;
            }
        }
        assertEquals("帧数必须被 maxFrames 夹住", 4, atLines);
        assertTrue(
            "被截断时要标注省略条数",
            lines.get(lines.size() - 1)
                .contains(" more"));
    }

    /** 包装异常的额度分配：外层不得把额度吃光，最内层（真正的失败点）必须出现。 */
    @Test
    public void deepestCauseIsAlwaysShown() {
        NullPointerException root = npe();
        // 外层造一条很长的栈：连抛几层，确保它自己的帧数远超额度的一半
        CpException wrapper = wrapDeep(root, 0);

        String text = StackSummary.text(wrapper, StackSummary.DEFAULT_FRAMES);
        assertTrue(text.contains("CpException: 动作执行异常（阶段 case.cameras）"));
        assertTrue(
            "最内层的失败点必须在摘要里",
            text.contains("Caused by: java.lang.NullPointerException: watchableobject is null"));
        assertTrue("最内层的帧必须在摘要里", text.contains("npe"));
    }

    /** 逐层包装，让外层栈足够长（模拟 CpException → 执行器 → 队列 → tick 的调用深度）。 */
    private static CpException wrapDeep(Throwable root, int depth) {
        if (depth >= 8) {
            return new CpException(ErrorCodes.EXEC_FAILED, "动作执行异常（阶段 case.cameras）", null, root);
        }
        return wrapDeep(root, depth + 1);
    }

    /** {@code cause == this} 在 JDK 上会被 {@code initCause} 拒掉，故这里只钉「链展开有上限」。 */
    @Test
    public void causeChainIsCapped() {
        Throwable t = new IllegalStateException("l0");
        for (int i = 1; i <= 6; i++) {
            t = new IllegalStateException("l" + i, t);
        }
        assertEquals(
            StackSummary.MAX_CAUSES,
            StackSummary.chainOf(t)
                .size());
    }

    @Test
    public void jsonFormIsStringArray() {
        JsonArray a = StackSummary.frames(boom("x"), 3);
        assertTrue(a.size() > 0);
        for (int i = 0; i < a.size(); i++) {
            assertTrue(
                a.get(i)
                    .isJsonPrimitive());
            assertTrue(
                a.get(i)
                    .getAsJsonPrimitive()
                    .isString());
        }
    }

    /** {@code cause == this} 是 {@link Throwable} 的合法状态（{@code initCause(this)}），不能死循环。 */
    @Test
    public void selfReferencingCauseTerminates() {
        IllegalStateException t = new IllegalStateException("self");
        assertNull(StackSummary.causeOf(t));
        List<String> lines = StackSummary.lines(t, 12);
        assertFalse(lines.isEmpty());
        for (String line : lines) {
            assertFalse("自引用不得展开出 Caused by", line.startsWith("Caused by:"));
        }
    }

    /** 取不到 message 时只留类名（不许出现 "null" 字样）。 */
    @Test
    public void describeWithoutMessage() {
        assertEquals("java.lang.IllegalStateException", StackSummary.describe(new IllegalStateException()));
    }

    /** 栈顶是 {@code boom}，便于断言「摘要里能看到抛出点」。 */
    private static Throwable boom(String message) {
        return new IllegalStateException(message);
    }

    /** 栈顶是 {@code npe}，用来模拟「被包装的真正失败点」。 */
    private static NullPointerException npe() {
        try {
            throw new NullPointerException("watchableobject is null");
        } catch (NullPointerException e) {
            return e;
        }
    }
}
