// @vitest-environment node
/**
 * **C10（M5-4）**：材质卡 GIF 的逐帧时延必须来自**声明**（不是自算 tick）。
 *
 * ## 为什么是源码级判据
 *
 * 真跑这条路径要 canvas + 图片解码 + Blob 下载（vitest 环境没有真实 2D 画布语义），
 * 而"时延从哪来"这件事在实现上是**一个表达式**的差别：
 *
 * | 版本 | 表达式 | 对不等帧时长 [1t, 2t] 的结果 |
 * |---|---|---|
 * | 旧 | `(defaultFrametimeTicks ?? 1) * 5` | `[5, 5]`（第二个 2 tick 被压成 1 tick） |
 * | 新 | `planSequenceLoop(...)` 的 `delayCs` | `[5, 10]` |
 *
 * 行为面由 `domain/__tests__/sequenceLoopPlan.test.ts`（C6）覆盖；本判据只钉"接线"：
 * 旧表达式**消失**、计划函数**在场**。负对照把旧字符串喂给同一判定，必须命中。
 *
 * 行尾归一化为 LF（铁律 6：本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** 剥掉注释（行注释 / 块注释），只留代码；字符串保留（要看的表达式在代码里）。 */
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
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
    out += c
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code'
    }
    i += 1
  }
  return out
}

/** 判定的**唯一**实现：旧自算 tick 表达式是否还在、计划函数是否在场。 */
function violations(code: string): string[] {
  const out: string[] = []
  if (code.includes('defaultFrametimeTicks ?? 1) * 5')) out.push('仍用 defaultFrametimeTicks*5 自算时延')
  if (!code.includes('planSequenceLoop(')) out.push('没有经 planSequenceLoop 求逐帧时延')
  return out
}

const SOURCE = codeOnly(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'materialOperators.ts'), 'utf8'),
)

describe('材质卡 GIF · 逐帧时延来自声明（C10）', () => {
  it('反空洞真：代码视图里确实还有真实的 GIF 导出调用（否则下面恒绿）', () => {
    expect(SOURCE).toContain('encodeAnimatedGif(')
    expect(SOURCE).toContain('probeAnimatedStrip(')
  })

  it('旧的自算 tick 表达式**消失**，且计划函数在场', () => {
    expect(violations(SOURCE)).toEqual([])
  })

  it('**负对照**：把旧写法喂给同一判定，必须命中', () => {
    const legacy = [
      'const delay = (m.animation?.defaultFrametimeTicks ?? 1) * 5',
      'const { blob } = await encodeAnimatedGif(m.textureDataUrl, delay)',
    ].join('\n')
    expect(violations(legacy)).toEqual(['仍用 defaultFrametimeTicks*5 自算时延', '没有经 planSequenceLoop 求逐帧时延'])
  })
})
