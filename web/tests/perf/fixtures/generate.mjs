/**
 * #262 P11-C · **性能标定夹具生成器**（S / M / L 三档，确定性、可复算）。
 *
 *   ```powershell
 *   cd web
 *   node tests/perf/fixtures/generate.mjs            # 生成三档 + manifest
 *   node tests/perf/fixtures/generate.mjs --scale M  # 只生成一档
 *   ```
 *
 * ## 为什么这个脚本**在树里**（而测量脚手架不在）
 *
 * #249 §14 明文要求性能门槛「标定阈值并记录方法与数据」，#251 B2 §3.3 把夹具生成器
 * 列为标定批次（#262）的正式交付物 —— 它是**正式测试设施**，不是探索草稿：
 * 没有它，"本轮实测数字"无法在下一批复算（夹具一变，历史数字全部失效，B2 §1 第 3 条）。
 * 生成**产物**（大件 JSON）是可再生的，按既有 gitignore 口径不落树。
 *
 * ## 三档的轴（对齐 #251 B2 §3.2）
 *
 * | 轴 | S | M | L |
 * |---|---|---|---|
 * | 可编辑方块对象数 | 1 000 | 20 000 | 120 000 |
 * | 其中不同几何源数 | 8 | 40 | 120 |
 * | 材质数 | 4 | 16 | 48 |
 * | 纹理数 | 4 | 16 | 48 |
 * | 注解框对象数（**本生成器不产出**，见下） | 5 | 50 | 300 |
 *
 * ### 注解轴的诚实说明（**不得当作已覆盖**）
 *
 * 本生成器产出的 v2 plain 文档里 `annotations` 恒为 `[]`。理由：v2 的注解载荷是
 * **旧面原样透传**（`builtinParsers` 里 `annotations: (world.annotations as unknown[]) ?? []`），
 * 其几何字段（`min/max/renderStyle/...`）的正确形状属于旧格式契约，本批**不去猜**
 * ——猜错会让装配把注解记成"skipped"，于是"注解更慢"变成"注解根本没被算"，
 * 而后者在数字上看起来完全正常（**静默的错误结论比没有结论更坏**）。
 *
 * 注解轴因此只在**呈现层夹具**上覆盖（`src/presentation/__tests__/fixtures.ts` 的
 * `makePrimitive`，可造任意数量对象），标定表里逐点标明该点覆盖了哪条轴。
 *
 * ## 确定性（B2 §3.3 要求"可复算"）
 *
 * 无时间、无 `Math.random`：每个格子的调色板下标由 `cellIndex` 的整数散列决定。
 * 同一提交重复运行 ⇒ 逐字节一致（manifest 里的 sha256 可机械对账）。
 * gzip 的 MTIME 钉死为 0（与 `adapters/files/envelopeCodec.ts` 的 `GZIP_MTIME_PINNED` 同口径）。
 *
 * ## 产物落点
 *
 * 缺省 `web/test-artifacts/perf-fixtures/`（`.gitignore` 已含 `web/test-artifacts/`）。
 * **不落 `web/test-results/`**：Playwright 每次启动会清空那个目录，夹具会被静默删掉。
 * 可用 `P11C_PERF_FIXTURE_DIR` 覆盖（标定脚本与本生成器读同一个变量）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `web/`。 */
export const WEB_ROOT = path.resolve(HERE, '..', '..', '..')

/** 夹具产物目录（gitignore 内**可再生物**；不落 `test-results/`，那个目录会被 Playwright 清空）。 */
export const FIXTURE_DIR =
  process.env.P11C_PERF_FIXTURE_DIR ?? path.join(WEB_ROOT, 'test-artifacts', 'perf-fixtures')

// ─────────────────────────────────────────────────────────────────────────────
// 三档规格
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 档位规格。
 *
 * `dims` 是 `cellGrid` 的 `[z][row][col]` 尺寸（契约 `format-scene-file.md`：
 * `cellGrid` 是 `[z][row][col]` 的整数下标网格），`z*row*col` 必须等于 `blocks`。
 */
export const SCALES = Object.freeze({
  S: Object.freeze({
    id: 'S',
    blocks: 1_000,
    geometrySources: 8,
    materials: 4,
    textures: 4,
    dims: Object.freeze({ z: 1, row: 10, col: 100 }),
  }),
  M: Object.freeze({
    id: 'M',
    blocks: 20_000,
    geometrySources: 40,
    materials: 16,
    textures: 16,
    dims: Object.freeze({ z: 10, row: 20, col: 100 }),
  }),
  L: Object.freeze({
    id: 'L',
    blocks: 120_000,
    geometrySources: 120,
    materials: 48,
    textures: 48,
    dims: Object.freeze({ z: 10, row: 100, col: 120 }),
  }),
})

/** 1×1 透明 PNG（与 `e2e/fixtures/minimal-v2.json` 同一个 blob，避免引入二进制资产）。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ─────────────────────────────────────────────────────────────────────────────
// 构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 整数散列（**确定性**，无 `Math.random`）—— 决定每格用哪个调色板条目。
 *
 * 用 FNV-1a 变体：与整个内核的"纯 FNV-1a 哈希"口径一致（`adapters/host/*` 的纪律）。
 */
function cellHash(z, row, col) {
  let h = 0x811c9dc5
  for (const v of [z, row, col]) {
    h ^= v & 0xff
    h = Math.imul(h, 0x01000193)
    h ^= (v >>> 8) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 一个立方体几何源（6 面 × 4 顶点，与 `bakedQuadsJsonV1` 契约一致）。 */
function cubeQuads(color) {
  const face = (verts) => ({
    materialIndex: 0,
    vertices: verts.map(([x, y, z, u, v]) => ({ x, y, z, u, v, color })),
  })
  const uv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const corners = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // +z
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // -y
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], // +x
    [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], // -x
  ]
  return corners.map((c, i) => face(c.map((p, j) => [...p, uv[j][0], uv[j][1], i])))
}

/**
 * 生成一档 v2 **plain** 文档（World 形态：顶层有 `frames`）。
 *
 * ## 调色板为什么**两处都要有**（实测得出，不是照抄）
 *
 * | 位置 | 谁读它 | 缺了会怎样 |
 * |---|---|---|
 * | `frames[i].structure.blockPalette` | `RuntimeDocument._fromV2CellGrid` 建 `Grid` | 帧网格为 `null` ⇒ 装配层判 `unsupportedDocumentShape`（整个文档装配不出来） |
 * | 根级 `blockPalette` | `WorldParser` 的 `world.blockPalette` → `RuntimeDocument.blockPalette` | 文档级调色板缺失（下游读面拿不到方块身份） |
 *
 * `e2e/fixtures/minimal-v2.json` 只有帧内那一份（所以它作为"最小解析样本"够用）；
 * 真正能被装配成内核场景的文档两处都要有 —— 本生成器两处都写。
 */
export function buildPlainDoc(spec) {
  const { dims, geometrySources: K, materials, textures } = spec

  // ① blockPalette：0 号是 air，1..K 是 K 个**不同**几何源（B2 的"共享度"轴）
  const blockPalette = [
    {
      registryId: 'air',
      meta: 0,
      renderMode: 'BakedQuads',
      geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
      occludesAdjacentFaces: false,
      tooltip: [],
    },
  ]
  for (let i = 1; i <= K; i++) {
    blockPalette.push({
      registryId: `lightning:perf_source_${i}`,
      meta: i % 16,
      renderMode: 'BakedQuads',
      geometry: { encoding: 'bakedQuadsJsonV1', quads: cubeQuads(0x100000 * i) },
      // 一半遮挡邻面、一半不遮挡 —— 否则"遮挡剔除"这一类真实成本被夹具抹平
      occludesAdjacentFaces: i % 2 === 0,
      tooltip: [`Perf Source ${i}`],
    })
  }

  // ② cellGrid[z][row][col] = **整数**调色板下标
  //
  // 必须是整数，不是 `[下标, meta]` 对：`RuntimeDocument._fromV2CellGrid` 逐格读
  // `rawRow[x]` 当 `palIdx` 用（`palIdx > AIR_PALETTE_INDEX && palIdx < palette.length`）。
  // 第一版照抄了 `e2e/fixtures/minimal-v2.json` 的 `[[1,1],[1,1]]` 对形态 —— 那是
  // **多方块** `cellGrid` 的约定，于本格式里数组与数字比较恒为假 ⇒ **全格判成空气**
  // ⇒ `cells` 装配出 0 格，装配层以 `no-typed-geometry` 跳过对象
  // ⇒ "渲染重编/拾取"的读数全部是在**空场景**上量的（数字漂亮，实为零断言）。
  const cellGrid = new Array(dims.z)
  for (let z = 0; z < dims.z; z++) {
    const plane = new Array(dims.row)
    for (let row = 0; row < dims.row; row++) {
      const line = new Array(dims.col)
      for (let col = 0; col < dims.col; col++) {
        // 每 7 格留 1 格空气：真实结构不是实心块，纯实心会掩盖"逐格跳过"的成本
        const air = cellHash(z, row, col) % 7 === 0
        line[col] = air ? 0 : 1 + (cellHash(z, row, col) % K)
      }
      plane[row] = line
    }
    cellGrid[z] = plane
  }

  const materialPalette = []
  for (let i = 0; i < materials; i++) materialPalette.push({ textureBlobIndex: i % textures })

  const textureBlobs = []
  for (let i = 0; i < textures; i++) {
    textureBlobs.push({ id: `perf-tex-${i}`, mime: 'image/png', dataBase64: TINY_PNG_BASE64 })
  }

  return {
    format_version: '2.0',
    id: `p11c-perf-${spec.id}`,
    meta: {
      name: `P11-C perf fixture ${spec.id}`,
      author: '',
      created_at_ms: 0,
      description: `#262 P11-C 性能标定夹具（确定性生成器 tests/perf/fixtures/generate.mjs）`,
      tags: ['perf', 'p11c', spec.id],
      origin: { x: 0, y: 0, z: 0 },
    },
    frames: [
      {
        index: 0,
        structure: { geometryPhase: 'baked', cellGrid, blockPalette },
      },
    ],
    // 根级调色板（World 形态：跨帧共享一张；见上表"两处都要有"）
    blockPalette,
    // 注解轴**不在本生成器覆盖范围**（理由见文件头"注解轴的诚实说明"）
    annotations: [],
    labels: [],
    materialPalette,
    textureBlobs,
  }
}

/**
 * 把 plain 文档包成 **Envelope**（`gzip+base64`，MTIME 钉死）。
 *
 * 与 `adapters/files/envelopeCodec.ts#encodeEnvelope` 的 `COMPACT_PAYLOAD_ENCODING`
 * 同口径：`gzip(utf8(JSON.stringify(body)))` → base64；`meta` 显式给 `{}`。
 */
export function buildEnvelopeDoc(plain) {
  const json = JSON.stringify(plain)
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9, mtime: 0 })
  return {
    documentFormat: 'Envelope',
    payloadEncoding: 'gzip+base64',
    meta: {},
    payload: gz.toString('base64'),
  }
}

/** 统计量（B2 §3.2 的"必须记录"列 —— 本生成器覆盖得到的那几项）。 */
export function statsOf(plain, envelope) {
  const frame = plain.frames[0]
  const grid = frame.structure.cellGrid
  let cells = 0
  let solid = 0
  for (const plane of grid) {
    for (const line of plane) {
      for (const cell of line) {
        cells++
        // 格子是**整数**下标（不是 `[下标, meta]` 对）——第一版按对形态写这里，
        // `cell[0]` 在数字上是 `undefined`，于是"全格实心"的假统计量进了 manifest。
        if (cell !== 0) solid++
      }
    }
  }
  const palette = plain.blockPalette
  let quads = 0
  for (const entry of palette) quads += (entry.geometry?.quads ?? []).length
  return Object.freeze({
    cells,
    solidCells: solid,
    airCells: cells - solid,
    geometrySources: palette.length - 1,
    blockPaletteEntries: palette.length,
    paletteQuads: quads,
    materials: plain.materialPalette.length,
    textures: plain.textureBlobs.length,
    annotations: plain.annotations.length,
    dims: { z: grid.length, row: grid[0]?.length ?? 0, col: grid[0]?.[0]?.length ?? 0 },
    plainBytes: Buffer.byteLength(JSON.stringify(plain), 'utf8'),
    envelopeBytes: Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
  })
}

/** 写一份文件并返回 `{ bytes, sha256 }`。 */
function writeArtifact(file, content) {
  const text = typeof content === 'string' ? content : `${JSON.stringify(content)}\n`
  fs.writeFileSync(file, text, 'utf8')
  const buf = Buffer.from(text, 'utf8')
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const onlyAt = argv.indexOf('--scale')
  const only = onlyAt >= 0 ? String(argv[onlyAt + 1]).toUpperCase() : null
  const wanted = only === null ? ['S', 'M', 'L'] : [only]
  for (const id of wanted) {
    if (SCALES[id] === undefined) {
      console.error(`未知档位 ${JSON.stringify(id)}（可选 S / M / L）`)
      process.exit(2)
    }
  }

  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const manifestPath = path.join(FIXTURE_DIR, 'manifest.json')
  const previous = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { entries: {} }

  const rows = []
  for (const id of wanted) {
    const spec = SCALES[id]
    const plain = buildPlainDoc(spec)
    const envelope = buildEnvelopeDoc(plain)
    const plainFile = path.join(FIXTURE_DIR, `perf-${id}.plain.json`)
    const envFile = path.join(FIXTURE_DIR, `perf-${id}.envelope.json`)
    const a = writeArtifact(plainFile, plain)
    const b = writeArtifact(envFile, envelope)
    const stats = statsOf(plain, envelope)
    previous.entries[id] = {
      scale: id,
      spec,
      plain: { file: path.basename(plainFile), ...a },
      envelope: { file: path.basename(envFile), ...b },
      stats,
    }
    rows.push({ id, ...stats, envelopeKb: Math.round(b.bytes / 1024) })
  }

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        note: '#262 P11-C 性能标定夹具清单（生成器 tests/perf/fixtures/generate.mjs，确定性、可复算）',
        generator: 'web/tests/perf/fixtures/generate.mjs',
        generatedAt: new Date().toISOString(),
        entries: previous.entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`夹具目录：${FIXTURE_DIR}`)
  console.log(
    ['档', '方块(实/空)', '几何源', '材质', '纹理', 'plain KB', 'envelope KB']
      .map((h, i) => h.padEnd([4, 16, 8, 6, 6, 10, 12][i]))
      .join(''),
  )
  for (const r of rows) {
    console.log(
      [
        r.id,
        `${r.solidCells}/${r.airCells}`,
        String(r.geometrySources),
        String(r.materials),
        String(r.textures),
        String(Math.round(r.plainBytes / 1024)),
        String(r.envelopeKb),
      ]
        .map((v, i) => v.padEnd([4, 16, 8, 6, 6, 10, 12][i]))
        .join(''),
    )
  }
  console.log(`manifest：${manifestPath}`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
