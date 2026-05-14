/**
 * 将屏幕像素偏移转换为世界坐标偏移。
 *
 * 符号约定基于用户直觉（Blender 惯例），与生产代码的 computeDelta 公式无关：
 *   - 向右拖拽 X 手柄 → +X 世界
 *   - 向上拖拽 Y 手柄 → +Y 世界（屏幕 Y 轴方向相反）
 *   - 向左拖拽 Z 手柄 → +Z 世界
 */
export function screenDeltaToWorld(
  screenDx: number,
  screenDy: number,
  axis: 'x' | 'y' | 'z',
  sensitivity: number,
): number {
  if (axis === 'x') return screenDx * sensitivity
  if (axis === 'y') return -screenDy * sensitivity
  return -screenDx * sensitivity // 'z'
}
