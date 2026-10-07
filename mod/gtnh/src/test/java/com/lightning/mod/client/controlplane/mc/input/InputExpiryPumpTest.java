package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import org.junit.Test;

/**
 * 结算泵的**线程判定**回归锁（Gitea #165，实机窗口 L-4）。
 *
 * <h2>它锁的是什么</h2>
 * 观察面要回答「当前是否在客户端 tick 线程上」。运行时自己的 {@code ownerThread} 只在**步进输入动作**
 * 跑过 {@code rt.tick()} 之后才绑定，而结算泵走的是 {@code expireDue()}（不绑定 owner）。
 * 实机因此出现过：{@code input.state.thread.snapshotThread == "Client thread"}，
 * 同一个响应里却写着 {@code verified:false}——明明在 tick 线程上，能力面却答「未验证」。
 *
 * <p>
 * 修法是给判定加第二条证据：**泵首次被调用时的线程按构造就是 tick 线程**
 * （泵只由 {@code ControlPlaneTickHandler} 的 {@code ClientTickEvent} 调用）。
 *
 * <p>
 * 本测试锁三件事：<b>捕获发生在调用时</b>（且即使在离线 JVM 里运行时构造失败也照样捕获——
 * 赋值在 try 之前）、<b>未捕获 = 无法判定（{@code null}）而不是「不是 tick 线程」</b>、
 * <b>判定按线程同一性</b>。第二件是重点：把「未验证」与「已验证为假」混成一个值，
 * 正是本仓禁止的「默认值伪装」。
 */
public class InputExpiryPumpTest {

    /** 泵的首次调用必须捕获当前线程——且这**不依赖**运行时是否能在离线 JVM 里构造出来。 */
    @Test
    public void tickCapturesTheFirstCallingThreadEvenIfTheRuntimeCannotBeBuilt() {
        InputExpiryPump.captureForTest(null);
        try {
            assertNull("未调用过 ⇒ 没有 tick 线程证据", InputExpiryPump.capturedTickThread());
            // 离线 JVM 里 InputRuntimeImpl.shared() 可能抛（无 MC/LWJGL），但捕获发生在 try 之前，
            // 因此这条断言不依赖运行期可用性。
            InputExpiryPump.tick();
            assertSame(
                "首次调用本泵的线程就是客户端 tick 线程（泵只由 ClientTickEvent 调用）",
                Thread.currentThread(),
                InputExpiryPump.capturedTickThread());
        } finally {
            InputExpiryPump.captureForTest(null);
        }
    }

    /** 未捕获 ⇒ {@code null}（**无法判定**），不是 {@code false}（「不是 tick 线程」）。 */
    @Test
    public void noEvidenceMeansUnjudgeableNotFalse() {
        assertNull(InputExpiryPump.sameThread(null, Thread.currentThread()));
    }

    /** 有证据时按**同一性**判定：同线程为真、异线程为假。 */
    @Test
    public void judgementIsByThreadIdentity() {
        Thread captured = new Thread("captured-tick");
        assertEquals(Boolean.TRUE, InputExpiryPump.sameThread(captured, captured));
        assertEquals(Boolean.FALSE, InputExpiryPump.sameThread(captured, new Thread("http-worker")));
    }
}
