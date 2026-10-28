package com.lightning.mod.client.meshcapture.env;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 一条环境事实的探针。与逐格捕获的三张策略表同构（{@code priority()} + {@code applies()} + 逐条异常隔离）：
 * 数值小的先跑；{@code applies} 决定这次值不值得跑；写不出的事实保持 {@link Capability#UNKNOWN}。
 * <p>
 * 硬约束：{@link #probe} <strong>不得抛异常</strong>（抛了也只降级该项事实，不中断捕获），
 * <strong>不得改变渲染状态</strong>（自证探针必须在丢弃窗口里跑，窗口关闭即丢弃几何）。
 */
@SideOnly(Side.CLIENT)
public interface CaptureEnvironmentProbe {

    /** 数值越小越先探测。 */
    int priority();

    /** 本次触发是否值得跑。 */
    boolean applies(CaptureProbeContext ctx);

    /** 写事实；写不出的项保持 UNKNOWN。 */
    void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out);
}
