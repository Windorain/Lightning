/**
 * `domain/materialPass` 判据：**混合模式（+ 贴图 alpha 类别）→ three 渲染状态**的唯一映射。
 *
 * 为什么这条判据值钱：它守的是一个"只在重叠半透明几何上才可见"的缺陷形态
 * （见模块文件头的实测：LP 管接缝被全透明四边形深度剔除）。
 *
 * 映射自修复轮 3 起多了一个输入：贴图的 alpha 类别（`domain/textureAlphaClass`）。
 * Angelica 的语义是"二值 alpha 的 translucent 实际走 cutout"（`AngelicaChunkBuildContext`
 * 的降级），故本判据把三段 pass + **降级支**逐条钉住，并用负对照证明不是恒真。
 */
import { describe, expect, it } from 'vitest'
import { materialPassStateOf } from '@/domain/materialPass'

const CUTOUT = { transparent: true, alphaTest: 0.5, depthWrite: true }
const BLEND = { transparent: true, alphaTest: 0, depthWrite: false }

describe('materialPassStateOf：MC 的三段 pass 状态', () => {
  it('opaque ⇒ 不混合、不测试 alpha、**写深度**（alpha 类别不改变它）', () => {
    expect(materialPassStateOf('opaque')).toEqual({ transparent: false, alphaTest: 0, depthWrite: true })
    expect(materialPassStateOf('opaque', 'binary')).toEqual(materialPassStateOf('opaque'))
    expect(materialPassStateOf('opaque', 'partial')).toEqual(materialPassStateOf('opaque'))
  })

  it('cutout ⇒ 二值透明、alphaTest 0.5、**仍写深度**（cutout 是实体；类别不改变它）', () => {
    expect(materialPassStateOf('cutout')).toEqual(CUTOUT)
    expect(materialPassStateOf('cutout', 'partial')).toEqual(CUTOUT)
    expect(materialPassStateOf('cutout', 'opaque')).toEqual(CUTOUT)
  })

  it('translucent + 未知类别 ⇒ 混合、**不写深度**（真半透明的画家路径，= 修复前现状）', () => {
    const s = materialPassStateOf('translucent')
    expect(s.transparent, '混合 pass 必须开 transparent').toBe(true)
    expect(s.alphaTest, '未知/真半透明不做 alpha 测试').toBe(0)
    expect(s.depthWrite, '未知/真半透明 **不得** 写深度').toBe(false)
  })

  it('translucent + partial ⇒ 与未知**同**状态（真半透明保留画家路径）', () => {
    expect(materialPassStateOf('translucent', 'partial')).toEqual(BLEND)
  })

  it('translucent + **binary** ⇒ cutout 等价状态（Angelica 的降级语义；alphaTest + 写深度）', () => {
    expect(materialPassStateOf('translucent', 'binary')).toEqual(CUTOUT)
    // "等价"不是"看起来像"：它与 cutout 声明**逐字段相等**（同一个状态值）。
    expect(materialPassStateOf('translucent', 'binary')).toEqual(materialPassStateOf('cutout'))
  })

  it('translucent + opaque ⇒ 同样降级为 cutout（贴图没有可裁像素时，混合不写深度纯亏）', () => {
    expect(materialPassStateOf('translucent', 'opaque')).toEqual(CUTOUT)
  })

  it('**负对照**：二值/无 alpha 与真半透明**必须**是不同状态（否则降级那条是空洞真）', () => {
    expect(materialPassStateOf('translucent', 'binary')).not.toEqual(materialPassStateOf('translucent', 'partial'))
    expect(materialPassStateOf('translucent', 'opaque')).not.toEqual(materialPassStateOf('translucent'))
    // 差异必须落在**渲染状态位**上，而不是对象身份上（boolean 位至少差一位）。
    const binary = materialPassStateOf('translucent', 'binary')
    const partial = materialPassStateOf('translucent', 'partial')
    expect([binary.alphaTest !== partial.alphaTest, binary.depthWrite !== partial.depthWrite].some(Boolean)).toBe(true)
  })

  it('**负对照**：三种 blend 的 depthWrite 不是同一个值（否则"不写深度"那条是空洞真）', () => {
    const values = new Set(['opaque', 'cutout', 'translucent'].map((b) => materialPassStateOf(b).depthWrite))
    expect(values.size, 'depthWrite 至少要有 true/false 两种取值').toBe(2)
  })

  it('未知/缺席 blend 按 opaque 处理（文件没声明 ⇒ 当实体画，不许意外剔除别人）', () => {
    expect(materialPassStateOf(undefined)).toEqual(materialPassStateOf('opaque'))
    expect(materialPassStateOf('nope')).toEqual(materialPassStateOf('opaque'))
    // alpha 类别不得把未知 blend 拖进 cutout（那会开始裁像素）。
    expect(materialPassStateOf('nope', 'binary')).toEqual(materialPassStateOf('opaque'))
  })

  it('**LP 回归保护（两半都要成立）**：α=0 的几何在任何 alpha 类别下都不偷写深度', () => {
    // 二值：alphaTest 丢掉 α=0 像素 ⇒ 不写深度 ⇒ 接缝板可见。
    const binary = materialPassStateOf('translucent', 'binary')
    expect(binary.alphaTest, '二值必须靠 alphaTest 丢弃 α=0 像素').toBeGreaterThan(0)
    // 真半透明：根本不写深度 ⇒ 接缝板可见。
    expect(materialPassStateOf('translucent', 'partial').depthWrite).toBe(false)
  })
})
