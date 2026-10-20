package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.lightning.mod.client.controlplane.core.JobQueue;
import com.lightning.mod.client.controlplane.mc.cmd.CommandArtifactRegistrar;
import com.lightning.mod.client.controlplane.mc.input.InputExpiryPump;

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
 * <h2>单向避让的去向（contract.md §9，Gitea #104）</h2>
 *
 * #104 之前本类在排空前先问 {@link ProbeActivity#any}：老探针激活时<b>不排空</b>（让出 tick）。
 * Gitea #104 把老批处理设施整体删除后，<b>不存在任何第三方自动化链</b>——控制面是唯一驱动世界的
 * 自动化，因此避让分支连同它的告警/事件已删除（留着一个永远不成立的判据就是死代码）。
 *
 * <p>
 * <b>为什么不能把「控制面自身忙」当作排空门</b>：步进作业正是靠每 tick 的 {@code drainOne()}
 * 推进的（{@code JobQueue.drainOne} 在 running 态继续 step）。以「忙」为门会把 running 作业
 * 冻结到超时。并发提交的互斥由 {@link JobQueue#submit} 在 HTTP 线程以 {@code CP-BUSY-001} 完成，
 * 与 tick 排空无关。
 *
 * <p>
 * 契约字段 {@code probeActive} / {@code probe} 仍在（{@link ProbeActivity}），语义改为
 * 「控制面自身忙闲」，形状不变。
 *
 * <h2>本 tick 里的第二件事：输入持键的到期结算（D-7）</h2>
 *
 * {@link InputExpiryPump#tick()} 在作业排空**之后**结算一次输入的到期持键。它修的是
 * {@code input-contract.md} §9.3 第 1 条（「唯一 tick 驱动 = 步进动作的 advance」）留下的一条实际漏洞：
 * {@code input.key action:"down"} 这类作业**立即完成却刻意保留持键**，此时没有任何步进动作在跑，
 * 到期项因此永远没人结算——键会一直按着（§3.2 的「不允许无限期持有」在空闲期不成立）。
 *
 * <p>
 * 它<b>不是</b>新订阅者（§9.3 第 2 条的【禁令】只禁新增 {@code ClientTickEvent} 订阅者），
 * 而是复用本处理器已有的那一拍；D-7 的完整理由与代价见 {@link InputExpiryPump} 的类注释。
 */
public final class ControlPlaneTickHandler {

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
            try {
                CommandArtifactRegistrar.pump();
            } catch (Throwable t) {
                CpLog.warn("延迟登记推进异常（已吞掉）: %s", String.valueOf(t));
            }
            // about 的 MC 相关字段只在本线程采集（HTTP 线程绝不触碰 MC 状态，contract §1.8）
            if (++tickCounter % CpAboutSnapshot.REFRESH_INTERVAL_TICKS == 0) {
                CpAboutSnapshot.refresh(mc);
            }

            if (queue.drainOne()) {
                CpAboutSnapshot.refresh(mc);
            }
            // 输入持键的到期结算（D-7）：排在作业排空**之后**——先把本 tick 的作业推进完，
            // 再由本泵收口它留下的到期项（幂等；无持有时是空操作，失败只 WARN 一次不刷屏）
            InputExpiryPump.tick();
        } catch (Throwable t) {
            CpLog.error(t, "控制面 tick 排空异常（已吞掉，不影响游戏）");
        }
    }
}
