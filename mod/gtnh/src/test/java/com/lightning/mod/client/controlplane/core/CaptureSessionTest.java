package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonObject;

/**
 * {@link CaptureSession} 的门控语义单测（contract.md §7.3，1.1）。
 *
 * <p>
 * 三条容易写错、写错就会静默伤人的语义：
 * <ol>
 * <li>重复 {@code begin} 必须 {@code CP-STATE-001}（不做隐式续期，否则「谁开的会话」说不清）；</li>
 * <li>未 {@code begin} 的 {@code end} 幂等成功；</li>
 * <li><b>开场作业自身可穿透</b>——{@code case.run} 的 capture 段在 build 段之前开场，
 * 若不加区分会把自己用例的 build 段挡掉。</li>
 * </ol>
 */
public class CaptureSessionTest {

    @Before
    public void setUp() {
        CaptureSession.end();
    }

    @After
    public void tearDown() {
        CaptureSession.end();
    }

    @Test
    public void initiallyUnarmed() {
        assertFalse(CaptureSession.isArmed());
        assertNull(CaptureSession.armedByJobId());
        // 未开场时任何作业都能写世界
        CaptureSession.assertWorldWriteAllowed("j1");
        CaptureSession.assertWorldWriteAllowed(null);
        assertFalse(
            CaptureSession.status()
                .get("armed")
                .getAsBoolean());
    }

    @Test
    public void beginArmsAndBlocksOtherJobs() {
        CaptureSession.begin("j7", "capture.begin", "2026-10-06T12:00:00+08:00", 3L);
        assertTrue(CaptureSession.isArmed());
        assertEquals("j7", CaptureSession.armedByJobId());
        JsonObject status = CaptureSession.status();
        assertTrue(
            status.get("armed")
                .getAsBoolean());
        assertEquals(
            "j7",
            status.get("by")
                .getAsString());
        assertEquals(
            "capture.begin",
            status.get("action")
                .getAsString());

        // 别的作业：拒
        CpException e = expectState(() -> CaptureSession.assertWorldWriteAllowed("j8"));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("捕获会话进行中"));
        // 匿名调用方（无作业 id）：同样拒（宁可拒，不可放）
        expectState(() -> CaptureSession.assertWorldWriteAllowed(null));
        // 开场作业：放行
        CaptureSession.assertWorldWriteAllowed("j7");
    }

    @Test
    public void duplicateBeginIsStateError() {
        CaptureSession.begin("j1", "capture.begin", "t1", 1L);
        CpException e = expectState(() -> CaptureSession.begin("j2", "capture.begin", "t2", 2L));
        assertTrue(
            e.detail(),
            e.detail()
                .contains("已在进行"));
        // 不做隐式续期：开场者仍是 j1
        assertEquals("j1", CaptureSession.armedByJobId());
        // j2 依然被挡
        expectState(() -> CaptureSession.assertWorldWriteAllowed("j2"));
    }

    @Test
    public void endIsIdempotent() {
        CaptureSession.begin("j1", "capture.begin", "t1", 1L);
        assertTrue(CaptureSession.end());
        assertFalse(CaptureSession.isArmed());
        // 第二次 end：幂等（返回 false = 本来就没会话）
        assertFalse(CaptureSession.end());
        assertFalse(CaptureSession.end());
        // 释放后世界写动作恢复
        CaptureSession.assertWorldWriteAllowed("j9");
    }

    @Test
    public void statusIsJsonSafeWhenUnarmed() {
        JsonObject status = CaptureSession.status();
        assertFalse(
            status.get("armed")
                .getAsBoolean());
        assertFalse(status.has("by"));
        assertFalse(status.has("since"));
    }

    private interface ThrowingRunnable {

        void run();
    }

    private static CpException expectState(ThrowingRunnable r) {
        try {
            r.run();
            fail("应当抛 CP-STATE-001");
            return null;
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            return e;
        }
    }
}
