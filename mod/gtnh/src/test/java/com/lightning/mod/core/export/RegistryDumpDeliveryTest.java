package com.lightning.mod.core.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;

import org.junit.Test;

/**
 * {@link RegistryDumpDelivery} 的内存投递单（run 由发起方持有）。
 *
 * <p>
 * 本测试锁四件事——它们都是「run 由发起方持有」这条裁决的可判定面：
 *
 * <ol>
 * <li><b>落点由发起方给出</b>：请求里的 {@code exportRoot} 就是调用方给的那个绝对目录
 * （客户端不推导，不用 mcDataDir/CWD）；</li>
 * <li><b>幂等单槽</b>：已有未消费请求时第二次 request 返回 null（调用方据此报 CP-BUSY-001），
 * 不静默覆盖——否则「谁发的那次 dump」就说不清了；</li>
 * <li><b>消费即摘除</b>：consume 之后单槽为空，避免同一请求被写出两次；</li>
 * <li><b>失败显式</b>：finish(error) 后 done=true 且 error 非空——等待方不会空转绿。</li>
 * </ol>
 */
public class RegistryDumpDeliveryTest {

    @Test
    public void requestCarriesCallerSuppliedAbsoluteRoot() {
        RegistryDumpDelivery.clear();
        File root = new File(System.getProperty("java.io.tmpdir"), "sde-run-xyz/registry");
        RegistryDumpDelivery.Request r = RegistryDumpDelivery
            .request("20261007-120000-export-registry-1", root, "export.registry");
        assertNotNull("首次请求必须成功", r);
        assertEquals("run 标识必须是发起方给的那个", "20261007-120000-export-registry-1", r.runId());
        assertEquals("落点必须是发起方给的绝对目录（客户端不推导）", root, r.exportRoot());
        assertEquals("export.registry", r.requestedBy());
        assertTrue("请求时刻必须被记录", r.atEpochMs() > 0L);
        assertFalse("刚登记时未完成", r.done());
        assertNull("刚登记时无错误", r.error());
        RegistryDumpDelivery.clear();
    }

    @Test
    public void secondRequestIsRejectedWhileOneIsPending() {
        RegistryDumpDelivery.clear();
        File root = new File(System.getProperty("java.io.tmpdir"), "sde-run-a");
        RegistryDumpDelivery.Request first = RegistryDumpDelivery.request("run-a", root, "export.registry");
        assertNotNull(first);
        RegistryDumpDelivery.Request second = RegistryDumpDelivery
            .request("run-b", new File(root, "b"), "export.registry");
        assertNull("已有未消费请求时必须返回 null（调用方报 CP-BUSY-001），不得静默覆盖", second);
        assertTrue(RegistryDumpDelivery.hasPending());
        assertTrue("单槽里仍是第一次那个请求", RegistryDumpDelivery.peek() == first);
        RegistryDumpDelivery.clear();
    }

    @Test
    public void consumeRemovesTheSlotSoItCannotBeWrittenTwice() {
        RegistryDumpDelivery.clear();
        RegistryDumpDelivery.request("run-c", new File(System.getProperty("java.io.tmpdir"), "sde-run-c"), "cmd-exec");
        RegistryDumpDelivery.Request got = RegistryDumpDelivery.consume();
        assertNotNull(got);
        assertFalse("consume 之后单槽必须为空（防同一请求写出两次）", RegistryDumpDelivery.hasPending());
        assertNull("再消费一次必须得到 null", RegistryDumpDelivery.consume());
        // 消费之后可以登记新请求（不是「永久占用」）
        assertNotNull(
            "消费后应能登记新请求",
            RegistryDumpDelivery
                .request("run-d", new File(System.getProperty("java.io.tmpdir"), "sde-run-d"), "export.registry"));
        RegistryDumpDelivery.clear();
    }

    @Test
    public void finishRecordsErrorExplicitly() {
        RegistryDumpDelivery.clear();
        RegistryDumpDelivery.Request r = RegistryDumpDelivery
            .request("run-e", new File(System.getProperty("java.io.tmpdir"), "sde-run-e"), "export.registry");
        assertNotNull(r);
        RegistryDumpDelivery.finish(r, "图集未就绪");
        assertTrue("finish 后 done 必须为 true", r.done());
        assertEquals("失败原因必须如实记录（等待方不空转绿）", "图集未就绪", r.error());

        RegistryDumpDelivery.Request r2 = RegistryDumpDelivery
            .request("run-f", new File(System.getProperty("java.io.tmpdir"), "sde-run-f"), "export.registry");
        assertNotNull(r2);
        RegistryDumpDelivery.finish(r2, null);
        assertTrue(r2.done());
        assertNull("成功路径 error 必须为 null", r2.error());
        RegistryDumpDelivery.clear();
    }

    @Test
    public void clearReleasesTheSlot() {
        RegistryDumpDelivery.clear();
        RegistryDumpDelivery
            .request("run-g", new File(System.getProperty("java.io.tmpdir"), "sde-run-g"), "export.registry");
        assertTrue(RegistryDumpDelivery.hasPending());
        RegistryDumpDelivery.clear();
        assertFalse("clear 后必须可再次登记（失败收尾必须释放单槽）", RegistryDumpDelivery.hasPending());
        assertNotNull(
            RegistryDumpDelivery
                .request("run-h", new File(System.getProperty("java.io.tmpdir"), "sde-run-h"), "export.registry"));
        RegistryDumpDelivery.clear();
    }
}
