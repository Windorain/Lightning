/**
 * World 多帧：帧**解析**（索引 → 帧 → 内嵌 StructureData）。
 *
 * ## 退役改造（#249 §15 第 8 条「帧序列兼任动画」，P5 负责的渲染侧）
 *
 * **被删除**：`frameIndexForPlaybackTick(world, override, _timeMs)`。
 *
 * 它的签名宣称"按时间 tick 选帧"，但实现里 `_timeMs` 是**未使用参数**
 * （下划线即此意）：真实行为只是"有 override 就取模，否则取默认帧"。
 * 这正是 §15 第 8 条要退役的形状 —— 帧序列**兼任**动画：播放推进靠
 * `drwMeshPipeline` 的 `setTimeout` 链（旧播放路径），而"按时间求帧"是空壳。
 *
 * 把它删掉而不是"实现它"，因为按时间求帧属于 **P4（#255）统一动画求值的语义替代**：
 * 在本仓实现一个局部的时间→帧映射会与 P4 的通用轨道形成第二条求值路径，
 * 恰是 #171 禁止的"新旧并存"。删除后本模块只保留**无时间参数**的纯解析函数
 * （`getDefaultFrameIndex` / `frameAt` / `embeddedStructure`），
 * 它们由适配器使用、不依赖任何时钟（#249 §2.1）。
 *
 * **接缝声明**：`drwMeshPipeline.scheduleNextWorldFrameStep()` 的 `setTimeout` 播放链
 * 是同一退役条目的另一半，其语义替代是 P4 的统一动画求值轨道。P4 尚未交付
 * （远端无 `web-kernel/p04-*` 分支），故按 Lead 裁决**不做半成品替换**，
 * 由 Lead 排合并顺序（详见 #256 交付汇报的接缝一节）。
 */

import type { Frame, StructureData, World } from '../schema/types'

/** 解析默认帧下标（始终循环取模） */
export function getDefaultFrameIndex(world: World): number {
  const n = world.frames.length
  if (n === 0) return 0
  const raw = world.playback?.defaultFrameIndex
  const i = raw === undefined || !Number.isFinite(raw) ? 0 : Math.floor(raw)
  return ((i % n) + n) % n
}

export function frameAt(world: World, index: number): Frame | undefined {
  return world.frames[index]
}

export function embeddedStructure(frame: Frame | undefined): StructureData | undefined {
  return frame?.structure
}
