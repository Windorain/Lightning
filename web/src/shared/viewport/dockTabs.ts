/**
 * 视口下方栏（`ViewportFrameLayerDock`）的 tab 可用性与默认 tab 解析 —— **纯函数**。
 *
 * 为什么单独一个模块：Embed 与 Workbench 两端必须**行为一致**（硬约束），
 * 而两端的 tab 显隐来源不同（Embed 走 `features` 开关，Workbench 恒显示分层预览 / 多帧才显示帧控制），
 * 故把"哪些 tab 可用 / 默认选哪个 / 首选不可用时回落到哪个"收敛成同一份纯逻辑，两端只填输入。
 *
 * 多方块文档的「通道」tab 是**文档形态驱动**（`documentShape === "multiblock"`），
 * 与 Embed 的 `features` 开关无关（`View3DFeatures` 不是本模块的输入，且通道切换是契约级能力）。
 */

export type ViewportDockTab = 'frame' | 'layer' | 'channels'

export interface DockTabAvailability {
  /** 帧控制 tab 是否被允许（Embed：`features.frameControls`；Workbench：恒 true） */
  showFrameTab: boolean
  /** 是否多帧文档（帧控制 tab 还需此条为真才出现） */
  hasWorldMultiFrame: boolean
  /** 分层预览 tab 是否被允许（Embed：`features.layerBar`；Workbench：恒 true） */
  showLayerTab: boolean
  /** 「通道」tab 是否被允许（文档为多方块为主形态时为真） */
  showChannelsTab: boolean
}

/**
 * 可用 tab，**按优先级排列**：通道 → 帧控制 → 分层预览。
 *
 * 顺序即语义：多方块文档下默认落在「通道」（该形态的主控），帧为主文档下「通道」不可用，
 * 首位自然回到帧控制 / 分层预览 —— 既有两端默认 tab 行为因此一字未变。
 */
export function availableDockTabs(o: DockTabAvailability): ViewportDockTab[] {
  const out: ViewportDockTab[] = []
  if (o.showChannelsTab) out.push('channels')
  if (o.showFrameTab && o.hasWorldMultiFrame) out.push('frame')
  if (o.showLayerTab) out.push('layer')
  return out
}

/** 默认 tab = 可用列表中优先级最高者（全部不可用时回落 'layer'，仅用于类型完备）。 */
export function defaultDockTab(o: DockTabAvailability): ViewportDockTab {
  return availableDockTabs(o)[0] ?? 'layer'
}

/** 首选 tab 仍可用则保留，否则回落到当前可用列表中优先级最高者（文档形态切换时不残留空 panel）。 */
export function resolveDockTab(
  preferred: ViewportDockTab,
  available: readonly ViewportDockTab[],
): ViewportDockTab {
  return available.includes(preferred) ? preferred : (available[0] ?? 'layer')
}
