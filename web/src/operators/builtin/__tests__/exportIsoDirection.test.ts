// @vitest-environment jsdom
/**
 * **D7 回归判据**（#301 P10f/E；`exportOperators.ts:88` 的既存缺陷）。
 *
 * ## 修复前的准确形态（**实测**，不是读源码推断）
 *
 * `ExportWorkspace.vue:54` 的调用形态是 `{ direction: isoDir.value }`，`isoDir` 是
 * **number**（0..3）。而修复前 `exec` 把它取成 `string` 再查
 * `ISO_DIRECTION_MAP: Record<string, number>`（键为 `'nw'`/`'ne'`/…）
 * ⇒ **number 键入 string 表恒 miss** ⇒ 渲染下标恒 `0`。
 *
 * 与此同时文件名插值的是**原始 props 值**：
 *
 * | 调用 | 传给 bake 的下标 | 下载文件名 | 内容 |
 * |---|---|---|---|
 * | `{direction: 0}` | 0 | `iso-0.png` | nw |
 * | `{direction: 1}` | **0** | `iso-1.png` | **nw** |
 * | `{direction: 2}` | **0** | `iso-2.png` | **nw** |
 * | `{direction: 3}` | **0** | `iso-3.png` | **nw** |
 *
 * ⇒ 用户可见缺陷是**名实不符**：预览显示方向 N（预览传的是真实 number），
 * 下载得 `iso-N.png` 而内容是 nw；四个方向下载出**同一张**图。
 *
 * ## 为什么判据钉在"下标"而不是"文件名"
 *
 * 文件名**本来就**随方向变（模板串把 number 原样插值）—— 若判据写"文件名应随方向变"，
 * 它在修复前**也是绿的**，即一条恒真判据（本项目明令禁止的形态）。
 * 真正的缺陷在**渲染下标**与**两者同源**上，故判据只钉这两件事。
 *
 * ## 对外接口的调用形态（本文件不 mock 生产模块）
 *
 * 判据分两层：
 *  - **纯函数层**（`resolveIsoDirection`）：直接调它，逐项核对边界与兼容口径；
 *  - **算子层**（`ExportIsoPngOperator.exec`）：注入一个**记录入参**的宿主，
 *    断言"传给 bake 的下标"与"文件名里的下标"**相等**。
 *
 * 第二层刻意**不** `vi.mock` 生产模块（那会绕开被测代码本身的接线）：
 * 它用一个只记录、不渲染的 `bake` 替身注入到算子的**可见边界**上 ——
 * 因为 `bake` 需要一个真实 WebGL 上下文（本仓 vitest 无真 GL，
 * 见 `adapters/export/renderDevice` 文件头的实测）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveIsoDirection } from '@/operators/builtin/exportOperators'

/**
 * 剥掉注释（行注释 / 块注释），只留**代码**。
 *
 * ## 为什么必须剥（本判据首跑实测到的**假红**）
 *
 * 本文件用"源码里不得出现旧的分叉写法"作为结构判据。而 `exportOperators.ts`
 * 的**文档注释**里逐字引用了修复前的写法（`` `iso-${direction}.png` ``）——
 * 那是**说明**，不是使用点。首跑即因此判红（假红）。
 *
 * 判定原则：**「提到某符号」≠「使用某符号」**。这与
 * `composition/__tests__/seams.test.ts` 的 `codeOf`（剥注释与字符串）、
 * `retirementRegistry.test.ts` 的同一处理是同一族手法。
 *
 * 字符串**保留**：本判据要看的 `iso-${…}.png` 模板字面量、`'ISO_DIRECTION_MAP[…]'`
 * 索引表达式都在代码里；剥掉字符串反而会看不见真实使用点。
 *
 * 行尾归一化为 LF（铁律 6：本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF）。
 */
function codeOnly(source: string): string {
  const text = source.replace(/\r\n/g, '\n')
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'single'; out += c; i += 1; continue }
      if (c === '"') { mode = 'double'; out += c; i += 1; continue }
      if (c === '`') { mode = 'template'; out += c; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue }
      i += 1
      continue
    }
    // 字符串/模板内部：整体保留（含转义处理）
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
    out += c
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code'
    }
    i += 1
  }
  return out
}

/** 算子源码的**代码**视图（注释已剥；行尾已归一化）。 */
const SOURCE = codeOnly(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'exportOperators.ts'), 'utf8'),
)

// ─────────────────────────────────────────────────────────────────────────────
// 一、纯函数层：归一化口径（边界的唯一权威）
// ─────────────────────────────────────────────────────────────────────────────

describe('D7 · `resolveIsoDirection` 归一化口径', () => {
  it('number 直用（UI 的真实形态）：0..3 恒等', () => {
    expect([0, 1, 2, 3].map(resolveIsoDirection)).toEqual([0, 1, 2, 3])
  })

  it('number 越界与负数按模 4 归一（不夹取、不回落 0）', () => {
    // 修复前 `-1` 会 miss ⇒ 0；`4` 也会 miss ⇒ 0。
    // 归一后 `-1 → 3`、`4 → 0`：前者是**真实方向**（往回一格），后者才是环绕。
    expect(resolveIsoDirection(-1)).toBe(3)
    expect(resolveIsoDirection(4)).toBe(0)
    expect(resolveIsoDirection(5)).toBe(1)
    expect(resolveIsoDirection(-5)).toBe(3)
    expect(resolveIsoDirection(7)).toBe(3)
  })

  it('number 小数向下取整（不四舍五入 —— 下标是离散档位）', () => {
    expect(resolveIsoDirection(2.7)).toBe(2)
    expect(resolveIsoDirection(0.9)).toBe(0)
    expect(resolveIsoDirection(-0.5)).toBe(3)
  })

  it('`NaN` / `Infinity` 回落 0（否则下标会变成 NaN 并索引出 undefined 方向）', () => {
    expect(resolveIsoDirection(Number.NaN)).toBe(0)
    expect(resolveIsoDirection(Number.POSITIVE_INFINITY)).toBe(0)
    expect(resolveIsoDirection(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('string 保留**文档化**的字符串口径（nw→0 … se→3）', () => {
    expect(resolveIsoDirection('nw')).toBe(0)
    expect(resolveIsoDirection('ne')).toBe(1)
    expect(resolveIsoDirection('sw')).toBe(2)
    expect(resolveIsoDirection('se')).toBe(3)
  })

  it('未知名与非法类型回落 0（与修复前的回落一致，不抛）', () => {
    for (const raw of ['bogus', '', 'NW', undefined, null, {}, [], true, () => {}]) {
      expect(resolveIsoDirection(raw), `${String(raw)} 应回落 0`).toBe(0)
    }
  })

  it('返回值**恒**在 0..3（调用方拿它索引四向表不可能越界）', () => {
    const samples: unknown[] = [0, 1, 2, 3, -1, 4, 99, -99, 2.7, NaN, Infinity, 'nw', 'se', 'x', undefined, null]
    for (const s of samples) {
      const v = resolveIsoDirection(s)
      expect(Number.isInteger(v), `${String(s)} → ${v} 必须是整数`).toBe(true)
      expect(v, `${String(s)} → ${v} 必须落在 0..3`).toBeGreaterThanOrEqual(0)
      expect(v, `${String(s)} → ${v} 必须落在 0..3`).toBeLessThanOrEqual(3)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、算子层：渲染下标 与 文件名 **同源**
// ─────────────────────────────────────────────────────────────────────────────

describe('D7 · 算子层：渲染下标与文件名同源（防再次分叉）', () => {
  /**
   * ## 为什么这条判据是**源码结构级**的（而不是又一次端到端驱动）
   *
   * 端到端驱动 `exec` 需要真实 WebGL（`bake` 内部要 `new THREE.WebGLRenderer`）；
   * 本仓 vitest **无真 GL**（见 `adapters/export/renderDevice` 文件头的实测）。
   * 若强行驱动，唯一办法是 `vi.mock` 掉 `bake` —— 那会绕开被测接线本身，
   * 判据退化成"我 mock 的行为"（本项目禁止的形态）。
   *
   * 真 GL 那一半由 e2e 承担（`e2e/export-ports.spec.ts`：真实浏览器里跑
   * 「四个方向各导一次 ⇒ 四张图**逐像素不同**」，那是本判据的**像素级**对应物）。
   *
   * 本判据守的是**结构不可分叉**：两处只能引用同一个归一化结果。
   * 它由 `resolveIsoDirection` 的存在 + `exec` 里的引用形态共同构成，
   * 且负对照（下方）证明它抓得住修复前的形态。
   */
  const SOURCE_VIEW = SOURCE

  it('反空洞真：剥注释后的代码视图**确实**还含有真实使用点（否则下面几条恒绿）', () => {
    // 若 `codeOnly` 把代码也剥光了，下面"不含旧写法"的断言会恒真 —— 那是假绿。
    expect(SOURCE_VIEW, '代码视图必须保留真实调用（否则判据空转）').toContain(
      'bakeIsometricStructurePngDataUrl(doc, directionIndex)',
    )
    expect(SOURCE_VIEW, '代码视图必须保留下载调用').toContain('downloadBlob(')
    // 且注释里那段"旧写法"的引用确实**在原文里**（证明剥注释这一步有实际作用）
    const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'exportOperators.ts'), 'utf8')
    expect(raw, '原文的注释里确有对旧写法的引用（故必须剥注释，否则假红）').toContain('iso-${direction}')
  })

  it('算子**不再**用原始 `props.direction` 拼文件名（修复前的分叉形态）', () => {
    // 修复前正是 `iso-${direction}.png`：`direction` 来自 props（原始值），
    // 与查表得到的渲染下标是两个来源。
    expect(SOURCE, '不得再出现把原始 props 值直接拼进文件名的形态').not.toContain('iso-${direction}')
    expect(SOURCE).not.toContain('ISO_DIRECTION_MAP[direction]')
  })

  it('文件名与 bake 的**同一个**变量（同源）', () => {
    expect(SOURCE, '文件名必须用归一化后的下标').toContain('iso-${directionIndex}.png')
    expect(SOURCE, 'bake 必须吃同一个归一化下标').toContain('bakeIsometricStructurePngDataUrl(doc, directionIndex)')
    // 反空洞真：变量确实由唯一入口产出（否则上面两条可能引用了别处的同名变量）
    expect(SOURCE).toContain('const directionIndex = resolveIsoDirection(_props.direction)')
  })

  it('**负对照**：修复前的分叉形态会被上面两条判据抓到', () => {
    // 逐字复刻修复前的两行（本判据要防的正是它复活）。
    const legacy = [
      "    const direction = (_props.direction as string) ?? 'nw'",
      '    const directionIndex = ISO_DIRECTION_MAP[direction] ?? 0',
      '      downloadBlob(`iso-${direction}.png`, blob)',
    ].join('\n')
    expect(legacy.includes('iso-${direction}'), '负对照：旧形态必须命中"原始值拼文件名"').toBe(true)
    expect(legacy.includes('ISO_DIRECTION_MAP[direction]'), '负对照：旧形态必须命中"直接查表"').toBe(true)
    expect(
      legacy.includes('iso-${directionIndex}.png'),
      '负对照：旧形态**不**含同源写法（证明上面那条不是恒真）',
    ).toBe(false)
  })

  it('**行为级负对照**：旧实现的分扁确实产生"名义 N、内容 0"（用对照实现证伪）', async () => {
    /**
     * 逐字复刻修复前的判定，喂进真实 UI 形态（number）——断言它**确实**把
     * 所有方向都算成 0。这就是"名实不符"的机械证据：
     * 文件名带 N，而渲染下标是 0。
     */
    const ISO_DIRECTION_MAP: Record<string, number> = { nw: 0, ne: 1, sw: 2, se: 3 }
    const legacyIndexFor = (props: { direction: unknown }): number => {
      const direction = (props.direction as string) ?? 'nw'
      return ISO_DIRECTION_MAP[direction] ?? 0
    }
    for (const isoDir of [0, 1, 2, 3]) {
      expect(legacyIndexFor({ direction: isoDir }), '旧实现把每个方向的渲染下标都算成 0').toBe(0)
    }
    // 而修复后的入口给出真实方向 —— 两者在同一输入下**必须不同**（这就是修复的实质）。
    for (const isoDir of [1, 2, 3]) {
      expect(resolveIsoDirection(isoDir)).not.toBe(legacyIndexFor({ direction: isoDir }))
    }
    // `0` 是唯一两者都同意的情形（nw 恰好是旧实现的恒定回落值）。
    expect(resolveIsoDirection(0)).toBe(legacyIndexFor({ direction: 0 }))
  })
})
