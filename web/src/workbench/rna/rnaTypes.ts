/**
 * RNA Property — 对标 Blender 的 RNA 属性描述符。
 *
 * 在 proto 生成的 TypeScript 接口之上添加反射层：
 * - 字段元数据（类型、UI 范围、枚举项）
 * - get/set 访问器
 * - 变更通知回调
 */
export interface RnaProperty {
  /** 属性标识（如 "frames[0].blocks[].block_state_id"） */
  path: string
  label: string
  description?: string
  type: 'string' | 'int' | 'float' | 'bool' | 'enum' | 'object' | 'array' | 'vec3'
  /** UI hints */
  min?: number
  max?: number
  step?: number
  enumItems?: Array<{ value: string; label: string }>
  default?: unknown
  /** 读写 */
  get(obj: unknown): unknown
  set(obj: unknown, value: unknown): void
  /** 变更回调（对标 Blender 的 update() callback，触发 depsgraph tag） */
  onChange?: (obj: unknown, newValue: unknown, oldValue: unknown) => void
}
