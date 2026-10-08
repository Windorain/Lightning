package com.lightning.mod.client.controlplane.mc.input.api;

import java.util.List;

/**
 * 通用输入运行时的接口面（Gitea #162 冻结件 §9.3；**由 Lead 在分叉前落定**）。
 *
 * <p>
 * <b>实现归 T2-A</b>（{@code mc/input/} 下的运行时），**调用方归 T3**（五个动作的描述符与注册），
 * 只读消费方是 T2-B（观察）。三方并行时谁都不许改本接口的方法名/参数/返回语义。
 *
 * <h2>线程与完成回调（§9.3 硬约束）</h2>
 * <ul>
 * <li><b>唯一</b> tick 驱动 = 步进动作每 tick 的 {@code advance}；<b>唯一</b>完成回调 = {@code onFinish}；</li>
 * <li>三方<b>都不得</b>新增 {@code ClientTickEvent} 订阅者（会与 {@code ControlPlaneTickHandler} 的排空顺序耦合）；</li>
 * <li>{@link #deliver} <b>必须非阻塞</b>：队列满时立即以 {@code CP-STATE-001} 拒绝，不许在 tick 线程等队列腾空；</li>
 * <li>HTTP 线程绝不触碰本接口（{@code contract.md} §1.8）。</li>
 * </ul>
 */
public interface InputRuntime {

    /**
     * 投递一批事件；<b>同步返回</b>，绝不阻塞。
     *
     * @param events 事件序列（顺序即投递顺序；同一 tick 内按序写队列）
     * @param jobId  归属作业 id（用于作业级释放与泄漏核对）
     * @return 投递结果；有任一条被拒即 {@link DeliverResult#hasRejections()} 为真（整条请求失败）
     */
    DeliverResult deliver(List<InputEvent> events, String jobId);

    /** 作业级释放（幂等）：只释放归属该作业的持有条目。 */
    ReleaseResult releaseJob(String jobId);

    /** 全清（幂等）：释放所有作业的持有条目。 */
    ReleaseResult releaseAll();

    /** 只读状态快照（客户端 tick 线程内取）。 */
    InputStateSnapshot snapshot();
}
