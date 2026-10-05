package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

import com.google.gson.JsonObject;

/** 动作注册表步进注册与 {@link ActionSteppingExecutor} 桥接测试。 */
public class ActionSteppingExecutorTest {

    @Test
    public void steppingActionGetsPersistentContextAcrossSteps() {
        ActionRegistry reg = new ActionRegistry();
        AtomicInteger steps = new AtomicInteger();
        List<ActionContext> seen = new ArrayList<ActionContext>();
        reg.registerStepping(
            ActionDescriptor.builder("test.walk", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> {
                int n = steps.incrementAndGet();
                seen.add(ctx);
                if (n == 1) {
                    return null; // 第一步未完成：上下文须跨 tick 保留，下个 step 复用
                }
                JsonObject r = new JsonObject();
                r.addProperty("stepsSeen", n);
                r.addProperty("sameContext", seen.get(0) == ctx);
                return r;
            });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);
        Job job = q.submit("test.walk", new JsonObject());

        q.drainOne(); // 第 1 步：未完成，作业留在 running
        assertEquals(Job.State.RUNNING, job.state());
        assertEquals(1, exec.activeContexts());

        q.drainOne(); // 第 2 步：必须拿到同一 ActionContext 并收尾
        assertEquals(2, seen.size());
        assertSame(seen.get(0), seen.get(1));
        assertEquals(Job.State.DONE, job.state());
        assertEquals(
            2,
            job.result()
                .get("stepsSeen")
                .getAsInt());
        assertTrue(
            job.result()
                .get("sameContext")
                .getAsBoolean());
        assertEquals(0, exec.activeContexts());
    }

    @Test
    public void syncActionRunsToCompletionInOneStep() {
        ActionRegistry reg = new ActionRegistry();
        reg.register(
            ActionDescriptor.builder("test.sync", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> {
                JsonObject r = new JsonObject();
                r.addProperty("ok", true);
                return r;
            });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);
        Job job = q.submit("test.sync", new JsonObject());
        q.drainOne();
        assertEquals(Job.State.DONE, job.state());
        assertTrue(
            job.result()
                .get("ok")
                .getAsBoolean());
        assertEquals(0, exec.activeContexts());
    }

    @Test
    public void failureDiscardsContext() {
        ActionRegistry reg = new ActionRegistry();
        reg.registerStepping(
            ActionDescriptor.builder("test.boom", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> { throw new CpException(ErrorCodes.EXEC_FAILED, "boom"); });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);
        Job job = q.submit("test.boom", new JsonObject());
        q.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(0, exec.activeContexts());
    }

    @Test
    public void artifactStoreNullBeginRunGivesStateError() {
        // 未装配 ArtifactStore 时 beginRun 必须 CP-STATE-001 而非 NPE
        ActionRegistry reg = new ActionRegistry();
        reg.register(
            ActionDescriptor.builder("test.norun", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> {
                ctx.beginRun("x");
                return null;
            });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);
        Job job = q.submit("test.norun", new JsonObject());
        q.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.STATE, job.errorCode());
        assertNull(job.result());
    }
}
