/**
 * `pure/partMask.ts#aabbOfQuadsWithinBox` 用文件自身的 baked quads 求 AABB 包络，
 * 仅用于描边 mask，不读世界、不调游戏取盒 API，也不参与命中或统计。
 *
 * `PartBoxMaskEnvelope` 标记把这种由量计算出的包络与硬编码部件盒区分开。
 * 本测试守住两点：包络仍由 min/max 变量计算；标记唯一且覆盖所有盒构造命中。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const MASK_REL = 'web/src/pure/partMask.ts'
const MARKER = 'PartBoxMaskEnvelope'
/** 部件盒构造的源码形态。 */
const BOX_CONSTRUCTION_RULE = /kind:\s*['"](visual|collision)['"]/

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

describe('partMask 包络标记与源码形态一致', () => {
  it('partMask 的包络行仍在，且形态是由量算出的 min/max（不是硬编码盒）', () => {
    const lines = read(MASK_REL).split(/\r?\n/)
    const hit = lines.findIndex((l) => BOX_CONSTRUCTION_RULE.test(l) && l.includes(MARKER))
    expect(hit, `${MASK_REL} 里应有一行同时命中盒规则且带标记 ${MARKER}`).toBeGreaterThanOrEqual(0)
    const line = lines[hit]!
    // 包络不得退化成硬编码盒。
    expect(line, `包络行不得含硬编码数字盒：${line.trim()}`).not.toMatch(/min:\s*\[\s*-?\d/)
    expect(line, `包络行不得含硬编码数字盒：${line.trim()}`).not.toMatch(/max:\s*\[\s*-?\d/)
  })

  it('包络标记唯一，所有盒构造命中都带同一标记', () => {
    const lines = read(MASK_REL).split(/\r?\n/)
    const markers = lines.filter((line) => new RegExp(`// ${MARKER}\\s*$`).test(line))
    expect(markers.length, `${MASK_REL} 应恰有 1 处 ${MARKER} 标记`).toBe(1)
    const hits = lines.filter((line) => BOX_CONSTRUCTION_RULE.test(line))
    expect(hits.length, '判据必须实际匹配到盒构造，避免空转').toBeGreaterThan(0)
    expect(hits.every((line) => line.includes(MARKER)), '所有盒构造命中都必须属于已标记包络').toBe(true)
  })
})
