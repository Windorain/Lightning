/**
 * **工程切换不得复用上一份文件的 `fidelityFieldMap`**（真实回归）。
 *
 * ## 缺陷形态
 *
 * 打开含解析器**未知根级字段**的文件 A（`adoptLoadedDocument` 采集后交给
 * `KernelSession#setFidelityFieldMap`），再经 File 菜单打开工程 B。
 * `adoptProject` 走的是：
 *
 * ```
 * setDocument(projectedDoc)   ← Context#setDocument 只 markLoaded，不 markUnloaded
 *   → kernel.adoptDocument(B)
 * ```
 *
 * 而 `fidelityFieldMap` 只在 `adoptLoadedDocument` 置位、只在 `markUnloaded`
 * 清空。工程路径两处都不经过 ⇒ 会话里仍留着 A 的字段表；下一次 `plainForSave()`
 * （`composition/saveProjection` → `kernelProjection#fidelityFields`）会把 A 的
 * 根级字段写回 B 的产物根（串档）。
 *
 * ## 判据
 *
 * 1. **正常保真**：同一份 A 装载后直接保存，A 的未知根字段**必须仍在**产物根
 *    —— 否则"B 不带"可能只是"保真被全局关掉"，本修复不许靠禁用保真求绿；
 * 2. **前置**：A 装载后会话确实持有该字段（不是"从来没采集到"）；
 * 3. **B 接管**：经生产 `projectForSave` → `decodeProjectFile` → `adoptProject`
 *    打开工程 B 后，生产渲染定义面必须换成 B（**先证接管**，再断言 A 的字段不存在，
 *    否则"清空字段但没 adoptDocument"也会让负判据假绿）；
 * 4. **正判据**：再保存的产物根不含 A 的未知字段；会话映射回到 `null`（未采集）
 *    —— 工程格式不携带这份映射，诚实缺失，**不**伪造成 `{}`。
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
} from '@/context/parsers/builtinParsers'
import { makeAdoptedKernelReadHost, type KernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'

/** 解析器**不认识**的根级字段（不是 `PART_ROOT_FIELDS` 的已知键）。 */
const CANARY = 'projectSwitchFidelityCanary432'
const CANARY_VALUE = Object.freeze({ marker: 'only-in-A', nested: { keep: true } })

const A_FIXTURE = 'parts-singlebox-mix.v2.json'
const B_FIXTURE = 'parts-ae2-multibox.v2.json'

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

/** 真夹具 → 生产装配 → 真 `Context` 宿主（可选注入额外根字段）。 */
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

/** 生产保存投影的产物根（`plainForSave` 是保存/导出的唯一分流点）。 */
function saveRootOf(host: KernelReadHost): Record<string, unknown> {
  const saved = host.ctx.plainForSave()
  if (saved.plain === null) throw new Error('前提：已装配文档必须有保存投影')
  return saved.plain as Record<string, unknown>
}

describe('正常保真：同一份文件 A 的未知根字段必须仍在产物里', () => {
  it('装载 A → 直接保存：根级 canary 保留（修复不得靠全局禁用保真求绿）', async () => {
    const a = await loadHost(A_FIXTURE, { [CANARY]: CANARY_VALUE })
    try {
      // 前置：字段确实被采集（否则下面的"保留"是平凡的）。
      const fields = a.session?.fidelityFieldMapOf()
      expect(fields, '前提：A 装载后必须持有未知根字段').not.toBeNull()
      expect(fields?.[CANARY], '前提：采集到的正是注入的 canary').toEqual(CANARY_VALUE)

      const root = saveRootOf(a)
      expect(
        root[CANARY],
        '正常保存必须把 A 的未知根字段写回产物根 —— 这是"保真"的既有语义',
      ).toEqual(CANARY_VALUE)
    } finally {
      a.dispose()
    }
  })
})

describe('工程切换：A 的 fidelityFieldMap 不得并入工程 B', () => {
  it('A 带未知根字段 → 打开工程 B → 再保存：B 接管、A canary 不存在、映射诚实为 null', async () => {
    const a = await loadHost(A_FIXTURE, { [CANARY]: CANARY_VALUE })
    try {
      // ── 前置：A 的未知根字段确实在会话里，且正常保存会带出去 ──
      expect(a.session?.fidelityFieldMapOf(), '前提：A 装载后必须持有未知根字段').not.toBeNull()
      expect(saveRootOf(a)[CANARY], '前提：当前 A 的保存产物带 canary').toEqual(CANARY_VALUE)

      // ── 工程 B：真实 B 文件 → 生产保存 → 生产解码 → 生产 adoptProject ──
      const b = await loadHost(B_FIXTURE)
      try {
        const saved = projectForSave({ kernel: b.session!, setDocument: b.setDocument })
        expect(saved.ok, '前提：B 必须能走生产工程保存').toBe(true)
        if (!saved.ok) return
        const decoded = decodeProjectFile(JSON.parse(JSON.stringify(saved.value)) as unknown)
        expect(decoded.ok, '前提：自己写出的工程必须能被自己读回').toBe(true)
        if (!decoded.ok) return

        const adopted = adoptProject({ kernel: a.session!, setDocument: a.setDocument }, decoded.value)
        expect(adopted.ok, '工程 B 必须重开成功').toBe(true)

        // ── 先证 B 接管：定义面必须是 B 的调色板（不是 A 的 fence）──
        const definition = definitionOf(a)
        const registries = ((definition.blockPalette ?? []) as Array<{ registryId?: string }>).map(
          (entry) => entry.registryId ?? '',
        )
        expect(registries, '工程 B 必须真的接管定义面（palette = B 的 AE2 线缆）').toContain(
          'appliedenergistics2:tile.BlockCableBus',
        )
        expect(registries, 'A 的 fence 不得残留在 B 的定义面').not.toContain('minecraft:fence')

        // ── 正判据：再保存的产物根不许出现 A 的 canary（用户可见的串档）──
        const root = saveRootOf(a)
        expect(
          Object.prototype.hasOwnProperty.call(root, CANARY),
          '再保存的产物根不得出现 A 的未知字段',
        ).toBe(false)
        expect(JSON.stringify(root), 'A 的串档字段不得以任何形式进入 B 的产物').not.toContain(CANARY)
        // ── 并且会话映射回到"未采集"：工程不携带这份映射，诚实缺失、不伪造 {} ──
        expect(
          a.session?.fidelityFieldMapOf(),
          '工程格式不携带 fidelity 映射 ⇒ 必须回到 null（未采集），不得伪造 {}',
        ).toBeNull()
      } finally {
        b.dispose()
      }
    } finally {
      a.dispose()
    }
  })
})
