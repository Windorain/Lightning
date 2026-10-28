/**
 * `presentation/blockRegistryKey` —— **block_registry 键的唯一口径**。
 *
 * `meta === 0` ⇒ 裸 `registryId`；否则 `registryId@meta`。
 *
 * ## 为什么它是**契约**而不是可自选的形式
 *
 * 侧栏高亮 / 悬停 tooltip（`neiTooltipMap` 的键）/ 导出都按这个键对齐。
 * 改拼法 = 三处**一起静默失配**：实测擒获过同族的"命中仍然成功、
 * tooltip 与侧栏却查不到"（`grid.at().name` 是截命名空间的短名）。
 *
 * ## 为什么落在这里（修 `gate/no-private-cross-layer`）
 *
 * 原定义在 `render/data/blockRegistryResolve.ts`（旧层、**深度 3**）——
 * 装配根 import 它会被"公共出口最大深度 2"判红（规则 6 / 规则 2，见 `web/tests/architecture/boundary-rules.mjs`）。
 * 现在本模块是**唯一实现**，旧层保留同名导出并**委托**到这里（不各写一份：
 * 两份实现必然漂移，本工程已三度实测）。
 */

/** block_registry 键：`meta === 0` ⇒ `registryId`，否则 `registryId@meta`。 */
export function blockRegistryKey(registryId: string, meta: number): string {
  return meta === 0 ? registryId : `${registryId}@${meta}`
}
