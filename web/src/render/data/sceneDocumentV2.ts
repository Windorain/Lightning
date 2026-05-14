// web/src/render/data/sceneDocumentV2.ts
// V2 = V1 原样继承 + 注解 + 标签。V1 字段名/类型全保留，迁移零转换。

import type { Frame, MaterialPaletteEntry, BlockPaletteEntry } from '../schema/types'

// ============================================================
// 基础
// ============================================================

export interface V2BlockPos { x: number; y: number; z: number }
export interface V2FloatPos { x: number; y: number; z: number }

// ============================================================
// 注解 / 标签
// ============================================================

export interface V2PartRef { block_pos: V2BlockPos; part_local_id: string }

export interface V2AnnotationBox {
  id: string; title: string; description: string
  min: V2FloatPos; max: V2FloatPos
  color: string; visible: boolean
  part_refs?: V2PartRef[]
  created_at: number; updated_at: number
  hover_event: string; hover_payload: string
  render_style: string; render_opacity: number
  linked_block_ref: string
}

export interface V2Label {
  id: string; text: string
  x: number; y: number; z: number
  color: string; font_size: number; visible: boolean
}

// ============================================================
// 统计（StatsPanel 依赖）
// ============================================================

export interface V2StatsEntry {
  block_state_id: string
  label_override?: string; icon_source?: string
}

export interface V2StatsGroup { label: string; entries: V2StatsEntry[] }

export interface V2StatsTemplate {
  mode: 'auto' | 'custom'
  groups?: V2StatsGroup[]; show_others?: boolean
}

// ============================================================
// 显示元数据
// ============================================================

export interface V2SceneMeta {
  name: string; author: string; created_at_ms: number
  description: string; tags: string[]
  origin: V2BlockPos
}

// ============================================================
// 顶层文档：V1 + 注解 + 标签
// ============================================================

export interface V2PlainSceneDocument {
  format_version: '2.0'

  // ── V1 原样保留 ──────────────────────────────────────
  schemaVersion?: number
  id: string
  label?: string
  gtnhVersion?: string
  author?: string
  description?: string | null
  modSource?: string
  globalConfig?: Record<string, unknown>
  textureBlobs?: string[]
  tooltipPalette?: string[]
  materialPalette?: MaterialPaletteEntry[]
  blockPalette?: BlockPaletteEntry[]
  frames: Frame[]
  playback?: { loop?: boolean; defaultFrameIndex?: number }

  // ── V2 新增 ──────────────────────────────────────────
  meta: V2SceneMeta
  annotations?: V2AnnotationBox[]
  labels?: V2Label[]
}
