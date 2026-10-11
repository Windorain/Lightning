/**
 * **D3a（#289 P10d）· 资源 → `TextureResource[]` 五态**。
 *
 * ## 本文件证什么
 *
 * 修掉一处**真缺陷**：`buildMaterialLibrary` 用 `Promise.all` + 逐项 `throw`，
 * 任一张纹理坏掉即**整库 reject**；调用方捕获后把 `textureCache = null`
 * ⇒ **57 张里坏 1 张，整个视口无贴图**（实测 `ALL-GOOD` 与 `ONE-BAD` 给出同一条错误）。
 *
 * 而 #249 §19.3 逐字要求区分「未请求、加载中、可用、缺失、失败」，D1 已交付
 * `textureBinding` 的五态模型正是为此准备的 —— 它此前**零生产接线**。
 *
 * ## 核心判据的形状
 *
 * 「坏一张 ⇒ **只**坏那一张」必须用**真实夹具的条数**断言
 * （`failed === 1 && ready === n - 1`），而不是"没抛错"。
 * 后者是空洞真：一个"全部标 failed"的实现也能不抛错。
 */

import { describe, expect, it } from 'vitest'
import { textureResourcesOf, textureBindingsOf, TEXTURE_STATES, type TextureDecoder } from '@/composition/kernelTextureResources'
import { bindTexture, missingRequiredAssets, textureRequirementsOf, type TextureResource } from '@/presentation/textureBinding'
import { contentIdentityKey } from '@/presentation/assetIdentity'
import type { ContentResource } from '@/domain/content'
import { plainRootOf } from '@/adapters/plainRoot'
import fs from 'node:fs'
import path from 'node:path'

/** 一个**总是成功**的解码器（像素内容无关紧要；本文件测状态机，不测 PNG）。 */
const okDecoder: TextureDecoder = {
  decode: async (payload) => ({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(payload.length & 0xff) }),
}

/** 一个**对指定下标抛错**的解码器（"坏一张"的注入点）。 */
function failingAtDecoder(badIndex: number): TextureDecoder {
  let seen = -1
  return {
    decode: async () => {
      seen += 1
      if (seen === badIndex) throw new Error(`注入的解码失败（第 ${badIndex} 张）`)
      return { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4) }
    },
  }
}

/** 造一条资源（只填本模块读的字段）。 */
function resource(over: Partial<ContentResource> & { assetId: string; payload: string | null }): ContentResource {
  const { assetId, payload, ...rest } = over
  return {
    ref: { assetId, contentVersion: `v:${assetId}`, url: `https://example.invalid/${assetId}.png` },
    kind: 'static16',
    payload,
    blend: null,
    emissive: null,
    animation: null,
    atlas: null,
    linear: null,
    useMipmaps: null,
    ...rest,
  } as ContentResource
}

/** 材质描述符（`bindTexture` 要求**完整**形状，见 `textureBindingsOf` 的说明）。 */
function material(id: string) {
  return { id, version: 'v1', blend: 'opaque' as const, tint: 0xffffff, useVertexColor: true }
}

/** 真实信封的资源条数（"坏一张"判据要用真实规模，不能用 3 条玩具数据）。 */
function realResourceCount(): number {
  const env = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8').replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const plain = plainRootOf(env)!
  const blobs = plain.textureBlobs
  return Array.isArray(blobs) ? blobs.length : Object.keys(blobs ?? {}).length
}

describe('D3a · 五态模型（#249 §19.3）', () => {
  it('五态取值一个不少（把任意两个并成一个会让"没请求过"与"请求了但 404"不可区分）', () => {
    expect([...TEXTURE_STATES].sort()).toEqual(['failed', 'loading', 'missing', 'ready', 'unrequested'])
  })

  it('内嵌且解码成功 ⇒ `ready` + `pixels` 非空', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'a', payload: 'data:image/png;base64,AAAA' })], okDecoder)
    expect(out[0]!.state).toBe('ready')
    expect(out[0]!.pixels).not.toBeNull()
  })

  it('外链（`payload === null`）⇒ `unrequested`，**不**伪造成 missing/failed', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'ext', payload: null })], okDecoder)
    expect(out[0]!.state, '还没请求 ≠ 缺失（后者需要提示用户，前者只需发起请求）').toBe('unrequested')
    expect(out[0]!.pixels).toBeNull()
    expect(out[0]!.locator.kind, '外链的位置类型').toBe('external')
  })

  it('解码抛错 ⇒ `failed` + 原因非空（不可静默）', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'bad', payload: 'x' })], failingAtDecoder(0))
    expect(out[0]!.state).toBe('failed')
    expect(out[0]!.failure, '失败必须带原因').toBeTruthy()
  })

  it('解码返回 `null` ⇒ `failed`（与抛错同归，但原因不同）', async () => {
    const nullDecoder: TextureDecoder = { decode: async () => null }
    const out = await textureResourcesOf([resource({ assetId: 'null', payload: 'x' })], nullDecoder)
    expect(out[0]!.state).toBe('failed')
    expect(out[0]!.failure).toContain('null')
  })

  it('**色彩空间/取回位置不进身份**（A28 正面对照：同内容换 URL 仍是同一身份）', async () => {
    const a = await textureResourcesOf([resource({ assetId: 'same', payload: 'data:x' })], okDecoder)
    const b = await textureResourcesOf(
      [
        {
          ...resource({ assetId: 'same', payload: 'data:x' }),
          ref: { assetId: 'same', contentVersion: 'v:same', url: 'https://other.invalid/moved.png' },
        },
      ],
      okDecoder,
    )
    expect(contentIdentityKey(a[0]!.identity), '换 URL 不得换身份').toBe(contentIdentityKey(b[0]!.identity))
  })
})

describe('D3a · **坏一张 ⇒ 只坏那一张**（本批修掉的真缺陷）', () => {
  it(`真实规模（${realResourceCount()} 张）：坏 1 张 ⇒ 恰好 1 条 failed，其余全部 ready`, async () => {
    const n = realResourceCount()
    expect(n, '真实信封必须有真实数量的纹理（否则本条是玩具判据）').toBeGreaterThan(10)
    const resources = Array.from({ length: n }, (_, i) => resource({ assetId: `r${i}`, payload: `data:image/png;base64,${i}` }))
    const out = await textureResourcesOf(resources, failingAtDecoder(3))
    const failed = out.filter((r) => r.state === 'failed')
    const ready = out.filter((r) => r.state === 'ready')
    expect(failed.length, '**恰好** 1 条失败 —— 旧实现是整库失败（0 条 ready）').toBe(1)
    expect(ready.length, '其余必须全部可用').toBe(n - 1)
    expect(contentIdentityKey(failed[0]!.identity), '失败的必须是第 3 张（不是随便一张）').toBe('r3@v:r3')
  })

  it('**旧口径的负对照**：等价于 `Promise.all` 的行为 ⇒ 整批失败（证明本判据不是恒真）', async () => {
    // 复刻旧实现的形状（`Promise.all` + 逐项 throw），证明"坏一张"在旧口径下确实是"全无"。
    //
    // ⚠️ 解码器必须是**同一个实例**（第一版在 map 里每次 `failingAtDecoder(3)`，
    // 于是每项的计数都从 0 开始、永远只命中第 0 项 —— 判据因此没在测它声称的东西）。
    async function legacyAllOrNothing(resources: readonly ContentResource[]): Promise<number> {
      const decoder = failingAtDecoder(3)
      const textures = await Promise.all(
        resources.map(async (r) => decoder.decode(r.payload ?? '')),
      )
      return textures.length
    }
    const n = 6
    const resources = Array.from({ length: n }, (_, i) => resource({ assetId: `r${i}`, payload: `d${i}` }))
    await expect(legacyAllOrNothing(resources), '旧口径必须整批失败').rejects.toThrow()
    // 而新口径在**同一个**注入下给出 1 失败 + 5 可用
    const out = await textureResourcesOf(resources, failingAtDecoder(3))
    expect(out.filter((r) => r.state === 'ready').length, '新口径：5 张仍可用').toBe(n - 1)
    expect(out.filter((r) => r.state === 'failed').length, '新口径：恰好 1 张失败').toBe(1)
  })
})

describe('D3a · 五态与既有绑定/诊断面接通（D1 的模型从此有生产输入）', () => {
  const material = { id: 'structure', version: 'v1', blend: 'opaque' as const, tint: 0xffffff, useVertexColor: true }

  it('`ready` 资源 ⇒ 绑定带 `map`，且**不**标缺', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'ok', payload: 'd' })], okDecoder)
    const binding = bindTexture(material, { identity: out[0]!.identity, required: true, state: out[0]!.state })
    expect(binding.map, '可用的资源必须绑上（否则"有贴图"与"没贴图"不可区分）').toBeDefined()
    expect(binding.missingRequired, '可用 ⇒ 不得标缺').toBe(false)
  })

  it('`failed` + 必需 ⇒ 绑定标缺，且 `missingRequiredAssets` 报出它（G4/A36 的判据面）', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'bad', payload: 'd' })], failingAtDecoder(0))
    const binding = bindTexture(material, { identity: out[0]!.identity, required: true, state: out[0]!.state })
    expect(binding.missingRequired, '必需且失败 ⇒ 必须标缺').toBe(true)
    const missing = missingRequiredAssets([binding])
    expect(missing.length, '缺必需资源必须被报出，不得假装完整').toBeGreaterThan(0)
  })

  it('`unrequested`（进行中）⇒ **不**标缺（否则每帧都在报"缺资源"）', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'ext', payload: null })], okDecoder)
    const binding = bindTexture(material, { identity: out[0]!.identity, required: true, state: out[0]!.state })
    expect(binding.missingRequired, '未请求是进行中，不是缺失').toBe(false)
  })

  it('`textureRequirementsOf` 能从绑定 + 资源反推出"要哪个版本"（A28 的前提）', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'req', payload: 'd' })], okDecoder)
    const binding = bindTexture(material, { identity: out[0]!.identity, required: true, state: out[0]!.state })
    const reqs = textureRequirementsOf([binding], out)
    expect(reqs.length, '必须反推出需求项').toBe(1)
    expect(reqs[0]!.required[0]!.version, '需求必须带**版本**（同 URL 换内容可判定的前提）').toBeTruthy()
  })
})

describe('D3a · `textureBindingsOf`：材质 → 资源（**唯一**的绑定生产点）', () => {
  it('`material:<n>` ⇒ 绑到 `resources[n]`（约定只有一处）', async () => {
    const resources = await textureResourcesOf(
      [resource({ assetId: 'a', payload: 'd0' }), resource({ assetId: 'b', payload: 'd1' })],
      okDecoder,
    )
    const bindings = textureBindingsOf({
      materials: [
        material('material:0'),
        material('material:1'),
      ],
      resources,
    })
    expect(bindings.length).toBe(2)
    expect(contentIdentityKey(bindings[0]!.map!), 'material:0 ⇒ 第 0 条资源').toBe(contentIdentityKey(resources[0]!.identity))
    expect(contentIdentityKey(bindings[1]!.map!), 'material:1 ⇒ 第 1 条资源').toBe(contentIdentityKey(resources[1]!.identity))
  })

  it('**下标越界 ⇒ 显式无贴图**（不得绑错一张）', async () => {
    const resources = await textureResourcesOf([resource({ assetId: 'only', payload: 'd' })], okDecoder)
    const bindings = textureBindingsOf({ materials: [material('material:7')], resources })
    expect(bindings[0]!.map, '越界不得回落到任意一张（那会静默贴错纹理）').toBeUndefined()
    expect(bindings[0]!.missingRequired, '无贴图 ⇒ 不标缺（它不是"缺"，是本来没有）').toBe(false)
  })

  it('**id 不符约定 ⇒ 显式无贴图**（不得猜）', async () => {
    const resources = await textureResourcesOf([resource({ assetId: 'a', payload: 'd' })], okDecoder)
    const bindings = textureBindingsOf({ materials: [material('structure')], resources })
    expect(bindings[0]!.map).toBeUndefined()
  })

  it('**缺哪张可查询**：坏的那张 ⇒ 该材质标缺，其余不标（G4/A36）', async () => {
    const resources = await textureResourcesOf(
      [resource({ assetId: 'good', payload: 'd0' }), resource({ assetId: 'bad', payload: 'd1' })],
      failingAtDecoder(1),
    )
    const bindings = textureBindingsOf({
      materials: [
        material('material:0'),
        material('material:1'),
      ],
      resources,
    })
    expect(bindings[0]!.missingRequired, '好的那张不得被牵连').toBe(false)
    expect(bindings[1]!.missingRequired, '坏的那张必须标缺').toBe(true)
    const missing = missingRequiredAssets(bindings)
    expect(missing.length, '恰好报出一项').toBe(1)
    expect(missing[0]!.materialId).toBe('material:1')
  })

  it('`requiredIndexes` 决定必需/可选（同一材质在不同场景可必需或可选）', async () => {
    const resources = await textureResourcesOf([resource({ assetId: 'bad', payload: 'd' })], failingAtDecoder(0))
    const required = textureBindingsOf({ materials: [material('material:0')], resources })
    const optional = textureBindingsOf({
      materials: [material('material:0')],
      resources,
      requiredIndexes: [],
    })
    expect(required[0]!.missingRequired, '必需 ⇒ 标缺').toBe(true)
    expect(optional[0]!.missingRequired, '可选 ⇒ 只降级不阻断').toBe(false)
  })

  it('空材质表 ⇒ 空绑定（不伪造一条默认绑定）', () => {
    expect(textureBindingsOf({ materials: [], resources: [] }).length).toBe(0)
  })
})

describe('D3a · 纯性与确定性（可缓存的前提）', () => {
  it('同输入 ⇒ 同输出（含身份与状态）', async () => {
    const mk = (): ContentResource[] => [
      resource({ assetId: 'a', payload: 'd1' }),
      resource({ assetId: 'b', payload: null }),
    ]
    const a = await textureResourcesOf(mk(), okDecoder)
    const b = await textureResourcesOf(mk(), okDecoder)
    expect(a.map((r) => `${contentIdentityKey(r.identity)}:${r.state}`)).toEqual(
      b.map((r) => `${contentIdentityKey(r.identity)}:${r.state}`),
    )
  })

  it('不修改输入（纯函数纪律）', async () => {
    const input = [resource({ assetId: 'a', payload: 'd' })]
    const before = JSON.stringify(input)
    await textureResourcesOf(input, okDecoder)
    expect(JSON.stringify(input), '入参不得被改写').toBe(before)
  })

  it('空输入 ⇒ 空输出（不伪造成"1 张默认图"）', async () => {
    const out: readonly TextureResource[] = await textureResourcesOf([], okDecoder)
    expect(out.length).toBe(0)
  })
})
