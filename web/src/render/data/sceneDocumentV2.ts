// web/src/render/data/sceneDocumentV2.ts

export interface V2BlockPos {
  x: number
  y: number
  z: number
}

export interface V2FloatPos {
  x: number
  y: number
  z: number
}

export interface V2BlockPart {
  local_id: string
  part_kind: string
  direction: number
  properties: Record<string, string>
  tooltip?: string
}

export interface V2ItemSlot {
  slot_index: number
  item_id: string
  count: number
  damage?: number
  nbt?: Record<string, string>
}

export interface V2FluidTank {
  tank_index: number
  fluid_id: string
  amount_mb: number
  capacity_mb: number
}

export interface V2EnergyState {
  stored_eu: number
  capacity_eu: number
}

export interface V2GuiState {
  layout_id: string
  item_slots: V2ItemSlot[]
  fluid_tanks: V2FluidTank[]
  energy?: V2EnergyState
  config: Record<string, string>
}

export interface V2BlockInstance {
  pos: V2BlockPos
  block_state_id: string
  nbt?: Record<string, string>
  parts?: V2BlockPart[]
  gui_state?: V2GuiState
}

export interface V2PartRef {
  block_pos: V2BlockPos
  part_local_id: string
}

export interface V2AnnotationBox {
  id: string
  title: string
  description: string
  min: V2FloatPos
  max: V2FloatPos
  color: string
  visible: boolean
  part_refs?: V2PartRef[]
  created_at: number
  updated_at: number
  hover_event: string
  hover_payload: string
  render_style: string
  render_opacity: number
  linked_block_ref: string
}

export interface V2Label {
  id: string
  text: string
  x: number
  y: number
  z: number
  color: string
  font_size: number
  visible: boolean
}

export interface V2StatsEntry {
  block_state_id: string
  label_override?: string
  icon_source?: string
}

export interface V2StatsGroup {
  label: string
  entries: V2StatsEntry[]
}

export interface V2StatsTemplate {
  mode: 'auto' | 'custom'
  groups?: V2StatsGroup[]
  show_others?: boolean
}

export interface V2SceneMeta {
  name: string
  author: string
  created_at_ms: number
  description: string
  tags: string[]
  origin: V2BlockPos
}

export interface V2EntityInstance {
  pos: V2BlockPos
  entity_id: string
  nbt?: Record<string, string>
}

export interface V2WorldFrame {
  label: string
  index: number
  blocks: V2BlockInstance[]
  entities: V2EntityInstance[]
}

export interface V2BlockState {
  name: string
  properties: Record<string, string>
}

export interface V2MaterialEntry {
  key: string
  texture_png: string   // base64
  blend_mode: string
  is_animated: boolean
  animation_ticks_per_frame: number
  animation_frame_count: number
}

export interface V2MaterialLibrary {
  entries: V2MaterialEntry[]
}

export interface V2PlainSceneDocument {
  format_version: '2.0'
  meta: V2SceneMeta
  frames: V2WorldFrame[]
  block_palette: Record<string, V2BlockState>
  materials: V2MaterialLibrary
  annotations?: V2AnnotationBox[]
  labels?: V2Label[]
  stats_template?: V2StatsTemplate
}
