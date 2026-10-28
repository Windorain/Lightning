package com.lightning.mod.client.meshcapture.env;

/**
 * TESR 部件批处理 API 的在场状态。
 * <p>
 * 只用于<strong>解释</strong>"批处理为什么没有参与这次捕获"，不参与任何行为判断：捕获期的分派调用不在批处理的
 * active 区间内，所以"批处理存在但空闲"是常态，不是故障。
 */
public enum TesrBatchingState {

    /** 批处理类不在当前环境（未安装提供该 API 的模组）。 */
    ABSENT,

    /** 批处理类存在，当前没有处于 active 区间。 */
    PRESENT_IDLE,

    /** 批处理类存在且正处于 active 区间。 */
    PRESENT_ACTIVE,

    /** 探测没有足够条件回答。 */
    UNKNOWN
}
