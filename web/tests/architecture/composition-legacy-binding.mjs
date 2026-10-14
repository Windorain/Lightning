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
    lines.push({ file: `src/${fromRel}`, line: f.line, target })
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
  // ── R1-A C9（f50f6011 / e453ea8f）：描边规划端口经装配根注入 ────────────────
  //
  // C9 把"描边几何承载"落成生产实现（`kernelOutlinePlanPort` + 计划→mask 适配 + DRW 接线）。
  // 该模块是 `composition/` 的装配根（深度 2），只 import `runtime/`、`pure/`、`domain/`、
  // `presentation/` 的**深度 ≤ 2 公共出口**（见其文件头"分层"一节）。
  // 它引用旧 `runtime/` 撞名层的**读面**（`gridRead`）与旧运行实例（`context`），
  // 外加 `pure/partMask` 的部件掩码几何 ⇒ 四条"装配根 → 旧层"边，逐条登记（不得静默）。
  E('src/composition/kernelOutlinePlanPort.ts', 49, 'runtime/context', 'import',
    'C9 接线：描边几何源需要旧运行实例的类型（网格/对象的取用入口此刻仍在旧 `Context` 上）——装配根引用各层实现是设计使然（契约 §7）',
    'R1 收口：旧外壳/旧运行实例退场、描边几何源改吃内核会话后核销', 'R1-A'),
  E('src/composition/kernelOutlinePlanPort.ts', 50, 'runtime/gridRead', 'import',
    'C9 接线：格几何的形状由 `gridRead` 的读面返回类型派生（`KernelGridView`/`KernelGridPos`）——刻意**不** import `render/schema/types#BakedQuad`（深度 3 超公共出口上限），故读面是唯一形状来源',
    'R1 收口：读面迁出旧层（与 `APPROVED_LEGACY_TO_KERNEL_EDGES` 的 `gridRead` 两条同批）后核销', 'R1-A'),
  E('src/composition/kernelOutlinePlanPort.ts', 51, 'runtime/gridRead', 'import',
    'C9 接线（值位置）：用 `kernelGridObjectIdOf` 把格归一成对象身份 —— 与 `runtime/gridRead#identityRefOf` 的"歧义即拒绝"同一条纪律，不另写第二份',
    'R1 收口：同 :50', 'R1-A'),
  E('src/composition/kernelOutlinePlanPort.ts', 65, 'pure/partMask', 'import',
    'C9 接线：部件掩码几何复用旧 `pure/partMask` 的实现（`resolvePartMaskGeometry`）——它是既有生产能力的**唯一**实现，本模块只负责把"格的部件"解析成它的输入',
    'R1 收口：部件掩码几何迁入 `domain`/`adapters` 的新承载后核销（与 `runtime/gridRead` 的退出同批评审）', 'R1-A'),
]

/** 逐条登记必须写全的字段（防"登记了但没有理由/没有退出归属/没有负责人"）。 */
export const REGISTRY_REQUIRED_FIELDS = Object.freeze(['from', 'line', 'to', 'kind', 'reason', 'exitStage', 'owner'])

/** 基线：12 文件 / 32 行（修订记录见测试文件头"基线为何是 12/32"）。 */
export const BASELINE_FILES = 12
export const BASELINE_LINES = 32
