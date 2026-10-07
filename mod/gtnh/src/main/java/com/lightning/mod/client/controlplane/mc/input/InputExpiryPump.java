package com.lightning.mod.client.controlplane.mc.input;

import com.lightning.mod.client.controlplane.mc.CpLog;

/**
 * 持键到期的**逐 tick 结算泵**（Gitea #165 的 D-7 裁决，见 {@code input-contract.md} §9.3 第 1′条）。
 *
 * <h2>它修的是什么：一个「冻结的契约」与「实测可达性」之间的矛盾</h2>
 * 契约 §9.3 第 1 条把「唯一 tick 驱动」冻结为<b>步进动作每 tick 的 {@code advance}</b>。
 * 但输入族存在一类**不跨 tick 的作业**：{@code input.key action:"down"} 投递按下后<b>立即完成</b>
 * 并刻意保留持有（否则 {@code down} 就没有意义）——此时<b>没有任何步进动作在跑</b>，
 * 于是 {@link InputRuntimeImpl#tick()} 不再被调用，{@code expiresAtTick} 到了也没人结算。
 *
 * <p>
 * 后果是实打实的：{@code down} 之后若作业失败、驱动退出、或调用方忘了 {@code input.release}，
 * 那个键会**一直按着**，直到下一次任意输入交互（{@code deliver}/{@code release}/{@code snapshot}）
 * 顺带结算为止。这正是本仓判据里明令要防的「故障停止后无持键泄漏」。
 * 注意 {@code host.clientTick()} 本身有墙钟兜底（§4.3），所以问题<b>不在计时</b>，而在<b>没人去结算</b>。
 *
 * <h2>为什么放在既有 tick 处理器里，而不是新增订阅者</h2>
 * §9.3 第 2 条是【禁令】：三方都不得新增 {@code ClientTickEvent} 订阅者（会让共享文件的排空顺序耦合）。
 * 本类<b>不是订阅者</b>：它由既有的 {@code ControlPlaneTickHandler} 在自己的 tick 事件里调用，
 * 因此仍然是「零新增订阅者」，只是把既有的那一拍用在结算上。
 *
 * <h2>为什么只调 {@code expireDue()} 而不是 {@code tick()}</h2>
 * {@link InputRuntimeImpl#tick()} 会推进 {@code host.advanceTick()} 的「被驱动 tick 数」。
 * 若泵也推进它，同一次客户端 tick 里泵与步进动作会各推进一次 ⇒ 计数虚高（虽然
 * {@code clientTick()} 取「驱动数」与「墙钟估计」之**大**，虚高只会让到期略早、不会漏抬，
 * 但诊断字段 {@code drivenTicks} 会变得不可解释）。到期结算只需要<b>读</b>真实 tick
 * （{@code host.clientTick()} 已含墙钟兜底）并抬起到期项，因此这里只调幂等的
 * {@link InputRuntimeImpl#expireDue()}。
 *
 * <h2>代价与诚实边界</h2>
 * <ul>
 * <li>泵在第一个客户端 tick 上会**首次构造**运行时单例（{@code McInputHost} + 反射探针）。
 * 这是一次性的、微秒级的代价；换取的是「持键到期不需要任何外力也会生效」。
 * 构造失败时只 WARN <b>一次</b>（不刷屏），并如实认为「到期结算不可用」——
 * 而不是静默地假装它在跑。</li>
 * <li>本泵<b>不</b>解决「进程崩溃」与「离图/断连」两种情形：前者状态随 JVM 消失（§3.4 路径 5 不承诺），
 * 后者没有钩子（§3.4 表外）。这两条继续留在 {@code input.state.notImplemented} 里，不因本泵而变绿。</li>
 * </ul>
 */
public final class InputExpiryPump {

    /** 失败只报一次（tick 路径上刷屏会淹没日志）。 */
    private static volatile boolean warned;

    private InputExpiryPump() {}

    /**
     * 结算一次到期持有（幂等；无持有时是空操作）。
     *
     * <p>
     * 由 {@code ControlPlaneTickHandler} 在**客户端 tick 线程**、于作业排空**之后**调用：
     * 先把本 tick 的作业推进完，再由本泵收口它留下的到期项。
     */
    public static void tick() {
        try {
            InputRuntimeImpl rt = InputRuntimeImpl.shared();
            if (rt != null) {
                rt.expireDue();
            }
        } catch (Throwable t) {
            if (!warned) {
                warned = true;
                CpLog.warn("输入持键的到期结算不可用（只报一次）：%s。持键将只能靠 input.release 或作业收尾释放", String.valueOf(t));
            }
        }
    }

    /** 测试/诊断用：泵是否已经报过失败。 */
    public static boolean warned() {
        return warned;
    }
}
