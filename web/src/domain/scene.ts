/**
 * `domain/scene` —— **对象、对象数据、集合、引用**（#249 §3.1 §3.2；契约 §1 §6.2）。
 *
 * ## 三条冻结语义在本模块的落点
 *
 * 1. **对象与对象数据分离**（#249 §1.1 方向 3、§3.1）：`SceneObject` 持有稳定 ID、类型、
 *    名称、变换、可见性；**内容**在同 ID 的 `ObjectData` 里，二者各有内容版本。
 *    多个对象可引用同一 `ObjectData`（共享几何）。
 * 2. **共享几何默认按对象独立编辑**（#249 §3.2）：本模块提供 `detachObjectData` ——
 *    显式的"为对象分离出独立数据"操作；**不**在每次属性写时隐式复制整份数据。
 *    修改共享源必须是显式操作（§1.1 方向 5）。
 * 3. **写权按拥有者/内容来源判断**（#249 §3.3、契约 §6.2）：`ObjectData.owner` 携带来源
 *    （`'document'` = 用户内容，可写；`'content'` = 只读参数化内容，如多方块生成物）。
 *    **不使用整份文档一个布尔值粗略代替** —— 这是契约 §3.2 的 ReadOnly 负对照。
 *
 * ## 本次交付的三类真实对象（#252 执行范围）
 *
 * `block`（方块/网格）、`annotation`（注解框）、`camera`（相机）。#249 §13 要求它们
 * "具有同等对象地位，具体属性与编辑能力不同" —— 本模块用**同一** `SceneObject` 承载三者，
 * 差异只落在 `data` 载荷与 `capabilities` 上，不为任一类型开旁路。
 *
 * 类型扩展机制由 #253/#257 收口；本模块只保证"新增一类不需要改对象/集合/引用代码"
 * 这一骨架前提：`ObjectDataPayload` 是开放映射，`SceneObject.type` 是 `string`。
 * 但 §13 同时要求"扩展验证通过现有贡献接口新增类型，而非改核心 switch" ——
 * 故本模块**没有任何** `switch (type)`：所有类型特定行为都在 `objectTypeRegistry` 里注册，
 * 核心只做结构操作。见 `domain/scene.ts#capabilitiesOf`。
 *
 * ## 与旧模型的区别（不得复用旧通路）
 *
 * 旧 `RuntimeDocument` 用 `frame.grid` 的**空间坐标**兼任对象身份、用 `record` 承载
 * 无界字段袋（#249 §15 第 2/9 条）。本模块的对象身份是**分配出来的稳定 ID**，
 * 变换可以离开整数网格；坐标约束由显式纯策略处理，不由身份系统承担。
 */

import { digestOf, type EntityRef, type Version } from './identity'
import { ok, type Result } from './errors'
import { topologyVersionOf, unitBoxMesh, type Deformation, type MeshPayload } from './geometry'
import type { BlockGeometryAsset, BlockPaletteEntry } from './blockGeometry'
import type { CellContentTable } from './cellContent'

// ─────────────────────────────────────────────────────────────────────────────
// 数学值（#249 §19.2：右手、Y-up；保留仿射表达能力）
// ─────────────────────────────────────────────────────────────────────────────

export type Vec3 = Readonly<{ x: number; y: number; z: number }>
export type Quat = Readonly<{ x: number; y: number; z: number; w: number }>

/** 对象局部变换。§19.2：枢轴显式，不由包围盒自动推导。 */
export interface Transform {
  readonly position: Vec3
  readonly rotation: Quat
  readonly scale: Vec3
  /** 显式原点/枢轴（对象空间）。 */
  readonly pivot: Vec3
}

export const IDENTITY_QUAT: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
export const ZERO_VEC3: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 })
export const ONE_VEC3: Vec3 = Object.freeze({ x: 1, y: 1, z: 1 })

export function vec3(x: number, y: number, z: number): Vec3 {
  return Object.freeze({ x, y, z })
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  position: ZERO_VEC3,
  rotation: IDENTITY_QUAT,
  scale: ONE_VEC3,
  pivot: ZERO_VEC3,
})

export function transform(partial: Partial<Transform>): Transform {
  return Object.freeze({
    position: partial.position ?? ZERO_VEC3,
    rotation: partial.rotation ?? IDENTITY_QUAT,
    scale: partial.scale ?? ONE_VEC3,
    pivot: partial.pivot ?? ZERO_VEC3,
  })
}

export function sameVec3(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

export function sameQuat(a: Quat, b: Quat): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w
}

export function sameTransform(a: Transform, b: Transform): boolean {
  return sameVec3(a.position, b.position) && sameQuat(a.rotation, b.rotation) && sameVec3(a.scale, b.scale) && sameVec3(a.pivot, b.pivot)
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象数据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 数据来源拥有者。
 *
 * - `'document'`：用户内容，可写。
 * - `'content'`：参数化只读内容（多方块生成物），可查询/拾取但**不可编辑**（#249 §3.3）。
 */
export type DataSource = 'document' | 'content'

/**
 * 注解的**呈现几何参数**（#289 P10d：从旧注解模型搬进内核）。
 *
 * ## 本类型替代什么
 *
 * P10c（#286）实测登记（机械证据）：
 *
 * > **注解几何** | 旧面（渲染消费）`min/max/renderStyle/renderOpacity/color/overlay/
 * > frameThickness/frameIndex/locked…` | 内核承载 `{shape, text?}` 两项 |
 * > 实测：注入完整 box 注解 ⇒ 内核 payload = `{"kind":"annotation","shape":"box","text":"T\n\nD"}`
 * > —— **几何字段全丢**
 *
 * 后果是内核通道下的注解**渲染不出几何**（`annotationMeshProvider` 读的
 * `min/max/renderStyle/...` 在载荷里不存在）—— 即渲染链切换会让注解全部消失。
 *
 * ## 为什么是"可选的一包参数"而不是把 5 种注解各自的字段都摊进联合
 *
 * 旧模型是 5 个 interface（`BoxAnnotation`/`PointAnnotation`/…）+ 一个 `AnnotationBase`
 * 基类，共 **21 个字段**，且**字段与 shape 强相关**（`min`/`max` 只对 box 有意义，
 * `arrow` 只对 line 有意义）。把它们全摊进 `ObjectDataPayload` 的分支会让
 * "一个 box 注解带着 `arrow` 字段"在类型上**可表达**——而那是无意义的组合。
 *
 * 同时也不能按 shape 再开 5 个分支：`ObjectDataPayload` 是**开放映射**
 * （`domain/scene` 文件头：#13「新增一类不需要改核心」），按 shape 分叉会把
 * "注解形状"变成需要改核心的类型级事实。
 *
 * ⇒ 取中间：`shape` 保持**判别式**（既有），几何参数以 {@link AnnotationGeometry}
 * 这一**具名结构**承载（字段全可选、与 shape 解耦），呈现层按 shape 决定读哪些。
 * 这不是"字段袋"：每个字段都是具名的、有类型的（#249 §15 第 2 条要退役的是
 * `Record<string, unknown>` 那种**无界键空间**，而这里是**封闭字段集**）。
 */
export interface AnnotationGeometry {
  /** 盒：局部（居中）坐标的最小角。 */
  readonly min?: Vec3
  /** 盒：局部（居中）坐标的最大角。 */
  readonly max?: Vec3
  /** 点/文字锚点（RAW Y-up 世界坐标）。 */
  readonly pos?: Vec3
  /** 线：折点序列（RAW Y-up）。 */
  readonly points?: readonly Vec3[]
  /** 面：宿主格位置（RAW Y-up）与面下标。 */
  readonly blockPos?: Vec3
  readonly quadIndex?: number
  /** 颜色（CSS 颜色串，如 `#4488ff`）。 */
  readonly color?: string
  readonly renderStyle?: 'wireframe' | 'boxFrame' | 'translucent' | 'hidden'
  readonly renderOpacity?: number
  readonly fillOpacity?: number
  readonly frameThickness?: number
  readonly overlay?: boolean
  readonly locked?: boolean
  readonly icon?: 'diamond' | 'circle' | 'square' | 'cross'
  readonly size?: number
  readonly thickness?: number
  readonly arrow?: 'none' | 'start' | 'end' | 'both'
  readonly showPoints?: boolean
  readonly fontSize?: number
  readonly backgroundAlpha?: number
  readonly linkedAnnotationId?: string
  readonly frameIndex?: number
  readonly createdAt?: number
  readonly updatedAt?: number
}

export type ObjectDataPayload =
  | {
      readonly kind: 'blockGrid'
      readonly cells: Readonly<Record<string, string>>
      /**
       * **网格的声明尺寸**（`sizeColumn` = x 宽、`sizeRow` = y 高、`sizeZSlice` = z 深）。
       *
       * ## 为什么必须显式承载（#301 P10f D3，Lead 裁决 D-1(甲)）
       *
       * `cells` 是**稀疏**键表（`"x,y,z"` → 方块身份），故"网格多大"**推不出来** ——
       * 早期实现按 `max(x)+1 / max(y)+1 / max(z)+1` 推，那在两处**静默出错**：
       *
       *  1. **尾层/尾列全空** ⇒ 推得的尺寸比文件声明的小。实测后果是
       *     `context/queries#gridHeight` 给出偏小的 `h`，而它直接进
       *     `structureRowToWorldY(row, h)` ⇒ **拾取与悬停的 Y 坐标整体偏移**；
       *  2. **空网格**（所有格都是空气）⇒ 推得 `0×0×0`，而"0 宽的网格"与
       *     "没有网格"是**两种不同状态**（与 `cellContent` 的"缺席 ≠ 空"同口径）。
       *
       * ⇒ 尺寸是**文件声明的事实**（`cellGrid` 的三个维度），必须显式承载，
       * 不能由内容反推。缺省（旧形态/未声明）= `undefined` ⇒ 消费侧如实降级为
       * 包围盒推导（**不**猜一个 `1×1×1`）。
       *
       * ## 两个消费侧**必须**同口径（#262 P11-A 补的那一侧）
       *
       * | 侧 | 消费点 | 用它做什么 |
       * |---|---|---|
       * | 读 | `runtime/gridRead#resolveGridSize`（D3 交付） | 网格尺寸（拾取/悬停/居中的基准） |
       * | 写 | `composition/kernelProjection#projectGridCells`（#262 交付） | 投影产物 `cellGrid` 的维度 —— 缺了这一侧，**保存一次就把声明的尺寸丢了**（实测：声明 6×5×4 的文档投影成 2×4×2） |
       *
       * 判定规则只有一处定义（`runtime/gridRead#declaredGridSize`），两侧共用 ——
       * 否则"哪些字段算一份合法声明"会长出第二份会漂移的实现。
       */
      readonly sizeColumn?: number
      readonly sizeRow?: number
      readonly sizeZSlice?: number
      /**
       * 逐格内容（部件 / 逐格说明）；键与 `cells` **同一套**（见 {@link cellContentKeyOf}）。
       *
       * 缺省 = 无逐格内容（**不**写成空表：使"没有"与"有但是空"可区分，
       * 与 `domain/cellContent` 文件头判据 3 同一口径）。
       */
      readonly cellContent?: CellContentTable
      /**
       * 几何**资产目录**（`assetId` → 资产）。**共享的唯一落点**。
       *
       * ## 为什么目录挂网格级、逐格只存 `assetId`
       *
       * 实测（真实信封夹具）：`appliedenergistics2:tile.BlockCableBus:0` 出现 33 次、
       * 12 种不同 `quads` 长度 —— 同 `name:meta` 在不同位置是**不同几何**。
       * 故几何不能由 `name:meta` 推出，必须显式承载；而承载方式决定了两件事：
       *
       * | 承载方式 | 共享 | 身份 |
       * |---|---|---|
       * | 逐格内联几何 | **不能**（每格一份拷贝） | 无法表达"这两格是同一份几何" |
       * | 网格级目录 + 逐格 `assetId` | 多格同 id ⇒ 一份资产 | 身份由**内容**派生（`domain/blockGeometry` 判据 2） |
       *
       * A07「共享几何默认按对象独立编辑」的前提正是**先有共享**：没有共享，
       * "独立编辑"就无从谈起。故目录式承载是唯一能证明 A07 的形态。
       */
      readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
      /**
       * 逐格 → 几何资产身份（`assetId`）。键与 `cells` 同一套。
       *
       * 缺省 = 该网格无几何资产（例如旧编辑期文档：`renderMode: 'BlockModel'`，
       * 几何由生产代码按方块身份现算）。**缺省不是"空几何"** —— 那是两种不同的能力状态。
       */
      readonly cellGeometry?: Readonly<Record<string, string>>
      /**
       * 逐格 → **调色板条目内容键**（`blockPaletteEntryKey`）。键与 `cells` 同一套。
       *
       * ## 为什么它必须存在（哪怕 `cells` 已经写了方块身份）
       *
       * `cells` 的值是 GF-7 编码的 `minecraft:<name>:<meta>` —— 它**丢掉了命名空间**
       * （`appliedenergistics2:tile.BlockCableBus` → `minecraft:tile.BlockCableBus`），
       * 且**无法区分"同 name:meta 同几何但条目内容不同"的方块**。
       *
       * 而后者是**载荷承重**的：渲染侧的同调色板邻面剔除按 **palette 下标**判
       * 「是不是同一方块类型」（`render/mesh/structureGeometryCore.ts:145`），
       * 故"合并本该分开的条目"会改变剔除结果（实测：4882 → 4862 三角形）。
       *
       * ⇒ 逐格显式携带"用了哪个**条目**"，于是投影侧不需要任何猜测/回落。
       * 这是**文件的分区块状态槽**这一格式语义的类型化承载 —— 不是"用下标当身份"
       * （条目身份由**内容键**给出，与下标无关；下标只是投影时的压缩手段）。
       *
       * 缺省 = 载荷没有该信息（旧形态），投影侧走名称/几何匹配的**显式降级**。
       */
      readonly cellPalette?: Readonly<Record<string, string>>
      /**
       * 逐格 → **文件里的调色板槽位**（legacy `SlotBlock.paletteIndex`）。
       *
       * ## 为什么它必须显式承载（#301 P10f D3；R-WK-09 裁决 4 的落地方式）
       *
       * 三个旧消费点按这个槽位取值：
       * `context/queries#getMaterialUsageCounts`（按槽位分组）、
       * `#getBlockPaletteEntry` / `#getBlockGeometry`（旧实现经
       * `PaletteCache.get('#' + paletteIndex)` 取条目）。
       *
       * 而 `palette`（本载荷的条目表）是**重新编号**的：投影侧
       *（`composition/kernelProjection#projectGridCells`）按"非空气格首次出现序"
       * 从 1 开始重排（0 保留给 air）⇒ **内核侧的数组位置 ≠ 文件槽位**。
       *
       * ⇒ 槽位**推不出来**，只能承载。这与 `cellPalette` 的理由同族：
       * 它们都是"文件格式的表达手段"，而其中**被旧消费方当作键使用**的那一部分
       * 必须在迁移期原样保留，否则就是行为变更（R-WK-09 裁决 4 明文：
       * 「投影下标跨网格不可移植为实测事实；改下游键口径 = 行为变更不做」）。
       *
       * ⚠️ 它**不是**身份：`cellPalette` 的内容键才是（见上方字段）。
       * 缺省 = 源里没有该信息（此时读取侧如实给 `undefined`，**不**编一个下标）。
       */
      readonly cellPaletteIndex?: Readonly<Record<string, number>>
      /**
       * 该网格实际使用的**调色板条目**（按内容去重后的稳定序）。
       *
       * 与 `geometry` 的分工：目录回答"资产长什么样"，本字段回答"这份网格引用了
       * 哪些**方块身份 + 呈现提示**的组合"（`occludesAdjacentFaces`/`facing`/`nbt`/`tooltip`
       * 是**逐条目**事实，不是逐资产事实 —— 同一份几何可以配不同的 `nbt`）。
       */
      readonly palette?: readonly BlockPaletteEntry[]
    }
  | {
      readonly kind: 'annotation'
      readonly shape: 'box' | 'point' | 'line' | 'text' | 'face'
      readonly text?: string
      /** 呈现几何参数（#289 补）；缺省 = 该注解无几何参数（仅语义数据）。 */
      readonly geometry?: AnnotationGeometry
    }
  /**
   * 相机**参数**（投影 / fov / 裁剪面）。
   *
   * ## 四个投影字段**全部可选**（R1-β① C3；**GF-21 乙**，#385 评论 7025）
   *
   * 缺省表达的是「文档**未声明**该投影参数」——它与"声明了某个值"是**两个**事实。
   * 之所以必须能表达"未声明"：旧 `meta.embed_initial_view` 是**观察视角**
   * （`{target,yawDeg,elevationDeg,distance,zoom}`；GF-8 已裁决它归 3D 编辑器实例/
   * 宿主初始视图，**不是**文档相机参数），而装配曾把它造成一个 `camera` 对象并
   * **硬编码填充** `projection:'perspective'`/`fov:50`/`clipStart:0.1`/`clipEnd:1000`
   * （GF-21 实测；`composition/kernelAssembly#observationViewObjectsFromMeta` 已改为
   * **省略**而不是填常量）。在可选化之前，`application/queries` 的相机读面把这些常量
   * 当**真实相机参数**交出 ⇒ 渲染/导出一旦切到内核相机就是可见的行为差异。
   *
   * ⚠️ `domain/scene.ts` 的 `camera` 工厂（`addObject` 的默认参数）**照常**写满四个字段
   * —— 那是"新建相机时命令声明了这些默认值"，不是伪造：声明与省略的区别正是本字段表的要点。
   */
  | { readonly kind: 'camera'; readonly projection?: 'perspective' | 'orthographic'; readonly fov?: number; readonly clipStart?: number; readonly clipEnd?: number }
  /**
   * 逻辑网格（#254 P3 交付）：拓扑 + 固定拓扑形变。
   *
   * 形状声明在此（`ObjectDataPayload` 是唯一的数据种类联合），
   * **定义**在 `domain/geometry.ts`（`MeshPayload`）。这样做的理由有两条：
   *  1. 网格**就是**一份对象数据 —— 不另起第二个数据注册表（#249 §3.1）；
   *  2. `domain/geometry` 只 `import type` 本模块，故运行期依赖是**单向**的
   *     （本模块 → geometry），没有环。
   */
  | MeshPayload

/** 对象数据的载荷种类（供能力/呈现查询，不参与身份）。 */
export type ObjectDataKind = ObjectDataPayload['kind']

/**
 * 对象数据：与对象分离的**内容**单元（#249 §3.1「对象数据可共享，具有独立 ID 和内容版本」）。
 */
export interface ObjectData {
  readonly id: string
  /** 来源拥有者：写权按此判定（§3.3），不使用文档级布尔。 */
  readonly source: DataSource
  readonly payload: ObjectDataPayload
  /** 内容版本：内容改变时推进；供 `StaleReference` 与求值键使用。 */
  readonly contentVersion: number
  /** 拓扑版本：结构与子元素寻址相关；`ElementRef` 据此判过期（#249 §3.2）。 */
  readonly topologyVersion: number
}

/**
 * 造一份对象数据。
 *
 * ## `topologyVersion` 由载荷**导出**，不由调用方传入（#254 P3）
 *
 * P1 曾把 `topologyVersion` 硬编码为 `0`。那在只有 `blockGrid`/`annotation`/`camera`
 * 三类**无子元素结构**的载荷时恰好正确，但一旦引入网格，硬编码 `0` 就会让
 * "拓扑版本变化使旧引用显式失效"（#249 §3.2）**永远不触发** —— 引用会静默命中
 * 另一张网的同一编号元素，正是契约 §1.2 负对照要判红的形态。
 *
 * 故现在由 {@link topologyVersionOf} 从载荷导出：
 *  - 网格载荷 ⇒ 网格的真实拓扑版本；
 *  - 其余载荷 ⇒ `0`（它们没有子元素，`ElementRef` 对它们无意义）。
 *
 * ## `contentVersion` 用 `digestOf`（键序稳定）而不是 `JSON.stringify`
 *
 * P1 用 `contentDigest(JSON.stringify(payload))`。`JSON.stringify` 的键序依赖对象
 * **插入顺序** ⇒ 同一份语义内容用不同构造路径得到的摘要不同 ⇒
 * 「撤销回实际保存内容必须干净」（#249 §8）会被误判为"仍脏"。
 * `digestOf` 走 `canonicalize`（键序排序），修掉这一点。
 */
export function objectData(id: string, payload: ObjectDataPayload, source: DataSource = 'document'): ObjectData {
  return Object.freeze({
    id,
    source,
    payload,
    contentVersion: digestOf(payload),
    topologyVersion: topologyVersionOf(payload),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象类型标识。
 *
 * 本次三类：`block` / `annotation` / `camera`。它是 `string` 而非封闭联合 ——
 * 目的是让"新增一类不需要改核心"（#249 §13 A21）。类型特定行为一律经
 * `ObjectTypeDescriptor` 贡献注册，核心代码里**没有** `switch (object.type)`。
 */
export type ObjectTypeId = string

/** 对象：稳定 ID、类型、名称、变换、可见性、数据引用（#249 §3.1）。 */
export interface SceneObject {
  readonly id: string
  readonly type: ObjectTypeId
  readonly name: string
  readonly transform: Transform
  readonly visible: boolean
  /** 引用的对象数据 ID。同一 ID 可被多个对象引用（共享几何）。 */
  readonly dataId: string
  /**
   * 显式父对象 ID（变换父子链）。§19.2：**集合成员不隐式成为变换父子**；
   * 父链无环由 `sceneParentChain` 判定并显式拒绝。
   */
  readonly parentId?: string
}

export function sceneObject(init: {
  id: string
  type: ObjectTypeId
  name?: string
  transform?: Transform
  visible?: boolean
  dataId: string
  parentId?: string
}): SceneObject {
  const out: {
    id: string
    type: ObjectTypeId
    name: string
    transform: Transform
    visible: boolean
    dataId: string
    parentId?: string
  } = {
    id: init.id,
    type: init.type,
    name: init.name ?? init.id,
    transform: init.transform ?? IDENTITY_TRANSFORM,
    visible: init.visible ?? true,
    dataId: init.dataId,
  }
  if (init.parentId !== undefined) out.parentId = init.parentId
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 集合（组织与可见性，**不是**变换父子）
// ─────────────────────────────────────────────────────────────────────────────

export interface ObjectCollection {
  readonly id: string
  readonly name: string
  /** 显式成员列表；集合是组织手段，不形成变换父子（#249 §19.2）。 */
  readonly members: readonly string[]
  readonly visible: boolean
}

export function objectCollection(id: string, name: string, members: readonly string[] = [], visible = true): ObjectCollection {
  return Object.freeze({ id, name, members: Object.freeze([...members]), visible })
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 场景：对象 + 数据 + 集合 + 组织关系。
 *
 * 全部字段只读；所有变更返回**新场景**并**结构共享**未变更部分
 * （契约 §3.1「保持未改分支的身份属于实现契约」）。
 */
export interface Scene {
  readonly id: string
  /** 对象按 ID 索引。 */
  readonly objects: Readonly<Record<string, SceneObject>>
  /** 数据按 ID 索引（可被多个对象共享）。 */
  readonly data: Readonly<Record<string, ObjectData>>
  readonly collections: Readonly<Record<string, ObjectCollection>>
  /** 稳定绘制/枚举顺序（不是身份）。 */
  readonly order: readonly string[]
}

export function emptyScene(id: string): Scene {
  return Object.freeze({ id, objects: Object.freeze({}), data: Object.freeze({}), collections: Object.freeze({}), order: Object.freeze([]) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型能力（贡献式，无核心 switch）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象类型的能力描述。由类型贡献方注册，核心只查表。
 *
 * ## 本批（#250 GF-5 收敛）删除了 `animatableProperties` 白名单
 *
 * 该字段原本是一份"哪些属性可动画"的字符串清单，作为写面的**内联白名单**被
 * `application/commands.ts` 的 `validatePropertyWrite` 消费。收敛后属性语义的
 * 唯一权威是 RNA 注册表（`application/properties.ts` 的 `PropertyDescriptor.animatable`），
 * 该函数连同白名单一起删除，于是这个字段**零生产消费者**。
 *
 * 为什么是删除而不是"改成查 RNA 注册表"：`domain/` **不得** import `application/`
 * （依赖方向单向向下，见 `tests/architecture/kernel-legacy-isolation.test.ts` 的
 * 「内核不得依赖旧层」与分层公共出口约束）。`domain` 这里能做的只有"声明资格"，
 * 而"资格"本身已经由 RNA 描述承载得更完整（含单位、值域、采样钩子）——
 * 留一份查不到的清单只会成为第二个漂移源。
 *
 * ## 为什么这里**只有数据**，没有 `create`（P6 / #257）
 *
 * P6 第一次实现时把"造对象"的工厂函数（`create`）放进了本描述符。
 * `pureDomain.test.ts` 立刻判红：`structuredClone(openDocumentState())` 抛
 * `DataCloneError` —— 因为 `Document.types` 是**应用状态的一部分**，
 * 而应用状态必须是**可克隆、可重放**的（A04「无需 DOM/GPU 重放」）。
 * 把函数塞进状态会同时破坏三件事：
 *   1. A04 的重放（记录无法序列化）；
 *   2. A02 的纯性判据（"相同显式输入 ⇒ 相同结果"无法对状态做结构比较）；
 *   3. #249 §2.1「`read` 不导出…文档实例字段」——函数是运行期句柄。
 *
 * ⇒ 本类型只描述**数据**（可序列化）；"怎么造一个该类型的对象"是
 * **构造工厂**，属执行输入（见 `application/commands.ts` 的
 * `ExecutionInputs.objectFactories`）——这正是 #249 §5.3 的规定：
 * 「需要时间、身份分配、**能力**、随机种子时，作为输入或状态传入」。
 * 工厂是"能力"，不是"内容"。
 */
export interface ObjectTypeDescriptor {
  readonly type: ObjectTypeId
  /** 该类型数据载荷种类。 */
  readonly dataKind: ObjectDataKind
  /** 该类型是否参与"内容编辑"（相机参数属于文档，但观察视角不属于 —— §3.1）。 */
  readonly editable: boolean
}

/**
 * 内核对象类型的能力表。
 *
 * `editable` 只表达"该类型的载荷是否属内容编辑面"这一**类型级**事实；
 * **逐属性的**可写性由 RNA 的 `evaluateEditability` 按当前状态求值
 * （契约 §5.1：动态可编辑性，不是静态 readonly 开关）。
 */
/** 造对象的显式输入（`params` 由各类型自己解释）。 */
export interface ObjectCreateInit {
  readonly objectId: string
  readonly dataId: string
  readonly name?: string
  readonly params?: Readonly<Record<string, unknown>>
}

/** 造对象的结果（对象 + 它的数据）。 */
export interface ObjectCreation {
  readonly object: SceneObject
  readonly data: ObjectData
}

/**
 * 某个对象类型的**构造工厂**（执行输入；不进文档状态 —— 见 `ObjectTypeDescriptor` 注释）。
 *
 * ## 为什么返回 `Result<ObjectCreation> | null` 而**不是** `ObjectCreation | null`
 *
 * 两种"失败"必须区分（#249 §5「不能用默认值掩盖缺失」）：
 *  - **`null`** = **本装配不认识这个类型**（表里没有该类型的工厂）
 *    ⇒ 调用方报 `UnsupportedOperation`（能力缺失，不是输入有问题）；
 *  - **`Result.err`** = 类型认识，但**本次构造失败**且原因**结构化**
 *    ⇒ 调用方原样透出该错误。
 *
 * P6 变基合流时由 #254（P3）的真实需求补足：`mesh` 的构造会校验几何参数，
 * 失败原因是**多种**的（`badBoxSize` / 尺寸非有限 / id 冲突），
 * 而 `geometryCommand.test.ts` 明文断言「网格尺寸非法 ⇒ 显式
 * `InvalidValue.reason=badBoxSize`（**不压成"id 冲突"**）」。
 * 若工厂只返回 `null`，`badBoxSize` 会被压成 `UnsupportedOperation`，
 * 该断言即判红 —— 也会丢掉"为什么失败"这一最有用的诊断。
 */
export type ObjectFactory = (init: ObjectCreateInit) => Result<ObjectCreation> | null

/** 对象类型 id → 构造工厂。装配层按贡献装配它，经 `ExecutionInputs` 传入。 */
export type ObjectFactoryTable = Readonly<Record<ObjectTypeId, ObjectFactory>>

const DEFAULT_TYPES: readonly ObjectTypeDescriptor[] = Object.freeze([
  Object.freeze({ type: 'block', dataKind: 'blockGrid', editable: true }),
  Object.freeze({ type: 'annotation', dataKind: 'annotation', editable: true }),
  Object.freeze({ type: 'camera', dataKind: 'camera', editable: true }),
  /**
   * 网格对象（#254 P3）。
   *
   * ## 为什么必须在**两处**登记
   *
   * 收敛（#250 GF-5）之后「类型登记」分成两件事，缺一即表现为**显式失败**：
   *
   * | 登记处 | 承载的事实 | 缺失后果 |
   * |---|---|---|
   * | 本表（`domain/scene`） | `dataKind` / `editable`（能力与呈现查询） | 类型级能力查询判为未知 |
   * | RNA 注册表（`application/kernel-properties.ts`） | 逐属性描述与值域 | 属性写被判 `property-not-registered` |
   *
   * 两处都登记是**有意**的，不是重复：`domain/` 不得 import `application/`
   * （依赖单向向下），故能力表无法"查 RNA 得到"；而 RNA 需要单位/值域，
   * 也不该由 `domain` 的字符串清单承担。分工的判据是**谁需要该事实**。
   */
  Object.freeze({ type: 'mesh', dataKind: 'mesh', editable: true }),
])

/**
 * **内置对象类型的构造工厂**（装配层的默认集合）。
 *
 * 新增对象类型 = 在本表加一条（由贡献方提供），核心**不**为类型开 switch（A21）。
 * 这些条目就是原先 `add*Object` 各分支的函数体的开放化形式。
 *
 * ## 变基合流（P6 × P3 #254）
 *
 * P3 交付 `mesh` 类型时，给 `AddObjectCommand` 加了 `'mesh'` 到**封闭联合**与一个
 * `meshSize` 具名字段 —— 这恰好复现了 A21 要禁止的形态（每加一个类型都要回来改核心）。
 * 合流采用 P6 已批准的开放通道：`objectType: string` + `params`，
 * `meshSize` 移入 `params.meshSize`（与 `annotationShape` → `params.shape` 同一处置）。
 */
export const DEFAULT_OBJECT_FACTORIES: ObjectFactoryTable = Object.freeze({
  block: (init) => {
    const cells = (init.params?.cells ?? {}) as Readonly<Record<string, string>>
    return ok({
      object: sceneObject({ id: init.objectId, type: 'block', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
      data: objectData(init.dataId, { kind: 'blockGrid', cells }, 'document'),
    })
  },
  annotation: (init) => {
    const shape = (init.params?.shape ?? 'box') as 'box' | 'point' | 'line' | 'text' | 'face'
    const text = init.params?.text
    const payload = typeof text === 'string' ? { kind: 'annotation' as const, shape, text } : { kind: 'annotation' as const, shape }
    return ok({
      object: sceneObject({ id: init.objectId, type: 'annotation', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
      data: objectData(init.dataId, payload, 'document'),
    })
  },
  camera: (init) => {
    // 新建相机的**默认参数**：由命令自己声明（不是 GF-21 那种"文件名下没声明、
    // 装配却填常量"）。四个字段都写满 ⇒ 与 `kind:'camera'` 的可选字段表一致。
    const projection = (init.params?.projection ?? 'perspective') as 'perspective' | 'orthographic'
    const fov = typeof init.params?.fov === 'number' ? init.params.fov : 50
    const clipStart = typeof init.params?.clipStart === 'number' ? init.params.clipStart : 0.1
    const clipEnd = typeof init.params?.clipEnd === 'number' ? init.params.clipEnd : 1000
    return ok({
      object: sceneObject({ id: init.objectId, type: 'camera', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
      data: objectData(init.dataId, { kind: 'camera', projection, fov, clipStart, clipEnd }, 'document'),
    })
  },
  /**
   * 逻辑网格（#254 P3）。
   *
   * 构造会**校验**几何参数，故必须透出结构化失败（见 `ObjectFactory` 注释）：
   * `unitBoxMesh` 对非法尺寸返回 `InvalidValue.reason='badBoxSize'`，这里原样返回。
   */
  mesh: (init) => {
    const size = typeof init.params?.meshSize === 'number' ? init.params.meshSize : 1
    const deformation = init.params?.deformation as Deformation | undefined
    const mesh = unitBoxMesh(init.dataId, size, deformation)
    if (!mesh.ok) return mesh
    return ok({
      object: sceneObject({ id: init.objectId, type: 'mesh', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
      data: objectData(init.dataId, { kind: 'mesh', mesh: mesh.value }, 'document'),
    })
  },
})

export type ObjectTypeRegistry = Readonly<Record<ObjectTypeId, ObjectTypeDescriptor>>

export function defaultObjectTypes(): ObjectTypeRegistry {
  const out: Record<string, ObjectTypeDescriptor> = {}
  for (const d of DEFAULT_TYPES) out[d.type] = d
  return Object.freeze(out)
}

/**
 * 用**执行输入里的构造工厂**造一个对象 + 数据
 * （唯一入口；核心不为类型开 switch —— A21）。
 *
 * 返回 `null` 表示该类型没有工厂（= 本装配不认识它）。
 * 返回 `Result.err` 表示类型认识但构造失败（原因结构化）。
 * 政策（前者 ⇒ `UnsupportedOperation`、后者 ⇒ 原样透出）由调用方定，不在本函数。
 *
 * 注意该函数**不**把工厂存进任何状态 —— 工厂是输入，用完即弃。
 */
export function createObjectOfType(
  factories: ObjectFactoryTable,
  type: ObjectTypeId,
  init: ObjectCreateInit,
): Result<ObjectCreation> | null {
  const factory = Object.prototype.hasOwnProperty.call(factories, type) ? factories[type] : undefined
  if (typeof factory !== 'function') return null
  return factory(init)
}

/**
 * 查类型描述。
 *
 * 返回 `undefined` 而不是抛 —— 由调用方（纯命令）决定这算 `UnsupportedOperation`
 * 还是 `MissingTarget`，**政策不在本函数**。
 */
export function typeDescriptor(registry: ObjectTypeRegistry, type: ObjectTypeId): ObjectTypeDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(registry, type) ? registry[type] : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 查询（纯读；供 application/queries 与 domain 自身复用）
// ─────────────────────────────────────────────────────────────────────────────

export function findObject(scene: Scene, id: string): SceneObject | undefined {
  return Object.prototype.hasOwnProperty.call(scene.objects, id) ? scene.objects[id] : undefined
}

export function findObjectData(scene: Scene, id: string): ObjectData | undefined {
  return Object.prototype.hasOwnProperty.call(scene.data, id) ? scene.data[id] : undefined
}

export function objectsInOrder(scene: Scene): readonly SceneObject[] {
  const out: SceneObject[] = []
  for (const id of scene.order) {
    const o = findObject(scene, id)
    if (o) out.push(o)
  }
  return out
}

/** 引用同一份数据的对象（共享几何的消费者）。 */
export function objectsSharingData(scene: Scene, dataId: string): readonly SceneObject[] {
  return objectsInOrder(scene).filter((o) => o.dataId === dataId)
}

/** 数据是否被多个对象共享。 */
export function isDataShared(scene: Scene, dataId: string): boolean {
  return objectsSharingData(scene, dataId).length > 1
}

/** 对象的有效写权（§3.3：按**数据来源拥有者**判定）。 */
export function writeAuthority(scene: Scene, objectId: string): 'writable' | 'readOnly' | 'missing' {
  const obj = findObject(scene, objectId)
  if (!obj) return 'missing'
  const data = findObjectData(scene, obj.dataId)
  if (!data) return 'missing'
  return data.source === 'content' ? 'readOnly' : 'writable'
}

/**
 * 父链（含自身）—— 用于环路判定与父子求值顺序。
 * 返回 `null` 表示存在环（§19.2：「父链必须无环」）。
 */
export function sceneParentChain(scene: Scene, objectId: string): readonly string[] | null {
  const chain: string[] = []
  const seen = new Set<string>()
  let cur: string | undefined = objectId
  while (cur !== undefined) {
    if (seen.has(cur)) return null
    seen.add(cur)
    chain.push(cur)
    cur = findObject(scene, cur)?.parentId
  }
  return chain
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构变更（全部返回新场景；未变更的子树按引用共享）
// ─────────────────────────────────────────────────────────────────────────────

/** 插入对象 + 其数据。已存在同 ID 时返回 `null`（政策由调用方定，不静默覆盖）。 */
export function withObject(scene: Scene, obj: SceneObject, data: ObjectData): Scene | null {
  if (findObject(scene, obj.id) || findObjectData(scene, data.id)) return null
  return Object.freeze({
    ...scene,
    objects: Object.freeze({ ...scene.objects, [obj.id]: obj }),
    data: Object.freeze({ ...scene.data, [data.id]: data }),
    order: Object.freeze([...scene.order, obj.id]),
  })
}

/** 替换对象（保持 order 与未变部分身份）。 */
export function withUpdatedObject(scene: Scene, obj: SceneObject): Scene {
  return Object.freeze({ ...scene, objects: Object.freeze({ ...scene.objects, [obj.id]: obj }) })
}

/** 替换数据。 */
export function withUpdatedData(scene: Scene, data: ObjectData): Scene {
  return Object.freeze({ ...scene, data: Object.freeze({ ...scene.data, [data.id]: data }) })
}

/** 删除对象；**不**级联删除其数据（数据可能仍被别的对象共享）。 */
export function withoutObject(scene: Scene, objectId: string): Scene {
  if (!findObject(scene, objectId)) return scene
  const objects = { ...scene.objects }
  delete objects[objectId]
  return Object.freeze({
    ...scene,
    objects: Object.freeze(objects),
    order: Object.freeze(scene.order.filter((id) => id !== objectId)),
  })
}

/** 删除数据；仍被引用时返回 `null`（不产生悬挂引用，§19.2）。 */
export function withoutData(scene: Scene, dataId: string): Scene | null {
  if (objectsSharingData(scene, dataId).length > 0) return null
  if (!findObjectData(scene, dataId)) return scene
  const data = { ...scene.data }
  delete data[dataId]
  return Object.freeze({ ...scene, data: Object.freeze(data) })
}

/** 插入集合。 */
export function withCollection(scene: Scene, collection: ObjectCollection): Scene | null {
  if (Object.prototype.hasOwnProperty.call(scene.collections, collection.id)) return null
  return Object.freeze({ ...scene, collections: Object.freeze({ ...scene.collections, [collection.id]: collection }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据分离（#249 §3.2 / §1.1 方向 5）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为对象**显式**分离出独立数据副本。
 *
 * `#249` §1.1 方向 5：「共享几何的普通编辑默认仅影响目标对象；需要时在事务内产生独立数据。
 * **修改共享源必须为显式操作**」。
 *
 * 本函数是那条"显式操作"的纯实现；它**只**做分离，不做任何属性写。
 * 调用方（命令）决定何时调用它。返回 `null` 表示该对象已独占数据（无需分离）——
 * 这同样是一个**显式**结果，不是静默 no-op。
 */
export function detachObjectData(
  scene: Scene,
  objectId: string,
  newDataId: string,
): { scene: Scene; object: SceneObject; data: ObjectData } | null {
  const obj = findObject(scene, objectId)
  if (!obj) return null
  const src = findObjectData(scene, obj.dataId)
  if (!src) return null
  if (objectsSharingData(scene, src.id).length <= 1) return null
  const copy: ObjectData = Object.freeze({ ...src, id: newDataId, contentVersion: src.contentVersion })
  const nextObj: SceneObject = Object.freeze({ ...obj, dataId: newDataId })
  const next: Scene = Object.freeze({
    ...scene,
    objects: Object.freeze({ ...scene.objects, [obj.id]: nextObj }),
    data: Object.freeze({ ...scene.data, [newDataId]: copy }),
  })
  return { scene: next, object: nextObj, data: copy }
}

/** 场景的 `EntityRef`（供 `PropertyRef` 的 owner 使用）。 */
export function sceneRef(scene: Scene, contentVersion?: number): EntityRef {
  return contentVersion === undefined ? Object.freeze({ kind: 'scene', id: scene.id }) : Object.freeze({ kind: 'scene', id: scene.id, contentVersion })
}

/** 场景的 `Version`（`documentVersion` 由**文档**拥有，不由场景自造）。 */
export function sceneEntityRefFor(scene: Scene, docVersion: Version): EntityRef {
  return Object.freeze({ kind: 'scene', id: scene.id, contentVersion: docVersion.contentVersion })
}
