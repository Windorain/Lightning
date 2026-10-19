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
 * **接缝声明（M9-1 更正：原文写“P4 尚未交付 / 由 Lead 排合并顺序”，已过期）**：
 * `drwMeshPipeline.scheduleNextWorldFrameStep()` 的 `setTimeout` 播放链是同一退役条目的
 * 另一半，**已删除**：`retirementRegistry` 的 `world-frame-playback` 组四个符号
 * （`scheduleNextWorldFrameStep`/`clearWorldPlaybackSchedule`/`worldPlaybackTimeoutId`/
 * `dwellMsForCurrentWorldFrame`）相位全 `executed`，全树生产命中 **0**
 * （只剩本注释与判据文字）；语义替代 = P4（#255）**已交付**的通用轨道：
 * `domain/animation#sampleTrack` + `advancePlayhead`，时间唯一权威 = `EditContext.time`
 * （`domain/editing.ts:129`）。⇒ 本模块与播放之间**已无未了的接缝**：
 * 它只提供无时间参数的纯解析函数。
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
