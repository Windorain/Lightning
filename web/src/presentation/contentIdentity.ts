/**
 * **内容身份** —— 替代 #249 §15 第 5 条被退役的「手推 renderViewRevision/structEpoch/refresh 链」。
 *
 * ## 被替换机制的病历
 *
 * 旧链是「任何文档写入 ⇒ `Main.replaceDoc()` 自增 `structEpoch` ⇒ 每个 DRW
 * `watch(structEpochRef)` ⇒ `rebuildAll()`」。它的三个缺陷无法局部修复：
 *
 * 1. **全量失效**：改一个注解文字与改一处几何走同一条路（G1 明确要求前者不重建方块几何）；
 * 2. **非内容版本冒充内容版本**：`bumpEpoch()` 在移动方块时被直接调用，于是调用方可以
 *    凭"我觉得该重建了"推进版本（§15 删除验收明文禁止）；
 * 3. **版本补丁**：`replaceDoc(doc, { bumpStructEpoch: false })` 是调用方在**手工打补丁**
 *    告诉渲染层"这次别重建" —— 依赖方向反了（§15 删除验收明文禁止）。
 *
 * ## 替代物：从**数据本身**算身份
 *
 * 本模块把"什么变了"变成从数据机械计算的**内容身份**，调用方不再有推版本的入口：
 *
 * | 身份 | 覆盖的内容 | 变化时该做什么 |
 * |---|---|---|
 * | `document` | 文档 id + 资源版本 | 整体换场景（重解码资源） |
 * | `structure` | 网格/调色板/多方块声明（**不含注解**） | 重建结构几何 |
 * | `annotations` | 注解集合内容 | 只重建注解叠加层 |
 *
 * 关键收益是 **G1 由构造保证**：注解内容不进 `structure` 摘要，所以"改注解文字"在
 * 类型上就**不可能**导致结构几何重建 —— 不需要任何调用方记得传 `bumpStructEpoch: false`。
 *
 * ## 为什么身份必须是"内容"而不是"提交序号"
 *
 * 契约 §1.4 明文：「内容版本**不能**用单调提交计数代替…必须能与保存基线**比较相等**」。
 * 用内容哈希时，"撤销回原内容"⇒ 身份**回到**原值 ⇒ 下游可判定"无需重建"，这正是
 * 内容身份相对计数器的核心优势（旧 `structEpoch` 只增不减，撤销也必然全量重建）。
 */

import { contentDigestOf, stableStringify } from './invalidationPlan'

/** 一次呈现的内容身份（四维，全部由数据机械派生）。 */
export interface ContentIdentity {
  /** 文档身份（文档 id + 资源版本的合成）。 */
  readonly document: string
  /** 结构身份（网格/调色板/多方块声明；**不含注解**）。 */
  readonly structure: string
  /** 注解身份（注解集合内容）。 */
  readonly annotations: string
  /** 内容资源版本（纹理等；参与 `document` 的合成，同时单独可查）。 */
  readonly resources: string
}

/** 「什么变了」的判别式（供适配层决定重建范围）。 */
export interface ContentChange {
  /** 文档/资源整体变化 ⇒ 需要重新解码资源（等价于旧 `rebuildAll` 的**合法**触发条件）。 */
  readonly documentChanged: boolean
  /** 结构变化 ⇒ 需要重解结构定义并重建几何。 */
  readonly structureChanged: boolean
  /** 注解变化 ⇒ 只需重建注解叠加层（**不得**重建结构几何）。 */
  readonly annotationsChanged: boolean
}

export function contentIdentityOf(parts: {
  documentId: string
  structureDigest: string
  annotationDigest: string
  resourceDigest: string
}): ContentIdentity {
  return {
    document: contentDigestOf([parts.documentId, parts.resourceDigest]),
    structure: parts.structureDigest,
    annotations: parts.annotationDigest,
    resources: parts.resourceDigest,
  }
}

/**
 * 计算两次身份之间的变化集。
 *
 * `prev === null`（首次）⇒ 全部为 `true`：这是"加载一份场景"的正常起点，
 * **不是**"全量失效"——它只在没有上一份内容时发生一次。
 */
export function diffContentIdentity(
  prev: ContentIdentity | null,
  next: ContentIdentity,
): ContentChange {
  if (prev === null) {
    return { documentChanged: true, structureChanged: true, annotationsChanged: true }
  }
  return {
    documentChanged: prev.document !== next.document,
    structureChanged: prev.structure !== next.structure,
    annotationsChanged: prev.annotations !== next.annotations,
  }
}

/**
 * **重建计划**（纯函数；替代"调用方手动 refresh"的决策面）。
 *
 * 这是本层对外唯一的"该做什么"出口。它的全部输入是两份内容身份，输出是显式布尔 ——
 * 因此"A11：只改机位不重建几何"与"G1：只改注解不重建方块几何"都能在没有 GPU、没有
 * Vue 的环境里断言（见 `__tests__/contentIdentity.test.ts`）。
 *
 * 语义细节（每条都有理由）：
 *  - `documentChanged` ⇒ 资源可能整批不同 ⇒ `reloadResources: true`，并且**必然**
 *    重解结构、重建几何、重建注解（场景换了，旧的一切都不再有意义）；
 *  - `structureChanged` ⇒ 重解结构定义 + 重建几何（**不**重解码资源 —— 这是旧
 *    `bindMultiblockMeshSync` 手工绕开 `rebuildAll` 的那个优化，现在由身份自然得到）；
 *  - `annotationsChanged` 单独 ⇒ **只**重建注解（G1 的字面要求）。
 */
export interface RebuildPlan {
  readonly reloadResources: boolean
  readonly resolveStructure: boolean
  readonly rebuildGeometry: boolean
  readonly syncAnnotations: boolean
}

export function planContentRebuild(change: ContentChange): RebuildPlan {
  if (change.documentChanged) {
    return { reloadResources: true, resolveStructure: true, rebuildGeometry: true, syncAnnotations: true }
  }
  return {
    reloadResources: false,
    resolveStructure: change.structureChanged,
    rebuildGeometry: change.structureChanged,
    syncAnnotations: change.annotationsChanged || change.structureChanged,
  }
}

/** 计划是否**什么都没要求**（"不动就不算"的惰性判据）。 */
export function rebuildPlanIsNoop(plan: RebuildPlan): boolean {
  return !plan.reloadResources && !plan.resolveStructure && !plan.rebuildGeometry && !plan.syncAnnotations
}

// ─────────────────────────────────────────────────────────────────────────────
// 摘要器（从数据机械派生；调用方**没有**填写或推版本的入口）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 资源摘要的**引用记忆**。
 *
 * 理由（性能，且必须是**诚实**的而非近似的）：`textureBlobs` 由文档克隆按引用复制
 * （`[...this.textureBlobs]` / `{ ...this.textureBlobs }`），且从不在原地被改写 ——
 * 因此"同一引用 ⇒ 同一内容"成立。记忆化只是省掉重复哈希，**不改变**摘要语义：
 * 换了新数组/新对象就必然重算。
 *
 * 键为对象引用，故用 `WeakMap`（不阻止 GC）。
 */
const resourceDigestMemo = new WeakMap<object, string>()

/**
 * 资源摘要：对 `textureBlobs` 的**内容**取摘要。
 *
 * 为什么必须含内容而不只是键名：A28/A36 要求"同一 URL 换内容"与"版本替换"可判定。
 * 只比键名会让"替换了纹理内容但键没变"静默复用旧资源。
 *
 * ## 身份必须与**形态**无关（**缺陷登记**，实测复查于 2026-10-15，#387 同族批）
 *
 * 本函数对入参直接 `stableStringify` ⇒ 同一逻辑资源的两种契约形态产出**不同**摘要。
 * 实测（本函数本尊，探针逐条打印，非推断）：
 *
 * | 形态 | `stableStringify` 中间串 | 摘要 |
 * |---|---|---|
 * | `['AAAA','BBBB']` | `["AAAA","BBBB"]` | `c:7f364cd1` |
 * | `{'0':'AAAA','1':'BBBB'}` | `{"0":"AAAA","1":"BBBB"}` | `c:ee985e1c` |
 *
 * 两种写法**同一份内容**（生产者决定形态：帧为主投影产对象、内核材质面/多方块产数组）
 * ⇒ 按形态分叉的身份是**假身份**。
 *
 * ### 影响面（谁按摘要做缓存/去重/比较）
 *
 * ``identity().document = contentDigestOf([documentId, resourceDigest])``（本文件 `:63-66`）
 * 与 `resources = resourceDigest`（`:69`）⇒ {@link diffContentIdentity} 的
 * `documentChanged`（`:87`）⇒ {@link planContentRebuild} 走第一条分支（`:115-117`）
 * ⇒ `reloadResources + resolveStructure + rebuildGeometry + syncAnnotations` **全 true**
 * ⇒ 同一内容的另一种形态被判成"资源整批换了"，做一次**无谓的全量重建**
 * （重解结构 + 重建几何 + 重载资源 + 重同步注解）。生产驱动点在
 * `presentation/contentSignal.ts:88-89`（`diffContentIdentity` → `planContentRebuild`），
 * 喂入点是 `runtime/presentationAdapter.ts:150`。
 *
 * ### 为什么未在本批修（**已实测的边界**，不是遗漏）
 *
 * 正解是先经唯一的形态归一化点再取摘要，但：
 *
 *  1. 本文件落在**新执行面**（`presentation` 层无 `activeSubpaths` ⇒ 整层受闸门约束），
 *     而 `gate/no-private-cross-layer` 判**发起方**且要求公共出口深度 ≤ 2。
 *     实测（2026-10-15，加了这一行 import 后跑 `npm run arch:scan`）：
 *     `FAIL（1 条 finding）· [gate/no-private-cross-layer] src/presentation/contentIdentity.ts`
 *     `新实现跨层导入了 render 层深于公共出口的实现（render/data/textureBlobPool，深度 3 > 2）`
 *     ⇒ 在本文件里 import `render/data/textureBlobPool` 必然判红。
 *  2. 接线点 `runtime/presentationAdapter.ts:150` 不在 `runtime` 层的 `activeSubpaths`
 *     （见 `tests/architecture/boundary-rules.mjs` 的 runtime 清单）⇒ **不是**闸门文件，
 *     在那里喂入前归一化无闸门冲突。
 *
 * ### 退出条件（owner 见 #387 评论 7719 存疑点 2）
 *
 * `runtime/presentationAdapter.ts:150` 改写为"先判形态、是池则归一化再取摘要"：
 *
 * ```ts
 * const raw = doc.textureBlobs ?? doc.materialPalette ?? undefined
 * resourceDigest: resourceDigestOf(isTextureBlobPoolShaped(raw) ? normalizeTextureBlobPool(raw) : raw)
 * ```
 *
 * 必须**带形态判别**：`{stone:'AAAA'}` 不是池，盲归一化会把它压成 `[]` ⇒ 摘要恒等 ⇒
 * A28/A36 的"同键不同内容"判据失效（`presentation/__tests__/contentIdentity.test.ts:178`
 * 与 `contentSignal.test.ts` 会当场判红，实测 `{stone:'AAAA'}`=`c:50b7e1fc`、
 * `{stone:'BBBB'}`=`c:33d05e48`，两者必须继续可分辨）。
 * 判据落 `render/data/__tests__/textureBlobPool.shapeContract.test.ts` 判据 ⑥（登记本读数）。
 * 该退出前，本条属**已知缺陷**，不得当作"已验证正确"。
 *
 * 注：`runtime/presentationAdapter.ts` 在**本批禁写**（另一代理在制），故本批只登记 + 报裁决。
 */
export function resourceDigestOf(textureBlobs: unknown): string {
  if (textureBlobs === null || textureBlobs === undefined) return 'r:none'
  if (typeof textureBlobs !== 'object') return contentDigestOf([textureBlobs])
  const memo = resourceDigestMemo.get(textureBlobs as object)
  if (memo !== undefined) return memo
  const digest = contentDigestOf([stableStringify(textureBlobs)])
  resourceDigestMemo.set(textureBlobs as object, digest)
  return digest
}

/**
 * 网格内容摘要：逐格下标 + 调色板身份 + 格级部件。
 *
 * `iterate` 由适配层提供（`presentation` 不依赖旧 `Grid` 类，避免把 legacy 类型带进新分层）。
 * 适配层保证回调顺序**稳定**（按 z→y→x），否则摘要会抖动。
 *
 * 为什么把"调色板身份"也纳入：同一格下标序列配不同调色板 ⇒ 几何完全不同
 * （材质/几何都变了），必须算作结构变化。
 */
export function structureDigestOf(parts: {
  /** 逐帧的网格指纹（顺序稳定；空帧用 `null`）。 */
  frames: readonly (readonly number[] | null)[]
  /** 调色板**名称级**身份（`registryId@meta` 序列，顺序稳定）。 */
  palette: readonly string[]
  /**
   * 调色板**内容级**身份（逐条完整条目，**位置即下标**，顺序稳定）。
   *
   * ## 为什么名称级（`palette`）不够（#334 实测）
   *
   * `registryId@meta` 把「条目内容不同、名称相同」的调色板**结构性地投影成同一个字符串**。
   * 而渲染链真正消费的是条目**内容**（`blockPalette[i]` 的 `geometry`/`renderMode`/
   * `tooltip`/`nbt` 直接决定画什么、标什么）。于是任何"换掉条目内容但不换方块名"的
   * 变化（多方块运行态正是这种形态：`gt.blockmachines@1000` 的 `tooltip` 从
   * `Electric Blast Furnace` 变 `… (running)`、`nbt.activeFace` 从缺席变 `true`）
   * 在结构摘要里**不可见** ⇒ `planContentRebuild` 全 false ⇒ 渲染链**什么都不做**
   * ⇒ 视口定义逐字节不变（#334 的三段实测）。
   *
   * ## 为什么是**两个**字段而不是把 `palette` 改成内容级
   *
   * 两者是不同的事实，各有消费者口径：名称级是**跨实现**的稳定身份（e2e 逐格门禁
   * `idMeta` 口径、素材登记），内容级是本仓库"到底画什么"的身份。合并会丢掉前者
   * （例如参考侧与渲染侧调色板编号重排时，名称级是唯一可比的口径）。
   */
  paletteContent: readonly unknown[]
  /** 帧级声明（变体/时长等影响呈现的结构性事实）。 */
  frameDecls: readonly unknown[]
  /** 多方块声明（通道/规则/骨架等；帧为主文档为 `null`）。 */
  multiblock: unknown
  /** 仅呈现相关的视图过滤（分层预览），它改变被采集的几何。 */
  layerFilter: unknown
}): string {
  return contentDigestOf([
    parts.frames.map((f) => (f === null ? 'x' : f.join(','))),
    parts.palette,
    parts.paletteContent,
    parts.frameDecls,
    parts.multiblock,
    parts.layerFilter,
  ])
}

/** 注解摘要（注解集合内容；**不进**结构摘要 —— G1 的构造保证）。 */
export function annotationDigestOf(annotations: readonly unknown[]): string {
  return contentDigestOf([annotations])
}
