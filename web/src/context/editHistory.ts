import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { createLogCenter } from '@/logging/LogCenter'

type EditHistoryLog = Pick<ReturnType<typeof createLogCenter>, 'operator'>

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
  bindLog(log: EditHistoryLog): void
}

/**
 * **撤销权威的值快照**（R1-β① C2）。
 *
 * ## 为什么它在这里，而不是在 `runtime/`
 *
 * 它是**撤销契约**的一部分：`UndoManager`（旧栈）与它（内核权威）回答的是
 * 同一组四个问题（"能撤吗 / 能重做吗 / 撤的是什么 / 重做的是什么"）。
 * 把两侧的读面形状放在同一个文件里，使"权威换了但读面口径没变"这件事
 * 在**类型上**可见 —— 消费点换源不需要改形状。
 *
 * ## 与 `UndoManager` 的形状差异是**刻意**的，不是待补的缺口
 *
 * | 成员 | `UndoManager`（旧栈） | `KernelUndoState`（内核） |
 * |---|---|---|
 * | `canUndo`/`canRedo`/两个 label | `Ref`（可被任意写） | **值**（不可写） |
 * | `push` | 有 —— 调用方能塞任意闭包 | **没有** —— 内核不收闭包，只收命令 |
 * | `undo`/`redo` | 有 —— 直接改栈 | **没有** —— 走 `Command` 的 `{kind:'undo'\|'redo'}` |
 *
 * 内核撤销不是"一个可在外部改的栈"，而是**两条语义命令**（记账由 `reduceUndoRedo`
 * 在事务内完成，契约 §5.2）。若这里补齐 `push()`/`undo()` 使形状与旧栈一致，
 * 就等于把旧栈的形状**保活**成新门面（#171 明令禁止的新门面包旧核心）。
 *
 * ⇒ 读走本类型；写走 `Context#submitKernelUndoRedo` 之类的**命令提交**。
 */
export interface KernelUndoState {
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undoLabel: string | null
  readonly redoLabel: string | null
}

export const editHistoryKey: InjectionKey<UndoManager> = Symbol('editHistory')

export function createEditHistory(maxStack = 256): UndoManager {
  let log: EditHistoryLog | null = null
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

  /** Push command onto undo stack. NOTE: also calls command.execute() and logs via logCenter. */
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
    if (undoStack.length > maxStack) {
      undoStack.shift()
    }
    redoStack.length = 0
    refreshFlags()
    command.execute()
  }

  function undo(): void {
    const cmd = undoStack.pop()
    if (!cmd) return
    redoStack.push(cmd)
    cmd.undo()
    log?.operator('EditHistory', `undo: ${cmd.label}`, { action: 'undo', label: cmd.label })
    refreshFlags()
  }

  function redo(): void {
    const cmd = redoStack.pop()
    if (!cmd) return
    undoStack.push(cmd)
    cmd.execute()
    log?.operator('EditHistory', `redo: ${cmd.label}`, { action: 'redo', label: cmd.label })
    refreshFlags()
  }

  function clear(): void {
    undoStack.length = 0
    redoStack.length = 0
    refreshFlags()
  }

  return {
    canUndo, canRedo, undoLabel, redoLabel, push, undo, redo, clear,
    bindLog(l: EditHistoryLog) { log = l },
  }
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
