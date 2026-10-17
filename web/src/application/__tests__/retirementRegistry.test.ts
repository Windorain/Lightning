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
 * 因此本批把清单做成**机器可读的登记 + 断言**。
 *
 * ## 本文件是 P11（#262）终局零引用审计的输入，也是 Lead 排合并顺序的依据
 *
 * ## 修订记录（P4 内，评审后修正 —— 见下）
 *
 * ### v1（首版，`84d7bd5`）的三处缺陷
 *
 * 首版用**裸子串**匹配符号，且只有"已删 / 未删"二元相位。评审中发现：
 *
 *  1. **判据精度不足 ⇒ 假红**：`getDoc` 会命中 `getDocument`/`getDocumentBinding`/
 *     `getDocumentSourceRegistry` 等 25 处无关符号；`revision` 会命中 `revisionId`/
 *     `revisions`/`BLOCK_ICON_LAYOUT_REVISION` 等 46 处。⇒ P6 即使完成了自己的删除，
 *     该条目也**永远无法翻绿**，而那个红是假的。
 *  2. **相位缺失 ⇒ 登记表在下一相位必然变红**：首版断言"留给 P5/P6 的条目 ⇒ 文件
 *     此刻仍在"。P5/P6 一旦按清单删除，这条断言立刻判红，而那个红只代表"登记表进入
 *     下一相位"，不代表任何问题。后来的读者极可能误读为回归。
 *  3. **跨文件真依赖无法按条目独立翻转**：`renderEngine.ts` 的 `tick` 与
 *     `simpleMaterialLibrary.ts` 的 `tick`、`blockIconCache.ts` 的 `library.tick(16)`
 *     是**同一机制的三处**（互相调用）；`main.ts` 的播放 Ref 被 7 个文件（含 P6 区
 *     视口）引用。按条目逐个翻相位会制造"部分删除即判红"的伪失败。
 *
 * ### v2（本版）的三条修法
 *
 *  - **相位字段**（Lead 裁决"方案 A"）：`status: 'pending' | 'executed'` + `executedBy`。
 *    `pending` ⇒ 文件仍在且替代接口存在；`executed` ⇒ 文件/符号确实不存在。
 *  - **符号判据精确化**：弃裸子串，改为**声明位/调用位级**正则
 *    （`SymbolCriterion.pattern`），并配负对照证明"子串撞名不误红、真残留判红"。
 *  - **同批成组**：`group` 字段；断言改为「**整组** executed 时才要求全树 0 命中」。
 *    组内可跨批次（`groupAreaNotes` 注明各文件所在区归属）。
 *  - 另加：**同文件多条目相位必须一致**（`useMultiblockChannels.ts` 两条 slug 共用一个
 *    文件），否则会出现"一条 executed、一条 pending"却指向同一文件的不自洽态。
 *
 * ### v3（P5 收尾**登记批**，R-WK-03；相位未变，只改事实口径）
 *
 * P5 收尾批（`web-kernel/p05-retire-closeout`）按 Lead 裁决（R-WK-03，登记于 #250）
 * 对本表做**登记修正**，**不删除任何代码**。触发原因是一次侦察实测的结论：
 *
 * > **新内核零生产调用方** —— `runtime/execution.ts`（P1）与 `application/evaluation` /
 * > `runtime/evaluation`（P4）在生产代码（排除 `__tests__`）中**只有注释引用**，
 * > 没有 `new Editor(...)` / 驱动者；`domain/animation.ts#advancePlayhead` 与
 * > `setTime` 命令**亦仅出现在测试**。而播放/纹理动画的**生产唯一来源**恰是待删的旧机制。
 *
 * ⇒ 这三项删除（material-tick 组、`drwMeshPipeline` 播放调度、`renderEngine` 业务 tick）
 * 与 `world-frame-playback` 组、`raw-authority-object` 接缝 B 部分一样，**前置条件是
 * 「内核接线进生产」**，而那是 **#261（P10 集成闭环）** 的核心内容。
 * 把它们记在 P5/P6 名下会让 Lead 排期时以为“删掉就行”；本版据实改记 `owner: 'P10'`。
 *
 * 三条口径修正（均经实测核对，非推断）：
 *  1. **播放状态归 `EditContext`，不归宿主**（Lead 裁决 2026-10-11）：#249 §3.4 时间归
 *     `EditContext`、§1.1-7 共享当前时间 ⇒ 播放是时间的**从属事实**；归宿主会致双视口各播各的。
 *  2. **内核缺口登记**：`domain/editing.ts` 的 `EditContext` 现只有 `time: TimeValue`，
 *     **无** `playing`/`Playhead` 字段；`application/commands.ts` 有 `setTime` 但**无**播放/暂停命令
 *     ⇒ 由 #261 作为接线第一步补齐。
 *  3. **`material-tick` 组不可按条目独立翻转**（组断言 `:969`）已再次确认：
 *     `blockIconCache.ts:399` 的 `library.tick(16)` 本身是“烘焙前推进一拍”的**一次性**调用
 *     （非循环），局部本可改为定时间纯采样；但它与另两处同一机制，故随组同批。
 *
 * 判据（`symbols`/`consumers`）**未改** —— 它们是 P11 终局零引用审计的输入，
 * 本批只改归属与说明字段。相位全部保持 `pending`（机制仍在，反空洞真由 `:958` 断言保证）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as multiblockDomain from '@/domain/multiblock'

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
export type RetirementOwner = 'P4' | 'P5' | 'P6' | 'P9' | 'P10' | 'P11'

/**
 * 退役相位（Lead 裁决"方案 A"）。
 *
 * `pending` = 旧机制仍在（已登记，待所属批次执行）；`executed` = 已删除并核实。
 * 执行方（P5/P6）在同批把自己的条目置 `executed` 并填 `executedBy`。
 */
export type RetirementStatus = 'pending' | 'executed'

/**
 * **位级**符号判据。
 *
 * 为什么不是裸字符串：`getDoc` 作为子串会命中 `getDocument`，`revision` 会命中
 * `revisionId`。用"声明位/调用位"形态（`\bgetDoc\s*\(`、`\.tick\s*\(`）后，
 * 判据描述的是"这个符号被声明或被调用"，而不是"这段文本里出现过这几个字母"。
 *
 * `pattern` 是正则**源字符串**（可序列化、可打印进证据）；`flags` 固定 `g`。
 */
export interface SymbolCriterion {
  /** 人类可读的符号名（诊断与证据里显示这个，而不是正则）。 */
  readonly name: string
  /** 正则源（对**去注释后**的源码生效）。 */
  readonly pattern: string
  /**
   * 作用域：该判据匹配**哪一侧**的出现。
   *
   * 这个字段由第三轮仿真逼出来的（见文件头 v2 修订记录）：同一符号在
   * "自己文件的**声明位**"与"别处的**引用位**"上形态不同，用一个正则同时
   * 覆盖两侧会产生**跨符号误伤**。实测例子：`runtime/context.ts` 的
   * `getDoc` 是 `Context` 的**类成员**（声明 `getDoc(): Ref<…> {`，引用 `ctx.getDoc()`），
   * 而新内核的 `application/commands.ts` 里有一个**同名的私有辅助函数**
   * `function getDoc(state, id)` —— 与本次退役毫无关系。
   *
   * 裸名判据会把那个无关函数算成"消费者"，于是：
   *  - 消费者清单被迫多登记一个文件（清单失真）；
   *  - P5 会被误导去"迁移"一个不需要动的文件。
   *
   * ⇒ `own` 只在自己文件里匹配（声明位），`consumer` 只在别处匹配（引用位，
   * 通常要求点号接收者以排除同名自由函数），`any`（缺省）两侧都匹配
   * （适用于名字足够独特、不存在同名自由函数的符号，如 `currentFrameIndex`）。
   */
  readonly scope?: 'any' | 'own' | 'consumer'
}

export interface RetirementEntry {
  /** B5 退役矩阵的条目 slug（与 `boundary-rules.mjs` 的 RETIREMENT_OWNERS 同键）。 */
  readonly matrixSlug: string
  /** §15 行号。 */
  readonly section15Entries: readonly number[]
  /** 被替代的旧机制（一句话；面向读者而非机器）。 */
  readonly removedMechanism: string
  /** 承载旧机制的文件（相对 `web/`）。 */
  readonly file: string
  /** 必须消失的符号（**位级**判据，不是裸子串）。 */
  readonly symbols: readonly SymbolCriterion[]
  /** 责任批次：谁执行这次删除。 */
  readonly owner: RetirementOwner
  /** 相位。 */
  readonly status: RetirementStatus
  /** 执行方（`status === 'executed'` 时必填，且必须等于 `owner`）。 */
  readonly executedBy?: RetirementOwner
  /**
   * 同批成组 id。
   *
   * 「全树 0 命中」只在**整组**都 `executed` 时才要求：跨文件互相调用的同一机制
   * （如材质 tick 三处）无法按条目独立翻相位 —— 单独翻必然假红。
   */
  readonly group?: string
  /** 组的跨区归属说明（组内可跨批次时必填）。 */
  readonly groupAreaNotes?: string
  /**
   * 与 B5 矩阵 `RETIREMENT_OWNERS[slug].owners` 的差异理由。
   *
   * 存在这个字段的原因是一处**真实的口径分歧**（当年如实登记，未静默抹平）：
   * B5 矩阵曾把 `frame-sequence-as-animation` 的退出阶段写成「P4 交付同批」，
   * 而 R-WK-01 规定「跨区旧文件的退役删除由**文件所在区批次**执行」——
   * `render/` 与旧 `runtime/` 属 P5 区。⇒ 同一 slug 下，**业务语义替代**归 P4，
   * **渲染侧文件删除**归 P5。Lead 已批准该分派（#250）。
   *
   * ## ⚠️ P11-B3 收口（2026-10-13）：矩阵层**已同步**，本字段转为历史依据
   *
   * 上面那句"B5 矩阵写成「P4 交付同批」"描述的是**分歧当时**的状态。该分歧已按
   * #262 附件 1909 在 `web/tests/architecture/boundary-rules.mjs` 的
   * `RETIREMENT_OWNERS` 上**同步为终订值**（#8/#11 的 `exitStage` 与 `owners` 补
   * `P10/#261`；#2/#13 在 P11-B2 已同步）⇒ **矩阵层与现实不再分叉**。
   * 本字段因此不再充当"矩阵字段过时"的补偿，而是保留**逐条改写依据**
   * （谁在何时把哪条 slug 的删除归属从哪个批次改判到 `#261`、理由是什么），
   * 供 P11 终局审计追溯。Gitea 侧历史附件不可变：v3 仍挂在 #250（asset 1008），
   * 终订镜像见 #262 附件 1909。
   */
  readonly areaOverrideReason?: string
  /** P4 提供的**替代接口**（相对 `web/` 的模块 + 符号）。 */
  readonly replacement: readonly string[]
  /**
   * 该条目是否要求**整个文件消失**。
   *
   * 这个字段是评审后的修正（见文件头 v2 修订记录第 4 条）：退役分两类，
   * 混在一个判据里会造出不可能的断言：
   *
   *  - `true` = **整文件退役**（`useMaterialAnimation.ts`、
   *    `shared/viewport/useMultiblockChannels.ts`）⇒ executed 时文件必须不存在；
   *  - `false`（缺省）= **机制退役**：文件会**继续存在**（被重写或裁剪），
   *    只是其中那套机制必须消失（如 `drwMeshPipeline.ts` 仍要渲染，
   *    只是不再自持 `setTimeout` 播放调度；`main.ts` 仍是 `Main` 类，
   *    只是不再挂播放 Ref）。
   *
   * 首版把两者都断言成"文件必须不存在"，对机制退役类是**无法满足**的要求 ——
   * 那会让 P5 完成删除后仍永远红。故拆成两个判据面。
   */
  readonly fileRemoved?: boolean
  /**
   * **消费者清单**（本文件之外仍引用该机制的文件，`web/` 相对）。
   *
   * ## 为什么这是必需的字段，而不是注释里的说明
   *
   * R-WK-01 明文要求「旧机制暂存登记（**消费者清单**、归口、退出阶段，供 #262 对账）」。
   * 首版把这层信息只写在 `groupAreaNotes` 的散文里 —— 于是相位翻转仿真（见文件末）
   * 立刻证明它不够用：仿真在删除 `main.ts` 自身那几行后，`miscOperators.ts` 等
   * 8 个文件仍在引用，判据永远归不了零。**散文无法驱动删除，清单可以。**
   *
   * 本字段使三件事成为机器可查的：
   *  1. **完整性**：实际命中该机制的文件集合必须**恰好等于**本清单
   *     （多一处未登记 ⇒ 判红，防止 P5/P6 漏迁移一个消费者）；
   *  2. **删除面**：仿真据此知道要一并裁剪哪些文件；
   *  3. **归口信息**：配合 `groupAreaNotes` 让 Lead 直接看清跨区依赖。
   *
   * 空数组 = 该机制无外部消费者（如 `drwMeshPipeline.ts` 的播放调度自成一体的那部分）。
   */
  readonly consumers?: readonly string[]
  /** 退出阶段（对齐 #250 B5 矩阵的措辞）。 */
  readonly exitStage: string
}

/** 便捷构造：标识符类判据（词边界 + 可选调用括号）。 */
function ident(name: string): SymbolCriterion {
  return Object.freeze({ name, pattern: `\\b${name}\\b` })
}

/** 便捷构造：调用位判据（`name(`，可带前缀点）。 */
function callSite(name: string, opts: { dotted?: boolean } = {}): SymbolCriterion {
  const prefix = opts.dotted === true ? '\\.' : '\\b'
  return Object.freeze({ name: opts.dotted === true ? `.${name}()` : `${name}()`, pattern: `${prefix}${name}\\s*\\(` })
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
    symbols: Object.freeze([callSite('useMaterialAnimation')]),
    owner: 'P4',
    status: 'executed',
    executedBy: 'P4',
    fileRemoved: true,
    // 本批退役时其唯一消费者（MaterialGallery.vue）已在**同批**改吃场景时间 + 纯采样，
    // 故现在无残留消费者。此字段为空数组而**不是**缺省：显式表达"已核实为零"。
    consumers: Object.freeze([]),
    replacement: Object.freeze([
      'web/src/domain/materials.ts#sampleTextureSequence',
      'web/src/domain/materials.ts#sampleTextureInstance',
      'web/src/domain/animation.ts#advancePlayhead',
    ]),
    exitStage: 'P4 交付同批（文件已删除；调用方 MaterialGallery 改用场景时间 + 纯采样）',
  }),

  // ── P10（#261）已删：渲染侧播放调度（R-WK-03 的核心删除项） ───────────────
  Object.freeze({
    matrixSlug: 'frame-sequence-as-animation',
    section15Entries: Object.freeze([8]),
    removedMechanism:
      '帧序列兼任动画：专用播放调度器（setTimeout 自续）按索引推进世界帧，替代通用轨道',
    file: 'web/src/runtime/drwMeshPipeline.ts',
    symbols: Object.freeze([
      ident('scheduleNextWorldFrameStep'),
      ident('clearWorldPlaybackSchedule'),
      ident('worldPlaybackTimeoutId'),
      ident('dwellMsForCurrentWorldFrame'),
    ]),
    owner: 'P10',
    status: 'executed',
    executedBy: 'P10',
    // 该播放调度自成一体的部分：四个符号只在本文件内出现（已实测 0 外部消费者）。
    consumers: Object.freeze([]),
    replacement: Object.freeze([
      'web/src/domain/animation.ts#Playhead',
      'web/src/domain/animation.ts#advancePlayhead',
      'web/src/domain/animation.ts#sampleTrack',
      'web/src/application/evaluation.ts#evaluateScene',
    ]),
    exitStage:
      'P10（#261）集成闭环同批删除（**已执行**）：旧 `setTimeout` 自续播放调度已删除；帧下标改由 `EditContext.time` 经离散阶跃采样派生（`runtime/kernelSession#frameIndex`），时间由宿主帧时钟（`composition/kernelRuntime`）按帧注入 `advancePlayback` 命令',
    areaOverrideReason: 'R-WK-03：B5 矩阵该 slug 退出阶段写「P4 交付同批」且渲染侧文件属 P5 区（R-WK-01）；P5 收尾批侦察实测「语义替代 P4 已交付但零生产接线」，故删除前置条件变为 #261 集成闭环（已在本批完成）',
  }),

  // ── P10（#261）已删：材质 tick（**同组**，三处互相调用，同批删除） ──────────
  Object.freeze({
    matrixSlug: 'multi-raf-business',
    section15Entries: Object.freeze([6]),
    removedMechanism: '旧 renderEngine 的 tick 驱动（含材质库 tick 前推）',
    file: 'web/src/runtime/renderEngine.ts',
    // **调用位**且钉死接收者：`opts.materialLibrary.tick(…)`。
    // 不能写成裸 `.tick(` —— 那会跨文件命中 `blockIconCache.ts` 的
    // `this.library.tick(16)`（**另一个**消费者），把"本文件的行"与
    // "别人的行"混为一谈（首版实测：消费者清单因此多出一个文件）。
    symbols: Object.freeze([Object.freeze({ name: 'materialLibrary.tick()', pattern: 'materialLibrary\\.tick\\s*\\(' })]),
    owner: 'P10',
    status: 'executed',
    executedBy: 'P10',
    consumers: Object.freeze([]),
    group: 'material-tick',
    groupAreaNotes: '同 `material-tick` 组：三处同属 P5 区（`runtime/`、`render/`）且互相调用 —— `renderEngine.ts:101` 调 `materialLibrary.tick(…)`、`blockIconCache.ts:399` 调 `library.tick(16)`、`simpleMaterialLibrary.ts` 实现 `tick`/`registerTick`，必须**同批**删除（按条目逐个翻相位必然假红）。**R-WK-03 登记 → P10 执行**：三者与全树唯一帧时钟同在 `renderEngine` 的 RAF 内，删除前置条件是内核接线生产（已在 #261 完成）。',
    replacement: Object.freeze([
      'web/src/domain/materials.ts#sampleTextureSequence',
      'web/src/domain/animation.ts#advancePlayhead',
    ]),
    exitStage:
      'P10（#261）集成闭环同批删除（**已执行**）：`renderEngine` 的 RAF 已不再持有时间语义（只做绘制）；材质时间改由 `composition/kernelRuntime` 的场景时间经 `SimpleMaterialLibrary#setSceneTime` 注入（纯采样，无累加器）',
    areaOverrideReason: 'R-WK-03：B5 矩阵该 slug 的 P4 面是材质面板独立 RAF（已删），渲染侧面（旧 renderEngine tick）原归 P5；侦察实测新内核零生产调用方，删除前置条件变为 #261 集成闭环（已在本批完成）',
  }),
  Object.freeze({
    matrixSlug: 'material-viewport-tick',
    section15Entries: Object.freeze([11]),
    removedMechanism:
      '材质库内部按 dtMs 累积 accMs 前推帧条偏移（每帧改 texture.offset，非纯采样）',
    file: 'web/src/render/materials/simpleMaterialLibrary.ts',
    symbols: Object.freeze([
      ident('registerTick'),
      ident('applyAnimatedStrip'),
      // **声明位**判据：`tick` 作为**成员声明**（`tick(deltaMs: number): void {`），
      // 不是点号调用（`x.tick(`）。用 `(?<!\.)` 负向后顾把它与调用位区分开 ——
      // 否则该判据会与 renderEngine 的调用位判据重叠，使"两处机制分别核销"失真。
      Object.freeze({ name: 'tick（声明位）', pattern: '(?<!\\.)\\btick\\s*\\(' }),
    ]),
    owner: 'P10',
    status: 'executed',
    executedBy: 'P10',
    // ## ⚠️ P11-B3 修正：消费者清单**腐烂** ⇒ 修正为空集（实测）
    //
    // 旧值 `['web/src/runtime/renderEngine.ts']` 是 P5 收尾批写下的事实，但 #261 删完
    // 三处机制后它**不再成立**：实测（判据本尊口径 = 本条 `symbols` 的三个判据点）
    // `runtime/renderEngine.ts` 对 `registerTick` / `applyAnimatedStrip` / `tick` 声明位
    // **各 0 命中** —— 该文件只剩 `import type { MaterialLibraryApi }`（`:4`）、
    // 接口字段声明（`:20`）与**注释里的**旧调用示例（`:40`/`:142`，注释被词法器剥除）。
    // ⇒ 机制无外部消费者，清单按新口径显式登记空集（与同组另两条一致）。
    // 该腐烂此前不可见：旧完备断言对 `executed` 条目 `continue`（P11-B3 已取消该豁免，
    // 见 `consumerListDiff` 与其负对照用例）。
    consumers: Object.freeze([]),
    group: 'material-tick',
    groupAreaNotes: '同 `material-tick` 组（见 renderEngine.ts 条目的完整说明）。**R-WK-03 → P10 执行**：`accMs += dtMs` 累积是纹理动画的生产唯一来源，删除前置条件是内核接线生产（已在 #261 完成）。',
    replacement: Object.freeze([
      'web/src/domain/materials.ts#sampleTextureSequence',
      'web/src/domain/materials.ts#TextureSample',
    ]),
    exitStage:
      'P10（#261）集成闭环同批删除（**已执行**）：纹理帧偏移改由统一时间纯采样（`domain/materials.ts#sampleStripFrameAt`）产出，材质库无状态（`setSceneTime(seconds)` 时间进、帧出）',
    areaOverrideReason: 'R-WK-03：B5 矩阵该 slug 退出阶段写「P4 交付同批」，但简单材质库属 render/ 区（P5）；P4 已交付纯采样，删除前置条件变为 #261 集成闭环（已在本批完成）',
  }),
  Object.freeze({
    matrixSlug: 'material-viewport-tick',
    section15Entries: Object.freeze([11]),
    removedMechanism: '图标缓存内部以固定 dt（library.tick(16)）前推动画纹理时间',
    file: 'web/src/render/interaction/blockIconCache.ts',
    // **位级**：`this.library.tick(16)` 这个调用位，不是裸 `tick`。
    symbols: Object.freeze([Object.freeze({ name: 'library.tick()', pattern: '\\.library\\.tick\\s*\\(' })]),
    owner: 'P10',
    status: 'executed',
    executedBy: 'P10',
    // 该调用位只在 blockIconCache.ts 自己文件内（已实测 0 外部消费者）。
    consumers: Object.freeze([]),
    group: 'material-tick',
    groupAreaNotes: '同 `material-tick` 组（见 renderEngine.ts 条目的完整说明）。**R-WK-03 → P10 执行**：本处的 `this.library.tick(16)` 是"烘焙前推进一拍"的一次性调用，已改为在**定义好的烘焙时间**（0 秒）纯采样。',
    replacement: Object.freeze(['web/src/domain/materials.ts#sampleTextureSequence']),
    exitStage:
      'P10（#261）集成闭环同批删除（**已执行**）：图标绘制改在定义好的烘焙时间（0 秒）纯采样（`library.setSceneTime(0)`）—— 图标是静态缩略图，不随播放位置变化',
    areaOverrideReason: 'R-WK-03：同一 slug 的另一处消费者（`render/` 区固定 dt 前推）；P4 已交付纯采样，删除前置条件变为 #261 集成闭环（已在本批完成）',
  }),

  // ── P10（#261）已删：世界帧播放 Ref（**跨区同组**） ────────────────────────
  Object.freeze({
    matrixSlug: 'frame-sequence-as-animation',
    section15Entries: Object.freeze([8]),
    removedMechanism: '世界帧播放索引与"正在播放"状态挂在旧权威对象上（Vue Ref）',
    file: 'web/src/runtime/main.ts',
    symbols: Object.freeze([ident('currentFrameIndex'), ident('framesPlaybackIsPlaying')]),
    owner: 'P10',
    status: 'executed',
    executedBy: 'P10',
    group: 'world-frame-playback',
    // 两个字段删除后，全树零引用 ⇒ 消费者清单为空（**显式**表达"已核实为零"，
    // 而不是缺省；与 P4 那条 `useMaterialAnimation` 的处置同一口径）。
    consumers: Object.freeze([]),
    groupAreaNotes:
      '**跨区组**：权威字段原在 `runtime/main.ts`（P5 区），消费者分布在 P5 区（`runtime/drw.ts`、`runtime/drwMeshPipeline.ts`、`runtime/context.ts`）与 **P6 区**（`shared/viewport/`、`workbench/components/WorkbenchViewport.vue`）以及 `operators/builtin/miscOperators.ts`。**R-WK-03 裁决（修正）→ P10 执行完成**：内核接线生产已在 #261 落地（`runtime/kernelSession` + `composition/kernelRuntime`），故两个字段本体**已删除**，全部消费者改吃 `Context.requireKernelSession()`。**播放状态归属**：归 `EditContext`（`playing` + `playbackRate`），不归宿主。',
    replacement: Object.freeze([
      // 符号用"源码里可搜到的字面量"，而不是 `EditContext.time` 这类文档式路径 ——
      // 否则断言只能匹配到我自己的写法，起不到"接口确实存在"的检查作用。
      'web/src/domain/editing.ts#time: TimeValue',
      'web/src/domain/editing.ts#withTime',
      'web/src/domain/editing.ts#seekContextTime',
      'web/src/domain/animation.ts#Playhead',
      'web/src/domain/animation.ts#seekPlayhead',
    ]),
    exitStage:
      'P10（#261）集成闭环同批删除（**已执行**）：**播放状态归 EditContext**（`playing`/`playbackRate` 字段 + `setPlaying`/`setPlaybackRate`/`advancePlayback` 命令）；帧下标改由 `EditContext.time` 经离散阶跃采样派生（`runtime/kernelSession#frameIndex`）；时间由宿主帧时钟按帧注入',
    areaOverrideReason: 'R-WK-03：B5 矩阵该 slug 只列 P4（"场景 + 通用轨道"），而播放 Ref 属旧 runtime 实现、且消费者跨 P5/P6 两区；Lead 裁决（2026-10-11）目标批次改为 #261 集成闭环，并修正语义口径为「播放状态归 EditContext」（原写"归宿主"，会致双视口各播各的）。前置条件（宿主驱动接线 + EditContext 补齐 playing 字段与 playback 命令）已在本批完成。',
  }),

  // ── P10b（#282）已执行：每视口通道暂存（**同文件两条 slug**） ──────────────
  //
  // 本组在 #282（P10b）**同批翻转 executed**：文件已删除，取值改经
  // `EditContext.channelValues`（`runtime/kernelSession` 的 `channelValues()`/
  // `setChannelValue()` 薄转发，写面走既有的 `setChannelValue` 命令），
  // 手动刷新链由"渲染侧按**内容身份**自行判定"取代
  // （`presentation/contentIdentity` + `contentRefreshTick`）。
  //
  // 机械证据（本批实测）：`multiblock-channel-traversal.spec.ts` 的**全 552 组合遍历**
  // 在改后仍全绿，且 `lsc-overlap` 的 108/108 组合**逐格 diff = 0**
  // —— 即"取值变化真的驱动了重建"，而不是"链断了但没断言"。
  Object.freeze({
    matrixSlug: 'per-viewport-staging',
    section15Entries: Object.freeze([4]),
    removedMechanism: '每视口独立暂存通道取值 + revision 计数，靠 watch 推 mesh 重建',
    file: 'web/src/shared/viewport/useMultiblockChannels.ts',
    symbols: Object.freeze([
      callSite('useMultiblockChannels'),
      callSite('bindMultiblockMeshSync'),
      // 相位变量本身不是稳定导出名，故用**调用位**钉它：`bindMultiblockMeshSync(revision, …)`
      Object.freeze({ name: 'bindMultiblockMeshSync(revision, …)', pattern: 'bindMultiblockMeshSync\\(\\s*revision\\b' }),
    ]),
    owner: 'P6',
    status: 'executed',
    executedBy: 'P6',
    fileRemoved: true,
    // 已 executed ⇒ 消费者清单核销为**空**：两个视口已改吃内核读面
    // （`useKernelChannels`），不再引用本机制。清单腐烂会被
    // "消费者清单必须完整"的 `extra` 断言判红，故必须同步核销。
    consumers: Object.freeze([]),
    group: 'multiblock-channel-staging',
    groupAreaNotes:
      '组内两条 slug 共用一个文件（`useMultiblockChannels.ts`，P6 区），同批翻转。'
      + '**R-WK-04（#250，2026-10-11）**：本条的**文档内容面**归 **#282（P10b）**，'
      + '已在本批执行 —— 取值迁到 `EditContext.channelValues`，视口改吃内核读面。',
    replacement: Object.freeze([
      'web/src/domain/editing.ts#channelValues',
      'web/src/domain/editing.ts#withChannelValue',
      // M5-5：原替代接口列的 `evaluateChannelAssembly`/`channelWriteAuthority` 已**删除**
      // （零生产消费者、且与生产"只夹取不拒绝"的口径相反）。现值层的唯一权威是：
      'web/src/domain/multiblockSelection.ts#projectMultiblockSelection',
      'web/src/domain/multiblock.ts#sampleChannelAt',
      'web/src/runtime/kernelSession.ts#channelValues',
    ]),
    exitStage:
      'P10b（#282）**已执行**：文件删除，取值归 `EditContext`、写入经 `setChannelValue` 命令、'
      + '失效由渲染侧按内容身份判定（无调用方手动 refresh）',
  }),
  Object.freeze({
    matrixSlug: 'manual-refresh-chain',
    section15Entries: Object.freeze([5]),
    removedMechanism: '通道取值变化 → 手动链式 loadStructureAndResources + rebuildContentMesh',
    file: 'web/src/shared/viewport/useMultiblockChannels.ts',
    symbols: Object.freeze([callSite('bindMultiblockMeshSync')]),
    owner: 'P6',
    status: 'executed',
    executedBy: 'P6',
    fileRemoved: true,
    // 已 executed ⇒ 消费者清单核销为**空**（两个视口已不再引用本机制）。
    consumers: Object.freeze([]),
    group: 'multiblock-channel-staging',
    groupAreaNotes:
      '组内两条 slug 共用一个文件（`useMultiblockChannels.ts`，P6 区），同批翻转。'
      + '**R-WK-04（#250）**：文档内容面归 **#282（P10b）**，已在本批执行。',
    replacement: Object.freeze([
      'web/src/application/evaluation.ts#evaluateGraph',
      'web/src/application/evaluation.ts#nodeIdentity',
      'web/src/runtime/evaluation.ts#EvaluationInstance',
    ]),
    exitStage:
      'P10b（#282）**已执行**：手动链删除，失效由内容身份自动判定'
      + '（`presentation/contentIdentity` 的 `contentIdentityOf`/`planContentRebuild`，'
      + '由 `contentRefreshTick` 观察者驱动）；全 552 组合遍历 + 108/108 逐格 diff=0 为机械证据',
    areaOverrideReason:
      'B5 矩阵该 slug 归口 P5（"依赖图自动失效"），但承载"手动链式刷新"的文件 `shared/viewport/useMultiblockChannels.ts` 属 P6 区（R-WK-01 comment 4875 实施细则）。实际分派：依赖图能力 P4 已交付，该文件删除随 P6 视口重写；本批（#282）执行删除并如实登记区归属差异',
  }),

  // ── 留给 P5/P6：旧权威对象的其余消费者（跨区，独立相位） ──────────────────
  Object.freeze({
    matrixSlug: 'raw-authority-object',
    section15Entries: Object.freeze([1]),
    removedMechanism: '材质/通道消费者经 ctx.main 裸字段与 Vue Ref 读取权威状态',
    file: 'web/src/runtime/context.ts',
    // **位级 + 作用域**判据（见 `SymbolCriterion.scope`）：
    //  - `own`（本文件）：类成员**声明位** `getDoc(): Ref<…> {`
    //    （不带点号 —— 声明位上没有接收者）；
    //  - `consumer`（别处）：**引用位** `ctx.getDoc()`，要求点号接收者，
    //    以排除新内核里那个**同名但无关**的私有辅助函数
    //    `application/commands.ts` 的 `function getDoc(state, id)`。
    //
    // 首版与第二版都漏了这一层：一个裸 `\bgetDoc\s*\(` 会把那个无关函数算成消费者，
    // 于是消费者清单被迫多登记一个文件、并误导 P5 去改它（端到端仿真实测抓出）。
    symbols: Object.freeze([
      Object.freeze({ name: 'getDoc（声明位）', pattern: '\\bgetDoc\\s*\\(', scope: 'own' as const }),
      Object.freeze({ name: 'getDoc（引用位）', pattern: '\\.getDoc\\s*\\(', scope: 'consumer' as const }),
      Object.freeze({ name: 'getStructEpoch（声明位）', pattern: '\\bgetStructEpoch\\s*\\(', scope: 'own' as const }),
      Object.freeze({ name: 'getStructEpoch（引用位）', pattern: '\\.getStructEpoch\\s*\\(', scope: 'consumer' as const }),
      Object.freeze({ name: 'getCurrentFrameIndex（声明位）', pattern: '\\bgetCurrentFrameIndex\\s*\\(', scope: 'own' as const }),
      Object.freeze({ name: 'getCurrentFrameIndex（引用位）', pattern: '\\.getCurrentFrameIndex\\s*\\(', scope: 'consumer' as const }),
    ]),
    owner: 'P10',
    // ── #301 P10f D3（本批）**翻相位** ──────────────────────────────────────
    //
    // 判据本尊口径实测：`getDoc` 全树 **0 命中 / 0 文件**（探针直接调本文件的
    // `codeOfSource` + 逐条 `symbols`/`scope`，与断言同一把尺子）。
    // ⇒ 声明位（`runtime/context.ts`）与 46 处消费位（18 文件）同时归零。
    //
    // ⚠️ **删除与翻相位必须同一提交**：本表的"`pending` 的机制退役类：判据此刻
    // **仍有命中**"断言会在只改一边时判红 —— 那是刻意的（防"半删"）。
    status: 'executed',
    executedBy: 'P10',
    // 已 executed ⇒ 消费者清单核销为**空**（"清单腐烂"断言会因非空判红）。
    consumers: Object.freeze([]),
    replacement: Object.freeze([
      'web/src/application/queries.ts#ReadView',
      'web/src/runtime/execution.ts#EditorClient',
      'web/src/application/evaluation.ts#EvaluationKey',
    ]),
    exitStage:
      '**R-WK-04（#250，2026-10-11）裁决：本条的文档内容面归 #282（P10b 批次）**。'
      + '#261 已完成的部分：宿主驱动接线（`runtime/kernelSession` + `composition/kernelRuntime`）'
      + '与 `ReadView` 读面补齐（相机组 + 播放读面）；`getCurrentFrameIndex` 声明位/引用位已全树归零'
      + '（帧下标改为时间派生）。**未完成的部分**：`getDoc()` 本身及其 31 个消费者 —— '
      + '把工作台文档内容迁到内核 `Document` 需要"旧文档 → 内核场景"装配，'
      + '而该装配未交付（#261 实测：内核 `Document` 只承载 block/annotation/camera/mesh，'
      + '不承载 `frames`/`cellGrid`/`textureBlobs`/`materialPalette`/`multiblock`/`meta`）。'
      + '故本条保持 `pending`，不伪造"已迁移"；#282 交付该装配后本条随其删除 → P11 终局零引用审计',
    areaOverrideReason: 'R-WK-03：本条的渲染侧读面（`getDoc`/`getCurrentFrameIndex` 消费者）归 P5，但删除前置条件是"内核接线进生产"（#261）；接缝 B 另需先由 P9/#261 补齐相机与 embed 初始视图读面，否则迁移消费者只能伪造不存在的查询（=#1 负对照要判红的形态）',
  }),
])

// ─────────────────────────────────────────────────────────────────────────────
// M5-5 收口：本批**删除**的符号 + **保留**的对照入口（不属 B5 矩阵）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * M5 收口的第二条登记面（与 {@link RETIREMENT_REGISTRY} 并列，**不**混进 B5 矩阵）。
 *
 * 为什么另立一张表而不是往 `RETIREMENT_REGISTRY` 里塞：
 *  - 那张表的 `matrixSlug`/`owner` 与 #250 的 B5 退役矩阵逐条对账（`owner` 只认
 *    P4/P5/P6/P9/P10/P11，`section15Entries` 指向 §15 行号）——M5 的删除对象**不在**
 *    那张矩阵里，硬塞会让"归属批次与矩阵对应"断言失去意义；
 *  - 本表的语义也不同：它登记的是**M5 这一批的收口事实**（删了什么、为什么还留着什么），
 *    其中 `retained` 条目**不是**"以后再说"，而是**当前仍被对照判据消费**的入口。
 *
 * 状态机（与 B5 表同一纪律，双向）：
 *  - `deleted` ⇒ 模块导出里**不存在**该符号，且全树**零调用位**；
 *  - `retained` ⇒ 符号仍在、**生产零调用**（只被测试/对照判据消费），且必须写明
 *    owner 与非空退出条件 —— "零调用但继续存在"必须有一个外部的、可核对的理由。
 */
export interface M5CloseoutEntry {
  /** 符号名（导出名 / 调用位名）。 */
  readonly symbol: string
  /** 承载文件（`web/` 相对）。 */
  readonly file: string
  readonly status: 'deleted' | 'retained'
  /** `M5` = 本批删除；`M6` = 呈现链收口批（对照参照的退出负责人）。 */
  readonly owner: 'M5' | 'M6'
  /** 为什么删 / 为什么留（留的必须指向**当前真实存在**的消费者）。 */
  readonly reason: string
  /** 退出阶段（`retained` 必填且必须点名 M6）。 */
  readonly exitStage: string
}

export const M5_CLOSEOUT: readonly M5CloseoutEntry[] = Object.freeze([
  // ── 本批删除：`domain/multiblock` 的「第二条求值/写权」───────────────
  //
  // 六条同一族：`evaluateChannelAssembly` → `validateChannelValues`；
  // `channelWriteAuthority` 与 `channelToPropertyRef` 族（`channelPropertyKey`/
  // `channelKeyOfProperty`）互相闭合。M5-1 之后生产求值已全部走
  // `context/multiblock#assembleSelection` + `composition/kernelMultiblockEvaluation`，
  // 这些符号在**生产与测试里都零引用**（只有退役登记文提到名字）⇒ 删除不丢判据。
  {
    symbol: 'evaluateChannelAssembly',
    file: 'web/src/domain/multiblock.ts',
    status: 'deleted',
    owner: 'M5',
    reason: '生产求值的第二实现；与生产"只夹取不拒绝"的口径相反（G5），零消费者',
    exitStage: 'M5-5 已删（求值唯一权威 = context/multiblock#assembleSelection）',
  },
  {
    symbol: 'validateChannelValues',
    file: 'web/src/domain/multiblock.ts',
    status: 'deleted',
    owner: 'M5',
    reason: '只为 evaluateChannelAssembly 服务的"不夹取"校验；零外部消费者',
    exitStage: 'M5-5 已删（校验由 domain/animation#validateParameterSet 在调用方执行）',
  },
  {
    symbol: 'channelWriteAuthority',
    file: 'web/src/domain/multiblock.ts',
    status: 'deleted',
    owner: 'M5',
    reason: '逐通道写权是域层超出 SPEC 的承诺（G4）；生产写权按 ObjectData.source 判定',
    exitStage: 'M5-5 已删（写权 = domain/scene#ObjectData.source）',
  },
  {
    symbol: 'channelPropertyKey',
    file: 'web/src/domain/multiblock.ts',
    status: 'deleted',
    owner: 'M5',
    reason: 'channelToPropertyRef 的反向寻址包装；零消费者',
    exitStage: 'M5-5 已删',
  },
  {
    symbol: 'channelKeyOfProperty',
    file: 'web/src/domain/multiblock.ts',
    status: 'deleted',
    owner: 'M5',
    reason: 'PropertyRef → 通道键的反向解析；零消费者',
    exitStage: 'M5-5 已删',
  },
  // ── 登记保留：通道阶跃轨道的寻址面 ────────────────────────────────────
  {
    symbol: 'channelToPropertyRef',
    file: 'web/src/domain/multiblock.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      'channelStepTrack（#249 §7 要求的"至少一条阶跃通道轨道"证明路径）仍用它做轨道目标；'
      + '生产调用为零，但删它会把通道阶跃轨道的判据一并废掉',
    exitStage: 'M6 呈现链收口批：轨道寻址改走通用属性面后随 channelStepTrack 同批处置',
  },
  // ── 登记保留：切换前的对照参照（M5-2 遗留，本批核实仍零生产调用）───────
  //
  // 这三条是 M5-2 声明的"切换前参照"：生产零调用，只被对照/恒等判据消费。
  // M5-5 核实它们仍零生产调用；**不删**的理由是删除会把"切换没有改变画面/内容身份"
  // 这条证据换成一份冻结指纹 —— 那是 M6 呈现链收口批的工作，M5 末尾不新造冻结资产。
  {
    symbol: 'kernelRenderViewOf',
    file: 'web/src/composition/kernelRenderView.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      '旧入口（整份文档重装配 + 投影）是 g5RenderLosslessSource / p11dRunstateContentIdentity '
      + '的对照参照；生产由 kernelRenderViewFromFace（只投影已求值场景）承担',
    exitStage: 'M6 呈现链收口批：把对照改为冻结几何/内容身份指纹后同批删除',
  },
  {
    symbol: 'evaluateMultiblock',
    file: 'web/src/presentation/multiblockEvaluation.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      '其唯一消费者是 kernelRenderViewOf；生产求值点是 evaluateMultiblockPresentation'
      + '（并带有与生产不同的失效模型，不能当活路径用）',
    exitStage: 'M6：随 kernelRenderViewOf 同批删除（含 evaluationNodeDependency）',
  },
  {
    symbol: 'buildMultiblockRenderView',
    file: 'web/src/shared/viewport/multiblockChannelUi.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      'renderCutoverParity 的 "before" 侧必须走切换前真正吃的那条路（否则比较的不是'
      + '切换前后的渲染输入）；生产零调用',
    exitStage: 'M6：对照改为冻结几何指纹后随旧文档装配簇同批删除',
  },
  {
    symbol: 'assembleForSelection',
    file: 'web/src/shared/viewport/multiblockChannelUi.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      '旧文档装配包装（未声明组合回落 + 提示）；生产已改吃 assembleMultiblockKernelFace，'
      + '它只剩面板 DOM 判据与切换对照两个测试消费者',
    exitStage: 'M6：旧文档装配簇退出时同批删除（与 buildMultiblockRenderView 一致）',
  },
  {
    symbol: 'buildChannelPanelModel',
    file: 'web/src/shared/viewport/multiblockChannelUi.ts',
    status: 'retained',
    owner: 'M6',
    reason:
      '旧文档面板模型适配器（委托 buildChannelPanelModelOf）；生产面板走内核面，'
      + '它只剩 DOM 判据消费',
    exitStage: 'M6：与 assembleForSelection 同批退出',
  },
])

/** 调用位计数（**纯**：输入已去注释的代码骨架）。 */
export function countCallSitesInCode(code: string, symbol: string): number {
  const re = new RegExp(`\\b${symbol}\\s*\\(`, 'g')
  return (code.match(re) ?? []).length
}

/** 全树生产代码里某符号的调用位命中（`web/` 相对文件 + 行）。 */
function productionCallSites(symbol: string): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|vue|mts)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
      const raw = readSourceText(full)
      const code = codeOfSource(full, raw)
      if (countCallSitesInCode(code, symbol) === 0) continue
      for (const line of code.split('\n')) {
        if (countCallSitesInCode(line, symbol) > 0) {
          out.push(`${path.relative(WEB_ROOT, full).replace(/[\\/]+/g, '/')} :: ${line.trim()}`)
        }
      }
    }
  }
  const srcRoot = path.join(WEB_ROOT, 'src')
  if (fs.existsSync(srcRoot)) walk(srcRoot)
  return Object.freeze(out)
}

describe('M5-5 退役收口：删除零消费者残留 + 保留对照入口（各自有 owner）', () => {
  it('已删符号在模块导出里**不存在**（防回流）', () => {
    for (const e of M5_CLOSEOUT.filter((x) => x.status === 'deleted')) {
      expect(
        e.symbol in multiblockDomain,
        `M5-5：${e.symbol} 已删除 —— 回流 = 第二份求值/写权复活`,
      ).toBe(false)
    }
    // 反空洞真：模块本身仍导出它该有的东西（不是"整个模块被删了"）。
    expect('channelStepTrack' in multiblockDomain).toBe(true)
    expect('resolveChannelEffective' in multiblockDomain).toBe(true)
  })

  it('已删符号全树**零调用位**（注释里提到名字不算）', () => {
    for (const e of M5_CLOSEOUT.filter((x) => x.status === 'deleted')) {
      expect(productionCallSites(e.symbol), `M5-5：${e.symbol} 仍有调用位`).toEqual([])
    }
  })

  it('保留条目：符号仍在、**生产零调用**、owner 与退出阶段已登记', () => {
    for (const e of M5_CLOSEOUT.filter((x) => x.status === 'retained')) {
      expect(e.owner, `${e.symbol}：保留必须有外部 owner`).toBe('M6')
      expect(e.reason.length, `${e.symbol}：保留必须写明理由`).toBeGreaterThan(40)
      expect(e.exitStage, `${e.symbol}：退出阶段必须点名 M6`).toContain('M6')
      const text = readMaybe(e.file)
      expect(text, `${e.file} 必须存在（保留类）`).not.toBeNull()
      expect(text!.includes(e.symbol), `${e.file} 必须仍定义 ${e.symbol}`).toBe(true)
      // **生产零调用** = 除定义文件外，调用位只能来自**同一保留簇**的其它文件。
      // 例：`evaluateMultiblock` 的唯一调用者是 `kernelRenderViewOf` —— 后者本身也零生产调用，
      // 故这条链是"零调用 → 零调用"，不是生产入口。簇外的调用位才判红（见下一条）。
      const own = e.file.replace(/^web\//, '')
      const retainedFiles = new Set(
        M5_CLOSEOUT.filter((x) => x.status === 'retained').map((x) => x.file.replace(/^web\//, '')),
      )
      const sites = productionCallSites(e.symbol)
        .filter((s) => !s.startsWith(own))
        .filter((s) => !retainedFiles.has(s.split(' :: ')[0] ?? ''))
      expect(sites, `${e.symbol} 仍被**保留簇之外**的生产代码调用（则它不该是"零调用对照"）`).toEqual([])
    }
  })

  it('**负对照**：调用位计数不是恒空（注入一行真调用必被抓住；注释里的不算）', () => {
    expect(countCallSitesInCode(stripNonCode('const x = evaluateMultiblock({ a: 1 })'), 'evaluateMultiblock')).toBe(1)
    expect(countCallSitesInCode(stripNonCode('// evaluateMultiblock({ a: 1 })'), 'evaluateMultiblock')).toBe(0)
    expect(countCallSitesInCode(stripNonCode('const s = "evaluateMultiblock("'), 'evaluateMultiblock')).toBe(0)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 扫描设施（**纯**：输入文本 → 命中；便于负对照直接喂合成文本）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 去掉**注释与字符串字面量的内容**，只留代码骨架（保留行结构与 `${}` 里的代码）。
 *
 * ## 为什么不能只用"行级注释判据"（合流后实测的两处假红）
 *
 * 初版用行级判据（行首为 `*`、`//`、`/*` 才剥）。它在当时的树上够用，但合流到
 * P2/P3 之后立刻暴露两个真实缺口 —— 都由本文件的断言抓到，且**都是假红**：
 *
 *  1. **行尾注释**：`const x = 1 // 见 ctx.getDoc()` 不以 `//` 开头 ⇒ 未被剥掉；
 *     P2 在 `composition/seams.ts` 里新增了带行尾注释的登记，于是命中被误算。
 *  2. **字符串字面量里的散文**：`composition/seams.ts` 在一条 `newTrack`/`oldTrack`
 *     说明字符串里写了 `` `editors/workbench-rna.ts` 经 `ctx.getDoc()` 读文档 `` ——
 *     那是**关于**该机制的描述，不是对该机制的**依赖**。裸扫描把它算成消费者，
 *     于是消费者清单被迫多登记一个"其实不需要迁移"的文件，并**误导 P5 去改它**。
 *
 * 这两类都不是"判据太松"，而是"判据看不到词法结构"。故升级为字符级扫描。
 *
 * ## 为什么保留 `${}` 里的代码（而不是把模板整体当字符串）
 *
 * 模板字面量的**字面量部分**是散文，但 `${…}` 里是**真代码**：
 * `` `${ctx.getDoc().value}` `` 确实依赖 `getDoc`。若把整个模板当字符串一并剥掉，
 * 就会**漏掉真实消费者**（假绿）—— 而"漏掉消费者"正是本登记表存在的理由，
 * 比假红危险得多。故进入 `${` 后切回代码模式（用栈支持嵌套），只清字面量片段。
 *
 * ## 输出形态与已验证的边界
 *
 * 注释/字符串内容逐字符替换为**空格**（不删行）：行号与行结构不变（诊断可直接
 * 显示命中行），且与 EOL 无关。**未闭合的引号**不吞掉后续行（回落到代码模式）——
 * 宁可多留文本（漏报方向更安全）。
 *
 * 本函数带 13 条合成用例的负对照（见文件末"扫描器词法负对照"），逐条实测：
 * 行尾注释 / 三类字符串 / 模板散文不误红，模板 `${}` 内代码与真代码必判红。
 */
export function stripNonCode(text: string): string {
  // 见 `stripNonCodeInto` —— 保留长度与行结构，故可逐行对齐使用。
  return stripNonCodeInto(text, false)
}

/**
 * 与 {@link stripNonCode} 同，但**不**把引号内容当字符串（HTML 模板口径）。
 *
 * ## 为什么 Vue 模板必须用另一套口径（本文件实测抓出的**假绿**）
 *
 * 合流后 `EmbedRoot.vue:52` 有一处真依赖：
 *
 * ```html
 * <EmbedViewport v-else-if="ctx.getDoc().value" :settings="settings" />
 * ```
 *
 * 那是模板属性里的**表达式**，是真代码。但 TS 词法把 `"…"` 当字符串字面量，
 * 于是这处依赖被整段清空 ⇒ 消费者清单**漏掉**它（假绿）。
 * 漏消费者正是本登记表存在的理由，比假红危险 —— 必须区分两种口径：
 *  - `<script>` 段：TS 词法（引号 = 字符串，内容非代码）；
 *  - 模板/样式段：HTML 口径，只去 `<!-- -->` 注释，引号内容是表达式 ⇒ 保留。
 */
export function stripNonCodeHtml(text: string): string {
  return stripNonCodeInto(text, true)
}

function stripNonCodeInto(text: string, quotedIsCode: boolean): string {
  const out = text.split('')
  const blank = (i: number): void => {
    if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '
  }
  const n = text.length
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'htmlComment' = 'code'
  /** 模板表达式嵌套栈：每进入一层 `${` 压一帧，记该层内 `{}` 深度。 */
  const frames: number[] = []
  let i = 0
  while (i < n) {
    const c = text[i]
    if (mode === 'code') {
      const c2 = text[i + 1]
      if (quotedIsCode && c === '<' && text.startsWith('<!--', i)) {
        mode = 'htmlComment'
        blank(i)
        blank(i + 1)
        blank(i + 2)
        blank(i + 3)
        i += 4
        continue
      }
      if (c === '/' && c2 === '/') {
        mode = 'line'
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      if (c === '/' && c2 === '*') {
        mode = 'block'
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      if (!quotedIsCode && (c === "'" || c === '"')) {
        mode = c === "'" ? 'single' : 'double'
        blank(i)
        i++
        continue
      }
      if (c === '`') {
        mode = 'template'
        blank(i)
        i++
        continue
      }
      // 模板表达式收尾：`}` 把当前层闭合时回到模板字面量模式
      if (c === '}' && frames.length > 0) {
        if (frames[frames.length - 1] === 0) {
          frames.pop()
          mode = 'template'
          blank(i)
          i++
          continue
        }
        frames[frames.length - 1] -= 1
        i++
        continue
      }
      if (c === '{' && frames.length > 0) frames[frames.length - 1] += 1
      i++
      continue
    }
    if (mode === 'htmlComment') {
      if (text.startsWith('-->', i)) {
        mode = 'code'
        blank(i)
        blank(i + 1)
        blank(i + 2)
        i += 3
        continue
      }
      blank(i)
      i++
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        i++
        continue
      }
      blank(i)
      i++
      continue
    }
    if (mode === 'block') {
      if (c === '*' && text[i + 1] === '/') {
        mode = 'code'
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      blank(i)
      i++
      continue
    }
    if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"'
      if (c === '\\') {
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      // 未闭合的引号**不**吞掉后续行：宁可多留文本（漏报方向更安全）
      if (c === '\n') {
        mode = 'code'
        i++
        continue
      }
      if (c === quote) {
        mode = 'code'
        blank(i)
        i++
        continue
      }
      blank(i)
      i++
      continue
    }
    // mode === 'template'：字面量片段置空，`${` 切回代码模式
    if (c === '\\') {
      blank(i)
      blank(i + 1)
      i += 2
      continue
    }
    if (c === '`') {
      mode = 'code'
      blank(i)
      i++
      continue
    }
    if (c === '$' && text[i + 1] === '{') {
      frames.push(0)
      mode = 'code'
      blank(i)
      blank(i + 1)
      i += 2
      continue
    }
    blank(i)
    i++
  }
  return out.join('')
}

/**
 * 按**文件种类**取"代码骨架"（供扫描）：`.vue` 分段处理，其余走 TS 词法。
 *
 * vue 分段规则：`<script>` 段用 TS 词法；模板/样式段用 HTML 口径。
 * 两个口径都**保留长度与行结构**，故拼接后逐行对齐仍然成立。
 */
export function codeOfSource(absPath: string, raw: string): string {
  const hit = codeCache.get(absPath)
  if (hit !== undefined && hit.raw === raw) return hit.code
  const code = computeCodeOfSource(absPath, raw)
  codeCache.set(absPath, { raw, code })
  return code
}

/** 清除 {@link codeOfSource} 的记忆（仿真前后对照用）。 */
export function clearCodeCache(): void {
  codeCache.clear()
}

function computeCodeOfSource(absPath: string, raw: string): string {
  if (!absPath.endsWith('.vue')) return stripNonCode(raw)
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  const pieces: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const open = m.index
    const closeStart = open + m[0].length - '</script>'.length
    const bodyStart = open + m[0].indexOf('>') + 1
    pieces.push(stripNonCodeHtml(raw.slice(last, open)))
    pieces.push(raw.slice(open, bodyStart))
    pieces.push(stripNonCode(m[1]))
    pieces.push(raw.slice(closeStart, closeStart + '</script>'.length))
    last = closeStart + '</script>'.length
  }
  pieces.push(stripNonCodeHtml(raw.slice(last)))
  return pieces.join('')
}

/** 便利包装（负对照用）：对**原始文本**跑 TS 词法剥离后找命中。 */
export function findCriterionHits(
  text: string,
  criterion: SymbolCriterion,
  side: 'own' | 'consumer' = 'consumer',
): readonly string[] {
  return findCriterionHitsIn(stripNonCode(text), criterion, side)
}

/** 找某条判据在**已去注释/字符串的代码骨架**里的命中（返回命中行，供证据显示）。 */
export function findCriterionHitsIn(
  code: string,
  criterion: SymbolCriterion,
  side: 'own' | 'consumer' = 'consumer',
): readonly string[] {
  const scope = criterion.scope ?? 'any'
  if (scope !== 'any' && scope !== side) return Object.freeze([] as string[])
  const re = new RegExp(criterion.pattern, 'g')
  const hits: string[] = []
  for (const line of code.split('\n')) {
    re.lastIndex = 0
    if (re.test(line)) hits.push(line.trim())
  }
  return Object.freeze(hits)
}

/**
 * 读源码并**归一化行尾为 LF**（铁律 6 的治本口径，与 #268 同一处治本）。
 *
 * ## 为什么必须归一化（本仓 `core.autocrlf=true`）
 *
 * 新鲜检出是 **CRLF**（本树 `src/` 404 个文件实测全部 uniform CRLF、0 处裸 LF），
 * 而执行者工具直接写出的工作树文件常是 LF。凡"读源码 + 正则/切片"的断言都会因此
 * 随检出口径变化 —— 这正是 #268 的事故形态。
 *
 * ## 当前**恰好安全**，但"恰好安全 ≠ 判据安全"（实测，不是推断）
 *
 * 本文件的 9 条符号判据全部是**无 `$` 锚**的调用/声明位正则
 * （`\.getDoc\s*\(`、`materialLibrary\.tick\s*\(` …）。在 CRLF 文本上按 `\n` 切分
 * 只让每行末尾多一个 `\r`，而**无锚正则照样命中** ⇒ 现状下断言与检出口径无关。
 *
 * 实测：在真实 `src/`（404 文件）上对多类判据逐文件比较"CRLF 原文 vs 归一化后"
 * 的命中数 —— **1352 次比较、0 处差异**。
 *
 * 这不构成"不用改"的理由，理由与 #268 的表格一致：
 *  - #268 的 `boundary-scan` / `kernel-legacy-isolation` 在 CRLF 下**同样通过**，
 *    仍被统一改为走归一化读入口，注释原文是「恰好安全 ≠ 判据安全」；
 *  - 真正危险的是**将来**任何 `$` 锚、`indexOf('\n\n')` 或按字符偏移切片：
 *    `'a\r\nb'.split('\n')` ⇒ `['a\r','b']`，于是 `/getDoc\($/` 永不命中，
 *    `indexOf('\n\n')` 返回 `-1`（#268 第 253 行那种**假绿**：切片取到文末、
 *    断言范围错了却仍然通过 —— 比直接判红更危险）。
 *
 * 故在**唯一读入口**归一化，使"进入断言的文本恒为 LF"成为**结构性事实**，
 * 而不是"当前所有正则恰好没锚"这一偶然事实。不写回文件，也不改被断言文件的真实 EOL。
 */
export function readSourceText(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * `codeOfSource` 的**按内容**记忆（键 = 绝对路径；仅当原文逐字相同才复用）。
 *
 * ## 为什么需要（实测的**真实超时假红**，与 EOL 无关）
 *
 * 词法器是**逐字符**扫描，而 `scanEntryResidual` 对**每条登记**都要遍历全部生产
 * 文件 ⇒ 同一文件被重复词法化 N 次（N = 登记条数）。实测单文件测试耗时 6.5–13s；
 * 在 CPU 负载下曾达 **34.9s**，超过本仓 `vitest.config.ts` 的 `testTimeout: 30000`
 * ⇒ 真实超时（无缓存冷启动首次运行时观测到一次）。
 * 记忆化把"每条目重新词法化"降为"每文件一次"，直接消除该超时面 ——
 * 治本优于调大超时（后者只是把同一隐患推远）。
 *
 * 安全性：键是绝对路径，且**原文不同即重算**。相位翻转仿真用 `mkdtemp` 建独立
 * 临时树（路径每次不同），且在词法化**之前**完成改写 ⇒ 不存在读到旧内容的情形。
 */
const codeCache = new Map<string, { readonly raw: string; readonly code: string }>()

/** 递归列出 `src/` 下的**生产**源文件（绝对路径）。`srcRoot` 可覆盖（供相位翻转仿真）。 */
function productionFiles(srcRoot: string = path.join(WEB_ROOT, 'src')): readonly string[] {
  const out: string[] = []
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
      out.push(full)
    }
  }
  walk(srcRoot)
  return out.sort()
}

export interface CriterionResidual {
  /** 命中所在文件（`web/` 相对，正斜杠）。 */
  readonly file: string
  /** 判据名。 */
  readonly symbol: string
  /** 命中行（去空白）。 */
  readonly line: string
}

/**
 * 全树扫描某条目的全部判据，返回残留。
 *
 * `root` 覆盖 `web/` 根：**相位翻转仿真**用它（见文件末的仿真用例）。
 * 没有这个参数，"P5/P6 翻相位后保持绿"就只能靠口头保证 —— 而本文件存在的
 * 全部理由就是"不要靠口头保证"。`excludeFiles` 用于跳过同组内其它文件。
 */
export function scanEntryResidual(
  entry: RetirementEntry,
  opts: {
    readonly includeOwnFile?: boolean
    readonly excludeFiles?: readonly string[]
    readonly root?: string
  } = {},
): readonly CriterionResidual[] {
  const root = opts.root ?? WEB_ROOT
  const own = entry.file.replace(/^web\//, '')
  const exclude = new Set(opts.excludeFiles ?? [])
  const out: CriterionResidual[] = []
  const srcRoot = path.join(root, 'src')
  if (!fs.existsSync(srcRoot)) return Object.freeze(out)
  for (const abs of productionFiles(srcRoot)) {
    const rel = path.relative(root, abs).replace(/[\\/]+/g, '/')
    if (opts.includeOwnFile !== true && rel === own) continue
    if (exclude.has(rel) || exclude.has(`web/${rel}`)) continue
    let text: string
    try {
      // **归一化读入口**（铁律 6）：进入判据的文本恒为 LF，与检出口径无关。
      text = readSourceText(abs)
    } catch {
      continue
    }
    for (const c of entry.symbols) {
      const side: 'own' | 'consumer' = rel === own ? 'own' : 'consumer'
      // `.vue` 按段取代码骨架（模板属性里的表达式是真代码），其余走 TS 词法。
      for (const line of findCriterionHitsIn(codeOfSource(abs, text), c, side)) {
        out.push(Object.freeze({ file: `web/${rel}`, symbol: c.name, line }))
      }
    }
  }
  return Object.freeze(out)
}

/**
 * **消费者清单的双向对账**（`missing` = 漏登记仍在引用的文件；`extra` = 登记了却不被引用的文件）。
 *
 * 抽成纯函数**只为可注入负对照**：本次 P11-B3 实测到一处真实腐烂 ——
 * `material-viewport-tick` / `simpleMaterialLibrary.ts` 条目的 `consumers` 写着
 * `web/src/runtime/renderEngine.ts`，而该文件对这三个判据（`registerTick` /
 * `applyAnimatedStrip` / `tick` 声明位）**零命中**（#261 删除后它只剩注释与类型导入）。
 * 腐烂之所以能潜伏，是因为原完备断言对 `executed` 条目 `continue`（该字段退出了断言面）；
 * 本函数 + 其负对照用例把这一形态变成能被判据抓住的输入。
 *
 * 归一化两侧的 `web/` 前缀（登记风格两存：接口文档写 `web/` 相对，`scanEntryResidual` 返 `web/` 相对）。
 */
export function consumerListDiff(
  declared: readonly string[],
  actual: readonly string[],
): { readonly missing: readonly string[]; readonly extra: readonly string[] } {
  const d = new Set(declared.map((c) => c.replace(/^web\//, '')))
  const a = new Set(actual.map((c) => c.replace(/^web\//, '')))
  return {
    missing: [...a].filter((f) => !d.has(f)).sort(),
    extra: [...d].filter((f) => !a.has(f)).sort(),
  }
}

/** 某条目所属组的全部条目（无组时只有它自己）。 */
export function groupMembers(entry: RetirementEntry): readonly RetirementEntry[] {
  if (entry.group === undefined) return Object.freeze([entry])
  return Object.freeze(RETIREMENT_REGISTRY.filter((e) => e.group === entry.group))
}

/** 组是否**整组** executed。 */
export function isGroupExecuted(entry: RetirementEntry): boolean {
  const members = groupMembers(entry)
  return members.length > 0 && members.every((m) => m.status === 'executed')
}

/** 读取 `web/` 相对路径的文本（**已归一化为 LF**）；不存在返回 `null`。 */
function readMaybe(rel: string): string | null {
  const abs = path.join(WEB_ROOT, rel.replace(/^web\//, ''))
  try {
    return readSourceText(abs)
  } catch {
    return null
  }
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(WEB_ROOT, rel.replace(/^web\//, '')))
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言
// ─────────────────────────────────────────────────────────────────────────────

describe('P4 退役归口登记（R-WK-01 的机器可读删除点清单）', () => {
  it('清单非空且每条字段自洽（反空洞真）', () => {
    expect(RETIREMENT_REGISTRY.length).toBeGreaterThanOrEqual(8)
    for (const e of RETIREMENT_REGISTRY) {
      expect(e.file.startsWith('web/'), `${e.file} 必须是 web/ 相对路径`).toBe(true)
      expect(e.symbols.length, `${e.file} 必须列出要消失的符号`).toBeGreaterThan(0)
      // 判据必须是**位级形态**（含正则元字符），不允许退化回裸子串
      for (const c of e.symbols) {
        expect(c.name.length, `${e.file} 的判据必须有可读名`).toBeGreaterThan(0)
        expect(
          /[\\^$.*+?()[\]{}|]/.test(c.pattern),
          `${e.file} 的判据 ${c.name} 必须是位级正则（含元字符），不得退化为裸子串`,
        ).toBe(true)
      }
      // 必须登记 consumers 字段（哪怕是空数组）—— 它是相位翻转与 #262 对账的依据。
      // 缺字段会让"消费者清单完备性"断言静默失效（把 undefined 当空清单）。
      expect(e.consumers, `${e.file} 必须显式登记 consumers（可为空数组）`).toBeDefined()
      expect(e.replacement.length, `${e.file} 必须给出替代接口`).toBeGreaterThan(0)
      expect(e.exitStage, `${e.file} 必须写明退出阶段`).toMatch(/P\d+/)
      expect(e.section15Entries.length).toBeGreaterThan(0)
      expect(e.matrixSlug).toMatch(/^[a-z0-9-]+$/)
      if (e.status === 'executed') {
        expect(e.executedBy, `${e.file} 为 executed 时必须写明 executedBy`).toBe(e.owner)
      } else {
        expect(e.executedBy, `${e.file} 为 pending 时不应写 executedBy`).toBeUndefined()
      }
      if (e.groupAreaNotes !== undefined) {
        expect(e.group, '写了 groupAreaNotes 就必须有 group').toBeDefined()
      }
    }
  })

  it('**同文件多条目相位必须一致**（`useMultiblockChannels.ts` 两条 slug 共用一个文件）', () => {
    // 否则会出现"一条 executed、一条 pending"却指向同一文件的不自洽态：
    // 文件要么在要么不在，不可能同时对两条成立。
    const byFile = new Map<string, RetirementEntry[]>()
    for (const e of RETIREMENT_REGISTRY) {
      const list = byFile.get(e.file) ?? []
      list.push(e)
      byFile.set(e.file, list)
    }
    for (const [file, list] of byFile) {
      if (list.length < 2) continue
      const statuses = new Set(list.map((e) => e.status))
      expect(statuses.size, `${file} 的 ${list.length} 条条目相位不一致：${list.map((e) => `${e.matrixSlug}=${e.status}`).join(', ')}`).toBe(1)
      // 且同文件的条目应在同一组（同批翻转）
      const groups = new Set(list.map((e) => e.group))
      expect(groups.size, `${file} 的多条条目应同组`).toBe(1)
    }
  })

  it('`pending` 条目：文件仍在，且替代接口**已存在**（防"半成品替换"）', () => {
    const pending = RETIREMENT_REGISTRY.filter((e) => e.status === 'pending')
    // ## ⚠️ 本断言的**相位演化**（#301 P10f D3；口径未放松，只是对象没了）
    //
    // P4 建立本条时写的是"本批必须留下待退役条目"—— 那是**P4 相位**的事实
    // （当时登记表里必然有等待后续批次的对象）。
    //
    // D3 把最后一条 pending（`raw-authority-object`）翻成 `executed` ⇒
    // **登记表首次全 executed**（`pending.length === 0`）。
    // 继续要求非空会**永远判红**，而那个红只代表"判据停在 P4 的相位"。
    //
    // ⇒ 改为**双向**：非空时逐条核对（下同）；为空时**如实登记**"本表已全 executed"
    // 并断言"全 executed ⇒ 每条都 0 命中"（由下一条 `executed` 用例把守）
    // —— 于是"清空登记表"不能靠删条目达成，只能靠真的删掉机制。
    if (pending.length === 0) {
      expect(
        RETIREMENT_REGISTRY.every((e) => e.status === 'executed'),
        '`pending` 为空时必须**全体** executed（防"删条目冒充收敛"）',
      ).toBe(true)
      expect(RETIREMENT_REGISTRY.length, '登记表不得被清空（否则本条空转）').toBeGreaterThan(0)
      // 全 executed ⇒ 下一条用例会逐条扫全树 0 命中。
      return
    }
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

  it('`executed` 条目：**整文件退役**类文件确实不存在；**机制退役**类只要求判据 0 命中', () => {
    const executed = RETIREMENT_REGISTRY.filter((e) => e.status === 'executed')
    expect(executed.length, '本批必须至少删掉一条（否则"同批退役"是空的）').toBeGreaterThan(0)
    for (const e of executed) {
      if (e.fileRemoved === true) {
        expect(exists(e.file), `${e.file} 已登记为整文件退役（executed），但它仍然存在`).toBe(false)
      } else {
        // 机制退役：文件按设计**继续存在**（被重写/裁剪），只是机制必须消失。
        // 断言文件存在是**反空洞真**：若它意外消失，说明登记对象被整文件删了，
        // 该条的 `fileRemoved` 应同步改为 true（而不是让判据静默失去对象）。
        expect(exists(e.file), `${e.file} 登记为机制退役，但文件已不存在 —— 请把 fileRemoved 改为 true`).toBe(true)
      }
      // 无论哪一类，判据都必须全树 0 命中
      const residual = scanEntryResidual(e)
      expect(
        residual.map((r) => `${r.file} [${r.symbol}] ${r.line}`),
        `已 executed 的条目仍有残留引用:\n${residual.map((r) => `${r.file} [${r.symbol}] ${r.line}`).join('\n')}`,
      ).toEqual([])
    }
  })

  it('`pending` 的**机制退役**类：判据此刻**仍有命中**（否则登记对象已消失，应加相位）', () => {
    // 这条是"机制退役"类的反空洞真：`drwMeshPipeline.ts` 等文件会继续存在，
    // 故不能靠"文件存在"证明登记有效 —— 必须证明**那套机制**还在。
    const mechanicalPending = RETIREMENT_REGISTRY.filter((e) => e.status === 'pending' && e.fileRemoved !== true)
    // 相位演化见上一条：D3 之后 `pending` 为空 ⇒ 本条改为"要么有对象可核，
    // 要么全体 executed（且由 `executed` 那条逐条扫 0 命中）"。
    if (mechanicalPending.length === 0) {
      expect(
        RETIREMENT_REGISTRY.filter((e) => e.status === 'pending').length,
        '`pending` 的机制退役类为空时，**不得**还有别的 pending（相位必须整体一致）',
      ).toBe(0)
      return
    }
    for (const e of mechanicalPending) {
      const residual = scanEntryResidual(e, { includeOwnFile: true })
      expect(residual.length, `${e.file} 的机制判据此刻 0 命中 —— 该机制可能已被删除，请核销或翻相位`).toBeGreaterThan(0)
    }
  })

  it('**同批成组**：整组 executed 时才要求全树 0 命中；部分删除不制造伪失败', () => {
    const groups = new Map<string, RetirementEntry[]>()
    for (const e of RETIREMENT_REGISTRY) {
      if (e.group === undefined) continue
      const list = groups.get(e.group) ?? []
      list.push(e)
      groups.set(e.group, list)
    }
    expect(groups.size, '必须登记至少一个跨文件组（材质 tick / 播放 Ref / 通道暂存）').toBeGreaterThanOrEqual(3)

    for (const [gid, members] of groups) {
      const executedCount = members.filter((m) => m.status === 'executed').length
      const allExecuted = executedCount === members.length
      if (!allExecuted) {
        // 部分删除：**不得**要求全树 0 命中（组内其它成员仍在引用它）。
        // 断言"尚未翻相位"是唯一合法状态 —— 若有人在组内只翻一部分，
        // 那条 executed 条目会在"executed 条目"用例里立即判红（文件仍在或
        // 仍有残留），故此处只需钉住"部分执行不得被登记为部分相位"。
        expect(
          executedCount,
          `组 ${gid} 部分删除（${executedCount}/${members.length}）—— 组内不得只翻一部分：` +
            members.map((m) => `${m.file}=${m.status}`).join(', '),
        ).toBe(0)
        // 反空洞真：该组确实**有**残留，否则"待删除"这个状态没有对象。
        const hasResidual = members.some((m) => scanEntryResidual(m, { includeOwnFile: true }).length > 0)
        expect(hasResidual, `组 ${gid} 全部 pending，但其判据在树上 0 命中 —— 登记对象可能已消失，请核销`).toBe(true)
      } else {
        // 整组 executed ⇒ 组内每条判据（含各自文件）全树 0 命中
        for (const m of members) {
          const residual = scanEntryResidual(m)
          expect(
            residual.map((r) => `${r.file} [${r.symbol}]`),
            `组 ${gid} 已整组 executed，但 ${m.file} 的判据仍有残留:\n${residual.map((r) => `${r.file} [${r.symbol}] ${r.line}`).join('\n')}`,
          ).toEqual([])
        }
      }
    }
  })

  it('跨区组必须注明各文件所在区归属（`groupAreaNotes`）', () => {
    for (const e of RETIREMENT_REGISTRY) {
      if (e.group === undefined) continue
      const members = groupMembers(e)
      const owners = new Set(members.map((m) => m.owner))
      if (owners.size > 1) {
        expect(
          e.groupAreaNotes,
          `组 ${e.group} 跨批次（${[...owners].join('/')}）必须写明各文件所在区归属`,
        ).toBeDefined()
        expect(e.groupAreaNotes?.length ?? 0, `组 ${e.group} 的区归属说明应足够具体`).toBeGreaterThan(30)
      }
    }
  })

  it('R-WK-01：**执行者**只能删自己区内的文件（P4 限 `workbench/ux/panels/`；P10 限 R-WK-03 归集项）', () => {
    // ## 本条判据的演化（口径未放松，只是随批次推进而收窄）
    //
    // P4 建立本条时，`executed` 条目只有 P4 自己删的 `useMaterialAnimation.ts`
    // （`workbench/ux/panels/` 区）—— 于是判据是"executed 必须落在该目录"。
    //
    // P10（#261）按 R-WK-03 执行了渲染侧与播放面的删除，那些文件**不在**
    // `workbench/ux/panels/`。若沿用旧判据，本批的合法删除会被判红 ——
    // 而那个红只代表"判据停在 P4 的相位"，不代表越区。
    //
    // ⇒ 判据改为**按执行者分派**：每个执行者只允许删 R-WK-01/R-WK-03
    // 归给它的区。这不是"放宽"：它仍然拒绝任何执行者删除不属于自己的文件
    // （见下一条负对照）。
    //
    // P10b（#282）追加 **P6**：本批执行了 `per-viewport-staging` 组
    // （`shared/viewport/useMultiblockChannels.ts`）—— 该文件按 R-WK-01
    // comment 4875 实施细则**属 P6 区**（该组两条 slug 的 `owner` 与
    // `areaOverrideReason` 逐字登记了这一点）。缺 P6 这一档时，该组**永远
    // 无法翻相位**（"P6 越区删除"），而那个红只代表"策略表停在 P4/P10 的相位"，
    // 不代表真的越区 —— 与 P10 当年遇到的是同一类问题。
    const ALLOWED_BY_OWNER: Record<string, readonly string[]> = {
      // P4：材质面板独立 RAF（`workbench/ux/panels/`）
      P4: ['web/src/workbench/ux/panels/'],
      // P10：R-WK-03 归集的内核接线同批删除项 —— 旧 runtime 播放面
      // （`runtime/main.ts`、`runtime/drwMeshPipeline.ts`）与渲染侧 tick
      // （`runtime/renderEngine.ts`、`render/materials/`、`render/interaction/`）
      P10: [
        'web/src/runtime/main.ts',
        'web/src/runtime/drwMeshPipeline.ts',
        'web/src/runtime/renderEngine.ts',
        'web/src/render/materials/simpleMaterialLibrary.ts',
        'web/src/render/interaction/blockIconCache.ts',
        // P10f D3（#301）：`raw-authority-object` 的**声明位**（`getDoc()` 访问器）
        // 在 `runtime/context.ts` —— 该文件属 R-WK-03 归 P10 的"内核接线落点"
        // （`Context` 是 P10 的过渡门面），故本批的机制退役落在这里。
        // ⚠️ 是**机制退役**不是整文件退役：`fileRemoved` 未置位，文件按设计继续存在。
        'web/src/runtime/context.ts',
      ],
      // P6：视口/Area 区（#257「工作区、Area 生命周期与模块装配」）——
      // `shared/viewport/` 是每视口机制（通道暂存、视口运行时）的所在区。
      P6: ['web/src/shared/viewport/'],
    }
    for (const e of RETIREMENT_REGISTRY) {
      if (e.status !== 'executed') continue
      const allowed = ALLOWED_BY_OWNER[e.executedBy ?? ''] ?? []
      expect(
        allowed.some((p) => e.file === p || e.file.startsWith(p)),
        `${e.executedBy} 越区删除 ${e.file}（R-WK-01/R-WK-03：跨区文件由所在区批次删除）`,
      ).toBe(true)
    }
  })

  it('**负对照**：上一条判据能抓到越区删除（证明它没有变成恒真）', () => {
    const ALLOWED_BY_OWNER: Record<string, readonly string[]> = {
      P4: ['web/src/workbench/ux/panels/'],
      P10: ['web/src/runtime/main.ts', 'web/src/render/materials/simpleMaterialLibrary.ts'],
    }
    const isAllowed = (by: string, file: string): boolean =>
      (ALLOWED_BY_OWNER[by] ?? []).some((p) => file === p || file.startsWith(p))
    // 真：各自删自己的
    expect(isAllowed('P4', 'web/src/workbench/ux/panels/useMaterialAnimation.ts')).toBe(true)
    expect(isAllowed('P10', 'web/src/render/materials/simpleMaterialLibrary.ts')).toBe(true)
    // 假：越区（P4 去删渲染侧 / P10 去删 P4 的面板）
    expect(isAllowed('P4', 'web/src/render/materials/simpleMaterialLibrary.ts'), 'P4 越区删渲染侧必须判红').toBe(false)
    expect(isAllowed('P10', 'web/src/workbench/ux/panels/useMaterialAnimation.ts'), 'P10 越区删 P4 面板必须判红').toBe(false)
    // 假：未登记的执行者（防止用一个不存在的批次名绕过）
    expect(isAllowed('P99', 'web/src/runtime/main.ts'), '未登记执行者必须判红').toBe(false)
  })

  it('归属批次与 B5 退役矩阵 slug 对应（P↔issue 由 #250 表格固定）', () => {
    const rules = require_(path.join(process.cwd(), 'tests', 'architecture', 'boundary-rules.mjs')) as {
      RETIREMENT_OWNERS: Record<string, { entries: readonly number[]; owners: readonly { p: string }[] }>
    }
    const owners = rules.RETIREMENT_OWNERS
    for (const e of RETIREMENT_REGISTRY) {
      const entry = owners[e.matrixSlug]
      expect(entry, `${e.matrixSlug} 必须是 §15 矩阵里的稳定 slug`).toBeTruthy()
      for (const n of e.section15Entries) {
        expect(entry.entries, `${e.matrixSlug} 的条目应覆盖 §15 第 ${n} 行`).toContain(n)
      }
      // `executed` 条目必须写明执行者，且该执行者就是 `owner`
      // （结构自洽已在上面的"字段自洽"用例里断言，这里复核归口一致性）。
      if (e.status === 'executed') {
        expect(e.executedBy, `${e.file} executed 必须写 executedBy`).toBe(e.owner)
        // **归口对账仍然成立**：无论相位如何，该 slug 都必须在矩阵里有归口批次
        // （防止"翻成 executed 就脱离矩阵"）。
        const listed = entry.owners.map((o: { p: string }) => o.p)
        expect(listed.length, `${e.matrixSlug} 仍须在矩阵里有归口批次`).toBeGreaterThan(0)
        // 有区归属差异时必须给出理由（与 pending 分支同一判据）
        if (e.areaOverrideReason === undefined) {
          expect(listed, `${e.matrixSlug} 的归口批次应包含 ${e.owner}`).toContain(e.owner)
        } else {
          expect(e.areaOverrideReason.length, 'override 必须写明理由').toBeGreaterThan(20)
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// 判据精度负对照（Lead 要求：每条 precision 判据都要证明"不误红 / 真残留判红"）
// ─────────────────────────────────────────────────────────────────────────────

describe('判据精度负对照：子串撞名不得误红，真依赖残留必须判红', () => {
  /** 取一条登记条目（按文件找，稳定）。 */
  function entryOf(fileEnd: string): RetirementEntry {
    const e = RETIREMENT_REGISTRY.find((x) => x.file.endsWith(fileEnd))
    expect(e, `登记表里必须有 ${fileEnd}`).toBeTruthy()
    return e as RetirementEntry
  }

  it('**不误红**：`getDocument`/`getDocumentBinding`/`getDocumentSourceRegistry` 等不得命中 `getDoc()` 判据', () => {
    const e = entryOf('runtime/context.ts')
    const collision = [
      'export function getDocument(state: ApplicationState, documentId: string) { return state }',
      'const b = ctx.getDocumentBinding().value',
      'import { getDocumentSourceRegistry } from "@/workbench/document/registry"',
      'const snap = getDocumentEmbedInitialView(main.doc.value)',
      'const rev = page.revisions?.[0]',
      'remoteRevisionId: result.revisionId ?? null',
    ].join('\n')
    for (const c of e.symbols) {
      expect(findCriterionHits(collision, c), `判据 ${c.name} 不得被子串撞名命中`).toEqual([])
    }
  })

  it('**不误红**：`revisionId`/`revisions`/`BLOCK_ICON_LAYOUT_REVISION` 不得命中 `revision` 调用位判据', () => {
    const e = entryOf('useMultiblockChannels.ts')
    const collision = [
      "export const BLOCK_ICON_LAYOUT_REVISION = '1'",
      'private revision = ""',
      'setRevisionKey(key: string): void { this.revision = key }',
      'afterDocumentSave(ctx, ctx.getDocumentBinding(), result.revisionId)',
      'const rev = page.revisions?.[0]?.revid ?? null',
      'remoteRevisionId: result.revisionId ?? null',
    ].join('\n')
    // 只有"调用位"判据会涉入 revision；逐条验它不误红
    for (const c of e.symbols) {
      expect(findCriterionHits(collision, c), `判据 ${c.name} 不得被子串撞名命中`).toEqual([])
    }
  })

  it('**不误红**：`pending` 条目不能靠"文件存在"证明有效（机制退役类必须看判据）', () => {
    // 这条钉住首版缺陷 1 的另一面：首版对**所有** pending 条目断言"文件仍在"，
    // 于是把两类不同的东西（整文件退役 / 机制退役）混为一谈。
    const wholeFile = RETIREMENT_REGISTRY.filter((e) => e.status === 'pending' && e.fileRemoved === true)
    const mechanical = RETIREMENT_REGISTRY.filter((e) => e.status === 'pending' && e.fileRemoved !== true)
    expect(wholeFile.length + mechanical.length).toBe(RETIREMENT_REGISTRY.filter((e) => e.status === 'pending').length)
    for (const e of [...wholeFile, ...mechanical]) {
      expect(exists(e.file), `${e.file}（pending）应仍存在`).toBe(true)
    }
    // 机制退役类必须有判据命中；整文件退役类**不必**（它的机制就是"文件本身"）
    for (const e of mechanical) {
      expect(scanEntryResidual(e, { includeOwnFile: true }).length, `${e.file} 机制判据应有命中`).toBeGreaterThan(0)
    }
  })

  it('**真残留判红**：`getDoc()` 的真实调用/声明位必须被命中', () => {
    const e = entryOf('runtime/context.ts')
    const ownDecl = ['getDoc(): Ref<RuntimeDocument | null> {', '  return this.main.doc', '}'].join('\n')
    const consumerRef = 'const d = ctx.getDoc().value'
    // 声明位：只在 `own` 侧命中（且只命中声明位判据，不命中引用位判据）
    const ownHits = e.symbols.flatMap((c) => findCriterionHits(ownDecl, c, 'own'))
    expect(ownHits.length, '声明位必须被 own 判据命中').toBeGreaterThan(0)
    const ownViaConsumer = e.symbols.flatMap((c) => findCriterionHits(ownDecl, c, 'consumer'))
    expect(ownViaConsumer, '声明位不应被 consumer 判据命中（否则作用域失效）').toEqual([])
    // 引用位：只在 `consumer` 侧命中
    const consumerHits = e.symbols.flatMap((c) => findCriterionHits(consumerRef, c, 'consumer'))
    expect(consumerHits.length, '引用位必须被 consumer 判据命中').toBeGreaterThan(0)
    // 说明：`own` 侧的声明位正则（`\bgetDoc\s*\(`）**也会**匹配 `ctx.getDoc(`
    // —— 这是**刻意**的：`own` 只在**本文件内**生效，而本文件里的 `getDoc(`
    // 无论带不带接收者都属于"该成员的声明或内部使用"，都该被判据覆盖。
    // 真正需要排除的是**别处**的同名自由函数，那由 `consumer` 侧的
    // 点号要求保证（见下一条用例）。
    expect(
      e.symbols.some((c) => (c.scope ?? 'any') === 'own' && findCriterionHits(consumerRef, c, 'own').length > 0),
      'own 侧判据应覆盖本文件内的所有 getDoc( 出现',
    ).toBe(true)
  })

  it('**不误红**：新内核里的同名自由函数 `getDoc(state, id)` **不是**消费者', () => {
    // 这是端到端仿真抓出的第三个真问题：`application/commands.ts` 有一个与本次退役
    // **毫无关系**的私有辅助函数 `function getDoc(state, id)`。一个裸名判据会把它
    // 算成 `runtime/context.ts` 的消费者，从而污染消费者清单、误导 P5。
    const e = entryOf('runtime/context.ts')
    const unrelated = [
      'function getDoc(state: ApplicationState, id: string): Document | undefined {',
      '  return Object.prototype.hasOwnProperty.call(state.docs, id) ? state.docs[id] : undefined',
      '}',
      'const doc = getDoc(state, cmd.documentId)',
    ].join('\n')
    for (const c of e.symbols) {
      expect(
        findCriterionHits(unrelated, c, 'consumer'),
        `consumer 侧判据 ${c.name} 不得命中同名自由函数（无点号接收者）`,
      ).toEqual([])
    }
  })

  it('**真残留判红**：材质 tick 三处互相调用，任一处残留都被对应判据抓到', () => {
    const renderEngine = entryOf('runtime/renderEngine.ts')
    const materialLib = entryOf('render/materials/simpleMaterialLibrary.ts')
    const iconCache = entryOf('render/interaction/blockIconCache.ts')

    // renderEngine 的调用位
    expect(findCriterionHits('opts.materialLibrary.tick(clock.getDelta() * 1000)', renderEngine.symbols[0]).length).toBe(1)
    // 材质库的声明/注册位
    expect(findCriterionHits('private registerTick(fn: (dtMs: number) => void): void {', materialLib.symbols[0]).length).toBe(1)
    expect(findCriterionHits('function applyAnimatedStrip(', materialLib.symbols[1]).length).toBe(1)
    expect(findCriterionHits('tick(deltaMs: number): void {', materialLib.symbols[2]).length).toBe(1)
    // 图标缓存的调用位
    expect(findCriterionHits('this.library.tick(16)', iconCache.symbols[0]).length).toBe(1)

    // renderEngine 的**接收者钉死**判据：只命中它自己的 `materialLibrary.tick(`。
    // 不跨文件误伤图标缓存的 `this.library.tick(16)`（不同接收者 ⇒ 不同调用点）。
    expect(
      findCriterionHits('this.library.tick(16)', renderEngine.symbols[0]),
      'renderEngine 判据（materialLibrary.tick）不得命中图标缓存的 library.tick',
    ).toEqual([])

    // 反向：**更窄**的判据不误伤。
    expect(
      findCriterionHits('opts.materialLibrary.tick(x)', iconCache.symbols[0]),
      '图标缓存判据（library.tick）不得命中 renderEngine 的 materialLibrary.tick',
    ).toEqual([])
    // 而材质库的**声明位**判据用负向后顾排除点号调用 ⇒ 它也不误伤调用位
    expect(
      findCriterionHits('opts.materialLibrary.tick(x)', materialLib.symbols[2]),
      '声明位判据（(?<!\\.)\\btick(）不得命中点号调用位',
    ).toEqual([])
    // 且它**确实**命中真正的成员声明（证明负向后顾没有把判据废掉）
    expect(
      findCriterionHits('  tick(deltaMs: number): void {', materialLib.symbols[2]).length,
      '声明位判据必须命中成员声明本身',
    ).toBe(1)
    // 同组内条目**互相调用**的事实由组登记表达（`material-tick`），
    // 不要求判据本身跨文件重叠 —— 判据越窄，失败定位越准。
  })

  it('**注释不算残留**：退役说明里提到旧符号名不得判红（否则文件头解释会自我判红）', () => {
    const e = entryOf('runtime/main.ts')
    const doc = [
      '/**',
      ' * 说明：本模块不再暴露 currentFrameIndex（已迁至 EditContext.time）',
      ' * framesPlaybackIsPlaying 的替代见 domain/animation.ts#Playhead',
      ' */',
      '// currentFrameIndex 由宿主持有',
      '/* framesPlaybackIsPlaying: 见上 */',
      'export const unrelated = 1',
    ].join('\n')
    for (const c of e.symbols) {
      expect(findCriterionHits(doc, c), `注释里的 ${c.name} 不得判为残留`).toEqual([])
    }
    // 反空洞真：同一判据对**真代码**必须命中（证明上一条不是"判据恒空"）
    expect(findCriterionHits('const i = ctx.main.currentFrameIndex.value', e.symbols[0]).length).toBe(1)
  })

  it('**消费者清单必须完整**：实际命中该机制的文件集合 = 登记清单（漏一个就判红）', () => {
    // 这是 R-WK-01「旧机制暂存登记（消费者清单/归口/退出阶段）」的机器化。
    // 缺了这条，`main.ts` 那种"权威字段在自己文件、消费者散在 8 个文件"的机制
    // 就会在 P5 删除后被漏掉的消费者拖住 —— 而漏掉的那个**不会**报错，
    // 只会让 phase flip 永远红（首版仿真正是这样抓出来的）。
    //
    // ## ⚠️ P11-B3 修正：**取消 `executed` 豁免**（该字段不再是"退出断言面"）
    //
    // 原文首行是 `if (e.status === 'executed') continue`。当时的理由是"相位已翻 ⇒
    // 机制已删 ⇒ 清单无核对对象"。实测该理由**不成立**：`executed` 条目的
    // `scanEntryResidual(e)` 必为 `[]`（由本文件「`executed` 条目…判据 0 命中」
    // 与「整组 executed ⇒ 0 命中」两条用例把守）⇒ `actual` 恒为空集，
    // 于是这条断言对 `executed` 条目等价于「声明必须为空」，**是可核对的**。
    // 豁免的代价是实测到的一处真实腐烂：
    // `simpleMaterialLibrary.ts` 条目声明消费者 `web/src/runtime/renderEngine.ts`，
    // 而该文件对三个判据零命中（#261 删除后只剩注释与类型导入）——
    // 登记指向了一个**不再引用该机制**的文件，豁免让它静默存活。
    for (const e of RETIREMENT_REGISTRY) {
      const { missing, extra } = consumerListDiff(e.consumers ?? [], scanEntryResidual(e).map((r) => r.file))
      expect(
        missing,
        `${e.file} 的消费者清单**漏登记**了仍在引用的文件（P5/P6 会漏迁移它们）:\n${missing.join('\n')}`,
      ).toEqual([])
      expect(
        extra,
        `${e.file} 的消费者清单登记了并不引用该机制的文件（清单腐烂，请核销）:\n${extra.join('\n')}`,
      ).toEqual([])
    }
  })

  it('**负对照**：消费者清单对账能抓住"清单腐烂"与"漏登记"两个方向（注入式）', () => {
    // ① 本次实测修正的**真实腐烂形态**：声明了 `renderEngine.ts`，实测零引用 ⇒ `extra` 命中。
    expect(
      consumerListDiff(['web/src/runtime/renderEngine.ts'], []).extra,
      '声明了一个不再引用该机制的文件必须判红（这就是 P11-B3 修掉的那处腐烂）',
    ).toEqual(['src/runtime/renderEngine.ts'])
    // ② 反方向：实测多一个未登记的文件 ⇒ `missing` 命中（P5/P6 会漏迁移它）。
    expect(consumerListDiff([], ['web/src/x.ts']).missing).toEqual(['src/x.ts'])
    // ③ **反空洞真**：两侧一致时判据必须为空（证明它不是"恒非空"）。
    expect(
      consumerListDiff(['web/src/a.ts'], ['src/a.ts']),
      '声明与实测一致时必须两侧皆空（判据不得恒红）',
    ).toEqual({ missing: [], extra: [] })
  })

  it('**跨区组**：`world-frame-playback` 组必须登记 P5 与 P6 两侧的消费者归属', () => {
    const group = RETIREMENT_REGISTRY.filter((e) => e.group === 'world-frame-playback')
    expect(group.length, 'world-frame-playback 组必须存在').toBeGreaterThan(0)
    const notes = group[0].groupAreaNotes ?? ''
    expect(notes, '跨区组说明必须点名 P6 区消费者（否则读者无法排合并顺序）').toContain('P6')
    expect(notes).toContain('shared/viewport/')
    // 单成员组不得被写成"跨区"（避免用注释掩盖实际未登记消费者）
    const multi = RETIREMENT_REGISTRY.filter((e) => e.group === 'material-tick')
    expect(multi.length, 'material-tick 必须是多成员组（三处互相调用）').toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 扫描器词法负对照（合流后实测的假红来源，逐条钉住）
// ─────────────────────────────────────────────────────────────────────────────

describe('扫描器词法：注释与字符串不算残留，但 `${}` 内的代码算', () => {
  /**
   * 这一组是**合流到 P2/P3 后抓出的两处假红**的回归钉。
   *
   * 现场：`composition/seams.ts` 用**行尾注释**与**字符串字面量内散文**提到了
   * `ctx.getDoc()`，行级注释判据看不见两者 ⇒ 它被算成"`runtime/context.ts` 的
   * 消费者"，于是消费者清单被迫多登记一个**不需要迁移**的文件，
   * 并会误导 P5 去改它。这不是判据太松，是判据看不到词法结构。
   */
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['行尾注释', 'const x = 1 // 见 ctx.getDoc()', false],
    ['行首注释', '// ctx.getDoc()', false],
    ['块注释同行', '/* ctx.getDoc() */', false],
    ['块注释跨行', '/*\n * ctx.getDoc()\n */', false],
    ['单引号字符串', "const s = 'ctx.getDoc()'", false],
    ['双引号字符串', 'const s = "ctx.getDoc()"', false],
    ['模板字面量散文', 'const s = `经 ctx.getDoc() 读文档`', false],
    ['字符串内转义引号', "const s = 'a\\' ctx.getDoc()'", false],
    // 反向：真代码与模板表达式内的代码**必须**判红（否则就是假绿 —— 漏消费者）
    ['模板内表达式', 'const s = `${ctx.getDoc().value}`', true],
    ['嵌套模板表达式', 'const s = `${a ?? `${ctx.getDoc()}`}`', true],
    ['真调用', 'const d = ctx.getDoc().value', true],
    ['声明位', 'getDoc(): Ref<X> {', true],
    ['未闭合引号回落代码', "const s = 'oops\nconst d = ctx.getDoc().value", true],
  ]

  it.each(cases)('%s ⇒ 命中=%s', (_label, input, want) => {
    expect(stripNonCode(input).includes('getDoc'), `输入: ${JSON.stringify(input)}`).toBe(want)
  })

  /** 与上面 `refs(rel)` 同一把尺子，但输入是**文本**（合成输入的负对照用）。 */
  const refs_of = (text: string): number =>
    stripNonCode(text)
      .split('\n')
      .filter((l) => /\.getDoc\s*\(/.test(l)).length

  it('**真树对照**：散文提及不算消费者，真代码算 —— 而 D3 之后**全树真代码为 0**', () => {
    // ## ⚠️ 本断言的**相位演化**（#301 P10f D3）
    //
    // 本条的原始用意是"证明扫描器能区分散文与真代码"——它当年用的对象是
    // "`seams.ts` 只有散文（0）+ `workbench-rna.ts`/`queries.ts` 是真代码（>0）"。
    //
    // D3 之后 `getDoc()` **全树 0 命中** ⇒ ">0 的那一半"没有对象了。
    // 若直接删掉那一半，本条就只剩"0 == 0"，**无法再证明扫描器抓得到真代码**
    //（判据空转）。故改为**两段**：
    //
    //  ① **真树**：全树真代码 0 命中（终删的机械面；散文**不得**把它变红）；
    //  ② **合成输入**：把真代码形式的串喂给扫描器 ⇒ 必须命中（反空洞真的**新载体**，
    //     与上面 `it.each(cases)` 的 `want=true` 那 5 条同一把尺子，这里额外
    //     钉住"`.getDoc(` 这个具体调用位正则"本身仍有效）。
    //
    // ⇒ "扫描器抓得到真代码"这件事**照样有判据**，且不依赖任何仍存活的生产调用点。
    const readSrc = (rel: string): string => readSourceText(path.join(WEB_ROOT, 'src', rel))
    const refs = (rel: string): number =>
      stripNonCode(readSrc(rel))
        .split('\n')
        .filter((l) => /\.getDoc\s*\(/.test(l)).length

    // ① 真树：散文提及不算消费者（`seams.ts` 的说明字符串就是这一类）
    expect(refs('composition/seams.ts'), 'seams.ts 只有散文提及，不得算消费者').toBe(0)

    // ①′ 真树：**D3 之后全树真代码为 0** —— 这是本条的相位更新（不是删除）。
    // 逐文件扫描 `src/`（与 `scanEntryResidual` 同一遍历口径），而不是抽查几份：
    // 抽查会在"某处漏删"时假绿。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue
          walk(full)
          continue
        }
        if (!/\.(ts|vue)$/.test(ent.name)) continue
        const rel = path.relative(path.join(WEB_ROOT, 'src'), full).replace(/\\/g, '/')
        if (refs(rel) > 0) offenders.push(rel)
      }
    }
    walk(path.join(WEB_ROOT, 'src'))
    expect(offenders, 'D3 已终删 `getDoc()` ⇒ 生产里不得再有真代码调用').toEqual([])

    // ①″ 真树：**已核销**的旧消费者现在为 0（"核销"这件事本身有判据在管）
    expect(
      refs('workbench/ux/PropertyInspector.vue'),
      'PropertyInspector.vue 已核销（不再是消费者）；若此处 > 0 说明 C′1 的替换被回退',
    ).toBe(0)
    expect(refs('editors/workbench-rna.ts'), 'workbench-rna.ts 已核销（D3 迁移）').toBe(0)
    expect(refs('context/queries.ts'), 'queries.ts 已核销（D3 迁移）').toBe(0)

    // ② 合成输入：真代码形式 ⇒ 必须命中（本条的反空洞真）
    // ⚠️ 只喂**引用位**（带点接收者）：声明位（`getDoc(): Ref<…> {`）由
    // registry 的 `scope: 'own'` 判据单独处理 —— `refs_of` 的口径是"引用位"，
    // 把声明位喂进来会因正则本身不匹配而假红（不是扫描器弱，是口径不同）。
    const codeLike = [
      'const d = ctx.getDoc().value',
      'const before = ctx.getDoc().value?.clone() ?? null',
      'if (ctx.getDoc().value !== null) return',
    ]
    for (const line of codeLike) {
      expect(
        refs_of(line),
        `扫描器必须抓得到真代码形式：${line}`,
      ).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 铁律 6：读入口归一化（EOL 不敏感），且**证伪侧**也钉住
// ─────────────────────────────────────────────────────────────────────────────

describe('铁律 6：读入口归一化 ⇒ 判据与检出口径无关', () => {
  it('`readSourceText` 恒返回 LF：对 CRLF 输入剥离 CR，对 LF 输入幂等', () => {
    // **不依赖本树检出口径** —— 否则这条会变成"CRLF 树上绿、LF 树上红"的新 EOL 脆性。
    // （我第一版正是这样写的，被"把 src/ 转成 LF 再跑"的反向验证当场判红。）
    // 改为用**临时文件**构造两种输入，验的是函数语义而非本树口径。
    const os = require_('node:os') as typeof import('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-eol-'))
    try {
      const crlfFile = path.join(dir, 'crlf.ts')
      const lfFile = path.join(dir, 'lf.ts')
      fs.writeFileSync(crlfFile, 'const a = 1\r\nconst b = 2\r\n', 'utf8')
      fs.writeFileSync(lfFile, 'const a = 1\nconst b = 2\n', 'utf8')
      // CRLF 输入 ⇒ 进入判据的文本不含 CR
      expect(readSourceText(crlfFile), 'CRLF 必须被归一化').toBe('const a = 1\nconst b = 2\n')
      expect(readSourceText(crlfFile).includes('\r')).toBe(false)
      // LF 输入 ⇒ 幂等（归一化不改变已归一化的文本）
      expect(readSourceText(lfFile), 'LF 输入必须幂等').toBe('const a = 1\nconst b = 2\n')
      // 反空洞真：构造的临时文件在磁盘上**确实**是 CRLF（否则第一条什么都不证明）
      expect(fs.readFileSync(crlfFile, 'utf8').includes('\r\n')).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**真树**：本树确实读得到源码（反空洞真，与检出口径无关）', () => {
    // 上一版这里断言"磁盘原文必为 CRLF" ⇒ 在 LF 检出上判红。那是我引入的新脆性：
    // 本树口径由 `core.autocrlf` 决定，**不是**被测函数的事实 ⇒ 不该断言。
    // 这里只断言"真的读到了内容 + 进入判据的文本不含 CR"，口径交给上一条（用构造输入验）。
    const target = path.join(WEB_ROOT, 'src', 'application', 'queries.ts')
    const normalized = readSourceText(target)
    expect(normalized.length, '必须真的读到源码').toBeGreaterThan(1000)
    expect(normalized.includes('\r'), '无论检出是 CRLF 还是 LF，进入判据的文本都不含 CR').toBe(false)
  })

  it('**证伪侧**：$ 锚定判据在未归一化的 CRLF 行上会失配（"恰好安全 ≠ 判据安全"）', () => {
    const crlfLine = 'const d = ctx.getDoc().value\r' // 未归一化时 split('\n') 的产物
    const lfLine = 'const d = ctx.getDoc().value'
    // 无锚（本文件现状）：两种口径都命中 ⇒ 当前恰好安全
    expect(/\bgetDoc\s*\(/.test(crlfLine)).toBe(true)
    expect(/\bgetDoc\s*\(/.test(lfLine)).toBe(true)
    // 有锚（将来任何人加 `$`）：未归一化时**失配** ⇒ 归一化是必要的
    expect(/getDoc\(\)\.value$/.test(crlfLine), '尾部 \\r 使 $ 失配').toBe(false)
    expect(/getDoc\(\)\.value$/.test(lfLine)).toBe(true)
  })

  it('**真树**：判据命中数与检出口径无关（逐文件实测，反空洞真）', () => {
    const probes: readonly RegExp[] = [/\bgetDoc\s*\(/, /\btick\s*\(/, /materialLibrary\.tick\s*\(/]
    let compared = 0
    const diffs: string[] = []
    for (const abs of productionFiles()) {
      const raw = fs.readFileSync(abs, 'utf8')
      const lf = raw.replace(/\r\n/g, '\n')
      for (const re of probes) {
        const onRaw = raw.split('\n').filter((l) => re.test(l)).length
        const onLf = lf.split('\n').filter((l) => re.test(l)).length
        compared++
        if (onRaw !== onLf) diffs.push(`${path.relative(WEB_ROOT, abs)} ${re}`)
      }
    }
    expect(compared, '必须真的比较过（反空洞真）').toBeGreaterThan(1000)
    expect(diffs, '命中数与检出口径出现差异 ⇒ 该判据未走归一化读入口').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 相位翻转仿真：证明"P5/P6 执行删除后翻相位能保持绿"
// ─────────────────────────────────────────────────────────────────────────────

describe('相位翻转仿真：把登记表投影到一份"已执行删除"的临时树上验算', () => {
  /**
   * 复制 `src/` 到临时目录，并按"执行方完成删除"的方式改写：
   *  - `fileRemoved: true` 的条目 ⇒ 删除该文件；
   *  - `fileRemoved !== true` 的条目 ⇒ 删除该文件里命中**本条目判据**的行
   *    （模拟"机制被裁剪掉，文件继续存在"）。
   *
   * 这是 Lead 验收判据「P5/P6 置 executed 后全树测试保持绿」的**可执行证明**：
   * 若判据写错（如 v1 的裸子串会把 `getDocument` 算进去），仿真里那条判据就无法
   * 归零 —— 本用例会判红，从而在**执行方开工前**暴露问题。
   */
  function projectExecutedTree(): string {
    const tmp = fs.mkdtempSync(path.join(require_('node:os').tmpdir(), 'wk-p4-flip-'))
    const dest = path.join(tmp, 'web')
    fs.cpSync(path.join(WEB_ROOT, 'src'), path.join(dest, 'src'), { recursive: true })

    // ① 整文件退役：删除文件。
    for (const e of RETIREMENT_REGISTRY) {
      if (e.fileRemoved !== true) continue
      fs.rmSync(path.join(dest, e.file.replace(/^web\//, '')), { force: true })
    }

    // ② 机制退役：删除命中**任意**条目判据的行。
    //
    // **必须一次性（按所有条目的判据并集）过滤，而不是逐条目依次过滤**：
    // 逐条过滤时，先处理的条目可能把某行留下（它不匹配该条判据），
    // 而后处理的条目本应删掉它 —— 但因为前一轮已重写文件，顺序就成了隐式依赖。
    // 首版仿真正是这样误报"无法归零"。
    //
    // 文件集合 = 各条目的**机制退役文件** ∪ **所有**条目的消费者清单。
    //
    // 注意 `consumers` 要**无条件**收集（不只机制退役类）：整文件退役类
    // （`useMultiblockChannels.ts`）的消费者（两个视口）也必须被裁剪，
    // 否则它们对已删符号的引用会让判据归不了零 —— 首版仿真在这里抓到第二处。
    //
    // `allMatchers` 同理必须收**全部**条目的判据（含整文件退役类）：
    // 消费者迁移时删掉的是"对已删符号的调用行"，那正是整文件退役类的判据。
    // 只收机制退役类的判据会漏掉这类调用行（首版仿真第三次抓到）。
    const allMatchers = RETIREMENT_REGISTRY.flatMap((e) => e.symbols.map((c) => new RegExp(c.pattern)))
    const files = new Set<string>()
    for (const e of RETIREMENT_REGISTRY) {
      if (e.fileRemoved !== true) files.add(e.file.replace(/^web\//, ''))
      for (const c of e.consumers ?? []) files.add(c.replace(/^web\//, ''))
    }
    for (const rel of files) {
      const abs = path.join(dest, rel)
      if (!fs.existsSync(abs)) continue
      // **整文件**去注释/字符串（而不是逐行）：扫描器是有状态的（块注释、模板
      // 字面量都跨行），逐行喂入会让"看起来是代码"的片段残留（首版实测：
      // 块注释中间那几行不含行首标记，逐行调用时状态被重置）。
      // 输出与输入**逐行对齐**（不删行），故可按下标安全裁剪。
      //
      // 归一化后以 `\n` 重写：仿真树是**一次性临时树**（`mkdtemp`），其 EOL 不构成
      // 交付面；归一化保证"词法结果"与"裁剪下标"口径一致。
      const raw = readSourceText(abs)
      const codeLines = codeOfSource(abs, raw).split('\n')
      const kept = raw.split('\n').filter((_line, idx) => {
        const code = codeLines[idx] ?? ''
        return !allMatchers.some((re) => re.test(code))
      })
      fs.writeFileSync(abs, kept.join('\n'), 'utf8')
    }
    return dest
  }

  it('**执行删除后，每条判据都能归零**（无"无法满足的断言"）', () => {
    const root = projectExecutedTree()
    try {
      for (const e of RETIREMENT_REGISTRY) {
        const residual = scanEntryResidual(e, { root, includeOwnFile: true })
        expect(
          residual.map((r) => `${r.file} [${r.symbol}] ${r.line}`),
          `${e.file} 在"已执行删除"的仿真树上仍有残留 —— 说明该条判据无法被满足（执行方会永远红）:\n` +
            residual.map((r) => `${r.file} [${r.symbol}] ${r.line}`).join('\n'),
        ).toEqual([])
      }
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true })
    }
  })

  it('**原树仍有残留**（反空洞真）：仿真归零不是因为判据恒空', () => {
    for (const e of RETIREMENT_REGISTRY) {
      if (e.status === 'executed') continue
      const residual = scanEntryResidual(e, { includeOwnFile: true })
      expect(
        residual.length,
        `${e.file} 在**原树**上判据 0 命中 —— 那么上一条仿真归零就没有意义（判据本就恒空）`,
      ).toBeGreaterThan(0)
    }
  })

  it('仿真**不修改**原树（跑完 `src/` 与运行前逐字节一致）', () => {
    // ⚠️ **本条刻意不归一化**（唯一的例外，且必须保持为例外）。
    //
    // 铁律 6 要求"读源码 + 正则/切片断言"归一化；但本条的判据**正是字节级不变量**：
    // "仿真过程没有改动原树一个字节"。若把两个读入口也归一化，判据会**失去检出能力**：
    //
    //   原树被误改成 LF 时（内容相同、字节不同）
    //     逐字节比较   ⇒ 检出（true）
    //     归一化后比较 ⇒ **不检出**（false）—— 被改动的证据恰好被归一化抹掉
    //
    // 这与归一化并不冲突：归一化的目的是让**语义**断言不随 EOL 漂移；
    // 而本条的语义**就是**"EOL 也不许变"。把它归一化等于把判据改成恒真。
    const before = productionFiles().map((f) => [f, fs.readFileSync(f, 'utf8')] as const)
    const root = projectExecutedTree()
    clearCodeCache() // 丢弃临时树条目的记忆（那棵树的路径随即删除）
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
    for (const [file, text] of before) {
      expect(fs.readFileSync(file, 'utf8'), `${file} 在仿真后不应被改动`).toBe(text)
    }
  })
})
