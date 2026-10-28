package com.lightning.mod.core.export;

import java.io.File;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 注册表全量 dump 的<b>内存投递单</b>（run 由发起方持有）。
 *
 * <h2>它解决什么问题</h2>
 *
 * {@code /sde dump} 的既有链路是「服务端线程写握手文件 {@code structure_exports/pending_dump.json}
 * → 客户端 tick 轮询消费 → 写三份注册表」。这条路有个结构性缺陷：<b>产物落点由服务端线程算</b>
 * （{@code exportRoot = new File("structure_exports").getAbsolutePath()}，CWD 相对），
 * 与「谁发起这次 dump」无关——于是 dump 的产物**不属于任何 cp run**，「产物可发现」（产物入 run 清单）无从达成。
 *
 * <p>
 * 裁决口径是「<b>run 由发起方持有</b>」：cp 的 {@code export.registry} 动作（或 {@code cmd.exec}）开 run，
 * 把 run 的目录作为落点<b>显式</b>交给客户端 tick。两者只能通过一个显式投递单接头——
 * 这就是本类。它照抄既有握手范式的思想（「把落点告诉客户端，不让客户端猜」），但落点从
 * CWD 相对目录变成调用方给的<b>绝对</b>目录。
 *
 * <h2>为什么不做成「{@code /sde dump} 自己开 run」（反模式）</h2>
 *
 * 命令通道跑在 {@code Server thread}，它<b>没有</b> {@code ActionContext}/{@code JobHandle}，
 * 拿不到 runId 也开不了 cp run。强行开 run 会产出「不属于任何 cp 作业」的孤儿 run，违反
 * contract.md §8 第 1 条与「无隐藏通道」纪律。正确形态是发起方持有 run，命令通道由 {@code cmd.exec} 做发起方。
 *
 * <h2>两态并存阶段</h2>
 *
 * 内存单槽<b>优先</b>，老文件路径<b>兜底</b>：{@code ExportBundleClient} 先看单槽，没有才去看
 * {@code structure_exports/pending_dump.json}。两条路最终都收敛到
 * {@code ExportBundleClient.writeFullRegistryDump(File)}——<b>同一个写出体</b>，满足 D2。
 * 老路径只服务尚未搬迁的命令通道，其删除另行安排。
 *
 * <h2>线程语义</h2>
 *
 * 写入方是客户端 tick 线程（{@code export.registry} 动作在 {@code advance} 里请求），消费方也是
 * 客户端 tick 线程（{@code ExportBundleTickHandler} 在 {@code TickEvent.ClientTickEvent} Phase.END）。
 * 但 {@code cmd.exec} 路径下请求可能来自服务端线程（{@code /sde dump} 命令），因此单槽用
 * {@code synchronized} + {@code volatile} 保证可见性——代价是内存级赋值，可忽略。
 */
public final class RegistryDumpDelivery {

    /** 投递单 schema 标识（写进内部件，便于事后核对是哪一版协议）。 */
    public static final String SCHEMA = "lightning.registry-dump-request/1";

    /** 一次注册表 dump 请求。 */
    public static final class Request {

        private final long seq;
        private final String runId;
        private final File exportRoot;
        private final String requestedBy;
        private final long atEpochMs;
        private volatile boolean done;
        private volatile String error;

        Request(long seq, String runId, File exportRoot, String requestedBy) {
            this.seq = seq;
            this.runId = runId;
            this.exportRoot = exportRoot;
            this.requestedBy = requestedBy;
            this.atEpochMs = System.currentTimeMillis();
        }

        /** 单调递增序号（诊断用）。 */
        public long seq() {
            return seq;
        }

        /** 发起方持有的 run 标识（命令通道经 {@code cmd.exec} 发起时也有值）。 */
        public String runId() {
            return runId;
        }

        /** 注册表落点（绝对目录；由发起方给出，客户端不推导）。 */
        public File exportRoot() {
            return exportRoot;
        }

        /** 发起者（{@code export.registry} / {@code cmd-exec:<player>}）。 */
        public String requestedBy() {
            return requestedBy;
        }

        /** 请求时刻（epoch ms）。 */
        public long atEpochMs() {
            return atEpochMs;
        }

        /** 是否已被客户端消费并写出。 */
        public boolean done() {
            return done;
        }

        /** 消费侧的错误摘要（写出失败时非空）。 */
        public String error() {
            return error;
        }
    }

    private static final AtomicLong SEQ = new AtomicLong();

    /** 单槽（volatile：跨线程可见性）。 */
    private static volatile Request pending;

    private RegistryDumpDelivery() {}

    /**
     * 登记一次 dump 请求（<b>幂等</b>：已有未消费请求时返回 null，避免重复触发）。
     *
     * @param runId       发起方 run（可为 null，命令通道的兜底场景）
     * @param exportRoot  注册表落点（绝对目录）
     * @param requestedBy 发起者标识
     * @return 新请求；已有未消费请求时返回 null（调用方应报 CP-BUSY-001 或等待）
     */
    public static synchronized Request request(String runId, File exportRoot, String requestedBy) {
        if (pending != null) {
            return null;
        }
        Request r = new Request(SEQ.incrementAndGet(), runId, exportRoot, requestedBy);
        pending = r;
        return r;
    }

    /** 当前未消费请求；无则 null。 */
    public static Request peek() {
        return pending;
    }

    /**
     * 消费当前请求（客户端 tick 调用；把单槽摘下来，避免重复写出）。
     *
     * <p>
     * 摘除与写出是两步：本方法只摘除并返回请求，写出由调用方做，完成后调 {@link #finish(Request, String)}。
     * 这样「写出失败」也是显式的——{@code done} 与 {@code error} 都会如实记录，等待方不会空转绿。
     */
    public static synchronized Request consume() {
        Request r = pending;
        pending = null;
        return r;
    }

    /**
     * 标记一次请求已完成（{@code error} 为 null 表示成功），<b>并释放单槽</b>。
     *
     * <p>
     * 释放单槽是必须的：否则一次失败会让后续所有 dump 调用都撞 {@code CP-BUSY-001}
     * （实测症状：第一次 dump 因图集未就绪失败后，重试永远被拒）。
     * 只释放<b>自己</b>那一次（{@code pending == r} 才清）——若期间已有新请求进来，不动它。
     */
    public static void finish(Request r, String error) {
        if (r == null) {
            return;
        }
        r.error = error;
        r.done = true;
        synchronized (RegistryDumpDelivery.class) {
            if (pending == r) {
                pending = null;
            }
        }
    }

    /** 清除当前单槽（收尾兜底；正常路径由 {@link #consume()} 摘除）。 */
    public static synchronized void clear() {
        pending = null;
    }

    /** 是否有待消费请求。 */
    public static boolean hasPending() {
        return pending != null;
    }
}
