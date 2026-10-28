package com.lightning.mod.client.meshcapture.env.probes;

import java.lang.reflect.Field;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;
import com.lightning.mod.client.meshcapture.env.TesrBatchingState;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 诊断标签：TESR 部件批处理 API 的在场状态。
 * <p>
 * 为什么只读：批处理的 active 区间由它自己的渲染 pass 驱动，而逐格捕获是在 pass 之外直接调分派器，
 * 捕获期读到"空闲"是<strong>常态</strong>。这条事实只用于解释"批处理为什么没有参与这次捕获"，不参与任何行为判断——
 * 捕获期不调用它、不推它的栈、不改它的状态。
 */
@SideOnly(Side.CLIENT)
public final class TesrBatchingProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 500;

    private static final String BATCHER_CLASS = "com.gtnewhorizons.angelica.rendering.tesr.ModelPartBatcher";

    private static final String INSTANCE_FIELD = "INSTANCE";

    private static final String ACTIVE_FIELD = "active";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(CaptureProbeContext ctx) {
        return ctx != null;
    }

    @Override
    public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
        Class<?> batcher;
        try {
            batcher = Class.forName(BATCHER_CLASS, false, TesrBatchingProbe.class.getClassLoader());
        } catch (Throwable t) {
            out.setTesrBatching(TesrBatchingState.ABSENT);
            out.note("tesr_batching: class absent (" + BATCHER_CLASS + ")");
            return;
        }
        try {
            Field instanceField = batcher.getField(INSTANCE_FIELD);
            Object instance = instanceField.get(null);
            if (instance == null) {
                out.setTesrBatching(TesrBatchingState.PRESENT_IDLE);
                out.note("tesr_batching: instance absent");
                return;
            }
            boolean active = readActive(instance);
            out.setTesrBatching(active ? TesrBatchingState.PRESENT_ACTIVE : TesrBatchingState.PRESENT_IDLE);
            out.note("tesr_batching: active=" + active);
        } catch (Throwable t) {
            // 类在、但状态读不出：仍报"在场"，状态取空闲（不猜"活跃"，活跃会让人误以为捕获期有批处理参与）
            out.setTesrBatching(TesrBatchingState.PRESENT_IDLE);
            out.note("tesr_batching: state unreadable (" + t + ")");
        }
    }

    /**
     * 只读它的 active 标志。该字段既可能是实例字段也可能是静态字段（不同版本实现不同），故按修饰符取：
     * 静态取 {@code null} 目标，实例取它自己的实例——传错目标会直接 NPE，读数就永远停在"状态不可读"。
     */
    private static boolean readActive(Object instance) throws Exception {
        for (Class<?> c = instance.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(ACTIVE_FIELD);
                f.setAccessible(true);
                Object target = java.lang.reflect.Modifier.isStatic(f.getModifiers()) ? null : instance;
                return f.getBoolean(target);
            } catch (NoSuchFieldException ignored) {
                // 继续向上找
            }
        }
        throw new NoSuchFieldException(ACTIVE_FIELD);
    }
}
