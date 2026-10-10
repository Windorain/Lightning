/**
 * 呈现编译的测试夹具（**共享构造器**，不是替身）。
 *
 * 纪律：这里造的是**真实数据结构**（`EvaluatedPrimitive` / `GeometrySource`），
 * 没有任何 Mock/Stub/Fake —— 被测代码就是生产路径。夹具只是"输入的显式化"，
 * 这样每条断言都能被第三方用同一函数复现（#249 §14「夹具哈希」的前提）。
 */

import type {
  EvaluatedPrimitive,
  EvaluationKey,
  GeometryAttributes,
  GeometryId,
  GeometrySource,
  MaterialDescriptor,
} from '../evaluationKey'
import { TIME_ZERO } from '../evaluationKey'

/** 列主序平移矩阵（构造局部变换用）。 */
export function translationMatrix(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

export const DEFAULT_MATERIAL: MaterialDescriptor = {
  id: 'mat:stone',
  version: 'v1',
  blend: 'opaque',
  tint: 0xffffff,
  useVertexColor: true,
}

/** 造一份最简单的几何属性（真实数据，可被 `BufferGeometry` 直接消费）。 */
export function makeAttributes(triangleCount = 1, seed = 0): GeometryAttributes {
  const positions = new Float32Array(triangleCount * 9)
  const uvs = new Float32Array(triangleCount * 6)
  const colors = new Float32Array(triangleCount * 9)
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9
    positions[o + 3] = 1
    positions[o + 7] = 1
    for (let i = 0; i < 6; i++) uvs[t * 6 + i] = seed
    for (let i = 0; i < 9; i++) colors[o + i] = 1
  }
  return { positions, uvs, colors, triangleCount }
}

/** 内存几何来源：**按内容身份**返回同一份属性实例（模拟真实缓存语义）。 */
export class MemoryGeometrySource implements GeometrySource {
  private readonly versions = new Map<GeometryId, string>()
  private readonly attrs = new Map<GeometryId, GeometryAttributes>()

  set(id: GeometryId, version: string, attrs: GeometryAttributes): void {
    this.versions.set(id, version)
    this.attrs.set(id, attrs)
  }

  /** 模拟"内容被替换"：版本变、属性实例换新（旧 GPU 资源必须失效）。 */
  replace(id: GeometryId, version: string, attrs: GeometryAttributes): void {
    this.set(id, version, attrs)
  }

  /** 模拟"资源不可用"（缺失/失败）。 */
  makeUnavailable(id: GeometryId): void {
    this.attrs.delete(id)
  }

  versionOf(id: GeometryId): string | undefined {
    return this.versions.get(id)
  }

  attributesOf(id: GeometryId): GeometryAttributes | undefined {
    return this.attrs.get(id)
  }
}

/** 造一个对象（一切字段显式，无默认魔术）。 */
export function makePrimitive(
  objectId: string,
  overrides: Partial<EvaluatedPrimitive> = {},
): EvaluatedPrimitive {
  const base: EvaluatedPrimitive = {
    objectId,
    geometry: overrides.geometry ?? { id: 'geo:cube', version: 'v1' },
    material: overrides.material ?? DEFAULT_MATERIAL,
    transform: overrides.transform ?? translationMatrix(0, 0, 0),
    bounds: overrides.bounds ?? { min: [0, 0, 0], max: [1, 1, 1] },
    deform: overrides.deform ?? 'shared',
    transparency: overrides.transparency ?? null,
  }
  return overrides.elementId === undefined ? base : { ...base, elementId: overrides.elementId }
}

/**
 * **A18 均质夹具**：N 个同几何/同材质/不透明的对象，空间上排成三维网格。
 *
 * 这是 A18 判据的夹具生成器（"10,000 个同几何/材质不透明对象，统一可见性条件"）。
 * 同一函数在 vitest（结构计数）与 e2e（真 GL 实测）两侧共用 —— 于是两边的"均质夹具"
 * 是**同一个定义**，数字可比。
 *
 * `stride` 控制相邻对象间距；默认 2.0 使包围盒不重叠（统一可见性条件不含遮挡）。
 */
export function makeHomogeneousFixture(
  count: number,
  options: {
    geometryId?: GeometryId
    geometryVersion?: string
    stride?: number
    material?: MaterialDescriptor
  } = {},
): EvaluatedPrimitive[] {
  const geometryId = options.geometryId ?? 'geo:cube'
  const geometryVersion = options.geometryVersion ?? 'v1'
  const material = options.material ?? DEFAULT_MATERIAL
  const stride = options.stride ?? 2
  const side = Math.max(1, Math.ceil(Math.cbrt(count)))
  const out: EvaluatedPrimitive[] = []
  for (let i = 0; i < count; i++) {
    const x = i % side
    const y = Math.floor(i / side) % side
    const z = Math.floor(i / (side * side))
    out.push(
      makePrimitive(`obj:${i}`, {
        geometry: { id: geometryId, version: geometryVersion },
        material,
        transform: translationMatrix(x * stride, y * stride, z * stride),
        bounds: {
          min: [x * stride, y * stride, z * stride],
          max: [x * stride + 1, y * stride + 1, z * stride + 1],
        },
      }),
    )
  }
  return out
}

/** 造一个求值键（一切字段显式；便于逐维差分测试）。 */
export function makeKey(overrides: Partial<EvaluationKey> = {}): EvaluationKey {
  return {
    documentVersion: 1,
    scene: 'scene:default',
    time: TIME_ZERO,
    parameterVersion: 0,
    contentResourceVersions: {},
    ...overrides,
  }
}

/** FNV-1a 32bit —— 夹具哈希（证据里与提交 SHA 并列记录）。 */
export function fixtureHash(values: readonly unknown[]): string {
  const s = JSON.stringify(values)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
