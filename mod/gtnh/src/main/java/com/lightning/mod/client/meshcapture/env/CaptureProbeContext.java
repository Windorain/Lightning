package com.lightning.mod.client.meshcapture.env;

import net.minecraft.client.Minecraft;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 触发一次探测所需的上下文：只描述"现在能不能做需要 GL 的事"，不携带任何方块/格子的信息。
 * <p>
 * 为什么要显式判可用性：自证探针要真渲染、真数顶点，只能发生在客户端线程且世界已加载时；
 * 过早调用时它们必须记 {@link Capability#UNKNOWN} 而不是崩掉启动。
 * 需要 GL 的探针在 {@code applies} 或 {@code probe} 里读 {@link #glContextAvailable()}。
 */
@SideOnly(Side.CLIENT)
public final class CaptureProbeContext {

    private final boolean glContextAvailable;
    private final boolean forced;
    private final long sessionId;
    private final String unavailableReason;

    private CaptureProbeContext(boolean glContextAvailable, boolean forced, long sessionId, String unavailableReason) {
        this.glContextAvailable = glContextAvailable;
        this.forced = forced;
        this.sessionId = sessionId;
        this.unavailableReason = unavailableReason != null ? unavailableReason : "";
    }

    /**
     * 捕获会话开始时的上下文：现场探测 GL 是否可用（世界已加载且渲染器在场）。
     * 任何异常都按"不可用"处理——探测不得扩大捕获流程的失败面。
     */
    public static CaptureProbeContext captureSession(long sessionId, boolean forced) {
        boolean ready;
        String reason = "";
        try {
            Minecraft mc = Minecraft.getMinecraft();
            ready = mc != null && mc.theWorld != null && mc.renderGlobal != null;
            if (!ready) {
                reason = "world_or_renderer_not_ready";
            }
        } catch (Throwable t) {
            ready = false;
            reason = "client_state_unreadable: " + t;
        }
        return new CaptureProbeContext(ready, forced, sessionId, reason);
    }

    /** 明确不可用的上下文（过早调用、非客户端线程、单测）。 */
    public static CaptureProbeContext unavailable(String reason) {
        return new CaptureProbeContext(false, false, 0L, reason);
    }

    /** 单测用：不触碰任何客户端状态的上下文。 */
    public static CaptureProbeContext forTesting(long sessionId) {
        return new CaptureProbeContext(false, false, sessionId, "testing");
    }

    public boolean glContextAvailable() {
        return glContextAvailable;
    }

    /** 是否为显式诊断请求触发的强制重跑。 */
    public boolean isForced() {
        return forced;
    }

    public long sessionId() {
        return sessionId;
    }

    /** GL 不可用时的原因（为空表示可用）。 */
    public String unavailableReason() {
        return unavailableReason;
    }
}
