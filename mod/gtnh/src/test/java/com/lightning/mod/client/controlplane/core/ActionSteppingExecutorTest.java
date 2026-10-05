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

    /**
     * 回归：<b>每个作业一个步进动作实例</b>。
     *
     * <p>
     * 事故现场（真机冒烟 A5–A8）：注册表存的是单例，第二个 {@code case.run} 接着第一个的状态跑——
     * 首个 step 不再 onBegin、{@code advance} 立刻认为已完成，于是把上一次的 result 原样再交一次
     * （段记录逐字段相同、runId 是上一个作业的、且没有自己的 run 目录）。这里用一个<b>带作业级计数</b>
     * 的动作把语义钉死：同一作业内实例复用（计数累加到完成），跨作业必须重新从 1 开始。
     */
    @Test
    public void eachJobGetsItsOwnSteppingActionInstance() {
        ActionRegistry reg = new ActionRegistry();
        AtomicInteger created = new AtomicInteger();
        reg.registerStepping(
            ActionDescriptor.builder("test.stateful", Tier.OBSERVE)
                .description("t")
                .build(),
            () -> {
                created.incrementAndGet();
                // 计数器必须是**实例字段**：它量的就是「作业级状态」，复用了实例它就会接着涨
                return new SteppingAction() {

                    private int steps;

                    @Override
                    public JsonObject step(ActionContext ctx) {
                        steps++;
                        JsonObject r = new JsonObject();
                        r.addProperty("stepsSeen", steps);
                        r.addProperty(
                            "jobId",
                            ctx.job() == null ? null
                                : ctx.job()
                                    .jobId());
                        return steps % 3 == 0 ? r : null; // 每 3 步完成一次
                    }
                };
            });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);

        Job first = q.submit("test.stateful", new JsonObject());
        for (int i = 0; i < 3; i++) {
            q.drainOne();
        }
        assertEquals(Job.State.DONE, first.state());
        assertEquals(
            "同一作业内跨 step 复用同一实例（计数累加）",
            3,
            first.result()
                .get("stepsSeen")
                .getAsInt());
        assertEquals(
            "j1",
            first.result()
                .get("jobId")
                .getAsString());

        Job second = q.submit("test.stateful", new JsonObject());
        for (int i = 0; i < 3; i++) {
            q.drainOne();
        }
        assertEquals(Job.State.DONE, second.state());
        assertEquals(
            "第二个作业必须从干净状态开跑（复用实例会接着 3 累加到 6）",
            3,
            second.result()
                .get("stepsSeen")
                .getAsInt());
        assertEquals(
            "j2",
            second.result()
                .get("jobId")
                .getAsString());
        assertEquals("每个作业取一次实例", 2, created.get());
    }

    /** 工厂返回 null 是装配错误：必须 CP-EXEC-001，不许静默不执行。 */
    @Test
    public void steppingFactoryReturningNullFailsLoudly() {
        ActionRegistry reg = new ActionRegistry();
        reg.registerStepping(
            ActionDescriptor.builder("test.nullfactory", Tier.OBSERVE)
                .description("t")
                .build(),
            () -> null);
        ActionSteppingExecutor exec = new ActionSteppingExecutor(reg, null, null, null);
        JobQueue q = new JobQueue(new JobRegistry(), null, null);
        q.setStepper(exec);
        Job job = q.submit("test.nullfactory", new JsonObject());
        q.drainOne();
        assertEquals(Job.State.FAILED, job.state());
        assertEquals(ErrorCodes.EXEC_FAILED, job.errorCode());
        assertEquals(0, exec.activeContexts());
    }
}
