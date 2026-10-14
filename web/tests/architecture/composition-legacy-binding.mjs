/**
 * **G1 判据① 的判定核与登记表**（`composition/` 生产文件绑定旧层的边）。
 *
 * 数据与逻辑住在这里（不是测试文件里）的理由：**负对照必须与生产判据共用同一实现**。
 * 任何"测试里另写一份判定逻辑"的形态都是"宿主复刻被测算法"——负对照绿了也证明不了
 * 生产判据会被判红。CLI 负对照（`temp/` 里的探针）通过本模块复现同样的判红输出。
 *
 * 覆盖形式、基线与口径的完整说明见 `composition-legacy-binding.test.ts` 的文件头。
 *
 * ---
 *
 * # 口径：`(file, target)` **对键** —— 行号不是语义
 *
 * ## 为什么去掉行锚（本条事故）
 *
 * 本判据原先把边冻结成 `file:line:target` **三元组**（行键）。事故（2026-10-14）：
 * 上游提交 `44030389`（"R2-1a 第4件(接线)：多方块声明进内容权威"）在
 * `web/src/composition/kernelAssembly.ts` 插入了一行 import（`:85` 的
 * `@/adapters/multiblockDeclaration`）连同其注释，使**既有的** `@/context/runtimeDocument`
 * import 从 `:87` 漂到 `:90`（`kernelAssembly.ts:90`）。后果：
 *
 *  - 同一条边被算成"登记之外的新绑定"（升成第三条例外，且它其实是**值/类型混合对**里的既有成员）；
 *  - 原登记 `:87` 被判"腐烂"；
 *  - `test:arch` 由绿转红：**8 failed / 7 passed**（全部连锁自这一处行漂移）。
 *
 * 判据缺陷（不是业务缺陷）的判定依据：**被替代的边集合与目标集合都没变** ——
 * 没有任何一条 `composition/ → 旧层` 的绑定新增或消失，变的只是无关编辑造成的行号漂移。
 * ⇒ 键里去掉行锚，只留 `(file, target)`；行号降级为**失败消息里的定位注解**，不参与任何断言。
 *
 * ## 同族先例（不是本判据的临时发明）
 *
 * `web/src/pure/__tests__/partMaskEnvelopeExemption.test.ts` 的判据明文要求
 * "豁免必须按**行内标记**匹配（挪行不失效）"，并断言"豁免登记**不得绑行号**"
 * （该文件 :41 的用例名、:48 的 `expect(block, '豁免登记不得绑行号').not.toMatch(/\bline:\s*\d/)`）。
 * 那次（#39 阶段二 `PartBoxMaskEnvelope`）与本条同因：**行锚在无关编辑下产生假红**，
 * 处置同为**去行号锚**。
 *
 * ## 一次性等价证明（读数：28 行 → 21 对，实测）
 *
 * 把旧口径的**行键读数**（`file:line:target`）按 `(file,target)` 归一后，与新对集**完全相等**
 * （`pairMultisetOfLineKeys` 是**独立于** `countCompositionLegacyEdges` 分组路径的另一条实现，
 * 两条路径的归一读数必须逐对、逐重数相等；见 `composition-legacy-binding.test.ts` 的等价证明用例）：
 *
 * | 读数 | 旧口径（行键） | 新口径（对键 + 重数） |
 * |---|---|---|
 * | 冻结基线（`9630a39d`） | **28 行** / 28 个不同行键 | **21 对 / 28 次出现**（6 对重数 2~3） |
 * | 实测（`44030389`） | 30 行 / 30 个不同行键 / 12 文件 | **23 对 / 30 次出现** / 12 文件 |
 * | `onlyDeclared`（登记腐烂） | **1** 条：`kernelAssembly.ts:87:context/runtimeDocument` | **0** 对 |
 * | `onlyObserved`（登记外绑定） | **3** 条（`:90` 假组件 + 2 条合法豁免） | **2** 对（恰为 2 条合法豁免） |
 * | 重数差 | — | **0** |
 *
 * 旧口径的两条假读数（`:87` 与 `:90`）**归一到同一个对**
 * （`src/composition/kernelAssembly.ts → context/runtimeDocument`，该对在基线里本来就有
 * 另一条登记 `:76`），归一后**互相湮灭** ⇒ 红绿差**只剩下** 2 条真正的新绑定
 * （`kernelOutlinePlanPort.ts`，本就登记在具名豁免里）。
 *
 * **这不是放宽口径**：分量一个没少 —— 重数仍然逐条对账（实测 30 次 = 冻结基线 28 次 +
 * 豁免 2 次，见 ③ `bindingCountViolations`），且同一 `(file,target)` 的**多条目仍按重数计**
 * （`kernelProjection.ts → context/runtimeDocument` 重数 3 不得掉到 2）。去掉的只是
 * **非语义键成分**（行号）。等价证明的原始读数另见 `PAIR_NORMALIZATION` 常量与事故账
 * `LINE_KEY_FALSE_READING_AT_44030389`。
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

// ─────────────────────────────────────────────────────────────────────────────
// 对键工具：判据的一切集合运算都建在 `(file, target)` 上 —— **行号不参与**。
// ─────────────────────────────────────────────────────────────────────────────

/** 对键：`<file>→<target>`（`file` 为 `src/` 相对路径；`target` 无扩展名）。 */
export function pairKeyOf(from, to) {
  return `${from}→${to}`
}

/** 拆对键（`from`/`to` 里不可能含 `→`）。 */
export function splitPairKey(key) {
  const i = key.lastIndexOf('→')
  return { from: key.slice(0, i), to: key.slice(i + 1) }
}

/** 键数组 → 多重集（`key → 出现次数`）。同一 `(file,target)` 的多条边仍是**多次出现**，不折叠。 */
export function pairMultisetOf(keys) {
  const out = new Map()
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1)
  return out
}

/**
 * **等价证明的归一算子**：把旧口径的**行键读数**（`file:line:target`）按 `(file,target)` 归一并保留重数。
 *
 * 它与 `countCompositionLegacyEdges` 的分组路径**互相独立**（这边先拿行键文本、再用正则拆，
 * 那边在 AST 事实上游直接分组）⇒ 两者归一结果相等是一个**有区分力的**一致性证明，
 * 而不是把同一个表达式写两遍。
 */
export function pairMultisetOfLineKeys(lineKeys) {
  const out = new Map()
  for (const key of lineKeys) {
    const m = /^(.+):(\d+):([^:]+)$/.exec(key)
    if (m === null) throw new Error(`行键形态非法（应为 file:line:target）：${key}`)
    const pair = pairKeyOf(m[1], m[3])
    out.set(pair, (out.get(pair) ?? 0) + 1)
  }
  return out
}

/** Map → 可比较的排序数组（断言里的对账形态；避免 Map 引用相等造成恒真/恒假）。 */
export function multisetEntries(m) {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * **判定核（计数半边）**：给定导入事实集，按 **对键** 数出 `composition/` 生产文件绑旧层的边。
 *
 * 返回：
 *  - `files`：出现的**文件数**（语义读数，与行键口径同值）；
 *  - `pairs`：**不同对**的个数（新口径的主读数）；`occurrences`：边重数合计（= 旧口径的行数）；
 *  - `lines`：`occurrences` 的**旧口径别名**（"28 行"这类历史读数口径），保留供等价证明对账；
 *  - `pairCounts`：`pair → 重数`（多重集）；`pairRows`：`pair → 明细`（**含行号，仅供报告**）；
 *  - `rows`：扁平明细（每行一条边，含行号），与旧口径同形。
 */
export function countCompositionLegacyEdges(facts, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {}) {
  const rows = []
  for (const f of facts) {
    const fromRel = path.relative(srcRoot, f.fromFile).replace(/[\\/]+/g, '/')
    if (!fromRel.startsWith(COMPOSITION_SCOPE)) continue
    if (!isProductionRel(fromRel)) continue
    const target = resolveTargetOf(f, srcRoot)
    if (target === null || !isOldLayerTarget(target, kernelFiles)) continue
    rows.push({
      file: `src/${fromRel}`,
      line: f.line,
      target,
      pair: pairKeyOf(`src/${fromRel}`, target),
      kind: f.kind,
      isTypeOnly: f.isTypeOnly === true,
    })
  }
  const pairCounts = pairMultisetOf(rows.map((r) => r.pair))
  const pairRows = new Map()
  for (const r of rows) {
    const cur = pairRows.get(r.pair)
    if (cur === undefined) {
      pairRows.set(
        r.pair,
        Object.freeze({
          pair: r.pair,
          file: r.file,
          target: r.target,
          occurrences: 1,
          lines: [r.line],
          kinds: [r.kind],
          allTypeOnly: r.isTypeOnly === true,
          anyValue: r.isTypeOnly !== true,
        }),
      )
    } else {
      const next = {
        pair: cur.pair,
        file: cur.file,
        target: cur.target,
        occurrences: cur.occurrences + 1,
        lines: [...cur.lines, r.line],
        kinds: [...cur.kinds, r.kind],
        allTypeOnly: cur.allTypeOnly && r.isTypeOnly === true,
        anyValue: cur.anyValue || r.isTypeOnly !== true,
      }
      pairRows.set(r.pair, Object.freeze(next))
    }
  }
  return {
    files: new Set(rows.map((r) => r.file)).size,
    pairs: pairCounts.size,
    occurrences: rows.length,
    lines: rows.length,
    rows,
    pairCounts,
    pairRows,
  }
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
 *
 * ## `line` 字段的法定身份：**报告注解**，不是判据键
 *
 * 每条登记的判据身份是 `(from, to)` 这个**对**（见 `BASELINE_PAIRS` / `BASELINE_PAIR_OCCURRENCES`）。
 * `line` 只在**失败消息**里出现，供人类定位；它**不参与任何断言**（可机械复核：
 * 把全表 `line` 扰动 +1000，三条检测的读数逐项不变 —— 见判据文件的"行号非键"用例）。
 * 本表的 `line` 是**冻结快照里的历史注解**（与基线提交同源），**不承诺**与当前文件同步 ——
 * 上游任一无关编辑都会让它漂移，这正是本条判据去掉行锚的原因。需要精确定位时，失败消息会
 * **同时**给出登记注解行与**实测行**（`rottenRegisteredPairs` 的 `occurrence-shortfall` 分支）；
 * 判据本身在任何一种注解下都给出同一结论（见判据文件的"行号非键"与"注解漂移不进判定"两个用例）。
 *
 * **活体证据（第二例，同一缺陷类）**：本树 `08cd99fc`（"G4+G5 S2 第二半(1/2)"）在
 * `web/src/composition/kernelPresentationInputs.ts:61` 插入一行（`@/adapters/tooltipPool`），
 * 使已登记的 `@/runtime/presentationAdapter` import 从 `:61` 漂到 `:62` ——
 * 行键口径下这是**又一例**假红（该登记被判"腐烂"），对键口径下**不可见**
 * （该对登记 1 条、实测 1 条）。本条与 `44030389` 是同一缺陷、不同提交，独立复现。
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
  // ⚠️ 这一条的 `line` 已随 `44030389` 的行插入从 `:87` 漂到 `:90`（**对键不变**，故判据不受影响）。
  E('src/composition/kernelAssembly.ts', 90, 'context/runtimeDocument', 'import',
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
 * **基线（冻结）**：`9630a39d` 的 **11 文件 / 21 对 / 28 次出现**（旧口径读数 = **28 行**）。
 *
 * ## 为什么基线冻结在这个提交，而**不是**评审当刻的最大值
 *
 * Lead 裁决（#385，2026-10-14）：基线**不得抬到**评审当刻的最大值 —— 那会让"边登记边做大"
 * 成为合法的反模式（登记表成了增长的许可证）。正确形态是：
 * **基线冻结在上一批真值**，本批新出现的绑定进**具名豁免清单**（下），
 * 且豁免清单的**终态必须是空的**。
 */
export const BASELINE_FILES = 11
/** 基线来源提交（便于 P11 复核"冻结在哪个真值上"）。 */
export const BASELINE_COMMIT = '9630a39d'

/** 冻结基线的**对键集**（从登记表派生，去重；`21` 由 `BASELINE_PAIR_COUNT` 冻结对账）。 */
export const BASELINE_PAIRS = Object.freeze(
  [...new Set(APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => pairKeyOf(e.from, e.to)))].sort(),
)

/** 冻结基线的**对多重集**（`pair → 重数`；合计 = `BASELINE_EDGE_OCCURRENCES` = 28 = 旧行键读数）。 */
export const BASELINE_PAIR_OCCURRENCES = Object.freeze(
  Object.fromEntries(multisetEntries(pairMultisetOf(APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => pairKeyOf(e.from, e.to))))),
)

/** 冻结读数①：**不同对的个数**（新口径主读数；`21` 由等价证明实测）。 */
export const BASELINE_PAIR_COUNT = 21
/** 冻结读数②：**边重数合计**（= 旧行键口径的"28 行"）。同一对多条目按重数计，不折叠。 */
export const BASELINE_EDGE_OCCURRENCES = 28

/**
 * **等价证明的机器可读读数**（旧行键口径 → 新对键口径）。
 *
 * `before` = 旧口径（`file:line:target` 三元组）；`after` = 新口径（`(file,target)` 对）。
 * 两个口径的**分量总数相同**（`before.lines === after.occurrences`）——
 * 这正是"去掉的是非语义键成分、不是放宽口径"的机械表述。
 */
export const PAIR_NORMALIZATION = Object.freeze({
  commit: '44030389',
  before: Object.freeze({
    baseline_lines: 28,
    baseline_distinct_line_keys: 28,
    measured_lines: 30,
    measured_distinct_line_keys: 30,
    measured_files: 12,
    onlyDeclared_line_keys: 1,
    onlyObserved_line_keys: 3,
    exemptions_line_keys: 3,
  }),
  after: Object.freeze({
    baseline_pairs: 21,
    baseline_pair_occurrences: 28,
    measured_pairs: 23,
    measured_pair_occurrences: 30,
    measured_files: 12,
    onlyDeclared_pairs: 0,
    onlyObserved_pairs: 2,
    exemptions_pairs: 2,
    occurrence_gap: 0,
  }),
})

/**
 * **事故账**（`44030389` 的行漂移在旧口径下造出的两条假读数）。
 *
 * 单看这两条，行键口径判"腐烂 1 条 + 登记外 3 条"；**归一到对键后它们互相湮灭**
 * （两行指向同一个对，而该对在基线里本来就有另一条登记 `:76`）⇒ 只剩 2 条**真**新绑定。
 * 这是"判据缺陷、不是业务缺陷"的最小可复核证据。
 */
export const LINE_KEY_FALSE_READING_AT_44030389 = Object.freeze({
  pair: pairKeyOf('src/composition/kernelAssembly.ts', 'context/runtimeDocument'),
  declared_line_key: 'src/composition/kernelAssembly.ts:87:context/runtimeDocument',
  observed_line_key: 'src/composition/kernelAssembly.ts:90:context/runtimeDocument',
  baseline_pair_occurrences: 2,
  verdict_before: '8 failed | 7 passed',
  verdict_after_expected: '0 failed',
})

/** 冻结基线登记的身份集（28 条**行键**读数；等价证明与历史对账用，**不参与判定**）。 */
export const BASELINE_EDGE_LINE_KEYS = Object.freeze(
  APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`).sort(),
)

/**
 * **具名豁免（暂准，终态必须为空）** —— 装配根 `kernelOutlinePlanPort.ts` 的绑旧层边。
 *
 * ## 形态的四条硬约束（Lead 裁决 #385，2026-10-14）
 *
 * | # | 约束 | 本文件里的落点 |
 * |---|---|---|
 * | ① | 未登记对 ⇒ 判红 | `unregisteredCompositionLegacyEdges` + `approvedWithExemptions` |
 * | ② | 豁免**只允许**冻结的许可组，多一条/超组上限/超总量 ⇒ 红 | `FROZEN_PERMITTED_EXEMPT_GROUPS`（按 `(file,target)` 组 + 组内**重数**上限 + 总量）+ `exemptionCeilingViolations` |
 * | ③ | 豁免条数作为**可读读数**导出（趋势机器可见） | `exemptionReading(facts)`（测试打进日志；含许可上限与终态声明） |
 * | ④ | 终态**必须为空**：R1-A 子件②把这 2 条注入化后豁免归零，基线相对读数回到 11/21/28 | `terminal: 'empty'` + `terminalBatch`；豁免由**实测导出**（`derivePendingExemptions`）⇒ 绑定一消失，条目自动消失，不存在"留着的空豁免" |
 *
 * ## 为什么豁免成员是**实测导出**而不是手写行号清单
 *
 * C9 的 `kernelOutlinePlanPort.ts` 在评审期由**其他写者**持续编辑，实测 20 分钟内变了三次：
 * `:51`（值位置 `gridRead`）与 `:65`（`pure/partMask`）被注入化消掉、行号从 49/50 漂到 56/57。
 * 手写 `file:line` 清单在这种条件下会产生**假红**（漂移被当成越界）与**假绿**（留着已消失的条目）。
 * ⇒ 判据钉在**语义**上：许可的 `(file, target)` 组合与**重数**（冻结），豁免成员由实测导出（读数）。
 * 判据强度不降：往豁免里塞第五个绑定/新的去向仍然判红（`exemptionCeilingViolations`）。
 *
 * ## 收缩史（读数）
 *
 * | 时点 | 边数 | 说明 |
 * |---|---|---|
 * | C9 落地（`f50f6011`/`e453ea8f`） | **4** | `:49`→`runtime/context`、`:50`/`:51`→`runtime/gridRead`、`:65`→`pure/partMask`（**4 行 → 3 对**，见下账） |
 * | R1-A 子件②在途（评审后实测） | **≤4（递减）** | 注入化推进时条目逐个消失，终态 0 |
 */

/**
 * ② 的**许可上限**：豁免**只允许**下列 `(file, target)` 组合与**重数**（新的组合 / 超组上限 / 超总量 ⇒ 判红）。
 *
 * ## 收敛史（逐批向下，不向上 —— #385 裁决 + R1-A C10 收敛）
 *
 * | 时点 | 该文件绑旧层边数 | 其中值导入 | 许可上限总量 | 依据 |
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
 *
 * 注：本表**自 C9 起就是按 `(file,target)` 组的**（组内 `permitted` 是**重数**上限），
 * 故 2026-10-14 的对键口径落地没有改动它的语义，只是把成员导出也换成了对键。
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

/**
 * 上表的**对键归一读数**（第二处等价证明：**4 行 → 3 对**）。
 * 由 `pairMultisetOfLineKeys` 独立算得：`runtime/gridRead` 重数 2（`:50`/`:51`），另两对各 1。
 */
export const EXEMPTION_LEDGER_AT_C9_LANDING_PAIRS = Object.freeze(
  Object.fromEntries(multisetEntries(pairMultisetOfLineKeys(EXEMPTION_LEDGER_AT_C9_LANDING))),
)

/** 许可上限的**总重数**（2 = R1-A C10 后的实测重数；由 4 收敛而来，只降不升）。 */
export const FROZEN_PERMITTED_EXEMPT_TOTAL = FROZEN_PERMITTED_EXEMPT_GROUPS.reduce((n, g) => n + g.permitted, 0)

/** 许可集里**可用的对数**（`permitted > 0` 的组数；`pure/partMask` 已收敛为 0 ⇒ 不计入）。 */
export const PERMITTED_EXEMPT_PAIRS = FROZEN_PERMITTED_EXEMPT_GROUPS.filter((g) => g.permitted > 0).length

/** 许可集里**可用的重数**（各组 `permitted` 之和）。 */
export const PERMITTED_EXEMPT_OCCURRENCES = FROZEN_PERMITTED_EXEMPT_TOTAL

/**
 * **豁免成员（实测导出，对键口径）**：`composition/` 里绑旧层的**对**中**不在冻结基线对集**里的那些。
 *
 * 它们在语义上就是"本批新出现、尚未核销、暂准存在"的绑定 —— 由手写清单改成实测导出，
 * 是因为 C9 的文件正被其他写者编辑：手写 `file:line` 会在漂移与注入化下反复产生**假红**
 * （本批评审期实测：同一份清单在 20 分钟内被动过三次：`:51`/`:65` 被注入化消掉、行号从 49/50 漂到 56/57）。
 * 判据强度不降：**许可上限（组 + 重数）仍是冻结的判据**，实测导出只回答"当前还剩几条"。
 *
 * 返回项带 `line`（**首个实测行号**，仅供报告）与 `lines`（全部实测行号）。
 */
export function derivePendingExemptions(facts, { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles(), registry = APPROVED_COMPOSITION_LEGACY_EDGES } = {}) {
  const baseline = pairMultisetOf(registry.map((e) => pairKeyOf(e.from, e.to)))
  const counted = countCompositionLegacyEdges(facts, { srcRoot, kernelFiles })
  const out = []
  for (const row of counted.pairRows.values()) {
    if (baseline.has(row.pair)) continue
    out.push(
      Object.freeze({
        from: row.file,
        to: row.target,
        pair: row.pair,
        line: Math.min(...row.lines),
        lines: Object.freeze([...row.lines].sort((a, b) => a - b)),
        occurrences: row.occurrences,
        kind: row.kinds[0],
        // 该对**全部**边都是 type-only 才算 type-only 豁免：混入一条值导入 ⇒ `false` ⇒ 「值导入不得借豁免存活」判红。
        isTypeOnly: row.allTypeOnly,
        valueOccurrences: row.anyValue ? row.lines.length : 0,
        exempt: true,
        terminalBatch: 'R1-A 子件②',
      }),
    )
  }
  return out.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0))
}

/** ② 的**机械检测核**（对键 + 重数）：返回"超出许可上限"的说明（空 = 合规）。判据与负对照共用。 */
export function exemptionCeilingViolations(
  exemptions,
  { permitGroups = FROZEN_PERMITTED_EXEMPT_GROUPS, permitTotal = FROZEN_PERMITTED_EXEMPT_TOTAL } = {},
) {
  const out = []
  const groups = new Map()
  let total = 0
  for (const e of exemptions) {
    const n = e.occurrences ?? 1
    const key = `${e.from}→${e.to}`
    groups.set(key, (groups.get(key) ?? 0) + n)
    total += n
    const permitted = permitGroups.find((g) => g.file === e.from && g.target === e.to)
    if (!permitted) {
      out.push(`${e.from}:${e.line} → ${e.to}：该 (file, target) 对不在冻结许可集内（新增绑定必须走基线修订的显式流程，不是往豁免里塞）`)
    }
  }
  for (const [key, count] of groups) {
    const [file, target] = key.split('→')
    const permitted = permitGroups.find((g) => g.file === file && g.target === target)
    if (permitted && count > permitted.permitted) {
      out.push(`${file} → ${target}：豁免重数 ${count} 条，超出许可上限 ${permitted.permitted} 条`)
    }
  }
  if (total > permitTotal) {
    out.push(`豁免总重数 ${total} 超出许可上限 ${permitTotal} 条`)
  }
  return out
}

/**
 * ③ 的读数本体（测试打进日志，供每批合流登记趋势）；`terminal` 是 ④ 的机器可读声明。
 * `exemptionPairs` / `exemptionOccurrences` 是**实测导出**（读数），`permittedCeiling` 是冻结判据。
 */
export function exemptionReading(facts) {
  const exemptions = derivePendingExemptions(facts)
  return {
    exemptionPairs: exemptions.length,
    exemptionOccurrences: exemptions.reduce((n, e) => n + e.occurrences, 0),
    permittedCeiling: FROZEN_PERMITTED_EXEMPT_TOTAL,
    baseline: { files: BASELINE_FILES, pairs: BASELINE_PAIR_COUNT, occurrences: BASELINE_EDGE_OCCURRENCES, commit: BASELINE_COMMIT },
    terminal: 'empty',
    terminalBatch: 'R1-A 子件②（C10 后剩 2 条 type-only；消除路径见许可组注释）',
    ids: exemptions.map((e) => e.pair),
    lineHints: exemptions.map((e) => `${e.from}:${e.line}`),
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
 * | **T1 边消失**（注入化落地） | 模块图里不再有 `kernelOutlinePlanPort.ts → <旧层>` 这条边 | 导出集只包含**实测存在**的对 ⇒ 自动为空 |
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
      id: e.pair,
      occurrences: e.occurrences,
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

/** 实测导出的豁免 → 登记项形态（供"登记 ∪ 豁免"的集合运算；`line` 仅为报告注解）。 */
export function exemptionRegistryEntries(exemptions) {
  return exemptions.map((e) => ({
    from: e.from,
    line: e.line,
    to: e.to,
    kind: 'import',
    reason: `R1-A C9 在途绑定（豁免，终态为空）：${e.from} → ${e.to}`,
    exitStage: 'R1-A 子件②：注入化后从豁免中消失，本批登记随之核销',
    owner: 'R1-A',
  }))
}

/** 生产判据使用的"当前已批准集合" = 冻结基线登记 + 实测导出的具名豁免。 */
export function approvedWithExemptions(facts) {
  return [...APPROVED_COMPOSITION_LEGACY_EDGES, ...exemptionRegistryEntries(derivePendingExemptions(facts))]
}

// ─────────────────────────────────────────────────────────────────────────────
// 三条检测（对键口径）—— 生产判据与负对照**共用**这三个函数。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **检测①：未登记即红（对键 + 重数）**。
 *
 * 实测的对多重集必须 ⊆ 登记集的对多重集。两种失败都报：
 *  - **新对**：登记集里根本没有这个 `(file,target)`；
 *  - **重数溢出**：对已登记，但实测该对的出现次数多于登记（= 往既有去向上加了新绑定）。
 *
 * 失败消息里**带行号**（人类定位用）；行号不参与判定。
 */
export function unregisteredCompositionLegacyEdges(
  facts,
  registry,
  { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles() } = {},
) {
  const declared = pairMultisetOf(registry.map((e) => pairKeyOf(e.from, e.to)))
  const counted = countCompositionLegacyEdges(facts, { srcRoot, kernelFiles })
  const out = []
  for (const row of counted.pairRows.values()) {
    const have = declared.get(row.pair) ?? 0
    const where = row.lines.map((l) => `${row.file}:${l}`).join(', ')
    if (have === 0) {
      out.push(`${where}  → ${row.target}（该 (file, target) 对未登记）`)
    } else if (row.occurrences > have) {
      out.push(
        `${where}  → ${row.target}（该对已登记 ${have} 条，实测 ${row.occurrences} 条 ⇒ 重数溢出）`,
      )
    }
  }
  return out
}

/**
 * **检测②：登记不得腐烂（对键 + 重数）**。
 *
 * 冻结基线的每个对都必须**实测存在**，且**出现次数不得少于登记重数**。
 * 两种失败都报（消息带登记表的**报告注解行号**，供人类定位）：
 *  - `pair-absent`：该对实测一条边都没有（登记腐烂）；
 *  - `occurrence-shortfall`：该对实测条数少于登记重数（有登记被悄悄删掉）。
 */
export function rottenRegisteredPairs(
  facts,
  { srcRoot = SRC_ROOT, kernelFiles = readKernelFiles(), registry = APPROVED_COMPOSITION_LEGACY_EDGES } = {},
) {
  const declared = pairMultisetOf(registry.map((e) => pairKeyOf(e.from, e.to)))
  const counted = countCompositionLegacyEdges(facts, { srcRoot, kernelFiles })
  const lineHints = new Map()
  for (const e of registry) {
    const key = pairKeyOf(e.from, e.to)
    lineHints.set(key, [...(lineHints.get(key) ?? []), e.line])
  }
  const out = []
  for (const [pair, n] of declared) {
    const observed = counted.pairCounts.get(pair) ?? 0
    if (observed === n) continue
    const { from, to } = splitPairKey(pair)
    const hints = (lineHints.get(pair) ?? []).sort((a, b) => a - b)
    const reason = observed === 0 ? 'pair-absent' : 'occurrence-shortfall'
    out.push(
      Object.freeze({
        pair,
        from,
        to,
        declared: n,
        observed,
        lineHints: Object.freeze(hints),
        reason,
        message:
          reason === 'pair-absent'
            ? `${from} → ${to}（登记腐烂：实测已无该 (file,target) 对；登记注解行 ${hints.map((l) => `${from}:${l}`).join(', ')}）`
            : `${from} → ${to}（登记腐烂：登记 ${n} 条，实测只剩 ${observed} 条；登记注解行 ${hints
                .map((l) => `${from}:${l}`)
                .join(', ')}；实测行 ${(counted.pairRows.get(pair)?.lines ?? [])
                .slice()
                .sort((a, b) => a - b)
                .map((l) => `${from}:${l}`)
                .join(', ')}）`,
      }),
    )
  }
  return out.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0))
}

/**
 * **检测③：计数不得增（对键 + 重数上限）**。
 *
 * 上限 = 冻结基线 + 许可豁免（默认 `BASELINE_PAIR_COUNT + PERMITTED_EXEMPT_PAIRS` = 23 对，
 * `BASELINE_EDGE_OCCURRENCES + PERMITTED_EXEMPT_OCCURRENCES` = 30 次）。
 * 两个上限都可注入 ⇒ **负对照（上限压低 1）与生产判据共用本实现**。
 */
export function bindingCountViolations(
  counted,
  {
    pairCap = BASELINE_PAIR_COUNT + PERMITTED_EXEMPT_PAIRS,
    occurrenceCap = BASELINE_EDGE_OCCURRENCES + PERMITTED_EXEMPT_OCCURRENCES,
  } = {},
) {
  const out = []
  if (counted.pairs > pairCap) {
    out.push(
      `实测对计数 ${counted.pairs} 超出冻结上限 ${pairCap} 对`
        + `（冻结基线 ${BASELINE_PAIR_COUNT} 对 + 许可豁免 ${pairCap - BASELINE_PAIR_COUNT} 对）`
        + '—— 新增绑定必须先改基线并写明理由，"可见性与可判定性"不等于"允许增长"（#387 评论 7293）',
    )
  }
  if (counted.occurrences > occurrenceCap) {
    out.push(
      `实测边重数 ${counted.occurrences} 超出冻结上限 ${occurrenceCap} 次`
        + `（冻结基线 ${BASELINE_EDGE_OCCURRENCES} 次 = 旧行键读数的 28 行 + 许可豁免 ${occurrenceCap - BASELINE_EDGE_OCCURRENCES} 次）`,
    )
  }
  return out
}

/**
 * **判定核（三条检测合一）** —— 生产判据与全部负对照都走这一个入口。
 *
 * 顺序与命名对应任务书的三条不许弱化的检测：
 *  - `unregistered` ①：未登记的**新对**（或重数溢出）⇒ 判红；
 *  - `rotted`       ②：冻结集里的对**实测消失/重数不足**（登记腐烂）⇒ 判红；
 *  - `growth`       ③：**计数增长**（对数或重数超上限）⇒ 判红。
 * 另外 `ceiling`（豁免许可上限，② 的豁免半边）同样计入 `violations`。
 *
 * 全部选项可注入 ⇒ 负对照用**同一实现**复现同样的判红输出（不另写判定逻辑）。
 */
export function assessCompositionLegacyBinding(facts, options = {}) {
  const {
    srcRoot = SRC_ROOT,
    kernelFiles = readKernelFiles(),
    registry = APPROVED_COMPOSITION_LEGACY_EDGES,
    permitGroups = FROZEN_PERMITTED_EXEMPT_GROUPS,
    permitTotal = FROZEN_PERMITTED_EXEMPT_TOTAL,
    pairCap = BASELINE_PAIR_COUNT + PERMITTED_EXEMPT_PAIRS,
    occurrenceCap = BASELINE_EDGE_OCCURRENCES + PERMITTED_EXEMPT_OCCURRENCES,
    includeExemptions = true,
  } = options
  const counted = countCompositionLegacyEdges(facts, { srcRoot, kernelFiles })
  const exemptions = derivePendingExemptions(facts, { srcRoot, kernelFiles, registry })
  const ceiling = exemptionCeilingViolations(exemptions, { permitGroups, permitTotal })
  const approved = includeExemptions ? [...registry, ...exemptionRegistryEntries(exemptions)] : registry
  const unregistered = unregisteredCompositionLegacyEdges(facts, approved, { srcRoot, kernelFiles })
  const rotted = rottenRegisteredPairs(facts, { srcRoot, kernelFiles, registry })
  const growth = bindingCountViolations(counted, { pairCap, occurrenceCap })
  return {
    counted,
    exemptions,
    unregistered,
    rotted,
    growth,
    ceiling,
    violations: [...unregistered, ...rotted.map((r) => r.message), ...growth, ...ceiling],
  }
}

/** 逐条登记必须写全的字段（防"登记了但没有理由/没有退出归属/没有负责人"）。 */
export const REGISTRY_REQUIRED_FIELDS = Object.freeze(['from', 'line', 'to', 'kind', 'reason', 'exitStage', 'owner'])

/**
 * **判据键字段**（对键）与**报告注解字段**的法定切分 —— 判据只读前者。
 *
 * 这条切分是可被机械复核的（"行号非键"用例：全表 `line` 扰动后三条检测读数逐项不变），
 * 不是注释里的自我声明。
 */
export const REGISTRY_SEMANTIC_KEY_FIELDS = Object.freeze(['from', 'to'])
export const REGISTRY_REPORT_ONLY_FIELDS = Object.freeze(['line'])
