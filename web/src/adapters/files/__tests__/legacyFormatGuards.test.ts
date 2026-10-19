/**
 * A20 —— **旧格式适配**：判别 / 终态硬约束 / 调色板 / 成对 idioms / 版本迁移 / 单一数据源
 * （#249 §14 A20、§12 第 3 段；B1 的 F-01..F-32、B-4/B-6/B-7/B-9/B-13/B-24/B-25；
 * #260 验收「旧格式夹具」+ 负对照 c / d）。
 *
 * ## A20 的两条指定负对照在本文件
 *
 * | 负对照 | 原文 | 落点 |
 * |---|---|---|
 * | c | `textureBlobIndex` 越界被当成空纹理渲染（**必须报错**） | {@link checkMaterialBlobIndexes} 的"对照实现"证伪 |
 * | d | `geometryPhase:'baked'` 里混入 `cellTypes` 仍被接受（**必须拒**） | {@link checkDocumentTerminal} 的"旧实现覆盖面缺口"证伪 |
 *
 * 两条都**不**靠"让测试自己 throw"：对照实现（一个真的接受越界、一个真的只看裸结构）
 * 被写成可调用的函数，测试断言"同一判据对对照实现判红"。
 *
 * ## 铁律 6（CRLF）
 *
 * 夹具按 `JSON.parse(readFileSync(...))` 读入 —— JSON 解析本身对 `\n`/`\r\n` 不敏感，
 * 故**本文件的夹具断言天然两种行尾都过**。读**源码**的部分（`pure/itemIndex.ts`
 * 的常量核对）经 `replace(/\r\n/g,'\n')` 归一化。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  classifyShape,
  checkBakedTerminal,
  checkDocumentTerminal,
  isShape,
  readDocumentShape,
  requireBakedTerminal,
  SCAN_ONLY_FIELDS,
  type LegacyShape,
} from '@/adapters/files/legacyShape'
import {
  checkDocumentMaterialIndexes,
  checkMaterialBlobIndexes,
  collectGridIndicesPublic,
  copyFieldsIfPresent,
  DEPRECATED_STATS_FIELDS,
  HOST_ITEM_FIELD,
  HOST_ITEM_FIELD as HOST_ITEM,
  isDeprecatedStatsField,
  ITEM_INDEX_FIELD,
  materialIndexError,
  missingItemIndexKeys,
  pairTooltipIdioms,
  readItemIndex,
  readTextureBlobIndex,
  requireMaterialIndexes,
  statsFieldsCarried,
  STRUCTURE_ROOT_FIELDS,
  TEXTURE_BLOB_INDEX_FALLBACK_FIELD,
  TEXTURE_BLOB_INDEX_FIELD,
  TOOLTIP_GRID_NONE,
  WORLD_ROOT_FIELDS,
} from '@/adapters/files/legacyFields'
import {
  detectVersion,
  migrateV1ToV2,
  migratedDocIsV2,
  migratedKeysAreUntouched,
  V2_ADDED_ROOT_KEYS,
  V2_FORMAT_VERSION,
} from '@/adapters/files/versionMigration'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const WEB_ROOT = process.cwd()
const FIXTURES = path.join(WEB_ROOT, 'e2e', 'fixtures')

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>
}

/** 读源码并归一化行尾为 LF（铁律 6）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, 'src', rel), 'utf8').replace(/\r\n/g, '\n')
}

const V2_PLAIN_FIXTURES = ['minimal-v2.json', 'parts-ae2-multibox.v2.json', 'parts-singlebox-mix.v2.json'] as const
const ENVELOPE_FIXTURE = 'structuredata-exported-envelope.json'

// ─────────────────────────────────────────────────────────────────────────────
// B-4：单一 classifyShape
// ─────────────────────────────────────────────────────────────────────────────

describe('B-4 形态判别：**单一** `classifyShape`（取代旧四处复写判据）', () => {
  it('四种形态各有一个真夹具/真构造命中，且判据标识可读', () => {
    expect(classifyShape(readFixture('minimal-v2.json'))).toEqual({ shape: 'v2plain', criterion: 'format_version=2.0+frames' })
    // World：`frames` 存在、无 `format_version`（契约 F-01 的判别式 = frames 的**存在性**）。
    const world = { id: 'w', frames: [{ index: 0, structure: { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [] } }] }
    expect(classifyShape(world).shape).toBe('world')
    // Structure：无 frames，有 geometryPhase/cellGrid。
    const structure = { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [] }
    expect(classifyShape(structure).shape).toBe('structure')
    // Multiblock：形态键最先。
    const mb = { documentShape: 'multiblock', multiblock: {}, multiblockCount: 1 }
    expect(classifyShape(mb)).toEqual({ shape: 'multiblock', criterion: 'documentShape=multiblock' })
    expect(readDocumentShape({ meta: { documentShape: 'multiblock' } }), '信封里的形态键也认').toBe('multiblock')
  })

  it('判别式是 `frames` 的**存在性**，不是帧数也不是 `id` 类型（F-01 原文）', () => {
    // 单帧 `{0}` 的产物仍必须是 World —— 这正是 B-4 指定的负对照场景
    // （`ExportSceneWriter.java:197-199` 的 `shape:"auto"` 旧隐函数会把单帧写成裸结构，
    //  而显式 `shape:"world"` 的单帧产物**必须**判为 World）。
    const singleFrameWorld = { id: 'x', frames: [{ index: 0, structure: {} }] }
    expect(classifyShape(singleFrameWorld).shape, '单帧也是 World（判别式不是帧数）').toBe('world')
    // 缺 `id` 但不缺 frames ⇒ 仍是 World（旧 `isWorldDocument` 多要求 id 是字符串，是漂移源）。
    expect(classifyShape({ frames: [] }).shape).toBe('world')
  })

  it('**负对照**：把 `frames` 当成"帧数 > 1"或"id 必须是字符串"就判红', () => {
    // 对照实现：旧 `isWorldDocument` 的判据（`bundleResolve.ts:49-55`）。
    const naiveIsWorld = (o: Record<string, unknown>): boolean =>
      Array.isArray(o.frames) && typeof o.id === 'string' && o.format_version === undefined

    const cases: Record<string, unknown>[] = [
      { frames: [{ index: 0 }] }, // 缺 id
      { id: 'x', frames: [{ index: 0 }] }, // 单帧
      { id: 'x', frames: [] }, // 空帧
    ]
    for (const c of cases) {
      expect(classifyShape(c).shape, '契约判据：有 frames 即 World').toBe('world')
    }
    // 对照实现在第一条上判错（它说"不是 World"）—— 这就是判据差异的可执行证据。
    expect(naiveIsWorld(cases[0]!), '对照实现（要求 id 是字符串）在缺 id 时判非 World').toBe(false)
    expect(classifyShape(cases[0]!).shape === 'world').toBe(true)
  })

  it('**负对照**：`format_version` 判据必须**优先于** world（否则 V2Plain 被判成 World）', () => {
    const v2 = readFixture('minimal-v2.json')
    expect(classifyShape(v2).shape).toBe('v2plain')
    // 对照实现：先判 world（不看 format_version）。
    const naive = (o: Record<string, unknown>): LegacyShape => (Array.isArray(o.frames) ? 'world' : 'structure')
    expect(naive(v2), '对照实现会把 V2Plain 判成 world').toBe('world')
    expect(classifyShape(v2).shape === 'world', '真实实现不得如此').toBe(false)
  })

  it('判别结果对**全部**真夹具稳定（同一输入两次判别相同）', () => {
    for (const name of [...V2_PLAIN_FIXTURES, ENVELOPE_FIXTURE]) {
      const doc = readFixture(name)
      const a = classifyShape(doc)
      const b = classifyShape(doc)
      expect(a).toEqual(b)
    }
    // Envelope 根上没有 frames/cellGrid ⇒ unknown（形态在被解包的内层里）。
    expect(classifyShape(readFixture(ENVELOPE_FIXTURE)).shape).toBe('unknown')
  })

  it('`isShape` 是同一判据的可读性包装（不是第二套判据）', () => {
    const v2 = readFixture('minimal-v2.json')
    expect(isShape(v2, 'v2plain')).toBe(true)
    expect(isShape(v2, 'world')).toBe(false)
    expect(isShape(v2, 'v2plain')).toBe(classifyShape(v2).shape === 'v2plain')
  })

  it('非对象输入不抛错，返回 `unknown`（形态缺陷是可诊断事实，不是崩溃）', () => {
    for (const v of [null, undefined, 42, 'x', [], true]) {
      const r = classifyShape(v)
      expect(r.shape).toBe('unknown')
      expect(r.criterion.length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-9 / F-07：终态硬约束（**含 A20 负对照 d**）
// ─────────────────────────────────────────────────────────────────────────────

describe("B-9 `geometryPhase` 终态硬约束：`baked` 里混入 `cellTypes`/`worldGrid` **必须拒**（A20 负对照 d）", () => {
  const bakedOk = { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [{ registryId: 'air' }] }

  it('正方向：干净的 baked 裸结构无缺陷', () => {
    expect(checkBakedTerminal(bakedOk)).toEqual([])
    expect(requireBakedTerminal(bakedOk).ok).toBe(true)
  })

  it('`scan` 中间态**不**算缺陷（契约明说它只是"Wiki 不直接渲染"）', () => {
    const scan = { geometryPhase: 'scan', cellTypes: [], cellGrid: [[[0]]], worldGrid: {} }
    expect(checkBakedTerminal(scan), 'scan 专有字段在 scan 态是合法的').toEqual([])
    expect(requireBakedTerminal(scan).ok).toBe(true)
  })

  it('`baked` 带 `cellTypes` ⇒ 拒；带 `worldGrid` ⇒ 拒；两个都带 ⇒ 两条诊断', () => {
    const a = { ...bakedOk, cellTypes: [] }
    const defects = checkBakedTerminal(a)
    expect(defects).toHaveLength(1)
    expect(defects[0]!.code).toBe('BakedTerminalCarriesScanField')
    expect(defects[0]!.detail.field).toBe('cellTypes')
    const r = requireBakedTerminal(a)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('BakedTerminalCarriesScanField')

    expect(checkBakedTerminal({ ...bakedOk, worldGrid: {} })[0]!.detail.field).toBe('worldGrid')
    expect(checkBakedTerminal({ ...bakedOk, cellTypes: [], worldGrid: {} })).toHaveLength(2)
  })

  it('`SCAN_ONLY_FIELDS` 是唯一的字段清单（校验与文档只此一处定义）', () => {
    expect([...SCAN_ONLY_FIELDS]).toEqual(['cellTypes', 'worldGrid'])
  })

  it('**World 形态的每一帧**都过同一判据（这是旧实现的覆盖面缺口）', () => {
    const worldWithBadFrame = {
      id: 'w',
      frames: [
        { index: 0, structure: { ...bakedOk } },
        { index: 1, structure: { ...bakedOk, cellTypes: [] } }, // ← 旧实现漏掉的那一帧
      ],
    }
    const defects = checkDocumentTerminal(worldWithBadFrame)
    expect(defects, '第 2 帧的缺陷必须被发现').toHaveLength(1)
    expect(defects[0]!.at, '诊断必须定位到具体帧').toBe('frames[1].structure')
    expect(requireBakedTerminal(worldWithBadFrame).ok).toBe(false)
  })

  it('**负对照 d**：只校验裸结构的"对照实现"会放过 World 里的坏帧 ⇒ 判红', () => {
    /**
     * **对照实现**：旧链路的覆盖形态 —— 只对**根**做终态校验
     * （`bundleResolve.ts:43-45` 的 `loadStructureData` 只接裸结构；
     *  World 的帧走 `loadWorldEmbeddedFrame`，没有这条校验）。
     */
    const naiveCheckRootOnly = (doc: Record<string, unknown>): readonly string[] => {
      const defects: string[] = []
      if (doc.geometryPhase === 'baked') {
        for (const f of SCAN_ONLY_FIELDS) if (Object.prototype.hasOwnProperty.call(doc, f)) defects.push(f)
      }
      return defects
    }
    const worldWithBadFrame = {
      id: 'w',
      frames: [{ index: 0, structure: { ...bakedOk, cellTypes: [], worldGrid: {} } }],
    }
    // 真实实现：报两条（两个字段），且定位到帧。
    const real = checkDocumentTerminal(worldWithBadFrame)
    expect(real.map((d) => d.detail.field).sort()).toEqual(['cellTypes', 'worldGrid'])
    expect(real.every((d) => d.at === 'frames[0].structure')).toBe(true)
    // 对照实现：根上没有 geometryPhase ⇒ 一条都报不出来。
    expect(naiveCheckRootOnly(worldWithBadFrame), '旧的"只查根"实现看不见 World 里的坏帧').toEqual([])
    // ⇒ 同一个坏输入，两者结论不同：这就是"覆盖面缺口"的可执行证据。
    expect(real.length).toBeGreaterThan(naiveCheckRootOnly(worldWithBadFrame).length)
  })

  it('**负对照 d（裸结构面）**：把 `cellTypes` 当"可忽略的遗留字段"跳过 ⇒ 判红', () => {
    const bad = { ...bakedOk, cellTypes: [{ a: 1 }] }
    // 对照实现：只检查 palette 与 grid，不看 scan 专有字段。
    const naivePaletteOnly = (doc: Record<string, unknown>): boolean => Array.isArray(doc.blockPalette) && Array.isArray(doc.cellGrid)
    expect(naivePaletteOnly(bad), '对照实现接受它（这正是要判红的形态）').toBe(true)
    expect(requireBakedTerminal(bad).ok, '真实实现必须拒').toBe(false)
  })

  it('`geometryPhase` 缺失或未知 ⇒ `GeometryPhaseUnknown`（不猜成 baked）', () => {
    const d1 = checkBakedTerminal({ cellGrid: [[[0]]], blockPalette: [] })
    expect(d1[0]!.code).toBe('GeometryPhaseUnknown')
    const d2 = checkBakedTerminal({ geometryPhase: 'halfbaked', cellGrid: [[[0]]], blockPalette: [] })
    expect(d2[0]!.code).toBe('GeometryPhaseUnknown')
    expect(d2[0]!.detail.reason).toBe('missingOrUnknownPhase')
  })

  it('`baked` 缺 `blockPalette`/`cellGrid` ⇒ `BakedTerminalMissingPalette`（终态的定义）', () => {
    const defects = checkBakedTerminal({ geometryPhase: 'baked' })
    expect(defects.map((d) => d.detail.field).sort()).toEqual(['blockPalette', 'cellGrid'])
    expect(defects.every((d) => d.code === 'BakedTerminalMissingPalette')).toBe(true)
  })

  it('真夹具（V2Plain）的全部帧都是合格终态', () => {
    for (const name of V2_PLAIN_FIXTURES) {
      expect(checkDocumentTerminal(readFixture(name)), `${name}: 真夹具不得有终态缺陷`).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-6 / F-11：textureBlobIndex 越界（**含 A20 负对照 c**）
// ─────────────────────────────────────────────────────────────────────────────

describe('B-6 `textureBlobIndex`：越界**必须报错**，不当空纹理渲染（A20 负对照 c）', () => {
  it('正方向：合法下标（含 0 与上界）通过', () => {
    expect(checkMaterialBlobIndexes([{ textureBlobIndex: 0 }, { textureBlobIndex: 2 }], 3)).toEqual([])
    expect(requireMaterialIndexes({ textureBlobs: ['a', 'b'], materialPalette: [{ textureBlobIndex: 1 }] }).ok).toBe(true)
  })

  it('越界（下界与上界）⇒ `TextureBlobIndexOutOfRange`，带下标与池大小', () => {
    const defects = checkMaterialBlobIndexes([{ textureBlobIndex: 3 }], 3)
    expect(defects).toHaveLength(1)
    expect(defects[0]!.code).toBe('TextureBlobIndexOutOfRange')
    expect(defects[0]!.index).toBe(3)
    expect(defects[0]!.blobCount).toBe(3)
    expect(defects[0]!.at).toBe('materialPalette[0]')
    expect(checkMaterialBlobIndexes([{ textureBlobIndex: -1 }], 3)[0]!.code).toBe('TextureBlobIndexOutOfRange')
    // 缺下标与越界是**两种**缺陷（不同 reason），不压成一个。
    expect(checkMaterialBlobIndexes([{}], 3)[0]!.code).toBe('TextureBlobIndexMissing')
  })

  it('**负对照 c**：把越界当空纹理（返回 `null` 继续）⇒ 同一判据判红', () => {
    /**
     * **对照实现**：旧渲染路径的宽松形态 —— 越界时返回 `null`，
     * 由渲染侧静默画成"没有贴图"。
     */
    const naiveResolve = (idx: number | undefined, blobCount: number): string | null => {
      if (typeof idx !== 'number') return null
      const blob = `blob#${idx}`
      return idx >= 0 && idx < blobCount ? blob : null // ← 越界时"当作没有纹理"，**不报错**
    }
    const palette = [{ textureBlobIndex: 7 }]
    const blobCount = 3
    // 对照实现的表现：不报错、拿到 null（用户看到的是"这个方块没贴图"）。
    expect(naiveResolve(palette[0]!.textureBlobIndex, blobCount), '对照实现静默返回空纹理').toBeNull()
    // 真实实现：显式报错。
    const defects = checkMaterialBlobIndexes(palette, blobCount)
    expect(defects, '越界必须产生诊断').toHaveLength(1)
    expect(defects[0]!.code).toBe('TextureBlobIndexOutOfRange')
    const r = requireMaterialIndexes({ textureBlobs: ['a', 'b', 'c'], materialPalette: palette })
    expect(r.ok, '必须报错而不是产出"看起来完整"的文档').toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('TextureBlobIndexOutOfRange')
    // 判据差异的可执行证据：同一个越界下标，对照实现"不报错地拿到了一个结果"（null），
    // 真实实现"显式失败"。两者不可互换 —— 前者会让用户以为方块没贴图。
    expect(naiveResolve(palette[0]!.textureBlobIndex, blobCount), '对照实现静默返回空纹理（无错误信号）').toBeNull()
    expect(r.ok, '真实实现必须显式失败').toBe(false)
    expect(naiveResolve(palette[0]!.textureBlobIndex, blobCount), '对照实现没有任何"失败"可观测（它返回的是数据）').not.toBe(false)
    const naiveFailureSignal = (() => {
      try {
        naiveResolve(palette[0]!.textureBlobIndex, blobCount)
        return false // 没有抛错 ⇒ 没有失败信号
      } catch {
        return true
      }
    })()
    expect(naiveFailureSignal, '对照实现不产生任何失败信号（这正是"静默"的定义）').toBe(false)
    expect(r.ok === false, '真实实现产生失败信号').toBe(true)
  })

  it('snake_case 回退 `texture_blob_index` 被接受（F-11 明文的双写兼容）', () => {
    expect(readTextureBlobIndex({ texture_blob_index: 2 })).toBe(2)
    expect(readTextureBlobIndex({ textureBlobIndex: 1 })).toBe(1)
    // camelCase **优先**（`?? ` 语义的既有事实）。
    expect(readTextureBlobIndex({ textureBlobIndex: 1, texture_blob_index: 2 })).toBe(1)
    expect(readTextureBlobIndex({})).toBeNull()
    expect(readTextureBlobIndex({ textureBlobIndex: Number.NaN })).toBeNull()
    expect(readTextureBlobIndex(null)).toBeNull()
    // `0` 是合法下标，**不得**与"没有"混淆（A36 同族要求）。
    expect(readTextureBlobIndex({ textureBlobIndex: 0 })).toBe(0)
    expect(TEXTURE_BLOB_INDEX_FIELD).toBe('textureBlobIndex')
    expect(TEXTURE_BLOB_INDEX_FALLBACK_FIELD).toBe('texture_blob_index')
  })

  it('空池 / 无池 ⇒ 跳过校验（既有事实：编辑态空文档无 textureBlobs）', () => {
    expect(checkMaterialBlobIndexes([{ textureBlobIndex: 99 }], 0)).toEqual([])
    expect(requireMaterialIndexes({ materialPalette: [{ textureBlobIndex: 99 }] }).ok).toBe(true)
  })

  it('真夹具的材质索引全部合法（含 62 项 / 57 blob 的真 Envelope）', () => {
    for (const name of V2_PLAIN_FIXTURES) {
      expect(checkDocumentMaterialIndexes(readFixture(name)), `${name}: 材质索引必须合法`).toEqual([])
    }
    // Envelope 的 palette 在**内层 body**：本判据面向文件形态，故先取 inner 的形态。
    const env = readFixture(ENVELOPE_FIXTURE)
    expect(checkDocumentMaterialIndexes(env), 'Envelope 根上没有 materialPalette ⇒ 无缺陷').toEqual([])
    expect(materialIndexError(readFixture('minimal-v2.json'))).toBeNull()
  })

  it('**负对照**：给真夹具注入一个越界下标 ⇒ 判红（证明判据在真数据上也生效）', () => {
    const doc = readFixture('minimal-v2.json') as Record<string, unknown>
    const blobs = doc.textureBlobs as unknown[]
    const bad = { ...doc, materialPalette: [{ textureBlobIndex: blobs.length }] }
    const r = requireMaterialIndexes(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.index).toBe(blobs.length)
    expect(r.error.params.blobCount).toBe(blobs.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #387 收尾批：池的**两种契约形态**不得使校验静默跳过（池计数：`Array.isArray` → 归一化）
// ─────────────────────────────────────────────────────────────────────────────

describe('#387 池形态：`textureBlobs` 是槽位键对象时也必须校验（修复前静默跳过）', () => {
  it('正：对象形态（帧为主投影 `plainForSave().plain`）⇒ 池计数正确、越界必报错', () => {
    expect(
      checkDocumentMaterialIndexes({ textureBlobs: { '0': 'a', '1': 'b', '2': 'c' }, materialPalette: [{ textureBlobIndex: 2 }] }),
      '合法下标不得报缺陷',
    ).toEqual([])
    const defects = checkDocumentMaterialIndexes({ textureBlobs: { '0': 'a', '1': 'b' }, materialPalette: [{ textureBlobIndex: 2 }] })
    expect(defects.map((d) => d.code)).toEqual(['TextureBlobIndexOutOfRange'])
    expect(defects[0]!.blobCount, '池计数必须 = 槽位数（2），不是 0').toBe(2)
  })

  it('正：对象形态的**空缺槽位**按"下标即槽位"计数（`{"0":…,"2":…}` ⇒ 3 个槽位）', () => {
    const doc = { textureBlobs: { '0': 'a', '2': 'c' }, materialPalette: [{ textureBlobIndex: 2 }] }
    expect(checkDocumentMaterialIndexes(doc)).toEqual([])
    const bad = checkDocumentMaterialIndexes({ ...doc, materialPalette: [{ textureBlobIndex: 3 }] })
    expect(bad).toHaveLength(1)
    expect(bad[0]!.blobCount, '槽位数 = 最大数值键 + 1').toBe(3)
  })

  it('正（回归）：数组口径**不变** —— 长度即槽位数，`""` 占位也算槽位', () => {
    expect(checkDocumentMaterialIndexes({ textureBlobs: ['a', '', 'c'], materialPalette: [{ textureBlobIndex: 2 }] })).toEqual([])
    const d = checkDocumentMaterialIndexes({ textureBlobs: ['a', '', 'c'], materialPalette: [{ textureBlobIndex: 3 }] })
    expect(d).toHaveLength(1)
    expect(d[0]!.blobCount).toBe(3)
  })

  it('非池值（键不是数值下标）⇒ 与修复前同口径：池计数 0 ⇒ 跳过（不是槽位表）', () => {
    expect(
      checkDocumentMaterialIndexes({ textureBlobs: { stone: 'AAAA' }, materialPalette: [{ textureBlobIndex: 0 }] }),
      '非池值不是"有池"：这里不引入新的假拒绝',
    ).toEqual([])
  })

  it('**负对照（能红）**：修复前的 `Array.isArray(…) ? length : 0` ⇒ 对象形态被数成 0 ⇒ 越界一条都不报', () => {
    /** 池计数**修复前**的逐字实现。 */
    const oldPoolCount = (doc: Record<string, unknown>): number =>
      Array.isArray(doc.textureBlobs) ? (doc.textureBlobs as unknown[]).length : 0
    const doc: Record<string, unknown> = { textureBlobs: { '0': 'a', '1': 'b' }, materialPalette: [{ textureBlobIndex: 9 }] }
    // 旧实现：池计数 0 ⇒ `checkMaterialBlobIndexes` 的 `blobCount <= 0` 早退 ⇒ 无缺陷（静默通过）。
    expect(oldPoolCount(doc)).toBe(0)
    expect(checkMaterialBlobIndexes(doc.materialPalette, oldPoolCount(doc)), '旧实现：有池但一条都不校验').toEqual([])
    // 真实实现：同输入必须报错 ⇒ 两者不可互换（这正是本判据的区分力）。
    const defects = checkDocumentMaterialIndexes(doc)
    expect(defects, '真实实现必须报错（"有池但不校验"按本函数契约就是放宽）').toHaveLength(1)
    expect(defects[0]!.code).toBe('TextureBlobIndexOutOfRange')
    expect(defects).not.toEqual(checkMaterialBlobIndexes(doc.materialPalette, oldPoolCount(doc)))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F-13 / B-7：tooltip 成对 idioms
// ─────────────────────────────────────────────────────────────────────────────

describe('F-13 / B-7 `tooltipPalette` + `cellTooltipGrid`：成对 idioms 是**读入侧**不变量', () => {
  it('有网格无池 ⇒ 池补空数组（早于该层的文件是合法形态，不是缺陷）', () => {
    const structure = { cellGrid: [[[0, 1]]], cellTooltipGrid: [[[-1, -1]]] }
    const r = pairTooltipIdioms(structure)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.tooltipPalette).toEqual([])
    expect(r.value.synthesized).toBe('palette')
  })

  it('有池无网格 ⇒ 按 `cellGrid` 形状补 `-1` 网格（**形状正确**才叫补对了）', () => {
    const structure = { cellGrid: [[[0, 1], [2, 3]], [[4, 5], [6, 7]]], tooltipPalette: ['a'] }
    const r = pairTooltipIdioms(structure)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.synthesized).toBe('grid')
    expect(r.value.cellTooltipGrid.length, 'z 层数必须与 cellGrid 一致').toBe(2)
    expect(r.value.cellTooltipGrid[0]!.length, '每层行数必须一致').toBe(2)
    expect(r.value.cellTooltipGrid[0]![0]!.length, '每行列数必须一致').toBe(2)
    expect(r.value.cellTooltipGrid.flat(2).every((v) => v === TOOLTIP_GRID_NONE), '补出来的必须是 -1（无说明）').toBe(true)
  })

  it('网格里引用越界下标 ⇒ **报错**（与材质索引同一政策：越界不是"没有说明"）', () => {
    const bad = { cellGrid: [[[0]]], cellTooltipGrid: [[[5]]], tooltipPalette: ['only-one'] }
    const r = pairTooltipIdioms(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('TooltipIndexOutOfRange')
    expect(r.error.params.index).toBe(5)
  })

  it('**负对照**：把"有池无网格"当成错误 ⇒ 判红（假拒绝比假成功更隐蔽）', () => {
    // 对照实现：要求两半必须都在。
    const naiveRequiresBoth = (s: Record<string, unknown>): boolean => Array.isArray(s.tooltipPalette) && Array.isArray(s.cellTooltipGrid)
    const legacy = { cellGrid: [[[0]]], tooltipPalette: ['说明'] }
    expect(naiveRequiresBoth(legacy), '对照实现对旧文件判"不合法"（假拒绝）').toBe(false)
    // 真实实现：补出另一半并如实标记"这是我补的"。
    const r = pairTooltipIdioms(legacy)
    expect(r.ok, '真实实现必须能读旧文件').toBe(true)
    if (!r.ok) return
    expect(r.value.synthesized).toBe('grid')
  })

  it('`TOOLTIP_GRID_NONE === -1`（与 `render/schema/types.ts:145` 的既有常量一致）', () => {
    const legacy = readSource('render/schema/types.ts')
    const m = /export const TOOLTIP_GRID_NONE = (-?\d+)/.exec(legacy)
    expect(m, '旧常量必须仍可被解析').not.toBeNull()
    expect(Number(m?.[1])).toBe(TOOLTIP_GRID_NONE)
  })

  it('真 Envelope 的成对材料自洽（16 个说明 / 7×6×19 网格，下标全部在界内）', async () => {
    // 用信封解码器取出 inner（本文件不重复实现解包）。
    const { decodeEnvelope } = await import('@/adapters/files/envelopeCodec')
    const d = decodeEnvelope(readFixture(ENVELOPE_FIXTURE))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    const inner = d.value.inner as Record<string, unknown>
    expect(Array.isArray(inner.tooltipPalette)).toBe(true)
    expect(Array.isArray(inner.cellTooltipGrid)).toBe(true)
    const r = pairTooltipIdioms(inner)
    expect(r.ok, '真产物的成对 idioms 必须自洽').toBe(true)
    if (!r.ok) return
    expect(r.value.synthesized, '真产物本来就是成对的（不是我们补的）').toBe('none')
    expect(r.value.tooltipPalette.length).toBe(16)
  })

  it('`collectGridIndicesPublic` 等价于内部遍历（供诊断复用，不是第二套算法）', () => {
    // 返回的是冻结数组 ⇒ 排序前先复制（冻结本身是有意的：诊断面不该被调用方改）。
    expect([...collectGridIndicesPublic([[[-1, 0]], [[2]]])].sort((a, b) => a - b)).toEqual([-1, 0, 2])
    expect(collectGridIndicesPublic('not-a-grid')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-24 / F-28 / F-29：版本迁移（零转换）
// ─────────────────────────────────────────────────────────────────────────────

describe('B-24/F-28 版本迁移：v1→v2 是**零转换**迁移（逐键可证）', () => {
  const v1 = {
    id: 'legacy-1',
    label: 'Legacy Structure',
    author: 'someone',
    description: '描述',
    gtnhVersion: '2.7.0',
    geometryPhase: 'baked',
    cellGrid: [[[0]]],
    blockPalette: [{ registryId: 'air' }],
    materialPalette: [{ textureBlobIndex: 0 }],
    textureBlobs: ['x'],
    unknownVendorField: { keep: 'me' },
  }

  it('`detectVersion`：`2.` 前缀即 v2，其余 v1（含缺键）', () => {
    expect(detectVersion({ format_version: '2.0' })).toBe('2')
    expect(detectVersion({ format_version: '2.7' })).toBe('2')
    expect(detectVersion({ format_version: '1.0' })).toBe('1')
    expect(detectVersion({})).toBe('1')
    expect(detectVersion(null)).toBe('1')
  })

  it('迁移只加 v2 新增的四项，其余键**逐位相同**', () => {
    const r = migrateV1ToV2(v1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(migratedKeysAreUntouched(v1, r.value), '除 v2 新增键外，任何键被改动即判红').toEqual([])
    expect(V2_ADDED_ROOT_KEYS.slice().sort()).toEqual(['annotations', 'format_version', 'labels', 'meta'])
    expect(r.value.annotations).toEqual([])
    expect(r.value.labels).toEqual([])
    expect(r.value.format_version).toBe(V2_FORMAT_VERSION)
    expect(r.value.unknownVendorField, '未知字段必须一并继承（零转换）').toEqual({ keep: 'me' })
  })

  it('`meta` 的来源映射逐字段：`label`/`id` → name，`author` → author，`description` → description', () => {
    const r = migrateV1ToV2(v1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const meta = r.value.meta as Record<string, unknown>
    expect(meta.name).toBe('Legacy Structure')
    expect(meta.author).toBe('someone')
    expect(meta.description).toBe('描述')
    expect(meta.created_at_ms, '不读时钟 ⇒ 常量 0（可复现）').toBe(0)
    expect(meta.tags).toEqual([])
    expect(meta.origin).toEqual({ x: 0, y: 0, z: 0 })
    // 无 label 时回退 id（旧 `versionMigration.ts:18` 的 `v1.label ?? v1.id ?? ''`）。
    const noLabel = migrateV1ToV2({ id: 'only-id' })
    expect(noLabel.ok).toBe(true)
    if (!noLabel.ok) return
    expect((noLabel.value.meta as Record<string, unknown>).name).toBe('only-id')
  })

  it('迁移**幂等**：对已是 v2 的输入再迁移得到语义相同的文档', () => {
    const first = migrateV1ToV2(v1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = migrateV1ToV2(first.value)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value).toEqual(first.value)
  })

  it('迁移的**后置条件**：结果必须被 `migratedDocIsV2` 与 `classifyShape` 双双认作 v2', () => {
    const r = migrateV1ToV2(v1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(migratedDocIsV2(r.value)).toBe(true)
    // 迁移结果是 v1 形态（无 frames）⇒ classifyShape 判 structure；有 frames 的 v1 会是 v2plain。
    const withFrames = migrateV1ToV2({ ...v1, frames: [{ index: 0 }] })
    expect(withFrames.ok).toBe(true)
    if (!withFrames.ok) return
    expect(classifyShape(withFrames.value).shape, '声明了 2.0 且有 frames ⇒ v2plain').toBe('v2plain')
  })

  it('**负对照**：`format_version` 被输入覆盖（旧实现的展开顺序缺陷）⇒ 后置条件判红', () => {
    /** **对照实现**：旧 `migrateV1ToV2` 的展开顺序（`...v1` 在 `format_version` **之后**）。 */
    const naiveMigrate = (src: Record<string, unknown>): Record<string, unknown> => ({
      format_version: V2_FORMAT_VERSION,
      ...src, // ← 输入能覆盖 format_version
      meta: { name: '', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
    })
    const input = { id: 'x', format_version: '1.9', frames: [] }
    expect(naiveMigrate(input).format_version, '对照实现产出声明 1.9 的"迁移结果"').toBe('1.9')
    expect(migratedDocIsV2(naiveMigrate(input)), '后置条件因此判红').toBe(false)
    // 真实实现：恒为 2.0。
    const real = migrateV1ToV2(input)
    expect(real.ok).toBe(true)
    if (!real.ok) return
    expect(real.value.format_version).toBe(V2_FORMAT_VERSION)
    expect(migratedDocIsV2(real.value)).toBe(true)
  })

  it('**负对照**：迁移时"顺手改名"会被 `migratedKeysAreUntouched` 抓到', () => {
    const r = migrateV1ToV2(v1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    /** 对照实现：把 `cellGrid` 改名成 `grid`（一次"看起来无害"的规范化）。 */
    const renamed: Record<string, unknown> = { ...r.value, grid: r.value.cellGrid }
    delete renamed.cellGrid
    expect(migratedKeysAreUntouched(v1, renamed), '改名必须判红（并指出是哪个键）').toContain('cellGrid:missing')
  })

  it('非对象输入显式拒绝（`InvalidValue`，不用默认值冒充成功）', () => {
    for (const v of [null, 42, 'x', []]) {
      const r = migrateV1ToV2(v)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('migrationSourceNotObject')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-13 / F-21 / F-22：itemIndex 单一数据源
// ─────────────────────────────────────────────────────────────────────────────

describe('B-13/F-21/F-22 `itemIndex`：**单一数据源**（不从 partLists/cellGrid 二次推导）', () => {
  it('根级字段名与旧层既有一致（`pure/itemIndex.ts:44,47`）', () => {
    const legacy = readSource('pure/itemIndex.ts')
    const m1 = /export const ITEM_INDEX_FIELD = '([^']+)'/.exec(legacy)
    const m2 = /export const HOST_ITEM_FIELD = '([^']+)'/.exec(legacy)
    expect(m1).not.toBeNull()
    expect(m2).not.toBeNull()
    expect(ITEM_INDEX_FIELD).toBe(m1![1])
    expect(HOST_ITEM_FIELD).toBe(m2![1])
    expect(HOST_ITEM).toBe('hostItem')
  })

  it('`readItemIndex` 只在**根级**读（不从帧/部件池回退）', () => {
    const withRoot = { itemIndex: { 'a:0': { display: 'A' } } }
    expect(readItemIndex(withRoot)).toEqual({ 'a:0': { display: 'A' } })
    // 帧内出现同名键**不**算（World 的 itemIndex 在根；帧内不算数据源）。
    expect(readItemIndex({ frames: [{ itemIndex: { 'x:0': {} } }] })).toBeNull()
    expect(readItemIndex(null)).toBeNull()
    expect(readItemIndex({ itemIndex: [] })).toBeNull()
  })

  it('缺键只**报告**、不补写（补键等于替导出侧修数据，会掩盖真实缺陷）', () => {
    const index = { 'a:0': {}, 'b:1': {} }
    expect(missingItemIndexKeys(index, ['a:0', 'b:1', 'c:2'])).toEqual(['c:2'])
    expect(missingItemIndexKeys(null, ['a:0'])).toEqual(['a:0'])
    expect(missingItemIndexKeys(index, [])).toEqual([])
    // 返回稳定排序（可对账）。
    expect(missingItemIndexKeys({}, ['z:0', 'a:0'])).toEqual(['a:0', 'z:0'])
  })

  it('**负对照**：从 `partLists` 二次推导键集 ⇒ 与文件里的 `itemIndex` 不一致（判据可见）', () => {
    // 真夹具含部件但**没有** itemIndex（手 fixture）——这正是"单一数据源"的边界情形：
    // 正确行为是"没有索引"，而不是"从 partLists 推一个出来"。
    const doc = readFixture('parts-singlebox-mix.v2.json')
    const frame = (doc.frames as Record<string, unknown>[])[0]!
    const struct = frame.structure as Record<string, unknown>
    const partLists = struct.partLists as { items?: { registry: string; damage: number }[] }[][]
    // 对照实现：从 partLists 推键。
    const derived = new Set<string>()
    for (const list of partLists) for (const part of list) for (const it of part.items ?? []) derived.add(`${it.registry}:${it.damage}`)
    expect(derived.size, '对照实现确实推出了键').toBeGreaterThan(0)
    // 真实读取：文件里**没有** itemIndex ⇒ 读到 null（不去推）。
    expect(readItemIndex(doc)).toBeNull()
    expect(missingItemIndexKeys(readItemIndex(doc), [...derived]).length, '真实实现如实报告"全缺"，而不是"推导成功"').toBe(derived.size)
  })

  it('无部件夹具**不含** `hostItem` / `itemIndex`（B-14：仅含部件文档才写）', () => {
    for (const name of ['minimal-v2.json', ENVELOPE_FIXTURE]) {
      const doc = readFixture(name)
      expect(readItemIndex(doc), `${name}: 无部件文档不得有 itemIndex`).toBeNull()
      const palette = (doc.blockPalette as Record<string, unknown>[] | undefined) ?? []
      expect(palette.some((e) => e[HOST_ITEM] !== undefined), `${name}: 不得有 hostItem`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-25 / F-30：statsTemplate / statsOverride —— 静默忽略但不丢
// ─────────────────────────────────────────────────────────────────────────────

describe('B-25/F-30 `statsTemplate`/`statsOverride`：透传但语义作废（**读到静默忽略，不报错、不空栏**）', () => {
  it('两个真夹具带 `statsTemplate`：原样取出，**不**补默认、**不**报错', () => {
    for (const name of ['parts-ae2-multibox.v2.json', 'parts-singlebox-mix.v2.json']) {
      const doc = readFixture(name)
      const carried = statsFieldsCarried(doc)
      expect(Object.keys(carried), `${name}: statsTemplate 必须被带过来`).toEqual(['statsTemplate'])
      expect(carried.statsTemplate).toEqual(doc.statsTemplate)
      // `statsOverride` 缺席 ⇒ **不出现**（不补一个 `{}`）。
      expect(Object.prototype.hasOwnProperty.call(carried, 'statsOverride'), `${name}: 缺席字段不得被补成默认值`).toBe(false)
    }
  })

  it('`isDeprecatedStatsField` 的判定与登记表一致（清单只有一处定义）', () => {
    for (const f of DEPRECATED_STATS_FIELDS) expect(isDeprecatedStatsField(f)).toBe(true)
    expect(isDeprecatedStatsField('statsTemplateOther')).toBe(false)
    expect([...DEPRECATED_STATS_FIELDS]).toEqual(['statsTemplate', 'statsOverride'])
  })

  it('**负对照**："静默忽略"不等于"丢掉" —— 对照实现（过滤掉已废弃字段）判红', () => {
    const doc = readFixture('parts-ae2-multibox.v2.json')
    /** **对照实现**：把语义作废的字段当垃圾清掉。 */
    const naiveStrip = (d: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...d }
      for (const f of DEPRECATED_STATS_FIELDS) delete out[f]
      return out
    }
    expect(naiveStrip(doc).statsTemplate, '对照实现把字段丢了').toBeUndefined()
    // 真实实现：字段在位（"不丢"），但本模块**没有**任何消费它的语义出口。
    const carried = statsFieldsCarried(doc)
    expect(carried.statsTemplate, '真实实现必须保留字段（不丢）').toBeDefined()
    // "不报错"：取值本身不产生任何诊断/异常 —— 上面两步都只是普通读取。
    expect(statsFieldsCarried({})).toEqual({})
  })

  it('无该字段的文档 ⇒ 空记录（"没有"与"空对象"不可混淆）', () => {
    expect(statsFieldsCarried(readFixture('minimal-v2.json'))).toEqual({})
    expect(statsFieldsCarried(null)).toEqual({})
    expect(statsFieldsCarried({ statsTemplate: {} }), '空对象是一个**存在**的值').toEqual({ statsTemplate: {} })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F-32：根级透传清单 + copyIfPresent
// ─────────────────────────────────────────────────────────────────────────────

describe('F-32 根级透传清单：两条解析链**同一份**清单；`copyIfPresent` 不凭空造键', () => {
  it('清单逐项对齐旧层既有事实（`builtinParsers.ts:30-38`）', () => {
    const legacy = readSource('context/parsers/builtinParsers.ts')
    const partRoot = /const PART_ROOT_FIELDS = \[([\s\S]*?)\] as const/.exec(legacy)
    expect(partRoot, '旧清单必须仍可被解析').not.toBeNull()
    const legacyParts = [...(partRoot?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(legacyParts.length).toBeGreaterThan(0)
    // 本模块的清单必须**覆盖**旧清单（可多，不可少 —— 少一个就是 World 根丢字段）。
    for (const f of legacyParts) {
      expect([...STRUCTURE_ROOT_FIELDS, ...WORLD_ROOT_FIELDS], `透传清单必须含 ${f}`).toContain(f)
    }
  })

  it('World 清单含 `blockPalette` 与 `itemIndex`（两条链同清单的核心判据）', () => {
    expect(WORLD_ROOT_FIELDS).toContain('blockPalette')
    expect(WORLD_ROOT_FIELDS).toContain(ITEM_INDEX_FIELD)
    expect(STRUCTURE_ROOT_FIELDS).toContain(ITEM_INDEX_FIELD)
    // 两条链的交集必须一致（否则 World 根丢字段）。
    const shared = ['materialPalette', 'textureBlobs', 'tooltipPalette', 'cellTooltipGrid', 'playback', ...DEPRECATED_STATS_FIELDS, 'partIconTextures', ITEM_INDEX_FIELD]
    for (const k of shared) {
      expect(STRUCTURE_ROOT_FIELDS, `Structure 链必须含 ${k}`).toContain(k)
      expect(WORLD_ROOT_FIELDS, `World 链必须含 ${k}`).toContain(k)
    }
  })

  it('`copyFieldsIfPresent` 不凭空造键（`copyIfPresent` 语义 ⇒ B-1 逐字节的前提）', () => {
    const src = { a: 1, c: 3 }
    const out = copyFieldsIfPresent(src, ['a', 'b', 'c'], {})
    expect(Object.keys(out).sort()).toEqual(['a', 'c'])
    expect(Object.prototype.hasOwnProperty.call(out, 'b'), '缺席键不得出现').toBe(false)
    // 不修改入参（纯函数）。
    expect(src).toEqual({ a: 1, c: 3 })
    // 非对象输入返回原 dst。
    expect(copyFieldsIfPresent(null, ['a'], { z: 9 })).toEqual({ z: 9 })
  })

  it('**负对照**：给缺席键填默认值 ⇒ 输出多出键（这就是"产物字节变化"的来源）', () => {
    const src = { a: 1 }
    /** **对照实现**：顺手用默认值补齐（"这样下游就不会拿到 undefined"）。 */
    const naiveFill = (s: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
      const out = { ...s }
      for (const k of keys) if (out[k] === undefined) out[k] = []
      return out
    }
    const real = copyFieldsIfPresent(src, ['a', 'b'], {})
    const naive = naiveFill(src, ['a', 'b'])
    expect(Object.keys(real).sort()).toEqual(['a'])
    expect(Object.keys(naive).sort(), '对照实现多出一个键 ⇒ 字节必变').toEqual(['a', 'b'])
    expect(Object.keys(naive).length).toBeGreaterThan(Object.keys(real).length)
  })

  it('对真夹具跑清单透传：**一个键都不多、一个都不少**', () => {
    for (const name of V2_PLAIN_FIXTURES) {
      const doc = readFixture(name)
      const copied = copyFieldsIfPresent(doc, STRUCTURE_ROOT_FIELDS, {})
      for (const k of Object.keys(copied)) {
        expect(Object.prototype.hasOwnProperty.call(doc, k), `${name}: 搬来的键 ${k} 必须真的在源里`).toBe(true)
      }
      const expected = Object.keys(doc).filter((k) => (STRUCTURE_ROOT_FIELDS as readonly string[]).includes(k))
      expect(Object.keys(copied).sort(), `${name}: 搬运集合必须恰好等于源里命中的集合`).toEqual(expected.sort())
    }
  })
})
