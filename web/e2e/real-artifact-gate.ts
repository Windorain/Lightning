/**
 * #332 T1 · **真实产物 spec 的显式排除口径**（产物门控，不是手敲路径清单）。
 *
 * ## 为什么需要它
 *
 * 仓库里 4 份 spec 需要**游戏内导出的真实产物**（`mod/gtnh/run/client/...`）。干净检出上没有这些
 * 产物，而其中**两份在 import 期就抛错** —— Playwright 会把 import 错误当成**整次 collection 失败**：
 * 实测 `npm run test:e2e:tree` 在 8.3s 内以 `expected: 0` 结束，**一个用例都没跑**。
 * 也就是说"全量 e2e"在干净检出上目前不是"跑得慢"，而是**根本跑不起来**。
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
 * 判据"产物是否就绪"**直接调用那 4 份 spec 自己要用的严格解析器**
 * （`resolvePartsArchive()` / `resolveRealExportsDir()`，未就绪即抛错）——
 * 于是本文件的"就绪"定义与 spec 的"就绪"定义**永远是同一个**，不会各说各话。
 *
 * ## 与"排除口径"的关系（#332 验收项）
 *
 * 显式排除口径 = 本文件的 `REAL_ARTIFACT_SPECS` 一张表 + 门控结果，二者都进证据。
 */

import fs from 'node:fs'
import path from 'node:path'
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
  /** 就绪判据：**调 spec 自己的严格解析器**（未就绪会抛）。 */
  ready: () => boolean
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
 * 需要真实产物的 spec（#332 验收口径里的"4 个缺真实产物 spec"）。
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
]

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

/** 人读横幅（在 collection 之前打印，避免"悄悄少跑了 4 份"）。 */
export function exclusionBanner(records: ExclusionRecord[]): string {
  if (records.length === 0) {
    return '[#332 e2e 分层] 真实产物 spec：**4/4 就绪**，全部纳入本次运行（无排除）。'
  }
  const lines = [
    '',
    '─'.repeat(78),
    `[#332 e2e 分层] 本次运行**排除 ${records.length} 份真实产物 spec**（产物未就绪）：`,
    ...records.map(
      (r) => `  · ${r.spec.padEnd(38)} ${r.failureMode === 'import-fatal' ? '[import 期致命]' : '[运行期失败]'}`,
    ),
    '  缺的产物与再生命令：',
    ...[...new Set(records.map((r) => `${r.requires}  ⇐  ${r.regenerate}`))].map((s) => `    - ${s}`),
    '  说明：这些 spec 的设计契约是"产物缺失必须显式失败，不得静默跳过"，故本设施**不改 spec**，',
    '        只在入口层按**产物门控**排除；产物一旦存在就自动纳入并必须通过。',
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
        note: '#332 e2e 分层：真实产物未就绪而被排除的 spec（产物存在即自动纳入，无静默跳过）',
        declared: REAL_ARTIFACT_SPECS.map((s) => s.spec),
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
