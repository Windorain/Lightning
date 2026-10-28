package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 动作失败必须落「完整栈」的回归测试。
 *
 * <p>
 * 失效形态：{@code case.run} 的 {@code cameras} 段首个 step 抛 NPE，FML 日志里只有
 *
 * <pre>
 * [SDE][CP] 动作失败 case.run#j3: 动作执行异常（阶段 case.cameras）: java.lang.NullPointerException: ...
 * </pre>
 *
 * 一行 message，<b>栈帧全无</b>，根因只能靠猜。这里把两条口径都钉住：
 * <ul>
 * <li>日志侧：失败必须把原始 {@code Throwable} 交给日志口（{@link LogSink#error}），
 * 由 mc 层用 {@code FMLLog.log(ERROR, t, msg)} 落完整栈；</li>
 * <li>事件侧：{@code action-fail} 事件的 {@code data.context.stack} 必须带前 12 帧摘要，
 * 且原有的 {@code code/message/context} 结构逐字段不变（老消费方不受影响）。</li>
 * </ul>
 */
public class FailureStackLoggingTest {

    /** 捕获日志口的桩：既实现 {@link LogSink}（带栈），也记录纯文本行。 */
    private static final class CapturingSink implements LogSink {

        private final List<String> lines = new ArrayList<String>();
        private final List<Throwable> errors = new ArrayList<Throwable>();

        @Override
        public void accept(String message) {
            lines.add(message);
        }

        @Override
        public void error(Throwable t, String message) {
            errors.add(t);
            lines.add(message);
        }
    }

    /** 同步执行器路径（{@code JobQueue} 自己就是落栈点）。 */
    @Test
    public void syncFailureLogsThrowableAndAddsStackToEvent() {
        CapturingSink sink = new CapturingSink();
        JobRegistry registry = new JobRegistry();
        EventStream events = new EventStream(64, null, null);
        JobQueue queue = new JobQueue(
            registry,
            events,
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "cp", 1000L),
            sink);
        final RuntimeException root = new NullPointerException("watchableobject is null");
        queue.setExecutor(
            job -> { throw new CpException(ErrorCodes.EXEC_FAILED, "动作执行异常（阶段 case.cameras）", null, root); });

        Job job = queue.submit("case.run", new JsonObject());
        queue.drainOne();

        assertEquals(Job.State.FAILED, job.state());
        assertEquals("日志口必须拿到原始 Throwable", 1, sink.errors.size());
        assertEquals(
            "落栈的是带 cause 的契约错误（log4j 会连 Caused by 一起展开）",
            CpException.class,
            sink.errors.get(0)
                .getClass());
        assertSame(
            root,
            sink.errors.get(0)
                .getCause());
        assertTrue(
            "日志行要能一眼看出是哪个作业失败",
            sink.lines.get(0)
                .contains("case.run#j1"));

        // 事件结构：code/message/context 一字不变，context 里多出 stack
        EventStream.Event fail = events.lastOfKind(EventStream.Kinds.ACTION_FAIL);
        assertNotNull(fail);
        JsonObject data = fail.data();
        assertEquals(
            ErrorCodes.EXEC_FAILED,
            data.get("code")
                .getAsString());
        assertEquals(
            "动作执行异常（阶段 case.cameras）",
            data.get("message")
                .getAsString());
        JsonArray stack = data.getAsJsonObject("context")
            .getAsJsonArray("stack");
        assertTrue("事件里必须带栈摘要", stack.size() > 0);
        String joined = join(stack);
        assertTrue(joined.contains("Caused by: java.lang.NullPointerException: watchableobject is null"));
        assertTrue("摘要要指到 case.cameras 这个阶段", joined.contains("case.cameras"));
    }

    /**
     * 步进路径的完整失效链：动作扔出的异常被包装成 {@link CpException}（带 cause）后，
     * 落栈点是 {@link ActionSteppingExecutor}，{@code JobQueue} 不得再落一遍。
     */
    @Test
    public void steppingFailureLogsExactlyOnceWithThrowable() {
        CapturingSink sink = new CapturingSink();
        ActionRegistry actions = new ActionRegistry();
        final NullPointerException root = new NullPointerException("watchableobject is null");
        actions.registerStepping(
            ActionDescriptor.builder("case.run", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> { throw new CpException(ErrorCodes.EXEC_FAILED, "动作执行异常（阶段 case.cameras）: " + root, null, root); });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(actions, null, null, sink);
        JobQueue queue = new JobQueue(
            new JobRegistry(),
            null,
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "cp", 1000L),
            sink);
        queue.setStepper(exec);

        Job job = queue.submit("case.run", new JsonObject());
        queue.drainOne();

        assertEquals(Job.State.FAILED, job.state());
        assertEquals("同一失败只落一份完整栈", 1, sink.errors.size());
        Throwable logged = sink.errors.get(0);
        assertEquals(CpException.class, logged.getClass());
        assertSame("包装层必须把原始异常带下来（否则栈全丢）", root, logged.getCause());
        String text = stackOf(logged);
        assertTrue(text.contains("Caused by: java.lang.NullPointerException: watchableobject is null"));
        assertTrue("栈里要有真正出错的那一帧（本测试的 lambda）", text.contains("lambda$"));
    }

    /** 步进动作直接扔未包装异常时同样要落栈。 */
    @Test
    public void steppingFailureWithRawThrowableLogsStack() {
        CapturingSink sink = new CapturingSink();
        ActionRegistry actions = new ActionRegistry();
        actions.registerStepping(
            ActionDescriptor.builder("case.run", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> { throw new NullPointerException("watchableobject is null"); });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(actions, null, null, sink);
        JobQueue queue = new JobQueue(
            new JobRegistry(),
            null,
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "cp", 1000L),
            sink);
        queue.setStepper(exec);

        queue.submit("case.run", new JsonObject());
        queue.drainOne();

        assertEquals(1, sink.errors.size());
        assertEquals(
            NullPointerException.class,
            sink.errors.get(0)
                .getClass());
        assertTrue(
            "栈里要有真正读 watcher 的那一帧所属的类名",
            stackOf(sink.errors.get(0)).contains("NullPointerException: watchableobject is null"));
    }

    /** 没有 {@link LogSink}（测试/旧装配里的 lambda）时退回纯文本，不许抛异常也不许丢日志。 */
    @Test
    public void plainConsumerStillWorks() {
        List<String> lines = new ArrayList<String>();
        ActionRegistry actions = new ActionRegistry();
        actions.registerStepping(
            ActionDescriptor.builder("case.run", Tier.OBSERVE)
                .description("t")
                .build(),
            ctx -> { throw new IllegalStateException("boom"); });
        ActionSteppingExecutor exec = new ActionSteppingExecutor(actions, null, null, lines::add);
        JobQueue queue = new JobQueue(
            new JobRegistry(),
            null,
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "cp", 1000L),
            lines::add);
        queue.setStepper(exec);

        queue.submit("case.run", new JsonObject());
        queue.drainOne();

        boolean sawFailure = false;
        for (String line : lines) {
            if (line.contains("boom")) {
                sawFailure = true;
            }
        }
        assertTrue("纯文本日志口也要收到失败", sawFailure);
    }

    /** 无 cause 的异常同样要落栈（栈就是异常自己）。 */
    @Test
    public void failureWithoutCauseStillLogs() {
        CapturingSink sink = new CapturingSink();
        JobQueue queue = new JobQueue(
            new JobRegistry(),
            null,
            TimeSource.fixed("2026-10-06T12:00:00+08:00", "cp", 1000L),
            sink);
        queue.setExecutor(job -> { throw new IllegalStateException("no cause"); });
        queue.submit("world.rebuild", new JsonObject());
        queue.drainOne();
        assertEquals(1, sink.errors.size());
        assertNull(
            sink.errors.get(0)
                .getCause());
    }

    private static String join(JsonArray a) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.size(); i++) {
            sb.append(
                a.get(i)
                    .getAsString())
                .append('\n');
        }
        return sb.toString();
    }

    private static String stackOf(Throwable t) {
        java.io.StringWriter sw = new java.io.StringWriter();
        t.printStackTrace(new java.io.PrintWriter(sw));
        return sw.toString();
    }
}
