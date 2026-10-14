/**
 * **`textureBlobs` 形态契约 · 判据**（#387 同族批）。
 *
 * ## 这份判据补的那一格
 *
 * `textureBlobs` 在生产里有**两种契约形态**，由**生产者**决定（不是实现选择）：
 *
 * | 形态 | 生产者 | 空洞表示 |
 * |---|---|---|
 * | 槽位键对象 `{"0":"<b64>", …}` | `composition/kernelProjection.ts:1406-1408`（**帧为主**文档 = `plainForSave().plain`） | 键缺席 |
 * | 数组 `["<b64>", …]` | ① `composition/kernelPresentationInputs.ts:397-404`（内核材质面）；② `composition/kernelProjection.ts:1403-1405`（**多方块**） | ①`undefined` 空洞；②`''` 占位 |
 *
 * 两种形态都会在**相遇点**被遇到，而三个相遇点此前各自失明（只认数组 / 只认全密数组 /
 * `.filter` 压紧错位）。本判据把"两种形态都必须被正确处理"变成机械可红的读数，
 * 并给出**逐条能红的负对照**。
 *
 * ## 负对照为什么必须"能红"（本判据的做法）
 *
 * 「能红」不能靠嘴说：本判据对每个正判据都跑一遍**旧实现**（`.filter` 压紧版，
 * `legacyExtractTextureBlobs` 是 `bundleMaterialBaking.ts` 修复前的**逐字副本**），
 * 断言**同一读数在旧实现下必然不同**（`expect(old).not.toBe(current)`）。
 * 这样"判据有区分力"本身是被测的 —— 若哪天负对照不再有差异，判据当场判红。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  hasTextureBlobAt,
  isTextureBlobPoolShaped,
  normalizeTextureBlobPool,
  textureBlobPoolOf,
} from '@/render/data/textureBlobPool'
import { resourceDigestOf } from '@/presentation/contentIdentity'
import { extractTextureBlobs } from '@/workbench/export/bundleMaterialBaking'

// ─────────────────────────────────────────────────────────────────────────────
// 负对照：修复前的实现（逐字副本）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `web/src/workbench/export/bundleMaterialBaking.ts` **修复前**的数组分支（逐字）：
 *
 * ```ts
 * if (Array.isArray(raw)) {
 *   return (raw as unknown[]).filter((x) => typeof x === 'string') as string[]
 * }
 * ```
 *
 * 它是"压紧"语义 ⇒ 空洞之后的槽位整体前移。
 */
function legacyExtractTextureBlobs(normalizedDocument: unknown): string[] {
  if (normalizedDocument === null || typeof normalizedDocument !== 'object') return []
  const raw = (normalizedDocument as { textureBlobs?: unknown }).textureBlobs
  if (Array.isArray(raw)) {
    return (raw as unknown[]).filter((x) => typeof x === 'string') as string[]
  }
  if (raw !== null && typeof raw === 'object') {
    const out: string[] = []
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      const idx = Number(k)
      if (!Number.isInteger(idx) || idx < 0) continue
      out[idx] = v
    }
    return out
  }
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 1：数组形态 —— 位置保持（空洞不得使后继槽位前移）
// ─────────────────────────────────────────────────────────────────────────────

describe('形态契约 ①：数组形态（含空洞）必须位置保持', () => {
  /** 稀疏数组：槽位 0 与 2 有字节，槽位 1 是空洞（内核材质面对无 payload 的条留 `undefined`）。 */
  const sparse = ['a', , 'c'] as unknown as unknown[]

  it('正：blobs[1] 是"无字节"占位、blobs[2] 仍是槽位 2 的字节', () => {
    const out = normalizeTextureBlobPool(sparse)
    expect(out.length, '归一化结果的长度必须等于入参长度（位置保持）').toBe(3)
    expect(out[0]).toBe('a')
    expect(hasTextureBlobAt(out, 1), '槽位 1 = 空洞 ⇒ 无字节').toBe(false)
    expect(out[2], '槽位 2 必须仍是 "c"（不得前移到 [1]）').toBe('c')
    expect(hasTextureBlobAt(out, 2)).toBe(true)
  })

  it('正：`null` / 嵌套对象元素同样只是"无字节"，不影响其它槽位', () => {
    // 注意：JSON 无法表达 `undefined` 空洞，存盘后变 `null`；旧文档还会把元素写成对象。
    const withNull = ['a', null, 'c'] as unknown[]
    const out = normalizeTextureBlobPool(withNull)
    expect(out.length).toBe(3)
    expect(out[2]).toBe('c')

    const withObject = ['a', { id: 'x', mime: 'image/png', dataBase64: 'c' }, 'c'] as unknown[]
    const out2 = normalizeTextureBlobPool(withObject)
    expect(out2.length).toBe(3)
    expect(out2[1], '嵌套对象元素不是裸 base64 ⇒ "无字节"占位').toBe('')
    expect(out2[2], '后继槽位不得被它挤走').toBe('c')
  })

  it('负对照（能红）：修复前的 `.filter` 实现 ⇒ 槽位 2 的字节前移到 [1]', () => {
    const current = normalizeTextureBlobPool(sparse)
    const old = legacyExtractTextureBlobs({ textureBlobs: sparse })
    expect(old.length, '旧实现压紧 ⇒ 长度变短').toBe(2)
    expect(old[1], '旧实现里 [1] 变成了槽位 2 的字节').toBe('c')
    // 同一断言（"取槽位 2"）在旧实现下必然红：
    expect(old[2], '旧实现取槽位 2 ⇒ 取不到（静默错图的形态）').toBeUndefined()
    expect(current[2]).not.toBe(old[2])
  })

  it('负对照（能红）：`.filter` 压紧对含**真空洞**的数组必然缩短长度（`""` 占位不算空洞）', () => {
    // 注意口径差别：`''` 是**字符串** ⇒ `.filter` 保留它（占位数组长度不变）；
    // 只有**真空洞 / null / 嵌套对象**才会被 `.filter` 丢掉 ⇒ 后继槽位前移。
    expect(legacyExtractTextureBlobs({ textureBlobs: ['a', '', 'c'] }), '`""` 占位被 filter 保留').toEqual(['a', '', 'c'])
    expect(legacyExtractTextureBlobs({ textureBlobs: ['a', null, 'c'] }), 'null 被 filter 丢掉 ⇒ 长度 2').toEqual(['a', 'c'])
    // ⇒ 判别"位置保持"的输入必须含真空洞或非字符串元素：
    expect(normalizeTextureBlobPool(['a', , 'c']).length).toBe(3)
    expect(legacyExtractTextureBlobs({ textureBlobs: ['a', , 'c'] }).length).toBe(2)
  })

  it('正：已规范（全 string 密数组）时返回入参本身（渲染帧循环里的零拷贝路径）', () => {
    const dense = ['a', 'b']
    expect(normalizeTextureBlobPool(dense)).toBe(dense)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 2：对象形态 —— 槽位键表必须按数值键落位
// ─────────────────────────────────────────────────────────────────────────────

describe('形态契约 ②：槽位键对象必须被接受（帧为主文档的投影形态）', () => {
  /** 帧为主文档的投影产物形态：键 = 槽位下标，空洞 = 键缺席。 */
  const slotKeyed = { '0': 'A', '2': 'C' } as Record<string, string>

  it('正：按数值键落位成位置保持数组（稀疏 = 槽位缺席）', () => {
    const out = normalizeTextureBlobPool(slotKeyed)
    expect(out.length).toBe(3)
    expect(out[0]).toBe('A')
    expect(hasTextureBlobAt(out, 1), '键缺席 = 该槽位无字节').toBe(false)
    expect(out[2], '槽位 2 必须仍落在 [2]').toBe('C')
  })

  it('正：非数值键与非字符串值不占槽位（不得当成槽位）', () => {
    const out = normalizeTextureBlobPool({ '0': 'A', name: 'nope', '1': 42, '2': 'C' })
    expect(out.length).toBe(3)
    expect(out[0]).toBe('A')
    expect(hasTextureBlobAt(out, 1)).toBe(false)
    expect(out[2]).toBe('C')
  })

  it('正：两种形态在**同一逻辑内容**下产出同一标准化结果（相遇点口径一致）', () => {
    expect(normalizeTextureBlobPool(slotKeyed)).toEqual(
      normalizeTextureBlobPool([...normalizeTextureBlobPool(slotKeyed)]),
    )
    // 对象的"键缺席"与数组的 `''` 占位在归一化后语义相同（同判无字节，且同占下标）：
    expect(hasTextureBlobAt(normalizeTextureBlobPool({ '0': 'A', '2': 'C' }), 1)).toBe(
      hasTextureBlobAt(normalizeTextureBlobPool(['A', '', 'C']), 1),
    )
  })

  it('负对照（能红）：修复前的实现对应"只认数组"的相遇点 ⇒ 对象形态枚举 0 条', () => {
    // 相遇点的旧判定（`render/data/sceneDocumentMaterialHydrate.ts:31-32` 修复前）：
    const legacyArrayOnly = (doc: { textureBlobs?: unknown }): string[] =>
      Array.isArray(doc.textureBlobs) ? (doc.textureBlobs as string[]) : []
    expect(legacyArrayOnly({ textureBlobs: slotKeyed }).length, '只认数组 ⇒ 一条都取不到').toBe(0)
    expect(normalizeTextureBlobPool(slotKeyed).length, '归一化后必须取到').toBe(3)
    expect(
      hasTextureBlobAt(normalizeTextureBlobPool(slotKeyed), 2),
      '只认数组的相遇点会让槽位 2 的字节彻底不可见（等轴 PNG 导出实测无贴图）',
    ).toBe(true)
  })

  it('负对照（能红）：`.filter` 式"先断言全密"判定会把对象形态判成"无池"', () => {
    // 相遇点的旧判定（`render/data/bundleResolve.ts:77-83` 修复前）：
    const legacyRootTextureBlobs = (document: unknown): string[] | null => {
      const d = document as Record<string, unknown>
      const raw = d.textureBlobs
      if (!Array.isArray(raw) || raw.length === 0) return null
      if (!raw.every((x) => typeof x === 'string' && (x as string).length > 0)) return null
      return raw as string[]
    }
    expect(legacyRootTextureBlobs({ textureBlobs: slotKeyed }), '对象形态 ⇒ null（校验整体跳过）').toBeNull()
    expect(
      legacyRootTextureBlobs({ textureBlobs: ['A', '', 'C'] }),
      '稀疏数组 ⇒ 也 null（校验同样跳过）',
    ).toBeNull()
    // 归一化路径不产生"无池"假象：
    expect(textureBlobPoolOf({ textureBlobs: slotKeyed }).length).toBe(3)
    expect(textureBlobPoolOf({ textureBlobs: ['A', '', 'C'] }).length).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 3：导出侧相遇点（`extractTextureBlobs`）两种形态都可用
// ─────────────────────────────────────────────────────────────────────────────

describe('形态契约 ③：导出侧相遇点 extractTextureBlobs 两种形态都取到字节', () => {
  it('正：对象形态（真入口 = plainForSave().plain）按槽位取到字节', () => {
    const doc = { textureBlobs: { '0': 'A', '1': 'B' } }
    expect(extractTextureBlobs(doc)).toEqual(['A', 'B'])
  })

  it('正：数组形态（内核材质面）位置保持，空洞不使后继前移', () => {
    const doc = { textureBlobs: ['A', , 'C'] as unknown[] }
    const out = extractTextureBlobs(doc)
    expect(out.length).toBe(3)
    expect(out[2]).toBe('C')
  })

  it('负对照（能红）：修复前的实现 ⇒ 对象形态整表返回 `[]`（OBJ 导出 1234/1234 无贴图的形态）', () => {
    const doc = { textureBlobs: { '0': 'A', '1': 'B' } }
    // 修复前（997fa8ba 之前）的 `extractTextureBlobs` 只有数组分支 ⇒ 对象形态整表取不到：
    const before997fa8ba = (d: { textureBlobs?: unknown }): string[] =>
      Array.isArray(d.textureBlobs)
        ? ((d.textureBlobs as unknown[]).filter((x) => typeof x === 'string') as string[])
        : []
    expect(before997fa8ba(doc), '只认数组 ⇒ 对象形态整表取不到').toEqual([])
    expect(extractTextureBlobs(doc), '修复后必须取到').toEqual(['A', 'B'])
    expect(extractTextureBlobs(doc)).not.toEqual(before997fa8ba(doc))
  })

  it('负对照（能红）：修复前的位置保持缺失 ⇒ 同一稀疏数组在旧实现下长度不同', () => {
    const doc = { textureBlobs: ['A', , 'C'] as unknown[] }
    const current = extractTextureBlobs(doc)
    const old = legacyExtractTextureBlobs(doc)
    expect(old.length, '旧实现压紧 ⇒ 长度 2').toBe(2)
    expect(current.length, '位置保持 ⇒ 长度 3').toBe(3)
    expect(old[2]).toBeUndefined()
    expect(current[2]).toBe('C')
  })

  it('正：`textureBlobs` 缺席/形态非法 ⇒ 空表（不抛）', () => {
    expect(extractTextureBlobs({})).toEqual([])
    expect(extractTextureBlobs({ textureBlobs: null })).toEqual([])
    expect(extractTextureBlobs({ textureBlobs: 'not-a-pool' })).toEqual([])
    expect(extractTextureBlobs(null)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 4：形态解析**只在一处**（§15 同一语义不得有第二处实现）
// ─────────────────────────────────────────────────────────────────────────────

describe('形态契约 ④：形态解析只许在 textureBlobPool.ts 一处实现', () => {
  const SRC = path.join(process.cwd(), 'src')
  /** CRLF 归一化（铁律 6）：本仓 `core.autocrlf=true`，新鲜检出是 CRLF。 */
  const read = (rel: string): string =>
    fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

  /**
   * 剥掉注释后再探测（**本判据第一版在这里判红，实测记录**）：
   *
   * 第一版直接对整份源码做正则，结果 `workbench/export/bundleMaterialBaking.ts` 判红 ——
   * 命中的是**文档注释里引用的修复前代码**（`:56` 逐字引用 `.filter((x) => typeof x === 'string')`，
   * 那是本批要求的**可追溯性**留痕）。⇒ 判据必须只看**实现代码**：注释里引用旧实现
   * 是"记录过去"，不是"第二处实现"。负对照见下一条（注释形态**不得**命中，代码形态**必须**命中）。
   *
   * 口径：块注释整体删除；行注释只删**整行**（保守，避免误伤含 `//` 的字符串字面量）。
   */
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/^\s*\/\/.*$/gm, '')

  /** 形态判别式（实现代码里出现即视为"自己解析形态"）。 */
  const SHAPE_PROBE =
    /Array\.isArray\([^)]*textureBlobs/
  /** 在给定文本上直接探测（**不**剥注释；供负对照证明"剥注释"这一步有区分力）。 */
  const rawProbe = (text: string): boolean =>
    SHAPE_PROBE.test(text)
    || /Object\.entries\([^)]*textureBlobs/.test(text)
    || /\.filter\(\s*\(\s*x\s*\)\s*=>\s*typeof x === 'string'\s*\)/.test(text)
  /** 判据本尊用的探测：只看实现代码。 */
  const probeShape = (code: string): boolean => rawProbe(stripComments(code))

  /** 逐个消费者断言：不得**自己**做形态判别（`Array.isArray(....textureBlobs)` / `Object.entries(....textureBlobs)`）。 */
  const CONSUMERS = [
    'render/data/sceneDocumentMaterialHydrate.ts',
    'render/data/bundleResolve.ts',
    'workbench/export/bundleMaterialBaking.ts',
  ] as const

  for (const rel of CONSUMERS) {
    it(`正：${rel} 不再自己解析形态（只调归一化函数）`, () => {
      const code = read(rel)
      expect(
        probeShape(code),
        `${rel} 的**实现代码**里出现了自己的形态判别（应改调 textureBlobPool.ts）`,
      ).toBe(false)
      expect(code, `${rel} 必须真的委托归一化函数（否则上一条可能是恒真）`).toContain(
        'textureBlobPool',
      )
    })
  }

  it('负对照（能红）：修复前的**实现代码**确实命中判别式（判别力证明）', () => {
    // 用保存的**修复前**片段复刻同一判别式，证明上面的断言不是恒真。
    const legacySnippet = [
      'if (Array.isArray(raw)) {',
      "  return (raw as unknown[]).filter((x) => typeof x === 'string') as string[]",
      '}',
    ].join('\n')
    expect(
      /\.filter\(\s*\(\s*x\s*\)\s*=>\s*typeof x === 'string'\s*\)/.test(legacySnippet),
      '修复前的**代码**片段必须命中判别式（否则该断言无区分力）',
    ).toBe(true)
    expect(
      /Array\.isArray\([^)]*textureBlobs/.test(stripComments('if (!Array.isArray(root.textureBlobs)) return []')),
      '只认数组的旧判定必须命中判别式',
    ).toBe(true)
  })

  it('负对照（能红）：**注释里**引用修复前实现不得命中（否则可追溯性与判据互相打架）', () => {
    const legacyInComment = [
      '/**',
      ' * 此前的数组分支写的是 `.filter((x) => typeof x === \'string\')`（压紧语义）。',
      ' * 旧判定：`if (!Array.isArray(root.textureBlobs)) return []`',
      ' */',
      'export function extractTextureBlobs(d: unknown): string[] {',
      '  return textureBlobPoolOf(d) as string[]',
      '}',
    ].join('\n')
    // 不剥注释 ⇒ 必然命中（这正是第一版判据在这个文件上误红的原因）：
    expect(rawProbe(legacyInComment), '整份源码（含注释）会误命中').toBe(true)
    // 剥掉注释后只剩委托 ⇒ 不命中：
    const impl = stripComments(legacyInComment)
    expect(SHAPE_PROBE.test(impl), '剥注释后不得命中').toBe(false)
    expect(/\.filter\(\s*\(\s*x\s*\)\s*=>\s*typeof x === 'string'\s*\)/.test(impl)).toBe(false)
    // 同一条线索：把同一模式放进**代码**位置，剥注释也必须命中（证明剥注释没把代码也剥掉）。
    expect(probeShape('const a = Array.isArray(x.textureBlobs) ? x.textureBlobs : []')).toBe(true)
  })

  it('正：归一化函数的存在性（唯一落点就在本文件）', () => {
    const pool = read('render/data/textureBlobPool.ts')
    expect(pool).toContain('export function normalizeTextureBlobPool')
    expect(pool).toContain('export function hasTextureBlobAt')
    expect(pool).toContain('export function textureBlobPoolOf')
  })

  it('正：`isTextureBlobPoolShaped` 对"非池"值不误判（摘要类消费者先判形态的依据）', () => {
    expect(isTextureBlobPoolShaped(['A', 'B'])).toBe(true)
    expect(isTextureBlobPoolShaped({ '0': 'A' })).toBe(true)
    // 非槽位键 ⇒ 不是池（若被归一化会丢内容 ⇒ 摘要恒等的假绿；实测 contentIdentity 3 条判红）
    expect(isTextureBlobPoolShaped({ stone: 'AAAA' })).toBe(false)
    expect(isTextureBlobPoolShaped([{ stone: 'AAAA' }])).toBe(false)
    expect(isTextureBlobPoolShaped('not-a-pool')).toBe(false)
    expect(isTextureBlobPoolShaped(null)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 5：第三种元素形态（`{id,mime,dataBase64}`）—— **不是**契约形态，不得当字节
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这一格补的是什么
 *
 * 仓里还有**第三种**写法：`textureBlobs` 是数组，但元素是对象 `{id,mime,dataBase64}`。
 * 它不是生产契约形态（下表是**实测**的来源核查，不是推断），却出现在多份判据的输入里
 * `web/e2e/fixtures/{minimal-v2,parts-singlebox-mix.v2,parts-ae2-multibox.v2}.json`
 * —— 形态前提**不能悬空**，所以本判据把它变成机械读数。
 *
 * | 核查项 | 实测 |
 * |---|---|
 * | 生产者（Java 导出） | `mod/gtnh/src/main/java/com/lightning/mod/client/export/TextureBlobEmbedder.java:116` 写的是 `blobs.add(new JsonPrimitive(base64))` ⇒ **裸 base64 串数组**；无材质槽时 `:67` 同样只放一个裸串 |
 * | 格式契约（proto） | `protocol/lightning/v2/plain_v2.proto`：`bytes texture_png = 2`（`MaterialEntry`）—— 既不是对象也不是 base64 串 |
 * | 文档契约 | `docs/contracts/format-multiblock-doc.md:108` 逐字 `"textureBlobs": [ … ]`（结构体 base64 PNG），无 `{id,mime,dataBase64}` 元素 schema |
 * | web 侧是否有解析器/类型接受它 | **无**：`web/src/**` 里没有读 `dataBase64` 的生产代码（grep 全仓，只剩 e2e 帮助函数与 perf 生成器） |
 * | 来源提交 | `web/e2e/fixtures/minimal-v2.json` 由 `2566f59f`（"Add embed mobile fit, touch gestures…"）引入 —— 该提交是 `git log -S"dataBase64"` 里**最老**的一条，且当时全仓只有这一个文件含该串；`parts-*.v2.json` 由 `b4be5627`（"P0.4 部件数据契约定稿…双 fixture（真实探针数据蓝本）"）引入，`id` 分别是 `e2e-parts`/`e2e-ae2`（**夹具自造 id**，非真实纹理定位符） |
 * | 结论 | 该元素形态是**手写 e2e 夹具的私有编码**（"真实探针数据蓝本"指的是几何/部件数据，不是 blob 元素），除 e2e 帮助函数 `web/e2e/helpers/parts/fixtures.ts:40-56` 的临时 `b.dataBase64 ?? ''` 外**无生产者无消费者** |
 *
 * ## 为什么"不得当字节"是必须的（下游后果已实测）
 *
 * 内核装配 `composition/kernelAssembly.ts#resourcesFromLegacy`（`:1407`
 * `const payload = typeof blob === 'string' ? blob : null`）**只接受裸串**：
 * 同一个夹具的 blob 元素是对象时 ⇒ `content.resources[0].payload === null` +
 * 诊断 `resourceWithoutPayloadOrLocator`；把元素换成裸 base64 串 ⇒ `payload` 是 string
 * （两条读数见 `render/data/__tests__/materialBlendHydrateFrozen.test.ts` 的登记判据）。
 * 归一化侧若把对象当成字节，产出的是 `data:image/png;base64,[object Object]`
 * —— 一个**语法合法、内容虚假**的 data URL，比"无字节"更难发现。
 */
describe('形态契约 ⑤：非契约元素形态 `{id,mime,dataBase64}` ⇒ 无字节（不得冒充 base64）', () => {
  const FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'parts-singlebox-mix.v2.json')

  /** 夹具里**真的**是这种元素形态 —— 由本判据从盘上读，而不是在注释里声称。 */
  function fixtureBlobs(): unknown[] {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')) as {
      textureBlobs?: unknown[]
    }
    return raw.textureBlobs ?? []
  }

  it('前提（从盘上读）：夹具的元素确实是 `{id,mime,dataBase64}` 对象，且没有裸串元素', () => {
    const blobs = fixtureBlobs()
    expect(blobs.length, '夹具确有 blob 元素').toBeGreaterThan(0)
    expect(blobs.every((b) => b !== null && typeof b === 'object' && !Array.isArray(b))).toBe(true)
    expect(
      blobs.every((b) => typeof (b as { dataBase64?: unknown }).dataBase64 === 'string'),
      '每个元素都靠 `dataBase64` 承载字节（这就是 e2e 帮助函数要归一化的原因）',
    ).toBe(true)
    expect(blobs.some((b) => typeof b === 'string'), '没有一个裸串元素').toBe(false)
  })

  it('正：归一化后该槽位是"无字节"（长度保持，不抛、不冒充）', () => {
    const out = normalizeTextureBlobPool(fixtureBlobs())
    expect(out.length, '长度 = 槽位数（位置保持）').toBe(fixtureBlobs().length)
    expect(hasTextureBlobAt(out, 0), '对象元素 ⇒ 槽位 0 无字节').toBe(false)
    expect(out[0]).toBe('')
    // 且形态判别如实说"这不是池"（摘要类消费者的依据）：
    expect(isTextureBlobPoolShaped(fixtureBlobs())).toBe(false)
  })

  it('负对照（能红）：把对象当字节的实现 ⇒ 产出 `base64,[object Object]` 的假 data URL', () => {
    /** "对象也当字节"的错误实现（`String(v)` 造一个语法合法的假串）。 */
    const naiveAsBytes = (blobs: unknown[]): string[] =>
      blobs.map((v) => (typeof v === 'string' ? v : String(v)))
    const fake = naiveAsBytes(fixtureBlobs())[0]!
    expect(fake, '错误实现的读数是可辨认的 `[object Object]`').toBe('[object Object]')
    expect(
      `data:image/png;base64,${fake}`.endsWith('base64,[object Object]'),
      '它会被拼成一个**语法合法、内容虚假**的 data URL（比"无字节"更难发现）',
    ).toBe(true)
    // 正确实现给出的是"无字节"，与上面必然不同 ⇒ 本判据有区分力：
    expect(hasTextureBlobAt(normalizeTextureBlobPool(fixtureBlobs()), 0)).toBe(false)
    expect(normalizeTextureBlobPool(fixtureBlobs())[0]).not.toBe(fake)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 6：资源摘要的**形态无关性**（缺陷登记 + 已验证的修复配方）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 登记的是什么
 *
 * `presentation/contentIdentity.ts#resourceDigestOf` 直接对入参 `stableStringify`
 * ⇒ **同一逻辑资源**的两种契约形态给出**不同**摘要 ⇒ 假身份。
 * 影响面与退出条件写在该函数的 docblock 里（同一批落盘）；本判据只负责把"当前读数"
 * 与"修复配方确实有效"两件事变成机械可红的读数。
 *
 * ## 为什么这条判据是"登记"而不是"期望"
 *
 * 缺陷未修（修复点在 `runtime/presentationAdapter.ts:150`，本批禁写）。若把它写成
 * "期望两形摘要相同"，判据当场判红而没有人该改的代码——那只会制造一条永久红的噪音。
 * 故：① 断言**当前**读数（分叉）；② 断言**修复配方**（先归一化再取摘要）给出相同摘要
 * ——修复一旦落地，① 那条断言就是唯一需要**反转**的地方（注释已写明）。
 */
describe('形态契约 ⑥：资源摘要必须与形态无关（缺陷登记：现状分叉，配方已验证）', () => {
  const asArray = ['AAAA', 'BBBB'] as const
  const asObject = { '0': 'AAAA', '1': 'BBBB' } as Readonly<Record<string, string>>

  it('登记（缺陷）：同一逻辑资源的两种形态 ⇒ 摘要**不同**（修复后本断言须反转）', () => {
    const arrayDigest = resourceDigestOf(asArray)
    const objectDigest = resourceDigestOf(asObject)
    expect(arrayDigest).toBe('c:7f364cd1')
    expect(objectDigest).toBe('c:ee985e1c')
    expect(
      arrayDigest,
      '缺陷：同一内容的两种合法写法被判成两个资源（退出条件 = runtime/presentationAdapter.ts:150 先归一化）',
    ).not.toBe(objectDigest)
  })

  it('正（配方已验证）：先经唯一归一化点再取摘要 ⇒ 两形摘要相同（修复即此一行）', () => {
    const a = resourceDigestOf(normalizeTextureBlobPool(asArray))
    const b = resourceDigestOf(normalizeTextureBlobPool(asObject))
    expect(b).toBe(a)
  })

  it('负对照（能红）：**盲**归一化会毁掉非池值 ⇒ 两个不同内容的非池对象摘要恒等', () => {
    const blind = (v: unknown): string => resourceDigestOf(normalizeTextureBlobPool(v))
    // 非池对象被压成 `[]` ⇒ 两个**不同内容**的输入给出同一摘要（这就是必须先判形态的原因）：
    expect(blind({ stone: 'AAAA' })).toBe(blind({ stone: 'BBBB' }))
    // 带形态判别的配方：两者必须继续可分辨（A28/A36「同键换内容」判据的依据）
    const guarded = (v: unknown): string =>
      resourceDigestOf(isTextureBlobPoolShaped(v) ? normalizeTextureBlobPool(v) : v)
    expect(guarded({ stone: 'AAAA' })).not.toBe(guarded({ stone: 'BBBB' }))
    expect(guarded({ stone: 'AAAA' })).toBe(resourceDigestOf({ stone: 'AAAA' }))
    // 且对**真池**仍与配方一致（不是靠"放过非池"蒙对）：
    expect(guarded(asObject)).toBe(guarded(asArray))
  })
})
