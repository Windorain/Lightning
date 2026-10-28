package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;

/**
 * {@link BuildJobMailbox} 的纯 JVM 单测（零 MC 依赖，JUnit4）。
 *
 * <p>
 * 覆盖那条跨线程通道的全部语义：提交 → 服务端认领 → 落结局 →
 * 客户端领取；结局复位；非 IDLE 拒绝；非法迁移响亮；以及<b>volatile 交接</b>——
 * 两个线程之间除了 mailbox 自己不借助任何额外同步，一方 take+complete，另一方 poll 必须看得见。
 */
public class BuildJobMailboxTest {

    /** 轮询等待上限（测试失败要失败得快，不许挂死）。 */
    private static final long TIMEOUT_MS = 5000L;

    @Test
    public void idleMailboxHasNothingToTakeOrPoll() {
        BuildJobMailbox mb = new BuildJobMailbox();
        assertEquals(BuildJobMailbox.State.IDLE, mb.state());
        assertTrue(mb.isIdle());
        assertNull("IDLE 时服务端没有作业可认领", mb.take());
        assertNull("IDLE 时客户端没有结局可领取", mb.poll());
        assertFalse("没有结局可丢弃", mb.discardUnclaimedOutcome());
    }

    @Test
    public void submitTakeCompleteThenPollReturnsSameResult() {
        BuildJobMailbox mb = new BuildJobMailbox();
        Object payload = new Object();
        Object result = new Object();

        assertTrue(mb.trySubmit(payload, "scene-build"));
        assertEquals(BuildJobMailbox.State.RUNNING, mb.state());

        BuildJobMailbox.Job job = mb.take();
        assertNotNull("提交后服务端必须认领到作业", job);
        assertSame("交接的必须是同一个载荷对象", payload, job.payload());
        assertEquals("scene-build", job.tag());
        assertEquals(BuildJobMailbox.State.RUNNING, mb.state());

        assertNull("作业在途时客户端拿不到结局", mb.poll());

        mb.complete(result);
        assertEquals(BuildJobMailbox.State.DONE, mb.state());

        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertEquals(BuildJobMailbox.State.DONE, c.state());
        assertTrue(c.isDone());
        assertFalse(c.isFailed());
        assertFalse(c.isAborted());
        assertSame("结局载荷必须是服务端交付的那一个", result, c.result());
        assertTrue("领取即消费：槽位复位为 IDLE", mb.isIdle());
        assertNull("结局只能领一次", mb.poll());
    }

    @Test
    public void takeIsClaimedOncePerJob() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit(new Object(), "t");
        assertNotNull(mb.take());
        assertNull("同一件作业不得被认领两遍（否则服务端会推进两遍）", mb.take());
    }

    @Test
    public void failureCarriesCodeMessageAndStackVerbatim() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit(new Object(), "t");
        mb.take();

        String stack = "java.lang.IllegalStateException: boom\n\tat com.example.Foo.bar(Foo.java:1)\n";
        mb.fail(ErrorCodes.EXEC_FAILED, "场景构建异常（服务端线程）: boom", stack);
        assertEquals(BuildJobMailbox.State.FAILED, mb.state());

        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertTrue(c.isFailed());
        assertFalse(c.isDone());
        assertEquals(ErrorCodes.EXEC_FAILED, c.errorCode());
        assertEquals("场景构建异常（服务端线程）: boom", c.errorMessage());
        assertEquals("栈文本必须逐字保真", stack, c.errorStack());
        assertNull(c.result());
        assertTrue(mb.isIdle());
    }

    @Test
    public void failureWithNullCodeFallsBackToExecFailed() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit(new Object(), "t");
        mb.take();
        mb.fail(null, "无码失败", null);

        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertEquals("码缺失时落 CP-EXEC-001（不是 null）", ErrorCodes.EXEC_FAILED, c.errorCode());
        assertNull("未提供栈时 errorStack 为 null", c.errorStack());
    }

    @Test
    public void abortCarriesReason() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit(new Object(), "t");
        mb.take();

        String reason = "构建期间世界实例更换（跨重建串写防护）bound=123 current=456";
        mb.abort(reason);
        assertEquals(BuildJobMailbox.State.ABORTED, mb.state());

        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertTrue(c.isAborted());
        assertFalse(c.isDone());
        assertEquals(reason, c.abortReason());
        assertNull(c.errorCode());
        assertTrue(mb.isIdle());
    }

    @Test
    public void secondSubmitIsRejectedWhileRunning() {
        BuildJobMailbox mb = new BuildJobMailbox();
        Object first = new Object();
        assertTrue(mb.trySubmit(first, "first"));
        mb.take();

        assertFalse("在途作业不得被覆盖", mb.trySubmit(new Object(), "second"));
        assertEquals("拒绝后状态与载荷都不许变", BuildJobMailbox.State.RUNNING, mb.state());

        mb.complete("r1");
        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertSame("被拒的提交绝不能顶掉在途作业的结局", "r1", c.result());
    }

    @Test
    public void secondSubmitIsRejectedWhileOutcomeUnclaimed() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit(new Object(), "first");
        mb.take();
        mb.complete("r1");

        assertFalse("结局待领取时同样非 IDLE，必须拒绝", mb.trySubmit(new Object(), "second"));
        assertEquals(BuildJobMailbox.State.DONE, mb.state());
    }

    @Test
    public void pollResetsSlotSoNextSubmitIsAccepted() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit("a", "first");
        mb.take();
        mb.complete("ra");
        assertNotNull(mb.poll());

        assertTrue("领取后槽位可再次受理", mb.trySubmit("b", "second"));
        mb.take();
        mb.complete("rb");
        BuildJobMailbox.Completion c = mb.poll();
        assertNotNull(c);
        assertEquals("rb", c.result());
    }

    @Test
    public void discardUnclaimedOutcomeOnlyWorksOnSettledOutcome() {
        BuildJobMailbox mb = new BuildJobMailbox();
        mb.trySubmit("a", "first");
        mb.take();

        assertFalse("在途作业不得被丢弃（安全阀只能收尸，不能杀活人）", mb.discardUnclaimedOutcome());
        assertEquals(BuildJobMailbox.State.RUNNING, mb.state());

        mb.fail(ErrorCodes.EXEC_FAILED, "超时退出后的残局", "stack");
        assertTrue("无人领取的结局必须能被丢弃（否则后续构建永久 CP-BUSY-001）", mb.discardUnclaimedOutcome());
        assertTrue(mb.isIdle());
        assertFalse("已复位的槽位没有结局可再丢", mb.discardUnclaimedOutcome());

        assertTrue(mb.trySubmit("b", "second"));
    }

    @Test
    public void illegalTransitionsAreLoud() {
        BuildJobMailbox mb = new BuildJobMailbox();

        try {
            mb.complete("r");
            fail("IDLE 时落结局必须抛 IllegalStateException");
        } catch (IllegalStateException expected) {
            assertTrue(
                "异常要写清当前状态",
                expected.getMessage()
                    .contains("IDLE"));
        }

        mb.trySubmit("a", "t");
        try {
            mb.complete("r");
            fail("未认领（服务端还没 take）就落结局必须抛 IllegalStateException");
        } catch (IllegalStateException expected) {
            assertTrue(
                expected.getMessage()
                    .contains("claimed=false"));
        }

        mb.take();
        mb.abort("世界换了");
        try {
            mb.fail(ErrorCodes.EXEC_FAILED, "重复落结局", null);
            fail("结局落两次必须抛 IllegalStateException");
        } catch (IllegalStateException expected) {
            assertTrue(
                expected.getMessage()
                    .contains("ABORTED"));
        }
    }

    /**
     * volatile 交接：两个线程之间<b>不借助任何额外同步</b>——服务端线程空转 take，
     * 客户端线程空转 poll，双方只依赖 mailbox 自己的 volatile 状态与锁。
     *
     * <p>
     * 这里刻意不用「await 服务端的闩锁再 poll」的写法：闩锁本身就是 happens-before 边，
     * 那样测到的是闩锁而不是 mailbox。轮询有上限（{@link #TIMEOUT_MS}），不会挂死。
     */
    @Test
    public void volatileHandoffIsVisibleAcrossThreads() throws Exception {
        final BuildJobMailbox mb = new BuildJobMailbox();
        final Object payload = new Object();
        final Object result = new Object();
        final CountDownLatch serverStarted = new CountDownLatch(1);
        final AtomicReference<Throwable> serverFailure = new AtomicReference<Throwable>();

        Thread server = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(TIMEOUT_MS);
                    BuildJobMailbox.Job job = null;
                    serverStarted.countDown();
                    while (job == null && System.nanoTime() < deadline) {
                        job = mb.take();
                    }
                    if (job == null) {
                        serverFailure.set(new AssertionError("服务端线程未在超时内认领到作业"));
                        return;
                    }
                    if (job.payload() != payload) {
                        serverFailure.set(new AssertionError("服务端线程读到的载荷不是提交的那一个"));
                        return;
                    }
                    mb.complete(result);
                } catch (Throwable t) {
                    serverFailure.set(t);
                }
            }
        }, "test-server-tick-thread");
        server.start();
        assertTrue(serverStarted.await(TIMEOUT_MS, TimeUnit.MILLISECONDS));

        assertTrue("提交必须被受理", mb.trySubmit(payload, "scene-build"));

        BuildJobMailbox.Completion c = null;
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(TIMEOUT_MS);
        while (c == null && System.nanoTime() < deadline) {
            c = mb.poll();
        }
        server.join(TIMEOUT_MS);
        assertNull("服务端线程不得有任何失败", serverFailure.get());
        assertNotNull("结局必须对客户端线程可见", c);
        assertTrue(c.isDone());
        assertSame("跨线程交付的必须是同一个结果对象", result, c.result());
        assertTrue(mb.isIdle());
    }
}
