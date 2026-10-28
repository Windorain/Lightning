/**
 * 捕获占位条目（`renderMode: "CapturePlaceholder"`）的**呈现策略常量**。
 *
 * 占位条目由导出侧在"世界里有一个方块、但捕获期拿不到任何可观测几何"时生成：
 * 它带一份方块局部 [0,1]³ 的单位立方体，材质取自该方块图集图标。它的语义是
 * **"这是替身，不是真几何"**，不是一块实心方块。
 *
 * ## 为什么策略是"半透明、不写深度"
 *
 * - 半透明：一眼能与真几何区分；保留原色（只降不透明度、不染色）则仍能认出厂牌。
 * - 不写深度：替身不能把身后的东西裁掉，否则"透明"只对背景成立，对相邻几何不成立；
 *   也让两个相邻占位格不会互相遮成实心块。
 * - 不参与邻面剔除：占位格没有"实心面"这回事，它的六个面都要发出来（见
 *   `render/mesh/structureGeometryCore`），邻格也不因它而少画。
 *
 * 这三条只在**呈现**层生效；导出件里的 `renderMode` / `captureIssue` 原样承载，
 * 判据读的是它们，不是这里的像素。
 */

/** 导出件里标记"该格是捕获占位"的 `renderMode` 取值。 */
export const CAPTURE_PLACEHOLDER_RENDER_MODE = 'CapturePlaceholder'

/**
 * 占位条目的不透明度（0..1）。
 *
 * 0.4 是**可辨认**与**不喧宾夺主**的折中：低于 0.3 在暗色方块（如黑曜石图标）上
 * 几乎看不见，高于 0.6 又容易被误认成真方块。集中在这里，便于实机观感复核后调整。
 */
export const CAPTURE_PLACEHOLDER_OPACITY = 0.4

/** 该 `renderMode` 是否是捕获占位（未知/缺省一律不是）。 */
export function isCapturePlaceholderRenderMode(renderMode: string | undefined | null): boolean {
  return renderMode === CAPTURE_PLACEHOLDER_RENDER_MODE
}
