package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

import com.google.gson.JsonObject;

/** {@link JobQueue} 步进模式（{@link SteppingExecutor}）语义测试。 */
public class JobQueueSteppingTest {

    private static JobQueue newQueue() {
        return new JobQueue(new JobRegistry(), null, null);
    }

    @Test
    public void steppingJobStaysRunningAcrossTicks() {
        JobQueue q = newQueue();
        AtomicInteger steps = new AtomicInteger();
        q.setStepper(job -> {
            int n = steps.incrementAndGet();
            job.progress(n / 3.0d, "step " + n);
            return n >= 3 ? new JsonObject() : null;
        });
        Job job = q.submit("test.step", new JsonObject());

        assertTrue(q.drainOne()); // 第 1 步
        assertEquals(Job.State.RUNNING, job.state());
        assertTrue(q.isBusy());

        assertTrue(q.drainOne()); // 第 2 步
        assertEquals(Job.State.RUNNING, job.state());

        assertTrue(q.drainOne()); // 第 3 步完成
        assertEquals(Job.State.DONE, job.state());
        assertFalse(q.isBusy());
        assertEquals(1.0d, job.progress(), 0.0001d);
        assertEquals(3, steps.get());
    }

    @Test
    public void steppingFailureEndsJobAndFreesQueue() {
        JobQueue q = newQueue();
        AtomicInteger steps = new AtomicInteger();
        q.setStepper(job -> {
            if (steps.incrementAndGet() >= 2) {
                throw new CpException(ErrorCodes.EXEC_FAILED, "第二步炸了");
            }
            return null;
        });
        Job job = q.submit("test.step", new JsonObject());
        q.drainOne();
        q.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.EXEC_FAILED, job.errorCode());
        assertFalse(q.isBusy());
        // 队列释放后可提交新作业
        Job next = q.submit("test.step2", new JsonObject());
        assertNotNull(next);
    }

    @Test
    public void syncAwaitWorksWithStepping() {
        JobQueue q = newQueue();
        q.setStepper(job -> new JsonObject()); // 一步完成
        Job job = q.submit("test.step", new JsonObject());
        assertFalse(job.await(0));
        q.drainOne();
        assertTrue(job.await(0));
        assertEquals(Job.State.DONE, job.state());
    }

    @Test
    public void drainOneWithoutJobsReturnsFalse() {
        JobQueue q = newQueue();
        q.setStepper(job -> new JsonObject());
        assertFalse(q.drainOne());
    }

    @Test
    public void busyRejectionAppliesDuringStepping() {
        JobQueue q = newQueue();
        q.setStepper(job -> null); // 永不完成
        q.submit("test.step", new JsonObject());
        q.drainOne();
        try {
            q.submit("test.other", new JsonObject());
        } catch (CpException e) {
            assertEquals(ErrorCodes.BUSY, e.code());
            return;
        }
        throw new AssertionError("执行中再提交应 CP-BUSY-001");
    }
}
