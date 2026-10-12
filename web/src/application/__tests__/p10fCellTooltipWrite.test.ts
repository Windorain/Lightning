/**
 * **P10f D0 判据：逐格说明写命令**（#301）。
 *
 * ## 要证明什么
 *
 * 1. **写生效**：命令 `applied`、内核 `cellContent[key].tooltip` 真的变了；
 * 2. **`null` ≠ `''`**（"删除"与"显式空说明"必须可区分 —— 内核 `cellContent` 的核心口径）；
 * 3. **幂等**：同值 ⇒ `unchanged`（不推进版本、不进历史）；
 * 4. **拒绝孤儿键**：写一个不在 `cells` 里的格必须被拒（否则说明永远显示不出来）；
 * 5. **投影往返等价**：写完后经 `projectKernelDocument` 投回 legacy，
 *    `tooltipPalette`/`cellTooltipGrid` 能逐格解出我写的文本。
 *
 * ## 为什么第 5 条是关键
 *
 * D0 要替代的两处旧写法（`metaEditOperators`、`property-writers`）直接改**侧表**；
 * 而保存/渲染仍读侧表（D2 才迁）。⇒ 若投影不能把我的内核写还原成等价侧表，
 * "写内核"就会让用户看到**说明消失**。这条判据把该风险钉死。
 *
 * ## 为什么不用真 `Context`（与 C′2 判据的差别）
 *
 * 本文件测的是**命令层**（`reduceSetCellTooltip`），它的输入就是 `ApplicationState`；
 * 用 `KernelSession.submit` 走的就是**生产命令通路**（`reduceCommand` 本体）。
 * ⇒ 无需 `Context`，也不存在"宿主复刻被测算法"的空转风险
 * （C′1/C′2 的教训在那里适用，因为被替代物**在** `Context` 上；这里不在）。
 */

import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { projectKernelDocument } from '@/composition/kernelProjection'

const OBJ = 'structure:frame-0'

/** 造"一个方块网格对象"的最小内核会话（逐格说明挂在它的 `blockGrid` 载荷上）。 */
function sessionWithGrid(cells: Readonly<Record<string, string>>): KernelSession {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
  const withObj = withObject(
    emptyScene('probe-scene'),
    sceneObject({ id: OBJ, type: 'block', dataId: `${OBJ}:data` }),
    objectData(`${OBJ}:data`, { kind: 'blockGrid', cells }, 'document'),
  ) as Scene
  const withSceneDoc = withContent(base, withObj, base.animation)
  const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
  session.adoptDocument(adopted, adopted.content)
  return session
}

const CELLS = { '0,0,0': 'minecraft:stone', '1,0,1': 'minecraft:dirt' }

function submit(session: KernelSession, cmd: Record<string, unknown>) {
  const t = session.submit(cmd as never)
  session.drain()
  return session.settlementOf(t) as { status?: string } | null
}

function tooltipAt(session: KernelSession, x: number, y: number, z: number): string | undefined {
  const doc = session.document()!
  const obj = findObject(doc.scene, OBJ)
  const data = obj === undefined ? undefined : findObjectData(doc.scene, obj.dataId)
  if (data === undefined || data.payload.kind !== 'blockGrid') return undefined
  return data.payload.cellContent?.[cellContentKey(x, y, z)]?.tooltip
}

function write(session: KernelSession, x: number, y: number, z: number, text: string | null) {
  return submit(session, { kind: 'setCellTooltip', contextId: KERNEL_CONTEXT_ID, objectId: OBJ, x, y, z, text })
}

describe('P10f D0 · ① 写生效 + 三态语义', () => {
  it('写文案后内核 `cellContent[key].tooltip` 生效', () => {
    const s = sessionWithGrid(CELLS)
    try {
      expect(write(s, 0, 0, 0, 'hello').status, '写必须 applied').toBe('applied')
      expect(tooltipAt(s, 0, 0, 0)).toBe('hello')
      // 未写的格不得被牵连
      expect(tooltipAt(s, 1, 0, 1)).toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it("**`null` ≠ `''`**：删除与「显式空说明」必须可区分", () => {
    const s = sessionWithGrid(CELLS)
    try {
      write(s, 0, 0, 0, 'x')

      // `''` ⇒ 字段**在**且为 `''`（显式"说明了空"）
      write(s, 0, 0, 0, '')
      expect(tooltipAt(s, 0, 0, 0), '空串必须是「有字段且为空」').toBe('')

      // 写回有值，再 `null` ⇒ 字段**缺席**
      write(s, 0, 0, 0, 'y')
      write(s, 0, 0, 0, null)
      expect(tooltipAt(s, 0, 0, 0), '`null` 必须移除字段（缺席 ≠ 空）').toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('**幂等**：同值 ⇒ `unchanged`（不推进版本、不进历史）', () => {
    const s = sessionWithGrid(CELLS)
    try {
      write(s, 0, 0, 0, 'same')
      const pastBefore = s.document()!.history.past.length
      expect(write(s, 0, 0, 0, 'same').status, '同值必须 unchanged').toBe('unchanged')
      expect(s.document()!.history.past.length, 'unchanged 不得进历史').toBe(pastBefore)
    } finally {
      s.dispose()
    }
  })

  it('**拒绝孤儿键**：写不在 `cells` 里的格 ⇒ 拒绝', () => {
    const s = sessionWithGrid(CELLS)
    try {
      // (9,9,9) 不在 CELLS 里
      expect(write(s, 9, 9, 9, 'nope').status, '越界格必须拒绝').toBe('rejected')
      expect(tooltipAt(s, 9, 9, 9)).toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('**历史记账**：真写入必须进历史（可撤销）', () => {
    const s = sessionWithGrid(CELLS)
    try {
      const before = s.document()!.history.past.length
      write(s, 0, 0, 0, 'a')
      expect(s.document()!.history.past.length, '写入必须进历史').toBeGreaterThan(before)
    } finally {
      s.dispose()
    }
  })
})

describe('P10f D0 · ② 投影往返：内核写 → legacy 侧表逐格等价', () => {
  it('写完一格的说明，投回 legacy 的侧表必须能解出同一文本', () => {
    const s = sessionWithGrid(CELLS)
    try {
      write(s, 1, 0, 1, 'corner')
      const doc = s.document()!
      const projected = projectKernelDocument({ scene: doc.scene, content: doc.content })
      const plain = projected.plain as Record<string, unknown>
      const palette = plain.tooltipPalette as string[] | undefined
      const grid = plain.cellTooltipGrid as number[][][] | undefined

      expect(palette, '投影必须产出 `tooltipPalette`（否则保存会丢说明）').toBeDefined()
      expect(grid, '投影必须产出 `cellTooltipGrid`').toBeDefined()
      // 把侧表解读回"某一格的文本"（-1 哨兵 ⇒ 无说明）
      const textAt = (x: number, y: number, z: number): string => {
        const idx = grid![z]?.[y]?.[x] ?? -1
        return idx < 0 ? '' : (palette![idx] ?? '')
      }
      expect(textAt(1, 0, 1), '投影后该格文本必须是我写的').toBe('corner')
      expect(textAt(0, 0, 0), '未写的格必须仍无说明').toBe('')
    } finally {
      s.dispose()
    }
  })

  it('**反空洞**：没写过任何说明时投影**不产出**侧表（`null` ⇒ 不写这两项）', () => {
    const s = sessionWithGrid(CELLS)
    try {
      const doc = s.document()!
      const plain = projectKernelDocument({ scene: doc.scene, content: doc.content }).plain as Record<string, unknown>
      // 装配侧口径："缺省 = 无逐格内容"；投影侧对称：没有说明就不写这两项
      expect(plain.tooltipPalette, '无说明时不得造一个空池').toBeUndefined()
      expect(plain.cellTooltipGrid).toBeUndefined()
    } finally {
      s.dispose()
    }
  })
})
