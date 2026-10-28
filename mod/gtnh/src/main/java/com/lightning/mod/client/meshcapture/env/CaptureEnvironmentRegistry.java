package com.lightning.mod.client.meshcapture.env;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.lightning.mod.client.meshcapture.env.probes.AngelicaChestCacheToggleProbe;
import com.lightning.mod.client.meshcapture.env.probes.DirectTessellatorProbe;
import com.lightning.mod.client.meshcapture.env.probes.EnderStorageTankModelProbe;
import com.lightning.mod.client.meshcapture.env.probes.ModelRendererHandlerProbe;
import com.lightning.mod.client.meshcapture.env.probes.ModelRendererInlineProbe;
import com.lightning.mod.client.meshcapture.env.probes.TesrBatchingProbe;
import com.lightning.mod.client.meshcapture.env.probes.TessellatorVertexProbe;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 环境事实注册表：按 {@link CaptureEnvironmentProbe#priority()} 升序跑 {@code applies} 命中的探针，产出一份
 * 不可变的 {@link CaptureEnvironment} 快照并缓存。
 * <p>
 * 与逐格捕获的三张策略表同构（{@link CopyOnWriteArrayList} + 静态注册 + 优先级升序 + {@code applies} 过滤 +
 * 逐条 {@code catch (Throwable)} 隔离）；两处差异：产物是"能画什么"的<strong>快照</strong>而非"画了什么"，
 * 因此带缓存与失效，而不是每次调用重算。
 * <p>
 * 成本模型：一次会话只做一次全面探测（两次极小规模渲染），逐格只读 {@link #current()}（零成本）。
 * 单个探针抛错只降级它自己写的事实，不影响其它探针，也不影响捕获流程。
 */
@SideOnly(Side.CLIENT)
public final class CaptureEnvironmentRegistry {

    private static final CopyOnWriteArrayList<CaptureEnvironmentProbe> PROBES = new CopyOnWriteArrayList<CaptureEnvironmentProbe>();

    private static final Object LOCK = new Object();

    private static volatile CaptureEnvironment cached;

    private static long generation;

    /** 内置探针的原始集合：单测用它把注册表复原，避免用例之间互相污染。 */
    private static final List<CaptureEnvironmentProbe> BUILT_IN_PROBES;

    static {
        register(new TessellatorVertexProbe());
        register(new DirectTessellatorProbe());
        register(new ModelRendererInlineProbe());
        register(new ModelRendererHandlerProbe());
        register(new TesrBatchingProbe());
        register(new AngelicaChestCacheToggleProbe());
        register(new EnderStorageTankModelProbe());
        BUILT_IN_PROBES = Collections.unmodifiableList(new ArrayList<CaptureEnvironmentProbe>(PROBES));
    }

    private CaptureEnvironmentRegistry() {}

    /** 注册探针；集成模组在客户端 init 调用即可。 */
    public static void register(CaptureEnvironmentProbe probe) {
        if (probe != null) {
            PROBES.add(probe);
        }
    }

    /**
     * 跑一次探测并返回快照。
     *
     * @param ctx   触发上下文；{@code null} 视为 GL 不可用（保守）
     * @param force {@code true} = 无视缓存重跑（显式诊断请求）
     * @return 不可变快照；已缓存且未要求重跑时直接返回缓存
     */
    public static CaptureEnvironment snapshot(CaptureProbeContext ctx, boolean force) {
        CaptureEnvironment hit = cached;
        if (!force && hit != null) {
            return hit;
        }
        CaptureProbeContext effective = ctx != null ? ctx : CaptureProbeContext.unavailable("null_context");
        synchronized (LOCK) {
            if (!force && cached != null) {
                return cached;
            }
            CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
            List<CaptureEnvironmentProbe> sorted = new ArrayList<CaptureEnvironmentProbe>(PROBES);
            sorted.sort(Comparator.comparingInt(CaptureEnvironmentProbe::priority));
            for (CaptureEnvironmentProbe p : sorted) {
                try {
                    if (!p.applies(effective)) {
                        continue;
                    }
                } catch (Throwable t) {
                    facts.note(
                        "probe_applies_failed:" + p.getClass()
                            .getName() + ":" + t);
                    continue;
                }
                try {
                    p.probe(effective, facts);
                } catch (Throwable t) {
                    // 单个探针失败只降级事实，不中断其它探针、更不中断捕获
                    facts.note(
                        "probe_failed:" + p.getClass()
                            .getName() + ":" + t);
                }
            }
            if (!effective.glContextAvailable() && !effective.unavailableReason()
                .isEmpty()) {
                facts.note("gl_context_unavailable:" + effective.unavailableReason());
            }
            generation++;
            CaptureEnvironment snapshot = facts.toEnvironment(generation);
            cached = snapshot;
            return snapshot;
        }
    }

    /**
     * 最近一次快照；从未探测时返回"全 UNKNOWN"的保守快照并留一条说明。
     * 逐格捕获只调本方法，因此它必须是零成本的。
     */
    public static CaptureEnvironment current() {
        CaptureEnvironment hit = cached;
        if (hit != null) {
            return hit;
        }
        return CaptureEnvironment.allUnknown("probe_never_ran");
    }

    /**
     * 让缓存失效（下一次 {@link #snapshot} 重跑）。用于"环境可能变了"的场合：资源重载、模组晚注册、
     * 显示列表被外部清空等——本层不猜测何时发生，只提供显式入口。
     */
    public static void invalidate(String reason) {
        synchronized (LOCK) {
            cached = null;
        }
        logBestEffort("[SDE][capture-env] 事实快照已失效，下次探测重跑：%s", String.valueOf(reason));
    }

    /** 已注册探针数（诊断/自检用）。 */
    public static int probeCount() {
        return PROBES.size();
    }

    /** 单测专用：把注册表复原成内置探针集合并清掉缓存与代次。 */
    public static void resetProbesForTesting() {
        PROBES.clear();
        PROBES.addAll(BUILT_IN_PROBES);
        resetCacheForTesting();
    }

    /** 单测专用：清掉缓存与代次（不动注册表）。 */
    public static void resetCacheForTesting() {
        synchronized (LOCK) {
            cached = null;
            generation = 0L;
        }
    }

    private static void logBestEffort(String format, Object arg) {
        try {
            FMLLog.info(format, arg);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }
}
