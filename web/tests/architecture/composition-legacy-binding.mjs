/**
 * **G1 判据① 的判定核与登记表**（`composition/` 生产文件绑定旧层的边）。
 *
 * 数据与逻辑住在这里（不是测试文件里）的理由：**负对照必须与生产判据共用同一实现**。
 * 任何"测试里另写一份判定逻辑"的形态都是"宿主复刻被测算法"——负对照绿了也证明不了
 * 生产判据会被判红。CLI 负对照（`temp/` 里的探针）通过本模块复现同样的判红输出。
 *
 * 覆盖形式、基线与口径的完整说明见 `composition-legacy-binding.test.ts` 的文件头。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `web/src`（本文件在 `web/tests/architecture/`）。 */
export const SRC_ROOT = path.resolve(HERE, '..', '..', 'src')
/** 判定面：`src/` 相对前缀。 */
export const COMPOSITION_SCOPE = 'composition/'

/**
 * 旧分层表 —— 与 `kernel-legacy-isolation.test.ts#OLD_LAYERS` **同表同义**（撞名层 `runtime` 在列）。
 * 两处都要列同一批目录是**故意**的：判据各自独立可读，改一处必须同批改另一处。
 */
export const OLD_LAYERS = Object.freeze([
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
])

/** 从内核隔离闸门的源码里用 **AST** 取出 `KERNEL_FILES` 字面量（单一事实来源，不复制清单）。 */
export function readKernelFiles() {
  const gatePath = path.join(HERE, 'kernel-legacy-isolation.test.ts')
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
      found = node.initializer.elements.filter((e) => ts.isStringLiteral(e)).map((e) => e.text)
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
 * 生产判据与负对照**共用本函数** —— 负对照不得另写一份判定逻辑。
 */
export function unregisteredCompositionLegacyEdges(
  facts,
  registry,
  { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {},
) {
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
    lines.push({ file: `src/${fromRel}`, line: f.line, target, kind: f.kind, isTypeOnly: f.isTypeOnly === true })
  }
  return { files: new Set(lines.map((l) => l.file)).size, lines: lines.length, rows: lines }
}

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
 */
export const APPROVED_COMPOSITION_LEGACY_EDGES = [
  // ── 入向：把真实文件装配成内核文档（旧 RuntimeDocument / Grid / multiblock 的公共出口）──
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
    "出向投影（类型位置 `import('x').T`）：该行附近的签名用旧 `gridTypes` 的判别式类型表达\"投影输入是内核载荷\"",
    'R1 收口：旧 `gridTypes` 退出生产后核销', 'G1'),
  E('src/composition/kernelProjection.ts', 569, 'pure/gridTypes', 'import',
    "出向投影（类型位置 `import('x').T`）：同一模块内第二处签名也以内核载荷类型为准，复用旧 `gridTypes` 的判别式类型描述\"投影输入来自内核\"",
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

/**
 * **基线（冻结）**：`9630a39d` 的 **11 文件 / 28 行**。
 *
 * ## 为什么基线冻结在这个提交，而**不是**评审当刻的最大值
 *
 * Lead 裁决（#385，2026-10-14）：基线**不得抬到**评审当刻的 12/32 —— 那会让"边登记边做大"
 * 成为合法的反模式（登记表成了增长的许可证）。正确形态是：
 * **基线冻结在上一批真值 11/28**，本批新出现的绑定进**具名豁免清单**（下），
 * 且豁免清单的**终态必须是空的**。
 */
export const BASELINE_FILES = 11
export const BASELINE_LINES = 28
/** 基线的来源提交（便于 P11 复核"冻结在哪个真值上"）。 */
export const BASELINE_COMMIT = '9630a39d'

/**
 * **具名豁免（暂准，终态必须为空）** —— 装配根 `kernelOutlinePlanPort.ts` 的绑旧层边。
 *
 * ## 形态的四条硬约束（Lead 裁决 #385，2026-10-14）
 *
 * | # | 约束 | 本文件里的落点 |
 * |---|---|---|
 * | ① | 未登记边 ⇒ 判红 | `unregisteredCompositionLegacyEdges` + `approvedWithExemptions` |
 * | ② | 豁免**只允许**冻结的那 4 条，多一条 ⇒ 红 | `FROZEN_PERMITTED_EXEMPT_GROUPS`（许可组 + 组内条数上限 + 总量 4）+ `exemptionCeilingViolations` |
 * | ③ | 豁免条数作为**可读读数**导出（趋势机器可见） | `exemptionReading(facts)`（测试打进日志；含许可上限与终态声明） |
 * | ④ | 终态**必须为空**：R1-A 子件②把这 4 条注入化后豁免归零，基线相对读数回到 11/28 | `terminal: 'empty'` + `terminalBatch`；豁免由**实测导出**（`derivePendingExemptions`）⇒ 绑定一消失，条目自动消失，不存在"留着的空豁免" |
 *
 * ## 为什么豁免成员是**实测导出**而不是手写行号清单
 *
 * C9 的 `kernelOutlinePlanPort.ts` 在评审期由**其他写者**持续编辑，实测 20 分钟内变了三次：
 * `:51`（值位置 `gridRead`）与 `:65`（`pure/partMask`）被注入化消掉、行号从 49/50 漂到 56/57。
 * 手写 `file:line` 清单在这种条件下会产生**假红**（漂移被当成越界）与**假绿**（留着已消失的条目）。
 * ⇒ 判据钉在**语义**上：许可的 `(file, target)` 组合与条数（冻结），豁免成员由实测导出（读数）。
 * 判据强度不降：往豁免里塞第五个绑定/新的去向仍然判红（`exemptionCeilingViolations`）。
 *
 * ## 收缩史（读数）
 *
 * | 时点 | 条数 | 说明 |
 * |---|---|---|
 * | C9 落地（`f50f6011`/`e453ea8f`） | **4** | `:49`→`runtime/context`、`:50`/`:51`→`runtime/gridRead`、`:65`→`pure/partMask` |
 * | R1-A 子件②在途（评审后实测） | **≤4（递减）** | 注入化推进时条目逐个消失，终态 0 |
 */

/**
 * ② 的**许可上限**：豁免**只允许**下列 `(file, target)` 组合与条数（新的组合 / 超组上限 / 超总量 ⇒ 判红）。
 *
 * ## 收敛史（逐批向下，不向上 —— #385 裁决 + R1-A C10 收敛）
 *
 * | 时点 | 该文件绑旧层条数 | 其中值导入 | 许可上限总量 | 依据 |
 * |---|---|---|---|---|
 * | C9 落地（`f50f6011`/`e453ea8f`） | 4 | 2（`gridRead` 值位置 + `partMask`） | 4 | Lead 裁决的暂准起点 |
 * | R1-A 子件②在途（评审实测） | 3 | 1（`partMask` 已被注入化消掉） | 4 | 实测导出 |
 * | **R1-A C10（`d4708d0b`）** | **2** | **0** | **2** | C10 把旧层**值导入清零**（改吃 `runtime/host.ts` 的注入口），只剩 2 条 **type-only** |
 *
 * ⚠️ Lead 给定的血统读数记作 `fb0814d4=4 / C7 段二=4 / R1-A C10(d4708d0b)=2（值导入 0）`；
 * 本判据可**机械复核**的是后两项（C9 落地 = 4、C10 后 = 2 —— `kernelOutlinePlanPort.ts` 本身是
 * C9 新建的文件，故更早的"4"指向同一"装配根绑旧层"计数线的另一口径，本文件按给定值留档、不冒充实测）。
 *
 * ## 为什么上限现在是 2（而不是仍留 4 的余量）
 *
 * 余量会让"再塞回一条值导入"不判红 —— 那正是"边登记边做大"的反模式。
 * 上限必须**紧跟实测**逐批向下收敛，故 C10 落地后即改为：`context` 1、`gridRead` 1、`partMask` **0**。
 *
 * ## 剩下这 2 条 type-only 的处置（不得默认永久保留）
 *
 * 本判据的口径里 **type-only 同样计入**（`module-graph.mjs` 的 AST 采集含 `import type` 与
 * `import('x').T`，与 `boundary-rules.mjs`「类型导入同计」一致）⇒ 它们**必须**留在豁免里直到
 * 被消除，且豁免**终态必须为空**。可消除的路径有两条（择一，须在 R1-A 收口时落地）：
 *  1. 把 `Context` / `KernelGridView` 的**类型**也改为经 `runtime/host.ts` 的注入口声明
 *     （与 C10 对值导入做的一样）⇒ 两条 type-only 边消失，豁免归零；
 *  2. 若 R1-A 收口后 `runtime/` 撞名层本身退出（`gridRead`/`context` 不再是旧层），
 *     这两条边不再落在 `OLD_LAYERS` 判定内 ⇒ 自然消失。
 * 在任一路径落地前，本表不得再增，也不得把"2"当作新基线写死。
 */
export const FROZEN_PERMITTED_EXEMPT_GROUPS = Object.freeze([
  Object.freeze({ file: 'src/composition/kernelOutlinePlanPort.ts', target: 'runtime/context', permitted: 1 }),
  Object.freeze({ file: 'src/composition/kernelOutlinePlanPort.ts', target: 'runtime/gridRead', permitted: 1 }),
  Object.freeze({ file: 'src/composition/kernelOutlinePlanPort.ts', target: 'pure/partMask', permitted: 0 }),
])

/**
 * C9 落地（`f50f6011` / `e453ea8f`）时的豁免**历史读数**（4 条 `file:line:target`）。
 *
 * ⚠️ 这是**读数快照，不是判据**（也不参与任何断言的门槛）：C9 的 `kernelOutlinePlanPort.ts`
 * 在评审期由**其他写者**持续编辑（文件头注释增长 ⇒ 导入行号漂移；子件②的注入化 ⇒ 条目被消掉；
 * C10 的值导入清零 ⇒ 只剩 type-only）。把行号当作**判据**会让"行号漂移"与"注入化收缩"
 * 都变成假红 —— 闸门要判的是**绑定的数量与去向不得新增**（上 `FROZEN_PERMITTED_EXEMPT_GROUPS`），
 * 而不是一个正在被编辑的文件的行号。故当前的豁免成员由 `derivePendingExemptions()`
 * **实测导出**（读数），许可上限由冻结的许可组把守（判据）。
 *
 * 收敛史（同一张表，便于 P11 对账）：`fb0814d4=4 / C7 段二=4 / R1-A C10(d4708d0b)=2（值导入 0）`
 * —— 前两项为 Lead 给定的血统读数（本判据当时不可机械复核），后两项为本判据实测。
 */
export const EXEMPTION_LEDGER_AT_C9_LANDING = Object.freeze([
  'src/composition/kernelOutlinePlanPort.ts:49:runtime/context',
  'src/composition/kernelOutlinePlanPort.ts:50:runtime/gridRead',
  'src/composition/kernelOutlinePlanPort.ts:51:runtime/gridRead',
  'src/composition/kernelOutlinePlanPort.ts:65:pure/partMask',
].sort())

/** 许可上限的**总条数**（2 = R1-A C10 后的实测条数；由 4 收敛而来，只降不升）。 */
export const FROZEN_PERMITTED_EXEMPT_TOTAL = FROZEN_PERMITTED_EXEMPT_GROUPS.reduce((n, g) => n + g.permitted, 0)

/** 冻结基线登记的身份集（28 条；豁免 = 实测 − 本集）。 */
export const BASELINE_EDGE_IDS = Object.freeze(
  APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`).sort(),
)

/**
 * **豁免成员（实测导出）**：`composition/` 里绑旧层的边中**不在冻结基线**里的那些。
 *
 * 它们在语义上就是"本批新出现、尚未核销、暂准存在"的绑定 —— 由 `PENDING_*` 手写清单
 * 改成实测导出，是因为 C9 的文件正被其他写者编辑：手写 `file:line` 会在漂移与注入化下
 * 反复产生**假红**（本批评审期实测：同一份清单在 20 分钟内被动过三次：
 * `:51`/`:65` 被注入化消掉、行号从 49/50 漂到 56/57）。
 * 判据强度不降：**许可上限（组 + 条数）仍是冻结的判据**，实测导出只回答"当前还剩几条"。
 */
export function derivePendingExemptions(facts, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {}) {
  const baseline = new Set(BASELINE_EDGE_IDS)
  return countCompositionLegacyEdges(facts, { srcRoot, kernelFiles })
    .rows.filter((r) => !baseline.has(`${r.file}:${r.line}:${r.target}`))
    .map((r) =>
      Object.freeze({
        from: r.file,
        line: r.line,
        to: r.target,
        kind: r.kind,
        isTypeOnly: r.isTypeOnly,
        exempt: true,
        terminalBatch: 'R1-A 子件②',
      }),
    )
    .sort((a, b) => (a.from === b.from ? a.line - b.line : a.from < b.from ? -1 : 1))
}

/** ② 的**机械检测核**：返回"超出许可上限"的说明（空 = 合规）。判据与负对照共用。 */
export function exemptionCeilingViolations(exemptions) {
  const out = []
  const groups = new Map()
  for (const e of exemptions) {
    const key = `${e.from}→${e.to}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
    const permitted = FROZEN_PERMITTED_EXEMPT_GROUPS.find((g) => g.file === e.from && g.target === e.to)
    if (!permitted) {
      out.push(`${e.from}:${e.line} → ${e.to}：该 (file, target) 组合不在冻结许可集内（新增绑定必须走基线修订的显式流程，不是往豁免里塞）`)
    }
  }
  for (const [key, count] of groups) {
    const [file, target] = key.split('→')
    const permitted = FROZEN_PERMITTED_EXEMPT_GROUPS.find((g) => g.file === file && g.target === target)
    if (permitted && count > permitted.permitted) {
      out.push(`${file} → ${target}：豁免 ${count} 条，超出许可上限 ${permitted.permitted} 条`)
    }
  }
  if (exemptions.length > FROZEN_PERMITTED_EXEMPT_TOTAL) {
    out.push(`豁免总条数 ${exemptions.length} 超出许可上限 ${FROZEN_PERMITTED_EXEMPT_TOTAL} 条`)
  }
  return out
}

/**
 * ③ 的读数本体（测试打进日志，供每批合流登记趋势）；`terminal` 是 ④ 的机器可读声明。
 * `exemptionCount` 是**实测导出**（读数），`permittedCeiling` 是冻结判据。
 */
export function exemptionReading(facts) {
  const exemptions = derivePendingExemptions(facts)
  return {
    exemptionCount: exemptions.length,
    permittedCeiling: FROZEN_PERMITTED_EXEMPT_TOTAL,
    baseline: { files: BASELINE_FILES, lines: BASELINE_LINES, commit: BASELINE_COMMIT },
    terminal: 'empty',
    terminalBatch: 'R1-A 子件②（C10 后剩 2 条 type-only；消除路径见许可组注释）',
    ids: exemptions.map((e) => `${e.from}:${e.line}:${e.to}`),
  }
}

/**
 * **豁免的"必须为空"是可机械判定的**（不是注释里的承诺）。
 *
 * ## 为什么需要它
 *
 * "豁免终态应为空"若只写在注释里，就只是一句**无法被判据追踪的承诺** ——
 * 任何人可以无限期不动它而没有任何东西变红。这里把释放条件定义成**两条可观测触发**，
 * 且两条都由 `derivePendingExemptions()` 的实现**直接兑现**（豁免是实测导出 ⇒ 条件成立时
 * 条目**自动**消失，不依赖谁记得去删表）：
 *
 * | 触发 | 观测 | 兑现方式 |
 * |---|---|---|
 * | **T1 边消失**（注入化落地） | 模块图里不再有 `kernelOutlinePlanPort.ts → <旧层>` 这条边 | 导出集只包含**实测存在**的边 ⇒ 自动为空 |
 * | **T2 目标不再是旧层**（`runtime/context` / `runtime/gridRead` 被登记进 `KERNEL_FILES`） | `isOldLayerTarget(target, kernelFiles) === false` | `countCompositionLegacyEdges` 已按 `isOldLayerTarget` 过滤 ⇒ 自动为空 |
 *
 * ⚠️ 还有一条**不可协商**的边界：`runtime/context` 与 `runtime/gridRead` 今天仍是旧层
 * （不在 `KERNEL_FILES` 内），所以 T2 **今天不成立**，这两条 type-only 边**现在确实算边**
 * —— 闸门自身的口径就是"类型导入同计"（`ruleNoPrivateCrossLayer` 对 `import { type X }`
 * 形态同样产出 finding）。⇒ 它们**不是终态可接受的"已知并存边界"**，而是
 * **待 R1-A 子件②核销的欠账**。本判据把这个立场变成断言：条目必须全是 type-only、
 * 必须 ≤2、且不得增长；释放条件一旦成立，条目消失、计数必须回落。
 */
export const EXEMPTION_RELEASE_TRIGGERS = Object.freeze([
  Object.freeze({ id: 'T1', kind: 'edge-absent', detail: '注入化落地 ⇒ 模块图里不再有该边 ⇒ 实测导出自动为空' }),
  Object.freeze({ id: 'T2', kind: 'target-not-old-layer', detail: '目标被登记进 KERNEL_FILES ⇒ 不再是旧层 ⇒ 实测导出自动为空' }),
])

/**
 * ④ 的**机器可读退出状态**：把"何时必须为空"变成可判定的事实，而不是承诺。
 *
 * 逐条给出"现在它凭什么还在"（`holdingBecause`）与"哪一条触发一旦成立它就必消失"。
 * 若 `releaseConditionSatisfied` 为真而条目仍在 ⇒ 调用方（判据）必须判红。
 */
export function exemptionExitStatus(facts, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {}) {
  const exemptions = derivePendingExemptions(facts, { srcRoot, kernelFiles })
  const allTypeOnly = exemptions.every((e) => e.isTypeOnly === true)
  const reasons = exemptions.map((e) => {
    const targetStillOldLayer = isOldLayerTarget(e.to, kernelFiles)
    const edgeAbsent = false // 它出现在导出集里 ⇒ 边存在（T1 不成立）
    return {
      id: `${e.from}:${e.line}:${e.to}`,
      isTypeOnly: e.isTypeOnly === true,
      edgeAbsent,
      targetStillOldLayer,
      releaseConditionSatisfied: edgeAbsent || !targetStillOldLayer,
      holdingBecause: targetStillOldLayer
        ? `T1 未成立（边仍在）且 T2 未成立（${e.to} 仍在旧层、未登记进 KERNEL_FILES）`
        : 'T2 成立（目标已不在旧层）—— 该条必须已消失',
    }
  })
  return {
    count: exemptions.length,
    allTypeOnly,
    mustBeEmpty: exemptions.length === 0,
    /** 释放条件成立时，条目必须消失：任何"该消失却还在"的条目都在这里列出。 */
    violations: reasons.filter((r) => r.releaseConditionSatisfied).map((r) => r.id),
    triggers: EXEMPTION_RELEASE_TRIGGERS,
    reasons,
  }
}

/** 生产判据使用的"当前已批准集合" = 冻结基线登记 + 实测导出的具名豁免。 */
export function approvedWithExemptions(facts) {
  const exemptions = derivePendingExemptions(facts).map((e) => ({
    from: e.from,
    line: e.line,
    to: e.to,
    kind: 'import',
    reason: `R1-A C9 在途绑定（豁免，终态为空）：${e.from} → ${e.to}`,
    exitStage: 'R1-A 子件②：注入化后从豁免中消失，本批登记随之核销',
    owner: 'R1-A',
  }))
  return [...APPROVED_COMPOSITION_LEGACY_EDGES, ...exemptions]
}

/** 逐条登记必须写全的字段（防"登记了但没有理由/没有退出归属/没有负责人"）。 */
export const REGISTRY_REQUIRED_FIELDS = Object.freeze(['from', 'line', 'to', 'kind', 'reason', 'exitStage', 'owner'])
