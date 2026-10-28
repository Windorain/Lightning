package com.lightning.mod.client.meshcapture.env;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 探针写入点：一次探测期间的<strong>可变</strong>事实袋，探测结束即冻结成 {@link CaptureEnvironment}。
 * <p>
 * 为什么事实只有这几条：它们各自回答一个"这次运行里能不能录到"的问题，且都能由<strong>行为自证</strong>
 * （在丢弃窗口里真渲染一次再数四边形）或<strong>只读反射</strong>得到。任何需要"认出某个模组/某个版本"才能回答的
 * 问题都不进本层——那种判据在多模组混装下必然失准，且会把兜底逻辑绑到别人的实现细节上。
 * <p>
 * 三个能力型事实（{@link Fact#TESSELLATOR_VERTICES}、{@link Fact#DIRECT_TESSELLATOR_VERTICES}、
 * {@link Fact#MODEL_RENDERER_GEOMETRY}）的取值是 {@link Capability}；另外两条是纯诊断标签：
 * {@link Fact#MODEL_RENDERER_HANDLERS} 是"调用点上现在有谁"的方法名集合（不参与行为），
 * {@link Fact#TESR_BATCHING_API} 是批处理在场状态（不参与行为）。
 * <p>
 * 另有一条"开关可得性"事实（箱子 TESR 网格缓存能否在捕获窗口内临时拨动），取值是 {@link TogglePresence}：
 * 它与能力型事实分开，因为回答的问题不是"通道能不能录到"，而是"我们能不能在不破坏常态渲染的前提下，
 * 在窗口内把另一套实现逼回 Java 几何路径"。只有 {@link TogglePresence#PRESENT} 才允许拨动。
 */
@SideOnly(Side.CLIENT)
public final class CaptureEnvironmentFacts {

    /** 本层能回答的事实项。 */
    public enum Fact {

        /** 主 {@code Tessellator} 顶点通道整体是否可用（为否时所有逐格捕获都不必再试）。 */
        TESSELLATOR_VERTICES,
        /** {@code DirectTessellator} 通道是否在场并确实进过顶点。 */
        DIRECT_TESSELLATOR_VERTICES,
        /** {@code ModelRenderer} 的模型几何能不能在捕获窗口里被录到（决定"族 A"能否被救回来）。 */
        MODEL_RENDERER_GEOMETRY,
        /** {@code ModelRenderer} 上现有的外部处理器方法名（诊断标签，不参与行为）。 */
        MODEL_RENDERER_HANDLERS,
        /** TESR 部件批处理 API 的在场状态（诊断标签，不参与行为）。 */
        TESR_BATCHING_API
    }

    private final EnumMap<Fact, Capability> capabilities = new EnumMap<Fact, Capability>(Fact.class);
    private final List<String> notes = new ArrayList<String>();
    private List<String> handlers;
    private TesrBatchingState tesrBatching = TesrBatchingState.UNKNOWN;
    private TogglePresence chestCacheToggle = TogglePresence.UNKNOWN;
    private ModelAccessPresence tankModelAccess = ModelAccessPresence.UNKNOWN;

    public CaptureEnvironmentFacts() {
        for (Fact f : Fact.values()) {
            capabilities.put(f, Capability.UNKNOWN);
        }
    }

    /** 写一条能力型事实；传 {@code null} 等同不写（保持原值）。 */
    public void setCapability(Fact fact, Capability value) {
        if (fact != null && value != null) {
            capabilities.put(fact, value);
        }
    }

    public Capability capability(Fact fact) {
        Capability c = fact == null ? null : capabilities.get(fact);
        return c != null ? c : Capability.UNKNOWN;
    }

    /** 外部处理器方法名集合；{@code null} = 本次没有采集（与"采集到空集"不同）。 */
    public void setHandlers(List<String> names) {
        handlers = names == null ? null : Collections.unmodifiableList(new ArrayList<String>(names));
    }

    public List<String> handlers() {
        return handlers;
    }

    public void setTesrBatching(TesrBatchingState state) {
        if (state != null) {
            tesrBatching = state;
        }
    }

    public TesrBatchingState tesrBatching() {
        return tesrBatching;
    }

    /** 箱子 TESR 网格缓存开关的可得性；默认 {@link TogglePresence#UNKNOWN}。 */
    public void setChestCacheToggle(TogglePresence presence) {
        if (presence != null) {
            chestCacheToggle = presence;
        }
    }

    public TogglePresence chestCacheToggle() {
        return chestCacheToggle;
    }

    /** 某族渲染器的模型数据可得性；默认 {@link ModelAccessPresence#UNKNOWN}。 */
    public void setTankModelAccess(ModelAccessPresence presence) {
        if (presence != null) {
            tankModelAccess = presence;
        }
    }

    public ModelAccessPresence tankModelAccess() {
        return tankModelAccess;
    }

    /** 一行说明（探针的读数、降级原因、异常摘要）；只进日志与诊断快照，不参与任何判断。 */
    public void note(String line) {
        if (line != null && !line.isEmpty()) {
            notes.add(line);
        }
    }

    public List<String> notes() {
        return Collections.unmodifiableList(notes);
    }

    /** 冻结成不可变快照。 {@code generation} 由注册表递增，用于区分"同一份快照"与"重跑过"。 */
    public CaptureEnvironment toEnvironment(long generation) {
        EnumMap<Fact, Capability> copy = new EnumMap<Fact, Capability>(Fact.class);
        for (Map.Entry<Fact, Capability> e : capabilities.entrySet()) {
            copy.put(e.getKey(), e.getValue());
        }
        return new CaptureEnvironment(
            copy,
            handlers,
            tesrBatching,
            chestCacheToggle,
            tankModelAccess,
            notes,
            generation);
    }
}
