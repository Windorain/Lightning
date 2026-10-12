/**
 * **P10f D0 判据：算子层的行号→世界 Y 翻转（内核路径）**（#301）。
 *
 * ## 为什么单独一个文件（本批实测抓出的判据**空洞**）
 *
 * `tooltipEditWrite.test.ts`（#80 回归锁）的宿主把 `submitContentEdit` 替身成
 * `() => false` ⇒ 它**恰好**只覆盖 D0 的**回落分支**（那是它的本意）。
 * 于是我在算子里的"行号 → 世界 Y"翻转**完全没有判据**：
 * 注入"不翻转"后那 7 条**仍然全绿** —— 典型**空转**。本文件补上这条。
 *
 * ## 被钉的约定（两侧互为逆）
 *
 * | 侧 | 变换 | 依据 |
 * |---|---|---|
 * | 面板 → 算子 | `row = h - 1 - item.pos.y` | `TooltipEditorPanel.vue:58` |
 * | 算子 → 命令 | `worldY = frameHeight - 1 - row` | **本文件钉的就是它** |
 * | 命令 → 载荷 | 原样落 `cellContentKey(x, worldY, z)` | 命令不翻转（另有判据） |
 *
 * ⚠️ **高度取自 legacy `getDoc().frame(0)?.grid.height`**（与面板 `h` 同一来源）
 * ⇒ 本宿主必须同时提供 legacy 文档（面板口径）与内核会话（写路径）。
 */

import { describe, it, expect } from 'vitest'
import { ref, type Ref } from 'vue'
import { Context } from '@/runtime/context'
import { RuntimeDocument, RuntimeFrame, Grid } from '@/context/runtimeDocument'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'

const OBJ = 'structure:frame-0'
/** 高度 3 的网格：世界 y ∈ {0,1,2}。行号 = 2 - y（面板口径）。 */
const CELLS = { '0,0,0': 'a', '0,1,0': 'b', '0,2,0': 'c' }

interface Harness {
  ctx: Context
  session: KernelSession
  dispose(): void
}

/**
 * 造一个**真** `RuntimeDocument`：高度 3 的帧（面板的 `h` 从它读）。
 *
 * ⚠️ 用真文档而非手写替身 —— C′2 的实测教训：替身复刻被测形状时，
 * 一旦生产侧多调一个方法（这里是 `withAnnotations`，回写桥用的）
 * 就会以 `TypeError` 形式炸掉，而那不是"判据失败"而是"替身腐烂"。
 * 用真对象则**自动**跟随生产接口。
 */
function legacyDoc(): RuntimeDocument {
  const cells: (null | { name: string; meta: number })[][][] = [
    [
      [{ name: 'stone', meta: 0 }],
      [{ name: 'stone', meta: 0 }],
      [{ name: 'stone', meta: 0 }],
    ],
  ]
  return new RuntimeDocument({
    id: 'probe',
    frames: [new RuntimeFrame(0, undefined, new Grid(1, 3, 1, cells))],
  })
}

/** 真 `Context` + 真内核会话（`adoptDocument` 走生产装配序列）。 */
function harness(): Harness {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
  const scene = withObject(
    emptyScene('probe-scene'),
    sceneObject({ id: OBJ, type: 'block', dataId: `${OBJ}:data` }),
    objectData(`${OBJ}:data`, { kind: 'blockGrid', cells: CELLS }, 'document'),
  ) as Scene
  const withSceneDoc = withContent(base, scene, base.animation)
  const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
  session.adoptDocument(adopted, adopted.content)

  const docRef = ref(legacyDoc()) as unknown as Ref<RuntimeDocument | null>
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    main: { doc: docRef },
    kernel: session,
    getSelection: () => ({ active: ref(null), items: ref(new Set()) }),
  })
  Object.assign((ctx as unknown as { main: Record<string, unknown> }).main, {
    replaceDoc: (d: RuntimeDocument | null) => {
      docRef.value = d
    },
  })
  return { ctx, session, dispose: () => session.dispose() }
}

function tooltipAt(session: KernelSession, x: number, y: number, z: number): string | undefined {
  const doc = session.document()!
  const obj = findObject(doc.scene, OBJ)
  const data = obj === undefined ? undefined : findObjectData(doc.scene, obj.dataId)
  if (data === undefined || data.payload.kind !== 'blockGrid') return undefined
  return data.payload.cellContent?.[cellContentKey(x, y, z)]?.tooltip
}

describe('P10f D0 · 算子层行号→世界 Y（内核路径，非回落）', () => {
  it('行号 0（顶行）⇒ 世界 Y = height-1 = 2（**不得**落在 y=0）', () => {
    const h = harness()
    try {
      // 反空洞：必须真的装配成功，否则算子会走回落分支 ⇒ 本判据空转
      expect(h.session.hasAdoptedContent(), '必须先证明装配成功（否则走回落，判据空转）').toBe(true)

      TooltipEditOperator.exec!(h.ctx as never, {
        text: 'TOP',
        // 面板口径：行号 = h - 1 - y ⇒ 顶行(y=2) 的行号是 0
        pos: { x: 0, y: 0, z: 0 },
      } as never)

      expect(tooltipAt(h.session, 0, 2, 0), '行号 0 必须落世界 Y=2').toBe('TOP')
      expect(tooltipAt(h.session, 0, 0, 0), '**不得**落世界 Y=0（不翻转就会这样）').toBeUndefined()
      expect(tooltipAt(h.session, 0, 1, 0), '中间层不受影响').toBeUndefined()
    } finally {
      h.dispose()
    }
  })

  it('行号 2（底行）⇒ 世界 Y = 0', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      TooltipEditOperator.exec!(h.ctx as never, {
        text: 'BOTTOM',
        pos: { x: 0, y: 2, z: 0 },
      } as never)
      expect(tooltipAt(h.session, 0, 0, 0), '行号 2 必须落世界 Y=0').toBe('BOTTOM')
      expect(tooltipAt(h.session, 0, 2, 0), '**不得**落世界 Y=2').toBeUndefined()
    } finally {
      h.dispose()
    }
  })

  it('**双向**：两次写不同行 ⇒ 两层各得其所（不是"都写到同一层"）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      TooltipEditOperator.exec!(h.ctx as never, { text: 'T', pos: { x: 0, y: 0, z: 0 } } as never)
      TooltipEditOperator.exec!(h.ctx as never, { text: 'B', pos: { x: 0, y: 2, z: 0 } } as never)
      expect(tooltipAt(h.session, 0, 2, 0)).toBe('T')
      expect(tooltipAt(h.session, 0, 0, 0)).toBe('B')
    } finally {
      h.dispose()
    }
  })

  it('**内核真的被写**（`history.past` 增加 ⇒ 走的是内核路径而非回落）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      const before = h.session.document()!.history.past.length
      TooltipEditOperator.exec!(h.ctx as never, { text: 'X', pos: { x: 0, y: 1, z: 0 } } as never)
      expect(h.session.document()!.history.past.length, '内核必须记账（证明走了内核路径）').toBeGreaterThan(before)
    } finally {
      h.dispose()
    }
  })
})
