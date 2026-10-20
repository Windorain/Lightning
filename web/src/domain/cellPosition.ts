/**
 * `domain/cellPosition` —— **单元格位置的稳定键**（#289 P10d；GF-7 的唯一定义点）。
 *
 * ## 为什么单独一个模块（而不是放在 `domain/scene`）
 *
 * 逐格内容（`domain/cellContent`）与方块网格载荷（`domain/scene`）都要用这个键，
 * 而 `domain/scene` 的 `ObjectDataPayload` 又需要引用逐格内容的**表类型**。
 * 若键放在 `scene` 里，`cellContent` → `scene` →（载荷字段）→ `cellContent` 就成环。
 *
 * ⇒ 键与位置类型下沉到本模块（它不依赖任何别的领域模块），
 * 两个消费者都向它单向依赖 —— 依赖图无环，且键的**唯一权威**仍只有一处。
 *
 * ## 键的语义（#250 comment 5443 的 GF-7 裁决）
 *
 * 值格式 `"x,y,z"`，**Y-up 世界坐标**（`y = 0` 为底），与生产
 * `BlockRef.block_state_id` 的坐标系同源。GF-7 批准的就是这个口径。
 *
 * ## 为什么用世界坐标而不是文件的下标（`[z][row][col]`）
 *
 * 文件格式的 `cellGrid` 用 `row 0 = 顶部`；世界坐标用 `y = 0` 为底。两者之间是
 * `structureRowToWorldY`（自逆）。若内核承载**下标**，那么每一个消费者都要自己
 * 做一次翻转才能回答"这一格在哪" —— 而"重复坐标翻转"正是 #249 §19.2
 * 与 A26 负对照要判红的形态。
 *
 * ⇒ 翻转**一次**发生在解析期（`context/runtimeDocument#_fromV2CellGrid`），
 * 内核面全部用世界坐标；投影回文件时**再一次**（`composition/kernelProjection`，
 * 复用同一个 `structureRowToWorldY` 反解）。两处各自唯一，中间零翻转。
 */

/**
 * 单元格的**世界坐标**（Y-up；`y = 0` 为底）。
 *
 * 与旧层 `pure/gridTypes#GridPos` 形状相同但**归属不同**：后者属 `pure/`，
 * `domain/` 不得依赖它（#249 §4 规则 1）。就地声明使本模块零旧层依赖 ——
 * 这与 `domain/content` 对 `MaterialBlendMode` 的同一处置
 * （"就地声明是**唯一来源**而不是重复"）。
 */
export interface CellPosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 位置 → **稳定键**（`"x,y,z"`）。
 *
 * 保留 `cellContentKeyOf` 这个名字作为**别名**：`composition/kernelAssembly` 的
 * `blockCellKey` 是它在装配侧的既有名字（GF-7 的公开口径），改名会让既有调用点
 * 与测试被迫同步改动，而那是"改名冒充重构"。两个名字指向**同一个函数**。
 */
export function cellPositionKey(pos: CellPosition): string {
  return `${pos.x},${pos.y},${pos.z}`
}

/** 别名（历史名；与 {@link cellPositionKey} 是同一个函数）。 */
export const cellContentKeyOf = cellPositionKey

/**
 * 键 → 位置；非法返回 `null`（不抛：坏数据是**显式**跳过，由诊断计数）。
 *
 * 与键构造是**对偶**关系：两个方向必须同形，由 `domain/__tests__/cellPosition.test.ts`
 * 的往返断言把守。空段**必须显式拒绝**：`Number('')` 是 `0`，直接判
 * `Number.isInteger` 会让 `"1,2,"` 被静默读成 `(1,2,0)` —— 一次真实的坐标误读
 * （这条判据与 `composition/kernelProjection#parseBlockCellKey` 逐字同口径，
 * 本模块是它的**唯一权威**，那里改为转发）。
 */
export function parseCellPositionKey(key: string): CellPosition | null {
  const parts = key.split(',')
  if (parts.length !== 3) return null
  if (parts.some((p) => p.trim() === '')) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null
  return Object.freeze({ x, y, z })
}
