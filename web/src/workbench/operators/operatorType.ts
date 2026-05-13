/**
 * OperatorType — 对标 Blender 的 wmOperatorType。
 *
 * 操作符是编辑操作的最小可执行单元。
 * 支持三种执行模式：
 * - exec: 无交互执行（可被 API/脚本调用）
 * - invoke: 初始化交互（解析事件、设置参数）
 * - modal: 模态事件循环（每帧/每事件驱动）
 * 另有 poll（上下文检查）和 cancel（外部中断清理）。
 */
import type { BContext } from '@/workbench/context/bContext'
import type { PropertyDescriptor } from '@/workbench/ux/rna/types'

/** 操作符属性容器（对标 Blender operator properties） */
export type OperatorProperties = Record<string, unknown>

/** invoke/modal 的返回值 */
export const OP_RESULT = {
  FINISHED: 'FINISHED',
  CANCELLED: 'CANCELLED',
  RUNNING_MODAL: 'RUNNING_MODAL',
  PASS_THROUGH: 'PASS_THROUGH',
} as const

export type OpResult = (typeof OP_RESULT)[keyof typeof OP_RESULT]

export interface OperatorType {
  id: string
  label: string
  description?: string
  /** RNA 属性定义（对标 Blender operator RNA properties），用于未来自动 UI 生成 */
  properties?: PropertyDescriptor[]
  /** 是否自动包裹 undo */
  flagUndo?: boolean
  /** 无交互执行 */
  exec?(bctx: BContext, props: OperatorProperties): void
  /** 初始化交互，返回模态状态 */
  invoke?(bctx: BContext, props: OperatorProperties, event?: PointerEvent | KeyboardEvent): OpResult
  /** 模态事件循环 */
  modal?(bctx: BContext, props: OperatorProperties, event: Event): OpResult
  /** 上下文检查（返回 false 时操作符在 UI 中灰掉） */
  poll?(bctx: BContext): boolean
  /** 外部取消时的清理 */
  cancel?(bctx: BContext, props: OperatorProperties): void
  /** 创建模态状态（每次 invoke 进入模态时调用） */
  initModalState?: () => OperatorProperties
  /** 视口叠加层渲染（逐帧调用） */
  renderOverlay?(bctx: BContext, props: OperatorProperties, overlayScene: THREE.Scene): void
}

/* eslint-disable @typescript-eslint/no-unused-vars */
import type * as THREE from 'three'
