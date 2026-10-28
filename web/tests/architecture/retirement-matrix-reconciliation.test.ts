/**
 * **退役矩阵十三条 × 判据承载的对账**。
 *
 * ## 为什么需要这张表（实测缺口）
 *
 * 缺口定性：用 `boundary-rules.mjs#RETIREMENT_OWNERS`（13 slug）与
 * `retirementRegistry.test.ts` 的 `matrixSlug` 对账，**registry 只覆盖 6/13**；
 * 其余 7 条里 `grid-coord-as-identity` 有真判据（`geometryOwnership.test.ts`）、
 * `component-mount-lifetime` 只有"不在 seam 表里"一条，**其余 5 条零测试承载**
 * （全树对 slug 的命中**仅 `boundary-rules.mjs` 自身**的矩阵定义处）。
 *
 * ⇒ 「矩阵 slug ↔ 判据」的映射**没有机器可读的对账物**：终切前要"逐条关闭
 * M1 十三条"时，无法机械回答"这一条由谁把守"。本文件就是那份对账物，
 * 并且**把每条锚点变成可执行的断言**（文件存在 + 声明的判据串在该文件里），
 * 于是它不会像散文一样腐烂。
 *
 * ## 三条纪律
 *
 * 1. **分区必须完整且不重叠**：13 条 slug 恰好分成「registry 承载」与
 *    「判据承载（本表）」两半 —— 任何一条既无 registry 又无承载 ⇒ 判红。
 * 2. **承载必须是真判据文件**：锚点不得指向 `boundary-rules.mjs` 自身
 *    （那是"矩阵定义处"，不是把守者 —— 正是该缺口抓到的形态）。
 * 3. **锚点是可核对的字符串**：每条都声明一个在该文件里**确实出现**的判据串；
 *    判据被改名/删除 ⇒ 本表判红（逼同时更新对账，而不是让映射悄悄失效）。
 *
 * ## registry 承载的一半怎么**发现**（不 import 测试文件）
 *
 * ⚠️ 不能 `import` `retirementRegistry.test.ts`：那会把它的全部用例**重复注册**
 * 到本套件（本仓已实测过这类计数膨胀）。故这里**读它的源码**、正则抽出
 * `matrixSlug:` 的取值 —— 静态读取不执行、不注册，口径与"判据本尊"一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RETIREMENT_OWNERS } from './boundary-rules.mjs'
import { WEB_ROOT } from './module-graph.mjs'

/** 读源码并**归一化行尾为 LF**（铁律 6；本文件做源码文本断言）。 */
function readSource(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

/** registry 的相位机文件（相对 `web/`）。 */
const REGISTRY_FILE = 'src/application/__tests__/retirementRegistry.test.ts'

/**
 * registry 承载的 slug（**从源码抽取**，不是手抄 —— 手抄会与 registry 漂移）。
 *
 * `matrixSlug` 是 registry 条目与退役矩阵行之间的唯一键；一个 slug 可能被多条
 * 条目引用（组），故这里取集合。
 */
function registryMatrixSlugs(): Set<string> {
  const src = readSource(path.join(WEB_ROOT, REGISTRY_FILE))
  const out = new Set<string>()
  for (const m of src.matchAll(/matrixSlug:\s*'([a-z0-9-]+)'/g)) out.add(m[1]!)
  return out
}

/**
 * ## 无 registry 承载的 slug → 判据/证据对账表
 *
 * 每条 `carriers` 里是「判据文件（相对 `web/`）+ 该文件里必须出现的判据串」。
 * `note` 说明**为什么这些判据确实管着这条退役项**（可被人复核的语义链）。
 *
 * 表覆盖的 5 条 = 13 − 6（registry）− 2（有独立判据但不在 registry：
 * `grid-coord-as-identity` / `component-mount-lifetime`）—— 后两条由下面
 * `INDEPENDENTLY_GUARDED` 登记，同样进分区（见"分区完整性"用例）。
 */
const RECONCILIATION: ReadonlyArray<{
  readonly slug: string
  readonly entries: readonly number[]
  readonly carriers: ReadonlyArray<{ readonly file: string; readonly needle: string }>
  readonly note: string
}> = [
  {
    slug: 'runtime-document-triple-duty',
    entries: [2],
    carriers: [
      { file: 'tests/architecture/kernel-legacy-isolation.test.ts', needle: '无兼容门面：#1 删除验收' },
      { file: 'src/composition/__tests__/saveProjection.test.ts', needle: '两侧产物各自喂回**生产解析器**' },
    ],
    note:
      '「旧 `RuntimeDocument` 一物三职（内容/保存/呈现）」的退役证据在两个面上：' +
      '① `kernel-legacy-isolation` 的「无兼容门面」闸门（内核文件不得 `export … from` 造转出口门面 ⇒ 旧文档模型不可能被包一层继续服役）；' +
      '② `saveProjection` 的保存读面等价判据（保存/发布产物由内核投影产出，且两侧产物都喂回**生产解析器** ⇒ 内容面已与旧文档解耦）。',
  },
  {
    slug: 'ui-proxy-dispatch',
    entries: [3],
    carriers: [
      { file: 'src/application/__tests__/rna-contract.test.ts', needle: '不含 setter 闭包' },
      { file: 'src/application/__tests__/kernel-write-chain.test.ts', needle: '面板意图 → `submit` → `reduceCommand` → RNA handler' },
    ],
    note:
      '「UI Proxy 分派」要退役的是"描述自带 setter 闭包/代理写入"：' +
      '① `rna-contract` 的 A08-1 判据断言引用与描述里**不含任何函数值**（setter 闭包会在此现形）；' +
      '② `kernel-write-chain` 断言面板意图只能经 `submit` → `reduceCommand` → RNA handler 这一条写链路 ⇒ 旁路代理不可达。',
  },
  {
    slug: 'workbench-embed-fork',
    entries: [7],
    carriers: [
      { file: 'src/composition/__tests__/assembly.test.ts', needle: 'SHARED_FUNCTIONAL_MODULES' },
      { file: 'src/composition/__tests__/seams.test.ts', needle: '已核销项 · 回归断言（防被改回去）' },
    ],
    note:
      '「工作台/嵌入分叉」的替代机制是"公共功能模块 + profile + 外壳"：' +
      '① `assembly` 的判据要求四个 profile 的对象类型集合由**同一批共享模块**（按引用）提供 ⇒ 分叉不可表达；' +
      '② `seams` 的已核销项回归断言防"分叉被改回去"。',
  },
  {
    slug: 'scattered-text-and-global-lang',
    entries: [12],
    carriers: [
      { file: 'tests/architecture/content-boundary-gate.test.ts', needle: 'A32 内容边界闸门：本树实况' },
      { file: 'src/domain/__tests__/instanceSettings.test.ts', needle: '语言/主题/偏好按实例隔离' },
    ],
    note:
      '「文本散落 + 全局语言」两个半边的把守者：' +
      '① `content-boundary-gate`（A32）机械禁止未受控的 `v-html`/`innerHTML` 直通 ⇒ 文本只能经受控呈现边界；' +
      '② `instanceSettings`（A33）断言语言/主题/偏好按**实例**隔离（模块级 `activeLang` 的负对照）⇒ 全局语言状态不可达。',
  },
  {
    slug: 'exporter-borrows-live-viewport',
    entries: [13],
    carriers: [
      { file: 'tests/architecture/export-purity.test.ts', needle: '导出层**不得** import 实时视口/相机实现' },
      { file: 'src/application/__tests__/snapshotExport.test.ts', needle: 'A29：取景是**值**，不借用实时相机' },
    ],
    note:
      '「导出借用实时视口」的静态面与行为面：' +
      '① `export-purity` 的静态判据禁止导出层 import 实时视口/相机实现（含负对照：注入一条导入会被抓到）；' +
      '② `snapshotExport` 断言取景是**值**（`captureSpec`）而不是"当前/实时相机"⇒ 借用不可表达。',
  },
]

/**
 * **有独立判据、但不在 registry 相位机内**的两条（已实测其承载，
 * 这里把它显式登记进分区，使"13 条谁把守"成为一个完整闭集）。
 */
const INDEPENDENTLY_GUARDED: ReadonlyArray<{
  readonly slug: string
  readonly carriers: ReadonlyArray<{ readonly file: string; readonly needle: string }>
  readonly observed: string
}> = [
  {
    slug: 'grid-coord-as-identity',
    carriers: [{ file: 'src/domain/__tests__/geometryOwnership.test.ts', needle: '来源映射' }],
    observed: '实测：`geometryOwnership.test.ts` 的 describe 是真判据（对象身份必须经来源映射）',
  },
  {
    slug: 'component-mount-lifetime',
    carriers: [{ file: 'src/composition/__tests__/seams.test.ts', needle: '已核销项' }],
    observed: '实测：`seams.test.ts` 只断言"不在 seam 表里"（判据较薄，如实登记）',
  },
]

/** 本文件的锚点核对器（**不**允许指向矩阵定义文件自身）。 */
function assertCarrier(slug: string, carrier: { file: string; needle: string }): void {
  expect(carrier.file, `${slug}：锚点不得指向矩阵定义文件自身（那是定义处，不是把守者）`).not.toBe(
    'tests/architecture/boundary-rules.mjs',
  )
  const abs = path.join(WEB_ROOT, carrier.file)
  expect(fs.existsSync(abs), `${slug}：判据文件必须存在（${carrier.file}）`).toBe(true)
  const src = readSource(abs)
  expect(
    src,
    `${slug}：声明的判据串必须仍在 ${carrier.file} 里出现（判据被改名/删除 ⇒ 请同时更新本对账表）：` + JSON.stringify(carrier.needle),
  ).toContain(carrier.needle)
}

describe('退役矩阵十三条 × 判据承载对账', () => {
  const ALL_SLUGS = Object.keys(RETIREMENT_OWNERS)

  it('矩阵本身仍是 13 条（对账表的分母不得漂移）', () => {
    expect(ALL_SLUGS, '`RETIREMENT_OWNERS` 必须仍是 13 条退役矩阵条目').toHaveLength(13)
  })

  it('**分区完整**：13 条 slug 恰好分成 registry 承载 / 无承载（对账表 + 独立判据）两半', () => {
    const registry = registryMatrixSlugs()
    expect(registry.size, 'registry 的 `matrixSlug` 抽取必须非空（否则本对账是空转）').toBeGreaterThan(0)
    const reconciled = new Set(RECONCILIATION.map((r) => r.slug))
    const independent = new Set(INDEPENDENTLY_GUARDED.map((r) => r.slug))
    // ① 三个集合互不重叠（重叠会让"谁把守"含糊）
    for (const slug of reconciled) expect(registry.has(slug), `${slug} 同时在 registry 与对账表里（分区重叠）`).toBe(false)
    for (const slug of independent) expect(registry.has(slug), `${slug} 同时在 registry 与独立判据表里`).toBe(false)
    for (const slug of reconciled) expect(independent.has(slug), `${slug} 同时在对账表与独立判据表里`).toBe(false)
    // ② 三者之并 = 全 13 条（任何漏网的 slug 都会在这里现形）
    const union = new Set([...registry, ...reconciled, ...independent])
    const missing = ALL_SLUGS.filter((s) => !union.has(s))
    expect(
      missing,
      `以下退役矩阵条目**既不在 registry 也不在对账表**里 ⇒ 无人把守、无对账物：${missing.join(', ')}。`
        + '处置：①补判据（并登记本表）；②登记"由哪条既有断言覆盖"。',
    ).toEqual([])
    const extra = [...union].filter((s) => !ALL_SLUGS.includes(s))
    expect(extra, `对账表出现矩阵里没有的 slug（登记腐烂）：${extra.join(', ')}`).toEqual([])
    // ③ 分区规模如实披露（与基线 6/13 对账；数字变化必须是有意的）
    expect(registry.size, 'registry 承载数（基线读数：6）').toBe(6)
    expect(reconciled.size, '无 registry 承载、本表补对账的条数（基线读数：5）').toBe(5)
    expect(independent.size, '有独立判据但不在 registry 的条数（基线读数：2）').toBe(2)
  })

  it('对账表每条的 `entries` 与矩阵的覆盖行号**逐字一致**（防对错行）', () => {
    for (const r of RECONCILIATION) {
      expect(RETIREMENT_OWNERS[r.slug], `${r.slug} 必须在矩阵里`).toBeTruthy()
      expect(r.entries, `${r.slug} 的矩阵行号必须与矩阵一致`).toEqual([...RETIREMENT_OWNERS[r.slug]!.entries])
    }
  })

  it('每条无承载 slug 的锚点都**真实存在且仍含声明的判据串**（承载不得是散文）', () => {
    for (const r of [...RECONCILIATION, ...INDEPENDENTLY_GUARDED]) {
      expect(r.carriers.length, `${r.slug} 至少要有一条承载`).toBeGreaterThan(0)
      for (const c of r.carriers) assertCarrier(r.slug, c)
    }
  })

  it('每条对账都写清了"为什么这些判据管着这条退役项"（≥60 字，且点名每个承载文件）', () => {
    for (const r of RECONCILIATION) {
      expect(r.note.length, `${r.slug} 的说明必须写清语义链`).toBeGreaterThan(60)
      for (const c of r.carriers) {
        const base = path.basename(c.file).replace(/\.test\.ts$/, '')
        expect(r.note, `${r.slug} 的说明必须点名承载文件 ${base}（否则无法复核）`).toContain(base)
      }
    }
    for (const r of INDEPENDENTLY_GUARDED) {
      expect(r.observed.length, `${r.slug} 必须写明"实测观察到什么"`).toBeGreaterThan(20)
    }
  })

  it('**负对照**：锚点核对器能抓到"判据串已不存在"（不是恒绿）', () => {
    // 用一个**确定不存在**的判据串走同一条核对逻辑 ⇒ 必须判红
    expect(() =>
      assertCarrier('negative-control', { file: 'tests/architecture/export-purity.test.ts', needle: '__definitely_absent_needle__' }),
    ).toThrow()
    // 且缺文件同样判红（不是"文件不存在就跳过"）
    expect(() =>
      assertCarrier('negative-control', { file: 'tests/architecture/__absent__.test.ts', needle: 'x' }),
    ).toThrow()
    // 正对照：真实锚点判绿（防恒红）
    expect(() =>
      assertCarrier('negative-control', {
        file: 'tests/architecture/export-purity.test.ts',
        needle: '导出层**不得** import 实时视口/相机实现',
      }),
    ).not.toThrow()
  })
})
