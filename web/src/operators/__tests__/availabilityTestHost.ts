/**
 * **算子可用性判据的宿主**：真 `Context` + 真注册表 + 真装配能力。
 *
 * ## 为什么是"真 Context + 只注入宿主面"（而不是复刻一个 ctx）
 *
 * 本工程的判据纪律（`runtime/__tests__/kernelReadTestHost` 的两轮教训）：复刻实现会让判据
 * **空转**。这里被测的是三条生产代码路径：
 *
 *  1. `OperatorRegistry#exec/#invoke` 的 `settleAvailability`（能否在 poll=false 时给出
 *     **可见**拒绝）；
 *  2. `operators/availability#operatorAvailability`（唯一结算点）；
 *  3. Wiki 算子自己的 `poll`/`pollReason`（`plainForSave()` 差集 + 绑定形态）。
 *
 * 故 `ctx` 是**生产 `Context` 实例**（`Object.create(Context.prototype)` + 只注入宿主面），
 * 内核是**真 `KernelSession`**（`makeAdoptedKernelReadHost` 走生产 `adoptLoadedDocument`），
 * 产物 `plain` 由生产 `plainForSave()` 给出，算子注册走**生产** `registerWorkbenchOperators`。
 *
 * ## 注入的宿主面（都是外壳本该提供的东西）
 *
 * | 字段 | 生产来源 |
 * |---|---|
 * | `capabilities` | `resolveComposition(WIKI_PROFILE)` 的解析结果（**不是**手写数组） |
 * | `wm.settings` | `createShellSettings()`（`t()`/`lang` 都是生产的） |
 * | `wm.chrome.wikiUi` | `createWikiUiState()` |
 * | `wm.diagnostics` | `createDiagnosticRecorder()` |
 * | `log` | `createLogCenter()`（`liveStatus` 是底栏成句原因的**唯一**读面） |
 * | `screen.session.documentBinding` | `createDocumentBindingRef()`（生产形状） |
 * | `workbench.selection` | `createSelectionContext()`（`log.snapshot` 需要它） |
 * | `main.registries` | 生产 `OperatorRegistry` + `wrapOperatorRegistry` 门面 |
 */
import fs from 'node:fs'
import path from 'node:path'
import { ref, type Ref, type ShallowRef } from 'vue'
import { plainRootOf } from '@/adapters/plainRoot'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { createOperatorRegistry, wrapOperatorRegistry, type OperatorRegistry } from '@/operators/operatorRegistry'
import { registerWorkbenchOperators } from '@/workbench/registerWorkbench'
import { WIKI_PROFILE } from '@/composition/profiles'
import { resolveComposition } from '@/composition/resolver'
import { createLogCenter } from '@/logging/LogCenter'
import { createDiagnosticRecorder } from '@/application/diagnostics'
import { createSelectionContext } from '@/context/selection'
import { createWikiUiState, type WikiUiState } from '@/runtime/wikiUi'
import { createShellSettings, type ShellSettings } from '@/runtime/shellSettings'
import { createDocumentBindingRef } from '@/workbench/document/binding'
import type { DocumentBinding } from '@/workbench/document/types'
import { makeAdoptedKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import type { Context } from '@/runtime/context'
import { realFixtureText } from '../../../e2e/real-fixture-vitest'

/** 生产夹具（真实游戏内导出信封；与 e2e 同一份）。 */
export const ENVELOPE_FIXTURE = 'structuredata-exported-envelope.json'
/**
 * 纯 v2 plain 夹具（无 gzip 信封）。
 *
 * 为什么需要它：信封解包走 `pako`，而 `pako` 在 **jsdom** 环境下会走一条依赖 Node 流的
 * 分支（实测 `(intermediate value).stream is not a function`）⇒ 信封夹具在 DOM 判据里
 * 解析不了。DOM 判据要的是"菜单按生产 layout 渲染并按 poll 灰显"，与信封编码无关，
 * 故它用纯 plain 夹具（同一份生产解析器、同一份装配链）。
 */
export const PLAIN_FIXTURE = 'parts-singlebox-mix.v2.json'

/** 本宿主的文档形态（决定 binding 与保存基线）。 */
export type AvailabilityScenario =
  /** 从 Wiki 载入且**刚装载**（基线 = 当前产物 ⇒ 无可审计变更）。 */
  | 'wiki-clean'
  /** 从 Wiki 载入且**有可审计变更**（基线 ≠ 当前产物 ⇒ 保存可用）。 */
  | 'wiki-dirty'
  /** 非 Wiki 来源的绑定（Wiki 保存不可用；下一步是"另存为 Wiki 结构"）。 */
  | 'local-file'
  /** 刚被 `OPERATOR_OPEN_SCENE` 打开过、**从未**写过绑定（生产的真实形态）。 */
  | 'never-bound'

export interface AvailabilityHost {
  /** **生产** `Context` 实例（只注入宿主面）。 */
  readonly ctx: Context
  /** 生产工作台注册表（`registerWorkbenchOperators`）。 */
  readonly registry: OperatorRegistry
  readonly binding: ShallowRef<DocumentBinding>
  readonly log: ReturnType<typeof createLogCenter>
  readonly settings: ShellSettings
  readonly wikiUi: WikiUiState
  dispose(): void
}

/**
 * 生产夹具原文（不落盘、不改仓库原件）。
 *
 * `ENVELOPE_FIXTURE` 是**仓外** StructureData 真实件 ⇒ 走 `realFixtureText` 惰性解析
 * （缺件时抛带诊断的错误，由消费方据此显式门控）；
 * 其余**公开**夹具（`PLAIN_FIXTURE` 等）仍在仓内 `e2e/fixtures/`，保持原读取路径。
 */
export function fixtureRaw(fixture: string = ENVELOPE_FIXTURE): Record<string, unknown> {
  if (fixture === ENVELOPE_FIXTURE) {
    return JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Record<string, unknown>
  }
  const file = path.join(process.cwd(), 'e2e', 'fixtures', fixture)
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

/** 生产解析器注册顺序（与宿主同一份）。 */
function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** `WIKI_PROFILE` 的**装配解析结果**（能力集合的唯一来源）。 */
function wikiCapabilities(): readonly string[] {
  const r = resolveComposition({ profileId: WIKI_PROFILE.id, modules: WIKI_PROFILE.modules })
  if (!r.ok) throw new Error('WIKI_PROFILE 解析失败：' + r.error.failures.map((f) => f.detail).join(' | '))
  return r.value.capabilities
}

/** **给一份已装载的文档造一个可用的保存基线**（产物 plain 的冻结副本）。 */
function plainOf(ctx: Context): Record<string, unknown> {
  const saved = ctx.plainForSave()
  if (saved.plain === null) throw new Error('前提：已装配的夹具必须有保存投影')
  return JSON.parse(JSON.stringify(saved.plain)) as Record<string, unknown>
}

/**
 * 造一个"从 Wiki 载入、且**有可审计变更**"的基线。
 *
 * 手段是把 `tooltipPalette` 追加一项 —— 这正是 `buildWikiEditSummaryDraft` 逐项比较的
 * 通道之一（`tooltipPalette[i]: … -> …`），与"上次保存的内容"不同是**可读的事实**，
 * 不是内部标志位。
 */
function withAuditableChange(plain: Record<string, unknown>): Record<string, unknown> {
  const palette = Array.isArray(plain.tooltipPalette) ? [...(plain.tooltipPalette as unknown[])] : []
  palette.push('#availability-probe')
  return { ...plain, tooltipPalette: palette }
}

export async function makeAvailabilityHost(
  scenario: AvailabilityScenario,
  opts: { readonly fixture?: string } = {},
): Promise<AvailabilityHost> {
  const raw = fixtureRaw(opts.fixture)
  const parsers = productionParsers()
  const parsed = await parsers.detectAndParse(raw)
  if (parsed.document === null) throw new Error('夹具解析失败：' + String(parsed.error))
  // 与装配结果**同一份**能力集：Context 的可用性结算与内核命令闸门读到同一事实
  // （生产里两者都来自 `shell.assembly.capabilities`）。缺它则 `save` 命令会被
  // 内核以 capability 拒绝，保存类判据会空转。
  const capabilities = wikiCapabilities()
  const kernelHost = makeAdoptedKernelReadHost(parsed.document as never, plainRootOf(raw), capabilities)

  const registry = createOperatorRegistry()
  registerWorkbenchOperators(registry)

  const settings = createShellSettings({ surface: 'workbench', instanceId: 'availability-test' })
  const log = createLogCenter()
  const wikiUi = createWikiUiState()
  // 菜单是否出现 Wiki 文件项由它决定（生产里由 `WorkbenchRoot` 写）。
  wikiUi.mwReady.value = true

  const binding = createDocumentBindingRef()
  const localFileName: Ref<string | null> = ref(null)
  const plain = plainOf(kernelHost.ctx)
  const base = { sourceId: 'wiki-data' as const, locator: 'Data:Structures/AvailabilityProbe.json', remoteRevisionId: 1000 }
  if (scenario === 'wiki-clean') binding.value = { ...base, saveBaseline: plain }
  if (scenario === 'wiki-dirty') binding.value = { ...base, saveBaseline: withAuditableChange(plain) }
  if (scenario === 'local-file') {
    binding.value = {
      sourceId: 'local-file',
      locator: 'AvailabilityProbe.json',
      remoteRevisionId: null,
      saveBaseline: plain,
    }
    localFileName.value = 'AvailabilityProbe.json'
  }
  // `never-bound` ⇒ 保持 `createEmptyBinding()` 的原样（`sourceId: 'empty'`）

  const ctx = kernelHost.ctx
  const ctxAny = ctx as unknown as Record<string, unknown>
  Object.assign(ctxAny, {
    capabilities,
    log,
    t: (key: string) => settings.t(key),
    wm: {
      settings,
      diagnostics: createDiagnosticRecorder({ capacity: 64, now: () => 0 }),
      chrome: { wikiUi },
    },
    /** 生产的 `getSession()` 读它 ⇒ `getDocumentBinding()` 走**生产实现**。 */
    screen: {
      session: {
        documentBinding: binding,
        localFileName,
        workspaceMode: ref('wiki-data'),
        uiWorkspace: ref('workbench'),
        layerWorldY: ref(-1),
        connection: { connected: false },
      },
    },
    /** `log.snapshot` 需要 selection / toolRegistry（生产里由 `createWorkbenchHost` 给）。 */
    workbench: {
      selection: createSelectionContext(),
      toolRegistry: { activeTool: ref(null) },
    },
    /**
     * 装载算子会调它们：`viewports.resetAllViewportCameras(ctx.main.cameras)` 与
     * `hydrateMainEmbedInitialViewFromDoc(ctx.main)`。本宿主没有真实视口，
     * 故给"无事可做"的生产形参 —— 判据不读画面，只读文档/绑定。
     */
    viewports: {
      resetAllViewportCameras: () => {},
    },
    /** 装载前的脏确认（`confirmDiscardDirtyIfNeeded`）：测试一律选择"继续"。 */
    getToolSettings: () => ({ confirmDirty: () => true }),
    main: {
      ...(kernelHost.ctx.main as unknown as Record<string, unknown>),
      cameras: {},
      embedInitialView: ref(null),
      registries: {
        operators: registry,
        operatorsFacade: wrapOperatorRegistry(registry, () => ctx),
        // 装载算子（OPEN_SCENE / LOAD_BUILTIN / DOCUMENT_LOAD）都要它：
        // 与宿主同一份生产解析器注册表（不是测试另造一套）。
        parsers,
      },
    },
  })

  return {
    ctx,
    registry,
    binding,
    log,
    settings,
    wikiUi,
    dispose: () => kernelHost.dispose(),
  }
}
