/**
 * 文档绑定的**本地接管边界**判据（生产链路，无浏览器）。
 *
 * ## 被测的生产路径
 *
 * - Wiki A：`OPERATOR_DOCUMENT_LOAD`（sourceId=wiki-data）→ `documentLoadPipeline`
 *   → 生产 `DocumentBinding`（sourceId/locator/remoteRevisionId/saveBaseline）；
 * - 本地 B：`OPERATOR_OPEN_SCENE`（与拖放同一条生产算子）/ `OPERATOR_NEW_SCENE` /
 *   `OPERATOR_OPEN_PROJECT` / `OPERATOR_LOAD_BUILTIN` / `OPERATOR_SDE_LOAD` /
 *   `OPERATOR_LOAD_EMBED_DOCUMENT` / `OPERATOR_SET_WORKSPACE_MODE(resetDocument)`；
 * - 保存：`OPERATOR_SAVE_FILE` / `OPERATOR_SAVE_PROJECT` / `OPERATOR_DOCUMENT_SAVE` /
 *   `OPERATOR_WIKI_SAVE_AS` / `OPERATOR_WIKI_RELOAD`，全部走生产算子注册表；
 * - 保存闸门：`operators/availability#operatorAvailability`（单一结算点）。
 *
 * ## 为什么远端是替身、其余全是生产
 *
 * 判据要证明的是"绑定归谁、闸门给什么原因、本地保存把基线推给谁"。远端 MediaWiki
 * 只提供页面字节与 revision，替换它不会掩盖绑定/闸门/保存结算的任何一行；
 * 而 `Context`、内核会话、算子注册表、解析器、`plainForSave`、`completeDocumentSave`
 * 都是生产实现。全程不写真实 Wiki（`applyUploadPlan` 只记录参数）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ShallowRef } from 'vue'

import {
  ENVELOPE_FIXTURE,
  makeAvailabilityHost,
  PLAIN_FIXTURE,
  type AvailabilityHost,
} from '@/operators/__tests__/availabilityTestHost'
import { operatorAvailability, POLL_REASON } from '@/operators/availability'
import type { DocumentBinding } from '@/workbench/document/types'
import {
  applyDocumentBinding,
  createDocumentBindingRef,
  createEmptyBinding,
  resetDocumentBinding,
} from '@/workbench/document/binding'
import { confirmDiscardDirtyIfNeeded, settleDocumentTakeover } from '../pipeline'
import { projectForSave } from '@/composition/projectIo'
import { blockPaletteEntryKey } from '@/domain/blockGeometry'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import { realFixtureText, withRealFixture } from '../../../../e2e/real-fixture-vitest'
import {
  buildWikiEditSummaryDraft,
  WIKI_GENERIC_CONTENT_EDIT_SUMMARY,
} from '@/wiki/wikiEditSummary'
import { hasWikiRemoteChanges, wikiRemoteDirtyOf } from '@/wiki/wikiRemoteDirty'
import { createRecoveryHost } from '@/runtime/host/recoveryHost'
import { makeKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import { SDELoadExportOperator, SDELoadWorkspaceOperator } from '@/operators/builtin/sdeOperators'
import { LoadEmbedDocumentOperator } from '@/operators/builtin/docLifecycleOperators'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** 远端替身的记录面（只读测试进程；不发真实请求）。 */
const wikiState = vi.hoisted(() => ({
  loads: [] as string[],
  saves: [] as { summary: string; baserevid: number | null }[],
  revision: 1000,
}))

vi.mock('@/wiki/mwApiAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/wiki/mwApiAdapter')>()
  return {
    ...actual,
    // 只有"远端有 mw.Api 且已登录"这一条装配事实；绑定/闸门/结算不读它以外的网络。
    isWikiApiAvailable: () => true,
    createWikiApi: () => ({}) as never,
    loadStructureData: vi.fn(async (_api: unknown, title: string) => {
      const raw = JSON.parse(readFixtureText(ENVELOPE_FIXTURE)) as Record<string, unknown>
      const locator = title.startsWith('Data:Structures/') ? title : `Data:Structures/${title}.json`
      const base = locator.replace(/^Data:Structures\//, '').replace(/\.json$/, '')
      wikiState.loads.push(title)
      return { raw, locator, revisionId: wikiState.revision, displayName: base }
    }),
    applyUploadPlan: vi.fn(async (_api: unknown, _plan: unknown, opts: { summary: string; baserevid: number | null }) => {
      wikiState.saves.push({ summary: opts.summary, baserevid: opts.baserevid })
      wikiState.revision += 1
      return { lastRevisionId: wikiState.revision }
    }),
  }
})

vi.mock('@/util/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/util/browser')>()
  return { ...actual, downloadJson: vi.fn() }
})

vi.mock('@/dev/devScenes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dev/devScenes')>()
  return {
    ...actual,
    getDevSceneDocument: (id: string) => {
      if (id === 'broken-scene') return { not: 'a structure document' }
      return actual.getDevSceneDocument(id)
    },
  }
})

const sdeState = vi.hoisted(() => ({ data: null as unknown }))
vi.mock('@/workbench/sdeApi', () => ({
  sdePing: async () => {},
  sdeListExports: async () => [],
  sdeGetExportFile: async () => sdeState.data,
  sdePutWorkspaceDocument: async () => {},
}))

/** 与生产 `wikiEditSummary` 同一判据的"可审计变更"：基线里多一项 tooltip。 */
function withAuditableChange(plain: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const palette = Array.isArray(plain.tooltipPalette) ? [...(plain.tooltipPalette as unknown[])] : []
  palette.push('#takeover-probe')
  return { ...plain, tooltipPalette: palette }
}

/**
 * 夹具文本（**行尾归一化**；铁律 6：CRLF 检出下同上一次结果）。
 *
 * `ENVELOPE_FIXTURE` 是**仓外** StructureData 真实件 ⇒ 走 `realFixtureText` 惰性解析
 * （缺件时抛带诊断的错误，据此门控依赖它的用例）；`PLAIN_FIXTURE` 等**公开**夹具
 * 仍在仓内 `e2e/fixtures/`，保持原读取路径。
 */
function readFixtureText(name: string): string {
  if (name === ENVELOPE_FIXTURE) return realFixtureText('structureDataExportedEnvelope')
  return fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', name), 'utf8').replace(/\r\n/g, '\n')
}

function plainFixture(): Record<string, unknown> {
  // 与 availabilityTestHost 同一份夹具读取口径（web/ 为 cwd；行尾归一化，铁律 6）。
  return JSON.parse(readFixtureText(PLAIN_FIXTURE)) as Record<string, unknown>
}

async function makeHost(): Promise<AvailabilityHost> {
  return makeAvailabilityHost('never-bound')
}

/** Wiki A 的**正式装载**（生产算子 → 生产管线 → 生产绑定）。 */
async function loadWikiA(h: AvailabilityHost): Promise<void> {
  await h.registry.exec(h.ctx, 'OPERATOR_DOCUMENT_LOAD', { sourceId: 'wiki-data', title: 'TakeoverA' })
}

function bindingOf(h: AvailabilityHost): DocumentBinding {
  return h.ctx.getDocumentBinding().value
}

/**
 * **真实内核写**：只改一格方块身份（`cellGrid`/`cellPalette`），不碰摘要字段。
 *
 * 这是"主编辑内容"的最小生产命令面：`setCellIdentity` 走内核唯一写通路
 * （与属性面板同一条），装配/投影/保存产物都是生产实现。
 */
function editCellIdentityOnly(ctx: AvailabilityHost['ctx']): void {
  const before = ctx.plainForSave().plain
  if (before === null) throw new Error('前提：必须有保存产物')
  const grid = before.cellGrid as number[][][]
  const rows = grid[0]!.length
  const palette = before.blockPalette as Array<Record<string, unknown>>
  // 选一个**非空气且已存在于稀疏 `cells` 表**的格（越界/空格会被内核拒绝）。
  let cell: { x: number; y: number; z: number } | null = null
  let currentIdx = -1
  for (let z = 0; z < grid.length && cell === null; z++) {
    for (let row = 0; row < grid[z]!.length && cell === null; row++) {
      for (let col = 0; col < grid[z]![row]!.length; col++) {
        const idx = grid[z]![row]![col]!
        if (idx > 0 && palette[idx] !== undefined) {
          cell = { x: col, y: rows - 1 - row, z }
          currentIdx = idx
          break
        }
      }
    }
  }
  if (cell === null) throw new Error('前提：夹具里必须有一个非空气格')
  const current = palette[currentIdx]!
  const nextIdx = palette.findIndex(
    (e, i) =>
      i !== currentIdx &&
      e.registryId !== current.registryId &&
      typeof e.registryId === 'string' &&
      e.registryId.startsWith('minecraft:'),
  )
  if (nextIdx < 0) throw new Error('前提：夹具里必须有第二个不同的 minecraft 调色板条目')
  const next = palette[nextIdx]!
  const identity = {
    name: String(next.registryId).replace(/^minecraft:/, ''),
    paletteRef: blockPaletteEntryKey(next as never),
    ...(typeof next.meta === 'number' ? { meta: next.meta } : {}),
  }
  const session = ctx.requireKernelSession()
  const ticket = session.submit({
    kind: 'setCellIdentity',
    contextId: KERNEL_CONTEXT_ID,
    cells: [cell],
    identity,
  })
  session.drain()
  // 与生产 `Context#submitContentEdit` 同序：内核写 → legacy 投影。
  ctx.syncLegacyFromKernel()
  const settlement = session.settlementOf(ticket)
  if (settlement?.status !== 'applied') {
    throw new Error('setCellIdentity 未生效：' + JSON.stringify(settlement))
  }
}

/** 一次"本地保存后 Wiki 远端仍陈旧"场景的公共前半段。 */
async function dirtyWikiOnlyInCellGrid(h: AvailabilityHost): Promise<void> {
  await loadWikiA(h)
  editCellIdentityOnly(h.ctx)
  const plain = h.ctx.plainForSave().plain
  if (plain === null) throw new Error('前提：必须有保存产物')
  expect(bindingOf(h).sourceId).toBe('wiki-data')
  // 摘要草稿确实为 null（本场景遮蔽旧判据）；全量比较必须为 true。
  expect(
    buildWikiEditSummaryDraft(bindingOf(h).saveBaseline, plain),
    '前提：cellGrid-only 不得产生摘要行（否则本用例无法证明摘要判据有缺口）',
  ).toBeNull()
  expect(
    hasWikiRemoteChanges(bindingOf(h).saveBaseline, plain),
    '全量比较必须看见 cellGrid 差异',
  ).toBe(true)
  expect(wikiRemoteDirtyOf(h.ctx)).toBe(true)
  expect(gateOf(h).enabled, '真实编辑后 Wiki 保存必须可用').toBe(true)
  expect(documentSaveGateOf(h).enabled, '保存文档(poll)必须读同一全量判据').toBe(true)
}

/** 递归确认保存产物是合法 JSON 值（canonicalize 的边界前提）。 */
function assertJsonSafe(value: unknown, path = '$'): void {
  if (value === null) return
  const t = typeof value
  if (t === 'number') {
    expect(Number.isFinite(value as number), `${path} 必须是有限数（产物不得含 NaN/Infinity）`).toBe(true)
    return
  }
  if (t === 'string' || t === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`))
    return
  }
  if (t === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertJsonSafe(v, `${path}.${k}`)
    return
  }
  throw new Error(`${path}: 保存产物含非 JSON 值（${t}）`)
}

/** 安装一个"拒绝丢弃"的确认函数，并返回调用计数。 */
function refuseDiscard(h: AvailabilityHost): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => false)
  ;(h.ctx as unknown as { getToolSettings: () => unknown }).getToolSettings = () => ({ confirmDirty: confirm })
  return confirm
}

function gateOf(h: AvailabilityHost) {
  const op = h.registry.find('OPERATOR_WIKI_SAVE_CONFIRM')
  expect(op, '前提：生产注册表必须注册 Wiki 保存算子').toBeDefined()
  return operatorAvailability(h.ctx, op!)
}

function documentSaveGateOf(h: AvailabilityHost) {
  const op = h.registry.find('OPERATOR_DOCUMENT_SAVE')
  expect(op, '前提：生产注册表必须注册保存文档算子').toBeDefined()
  return operatorAvailability(h.ctx, op!)
}

/** 期望"保存到 Wiki 因**非 Wiki 文档**而不可用"，且下一步指向另存为。 */
function expectNotWikiGate(h: AvailabilityHost): void {
  const gate = gateOf(h)
  expect(gate.enabled, '本地文档上"保存到 Wiki"必须不可用').toBe(false)
  if (gate.enabled) return
  expect(gate.error.params.reason, '原因必须是 NOT_WIKI（不是"没有变更"）').toBe(
    POLL_REASON.NOT_WIKI_DATA_DOCUMENT,
  )
  expect(gate.reason, '原因必须指向"另存为 Wiki 结构"这一下一步').toContain('另存为')
}

const LOCAL_RAW = () => plainFixture()

beforeEach(() => {
  wikiState.loads.length = 0
  wikiState.saves.length = 0
  wikiState.revision = 1000
  sdeState.data = null
})

describe('applyDocumentBinding：字段缺席 / 显式 null 的判据', () => {
  it('显式 null 清空 baseline/revision；缺席才保留（防 ?? 陷阱）', () => {
    const binding: ShallowRef<DocumentBinding> = createDocumentBindingRef()
    binding.value = {
      sourceId: 'wiki-data',
      locator: 'Data:Structures/A.json',
      remoteRevisionId: 1000,
      saveBaseline: { marker: 'A' },
    }

    applyDocumentBinding(binding, {
      sourceId: 'wiki-data',
      locator: 'Data:Structures/A.json',
      remoteRevisionId: null,
      saveBaseline: null,
    })
    expect(binding.value.remoteRevisionId, '显式 null 必须清空 revision').toBeNull()
    expect(binding.value.saveBaseline, '显式 null 必须清空 baseline').toBeNull()

    binding.value = { ...binding.value, remoteRevisionId: 7, saveBaseline: { marker: 'B' } }
    applyDocumentBinding(binding, { sourceId: 'wiki-data', locator: 'Data:Structures/A.json' })
    expect(binding.value.remoteRevisionId, '字段缺席 ⇒ 保留（部分补丁语义）').toBe(7)
    expect(binding.value.saveBaseline, '字段缺席 ⇒ 保留').toEqual({ marker: 'B' })
  })

  it('没有工作台会话（嵌入外壳）时接管结算不触碰不存在的绑定', () => {
    // 嵌入外壳没有 DocumentBinding（Context#getDocumentBinding 会按装配事实抛错）；
    // LOAD_EMBED 也注册在嵌入外壳里，故这里必须是"没有可结算的绑定"而不是抛错。
    const embedLike = makeKernelReadHost(null)
    try {
      expect(() => settleDocumentTakeover(embedLike.ctx, { kind: 'no-document' })).not.toThrow()
    } finally {
      embedLike.dispose()
    }
  })

  it('resetDocumentBinding 一次清空四个字段（不是只清 sourceId）', () => {
    const binding: ShallowRef<DocumentBinding> = createDocumentBindingRef()
    binding.value = {
      sourceId: 'wiki-data',
      locator: 'Data:Structures/A.json',
      remoteRevisionId: 1000,
      saveBaseline: { marker: 'A' },
      pendingSaveSummary: 'draft',
    }
    resetDocumentBinding(binding)
    expect(binding.value).toEqual(createEmptyBinding())
    expect(binding.value.locator).toBe('')
    expect(binding.value.remoteRevisionId).toBeNull()
    expect(binding.value.saveBaseline).toBeNull()
  })
})

describe('Wiki A → 非 Wiki 文档接管：绑定不得沿用 A', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '真 OPEN_SCENE 打开本地 B：先证 B 接管，再证绑定重建且保存门关闭（零保存请求）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const aBaseline = bindingOf(h).saveBaseline
      expect(bindingOf(h).sourceId, '前提：生产装载必须建立 wiki-data 绑定').toBe('wiki-data')
      expect(bindingOf(h).locator).toBe('Data:Structures/TakeoverA.json')
      expect(bindingOf(h).remoteRevisionId).toBe(wikiState.revision)
      expect(h.ctx.kernelUndoState()?.canUndo, '前提：Wiki 装载后没有可撤销编辑（不触发脏确认）').toBe(false)

      const localRaw = LOCAL_RAW()
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_SCENE', {
        file: { name: 'local-b.json', text: async () => JSON.stringify(localRaw) },
      })

      // ① B 真的接管了内容（生产读面：文件名/工作区/产物 id）。
      expect(h.ctx.getLocalFileName().value, '本地文件名必须换成 B').toBe('local-b.json')
      expect(h.ctx.getWorkspaceMode().value, '工作区模式必须换成 local-file').toBe('local-file')
      const bPlain = h.ctx.plainForSave().plain
      expect(bPlain, '前提：B 必须有可保存产物').not.toBeNull()
      expect(bPlain?.id, 'B 的产物必须是本地夹具，不是 A 的信封').toBe(localRaw.id)

      // ② 绑定不再来自 A：四个字段逐个断。
      const b = bindingOf(h)
      expect(b.sourceId, 'sourceId 必须换成本地来源（不是 wiki-data）').toBe('local-file')
      expect(b.locator, 'locator 不得仍是 A 的 Wiki 页').toBe('local-b.json')
      expect(b.remoteRevisionId, 'remoteRevisionId 不得仍是 A 的远端修订').toBeNull()
      expect(b.saveBaseline, '基线不得仍是 A 的产物').not.toEqual(aBaseline)
      expect(b.saveBaseline, '基线必须钉到 B 的当前产物（刚打开 = 干净）').toEqual(bPlain)

      // ③ 保存门：不是"没有变更"，而是"不是 Wiki 文档"；派发零请求/零模态。
      expectNotWikiGate(h)
      const savesBefore = wikiState.saves.length
      const result = h.registry.invoke(h.ctx, 'OPERATOR_WIKI_SAVE_CONFIRM')
      expect(result, '不可用的 invoke 不得报 FINISHED').not.toBe('FINISHED')
      expect(h.wikiUi.modal.value, '不得打开保存确认模态（也就不会指向 A）').toBeNull()
      expect(wikiState.saves.length, '拒绝路径不得发出保存请求').toBe(savesBefore)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'NEW_SCENE：绑定整体清空（locator/baseline/revision 都为空）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      await h.registry.exec(h.ctx, 'OPERATOR_NEW_SCENE')
      expect(bindingOf(h)).toEqual(createEmptyBinding())
      expectNotWikiGate(h)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'OPEN_PROJECT：绑定重建成本地工程来源，A 的 locator/revision 不再出现',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const project = projectForSave({
        kernel: h.ctx.kernel,
        setDocument: (next) => h.ctx.setDocument(next),
      })
      expect(project.ok, '前提：Wiki A 必须能编码成工程').toBe(true)
      if (!project.ok) return
      const projectJson = JSON.stringify(project.value)

      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_PROJECT', {
        file: { name: 'project-441.json', text: async () => projectJson },
      })

      expect(h.ctx.getLocalFileName().value).toBe('project-441.json')
      const b = bindingOf(h)
      expect(b.sourceId).toBe('local-file')
      expect(b.locator).toBe('project-441.json')
      expect(b.locator).not.toContain('Data:Structures')
      expect(b.remoteRevisionId).toBeNull()
      expect(b.saveBaseline).toEqual(h.ctx.plainForSave().plain)
      expectNotWikiGate(h)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'OPEN_PROJECT 失败：当前文档与绑定都保留（失败不破坏有效状态）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const before = bindingOf(h)
      const beforeId = h.ctx.plainForSave().plain?.id
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_PROJECT', {
        file: { name: 'broken-project.json', text: async () => JSON.stringify({ not: 'a project' }) },
      })
      expect(h.ctx.hasLoadedDocument(), '失败不得清掉当前文档').toBe(true)
      expect(h.ctx.plainForSave().plain?.id, '失败不得换掉当前内容').toBe(beforeId)
      expect(bindingOf(h), '失败不得清/换当前绑定').toEqual(before)
      expect(gateOf(h).enabled, '当前仍是刚装载的 Wiki A（干净）⇒ gate 关闭').toBe(false)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'OPEN_SCENE 失败：当前文档与绑定都保留（M6 负对照）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const before = bindingOf(h)
      const beforeId = h.ctx.plainForSave().plain?.id
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_SCENE', {
        file: { name: 'broken-scene.json', text: async () => JSON.stringify({ not: 'a document' }) },
      })
      expect(h.ctx.hasLoadedDocument(), '失败的打开不得换掉当前有效文档').toBe(true)
      expect(h.ctx.plainForSave().plain?.id, '当前内容必须原样保留').toBe(beforeId)
      expect(bindingOf(h), '失败的打开没有任何接管 ⇒ 绑定不得被清/换').toEqual(before)
      expect(h.ctx.getLocalFileName().value, '文件名不得被失败的文件覆盖').not.toBe('broken-scene.json')
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'LOAD_BUILTIN 成功重建 builtin 绑定；解析失败清空文档时绑定也清空',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      await h.registry.exec(h.ctx, 'OPERATOR_LOAD_BUILTIN', { sceneId: 'builtin-animated-texture' })
      const b = bindingOf(h)
      expect(b.sourceId, '内置样例不是 Wiki').toBe('builtin')
      expect(b.locator).toBe('示例 · builtin-animated-texture.json')
      expect(b.remoteRevisionId).toBeNull()
      expect(b.saveBaseline, '成功接管必须把基线钉到当前产物（刚打开 = 干净）').toEqual(
        h.ctx.plainForSave().plain,
      )
      expect(h.ctx.kernelDirty(), '内置样例刚打开必须干净').toBe(false)
      expectNotWikiGate(h)

      // 装载失败会 setDocument(null) ⇒ 文档与绑定都必须清空。
      await loadWikiA(h)
      await h.registry.exec(h.ctx, 'OPERATOR_LOAD_BUILTIN', { sceneId: 'broken-scene' })
      expect(h.ctx.hasLoadedDocument(), '前提：解析失败后应当没有文档').toBe(false)
      expect(bindingOf(h)).toEqual(createEmptyBinding())
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'SDE 加载/失败：绑定换成 sde-export 或清空，不保留 Wiki A',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      sdeState.data = LOCAL_RAW()
      await SDELoadExportOperator.exec!(h.ctx, { name: 'sde-b' })
      const b = bindingOf(h)
      expect(b.sourceId).toBe('sde-export')
      expect(b.locator).toBe('sde-b')
      expect(b.remoteRevisionId).toBeNull()
      expect(b.saveBaseline).toEqual(h.ctx.plainForSave().plain)
      expectNotWikiGate(h)

      await loadWikiA(h)
      sdeState.data = { not: 'a structure document' }
      await SDELoadExportOperator.exec!(h.ctx, { name: 'sde-broken' })
      expect(h.ctx.hasLoadedDocument()).toBe(false)
      expect(bindingOf(h)).toEqual(createEmptyBinding())

      await loadWikiA(h)
      sdeState.data = LOCAL_RAW()
      await SDELoadWorkspaceOperator.exec!(h.ctx, { data: LOCAL_RAW() })
      expect(bindingOf(h).sourceId).toBe('sde-export')
      expect(bindingOf(h).locator).toBe('SDE workspace')
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'LOAD_EMBED：宿主提供的文档没有外部身份 ⇒ 清空；解析失败不清（当前文档不变）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      await LoadEmbedDocumentOperator.exec!(h.ctx, { document: LOCAL_RAW() })
      expect(bindingOf(h), '嵌入文档不属于任何外部文档 ⇒ 空绑定').toEqual(createEmptyBinding())
      expectNotWikiGate(h)

      await loadWikiA(h)
      const before = bindingOf(h)
      await expect(LoadEmbedDocumentOperator.exec!(h.ctx, { document: { not: 'a document' } })).rejects.toThrow()
      expect(bindingOf(h), '失败的嵌入装载不得破坏当前文档的绑定').toEqual(before)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'SET_WORKSPACE_MODE resetDocument：清文档时绑定一起清空',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      await h.registry.exec(h.ctx, 'OPERATOR_SET_WORKSPACE_MODE', {
        mode: 'local-file',
        resetDocument: true,
      })
      expect(h.ctx.hasLoadedDocument()).toBe(false)
      expect(bindingOf(h)).toEqual(createEmptyBinding())
    } finally {
      h.dispose()
    }
    },
  )
})

describe('本地 SAVE_FILE / SAVE_PROJECT：不得把旧 Wiki 的 locator/baseline 继续推进', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    'OPEN_SCENE 后本地保存只推进本地绑定的基线',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const aBaseline = bindingOf(h).saveBaseline
      const aLocator = bindingOf(h).locator
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_SCENE', {
        file: { name: 'local-b.json', text: async () => JSON.stringify(LOCAL_RAW()) },
      })
      const savesBefore = wikiState.saves.length
      const plainBeforeSave = h.ctx.plainForSave().plain
      expect(plainBeforeSave).not.toBeNull()

      // 让"本地绑定的基线"落后于当前产物：这样"本地保存推进自己的基线"才可观测。
      // 若实现把**所有**本地保存都跳过 B2（已知缺口），基线会停在这份陈旧值 ⇒ 判红。
      const staleForFile = withAuditableChange(plainBeforeSave!)
      h.ctx.getDocumentBinding().value = { ...bindingOf(h), saveBaseline: staleForFile }

      await h.registry.exec(h.ctx, 'OPERATOR_SAVE_FILE')
      const afterFile = bindingOf(h)
      expect(afterFile.sourceId).toBe('local-file')
      expect(afterFile.locator).toBe('local-b.json')
      expect(afterFile.locator).not.toBe(aLocator)
      expect(afterFile.remoteRevisionId).toBeNull()
      expect(afterFile.saveBaseline, '本地保存必须推进本地绑定自己的基线').toEqual(plainBeforeSave)
      expect(afterFile.saveBaseline).not.toEqual(staleForFile)
      expect(afterFile.saveBaseline).not.toEqual(aBaseline)

      const staleForProject = withAuditableChange(plainBeforeSave!)
      h.ctx.getDocumentBinding().value = { ...bindingOf(h), saveBaseline: staleForProject }
      await h.registry.exec(h.ctx, 'OPERATOR_SAVE_PROJECT')
      const afterProject = bindingOf(h)
      expect(afterProject.sourceId).toBe('local-file')
      expect(afterProject.locator).toBe('local-b.json')
      expect(afterProject.remoteRevisionId).toBeNull()
      expect(afterProject.saveBaseline, '工程保存必须推进本地绑定自己的基线').toEqual(
        h.ctx.plainForSave().plain,
      )
      expect(afterProject.saveBaseline).not.toEqual(staleForProject)
      expect(wikiState.saves.length, '本地保存不得发出任何 Wiki 保存请求').toBe(savesBefore)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'Wiki 绑定下本地保存不得把 Wiki 基线/revision 标成已保存（未写 Wiki 页）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const plain = h.ctx.plainForSave().plain
      expect(plain).not.toBeNull()
      // 代表"Wiki 页上的内容"与"当前本地内容"不同（差集判据真正比较的东西）。
      const wikiBaseline = withAuditableChange(plain!)
      h.ctx.getDocumentBinding().value = { ...bindingOf(h), saveBaseline: wikiBaseline }
      const revisionBefore = bindingOf(h).remoteRevisionId
      const locatorBefore = bindingOf(h).locator
      expect(gateOf(h).enabled, '前提：Wiki 基线落后于当前内容 ⇒ 保存到 Wiki 可用').toBe(true)

      await h.registry.exec(h.ctx, 'OPERATOR_SAVE_FILE')
      const afterFile = bindingOf(h)
      expect(afterFile.sourceId, '本地保存不得换绑定身份').toBe('wiki-data')
      expect(afterFile.locator).toBe(locatorBefore)
      expect(afterFile.remoteRevisionId, '本地保存不得推进 Wiki revision').toBe(revisionBefore)
      expect(afterFile.saveBaseline, '本地保存不得把 Wiki 基线推进成未写出的内容').toEqual(wikiBaseline)
      expect(h.ctx.kernelDirty(), 'B1（内容已保存到本地）仍然推进').toBe(false)
      const gateAfterFile = gateOf(h)
      expect(gateAfterFile.enabled, 'Wiki 页未写 ⇒ 保存到 Wiki 必须仍可用').toBe(true)

      await h.registry.exec(h.ctx, 'OPERATOR_SAVE_PROJECT')
      const afterProject = bindingOf(h)
      expect(afterProject.locator).toBe(locatorBefore)
      expect(afterProject.remoteRevisionId).toBe(revisionBefore)
      expect(afterProject.saveBaseline).toEqual(wikiBaseline)
      expect(gateOf(h).enabled, '工程保存同样不得把 Wiki 标成已保存').toBe(true)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'Wiki A 的确认草稿在装载/Reload 到 Wiki B 时清空（与本地接管一致）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      h.ctx.getDocumentBinding().value = {
        ...bindingOf(h),
        pendingSaveSummary: 'A 页未确认的草稿',
      }
      await h.registry.exec(h.ctx, 'OPERATOR_DOCUMENT_LOAD', {
        sourceId: 'wiki-data',
        title: 'TakeoverB',
      })
      expect(bindingOf(h).locator, '装载后绑定指向 B 页').toBe('Data:Structures/TakeoverB.json')
      expect(
        Object.prototype.hasOwnProperty.call(bindingOf(h), 'pendingSaveSummary'),
        '换到 Wiki B 后 A 页草稿必须清空',
      ).toBe(false)

      h.ctx.getDocumentBinding().value = {
        ...bindingOf(h),
        pendingSaveSummary: 'B 页未确认的草稿',
      }
      await h.registry.exec(h.ctx, 'OPERATOR_WIKI_RELOAD')
      expect(bindingOf(h).locator, 'Reload 后仍指向 B 页').toBe('Data:Structures/TakeoverB.json')
      expect(
        Object.prototype.hasOwnProperty.call(bindingOf(h), 'pendingSaveSummary'),
        'Reload 成功后旧草稿同样必须清空',
      ).toBe(false)
      expect(wikiState.loads.at(-1)).toBe('Data:Structures/TakeoverB.json')
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '本地接管显式清掉 pendingSaveSummary（旧页草稿不得跟到新文档）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      h.ctx.getDocumentBinding().value = {
        ...bindingOf(h),
        pendingSaveSummary: '旧 Wiki 页的确认草稿',
      }
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_SCENE', {
        file: { name: 'local-b.json', text: async () => JSON.stringify(LOCAL_RAW()) },
      })
      expect(
        Object.prototype.hasOwnProperty.call(bindingOf(h), 'pendingSaveSummary'),
        '接管后旧页的确认草稿必须被显式删掉（不是留着等下一份文档）',
      ).toBe(false)
    } finally {
      h.dispose()
    }
    },
  )
})

/** cellGrid-only 场景：本地保存后仍应判定 Wiki 远端陈旧，且 Wiki 保存后转干净。 */
async function cellGridOnlyThenLocalSave(
  kind: 'file' | 'project',
): Promise<AvailabilityHost> {
  const h = await makeHost()
  await dirtyWikiOnlyInCellGrid(h)
  expect(h.ctx.kernelDirty(), '前提：真实编辑后内核 B1 为脏').toBe(true)
  const baselineBefore = bindingOf(h).saveBaseline
  const locatorBefore = bindingOf(h).locator
  const revisionBefore = bindingOf(h).remoteRevisionId
  const confirm = refuseDiscard(h)

  await h.registry.exec(
    h.ctx,
    kind === 'file' ? 'OPERATOR_SAVE_FILE' : 'OPERATOR_SAVE_PROJECT',
  )

  // 本地保存：B1 clean，但 B2（Wiki 远端基线）必须原样保留。
  expect(h.ctx.kernelDirty(), `${kind}：本地保存后内核 B1 必须干净`).toBe(false)
  expect(bindingOf(h).saveBaseline, `${kind}：本地保存不得推进 Wiki 远端基线`).toEqual(
    baselineBefore,
  )
  expect(bindingOf(h).locator).toBe(locatorBefore)
  expect(bindingOf(h).remoteRevisionId).toBe(revisionBefore)
  expect(wikiRemoteDirtyOf(h.ctx), `${kind}：Wiki 远端仍陈旧`).toBe(true)
  expect(gateOf(h).enabled, `${kind}：Wiki 保存门仍必须可用`).toBe(true)

  // 丢弃确认：虽然 B1 干净，但 Wiki 远端落后 ⇒ 必须询问。
  expect(await confirmDiscardDirtyIfNeeded(h.ctx), `${kind}：丢弃前必须确认`).toBe(false)
  expect(confirm).toHaveBeenCalledTimes(1)

  // Wiki picker / Reload 走同一守卫：用户拒绝 ⇒ 一个页面都没重载。
  const loadsBefore = wikiState.loads.length
  await h.registry.exec(h.ctx, 'OPERATOR_WIKI_RELOAD')
  expect(wikiState.loads.length, `${kind}：拒绝丢弃后不得继续 Reload`).toBe(loadsBefore)
  expect(bindingOf(h).locator).toBe(locatorBefore)

  return h
}

/** 全量有差异但摘要草稿为 null：确认模态仍打开、摘要退化为通用说明。 */
async function wikiSaveCleanAfterGenericConfirm(h: AvailabilityHost): Promise<void> {
  const revisionBefore = bindingOf(h).remoteRevisionId
  const invoke = h.registry.invoke(h.ctx, 'OPERATOR_WIKI_SAVE_CONFIRM')
  expect(invoke, '全量有差异时 poll/invoke 必须放行').toBe('FINISHED')
  expect(h.wikiUi.modal.value, '必须打开保存确认（不能 poll 放行后 invoke 又拒绝）').toBe(
    'save-confirm',
  )
  expect(
    h.wikiUi.saveConfirm.value?.defaultSummary,
    '摘要草稿为 null 时必须给出通用摘要',
  ).toBe(WIKI_GENERIC_CONTENT_EDIT_SUMMARY)
  h.wikiUi.modal.value = null
  h.wikiUi.saveConfirm.value = null

  const savesBefore = wikiState.saves.length
  await h.registry.exec(h.ctx, 'OPERATOR_DOCUMENT_SAVE', {
    summary: WIKI_GENERIC_CONTENT_EDIT_SUMMARY,
  })
  expect(wikiState.saves.length, '保存必须真的发出一次（mock 远端）').toBe(savesBefore + 1)
  expect(wikiRemoteDirtyOf(h.ctx), 'B2 推进后全量 diff 必须为空').toBe(false)
  expect(gateOf(h).enabled, '保存成功后 gate 必须关闭').toBe(false)
  expect(documentSaveGateOf(h).enabled, '文档保存 poll 同样必须关闭').toBe(false)
  expect(bindingOf(h).saveBaseline).toEqual(h.ctx.plainForSave().plain)
  expect(bindingOf(h).remoteRevisionId).toBe((revisionBefore ?? 0) + 1)

  const confirm = refuseDiscard(h)
  expect(await confirmDiscardDirtyIfNeeded(h.ctx), '干净后丢弃不再需要确认').toBe(true)
  expect(confirm).not.toHaveBeenCalled()
}

describe('cellGrid-only：摘要草稿为 null 时 Wiki 远端 dirty 仍必须成立', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    'SAVE_FILE：B1 clean、B2 仍 A、gate/丢弃确认仍脏；mock Wiki 保存成功后 clean',
    async () => {
    const h = await cellGridOnlyThenLocalSave('file')
    try {
      await wikiSaveCleanAfterGenericConfirm(h)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'SAVE_PROJECT：B1 clean、B2 仍 A、gate/丢弃确认仍脏；mock Wiki 保存成功后 clean',
    async () => {
    const h = await cellGridOnlyThenLocalSave('project')
    try {
      await wikiSaveCleanAfterGenericConfirm(h)
    } finally {
      h.dispose()
    }
    },
  )
})

describe('真实保存产物边界', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    'Wiki A 的 plain 不含 undefined/NaN/Infinity（canonicalize 的 JSON 边界前提）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const plain = h.ctx.plainForSave().plain
      expect(plain).not.toBeNull()
      assertJsonSafe(plain)
    } finally {
      h.dispose()
    }
    },
  )
})

describe('正常 Wiki 面保留（正对照）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    'dirty 可保存：正式保存推进 baseline/revision，随后 clean 的原因变成"没有可审计变更"',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const locator = bindingOf(h).locator
      const plain = h.ctx.plainForSave().plain
      expect(plain).not.toBeNull()
      // 造一份"上次保存的内容"：与当前产物不同（这是差集判据真正比较的东西）。
      h.ctx.getDocumentBinding().value = {
        ...bindingOf(h),
        saveBaseline: withAuditableChange(plain!),
      }
      expect(gateOf(h).enabled, '前提：有可审计变更时 Wiki 保存必须可用').toBe(true)

      const revisionBefore = wikiState.revision
      await h.registry.exec(h.ctx, 'OPERATOR_DOCUMENT_SAVE', { summary: '正对照保存' })

      const b = bindingOf(h)
      expect(b.sourceId).toBe('wiki-data')
      expect(b.locator, '正常保存不得换 locator').toBe(locator)
      expect(b.saveBaseline, '正式保存必须把基线推进到捕获的产物').toEqual(plain)
      expect(b.remoteRevisionId, '正式保存必须推进远端 revision').toBe(revisionBefore + 1)
      expect(wikiState.saves.at(-1)?.baserevid, '正常保存必须以旧 revision 为 baserevid').toBe(revisionBefore)

      const clean = gateOf(h)
      expect(clean.enabled).toBe(false)
      if (!clean.enabled) {
        expect(clean.error.params.reason, '同一文档保存后原因必须是"没有可审计变更"').toBe(
          POLL_REASON.NO_AUDITABLE_CHANGES,
        )
      }
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'Wiki 另存为换 locator；Reload 保持 locator 并刷新 revision/基线',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      h.ctx.getDocumentBinding().value = {
        ...bindingOf(h),
        saveBaseline: withAuditableChange(h.ctx.plainForSave().plain!),
      }
      await h.registry.exec(h.ctx, 'OPERATOR_WIKI_SAVE_AS', { baseName: 'TakeoverB', summary: '另存为' })

      const saveAsBinding = bindingOf(h)
      expect(saveAsBinding.sourceId).toBe('wiki-data')
      expect(saveAsBinding.locator).toBe('Data:Structures/TakeoverB.json')
      expect(saveAsBinding.locator).not.toBe('Data:Structures/TakeoverA.json')
      expect(saveAsBinding.remoteRevisionId).toBe(wikiState.revision)
      expect(saveAsBinding.saveBaseline).toEqual(h.ctx.plainForSave().plain)
      expect(wikiRemoteDirtyOf(h.ctx), 'SaveAs 换新 baseline 后立即 clean（不残留旧缓存）').toBe(false)

      await h.registry.exec(h.ctx, 'OPERATOR_WIKI_RELOAD')
      const reloaded = bindingOf(h)
      expect(reloaded.sourceId).toBe('wiki-data')
      expect(reloaded.locator, 'Reload 必须保持在同一个页面').toBe('Data:Structures/TakeoverB.json')
      expect(reloaded.remoteRevisionId).toBe(wikiState.revision)
      expect(reloaded.saveBaseline).toEqual(h.ctx.plainForSave().plain)
      expect(wikiRemoteDirtyOf(h.ctx), 'Reload 替换 baseline 后立即 clean').toBe(false)
      expect(wikiState.loads.at(-1)).toBe('Data:Structures/TakeoverB.json')
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '从本地文档另存为 Wiki：baseline 钉到刚写出的内容，换 locator 后仍干净',
    async () => {
    const h = await makeHost()
    try {
      await h.registry.exec(h.ctx, 'OPERATOR_OPEN_SCENE', {
        file: { name: 'local-b.json', text: async () => JSON.stringify(LOCAL_RAW()) },
      })
      const plain = h.ctx.plainForSave().plain
      expect(plain).not.toBeNull()
      // 模拟"本地保存后又编辑"：基线落后于当前产物；另存为要写出的正是当前内容。
      h.ctx.getDocumentBinding().value = { ...bindingOf(h), saveBaseline: withAuditableChange(plain!) }

      await h.registry.exec(h.ctx, 'OPERATOR_WIKI_SAVE_AS', {
        baseName: 'TakeoverFromLocal',
        summary: '从本地另存为',
      })

      const b = bindingOf(h)
      expect(b.sourceId, '另存为后绑定归到 Wiki').toBe('wiki-data')
      expect(b.locator).toBe('Data:Structures/TakeoverFromLocal.json')
      expect(b.saveBaseline, '另存为写的是当前内容 ⇒ 基线必须钉到它').toEqual(h.ctx.plainForSave().plain)
      expect(b.remoteRevisionId).toBe(wikiState.revision)
      expect(gateOf(h).enabled, '刚另存为的页面必须判干净').toBe(false)
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '恢复副本采纳：仍整体清空绑定（副本不携带源 locator）',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const restored = h.ctx.kernel?.document()
      expect(restored, '前提：内核必须承载已装配文档').toBeDefined()
      if (restored === undefined) return
      const projected = h.ctx.main.doc.value as RuntimeDocument
      const installed = createRecoveryHost(h.ctx).installRestored({
        payload: {} as never,
        restored,
        content: restored.content,
        projected,
        declaration: null,
      })
      expect(installed).toBe(true)
      expect(bindingOf(h)).toEqual(createEmptyBinding())
    } finally {
      h.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'undo/redo 的写路径（documentSnapshot → restoreDocumentSnapshot）不碰绑定',
    async () => {
    const h = await makeHost()
    try {
      await loadWikiA(h)
      const before = bindingOf(h)
      const token = h.ctx.documentSnapshot()
      h.ctx.restoreDocumentSnapshot(token)
      expect(bindingOf(h), '撤销回到同一份文档不得清绑定').toEqual(before)

      // "撤销到无文档"也走同一个 setDocument(null)——绑定清空**不在这里**做。
      h.ctx.restoreDocumentSnapshot(null)
      expect(h.ctx.hasLoadedDocument()).toBe(false)
      expect(bindingOf(h), 'Context#setDocument 不得成为全局清绑定点').toEqual(before)
      expect(
        gateOf(h).enabled,
        '无文档时保存门不得因"缺 current"被判脏而放行（由 hasLoadedDocument 守卫）',
      ).toBe(false)
    } finally {
      h.dispose()
    }
    },
  )
})
