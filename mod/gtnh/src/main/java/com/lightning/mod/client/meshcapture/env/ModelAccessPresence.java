package com.lightning.mod.client.meshcapture.env;

/**
 * 一条"某族渲染器手里的模型数据能不能被只读反射取到"类事实的取值。
 * <p>
 * 与 {@link Capability} 分开：能力型事实回答"顶点通道能不能录到"；本取值只回答"那份<strong>已经算好的模型数据</strong>
 * （顶点数组 + 顶点布局）能不能按名字取到"。与 {@link TogglePresence} 也分开：本取值不拨动任何开关、不改变别人的渲染
 * 行为，只决定一条针对性策略参不参与。
 * <p>
 * {@link #PRESENT} 是这条事实唯一的放行条件：不是 PRESENT 时策略整条不参与，该格照常走零产出裁决与兜底
 * （见 {@code MeshCaptureBlockPostRenderRegistry} 的"策略只产真几何"约束）。两个方向猜错的代价不对称——把"取不到"
 * 猜成"取得到"会让策略在渲染线程上抛错或写出半份几何；把"取得到"猜成"取不到"只是少救回一格。故不确定一律不给
 * {@link #PRESENT}。
 */
public enum ModelAccessPresence {

    /** 目标类、字段与顶点布局都按名字取到，且签名与预期一致。 */
    PRESENT,

    /** 目标类或字段不在（或签名不符）：这条策略在当前环境里没有可用数据，不是"坏了"。 */
    ABSENT,

    /** 读取过程抛错，无法判断：按不放行处理（保守）。 */
    UNKNOWN
}
