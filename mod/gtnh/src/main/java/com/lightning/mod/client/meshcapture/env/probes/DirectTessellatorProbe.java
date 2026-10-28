package com.lightning.mod.client.meshcapture.env.probes;

import com.lightning.mod.client.meshcapture.CaptureDiagnostics;
import com.lightning.mod.client.meshcapture.env.Capability;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * {@code DirectTessellator} 通道是否在场：类存在性 + 既有的"本会话是否真见过这条通道的顶点"一次性自检位。
 * <p>
 * <strong>不主动造流量</strong>：该通道只服务少数模组的自建顶点缓冲，主动触发一次渲染会把探针绑到具体模组的渲染条件上。
 * 因此三种结果都是有意义的：类不在 ⇒ {@link Capability#NOT_PRESENT}（这条通道本来就没有）；类在且本会话已见过顶点 ⇒
 * {@link Capability#CAN_CAPTURE}；类在但还没见过流量 ⇒ {@link Capability#UNKNOWN}（"没采到"不等于"采不到"）。
 */
@SideOnly(Side.CLIENT)
public final class DirectTessellatorProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 200;

    /** 与捕获钩子打在同一个类上：存在性判据必须与录制点同源，否则会给出"通道在但录不到"的假事实。 */
    private static final String DIRECT_TESSELLATOR_CLASS = "com.gtnewhorizon.gtnhlib.client.renderer.DirectTessellator";

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
        if (!isClassPresent(DIRECT_TESSELLATOR_CLASS)) {
            out.setCapability(Fact.DIRECT_TESSELLATOR_VERTICES, Capability.NOT_PRESENT);
            out.note("direct_tessellator: class absent (" + DIRECT_TESSELLATOR_CLASS + ")");
            return;
        }
        if (CaptureDiagnostics.isDirectTessellatorHookEverSeen()) {
            out.setCapability(Fact.DIRECT_TESSELLATOR_VERTICES, Capability.CAN_CAPTURE);
            out.note("direct_tessellator: vertices observed this session");
            return;
        }
        out.setCapability(Fact.DIRECT_TESSELLATOR_VERTICES, Capability.UNKNOWN);
        out.note("direct_tessellator: class present, no vertex observed yet");
    }

    private static boolean isClassPresent(String name) {
        try {
            Class.forName(name, false, DirectTessellatorProbe.class.getClassLoader());
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
