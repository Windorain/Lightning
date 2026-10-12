/**
 * **P1 内核 · 旧层隔离闸门**（#250 裁决 2026-10-11；B5 退役矩阵 #1/#4/#6 的可执行半边）。
 *
 * ## 为什么需要它，且为什么它**不**在 `boundary-rules.mjs` 里
 *
 * `boundary-rules.mjs` 的 `GATE_RULES` 判的是「新层内部的导入形状」（不得 vue/three/DOM、
 * 不得 barrel 偷渡、跨层须经公共出口）。它**没有**判「新层是否在偷用旧实现」——
 * 那需要一张"旧层清单"，而清单是**本批（P1）才首次有内容**的事实。
 *
 * #1 的删除验收原文要求：「生产消费者不再访问旧权威对象；旧导出删除」，
 * 且**负对照**是「**新 facade 内调用旧 runtime** ⇒ 判红」。
 * 在 P1 的范围内（#252 正文「旧渲染/旧状态通路不改动、不复用」+#250 裁决一），
 * 能落地的正是这条负对照的**可执行半边**：
 *
 *  1. 新内核不得 import 任何旧层（否则就是"新门面包旧核心"）；
 *  2. 旧层不得被新层反向依赖（依赖方向无环，#249 §2.2）；
 *  3. 新层的公开面上不得出现"兼容门面"（转发旧类型的别名 / 重新导出旧模块）；
 *  4. `domain`/`application` 不得出现 Proxy / setter 旁路（A08 负对照的静态面）。
 *
 * ## 为什么放在 `tests/architecture/` 而不是 `src/` 的测试里
 *
 * 它是**边界判据**，与 A01 同族，应随 `npm run test:arch` 一起跑（P11 终局审计会复用）。
 * 它**不**修改 `boundary-rules.mjs` 的 `GATE_RULES` 本体（Lead 裁决：不碰规则本体），
 * 而是独立一条闸门，与 `boundary-scan.test.ts` 并列。
 *
 * ## 旧层清单的来源
 *
 * 取自 `boundary-rules.mjs` 的 `LAYER_DESTINATIONS[*].legacySources` **加上**具体的旧目录名。
 * 用一张显式表而不是"凡是 `src/` 下未登记的目录都算旧" ——
 * 后者会把 `logging`/`types`/`styles` 等中立设施也算成"旧权威对象"，
 * 让判据失真。清单必须逐条可解释。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModuleGraph, WEB_ROOT, SRC_ROOT, extractImports } from './module-graph.mjs'

/**
 * 新内核的文件清单（P1 交付；P3/P4/P6/P9/P7 陆续追加），相对 `src/`。
 *
 * 与 `boundary-rules.mjs` 的 `LAYER_DESTINATIONS.*.activeSubpaths` 同源 ——
 * 两处都列同一批文件是**故意**的：若哪天有人新增 `runtime/xxx.ts` 而忘了登记，
 * 本文件与扫描器会**同时**不覆盖它（而不是一处覆盖一处漏），
 * 由 `kernel-file-registry.test` 那条断言逼着两处一起改。
 *
 * P3（#254）追加：`domain/geometry.ts`、`domain/geometryEditing.ts`、
 * `domain/spatial.ts`、`domain/anchor.ts`、`domain/selection.ts`。
 *
 * P4（#255）追加：`domain/animation.ts`、`domain/materials.ts`、`domain/multiblock.ts`
 * （domain 为整层迁移，故不需登记进 `activeSubpaths`，但必须在此被隔离闸门覆盖）、
 * `application/evaluation.ts`、`runtime/evaluation.ts`。
 *
 * ## P6（#257）追加的登记项
 *
 * - `domain/workspace.ts` —— Area 分割树/编辑器类型/固定目标/绑定的纯状态转移。
 *   它与 `domain/` 其余文件同属**整层迁移**（`domain` 无 `activeSubpaths`），
 *   故本表是它的**判据面**（整层迁移的层由目录本身表达执行面，
 *   但内核隔离这条闸门需要显式清单才能判"它有没有偷用旧层"）。
 * - `runtime/lifecycle.ts` —— 实例与归属资源的记账（P6 登记进 `activeSubpaths`）。
 *
 * P9（#260）追加：`runtime/exportJob.ts`（导出作业，登记进 `activeSubpaths`）
 * 与 `adapters/**` 的格式/存储/宿主适配实现。`adapters/` 是 #249 §4 的目标分层之一，
 * 其新实现同样必须被"内核不得依赖旧层"这条闸门覆盖（它们**不是**旧层，
 * 但也不在旧层的"可以自由引用实现"之列）。
 *
 * `composition/` 与 `editors/` **不在本表**：它们不是"内核"（纯核心），
 * 而是装配根与接线层 —— `composition` 的边界由 `GATE_RULES` 直接覆盖
 * （它是整层新目录，无撞名），`editors` 属呈现侧（允许 Vue/DOM）。
 * 把它们塞进本表会误用"内核不得依赖旧层"这条判据：
 * `editors/` 按设计要与旧组件世界打交道（它**由外壳注入**组件，自己不 import）。
 *
 * ## P7（#258）增量与登记理由
 *
 * | 文件 | 层 | 为什么算"新实现" |
 * |---|---|---|
 * | `domain/input.ts` | `domain` | 纯输入路由（#249 §19.1） |
 * | `domain/textDraft.ts` | `domain` | 文本草稿三态机（#249 §19.1） |
 * | `application/inputCommands.ts` | `application` | 统一命令入口（#249 §19.1） |
 * | `runtime/inputSession.ts` | `runtime` | 输入会话（纯核心，**不得**碰 DOM） |
 * | `runtime/inputPort.ts` | `runtime` | 呈现层声明显式状态的端口 |
 * | `adapters/inputFacts.ts` | `adapters` | DOM 事实提取 + 平台同步动作 |
 * | `adapters/inputBinding.ts` | `adapters` | 事件绑定 + 单一挂载点断言 |
 * | `adapters/shellDom.ts` | `adapters` | 外壳 DOM 事实（从已删的 `wiki/wikiInputShield.ts` 搬出） |
 *
 * 注意 `runtime/inputSession.ts` **不在** `adapters/` —— 它属 `corePurity`，
 * 由 `gate/core-no-dom-globals` 保证它不碰 `document`。事件到事实的翻译在
 * `adapters/inputFacts`：这不是"为了过闸门而挪文件"，而是 #249 §9 明文要求
 * 「浏览器适配器只进行事实提取与平台同步动作」。
 */
export const KERNEL_FILES = [
  'domain/identity.ts',
  'domain/errors.ts',
  'domain/scene.ts',
  'domain/document.ts',
  'domain/editing.ts',
  // P3（#254）几何、坐标关系与固定拓扑形变
  'domain/geometry.ts',
  'domain/geometryEditing.ts',
  'domain/spatial.ts',
  'domain/anchor.ts',
  'domain/selection.ts',
  // P4（#255）时间/轨道/采样、纹理序列、通道装配 + 求值面
  'domain/animation.ts',
  'domain/materials.ts',
  'domain/multiblock.ts',
  // P6（#257）工作区/Area
  'domain/workspace.ts',
  'application/state.ts',
  'application/commands.ts',
  'application/queries.ts',
  'application/evaluation.ts',
  // P9（#260）持久化与固定快照导出：捕获规格（纯）、导出政策（纯）、导出作业接线
  'domain/captureSpec.ts',
  'application/exportPlan.ts',
  'runtime/execution.ts',
  'runtime/scheduling.ts',
  'runtime/effects.ts',
  'runtime/evaluation.ts',
  'runtime/lifecycle.ts',
  'runtime/exportJob.ts',
  // P10（#261）内核→生产接线：宿主侧会话（时间/播放/帧下标的读面与写面）
  'runtime/kernelSession.ts',
  // P9（#260）保存目标适配：写入串行化 + 远端条件版本（A16 适配器层）
  'adapters/saveTarget/coordinator.ts',
  // P9（#260）恢复副本存储适配（A31）：内存端口 + 浏览器薄适配
  'adapters/storage/memory.ts',
  'adapters/storage/browser.ts',
  // P9（#260）文件/工程/发布格式适配（A20）：保真记录、形态判别、字段规矩、
  // Plain/Envelope 编解码、版本迁移、坐标约定、工程格式、文档绑定、发布格式
  'adapters/files/fidelityRecord.ts',
  'adapters/files/legacyShape.ts',
  'adapters/files/legacyFields.ts',
  'adapters/files/plainCodec.ts',
  'adapters/files/envelopeCodec.ts',
  'adapters/files/versionMigration.ts',
  'adapters/files/mcAxisProfile.ts',
  'adapters/files/projectFormat.ts',
  'adapters/files/documentBinding.ts',
  'adapters/files/publishFormat.ts',
  // P9（#260）宿主产物适配（A34）：能力矩阵、宿主传输/补丁、构建 manifest
  'adapters/host/hostCapabilities.ts',
  'adapters/host/artifactTransport.ts',
  'adapters/host/buildManifest.ts',
  // P7（#258）输入路由/焦点/文本草稿：纯路由、草稿三态机、统一命令入口、
  // 输入会话（纯核心）、输入端口、浏览器输入适配器与外壳 DOM 事实
  'domain/input.ts',
  'domain/textDraft.ts',
  'application/inputCommands.ts',
  'runtime/inputSession.ts',
  'runtime/inputPort.ts',
  'adapters/inputFacts.ts',
  'adapters/inputBinding.ts',
  'adapters/shellDom.ts',
  // P10f/E（#301）导出面端口的生产实现（与 `boundary-rules.mjs` 的
  // `adapters.activeSubpaths` 同源，两处必须同改 —— 断言在下面把守）：
  // 离屏渲染端口 + 编码端口 + 设备端口 + 纯 PNG 编码 + 作业装配。
  'adapters/export/pngEncoder.ts',
  'adapters/export/renderDevice.ts',
  'adapters/export/offscreenRenderPort.ts',
  'adapters/export/encoderPort.ts',
  'adapters/export/snapshotExportJob.ts',
]

/**
 * 旧分层（#249 §15 退役矩阵的"旧机制"所在目录），相对 `src/`。
 *
 * 判定用**前缀**匹配：`runtime` 会命中 `runtime/renderEngine.ts`，
 * 但**不会**命中 `runtime/execution.ts`（它在 `KERNEL_FILES` 里，见 `isOldLayerTarget`）。
 *
 * ## 为什么判据以"来源是否落在本表"为准，而不是"来源 ∉ `KERNEL_FILES`"（P2/GF-5 收敛）
 *
 * 「旧层反向依赖内核」的原意是：**旧**实现不得靠 import 新内核续命
 * （#171「新门面包旧核心」的静态指纹）。
 *
 * 若按"来源 ∉ `KERNEL_FILES` ⇒ 旧"判定，那么**任何未登记进内核清单的新层实现**
 * 都会被误判为旧层 —— P6 新建的 `composition/`（装配根，契约 §7 明文允许引用实现）
 * 与 `editors/`（呈现侧接线）首跑即产生三条这类假红；
 * P5 的 `presentation/**` 也踩过同一坑。
 *
 * ⇒ 判据统一为：**来源落在 `OLD_LAYERS` 才算旧**。这比"枚举新层豁免"
 * 更稳：以后任何新层都不需要回来改这条判据（P6 初版就是枚举 `NEW_LAYERS`，
 * 已随合流撤掉 —— 两套排除机制不该并存）。
 */
const OLD_LAYERS = [  'pure',
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
  // 撞名层：旧 runtime 的实现文件（新实现见 KERNEL_FILES）
  'runtime',
]

/** 该模块路径（`src/` 相对、无扩展名）是否属于旧分层。 */
function isOldLayerTarget(rel) {
  const withExt = `${rel}.ts`
  const withVue = `${rel}.vue`
  if (KERNEL_FILES.includes(withExt) || KERNEL_FILES.includes(withVue) || KERNEL_FILES.includes(rel)) return false
  return OLD_LAYERS.some((layer) => rel === layer || rel.startsWith(`${layer}/`))
}

function isProductionRel(rel) {
  if (rel.startsWith('..')) return false
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

/**
 * 读源码并**归一化行尾为 LF**（EOL 脆性的治本处，见 `freeze-convergence.test.ts` 的长注释）。
 *
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF、执行者工具写出的工作树常是 LF。
 * 本文件当下这几条断言（`matchAll(/readonly kind: …/)`、`indexOf('}>')`）恰好不依赖
 * `\n` 字面量，**但**「恰好安全」不是判据 —— 后续任何人加一句 `indexOf('\n\n')`
 * 或 `/\n\n/` 就会重新引入同一缺陷。统一走本入口使"读到的文本恒为 LF"成为文件级前提。
 *
 * 2026-10-11 合流事故：集成树 `96b2e3b` 上 `freeze-convergence.test.ts:303` 因
 * `\n\n` 失配判红（该测试在 LF 树上绿）。
 */
function readSource(absPath) {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

function loadGraph() {
  const { files, facts } = buildModuleGraph()
  // P7（#258）：P7 的输入适配器已登记进 `KERNEL_FILES`，故 `kernelAbs` 只需该表。
  // （P7 初版另立了 `INPUT_ADAPTER_FILES`/`newLayerFiles`；合流后统一到 KERNEL_FILES，
  //  避免"两处清单"这一 P1 明确要避免的形态 —— 见本文件头"两处都列同一批文件是故意的"。）
  const kernelAbs = new Set(KERNEL_FILES.map((rel) => path.join(SRC_ROOT, rel)))
  // 测试文件可以（也应当）为了断言而 import 内核 —— 若把它们算进反向依赖，
  // 判据会把"测试证明新层可用"误报成"旧层依赖新层"（P1 首跑实测到的假红）。
  const prodFacts = facts.filter((f) => isProductionRel(path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')))
  const kernelImports = prodFacts.filter((f) => kernelAbs.has(f.fromFile))
  return { files, facts: prodFacts, allFacts: facts, kernelImports, kernelAbs }
}

function resolveTarget(f) {
  const spec = f.specifier
  if (spec.startsWith('«')) return null
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) return null
  const fromDir = path.dirname(f.fromFile)
  const abs = spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2)) : path.resolve(fromDir, spec)
  const rel = path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/')
  if (rel.startsWith('..')) return null
  return rel.replace(/\.(ts|tsx|mts|vue|js)$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 新内核不得 import 旧层
// ─────────────────────────────────────────────────────────────────────────────

describe('P1 内核隔离：新内核不得依赖任何旧层（#1 负对照「新 facade 内调用旧 runtime」的可执行半边）', () => {
  it(`${KERNEL_FILES.length} 个内核文件（含 P7 输入面）的**全部**内部导入都落在新层内（无一条指向旧目录）`, () => {
    const { kernelImports } = loadGraph()
    const violations = []
    for (const f of kernelImports) {
      const target = resolveTarget(f)
      if (target === null) continue // 外部包/无法解析
      if (isOldLayerTarget(target)) {
        violations.push(`${f.fromRel}:${f.line}  → ${f.specifier}（旧层 ${target.split('/')[0]}）`)
      }
    }
    expect(violations, `新内核出现指向旧层的导入（这就是"新门面包旧核心"）:\n${violations.join('\n')}`).toEqual([])
  })

  it('反空洞真：内核文件确实有内部导入（否则上一条的"0 违规"可能只是"没解析到"）', () => {
    const { kernelImports } = loadGraph()
    const internal = kernelImports.map(resolveTarget).filter((t) => t !== null)
    expect(internal.length, '内核文件之间必须有真实导入（否则断言器空转）').toBeGreaterThan(8)
    // 且确实**解析到**了新层目标
    expect(internal.some((t) => t.startsWith('domain/'))).toBe(true)
    expect(internal.some((t) => t.startsWith('application/'))).toBe(true)
    expect(internal.some((t) => t.startsWith('runtime/'))).toBe(true)
  })

  it('**负对照**：往内核文件里注入一条 `@/runtime/renderEngine` 导入 ⇒ 判红', () => {
    // 与上一条**同一个**判定函数，只换事实来源 —— 证明判据不是恒绿。
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'execution.ts'),
        fromRel: 'src/runtime/execution.ts',
        specifier: '@/runtime/renderEngine',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { RenderEngine } from '@/runtime/renderEngine'",
      },
    ]
    const violations = injected.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations, '新 facade 内调用旧 runtime 必须判红（#1 负对照原文）').toHaveLength(1)
    expect(violations[0]).toBe('runtime/renderEngine')
  })

  it('**负对照**：注入一条 `@/runtime/sessionStore` 的相对形态同样判红（两种说明符都要覆盖）', () => {
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'application', 'queries.ts'),
        fromRel: 'src/application/queries.ts',
        specifier: '../runtime/sessionStore',
        kind: 'import',
        isTypeOnly: false,
        line: 3,
        column: 1,
        syntax: "import { sessionStore } from '../runtime/sessionStore'",
      },
    ]
    const violations = injected.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations).toHaveLength(1)
  })

  it('**负对照**：导入新的 `runtime/scheduling` **不**判红（闸门不得把新层自己也算旧）', () => {
    const own = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'execution.ts'),
        fromRel: 'src/runtime/execution.ts',
        specifier: './scheduling',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { planBatch } from './scheduling'",
      },
      {
        fromFile: path.join(SRC_ROOT, 'application', 'commands.ts'),
        fromRel: 'src/application/commands.ts',
        specifier: '@/domain/scene',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { Scene } from '@/domain/scene'",
      },
    ]
    const violations = own.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations, '新层之间的导入不得被判为旧层依赖').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 旧层反向依赖新内核：**只允许已登记的迁移边**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 已登记的"旧层 → 新内核"迁移边（P4 首次出现）。
 *
 * ## 为什么必须显式登记，而不是把断言放宽
 *
 * 这条闸门存在的理由是「有人在用"新层"给旧路径续命」（文件头原文）。
 * 但它同时挡不住另一件事：**合法的迁移**也需要旧文件 import 新层 ——
 * 否则替代机制永远无法被消费。
 *
 * ⇒ 正确的处理不是"删断言"或"放宽为空"，而是把"哪一条旧→新依赖是**已批准**的"
 * 变成显式事实。于是：
 *  - 未登记的旧→新依赖仍然判红（闸门不放宽）；
 *  - 已登记的每条都必须**真实存在**（登记本身不许腐烂成"曾经有过"）；
 *  - 每条都要写明**理由与退出阶段**（供 P11 终局审计逐条核销）。
 *
 * 与 #250 R-WK-01 的关系：R-WK-01 要求"替代方提供替代接口与删除点清单"，
 * 本表就是那些清单在**依赖方向**上的镜像 —— 谁开始消费新接口、什么时候退出。
 */
const APPROVED_LEGACY_TO_KERNEL_EDGES = [
  Object.freeze({
    from: 'src/workbench/ux/panels/MaterialGallery.vue',
    to: 'domain/materials',
    reason:
      'P4 删除 useMaterialAnimation（每面板独立 RAF + elapsed 累积）后，材质缩略图的帧采样改吃统一时间纯采样器；这是 B5 #11 的替代机制首次被真实消费者使用（#252 的替代验收要求"被至少两个真实消费者证明"，此为业务侧消费者一例）',
    exitStage:
      'P6（工作台/编辑面板重写）把该面板迁到 editors/ 层时，此边随文件迁移自然消失；P11 终局审计应核销本行',
  }),
  Object.freeze({
    from: 'src/application/commands.ts',
    to: 'domain/animation',
    reason:
      '内核层内依赖（application → domain），非旧层依赖；列入此表仅为让"命令面到动画面"的接缝在架构清单里可见',
    exitStage: 'P11 终局审计：此边属新层内部依赖，永久保留',
    internalToKernel: true,
  }),
  // ── P7（#258）输入面：旧外壳/旧配置消费新输入内核 ──────────────────────────
  //
  // P7 把"输入路由"建成新内核（`domain/input` + `runtime/inputSession` +
  // `application/inputCommands`），但**消费者**仍是 P7 当时的旧外壳
  // （`WorkbenchRoot.vue` 与 `workbench/inputHotkeys.ts`）。
  // P6/P2 已重写工作台与面板，这批边在 P10 集成时随旧外壳退场而消失。
  Object.freeze({
    from: 'src/runtime/wm.ts',
    to: 'runtime/inputPort',
    reason:
      'WM 持有输入端口字段（呈现层声明焦点/弹窗/控件绑定等**显式状态**的唯一入口）；`runtime` 是撞名层，故本边需登记',
    exitStage: 'P10 集成：新外壳装配接管 `wm.inputPort` 后，本边随 wm 的旧字段退场；P11 核销',
  }),
  // `WorkbenchRoot.vue → composition/assembleInput` **不登记**：
  // `composition/` 按 P6 的设计**不在 KERNEL_FILES**（它是装配根，不是纯核心；
  // 边界由 `GATE_RULES` 直接覆盖）。故那条边不是"旧层 → 内核"，本表不收
  // （本表的每条都必须指向内核文件，否则"真实存在"检查会判它腐烂）。
  Object.freeze({
    from: 'src/workbench/inputHotkeys.ts',
    to: 'domain/input',
    reason: '工作台快捷键**配置表**类型化（`HotkeyBinding`）；配置归新外壳的模块贡献后消失',
    exitStage: 'P10 集成：键表迁入新外壳的模块贡献；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/inputHotkeys.ts',
    to: 'application/inputCommands',
    reason: '旧 operator 转发实现 `CommandSink` 端口（逐条列明转发项，未接通命令显式拒绝）',
    exitStage: 'P10 集成：换成 `editorCommandSink(editor)` 后删除本行；P11 核销',
  }),
  // ── P7（#258）输入面：旧外壳/旧配置消费新输入内核 ──────────────────────────
  //
  // P7 把"输入路由"建成新内核（`domain/input` + `runtime/inputSession` +
  // `application/inputCommands`），但**消费者**是当时的旧外壳
  // （`WorkbenchRoot.vue` 与 `workbench/inputHotkeys.ts`）。
  // 登记这些边的意义：新层**确实被真实消费者使用**（否则"新层已建成但不生效"
  // 是假完成），同时保证"旧路径偷偷依赖新层续命"与"按计划迁移"可区分。
  Object.freeze({
    from: 'src/composition/assembleInput.ts',
    to: 'runtime/inputPort',
    reason: 'P7 输入面装配根建输入端口；装配根引用各层实现是设计使然（契约 §7）',
    exitStage: 'P10 集成：新外壳装配接管后随本文件迁移；P11 核销',
  }),
  Object.freeze({
    from: 'src/runtime/wm.ts',
    to: 'runtime/inputPort',
    reason:
      'WM 持有输入端口字段（呈现层声明焦点/弹窗/控件绑定等**显式状态**的唯一入口）；`runtime` 是撞名层，故本边需登记',
    exitStage: 'P10 集成：新外壳装配接管 `wm.inputPort` 后，本边随 wm 的旧字段退场；P11 核销',
  }),
  Object.freeze({
    from: 'src/runtime/wm.ts',
    to: 'application/inputCommands',
    reason: '`WM.pendingControlBindings` 的元素类型（P7 晚绑定汇合点：控件先于输入装配挂载）',
    exitStage: 'P10 集成：新外壳用惰性登记取代晚绑定队列后删除本行；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/WorkbenchRoot.vue',
    to: 'adapters/shellDom',
    reason: '外壳 DOM 事实（浮层 Teleport 目标 / Wiki 宿主按键冒泡）由旧外壳消费',
    exitStage: 'P10 集成：新外壳接管后删除本行；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/WorkbenchRoot.vue',
    to: 'application/commands',
    reason: '旧外壳读能力集合常量（`ALL_CAPABILITIES`）交给 P7 输入装配（P2/P6 的 profile 装配尚未覆盖该常量）',
    exitStage: 'P10 集成：新外壳按 profile 装配能力后删除本行；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/WorkbenchRoot.vue',
    to: 'adapters/inputBinding',
    reason: '读 `exclusiveKeydownOwners()` 作为 A22「只挂一条 document keydown」的**结构证据**',
    exitStage: 'P10 集成：断言随 e2e 探针迁入新外壳后删除本行；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/inputHotkeys.ts',
    to: 'domain/errors',
    reason: '未接通旧 operator 的命令 ID 显式返回 `UnsupportedOperation`（**不**静默丢弃）',
    exitStage: 'P10 集成：命令全部接通新写通路后删除本行；P11 核销',
  }),
  // ── P7（#258）合流：P2 的属性字段接入输入层（Lead 裁决 B，本批接通）──────
  Object.freeze({
    from: 'src/workbench/ux/PropertyField.vue',
    to: 'application/inputCommands',
    reason:
      '属性字段按 `ControlBinding` **类型**声明自己（值，不含 setter），使控件身份进入输入层的命令绑定表 —— 这是"草稿提交经唯一入口"的前提',
    exitStage: 'P10 集成：字段模型直接产出控件声明后删除本行；P11 核销',
  }),
  Object.freeze({
    from: 'src/workbench/ux/PropertyField.vue',
    to: 'domain/textDraft',
    reason:
      '字段只声明**草稿种类**（`DraftKind`）；草稿权威（三态机）在输入层。本边是"呈现读核心类型"的最小面',
    exitStage: 'P10 集成：字段模型自带草稿种类后删除本行；P11 核销',
  }),
  // ── P10（#261）内核→生产接线：宿主创建会话并持有它（R-WK-03 的核心内容）──
  //
  // ## 这三条边为什么必须存在，以及它们**不**是"半成品替换"
  //
  // R-WK-03 的裁决依据是「内核在生产代码零调用方」。本批把内核接进生产，
  // 于是**必然**出现"旧层文件引用内核"的三条边 —— 它们正是裁决要求的接线本身：
  //
  //  - `runtime/context.ts`：实例持有会话（读面/写面的送达点）；
  //  - `runtime/host/workbenchHost.ts`：工作台宿主**创建**会话；
  //  - `runtime/host/embedHost.ts`：嵌入宿主创建会话（能力来自嵌入 profile）。
  //
  // 与"半成品替换"的区别是**可判定的**：接线的两端都是新实现
  // （会话 → 内核执行协议），旧机制（`Main` 的两个播放 Ref +
  // `drwMeshPipeline` 的 `setTimeout` 播放调度 + 材质库的 `accMs` 累加器）
  // 在**同一批**被删除，而不是留在那里继续服役。删除后
  // `retirementRegistry` 的 `world-frame-playback` 与 `material-tick` 两组
  // 相位翻 `executed` 并由机器断言把守（全树 0 命中）。
  //
  // ⇒ 退出阶段是"P10 本批"而不是"某个未来批次"：这三条边**不**代表未竟工作，
  // 它们代表接线已落地。P11 审计时应核对的是"旧机制确实零引用"，
  // 而不是"这三条边消失"—— 会话是内核的**生产入口**，它本就该被宿主引用。
  Object.freeze({
    from: 'src/runtime/context.ts',
    to: 'runtime/kernelSession',
    reason:
      '运行实例持有内核会话（构造参数，非模块级单例）——这是"实例隔离"（#249 §19.7）与"内核接线进生产"（R-WK-03）的共同落点；会话提供时间/播放/帧下标的读面与写面',
    exitStage:
      'P10（#261）本批接线落地，永久保留（会话是内核的生产入口）；P11 审计核对的是旧机制零引用，不是本边消失',
  }),
  Object.freeze({
    from: 'src/runtime/host/workbenchHost.ts',
    to: 'runtime/kernelSession',
    reason:
      '工作台宿主**创建**内核会话（R-WK-03「宿主创建 Editor」的落点）；能力集合取自同一装配结果（`shell.assembly.capabilities`），故 profile 裁剪对内核同样生效',
    exitStage: 'P10（#261）本批接线落地，永久保留（宿主创建会话是 R-WK-03 的原文要求）；P11 核销旧机制',
  }),
  Object.freeze({
    from: 'src/runtime/host/embedHost.ts',
    to: 'runtime/kernelSession',
    reason:
      '嵌入宿主创建自己的内核会话（能力来自嵌入 profile ⇒ 无内容编辑能力，A15 的运行时拒绝在嵌入侧同样成立）；与工作台会话互不可见 ⇒ 同页两实例状态隔离',
    exitStage: 'P10（#261）本批接线落地，永久保留；P11 核销旧机制',
  }),
  // ── P10（#261）材质时间：渲染侧消费纯采样（`material-tick` 组的替代面）──
  //
  // 这条边是 `material-tick` 组退役的**替代证据**：三处旧机制（`renderEngine` 的
  // `materialLibrary.tick`、材质库的 `accMs` 累加、图标缓存的 `library.tick(16)`）
  // 被删除后，渲染侧必须有一条**真实的**新路径接住"帧条该显示哪一帧"。
  // 它就是 `domain/materials#sampleStripFrameAt` —— 与 `MaterialGallery.vue`
  // 消费 `sampleTextureSequence` 是同一族（统一时间纯采样），
  // 故本条与 P4 那条 `MaterialGallery → domain/materials` 是同一条政策的两个消费者。
  //
  // 为什么不是"把旧实现搬进新层"：消费的是**纯函数**（时间进、帧出，无状态），
  // 而旧实现是材质库私有的 `accMs` 累加器 —— 前者可被"同一时间 ⇒ 同一结果"
  // 断言，后者不能。见 `simpleMaterialLibrary.ts` 文件头的逐条对照表。
  Object.freeze({
    from: 'src/render/materials/simpleMaterialLibrary.ts',
    to: 'domain/materials',
    reason:
      '材质库改为**无状态纯采样**：`setSceneTime(seconds)` 经 `sampleStripFrameAt` 把场景时间映射成帧条偏移（替代旧 `accMs` 累加器 + `registerTick` 回调）；这是 `material-tick` 组退役的替代机制被真实消费者使用',
    exitStage:
      'P10（#261）本批落地，永久保留（渲染侧消费统一时间纯采样是目标形态，不是过渡）；P11 审计核对旧累加器零引用',
  }),
  // ── P10b（#282）文档内容面：旧加载路径把文档装配进内核 ──────────────────
  //
  // ## P10d（#289）D1：这两条边（`docLifecycleOperators → domain/document` 与
  // `→ application/commands`）**已核销**（登记不得腐烂）
  //
  // D1 把装配实现从该 operator **移进** `composition/documentLoad`
  // （统一两条加载脊柱 —— 见该模块的文件头）。于是 operator 不再直接引用任何
  // **内核文件**，只 import `composition/`。架构闸门（"每条已登记边都真实存在"）
  // 当场判红两行 —— 判红是**对的**：登记表必须与现状一致。
  //
  // 按本判据的既有口径，**`composition/` 是装配根、引用各层是设计使然**
  // （见上方"为什么 `composition/kernelAssembly` 不需要登记"），
  // 故这些边**不该**改登记成 `→ composition/...` —— 那不是"旧→内核"边，
  // 登记它会把装配根的正当引用伪装成一条需审计的迁移边。正确处置是核销。
  //
  // ## "装配有真实生产调用点"没有随登记消失，而是换了**更强**的把守者
  //
  // `composition/__tests__/documentLoadSpines.test.ts` 的「生产源码断言」组
  // 直接断言**两条**脊柱都调 `adoptLoadedDocument`，且 `DocumentSource` 路径
  // 必须传 `plainRootOf(loadResult.raw)`。那断言的是**调用（含参数）**，
  // 比"文件里出现过 import"强。

  // ── P10b（#282）Area 产品接线：旧外壳/旧 operator 消费新 Area 内核 ────────
  // ── P10b（#282）Area 产品接线：旧外壳/旧 operator 消费新 Area 内核 ────────
  //
  // ## 这五条边为什么必须存在，以及它们**不**是"半成品替换"
  //
  // #249 §13 把「Area 可分割、合并、切换类型，切回恢复局部状态」列为基本骨架的
  // 完成边界，A05/A17 的**产品级**判据也依赖它。P6 交付了完整的 Area 内核
  // （`domain/workspace` 纯转移 + `editors/useAreaHost` 接线 + `editors/AreaHost.vue`
  // 生命周期宿主），但**全树零生产消费者** —— 实测：
  //
  //  - `WorkbenchShell.vue` 只有一个 `<slot name="viewport" />`（恒一个 3D 视口）；
  //  - `AreaHost.vue`/`useAreaHost.ts` 只被两处**注释**提到；
  //  - `splitArea` 只在 `designUseCasesS16.test.ts` 的**纯域层**断言里被调用。
  //
  // 本批把它接进产品，于是**必然**出现"旧层引用新 Area 内核"的边 —— 它们正是
  // 接线本身。与"半成品替换"的区别是**可判定的**：
  //
  //  - 消费的是**纯转移 + 显式生命周期**（`splitArea`/`mergeArea`/`setEditorType`、
  //    `LifecycleLedger`），不是"旧实现的新名字"；旧形态是"用 `v-show` 保活组件
  //    来保状态"（§15 第 10 条），那在本批**同批**被替代（布局成为 `Workspace` 的值）；
  //  - 每条边都是**唯一**的接缝：`areaOperators` 是布局命令的**唯一**写入口
  //    （`ctx.requireAreaSession()`），组件只**投影**布局、不持有它。
  //
  // ⇒ 退出阶段是"P10/P11 把工作台外壳与面板迁到 `shells/`+`editors/` 时随文件退场"。
  Object.freeze({
    from: 'src/operators/builtin/areaOperators.ts',
    to: 'domain/workspace',
    reason:
      'P10b（#282）Area 布局命令的**唯一** operator 写入口：`splitArea`/`mergeArea`/`setEditorType`/`setSplitRatio` 的纯转移在此被暴露成命令（菜单可列、快捷键可绑、测试可调），并消费 `SplitDirection` 类型。此前这四条命令只有装配声明（`profiles.ts` 的 `M_LAYOUT_EDIT`）与纯域实现，**零生产调用方**',
    exitStage:
      'P10/P11：`operators/` 被 `application/` 命令面接管、旧 operator 注册表退役时，本边随文件退场；P11 审计核销本行',
  }),
  Object.freeze({
    from: 'src/runtime/host/workbenchHost.ts',
    to: 'domain/workspace',
    reason:
      'P10b（#282）工作台宿主在**装配期**创建 Area 会话的初始布局（`createWorkspace`/`createInitialLayout`）——与"宿主创建内核会话"（`runtime/kernelSession`）同一口径：#249 要求「Area 与编辑器实例的寿命不依赖组件挂载」，故布局必须由宿主创建并挂在 `Context` 上，不能归渲染它的组件的 `ref`（`WorkbenchRoot` 切工作区时会 `:key` 卸载重建子树）',
    exitStage:
      'P10/P11：宿主装配被 `composition/` 的装配根接管时随文件迁移；P11 审计核销本行',
  }),
  Object.freeze({
    from: 'src/workbench/components/AreaLayoutHost.vue',
    to: 'domain/workspace',
    reason:
      'P10b（#282）Area 分割树的**渲染投影**：把 `Workspace.layout`（`AreaLayout` 的 `area`/`split` 两种节点）渲染成递归 flex（`direction` + `ratio`），并按类型注入编辑器组件（#10「组件由外壳注入」，`editors/` 不 import 旧 `workbench/`）。它只**读**布局，不持有它',
    exitStage: 'P10/P11：工作台外壳迁到 `shells/` 层时本组件随之外迁；P11 审计核销本行',
  }),
  Object.freeze({
    from: 'src/workbench/components/AreaNodeView.vue',
    to: 'domain/workspace',
    reason:
      'P10b（#282）递归渲染单元（叶子 ⇒ `AreaHost`；内部节点 ⇒ flex 容器）。用**真递归**而不是"扁平化 + 绝对定位"：`ratio` 是嵌套语义（每次分割只切当前节点），扁平化会丢掉"哪次分割切的是哪一块"这一事实。消费 `AreaLayoutNode` 判别式类型',
    exitStage: 'P10/P11：同 `AreaLayoutHost.vue`（同一组件族），随外壳迁移；P11 审计核销本行',
  }),
  Object.freeze({
    from: 'src/workbench/components/areaViewContext.ts',
    to: 'runtime/lifecycle',
    reason:
      'P10b（#282）Area 渲染树的作用域上下文类型引用 `LifecycleLedger`（A13 资源账本）：递归组件每加深一层若靠层层传 props，会让"加深一层"变成"改 N 个签名"（§15 末段禁止的形态），故经 `provide`/`inject` 传递。账本的**写入**仍唯一经 `AreaHost`（`acquire`/`release`/`closeInstance`）',
    exitStage: 'P10/P11：同 `AreaLayoutHost.vue`（同一组件族），随外壳迁移；P11 审计核销本行',
  }),
]

describe('依赖方向：旧层 → 新内核的**未登记**依赖判红；已登记的迁移边必须真实存在', () => {
  it('旧层文件里指向内核的导入只允许出现在 APPROVED_LEGACY_TO_KERNEL_EDGES 里', () => {
    // 说明：旧层**将来**会迁到新层（上述归口批次），届时这条断言会随迁移一起改。
    // 现在它是"新内核已建成但尚未被旧代码反向依赖"的事实记录 ——
    // 若有旧文件开始 import 内核，说明有人在用"新层"给旧路径续命 —— 必须出现在
    // `APPROVED_LEGACY_TO_KERNEL_EDGES` 里（显式登记，不得静默）。
    //
    // ## 判定面是**文件级**：来源必须是**旧层**，不能是"不在 KERNEL_FILES 里的任何文件"
    //
    // 初版按"来源 ∉ KERNEL_FILES ⇒ 旧"判定。那在只有 P1 那 11 个文件算新层时成立；
    // 但 `boundary-rules.mjs` 的登记表此后已陆续纳入 P5 的 `presentation/**` 等新层实现，
    // 于是"新层 → 新层"的导入（`presentation/compileScene.ts → @/domain/errors`）
    // 会被误判成"旧层反向依赖内核" —— 那是**假红**（与 P1 在 `boundary-rules.mjs`
    // 里把同一条判据改成文件级时踩到的是同一类问题）。
    //
    // 本批（GF-5 收敛）删除了 `presentation/result.ts` 的第二份契约定义，
    // 使 `presentation/compileScene.ts` 直接 import `@/domain/errors` ——
    // 这正是"类型单一来源"的应有结果（向下依赖，层深 2，符合公共出口约束），
    // 不是"用新层给旧路径续命"。故判定改为：**来源落在 OLD_LAYERS 才算旧**。
    //
    // P6 合流时同样受益：`composition/**`（装配根）与 `editors/**`（呈现侧接线）
    // 引用内核是设计使然（契约 §7），落在本判据下**天然不算旧层**，
    // 无需另立"新层豁免清单"（P6 初版的 `NEW_LAYERS` 已随合流删除）。
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const approved = new Set(
      APPROVED_LEGACY_TO_KERNEL_EDGES.filter((e) => e.internalToKernel !== true).map((e) => `${e.from}→${e.to}`),
    )
    const reverse = []
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      if (KERNEL_FILES.includes(fromRel)) continue
      // **来源**必须是旧层（用判据自身的旧层定义，不靠"不在内核清单里"反推）。
      if (!isOldLayerTarget(fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) continue
      const target = resolveTarget(f)
      if (target !== null && kernelNoExt.has(target)) {
        const key = `src/${fromRel}→${target}`
        if (approved.has(key)) continue
        reverse.push(`${f.fromRel}:${f.line}  → ${f.specifier}（未登记的旧→新依赖）`)
      }
    }
    expect(
      reverse,
      `旧层反向依赖内核但未登记（须先登记理由与退出阶段，不得静默）:\n${reverse.join('\n')}`,
    ).toEqual([])
  })

  it('每条已登记边都**真实存在**（登记不得腐烂）', () => {
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const present = new Set<string>()
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      const target = resolveTarget(f)
      if (target === null) continue
      if (!kernelNoExt.has(target)) continue
      present.add(`src/${fromRel}→${target}`)
    }
    for (const e of APPROVED_LEGACY_TO_KERNEL_EDGES) {
      if (e.internalToKernel === true) {
        // 内核内部依赖：断言它**是**新层内部（from 也是内核文件），
        // 否则这条登记会把一条真实的旧→新依赖伪装成"内部边"。
        expect(KERNEL_FILES, `${e.from}→${e.to} 标为内核内部边，但其发起方不在内核文件表内`).toContain(
          e.from.replace(/^src\//, ''),
        )
        continue
      }
      expect(present, `登记的迁移边 ${e.from}→${e.to} 已不存在 —— 请同步核销登记（P11 审计依赖它的准确性）`).toContain(
        `${e.from}→${e.to}`,
      )
      expect(e.reason.length, `${e.from}→${e.to} 必须写明理由`).toBeGreaterThan(20)
      expect(e.exitStage, `${e.from}→${e.to} 必须写明退出阶段`).toMatch(/P\d+/)
    }
  })

  it('**负对照**：未登记的旧→新依赖仍判红（闸门没有因为"有登记表"而失效）', () => {
    // 合成一条未经登记的旧层文件 → 内核文件的导入，走**同一个**判定逻辑。
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const approved = new Set(
      APPROVED_LEGACY_TO_KERNEL_EDGES.filter((e) => e.internalToKernel !== true).map((e) => `${e.from}→${e.to}`),
    )
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'renderEngine.ts'),
        fromRel: 'src/runtime/renderEngine.ts',
        fromSrcRel: 'runtime/renderEngine.ts',
        specifier: '@/application/evaluation',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { evaluateScene } from '@/application/evaluation'",
      },
    ]
    const hits = injected
      .map((f) => ({ f, target: resolveTarget(f) }))
      .filter(({ f, target }) => target !== null && kernelNoExt.has(target) && !approved.has(`src/${f.fromSrcRel}→${target}`))
    expect(hits, '未登记的旧→新依赖必须判红').toHaveLength(1)
  })

  it('反空洞真 + 负对照：内核确实被**新层**依赖，而注入一条旧层导入会被抓到', () => {
    // 反空洞真：收敛后 `presentation/**`（新层）确实 import 内核 ——
    // 若这一条不成立，"旧层零反向依赖"可能只是"没人 import 内核"。
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const newLayerDependents = facts.filter((f) => {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      if (KERNEL_FILES.includes(fromRel)) return false
      if (isOldLayerTarget(fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) return false
      const t = resolveTarget(f)
      return t !== null && kernelNoExt.has(t)
    })
    expect(
      newLayerDependents.length,
      '新层之间存在真实的内核依赖（否则"旧层零反向依赖"是空洞真）',
    ).toBeGreaterThan(0)

    // 负对照：同一判据对**旧层**来源必须判红（证明它不是恒绿）。
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'render', 'someLegacyModule.ts'),
        fromRel: 'render/someLegacyModule.ts',
        specifier: '@/domain/errors',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { err } from '@/domain/errors'",
      },
    ]
    const flagged = injected.filter((f) => {
      if (!isOldLayerTarget(f.fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) return false
      const t = resolveTarget(f)
      return t !== null && kernelNoExt.has(t)
    })
    expect(flagged, '旧层 import 内核必须判红').toHaveLength(1)
  })

  it('**反空洞真**：本判据确实在**执行面**上跑过（内核文件之间真有被 import 的目标）', () => {
    // 上一条的"0 条"只有在"判据确实能命中内核文件"时才有意义。
    // 这里从**内核文件自己**的方向验证：内核之间的导入会被 `kernelNoExt` 命中。
    const { kernelImports } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const internalHits = kernelImports
      .map((f) => resolveTarget(f))
      .filter((t) => t !== null && kernelNoExt.has(t))
    expect(internalHits.length, '内核文件之间必须有真实 import（否则上一条的 0 是空转）').toBeGreaterThan(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 新层公开面上不得出现"兼容门面"
// ─────────────────────────────────────────────────────────────────────────────

describe('无兼容门面：#1 删除验收「旧导出删除」的静态面', () => {
  it('内核文件不重新导出（`export ... from`）任何模块（不造转出口门面）', () => {
    const { kernelImports } = loadGraph()
    const reexports = kernelImports.filter((f) => f.kind === 'export-from')
    expect(
      reexports.map((f) => `${f.fromRel}:${f.line} ${f.syntax}`),
      '内核不得有转出口（否则就是"新门面包旧核心"的入口形态）',
    ).toEqual([])
  })

  it('内核里不出现 `ctx.main` / `Context` / `Main` / `RuntimeDocument` 等旧权威类型名', () => {
    const forbidden = ['RuntimeDocument', 'structEpoch', 'renderViewRevision', 'ref(']
    const hits = []
    for (const rel of KERNEL_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const needle of forbidden) {
        // 只检查**代码文本**（注释里解释"退役了旧机制"是允许且有价值的）
        const codeOnly = text
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join('\n')
        if (codeOnly.includes(needle)) hits.push(`${rel}: ${needle}`)
      }
    }
    expect(hits, '内核代码（非注释）里不得出现旧权威类型/API 名').toEqual([])
  })

  it('**负对照**：把旧类型名放进代码文本会被抓到（证明上一条不是空转）', () => {
    const sample = "import type { RuntimeDocument } from '@/context/runtimeDocument'\nexport function f(d: RuntimeDocument) { return d }"
    const codeOnly = sample.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
    expect(codeOnly.includes('RuntimeDocument')).toBe(true)
    // 同一判据对**注释里的**提及不判红（退役说明需要写"我们不再用 RuntimeDocument"）
    const commentOnly = '/** 说明：本模块不再依赖 RuntimeDocument（#249 §15 第 2 条） */\nexport const x = 1'
    const commentCode = commentOnly.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
    expect(commentCode.includes('RuntimeDocument')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 无 Proxy / setter 旁路（A08 负对照的静态面）
// ─────────────────────────────────────────────────────────────────────────────

describe('唯一写通路（静态面）：内核里没有 Proxy / defineProperty / set 拦截', () => {
  it('内核源码里不出现 `new Proxy` / `Object.defineProperty` / `__defineSetter__`', () => {
    const banned = ['new Proxy', 'Object.defineProperty', '__defineSetter__', 'Object.defineProperties']
    const hits = []
    for (const rel of KERNEL_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const needle of banned) {
        if (text.includes(needle)) hits.push(`${rel}: ${needle}`)
      }
    }
    expect(hits, '契约 §5.2：不存在第二条属性写通路（无 Proxy、无 setter 旁路）').toEqual([])
  })

  it('**负对照**：同一判据能抓到 Proxy（证明不是空转）', () => {
    const sample = 'const p = new Proxy(target, { set(t, k, v) { t[k] = v; return true } })'
    const banned = ['new Proxy', 'Object.defineProperty']
    expect(banned.some((n) => sample.includes(n))).toBe(true)
  })

  it('`setProperty` 是**唯一**的属性写命令（命令联合的封闭性）', () => {
    // 从命令层源码里抽出 `kind:` 字面量集合，断言与契约的命令清单一致 ——
    // 若有人偷偷加一个 `patch`/`setField` 式命令，这条会失败。
    //
    // ## 为什么要读两个文件（#250 GF-5 收敛后的形态）
    //
    // 收敛前 `SetPropertyCommand` 在 `commands.ts` 里**再定义**一份，
    // 故只看该文件就能抽到 `'setProperty'`。收敛后 `commands.ts` 只**再导出**
    // 该类型，唯一权威在 `application/property-commands.ts`（RNA 的公开命令类型）——
    // 只看一个文件会漏掉 `setProperty`，于是这条断言会以"清单少一项"的形式失败。
    //
    // 修正的做法不是把 `setProperty` 从期望清单里删掉（那等于放松判据、
    // 让"属性写命令"从此无人检查），而是**两处都读**：契约的命令联合横跨
    // "命令总表"（`commands.ts`）与"RNA 公开命令"（`property-commands.ts`）。
    const readKinds = (rel: string): string[] => {
      const text = readSource(path.join(SRC_ROOT, rel))
      return [...text.matchAll(/readonly kind: '([a-zA-Z]+)'/g)].map((m) => m[1])
    }
    /** `property-commands.ts` 的 `SetPropertyCommand` 用 `Readonly<{ kind: … }>`（无 `readonly` 前缀）。 */
    const setPropertyKinds = (): string[] => {
      const text = readSource(path.join(SRC_ROOT, 'application/property-commands.ts'))
      const start = text.indexOf('export type SetPropertyCommand')
      expect(start, '`SetPropertyCommand` 必须定义在 `property-commands.ts`').toBeGreaterThan(-1)
      const block = text.slice(start, text.indexOf('}>', start))
      return [...block.matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1])
    }
    const unique = [
      ...new Set([...readKinds('application/commands.ts'), ...setPropertyKinds()]),
    ].sort()
    expect(unique).toEqual(
      [
        'addObject',
        'advancePlayback',
        'beginInteraction',
        'cancelInteraction',
        'closeDocument',
        'commitInteraction',
        'deleteObject',
        'insertKeyframe',
        'openDocument',
        'publishDefault',
        'redo',
        'removeKeyframe',
        'save',
        'saveCompleted',
        'select',
        'setChannelValue',
        'setPlaybackRate',
        'setPlaying',
        'setProperty',
        'setTime',
        'setTrackEnabled',
        'setTransform',
        'undo',
        'updateInteraction',
      ].sort(),
    )
    // **唯一性**：属性写命令恰好一个（不是"清单里有 setProperty 就算过"）。
    // `setChannelValue` 是**编辑上下文**的具名命令（通道取值），不经通用属性写，
    // 且它写的是 context 而不是属性值 —— 故不在这一组里。
    //
    // `setPlaying`/`setPlaybackRate`/`advancePlayback`（P10 补齐的播放命令）同样
    // **不**属这一组：它们写的是 `EditContext` 的播放状态与时间，不是属性值。
    // 注意它们名字里的 `set`/`advance` 会被下面的正则命中 —— 判据因此必须
    // **按语义列举**而不是"含 set 就算属性写"：把播放命令误算成属性写会
    // 让"通用属性写恰好一个"这条断言以假红的形式失败，而那个红没有意义。
    const propertyWrites = unique.filter(
      (k) => /set(Property|Field|Value)|patch|assign|merge|apply/i.test(k),
    )
    expect(propertyWrites, '通用属性写命令必须恰好是 `setProperty`').toEqual(['setProperty'])
    // 明确的负面清单：这些名字一旦出现就意味着"暴露任意字段 patch"
    for (const banned of ['patch', 'setField', 'assign', 'merge', 'applyPatch']) {
      expect(unique, `不得引入 \`${banned}\` 式通用字段写命令（契约 §5.2）`).not.toContain(banned)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.5 全局键盘监听：只许一条（#12 输入面退役的可执行验收，P7 = #258）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **尚未迁移**的全局 `keydown` 监听（逐条登记，含归属批次与理由）。
 *
 * ## 为什么要有这张表
 *
 * #12（输入面）要退役的正是"各处组件自己的 `window.addEventListener('keydown')`"。
 * P7 删掉了其中四条（`wikiInputShield` / `chromeBinder` / `viewportBinder` /
 * 设置抽屉），并建立了**唯一**挂载点 `adapters/inputBinding`。
 *
 * 巡检发现**第五条**：`embed/components/BlockStatsSidebar.vue` 也自挂了一条
 * document keydown（只为 Escape 清空选择）。它属**嵌入外壳**的输入面 ——
 * 嵌入侧的输入装配归 P9/P11，故 P7 **不**擅自改它的行为。
 *
 * 不修**不等于**不登记：一张没人核对的"待办"会退化成"永远不做"。
 * 故把它列在这里，并由下面的断言保证：
 *  - 清单里的每条**确实**存在（否则就是过期条目，必须删）；
 *  - 清单**外**不得出现新的全局 keydown（否则判红 —— 那才是"再长一条"的入口）。
 */
const REGISTERED_GLOBAL_KEYDOWN = [
  Object.freeze({
    file: 'embed/components/BlockStatsSidebar.vue',
    batch: 'P9/P11',
    reason: '嵌入侧 Escape 清空选择；嵌入外壳的输入装配（`EmbedRoot`）归 P9/P11，P7 只装配工作台',
  }),
]

/**
 * **允许**的全局键盘监听（与"待迁移"区分开）。
 *
 * ## 为什么 `adapters/shellDom.ts` 不是违规
 *
 * 该监听**不判定接收者**：它只调 `event.stopPropagation()`，用于 Wiki 宿主下
 * 阻止工作台子树的按键继续冒泡到宿主页面（#249 §9 的"平台同步动作"）。
 * 它不读 `key`、不选命令、不影响谁能收到 —— 归属判定仍只由 `inputBinding` 那一条做。
 *
 * 判据因此按**行为**区分，而不是按"有没有 addEventListener"：
 *  - 违规定义 = 监听里出现 `key`/`code` 判定、`preventDefault`、或命令分发；
 *  - 允许 = 只做 `stopPropagation`（纯事件边界）。
 * 下面用一个**可执行**的检查落实这个区分，而不是靠注释声明。
 */
const ALLOWED_PROPAGATION_ONLY_LISTENERS = ['adapters/shellDom.ts']

/** 该监听是否只做冒泡边界（不含按键判定/默认行为干预）。 */
function isPropagationOnlyListener(file, line) {
  const text = readSource(path.join(SRC_ROOT, file)).split('\n')
  // 回调可能在注册行**之前**定义（`const onKeydown = ... ; addEventListener(...)`），
  // 也可能内联在注册行**之后** —— 故两侧都取一段。
  const slice = text.slice(Math.max(0, line - 1 - 8), line + 10).join('\n')
  const touchesKey = /\b(key|code)\s*[=!]==|switch\s*\(\s*\w*\.(key|code)|preventDefault\(/.test(slice)
  const stopsPropagation = /stopPropagation\(/.test(slice)
  return stopsPropagation && !touchesKey
}

/** 扫全部生产源码，找 `addEventListener('keydown'|'keyup'...)`。 */
function scanGlobalKeydownListeners() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(ts|vue)$/.test(entry.name)) continue
      const rel = path.relative(SRC_ROOT, full).replace(/[\\/]+/g, '/')
      const lines = readSource(full).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        // 只算**代码**（注释里记录"删掉了旧监听"是允许且有价值的）
        const trimmed = raw.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
        if (/addEventListener\(\s*['"`]keydown['"`]/.test(raw) || /addEventListener\(\s*['"`]keyup['"`]/.test(raw)) {
          out.push({ file: rel, line: i + 1, text: trimmed })
        }
      }
    }
  }
  walk(SRC_ROOT)
  return out
}

describe('全局 keyboard 监听清单：唯一挂载点之外必须逐条登记（#12 输入面退役）', () => {
  it('登记表**外**不得出现新的全局 keydown/keyup 监听（多一条即判红）', () => {
    const found = scanGlobalKeydownListeners()
    const registeredFiles = new Set(REGISTERED_GLOBAL_KEYDOWN.map((e) => e.file))
    // 唯一挂载点自己（`adapters/inputBinding`）是**被允许**的那一条
    const allowed = new Set(['adapters/inputBinding.ts', ...registeredFiles, ...ALLOWED_PROPAGATION_ONLY_LISTENERS])
    const unregistered = found.filter((f) => !allowed.has(f.file))
    expect(
      unregistered.map((f) => `${f.file}:${f.line}  ${f.text}`),
      '出现未登记的全局键盘监听（必须迁入 `adapters/inputBinding` 的唯一挂载点，或在此逐条登记归属批次）',
    ).toEqual([])
  })

  it('冒泡边界型监听必须**确实**只做 stopPropagation（不得偷偷变成路由）', () => {
    // 反空洞真：`ALLOWED_PROPAGATION_ONLY_LISTENERS` 不能是"免检白名单"，
    // 否则有人把路由逻辑塞进那个文件就绕过了上面的判据。
    const found = scanGlobalKeydownListeners()
    for (const file of ALLOWED_PROPAGATION_ONLY_LISTENERS) {
      const hits = found.filter((f) => f.file === file)
      expect(hits.length, `${file} 应登记在案（否则白名单条目已过期）`).toBeGreaterThan(0)
      for (const h of hits) {
        expect(
          isPropagationOnlyListener(h.file, h.line),
          `${file}:${h.line} 只允许做 stopPropagation；一旦出现 key 判定/preventDefault 就必须迁入唯一挂载点`,
        ).toBe(true)
      }
    }
  })

  it('反空洞真：唯一挂载点**确实**挂了 keydown（否则上一条"0 未登记"是空转）', () => {
    const found = scanGlobalKeydownListeners()
    expect(
      found.some((f) => f.file === 'adapters/inputBinding.ts'),
      '唯一挂载点必须真实注册 keydown',
    ).toBe(true)
  })

  it('登记表里**没有**已消失的条目（迁移完成后必须同批删表）', () => {
    const found = scanGlobalKeydownListeners()
    const present = new Set(found.map((f) => f.file))
    const stale = REGISTERED_GLOBAL_KEYDOWN.filter((e) => !present.has(e.file)).map(
      (e) => `${e.file}（登记于 ${e.batch}）`,
    )
    expect(stale, `登记表里有已不存在的监听（收口后必须同批删除登记）:\n${stale.join('\n')}`).toEqual([])
  })

  it('P7 已删的四条监听**不再**复活（文档注释提及是允许的，代码不得有）', () => {
    const found = scanGlobalKeydownListeners()
    for (const rel of [
      'wiki/wikiInputShield.ts',
      'runtime/chromeBinder.ts',
      'runtime/viewportBinder.ts',
      'workbench/components/WorkbenchSettingsDrawer.vue',
      'workbench/components/WikiModalsHost.vue',
    ]) {
      expect(
        found.filter((f) => f.file === rel).map((f) => `${f.file}:${f.line}`),
        `${rel} 的全局键盘监听已迁入唯一挂载点，不得复活`,
      ).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 内核文件登记表与边界扫描器同源
// ─────────────────────────────────────────────────────────────────────────────

describe('内核文件登记表', () => {
  it('KERNEL_FILES 的每一项都真实存在（防登记了不存在的文件而"闸门覆盖它"是假象）', () => {
    for (const rel of KERNEL_FILES) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel} 必须存在`).toBe(true)
    }
  })

  it('与 boundary-rules.mjs 的 runtime.activeSubpaths 完全一致（两处必须同改）', async () => {
    const rules = await import('./boundary-rules.mjs')
    const dest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'runtime')
    expect(dest, 'runtime 分层必须登记 activeSubpaths').toBeTruthy()
    const runtimeKernel = KERNEL_FILES.filter((f) => f.startsWith('runtime/')).sort()
    expect(dest.activeSubpaths.slice().sort()).toEqual(runtimeKernel)
    // domain/application 是整层迁移（无 activeSubpaths）⇒ 它们的存在性由目录本身表达
    const domainDest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'domain')
    expect(domainDest.activeSubpaths, 'domain 为整层迁移，不应登记 activeSubpaths').toBeUndefined()
    const appDest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'application')
    expect(appDest.activeSubpaths, 'application 为整层迁移，不应登记 activeSubpaths').toBeUndefined()
  })

  it('adapters 层为**部分迁移**：本批登记的文件全部存在，且 KERNEL_FILES 的 adapters 项与登记一致', async () => {
    const rules = await import('./boundary-rules.mjs')
    const dest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'adapters')
    expect(dest, 'adapters 分层必须存在').toBeTruthy()
    expect(Array.isArray(dest.activeSubpaths), 'P9 起 adapters 必须登记 activeSubpaths（不允许"整层算新"）').toBe(true)
    for (const rel of dest.activeSubpaths) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `登记的 adapters 路径 ${rel} 必须存在`).toBe(true)
    }
    const adapterKernel = KERNEL_FILES.filter((f) => f.startsWith('adapters/')).sort()
    expect(adapterKernel.length, 'P9 必须至少登记一个 adapters 新实现（保存目标适配）').toBeGreaterThan(0)
    expect(dest.activeSubpaths.slice().sort()).toEqual(adapterKernel)
    // 适配器**不**是纯核心（它们本来就该碰 DOM —— #249 §4 规则 4「实现端口」）。
    // P7（#258）的输入事实提取/事件绑定/外壳 DOM 事实都在此列。
    expect(dest.corePurity ?? false, '适配器不得被登记为纯核心（否则 DOM 提取无处可放）').toBe(false)
  })

  it('P7 输入面文件都在闸门执行面内，且**不**被当成纯核心（两层不能混）', async () => {
    const rules = await import('./boundary-rules.mjs')
    const { active } = rules.resolveGateLayers(SRC_ROOT)
    const core = rules.corePurityFileSet(SRC_ROOT)
    const inputAdapters = ['adapters/inputFacts.ts', 'adapters/inputBinding.ts', 'adapters/shellDom.ts']
    for (const rel of inputAdapters) {
      expect(active, `${rel} 必须在闸门执行面内`).toContain(rel)
      expect(core.has(rel), `${rel} 不得被当成纯核心（它按设计要碰 DOM）`).toBe(false)
    }
  })

  it('P7 新增的纯核心文件（domain/input、domain/textDraft、application/inputCommands、runtime/inputSession/inputPort）都在纯核心集合里', async () => {
    const rules = await import('./boundary-rules.mjs')
    const core = rules.corePurityFileSet(SRC_ROOT)
    for (const rel of [
      'domain/input.ts',
      'domain/textDraft.ts',
      'application/inputCommands.ts',
      'runtime/inputSession.ts',
      'runtime/inputPort.ts',
    ]) {
      expect(core.has(rel), `${rel} 必须受 core-no-vue-three / core-no-dom-globals 约束`).toBe(true)
    }
  })

  it('扫描器报告的闸门执行面**包含**全部内核文件（防"登记了但没被扫"）', async () => {
    const rules = await import('./boundary-rules.mjs')
    const { active } = rules.resolveGateLayers(SRC_ROOT)
    for (const rel of KERNEL_FILES) {
      expect(active, `内核文件 ${rel} 必须落在闸门执行面内`).toContain(rel)
    }
  })

  it('内核文件都是**生产**文件（不被 "测试文件不计入" 的规则漏掉）', async () => {
    const mod = await import('./module-graph.mjs')
    for (const rel of KERNEL_FILES) {
      expect(mod.isProductionFile(path.join(SRC_ROOT, rel)), `${rel} 必须算生产文件`).toBe(true)
    }
  })
})

/** 未使用占位，保持 `extractImports` 可达（下游如需按需抽单文件可复用）。 */
void extractImports
void WEB_ROOT
