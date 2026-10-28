package com.lightning.mod.client.meshcapture.env;

/**
 * 一条环境事实的取值：在<strong>当前这次运行</strong>里，某条顶点/几何通道能不能录到东西。
 * <p>
 * 取值域故意只有四档，且 {@link #UNKNOWN} 是合法结果：探针没有足够条件时<strong>不得猜</strong>。
 * 两个方向猜错都有实际代价——把"录不到"猜成"录得到"，会让零产出继续静默变成空气；
 * 把"录得到"猜成"录不到"，会把本来能救回来的格画成占位方块。
 * <p>
 * 本取值域<strong>不</strong>表达"原因"，也不表达"是谁接管了调用点"：原因写在日志与会话级事实快照里，
 * 身份判断不在本层（见 {@link CaptureEnvironmentFacts} 的类注释）。
 */
public enum Capability {

    /** 通道在本次运行里确实进过顶点（行为自证），或该能力经自检确认可用。 */
    CAN_CAPTURE,

    /** 通道存在但本次运行里没有产出可录几何（行为自证为否）。 */
    CANNOT_CAPTURE,

    /** 通道依赖的类/接口不在当前环境里；不是"坏了"，而是"没有这个通道"。 */
    NOT_PRESENT,

    /** 探针没有足够条件回答（未运行、GL 上下文不可用、探测期间抛错等）。 */
    UNKNOWN
}
