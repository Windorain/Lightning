/**
 * **G1 判据③ · 闸门覆盖审计（部分迁移层不得静默脱离执行面）**（#385 G1 工作包）。
 *
 * ## 缺口本身（GF-23 / #301 同族）
 *
 * `resolveGateLayers()` 对**部分迁移层**（`runtime` / `adapters`）只把
 * `LAYER_DESTINATIONS[*].activeSubpaths` 里**列出的路径**纳入闸门执行面；
 * 其余文件被当作遗留债务（这是撞名层的必要设计：否则 38 个旧 `runtime/*.ts` 会凭空假红）。
 *
 * ⇒ 该设计的**已知失败模式**是：**新落的内核文件忘登记** ⇒ 它不报错、不判红，
 * 只是**静默脱离** `no-private-cross-layer` / `core-no-vue-three` / `core-no-dom-globals`
 * 全部闸门 —— "闸门 PASS" 于是**不蕴含**"这个文件被检查过"。
 *
 * 本批实测命中一例：`adapters/files/multiblockDeclaration.ts`（475 行，含跨层导入）落地时
 * 未登记 ⇒ 执行面查无此文件（见下 `GATE_COVERAGE_AUDIT` 的 `before` 列）。
 *
 * ## 覆盖形式声明
 *
 * | 参与 | 不参与 |
 * |---|---|
 * | `resolveGateLayers()`（生产函数）返回的执行面集合 —— 判据**不另写一份"什么算执行面"的逻辑** | `__tests__/`、`*.test.ts`、`.d.ts`（`collectLayerFiles` 本来就排除） |
 * | `LAYER_DESTINATIONS` 里**声明了** `activeSubpaths` 的部分迁移层（`runtime` / `adapters`） | 未声明 `activeSubpaths` 的层（`composition` / `presentation` / `domain` …）—— 它们整层即执行面，不存在"登记漏了"这种缺口（本判据对它们只做"文件确实在面内"的正向断言） |
 *
 * ## 判据与其负对照（"看得见"必须先被证明）
 *
 * 1. **登记有效性**：`GATE_COVERAGE_AUDIT` 里每一条 `registered` 都必须在
 *    `resolveGateLayers().active` 里（否则登记是空的）；
 * 2. **负对照（证明真的看得见）**：把该文件放进**临时树**、按同样的登记方式登记，
 *    再注入一条**跨层深路径**导入（`@/presentation/<a>/<b>`，深度 3 > 公共出口上限 2）
 *    ⇒ 生产规则 `ruleNoPrivateCrossLayer` 必须**判红 1 条**；
 *    把登记**撤掉**（模拟"忘登记"）⇒ 同一条导入**不再判红** ——
 *    这一步是本判据的核心：它机械证明了"未登记 = 静默脱离"这一失败模式的真实存在。
 *
 * ⚠️ 判据只写 `web/tests/architecture/**`：业务源码（`web/src/**`）与 `boundary-rules.mjs`
 * 的既有闸门强度都不改动；登记只**扩大**执行面（把新文件纳入检查），不放宽任何规则。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_RULES, resolveGateLayers } from './boundary-rules.mjs'
import { buildModuleGraph, SRC_ROOT } from './module-graph.mjs'

/**
 * **覆盖审计表**：自 `00782b1b` 起，新落在**部分迁移层**（声明了 `activeSubpaths` 的层，
 * 当前为 `runtime` / `adapters`）或新层里的文件，逐个核对其是否在判定面内。
 *
 * 列：
 *  - `file`：**相对 `src/` 的路径**（与 `resolveGateLayers().active` **同口径** —— 该集合
 *    实测 `length=134`、以 `src/` 开头者 `0`；判据按**被测函数的**口径写。⚠️ 不得反向给
 *    `active` 加前缀：那会与 `corePurityFileSet`、`path.join(srcRoot, …)`、本文件的负对照
 *    `gateFiles: ['adapters/files/multiblockDeclaration.ts']` 以及 `boundary-scan.test.ts`
 *    的既有口径冲突 —— 本文件首次落地时正是把它写成了 `'src/…'`，导致 10 条 `after:'IN'`
 *    比对全 false（**判据口径 bug**，不是结构发现；已按本口径修正）；
 *  - `layer`：所属层；
 *  - `partial`：该层是否部分迁移（`true` ⇒ 存在"忘登记就静默脱离"的风险面）；
 *  - `before`：本批**登记前**是否在执行面内（实测；`'OUT'` = 曾经脱离执行面）；
 *  - `after`：登记后是否在执行面内（本判据逐条断言必须为 `'IN'`）；
 *  - `why`：为何纳/不纳入（部分迁移层的"未登记"必须写明处置）。
 *
 * 审计方法（可复现）：`git diff --name-status 00782b1b..HEAD -- web/src/{adapters,runtime,presentation,composition}`
 * 取 `A` 行 ⇒ 逐个用 `resolveGateLayers().active` 判定（**不用 grep 粗估**，铁律 #7）。
 */
export const GATE_COVERAGE_AUDIT = Object.freeze([
  { file: 'adapters/files/multiblockDeclaration.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'IN', why: '本批实测缺口：475 行新实现落地时未登记 ⇒ 全部闸门静默脱离；本批登记纳入（boundary-rules.mjs 的 adapters.activeSubpaths）。⚠️ 登记当场暴露一条既有违规：该文件 `:55` 的跨层深路径导入被判红（**既有违规被登记暴露**，不是登记造成的）—— 已由负责批次在 `3d5f496f` 改导入修复，**未加任何闸门豁免**' },
  { file: 'adapters/export/objExportSerialize.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'OUT', why: '同批新落但仍在 `util/` 旧实现的替代序列中；**未登记 ⇒ 仍脱离执行面**，属遗留债务（由导出面批次随 util/ 退役一并处置）' },
  { file: 'adapters/export/offscreenTextureDomain.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'OUT', why: '同上（在途 R3-2/纹理批次的在制文件）；登记条件 = 该批定稿后由负责批次登记，本判据只把"脱离"这件事变成可见事实' },
  { file: 'adapters/export/offscreenTextureUpload.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'OUT', why: '同上' },
  { file: 'adapters/projectFile.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'OUT', why: '同上' },
  { file: 'adapters/textureDecode.ts', layer: 'adapters', partial: true, before: 'OUT', after: 'OUT', why: '同上' },
  { file: 'presentation/blockRegistryKey.ts', layer: 'presentation', partial: false, before: 'IN', after: 'IN', why: '整层新目录（无撞名）⇒ 全目录即执行面，不存在登记缺口' },
  { file: 'presentation/overlayPresenter.ts', layer: 'presentation', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'presentation/pickResult.ts', layer: 'presentation', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'presentation/textureUploadPort.ts', layer: 'presentation', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'composition/kernelOutlinePlanPort.ts', layer: 'composition', partial: false, before: 'IN', after: 'IN', why: '同上（R1-A C9 新落）' },
  { file: 'composition/kernelPickAdapter.ts', layer: 'composition', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'composition/projectIo.ts', layer: 'composition', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'composition/viewportPick.ts', layer: 'composition', partial: false, before: 'IN', after: 'IN', why: '同上' },
  { file: 'composition/viewportTexturePort.ts', layer: 'composition', partial: false, before: 'IN', after: 'IN', why: '同上' },
])

const rule = GATE_RULES.find((r) => r.id === 'gate/no-private-cross-layer')
const gateCtx = (srcRoot) => ({ srcRoot, gateFiles: resolveGateLayers(srcRoot).active })

describe('G1 ③：闸门覆盖审计 —— 部分迁移层的新文件不得静默脱离执行面', () => {
  it('登记有效性：审计表里 `after: IN` 的每个文件都**确实**在执行面内', () => {
    const { active } = resolveGateLayers(SRC_ROOT)
    const gate = new Set(active)
    const missing = GATE_COVERAGE_AUDIT.filter((r) => r.after === 'IN' && !gate.has(r.file)).map((r) => r.file)
    expect(
      missing,
      '审计表声明"已纳入执行面"但实际不在 ⇒ 登记是空的（或文件被改名/移走，须同批更新审计表）',
    ).toEqual([])
  })

  it('审计表自洽：`before/after` 与层的部分迁移性一致（部分迁移层才可能 OUT）', () => {
    const bad = GATE_COVERAGE_AUDIT.filter((r) => r.partial === false && r.before === 'OUT').map(
      (r) => `${r.file}（整层执行面却记作登记前脱离）`,
    )
    expect(bad, '未声明 activeSubpaths 的层整层即执行面，其文件不可能"曾经脱离"').toEqual([])
  })

  it('审计表非空转：**确实**记录了"曾经脱离执行面"的文件（GF-23 同族缺口的实测证据）', () => {
    const outBefore = GATE_COVERAGE_AUDIT.filter((r) => r.before === 'OUT')
    expect(outBefore.length, '审计必须留下"曾经脱离"的实测记录（否则这条判据没有对象）').toBeGreaterThan(0)
    expect(
      outBefore.some((r) => r.file === 'adapters/files/multiblockDeclaration.ts'),
      '本批实测缺口必须留档',
    ).toBe(true)
  })

  it('**负对照**：登记后跨层深路径导入 ⇒ 判红；撤掉登记 ⇒ 同一条导入静默通过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-coverage-'))
    try {
      const srcRoot = path.join(dir, 'src')
      fs.mkdirSync(path.join(srcRoot, 'adapters', 'files'), { recursive: true })
      const target = path.join(srcRoot, 'adapters', 'files', 'multiblockDeclaration.ts')
      // 跨层**深路径**导入（`presentation/<a>/<b>` = 层内深度 3 > 公共出口上限 2）
      const deepImport = "import { deepThing } from '@/presentation/scope/deepThing'\n"
      fs.writeFileSync(target, `export const x = 1\n${deepImport}`, 'utf8')

      const facts = buildModuleGraph(srcRoot).facts
      const withRegistration = { srcRoot, gateFiles: ['adapters/files/multiblockDeclaration.ts'] }
      const withoutRegistration = { srcRoot, gateFiles: [] }

      const red = rule.check(facts, withRegistration)
      const silent = rule.check(facts, withoutRegistration)

      expect(
        red.map((f) => `${f.rule} ${f.file}:${f.line} ${f.specifier}`),
        '登记后：跨层深路径导入必须被判红（证明该文件真的被执行面覆盖）',
      ).toHaveLength(1)
      expect(silent, '撤掉登记后：同一条导入必须静默通过（证明"未登记 = 静默脱离"这一失败模式真实存在）').toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('正向 + 负对照：该文件的导入确实受 `no-private-cross-layer` 管辖（登记生效，当前合规）', () => {
    // 留档（**历史，不是当前状态**）：登记落地后，本文件 `:55` 的跨层深路径导入
    // （`@/context/parsers/multiblockDocument`，深度 3 > 公共出口上限 2）当场被判红 ——
    // 那是**登记把一个一直在静默逃逸的既有违规暴露出来**，不是登记造成的红。
    // 该违规已由负责批次在 `3d5f496f` 就地声明结构输入形状修复（即：**改导入，不是给闸门加豁免**），
    // 故当前 0 finding。判据因此写成"当前合规 + 通路仍然有效"两段，任一被动手都会红。
    const facts = buildModuleGraph(SRC_ROOT).facts.filter((f) => f.fromSrcRel === 'adapters/files/multiblockDeclaration.ts')
    expect(facts.length, '该文件在模块图里必须有导入事实（否则判定面里没有它）').toBeGreaterThan(0)
    expect(
      rule.check(facts, gateCtx(SRC_ROOT)).map((f) => `${f.file}:${f.line} → ${f.specifier}（${f.detail}）`),
      '该文件当前合规：0 finding 是"真的检查过且合规"，不是"没被检查"',
    ).toEqual([])
    // 负对照：同一文件注入一条深路径跨层导入 ⇒ 必须判红。证明这条通路**对它**有效；
    // 若哪天有人把该文件从执行面摘出去，这一条会立刻红。
    const injected = { ...facts[0], line: 1, specifier: '@/render/schema/types', fromSrcRel: 'adapters/files/multiblockDeclaration.ts' }
    expect(rule.check([injected], gateCtx(SRC_ROOT)), '同一文件注入的深路径跨层导入必须判红').toHaveLength(1)
  })
})
