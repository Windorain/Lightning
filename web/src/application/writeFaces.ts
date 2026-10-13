/**
 * `application/writeFaces` —— **写面分类与共享存储上下文**（#249 §11；R1-α 冻结）。
 *
 * ## 这份模块解决什么（它替代的旧机制）
 *
 * #249 §11 要求「格内容、对象附件、对象数据、注解**共享同一存储上下文**」，
 * 而 R1 的正式契约（`docs/contracts/web-kernel-contracts.md` v1.6）**没有**这一节 ——
 * 于是"哪一类写与文档内容共用同一份存储"只能从代码里**反推**：旧实现里
 * 格内容写在 `cellTooltipGrid`/`cellPartsGrid` 两个旁表、对象数据写在 `frames[].structure`、
 * 注解写在 `annotations`、可恢复编辑数据写在 `_sde_workspace.json`、
 * 布局/偏好散在若干 `localStorage` 键 —— **没有任何类型**在把守"它们该不该分叉"。
 *
 * R0-D② 实测的后果是具体的：`Context#setDocument` 写 legacy 文档**并镜像**内核装载状态，
 * 而 `syncLegacyFromKernel` 又把内核投影回 legacy ⇒ **同一条内容事实有两个存储**，
 * 必须靠"每次编辑两步都做"维持一致（漏一步就是 #333 的"提交成功但看不见"）。
 *
 * ## 四条写面（冻结；按"谁拥有这条事实"分，不按代码位置分）
 *
 * | 写面 | 拥有者（契约 §6 所有权表） | 共享文档内容的存储上下文？ | 进文档历史？ | 进工程文件？ |
 * |---|---|---|---|---|
 * | `document-content` | 文档状态域 | ✅ **是**（这就是它的定义） | ✅ | ✅（`ProjectPayload`） |
 * | `editor-session` | `EditContext` | ✅ 是（**选择/时间/通道/工具**是文档相关的上下文事实） | ❌（点选不记历史） | ✅（`RecoverableEditData`） |
 * | `publish-default` | 文档状态域（`animation.publishedDefaults`） | ✅ 是（发布默认值是**文档内容**，进内容身份） | ✅ | ✅ |
 * | `export-preview` | 求值缓存 / 适配器 | ❌ **不是**（派生且可丢弃，见契约 §6 表末两行） | ❌ | ❌ |
 *
 * ## 「不得分叉」的可执行含义
 *
 * **分叉** = 同一条事实在两个存储里各有一份，且允许它们在某一时刻不同。
 * 三条判据（本模块把它们变成数据，由 `writeFaces.test.ts` 逐条断言）：
 *
 * 1. **`document-content` 与 `publish-default` 必须共用同一份内容身份**
 *    （`domain/document#contentOf`）—— 两者都进 `documentVersion` 的摘要输入，
 *    故"改了其中一个而另一个不变"在结构上不可能（同一摘要函数算出同一个版本）。
 * 2. **`editor-session` 不得进文档历史，但必须进工程文件**
 *    —— 它是"文档相关的上下文事实"，不是文档内容：点选不记历史（A06），
 *    而重开工程要恢复它（#249 §12「可恢复的编辑数据」）。
 *    把这两条压成一条（要么都进历史、要么都不存）都会产生用户可见的错。
 * 3. **`export-preview` 不得成为任何事实的存储**：它只消费求值产物、可丢弃、
 *    不保存为权威（契约 §6 表「求值场景、空间索引、统计 | 求值缓存 | 按求值键复用，
 *    **可丢弃** | 不保存为权威」）。⇒ 它**不参与**共享存储上下文。
 *
 * ## 纯函数
 *
 * 无 IO / 无 DOM / 无时钟；`writeFaceOf` 只按命令的**语义类别**分类（不看它在哪一层被调用）。
 * 这正是 #249 §2.1 要的形态：分类是**领域事实**，不是接线层的一串 if。
 */

import type { Command } from './commands'

/**
 * 写面（冻结的四类；`docs/contracts/web-kernel-contracts.md` §2.5）。
 *
 * ## 为什么按"写"分类而不是按"层"分类
 *
 * 同一层里会出现多个写面（`application/` 既有文档内容写也有编辑器会话写），
 * 而**同一份事实**的写可能来自不同层（格内容既可由算子写、也可由面板写）。
 * 按层分类会让"这两条写是不是同一事实"退化成"它们在不在同一个目录" ——
 * 那与 #249 §4「按真实职责重新命名目录、类型和函数，不因旧文件存在而继续填充」矛盾。
 */
export type WriteFace = 'document-content' | 'editor-session' | 'publish-default' | 'export-preview'

/** 一条写面的冻结规格（数据，不是文档 —— 判据要断言的就是这些字段）。 */
export interface WriteFaceSpec {
  readonly face: WriteFace
  /** 权威拥有者（契约 §6 所有权表的哪一行）。 */
  readonly owner: string
  /** 是否与**文档内容**共享同一存储上下文（#249 §11 的判据面）。 */
  readonly sharesDocumentContext: boolean
  /** 是否进**文档历史**（撤销栈）。 */
  readonly entersDocumentHistory: boolean
  /** 是否推进 `documentVersion`（= 是否进内容身份）。 */
  readonly advancesDocumentVersion: boolean
  /** 是否写进**工程文件**（`adapters/files/projectFormat`）。 */
  readonly persistsToProject: boolean
  /** 是否进**恢复副本**（`application/recovery`；崩溃恢复用）。 */
  readonly persistsToRecovery: boolean
  /**
   * **分叉是否被允许**（"这条活动写能不能有两个存储"）。
   *
   * `false` = 不得分叉：它的唯一存储就是它自己的权威，出现第二份存储即为缺陷
   * （R1 要清算的形态）。
   */
  readonly mayFork: boolean
}

/**
 * 四条写面（**冻结**）。
 *
 * ⚠️ `mayFork` 全为 `false` —— 这**不是**一句口号：它意味着"第二份存储"在四类写里
 * 都**不被允许**，R1 的清算对象（legacy 镜像、`syncLegacyFromKernel`）正落在
 * `document-content` 上（那是一条被容忍的临时分叉，由接缝登记与退出条件把守）。
 */
export const WRITE_FACES: readonly WriteFaceSpec[] = Object.freeze([
  Object.freeze({
    face: 'document-content',
    owner: '文档状态域（契约 §6 第 1 行：文档内容、对象与数据、动画）',
    sharesDocumentContext: true,
    entersDocumentHistory: true,
    advancesDocumentVersion: true,
    persistsToProject: true,
    persistsToRecovery: true,
    mayFork: false,
  }),
  Object.freeze({
    face: 'editor-session',
    owner: 'EditContext（契约 §6 第 2 行：选择、活动对象、时间、通道取值、活动工具）',
    sharesDocumentContext: true,
    // 点选**不**记文档历史（A06 的正面判据：「单选不得产生历史条目」）。
    entersDocumentHistory: false,
    // 时间/选择不进内容身份 —— 播放不推进文档版本（#249 §7）。
    advancesDocumentVersion: false,
    persistsToProject: true,
    persistsToRecovery: true,
    mayFork: false,
  }),
  Object.freeze({
    face: 'publish-default',
    owner: '文档状态域（动画的 `publishedDefaults`；进内容身份）',
    sharesDocumentContext: true,
    entersDocumentHistory: true,
    advancesDocumentVersion: true,
    persistsToProject: true,
    persistsToRecovery: true,
    mayFork: false,
  }),
  Object.freeze({
    face: 'export-preview',
    owner: '求值缓存 / 适配器（契约 §6 末两行：可丢弃、不保存为权威）',
    sharesDocumentContext: false,
    entersDocumentHistory: false,
    advancesDocumentVersion: false,
    persistsToProject: false,
    persistsToRecovery: false,
    mayFork: false,
  }),
])

/** 按 face 取名（唯一查表入口；`undefined` = 未登记 ⇒ 调用方按缺陷处理）。 */
export function writeFaceSpec(face: WriteFace): WriteFaceSpec | undefined {
  return WRITE_FACES.find((f) => f.face === face)
}

/**
 * **命令 → 写面**（唯一分类点）。
 *
 * ## 为什么按 `kind` 穷举而不是按"命令长得像什么"猜
 *
 * `Command` 是**封闭判别联合**（契约 §5.2）⇒ 这里可以**穷举**，于是
 * "新增一条命令忘了分类"会在编译期被判红（`switch` 无 `default`，TS 会报
 * "函数缺少返回"）。若改用"含 `set` 就算内容写"式的正则，新增命令会被**静默**
 * 归到某一类 —— 而写面分类决定"它进不进历史 / 进不进工程"，静默分错的后果是数据丢失。
 *
 * ## ⊆ 关系（本函数的返回值必须是**恰好一个**写面）
 *
 * 每条命令**恰好**落一个写面。若某条命令名义上横跨两面（例如 `saveCompleted`
 * 既改文档基线又涉及 IO），它按"**它改动了哪一面的存储**"归类 ——
 * `saveCompleted` 改的是**保存基线**（文档状态域的一部分，与内容身份同域）⇒ 归 `document-content`。
 */
export function writeFaceOf(command: Command): WriteFace {
  switch (command.kind) {
    // ── 文档内容写（改文档状态域的内容面）──────────────────────────────────
    case 'setTransform':
    case 'addObject':
    case 'deleteObject':
    case 'setProperty':
    case 'setCellTooltip':
    case 'setCellContent':
    case 'setCellIdentity':
    case 'moveCells':
    case 'setDocumentMeta':
    case 'insertKeyframe':
    case 'removeKeyframe':
    case 'setTrackEnabled':
    case 'undo':
    case 'redo':
    case 'saveCompleted':
    case 'openDocument':
    case 'closeDocument':
      return 'document-content'

    // ── 编辑器会话写（改 `EditContext`）────────────────────────────────────
    case 'beginInteraction':
    case 'updateInteraction':
    case 'commitInteraction':
    case 'cancelInteraction':
    case 'select':
    case 'setTime':
    case 'setPlaying':
    case 'setPlaybackRate':
    case 'advancePlayback':
    case 'setChannelValue':
      return 'editor-session'

    // ── 发布默认写（`animation.publishedDefaults`；进内容身份）──────────────
    case 'publishDefault':
      return 'publish-default'

    // ── 导出/预览（无状态变更，只有效果请求）────────────────────────────────
    case 'save':
      return 'export-preview'
  }
}

/**
 * 这条命令是否**可以与其它命令并发**（"活动写不得分叉"的可执行形式）。
 *
 * ## 为什么它不等于"能不能并行执行"
 *
 * 本函数回答的是**存储语义**问题：两条写是否会各自产生一份**同一事实**的存储。
 * `export-preview` 不拥有任何事实 ⇒ 与任何写都可并发（它读快照）。
 * 其余三面都改**共享**存储 ⇒ 同文档上的两条活动写必须**串行**
 * （由 `domain/editing` 的文档级租约把守：他人持锁 ⇒ `DocumentBusy`，**不排队**）。
 *
 * @returns `true` = 该命令**不**要求独占文档写权（可与会话写并发）。
 */
export function writeIsEffectOnly(command: Command): boolean {
  return writeFaceOf(command) === 'export-preview'
}

/**
 * **存储上下文的共享关系**（#249 §11 的可执行形式）。
 *
 * `#249 §11` 要求格内容 / 对象附件 / 对象数据 / 注解**共享同一存储上下文** ——
 * 在内核里这四类事实的落点是同一个 `Document`（`scene` + `content` + `animation`），
 * 故本条判据是"它们由**同一份内容身份**覆盖"：
 *
 * - **格内容**：`blockGrid.cellContent`（对象数据载荷）⇒ 进 `scene` ⇒ 进 `contentOf`；
 * - **对象数据**：`ObjectData` ⇒ 进 `scene`；
 * - **注解**：`type === 'annotation'` 的对象 + 其载荷 ⇒ 进 `scene`；
 * - **对象附件**（宿主物品桥接 / 部件图标等）⇒ **⚠️ 尚未类型化承载**（见下文"已知缺口"）。
 *
 * ## 已知缺口（R1-α **如实登记**，不就地实现）
 *
 * "对象附件"在 #249 有要求（§11），而内核 `ObjectDataPayload` 的变体表里
 * **没有**"附件"这一类 —— 今天的等价物是旧文档根级的 `itemIndex`/`partIconTextures`/
 * `statsTemplate`（`pure/partTypes` 与 `render/schema/types` 承载），它们**不在**内核
 * `DocumentContent` 里（`domain/blockGeometry` 文件头已登记该项为遗留缺口）。
 * ⇒ 本模块**不**伪造一类附件承载；该缺口按契约 §8 登记 GF 到 #385，
 * 由 R2（多方块/部件面）承接。
 *
 * @returns 四类逐格/对象事实是否都落在同一份内容身份覆盖下（附件一项目前为 `false`）。
 */
export interface SharedStorageContextReport {
  readonly cellContent: boolean
  readonly objectData: boolean
  readonly annotations: boolean
  /** ⚠️ 对象附件**尚未**类型化承载 ⇒ 恒 `false`（如实登记，见上文"已知缺口"）。 */
  readonly objectAttachments: boolean
  /** 四项是否**全部**共享（今天是 `false` —— 那正是登记缺口的依据）。 */
  readonly allShared: boolean
}

export function sharedStorageContextReport(): SharedStorageContextReport {
  return Object.freeze({
    cellContent: true,
    objectData: true,
    annotations: true,
    objectAttachments: false,
    allShared: false,
  })
}
