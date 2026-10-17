/**
 * 生成**内置多方块样例**（`web/data/scenes/builtin-multiblock-ebf.json`）。
 *
 * ## 为什么需要它
 *
 * 产品要能在「设置 → 内置示例」里一步打开一份多方块文档（否则用户必须自备外部文件
 * 才能看到通道面板）。样例的内容来自测试夹具 `multiblock-ebf-2ch.json`（T0.5 合成样品，
 * 被 traversal / illegal / panel 三套判据钉得最死）—— 故样例**不是手写的新文档**，
 * 而是它的**产品化再包装**：声明/场景/规则（`cellGrid` 决定的**结构**）逐字节不变，
 * 重写信封 `meta`（去掉 `fixtureSynthetic`/`fixtureFile`/`payloadNote` 等测试专用字段）、
 * 把载荷换成生产形态 `gzip+base64`（与真实 /sde 产物同一读取路径，format 文档 §8.3），
 * 并把**呈现资产**（每方块几何 + 贴图）改写成生产约定（见下）。
 *
 * ## 为什么必须改写呈现资产（M5 手测否决的真实根因）
 *
 * 夹具的 `blockPalette[].geometry` 是 **T0.5 合成占位**：
 *  - 每方块只有 **2 个四边形**（z=0 与 z=16 两个整面），不是盒体；
 *  - 顶点坐标在 **MC 纹素空间 0..16**，而生产约定是**单位立方体 0..1**；
 *  - 四张 `textureBlobs` 是 **1×1 纯红 PNG**（`ff0000`，alpha 0x7f）。
 *
 * 生产几何收集器（`render/mesh/structureGeometryUVs#bakedQuadTriangleAttributesPure`）
 * 直接把顶点坐标加上**体素整数偏移**（每格 1 个单位）—— 于是 0..16 的四边形在
 * 3×2×3 的机器上铺满 **18×17 个世界单位**（真实导出是 0..1 ⇒ 3×2×3）。
 * 相机按 `bounds=±1.5` 取景 ⇒ 屏幕上只剩两片巨大的红色四边形。
 * 实测（M5 手测打回）：画布 764736 像素里 764598 是纯背景灰。
 *
 * 真实导出的调色板条目是 `0..1` 单位立方体的 **6 个面**（`texture-uv-orientation`
 * 与 `structuredata-exported-envelope.json` 实测：`quads: 6`、`x/y/z ∈ [0,1]`）。
 * ⇒ 本脚本把样例的呈现资产**按同一约定重建**：单位盒 6 面 + 16×16 程序化贴图
 * （每种材质一张：机壳 / 线圈 / 玻璃 / 控制器），并保留按面烘焙的明暗（顶点色），
 * 使盒体在相机下有立体感。**结构（cellGrid/变体/规则）一字未改** —— 参考网格判据
 * （逐格 `name:meta`）因此完全不受影响。
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/multiblock-fixtures/make-builtin-sample.mjs
 * ```
 *
 * 产物是**可再生物**：不要手改 `web/data/scenes/builtin-multiblock-ebf.json`，
 * 要改就改夹具/本脚本后重跑（判据 `web/e2e/builtin-multiblock-sample.spec.ts` 会打开它）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const source = path.join(repoRoot, 'web', 'src', 'context', '__tests__', 'fixtures', 'multiblock-ebf-2ch.json')
const target = path.join(repoRoot, 'web', 'data', 'scenes', 'builtin-multiblock-ebf.json')

const fixture = JSON.parse(fs.readFileSync(source, 'utf8'))
if (fixture.payloadEncoding !== 'base64(json)') {
  throw new Error(`夹具载荷形态变了（期望 base64(json)，实际 ${String(fixture.payloadEncoding)}）—— 请同步更新本脚本`)
}

// 内层 body：结构性字段逐字节保留（面板/通道/变体键/参考网格判据按它断言）。
const innerText = Buffer.from(fixture.payload, 'base64').toString('utf8')
const inner = JSON.parse(innerText)
if (inner?.multiblock === undefined) throw new Error('夹具内层 body 不含 multiblock 节')

// ─────────────────────────────────────────────────────────────────────────────
// 呈现资产：单位盒几何 + 程序化贴图（生产约定，见文件头）
// ─────────────────────────────────────────────────────────────────────────────

/** 材质下标：与 `materialPalette` 顺序一致（casing/coil/glass/controller）。 */
const MATERIAL = { casing: 0, coil: 1, glass: 2, controller: 3 }

/**
 * 面定义：单位立方体 `[0,1]^3`，**外向逆时针**绕序（三.js 默认 `FrontSide` ⇒ 绕序有意义）。
 *
 * `brightness` 是按面烘焙的明暗（等轴视角下的习惯值：顶面最亮、底面最暗），
 * 写进顶点色后与贴图**相乘**（`presenter#createMaterial` 的既有语义）。
 */
const FACES = [
  // +y（顶）
  { key: 'top', brightness: 1.0, v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  // -y（底）
  { key: 'bottom', brightness: 0.55, v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  // +z / -z（前后）
  { key: 'front', brightness: 0.92, v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { key: 'back', brightness: 0.72, v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  // +x / -x（左右）
  { key: 'right', brightness: 0.84, v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { key: 'left', brightness: 0.66, v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
]

/** MC 顶点色的打包口径（`rgbTripletFromMcTessellatorColor`：r 低字节、b 高字节）。 */
function packedColor(factor) {
  const v = Math.max(0, Math.min(255, Math.round(factor * 255)))
  return v + (v << 8) + (v << 16)
}

/** 面的 UV：侧面 v 以 y 为轴（贴图正立），顶/底面用 x/z。 */
function uvOf(faceKey, p) {
  if (faceKey === 'top' || faceKey === 'bottom') return [p[0], p[2]]
  return [p[0], p[1]]
}

/**
 * 一个调色板条目的**单位盒几何**（6 面）。
 *
 * @param materialIndex 该条目使用的主材质下标
 * @param tint 顶点色乘子（用于让"运行态"两种控制器在像素上可区分）
 * @param frontMaterial 前脸单独材质（控制器用它把屏幕贴到 +z 面；缺省 = 同主材质）
 */
function cubeQuads({ materialIndex, tint = 1, frontMaterial = null }) {
  return FACES.map((face) => ({
    materialIndex: face.key === 'front' && frontMaterial !== null ? frontMaterial : materialIndex,
    vertices: face.v.map((p) => {
      const [u, v] = uvOf(face.key, p)
      return {
        x: p[0],
        y: p[1],
        z: p[2],
        u,
        v,
        brightness: face.brightness,
        color: packedColor(face.brightness * tint),
      }
    }),
  }))
}

/** 调色板条目 → 呈现资产规格（材质 / 明暗乘子）。 */
function assetSpecOf(entry) {
  const rid = String(entry.registryId ?? '')
  const name = rid.slice(rid.indexOf(':') + 1)
  if (name === 'blockcasings5') return { materialIndex: MATERIAL.coil, tint: 1 }
  if (name === 'blockglass1') return { materialIndex: MATERIAL.glass, tint: 1 }
  if (name === 'blockmachines') {
    // 两个控制器条目：idle 压暗、active 全亮（运行态在像素上可辨）。
    const active = Array.isArray(entry.tooltip) && String(entry.tooltip[0] ?? '').includes('running')
    return { materialIndex: MATERIAL.casing, frontMaterial: MATERIAL.controller, tint: active ? 1 : 0.78 }
  }
  return { materialIndex: MATERIAL.casing, tint: 1 }
}

let rewritten = 0
for (const entry of inner.blockPalette ?? []) {
  const quads = entry?.geometry?.quads
  if (!Array.isArray(quads) || quads.length === 0) continue // air
  const spec = assetSpecOf(entry)
  entry.geometry = {
    encoding: 'bakedQuadsJsonV1',
    quads: cubeQuads({ materialIndex: spec.materialIndex, tint: spec.tint, frontMaterial: spec.frontMaterial ?? null }),
  }
  rewritten += 1
}
if (rewritten < 4) throw new Error(`呈现资产改写条数异常（${rewritten}）—— 夹具调色板形态可能变了`)

// ── 程序化贴图（16×16 RGBA，确定性；无随机、无外部文件）─────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** RGBA 像素（16×16）→ PNG（filter 0，无交错）。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PX = 16
function blank() {
  return Buffer.alloc(PX * PX * 4)
}
function put(buf, x, y, [r, g, b, a = 255]) {
  const i = (y * PX + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = a
}
function fill(buf, rgba) {
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) put(buf, x, y, rgba)
}
/** 机壳：灰色钢板 + 深色边框 + 四角铆钉。 */
function texCasing() {
  const t = blank()
  fill(t, [138, 143, 150])
  for (let i = 0; i < PX; i++) {
    put(t, i, 0, [92, 97, 103]); put(t, i, PX - 1, [92, 97, 103])
    put(t, 0, i, [92, 97, 103]); put(t, PX - 1, i, [92, 97, 103])
  }
  for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(t, x + dx, y + dy, [200, 204, 210])
  }
  for (let y = 6; y <= 9; y++) for (let x = 5; x <= 10; x++) put(t, x, y, [122, 127, 134])
  return t
}
/** 线圈：铜色横条（深/亮交替）。 */
function texCoil() {
  const t = blank()
  for (let y = 0; y < PX; y++) {
    const dark = y % 4 === 0 || y % 4 === 1
    const c = dark ? [124, 70, 32] : [188, 116, 58]
    for (let x = 0; x < PX; x++) put(t, x, y, c)
  }
  for (let x = 0; x < PX; x++) {
    put(t, x, 0, [96, 54, 24])
    put(t, x, PX - 1, [96, 54, 24])
  }
  return t
}
/** 玻璃：浅蓝半透明 + 深色框 + 一条高光斜线。 */
function texGlass() {
  const t = blank()
  fill(t, [150, 200, 228, 205])
  for (let i = 0; i < PX; i++) {
    put(t, i, 0, [96, 150, 180, 235]); put(t, i, PX - 1, [96, 150, 180, 235])
    put(t, 0, i, [96, 150, 180, 235]); put(t, PX - 1, i, [96, 150, 180, 235])
  }
  for (let i = 2; i < 9; i++) for (let d = 0; d < 2; d++) put(t, i + d, PX - 2 - i, [220, 240, 252, 225])
  return t
}
/** 控制器：深色机壳 + 绿色屏幕（带扫描线）+ 红色指示灯。 */
function texController() {
  const t = blank()
  fill(t, [40, 44, 52])
  for (let y = 4; y <= 11; y++) {
    for (let x = 3; x <= 12; x++) {
      const scan = y % 3 === 0
      put(t, x, y, scan ? [40, 130, 78] : [64, 208, 122])
    }
  }
  for (const x of [3, 12]) for (let y = 4; y <= 11; y++) put(t, x, y, [24, 70, 44])
  put(t, 14, 2, [220, 64, 64])
  return t
}

inner.textureBlobs = [texCasing(), texCoil(), texGlass(), texController()].map((t) => encodePng(PX, PX, t).toString('base64'))

const envelope = {
  documentFormat: 'Envelope',
  payloadEncoding: 'gzip+base64',
  meta: {
    id: 'sample:multiblock/electric-blast-furnace',
    mode: 'multiblock',
    label: '示例·电力高炉（多方块）',
    author: 'Lightning 内置样例',
    description:
      '内置合成样例（非真实导出）：3×3×h 塔式机器，height 尺寸型通道定骨干，coil/glass 双替换型通道叠加，'
      + '运行态两态只差异材质。呈现资产（单位盒几何 + 16×16 程序化贴图）按生产约定重建，'
      + '结构（骨架阶/变体/规则）与 ebf-2ch 夹具逐字节一致。'
      + '由 scripts/multiblock-fixtures/make-builtin-sample.mjs 再生成，勿手改。',
    documentShape: 'multiblock',
  },
  payload: zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8'), { level: 9 }).toString('base64'),
}

fs.writeFileSync(target, JSON.stringify(envelope))
console.log(`wrote ${path.relative(repoRoot, target)} (${fs.statSync(target).size} bytes); 改写呈现资产 ${rewritten} 条`)
