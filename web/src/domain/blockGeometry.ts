/**
 * `domain/blockGeometry` —— **方块烘焙几何的类型化承载**（#289 P10d；R-WK-06）。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * P10c（#286）实测的决定性事实（机械证据，Lead 认可）：
 *
 * > 渲染几何的**唯一**来源是 `blockPalette[].geometry`（内嵌 BakedQuads）：
 * > `render/schema/types.ts:257` 是唯一几何载体，`render/mesh/structureGeometryCore.ts:217`
 * > 调 `decodeBakedGeometry(entry.geometry)`。内核**只**承载 `name:meta` 字符串
 * > （`composition/kernelAssembly.ts:449`）—— **新层没有方块几何的类型化落点**。
 *
 * 且几何今天能渲染，**只因 `MultiblockContent.source` 把原始 JSON 回显**（见
 * `composition/kernelProjection.ts:447`）。本模块把那个落点补上。
 *
 * | 旧形态 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `BakedQuadsGeometry`（`{encoding, quads[]}`，`quads[].vertices[].{x,y,z,u,v,color}`） | `render/schema/types.ts:219-240` | {@link BlockGeometryAsset}：**P3 `MeshData`** 承载拓扑与稳定元素身份 + 逐面材质下标 |
 * | 「几何在调色板条目上」这一事实靠字段存在与否表达 | 同上 | {@link BlockPaletteEntry}：几何是**显式可选**字段；无几何 = 该条目渲染不出东西（**显式**，不是空几何冒充） |
 * | `decodeBakedGeometry` 在**渲染期**被每个消费者各调一次 | `structureGeometryCore.ts:217`、`blockMeshProvider.ts:22`、`presentationAdapter.ts:167`、`annotationMeshProvider.ts:268`、`partDetect.ts:89/149` | 解码在**装配期一次**完成（#289 执行范围第 1 条明文：「装配期 `decodeBakedGeometry`」），产出类型化资产 |
 *
 * ## 三条设计判据
 *
 * ### 1. 几何资产是**局部坐标**的，位置由单元格决定
 *
 * 实测（真实信封夹具 `structuredata-exported-envelope.json`，68 条目）：四边形顶点在
 * **`0..16` 的方块局部坐标**内，而世界位置由渲染期的体素偏移给出
 * （`render/mesh/structureGeometryUVs.ts:31-34` 的 `ox/oy/oz`）。同一份几何因此
 * **可以跨单元格共享** —— 这正是 #249 §3.2「共享几何」在方块面上的落点，
 * 也是 A07「共享几何默认按对象独立编辑」的前提：没有共享，就没有"独立编辑"可言。
 *
 * ⇒ 顶点坐标**原样**进资产（不做任何偏移、不四舍五入 —— 几何契约 §1 E3 明文
 * 「不任意四舍五入到整数」）。体素偏移留在呈现编译（它是**位置**问题，不是几何问题）。
 *
 * ### 2. 几何内容是**位置特异**的，故不能用 `name:meta` 当几何身份
 *
 * 实测（同一信封夹具，68 条目 9 组重名）：`appliedenergistics2:tile.BlockCableBus:0`
 * 出现 **33 次**，各自 `quads.length` 为 `6/16/22/27/31/37/44/45/49/50/85/110` 不等 ——
 * 即**同一 `name:meta` 在不同位置是不同的烘焙模型**（线缆的连接形状）。多方块夹具
 * `multiblock-ebf-2ch` 同族：`gt.blockmachines:1000` 两条，`tooltip` 一为
 * `Electric Blast Furnace`、一为 `Electric Blast Furnace (running)`。
 *
 * ⇒ 几何身份**只能**由几何内容本身派生（{@link blockGeometryId}），
 * 与调色板下标、与 `name:meta`、**与位置**都无关。这正是 #249 §3.2
 * 「不得把 GPU 索引作为持久身份」与 §15 第 9 条「格坐标/批次序号兼任对象身份」
 * 要退役的形态在**几何资产**这一层的同族应用。
 *
 * ### 3. 每格用**哪个**几何，是格的内容，不是调色板下标
 *
 * 旧形态里"这一格画什么"= `cellGrid[z][row][col]` → `blockPalette[i]`，
 * 于是同一格在不同帧/不同变体下靠**下标**指代几何。而下标是调色板的**枚举序号**：
 * 重编号（`kernelProjection` 的 `airPaletteEntry` + 重排）会让它指向另一份几何 ——
 * A18 负对照「把 batch index 当对象 ID」的方块面同族形态。
 *
 * ⇒ 装配产出 {@link BlockPaletteEntry} 的**有序联合表** + 逐格的**资产身份**
 * （`assetId`），于是"这一格是哪份几何"由**内容身份**回答，与下标无关；
 * 下标只是投影回文件格式时的**压缩手段**（见 `composition/kernelProjection`）。
 *
 * ## 与 P3 (`domain/geometry`) 的关系
 *
 * 本模块**不另起**拓扑结构：一份几何资产内嵌 P3 的 {@link MeshData}
 * （`ObjectDataPayload` 的既有 `'mesh'` 分支形状），于是：
 *  - 「顶点/边/面稳定身份」与「拓扑版本使旧引用显式失效」**自动**成立
 *    （`domain/geometry#resolveVertex` 等）；
 *  - 「不得把 GPU 索引作为持久身份」在类型上不可表达（`MeshTopology` 无索引数组）。
 *
 * ## 契约接触点（回 #250 登记，接续 GF 编号）
 *
 * 几何契约（`web-kernel-geometry-contract.md`）只冻结**数学**（容限/坐标/仿射/枢轴/父链/轴序），
 * 全文无方块几何载体；冻结契约（`web-kernel-contracts.md`）全文无 `ObjectDataPayload`/
 * `blockGrid`（实测 0 命中）。故本模块属**契约未覆盖处**，按 §8 登记 GF-11（见汇报），
 * **不**改任何冻结类型。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层（`domain/` 是纯核心，#249 §4 规则 1）。
 */

import { digestOf } from './identity'
import {
  edgeIdOf,
  faceIdOf,
  meshData,
  meshTopology,
  type FaceId,
  type MeshAttributeLayer,
  type MeshData,
  type MeshEdge,
  type MeshFace,
  type MeshTopology,
  type MeshVertex,
  type VertexId,
} from './geometry'
import type { Vec3 } from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 编码
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 几何编码（与文件格式**逐字对齐**）。
 *
 * 就地声明而**不** import `render/schema/types`：`render/` 是旧层，`domain/` 不得依赖它
 * （#249 §4 规则 1）。这两个成员是**格式契约**的一部分，且 `packedQuadsV1` 的解码
 * 在旧层也是 `throw new Error('packedQuadsV1 尚未实现解码')`（`bakedGeometryDecode.ts:13`）——
 * 本模块对它的处置**逐字相同**（显式拒绝，不静默当空）。
 */
export type BlockGeometryEncoding = 'bakedQuadsJsonV1' | 'packedQuadsV1'

/** 目前唯一有解码器的编码。 */
export const SUPPORTED_BLOCK_GEOMETRY_ENCODINGS: readonly BlockGeometryEncoding[] = Object.freeze(['bakedQuadsJsonV1'])

// ─────────────────────────────────────────────────────────────────────────────
// 四边形（解码的**输入**形状；由文件 JSON 直接给出）
// ─────────────────────────────────────────────────────────────────────────────

/** 四边形顶点：位置（局部）+ 纹理坐标 + 可选明暗/顶点色。 */
export interface QuadVertex {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly u: number
  readonly v: number
  /** 打包的 MC 顶点色（`0xRRGGBB` 之外还含 alpha 位，与生产同口径解析）。 */
  readonly color?: number
  /**
   * 明暗系数。
   *
   * ## 为什么承载它而当前消费方为 0（实测，如实登记）
   *
   * 全树 grep `brightness` 的**生产**命中只有三处 CSS `filter: brightness(...)`
   * 与 `render/schema/types.ts:227` 的**声明本身** —— 即 `BakedQuadVertex.brightness`
   * 今天**没有任何消费者**（它是烘焙器的输出，渲染路径只用 `color`）。
   *
   * 仍然承载的理由是**往返保真**：它是文件里真实存在的字段，投影时若不写回，
   * "装配 → 投影"就不是无损的（#249 §12「不能静默丢失无法解释的语义」）。
   * 承载一个零消费方的字段是**如实记录**；不承载它才是静默丢弃。
   */
  readonly brightness?: number
}

/** 一个四边形：材质下标 + 4 个顶点（**有序**：绘制顺序与数组顺序一致）。 */
export interface Quad {
  readonly materialIndex: number
  readonly vertices: readonly QuadVertex[]
}

/** 从文件读入的调色板几何（`blockPalette[].geometry` 的形状）。 */
export interface BakedGeometrySource {
  readonly encoding: BlockGeometryEncoding | string
  readonly quads?: readonly Quad[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 解码（装配期唯一入口）
// ─────────────────────────────────────────────────────────────────────────────

/** 解码失败的稳定原因（**不静默**：每条都带可说出的原因）。 */
export type DecodeFailureReason =
  /** 编码没有解码器（`packedQuadsV1`）。 */
  | 'unsupportedEncoding'
  /** `quads` 不是数组（形态瑕疵）。 */
  | 'quadsNotArray'
  /** 四边形顶点数 ≠ 4（旧层 `bakedQuadTriangleAttributesPure` 对非 4 顶点返回 `null`）。 */
  | 'degenerateQuad'
  /** 顶点分量非有限数（几何契约 §1：非有限值判不等，不参与几何）。 */
  | 'nonFiniteVertex'

export interface DecodeFailure {
  readonly reason: DecodeFailureReason
  /** 出错项在该调色板条目内的下标（`degenerateQuad`/`nonFiniteVertex` 时有值）。 */
  readonly quadIndex?: number
  readonly detail: string
}

export interface DecodedBlockGeometry {
  readonly quads: readonly Quad[]
  /** 被**显式跳过**的四边形（不静默：计数与原因都报出来）。 */
  readonly skipped: readonly DecodeFailure[]
}

/**
 * 解码一份烘焙几何为**规范化四边形列表**（保持顺序）。
 *
 * ## 为什么非法四边形是"跳过并记录"而不是"整条失败"
 *
 * 旧层的两处行为**不一致**，本模块取其中**信息不丢失**的那一种：
 *
 * | 旧位置 | 行为 |
 * |---|---|
 * | `render/mesh/bakedGeometryDecode.ts` | 只解释编码；`quads` 原样返回（**不校验单个四边形**） |
 * | `render/mesh/structureGeometryUVs.ts:30` / `structureGeometryNormals.ts:20` | 顶点数 ≠ 4 ⇒ 返回 `null` ⇒ 调用方 `continue`（**跳过该四边形，其余照画**） |
 *
 * 后者才是既有的**渲染行为**（能力不回退的对照基线）。⇒ 本模块按顶点数/有限性
 * 逐条跳过并记录，使"少画了一个面"是一个**可见**的事实而不是静默结果。
 *
 * 编码不支持时返回 `null`（**整条失败**，与旧层 `throw` 同一个语义位置：
 * 调用方 `catch` 后跳过整格）。用 `null` 而不是 `err` 是因为本函数是**解码器**
 * 而不是业务操作：它的失败要由装配层翻译成诊断（`AssemblyDiagnostic`），
 * 而那不是 `domain/errors` 的八类业务错误之一（契约 §3.2 的封闭集合，
 * 不得为"格式瑕疵"新开一个码）。
 */
export function decodeBlockGeometry(source: BakedGeometrySource | undefined | null): DecodedBlockGeometry | null {
  if (!source || typeof source !== 'object') return null
  if (!SUPPORTED_BLOCK_GEOMETRY_ENCODINGS.includes(source.encoding as BlockGeometryEncoding)) return null
  const raw = source.quads
  if (raw === undefined) return { quads: Object.freeze([]), skipped: Object.freeze([]) }
  if (!Array.isArray(raw)) {
    return {
      quads: Object.freeze([]),
      skipped: Object.freeze([
        Object.freeze({ reason: 'quadsNotArray' as const, detail: `geometry.quads 不是数组（实际 ${typeof raw}）` }),
      ]),
    }
  }
  const quads: Quad[] = []
  const skipped: DecodeFailure[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i]
    if (q === null || typeof q !== 'object') {
      skipped.push(Object.freeze({ reason: 'degenerateQuad' as const, quadIndex: i, detail: `quads[${i}] 不是对象` }))
      continue
    }
    const vs = (q as Quad).vertices
    if (!Array.isArray(vs) || vs.length !== 4) {
      skipped.push(
        Object.freeze({
          reason: 'degenerateQuad' as const,
          quadIndex: i,
          detail: `quads[${i}] 顶点数 ${Array.isArray(vs) ? vs.length : '(缺)'} ≠ 4`,
        }),
      )
      continue
    }
    const vertices: QuadVertex[] = []
    let bad = false
    for (let j = 0; j < 4; j++) {
      const v = vs[j] as QuadVertex
      if (
        v === null || typeof v !== 'object' ||
        !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z) ||
        !Number.isFinite(v.u) || !Number.isFinite(v.v)
      ) {
        skipped.push(
          Object.freeze({ reason: 'nonFiniteVertex' as const, quadIndex: i, detail: `quads[${i}].vertices[${j}] 含非有限分量` }),
        )
        bad = true
        break
      }
      vertices.push(v)
    }
    if (bad) continue
    const mi = (q as Quad).materialIndex
    quads.push(
      Object.freeze({
        materialIndex: Number.isInteger(mi) ? mi : 0,
        vertices: Object.freeze(vertices),
      }),
    )
  }
  return { quads: Object.freeze(quads), skipped: Object.freeze(skipped) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 几何资产（P3 MeshData 承载）
// ─────────────────────────────────────────────────────────────────────────────

/** 顶点属性层名（与呈现编译的读法约定；**不是** GPU 属性名）。 */
export const QUAD_UV_LAYER = 'quad.uv' as const
export const QUAD_COLOR_LAYER = 'quad.color' as const
export const QUAD_BRIGHTNESS_LAYER = 'quad.brightness' as const

/**
 * 一份方块几何资产。
 *
 * ## 为什么 `mesh` 与 `quads` 并存（而不是只留其一）
 *
 * 两者回答**不同的问题**，且各自都有真实消费者：
 *
 * | 字段 | 回答什么 | 谁读 |
 * |---|---|---|
 * | `mesh`（P3 `MeshData`） | 「这份几何有哪些**稳定元素**」——顶点/边/面的身份与**拓扑版本** | 选择/拾取/元素引用（`ElementRef` 过期判定）、`buildGeometrySourceMap` |
 * | `quads`（有序四边形） | 「怎么把它**画出来**」——绘制顺序 + 逐面材质下标 | 呈现编译（三角形属性、逐面拾取 `quadIndex`） |
 *
 * 只留 `mesh` 会丢掉**绘制顺序**与**逐面材质**（`MeshTopology` 没有这两个概念：
 * 边/面是集合，不是序列；材质属**呈现**参数）。只留 `quads` 会丢掉稳定元素身份
 * （那就退回 §15 第 9 条的"下标即身份"）。
 *
 * ⇒ 两者是**同一份内容**的两个面，由 `blockGeometryAsset` **同一个构造点**产出，
 * 不存在漂移的可能（`quads[k].face` 是 `mesh.topology.faces[k].id` 的**同一字符串**，
 * 由构造序保证；见 `domain/__tests__/blockGeometry.test.ts` 的同序断言）。
 */
export interface BlockGeometryAsset {
  /** 内容身份（由四边形内容机械派生；同内容 ⇒ 同 id ⇒ 可共享，见 {@link blockGeometryId}）。 */
  readonly id: string
  readonly encoding: 'bakedQuadsJsonV1'
  /**
   * **已校验的类型化四边形**（绘制顺序与数组顺序一致）。
   *
   * ## 为什么它是资产的**规范来源**（而不是从 `mesh` 反推）
   *
   * 两个理由，第一个是实测抓出的**真实信息丢失**：
   *
   * 1. **`mesh` 的属性层是有损的**。呈现编译要的是归一化 RGB 三元组
   *    （`structureGeometryUVs#rgbTripletFromMcTessellatorColor` 取低 24 位），
   *    而文件里的 `color` 是**打包 32 位整数**（含最高位的 alpha/sign 位）。
   *    本模块第一版把 `mesh` 当唯一来源、编码时从三元组反量化 —— 实测
   *    `tectech:gt.godforgecasing:0` 的 `color: -8421505`（`0xFF7F7F7F`）
   *    往返成 `8355711`（`0x007F7F7F`）：**最高字节被抹掉**，且符号表示改变。
   *    ⇒ 若"零回显"的往返是有损的，它就只是"带着一份原始 JSON 备用"的另一种写法，
   *    而那正是 #289 执行范围禁止的形态。
   * 2. **绘制顺序是内容**。文件契约逐字写明「`geometry.quads` 有序：绘制顺序与数组顺序一致」，
   *    且渲染侧按 `quadOrder` 排序批次（`render/mesh/blockMesh.ts:105-109`）——
   *    半透明四边形**重叠时结果依赖顺序**。故顺序进几何身份（见 {@link blockGeometryId}）。
   *
   * 这不是"原始 JSON 回显"：`Quad[]`/`QuadVertex` 是**本模块的类型**，
   * 每个四边形在 {@link decodeBlockGeometry} 里**已校验**（顶点数 = 4、分量有限），
   * 非法项被逐条剔除并记录。它是**校验过的类型化内容**，不是 `Record<string, unknown>`。
   */
  readonly quads: readonly Quad[]
  /** P3 拓扑：顶点/边/面 + 稳定元素身份 + 拓扑版本。**由 `quads` 派生**（见文件头）。 */
  readonly mesh: MeshData
}

/**
 * 第 `i` 个四边形对应的**稳定面身份**。
 *
 * ## 为什么是函数而不是资产上的一个数组
 *
 * 不变量：`mesh.topology.faces[i]` **恒**对应 `quads[i]`（`blockGeometryAsset` 按同一
 * 循环序 push 两者）。把它做成函数使这条不变量只有一个表达点 ——
 * 若另存一个 `BlockQuadRef[]`，就出现"两份顺序可能漂移"的余地，
 * 而漂移的后果是"描边画到了另一个面"（静默错误）。
 */
export function quadFaceRef(asset: BlockGeometryAsset, i: number): Readonly<{ face: FaceId; materialIndex: number; geometryVersion: string }> | undefined {
  const face = asset.mesh.topology.faces[i]
  const q = asset.quads[i]
  if (face === undefined || q === undefined) return undefined
  return Object.freeze({ face: face.id, materialIndex: q.materialIndex, geometryVersion: String(asset.mesh.topology.version) })
}

/**
 * 顶点身份：**内容派生**（见 {@link blockGeometryAsset} 内的长注释）。
 *
 * 格式：`` v:<x>|<y>|<z>|<u>|<v>|<color>|<brightness> ``，缺省分量写 `-`（使"未声明"
 * 与"声明了 0"可区分 —— 与 §19.3 同族要求：`undefined` 与 `0` 不是同一件事）。
 */
function vertexIdOf(v: QuadVertex): VertexId {
  const c = v.color === undefined ? '-' : String(v.color >>> 0)
  const b = v.brightness === undefined ? '-' : String(v.brightness)
  return `v:${v.x}|${v.y}|${v.z}|${v.u}|${v.v}|${c}|${b}`
}

/**
 * 由解码后的四边形产出**类型化几何资产**。
 *
 * ## 顶点身份是**内容派生**的（见下方逐行注释），故重排/去重不改变任何身份
 *
 * ## 失败是 `null`（不返回"看起来像几何"的空资产）
 *
 * 无四边形（或全部被跳过）时返回 `null` —— 由装配层把它翻成"该条目无几何"这一**显式**事实。
 * 返回一个空 `MeshData` 会被 `meshTopology` 拒绝（`emptyTopology`），
 * 而伪造一个退化顶点则会让"这个方块渲染不出来"表现为"画了个点"（A36 同族）。
 */
export function blockGeometryAsset(quads: readonly Quad[], encoding: 'bakedQuadsJsonV1' = 'bakedQuadsJsonV1'): BlockGeometryAsset | null {
  if (quads.length === 0) return null

  const vertices: MeshVertex[] = []
  /** 顶点身份 → 该顶点在 `vertices` 里的下标（属性层按**同一个顺序**排布）。 */
  const vertexSlot = new Map<VertexId, number>()
  const edges: MeshEdge[] = []
  const faces: MeshFace[] = []
  /** 逐顶点的 UV / 色 / 明暗（按 `vertices` 的顺序 push，使属性层长度恒等于顶点数）。 */
  const uv: number[] = []
  const color: number[] = []
  const brightness: number[] = []
  let sawBrightness = false

  for (let qi = 0; qi < quads.length; qi++) {
    const q = quads[qi] as Quad
    // ── 顶点身份：**内容派生**（位置 + UV + 色 + 明暗），与四边形枚举顺序、与角序无关 ──
    //
    // ## 为什么身份必须内容派生（而不是 `<面id>#v<k>`）
    //
    // 朴素做法（面身份 + 角角色）有个致命后果：**重排 `quads` 数组会改变全部顶点身份**，
    // 因为面身份由顶点集合派生、而顶点名含 `qi`。而"重排不改变身份"正是 §15 第 9 条
    // （格坐标/下标兼任身份 ⇒ 重排/分批后身份漂移）要退役的形态。若本模块自己犯了它，
    // 退役就是自欺。
    //
    // ⇒ 顶点身份 = `v:<位置>|<uv>|<色>|<明暗>`（内容的稳定规范化）。于是：
    //  - 两个**数值相同**的顶点得到**同一个**身份（真实去重）；
    //  - 重排 `quads` 或调换角序**不改变**任何顶点身份；
    //  - 同一份几何被两个调色板条目引用时，两处顶点身份**逐字相同**（可共享的直接证据）。
    //
    // ## 为什么这**不**改变渲染语义（面平着色 vs 平滑着色）
    //
    // P3 `MeshTopology` 是**逻辑**拓扑 —— 它不含索引数组、不含法线、不参与 GPU 展开
    // （`domain/geometry` 文件头判据 1 逐字说明："GPU 顶点展开由渲染编译处理"）。
    // 呈现编译**按四边形**产出三角形（每个四边形 6 个顶点，各自 `computeVertexNormals`），
    // 因此相邻四边形共享一个**逻辑**顶点**不会**让法线被平均 —— 面平着色由呈现侧
    // 的展开方式保证，与这里是否去重无关。去重只影响"元素身份是否合理"，不影响像素。
    //
    // ## 属性层长度必须等于**去重后**的顶点数
    //
    // `meshTopology` 对每一层断言 `values.length === vertices.length * components`
    // （`domain/geometry.ts:225-234`，不符即 `attributeLengthMismatch`）。
    // 故 UV/色/明暗按**首次出现顺序**逐顶点 push（`vertexSlot` 是唯一判据），
    // 而**不是**按 `quads.length * 4` —— 后者在去重发生时会让层变长。
    const ids: VertexId[] = q.vertices.map((v) => vertexIdOf(v))
    const faceId = faceIdOf(ids)
    for (let k = 0; k < 4; k++) {
      const id = ids[k] as VertexId
      if (vertexSlot.has(id)) continue
      const p = q.vertices[k] as QuadVertex
      vertexSlot.set(id, vertices.length)
      vertices.push(Object.freeze({ id, position: positionOf(p) }))
      uv.push(p.u, p.v)
      const rgb = colorTriplet(p.color)
      color.push(rgb[0], rgb[1], rgb[2])
      const br = typeof p.brightness === 'number' && Number.isFinite(p.brightness) ? p.brightness : 0
      brightness.push(br)
      if (p.brightness !== undefined) sawBrightness = true
    }
    faces.push(Object.freeze({ id: faceId, vertices: Object.freeze(ids) }))
    for (let k = 0; k < 4; k++) {
      const a = ids[k] as VertexId
      const b = ids[((k + 1) % 4)] as VertexId
      edges.push(Object.freeze({ id: edgeIdOf(a, b), a, b }))
    }
  }

  const attributes: MeshAttributeLayer[] = [
    Object.freeze({ name: QUAD_UV_LAYER, components: 2, values: Object.freeze(uv) }),
    Object.freeze({ name: QUAD_COLOR_LAYER, components: 3, values: Object.freeze(color) }),
  ]
  // 明暗层只在**文件真的写了**时承载：全缺省时不加一层全 0（那会让"没写"与"写了 0"不可区分）。
  if (sawBrightness) attributes.push(Object.freeze({ name: QUAD_BRIGHTNESS_LAYER, components: 1, values: Object.freeze(brightness) }))

  const topo = meshTopology({ vertices, edges: dedupeEdges(edges), faces, attributes })
  if (!topo.ok) return null

  const id = blockGeometryId(quads)
  const mesh = meshData(id, topo.value)
  return Object.freeze({ id, encoding, quads: Object.freeze([...quads]), mesh })
}

function positionOf(v: QuadVertex): Vec3 {
  return Object.freeze({ x: v.x, y: v.y, z: v.z })
}

/** 打包色 → `[r,g,b]` 归一化（与 `structureGeometryUVs#rgbTripletFromMcTessellatorColor` 逐字同口径）。 */
function colorTriplet(packed: number | undefined): readonly [number, number, number] {
  if (packed === undefined || !Number.isFinite(packed)) return [1, 1, 1]
  const u = packed >>> 0
  return [(u & 0xff) / 255, ((u >>> 8) & 0xff) / 255, ((u >>> 16) & 0xff) / 255]
}

/** 边去重（同一对顶点可能是两个四边形的公共棱；`MeshTopology` 不禁止重复，但去重使资产更小且身份唯一）。 */
function dedupeEdges(edges: readonly MeshEdge[]): MeshEdge[] {
  const seen = new Set<string>()
  const out: MeshEdge[] = []
  for (const e of edges) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/**
 * 几何资产的**内容身份**。
 *
 * 由四边形的**全部数值内容**派生（材质下标 + 顶点位置 + UV + 色 + 明暗），
 * 与调色板下标、`name:meta`、**位置**都无关 —— 见文件头判据 2 的实测定量。
 *
 * 复用 `domain/identity#digestOf`（键序稳定的 `canonicalize`）：**唯一**摘要算法，
 * 本模块不自己写第二份哈希（#249 §15 第 5 条要退役的正是"两套判据"）。
 * 用 `digestOf` 而不是 `JSON.stringify`：后者键序依赖**插入顺序**，同一份语义内容
 * 经不同构造路径会得到不同摘要 ⇒ 缓存永不命中。
 */
export function blockGeometryId(quads: readonly Quad[]): string {
  return `geo:${digestOf(
    quads.map((q) => [
      q.materialIndex,
      q.vertices.map((v) => [v.x, v.y, v.z, v.u, v.v, v.color ?? null, v.brightness ?? null]),
    ]),
  ).toString(16)}`
}

/**
 * 几何资产的**共享键**（`assetId` 的稳定回读）。
 *
 * 与 `blockGeometryId` 的区别：后者从**四边形内容**算（装配期用），本函数从
 * **已构造的资产**读（投影侧用）。两者恒等由 `blockGeometryAsset` 的构造保证
 * （`id = blockGeometryId(quads)`），故不存在"算两遍得到两个答案"。
 */
export function assetIdOf(asset: BlockGeometryAsset): string {
  return asset.id
}

/**
 * 资产 → 文件格式的**几何编码**（`blockPalette[].geometry` 的值）。
 *
 * ## 为什么需要反向（而不只是正向解码）
 *
 * #289 执行范围明文要求「内核清单/装配零 `decodeBakedGeometry` 回显依赖」，
 * 而"零回显"的可判定含义是：**几何能从内核内容重建出原文件的那份编码**。
 * 若只能正向解码、不能反向编码，那么"零回显"就退化成"带着一份原始 JSON 备用"——
 * 那正是执行范围禁止的形态。
 *
 * ## 往返为什么是**逐字节**无损的（本模块第一版在这里丢过数据）
 *
 * 资产的规范来源是 `asset.quads`（**已校验的类型化四边形**，见 `BlockGeometryAsset` 的
 * 字段注释），故编码是**逐字段复制**：顶点位置/UV 是 IEEE-754 双精度原值、
 * `color` 是打包 32 位整数原值、`brightness` 原值 —— **没有任何量化或归一化往返**。
 *
 * 第一版从 `mesh` 的属性层反推（那里 `color` 已归一化成 `[0,1]` 三元组），
 * 实测把 `tectech:gt.godforgecasing:0` 的 `color: -8425025`（`0xFF7F7F7F`，最高字节是 alpha）
 * **抹成** `0x007F7F7F`。这条缺陷由 `__tests__/blockGeometry.test.ts` 的
 * "真实夹具逐条往返零 diff"（68 条目）判红抓出 —— 它证明**属性层不是规范来源**。
 *
 * 字段顺序由构造顺序固定（`x,y,z,u,v[,color][,brightness]`），故两次编码逐字节相同。
 */
export function encodeBlockGeometry(asset: BlockGeometryAsset): BakedGeometrySource {
  // 资产的 `quads` **就是**校验过的类型化内容（见 `BlockGeometryAsset.quads` 的长注释），
  // 故编码是**原样交回**而不是重建：重建会重新决定键序（实测抓出：
  // `brightness`/`color` 的 JSON 键序在重建路径上翻转，逐字节比较判红），
  // 而键序在本格式里是**可观测**的（它是同一份文件字节的一部分）。
  return Object.freeze({ encoding: asset.encoding, quads: asset.quads })
}

/** 资产可共享的判据（同 id ⇒ 同内容）。 */
export function sameGeometry(a: BlockGeometryAsset, b: BlockGeometryAsset): boolean {
  return a.id === b.id
}

// ─────────────────────────────────────────────────────────────────────────────
// 调色板条目（方块身份 + 呈现提示 + 几何）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 呈现模式。
 *
 * `BakedModel` = 真几何来自 `geometry`（真实产物）；`BakedQuads` = 真实信封夹具的写法；
 * `BlockModel` = **无几何**，由生产代码按方块身份现算（`context/runtimeDocument.ts:454`
 * 的编辑期默认值）。三者都是文件里真实出现的字符串，故本联合**开放**（`string`），
 * 但前三个是**已知**值 —— 未知值不拒绝、原样承载（§12「不能静默丢失无法解释的语义」）。
 */
export type BlockRenderMode = 'BakedModel' | 'BakedQuads' | 'BlockModel' | (string & {})

/** 面名（与文件格式一致；`facing` 的取值）。 */
export type BlockFaceName = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/**
 * 一条方块调色板条目的**类型化承载**。
 *
 * ## 为什么每个字段都必须在（对齐实测的真实产物键集）
 *
 * 实测（`structuredata-exported-envelope.json` 68 条目 + 三份多方块夹具）：
 * `registryId` / `meta` / `renderMode` / `geometry` / `occludesAdjacentFaces` /
 * `tooltip` / `thumbnailPNG` / `nbt` / `facing`。每一个都有**生产消费者**：
 *
 * | 字段 | 生产消费者 |
 * |---|---|
 * | `registryId` + `meta` | 拾取身份（`BlockRef.block_state_id`）、统计、tooltip 回退 |
 * | `geometry` | 网格构建（`structureGeometryCore`）、描边（`context/queries.ts:305`）、注解面（`annotationMeshProvider:268`）、部件检测（`partDetect`） |
 * | `occludesAdjacentFaces` | 邻面剔除（`structureGeometryCore:122/137/146/280/309`） |
 * | `facing` + `nbt` | `buildVoxelVolume` → `VoxelState`（`render/data/grid.ts:48-49`）；`nbt` 另供检查器展示（`blockInspector.ts:33`） |
 * | `thumbnailPNG` | 图标缓存通道 2（`blockIconCache.ts:359-361`） |
 * | `tooltip` | 方块级说明行 |
 *
 * ## 为什么不带 `hostItem`（如实登记）
 *
 * `hostItem`（`pure/itemIndex` 的 `HOST_ITEM_FIELD`）是契约 §2.2 层②的宿主物品桥接数据，
 * 由**部件轮**落盘（`render/schema/types.ts:254`「仅当该结构含部件数据时写出」）。
 * 它属于**部件面**而非方块几何面，且其消费者（`buildItemHitIndex`）读的是**文档根级**
 * `itemIndex`，不是调色板条目。本批把部件面作为独立承载（见 `domain/cellContent`），
 * `hostItem` 随部件轮的其余根级字段（`partIconTextures`/`statsTemplate`/`itemIndex`）
 * **保持原样**（本批不动它们，如实登记为遗留缺口）。
 */
export interface BlockPaletteEntry {
  /** 该条目的**资产身份**（内容派生；同内容 ⇒ 同 id ⇒ 两条目可共享同一几何资产）。 */
  readonly assetId: string
  /** 注册表身份（`namespace:path`；真实产物含 `gregtech:`/`appliedenergistics2:` 等命名空间）。 */
  readonly registryId: string
  readonly meta: number
  readonly renderMode: BlockRenderMode
  /** 烘焙几何；`null` = 该条目**没有**几何（显式，不是空几何）。 */
  readonly geometry: BlockGeometryAsset | null
  /** 是否遮挡相邻面（影响邻面剔除；`undefined` = 文件未声明）。 */
  readonly occludesAdjacentFaces?: boolean
  readonly facing?: BlockFaceName
  readonly nbt?: Readonly<Record<string, unknown>>
  readonly thumbnail?: string
  readonly tooltip?: readonly string[]
}

/** 由资产身份与方块身份合成调色板条目的**稳定键**（供联合表去重；**不是**身份本身）。 */
export function blockPaletteEntryKey(entry: Pick<BlockPaletteEntry, 'registryId' | 'meta' | 'assetId'>): string {
  return `${entry.registryId}\u0000${entry.meta}\u0000${entry.assetId}`
}

/**
 * 调色板**规范化**：按 `(registryId, meta, assetId)` 去重 + 稳定排序。
 *
 * ## 为什么去重键必须含 `assetId`（实测定量，见文件头判据 2）
 *
 * 若只按 `name:meta` 去重，真实信封夹具的 68 条目会塌成 **59** 条
 * （9 组重名，`tile.BlockCableBus:0` 一组 33 个不同模型）—— 于是 33 种线缆形状
 * 只剩 1 种，渲染结果与切换前**不一致**（能力回退）。
 *
 * 去重键含 `assetId` 后：内容相同的条目合并（共享几何，A07），内容不同的保留 ——
 * 两者的判据**都是内容**，不是位置或下标。
 *
 * 排序使"同一份内容两种枚举顺序 ⇒ 同一张表"成为事实（诊断与逐格对照证据可比）。
 */
export function normalizePalette(entries: readonly BlockPaletteEntry[]): readonly BlockPaletteEntry[] {
  const seen = new Map<string, BlockPaletteEntry>()
  for (const e of entries) {
    const k = blockPaletteEntryKey(e)
    if (!seen.has(k)) seen.set(k, e)
  }
  return Object.freeze([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v))
}

/** 资产身份 → 资产（同一份几何在多个条目间**共享**的可执行形式）。 */
export function geometryAssetsOf(entries: readonly BlockPaletteEntry[]): ReadonlyMap<string, BlockGeometryAsset> {
  const out = new Map<string, BlockGeometryAsset>()
  for (const e of entries) {
    if (e.geometry !== null && !out.has(e.assetId)) out.set(e.assetId, e.geometry)
  }
  return out
}

/** 共享统计（诊断/证据用：实体条目数、唯一几何数、共享次数）。 */
export function paletteSharingStats(entries: readonly BlockPaletteEntry[]): {
  readonly entries: number
  readonly uniqueGeometry: number
  readonly shared: number
  readonly withoutGeometry: number
} {
  let withoutGeometry = 0
  const ids = new Set<string>()
  for (const e of entries) {
    if (e.geometry === null) withoutGeometry += 1
    else ids.add(e.assetId)
  }
  return Object.freeze({
    entries: entries.length,
    uniqueGeometry: ids.size,
    shared: entries.length - withoutGeometry - ids.size,
    withoutGeometry,
  })
}

/** 拓扑版本再导出（供呈现/装配两侧读同一个字段，不各自解释）。 */
export function geometryTopologyVersion(asset: BlockGeometryAsset): number {
  return asset.mesh.topology.version
}

/** 未使用占位：保持 `MeshTopology` 类型可达（下游 `import type` 推导用）。 */
export type { MeshTopology }
