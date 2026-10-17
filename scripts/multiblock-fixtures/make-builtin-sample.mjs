/**
 * 生成**内置多方块样例**（`web/data/scenes/builtin-multiblock-ebf.json`）。
 *
 * ## 为什么需要它
 *
 * 产品要能在「设置 → 内置示例」里一步打开一份多方块文档（否则用户必须自备外部文件
 * 才能看到通道面板）。样例的内容来自测试夹具 `multiblock-ebf-2ch.json`（T0.5 合成样品，
 * 被 traversal / illegal / panel 三套判据钉得最死）—— 故样例**不是手写的新文档**，
 * 而是它的**产品化再包装**：内层 body 逐字节不变，只重写信封 `meta`（去掉
 * `fixtureSynthetic`/`fixtureFile`/`payloadNote` 等测试专用字段）并把载荷换成
 * 生产形态 `gzip+base64`（与真实 /sde 产物同一读取路径，format 文档 §8.3）。
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

// 内层 body：逐字节保留（判据按它断言面板/通道/变体键）。
const innerText = Buffer.from(fixture.payload, 'base64').toString('utf8')
const inner = JSON.parse(innerText)
if (inner?.multiblock === undefined) throw new Error('夹具内层 body 不含 multiblock 节')

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
      + '运行态两态只差异材质。由 scripts/multiblock-fixtures/make-builtin-sample.mjs 从 ebf-2ch 夹具再生成，勿手改。',
    documentShape: 'multiblock',
  },
  payload: zlib.gzipSync(Buffer.from(innerText, 'utf8'), { level: 9 }).toString('base64'),
}

fs.writeFileSync(target, JSON.stringify(envelope))
console.log(`wrote ${path.relative(repoRoot, target)} (${fs.statSync(target).size} bytes)`)
