/**
 * `presentation/textureBinding` 的判据测试（#289 P10d）。
 *
 * ## 本文件证的三条（各自对应一条明文的负对照）
 *
 * | 判据 | 明文来源 | 负对照 |
 * |---|---|---|
 * | 纹理按**内容身份**绑定，locator 不进身份 | §19.3「URL 仅为获取位置」；契约 §4 | 按 URL 缓存（A28） |
 * | 换纹理内容 ⇒ 材质身份变 | A36「版本替换」 | 同一 URL 覆盖上传后永远显示旧图 |
 * | 必需资源未就绪 ⇒ **显式**标缺 | G4 / A36「不得假装完整」 | 用默认图顶上并宣称成功 |
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  VOXEL_SAMPLING,
  bindTexture,
  missingRequiredAssets,
  textureBindingKey,
  textureRequirementsOf,
  type TextureResource,
} from '@/presentation/textureBinding'
import { contentVersionOfBytes, type ContentIdentity } from '@/presentation/assetIdentity'
import { materialIdentityOf } from '@/presentation/presenter'
import type { MaterialDescriptor } from '@/presentation/evaluationKey'

const MATERIAL: MaterialDescriptor = {
  id: 'structure',
  version: 'v1',
  blend: 'opaque',
  tint: 0xffffff,
  useVertexColor: true,
}

function resource(overrides: Partial<Omit<TextureResource, 'identity'>> & { identity?: ContentIdentity } = {}): TextureResource {
  return {
    identity: { id: 'material:0', version: 'fnv1a:aaaa:10' },
    locator: { kind: 'inline', url: 'data:image/png;base64,AAAA' },
    state: 'ready',
    pixels: null,
    ...overrides,
  }
}

describe('纹理绑定：内容身份，不是 URL', () => {
  it('绑定携带纹理的**内容身份**（id + version）', () => {
    const r = resource()
    const b = bindTexture(MATERIAL, { identity: r.identity, required: true, state: r.state })
    expect(b.map).toEqual(r.identity)
    expect(b.missingRequired).toBe(false)
  })

  it('**A28 正面对照**：同一份内容换获取位置 ⇒ 绑定**不变**（换 CDN 不该重建材质）', () => {
    const a = resource({ locator: { kind: 'external', url: 'https://a/x.png' } })
    const b = resource({ locator: { kind: 'external', url: 'https://mirror/x.png' } })
    const ba = bindTexture(MATERIAL, { identity: a.identity, required: true, state: a.state })
    const bb = bindTexture(MATERIAL, { identity: b.identity, required: true, state: b.state })
    expect(textureBindingKey(ba)).toBe(textureBindingKey(bb))
  })

  it('**A28 负对照的镜像**：同一 id 换了内容版本 ⇒ 绑定键**必须**变', () => {
    const a = resource({ identity: { id: 'material:0', version: 'fnv1a:aaaa:10' } })
    const b = resource({ identity: { id: 'material:0', version: 'fnv1a:bbbb:10' } })
    const ba = bindTexture(MATERIAL, { identity: a.identity, required: true, state: a.state })
    const bb = bindTexture(MATERIAL, { identity: b.identity, required: true, state: b.state })
    expect(textureBindingKey(ba)).not.toBe(textureBindingKey(bb))
  })

  it('**A36 版本替换**：换纹理 ⇒ **材质身份**跟着变（否则缓存命中、永远显示旧图）', () => {
    const m1 = materialIdentityOf(MATERIAL, bindTexture(MATERIAL, { identity: { id: 'm:0', version: 'v1' }, required: true, state: 'ready' }))
    const m2 = materialIdentityOf(MATERIAL, bindTexture(MATERIAL, { identity: { id: 'm:0', version: 'v2' }, required: true, state: 'ready' }))
    expect(m1.id).not.toBe(m2.id)
  })

  it('无贴图材质 ⇒ 绑定**不写** `map`（缺席 ≠ 绑到默认图）', () => {
    const b = bindTexture(MATERIAL, null)
    expect(b.map).toBeUndefined()
    expect(b.missingRequired).toBe(false)
    // 且它与其他无贴图材质的身份一致（不因"没贴图"而分叉）
    expect(materialIdentityOf(MATERIAL, b).id).toBe(materialIdentityOf(MATERIAL, bindTexture(MATERIAL, null)).id)
  })

  it('**G4/A36**：必需纹理 `missing`/`failed` ⇒ `missingRequired = true`（不用占位冒充完整）', () => {
    for (const state of ['missing', 'failed'] as const) {
      const b = bindTexture(MATERIAL, { identity: { id: 'm:0', version: 'v1' }, required: true, state })
      expect(b.missingRequired, `state=${state} 必须标缺`).toBe(true)
    }
  })

  it('**进行中不算缺**：`unrequested`/`loading` ⇒ 不标缺（否则每帧都在报"缺资源"）', () => {
    for (const state of ['unrequested', 'loading'] as const) {
      const b = bindTexture(MATERIAL, { identity: { id: 'm:0', version: 'v1' }, required: true, state })
      expect(b.missingRequired, `state=${state} 不得标缺`).toBe(false)
    }
  })

  it('**可选资源**缺失 ⇒ 不标缺（只降级，不阻断 —— G4 原文）', () => {
    const b = bindTexture(MATERIAL, { identity: { id: 'm:0', version: 'v1' }, required: false, state: 'missing' })
    expect(b.missingRequired).toBe(false)
  })

  it('缺失清单可机械读出（G4 判据面）', () => {
    const bindings = [
      bindTexture(MATERIAL, { identity: { id: 'a', version: '1' }, required: true, state: 'missing' }),
      bindTexture(MATERIAL, null),
      bindTexture(MATERIAL, { identity: { id: 'b', version: '1' }, required: true, state: 'failed' }),
      bindTexture(MATERIAL, { identity: { id: 'c', version: '1' }, required: true, state: 'ready' }),
    ]
    expect(missingRequiredAssets(bindings).map((x) => x.assetId)).toEqual(['a', 'b'])
  })

  it('资源需求清单带**内容版本**（`compileScene#requiredAssetIds` 只给 id 的对偶）', () => {
    const r = resource({ identity: { id: 'material:0', version: 'fnv1a:cccc:20' } })
    const b = bindTexture(MATERIAL, { identity: r.identity, required: true, state: 'ready' })
    const reqs = textureRequirementsOf([b], [r])
    expect(reqs.length).toBe(1)
    expect(reqs[0]!.required[0]).toEqual(r.identity)
  })

  it('内容版本由**字节**派生，且长度进版本（截断到同一哈希前缀不可误判）', () => {
    const v1 = contentVersionOfBytes('AAAA')
    const v2 = contentVersionOfBytes('AAAAA')
    expect(v1).not.toBe(v2)
    expect(contentVersionOfBytes('AAAA')).toBe(v1)
  })
})

describe('采样设置是**呈现参数**（不进资源身份）', () => {
  it('默认是 MC 体素风格（nearest / clamp / 不翻 Y / 无 mipmap）', () => {
    expect(VOXEL_SAMPLING).toEqual({ filter: 'nearest', wrap: 'clamp', flipY: false, mipmaps: false, anisotropy: 0 })
  })

  it('换采样不改纹理身份（同一份像素两种采样 = 同一资源）', () => {
    const r = resource()
    const a = bindTexture(MATERIAL, { identity: r.identity, required: true, state: 'ready' }, VOXEL_SAMPLING)
    const b = bindTexture(MATERIAL, { identity: r.identity, required: true, state: 'ready' }, { ...VOXEL_SAMPLING, filter: 'linear' })
    expect(textureBindingKey(a)).toBe(textureBindingKey(b))
    expect(a.sampling.filter).toBe('nearest')
    expect(b.sampling.filter).toBe('linear')
  })

  it('three r174 具备本模块用到的过滤常量（锁定版本核实，不照最新在线文档假定）', () => {
    // #249 §11 末段：「具体 Three.js API 以实际锁定版本核实」
    for (const name of ['NearestFilter', 'LinearFilter', 'NearestMipmapNearestFilter', 'LinearMipmapLinearFilter', 'RepeatWrapping', 'ClampToEdgeWrapping'] as const) {
      expect(THREE[name], `three 应导出 ${name}`).toBeDefined()
    }
  })
})
