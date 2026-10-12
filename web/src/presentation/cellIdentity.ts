/**
 * `presentation/cellIdentity` —— **逐格身份层**（#299 P10e）。
 *
 * ## 本模块补什么（P10d D3c 侦察实测的缺口）
 *
 * P10d 把「内核场景 → `PresentationInputs` → `compileScene`」接通之后，呈现层能画方块了
 * —— 但**画得出来 ≠ 点得中**。实测缺口（#289 收尾报告第四节，Lead 认可）：
 *
 * > 拾取 provenance（`triangleMap` 等价物进 `PickIndex`）—— `context/selection.ts:21-34`
 * > 显式要求 `column`/`row`/`zSlice`；不先做则 presenter 接线即能力回归
 *
 * legacy 侧那条链是：
 *
 * ```
 * raycaster 命中 → faceIndex → mesh.userData.triangleMap[faceIndex]
 *                                     ↑ 逐**三角形** → 单元格身份
 *   → { column, row, zSlice, quadIndex } → BlockRef → 选中/悬停/部件检测
 * ```
 *
 * 而内核侧的对象模型是「**一结构一对象**」：`EvaluatedPrimitive.objectId` 是整座结构的
 * 内容身份（`runtime/presentationAdapter#structurePrimitive`）。于是命中一个三角形只能解到
 * "命中了这个结构"，**解不出"哪一格"** —— 逐格交互面因此整条断掉。
 *
 * ## 三层身份的关系（本模块的核心声明）
 *
 * | 层 | 身份 | 谁给 | 生命周期 |
 * |---|---|---|---|
 * | **对象** | `objectId`（内容派生，如 `structure:0a90e7d2`） | `EvaluatedPrimitive` | 跨重新分批/压缩稳定（A18/G2） |
 * | **元素** | `elementId` + `topologyVersion` | `domain/geometry#ElementRef` | 拓扑变化即失效（`stale-topology`） |
 * | **格** | {@link CellRef}（`column`/`row`/`zSlice`/`quadIndex`） | **本模块** | 与对象同寿命（它是对象**内部**的寻址） |
 *
 * **关键立场**：格身份**不是**第四个对象身份，也不是"把格坐标当对象 ID"
 * （#249 §15 第 9 条要退役的正是后者）。它是**对象内部**的寻址维度 ——
 * 一个 `blockGrid` 对象里有哪些格，是该对象的**内容**的一部分。
 * 因此：
 *
 *  - 格身份**不进** `objectId`：`objectId` 仍由结构几何内容派生，格坐标变了它就是另一份内容
 *    （几何身份随之变），但那是**内容变化**，不是"身份被位置冒充"；
 *  - 格身份**不进**批次：`BatchInstance` 里没有它的位置 —— 它与 `objectId` 一起从
 *    `CompiledScene.payloads` 读出来，而批次序号仍然只在其 `generation` 内有效；
 *  - 格身份**不参与**持久化：它是可丢弃的派生视图（契约 §6「空间索引 ⇒ 可丢弃」）。
 *
 * ## 坐标约定（**逐字**沿用 legacy，不改口径）
 *
 * `column`/`row`/`zSlice` 是**结构网格下标**（`row 0 = 顶部`），与 legacy
 * `scenePick.ScenePickBlock` 的三个字段**同义**；转成 `BlockRef.pos`（Y-up 世界坐标）
 * 的那一次翻转仍只发生在拾取→选择的边界上（`context/queries.ts` 的两处
 * `structureRowToWorldY`），本模块**不做**翻转。
 *
 * 为什么不在本层就翻转：翻转是**边界**问题而不是身份问题（`domain/cellPosition` 的文件头
 * 已就"内核面用世界坐标、翻转只发生一次"给出同一结论）。本模块若自己翻一次，就会出现
 * 两处翻转定义 —— 而"重复坐标翻转"正是 #249 §19.2 / A26 负对照要判红的形态。
 * 于是宁可让本层与 legacy **逐字段同形**（那使"行为与迁移前一致"成为可比对的断言，
 * 而不是"看起来一样"）。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无 three、无 Vue、不读时钟、不修改入参
 * （`presentation-purity` 闸门覆盖本文件）。
 */

/**
 * 一个**单元格引用**：对象内部的寻址。
 *
 * 字段名与 legacy `render/interaction/scenePick#ScenePickBlock` 的
 * `column`/`row`/`zSlice`/`quadIndex` **逐字相同** —— 这是刻意的：迁移的正确判据是
 * 「同一物理命中在两个实现下给出**逐字段相同**的结果」，而字段名不同会让该判据
 * 退化成"人工对照"。
 */
export interface CellRef {
  /** 结构网格列下标（X）。 */
  readonly column: number
  /** 结构网格行下标（**`row 0 = 顶部`**，与文件格式同口径；不是世界 Y）。 */
  readonly row: number
  /** 结构网格 Z 下标。 */
  readonly zSlice: number
  /**
   * 被击中的四边形**在该格内**的序号（格自己的 `BakedQuadsGeometry.quads` 下标）。
   *
   * 为什么它必需（而不只是 `column/row/zSlice`）：`selectionModes` 的"逐面"
   * 语义与 `BlockRef.quadIndex` 都按它寻址；而 legacy `scenePick` 一直在填它
   * （`scenePick.ts:183`）。丢掉它 = 从"命中了一个面"退化成"命中了一个格"。
   */
  readonly quadIndex: number
}

/**
 * **逐三角形 → 单元格**表（`triangleMap` 的等价物）。
 *
 * 不变量：`entries.length === 该几何的 triangleCount`，且第 `t` 项对应
 * `GeometryAttributes.positions` 的第 `t` 个三角形（`positions[9t .. 9t+9)`）。
 *
 * ## 为什么它是**数组**而不是"三角形 → 格"的映射表
 *
 * 拾取路径拿到的天然索引就是 `Raycaster.intersectObject(...)` 给的 `faceIndex` ——
 * 一个**整数三角形序号**。数组的 `O(1)` 直取使"命中 → 格"是一次寻址而不是一次查找，
 * 且**顺序对齐**本身就是判据（错位一格会让点选点到邻居格上，而那是静默错误）。
 */
export type TriangleCellMap = readonly CellRef[];

/**
 * 从逐三角形表解出命中格。
 *
 * 返回 `null` 的两种情形都**不得**静默糊过去（与 `PickIndex.resolve` 同一纪律）：
 *  - 几何**不携带**逐格身份（`map === undefined`）⇒ 该几何不是逐格来源
 *    （A18 自造夹具、纯网格元素等）；
 *  - `triangleIndex` 越界或非整数 ⇒ 表与 GPU 状态不一致（真实缺陷，必须暴露）。
 *
 * ## 为什么越界**不**回落到"取最近的一项"
 *
 * 相邻三角形常常属于**不同**的格（同一四边形的两个三角形一定同格，但跨四边形的
 * 下一个三角形几乎总是邻居格）。回落到最近项会把"点空了"变成"点到了旁边的方块"
 * —— 用户看到的是"选中莫名其妙跑到隔壁"，而不是"没点中"。
 */
export function cellRefOfTriangle(
  map: TriangleCellMap | undefined,
  triangleIndex: number | undefined,
): CellRef | null {
  if (map === undefined) return null;
  if (triangleIndex === undefined) return null;
  if (!Number.isInteger(triangleIndex)) return null;
  if (triangleIndex < 0 || triangleIndex >= map.length) return null;
  return map[triangleIndex] ?? null;
}

/**
 * 表与几何是否**形状一致**（`length === triangleCount`）。
 *
 * 单独成函数而不是内联 `===`：它是三条路径的共同判据 ——
 * 编译期（`compileScene` 的 `cell-map-shape-invalid` 跳过）、
 * 适配层（`structureGeometryAttributes` 自检）、
 * 以及测试（负对照注入）。散落三处 `===` 就是三处会漂移的判据。
 *
 * `map === undefined` ⇒ `true`（"不携带"是合法状态，见 {@link TriangleCellMap}）。
 * 这与"携带了但长度不对"必须区分：后者是**实现缺陷**。
 */
export function cellMapShapeOk(
  map: TriangleCellMap | undefined,
  triangleCount: number,
): boolean {
  if (map === undefined) return true;
  return map.length === triangleCount;
}

/**
 * 由**四边形片段序**产出逐三角形表（**纯函数**；两份几何路径共用同一处构造）。
 *
 * ## 为什么按"每片 2 个三角形"展开
 *
 * `render/mesh/structureGeometryUVs#bakedQuadTriangleAttributesPure` 把一个四边形
 * 展开成 **6 顶点 / 2 三角形**（`[0,1,2]` 与 `[0,2,3]`），每片固定产出 18 个浮点。
 * 于是"第 `t` 个三角形属于第 `floor(t / 2)` 片"是**构造性事实**，不是约定。
 *
 * ## 反漂移：本函数**不重新遍历**几何
 *
 * 它只把调用方已经拿到的**片段序**（与合并属性同一序）翻成表。若它自己去遍历一遍
 * 网格，那两序会在"剔除判据变了"时静默错位 —— 而 D3a 实测的正是这类
 * 「两份重复实现必然漂移」（`structureGeometryAttributes` 曾经不剔除遮挡，与渲染路径
 * 差 3 倍三角形）。故本函数**只做同序展开**，遍历与剔除仍只有一处。
 *
 * @param pieces 按**合并属性同一序**给出的片段（只需 `col`/`row`/`zSlice`/`quadIndex`）
 * @param trianglesPerPiece 每片展开出的三角形数（实测恒为 2；显式传参使该事实可断言）
 */
export function triangleCellMapOf(
  pieces: readonly {
    readonly col: number
    readonly row: number
    readonly zSlice: number
    readonly quadIndex: number
  }[],
  trianglesPerPiece = 2,
): CellRef[] {
  const out: CellRef[] = [];
  for (const p of pieces) {
    const ref: CellRef = Object.freeze({
      column: p.col,
      row: p.row,
      zSlice: p.zSlice,
      quadIndex: p.quadIndex,
    });
    // 同一个四边形展开出的若干个三角形**逐项写入同一个**冻结引用
    // （内容相同的格引用不必各持一份；这也让"同格两三角形同引用"成为可断言的事实）。
    for (let t = 0; t < trianglesPerPiece; t++) out.push(ref);
  }
  return out;
}

/** 两个格引用是否指同一格（**不含** `quadIndex` —— "同一格"是格身份问题）。 */
export function sameCell(a: CellRef, b: CellRef): boolean {
  return a.column === b.column && a.row === b.row && a.zSlice === b.zSlice;
}

/** 两个格引用是否指同一**面**（含 `quadIndex`）。 */
export function sameCellFace(a: CellRef, b: CellRef): boolean {
  return sameCell(a, b) && a.quadIndex === b.quadIndex;
}

/**
 * 格引用 → 稳定键（`"column,row,zSlice"`）。
 *
 * 与 `domain/cellPosition#cellPositionKey` 的**段序**刻意不同：那个是 Y-up 世界坐标
 * 的 `"x,y,z"`，本键是**网格下标**的 `"column,row,zSlice"`。两者是不同坐标系下的键，
 * 用同一个构造函数会让"把 row 当 y 传"变成**能编译**的错误。
 * ⇒ 本函数就地在呈现层定义（呈现层不得 import `domain/` 之外的旧层，
 * 而 `domain/` 侧的键语义不同，复用是错的）。
 */
export function cellKeyOf(cell: CellRef): string {
  return `${cell.column},${cell.row},${cell.zSlice}`;
}
