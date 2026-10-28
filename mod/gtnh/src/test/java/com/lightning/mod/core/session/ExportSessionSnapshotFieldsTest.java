package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import org.junit.Test;

import com.lightning.mod.client.controlplane.core.Hashing;

/**
 * {@link ExportSession#snapshot()} 的「同会话同缓冲」判据字段（只增不改）：
 * {@code frameSha256[]} 与 {@code bufferGeneration}。
 *
 * <p>
 * <b>裁决原文对照</b>：「{@code export.session} 只增不改扩展：为同会话同缓冲机械判据补 {@code frameSha256[]}
 * （+ 可选 {@code bufferGeneration}）——只加字段，不改命令态行为（不引入隐式清缓冲）」。
 * 因此本测试锁两件事：
 *
 * <ol>
 * <li><b>字段正确性</b>：哈希与 {@code recordedFrames} 同序一一对应、口径 = 帧文本 UTF-8 的 sha256、
 * 不同内容必得不同哈希、世代号随写入递增；</li>
 * <li><b>「不改命令态行为」</b>：加入这两个字段后，写帧 / 读快照的既有语义不变，
 * 且<b>没有</b>任何隐式清缓冲（连续两次 record 后缓冲里是两帧，不是一帧）。</li>
 * </ol>
 */
public class ExportSessionSnapshotFieldsTest {

    /**
     * 哈希与帧号同序对应，且等于「该帧文本 UTF-8 的 sha256」。
     *
     * <p>
     * 「同序对应」是关键契约：调用方要能用 {@code frameSha256[i]} 定位 {@code recordedFrames[i]} 的内容。
     * 若两者顺序不一致（例如一个用 TreeMap 顺序、另一个用拷贝顺序），判据会静默错配——
     * 因此这里逐个索引比对，而不是只比集合。
     */
    @Test
    public void frameSha256MatchesFrameContentInSameOrder() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();
        s.setActiveFrame(0);

        // 故意用非连续、乱序的帧号，验证 TreeMap 的升序与哈希数组的顺序一致
        int[] targets = { 7, 3, 11, 1 };
        for (int f : targets) {
            s.registerFrameForTest(f, "{\"frame\":" + f + "}");
        }

        ExportSession.Snapshot snap = s.snapshot();
        int[] frames = snap.recordedFrames();
        String[] hashes = snap.frameSha256();

        assertEquals("两个数组必须等长", frames.length, hashes.length);
        assertEquals("帧数", targets.length, frames.length);
        assertEquals("recordedFrameCount 必须与数组长度一致", frames.length, snap.recordedFrameCount());

        // updated: 校验按升序排列且与哈希一一对应
        int[] expectedOrder = { 1, 3, 7, 11 };
        assertTrue("帧号应按升序（TreeMap 语义）: " + Arrays.toString(frames), Arrays.equals(expectedOrder, frames));

        for (int i = 0; i < frames.length; i++) {
            String expected = Hashing.sha256HexUtf8("{\"frame\":" + frames[i] + "}");
            assertEquals("第 " + i + " 个哈希必须对应帧 " + frames[i] + " 的内容", expected, hashes[i]);
        }
    }

    /** 不同内容必须得到不同哈希（否则哈希没有判别力）。 */
    @Test
    public void differentFrameContentYieldsDifferentHash() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();
        s.registerFrameForTest(1, "{\"frame\":1,\"marker\":\"a\"}");
        s.registerFrameForTest(2, "{\"frame\":2,\"marker\":\"b\"}");

        String[] hashes = s.snapshot()
            .frameSha256();
        assertEquals(2, hashes.length);
        assertNotEquals("不同帧内容不得同哈希", hashes[0], hashes[1]);
    }

    /** 世代号随写入帧递增（廉价「动过没有」判据）。 */
    @Test
    public void bufferGenerationIncrementsOnEachFrameWrite() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();
        long g0 = s.snapshot()
            .bufferGeneration();

        s.registerFrameForTest(1, "{}");
        long g1 = s.snapshot()
            .bufferGeneration();
        assertTrue("写入一帧后世代号必须递增（" + g0 + " -> " + g1 + "）", g1 > g0);

        s.registerFrameForTest(2, "{}");
        long g2 = s.snapshot()
            .bufferGeneration();
        assertTrue("再写一帧后世代号必须继续递增（" + g1 + " -> " + g2 + "）", g2 > g1);

        // 覆盖同一帧也算「动过」
        s.registerFrameForTest(2, "{\"changed\":true}");
        long g3 = s.snapshot()
            .bufferGeneration();
        assertTrue("覆盖同帧后世代号必须递增（" + g2 + " -> " + g3 + "）", g3 > g2);
    }

    /**
     * 「只增不改」的反面判据：<b>没有</b>隐式清缓冲。
     *
     * <p>
     * 硬口径要求「不引入隐式清缓冲」。本测试连续写帧并检查缓冲是**累积**的——
     * 若将来有人把 {@code snapshot()} 或某个新字段实现成「读一次就清」，这里会立刻变红。
     */
    @Test
    public void snapshotDoesNotImplicitlyClearTheBuffer() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();

        s.registerFrameForTest(1, "{\"frame\":1}");
        s.registerFrameForTest(2, "{\"frame\":2}");
        s.registerFrameForTest(3, "{\"frame\":3}");

        // 连读三次快照，每次都必须看到同样三帧（读操作绝不改状态）
        for (int round = 0; round < 3; round++) {
            ExportSession.Snapshot snap = s.snapshot();
            assertEquals("第 " + round + " 次读快照后帧数必须仍为 3（读操作不得清缓冲）", 3, snap.recordedFrameCount());
            Set<Integer> got = new HashSet<Integer>();
            for (int f : snap.recordedFrames()) {
                got.add(Integer.valueOf(f));
            }
            assertEquals("三帧必须都在", new HashSet<Integer>(Arrays.asList(1, 2, 3)), got);
            assertEquals("哈希数必须仍是 3", 3, snap.frameSha256().length);
        }
    }

    /** 空缓冲时两个新字段必须是「空/零」而不是 null（调用方无需判 null）。 */
    @Test
    public void emptyBufferYieldsEmptyArraysAndZeroGenerationNotBroken() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();

        ExportSession.Snapshot snap = s.snapshot();
        assertEquals("空缓冲帧数必须为 0", 0, snap.recordedFrameCount());
        assertEquals("空缓冲哈希数组必须为空（不是 null）", 0, snap.frameSha256().length);
        assertTrue("空缓冲时世代号不得为负", snap.bufferGeneration() >= 0L);
    }

    /** 快照返回的数组必须是副本：改它也改不到单例内部（不可变值对象的契约）。 */
    @Test
    public void snapshotArraysAreCopiesNotViews() {
        ExportSession s = ExportSession.get();
        s.clearFramesForTest();
        s.registerFrameForTest(5, "{\"frame\":5}");

        ExportSession.Snapshot snap = s.snapshot();
        String[] hashes = snap.frameSha256();
        int[] frames = snap.recordedFrames();

        assertTrue(hashes.length > 0 && frames.length > 0);
        hashes[0] = "tampered";
        frames[0] = -999;

        ExportSession.Snapshot fresh = s.snapshot();
        assertNotEquals("篡改快照副本不得影响单例", "tampered", fresh.frameSha256()[0]);
        assertNotEquals("篡改快照副本不得影响单例", -999, fresh.recordedFrames()[0]);
    }
}
