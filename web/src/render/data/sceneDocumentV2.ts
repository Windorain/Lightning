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
// 统计（旧文档线格式：字段保留、语义已作废 —— 见下）
// ============================================================

/**
 * **已废弃（B-3 / 决策 C）**：`statsTemplate` / `statsOverride` 的语义（三级配置 + 统计规则）
 * 已整套移除，web 端不存在消费方。此处**只保留线格式形状**（同 proto `StatsTemplate` /
 * `StatsEntry.part_type_key`：字段不删，语义作废），供解析链把旧文档根字段**透传不丢**：
 * 契约 §9 兼容口径 = 「旧文档携带 statsTemplate/statsOverride ⇒ 读取后静默忽略」。
 * 契约：http://127.0.0.1:3300/Lightning/lightning/wiki/%E9%83%A8%E4%BB%B6%E6%95%B0%E6%8D%AE%E5%A5%91%E7%BA%A6 §9
 */
export interface V2StatsEntry {
  block_state_id: string
  label_override?: string; icon_source?: string
  /** 旧字段（语义作废）：部件视图的条目键 = 部件 typeKey（契约 §9/§10.2；与 block_state_id 互斥使用） */
  partTypeKey?: string
}

export interface V2StatsGroup { label: string; entries: V2StatsEntry[] }

/** **已废弃（B-3 / 决策 C）**：仅线格式形状，无消费方（见上） */
export interface V2StatsTemplate {
  mode: 'auto' | 'custom'
  groups?: V2StatsGroup[]; show_others?: boolean
  /** camelCase 落盘形态（契约 §10.2：JSON 字段名按 camelCase，与 proto show_others 对应） */
  showOthers?: boolean
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
  /**
   * **旧字段（语义作废，B-3 / 决策 C）**：原"三级配置的文档默认层"已整套移除。
   * 字段仍随文档根透传（旧文档读取后**静默忽略**，不报错、不空栏），但无任何消费方。
   * 契约 §9 兼容口径：http://127.0.0.1:3300/Lightning/lightning/wiki/%E9%83%A8%E4%BB%B6%E6%95%B0%E6%8D%AE%E5%A5%91%E7%BA%A6
   */
  statsTemplate?: V2StatsTemplate
}
