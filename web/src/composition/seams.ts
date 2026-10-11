/**
 * `composition/seams` —— **暂存双轨的登记表**（#250 GF-5 收敛项 4）。
 *
 * ## 这份表是什么
 *
 * #249 §15 的退役矩阵列出 13 条"旧机制 → 目标分层"的迁移。其中若干条**不可能**
 * 在某一个批次的边界内一次退完：退出需要消费者先迁走，而消费者属别的批次。
 * 这类"新机制已交付、旧路径仍在服役"的**过渡态**必须显式登记 ——
 * 否则它就从"有期限的暂存"退化成"长期并存"，而 AGENTS.md 的退役纪律
 * （#171）明文规定：**阶段间暂存的未迁移路径必须有负责人和退出阶段**。
 *
 * `boundary-rules.mjs` 的 `RETIREMENT_OWNERS` 登记的是**§15 那 13 条**本身；
 * 本表登记的是**代码里当下真实存在的双轨接缝**（seam）——粒度更细、可逐条对应到
 * 文件与函数，并且**带退出条件**。两者是"任务清单"与"现状清单"的关系。
 *
 * ## 为什么放在 `composition/`
 *
 * `composition/` 是 #249 §4 的九个目标分层之一（"装配"，无旧对应物），
 * 它的职责正是"把各层装到一起"——而**接缝恰好是装配问题**：
 * 哪条路径还没接通、临时由谁代偿、什么时候拆掉。放在 `domain/` 会让纯核心
 * 知道迁移事务；放在 `editors/` 会把装配事实藏进某个编辑器实现。
 *
 * ## 本表是**声明**而非机制
 *
 * 它不改变任何运行时行为，只让"双轨在哪、谁负责、何时退出"可被静态核对
 * （`tests/architecture/boundary-scan.test.ts` 逐条断言字段完整）。
 * 每条 `exitCondition` 必须是**可判定的**：写"迁移完成后"是空话，
 * 写"`workbench-rna.ts` 不再 import `RuntimeDocument`"才可核对。
 */

/** 一条暂存双轨的登记项。 */
export interface SeamRegistration {
  /** 稳定标识（非空、kebab-case，供测试与报告引用）。 */
  readonly id: string
  /** 涉及的文件（相对 `web/`，正斜杠）。 */
  readonly files: readonly string[]
  /** 新轨（已交付的权威路径）。 */
  readonly newTrack: string
  /** 旧轨（仍在服役、待退出的路径）。 */
  readonly oldTrack: string
  /**
   * 为什么不能在本批退完 —— 必须指向**具体的外部依赖**，
   * 而不是"工作量大"这类无法核对的说法。
   */
  readonly blocker: string
  /** 负责批次（`P<N>`）与执行单号。 */
  readonly owner: { readonly p: string; readonly issue: number; readonly duty: string }
  /**
   * **退出条件**（可静态核对的判据）。退出=删掉 `oldTrack`，
   * 并把本条从本表移除（本表的长度就是"双轨剩余数"，只应减少）。
   */
  readonly exitCondition: string
}

/**
 * 当下登记在案的接缝。**新增双轨必须在此登记**（否则 `test:arch` 会因
 * `boundary-scan.test.ts` 的"登记项字段完整"+数量对账而提醒）。
 */
export const SEAMS: readonly SeamRegistration[] = Object.freeze([
  Object.freeze({
    id: 'kernel-property-write-dual-track',
    files: Object.freeze([
      'src/editors/workbench-rna.ts',
      'src/application/property-commands.ts',
      'src/application/kernel-properties.ts',
    ]),
    newTrack:
      '内核侧唯一写入口：#253 的 `reduceCommand` → `reduceSetProperty` → RNA 注册表 + `applySetProperty`（`application/kernel-properties.ts` 注册 block/annotation/camera 的属性语义）',
    oldTrack:
      '实时工作台的面板写路径仍落在**旧运行时文档**上：`editors/workbench-rna.ts` 的 `submitPropertyWrite`/`documentStateOf` 经 `ctx.getDoc()` 读文档，而 `runtime/context.ts` 的 `getDoc()` 类型是旧 `RuntimeDocument`（`getDoc(): Ref<RuntimeDocument | null>`），再包成 `DocumentState` 传给 `applySetProperty`。机制已是同一套（同一个 RNA 表与同一个原子写路由），但**数据模型**仍是旧的 `RuntimeDocument` 而非内核的 `Scene`/`Document`。',
    blocker:
      '把实时工作台从 `RuntimeDocument` 迁到内核 `Document`/`ApplicationState` 属**工作区/Area 装配**面（`boundary-rules.mjs` 的 `RETIREMENT_OWNERS["runtime-document-triple-duty"]` 归口 P4/P9；面积/外壳归 P6），不在 #253 的退出边界内（#253 退出边界：不做 Area/外壳）。',
    owner: Object.freeze({ p: 'P10', issue: 261, duty: '集成闭环与交叉验收' }),
    exitCondition:
      '`src/runtime/context.ts` 的 `getDoc()` 不再返回 `RuntimeDocument`（类型改为内核 `Document`），且 `src/editors/workbench-rna.ts` 的 `documentStateOf` 直接由内核 `Document` 构造 `DocumentState`（不再有 `RuntimeDocument`）。届时删除本条登记。',
  }),
])

/** 按 id 取登记项（未登记返回 `undefined`，由调用方决定是缺口还是缺陷）。 */
export function seamById(id: string): SeamRegistration | undefined {
  return SEAMS.find((s) => s.id === id)
}
