/**
 * **G1 判据① · `composition/` 生产文件绑定旧层的边**（#385 G1 工作包；形态抄
 * `kernel-legacy-isolation.test.ts#APPROVED_LEGACY_TO_KERNEL_EDGES`）。
 *
 * ## 为什么需要它（已实测的**无判据**缺口）
 *
 * `kernel-legacy-isolation.test.ts` 的判定面只有 `KERNEL_FILES`（domain / application /
 * 新 runtime / adapters 的登记文件）。`composition/`（装配根）与 `presentation/`（呈现侧）
 * **不在判定面内** —— 于是「装配根在生产路径上把真实文件装配成内核文档、再把内核投影回
 * 旧形状」这条**设计必需**的编解码面，在闸门上完全不可见：它既不被"内核不得依赖旧层"覆盖
 * （它不在 `KERNEL_FILES`），也不被"旧层 → 内核"覆盖（它不在 `OLD_LAYERS`）。
 *
 * ## 判定面（覆盖形式声明）
 *
 * | 参与 | 不参与 |
 * |---|---|
 * | `src/composition/**` 下**生产**文件（`__tests__/` 与 `*.test.ts` 除外） | `composition/__tests__/**`、`*.test.ts`（它们是夹具与断言，允许绑旧层） |
 * | **全部**内部导入事实：`import` / `export ... from` / `import('x')` / `import('x').T` / 动态 `import()` / `require` | 外部包（`vue`/`three`/`zod`…）与非相对说明符 |
 * | 目标落在**旧分层**（`OLD_LAYERS`，与内核隔离闸门同表）的边 | 目标落在 `KERNEL_FILES`（新层）或 `composition/` 自身的边 |
 *
 * **口径 = AST 全量**（`module-graph.mjs#buildModuleGraph` → TypeScript 编译器 API）。
 * 本文件**不做任何文本扫描**：没有正则、没有 `indexOf`、不读源码文本做匹配
 * —— 因此注释与字符串字面量**天然不可能**误报（`seams.ts` 把符号写在字符串里的坑在此不适用）。
 * 唯一的文本读取是"从 `kernel-legacy-isolation.test.ts` 里取出 `KERNEL_FILES` 字面量"，
 * 那也走 TS 的 AST（见 `readKernelFiles`），不是正则。
 *
 * ## 三条判据形态（与 #387 评论 7293 的归档纪律一致）
 *
 * 1. **未登记即红**：扫描出的每一条边都必须逐条在 `APPROVED_COMPOSITION_LEGACY_EDGES` 里；
 * 2. **登记不得腐烂**：每条登记都必须**真实存在**（文件 + 行 + 说明符 + 目标全对）；
 * 3. **登记数不得增**：`files` / `lines` 与 `COMPOSITION_LEGACY_EDGE_BASELINE` 逐数对齐
 *    —— 多一条即红（新增绑定必须先改基线并给出理由），少一条**也**红（须同批核销）。
 *
 * ⚠️ **登记是"可见性与可判定性"，不是允许增长**（#387 评论 7293）。
 * 本判据**严禁直接判零**：装配根把真实文件装配成内核文档、把内核投影回旧形状，
 * 是设计必需的编解码面，判零会立刻假红（实测 28 行）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SRC_ROOT, extractImports } from './module-graph.mjs'

/** 判定面：`src/` 相对前缀。 */
export const COMPOSITION_SCOPE = 'composition/'

/**
 * 旧分层表 —— 与 `kernel-legacy-isolation.test.ts#OLD_LAYERS` **同表同义**（撞名层 `runtime` 在列）。
 * 两处都要列同一批目录是**故意**的：判据各自独立可读，改一处必须同批改另一处。
 */
const OLD_LAYERS = [
  'pure',
  'context',
  'operators',
  'handlers',
  'events',
  'render',
  'shared',
  'workbench',
  'viewer',
  'embed',
  'wiki',
  'util',
  'config',
  'dev',
  'logging',
  'runtime',
]

/** 从内核隔离闸门的源码里用 **AST** 取出 `KERNEL_FILES` 字面量（单一事实来源，不复制清单）。 */
export function readKernelFiles() {
  const gatePath = path.join(import.meta.dirname, 'kernel-legacy-isolation.test.ts')
  const text = fs.readFileSync(gatePath, 'utf8').replace(/\r\n/g, '\n')
  const sf = ts.createSourceFile(gatePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  let found = null
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'KERNEL_FILES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = node.initializer.elements
        .filter((e) => ts.isStringLiteral(e))
        .map((e) => e.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (found === null) throw new Error('未能从 kernel-legacy-isolation.test.ts 取出 KERNEL_FILES（判据链断裂）')
  return found
}

/** 生产文件判定（与 `module-graph.mjs#isProductionFile` 同口径）。 */
export function isProductionRel(rel) {
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

/** 目标模块路径（`src/` 相对、无扩展名）是否属于旧分层（内核文件表内的不算旧）。 */
export function isOldLayerTarget(rel, kernelFiles) {
  if (kernelFiles.includes(`${rel}.ts`) || kernelFiles.includes(`${rel}.vue`) || kernelFiles.includes(rel)) return false
  return OLD_LAYERS.some((layer) => rel === layer || rel.startsWith(`${layer}/`))
}

/** 解析一条导入事实的目标（`src/` 相对、无扩展名）；不可静态判定 ⇒ `null`。 */
export function resolveTargetOf(fact, srcRoot) {
  const spec = fact.specifier
  if (spec.startsWith('«')) return null
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) return null
  const abs = spec.startsWith('@/') ? path.join(srcRoot, spec.slice(2)) : path.resolve(path.dirname(fact.fromFile), spec)
  const rel = path.relative(srcRoot, abs).replace(/[\\/]+/g, '/')
  if (rel.startsWith('..')) return null
  return rel.replace(/\.(ts|tsx|mts|vue|js)$/, '')
}

/**
 * **判定核**：给定导入事实集与登记表，返回未登记的边（判红用）。
 * 生产判据与两条负对照**共用本函数** —— 负对照不得另写一份判定逻辑。
 */
export function unregisteredCompositionLegacyEdges(facts, registry, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {}) {
  const registered = new Set(registry.map((e) => `${e.from}:${e.line}:${e.to}`))
  const out = []
  for (const f of facts) {
    const fromRel = path.relative(srcRoot, f.fromFile).replace(/[\\/]+/g, '/')
    if (!fromRel.startsWith(COMPOSITION_SCOPE)) continue
    if (!isProductionRel(fromRel)) continue
    const target = resolveTargetOf(f, srcRoot)
    if (target === null || !isOldLayerTarget(target, kernelFiles)) continue
    if (registered.has(`src/${fromRel}:${f.line}:${target}`)) continue
    out.push(`src/${fromRel}:${f.line}  → ${f.specifier}（未登记）`)
  }
  return out
}

/** **校准自检用**：按判定核自己的口径数出（文件数 / 行数）。 */
export function countCompositionLegacyEdges(facts, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {}) {
  const lines = []
  for (const f of facts) {
    const fromRel = path.relative(srcRoot, f.fromFile).replace(/[\\/]+/g, '/')
    if (!fromRel.startsWith(COMPOSITION_SCOPE)) continue
    if (!isProductionRel(fromRel)) continue
    const target = resolveTargetOf(f, srcRoot)
    if (target === null || !isOldLayerTarget(target, kernelFiles)) continue
    lines.push({ file: `src/${fromRel}`, line: f.line, target })
  }
  return { files: new Set(lines.map((l) => l.file)).size, lines: lines.length, rows: lines }
}

// ─────────────────────────────────────────────────────────────────────────────
// 登记表（基线：8 文件 / 13 行的**修订实测值**，见下方 BASELINE 注释的差异说明）
// ─────────────────────────────────────────────────────────────────────────────

const E = (from, line, to, kind, reason, exitStage, owner) =>
  Object.freeze({ from, line, to, kind, reason, exitStage, owner })

/**
 * `composition/` 生产文件 → 旧层的**已登记**边。
 *
 * ## 每一行为什么"必须存在"
 *
 * 装配根（`composition/`）的职责就是**把各层的实现装到一起**（契约 §7 明文：
 * 装配根引用实现是设计使然）。本批的编解码面更是**不可能不绑旧层**：
 *  - **入向**：把真实文件（旧 `RuntimeDocument` / `Envelope` / `Parser`）装配成内核 `Document`；
 *  - **出向**：把内核的 `Document`/`scene` 投影回旧形状（旧 `Grid`/`SlotBlock`/`vec`）供
 *    渲染链与保存链消费。
 * 判零会立刻假红 ⇒ 形态只能是"逐条登记 + 计数冻结"。
 *
 * ## 与任务书给定数字的**差异**（实测口径，铁律 #7）
 *
 * 任务书写"8 个生产文件 / 13 行"，且其逐条列举自加为 7 文件 / 17 行 —— 两组数字互不相符。
 * 本判据以**判据本尊的扫描口径**在本树（HEAD `9630a39d`）实测：
 * **11 文件 / 28 行**（含 `runtime/*` 撞名层目标；这些目标不在 `KERNEL_FILES`，
 * 按闸门自身口径**就是**旧层）。若只看 `@/context/*` + `@/pure/*` 目标则为 7 文件 / 21 行。
 * 两个读数都在报告里给出；本表的 `lines` 采用 28（全口径）。
 */
export const APPROVED_COMPOSITION_LEGACY_EDGES = [
  // ── 入向：把真实文件装配成内核文档（旧 RuntimeDocument / Grid / multimblock 的公共出口）──
  E('src/composition/kernelAssembly.ts', 76, 'context/runtimeDocument', 'import',
    '入向装配：旧 `RuntimeDocument`/`RuntimeFrame` 的**类型**是装配的输入形状（真实文件先被旧解析器读成它，再被本模块装配成内核 `Document`）。这是"把真实文件装配成内核文档"这条设计必需编解码面的类型端',
    'R1 收口：旧解析器/旧文档载体退出生产后，本模块的输入形状改为适配器出口 ⇒ 本行随 `@/context/runtimeDocument` 的引用一起核销', 'G1'),
  E('src/composition/kernelAssembly.ts', 77, 'context/grid', 'import',
    '入向装配：旧 `Grid`/`SlotBlock` 是**文件分区块**在旧解析器里的类型化承载，装配必须读它才能取出逐格方块身份与调色板槽位',
    'R1 收口：分区块状态槽由适配器（`adapters/files/**`）直接承载后核销', 'G1'),
  E('src/composition/kernelAssembly.ts', 82, 'context/multiblock', 'import',
    '入向装配：多方块**声明**（`assembleSelection` 的公共出口）来自旧 `context/multiblock` —— 它把文件里的多方块声明求值成装配输入',
    'R1 收口：多方块声明求值迁入 `domain/multiblock` 的适配器侧出口后核销', 'G1'),
  E('src/composition/kernelAssembly.ts', 87, 'context/runtimeDocument', 'import',
    '入向装配：多方块声明类型（`MultiblockChannelDecl` 等）经旧 `context/runtimeDocument` 的**公共出口**取得（不钻 `context/parsers/multiblockDocument`，避免超公共出口深度上限 2）',
    'R1 收口：随 `@/context/runtimeDocument` 退场而核销（同 :76 那条）', 'G1'),
  E('src/composition/documentLoad.ts', 36, 'context/runtimeDocument', 'import',
    '入向装配（DocumentSource 脊柱）：加载结果里的 `RuntimeDocument` 类型是两条加载脊柱的公共输入；`plainRootOf(loadResult.raw)` 的形态由它给出',
    'R1 收口：加载器出口改为适配器形状后核销', 'G1'),
  E('src/composition/projectIo.ts', 42, 'context/runtimeDocument', 'import',
    '入向装配（工程 IO 脊柱）：同上，工程文件读回后先落到旧文档类型再装配',
    'R1 收口：随加载脊柱统一到适配器出口而核销', 'G1'),

  // ── 出向：把内核投影回旧形状（渲染链与保存链此刻仍读旧形状）──
  E('src/composition/kernelProjection.ts', 56, 'context/grid', 'import',
    '出向投影：内核载荷 → 旧 `Grid` 的**值导入**（不只是类型）—— 投影产物必须是旧渲染链能直接吃的对象',
    'R1 收口：渲染链终切内核、旧 `Grid` 退出生产后核销（与 `legacy-render-source-document` 同批）', 'G1'),
  E('src/composition/kernelProjection.ts', 57, 'context/grid', 'import',
    '出向投影：旧 `SlotBlock`（格子的文件槽位形态），投影时逐格写回',
    'R1 收口：同 :56 那条；`SlotBlock` 与 `Grid` 同批退出', 'G1'),
  E('src/composition/kernelProjection.ts', 58, 'context/runtimeDocument', 'import',
    '出向投影：投影目标就是旧 `RuntimeDocument`（`RuntimeFrame` 亦是），故需其类型',
    'R1 收口：旧权威 `RuntimeDocument` 终删时随投影面一起核销', 'G1'),
  E('src/composition/kernelProjection.ts', 59, 'context/runtimeDocument', 'import',
    '出向投影：同上（值位置，用于构造旧形状对象）',
    'R1 收口：同 :58', 'G1'),
  E('src/composition/kernelProjection.ts', 60, 'pure/vec', 'import',
    '出向投影：旧形状里坐标是 `vec`（`{x,y,z}` 的旧工具族），投影必须产出同形状',
    'R1 收口：旧形状退出后被 `domain` 的坐标表示取代 ⇒ 核销', 'G1'),
  E('src/composition/kernelProjection.ts', 61, 'context/runtimeDocument', 'import',
    '出向投影：逐格内容/调色板写回旧文档根级字段时需要的类型与常量',
    'R1 收口：同 :58', 'G1'),
  E('src/composition/kernelProjection.ts', 62, 'pure/partTypes', 'import',
    '出向投影：多方块**部件**的旧类型族（部件的文件形状），投影时按它还原',
    'R1 收口：部件面迁入 `domain/cellContent` 的适配器出口后核销', 'G1'),
  E('src/composition/kernelProjection.ts', 78, 'runtime/gridRead', 'import',
    '出向投影：读面（旧 `runtime/` 撞名层的新写实现）与投影面必须共用**同一条**取值规则（"取哪一份载荷"），否则两侧会漂移成两套实现',
    'R1 收口：`runtime/gridRead` 随工作台消费面迁出旧层时核销（与 `APPROVED_LEGACY_TO_KERNEL_EDGES` 的 `gridRead` 两条同批）', 'G1'),
  E('src/composition/kernelProjection.ts', 562, 'pure/gridTypes', 'import',
    '出向投影（类型位置 `import(\'x\').T`）：该行附近的签名用旧 `gridTypes` 的判别式类型表达"投影输入是内核载荷"',
    'R1 收口：旧 `gridTypes` 退出生产后核销', 'G1'),
  E('src/composition/kernelProjection.ts', 569, 'pure/gridTypes', 'import',
    '出向投影（类型位置 `import(\'x\').T`）：同一模块内第二处签名也以内核载荷类型为准，复用旧 `gridTypes` 的判别式类型描述"投影输入来自内核"',
    'R1 收口：与 :562 同批核销（旧 `gridTypes` 退出生产）', 'G1'),
  E('src/composition/kernelRenderView.ts', 30, 'context/runtimeDocument', 'import',
    '出向投影（渲染视图）：内核视图要能被旧渲染链消费，故按旧 `RuntimeFrame` 形状投影',
    'R1 收口：渲染链终切内核后核销', 'G1'),
  E('src/composition/kernelRenderView.ts', 31, 'context/runtimeDocument', 'import',
    '出向投影（渲染视图）：值位置构造（同上）',
    'R1 收口：同 :30', 'G1'),
  E('src/composition/kernelPaletteAssembly.ts', 50, 'context/grid', 'import',
    '出向装配：调色板装配按旧 `Grid` 的槽位语义（`paletteIndex`）对齐条目，使投影产物与旧消费点键口径一致',
    'R1 收口：旧 `Grid` 槽位语义由内核 `palette` 承载后核销', 'G1'),
  E('src/composition/projectIo.ts', 53, 'runtime/annotationRead', 'import',
    '出向投影（工程写出）：注解读面（旧 `runtime/` 撞名层的新写实现）把内核注解投影成旧形状后才能落盘',
    'R1 收口：保存路径无 legacy 回落分支后，随 `annotationRead` 退出核销', 'G1'),
  E('src/composition/saveProjection.ts', 47, 'runtime/annotationRead', 'import',
    '出向投影（保存投影）：同 `projectIo:53`，保存链路读旧形状注解',
    'R1 收口：同 `projectIo:53`', 'G1'),
  E('src/composition/useKernelFrameLoop.ts', 44, 'runtime/context', 'import',
    '接线：帧循环要驱动旧运行实例（`Context`），此刻宿主仍是旧外壳',
    'R1 收口：旧外壳退场、帧循环改吃新宿主后核销', 'G1'),
  E('src/composition/kernelPresentationInputs.ts', 61, 'runtime/presentationAdapter', 'import',
    '接线：呈现输入装配（旧 `runtime/` 撞名层的适配器）—— 装配根引用各层实现是设计使然（契约 §7）',
    'R1 收口：呈现输入改由 `presentation/` 出口承载后核销', 'G1'),
  E('src/composition/kernelPickAdapter.ts', 37, 'pure/vec', 'import',
    '接线：拾取适配器的坐标换算复用旧 `vec` 工具族（射线/包围盒计算）',
    'R1 收口：坐标与射线工具迁入 `domain`/`presentation` 出口后核销', 'G1'),
  E('src/composition/kernelPickAdapter.ts', 38, 'runtime/gridRead', 'import',
    '接线：拾取要经读面取网格（`gridRead` 是 15 处旧消费点的统一替代面），与本模块的命中计算同批接通',
    'R1 收口：拾取链完全落内核读面后核销（与 `viewportPick` 同批）', 'G1'),
  E('src/composition/viewportPick.ts', 28, 'runtime/gridRead', 'import',
    '接线：视口拾取的网格取值经读面（与 `kernelPickAdapter` 共用同一条取值规则）',
    'R1 收口：同 `kernelPickAdapter:38`', 'G1'),
  E('src/composition/viewportPick.ts', 30, 'runtime/annotationRead', 'import',
    '接线：视口拾取要能命中注解，注解形状由读面投影给出',
    'R1 收口：注解消费面迁出旧层后核销', 'G1'),
  E('src/composition/viewportPick.ts', 31, 'runtime/annotationRead', 'import',
    '接线：同上（值位置：拾取时构造读取形状）',
    'R1 收口：同 :30', 'G1'),
]

/** 逐条登记必须写全的字段（防"登记了但没有理由/没有退出归属/没有负责人"）。 */
const REQUIRED_FIELDS = ['from', 'line', 'to', 'kind', 'reason', 'exitStage', 'owner']

const BASELINE_FILES = 11
const BASELINE_LINES = 28

describe('G1 ①：`composition/` 生产文件绑定旧层的边 —— 逐条登记，未登记即红，登记数不得增', () => {
  /** 判据执行面：AST 扫全部生产模块图（与生产扫描器同源）。 */
  function loadFacts() {
    // 动态导入以避免测试文件在模块求值时就把整棵扫描跑两遍（负对照复用同一入口）。
    return import('./module-graph.mjs').then((m) => m.buildModuleGraph().facts)
  }

  it('未登记即红：`composition/` 生产文件指向旧层的每一条边都必须逐条登记', async () => {
    const facts = await loadFacts()
    const violations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES)
    expect(
      violations,
      `composition/ 生产文件绑定了旧层但未登记（须逐条登记"文件:行 + 目标层 + 理由 + 退出归属"）:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('登记不得腐烂：每条登记都真实存在（文件 + 行 + 目标全对）', async () => {
    const facts = await loadFacts()
    const kernelFiles = readKernelFiles()
    const present = new Set()
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      const target = resolveTargetOf(f, SRC_ROOT)
      if (target === null) continue
      if (!isOldLayerTarget(target, kernelFiles)) continue
      present.add(`src/${fromRel}:${f.line}:${target}`)
    }
    const rotted = []
    for (const e of APPROVED_COMPOSITION_LEGACY_EDGES) {
      if (!present.has(`${e.from}:${e.line}:${e.to}`)) rotted.push(`${e.from}:${e.line} → ${e.to}`)
    }
    expect(
      rotted,
      `登记的边已不存在或行号漂移（请同批核销/更正 —— 建筑在腐烂登记上的闸门等于没有闸门）:\n${rotted.join('\n')}`,
    ).toEqual([])
  })

  it('登记数不得增（也不得静默减）：文件数与行数与基线逐数对齐', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    expect(
      { files: counted.files, lines: counted.lines },
      `绑定旧层的边数偏离基线 {files:${BASELINE_FILES}, lines:${BASELINE_LINES}}。`
        + '新增绑定必须先改基线与登记表并写明理由（"可见性与可判定性"不等于"允许增长"，#387 评论 7293）；'
        + `减少则须同批核销登记。实测:${JSON.stringify({ files: counted.files, lines: counted.lines })}`,
    ).toEqual({ files: BASELINE_FILES, lines: BASELINE_LINES })
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length, '登记表长度必须等于实测行数').toBe(BASELINE_LINES)
  })

  it('**校准自检**：登记表自身读数与判据实测读数逐条一致（表里每一行都对应一条真实边）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const observed = new Set(counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`))
    const registered = new Set(APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`))
    const onlyRegistered = [...registered].filter((k) => !observed.has(k)).sort()
    const onlyObserved = [...observed].filter((k) => !registered.has(k)).sort()
    expect({ onlyRegistered, onlyObserved }, '登记表与实测边的对称差必须为空').toEqual({ onlyRegistered: [], onlyObserved: [] })
    // 基线数与判据自身读数一致（作者手写的 11/28 必须等于判定核数出来的 11/28）
    expect({ files: BASELINE_FILES, lines: BASELINE_LINES }).toEqual({ files: counted.files, lines: counted.lines })
  })

  it('覆盖形式被测：判定面确实覆盖了 `composition/` 的全部生产文件，且无解析失败', async () => {
    const { buildModuleGraph } = await import('./module-graph.mjs')
    const { files, facts } = buildModuleGraph()
    // ⚠️ 判"是否进判定面"必须用扫描器返回的 `files`（被解析的文件清单），
    // **不能**用 `facts` 的来源集合：一个文件可以合法地**没有任何导入**
    // （`composition/seams.ts` 正是如此 —— 它只在字符串里写符号名），
    // 用 facts 反推会把"零导入的文件"误判成"没被扫"（本测试首跑实测的假红）。
    const scanned = new Set(files.map((f) => path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')))
    const srcFiles = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue
          walk(full)
        } else if (/\.(ts|tsx|mts|vue)$/.test(e.name)) {
          srcFiles.push(path.relative(SRC_ROOT, full).replace(/[\\/]+/g, '/'))
        }
      }
    }
    walk(path.join(SRC_ROOT, COMPOSITION_SCOPE))
    const uncovered = srcFiles.filter((rel) => isProductionRel(rel) && !scanned.has(rel)).sort()
    expect(uncovered, 'composition/ 的生产文件必须全部进判定面（否则"未登记即红"有洞）').toEqual([])
    expect(srcFiles.length, '判定面非空转').toBeGreaterThan(10)
    expect(
      facts.filter((f) => f.kind === 'parse-error').map((f) => f.fromRel),
      '解析失败会让判据静默漏边',
    ).toEqual([])
  })

  it('登记字段完备性：每条登记都写明 文件/行/目标/类别/理由/退出归属/负责人', () => {
    const incomplete = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => {
      if (REQUIRED_FIELDS.some((k) => e[k] === undefined || e[k] === null || e[k] === '')) return true
      if (String(e.reason).length < 20) return true
      if (String(e.exitStage).length < 5) return true
      return false
    }).map((e) => `${e.from}:${e.line}`)
    expect(incomplete, `登记项必须写全 ${REQUIRED_FIELDS.join('/')}（理由 ≥20 字）`).toEqual([])
  })

  it('反空洞真：判定面里**确实**有边被扫到（否则"未登记即红"是空转）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    expect(counted.lines, '判定核必须真实命中边 —— 否则上一条的 0 违规只是"没扫到"').toBeGreaterThan(0)
    expect(counted.files).toBeGreaterThan(1)
  })

  it('**负对照 A**：往 `composition/` 注入一条未登记的新边 ⇒ 判红', () => {
    // 走**生产**扫描器（`extractImports`）+ **生产**判定核（`unregisteredCompositionLegacyEdges`），
    // 不是手造 fact 对象（手造会绕过 AST 通路 = "宿主复刻被测算法"）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-comp-neg-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const comp = path.join(srcRoot, 'composition')
      fs.mkdirSync(comp, { recursive: true })
      const probe = path.join(comp, 'probeAssembly.ts')
      fs.writeFileSync(probe, "import { slotsOf } from '@/context/grid'\n", 'utf8')
      const facts = extractImports(probe, dir)
      const kernelFiles = readKernelFiles()
      const violations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES, { srcRoot, kernelFiles })
      expect(violations, '未登记的新边必须判红（注入 `@/context/grid`）').toHaveLength(1)
      // 正对照：同一条边**登记后**判绿（证明判红来自登记表，而不是别的什么）
      const registry = [...APPROVED_COMPOSITION_LEGACY_EDGES, E('src/composition/probeAssembly.ts', 1, 'context/grid', 'import', 'x'.repeat(30), 'P11', 'G1')]
      expect(
        unregisteredCompositionLegacyEdges(facts, registry, { srcRoot, kernelFiles }),
        '登记之后必须判绿（否则负对照证明不了登记表在起作用）',
      ).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**负对照 B**：删掉一条登记 ⇒ 判红', async () => {
    const facts = await loadFacts()
    // 删掉 `kernelAssembly.ts:82`（`@/context/multiblock`）这条登记，其余不动。
    const baselineViolations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES)
    const removed = APPROVED_COMPOSITION_LEGACY_EDGES.filter(
      (e) => !(e.from === 'src/composition/kernelAssembly.ts' && e.line === 82),
    )
    expect(removed.length, '负对照必须真的删掉了一条').toBe(APPROVED_COMPOSITION_LEGACY_EDGES.length - 1)
    const violations = unregisteredCompositionLegacyEdges(facts, removed)
    // 判据：删一条登记，未登记集合必须在**原集合**上恰好多出**那一条**
    // （这样写法在工作树另有他人在途改动时依然精确 —— 多余项不被吞掉，也不会把
    //  别人的未登记边误算成本次删除的效果）。
    expect(
      violations.length,
      `删掉一条登记后未登记集合必须恰好 +1（原 ${baselineViolations.length} ⇒ 期望 ${baselineViolations.length + 1}）`,
    ).toBe(baselineViolations.length + 1)
    const added = violations.filter((v) => !baselineViolations.includes(v))
    expect(added, '新增的那一条必须正是被删登记对应的真实边').toHaveLength(1)
    expect(added[0]).toContain('kernelAssembly.ts:82')
    // 同时基线断言也必须红（登记数减少 = 未同批核销）
    const counted = countCompositionLegacyEdges(facts)
    expect(counted.lines).not.toBe(removed.length)
  })

  it('**负对照 C**：注入一条**目标在新层**的边不判红（闸门不得把新层也算旧）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-comp-neg3-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const comp = path.join(srcRoot, 'composition')
      fs.mkdirSync(comp, { recursive: true })
      const probe = path.join(comp, 'probeNewLayer.ts')
      fs.writeFileSync(probe, "import { evaluateScene } from '@/application/evaluation'\n", 'utf8')
      const facts = extractImports(probe, dir)
      expect(
        unregisteredCompositionLegacyEdges(facts, [], { srcRoot, kernelFiles: readKernelFiles() }),
        '指向内核文件（`KERNEL_FILES` 内）的边不是"绑旧层"',
      ).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
