/**
 * World 多帧：播放索引与内嵌 StructureData 解析。
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

/** 按时间 tick 选帧 */
export function frameIndexForPlaybackTick(
  world: World,
  frameIndexOverride: number | undefined,
  _timeMs: number,
): number {
  if (frameIndexOverride !== undefined && Number.isFinite(frameIndexOverride)) {
    const n = world.frames.length
    if (n === 0) return 0
    const i = Math.floor(frameIndexOverride)
    return ((i % n) + n) % n
  }
  return getDefaultFrameIndex(world)
}
