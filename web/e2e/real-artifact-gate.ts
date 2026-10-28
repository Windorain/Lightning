/**
 * **真实产物 spec 的显式排除口径**（产物门控，不是手敲路径清单）。
 *
 * ## 为什么需要它
 *
 * 仓库里有 **44 份 spec** 需要**落在树外的真实产物**：
 *  - 6 份既有门控（4 份是 `mod/gtnh/run/client/...` 下的游戏内导出，
 *    2 份是 `LIGHTNING_REAL_FIXTURES_DIR` 下的真实夹具：TESR 捕获占位与 IC2 裁列棘轮）；
 *  - 38 份消费 **StructureData 真实信封**（同一夹具根下的 `structuredata/`，本批外置）。
 *
 * 干净检出上没有树外产物，而其中**两份在 import 期就抛错** —— Playwright 会把 import 错误
 * 当成**整次 collection 失败**：实测 `npm run test:e2e:tree` 在 8.3s 内以 `expected: 0` 结束，
 * **一个用例都没跑**。也就是说"全量 e2e"在干净检出上目前不是"跑得慢"，而是**根本跑不起来**。
 *
 * ## 与那 4 份 spec **自己的契约**如何共存
 *
 * 它们刻意设计成"产物缺失必须显式失败，**不得静默跳过**"（验收管线语义，见
 * `helpers/parts/realExport.ts` / `helpers/multiblock/realExports.ts` 的头注释）——
 * 这个契约是对的，不能为了让套件跑起来而把它们改成 skip。
 *
 * 所以排除做在**入口层**，并且是**产物门控**的：
 *  - **缺产物** ⇒ 该 spec 从本次 collection 排除，并在启动时打印横幅 + 落一份
 *    `test-results/e2e-exclusions.json`（含文件、失败形态、缺的产物、检查过的候选路径、再生命令）
 *    ⇒ "排除了什么、为什么"是**机器可读且有据可查**的，不是一句"已知失败"；
 *  - **产物存在** ⇒ `testIgnore` 为空，这些 spec **自动纳入并必须通过**（没有任何静默跳过）。
 *
 * 判据"产物是否就绪"**直接调用各 spec 自己要用的解析器**
 * （`resolvePartsArchive()` / `resolveRealExportsDir()`，未就绪即抛错；
 * TESR / IC2 / StructureData 则是它们与 spec 共用的 `realFixtureAvailable('<key>')`）——
 * 于是本文件的"就绪"定义与 spec 的"就绪"定义**永远是同一个**，不会各说各话。
 *
 * ## 第三种来源：**入仓产物（棘轮）** —— `committed: true`
 *
 * 表里保留了 `committed` 这一**通用**口径：产物**提交进仓**的 spec 不可能"环境性缺失"，
 * 它的缺失只可能是**有人删了/搬了/改坏了它**（缺陷）。故：
 *  - 树外产物未就绪 ⇒ **排除**（环境条件，横幅 + `e2e-exclusions.json` 登记）；
 *  - 入仓产物未就绪 ⇒ **绝不排除**，spec 照跑并由它自己判红（缺陷必须红，不能被门控吞成"本次没跑"）。
 * 两者仍是**同一张表、同一个横幅、同一份记录**，不是第二套门控。
 *
 * ⚠ 当前表中**没有条目**使用 `committed: true`：IC2 裁列棘轮与 StructureData 真实信封
 * 也都已外置到仓外夹具根，与其余 5 份同样是"树外真实基线"（缺失 = 环境条件 ⇒ 显式排除）。保留该字段是为了
 * 将来真有入仓产物时的唯一口径不被重新发明；无条目使用时横幅与记录里的相关小节自动为空。
 *
 * ## 与"排除口径"的关系
 *
 * 显式排除口径 = 本文件的 `REAL_ARTIFACT_SPECS` 一张表 + 门控结果，二者都进证据。
 */

import fs from 'node:fs'
import path from 'node:path'
// 外部真实夹具（TESR / IC2 / StructureData）的就绪判据 = resolver 的 `realFixtureAvailable`（唯一夹具根键）。
// 该模块自身会加载仓库根 `.env`；playwright.config 亦显式先行加载，二者幂等。
import { realFixtureAvailable } from './real-fixtures.mjs'
import { REAL_EXPORT_COMMAND as PARTS_EXPORT_COMMAND, resolvePartsArchive } from './helpers/parts/realExport'
import {
  REAL_EXPORT_COMMAND as MB_EXPORT_COMMAND,
  resolveRealExportsDir,
} from './helpers/multiblock/realExports'

/** 一份需要真实产物的 spec。 */
export interface RealArtifactSpec {
  /** spec 文件名（`web/e2e/` 下）。 */
  spec: string
  /**
   * 缺产物时的失败形态（实测）：
   *  - `import-fatal`：**模块顶层**就抛 ⇒ Playwright 整次 collection 中止（危害最大）；
   *  - `runtime`：collect 通过，跑起来才因缺产物红。
   */
  failureMode: 'import-fatal' | 'runtime'
  /** 人读的产物要求。 */
  requires: string
  /** 产物再生命令（原样取自 spec 侧的常量，不另写一份）。 */
  regenerate: string
  /** 就绪判据：**调 spec 自己的严格解析器 / resolver**（未就绪会抛或返回 false）。 */
  ready: () => boolean
  /**
   * 产物**已入仓**（棘轮口径）。
   *
   * `true` ⇒ 本 spec **永不进入排除名单**：入仓件的"未就绪"是缺陷（有人删了/搬了它），
   * 必须由 spec 自己判红。该条目在横幅与 `test-results/e2e-exclusions.json` 里单列，
   * 不计入"可排除"。
   */
  committed?: boolean
}

/** 就绪判据：严格解析器不抛即就绪。 */
function resolvedOrNot(fn: () => unknown): boolean {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

/**
 * 需要真实产物的 spec（6 份既有树外产物 spec：4 份 `mod/gtnh/run/client/...` 游戏内导出
 * + TESR 捕获占位 + IC2 裁列棘轮；另加 38 份 StructureData 真实信封消费者，均在
 * `LIGHTNING_REAL_FIXTURES_DIR` 下）。
 *
 * 顺序按**危害**排列：先 import-fatal 的两份（它们会让整次运行零用例）。
 */
export const REAL_ARTIFACT_SPECS: RealArtifactSpec[] = [
  {
    spec: 'parts-real-export.spec.ts',
    failureMode: 'import-fatal',
    requires: 'parts 验收归档（含 sde_parts_acceptance_export_full_a.json）',
    regenerate: PARTS_EXPORT_COMMAND,
    ready: () => resolvedOrNot(() => resolvePartsArchive()),
  },
  {
    spec: 'parts-real-export-evidence.spec.ts',
    failureMode: 'import-fatal',
    requires: 'parts 验收归档（含 sde_parts_acceptance_export_full_a.json）',
    regenerate: PARTS_EXPORT_COMMAND,
    ready: () => resolvedOrNot(() => resolvePartsArchive()),
  },
  {
    spec: 'multiblock-real-acceptance.spec.ts',
    failureMode: 'runtime',
    requires: '多方块真实产物目录（含 *.multiblock.json 产物）',
    regenerate: MB_EXPORT_COMMAND,
    ready: () => resolvedOrNot(() => resolveRealExportsDir()),
  },
  {
    spec: 'texture-uv-orientation.spec.ts',
    failureMode: 'runtime',
    requires: '多方块真实产物目录（含 *.multiblock.json 产物）',
    regenerate: MB_EXPORT_COMMAND,
    ready: () => resolvedOrNot(() => resolveRealExportsDir()),
  },
  {
    // TESR 捕获占位：真实件在**树外**（LIGHTNING_REAL_FIXTURES_DIR/tesr/），缺失属环境条件 ⇒ 排除。
    // 就绪判据直接复用 resolver，与 spec 读件用的是同一条解析路径。
    spec: 'tesr-capture-placeholder.spec.ts',
    failureMode: 'runtime',
    requires:
      'TESR 捕获占位真实导出件（<LIGHTNING_REAL_FIXTURES_DIR>/tesr/tesr-capture-placeholder.ctm.json）',
    regenerate:
      '不提供再生成捷径：由游戏内捕获导出；取值经根 .env 的 LIGHTNING_REAL_FIXTURES_DIR 指定（布局见 .env.example）',
    ready: () => realFixtureAvailable('tesrCaptureCtm'),
  },
  {
    // IC2 裁列棘轮：真实件在**树外**（LIGHTNING_REAL_FIXTURES_DIR/multiblock/），缺失属环境条件 ⇒ 排除。
    // 就绪判据复用 resolver；spec 经同一条解析路径读件（缺件即抛，带 key / 期望相对路径 / 候选）。
    spec: 'ic2-texture-strip-ratchet.spec.ts',
    failureMode: 'runtime',
    requires:
      'IC2 裁列棘轮场景的真实导出件（<LIGHTNING_REAL_FIXTURES_DIR>/multiblock/ic2-nuclear-reactor-pair-postfix.json，runId 20261021-034525-export-scene-10）',
    regenerate:
      '不提供再生成捷径：该件即判据基线（由游戏内 export.scene 导出）；确需换件须同时更新 spec 里的 sha256/读数（"只许收紧"裁决）',
    ready: () => realFixtureAvailable('ic2StripRatchet'),
  },
]

/**
 * **StructureData 真实信封族**（本批外置）。
 *
 * 该件是 `<LIGHTNING_REAL_FIXTURES_DIR>/structuredata/structuredata-exported-envelope.json`，
 * 由三类消费者真实读取（缺件 ⇒ 这些 spec 运行期必红）：
 *  - 直接经 `helpers/saveReopen#fixturePath()`（含 LF 归一化读/复制）读取；
 *  - 经 `helpers/areaLifetime#openWorkbenchWithScene()` 间接读取；
 *  - 经 `helpers/multiblock/frameDoc` 的惰性派生读取；
 *  - 浏览器侧经 `/e2e/fixtures/structuredata-exported-envelope.json` 读取
 *    （`embed-mobile` / `embed-dual` 两个页面，由 vite 仅 serve 中间件供件）。
 *
 * 清单按**实际读取**逐个核对过（不按 import 猜）：只 import barrel 取 `pollUntil` /
 * `injectSceneDocumentOk` 等、并不消费该件的 spec 不在此列，避免误排除。
 * 全部为 `runtime`：本批已把 `frameDoc` 与两个 helper 的读取改为用例体内惰性调用，
 * 缺件不再造成 import-fatal。
 */
const STRUCTUREDATA_FIXTURE_KEY = 'structureDataExportedEnvelope'

const STRUCTUREDATA_REQUIRES =
  'StructureData 真实导出信封（<LIGHTNING_REAL_FIXTURES_DIR>/structuredata/structuredata-exported-envelope.json）'
const STRUCTUREDATA_REGENERATE =
  '不提供再生成捷径：由游戏内 StructureDataExporter scan 导出；取值经根 .env 的 LIGHTNING_REAL_FIXTURES_DIR 指定（布局见 .env.example）'

export const STRUCTUREDATA_GATED_SPECS = [
  'document-binding-takeover.spec.ts',
  'embed-mobile.spec.ts',
  'kernel-area-lifetime-ledger.spec.ts',
  'kernel-area-merge-guard.spec.ts',
  'kernel-area-split-roundtrip.spec.ts',
  'kernel-camera-initial-fit.spec.ts',
  'kernel-click-pick.spec.ts',
  'kernel-corrupt-recovery.spec.ts',
  'kernel-device-diagnostics.spec.ts',
  'kernel-device-generation.spec.ts',
  'kernel-device-loss.spec.ts',
  'kernel-diagnostics-list.spec.ts',
  'kernel-dual-area.spec.ts',
  'kernel-dual-edit.spec.ts',
  'kernel-embed-assembly.spec.ts',
  'kernel-embed-instance-isolation.spec.ts',
  'kernel-embed-lifetime.spec.ts',
  'kernel-load-failure.spec.ts',
  'kernel-move-persist.spec.ts',
  'kernel-recovery-copy.spec.ts',
  'kernel-reject-visible.spec.ts',
  'kernel-resource-diagnostics.spec.ts',
  'kernel-save-baseline.spec.ts',
  'kernel-save-reopen.spec.ts',
  'kernel-texture-pixels.spec.ts',
  'kernel-texture-progress.spec.ts',
  'kernel-tooltip-fidelity.spec.ts',
  'kernel-undo-redo.spec.ts',
  'kernel-viewport-camera.spec.ts',
  'kernel-viewport-host-lifetime.spec.ts',
  'kernel-wiki-preview-lifetime.spec.ts',
  'kernel-wiring.spec.ts',
  'kernel-workbench-tooltip.spec.ts',
  'kernel-workspace-camera-roundtrip.spec.ts',
  'multiblock-falsification.spec.ts',
  'multiblock-frame-regression.spec.ts',
  'wiki-ctrl-s.spec.ts',
  'wiki-save-availability.spec.ts',
] as const

REAL_ARTIFACT_SPECS.push(
  ...STRUCTUREDATA_GATED_SPECS.map((spec) => ({
    spec,
    failureMode: 'runtime' as const,
    requires: STRUCTUREDATA_REQUIRES,
    regenerate: STRUCTUREDATA_REGENERATE,
    ready: () => realFixtureAvailable(STRUCTUREDATA_FIXTURE_KEY),
  })),
)

/** 一条排除记录（机器可读证据的一行）。 */
export interface ExclusionRecord {
  spec: string
  failureMode: 'import-fatal' | 'runtime'
  requires: string
  regenerate: string
}

/** 本次运行应当**排除**的 spec（产物未就绪者）。 */
export function excludedSpecs(): ExclusionRecord[] {
  const out: ExclusionRecord[] = []
  for (const s of REAL_ARTIFACT_SPECS) {
    // 入仓产物（`committed: true`，通用口径；当前无条目使用）：**永不排除** —— 缺它 = 缺陷，交给 spec 自己判红。
    if (s.committed) continue
    if (s.ready()) continue
    out.push({
      spec: s.spec,
      failureMode: s.failureMode,
      requires: s.requires,
      regenerate: s.regenerate,
    })
  }
  return out
}

/** `testIgnore` 用的 glob（相对 `testDir`）。产物齐全时为空数组 = 不排除任何 spec。 */
export function testIgnoreGlobs(): string[] {
  return excludedSpecs().map((e) => `**/${e.spec}`)
}

/**
 * 人读横幅（在 collection 之前打印，避免"悄悄少跑了几份"）。
 *
 * 三种情形都要说清楚：
 *  - 全部就绪 ⇒ 一行"N/N 就绪"（数字**算出来**，不写死）；
 *  - 树外产物缺 ⇒ 逐份列出缺什么、怎么再生（既有口径）；
 *  - **入仓产物缺** ⇒ 明确写"仍会跑、必判红"（棘轮：删产物 = 红，不是被静默排除）。
 */
export function exclusionBanner(records: ExclusionRecord[]): string {
  const total = REAL_ARTIFACT_SPECS.length
  const committed = REAL_ARTIFACT_SPECS.filter((s) => s.committed === true)
  const missingCommitted = committed.filter((s) => !s.ready())
  const committedNote =
    committed.length === 0
      ? []
      : [
          `  入仓棘轮（**永不排除**）：${committed.map((s) => s.spec).join(', ')}`,
          ...(missingCommitted.length === 0
            ? ['    （这类条目永不排除：即使缺失也照跑，由 spec 自己判红，不被门控吞成"本次没跑"。）']
            : [
                `    ⚠ 入仓产物缺失：${missingCommitted.map((s) => s.spec).join(', ')}`,
                '      ⇒ 本次**不排除**它们，spec 会照跑并判红（棘轮口径：删产物 = 红，不是"本次没跑"）。',
              ]),
        ]

  if (records.length === 0) {
    return [
      `[e2e 分层] 真实产物 spec：**${total}/${total} 就绪**，全部纳入本次运行（无排除）。`,
      ...committedNote,
    ].join('\n')
  }
  const lines = [
    '',
    '─'.repeat(78),
    `[e2e 分层] 本次运行**排除 ${records.length} 份真实产物 spec**（树外产物未就绪）：`,
    ...records.map(
      (r) => `  · ${r.spec.padEnd(38)} ${r.failureMode === 'import-fatal' ? '[import 期致命]' : '[运行期失败]'}`,
    ),
    '  缺的产物与再生命令：',
    ...[...new Set(records.map((r) => `${r.requires}  ⇐  ${r.regenerate}`))].map((s) => `    - ${s}`),
    '  说明：这些 spec 的设计契约是"产物缺失必须显式失败，不得静默跳过"，故本设施**不改 spec**，',
    '        只在入口层按**产物门控**排除；产物一旦存在就自动纳入并必须通过。',
    ...committedNote,
    '        记录已落盘：web/test-results/e2e-exclusions.json',
    '─'.repeat(78),
    '',
  ]
  return lines.join('\n')
}

/**
 * 落一份机器可读的排除记录（证据纪律：结论要能落盘并可机械对账）。
 * @returns 落盘路径
 */
export function writeExclusionRecord(webRoot: string, records: ExclusionRecord[]): string {
  const dir = path.join(webRoot, 'test-results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'e2e-exclusions.json')
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        note: 'e2e 分层：真实产物未就绪而被排除的 spec（产物存在即自动纳入，无静默跳过）',
        declared: REAL_ARTIFACT_SPECS.map((s) => s.spec),
        /** 入仓产物（棘轮）：永不排除；缺了也照跑，由 spec 判红。 */
        committed: REAL_ARTIFACT_SPECS.filter((s) => s.committed === true).map((s) => s.spec),
        /** 入仓件里当前**缺**的那几份（正常应为空；非空 ⇒ 本次必然红）。 */
        committedMissing: REAL_ARTIFACT_SPECS.filter((s) => s.committed === true && !s.ready()).map((s) => s.spec),
        excluded: records,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  )
  return file
}
