/**
 * **外壳实例身份**（M7-6）。
 *
 * ## 为什么需要它
 *
 * M7-0 的 D6/D7/D9 是同一个根因的三种症状：持久化键与观测面按**外壳类型**命名，
 * 而同一类型可以有**多个实例**（Wiki 页面同页两个嵌入；工作台 + 嵌入共存）。
 * 于是"最后写者胜"：A 改的偏好被 B 读到、A 的日志出现在 B 的状态栏。
 *
 * 身份必须由**装配层**分配（S0-A §7.4 / 计划 §5 M7-6），不是由域层猜测：
 *
 * | 宿主 | 身份 | 为什么 |
 * |---|---|---|
 * | 工作台 | 固定 `workbench` | 结构上禁止同页两个工作台（Q3 裁决：保持禁止、报错改人话） |
 * | 嵌入 | 每次 `mount()` 分配一个 `embed-<n>` | 同页可多实例；Wiki 模板重复嵌入是真实形态 |
 *
 * ## 为什么是"页内序号"而不是随机/时间戳
 *
 * 序号在同一次页面装载里稳定：第一个嵌入恒为 `embed-1`，于是**刷新后仍读回自己**
 * 的偏好（否则实例键从随机/时间派生，用户每次刷新都丢偏好 —— 那是数据保真退化）。
 * 多个容器按挂载顺序得到不同序号，故同页实例互不覆盖。
 *
 * 计数器是模块级可变状态，但它只做**分配**、不承载任何偏好事实；
 * 偏好事实落在带该 id 的存储键上（见 `runtime/instanceStorage`）。
 */

/** 工作台实例身份（固定；结构上禁止同页两个工作台，见 Q3）。 */
export const WORKBENCH_INSTANCE_ID = 'workbench'

let embedSeq = 0

/**
 * 分配一个嵌入实例身份（装配层 = `embed/mount`；每次 `mount()` 一次）。
 *
 * 不在 `EmbedRoot` 里分配：组件可能被宿主直接 `createApp`（库形态允许），
 * 那样"谁是装配层"就变成隐式的。`mount()` 是**唯一**的库入口，
 * 由它分配即可保证"一次挂载 = 一个实例身份"。
 */
export function allocateEmbedInstanceId(): string {
  embedSeq += 1
  return `embed-${embedSeq}`
}

/** 测试用：把分配器复位（**只**供测试；产品代码不得调用）。 */
export function resetEmbedInstanceAllocatorForTest(): void {
  embedSeq = 0
}

/** 归一化实例身份（空串 ⇒ `default`；仅保留存储键安全字符）。 */
export function normalizeInstanceId(instanceId: string): string {
  const cleaned = instanceId.trim().replace(/[^A-Za-z0-9_-]/g, '-')
  return cleaned === '' || cleaned === '-' ? 'default' : cleaned
}
