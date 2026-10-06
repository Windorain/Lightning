/**
 * `pure/mcShotCamera` 单测 —— MC 控制面 CameraSpec → web 出图机位换算。
 *
 * 契约来源：#87 §2.2「三对齐」（web 出图机位必须与游戏内控制面同机位）。
 * 本文件是**换算口径的回归锁**：yaw 映射 / pitch 透传与极点退让 / 中心复原公式 / pos 减算 / 归一化边界。
 *
 * 位置说明：任务指定路径为 `src/pure/mcShotCamera.test.ts`（非 `src/pure/__tests__/`），
 * `vitest.config.ts` 的 include 为 `src/**\/*.test.ts`，两种位置等价，此处照任务口径。
 */
import { describe, it, expect } from 'vitest'

import {
  MC_POLE_PITCH_EPSILON_DEG,
  mcPitchToWebElevationDeg,
  mcSpecToShotCamera,
  mcYawToWebYawDeg,
  structureCenterFromScanBounds,
  type McCameraSpec,
  type ShotCameraSpec,
} from '@/pure/mcShotCamera'

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

function mcSpec(partial: Partial<McCameraSpec> = {}): McCameraSpec {
  return {
    pos: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    orthoHeight: 12,
    width: 1280,
    height: 720,
    ...partial,
  }
}

const CENTER: [number, number, number] = [-492, 4, -12]

function expectPos(
  actual: ShotCameraSpec['pos'],
  expected: [number, number, number],
): void {
  expect(actual.x).toBeCloseTo(expected[0], 9)
  expect(actual.y).toBeCloseTo(expected[1], 9)
  expect(actual.z).toBeCloseTo(expected[2], 9)
}

// ---------------------------------------------------------------------------
// ① yaw 映射（六轴机位逐台）
// ---------------------------------------------------------------------------

describe('mcYawToWebYawDeg：MC 偏航 → web 方位角', () => {
  it('yaw 180 → 0（MC 朝 -z 看 ↔ web 相机在 +z 侧）', () => {
    expect(mcYawToWebYawDeg(180)).toBe(0)
  })

  it('yaw 0 → 180', () => {
    expect(mcYawToWebYawDeg(0)).toBe(180)
  })

  it('yaw 90 → 90', () => {
    expect(mcYawToWebYawDeg(90)).toBe(90)
  })

  it('yaw 270 → 270', () => {
    expect(mcYawToWebYawDeg(270)).toBe(270)
  })

  it('yaw -90 → 270（负角归一化到 [0,360)）', () => {
    expect(mcYawToWebYawDeg(-90)).toBe(270)
  })

  it('yaw 450 → 90（超一圈归一化）', () => {
    expect(mcYawToWebYawDeg(450)).toBe(90)
  })

  it('yaw 360 ≡ yaw 0 → 180（整圈等价）', () => {
    expect(mcYawToWebYawDeg(360)).toBe(180)
    expect(mcYawToWebYawDeg(360)).toBe(mcYawToWebYawDeg(0))
  })

  it('结果恒落在 [0,360)', () => {
    for (const yaw of [-720, -361, -359, -180, -1, 0, 1, 179, 359, 360, 721, 1080]) {
      const web = mcYawToWebYawDeg(yaw)
      expect(web, `yaw=${yaw}`).toBeGreaterThanOrEqual(0)
      expect(web, `yaw=${yaw}`).toBeLessThan(360)
    }
  })

  it('非有限输入 → NaN（不静默产出机位）', () => {
    expect(Number.isNaN(mcYawToWebYawDeg(NaN))).toBe(true)
    expect(Number.isNaN(mcYawToWebYawDeg(Infinity))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ② pitch → elevation（含极点退让）
// ---------------------------------------------------------------------------

describe('mcPitchToWebElevationDeg：MC 俯仰 → web 仰角', () => {
  it('pitch 0 透传（水平视线）', () => {
    expect(mcPitchToWebElevationDeg(0)).toBe(0)
  })

  it('普通俯仰角透传（含负值 = 仰视）', () => {
    expect(mcPitchToWebElevationDeg(10)).toBe(10)
    expect(mcPitchToWebElevationDeg(30)).toBe(30)
    expect(mcPitchToWebElevationDeg(45.5)).toBe(45.5)
    expect(mcPitchToWebElevationDeg(-30)).toBe(-30)
  })

  it(`top 机位 pitch 90 → 90-ε = ${90 - MC_POLE_PITCH_EPSILON_DEG}（lookAt 极点退让）`, () => {
    expect(mcPitchToWebElevationDeg(90)).toBe(90 - MC_POLE_PITCH_EPSILON_DEG)
    expect(mcPitchToWebElevationDeg(90)).toBe(89.999)
  })

  it(`bottom 机位 pitch -90 → -90+ε = ${-(90 - MC_POLE_PITCH_EPSILON_DEG)}`, () => {
    expect(mcPitchToWebElevationDeg(-90)).toBe(-(90 - MC_POLE_PITCH_EPSILON_DEG))
    expect(mcPitchToWebElevationDeg(-90)).toBe(-89.999)
  })

  it('越界 |pitch| > 90 同样夹到极点退让值（不产出 |elevation| ≥ 90）', () => {
    expect(mcPitchToWebElevationDeg(120)).toBe(89.999)
    expect(mcPitchToWebElevationDeg(-120)).toBe(-89.999)
  })

  it('非有限输入 → NaN', () => {
    expect(Number.isNaN(mcPitchToWebElevationDeg(NaN))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ③ 中心复原公式（scanBounds + cellGrid 尺寸）
// ---------------------------------------------------------------------------

describe('structureCenterFromScanBounds：结构包围盒中心（MC 世界坐标）', () => {
  const SCAN = { minX: -492, maxY: 4, minZ: -12 }

  it('3×2×1 网格手算对照：C = (-490.5, 4, -11.5)', () => {
    // x: -492 + 3/2       = -492 + 1.5 = -490.5
    // y:    4 + 1 - 2/2   =    4 + 0   = 4
    // z:  -12 + 1/2       =  -12 + 0.5 = -11.5
    expect(structureCenterFromScanBounds(SCAN, { w: 3, h: 2, d: 1 })).toEqual([-490.5, 4, -11.5])
  })

  it('单格结构（w=h=d=1）时中心 = 该格 MC 格角 + 半格（即该格几何中心）', () => {
    expect(structureCenterFromScanBounds(SCAN, { w: 1, h: 1, d: 1 })).toEqual([-491.5, 4.5, -11.5])
  })

  it('5×3×2 手算对照：(-489.5, 3.5, -11)', () => {
    expect(structureCenterFromScanBounds(SCAN, { w: 5, h: 3, d: 2 })).toEqual([-489.5, 3.5, -11])
  })

  it('#87 复现场景（scanBounds minX=64 maxY=12 minZ=64，5×1×3）→ (66.5, 12.5, 65.5)', () => {
    // 与 #87 验收侧手工传入的 MB_SHOT_CENTER 一致（连续 AABB 中心）
    expect(
      structureCenterFromScanBounds({ minX: 64, maxY: 12, minZ: 64 }, { w: 5, h: 1, d: 3 }),
    ).toEqual([66.5, 12.5, 65.5])
  })

  it('中心公式与体素网格坐标约定**精确**互证：MC 格角 − C 恰为 web 体素**最小角**', () => {
    // web 口径（见 render/mesh/quadGeometry.ts 的 minX/maxX 与
    // structureGeometryUVs.ts 的 ox/oy/oz）：格 (col,row,z) 占
    //   [col - w/2, col+1 - w/2] × [voxelY - h/2, voxelY+1 - h/2] × [z - d/2, z+1 - d/2]
    // 其中 voxelY = h-1-row（structureRowToWorldY，row 0 = 顶）。
    // MC 侧格角：x = minX + col，y = maxY - row，z = minZ + z。
    // 本用例把「MC 格角 − C == web 体素最小角」逐格钉死：公式若少算/多算半格，这里立刻变红。
    const w = 3
    const h = 2
    const d = 2
    const C = structureCenterFromScanBounds(SCAN, { w, h, d })
    for (let z = 0; z < d; z++) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const voxelY = h - 1 - row
          const localX = SCAN.minX + col - C[0]
          const localY = SCAN.maxY - row - C[1]
          const localZ = SCAN.minZ + z - C[2]
          const meshMinX = col - w / 2
          const meshMinY = voxelY - h / 2
          const meshMinZ = z - d / 2
          expect(localX, `x col=${col}`).toBeCloseTo(meshMinX, 9)
          expect(localY, `y row=${row}`).toBeCloseTo(meshMinY, 9)
          expect(localZ, `z z=${z}`).toBeCloseTo(meshMinZ, 9)
        }
      }
    }
  })

  it('单格结构：内容几何中心落在 web 原点（内容居中）', () => {
    const C = structureCenterFromScanBounds(SCAN, { w: 1, h: 1, d: 1 })
    // 唯一格 col=row=z=0：MC 格角 (minX, maxY, minZ)，该格在 MC 里占 [格角, 格角+1)
    // （y 向上：y=12 的方块占 [12,13)），故其几何中心 = 格角 +(0.5,0.5,0.5)。
    // 减 C 后 = web 体素中心 (0+0.5-1/2, …) = (0,0,0) ⇒ 内容恰好居中于 web 原点。
    expect(SCAN.minX + 0.5 - C[0]).toBeCloseTo(0, 9)
    expect(SCAN.maxY + 0.5 - C[1]).toBeCloseTo(0, 9)
    expect(SCAN.minZ + 0.5 - C[2]).toBeCloseTo(0, 9)
  })
})

// ---------------------------------------------------------------------------
// ④ mcSpecToShotCamera：整机位换算（pos 减算 + 透传）
// ---------------------------------------------------------------------------

describe('mcSpecToShotCamera：整机位换算', () => {
  it('pos_local = pos_mc − center（逐轴）', () => {
    const spec = mcSpecToShotCamera(mcSpec({ pos: [-482, 14, 18], yaw: 180, pitch: 10 }), CENTER)
    expectPos(spec.pos, [10, 10, 30])
  })

  it('width / height / orthoHeight 原样透传（不 clamp、不强制正方）', () => {
    const spec = mcSpecToShotCamera(
      mcSpec({ pos: [0, 0, 0], orthoHeight: 14.5, width: 1280, height: 720 }),
      CENTER,
    )
    expect(spec.orthoHeight).toBe(14.5)
    expect(spec.width).toBe(1280)
    expect(spec.height).toBe(720)
  })

  it('宽高不被改写成正方形（1280×720 与 720×1280 都原样）', () => {
    expect(mcSpecToShotCamera(mcSpec({ width: 720, height: 1280 }), CENTER)).toMatchObject({
      width: 720,
      height: 1280,
    })
    expect(mcSpecToShotCamera(mcSpec({ width: 1025, height: 3 }), CENTER)).toMatchObject({
      width: 1025,
      height: 3,
    })
  })

  it('六轴机位逐台：yaw 180/0/90/270 + pitch 0 与 top（pitch 90）', () => {
    const cases: Array<{
      label: string
      yaw: number
      pitch: number
      expectedYaw: number
      expectedElevation: number
    }> = [
      { label: 'north(yaw 180)', yaw: 180, pitch: 0, expectedYaw: 0, expectedElevation: 0 },
      { label: 'south(yaw 0)', yaw: 0, pitch: 0, expectedYaw: 180, expectedElevation: 0 },
      { label: 'east(yaw 90)', yaw: 90, pitch: 0, expectedYaw: 90, expectedElevation: 0 },
      { label: 'west(yaw 270)', yaw: 270, pitch: 0, expectedYaw: 270, expectedElevation: 0 },
      { label: 'top 机位（俯视，yaw 180）', yaw: 180, pitch: 90, expectedYaw: 0, expectedElevation: 89.999 },
      { label: 'top 机位（俯视，yaw 90）', yaw: 90, pitch: 90, expectedYaw: 90, expectedElevation: 89.999 },
    ]

    for (const c of cases) {
      const spec = mcSpecToShotCamera(
        mcSpec({ pos: [-482, 14, 18], yaw: c.yaw, pitch: c.pitch }),
        CENTER,
      )
      expect(spec.yawDeg, c.label).toBe(c.expectedYaw)
      expect(spec.elevationDeg, c.label).toBe(c.expectedElevation)
      // 极点退让不影响 yaw 映射（水平分量方向仍由 yaw 决定）
      expectPos(spec.pos, [10, 10, 30])
    }
  })

  it('纯函数契约：不改写 mc 入参与 center 入参', () => {
    const mc = mcSpec({ pos: [-482, 14, 18], yaw: 180, pitch: 10 })
    const center: [number, number, number] = [-492, 4, -12]
    const mcBefore = JSON.stringify(mc)
    const centerBefore = JSON.stringify(center)
    mcSpecToShotCamera(mc, center)
    expect(JSON.stringify(mc)).toBe(mcBefore)
    expect(JSON.stringify(center)).toBe(centerBefore)
  })
})
