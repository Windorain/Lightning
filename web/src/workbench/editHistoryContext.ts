import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import { logCenter } from '@/workbench/logging/LogCenter'

export interface EditCommand {
  id: string
  label: string
  timestamp: number
  execute(): void
  undo(): void
  canMergeWith?(other: EditCommand): boolean
  merge?(other: EditCommand): void
}

export interface UndoManager {
  readonly canUndo: Ref<boolean>
  readonly canRedo: Ref<boolean>
  readonly undoLabel: Ref<string | null>
  readonly redoLabel: Ref<string | null>
  push(command: EditCommand): void
  undo(): void
  redo(): void
  clear(): void
}

export const editHistoryKey: InjectionKey<UndoManager> = Symbol('editHistory')

export function createEditHistory(maxStack = 256): UndoManager {
  const undoStack: EditCommand[] = []
  const redoStack: EditCommand[] = []
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref<string | null>(null)
  const redoLabel = ref<string | null>(null)

  function refreshFlags(): void {
    canUndo.value = undoStack.length > 0
    canRedo.value = redoStack.length > 0
    undoLabel.value = undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null
    redoLabel.value = redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null
  }

  function push(command: EditCommand): void {
    if (undoStack.length > 0) {
      const last = undoStack[undoStack.length - 1]
      if (last.canMergeWith?.(command)) {
        last.merge?.(command)
        refreshFlags()
        return
      }
    }

    undoStack.push(command)
    console.log('[editHistory] push, label:', command.label, 'stack size:', undoStack.length)
    if (undoStack.length > maxStack) {
      undoStack.shift()
    }
    redoStack.length = 0
    refreshFlags()
    console.log('[editHistory] calling execute for:', command.label)
    command.execute()
    console.log('[editHistory] execute done for:', command.label)
  }

  function undo(): void {
    const cmd = undoStack.pop()
    if (!cmd) return
    redoStack.push(cmd)
    cmd.undo()
    logCenter.operator('EditHistory', `undo: ${cmd.label}`, { action: 'undo', label: cmd.label })
    refreshFlags()
  }

  function redo(): void {
    const cmd = redoStack.pop()
    if (!cmd) return
    undoStack.push(cmd)
    cmd.execute()
    logCenter.operator('EditHistory', `redo: ${cmd.label}`, { action: 'redo', label: cmd.label })
    refreshFlags()
  }

  function clear(): void {
    undoStack.length = 0
    redoStack.length = 0
    refreshFlags()
  }

  return { canUndo, canRedo, undoLabel, redoLabel, push, undo, redo, clear }
}

export function provideEditHistory(maxStack = 256): UndoManager {
  const ctx = createEditHistory(maxStack)
  provide(editHistoryKey, ctx)
  return ctx
}

export function useEditHistory(): UndoManager {
  const ctx = inject(editHistoryKey)
  if (!ctx) throw new Error('useEditHistory() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
