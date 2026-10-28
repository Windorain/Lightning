/**
 * pure/mcShotCamera.ts — MC 控制面 `CameraSpec` → web 正交出图机位（{@link ShotCameraSpec}）的**唯一换算点**。
 *
 * 背景（三对齐）：SDE 导出的结构 JSON 需要「用与游戏内控制面完全相同的正交机位」在 web 侧出图。
 * 游戏内（mod）与 web 是两套相机口径：
 *   - MC 口径：`yaw` 为 MC 世界偏航角（度），`pitch` 为俯仰（+ = 向下看），`pos` 为 **MC 世界坐标**（方块整数格）；
 *   - web 口径：`yawDeg` 为 web 轨道方位角，`elevationDeg`（+ = 俯视），`pos` 为 **web 局部坐标**
 *     （体素网格已按 w/h/d 居中到原点，见 `render/mesh/quadGeometry.ts`）。
 * 换算规则集中在此，禁止在算子/调用方各自重写。
 *
 * 纯函数：无副作用、无 DOM、不改写入参。
 */

/**
 * 出图机位（web 口径）——**相对内容包围盒中心**的落点 + 诊断角 + 正交全高 + 分辨率。
 *
 * 消费方是 `presentation/shotCamera#shotCameraSpecOf`（把 `pos` / `orthoHeight` 变成内核
 * 冻结的 `CameraSpec` 值）与 `operators/builtin/exportOperators#ExportShotPngOperator`。
 * 旧的 `workbench/exportShotImage.ts` 烘焙器已随旧链删除，本形状不随它消失：
 * 它描述的是 **MC 口径 → 结构相对口径** 的换算，与哪台渲染器无关。
 */
export interface ShotCameraSpec {
  /** web 局部系相机落点（左上角前的观察点，不是目标点） */
  pos: { x: number; y: number; z: number }
  /** web 口径方位角（度） */
  yawDeg: number
  /** web 口径俯仰（度），正 = 俯视 */
  elevationDeg: number
  /** 竖直全高（方块数；不是半高） */
  orthoHeight: number
  /** 任意分辨率；不 clamp、不强制正方 */
  width: number
  height: number
}

/** MC 控制面 `CameraSpec`（mod 侧 `xyz.windorain.lightning.sde.control.CameraSpec` 的 JSON 同形）。 */
export interface McCameraSpec {
  /** MC 世界坐标（方块整数格） */
  pos: [number, number, number]
  /** MC 偏航角（度） */
  yaw: number
  /** MC 俯仰角（度），正 = 俯视 */
  pitch: number
  /** 竖直全高（方块数） */
  orthoHeight: number
  width: number
  height: number
}

/**
 * three `lookAt` 在视线与 `up` 平行时退化（画面内旋向不确定）——
 * 极点机位（pitch = ±90）退让 ε 度，ε 残余水平分量把「画面内旋向」钉死在与 MC 一致的一侧。
 */
export const MC_POLE_PITCH_EPSILON_DEG = 1e-3

/** 归一化到 [0, 360)（对非有限值返回 NaN，交由调用方校验） */
function normalizeYawDeg(deg: number): number {
  if (!Number.isFinite(deg)) return NaN
  const m = deg % 360
  return m < 0 ? m + 360 : m
}

/**
 * MC 偏航 → web 方位角：`yawDeg = (180 - yaw) mod 360`。
 *
 * 已互证：MC 的 yaw 增长方向与 web 轨道方位角相反，且两套「0°」相差 180°
 * （MC 0 = 朝 +z 看，web 0 = 相机在 +z 侧朝 -z 看）。
 */
export function mcYawToWebYawDeg(yawMc: number): number {
  return normalizeYawDeg(180 - yawMc)
}

/**
 * MC 俯仰 → web 仰角。两者同名同号（正 = 俯视），仅需处理 lookAt 极点退化。
 */
export function mcPitchToWebElevationDeg(pitchMc: number): number {
  const limit = 90 - MC_POLE_PITCH_EPSILON_DEG
  if (!Number.isFinite(pitchMc)) return NaN
  if (pitchMc >= 90) return limit
  if (pitchMc <= -90) return -limit
  return pitchMc
}

/** MC 世界坐标 − center（center 为**结构包围盒中心**的 MC 世界坐标）→ web 局部坐标。 */
function mcPosToLocal(
  pos: readonly [number, number, number],
  center: readonly [number, number, number],
): { x: number; y: number; z: number } {
  return { x: pos[0] - center[0], y: pos[1] - center[1], z: pos[2] - center[2] }
}

/**
 * MC 控制面机位 → web 出图机位。`width` / `height` / `orthoHeight` 原样透传（不 clamp）。
 *
 * @param mc MC 机位（pos 为 MC 世界坐标）
 * @param center 结构包围盒中心的 MC 世界坐标；由调用方从 `scanBounds` + `cellGrid` 尺寸复原
 *               （见 {@link structureCenterFromScanBounds}）
 */
export function mcSpecToShotCamera(
  mc: McCameraSpec,
  center: [number, number, number],
): ShotCameraSpec {
  return {
    pos: mcPosToLocal(mc.pos, center),
    yawDeg: mcYawToWebYawDeg(mc.yaw),
    elevationDeg: mcPitchToWebElevationDeg(mc.pitch),
    orthoHeight: mc.orthoHeight,
    width: mc.width,
    height: mc.height,
  }
}

/**
 * 由 SDE `scanBounds` 与 `cellGrid` 尺寸复原**结构包围盒中心**的 MC 世界坐标。
 *
 * `scanBounds`（`StructureDataExporter scan` 写入 `meta.scanBounds`）只记录**最小角**：
 * `minX` / `maxY` / `minZ`。网格是 `cellGrid[d][row][col]`，尺寸 `w/h/d`，
 * `row` 0 = 顶 = `maxY`。每格在 MC 里占 1×1×1 的**半开立方体**，故格 (col,row,z) 的
 * MC 角（最小角）为 `(minX+col, maxY-row, minZ+z)`，内容连续 AABB 为
 * `[minX, minX+w] × [maxY-h+1, maxY+1] × [minZ, minZ+d]`，中心即：
 *
 * ```
 * C = ( minX + w/2 ,  maxY + 1 - h/2 ,  minZ + d/2 )
 * ```
 *
 * 互证（web 侧体素坐标）：`render/mesh/quadGeometry.ts` 与 `structureGeometryUVs.ts` 都把
 * 「MC 格角」映射到 web 体素的**最小角**（`ox = col - sizeColumn/2`、`oy = voxelY - sizeRow/2`），
 * 于是本式给出 `MC格角 − C = web 体素最小角`、
 * `MC格角 + 0.5 − C = voxelCenterWorld(...)`（见 `pure/vec.ts`）——逐格精确成立。
 *
 * ⚠️ 旧实现取的是格**下标**中心 `(minX+(w-1)/2, maxY-(h-1)/2, minZ+(d-1)/2)`，三轴各**少算半格**：
 * 调用方按它算 `pos − center` 时，相机会沿视线横移半格，出图轻微偏轴（不是正对结构轴心）。
 * 验收侧已按连续 AABB 中心 `(66.5,12.5,65.5)` 出图，与本式一致。
 */
export function structureCenterFromScanBounds(
  scanBounds: { minX: number; maxY: number; minZ: number },
  size: { w: number; h: number; d: number },
): [number, number, number] {
  return [
    scanBounds.minX + size.w / 2,
    scanBounds.maxY + 1 - size.h / 2,
    scanBounds.minZ + size.d / 2,
  ]
}
