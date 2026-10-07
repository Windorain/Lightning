package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Job;
import com.lightning.mod.client.controlplane.core.JobQueue;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.cmd.CommandArtifactRegistrar;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import cpw.mods.fml.relauncher.Side;

/**
 * 控制面 tick 排空器（contract.md §1.8）。
 *
 * <p>
 * HTTP 线程只解析/鉴权/入队；真正的动作在<b>客户端 tick 线程</b>执行：每个 tick
 * （{@link TickEvent.Phase#END}）调一次 {@link JobQueue#drainOne()}，步进动作因此可以跨 tick 推进。
 *
 * <h2>单向避让（contract.md §9）</h2>
 * 既有六条触发文件自动化链任一激活时（{@link ProbeActivity#any}），<b>不排空</b>：让出 tick，
 * 不动世界、不动玩家。控制面因此不需要、也<b>不允许</b>改动既有探针代码。
 *
 * <p>
 * 注意（契约缺口，见交付报告）：契约要求此时新提交的动作返回 {@code CP-BUSY-001}，
 * 但 core 的 {@code JobQueue} 只在「已有作业在队/在跑」时拒绝提交，没有「前置状态禁止执行」的钩子，
 * 因此在探针激活期间提交的动作会<b>排队等待</b>（探针结束后自动开跑），而不是被拒。
 * 本类在探针激活且队列非空时打一条 WARN 与一条事件，避免调用方以为动作已经跑了。
 */
public final class ControlPlaneTickHandler {

    /** 避免同一作业重复打「被探针挡住」的告警。 */
    private String lastBlockedJobId;

    /** 快照刷新节拍。 */
    private int tickCounter;

    /** 每个客户端 tick 的排空。 */
    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent e) {
        if (e == null || e.side != Side.CLIENT || e.phase != TickEvent.Phase.END) {
            return;
        }
        try {
            Minecraft mc = Minecraft.getMinecraft();
            // 场景会话期间：清掉失焦暂停菜单/聊天框/FML 通知（#55 坑 11 防护）
            SceneSessionGuard.onTick(mc);

            JobQueue queue = ControlPlaneBootstrap.queue();
            if (queue == null) {
                return;
            }
            // 命令通道产物的延迟登记（Gitea #102）：`/sde export` 的 baked 覆盖与 `/sde dump` 的
            // 注册表写出都发生在本线程的**后续 tick** 上，因此只能在这里推进（不能在动作里 sleep——
            // 那会掐死唯一的推进者，见 CommandArtifactRegistrar 类注释）。
            // 放在避让判定**之前**：登记是纯本地文件复制，不动世界，探针激活时也应照常完成。
            try {
                CommandArtifactRegistrar.pump();
            } catch (Throwable t) {
                CpLog.warn("延迟登记推进异常（已吞掉）: %s", String.valueOf(t));
            }
            // about 的 MC 相关字段只在本线程采集（HTTP 线程绝不触碰 MC 状态，contract §1.8）
            if (++tickCounter % CpAboutSnapshot.REFRESH_INTERVAL_TICKS == 0) {
                CpAboutSnapshot.refresh(mc);
            }

            String probe = ProbeActivity.firstActive(mc);
            if (probe != null) {
                warnBlocked(queue, probe);
                return; // 单向避让：不排空
            }
            lastBlockedJobId = null;
            if (queue.drainOne()) {
                CpAboutSnapshot.refresh(mc);
            }
        } catch (Throwable t) {
            CpLog.error(t, "控制面 tick 排空异常（已吞掉，不影响游戏）");
        }
    }

    private void warnBlocked(JobQueue queue, String probe) {
        if (!queue.isBusy()) {
            return;
        }
        Job cur = queue.current();
        String jobId = cur == null ? null : cur.jobId();
        if (jobId != null && jobId.equals(lastBlockedJobId)) {
            return;
        }
        lastBlockedJobId = jobId;
        CpLog.warn("既有探针 %s 激活中：控制面动作 %s 暂缓执行（单向避让，探针结束后自动继续）", probe, String.valueOf(jobId));
        try {
            ControlPlaneRuntime rt = ControlPlaneBootstrap.runtime();
            if (rt != null && rt.events() != null) {
                rt.events()
                    .append(
                        EventStream.LEVEL_WARN,
                        EventStream.Kinds.ACTION_REJECT,
                        cur == null ? null : cur.action(),
                        jobId,
                        "探针 " + probe + " 激活中，动作暂缓执行（CP-BUSY-001 口径：排队等待）",
                        Json.object("code", ErrorCodes.BUSY, "probe", probe));
            }
        } catch (Throwable t) {
            CpLog.warn("记录避让事件失败: %s", String.valueOf(t));
        }
    }
}
