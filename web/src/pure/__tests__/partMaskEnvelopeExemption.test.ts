/**
 * `check-static.mjs`「web 端不构造部件盒」规则的**具名豁免**守卫（#39 阶段二）。
 *
 * 背景（README §6 finding F7）：该规则用 `kind: 'visual'|'collision'` 字面量判定"端上构造部件盒"，
 * 而 B-1 的 `pure/partMask.ts#aabbOfQuadsWithinBox` 用**文件自己的 baked quads** 求 AABB 包络
 * （描边 mask 用；不读世界、不调游戏取盒 API、不参与命中/统计）⇒ 命中过宽。
 * 处置 = 规则对该行做**具名行内标记豁免**（`PartBoxMaskEnvelope`），带"标记消失即判红"的陈旧守卫。
 *
 * 本测试把两侧的登记对齐，防"规则被悄悄改宽/豁免变哑"：
 *  1. 被豁免的源码行仍在、且仍带标记；
 *  2. 该行的形态仍是**由量算出的包络**（min/max 来自变量，而不是硬编码盒字面量）；
 *  3. 脚本侧的豁免登记**唯一**（只有这一处），且仍以该标记匹配。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const SCRIPT_REL = 'scripts/parts-acceptance/check-static.mjs'
const MASK_REL = 'web/src/pure/partMask.ts'
const MARKER = 'PartBoxMaskEnvelope'
/** 规则本体（与 check-static.mjs 的 `boxConstructionHits` 判据同形）。 */
const BOX_CONSTRUCTION_RULE = /kind:\s*['"](visual|collision)['"]/

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

describe('check-static 盒规则豁免与纯函数登记一致', () => {
  it('partMask 的包络行仍在，且形态是由量算出的 min/max（不是硬编码盒）', () => {
    const lines = read(MASK_REL).split(/\r?\n/)
    const hit = lines.findIndex((l) => BOX_CONSTRUCTION_RULE.test(l) && l.includes(MARKER))
    expect(hit, `${MASK_REL} 里应有一行同时命中盒规则且带标记 ${MARKER}`).toBeGreaterThanOrEqual(0)
    const line = lines[hit]!
    // 包络不得退化成硬编码盒（硬编码数字 = §6/§12 真违例，豁免不允许覆盖）
    expect(line, `被豁免行不得含硬编码数字盒：${line.trim()}`).not.toMatch(/min:\s*\[\s*-?\d/)
    expect(line, `被豁免行不得含硬编码数字盒：${line.trim()}`).not.toMatch(/max:\s*\[\s*-?\d/)
  })

  it('脚本侧的豁免登记唯一，并以同一标记匹配（不绑行号）', () => {
    const script = read(SCRIPT_REL)
    const markers = script.match(new RegExp(`marker: '${MARKER}'`, 'g')) ?? []
    expect(markers.length, `check-static.mjs 应恰有 1 处 marker: '${MARKER}' 登记`).toBe(1)
    expect(script, '豁免必须带陈旧守卫（staleExemptions）').toContain('staleExemptions')
    // 豁免按**行内标记**匹配（挪行不失效）；登记对象里不得出现 `line:` 字段
    const block = script.slice(script.indexOf('const BOX_RULE_EXEMPTIONS'), script.indexOf('const exemptionHit'))
    expect(block, '豁免登记不得绑行号').not.toMatch(/\bline:\s*\d/)
  })
})
