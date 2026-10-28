package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.ActionSteppingExecutor;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlPlaneServer;
import com.lightning.mod.client.controlplane.core.CoreEndpoints;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.JobQueue;
import com.lightning.mod.client.controlplane.core.JobRegistry;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Router;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.core.TokenStore;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl;
import com.lightning.mod.config.SdeControlPlaneConfig;

import cpw.mods.fml.common.FMLCommonHandler;

/**
 * 控制面静态装配（contract.md §14）。
 *
 * <p>
 * 装配顺序（每个组件只依赖它前面的）：
 *
 * <pre>
 * dataDir = &lt;mcDataDir&gt;/controlplane
 * EventStream(events.jsonl) → TokenStore.generate()+save(tokens.json) → ArtifactStore(runs/)
 * → ActionRegistry + ActionRegistrar.registerAll(8 动作)
 * → JobRegistry → JobQueue.setStepper(ActionSteppingExecutor) → Router → CoreEndpoints.registerAll()
 * → ControlPlaneServer.start() → setShutdownCleanup(进程退出尽力释放) → installShutdownHook()
 * → 注册 ControlPlaneTickHandler 到 FML 总线
 * → 注册 ServerBuildPump（服务端 tick 线程推进场景构建）
 * </pre>
 *
 * <p>
 * 三条不可放宽的边界都在这里落实：<b>默认关闭</b>（{@link SdeControlPlaneConfig#isEnabled()}，
 * 含 JVM 属性覆盖）、<b>默认仅回环</b>（非回环打 WARN）、<b>不存在空 token 放行</b>
 * （每次启动随机生成三级 token，写 {@code tokens.json}）。
 *
 * <p>
 * 启动失败（端口全被占、目录不可写等）只记 ERROR，绝不让控制面把游戏拖崩——调用方
 * （{@code ClientProxy}）也不会因此中断后续初始化。
 */
public final class ControlPlaneBootstrap {

    private static ControlPlaneRuntime runtime;
    private static ControlPlaneTickHandler tickHandler;
    private static EventStream events;
    private static ControlPlaneServer server;
    private static String failureReason;

    private ControlPlaneBootstrap() {}

    /** 是否已成功启动。 */
    public static synchronized boolean isStarted() {
        return runtime != null;
    }

    /** 启动失败的原因；未失败时 null。 */
    public static synchronized String failureReason() {
        return failureReason;
    }

    /** 运行态句柄；未启动时 null。 */
    public static synchronized ControlPlaneRuntime runtime() {
        return runtime;
    }

    /** 作业队列（tick 排空器用）；未启动时 null。 */
    public static JobQueue queue() {
        ControlPlaneRuntime r = runtime();
        return r == null ? null : r.queue();
    }

    /**
     * 按配置启动控制面（幂等）。
     *
     * <p>
     * 由 {@code ClientProxy.initNetwork()} 在 {@link SdeControlPlaneConfig#isEnabled()} 为真时调用。
     *
     * @return 是否已处于运行状态
     */
    public static synchronized boolean start(Minecraft mc) {
        if (runtime != null) {
            return true;
        }
        if (mc == null) {
            failureReason = "Minecraft 实例不可用";
            CpLog.error(null, "控制面启动失败：%s", failureReason);
            return false;
        }
        failureReason = null;
        File mcDataDir = mc.mcDataDir;
        Path dataDir = CpPaths.dataDir(mcDataDir);
        try {
            Files.createDirectories(dataDir);
            Files.createDirectories(CpPaths.runsRoot(mcDataDir));
            Files.createDirectories(CpPaths.snapshotsRoot(mcDataDir));
            Files.createDirectories(CpPaths.casesRoot(mcDataDir));
        } catch (IOException e) {
            failureReason = "无法创建控制面数据目录 " + dataDir + " / " + e;
            CpLog.error(e, "控制面启动失败：%s", failureReason);
            return false;
        }

        events = new EventStream(CpPaths.eventsFile(mcDataDir), CpLog.coreSink());

        // TE 补全器/描述器的模组族注册（contract.md §10 第 6 条的 v1.2 注册表：vanilla/lp-pipe/ae2-part）。
        // 缺席的模组只跳过注册并 WARN——注册动作本身永不失败（ModTeFamilies，全反射探测）。
        ModTeFamilies.registerAll();

        // token 每次启动随机生成：不存在空 token 放行（contract.md §2 第 1 条）
        TokenStore tokens = TokenStore.generate();
        try {
            tokens.save(
                TokenStore.defaultFile(dataDir),
                TimeSource.system()
                    .isoNow());
        } catch (IOException e) {
            failureReason = "写 tokens.json 失败: " + e;
            CpLog.error(e, "控制面启动失败：%s", failureReason);
            return false;
        }

        ArtifactStore artifacts = new ArtifactStore(CpPaths.runsRoot(mcDataDir), null, CpLog.coreSink());
        ActionRegistry actions = new ActionRegistry(Contract.VERSION);
        JobRegistry jobs = new JobRegistry();
        JobQueue queue = new JobQueue(jobs, events, CpLog.coreSink());
        // 只用步进执行器：它同时兼容同步注册的动作（见 ActionSteppingExecutor 类注释）
        queue.setStepper(new ActionSteppingExecutor(actions, artifacts, events, CpLog.coreSink()));

        Router router = new Router(tokens, events, CpLog.coreSink());

        ControlPlaneServer srv = new ControlPlaneServer(
            ControlPlaneServer.Config.builder()
                .port(SdeControlPlaneConfig.port())
                .bind(SdeControlPlaneConfig.bind())
                .dataDir(dataDir)
                .contractVersion(Contract.VERSION)
                .tokens(tokens)
                .router(router)
                .events(events)
                .logger(CpLog.coreSink())
                .build());

        final ControlPlaneRuntime rt = new ControlPlaneRuntime(
            mcDataDir,
            srv,
            actions,
            queue,
            jobs,
            events,
            artifacts,
            tokens);
        ActionRegistrar.registerAll(rt, actions);

        CoreEndpoints.builder()
            .router(router)
            .actions(actions)
            .queue(queue)
            .jobs(jobs)
            .events(events)
            .artifacts(artifacts)
            .logFile(CpPaths.clientLogFile(mcDataDir))
            .serverInfo(new CoreEndpoints.ServerInfo() {

                @Override
                public boolean running() {
                    return rt.server() != null && rt.server()
                        .isRunning();
                }

                @Override
                public int boundPort() {
                    return rt.server() == null ? 0
                        : rt.server()
                            .boundPort();
                }

                @Override
                public String bindAddress() {
                    return rt.server() == null ? SdeControlPlaneConfig.bind()
                        : rt.server()
                            .bindAddress();
                }

                @Override
                public long uptimeMillis() {
                    return rt.server() == null ? 0L
                        : rt.server()
                            .uptimeMillis();
                }
            })
            .about(new CoreEndpoints.AboutContributor() {

                @Override
                public void contribute(JsonObject about) {
                    // HTTP 线程：只读 tick 线程刷新的快照，绝不触碰 MC 状态（contract.md §8 第 1 条）
                    about.add("versions", VersionInfo.aboutVersions());
                    about.addProperty(
                        "dataDir",
                        rt.dataDir()
                            .toString());
                    CpAboutSnapshot.contribute(about);
                }
            })
            .logger(CpLog.coreSink())
            .build()
            .registerAll();

        if (!isLoopback(SdeControlPlaneConfig.bind())) {
            CpLog.warn("控制面绑定非回环地址 %s：契约 §1 第 3 条要求显式配置并留痕；请确认这是预期的暴露面", SdeControlPlaneConfig.bind());
        }
        try {
            srv.start();
        } catch (IOException e) {
            failureReason = "控制面 HTTP 启动失败: " + e;
            CpLog.error(e, "控制面启动失败：%s", failureReason);
            return false;
        }

        // 进程正常退出的 best-effort 输入清理（input-contract.md §3.4 路径 5）：挂到**既有**的
        // shutdown hook 上（core 层只留回调口，本层才知道输入设施）。整段 try/catch 由钩子兜底
        // （core/ControlPlaneServer.runShutdownCleanup：吞掉一切异常、只 WARN 一次），这里只提供
        // 「经唯一实现点（InputRuntimeImpl.shared() 的释放入口）投递抬起」这一件事。
        srv.setShutdownCleanup(new Runnable() {

            @Override
            public void run() {
                // 退出钩子不在 tick 线程上 ⇒ 走 releaseAllForShutdown（不校验 owner 线程的
                // best-effort 入口；直接调 releaseAll() 在真的持有按键时必然抛）
                InputRuntimeImpl.shared()
                    .releaseAllForShutdown();
            }
        });

        srv.installShutdownHook();
        server = srv;
        runtime = rt;
        // about 的 MC 相关字段快照：启动时先采一次，之后由 tick 处理器周期性刷新
        CpAboutSnapshot.refresh(mc);

        ControlPlaneTickHandler handler = new ControlPlaneTickHandler();
        // ClientTickEvent（1.7.10）由 FML 总线派发，勿注册到 MinecraftForge.EVENT_BUS。
        FMLCommonHandler.instance()
            .bus()
            .register(handler);
        tickHandler = handler;

        // 场景构建泵：把 SceneBuilder 的逐 tick 推进搬到服务端 tick 线程
        // （ServerTickEvent / Phase.END）。控制面是客户端独占装配，本注册只在这里发生一次；
        // 单例保证两个入口（case.run 的 build 段、world.rebuild 的 BUILD 段）共用同一个槽位。
        FMLCommonHandler.instance()
            .bus()
            .register(ServerBuildPump.instance());

        CpLog.info(
            "控制面已启用：http://%s:%d%s（dataDir=%s，token 见 tokens.json）",
            SdeControlPlaneConfig.bind(),
            Integer.valueOf(srv.boundPort()),
            Contract.PREFIX,
            dataDir);
        events.append(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.SERVER_START,
            null,
            null,
            "控制面装配完成",
            Json.object(
                "port",
                Integer.valueOf(srv.boundPort()),
                "bind",
                SdeControlPlaneConfig.bind(),
                "contractVersion",
                Contract.VERSION));
        return true;
    }

    /** 停止控制面（幂等；也可由 shutdown hook 触发）。 */
    public static synchronized void stop() {
        if (server != null) {
            server.stop();
        }
        if (events != null) {
            events.close();
        }
        server = null;
        runtime = null;
        tickHandler = null;
    }

    /** tick 处理器（诊断用）。 */
    static ControlPlaneTickHandler tickHandler() {
        return tickHandler;
    }

    private static boolean isLoopback(String bind) {
        try {
            return java.net.InetAddress.getByName(bind)
                .isLoopbackAddress();
        } catch (Throwable t) {
            return false;
        }
    }
}
