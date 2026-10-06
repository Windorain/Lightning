package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

import com.google.gson.JsonObject;

/**
 * {@link JobQueue} 单测：单动作互斥（CP-BUSY-001）、drainOne 状态机、失败路径与 sync 等待/超时。
 */
public class JobQueueTest {

    private JobRegistry registry;
    private EventStream events;
    private JobQueue queue;

    private JobQueue newQueue(JobExecutor executor) {
        registry = new JobRegistry();
        events = new EventStream(64, null, null);
        queue = new JobQueue(registry, events, TimeSource.fixed("2026-10-06T12:00:00+08:00", "t", 1000L), null);
        if (executor != null) {
            queue.setExecutor(executor);
        }
        return queue;
    }

    @Test
    public void submitReturnsQueuedJobAndRejectsSecondSubmit() {
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                return new JsonObject();
            }
        });
        Job first = queue.submit("core.ping", new JsonObject());
        assertEquals(Job.State.QUEUED, first.state());
        assertEquals("j1", first.jobId());
        assertEquals(1L, first.seq());
        assertTrue(queue.isBusy());
        assertEquals(1, queue.pendingCount());

        try {
            queue.submit("core.status", new JsonObject());
            fail("第二次提交应当 CP-BUSY-001");
        } catch (CpException e) {
            assertEquals(ErrorCodes.BUSY, e.code());
            assertEquals(409, e.httpStatus());
            assertEquals(
                "j1",
                e.context()
                    .get("busyJobId")
                    .getAsString());
        }
        // 被拒的提交不占用作业号
        assertEquals(1L, registry.lastSeq());
    }

    @Test
    public void drainOneRunsExecutorAndRecordsResult() {
        final AtomicInteger calls = new AtomicInteger();
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                calls.incrementAndGet();
                job.progress(0.5d, "half");
                JsonObject r = new JsonObject();
                r.addProperty("pong", true);
                return r;
            }
        });
        Job job = queue.submit("core.ping", new JsonObject());
        assertFalse(job.isFinished());

        assertTrue(queue.drainOne());
        assertEquals(1, calls.get());
        assertEquals(Job.State.DONE, job.state());
        assertTrue(
            job.result()
                .get("pong")
                .getAsBoolean());
        // 完成时进度被钉到 1.0；执行器中途上报的 0.5 保留在 progressMessage 上
        assertEquals(1.0d, job.progress(), 1e-9);
        assertEquals("half", job.progressMessage());
        assertNotNull(job.startedAt());
        assertNotNull(job.endedAt());
        assertTrue(job.isFinished());
        assertFalse(queue.isBusy());
        assertNull(queue.current());
        // 空闲时 drainOne 不再执行
        assertFalse(queue.drainOne());

        // 完成后可以再次提交
        Job second = queue.submit("core.ping", new JsonObject());
        assertEquals("j2", second.jobId());

        assertEquals(2, events.countKind(EventStream.Kinds.ACTION_SUBMIT));
        assertEquals(1, events.countKind(EventStream.Kinds.ACTION_START));
        assertEquals(1, events.countKind(EventStream.Kinds.ACTION_DONE));
    }

    @Test
    public void executorCpExceptionBecomesJobErrorWithSameCode() {
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                throw new CpException(ErrorCodes.STATE, "世界未加载");
            }
        });
        Job job = queue.submit("world.rebuild", new JsonObject());
        queue.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.STATE, job.errorCode());
        assertEquals(
            "世界未加载",
            job.error()
                .get("message")
                .getAsString());
        assertEquals(1, events.countKind(EventStream.Kinds.ACTION_FAIL));
        assertFalse(queue.isBusy());
    }

    @Test
    public void unexpectedExceptionBecomesExecFailed() {
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                throw new IllegalStateException("boom");
            }
        });
        Job job = queue.submit("world.rebuild", new JsonObject());
        queue.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.EXEC_FAILED, job.errorCode());
        assertEquals(
            "java.lang.IllegalStateException",
            job.error()
                .getAsJsonObject("context")
                .get("exception")
                .getAsString());
    }

    @Test
    public void missingExecutorFailsTheJobInsteadOfHanging() {
        newQueue(null);
        Job job = queue.submit("core.ping", new JsonObject());
        queue.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.EXEC_FAILED, job.errorCode());
    }

    @Test
    public void awaitReturnsFalseOnTimeoutThenTrueAfterCompletion() throws Exception {
        final CountDownLatch release = new CountDownLatch(1);
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread()
                        .interrupt();
                }
                return new JsonObject();
            }
        });
        final Job job = queue.submit("world.rebuild", new JsonObject());
        // 超时：202 + jobId，动作不取消
        assertFalse(job.await(50L));
        assertEquals(Job.State.QUEUED, job.state());

        Thread tick = new Thread(new Runnable() {

            @Override
            public void run() {
                queue.drainOne();
            }
        });
        tick.start();
        Thread.sleep(30L);
        assertFalse("执行中仍未结束", job.isFinished());
        release.countDown();
        assertTrue("完成后应被唤醒", job.await(3000L));
        assertEquals(Job.State.DONE, job.state());
        tick.join(3000L);
    }

    @Test
    public void jobJsonCarriesContractFields() {
        newQueue(null);
        JsonObject params = new JsonObject();
        params.addProperty("file", "cases/a.json");
        Job job = queue.submit("case.run", params);
        JsonObject o = job.toJson();
        assertEquals(
            "j1",
            o.get("jobId")
                .getAsString());
        assertEquals(
            "case.run",
            o.get("action")
                .getAsString());
        assertEquals(
            "queued",
            o.get("state")
                .getAsString());
        assertEquals(
            "cases/a.json",
            o.getAsJsonObject("params")
                .get("file")
                .getAsString());
        assertTrue(o.has("submittedAt"));
        assertFalse(o.has("result"));
        assertFalse(o.has("error"));
    }

    @Test
    public void registryReportsStateCounts() {
        newQueue(new JobExecutor() {

            @Override
            public JsonObject execute(Job job) {
                return new JsonObject();
            }
        });
        queue.submit("a", new JsonObject());
        queue.drainOne();
        JsonObject counts = registry.stateCounts();
        assertEquals(
            1,
            counts.get("done")
                .getAsInt());
        assertEquals(
            0,
            counts.get("queued")
                .getAsInt());
        assertEquals(
            1,
            registry.recent(5)
                .size());
    }
}
