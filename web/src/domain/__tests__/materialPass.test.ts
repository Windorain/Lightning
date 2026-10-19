/**
 * `domain/materialPass` 判据：**混合模式 → three 渲染状态**的唯一映射。
 *
 * 为什么这条判据值钱：它守的是一个"只在重叠半透明几何上才可见"的缺陷形态
 * （见模块文件头的实测：LP 管接缝被全透明四边形深度剔除）。三条 pass 语义
 * 逐条钉住，并用**负对照**证明它不是恒真。
 */

import { describe, expect, it } from 'vitest'
import { materialPassStateOf } from '@/domain/materialPass'

describe('materialPassStateOf：MC 的三段 pass 状态', () => {
  it('opaque ⇒ 不混合、不测试 alpha、**写深度**', () => {
    expect(materialPassStateOf('opaque')).toEqual({ transparent: false, alphaTest: 0, depthWrite: true })
  })

  it('cutout ⇒ 二值透明、alphaTest 0.5、**仍写深度**（cutout 是实体）', () => {
    expect(materialPassStateOf('cutout')).toEqual({ transparent: true, alphaTest: 0.5, depthWrite: true })
  })

  it('translucent ⇒ 混合、**不写深度**（MC 混合 pass 的语义）', () => {
    const s = materialPassStateOf('translucent')
    expect(s.transparent, '混合 pass 必须开 transparent').toBe(true)
    expect(s.alphaTest, '混合 pass 不做 alpha 测试').toBe(0)
    // 这一位就是实测缺陷的位置：写成 true ⇒ 全透明四边形会把后面的实体剔除
    expect(s.depthWrite, '混合 pass **不得**写深度').toBe(false)
  })

  it('**负对照**：三种模式的 depthWrite 不是同一个值（否则"不写深度"那条是空洞真）', () => {
    const values = new Set(['opaque', 'cutout', 'translucent'].map((b) => materialPassStateOf(b).depthWrite))
    expect(values.size, 'depthWrite 至少要有 true/false 两种取值').toBe(2)
  })

  it('未知/缺席按 opaque 处理（文件没声明 ⇒ 当实体画，不许意外剔除别人）', () => {
    expect(materialPassStateOf(undefined)).toEqual(materialPassStateOf('opaque'))
    expect(materialPassStateOf('nope')).toEqual(materialPassStateOf('opaque'))
  })
})
