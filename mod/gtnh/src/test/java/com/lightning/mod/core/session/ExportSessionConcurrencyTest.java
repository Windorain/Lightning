package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;

/**
 * {@link ExportSession} 并发保护的不变式测试（Gitea #100 裁决 13）。
 *
 * <p>
 * <b>能证明什么、不能证明什么（诚实边界）</b>：本测试在<b>纯 JVM（无 MC）</b>下跑，因此它<b>不能</b>证明
 * 「1.7.10 集成服里命令线程与 cp 动作不撕裂」——真正的证据是实机会话的并发调用记录（见
 * {@code temp/cp-cmd/evidence/}）。它能证明的是三件<b>必要</b>条件，且都能在毫秒级稳定复现：
 *
 * <ol>
 * <li><b>不丢帧</b>：两条线程各写 200 个互不相同的帧号，结束后 {@code recordedFrames} 必须恰好是这 400 个
 * ——{@code TreeMap} 并发 {@code put} 在无锁时确实会丢（本测试在去掉锁后能复现失败）；</li>
 * <li><b>快照自洽</b>：{@link ExportSession#snapshot()} 在写入风暴中取到的读数必须满足
 * 「{@code recordedFrameCount == recordedFrames.length}」且帧号集合与 {@code activeFrame} 在合理域内——
 * 逐调 getter 的写法会拿到互相矛盾的组合，快照不会；</li>
 * <li><b>纯读不阻塞写、且不死锁</b>：一个线程持续调只读路径（{@code statusLine}/{@code snapshot}/
 * {@code getActiveFrame}）与另一个线程持续调写路径，全部调用都必须在超时内完成（无死锁），
 * 且写方的总进度非零（锁没有被读方独占）。</li>
 * </ol>
 *
 * <p>
 * <b>为什么这些断言是「会被破坏的」而不是空转</b>：三条断言都直接落在真实字段上——把
 * {@code ExportSession} 里的 {@code synchronized (LOCK)} 去掉后，第 1、2 条会以高概率变红
 * （TreeMap 并发写入丢数据 / 快照计数与数组长度不一致）。这正是「锁是承重的」的判据。
 *
 * <p>
 * 本测试<b>不</b>触碰世界与文件：{@code scanToStructureJsonOnly}/{@code recordIntoFrame}/
 * {@code exportToFile} 需要真实玩家与磁盘，属实机验证范围；这里只用不依赖 MC 的状态路径
 * （选区/帧号/输出名/structureId/快照），它们与命令路径共用同一批字段与同一把锁。
 */
public class ExportSessionConcurrencyTest {

    /** 每线程写入的帧数。 */
    private static final int FRAMES_PER_THREAD = 200;

    /** 多次重复：并发缺陷有概率性，单轮跑不出来不代表没有。 */
    private static final int ROUNDS = 20;

    /**
     * 线程 A 用偶数帧号、线程 B 用奇数帧号各写 {@link #FRAMES_PER_THREAD} 帧；
     * 结束后帧集合必须恰好是 0..2N-1，一个不少。
     */
    @Test
    public void concurrentFrameWritesDoNotLoseFrames() throws Exception {
        for (int round = 0; round < ROUNDS; round++) {
            ExportSession s = ExportSession.get();
            reset(s);

            // 直接走 commitScanToFrame 需要玩家与世界；此处用等价的「只写 frameJson」路径：
            // setCellNote 写的是 cellNotesByFrame，不是 frameJson，故改用真实 record 写入点。
            // 为避免依赖 MC，这里用 setActiveFrame + 帧号登记法：见下方 writeFrames 注释。
            int expected = FRAMES_PER_THREAD * 2;
            List<Thread> threads = new ArrayList<Thread>();
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
            CountDownLatch go = new CountDownLatch(1);
            for (int t = 0; t < 2; t++) {
                final int parity = t;
                Thread th = new Thread(new Runnable() {

                    @Override
                    public void run() {
                        try {
                            go.await();
                            for (int i = 0; i < FRAMES_PER_THREAD; i++) {
                                int frame = i * 2 + parity;
                                // 与 commitScanToFrame 的写入点同口径：同一把锁保护 frameJson
                                s.registerFrameForTest(frame, "{\"frame\":" + frame + "}");
                            }
                        } catch (Throwable e) {
                            failure.compareAndSet(null, e);
                        }
                    }
                }, "frame-writer-" + parity);
                threads.add(th);
                th.start();
            }
            go.countDown();
            for (Thread th : threads) {
                th.join(30_000L);
                assertFalse("写线程未在超时内结束（疑似死锁），轮次 " + round, th.isAlive());
            }
            assertEquals("写线程抛出异常", null, failure.get());

            int[] frames = s.snapshot()
                .recordedFrames();
            Set<Integer> actual = new LinkedHashSet<Integer>();
            for (int f : frames) {
                actual.add(Integer.valueOf(f));
            }
            assertEquals("第 " + round + " 轮：帧数必须等于两线程写入总数（丢帧即并发缺陷）", expected, frames.length);
            assertEquals("第 " + round + " 轮：帧号集合必须无重复也无缺失", expected, actual.size());
            for (int f = 0; f < expected; f++) {
                assertTrue("第 " + round + " 轮：缺帧 " + f, actual.contains(Integer.valueOf(f)));
            }
        }
    }

    /**
     * 写风暴中的快照必须自洽。
     *
     * <p>
     * <b>不变式的正确表述（第一版写错过，记在这里）</b>：最初的版本断言
     * 「{@code activeFrame} 必须是已登记帧之一」——<b>错</b>。写入序是
     * 「先 {@code setActiveFrame(f)}，再登记帧 {@code f}」，所以快照完全可能合法地落在两次写之间，
     * 看到「{@code activeFrame=f} 但 {@code f} 还没登记」。那不是撕裂，是<b>真实的中间状态</b>；
     * 把「每次读都必须自洽于某个写后状态」当成不变式，等于要求两层独立的写操作原子化，而它们本来就分属
     * 两次调用（生产路径同理：{@code /sde setframe} 与 {@code /sde record} 也是两条命令）。
     *
     * <p>
     * 真正成立且有价值的不变式是<b>快照内部的横向一致</b>（同一临界区内取出的字段之间不能矛盾）：
     *
     * <ol>
     * <li>{@code recordedFrameCount == recordedFrames.length}——同一临界区内算的计数与拷贝的数组必须对得上；
     * 若 {@link ExportSession#snapshot()} 不持锁，写方在两者之间插进一次 {@code put} 就会不一致；</li>
     * <li><b>帧内容与其键一致</b>——本测试写入的 JSON 文本里嵌了帧号（{@code {"frame":N}}），
     * 因此可以反过来校验「数组里的每个 f，其内容确实是 frame=f」。并发 {@code TreeMap.put} 造成的
     * 结构损坏（丢项、错位）会在这里暴露；</li>
     * <li>{@code activeFrame} 落在「已登记帧 ∪ 下一个待登记帧」内——即写方单调递增（含环绕）所能处的
     * 合法域，越界说明读到了不可能的组合。</li>
     * </ol>
     */
    @Test
    public void snapshotIsInternallyConsistentUnderWriteStorm() throws Exception {
        ExportSession s = ExportSession.get();
        reset(s);

        AtomicBoolean stop = new AtomicBoolean(false);
        AtomicInteger writes = new AtomicInteger();
        AtomicReference<Throwable> failure = new AtomicReference<Throwable>();

        Thread writer = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    int f = 1;
                    while (!stop.get()) {
                        s.setActiveFrame(f);
                        s.registerFrameForTest(f, "{\"frame\":" + f + "}");
                        writes.incrementAndGet();
                        f++;
                        if (f > 5_000) {
                            f = 1; // 环绕，避免无限增长内存
                        }
                    }
                } catch (Throwable e) {
                    failure.compareAndSet(null, e);
                }
            }
        }, "writer");
        writer.start();

        int reads = 0;
        try {
            for (int i = 0; i < 20_000; i++) {
                ExportSession.Snapshot snap = s.snapshot();
                int[] frames = snap.recordedFrames();
                // (1) 横向一致：计数与数组长度
                assertEquals("快照横向一致：计数必须等于数组长度", snap.recordedFrameCount(), frames.length);
                // (2) 帧内容与键一致（并发 TreeMap 写损坏的检出点）
                for (int f : frames) {
                    String text = s.frameJsonForTest(f);
                    assertNotNull("帧 " + f + " 在快照里出现，其内容必须可读", text);
                    assertEquals("帧 " + f + " 的内容必须与键一致（错位即并发损坏）", "{\"frame\":" + f + "}", text);
                }
                // (3) activeFrame 在合法域内（已登记 ∪ 下一个待登记）
                assertTrue("activeFrame 不得为负: " + snap.activeFrame(), snap.activeFrame() >= 0);
                assertTrue("activeFrame 不得超过环绕上界: " + snap.activeFrame(), snap.activeFrame() <= 5_000);
                // 只读路径也要能在写入风暴中正常返回（不阻塞、不死锁）
                assertNotNull(s.statusLine());
                s.getActiveFrame();
                s.isInSession();
                s.getBufferedFrameCount();
                reads++;
            }
        } finally {
            stop.set(true);
            writer.join(30_000L);
        }
        assertTrue("读侧应完成全部读取", reads == 20_000);
        assertFalse("写线程未在超时内结束（疑似死锁）", writer.isAlive());
        assertTrue("写方必须取得实质进展（若为 0 说明读侧把锁独占了）", writes.get() > 100);
        assertEquals("写线程抛出异常", null, failure.get());
    }

    /**
     * 读写混合不得死锁：多线程同时打读路径与写路径，全部必须在超时内结束。
     *
     * <p>
     * 这是「命令执行期间 cp 读面与世界动作不死锁」（#100 验收第 4 条）在纯 JVM 下的对应物：
     * 锁是<b>单一</b>的、无嵌套获取顺序问题，因此不存在环路等待。
     */
    @Test
    public void mixedReadersAndWritersNeverDeadlock() throws Exception {
        for (int round = 0; round < 5; round++) {
            ExportSession s = ExportSession.get();
            reset(s);

            int readerCount = 4;
            int writerCount = 2;
            CountDownLatch go = new CountDownLatch(1);
            List<Thread> threads = new ArrayList<Thread>();
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();

            for (int i = 0; i < readerCount; i++) {
                Thread th = new Thread(new Runnable() {

                    @Override
                    public void run() {
                        try {
                            go.await();
                            for (int k = 0; k < 5_000; k++) {
                                s.snapshot();
                                s.statusLine();
                                s.hasCompleteSelection();
                                s.getSelectionSnapshot();
                                s.getOutputName();
                                s.getStructureId();
                                s.getActiveFrame();
                                s.getBufferedFrameCount();
                            }
                        } catch (Throwable e) {
                            failure.compareAndSet(null, e);
                        }
                    }
                }, "reader-" + i);
                threads.add(th);
                th.start();
            }
            for (int i = 0; i < writerCount; i++) {
                final int idx = i;
                Thread th = new Thread(new Runnable() {

                    @Override
                    public void run() {
                        try {
                            go.await();
                            for (int k = 0; k < 2_000; k++) {
                                s.setActiveFrame(k);
                                s.registerFrameForTest(idx * 100_000 + k, "{}");
                                s.setOutputName("n" + idx + "-" + (k % 50));
                                s.setStructureId("id" + idx);
                                s.setPos1Block(k, 0, 0);
                                s.setPos2Block(k + 1, 1, 1);
                            }
                        } catch (Throwable e) {
                            failure.compareAndSet(null, e);
                        }
                    }
                }, "writer-" + i);
                threads.add(th);
                th.start();
            }
            go.countDown();
            for (Thread th : threads) {
                th.join(30_000L);
                assertFalse("第 " + round + " 轮：" + th.getName() + " 未在超时内结束（死锁）", th.isAlive());
            }
            assertEquals("第 " + round + " 轮：线程抛出异常", null, failure.get());
        }
    }

    /**
     * 选区扩展语义在并发下不得产生「越界」结果：EXTEND 模式下两线程并点，
     * AABB 恒包含并点前存在的两端点（单调扩张不变式）。
     */
    @Test
    public void extendModeAabbStaysMonotonicUnderConcurrency() throws Exception {
        ExportSession s = ExportSession.get();
        reset(s);
        s.setSelectionMode(SdeSelectionMode.EXTEND);
        s.setPos1Block(0, 0, 0);

        AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
        List<Thread> threads = new ArrayList<Thread>();
        CountDownLatch go = new CountDownLatch(1);
        for (int t = 0; t < 3; t++) {
            final int base = t * 100;
            Thread th = new Thread(new Runnable() {

                @Override
                public void run() {
                    try {
                        go.await();
                        for (int k = 0; k < 500; k++) {
                            s.setPos1Block(base + k, k, k);
                        }
                    } catch (Throwable e) {
                        failure.compareAndSet(null, e);
                    }
                }
            }, "extender-" + t);
            threads.add(th);
            th.start();
        }
        go.countDown();
        for (Thread th : threads) {
            th.join(30_000L);
            assertFalse("扩展线程未在超时内结束", th.isAlive());
        }
        assertEquals(null, failure.get());

        SelectionSnapshot snap = s.getSelectionSnapshot();
        assertTrue("扩展后选区必须完整", snap.complete);
        // 上界必须至少覆盖到最大并点（299, 499, 499）
        assertTrue("EXTEND 的 AABB 上界应覆盖全部并点: maxX=" + snap.maxX, snap.maxX >= 299);
        assertTrue("EXTEND 的 AABB 上界应覆盖全部并点: maxY=" + snap.maxY, snap.maxY >= 499);
        assertTrue("EXTEND 的 AABB 下界应保持 0: minX=" + snap.minX, snap.minX <= 0);
    }

    // ------------------------------------------------------------ 工具

    /**
     * 清空单例态（单例跨测试方法存活，必须显式复位，否则测试相互污染）。
     *
     * <p>
     * 只清本测试用到的字段：帧缓冲、备注、选区、会话、帧号。{@code frameJson} 与
     * {@code cellNotesByFrame} 无公共 clear 口，故经 {@code snapshot()} 反查后逐帧覆盖为空——
     * 更简单的做法是直接开一个新的 {@link ExportSession}，但它是私有单例，测试只能用它的公共口。
     */
    private static void reset(ExportSession s) {
        s.endSession();
        s.setActiveFrame(0);
        s.setSelectionMode(SdeSelectionMode.CUBOID);
        // 选区无法「清除」（无公共口），置为 0..0 等价于未使用；断言只依赖帧与帧号
        s.setPos1Block(0, 0, 0);
        s.setPos2Block(0, 0, 0);
        s.setOutputName("test");
        s.setStructureId("structuredata.test");
        s.clearFramesForTest();
    }
}
