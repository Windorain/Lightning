/**
 * 调试日志系统 — 仅 `import.meta.env.DEV` 时激活，生产构建 tree-shake 排除。
 * 通过 `window.__wb_debug__` 暴露 API 供测试/调试使用。
 */
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

export interface LogEntry {
  time: string
  action: string
  data: string
}

const logs: LogEntry[] = []
const MAX_LOGS = 2000

function pad(n: number): string { return n.toString().padStart(2, '0') }

function formatTime(): string {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** @side-effect 写入日志，容量超限时移除最早条目 */
function log(action: string, data: string): void {
  if (!import.meta.env.DEV) return
  logs.push({ time: formatTime(), action, data })
  if (logs.length > MAX_LOGS) logs.shift()
}

// ---- 窗口级 API ----
interface WbDebug {
  getLogs(): LogEntry[]
  getScene(): V2PlainSceneDocument | null
  getSelection(): BlockRef[]
  getActiveTool(): string
  getEditHistory(): { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }
  /** gizmo 在世界空间中的位置（无激活 gizmo 时返回 null） */
  getGizmoPosition(): { x: number; y: number; z: number } | null
  /** 视口下相机状态 */
  getCameraState(): { position: [number, number, number]; target: [number, number, number] } | null
}

// 延迟引用避免循环依赖，由 WorkbenchRoot 在 setup 时注入
let _sceneRef: (() => V2PlainSceneDocument | null) | null = null
let _selectionRef: (() => BlockRef[]) | null = null
let _toolRegistryRef: (() => { activeToolId: string; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }) | null = null
let _gizmoPosRef: (() => { x: number; y: number; z: number } | null) | null = null
let _cameraStateRef: (() => { position: [number, number, number]; target: [number, number, number] } | null) | null = null

export function installDebugApi(): void {
  if (!import.meta.env.DEV) return

  const api: WbDebug = {
    getLogs: () => logs,
    getScene: () => _sceneRef?.() ?? null,
    getSelection: () => _selectionRef?.() ?? [],
    getActiveTool: () => _toolRegistryRef?.().activeToolId ?? 'none',
    getEditHistory: () => {
      const r = _toolRegistryRef?.()
      return r ? { canUndo: r.canUndo, canRedo: r.canRedo, undoLabel: r.undoLabel, redoLabel: r.redoLabel } : { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
    },
    getGizmoPosition: () => _gizmoPosRef?.() ?? null,
    getCameraState: () => _cameraStateRef?.() ?? null,
  }
  ;(window as any).__wb_debug__ = api
}

export function injectDebugRefs(refs: {
  scene: () => V2PlainSceneDocument | null
  selection: () => BlockRef[]
  toolRegistry: () => { activeToolId: string; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }
}): void {
  if (!import.meta.env.DEV) return
  _sceneRef = refs.scene
  _selectionRef = refs.selection
  _toolRegistryRef = refs.toolRegistry
  // gizmo/camera state 不在这里注入 — 由 updateGizmoState / updateCameraState 从 viewport 推送
}

// ---- 由 WorkbenchViewport 在 render loop 中调用的状态更新 ----

let _gizmoPos: { x: number; y: number; z: number } | null = null
let _cameraState: { position: [number, number, number]; target: [number, number, number] } | null = null

// 模块加载时即绑定 getter → 读内部变量
if (import.meta.env.DEV) {
  _gizmoPosRef = () => _gizmoPos
  _cameraStateRef = () => _cameraState
}

export function updateGizmoState(pos: { x: number; y: number; z: number } | null): void {
  if (!import.meta.env.DEV) return
  _gizmoPos = pos
}
export function updateCameraState(state: { position: [number, number, number]; target: [number, number, number] } | null): void {
  if (!import.meta.env.DEV) return
  _cameraState = state
}

// ---- 预设日志函数（按操作类型） ----

export function logSceneLoaded(sceneName: string, blockCount: number): void {
  log('场景加载', `${sceneName} (${blockCount} 方块)`)
}

export function logBlockSelected(blockId: string, x: number, y: number, z: number): void {
  log('选中方块', `${blockId} @ (${x}, ${y}, ${z})`)
}

export function logBoxSelect(count: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
  log('框选', `${count} 方块 (${minX},${minY},${minZ}) → (${maxX},${maxY},${maxZ})`)
}

export function logToolActivated(toolId: string): void {
  log('激活工具', toolId)
}

export function logMove(dx: number, dy: number, dz: number, newX: number, newY: number, newZ: number): void {
  log('移动', `delta=(${dx},${dy},${dz}) → 新位置 (${newX},${newY},${newZ})`)
}

export function logDelete(count: number): void {
  log('删除', `${count} 方块`)
}

export function logUndo(label: string): void {
  log('撤销', label)
}

export function logRedo(label: string): void {
  log('重做', label)
}

export function logReplace(oldId: string, newId: string): void {
  log('替换', `${oldId} → ${newId}`)
}

export function logMirror(axis: string, count: number): void {
  log('镜像', `沿 ${axis} 轴, ${count} 方块`)
}

export function logError(message: string): void {
  log('错误', message)
}

export { logs }
