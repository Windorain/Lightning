/**
 * **工程切换不得复用上一份文件的根级部件字段**（真实回归）。
 *
 * ## 缺陷形态
 *
 * 打开文件 A（带 `itemIndex` / `partIconTextures` 等文档根级字段）后，
 * 再打开工程 B。`adoptProject` 走的是：
 *
 * ```
 * setDocument(projectedDoc)   ← Context#setDocument 只 markLoaded，不 markUnloaded
 *   → kernel.adoptDocument(B)
 * ```
 *
 * 而 `assemblySourceRoot` 只在 `adoptLoadedDocument` 置位、只在 `markUnloaded`
 * 清空。工程路径两处都不经过 ⇒ 会话里仍留着 A 的源根，渲染定义会把 A 的
 * `itemIndex`/`partIconTextures` 套到 B 上（侧栏行/图标串档）。
 *
 * ## 判据
 *
 * 1. **前置**：A 装载后，生产渲染面 `Context#kernelRenderSourceFace()` 的定义根
 *    确实带 A 的根级字段（否则下面的"不带"可能只是"从来没带过"）；
 * 2. **正判据**：打开工程 B 后 `kernelSourceRoot()` 必须回到 `null`；
 *    生产渲染面的 `definitionAt(0).definition` 不得再出现 A 的任何根级字段；
 * 3. 键面用既有常量 `PART_ROOT_FIELDS`（读写同一份清单），不是手写字面量。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { plainRootOf } from '@/adapters/plainRoot'
import { adoptProject, decodeProjectFile, projectForSave } from '@/composition/projectIo'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
  PART_ROOT_FIELDS,
} from '@/context/parsers/builtinParsers'
import { ITEM_INDEX_FIELD } from '@/pure/itemIndex'
import { makeAdoptedKernelReadHost, type KernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'

/** 与生产宿主同一份注册顺序。 */
function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

function readFixture(fileName: string): Record<string, unknown> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', fileName)
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

/** 真夹具 → 生产装配 → 真 `Context` 宿主（可选注入源根字段）。 */
async function loadHost(
  fileName: string,
  rootFields?: Readonly<Record<string, unknown>>,
): Promise<KernelReadHost> {
  const raw = readFixture(fileName)
  const sourceRoot = rootFields === undefined ? raw : { ...raw, ...rootFields }
  const parsed = await productionRegistry().detectAndParse(sourceRoot)
  if (parsed.document === null) throw new Error(`${fileName} 解析失败`)
  return makeAdoptedKernelReadHost(
    parsed.document as never,
    rootFields === undefined ? undefined : plainRootOf(sourceRoot),
  )
}

/** 生产渲染面：第 0 帧定义根。 */
function definitionOf(host: KernelReadHost): Record<string, unknown> {
  const face = host.ctx.kernelRenderSourceFace()
  if (face === null) throw new Error('前提：生产渲染面必须在场')
  const def = face.definitionAt(0)?.definition
  if (def === undefined) throw new Error('前提：第 0 帧定义面必须在场')
  return def as unknown as Record<string, unknown>
}

describe('工程切换：上一份文件的根级部件字段不得串到工程 B', () => {
  it('A 带根级字段 → 打开工程 B：kernelSourceRoot 与渲染定义都不带 A 的字段', async () => {
    const aFields: Record<string, unknown> = {
      [ITEM_INDEX_FIELD]: {
        'minecraft:stone:0': {
          display: 'Stone',
          tooltip: ['Stone'],
          source: 'part',
          attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
        },
      },
      partIconTextures: { 'minecraft:stone:0': 'data:image/png;base64,AA==' },
      statsTemplate: { rows: [{ key: 'A' }] },
      statsOverride: { rows: [{ key: 'A-override' }] },
    }
    // 键面与生产清单同源：本用例覆盖 PART_ROOT_FIELDS 的全部键。
    expect(Object.keys(aFields).sort()).toEqual([...PART_ROOT_FIELDS].sort())

    const a = await loadHost('parts-singlebox-mix.v2.json', aFields)
    try {
      // ── 前置：A 的生产渲染面确实带着 A 的根级字段（否则"B 不带"没有区分力）──
      expect(a.ctx.kernelSourceRoot(), 'A 装载后必须采集到源根').not.toBeNull()
      const before = definitionOf(a)
      for (const key of PART_ROOT_FIELDS) {
        expect(Reflect.get(before, key), `前置：A 的定义根必须带 ${key}`).toEqual(aFields[key])
      }

      // ── 工程 B：真实 B 文件 → 生产保存 → 生产解码 → 生产 adoptProject ──
      const b = await loadHost('parts-ae2-multibox.v2.json')
      let decoded: ReturnType<typeof decodeProjectFile>
      try {
        const saved = projectForSave({ kernel: b.session!, setDocument: b.setDocument })
        expect(saved.ok, '前提：B 必须能走生产工程保存').toBe(true)
        if (!saved.ok) return
        decoded = decodeProjectFile(JSON.parse(JSON.stringify(saved.value)) as unknown)
      } finally {
        b.dispose()
      }
      expect(decoded.ok, '前提：自己写出的工程必须能被自己读回').toBe(true)
      if (!decoded.ok) return

      const adopted = adoptProject({ kernel: a.session!, setDocument: a.setDocument }, decoded.value)
      expect(adopted.ok, '工程 B 必须重开成功').toBe(true)

      // ── 正判据：源根回到"未采集"；生产定义根不再带 A 的任何键 ──
      expect(
        a.ctx.kernelSourceRoot(),
        '工程重开后必须清掉 A 的无损源根（null = 未采集，不是 A 的根）',
      ).toBeNull()
      const after = definitionOf(a)
      // 先证明"确实换成了 B"：B 的调色板是 AE2 线缆，A 的 fence 必须消失。
      // （否则"清空源根但没 adoptDocument"也会让下面的"无 A 字段"假绿。）
      const registries = ((after.blockPalette ?? []) as Array<{ registryId?: string }>).map(
        (e) => e.registryId ?? '',
      )
      expect(registries, '工程 B 必须真的接管定义面（palette = B 的 AE2 线缆）').toContain(
        'appliedenergistics2:tile.BlockCableBus',
      )
      expect(registries, 'A 的 fence 不得残留在 B 的定义面').not.toContain('minecraft:fence')
      for (const key of PART_ROOT_FIELDS) {
        expect(Reflect.get(after, key), `工程 B 的定义根不得带 A 的 ${key}`).toBeUndefined()
      }
      // 具体到消费路径：侧栏反查索引为空（B 没有 itemIndex ⇒ 不命中 A 的物品键）。
      expect(Object.prototype.hasOwnProperty.call(after, ITEM_INDEX_FIELD), 'itemIndex 键不得残留').toBe(false)
    } finally {
      a.dispose()
    }
  })
})
