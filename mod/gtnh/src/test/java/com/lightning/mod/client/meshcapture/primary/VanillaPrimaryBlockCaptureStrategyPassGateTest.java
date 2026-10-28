package com.lightning.mod.client.meshcapture.primary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

/**
 * 「这一 pass 该不该渲」的离线单测。
 *
 * <p>
 * 捕获过去对多 pass 方块无条件渲两轮、把 {@code canRenderInPass(pass)} 的返回值丢掉，于是只在某一个 pass
 * 渲染的方块被录了两遍。判定被抽成纯函数 {@link VanillaPrimaryBlockCaptureStrategy#shouldRenderPass}，
 * 本测试不依赖 Minecraft 静态实例，也不需要世界对象。
 */
public class VanillaPrimaryBlockCaptureStrategyPassGateTest {

    /** 只在 pass 1 渲染的方块（单层半透明外壳一类）：pass 0 必须跳过，pass 1 必须保留。 */
    @Test
    public void multiPassBlockSkipsThePassRejectedByCanRenderInPass() {
        assertFalse(
            "canRenderInPass(0)==false ⇒ 不得渲 pass 0（否则整块几何被录第二遍）",
            VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 0, pass -> pass == 1));
        assertTrue(
            "canRenderInPass(1)==true ⇒ 必须渲 pass 1（这是该方块唯一的合法 pass）",
            VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 1, pass -> pass == 1));
    }

    /** 两个 pass 都合法的方块：门控不得抑制任何一轮。 */
    @Test
    public void multiPassBlockRendersEveryLegalPass() {
        assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 0, pass -> true));
        assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 1, pass -> true));
    }

    /** 两个 pass 都被拒绝：一轮都不渲（例如只在 alpha pass 且当前无 alpha 几何的方块）。 */
    @Test
    public void multiPassBlockRendersNothingWhenEveryPassIsRejected() {
        assertFalse(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 0, pass -> false));
        assertFalse(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 1, pass -> false));
    }

    /** 谓词收到的必须是被决策的那个 pass（不是常量 0，也不是上一次的 pass）。 */
    @Test
    public void predicateReceivesThePassUnderDecision() {
        List<Integer> seen = new ArrayList<>();
        assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 0, pass -> {
            seen.add(pass);
            return true;
        }));
        assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 1, pass -> {
            seen.add(pass);
            return true;
        }));
        assertEquals(Arrays.asList(Integer.valueOf(0), Integer.valueOf(1)), seen);
    }

    /**
     * GT 机器那条分支（不进多 pass 判断）行为不变：两轮都渲，且<b>不调用</b>谓词
     * （改造前该分支同样只 setPass + 渲染，从不询问 canRenderInPass）。
     */
    @Test
    public void nonMultiPassBranchRendersBothPassesWithoutConsultingPredicate() {
        AtomicInteger calls = new AtomicInteger();
        assertTrue("非多 pass 分支的 pass 0 必须照旧渲", VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(false, 0, pass -> {
            calls.incrementAndGet();
            return false;
        }));
        assertTrue("非多 pass 分支的 pass 1 必须照旧渲", VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(false, 1, pass -> {
            calls.incrementAndGet();
            return false;
        }));
        assertEquals("非多 pass 分支不得询问 canRenderInPass", 0, calls.get());
    }

    /** 谓词抛异常时按放行处理：宁可多录一遍，也不静默丢几何。 */
    @Test
    public void predicateFailureFallsBackToRendering() {
        assertTrue(
            "谓词抛错不得吞掉几何",
            VanillaPrimaryBlockCaptureStrategy
                .shouldRenderPass(true, 0, pass -> { throw new IllegalStateException("boom"); }));
        assertTrue(
            "谓词抛错时 pass 1 同样放行",
            VanillaPrimaryBlockCaptureStrategy
                .shouldRenderPass(true, 1, pass -> { throw new IllegalStateException("boom"); }));
    }

    /** 判定是纯函数：同样的输入永远同样的输出。 */
    @Test
    public void decisionIsPureAndDeterministic() {
        for (int i = 0; i < 3; i++) {
            assertFalse(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 0, pass -> pass == 1));
            assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(true, 1, pass -> pass == 1));
            assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(false, 0, pass -> false));
            assertTrue(VanillaPrimaryBlockCaptureStrategy.shouldRenderPass(false, 1, pass -> false));
        }
    }
}
