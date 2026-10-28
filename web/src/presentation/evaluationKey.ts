/**
 * `EvaluationKey` 与呈现侧的求值输入。
 *
 * `EvaluationKey` 的字段与「必须成立」条目由本文件定义：六维主键 + `viewProjection`，
 * **不增不减字段语义**。本层是**消费方**：按该形状实现呈现侧的读取接口，供呈现编译、
 * 失效判定与诊断消费。
 *
 * 键是纯值：可比较、可序列化，不含 Vue ref、Three 对象或 DOM。
 *
 * ## 为什么呈现层需要一个"键"而不是一个 `renderViewRevision` 计数器
 *
 * 要退役的正是「手推 `renderViewRevision`/`structEpoch`/`refresh` 链」，
 * 删除验收是「**调用方无手动刷新、版本补丁；非内容版本不得冒充内容变化**」。
 * 一个裸计数器之所以不成立，是因为它把三类完全不同的变化压成同一个事实：
 *
 * | 变化 | 应该失效什么 | 计数器行为 |
 * |---|---|---|
 * | 机位移动 | **只**重投影；几何重建数必须为 0 | 若也 bump ⇒ 全量重算（判红） |
 * | 注解文字改变 | 只失效注解节点 | 若也 bump ⇒ 方块几何重建（判红） |
 * | 几何数据改变 | 只失效受影响几何节点 | 无法表达"哪一部分" ⇒ 只能全量 |
 *
 * 用版本化输入替代计数器的关键收益是**可计算**："哪个维度变了"可以直接算出来
 * （扁平主键的选择理由），于是"只重建该重建的"从愿望变成判据。
 *
 * ## 六项区分 + 相位维 + 视图投影键
 *
 * 六项：文档版本、场景、时间、参数版本、暂存事务版本、内容资源版本。
 * 本文件在六项之上**增第七维 `texturePhase`**（「相位进求值键 = 必修」）。增维是**纯增**：
 * 既有六维的语义、序列化前缀与比较顺序都不变，新维追加在末尾 ⇒ 旧键是新键的缺省形态
 * （缺省相位序列化为 `-`）。
 *
 * 摄像机/局部显示**若不影响结构**只进 `viewProjection`。本实现因此把
 * `viewProjection` 与其余六项**分开比较** —— 这是机位判据的落点。
 */

/** 场景身份。 */
export type SceneId = string

/** 时间值（契约：有理帧率的最终表示待确认；此处显式给出分子/分母 + 秒）。 */
export type TimeValue = Readonly<{ seconds: number; numerator: number; denominator: number }>

export const TIME_ZERO: TimeValue = { seconds: 0, numerator: 0, denominator: 1 }

/**
 * 纹理**相位**绑定 —— 材质**实例**的相位（采样器 `domain/materials#sampleTextureInstance`）。
 *
 * ## 取值域与缺省语义（三态必须可区分）
 *
 * | 值 | 含义 | 序列化 |
 * |---|---|---|
 * | `undefined`（字段缺席） | 该材质**无相位动画**：不参与相位，序列按场景时间直接采样 | `-` |
 * | `{ phaseOffset: 0, phaseScale: 1 }` | 带相位绑定，且恰为"零偏移、原速"（即第 0 相位） | `0/1` |
 * | 其它数值对 | 带相位绑定，偏移/缩放非平凡 | `<offset>/<scale>` |
 *
 * **缺省不得用 `0` 冒充"第 0 帧"**：`undefined` 与 `{0,1}` 在本键里是**两个不等价的值**
 * （`ph:-` vs `ph:0/1`），故相位缺席的材质与"显式第 0 相位"的材质**不得**共享缓存条目/批次。
 * 理由不是"像素一定不同"，而是两者是**不同的求值输入** —— 把缺席归一成 `{0,1}` 会让
 * "该材质是否声明了相位"这一事实在键里消失，之后任何按相位区分的求值与失效都失去可计算性
 * （与 `useVertexColor` 之下 tint 仍进兼容性键同一口径：不因"当前路径下结果相同"就抹掉输入）。
 */
export type TexturePhaseBinding = Readonly<{ phaseOffset: number; phaseScale: number }>

/** 相位维的稳定序列化（**唯一一处**规则：缺省 = `-`，显式 = `<offset>/<scale>`）。 */
export function texturePhaseKeyOf(phase: TexturePhaseBinding | undefined | null): string {
  return phase === undefined || phase === null ? '-' : `${phase.phaseOffset}/${phase.phaseScale}`
}

/**
 * 主键的维度（顺序即比较顺序，便于诊断按任一维度分组）。
 *
 * 前六项是主键的既有维度；第七项 `texturePhase` 是新增的**相位维**，追加在末尾。
 */
export const EVALUATION_KEY_DIMENSIONS = [
  'documentVersion',
  'scene',
  'time',
  'parameterVersion',
  'stagedTransactionVersion',
  'contentResourceVersions',
  'texturePhase',
] as const

export type EvaluationKeyDimension = (typeof EVALUATION_KEY_DIMENSIONS)[number]

/** `EvaluationKey` 的字段名与类型（本文件定义）。 */
export type EvaluationKey = Readonly<{
  documentVersion: number
  scene: SceneId
  time: TimeValue
  /** 通道取值/动画参数版本 */
  parameterVersion: number
  /** 活动编辑事务的暂存版本 */
  stagedTransactionVersion?: number
  /** 内容资源版本/哈希；键是 `AssetId`，值是内容版本 */
  contentResourceVersions: Readonly<Record<string, string>>
  /**
   * **纹理相位**（增维后的第七维）。缺省 = 该材质无相位动画；显式 `{0,1}` = 第 0 相位
   * —— 语义与"两者不等价"的理由见 {@link TexturePhaseBinding}。
   */
  texturePhase?: TexturePhaseBinding
  /** 视图投影键：只影响机位/局部显示，**不影响结构** */
  viewProjection?: Readonly<{ camera: string; localDisplay: string }>
}>

export const EMPTY_EVALUATION_KEY: EvaluationKey = {
  documentVersion: 0,
  scene: '',
  time: TIME_ZERO,
  parameterVersion: 0,
  contentResourceVersions: {},
  // `texturePhase` **刻意缺席** = 无相位动画。不得写成 `{ phaseOffset: 0, phaseScale: 1 }`
  // （那是"显式第 0 相位"，与缺席不等价；见 `TexturePhaseBinding` 的三态表）。
}

/** 主键（七维：契约六项 + 相位）的稳定序列化 —— 用于缓存查找与"是否结构等价"判定。 */
export function structuralKeyOf(key: EvaluationKey): string {
  return [
    `d${key.documentVersion}`,
    `s${key.scene}`,
    `t${key.time.numerator}/${key.time.denominator}@${key.time.seconds}`,
    `p${key.parameterVersion}`,
    `x${key.stagedTransactionVersion ?? '-'}`,
    `r{${resourceVersionsKey(key)}}`,
    `ph:${texturePhaseKeyOf(key.texturePhase)}`,
  ].join('|')
}

/**
 * 视图投影键的稳定序列化（**不进**主键）。
 *
 * 单独成函数的理由：它是"机位变化不重建几何"这条判据的机械落点 ——
 * 只要 `structuralKeyOf` 不读它，机位就**不可能**影响几何缓存命中。
 */
export function viewProjectionKeyOf(key: EvaluationKey): string {
  const vp = key.viewProjection
  return vp === undefined ? '' : `${vp.camera}/${vp.localDisplay}`
}

/**
 * 两个键在**结构维度**（六项主键）上是否等价。
 *
 * 机位判据的落点：只改机位 ⇒ 本函数返回 `true` ⇒ 几何重建数必须为 0。
 * 只改注解文字 ⇒ `documentVersion` 变化 ⇒ 返回 `false`，但**失效面由依赖图收窄**
 * （见 `invalidationPlan.ts`），不因此重建方块几何。
 */
export function structurallyEqual(a: EvaluationKey, b: EvaluationKey): boolean {
  return structuralKeyOf(a) === structuralKeyOf(b)
}

/**
 * 逐维差分（诊断面；「求值节点失效来源和耗时」）。
 *
 * 选择扁平结构而不嵌套的理由正是"哪个维度变了可以直接计算，无需遍历嵌套对象"。
 */
export function diffEvaluationKey(
  prev: EvaluationKey,
  next: EvaluationKey,
): readonly EvaluationKeyDimension[] {
  const changed: EvaluationKeyDimension[] = []
  if (prev.documentVersion !== next.documentVersion) changed.push('documentVersion')
  if (prev.scene !== next.scene) changed.push('scene')
  const t0 = prev.time
  const t1 = next.time
  if (t0.seconds !== t1.seconds || t0.numerator !== t1.numerator || t0.denominator !== t1.denominator) {
    changed.push('time')
  }
  if (prev.parameterVersion !== next.parameterVersion) changed.push('parameterVersion')
  if (prev.stagedTransactionVersion !== next.stagedTransactionVersion) changed.push('stagedTransactionVersion')
  if (resourceVersionsKey(prev) !== resourceVersionsKey(next)) changed.push('contentResourceVersions')
  if (texturePhaseKeyOf(prev.texturePhase) !== texturePhaseKeyOf(next.texturePhase)) changed.push('texturePhase')
  return changed
}

function resourceVersionsKey(key: EvaluationKey): string {
  return Object.keys(key.contentResourceVersions)
    .sort()
    .map((id) => `${id}=${key.contentResourceVersions[id]}`)
    .join(',')
}

/**
 * 呈现侧的**求值输入快照**（呈现编译所需输入的最小投影）。
 *
 * 刻意只包含呈现编译真正读得到的东西：一个 `EvaluationKey`、一个几何来源端口、
 * 一个图元清单。它**不**包含 Vue ref、Three 对象、DOM —— 于是编译可以在无宿主环境下
 * 断言（纯性纪律）。
 */
export type PresentationInputs = Readonly<{
  key: EvaluationKey
  /** 几何来源：按几何身份取**纯数据**（三角形属性），不含 GPU 句柄。 */
  geometry: GeometrySource
  /** 图元（对象/元素）来源：本次求值里要呈现的条目。 */
  primitives: readonly EvaluatedPrimitive[]
}>

/** 稳定几何身份（**内容**身份：同内容 ⇒ 同身份 ⇒ 可实例化共享）。 */
export type GeometryId = string

/**
 * 一次求值里某个对象的呈现条目 —— **对象身份与 GPU 批次身份分离的起点**。
 *
 * `objectId` 是唯一被下游引用的身份（选择、动画轨道、拾取结果都引用它）；
 * 批次位置**不**出现在本类型里（它由 `compileScene` 产出，只存在于 `provenance`）。
 */
export type EvaluatedPrimitive = Readonly<{
  /** 对象身份，**跨重新分批/压缩稳定**（身份稳定判据）。 */
  objectId: string
  /** 该对象使用的几何身份及其内容版本。 */
  geometry: Readonly<{ id: GeometryId; version: string }>
  /** 元素身份（顶点/边/面的稳定局部身份；无子元素语义时省略）。 */
  elementId?: string
  /** 材质描述符（呈现参数，不是 GPU 材质实例）。 */
  material: MaterialDescriptor
  /** 局部变换（列主序 16 元；纯数据，GPU 上传时再转 `Matrix4`）。 */
  transform: readonly number[]
  /** 世界空间包围盒（空间范围分批与拾取初筛用）。 */
  bounds: Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number] }>
  /**
   * 变形方式。`'shared'` = 与其他实例共用同一变换族（可实例化）；
   * `'independent'` = 有独立形变 ⇒ 必须走独立路径（契约明文）。
   */
  deform: 'shared' | 'independent'
  /** 透明顺序键（`null` = 不透明）。 */
  transparency: number | null
}>

/** 材质描述符：**纯数据**，与 GPU 材质实例一一对应但不等同（内容身份与版本的分离要求）。 */
export type MaterialDescriptor = Readonly<{
  /** 材质身份（内容身份；纹理替换后身份变）。 */
  id: string
  version: string
  blend: 'opaque' | 'cutout' | 'translucent'
  /** 整型色（`0xRRGGBB`）；顶点色路径为白。 */
  tint: number
  useVertexColor: boolean
  /**
   * 纹理**相位**绑定（缺省 = 该材质**无相位动画**；显式 `{0,1}` = 带相位绑定且为原速第 0 相位）。
   *
   * 只增字段，既有的 `id`/`version`/`blend`/`tint`/`useVertexColor` 语义不变。它与
   * {@link TexturePhaseBinding} 的三态口径**同一份**（`undefined` ≠ `{0,1}`），并由
   * `presentation/batchPlan#compatibilityKeyOf`、`presentation/presenter#materialIdentityOf`
   * 与 `presentation/textureBinding#textureBindingKey` 三处**同时**进键 —— 相位不同的材质
   * 因此不共享材质缓存条目，也不合进同一绘制批次（相位判据面）。
   */
  texturePhase?: TexturePhaseBinding
  /**
   * 整体不透明度（0..1）。缺席 = 1（按 `blend` 的常规状态画）。
   *
   * 只给"必须与真几何区分"的呈现（捕获占位条目）使用：`< 1` 时呈现层把它当
   * 真半透明处理（`transparent` + `opacity` + `depthWrite: false` + `alphaTest: 0`）。
   * 它与 `blend` 是两个维度：`blend` 来自导出件的材质声明，`opacity` 是呈现决定。
   */
  opacity?: number
}>

/**
 * 几何来源端口：返回**纯数据**，不含 three 类型。
 *
 * 编译层不得依赖渲染库 —— 这既是纯性纪律，也让身份/计数的**结构**部分
 * 能在 vitest 里断言（真实 GPU 数字由 e2e 提供，见 `presentation/three`）。
 */
export interface GeometrySource {
  /** 该几何身份的**内容**版本（用于"内容变了换身份"的判定与缓存查找）。 */
  versionOf(id: GeometryId): string | undefined
  /**
   * 取该几何的三角形属性（位置/UV/颜色，均为定长非索引数据）。
   * 返回 `undefined` = 该几何**不可用** —— 调用方**不得**用空几何冒充"渲染成功"
   * （必需资源未就绪不得假装完整）。
   */
  attributesOf(id: GeometryId): GeometryAttributes | undefined
}

export type GeometryAttributes = Readonly<{
  /** 每顶点 3 分量，位置在**局部**空间。 */
  positions: Float32Array
  /** 每顶点 2 分量。 */
  uvs: Float32Array
  /** 每顶点 3 分量（顶点色）。 */
  colors: Float32Array
  /** 三角形数（= positions.length / 9）。 */
  triangleCount: number
  /**
   * **逐三角形 → 单元格**表（逐格身份层；legacy `triangleMap` 的等价物）。
   *
   * ## 为什么它挂在几何属性上（而不是图元上）
   *
   * 三角形的**序号**是几何的属性：`positions[9t .. 9t+9)` 就是第 `t` 个三角形。
   * 而"第 `t` 个三角形属于哪一格"由**同一份**几何的内容决定 —— 两个对象共享同一
   * 几何身份时，它们的三角形序与格映射**必然相同**（同一份内容）。
   * 挂在图元上会让"共享几何"的两份映射各存一份并可能漂移。
   *
   * 这正是 legacy 的形态：`mesh.userData.triangleMap` 挂在**合并后的几何**上，
   * 与 `geometry.attributes.position` 同一序（`render/mesh/blockMesh.ts:121-130`）。
   *
   * ## 缺失的语义（**显式**，不是"空表"）
   *
   * `undefined` = 该几何**不是**逐格来源（自造夹具、纯网格元素、无几何资产）。
   * 这与"携带了但长度不符"是两种不同的事实：后者是**实现缺陷**，
   * 由 `compileScene` 的 `cell-map-shape-invalid` 显式跳过并报出。
   * 把缺失表达成空表会让"这一点不可逐格拾取"与"格表算错了"不可区分。
   */
  readonly cellMap?: import('./cellIdentity').TriangleCellMap
}>
