/**
 * **P4 退役归口与删除点登记**（#250 裁决 R-WK-01 / comment 4851+4875；#249 §15）。
 *
 * ## 为什么需要这个测试文件，而不是"写一份文档"
 *
 * R-WK-01 实施细则（#250 comment 4875）：
 * 「跨区旧文件的退役删除由**文件所在区批次**在同批执行，语义替代方提供
 * **替代接口与删除点清单**……接缝处若交付时上游未合入，执行者显式声明接缝，
 * 由 Lead 排合并顺序，**禁止半成品替换**。」
 *
 * 一份"清单"如果只存在于汇报正文里，它就会在下一批开工时消失（AGENTS.md
 * 「规则进指令，证据进平台」的同一教训：「只存在于评论里的规则 ≈ 不存在」）。
 * 因此本批把清单做成**机器可读的登记 + 断言**：
 *  - 每条删除点带**文件、符号、责任批次、退出阶段**；
 *  - 本批（P4）**已删**的条目必须证明文件/符号**确实不存在**（不是"打算删"）；
 *  - 留给 P5/P6 的条目必须证明"替代机制**已经存在**"（不是"将来会有"）——
 *    否则就是"半成品替换"；
 *  - 越区条目必须标注该区归属批次（P4 **不得**自己删 `render/`、旧 `runtime/`
 *    与 `shared/viewport/` 的文件，见 R-WK-01）。
 *
 * 这个文件是 P11（#262）终局零引用审计的输入，也是 Lead 排合并顺序的依据。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * `web/` 根。
 *
 * 用 `require` 而不是静态 `import`：`tests/architecture/module-graph.mjs` 在
 * `tsconfig.json` 的 `include`（只含 `src/**`）之外，静态导入会让 `vue-tsc`
 * 因缺类型声明报错。本文件的运行时断言不需要类型。
 */
const require_ = createRequire(path.join(process.cwd(), 'noop.js'))
const { WEB_ROOT } = require_(path.join(process.cwd(), 'tests', 'architecture', 'module-graph.mjs')) as {
  WEB_ROOT: string
}

/** 归属批次：`P4` = 本批已删；其余 = 该区批次同批删除。 */
export type RetirementOwner = 'P4' | 'P5' | 'P6' | 'P9' | 'P11'

export interface RetirementEntry {
  /** B5 退役矩阵的条目 slug（与 `boundary-rules.mjs` 的 RETIREMENT_OWNERS 同键）。 */
  readonly matrixSlug: string
  /** §15 行号。 */
  readonly section15Entries: readonly number[]
  /** 被替代的旧机制（一句话；面向读者而非机器）。 */
  readonly removedMechanism: string
  /** 承载旧机制的文件（相对 `web/`）。 */
  readonly file: string
  /** 必须消失的符号（导出名/字段名/函数名）。 */
  readonly symbols: readonly string[]
  /** 责任批次：谁执行这次删除。 */
  readonly owner: RetirementOwner
  /**
   * 与 B5 矩阵 `RETIREMENT_OWNERS[slug].owners` 的差异理由。
   *
   * 存在这个字段的原因是一处**真实的口径分歧**（本批如实登记，未静默抹平）：
   * B5 矩阵把 `frame-sequence-as-animation` 的退出阶段写成「P4 交付同批」，
   * 而 R-WK-01（#250 comment 4851 裁决 2/3 与 comment 4875 实施细则）规定
   * 「跨区旧文件的退役删除由**文件所在区批次**执行」——`render/` 与旧 `runtime/`
   * 属 P5 区。⇒ 同一 slug 下，**业务语义替代**归 P4，**渲染侧文件删除**归 P5。
   *
   * 这不是"改判据"：矩阵的删除验收（"旧播放路径删除；旧文件帧仅在适配时解释"）
   * 不变，只是执行者按区分派。此字段使该分派成为**显式事实**，供 Lead 排合并
   * 顺序与 P11 终局审计时逐条对账（而不是靠读者推断）。
   */
  readonly areaOverrideReason?: string
  /** P4 提供的**替代接口**（相对 `web/` 的模块 + 符号）。 */
  readonly replacement: readonly string[]
  /**
   * 本批是否已删除。
   * `true` ⇒ 断言文件或符号**确实不存在**；
   * `false` ⇒ 断言替代机制**确实存在**且该文件仍在（留给 owner）。
   */
  readonly deletedInP4: boolean
  /** 退出阶段（对齐 #250 B5 矩阵的措辞）。 */
  readonly exitStage: string
}

/**
 * 清单本体。
 *
 * 每条的 `replacement` 都是**本批已交付**的模块与符号 —— 这是"不是半成品替换"
 * 的可执行证明：接缝处的下游批次可以立刻 import 它。
 */
export const RETIREMENT_REGISTRY: readonly RetirementEntry[] = Object.freeze([
  // ── 本批（P4）已删 ────────────────────────────────────────────────────────
  Object.freeze({
    matrixSlug: 'multi-raf-business',
    section15Entries: Object.freeze([6]),
    removedMechanism:
      '材质面板自持 requestAnimationFrame 并累积 elapsed（独立播放循环），与场景时间无关',
    file: 'web/src/workbench/ux/panels/useMaterialAnimation.ts',
    symbols: Object.freeze(['useMaterialAnimation']),
    owner: 'P4',
    replacement: Object.freeze([
      'web/src/domain/materials.ts#sampleTextureSequence',
      'web/src/domain/materials.ts#sampleTextureInstance',
      'web/src/domain/animation.ts#advancePlayhead',
    ]),
    deletedInP4: true,
    exitStage: 'P4 交付同批（文件已删除；调用方 MaterialGallery 改用场景时间 + 纯采样）',
  }),

  // ── 留给 P5：渲染侧播放调度与材质 tick ────────────────────────────────────
  Object.freeze({
    matrixSlug: 'frame-sequence-as-animation',
    section15Entries: Object.freeze([8]),
    removedMechanism:
      '帧序列兼任动画：专用播放调度器（setTimeout 自续）按索引推进世界帧，替代通用轨道',
    file: 'web/src/runtime/drwMeshPipeline.ts',
    symbols: Object.freeze([
      'scheduleNextWorldFrameStep',
      'clearWorldPlaybackSchedule',
      'worldPlaybackTimeoutId',
      'dwellMsForCurrentWorldFrame',
    ]),
    owner: 'P5',
    replacement: Object.freeze([
      'web/src/domain/animation.ts#Playhead',
      'web/src/domain/animation.ts#advancePlayhead',
      'web/src/domain/animation.ts#sampleTrack',
      'web/src/application/evaluation.ts#evaluateScene',
    ]),
    deletedInP4: false,
    exitStage:
      'P5 呈现重写同批删除（语义替代 P4 交付：帧推进改由 Playhead + 通用轨道求值）；删前须由 P5 确认其帧索引消费者已迁移',
    areaOverrideReason:
      'B5 矩阵该 slug 的退出阶段写「P4 交付同批」，而渲染侧文件属 P5 区（R-WK-01）；实际分派：语义替代 P4 已交付，文件删除 P5 执行',
  }),
  Object.freeze({
    matrixSlug: 'multi-raf-business',
    section15Entries: Object.freeze([6]),
    removedMechanism: '旧 renderEngine 的 tick 驱动（含材质库 tick 前推）',
    file: 'web/src/runtime/renderEngine.ts',
    symbols: Object.freeze(['tick']),
    owner: 'P5',
    replacement: Object.freeze(['web/src/domain/materials.ts#sampleTextureSequence']),
    deletedInP4: false,
    exitStage: 'P5 呈现重写同批删除（renderEngine tick 归口渲染批次）',
    areaOverrideReason:
      '同一 slug（multi-raf-business）的渲染侧面：旧 renderEngine 的 tick 归 P5；矩阵该 slug 的 P4 面是材质面板独立 RAF（useMaterialAnimation，本批已删）',
  }),
  Object.freeze({
    matrixSlug: 'material-viewport-tick',
    section15Entries: Object.freeze([11]),
    removedMechanism:
      '材质库内部按 dtMs 累积 accMs 前推帧条偏移（每帧改 texture.offset，非纯采样）',
    file: 'web/src/render/materials/simpleMaterialLibrary.ts',
    symbols: Object.freeze(['tick', 'registerTick', 'applyAnimatedStrip']),
    owner: 'P5',
    replacement: Object.freeze([
      'web/src/domain/materials.ts#sampleTextureSequence',
      'web/src/domain/materials.ts#TextureSample',
    ]),
    deletedInP4: false,
    exitStage:
      'P5 呈现重写同批删除（纹理帧偏移改由统一时间纯采样产出；跳帧/双视口/导出同时间须一致）',
    areaOverrideReason:
      'B5 矩阵该 slug 的退出阶段写「P4 交付同批」，但简单材质库属 render/ 区（P5）。实际分派：P4 交付统一时间与纯采样（已在 domain/materials.ts），render/ 内的 dtMs 累积由 P5 随呈现重写删除',
  }),
  Object.freeze({
    matrixSlug: 'material-viewport-tick',
    section15Entries: Object.freeze([11]),
    removedMechanism: '图标缓存内部以固定 dt（library.tick(16)）前推动画纹理时间',
    file: 'web/src/render/interaction/blockIconCache.ts',
    symbols: Object.freeze(['this.library.tick']),
    owner: 'P5',
    replacement: Object.freeze(['web/src/domain/materials.ts#sampleTextureSequence']),
    deletedInP4: false,
    exitStage: 'P5 呈现重写同批删除（图标绘制同样吃统一时间样本）',
    areaOverrideReason:
      '同一 slug（material-viewport-tick）的另一处消费者：`render/` 区文件内的固定 dt 前推，归 P5 随呈现重写删除（矩阵该 slug 的 P4 面是"统一时间与纯采样"，已交付）',
  }),
  Object.freeze({
    matrixSlug: 'frame-sequence-as-animation',
    section15Entries: Object.freeze([8]),
    removedMechanism: '世界帧播放索引与"正在播放"状态挂在旧权威对象上（Vue Ref）',
    file: 'web/src/runtime/main.ts',
    symbols: Object.freeze(['currentFrameIndex', 'framesPlaybackIsPlaying']),
    owner: 'P5',
    replacement: Object.freeze([
      // 符号用"源码里可搜到的字面量"，而不是 `EditContext.time` 这类文档式路径 ——
      // 否则断言只能匹配到我自己的写法，起不到"接口确实存在"的检查作用。
      'web/src/domain/editing.ts#time: TimeValue',
      'web/src/domain/editing.ts#withTime',
      'web/src/domain/editing.ts#seekContextTime',
      'web/src/domain/animation.ts#Playhead',
      'web/src/domain/animation.ts#seekPlayhead',
    ]),
    deletedInP4: false,
    exitStage: 'P5 呈现重写同批删除（时间权威归 EditContext；播放状态归宿主）',
    areaOverrideReason:
      'B5 矩阵该 slug 只列 P4（"场景 + 通用动画轨道"），而 `runtime/main.ts` 的播放 Ref 属旧 runtime 实现（P5 区）。实际分派：通用轨道能力 P4 已交付，旧 Ref 删除 P5 执行；P11 终局审计时该 slug 应显示"两类事实都已退出"',
  }),

  // ── 留给 P6：每视口通道暂存 ───────────────────────────────────────────────
  Object.freeze({
    matrixSlug: 'per-viewport-staging',
    section15Entries: Object.freeze([4]),
    removedMechanism: '每视口独立暂存通道取值 + revision 计数，靠 watch 推 mesh 重建',
    file: 'web/src/shared/viewport/useMultiblockChannels.ts',
    symbols: Object.freeze(['useMultiblockChannels', 'bindMultiblockMeshSync', 'revision']),
    owner: 'P6',
    replacement: Object.freeze([
      'web/src/domain/editing.ts#channelValues',
      'web/src/domain/editing.ts#withChannelValue',
      'web/src/domain/multiblock.ts#evaluateChannelAssembly',
      'web/src/domain/multiblock.ts#channelWriteAuthority',
      'web/src/domain/multiblock.ts#channelStepTrack',
    ]),
    deletedInP4: false,
    exitStage:
      'P6 视口组件重写同批删除（文件本体归 P6；P4 提供替代接口 —— 通道取值属 EditContext、装配是纯函数、写权逐通道判定）',
  }),
  Object.freeze({
    matrixSlug: 'manual-refresh-chain',
    section15Entries: Object.freeze([5]),
    removedMechanism: '通道取值变化 → 手动链式 loadStructureAndResources + rebuildContentMesh',
    file: 'web/src/shared/viewport/useMultiblockChannels.ts',
    symbols: Object.freeze(['bindMultiblockMeshSync']),
    owner: 'P6',
    replacement: Object.freeze([
      'web/src/application/evaluation.ts#evaluateGraph',
      'web/src/application/evaluation.ts#nodeIdentity',
      'web/src/runtime/evaluation.ts#EvaluationInstance',
    ]),
    deletedInP4: false,
    exitStage: 'P6 视口重写同批删除（失效由依赖图自动传播，无调用方手动 refresh）',
    areaOverrideReason:
      'B5 矩阵该 slug 归口 P5（"依赖图自动失效"），但承载"手动链式刷新"的文件 `shared/viewport/useMultiblockChannels.ts` 属 P6 区（R-WK-01 comment 4875 实施细则）。实际分派：依赖图能力 P4 已交付，该文件删除随 P6 视口重写；清单如实登记这一区归属差异供 Lead 排合并顺序',
  }),

  // ── 留给 P5/P6：旧权威对象的其余消费者 ────────────────────────────────────
  Object.freeze({
    matrixSlug: 'raw-authority-object',
    section15Entries: Object.freeze([1]),
    removedMechanism: '材质/通道消费者经 ctx.main 裸字段与 Vue Ref 读取权威状态',
    file: 'web/src/runtime/context.ts',
    symbols: Object.freeze(['getDoc', 'getStructEpoch', 'getCurrentFrameIndex']),
    owner: 'P5',
    replacement: Object.freeze([
      'web/src/application/queries.ts#ReadView',
      'web/src/runtime/execution.ts#EditorClient',
      'web/src/application/evaluation.ts#EvaluationKey',
    ]),
    deletedInP4: false,
    exitStage:
      'P5/P6 消费者归口同批退出 → P11 终局零引用审计（#250 R-WK-01 裁决 1/2）',
  }),
])

/** 读取 `web/` 相对路径的文本；不存在返回 `null`。 */
function readMaybe(rel: string): string | null {
  const abs = path.join(WEB_ROOT, rel.replace(/^web\//, ''))
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(WEB_ROOT, rel.replace(/^web\//, '')))
}

describe('P4 退役归口登记（R-WK-01 的机器可读删除点清单）', () => {
  it('清单非空且每条都有责任批次、退出阶段与替代接口（反空洞真）', () => {
    expect(RETIREMENT_REGISTRY.length).toBeGreaterThanOrEqual(8)
    for (const e of RETIREMENT_REGISTRY) {
      expect(e.file.startsWith('web/'), `${e.file} 必须是 web/ 相对路径`).toBe(true)
      expect(e.symbols.length, `${e.file} 必须列出要消失的符号`).toBeGreaterThan(0)
      expect(e.replacement.length, `${e.file} 必须给出替代接口`).toBeGreaterThan(0)
      expect(e.exitStage, `${e.file} 必须写明退出阶段`).toMatch(/P\d+/)
      expect(e.section15Entries.length).toBeGreaterThan(0)
      expect(e.matrixSlug).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('**本批已删**的条目：文件与符号**确实不存在**（不是"打算删"）', () => {
    const deleted = RETIREMENT_REGISTRY.filter((e) => e.deletedInP4)
    expect(deleted.length, '本批必须至少删掉一条（否则"同批退役"是空的）').toBeGreaterThan(0)
    for (const e of deleted) {
      expect(exists(e.file), `${e.file} 已登记为本批删除，但它仍然存在`).toBe(false)
      // 全树不得再有该符号的引用（含注释外的代码）
      const hits = grepTree(e.symbols)
      expect(hits, `已删符号仍被引用:\n${hits.join('\n')}`).toEqual([])
    }
  })

  it('**留给其他批次**的条目：替代机制**已存在**（否则就是"半成品替换"）', () => {
    const pending = RETIREMENT_REGISTRY.filter((e) => !e.deletedInP4)
    expect(pending.length).toBeGreaterThan(0)
    for (const e of pending) {
      expect(exists(e.file), `${e.file} 登记的旧机制应仍存在（由 ${e.owner} 删除）`).toBe(true)
      for (const ref of e.replacement) {
        const [file, symbol] = ref.split('#')
        expect(exists(file), `替代接口 ${file} 必须已存在（P4 已交付）`).toBe(true)
        const text = readMaybe(file)
        expect(text, `替代接口 ${file} 必须可读`).not.toBeNull()
        expect(text?.includes(symbol ?? ''), `${file} 必须导出 ${symbol}`).toBe(true)
      }
    }
  })

  it('R-WK-01：P4 **不得**自己删除跨区文件（render/ 与旧 runtime/ 归 P5，shared/viewport/ 归 P6）', () => {
    for (const e of RETIREMENT_REGISTRY) {
      if (!e.deletedInP4) continue
      // 本批只允许删自己区（workbench/ux/panels 的 useMaterialAnimation 例外归 P4）
      const allowed = e.file.startsWith('web/src/workbench/ux/panels/')
      expect(allowed, `P4 越区删除 ${e.file}（R-WK-01：跨区文件由所在区批次删除）`).toBe(true)
    }
  })

  it('归属批次与 B5 退役矩阵 slug 对应（P↔issue 由 #250 表格固定）', () => {
    const rules = require_(path.join(process.cwd(), 'tests', 'architecture', 'boundary-rules.mjs')) as {
      RETIREMENT_OWNERS: Record<string, { entries: readonly number[]; owners: readonly { p: string }[] }>
    }
    const owners = rules.RETIREMENT_OWNERS
    for (const e of RETIREMENT_REGISTRY) {
      const entry = owners[e.matrixSlug]
      expect(entry, `${e.matrixSlug} 必须是 §15 矩阵里的稳定 slug`).toBeTruthy()
      // §15 行号必须落在该 slug 覆盖的范围内
      for (const n of e.section15Entries) {
        expect(entry.entries, `${e.matrixSlug} 的条目应覆盖 §15 第 ${n} 行`).toContain(n)
      }
      // P4 是"已替代"，不是"已退役"：删掉的必须是 P4 自己区里的东西
      if (e.deletedInP4) {
        expect(e.owner).toBe('P4')
      } else if (e.areaOverrideReason === undefined) {
        const listed = entry.owners.map((o: { p: string }) => o.p)
        expect(listed, `${e.matrixSlug} 的归口批次应包含 ${e.owner}`).toContain(e.owner)
      } else {
        // 有区归属差异时：必须给出理由，且该 slug **至少**含一个矩阵归口批次
        // （防止用 override 字段绕过对账 —— 那样清单会与矩阵脱钩）
        const listed = entry.owners.map((o: { p: string }) => o.p)
        expect(listed.length, `${e.matrixSlug} 仍须在矩阵里有归口批次`).toBeGreaterThan(0)
        expect(e.areaOverrideReason.length, 'override 必须写明理由').toBeGreaterThan(20)
      }
    }
  })

  it('P4 的替代接口全部落在本批新层内（不引旧层，R-WK-01「禁止新门面包旧核心」）', () => {
    const newLayers = ['web/src/domain/', 'web/src/application/', 'web/src/runtime/']
    for (const e of RETIREMENT_REGISTRY) {
      for (const ref of e.replacement) {
        const file = ref.split('#')[0]
        expect(
          newLayers.some((p) => file.startsWith(p)),
          `替代接口 ${file} 必须落在本批建成的层内`,
        ).toBe(true)
      }
    }
  })
})

/** 在 `src/` 的生产文件里搜符号（排除注释行）。 */
function grepTree(symbols: readonly string[]): readonly string[] {
  const root = path.join(WEB_ROOT, 'src')
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|vue|mts)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
      const rel = path.relative(WEB_ROOT, full).replace(/[\\/]+/g, '/')
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // 跳过注释行（"退役说明"里提到旧符号是**有价值**的记录，不是引用）
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
        for (const s of symbols) {
          if (s === 'tick') {
            // `tick` 太常见：只认"作为方法调用"的形态，避免把 `ticks` 等误报
            if (new RegExp(`\\.tick\\s*\\(`).test(line)) hits.push(`${rel}:${i + 1} ${line.trim()}`)
          } else if (line.includes(s)) {
            hits.push(`${rel}:${i + 1} ${line.trim()}`)
          }
        }
      }
    }
  }
  walk(root)
  return hits
}

/** 未使用占位：保持 `RetirementOwner` 类型可达（下游按 owner 分组时复用）。 */
export type { RetirementOwner as OwnerAlias }
