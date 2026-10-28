/**
 * 生成**动态贴图内置样例**（`web/data/scenes/builtin-animated-texture.json`）。
 *
 * ## 为什么需要它
 *
 * 验收要手测「动态贴图在视口里播放」和「GIF 导出会动」。第一份内置样例
 * （`builtin-multiblock-ebf`）与既有 `export.json` 的材质**都没有 animation 声明**
 * （实测 `materialPalette[].animation` 命中 0）—— 只有这两份样例的话，手测看不到任何动画。
 *
 * ## 来源（可再生物，勿手改）
 *
 * 源夹具 = `web/e2e/fixtures/texture-strip-animated.v2.json`（双 Area 纹理时间判据夹具）：
 * 3×3×3 实心网格 + 16×64 **四色竖条**（帧 0 在最上）+ 4 帧 `frameSequence`
 * （`[{0}, {1,3}, {2,1}, {3,2}]`，default 2 tick）。它的"帧 0 红 / 帧 3 黄"像素变化
 * 已被 `e2e/texture-time-dual-area.spec.ts` 实测过 ⇒ 是**真的会动**的贴图，不是占位。
 *
 * 本脚本只做三件产品化的事：
 *  1. 世界帧轴从 1 帧扩到 **3 帧**（同一结构，`durationMs: 200`）—— 只有多帧文档才有
 *     播放按钮（单帧文档没有帧控制 tab），用户才能"播放着看"；
 *  2. 信封换成生产形态 `Envelope + gzip+base64`（与真实 /sde 产物同一读取路径）；
 *  3. meta 换成产品语汇，去掉夹具专用键（`tags` 保留为空数组也无妨，这里一并产品化）。
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/multiblock-fixtures/make-animated-sample.mjs
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const source = path.join(repoRoot, 'web', 'e2e', 'fixtures', 'texture-strip-animated.v2.json')
const target = path.join(repoRoot, 'web', 'data', 'scenes', 'builtin-animated-texture.json')

const sourceDoc = JSON.parse(fs.readFileSync(source, 'utf8'))
const material = sourceDoc.materialPalette?.[0]
if (material?.kind !== 'animated' || material.animation === undefined) {
  throw new Error('源夹具的材质必须声明 kind=animated + animation（否则样例动不起来）')
}
const blobs = sourceDoc.textureBlobs ?? {}
if (typeof blobs['0'] !== 'string') throw new Error('源夹具必须内嵌 textureBlobs["0"] 字节')
const baseFrame = sourceDoc.frames?.[0]
if (baseFrame?.structure === undefined) throw new Error('源夹具必须有第 0 帧结构')

// 3 帧同结构：多帧文档才挂播放按钮（单帧文档没有帧控制 tab）。
const FRAME_COUNT = 3
const FRAME_MS = 200
const frames = Array.from({ length: FRAME_COUNT }, (_, i) => ({
  index: i,
  durationMs: FRAME_MS,
  structure: baseFrame.structure,
}))

const body = {
  format_version: '2.0',
  id: 'sample:animated-texture',
  meta: {
    name: '示例·动态贴图',
    author: 'Lightning 内置样例',
    created_at_ms: 0,
    description:
      '内置合成样例（非真实导出）：3×3×3 网格 + 16×64 四色竖条纹理（4 帧，'
      + 'frameSequence [{0},{1,3},{2,1},{3,2}]）。播放时纹理帧随时间变化，GIF 导出相邻帧不同。'
      + '由 scripts/multiblock-fixtures/make-animated-sample.mjs 再生成，勿手改。',
    tags: [],
    origin: { x: 0, y: 0, z: 0 },
  },
  frames,
  annotations: sourceDoc.annotations ?? [],
  labels: sourceDoc.labels ?? [],
  materialPalette: sourceDoc.materialPalette,
  textureBlobs: blobs,
}

const envelope = {
  documentFormat: 'Envelope',
  payloadEncoding: 'gzip+base64',
  meta: body.meta,
  payload: zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf8'), { level: 9 }).toString('base64'),
}

fs.writeFileSync(target, JSON.stringify(envelope))
console.log(`wrote ${path.relative(repoRoot, target)} (${fs.statSync(target).size} bytes)`)
