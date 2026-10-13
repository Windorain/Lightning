/**
 * `adapters/files/projectFormat` —— **工程格式**（类型化文档 / 版本 / 资源清单 / 可恢复编辑数据）
 * （#249 §12 第 1 段；契约 §1.1/§6；#260 交付范围第 1 项）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧实现**没有工程格式**：工作台把"当前编辑文档"直接写成场景文件
 * （`mod/.../SdeWebServer.java:373-375` 的 `_sde_workspace.json`），
 * 于是一份文件同时承担了三种角色：
 *
 * | 角色 | 旧载体 | 问题 |
 * |---|---|---|
 * | 工程（可继续编辑的内容） | `_sde_workspace.json` | 与产物同格式 ⇒ 无法表达"版本 / 资源清单 / 可恢复编辑数据" |
 * | 发布产物（查看所需内容） | 场景文件本身 | 见 `adapters/files/publishFormat` |
 * | 工作环境（布局/个人偏好） | 散在 `localStorage` 各键 | 与文档内容混在一起，切文档时互相污染 |
 *
 * `#249` §12 把这三件事拆开：
 *
 * > 「工程格式保存**类型化文档、版本、资源清单与可恢复的编辑数据**；
 * > **布局和个人偏好单独保存，通过文档 ID 重新绑定**。」
 *
 * 本模块负责前半句；后半句在 `adapters/files/documentBinding`（那里的键由**文档 ID**
 * 构成 —— 这正是"重新绑定"的可执行含义）。
 *
 * ## 三条设计判据（各自对应一条会被静默违反的约束）
 *
 * ### 1. `formatVersion` 是**显式**的，且未知版本**显式拒绝**
 *
 * 工程格式会演进。若读入端遇到 `formatVersion: 3` 时"尽力而为"地当 2 处理，
 * 那么版本 3 新增的字段会被**静默丢弃**（因为它们不在读入端认识的键里）——
 * 用户下次保存就永久丢了它们。⇒ {@link decodeProject} 对未认识的主版本返回
 * `UnsupportedOperation`（契约 §3.2：能力不存在），**不**尝试降级读取。
 *
 * ### 2. 资源清单：**资源 ID + 内容版本/哈希**，URL 仅获取位置
 *
 * `#249` §19.3 原文：「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**」。
 * 故 {@link ProjectAssetRef} 的三元组里，`contentVersion` 参与身份、`locator` 不参与。
 * 这条在工程格式里格外重要：同一个 URL（例如 `textures/blocks/ore.png`）在不同版本
 * 的包里是**不同内容**，按 URL 去重会让工程在换包后引用到错的贴图。
 *
 * ### 3. 「可恢复的编辑数据」**不含**布局与个人偏好
 *
 * 这是本模块最容易做错的地方，故用**类型**挡住：{@link RecoverableEditData} 的字段
 * 全部来自契约 §6 表的「选择、活动对象、时间、通道取值、活动工具」一行，
 * 而**机位、局部显示、面板布局、语言、主题**在类型里**没有位置**。
 * 想往工程文档里写机位，得先改这个类型 —— 那是一次 review 可见的改动，
 * 不是一次顺手 `payload.camera = view`。
 */

import {
  createDocument,
  withContent,
  withDocumentContent,
  type Document,
} from '@/domain/document'
import { createEditContext, type EditContext, type SelectionState } from '@/domain/editing'
import { invalidValue, unsupportedOperation, type Result, ok, err } from '@/domain/errors'
import { canonicalize, digestOf, entityRef, type EntityRef } from '@/domain/identity'
import type { Scene } from '@/domain/scene'
import { EMPTY_ANIMATION, type AnimationState, type TimeValue } from '@/domain/animation'
import { type DocumentContent } from '@/domain/content'

/**
 * 工程格式主版本。
 *
 * 判据是**主版本**（`major`）：同主版本内的次版本差异必须是**加宽**（新增可选字段），
 * 故可以互读；跨主版本意味着字段语义可能变了，必须显式拒绝（见文件头判据 1）。
 */
export const PROJECT_FORMAT_MAJOR = 1
export const PROJECT_FORMAT_VERSION = '1.0'

/** 工程文件的 `formatVersion` 字符串形态（与 `PROJECT_FORMAT_VERSION` 同源）。 */
export const PROJECT_FORMAT_FIELD = 'formatVersion'

/**
 * 资源引用（工程清单项）。
 *
 * `locator` 是**获取位置**（URL 或宿主路径）。命名用 `locator` 而不是 `url`：
 * 它不一定是 URL（mod 侧内嵌资源是类路径），而**任何**取回方式都不参与身份判定 ——
 * 用 `url` 命名会诱导调用方写 `assets[url]`。
 */
export interface ProjectAssetRef {
  readonly assetId: string
  /** 内容版本/哈希（参与身份；见文件头判据 2）。 */
  readonly contentVersion: string
  /** 获取位置（**仅**用于取回）。 */
  readonly locator: string
}

/**
 * **可恢复的编辑数据**（#249 §12 的"可恢复编辑数据"）。
 *
 * 逐字段对应契约 §6 所有权的「选择、活动对象、时间、通道取值、活动工具」一行。
 * 逐个说明**为什么它在工程里**（而不是"顺手全存了"）：
 *
 * | 字段 | 为什么进工程 | 为什么不是偏好 |
 * |---|---|---|
 * | `selection` / `active` | 重开工程时"上次在改哪个对象"是最强的上下文 | 选择是**文档相关**的：换文档后旧选择必须失效，故按文档存 |
 * | `time` | 动画轨道的求值时刻；不带它重开就看不到上次的帧 | 时间属共享编辑上下文（#249 §1.1 方向 7），不是实例外观 |
 * | `channelValues` | 多方块通道的**手动预览取值**（`#249` §3.3） | 不是发布默认值（那个在 `animation.publishedDefaults`） |
 * | `activeTool` | 上次使用的工具 | 工具是编辑动作的一部分，不是 UI 布局 |
 *
 * **明确不含**：相机/观察视角（属 3D 编辑器实例）、区域布局（属 `Workspace`）、
 * 语言/主题/键位（用户持久偏好）。
 */
export interface RecoverableEditData {
  /** 编辑上下文 id（同一工程重开时恢复同一上下文身份）。 */
  readonly contextId: string
  readonly selection: readonly EntityRef[]
  readonly active: EntityRef | null
  readonly selectionMode: SelectionState['mode']
  readonly time: TimeValue
  readonly channelValues: Readonly<Record<string, number>>
  readonly activeTool: string | null
}

/**
 * 工程文档负载（工程格式的**类型化**内容）。
 *
 * 与 `domain/document.Document` 的差异是**有意**的：`Document` 还带
 * `history`（撤销栈）与 `types`（类型注册表）。这两者**不进工程文件**：
 *  - `history`：契约 §6 表「历史与保存基线 | 基线运行期；**历史默认不写工程**」；
 *  - `types`：类型注册表由**装配**决定（profile），不是用户内容 —— 存进文件会让
 *    "这份工程用什么类型"变成文件里的数据，与 `#249` §10「运行实例由解析结果创建」
 *    的装配职责冲突。
 */
export interface ProjectPayload {
  readonly documentId: string
  readonly sceneId: string
  readonly scene: Scene
  readonly animation: AnimationState
  /**
   * **文档内容的其余三块**（`DocumentContent`：文档元数据 + 帧时长轴 + 资源内容）。
   *
   * ## 为什么必须与 `assets` 并存（R1-α 接手生产时实测抓出的保真缺口）
   *
   * `assets` 是**清单**（`assetId`/`contentVersion`/`locator` —— 只有**身份**），
   * 而 `ContentResource` 还带**内容面**：`payload`（内嵌 base64 字节）、`blend`、
   * `emissive`、`animation`（纹理序列规格）、`atlas`、`linear`、`useMipmaps`。
   *
   * R1-α 把本模块接进生产后**当场实测**：`restoreProject` 只用
   * `createDocument` + `withContent(scene, animation)` ⇒ 重开一份工程得到
   * `content.resources === []`、`metadata` 全空、`frameAxis` 零帧 ——
   * **纹理字节、材质呈现参数、逐帧时长与文档元数据全部丢失**。
   * 那不是"表示差异"，是**内容丢失**（判据 `r1aProjectFormatProduction.test.ts`
   * 的往返对照当场判红，资源清单 62 条 → 0 条）。
   *
   * ⇒ 负载必须**直接编码内核 `Document`**（#249 §12 逐字：
   * 「工程格式保存**类型化文档**、版本、资源清单与可恢复的编辑数据」）——
   * `scene` + `animation` + 本条就是"类型化文档"的全部。
   *
   * ## 为什么是**可选**字段（同主版本加宽，不是版本跳跃）
   *
   * `formatVersion` 的判据是**主版本**，且同主版本内的差异必须是**加宽**
   * （见文件头判据 1）。R1-α 之前写出的工程文件没有这个键 —— 它们是合法的旧产物，
   * 必须继续可读（缺省 ⇒ `restoreProject` 退回"只有 scene + animation"的旧行为，
   * 且**不**静默编造资源）。加宽正好是这个类型演化规则允许的形态。
   *
   * ⚠️ 与 `assets` 的**关系不是冗余**：`assets` 是"这份工程引用了哪些资源身份"
   * 的**清单视图**（`assetManifestDigest` 的对象），本条是**内容本体**。
   * 用本体反推清单会丢掉"清单里声明了但内容面没有的条目"这一差异；
   * 反之用清单反推本体则会**丢掉字节** —— 正是上面实测的那次丢失。
   */
  readonly content?: DocumentContent
  /** 资源清单（可能为空：无资源的工程是合法的）。 */
  readonly assets: readonly ProjectAssetRef[]
  readonly editData: RecoverableEditData
}

/** 工程文件（线格式）。 */
export interface ProjectFile {
  readonly formatVersion: string
  readonly payload: ProjectPayload
}

// ─────────────────────────────────────────────────────────────────────────────
// 编码
// ─────────────────────────────────────────────────────────────────────────────

export interface EncodeProjectInput {
  readonly doc: Document
  readonly context: EditContext
  readonly assets?: readonly ProjectAssetRef[]
}

/**
 * 组装工程文件（纯函数；不改入参）。
 *
 * 调用方提供 `doc` + `context`（两份值），本函数把契约 §12 要求的四项逐一落进负载。
 * **不做**任何"顺手把机位/布局也带上"的便利：见 {@link RecoverableEditData} 的字段表。
 */
export function encodeProject(input: EncodeProjectInput): Result<ProjectFile> {
  if (input.doc.id !== input.context.documentId) {
    // 上下文绑定的不是这份文档 ⇒ 其 selection/time 必然指向别处。
    // 显式拒绝而不是"以 doc 为准"：静默改写会让"我存的是哪个工作环境"不可复现。
    return err(invalidValue({ reason: 'projectContextDocumentMismatch', document: input.doc.id, context: input.context.documentId }))
  }
  const assets = normalizeAssets(input.assets ?? [])
  if (!assets.ok) return assets
  return ok(
    Object.freeze({
      formatVersion: PROJECT_FORMAT_VERSION,
      payload: Object.freeze({
        documentId: input.doc.id,
        sceneId: input.doc.scene.id,
        scene: input.doc.scene,
        animation: input.doc.animation,
        // R1-α：**直接编码内核 `DocumentContent`**（元数据 + 帧轴 + 资源内容本体）。
        // 少了它就是实测的那次内容丢失（见 `ProjectPayload#content` 的说明）。
        content: input.doc.content,
        assets: assets.value,
        editData: editDataOf(input.context),
      }),
    }),
  )
}

/** 从编辑上下文抽出可恢复编辑数据（**唯一**的抽取点）。 */
export function editDataOf(context: EditContext): RecoverableEditData {
  return Object.freeze({
    contextId: context.id,
    selection: Object.freeze([...context.selection.selected]),
    active: context.selection.active,
    selectionMode: context.selection.mode,
    time: context.time,
    channelValues: Object.freeze({ ...context.channelValues }),
    activeTool: context.activeTool,
  })
}

/**
 * 资源清单规范化：按 `(assetId, contentVersion)` 去重，**稳定排序**。
 *
 * 去重键**不含 `locator`**（见文件头判据 2）。同一资源 ID 以两个不同内容版本出现时
 * **不**合并（那会丢掉其中一个版本），而是保留两条 —— 排序保证输出稳定。
 * 冲突（同 ID 同版本、不同 locator）保留**第一条**并把差异留给诊断：两个 locator
 * 指向同一内容版本是合法的（镜像），不是错误。
 */
export function normalizeAssets(assets: readonly ProjectAssetRef[]): Result<readonly ProjectAssetRef[]> {
  const out = new Map<string, ProjectAssetRef>()
  for (const a of assets) {
    if (a.assetId.trim() === '') return err(invalidValue({ reason: 'assetIdRequired' }))
    if (a.contentVersion.trim() === '') return err(invalidValue({ reason: 'assetContentVersionRequired', assetId: a.assetId }))
    const key = `${a.assetId}\u0000${a.contentVersion}`
    if (!out.has(key)) out.set(key, Object.freeze({ assetId: a.assetId, contentVersion: a.contentVersion, locator: a.locator }))
  }
  return ok(Object.freeze([...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)))
}

/**
 * 资源清单摘要（**身份**用；`locator` 不参与）。
 *
 * 为什么这个摘要有用：资源换版本时工程内容的"需要什么"变了，但**文档内容版本不变**
 * （贴图不是文档内容）。把清单摘要单独暴露出来，才能表达"内容没变、依赖变了"——
 * 而把 locator 拼进去会让"同一份资源换了个镜像地址"被当成依赖变化。
 */
export function assetManifestDigest(assets: readonly ProjectAssetRef[]): number {
  return digestOf([...assets].map((a) => `${a.assetId}@${a.contentVersion}`).sort().join('\u0000'))
}

// ─────────────────────────────────────────────────────────────────────────────
// 解码
// ─────────────────────────────────────────────────────────────────────────────

/** 工程文件解析结果（协议版本 + 负载）。 */
export interface DecodedProject {
  readonly formatVersion: string
  readonly payload: ProjectPayload
}

/** 主版本是否被本实现支持。 */
export function isSupportedProjectVersion(formatVersion: string): boolean {
  const major = Number.parseInt(formatVersion.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major === PROJECT_FORMAT_MAJOR
}

/**
 * 解析工程文件。
 *
 * 拒绝条件（全部**显式**，且各自的 reason 稳定）：
 *  - 不是对象 / 缺 `formatVersion` / 缺 `payload`；
 *  - `formatVersion` 的主版本不被支持 ⇒ `UnsupportedOperation`（**不**降级读取，见文件头判据 1）；
 *  - 负载字段形状不符（`sceneId` 非字符串、`scene` 不是对象、`editData` 缺 `contextId`）。
 */
export function decodeProject(raw: unknown): Result<DecodedProject> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(invalidValue({ reason: 'projectNotObject' }))
  }
  const o = raw as Record<string, unknown>
  const fv = o[PROJECT_FORMAT_FIELD]
  if (typeof fv !== 'string' || fv.trim() === '') {
    return err(invalidValue({ reason: 'projectMissingFormatVersion' }))
  }
  if (!isSupportedProjectVersion(fv)) {
    return err(
      unsupportedOperation({
        reason: 'projectFormatVersionUnsupported',
        formatVersion: fv,
        supportedMajor: PROJECT_FORMAT_MAJOR,
      }),
    )
  }
  const p = o.payload
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    return err(invalidValue({ reason: 'projectMissingPayload' }))
  }
  const payload = p as Record<string, unknown>
  if (typeof payload.documentId !== 'string' || payload.documentId.trim() === '') {
    return err(invalidValue({ reason: 'projectMissingDocumentId' }))
  }
  if (typeof payload.sceneId !== 'string') {
    return err(invalidValue({ reason: 'projectMissingSceneId' }))
  }
  if (payload.scene === null || typeof payload.scene !== 'object' || Array.isArray(payload.scene)) {
    return err(invalidValue({ reason: 'projectMissingScene' }))
  }
  const edit = payload.editData
  if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
    return err(invalidValue({ reason: 'projectMissingEditData' }))
  }
  const editData = edit as Record<string, unknown>
  if (typeof editData.contextId !== 'string' || editData.contextId.trim() === '') {
    return err(invalidValue({ reason: 'projectMissingContextId' }))
  }

  const assets = normalizeAssets(readAssets(payload.assets))
  if (!assets.ok) return assets

  return ok(
    Object.freeze({
      formatVersion: fv,
      payload: Object.freeze({
        documentId: payload.documentId,
        sceneId: payload.sceneId,
        scene: payload.scene as Scene,
        // 动画缺席 ⇒ 空动画（旧工程文件没有动画节是合法形态）；**不**返回 undefined，
        // 让"没有动画"与"动画没读到"在类型上不可区分才是 A36 类错误。
        animation: (payload.animation ?? EMPTY_ANIMATION) as AnimationState,
        // R1-α：内容本体缺席 ⇒ **不**编造（旧产物本就没有它）；
        // 但**有**时必须原样带过 —— 少了它 `restoreProject` 会丢资源/元数据/帧轴。
        ...(readDocumentContent(payload.content) === undefined
          ? {}
          : { content: readDocumentContent(payload.content) as DocumentContent }),
        assets: assets.value,
        editData: Object.freeze({
          contextId: editData.contextId,
          selection: Object.freeze(readEntityRefs(editData.selection)),
          active: readEntityRef(editData.active),
          selectionMode: (typeof editData.selectionMode === 'string' ? editData.selectionMode : 'single') as SelectionState['mode'],
          time: (editData.time ?? EMPTY_SELECTION_TIME) as TimeValue,
          channelValues: Object.freeze(readNumberRecord(editData.channelValues)),
          activeTool: typeof editData.activeTool === 'string' ? editData.activeTool : null,
        }),
      }),
    }),
  )
}

/** 时间缺省（与 `domain/editing` 的 `TIME_ZERO` 同值；此处不 import 以免多一处耦合）。 */
const EMPTY_SELECTION_TIME: TimeValue = Object.freeze({ frame: 0, fps: 20 })

/**
 * 读 `payload.content`（R1-α 加宽的字段）。
 *
 * ## 为什么这里做**形状闸门**而不是直接 `as DocumentContent`
 *
 * 工程文件是**外部输入**：`payload.content` 可能是任意形状（被人手改过、
 * 或被更新的主版本写出）。直接断言会让坏形状一路进到 `domain/`,
 * 在那里以 `Cannot read properties of undefined` 的形式爆在四层之外（难定位）。
 *
 * ## 为什么**不**逐字段重建（与 `readAssets` 的处置不同）
 *
 * `ContentResource` 的字段全部是**纯数据**（`ref`/`kind`/`payload`/`blend`/
 * `emissive`/`animation`/`atlas`/`linear`/`useMipmaps`），JSON 往返逐字段保真；
 * 逐字段重建反而会**漏掉将来新增的字段**（那正是"加宽兼容"要避免的：
 * 新版本写出的字段被旧版本读取时静默丢弃）。
 * ⇒ 只校验三个**结构性**前提（是对象、有 `metadata` 与 `frameAxis`、`resources` 是数组），
 * 其余原样带过。**缺前提 ⇒ 返回 `undefined`**（缺席，不是空值）——
 * 与"字段缺席 ≠ 空值"同一口径（`domain/cellContent` 判据 3）。
 */
function readDocumentContent(v: unknown): DocumentContent | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (o.metadata === null || typeof o.metadata !== 'object' || Array.isArray(o.metadata)) return undefined
  if (o.frameAxis === null || typeof o.frameAxis !== 'object' || Array.isArray(o.frameAxis)) return undefined
  if (!Array.isArray(o.resources)) return undefined
  return o as unknown as DocumentContent
}

function readAssets(v: unknown): readonly ProjectAssetRef[] {  if (!Array.isArray(v)) return Object.freeze([])
  const out: ProjectAssetRef[] = []
  for (const e of v) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue
    const o = e as Record<string, unknown>
    if (typeof o.assetId !== 'string' || typeof o.contentVersion !== 'string') continue
    out.push(Object.freeze({ assetId: o.assetId, contentVersion: o.contentVersion, locator: typeof o.locator === 'string' ? o.locator : '' }))
  }
  return Object.freeze(out)
}

function readEntityRef(v: unknown): EntityRef | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string' || typeof o.id !== 'string') return null
  return typeof o.contentVersion === 'number'
    ? entityRef(o.kind as EntityRef['kind'], o.id, o.contentVersion)
    : entityRef(o.kind as EntityRef['kind'], o.id)
}

function readEntityRefs(v: unknown): readonly EntityRef[] {
  if (!Array.isArray(v)) return Object.freeze([])
  const out: EntityRef[] = []
  for (const e of v) {
    const r = readEntityRef(e)
    if (r) out.push(r)
  }
  return Object.freeze(out)
}

function readNumberRecord(v: unknown): Readonly<Record<string, number>> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return Object.freeze({})
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 还原（工程 → 文档 + 编辑上下文）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由工程负载还原 `Document` 与 `EditContext`。
 *
 * 还原路径**只**用 `domain/document` 与 `domain/editing` 的公共出口
 * （`createDocument` + `withContent` + `createEditContext` + 逐字段赋值），
 * **不**自己造版本/内容身份 —— 于是"重开同一工程得到同一 `contentVersion`"
 * 直接继承 `domain/document` 的内容身份算法，而不是适配器再实现一份。
 *
 * ## 基线必须**钉到还原后的内容**（否则"一打开就脏"）
 *
 * `createDocument` 的 `saveBaseline` 取的是**空场景**的内容身份；`withContent` 只推进
 * `version`、**不动** `saveBaseline`（那条设计是对的：它服务"编辑后仍脏"的语义）。
 * ⇒ 若本函数直接返回 `withContent` 的结果，重开一份工程会立刻显示为"未保存的修改"，
 * 而用户**什么都没改**。这是 `isDirty` 判据（`!sameContent(version, saveBaseline)`）
 * 在还原路径上的必然结果，不是偶然的初始值问题。
 *
 * 故本函数显式把 `saveBaseline` 置为还原后的版本 —— "刚打开 = 与保存基线相同"
 * 是**打开一份工程的后置条件**。注意它**不**伪造 `documentVersion`：
 * 单调世代仍从 0 起（`createDocument` 给的值），只有内容身份被认账。
 *
 * 判据由 `projectRoundTrip.test.ts` 的「还原后的文档是干净的」逐项断言 ——
 * 该断言在本函数修好之前**确实判红**（记录在 B1 对照表的遗留一节）。
 */
export function restoreProject(decoded: DecodedProject): { doc: Document; context: EditContext } {
  const base = createDocument(decoded.payload.documentId, { sceneId: decoded.payload.sceneId })
  const withSceneAndAnimation = withContent(base, decoded.payload.scene, decoded.payload.animation)
  /**
   * ⚠️ **R1-α 实测抓出的内容丢失**（本函数此前只走 `withContent`）：
   *
   * `withContent` 只吃 `scene` + `animation`，于是资源内容（纹理字节/呈现参数/纹理序列）、
   * 文档元数据、帧时长轴**全部丢失** —— 重开一份工程得到 `resources === []`、
   * 元数据全空、帧轴零帧。判据 `r1aProjectFormatProduction.test.ts` 的往返对照
   * 当场判红（资源清单 62 条 → 0 条）。
   *
   * 修法是**用负载里的内容本体**（`payload.content`，R1-α 加宽的字段），
   * 而不是在这里编一份默认值 —— 编默认值会让"丢了"表现为"本来就是空的"。
   * 旧产物（无该键）保持旧行为：**不**编造资源（它们本就没被写出来）。
   */
  const restored =
    decoded.payload.content === undefined
      ? withSceneAndAnimation
      : withDocumentContent(withSceneAndAnimation.doc, decoded.payload.content)
  const doc: Document = Object.freeze({ ...restored.doc, saveBaseline: restored.version })
  const seed = createEditContext(decoded.payload.editData.contextId, decoded.payload.documentId)
  const context: EditContext = Object.freeze({
    ...seed,
    selection: Object.freeze({
      selected: decoded.payload.editData.selection,
      active: decoded.payload.editData.active,
      mode: decoded.payload.editData.selectionMode,
    }),
    time: decoded.payload.editData.time,
    channelValues: decoded.payload.editData.channelValues,
    activeTool: decoded.payload.editData.activeTool,
  })
  return { doc, context }
}

/**
 * 工程往返的**语义身份**是否保留（#260 判据 1 的可执行形式）。
 *
 * 检查四件事，缺一即判红：
 *  1. 内容身份相同（`contentVersion`）—— 场景与动画都进内容身份
 *     （`domain/document.contentDigestOf`）；
 *  2. 文档 id 相同；
 *  3. 资源清单摘要相同；
 *  4. 可恢复编辑数据逐字段相同（选择按**值**比较，不含对象指针）。
 *
 * 第 4 条的"按值比较"很重要：`EntityRef` 是值（契约 §1.1），
 * 于是"选择保留"可以用 `canonicalize` 逐位核对，不需要遍历对象。
 */
export interface ProjectRoundTripReport {
  readonly contentIdentityPreserved: boolean
  readonly documentIdPreserved: boolean
  readonly assetManifestPreserved: boolean
  readonly editDataPreserved: boolean
  /**
   * **文档内容本体**（元数据 / 帧时长轴 / 资源内容）是否保全（R1-α 补）。
   *
   * 与 `assetManifestPreserved` **不是同一件事**：后者只比清单的
   * `(assetId, contentVersion)` 摘要，看不见内嵌字节、呈现参数、
   * 纹理序列规格与文档元数据 —— 而 R1-α 接手生产时实测那几样曾经整体丢失
   * （清单 62 条却 `resources === []` 的形态不可由清单判据区分）。
   */
  readonly documentContentPreserved: boolean
}

export function compareProjectRoundTrip(before: ProjectFile, after: ProjectFile): ProjectRoundTripReport {
  return Object.freeze({
    contentIdentityPreserved: digestOf(before.payload.scene) === digestOf(after.payload.scene) && digestOf(before.payload.animation) === digestOf(after.payload.animation),
    documentIdPreserved: before.payload.documentId === after.payload.documentId,
    assetManifestPreserved: assetManifestDigest(before.payload.assets) === assetManifestDigest(after.payload.assets),
    editDataPreserved: canonicalize(before.payload.editData) === canonicalize(after.payload.editData),
    // 内容本体：两侧都缺席（旧产物）算保真；一侧有一侧无**不**算（那是丢失或凭空出现）。
    documentContentPreserved:
      canonicalize(before.payload.content ?? null) === canonicalize(after.payload.content ?? null),
  })
}

/** 未使用占位：保持 `Document` 类型可达（下游类型推导用）。 */
export type { Document }
