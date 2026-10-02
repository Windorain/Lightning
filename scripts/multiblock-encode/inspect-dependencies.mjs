/**
 * T1.4 诊断工具：逐阶打印「每个格位置的取值由什么决定」。
 *
 *   node scripts/multiblock-encode/inspect-dependencies.mjs <datasetDir> [slug...]
 *
 * 输出把位置分类（与 `MultiblockFactorizer` 的候选键分类同口径）：
 *   - `const`：所有变体同值 → 进骨架；
 *   - `chan:<通道>{取值→下标}`：只随一条替换型通道变 → 一条 `indexTable` 规则；
 *   - `runstate{idle→x,active→y}`：只随运行态变 → 每态一条 `setCell`；
 *   - `tier{...}` / `runstate×chan`：组合依赖 → 按帧引用的多条规则。
 *
 * 新机器接入（T1.5 全量导出）时先跑它：若某位置落在"无法表达"的分类里，
 * 那台机器就需要 guard 消歧规则（见 `docs/plan/probe-factorized-encoding.md` §8.4）。
 */
import fs from 'node:fs'

const base = process.argv[2] ?? 'D:/Projects/Lightning/mod/gtnh/run/client/variant_capture/run-0015'
const slugs = process.argv.length > 3
  ? process.argv.slice(3)
  : ['mteelectricblastfurnace', 'mtedistillationtower', 'mtequantumforcetransformer', 'mtebrickedblastfurnace']

for (const slug of slugs) {
  const j = JSON.parse(fs.readFileSync(`${base}/machines/${slug}.json`, 'utf8'))
  const chanKeys = j.channels.map((c) => c.key)
  const bySize = new Map()
  for (const v of j.variants) {
    const k = v.grid.size.join('x')
    if (!bySize.has(k)) bySize.set(k, [])
    bySize.get(k).push(v)
  }
  console.log(`\n### ${slug}  channels=${chanKeys.join(',') || '(none)'} sizes=${bySize.size}`)
  for (const [size, vs] of bySize) {
    const [w, h, d] = size.split('x').map(Number)
    const obs = new Map() // pos -> [{eff:{},tt,rs,val}]
    for (const v of vs) {
      const g = v.grid.cellGrid
      for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = `${x},${y},${z}`
        if (!obs.has(p)) obs.set(p, [])
        obs.get(p).push({ eff: v.effective, tt: v.totalTier, rs: v.runstate, val: g[z][y][x], ch: v.values })
      }
    }
    const buckets = new Map() // 依赖描述 -> positions
    for (const [p, rows] of obs) {
      const vals = new Set(rows.map((r) => r.val))
      let cls
      if (vals.size === 1) cls = 'const'
      else {
        const deps = []
        // 单通道？
        for (const c of chanKeys) {
          const m = new Map()
          let ok = true
          for (const r of rows) {
            const k = r.eff[c]
            if (m.has(k) && m.get(k) !== r.val) { ok = false; break }
            m.set(k, r.val)
          }
          if (ok) deps.push(`chan:${c}{${[...m.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>k+'->'+v).join(',')}}`)
        }
        // 运行态？
        {
          const m = new Map(); let ok = true
          for (const r of rows) { const k = r.rs; if (m.has(k) && m.get(k) !== r.val) { ok = false; break } m.set(k, r.val) }
          if (ok) deps.push('runstate{' + [...m.entries()].map(([k,v])=>k+'->'+v).join(',') + '}')
        }
        // 总Tier？
        {
          const m = new Map(); let ok = true
          for (const r of rows) { const k = r.tt; if (m.has(k) && m.get(k) !== r.val) { ok = false; break } m.set(k, r.val) }
          if (ok) deps.push('tier{' + [...m.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>k+'->'+v).join(',') + '}')
        }
        // 运行态 + 单通道
        for (const c of chanKeys) {
          const m = new Map(); let ok = true
          for (const r of rows) { const k = r.rs + '|' + r.eff[c]; if (m.has(k) && m.get(k) !== r.val) { ok = false; break } m.set(k, r.val) }
          if (ok) deps.push(`runstate×chan:${c}`)
        }
        cls = deps.length ? deps.join(' + ') : 'UNEXPLAINED vals=' + [...vals].join('/')
      }
      const key = cls.split('{')[0] === 'const' ? 'const' : cls
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(p + (cls.startsWith('const') ? `(=${[...vals][0]})` : ''))
    }
    console.log(`  尺寸 ${size}: ${vs.length} 变体, ${obs.size} 格`)
    for (const [k, ps] of buckets) {
      const full = k === 'const' && new Set(ps.map((p) => p.split('(')[1])).size === 1
      console.log(`    [${k}] ${ps.length} 格${full ? '' : ': ' + ps.slice(0, 40).join(' ')}${ps.length > 40 ? ' …' : ''}`)
    }
  }
}
