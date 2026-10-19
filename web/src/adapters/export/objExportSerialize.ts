/**
 * OBJ/MTL 文本序列化（纯函数，无 Three）。
 * 非索引三角条：每三角形独立 v/vt/vn，便于 Blender 等消费。
 */

export interface ObjExportMesh {
  objectName: string
  materialName: string
  positions: Float32Array
  uvs: Float32Array
  colors?: Float32Array
}

export interface MtlSerializedEntry {
  name: string
  kd?: [number, number, number]
  ka?: [number, number, number]
  ks?: [number, number, number]
  d?: number
  illum?: number
  mapKd?: string
}

/** 三角条：positions 长度 = n*9，uvs = n*6（每三角 3 顶点） */
export function computeFlatNormalsNonIndexed(positions: Float32Array): Float32Array {
  const t = positions.length / 9
  const out = new Float32Array(t * 9)
  for (let i = 0; i < t; i++) {
    const o = i * 9
    const ax = positions[o]!
    const ay = positions[o + 1]!
    const az = positions[o + 2]!
    const bx = positions[o + 3]!
    const by = positions[o + 4]!
    const bz = positions[o + 5]!
    const cx = positions[o + 6]!
    const cy = positions[o + 7]!
    const cz = positions[o + 8]!
    const e1x = bx - ax
    const e1y = by - ay
    const e1z = bz - az
    const e2x = cx - ax
    const e2y = cy - ay
    const e2z = cz - az
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz)
    if (len > 1e-20) {
      nx /= len
      ny /= len
      nz /= len
    } else {
      nx = 0
      ny = 1
      nz = 0
    }
    for (let k = 0; k < 3; k++) {
      out[o + k * 3] = nx
      out[o + k * 3 + 1] = ny
      out[o + k * 3 + 2] = nz
    }
  }
  return out
}

/**
 * 将内部 UV（与 {@link simpleMaterialLibrary} 中 `Texture.flipY = false` / Forge 一致，常为「图像空间」v）转为
 * Blender 等 DCC 导入 Wavefront 时期望的 **OpenGL 式 vt**（v=0 在贴图底边）。
 * 若不转换，会出现竖直方向采样错位、图案「挤出」面外等现象。
 */
export function flipVCoordForObjInterop(uvs: Float32Array): Float32Array {
  const out = new Float32Array(uvs.length)
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = uvs[i]!
    out[i + 1] = 1.0 - uvs[i + 1]!
  }
  return out
}

/**
 * 生成 .obj 主体（无文件头时可由适配层拼接 mtllib）。
 */
export function serializeObjMeshes(options: {
  headerLines?: string[]
  mtllibName?: string
  meshes: ObjExportMesh[]
  /**
   * 为 true（默认）时对写入的 vt 做 v 翻转，与 Blender 等导入器一致；
   * 若工具链已使用 Forge 同款 v，可设为 false。
   */
  flipTextureVForBlender?: boolean
}): string {
  const lines: string[] = []
  if (options.headerLines) {
    for (const h of options.headerLines) lines.push(h.startsWith('#') ? h : `# ${h}`)
  }
  if (options.mtllibName) {
    lines.push(`mtllib ${options.mtllibName}`)
    lines.push('')
  }

  const flipV = options.flipTextureVForBlender !== false

  let vBase = 1
  for (const m of options.meshes) {
    const pos = m.positions
    const uv = flipV ? flipVCoordForObjInterop(m.uvs) : m.uvs
    const norms = computeFlatNormalsNonIndexed(pos)
    const triCount = pos.length / 9
    if (uv.length < triCount * 6) {
      throw new Error('serializeObjMeshes: uvs 与 positions 三角数量不匹配')
    }

    lines.push(`o ${sanitizeObjName(m.objectName)}`)
    lines.push(`g ${sanitizeObjName(m.objectName)}`)
    lines.push(`usemtl ${sanitizeObjName(m.materialName)}`)

    for (let t = 0; t < triCount; t++) {
      const po = t * 9
      const uo = t * 6
      const no = t * 9
      for (let k = 0; k < 3; k++) {
        lines.push(
          `v ${fmt(pos[po + k * 3]!)} ${fmt(pos[po + k * 3 + 1]!)} ${fmt(pos[po + k * 3 + 2]!)}`,
        )
      }
      for (let k = 0; k < 3; k++) {
        lines.push(`vt ${fmt(uv[uo + k * 2]!)} ${fmt(uv[uo + k * 2 + 1]!)}`)
      }
      for (let k = 0; k < 3; k++) {
        lines.push(
          `vn ${fmt(norms[no + k * 3]!)} ${fmt(norms[no + k * 3 + 1]!)} ${fmt(norms[no + k * 3 + 2]!)}`,
        )
      }
      const a = vBase
      const b = vBase + 1
      const c = vBase + 2
      lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`)
      vBase += 3
    }
    lines.push('')
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const t = Math.round(n * 1e6) / 1e6
  return String(t)
}

function sanitizeObjName(s: string): string {
  const t = s.trim().replace(/\s+/g, '_')
  return t.length > 0 ? t : 'mesh'
}

export function serializeMtl(entries: MtlSerializedEntry[]): string {
  const lines: string[] = ['# web-structure-renderer', '']
  for (const e of entries) {
    lines.push(`newmtl ${sanitizeObjName(e.name)}`)
    const ka = e.ka ?? [1, 1, 1]
    const kd = e.kd ?? [1, 1, 1]
    const ks = e.ks ?? [0, 0, 0]
    lines.push(`Ka ${ka[0]} ${ka[1]} ${ka[2]}`)
    lines.push(`Kd ${kd[0]} ${kd[1]} ${kd[2]}`)
    lines.push(`Ks ${ks[0]} ${ks[1]} ${ks[2]}`)
    if (e.d !== undefined) lines.push(`d ${e.d}`)
    if (e.illum !== undefined) lines.push(`illum ${e.illum}`)
    if (e.mapKd) lines.push(`map_Kd ${e.mapKd}`)
    lines.push('')
  }
  return lines.join('\n') + '\n'
}
