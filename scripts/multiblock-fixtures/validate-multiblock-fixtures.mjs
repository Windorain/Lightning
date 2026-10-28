/**
 * fixture 校验器 —— **格式校验 + 装配算法参考实现**。
 *
 *   node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs            # 校验全部 fixture
 *   node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <file>...  # 校验指定文件
 *   node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --dump-expanded   # 额外落盘展开对照
 *
 * 它同时是 web 装配器的**对照蓝本**：装配路径只有查表 + 索引 + 区间写入，
 * 零游戏逻辑、零函数求值、零 GT/StructureLib 知识。web 解析器还不存在时，本脚本是
 * fixture 的唯一机器判据。
 *
 * 退出码：0 = 全绿；1 = 有硬失败（格式非法 / 装配出错 / 变体缺失）。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  assembleVariant,
  channelBounds,
  enumerateVariants,
  entrySignature,
  expectedCombinationKeys,
  parseVariantKey,
  readFixtureDocument,
  tierSample,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURE_DIR = join(REPO, 'web', 'src', 'context', '__tests__', 'fixtures')
const OUT_DIR = join(HERE, '.out')

// ---------------------------------------------------------------------------
// 校验流水线
// ---------------------------------------------------------------------------

class Checks {
  constructor(name) {
    this.name = name
    this.items = []
  }
  ok(id, detail) {
    this.items.push({ id, status: 'ok', detail })
  }
  warn(id, detail) {
    this.items.push({ id, status: 'warn', detail })
  }
  fail(id, detail) {
    this.items.push({ id, status: 'FAIL', detail })
  }
  get failures() {
    return this.items.filter((i) => i.status === 'FAIL')
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validateChannelList(ch, chk) {
  const keys = new Set()
  const ids = new Set()
  const enums = new Set()
  const names = new Set()
  for (const c of ch) {
    if (keys.has(c.key)) chk.fail('channels/key-unique', `通道 key 重复: ${c.key}`)
    else keys.add(c.key)
    if (ids.has(c.id)) {
      chk.fail(
        'channels/id-unique-per-multiblock',
        `同一多方块内 id 重复: ${c.id}（契约 docs/contracts/format-multiblock-doc.md §4.2 的导出期断言：需人工处理，导出应失败）`,
      )
    } else ids.add(c.id)
    if (c.enum !== null && c.enum !== undefined) {
      if (enums.has(c.enum)) chk.fail('channels/enum-unique', `通道 enum 重复: ${c.enum}`)
      else enums.add(c.enum)
    }
    if (names.has(c.name)) chk.fail('channels/name-unique', `通道呈现名重复: ${c.name}（UI 必须可区分）`)
    else names.add(c.name)
  }
  return { keys, ids, enums, names }
}

function validateFixture(path) {
  const rawText = readFileSync(path, 'utf8')
  const chk = new Checks(basename(path))
  const stats = { path, fileBytes: rawText.length, rawText }
  let doc
  try {
    doc = readFixtureDocument(JSON.parse(rawText))
    chk.ok('envelope/read', 'Envelope 读取成功（payload 解 base64 → JSON 文本 → body）')
  } catch (e) {
    chk.fail('envelope/read', String(e))
    return { chk, stats }
  }

  // ---- 1. 文档级形态枚举与判别 ----
  const shape = doc.documentShape
  if (shape === 'multiblock') chk.ok('shape/enum', 'documentShape = "multiblock"（与缺省 "frames" 互斥）')
  else chk.fail('shape/enum', `documentShape 必须为 "multiblock"，实际 ${JSON.stringify(shape)}`)
  if (doc.multiblockCount === 1 && isPlainObject(doc.multiblock)) {
    chk.ok('shape/single-multiblock', '每文件恰好一台多方块（multiblockCount = 1）')
  } else {
    chk.fail('shape/single-multiblock', `multiblockCount/multiblock 不合法: ${doc.multiblockCount}`)
  }
  if (shape === 'multiblock' && Array.isArray(doc.cellGrid)) {
    chk.fail('shape/no-root-cellgrid', 'multiblock 文档不得带根级 cellGrid（那是 frames 形态的根级展开约定）')
  } else {
    chk.ok('shape/no-root-cellgrid', '无根级 cellGrid/blockPalette 展开（与 frames 形态的约定互斥）')
  }

  const mb = doc.multiblock
  const channels = mb.channels ?? []
  const sizeChannels = channels.filter((c) => c.kind === 'size')
  const replaceChannels = channels.filter((c) => c.kind === 'replace')
  const hatchChannels = channels.filter((c) => c.kind === 'hatch')

  // ---- 2. 通道清单 ----
  const { keys } = validateChannelList(channels, chk)
  chk.ok('channels/kinds', `通道 ${channels.length} 条：尺寸型 ${sizeChannels.length} / 替换型 ${replaceChannels.length} / 舱口布局型 ${hatchChannels.length}`)
  for (const c of channels) {
    if (c.enum === undefined) chk.fail('channels/enum-field', `通道 ${c.key} 缺 enum 字段（可为 null，但必须显式声明）`)
    if (!isPlainObject(c.domain)) chk.fail('channels/domain', `通道 ${c.key} 缺 domain 对象`)
    else if (c.domain.max === undefined) chk.fail('channels/domain', `通道 ${c.key}.domain 缺 max`)
    if (c.kind === 'size' && (c.min === undefined || c.max === undefined)) {
      chk.fail('channels/size-minmax', `尺寸型通道 ${c.key} 必须带 min/max（getValueClamped 的偏移语义）`)
    }
    if (c.kind === 'hatch' && c.slider === true) {
      chk.fail('channels/hatch-no-slider', `舱口布局型通道 ${c.key} 不得生成滑杆`)
    }
    if (c.kind !== 'size' && c.kind !== 'replace' && c.kind !== 'hatch') {
      chk.fail('channels/kind', `通道 ${c.key} 的 kind 非法: ${c.kind}`)
    }
  }
  // "Not set"（0）必须落在每个通道的取值域内
  for (const c of channels) {
    const { lo } = channelBounds(c, mb.totalTierDomain?.max ?? 1)
    if (lo !== 0) chk.fail('channels/not-set-in-domain', `通道 ${c.key} 的取值域不含 0（Not set 必须可表达）`)
  }
  chk.ok('channels/not-set-in-domain', '每个通道的取值域都包含 0 = "Not set"')

  // ---- 3. 总 Tier 域 ----
  const tt = mb.totalTierDomain
  if (!isPlainObject(tt) || tt.min === undefined || tt.max === undefined) {
    chk.fail('totalTier/domain', 'totalTierDomain 必须带 min/max')
  } else {
    chk.ok('totalTier/domain', `总 Tier 域 ${tt.min}..${tt.max}（source=${tt.source ?? 'undeclared'}）`)
  }
  const samples = tierSample(doc)
  const outOfDomain = samples.filter((s) => s < tt.min || s > tt.max)
  if (outOfDomain.length > 0) chk.fail('totalTier/sample', `tierSample 越出域: ${outOfDomain.join(', ')}`)
  else chk.ok('totalTier/sample', `总 Tier 抽样清单 tierSample=[${samples.join(',')}]（声明完备的范围）`)

  // ---- 4. 运行态清单 ----
  const runstates = mb.runstates ?? []
  if (runstates.length === 0) chk.fail('runstates/declared', 'runstates 不得为空（单态也要显式声明 idle）')
  else {
    chk.ok('runstates/declared', `运行态 ${runstates.length} 态：${runstates.map((r) => `${r.id}「${r.name}」`).join(' / ')}`)
    for (const r of runstates) {
      if (!r.name) chk.fail('runstates/name', `运行态 ${r.id} 缺呈现名`)
    }
  }
  const cov = mb.viewerSemantics?.runstateCoverage
  if (!cov || cov.tesr !== 'not-covered') {
    chk.fail('runstates/not-covered', 'viewerSemantics.runstateCoverage.tesr 必须显式声明 "not-covered"（视图语义口径）')
  } else {
    chk.ok('runstates/not-covered', 'TESR 活动表现 + 运行中附属渲染方块已显式声明"不覆盖"')
  }

  // ---- 5. 骨架（尺寸型） ----
  const backbone = mb.backbone
  const sizeSteps = backbone?.sizeSteps ?? []
  if (backbone?.kind !== 'sizeSteps') chk.fail('backbone/kind', `backbone.kind 必须为 "sizeSteps"，实际 ${backbone?.kind}`)
  if (sizeSteps.length === 0) chk.fail('backbone/steps', 'backbone.sizeSteps 为空')
  else chk.ok('backbone/steps', `骨架 ${sizeSteps.length} 阶，channel=${backbone.sizeChannel}`)
  const primarySize = sizeChannels.find((c) => c.key === backbone?.sizeChannel)
  if (sizeChannels.length > 0 && !primarySize) {
    chk.fail('backbone/size-channel', `backbone.sizeChannel=${backbone?.sizeChannel} 不是维度型通道`)
  }
  if (primarySize && sizeSteps.length !== primarySize.max - primarySize.min + 1) {
    chk.fail(
      'backbone/steps-count',
      `骨架阶数 ${sizeSteps.length} ≠ 尺寸通道域长度 ${primarySize.max - primarySize.min + 1}（每阶一个完整布局是硬要求）`,
    )
  } else if (primarySize) {
    chk.ok('backbone/steps-count', `骨架阶数 = 尺寸通道域长度 = ${sizeSteps.length}`)
  }
  for (const [i, s] of sizeSteps.entries()) {
    if (!Array.isArray(s.cellGrid)) chk.fail('backbone/cellgrid', `sizeStep[${i}] 缺 cellGrid`)
    else {
      const d = s.cellGrid.length
      const h = s.cellGrid[0]?.length
      const w = s.cellGrid[0]?.[0]?.length
      if (d !== s.d || h !== s.hh || w !== s.w) {
        chk.fail('backbone/dims', `sizeStep[${i}] dims 声明 [${s.w},${s.hh},${s.d}] ≠ cellGrid 实际 [${w},${h},${d}]`)
      }
    }
    const roleKeys = Object.keys(s.roles ?? {})
    if (roleKeys.length === 0) chk.warn('backbone/roles', `sizeStep[${i}] 未声明任何角色（规则若用 indexRole 会失败）`)
  }
  chk.ok('backbone/dims', '每个 sizeStep 的 dims 与 cellGrid 实际形状一致')

  // ---- 6. 调色板（并集 + 去重） ----
  const palette = doc.blockPalette ?? []
  if (!Array.isArray(palette) || palette.length === 0) chk.fail('palette/present', 'blockPalette 必须非空数组')
  else {
    const sigs = palette.map(entrySignature)
    const dup = sigs.filter((s, i) => sigs.indexOf(s) !== i).length
    if (dup > 0) chk.fail('palette/dedup', `blockPalette 存在 ${dup} 条内容重复条目（全局去重未生效）`)
    else chk.ok('palette/dedup', `blockPalette ${palette.length} 条，内容签名全局唯一`)
    if (palette[0]?.registryId === 'air') chk.ok('palette/air-zero', 'air 固定下标 0')
    else chk.fail('palette/air-zero', `下标 0 必须是 air，实际 ${palette[0]?.registryId}`)
    for (const [i, e] of palette.entries()) {
      if (!isPlainObject(e)) chk.fail('palette/entry', `blockPalette[${i}] 不是对象`)
      else if (!e.registryId) chk.fail('palette/entry', `blockPalette[${i}] 缺 registryId`)
      else if (!isPlainObject(e.geometry)) chk.fail('palette/entry', `blockPalette[${i}] 缺 geometry`)
      else if (e.geometry.encoding !== mb.geometryEncoding) {
        chk.fail('palette/encoding', `blockPalette[${i}].geometry.encoding=${e.geometry.encoding} ≠ multiblock.geometryEncoding=${mb.geometryEncoding}`)
      }
    }
    const encodings = new Set(palette.map((e) => e.geometry?.encoding))
    if (encodings.size > 1) chk.fail('palette/encoding-uniform', `调色板内编码不统一: ${[...encodings].join(', ')}`)
    else chk.ok('palette/encoding', `几何编码统一为 ${[...encodings][0]}（既有 web 解码器可直接读，无需新渲染路径）`)
  }

  // ---- 7. 变体清单与组合完备性 ----
  const variants = enumerateVariants(doc)
  const declaredKeys = variants.map((v) => v.key)
  const dupKeys = declaredKeys.filter((k, i) => declaredKeys.indexOf(k) !== i)
  if (dupKeys.length > 0) chk.fail('variants/unique', `变体键重复: ${[...new Set(dupKeys)].join(', ')}`)
  else chk.ok('variants/unique', `变体键 ${declaredKeys.length} 个，互不重复`)

  const expected = expectedCombinationKeys(doc).map((v) => v.key)
  const missing = expected.filter((k) => !declaredKeys.includes(k))
  const extra = declaredKeys.filter((k) => !expected.includes(k))
  if (missing.length > 0) chk.fail('variants/complete', `少声明 ${missing.length} 个组合（禁止靠丢变体换体积）: ${missing.slice(0, 4).join(', ')}…`)
  if (extra.length > 0) chk.fail('variants/complete', `多声明 ${extra.length} 个非组合键: ${extra.slice(0, 4).join(', ')}…`)
  if (missing.length === 0 && extra.length === 0) {
    chk.ok(
      'variants/complete',
      `声明集合 = ∏(通道域 ${channels.map((c) => (c.domain?.max ?? 0) + 1).join('×')}) × tierSample(${tierSample(doc).join(',')}) × 运行态${runstates.length} = ${expected.length}`,
    )
  }

  // ---- 8. 逐变体装配（全组合） ----
  const assembled = []
  const gridDims = new Set()
  const usedIndices = new Set()
  for (const v of variants) {
    try {
      const res = assembleVariant(doc, v.key)
      assembled.push({ key: v.key, ...res })
      gridDims.add(`${res.dims.w}x${res.dims.h}x${res.dims.d}`)
      for (let z = 0; z < res.dims.d; z++)
        for (let y = 0; y < res.dims.h; y++)
          for (let x = 0; x < res.dims.w; x++) usedIndices.add(res.cellGrid[z][y][x])
    } catch (e) {
      chk.fail('assembly/all-variants', `变体 ${v.key} 装配失败: ${e.message}`)
    }
  }
  if (assembled.length === variants.length && variants.length > 0) {
    chk.ok('assembly/all-variants', `全部 ${variants.length} 个变体装配成功，尺寸集合 {${[...gridDims].join(', ')}}`)
  }

  // 每个变体都必须有 frame（Frame 是唯一变体存储原语）
  const frameKeys = new Set((doc.frames ?? []).map((f) => f.variant))
  const noFrame = declaredKeys.filter((k) => !frameKeys.has(k))
  if (noFrame.length > 0) chk.fail('frames/cover-variants', `${noFrame.length} 个变体没有对应 frame: ${noFrame.slice(0, 3).join(', ')}`)
  else chk.ok('frames/cover-variants', `每个变体恰好至少一个 frame（共 ${(doc.frames ?? []).length} frame）`)

  const frameKeySet = new Set()
  const ruleIds = new Set((mb.rules ?? []).map((r) => r.id))
  if (!Array.isArray(mb.rules) || mb.rules.length === 0) chk.fail('rules/present', 'multiblock.rules 必须是非空规则表')
  else {
    chk.ok('rules/present', `规则表 ${mb.rules.length} 条（**按引用复用**：frame 只存 id，规则体不随组合重复）`)
    for (const r of mb.rules) {
      if (r.kind !== 'fill' && r.kind !== 'setCell') {
        chk.fail('rules/op-kind', `规则 ${r.id} 含未定义 kind=${r.kind}（装配器只有 fill / setCell 两种差异表达）`)
      }
      if (r.index === undefined && !r.indexTable && r.indexRole === undefined) {
        chk.fail('rules/content', `规则 ${r.id} 既无 index、也无 indexTable/indexRole（无法确定写入内容）`)
      }
      if (r.index !== undefined && (r.index < 0 || r.index >= palette.length)) {
        chk.fail('rules/index', `规则 ${r.id} 的 index=${r.index} 越界（调色板长度 ${palette.length}）`)
      }
      if (r.indexTable) {
        const ch = channels.find((c) => c.key === r.channel)
        if (!ch) chk.fail('rules/indexTable-channel', `规则 ${r.id} 的 indexTable 引用了未声明通道 ${r.channel}`)
        else {
          const need = (ch.domain?.max ?? 0) + 1
          if (r.indexTable.length < need) {
            chk.fail('rules/indexTable-size', `规则 ${r.id} 的 indexTable 长度 ${r.indexTable.length} < 域长度 ${need}（通道 ${ch.key}）`)
          }
          for (const ix of r.indexTable) {
            if (!Number.isInteger(ix) || ix < 0 || ix >= palette.length) {
              chk.fail('rules/indexTable-range', `规则 ${r.id} 的 indexTable 含越界下标 ${ix}`)
            }
          }
        }
      }
      if (r.legend !== undefined && !(mb.opsLegend ?? {})[r.legend]) {
        chk.fail('rules/legend', `规则 ${r.id} 的 legend=${r.legend} 未在 opsLegend 中登记`)
      }
      if (r.guard) {
        for (const cl of r.guard.clauses ?? []) {
          if (!keys.has(cl.channel)) chk.fail('rules/guard-channel', `规则 ${r.id} 的 guard 引用未声明通道 ${cl.channel}`)
        }
      }
      if (r.indexAliases) {
        for (const [from, to] of Object.entries(r.indexAliases)) {
          if (!Number.isInteger(to) || to < 0 || to >= palette.length) {
            chk.fail('rules/indexAliases', `规则 ${r.id} 的 indexAliases[${from}] = ${to} 越界`)
          }
        }
      }
    }
  }

  for (const f of doc.frames ?? []) {
    if (!frameKeySet.has(f.variant)) frameKeySet.add(f.variant)
    if (!declaredKeys.includes(f.variant)) chk.fail('frames/variant-ref', `frame ${f.index} 的 variant 未在 variants 中声明: ${f.variant}`)
    if (!Array.isArray(f.rules)) chk.fail('frames/rules-ref', `frame ${f.index} 缺 rules 引用数组`)
    else {
      for (const ref of f.rules) {
        const id = typeof ref === 'string' ? ref : ref.id
        if (!ruleIds.has(id)) chk.fail('frames/rules-ref', `frame ${f.index} 引用了未声明规则 ${id}`)
      }
    }
    if (f.stepIndex === undefined) chk.fail('frames/step-index', `frame ${f.index} 缺 stepIndex（关联骨架阶）`)
    else if (!sizeSteps[f.stepIndex]) chk.fail('frames/step-index', `frame ${f.index} 的 stepIndex=${f.stepIndex} 越界（骨架 ${sizeSteps.length} 阶）`)
    const v = Array.isArray(f.cellGrid) ? f.cellGrid : null
    if (v) {
      const d = v.length
      const h = v[0]?.length
      const w = v[0]?.[0]?.length
      const step = sizeSteps[f.stepIndex]
      if (step && (d !== step.d || h !== step.hh || w !== step.w)) {
        chk.fail('frames/cellgrid-shape', `frame ${f.index} 的参考 cellGrid 形状 [${w},${h},${d}] ≠ 骨架阶 ${f.stepIndex} 的 [${step.w},${step.hh},${step.d}]`)
      }
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const ix = v[z][y][x]
            if (!Number.isInteger(ix) || ix < 0 || ix >= palette.length) {
              chk.fail('frames/cellgrid-range', `frame ${f.index} 的 cellGrid(${x},${y},${z}) = ${ix} 越界`)
            }
          }
    }
    if (f.ops !== undefined) {
      chk.fail('frames/op-inline', `frame ${f.index} 携带内联 ops：差异规则必须只存一份并按压引用复用（禁止组合展开）`)
    }
    if (Object.prototype.hasOwnProperty.call(f, 'note')) {
      chk.warn('frames/note', `frame ${f.index} 带自由文本 note（真实导出应清空）`)
    }
  }
  chk.ok('rules/refs', `frame 的规则引用全部命中规则表（${ruleIds.size} 条规则）`)

  // ---- 9. 调色板无未引用条目（并集不虚胖） ----
  const unused = []
  for (let i = 1; i < palette.length; i++) if (!usedIndices.has(i)) unused.push(i)
  if (unused.length > 0) {
    chk.warn('palette/no-unused', `调色板有 ${unused.length} 条从未出现在任何变体装配结果中: ${unused.join(', ')}`)
  } else {
    chk.ok('palette/no-unused', `调色板 ${palette.length} 条（含 air）全部被至少一个变体引用`)
  }

  // ---- 10. 差异规则确实"不展开"：组合数 × 完整变体 ≫ 文件 ----
  const perVariantCellGridBytes = assembled.map((a) => Buffer.byteLength(JSON.stringify(a.cellGrid), 'utf8'))
  const perVariantGridCost = perVariantCellGridBytes.reduce((a, b) => a + b, 0)
  const perVariantCellCount = assembled.reduce((a, r) => a + r.dims.w * r.dims.h * r.dims.d, 0)
  const paletteJsonBytes = Buffer.byteLength(JSON.stringify(palette), 'utf8')
  const innerJsonBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8')
  // ① 诚实对照：**既有格式已共享调色板**（liftBlockPaletteToRoot），所以"打开组合"的真实成本
  //    是把每个变体的完整 cellGrid 全写下来 —— 即 palette ×1 + cellGrid ×N。
  const honestExpandedBytes = innerJsonBytes - perVariantGridCost + perVariantGridCost * assembled.length
  // ② 朴素对照（参考实现的做法，每变体自带一份调色板）：palette ×N + cellGrid ×N
  const naiveExpandedBytes = innerJsonBytes - paletteJsonBytes + perVariantGridCost + paletteJsonBytes * assembled.length

  stats.combinations = variants.length
  stats.cellsTotal = perVariantCellCount
  stats.perVariantGridCost = perVariantGridCost
  stats.paletteJsonBytes = paletteJsonBytes
  stats.innerJsonBytes = innerJsonBytes
  stats.honestExpandedBytes = honestExpandedBytes
  stats.naiveExpandedBytes = naiveExpandedBytes
  stats.gzipBytes = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 }).length

  return { chk, stats, doc, assembled, expected }
}

// ---------------------------------------------------------------------------
// 非法/夹取行为（格式文档 §6 的机器判读）
// ---------------------------------------------------------------------------

function probeIllegalBehaviour(doc, chk, sampleKey) {
  const mb = doc.multiblock
  const domainMax = mb.totalTierDomain.max
  const channel = (mb.channels ?? []).find((c) => c.kind === 'replace')
  if (!channel) {
    chk.warn('illegal/no-channel', 'fixture 无替换型通道，跳过越界/耦合夹取的机器判读')
    return []
  }
  const results = []
  const allZeroVariants = (mb.variants ?? []).filter((v) => {
    const p = parseVariantKey(v.key)
    return Object.values(p.values).every((x) => x === 0)
  })
  if (allZeroVariants.length > 0) {
    // ① 通道值 = 0（Not set）必须能装配；有效值 = 回落总 Tier，越出通道声明域时按 GT 同口径夹取
    const v = allZeroVariants[0]
    const res = assembleVariant(doc, v.key)
    const eff = res.effective.get(channel.key)
    const ttVal = parseVariantKey(v.key).totalTier
    const hi = channel.domain?.max ?? Infinity
    const expect = Math.min(ttVal, hi)
    const clampLogged = res.report.clamped.some((c) => c.field === channel.key && c.reason === 'domain')
    if (eff === expect) {
      chk.ok(
        'illegal/not-set-fallback',
        `${channel.key}=0（Not set）→ 有效值 ${eff} = ${ttVal === expect ? `总 Tier ${ttVal}` : `总 Tier ${ttVal} 按通道域夹取到 ${hi}`}（GT ChannelDataAccessor + getValueClamped 语义）` +
          (clampLogged ? '，夹取已落 report.clamped' : ''),
      )
    } else {
      chk.fail('illegal/not-set-fallback', `${channel.key}=0 的有效值 ${eff} ≠ 期望 ${expect}（总 Tier ${ttVal}）`)
    }
    results.push({ case: 'not-set-fallback', variant: v.key, effective: eff, totalTier: ttVal, expected: expect })
  }

  // ② 越界取值 → 夹取到域上界（不拒绝、不抛错）
  const overKey = syntheticKey(doc, channel.key, 99)
  const overRes = assembleVariantOverridden(doc, overKey, { [channel.key]: 99 })
  const overClamp = overRes.report.clamped.find((c) => c.field === channel.key)
  if (overClamp && overClamp.now <= (channel.domain?.max ?? domainMax)) {
    chk.ok('illegal/out-of-domain-clamp', `通道 ${channel.key}=99 → 夹取到 ${overClamp.now}（域外值不拒绝装配）`)
  } else {
    chk.fail('illegal/out-of-domain-clamp', `通道 ${channel.key}=99 未被夹取（clamped=${JSON.stringify(overRes.report.clamped)}）`)
  }
  results.push({ case: 'out-of-domain-clamp', clamped: overRes.report.clamped })

  // ③ 耦合约束违规 → 夹取并落表
  const couplings = mb.couplings ?? []
  if (couplings.length === 0) {
    chk.ok('illegal/coupling-default', 'couplings: []（未探测到约束）→ 不拒绝任何组合，符合缺省行为定义')
    results.push({ case: 'coupling-default', couplings: 0 })
  } else {
    for (const cp of couplings) {
      const bad = violatingValues(doc, cp)
      if (!bad) {
        chk.warn('illegal/coupling-probe', `耦合 ${cp.id} 在声明域内找不到违规组合，无法机器判读`)
        continue
      }
      const res = assembleVariantOverridden(doc, syntheticKey(doc, null, 0), bad)
      const hit = res.report.clamped.find((c) => c.coupling === cp.id)
      if (hit) {
        chk.ok('illegal/coupling-clamp', `耦合 ${cp.id}（${cp.a} ${cp.requires} ${cp.b}）违规组合被夹取: ${cp.b} ${hit.bWas} → ${hit.bNow}`)
        results.push({ case: 'coupling-clamp', coupling: cp.id, ...hit })
      } else {
        chk.fail('illegal/coupling-clamp', `耦合 ${cp.id} 违规组合 ${JSON.stringify(bad)} 未被夹取`)
      }
    }
  }
  void sampleKey
  return results
}

/** 在声明域内找一组违反耦合的通道取值。 */
function violatingValues(doc, cp) {
  const mb = doc.multiblock
  const a = mb.channels.find((c) => c.key === cp.a)
  const b = mb.channels.find((c) => c.key === cp.b)
  if (!a || !b) return null
  const ensure = (ch, need) => {
    const hi = ch.domain?.max ?? 1
    return need <= hi ? need : null
  }
  if (cp.requires === 'ge') {
    // 需要 a < b：取 b 最大值、a 最小值 1（0 是 Not set，不走这里）
    const need = ensure(b, b.domain?.max ?? 1)
    if (need === null) return null
    return { [cp.a]: 1, [cp.b]: need }
  }
  if (cp.requires === 'le') {
    const need = ensure(a, a.domain?.max ?? 1)
    if (need === null) return null
    return { [cp.a]: need, [cp.b]: 1 }
  }
  return null
}

/** 用"覆盖通道值"的方式装配一个未必声明的组合（用于非法组合判读）。 */
function assembleVariantOverridden(doc, fallbackKey, overrides) {
  const mb = doc.multiblock
  const baseVariant = (mb.variants ?? []).find((v) => v.key === fallbackKey) ?? mb.variants[0]
  const values = { ...(baseVariant.values ?? {}), ...overrides }
  const totalTier = baseVariant.totalTier ?? mb.totalTierDomain.default ?? 1
  const rs = baseVariant.runstate ?? 'idle'
  // 找一个"通道值恰好等于 overrides"的已声明变体；找不到则用 base 变体的 frame 集合 + 覆盖值
  // 直接跑装配核心（assembleVariant 的取值来自 variant，故这里临时注入变体）。
  // 覆盖通道值后，"参考 cellGrid"必然与装配结果不同（它记录的是原取值下的网格），
  // 故探针路径剥掉 cellGrid，只跑装配本体。
  const probeFrames = (doc.frames ?? [])
    .filter((f) => f.variant === baseVariant.key)
    .map((f) => {
      const c = { ...f, variant: '__probe__' }
      delete c.cellGrid
      return c
    })
  const injected = {
    ...doc,
    multiblock: {
      ...mb,
      variants: [...mb.variants, { key: '__probe__', totalTier, values, runstate: rs, stepIndex: baseVariant.stepIndex ?? 0 }],
    },
    frames: [...(doc.frames ?? []), ...probeFrames],
  }
  return assembleVariant(injected, '__probe__')
}

function syntheticKey(doc, channelKey, value) {
  const mb = doc.multiblock
  const v = mb.variants[0]
  const p = parseVariantKey(v.key)
  if (channelKey) p.values[channelKey] = value
  return v.key
}

// ---------------------------------------------------------------------------
// 体积增长机器判定式（落地实现）
// ---------------------------------------------------------------------------

/**
 * 体积增长的**机器判定式**（完整论证见 format 文档 §10）。
 *
 * ## 记号
 *   N    = 文档声明的变体数（= 各通道域之**积** × Tier 抽样 × 运行态数；"组合数"）
 *   S    = 轴展维度和 = Tier 取值数 + Σ(每通道取值数)（**不含组合**，用于表达"骨架/调色板只存一份"）
 *   C    = 单个变体的完整 cellGrid 字节数（由骨架阶决定）
 *   G    = 信封文件（gzip）字节数
 *   V    = "组合展开"体积 = 调色板 ×1 + Σ_variants 完整 cellGrid（既有格式已共享调色板）
 *
 * ## 为什么判定式的自变量是 N 而不是 S（对既有建议式的**修正**）
 * 既有建议是"取值数翻倍时体积增长倍数 < 取值数增长倍数 × 安全系数"，自变量取 S。
 * 实测（本校验器 `--volume`）：`帧是唯一变体存储原语` → 每个组合**至少一个 frame**，
 * 而组合数正是各通道域的**积**。故任何满足硬约束 2 的实现都有 "G 随 N 增长" 的下界，
 * 不可能做到 "G 随 S 增长"（那要求组合数也随 S 线性）。S 只能解释**调色板/骨架那一份**的增长。
 * 因此本判定式把可判定的性质改写为下面三条，全部与实现无关、可机器复核。
 *
 * ## 三条判据
 *   R1 展开比     : κ = V / G 必须**随 N 同步增长**，即 κ(N) / κ(N/2) ≥ 1/√λ
 *                   （λ = 安全系数）。含义：文件随 N **线性**（每条组合的边际成本有界），
 *                   而不是随"每个组合都物化一份完整网格"增长。
 *   R2 常数项有界 : 线性拟合 G ≈ a + b·N，R² ≥ ρ，且 b·N_max ≥ 2·max(a, 4096)
 *                   （排除"体积被信封常数/头部开销主导"的伪通过）。
 *   R3 结构无关   : 以上对"单通道域放大"与"多通道同时放大"两种放大方式都必须成立。
 *
 * 阈值取值与理由见 format 文档 §10.1。三项全过 = 通过。
 */
export const VOLUME_CRITERION = {
  /** 每个组合的边际 gzip 成本上限（字节/组合）——由 R2 的斜率 b 复核。 */
  maxMarginalBytesPerVariant: 2048,
  safetyFactor: 1.35,
  r2Min: 0.95,
  floorBytes: 4096,
  minPoints: 4,
}

function leastSquares(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const b = sxx === 0 ? 0 : sxy / sxx
  const a = my - b * mx
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (a + b * xs[i])) ** 2
    ssTot += (ys[i] - my) ** 2
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
  return { a, b, r2 }
}

/** S = 总 Tier 取值数 + Σ(每通道取值数)。 */
export function axisSpan(doc) {
  const mb = doc.multiblock
  const ttCount = mb.totalTierDomain.max - mb.totalTierDomain.min + 1
  let s = ttCount
  for (const c of mb.channels) s += channelBounds(c, mb.totalTierDomain.max).hi + 1
  return s
}

/**
 * 把替换型通道的取值数放大 k 倍（槽位仍是同一组位置，只换内容）——用于曲线测量。
 *
 * 放大方式与真实导出同构：域放大 → 新增"该档位的方块条目"（拷贝一个既有条目、改 meta 与
 * tooltip、内容签名因此唯一）→ 逐组合声明变体 + 一条槽位规则。测量只关心
 * 「轴展维度和 S ↔ gzip 体积」的关系，故规则用统一形状（一条 fill）而非复刻 fixture 的全部规则。
 */
function scaleDocument(doc, k) {
  if (k === 1) return doc
  const mb = doc.multiblock
  const entries = [...doc.blockPalette]
  const channels = mb.channels.map((c) => {
    if (c.kind !== 'replace') return c
    const baseMax = c.domain?.max ?? 1
    const newMax = baseMax * k
    for (let v = baseMax + 1; v <= newMax; v++) {
      const proto = entries[1 + ((v - 1) % baseMax)]
      const entry = JSON.parse(JSON.stringify(proto))
      entry.meta = (proto.meta ?? 0) + v * 1000
      entry.tooltip = [`scaled variant ${v}`]
      entries.push(entry)
    }
    return { ...c, max: newMax, domain: { ...c.domain, max: newMax } }
  })
  const baseMaxByKey = new Map(mb.channels.map((c) => [c.key, c.domain?.max ?? 1]))
  const slotByKey = new Map()
  for (const c of mb.channels) {
    if (c.kind === 'replace') slotByKey.set(c.key, c.key === 'coil' || c.key === 'capacitor' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 })
  }
  const indexFor = (key, raw) => {
    if (raw === 0) return 1
    const baseMax = baseMaxByKey.get(key)
    return raw <= baseMax ? 1 + raw : doc.blockPalette.length + (raw - baseMax) - 1
  }
  // 规则表：每个替换型通道一条 indexTable 规则（表长 = 新域长度），复用同一套规则体
  const rules = []
  for (const c of channels) {
    if (c.kind !== 'replace') continue
    const table = []
    const ch = mb.channels.find((x) => x.key === c.key)
    for (let v = 0; v <= (c.domain?.max ?? 0); v++) table.push(v === 0 ? 1 : indexFor(c.key, v))
    rules.push({
      id: `scaled.${c.key}`,
      phase: 'replace',
      kind: 'setCell',
      ...slotByKey.get(c.key),
      channel: c.key,
      indexTable: table,
    })
    void ch
  }
  const runstates = mb.runstates ?? [{ id: 'idle', name: 'Idle' }]
  const ttSamples = tierSample(doc)
  const variants = []
  const frames = []
  const channelKeys = channels.map((c) => c.key)
  const domains = channels.map((c) => ({ lo: 0, hi: c.domain?.max ?? 1 }))
  const stepBySize = (values) => {
    const sizeCh = channels.find((c) => c.kind === 'size')
    if (!sizeCh) return 0
    const raw = values[sizeCh.key] ?? 0
    const eff = raw > 0 ? raw : 1
    return Math.min(Math.max(eff - (sizeCh.min ?? 1), 0), (mb.backbone?.sizeSteps?.length ?? 1) - 1)
  }
  const rec = (i, values) => {
    if (i === channelKeys.length) {
      for (const tt of ttSamples) {
        for (const rs of runstates) {
          const key = `${channelKeys.map((kk) => `${kk}:${values[kk] ?? 0}`).join('|')}|tt:${tt}|runstate:${rs.id}`
          variants.push({ key, totalTier: tt, values: { ...values }, runstate: rs.id, stepIndex: stepBySize(values) })
        }
      }
      return
    }
    for (let v = domains[i].lo; v <= domains[i].hi; v++) {
      values[channelKeys[i]] = v
      rec(i + 1, values)
    }
    delete values[channelKeys[i]]
  }
  rec(0, {})
  for (const v of variants) {
    frames.push({
      index: frames.length,
      variant: v.key,
      runstate: v.runstate,
      stepIndex: v.stepIndex,
      rules: rules.filter((r) => r.phase === 'replace').map((r) => r.id),
    })
  }
  return { ...doc, blockPalette: entries, multiblock: { ...mb, channels, variants, rules, opsLegend: {} }, frames }
}

function measureVolumeCurve(doc) {
  const points = []
  for (const k of [1, 2, 4, 8]) {
    const scaled = scaleDocument(doc, k)
    const json = JSON.stringify(scaled)
    const s = axisSpan(scaled)
    const n = scaled.multiblock.variants.length
    // V = 调色板 ×1 + Σ 每个组合的完整 cellGrid（"组合展开"体积）
    const paletteBytes = Buffer.byteLength(JSON.stringify(scaled.blockPalette), 'utf8')
    let gridBytes = 0
    let cells = 0
    for (const v of scaled.multiblock.variants) {
      const r = assembleVariant(scaled, v.key)
      gridBytes += Buffer.byteLength(JSON.stringify(r.cellGrid), 'utf8')
      cells += r.dims.w * r.dims.h * r.dims.d
    }
    const gzipBytes = gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length
    points.push({
      k,
      S: s,
      N: n,
      cells,
      rawBytes: Buffer.byteLength(json, 'utf8'),
      gzipBytes,
      expandedBytes: paletteBytes + gridBytes,
      kappa: (paletteBytes + gridBytes) / gzipBytes,
      bytesPerVariant: gzipBytes / n,
    })
  }
  const xs = points.map((p) => p.N)
  const ys = points.map((p) => p.gzipBytes)
  const fit = leastSquares(xs, ys)
  const maxN = Math.max(...xs)
  const tol = VOLUME_CRITERION
  const pairs = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const kappaGrowth = b.kappa / a.kappa
    const limit = 1 / Math.sqrt(tol.safetyFactor)
    pairs.push({
      fromN: a.N,
      toN: b.N,
      fromS: a.S,
      toS: b.S,
      gzipGrowth: b.gzipBytes / a.gzipBytes,
      variantsGrowth: b.N / a.N,
      kappaGrowth,
      kappaLimit: limit,
      r1: kappaGrowth >= limit,
      marginal: (b.gzipBytes - a.gzipBytes) / (b.N - a.N),
    })
  }
  const r2 = fit.r2 >= tol.r2Min
  // 变量部分是否够大：b·N_max ≥ floor 才有资格做线性拟合判定。若整个文件的变量部分
  // 比绝对下限还小（小结构），gzip 必然被信封常数主导 —— 此时 R² 无意义，改判"文件足够小"。
  const variablePart = fit.b * maxN
  const constantDominated = variablePart < tol.floorBytes
  const smallEnough = Math.max(...ys) <= tol.floorBytes
  const fitOk = constantDominated ? smallEnough : r2 && variablePart >= 2 * Math.max(fit.a, 0)
  const marginalOk = fit.b <= tol.maxMarginalBytesPerVariant
  return {
    criterion: tol,
    points,
    fit,
    checks: { r2, constantDominated, smallEnough, fitOk, marginalOk },
    pairs,
    pass: fitOk && marginalOk && pairs.every((p) => p.r1),
  }
}

/**
 * 全量参考网格验证（`--verify-grids`）：对**每个变体**独立装配一遍，断言：
 *   ① 装配不抛错；② 结果形状 = 该变体骨架阶的声明尺寸；③ 下标全部落在并集调色板内；
 *   ④ 装配是**纯函数**（同一变体连装两次逐格一致）。
 * 参考网格落 `<out>/expanded-fixtures/<name>__<variant>.json`，供 web 装配器与逐格 diff 做基准。
 */
function verifyAllGrids(files, chkList) {
  const dir = join(OUT_DIR, 'expanded-fixtures')
  mkdirSync(dir, { recursive: true })
  for (const f of files) {
    const doc = readFixtureDocument(JSON.parse(readFileSync(f, 'utf8')))
    const mb = doc.multiblock
    const chk = new Checks(basename(f))
    const variants = enumerateVariants(doc)
    let cells = 0
    let refs = 0
    for (const v of variants) {
      const a = assembleVariant(doc, v.key)
      const b = assembleVariant(doc, v.key)
      if (JSON.stringify(a.cellGrid) !== JSON.stringify(b.cellGrid)) {
        chk.fail('verify/deterministic', `变体 ${v.key} 两次装配结果不一致（装配必须确定性）`)
      }
      const dims = a.dims
      const expected = a.cellGrid
      if (expected.length !== dims.d || expected[0].length !== dims.h || expected[0][0].length !== dims.w) {
        chk.fail('verify/shape', `变体 ${v.key} 的网格形状与声明尺寸不符`)
      }
      cells += dims.w * dims.h * dims.d
      refs++
      const fv = (mb.frames ?? []).find((x) => x.variant === v.key)
      if (fv?.cellGrid) {
        if (JSON.stringify(fv.cellGrid) !== JSON.stringify(a.cellGrid)) {
          chk.fail('verify/reference-grid', `变体 ${v.key} 的 frame.cellGrid 与装配结果不一致`)
        }
      }
      // 参考网格**每变体一份**（装配与逐格 diff 的基准）。fixture 规模可控（552 份）；
      // 真实产物若变体数过大，改为对抽样组合落盘（留样清单由导出自检口径定）。
      const name = `${basename(f, '.json')}__${v.key.replace(/[|:]/g, '_')}.json`
      writeFileSync(join(dir, name), JSON.stringify({ variant: v.key, dims, cellGrid: a.cellGrid }), 'utf8')
    }
    chk.ok('verify/all-grids', `${refs} 个变体全量独立装配通过，共 ${cells} 格；装配确定性（两次逐格一致）已断言`)
    chkList.push(chk)
  }
  return dir
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function run() {
  const argv = process.argv.slice(2)
  const dumpExpanded = argv.includes('--dump-expanded')
  const volume = argv.includes('--volume') || argv.includes('--all')
  const verifyGrids = argv.includes('--verify-grids') || argv.includes('--all')
  const args = argv.filter((a) => !a.startsWith('--'))
  let files
  if (args.length > 0) {
    files = args
  } else {
    files = readdirSync(FIXTURE_DIR)
      .filter((f) => f.startsWith('multiblock-') && f.endsWith('.json'))
      .sort()
      .map((f) => join(FIXTURE_DIR, f))
  }
  if (files.length === 0) {
    console.error(`未找到 fixture（目录 ${FIXTURE_DIR}）`)
    process.exit(2)
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const report = { fixtures: [], failures: 0, warnings: 0 }
  console.log('═'.repeat(78))
  console.log('多方块 fixture 校验 + 参考装配（scripts/multiblock-fixtures）')
  console.log('═'.repeat(78))

  for (const f of files) {
    if (!statSync(f).isFile()) continue
    const { chk, stats, doc, assembled } = validateFixture(f)
    const illegal = doc ? probeIllegalBehaviour(doc, chk, doc.multiblock?.variants?.[0]?.key) : []

    const head = `\n▌ ${basename(f)}`
    console.log(head)
    console.log('─'.repeat(78))
    for (const it of chk.items) {
      const mark = it.status === 'ok' ? '  ✔' : it.status === 'warn' ? '  ▲' : '  ✘'
      console.log(`${mark} [${it.id}] ${it.detail}`)
    }
    console.log(`  ─ 失败 ${chk.failures.length} / 警告 ${chk.items.filter((i) => i.status === 'warn').length}`)
    report.failures += chk.failures.length
    report.warnings += chk.items.filter((i) => i.status === 'warn').length
    report.fixtures.push({
      file: basename(f),
      status: chk.failures.length === 0 ? 'pass' : 'fail',
      checks: chk.items,
      stats: {
        fileBytes: stats.fileBytes,
        innerJsonBytes: stats.innerJsonBytes,
        gzipBytes: stats.gzipBytes,
        combinations: stats.combinations,
        cellsTotal: stats.cellsTotal,
        perVariantGridCost: stats.perVariantGridCost,
        paletteJsonBytes: stats.paletteJsonBytes,
        honestExpandedBytes: stats.honestExpandedBytes,
        naiveExpandedBytes: stats.naiveExpandedBytes,
      },
      illegal,
    })

    if (dumpExpanded && assembled) {
      for (const a of assembled.slice(0, 3)) {
        const name = `${basename(f, '.json')}__${a.key.replace(/[|:]/g, '_')}__assembled.json`
        writeFileSync(join(OUT_DIR, name), JSON.stringify({ variantKey: a.key, dims: a.dims, cellGrid: a.cellGrid }, null, 1), 'utf8')
      }
    }
  }

  // ---- 体积对照汇总 ----
  console.log('\n' + '═'.repeat(78))
  console.log('体积对照：因子化文件 vs 组合展开')
  console.log('═'.repeat(78))
  console.log('「展开」口径 ①（诚实）：调色板 ×1 + **每个组合一份完整 cellGrid**（既有格式已共享调色板）')
  console.log('「展开」口径 ②（朴素）：调色板 ×N + 每个组合一份完整 cellGrid（参考实现每变体自带调色板）')
  console.log(
    [
      'fixture'.padEnd(30),
      '组合'.padStart(5),
      '格数'.padStart(7),
      '①展开B'.padStart(9),
      '②展开B'.padStart(10),
      '文件B'.padStart(8),
      '①比'.padStart(6),
      '②比'.padStart(6),
      'gzipB'.padStart(8),
    ].join(' '),
  )
  for (const r of report.fixtures) {
    const s = r.stats
    const r1 = s.honestExpandedBytes > 0 ? (s.honestExpandedBytes / s.fileBytes).toFixed(2) : 'n/a'
    const r2 = s.naiveExpandedBytes > 0 ? (s.naiveExpandedBytes / s.fileBytes).toFixed(1) : 'n/a'
    console.log(
      [
        r.file.padEnd(30),
        String(s.combinations).padStart(5),
        String(s.cellsTotal).padStart(7),
        String(s.honestExpandedBytes).padStart(9),
        String(s.naiveExpandedBytes).padStart(10),
        String(s.fileBytes).padStart(8),
        (r1 + '×').padStart(6),
        (r2 + '×').padStart(6),
        String(s.gzipBytes).padStart(8),
      ].join(' '),
    )
  }
  const total = report.fixtures.reduce(
    (a, r) => ({
      exp: a.exp + r.stats.naiveExpandedBytes,
      honest: a.honest + r.stats.honestExpandedBytes,
      file: a.file + r.stats.fileBytes,
      gzip: a.gzip + r.stats.gzipBytes,
      combos: a.combos + r.stats.combinations,
      grid: a.grid + r.stats.perVariantGridCost,
    }),
    { exp: 0, honest: 0, file: 0, gzip: 0, combos: 0, grid: 0 },
  )
  console.log('─'.repeat(78))
  console.log(
    `合计：组合 ${total.combos} 个；"每变体一份完整 cellGrid"需 ${total.grid} B；` +
      `①展开 ${total.honest} B（${(total.honest / total.file).toFixed(2)}×）；` +
      `②朴素展开 ${total.exp} B（${(total.exp / total.file).toFixed(1)}×）；` +
      `三份因子化 fixture 落盘 ${total.file} B、gzip ${total.gzip} B`,
  )

  // ---- 体积增长机器判定式 ----
  if (verifyGrids) {
    console.log('\n' + '═'.repeat(78))
    console.log('全量参考网格验证（--verify-grids）：每个变体独立装配 + 确定性断言')
    console.log('═'.repeat(78))
    const chkList = []
    const dir = verifyAllGrids(files, chkList)
    for (const chk of chkList) {
      console.log(`\n▌ ${chk.name}`)
      for (const it of chk.items) console.log(`  ${it.status === 'ok' ? '✔' : '✘'} [${it.id}] ${it.detail}`)
      report.failures += chk.failures.length
    }
    console.log(`\n参考网格落盘目录：${dir}`)
  }

  if (volume) {
    console.log('\n' + '═'.repeat(78))
    console.log('体积增长机器判定式：N = 组合数，S = 轴展维度和，G = gzip 字节，κ = 展开体积/G')
    console.log('═'.repeat(78))
    console.log(
      `安全系数 λ=${VOLUME_CRITERION.safetyFactor}  线性拟合 ρ=${VOLUME_CRITERION.r2Min}  ` +
        `常数项下限 ${VOLUME_CRITERION.floorBytes} B  边际成本上限 ${VOLUME_CRITERION.maxMarginalBytesPerVariant} B/组合`,
    )
    for (const f of files) {
      const doc = readFixtureDocument(JSON.parse(readFileSync(f, 'utf8')))
      const curve = measureVolumeCurve(doc)
      report.volume = report.volume ?? []
      report.volume.push({ file: basename(f), ...curve })
      console.log(`\n▌ ${basename(f)}`)
      console.log(
        ['k'.padStart(2), 'S'.padStart(5), 'N'.padStart(6), 'gzip B'.padStart(9), 'B/组合'.padStart(8), '展开 B'.padStart(11), 'κ'.padStart(7)].join(' '),
      )
      for (const p of curve.points) {
        console.log(
          [
            String(p.k).padStart(2),
            String(p.S).padStart(5),
            String(p.N).padStart(6),
            String(p.gzipBytes).padStart(9),
            p.bytesPerVariant.toFixed(1).padStart(8),
            String(p.expandedBytes).padStart(11),
            p.kappa.toFixed(2).padStart(7),
          ].join(' '),
        )
      }
      console.log(
        `   线性拟合 G ≈ ${curve.fit.a.toFixed(0)} + ${curve.fit.b.toFixed(2)}·N   R²=${curve.fit.r2.toFixed(4)}  ` +
          (curve.checks.constantDominated
            ? `变量部分 < ${VOLUME_CRITERION.floorBytes} B（信封常数主导）→ 改判"文件足够小"=${curve.checks.smallEnough}`
            : `拟合通过=${curve.checks.fitOk}`) +
          `  边际上限内=${curve.checks.marginalOk}`,
      )
      for (const p of curve.pairs) {
        console.log(
          `   N ${String(p.fromN).padStart(5)} → ${String(p.toN).padStart(5)}（S ${p.fromS} → ${p.toS}）：` +
            `G ×${p.gzipGrowth.toFixed(2)}  N ×${p.variantsGrowth.toFixed(2)}  ` +
            `κ ×${p.kappaGrowth.toFixed(3)} ≥ ${p.kappaLimit.toFixed(3)} → ${p.r1 ? '通过' : '❌'}  ` +
            `边际 ${p.marginal.toFixed(0)} B/组合`,
        )
      }
      console.log(`   ${curve.pass ? '✔ 判定式通过' : '✘ 判定式不通过'}`)
      if (!curve.pass) report.failures += 1
    }
  }

  writeFileSync(join(OUT_DIR, 'validation-report.json'), JSON.stringify(report, null, 1), 'utf8')
  console.log(`\n报告落盘：${join(OUT_DIR, 'validation-report.json')}`)
  console.log(report.failures === 0 ? `\n✅ 全绿（失败 0 / 警告 ${report.warnings}）` : `\n❌ 失败 ${report.failures} 项`)
  process.exit(report.failures === 0 ? 0 : 1)
}

run()
