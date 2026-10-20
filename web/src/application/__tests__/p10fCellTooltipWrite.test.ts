/**
 * **P10f D0 判据：逐格说明写命令**（#301）。
 *
 * ## 要证明什么
 *
 * 1. **写生效**：命令 `applied`、内核 `cellContent[key].tooltip` 真的变了；
 * 2. **`null` ≠ `''`**（"删除"与"显式空说明"必须可区分 —— 内核 `cellContent` 的核心口径）；
 * 3. **幂等**：同值 ⇒ `unchanged`（不推进版本、不进历史）；
 * 4. **拒绝孤儿格**：写一个不在任何网格 `cells` 里的格必须被拒；
 * 5. **投影往返等价**：写完后经 `projectKernelDocument` 投回 legacy，
 *    `tooltipPalette`/`cellTooltipGrid` 能逐格解出我写的文本；
 * 6. ⚠️ **多帧文档：全部帧对象必须同时更新**（这是本命令**文档级**设计的理由）。
 *
 * ## 为什么第 6 条是本命令形态的依据
 *
 * legacy 侧 `tooltipPalette`/`cellTooltipGrid` 是**文档根**的**单个**网格，
 * 而装配把同一份说明复制到**每一个**帧对象（`kernelAssembly.ts:1559-1583`）。
 * 投影侧 `tooltipPoolOfPayloads`（`kernelProjection.ts:869-873`）取
 * **第一个**有池的载荷就返回 ⇒ 若只写一个帧对象，其余帧的说明**静默丢失**。
 * 故本命令必须**文档级**写入。
 *
 * ## 为什么不用真 `Context`（与 C′2 判据的差别）
 *
 * 本文件测的是**命令层**（`reduceSetCellTooltip`），输入就是 `ApplicationState`；
 * 用 `KernelSession.submit` 走的就是**生产命令通路**（`reduceCommand` 本体）。
 * ⇒ 不存在"宿主复刻被测算法"的空转风险（C′1/C′2 的教训在那里适用，因为被替代物**在** `Context` 上）。
 */

import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { projectKernelDocument } from '@/composition/kernelProjection'

/** 造最小内核会话；`grids` 里的每个元素是**一个** `blockGrid` 对象（多帧 = 多个）。 */
function sessionWith(grids: readonly Readonly<Record<string, string>>[]): KernelSession {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
  let scene: Scene = emptyScene('probe-scene')
  grids.forEach((cells, i) => {
    const id = `structure:frame-${i}`
    scene = withObject(
      scene,
      sceneObject({ id, type: 'block', dataId: `${id}:data` }),
      objectData(`${id}:data`, { kind: 'blockGrid', cells }, 'document'),
    ) as Scene
  })
  const withSceneDoc = withContent(base, scene, base.animation)
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

function tooltipAt(session: KernelSession, objectId: string, x: number, y: number, z: number): string | undefined {
  const doc = session.document()!
  const obj = findObject(doc.scene, objectId)
  const data = obj === undefined ? undefined : findObjectData(doc.scene, obj.dataId)
  if (data === undefined || data.payload.kind !== 'blockGrid') return undefined
  return data.payload.cellContent?.[cellContentKey(x, y, z)]?.tooltip
}

function write(session: KernelSession, x: number, y: number, z: number, text: string | null) {
  return submit(session, { kind: 'setCellTooltip', contextId: KERNEL_CONTEXT_ID, cells: [{ x, y, z }], text })
}

describe('P10f D0 · ① 写生效 + 三态语义', () => {
  it('写文案后内核 `cellContent[key].tooltip` 生效', () => {
    const s = sessionWith([CELLS])
    try {
      expect(write(s, 0, 0, 0, 'hello')?.status, '写必须 applied').toBe('applied')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0)).toBe('hello')
      // 未写的格不得被牵连
      expect(tooltipAt(s, 'structure:frame-0', 1, 0, 1)).toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it("**`null` ≠ `''`**：删除与「显式空说明」必须可区分", () => {
    const s = sessionWith([CELLS])
    try {
      write(s, 0, 0, 0, 'x')
      // `''` ⇒ 字段**在**且为 `''`（显式"说明了空"）
      write(s, 0, 0, 0, '')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '空串必须是「有字段且为空」').toBe('')
      // 写回有值，再 `null` ⇒ 字段**缺席**
      write(s, 0, 0, 0, 'y')
      write(s, 0, 0, 0, null)
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '`null` 必须移除字段（缺席 ≠ 空）').toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('**幂等**：同值 ⇒ `unchanged`（不推进版本、不进历史）', () => {
    const s = sessionWith([CELLS])
    try {
      write(s, 0, 0, 0, 'same')
      const pastBefore = s.document()!.history.past.length
      expect(write(s, 0, 0, 0, 'same')?.status, '同值必须 unchanged').toBe('unchanged')
      expect(s.document()!.history.past.length, 'unchanged 不得进历史').toBe(pastBefore)
    } finally {
      s.dispose()
    }
  })

  it('**拒绝孤儿格**：写不在任何网格 `cells` 里的格 ⇒ 拒绝', () => {
    const s = sessionWith([CELLS])
    try {
      // (9,9,9) 不在 CELLS 里
      expect(write(s, 9, 9, 9, 'nope')?.status, '无此格必须拒绝').toBe('rejected')
      expect(tooltipAt(s, 'structure:frame-0', 9, 9, 9)).toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('**历史记账**：真写入必须进历史（可撤销）', () => {
    const s = sessionWith([CELLS])
    try {
      const before = s.document()!.history.past.length
      write(s, 0, 0, 0, 'a')
      expect(s.document()!.history.past.length, '写入必须进历史').toBeGreaterThan(before)
    } finally {
      s.dispose()
    }
  })
})

describe('P10f D0 · ② ⚠️ 多帧文档：**全部**帧对象同时更新', () => {
  it('两个帧对象都含该格 ⇒ 一条命令同时改两边（否则投影只取第一份池，其余帧静默丢失）', () => {
    const s = sessionWith([CELLS, CELLS])
    try {
      expect(write(s, 0, 0, 0, 'both')?.status, '写必须 applied').toBe('applied')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '帧 0 必须更新').toBe('both')
      expect(tooltipAt(s, 'structure:frame-1', 0, 0, 0), '**帧 1 也必须更新**（本命令文档级的理由）').toBe('both')
      // 一条命令 = 一条历史（不是两帧各一条）
      expect(s.document()!.history.past.length, '原子：两帧各一条历史会让撤销语义碎裂').toBe(1)
    } finally {
      s.dispose()
    }
  })

  it('**反空洞**：只更新真的含该格的帧（另一帧没有这一格 ⇒ 不动它）', () => {
    const onlyFrame0 = { '0,0,0': 'minecraft:stone' }
    const onlyFrame1 = { '5,0,5': 'minecraft:dirt' }
    const s = sessionWith([onlyFrame0, onlyFrame1])
    try {
      write(s, 0, 0, 0, 'f0only')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0)).toBe('f0only')
      // 帧 1 没有 (0,0,0) ⇒ 不该有该键（"孤儿键"会让投影报警）
      expect(tooltipAt(s, 'structure:frame-1', 0, 0, 0)).toBeUndefined()
    } finally {
      s.dispose()
    }
  })
})

describe('P10f D0 · ②b 多格（面板多选）：一条命令原子写多格', () => {
  it('多格同写 ⇒ 一次事务、一条历史，逐格生效', () => {
    const s = sessionWith([CELLS])
    try {
      const out = submit(s, {
        kind: 'setCellTooltip',
        contextId: KERNEL_CONTEXT_ID,
        cells: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 1 },
        ],
        text: 'multi',
      })
      expect(out?.status, '多格写必须 applied').toBe('applied')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0)).toBe('multi')
      expect(tooltipAt(s, 'structure:frame-0', 1, 0, 1)).toBe('multi')
      expect(s.document()!.history.past.length, '一次事务 = 一条历史').toBe(1)
      // 变更摘要必须逐格列出（"改了哪些格"可见）
      const entry = s.document()!.history.past[0]!
      expect(entry.changes.changedProperties.length, '两个格 ⇒ 两条变更项').toBe(2)
    } finally {
      s.dispose()
    }
  })

  it('**部分失败整批拒**：多格里有一个不存在 ⇒ 全拒（不留半成品）', () => {
    const s = sessionWith([CELLS])
    try {
      const out = submit(s, {
        kind: 'setCellTooltip',
        contextId: KERNEL_CONTEXT_ID,
        cells: [
          { x: 0, y: 0, z: 0 },
          { x: 9, y: 9, z: 9 }, // 不存在
        ],
        text: 'partial',
      })
      expect(out?.status, '有孤儿格 ⇒ 整批拒绝').toBe('rejected')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '**已存在的那个格也不得被写**（原子性）').toBeUndefined()
      expect(s.document()!.history.past.length, '拒绝不得进历史').toBe(0)
    } finally {
      s.dispose()
    }
  })

  it('**拒绝重复格**（重复会让变更摘要出现同目标两项）', () => {
    const s = sessionWith([CELLS])
    try {
      const out = submit(s, {
        kind: 'setCellTooltip',
        contextId: KERNEL_CONTEXT_ID,
        cells: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
        ],
        text: 'dup',
      })
      expect(out?.status).toBe('rejected')
    } finally {
      s.dispose()
    }
  })
})

describe('P10f D0 · ②c 坐标契约：命令吃**世界坐标**，**不做**行序翻转', () => {
  /**
   * ## 为什么这条存在（我第一版实现的错误，以及它该由谁抓）
   *
   * 调用方（`TooltipEditorPanel.vue:58`）传给算子的 `pos.y` 是
   * `row = h - 1 - item.pos.y` —— **自上而下的行号**，不是世界 Y；
   * 而装配侧要紧回来（`kernelPaletteAssembly.ts:260`：`y = sizeRow - 1 - row`）。
   *
   * 我第一版在**算子**里把 `pos.y` 当**世界 Y** 直接传给命令 ⇒ 写到镜像的那一行。
   * 那个错误的**正判据**在算子层（`tooltipEditWrite.test.ts` 的 #80 回归锁，
   * 它当场判红抓出了我这次错误），**不在**本文件。
   *
   * ## 本组钉的是**命令的坐标契约**（另一件事，也必须钉）
   *
   * 命令收的是**世界坐标**并**原样**落键 ⇒ 它**不得**自己再翻一次
   * （算子已经翻过；命令再翻 = 双重翻转 = 又回到错行）。
   * 用**不对称**网格（高度 3）钉住：写 y=2 就落 y=2，写 y=0 就落 y=0，互不影响。
   */
  it('写哪一层的世界 Y 就落哪一层（命令不翻转、不错位）', () => {
    // 高度 3：世界 y ∈ {0,1,2}
    const tall = { '0,0,0': 'a', '0,1,0': 'b', '0,2,0': 'c' }
    const s = sessionWith([tall])
    try {
      write(s, 0, 2, 0, 'top')
      expect(tooltipAt(s, 'structure:frame-0', 0, 2, 0), '写 y=2 必须落 y=2').toBe('top')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '**不得**落到 y=0（若命令自己翻转就会这样）').toBeUndefined()

      write(s, 0, 0, 0, 'bottom')
      expect(tooltipAt(s, 'structure:frame-0', 0, 0, 0), '写 y=0 必须落 y=0').toBe('bottom')
      expect(tooltipAt(s, 'structure:frame-0', 0, 2, 0), '先前写的 y=2 不受影响').toBe('top')
    } finally {
      s.dispose()
    }
  })
})

describe('P10f D0 · ③ 投影往返：内核写 → legacy 侧表逐格等价', () => {
  it('写完一格的说明，投回 legacy 的侧表必须能解出同一文本', () => {
    const s = sessionWith([CELLS])
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
    const s = sessionWith([CELLS])
    try {
      const doc = s.document()!
      const plain = projectKernelDocument({ scene: doc.scene, content: doc.content }).plain as Record<string, unknown>
      expect(plain.tooltipPalette, '无说明时不得造一个空池').toBeUndefined()
      expect(plain.cellTooltipGrid).toBeUndefined()
    } finally {
      s.dispose()
    }
  })
})
