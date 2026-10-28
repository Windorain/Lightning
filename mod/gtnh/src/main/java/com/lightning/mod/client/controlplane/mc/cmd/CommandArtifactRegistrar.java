package com.lightning.mod.client.controlplane.mc.cmd;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.client.controlplane.mc.ControlPlaneBootstrap;
import com.lightning.mod.client.controlplane.mc.ControlPlaneRuntime;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.core.export.RegistryDumpDelivery;

/**
 * 命令通道产物的<b>延迟登记</b>队列（单一归属）。
 *
 * <h2>为什么必须延迟（两条实测出来的硬约束）</h2>
 *
 * 命令通道的两类产物都不是「命令返回时就已经最终」的，而 {@code cmd.exec} 是<b>同步动作</b>：
 *
 * <ol>
 * <li><b>场景文件是两段写的</b>：{@code /sde export} 在<b>服务端线程</b>先写一份
 * {@code geometryPhase=scan} 的中间态，再把字节经网络包投给客户端；客户端在<b>下一个 tick</b>
 * 经 {@code MeshCaptureService.enrichAndWriteClientExport} <b>覆盖写同名文件</b>为
 * {@code baked} + Envelope。命令返回时磁盘上还是那份 scan 中间态——此刻登记，登记的是<b>半成品</b>。</li>
 * <li><b>注册表是客户端 tick 写的</b>：{@code /sde dump} 只写握手/投递单，三份注册表由客户端 tick
 * 消费后写出。命令返回时它们<b>还不存在</b>。</li>
 * </ol>
 *
 * <p>
 * <b>不能靠「在动作里 sleep 等」</b>：{@code cmd.exec} 跑在<b>客户端 tick 线程</b>，而上面两件事
 * 都<b>只能</b>在该线程的后续 tick 上发生（{@code ExportBundleTickHandler} 在
 * {@code TickEvent.ClientTickEvent} 排空）。在动作里阻塞 = 掐死唯一的推进者 ⇒ <b>构造性死锁</b>，
 * 必然超时。（第一版正是这么写的，实测表现为「等待客户端写出注册表超时」，已改掉。）
 *
 * <h2>机制</h2>
 *
 * 动作把「待登记项」压进本队列并<b>立即返回</b>（结果里如实写 {@code registered=false, deferred=true}）；
 * {@link #pump()} 由 {@code ControlPlaneTickHandler} 每客户端 tick 调一次，直到该项的
 * {@link Pending#ready()} 为真（或超过截止时刻）才真正写盘 + 登记 + 补写 manifest。
 *
 * <p>
 * <b>登记的是最终字节</b>：{@code ready()} 的判据就是「这份文件已经是最终形态」——
 * 场景文件要求能被解析为 {@code documentFormat=Envelope}（客户端 enrich 的产物形态），
 * 注册表要求投递单已被消费且三份文件都在。超时则<b>如实登记当时的字节</b>并附
 * {@code phase} 说明（不静默成功、不假装是终态）。
 *
 * <h2>为什么不用 cp 的作业机制</h2>
 *
 * 那会把「登记产物」变成一个新作业，而 {@code cmd.exec} 的 run 已经由它自己持有（run 由发起方持有：
 * run 归发起方）——再开作业等于让一个 run 有两个所有者。本队列只是同一 run 的<b>写延迟</b>，
 * 不引入第二个所有者。
 */
public final class CommandArtifactRegistrar {

    /** 默认截止（tick；20 tick/s ⇒ 100 tick ≈ 5 s）。 */
    public static final int DEFAULT_DEADLINE_TICKS = 100;

    /** 一条待登记项。 */
    public abstract static class Pending {

        final String runId;
        final String relPath;
        final String role;
        final int deadlineTicks;
        int ticks;

        Pending(String runId, String relPath, String role, int deadlineTicks) {
            this.runId = runId;
            this.relPath = relPath;
            this.role = role;
            this.deadlineTicks = deadlineTicks;
        }

        /** 描述（日志与事件用）。 */
        public abstract String describe();

        /** 是否已可登记（文件已是最终形态）。 */
        public abstract boolean ready();

        /**
         * 取要登记的字节。
         *
         * @return 字节；仍不可用时返回 null（表达「超时了但文件还没出现」）
         */
        public abstract byte[] bytes();

        /** 登记完成后的补充说明（如「超时登记了 scan 中间态」）。 */
        public String phaseNote() {
            return null;
        }
    }

    /** 场景文件待登记项：等客户端 enrich 把它覆盖成 Envelope。 */
    public static final class SceneFile extends Pending {

        private final File src;

        /**
         * @param src           服务端写出的绝对路径（命令回报里给的那个）
         * @param runId         发起方 run
         * @param relPath       run 目录内相对路径
         * @param deadlineTicks 截止 tick
         */
        public SceneFile(File src, String runId, String relPath, int deadlineTicks) {
            super(runId, relPath, "cmd-scene-file", deadlineTicks);
            this.src = src;
        }

        @Override
        public String describe() {
            return "场景文件 " + src.getName();
        }

        @Override
        public boolean ready() {
            byte[] b = bytes();
            if (b == null) {
                return false;
            }
            try {
                JsonObject o = new JsonParser().parse(new String(b, java.nio.charset.StandardCharsets.UTF_8))
                    .getAsJsonObject();
                // 客户端 enrich 的产物形态：Envelope（或显式 raw 的 Plain）。
                // 服务端那份 scan 中间态两者都不是 ⇒ 这就是「还没 enrich」的机械判据。
                String fmt = o.has("documentFormat") ? o.get("documentFormat")
                    .getAsString() : null;
                return "Envelope".equals(fmt) || "Plain".equals(fmt) || "Raw".equals(fmt);
            } catch (RuntimeException e) {
                return false;
            }
        }

        @Override
        public byte[] bytes() {
            try {
                if (!src.isFile()) {
                    return null;
                }
                return Files.readAllBytes(src.toPath());
            } catch (Exception e) {
                return null;
            }
        }

        @Override
        public String phaseNote() {
            byte[] b = bytes();
            if (b == null) {
                return "超时登记：源文件不可读";
            }
            try {
                JsonObject o = new JsonParser().parse(new String(b, java.nio.charset.StandardCharsets.UTF_8))
                    .getAsJsonObject();
                String fmt = o.has("documentFormat") ? o.get("documentFormat")
                    .getAsString() : "(服务端 scan 中间态)";
                return "超时登记：形态=" + fmt + "（客户端 enrich 未在 " + deadlineTicks + " tick 内完成）";
            } catch (RuntimeException e) {
                return "超时登记：源文件不是合法 JSON";
            }
        }
    }

    /** 注册表待登记项：等客户端消费投递单写出三份注册表。 */
    public static final class RegistryFiles extends Pending {

        private final RegistryDumpDelivery.Request request;
        private final File dir;
        private final String[] names;

        /**
         * @param request 投递单（消费后 {@code done()} 为真）
         * @param dir     三份注册表所在目录（run 内 {@code cmd-exec/}）
         * @param names   文件名（按 {@code ExportRegistryAction.FILES} 的顺序）
         */
        public RegistryFiles(RegistryDumpDelivery.Request request, File dir, String[] names, String runId,
            String relPrefix, int deadlineTicks) {
            super(runId, relPrefix, "registry-dump", deadlineTicks);
            this.request = request;
            this.dir = dir;
            this.names = names;
        }

        /** 投递单是否已被客户端消费并成功写出。 */
        public boolean settled() {
            return request.done() && request.error() == null;
        }

        /** 投递单的错误（非 null 表示客户端写出失败）。 */
        public String error() {
            return request.error();
        }

        @Override
        public String describe() {
            return "注册表三份（" + dir.getName() + "）";
        }

        @Override
        public boolean ready() {
            if (!settled()) {
                return false;
            }
            for (String n : names) {
                File f = new File(dir, n);
                if (!f.isFile() || f.length() == 0) {
                    return false;
                }
            }
            return true;
        }

        @Override
        public byte[] bytes() {
            return null; // 注册表是**多份**产物，逐份登记由 pump 特判（见下）
        }
    }

    private static final List<Pending> QUEUE = new ArrayList<Pending>();

    private CommandArtifactRegistrar() {}

    /** 压入一条待登记项。 */
    public static synchronized void enqueue(Pending p) {
        if (p != null) {
            QUEUE.add(p);
        }
    }

    /** 队列长度（诊断）。 */
    public static synchronized int size() {
        return QUEUE.size();
    }

    /**
     * 每客户端 tick 推进一次（由 {@code ControlPlaneTickHandler} 调用）。
     *
     * <p>
     * 全部异常吞掉并记 WARN：本队列是「补齐产物登记」，<b>绝不能</b>因为它的失败影响客户端 tick。
     */
    public static synchronized void pump() {
        if (QUEUE.isEmpty()) {
            return;
        }
        ControlPlaneRuntime rt = ControlPlaneBootstrap.runtime();
        ArtifactStore store = rt == null ? null : rt.artifacts();
        if (store == null) {
            return;
        }
        Iterator<Pending> it = QUEUE.iterator();
        while (it.hasNext()) {
            Pending p = it.next();
            p.ticks++;
            boolean ready;
            try {
                ready = p.ready();
            } catch (Throwable t) {
                CpLog.warn("[SDE][CP] 延迟登记就绪判定异常（%s）: %s", p.describe(), String.valueOf(t));
                ready = false;
            }
            if (!ready && p.ticks < p.deadlineTicks) {
                continue;
            }
            it.remove();
            try {
                register(store, p, ready);
            } catch (Throwable t) {
                CpLog.warn("[SDE][CP] 延迟登记失败（%s）: %s", p.describe(), String.valueOf(t));
            }
        }
    }

    private static void register(ArtifactStore store, Pending p, boolean ready) {
        ArtifactStore.Run run = store.findRun(p.runId);
        if (run == null) {
            CpLog.warn("[SDE][CP] 延迟登记跳过：run %s 已不在内存（%s）", p.runId, p.describe());
            return;
        }
        String phase = ready ? "final" : "timeout";
        String note = ready ? null : p.phaseNote();
        int registered = 0;
        if (p instanceof RegistryFiles) {
            RegistryFiles rf = (RegistryFiles) p;
            if (rf.error() != null && !ready) {
                emit(run, EventStream.LEVEL_WARN, p, "客户端写出注册表失败: " + rf.error(), null, phase);
                return;
            }
            for (String n : rf.names) {
                File f = new File(rf.dir, n);
                if (!f.isFile() || f.length() == 0) {
                    CpLog.warn("[SDE][CP] 延迟登记：注册表缺失 %s", f.getAbsolutePath());
                    continue;
                }
                try {
                    byte[] b = Files.readAllBytes(f.toPath());
                    ArtifactStore.Artifact a = store.writeArtifact(run, rf.relPath + "/" + n, b, roleOf(n));
                    emit(run, EventStream.LEVEL_INFO, p, "注册表已登记: " + a.path(), a, phase);
                    registered++;
                } catch (Exception e) {
                    CpLog.warn("[SDE][CP] 注册表登记失败 %s: %s", n, String.valueOf(e));
                }
            }
        } else {
            byte[] b = p.bytes();
            if (b == null || b.length == 0) {
                emit(run, EventStream.LEVEL_WARN, p, "延迟登记失败：源文件不可读", null, phase);
                return;
            }
            ArtifactStore.Artifact a = store.writeArtifact(run, p.relPath, b, p.role);
            emit(
                run,
                EventStream.LEVEL_INFO,
                p,
                "命令通道产物已登记: " + a.path() + (note == null ? "" : "（" + note + "）"),
                a,
                phase);
            registered++;
        }
        if (registered > 0) {
            // job 早已收尾（manifest 已写过一次），补写一次把延迟登记项落进清单——
            // 不补写就等于「产物在内存里登记过、磁盘清单里没有」，清单端点会看不到它。
            try {
                store.writeManifest(run);
            } catch (Throwable t) {
                CpLog.warn("[SDE][CP] 延迟登记后补写 manifest 失败（%s）: %s", p.runId, String.valueOf(t));
            }
        }
        CpLog.info(
            "[SDE][CP] 命令通道延迟登记完成：%s → run %s（%d 份，%s）",
            p.describe(),
            p.runId,
            Integer.valueOf(registered),
            phase);
    }

    private static String roleOf(String name) {
        if (name.startsWith("block_registry")) return "registry-block";
        if (name.startsWith("material_registry")) return "registry-material";
        if (name.startsWith("model_registry")) return "registry-model";
        return "registry-dump";
    }

    private static void emit(ArtifactStore.Run run, String level, Pending p, String message, ArtifactStore.Artifact a,
        String phase) {
        try {
            ControlPlaneRuntime rt = ControlPlaneBootstrap.runtime();
            if (rt == null || rt.events() == null) {
                return;
            }
            JsonObject data = new JsonObject();
            data.addProperty("runId", run.runId());
            data.addProperty("deferred", true);
            data.addProperty("phase", phase);
            if (a != null) {
                data.addProperty("path", a.path());
                data.addProperty("sha256", a.sha256());
                data.addProperty("bytes", a.bytes());
            }
            rt.events()
                .append(level, "cp-export", CmdExecAction.class.getSimpleName(), null, message, data);
        } catch (Throwable t) {
            CpLog.warn("[SDE][CP] 延迟登记事件落盘失败: %s", String.valueOf(t));
        }
    }

    /** 供测试与诊断：清空队列。 */
    static synchronized void clearForTest() {
        QUEUE.clear();
    }

    /** 供测试：暴露单条项的摘要。 */
    static synchronized List<String> describeForTest() {
        List<String> out = new ArrayList<String>();
        for (Pending p : QUEUE) {
            out.add(p.runId + "|" + p.relPath + "|" + p.ticks + "/" + p.deadlineTicks);
        }
        return out;
    }

    /** {@code sha256} 便捷口（延迟登记里多处要算，集中一处便于口径统一）。 */
    static String sha256(byte[] b) {
        return Hashing.sha256Hex(b);
    }
}
