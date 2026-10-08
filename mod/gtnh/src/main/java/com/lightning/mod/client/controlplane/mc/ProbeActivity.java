package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.lightning.mod.client.controlplane.core.Job;
import com.lightning.mod.client.controlplane.core.JobQueue;

/**
 * 控制面自身忙闲（contract.md §9 的「单向避让」判据；<b>#104 后语义变更</b>）。
 *
 * <h2>老语义（#104 之前）</h2>
 *
 * 六（实为七）条既有自动化链各自有自己的 {@code isRequested(mc)} 判据（只读 {@code <mcDataDir>}
 * 下的触发文件）。控制面不改动它们，只在排空前问一句「现在有没有老探针在跑」，有就不排空——
 * 单向避让，避免两套自动化在同一 tick 里同时动世界与玩家。{@code probeActive} 暴露的就是这个原因。
 *
 * <h2>新语义（#104 之后）</h2>
 *
 * Gitea #104 把老批处理设施<b>整体删除</b>了：10 个自动化入口、tick 接管链、9 个触发文件约定、
 * 5 个专用世界目录、{@code SdeClientAutomationTickHandler} 全部分派分支都不存在了。因此：
 *
 * <ul>
 * <li><b>老探针设施已随 #104 删除</b>——本类<b>不再探测任何外部触发文件</b>，也不再与任何
 * 第三方自动化争 tick（控制面是唯一驱动世界的自动化）；</li>
 * <li>{@code probeActive} / {@code probe} 两个字段<b>保留不删</b>（删字段是契约破坏性变更，
 * 契约 1.7 的形状必须稳定）。语义改为「<b>控制面自身忙闲</b>」：
 * {@code probeActive} = 是否有控制面作业在队/在跑（与 {@code busy} 同源）；
 * {@code probe} = <b>恒为 null</b>（老探针名已不存在，字段恒空是这条语义的唯一诚实取值）；</li>
 * <li>本类因此不再读文件系统：唯一真值来源是 {@link JobQueue#isBusy()}。</li>
 * </ul>
 *
 * <h2>为什么 {@code firstActive} 保留但仍存在</h2>
 *
 * 三个消费方（{@code core.ping} / {@code core.status} / {@code /cp/v1/about}）都按
 * 「{@code probe != null}」的旧形状组装字段。保留一个恒返回 {@code null} 的入口，
 * 使「字段还在、但恒空」这件事在代码里是显式的、可检索的，而不是让调用方各自硬编码 {@code null}。
 *
 * @see ControlPlaneTickHandler
 */
public final class ProbeActivity {

    private ProbeActivity() {}

    /**
     * 控制面自身是否忙（有作业在队/在跑）。
     *
     * <p>
     * {@code mc} 参数保留是为了让签名与调用点不必变动，也为将来出现「只在与 MC 状态有关时才忙」
     * 的判据留位；当前实现不读 MC 状态（可安全地从任意线程调用）。
     */
    public static boolean any(Minecraft mc) {
        JobQueue queue = ControlPlaneBootstrap.queue();
        return queue != null && queue.isBusy();
    }

    /**
     * 恒返回 {@code null}：老探针设施已随 Gitea #104 删除，不再有「激活中的探针名」。
     *
     * <p>
     * <b>不要</b>把它改回读触发文件——契约字段 {@code probe} 的语义已由 #104 裁决为「恒空」，
     * 老设施目录（{@code client/meshcapture/parts/probe}、{@code client/multiblock} 的
     * {@code *Automation} 族）与 {@code client/automation/} 均已整体删除。
     */
    public static String firstActive(Minecraft mc) {
        return null;
    }

    /** 当前在队/在跑的作业 id；空闲时 null（诊断用，不进契约字段）。 */
    public static String currentJobId() {
        JobQueue queue = ControlPlaneBootstrap.queue();
        Job cur = queue == null ? null : queue.current();
        return cur == null ? null : cur.jobId();
    }
}
