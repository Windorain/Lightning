package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.nio.file.Path;

import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.ControlPlaneServer;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Job;
import com.lightning.mod.client.controlplane.core.JobQueue;
import com.lightning.mod.client.controlplane.core.JobRegistry;
import com.lightning.mod.client.controlplane.core.TokenStore;

/**
 * 已装配的控制面运行态（不可变句柄集合）。
 *
 * <p>
 * {@link ControlPlaneBootstrap} 装配一次、交给动作实现只读使用；动作因此不依赖任何静态单例，
 * 装配顺序与依赖关系在一个地方看得清。
 */
public final class ControlPlaneRuntime {

    private final File mcDataDir;
    private final ControlPlaneServer server;
    private final ActionRegistry actions;
    private final JobQueue queue;
    private final JobRegistry jobs;
    private final EventStream events;
    private final ArtifactStore artifacts;
    private final TokenStore tokens;

    /** 全参构造（各组件由 Bootstrap 装配后注入）。 */
    public ControlPlaneRuntime(File mcDataDir, ControlPlaneServer server, ActionRegistry actions, JobQueue queue,
        JobRegistry jobs, EventStream events, ArtifactStore artifacts, TokenStore tokens) {
        this.mcDataDir = mcDataDir;
        this.server = server;
        this.actions = actions;
        this.queue = queue;
        this.jobs = jobs;
        this.events = events;
        this.artifacts = artifacts;
        this.tokens = tokens;
    }

    /** 客户端数据目录。 */
    public File mcDataDir() {
        return mcDataDir;
    }

    /** 控制面数据目录 {@code <mcDataDir>/controlplane}。 */
    public Path dataDir() {
        return CpPaths.dataDir(mcDataDir);
    }

    /** 用例文件默认目录。 */
    public Path casesRoot() {
        return CpPaths.casesRoot(mcDataDir);
    }

    /** 快照根目录。 */
    public Path snapshotsRoot() {
        return CpPaths.snapshotsRoot(mcDataDir);
    }

    /** HTTP 服务。 */
    public ControlPlaneServer server() {
        return server;
    }

    /** 动作注册表。 */
    public ActionRegistry actions() {
        return actions;
    }

    /** 作业队列。 */
    public JobQueue queue() {
        return queue;
    }

    /** 作业登记表。 */
    public JobRegistry jobs() {
        return jobs;
    }

    /** 事件流水。 */
    public EventStream events() {
        return events;
    }

    /** 产物仓库。 */
    public ArtifactStore artifacts() {
        return artifacts;
    }

    /** token 仓库。 */
    public TokenStore tokens() {
        return tokens;
    }

    /** 当前是否有动作在队/在跑。 */
    public boolean busy() {
        return queue != null && queue.isBusy();
    }

    /** 当前作业；空闲时 null。 */
    public Job currentJob() {
        return queue == null ? null : queue.current();
    }
}
