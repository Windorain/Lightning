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
import {
  textureResourcesOf,
  textureBindingsOf,
  TEXTURE_STATES,
  TEXTURE_DECODE_CONCURRENCY,
  type TextureDecoder,
  type TextureResourcesProgress,
} from '@/composition/kernelTextureResources'
import {
  bindTexture,
  missingRequiredAssets,
  textureBindingKey,
  textureRequirementsOf,
  type TextureResource,
} from '@/presentation/textureBinding'
import { contentIdentityKey } from '@/presentation/assetIdentity'
import type { ContentResource, TextureAnimationSpec } from '@/domain/content'
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

// ─────────────────────────────────────────────────────────────────────────────
// #399 B1 · 有界并发：乱序完成 + 单张抛错（并发化最容易破坏的两条不变量）
// ─────────────────────────────────────────────────────────────────────────────

describe('#399 B1 · 有界并发（缺陷 A）：下标对齐 / 逐项失败 / 进度计数', () => {
  const N = 24
  /** 注入"坏一张"的下标：不是 0（0 会被"没开始"掩盖），也不是最后一个（会被"末尾"掩盖）。 */
  const BAD = 3

  /**
   * 乱序完成 + 统计在途峰值的解码器。
   *
   * 延迟按**逆序**给（下标越大越先完成）⇒ 完成顺序与输入顺序严格相反：
   * 任何"按完成顺序 push"的实现都会让 out 与入参错位，而本文件的判据逐位钉身份。
   */
  function outOfOrderDecoder(badIndex: number): {
    decode: (payload: string) => Promise<{ width: number; height: number; rgba: Uint8Array }>
    peak: () => number
  } {
    let inFlight = 0
    let peak = 0
    const decode = async (payload: string) => {
      const i = Number(payload.slice(1))
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, (N - i) * 2))
        if (i === badIndex) throw new Error(`注入的解码失败（第 ${i} 张）`)
        return { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) }
      } finally {
        inFlight -= 1
      }
    }
    return { decode, peak: () => peak }
  }

  const resourcesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => resource({ assetId: `r${i}`, payload: `p${i}` }))

  it('乱序完成 + 第 3 张抛错 ⇒ out[3] 为 failed，其余**按位**为 ready（位置即语义）', async () => {
    const d = outOfOrderDecoder(BAD)
    const out = await textureResourcesOf(resourcesOf(N), { decode: d.decode })
    expect(out.length, '并发不得丢项/多项').toBe(N)
    expect(
      out.map((r, i) => (r.state === 'failed' ? i : -1)).filter((i) => i >= 0),
      '**恰好**第 3 张失败（坏一张只坏一张，且是它自己）',
    ).toEqual([BAD])
    for (let i = 0; i < N; i += 1) {
      expect(
        contentIdentityKey(out[i]!.identity),
        `下标 ${i} 必须仍是第 ${i} 张资源（乱序完成不得改变输出位置）`,
      ).toBe(`r${i}@v:r${i}`)
      if (i !== BAD) expect(out[i]!.state, `第 ${i} 张必须可用`).toBe('ready')
    }
    expect(d.peak(), '必须真的并发（否则本判据退化成串行的同义反复）').toBeGreaterThan(1)
    expect(d.peak(), '同时在途不得超过窗口（无界并发会顶内存峰值）').toBeLessThanOrEqual(TEXTURE_DECODE_CONCURRENCY)
  })

  it('onProgress：n 单调不减、起点为 0/total、终态汇总与真实产出逐项一致', async () => {
    const d = outOfOrderDecoder(BAD)
    const events: TextureResourcesProgress[] = []
    const out = await textureResourcesOf(resourcesOf(N), { decode: d.decode }, (p) => events.push(p))

    expect(events.length, '必须至少收到起点与终态').toBeGreaterThan(2)
    expect(events[0], '起点必须是 0/total 的加载中（调用方不必自己拼）').toMatchObject({
      state: 'loading',
      done: 0,
      total: N,
    })
    const dones = events.map((e) => e.done)
    expect(
      dones.every((n, i) => i === 0 || n >= dones[i - 1]!),
      `n 必须单调不减（实测 ${dones.join(',')}）`,
    ).toBe(true)
    expect(Math.max(...dones), '必须走到 n === total（否则进度永远差一截）').toBe(N)

    const last = events[events.length - 1]!
    expect(last.state, '有一张失败 ⇒ 终态是 failed，不是 ready').toBe('failed')
    expect(last.done).toBe(N)
    expect(last.failed, '终态失败数').toBe(1)
    expect(last.ready, '终态可用数').toBe(N - 1)
    expect(last.ready + last.failed + last.unrequested, '终态三类计数必须补齐总数').toBe(N)
    expect(last.ready, '汇总必须与真实产出一致').toBe(out.filter((r) => r.state === 'ready').length)
    expect(last.failed, '汇总必须与真实产出一致').toBe(out.filter((r) => r.state === 'failed').length)
  })

  it('全部成功 ⇒ 终态 ready、ready 数等于总数（不得把"没失败"漏报成别的相位）', async () => {
    const events: TextureResourcesProgress[] = []
    const out = await textureResourcesOf(resourcesOf(6), okDecoder, (p) => events.push(p))
    expect(out.every((r) => r.state === 'ready')).toBe(true)
    const last = events[events.length - 1]!
    expect(last.state).toBe('ready')
    expect(last.ready).toBe(6)
    expect(last.failed).toBe(0)
  })

  it('进度上报抛错是**旁路**：不得把已解码的纹理伪装成失败（报表坏了 ≠ 资源坏了）', async () => {
    const out = await textureResourcesOf(resourcesOf(5), okDecoder, () => {
      throw new Error('注入：进度上报抛错')
    })
    expect(out.length).toBe(5)
    expect(
      out.every((r) => r.state === 'ready'),
      '上报抛错若冒泡，会把整批结果变成 failed —— 两种事实必须可区分',
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5-3b：纹理序列（就绪 ⇒ 派生；缺席 = 静态）
// ─────────────────────────────────────────────────────────────────────────────

/** 16×64 竖条像素（4 格）——格数由像素尺寸推，不由声明推。 */
const stripDecoder: TextureDecoder = {
  decode: async () => ({ width: 16, height: 64, rgba: new Uint8Array(16 * 64 * 4) }),
}

const STRIP_ANIMATION: TextureAnimationSpec = Object.freeze({
  defaultFrametimeTicks: 2,
  frameSequence: Object.freeze([
    Object.freeze({ index: 0 }),
    Object.freeze({ index: 1, timeTicks: 3 }),
    Object.freeze({ index: 2, timeTicks: 1 }),
    Object.freeze({ index: 3, timeTicks: 2 }),
  ]),
})

describe('M5-3b · 纹理资源派生序列（`textureAnimationOf` 的生产接线）', () => {
  it('生产形状的 ContentResource（animated + 声明 + 16×64 像素）⇒ 资源带 animation', async () => {
    const out = await textureResourcesOf(
      [resource({ assetId: 'material:0', payload: 'p0', kind: 'animated', animation: STRIP_ANIMATION })],
      stripDecoder,
    )
    expect(out[0]!.state).toBe('ready')
    const animation = out[0]!.animation
    expect(animation, '就绪 + 竖条 ⇒ 必须派生序列').toBeDefined()
    expect(animation!.stripFrameCount).toBe(4)
    expect(animation!.sequence.frames.map((f) => f.duration.num / f.duration.den)).toEqual([0.1, 0.15, 0.05, 0.1])
  })

  it('绑定生产点把 `resource.animation` 带进 `TextureBinding`（唯一绑定构造点）', async () => {
    const out = await textureResourcesOf(
      [resource({ assetId: 'material:0', payload: 'p0', kind: 'animated', animation: STRIP_ANIMATION })],
      stripDecoder,
    )
    const bindings = textureBindingsOf({ materials: [material('material:0')], resources: out })
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.animation, '绑定必须带序列（presenter 的每帧采样输入）').toBeDefined()
    expect(bindings[0]!.animation!.stripFrameCount).toBe(4)
  })

  it('负对照：kind=static16 ⇒ 即使像素是 16×64 竖条，animation **缺席**', async () => {
    const out = await textureResourcesOf(
      [resource({ assetId: 'material:0', payload: 'p0', kind: 'static16', animation: STRIP_ANIMATION })],
      stripDecoder,
    )
    expect(out[0]!.state).toBe('ready')
    expect(out[0]!.animation, 'kind 不是 animated ⇒ 不采样').toBeUndefined()
    expect('animation' in out[0]!, '缺席就是缺席（不得写出 animation: undefined）').toBe(false)
    const bindings = textureBindingsOf({ materials: [material('material:0')], resources: out })
    expect(bindings[0]!.animation).toBeUndefined()
  })

  it('越界/负索引与非法时长**归一化**后仍出序列，且资源不得被标 failed（贴图本身可用）', async () => {
    const out = await textureResourcesOf(
      [
        resource({
          assetId: 'material:0',
          payload: 'p0',
          kind: 'animated',
          animation: { defaultFrametimeTicks: 0, frameSequence: [{ index: -5 }, { index: 9, timeTicks: 0 }] },
        }),
      ],
      stripDecoder,
    )
    expect(out[0]!.state, '坏声明不是坏贴图').toBe('ready')
    const animation = out[0]!.animation!
    expect(animation.sequence.frames.map((f) => f.index), '取模 + 默认 tick').toEqual([3, 1])
    expect(animation.sequence.frames.map((f) => f.duration.num / f.duration.den)).toEqual([0.05, 0.05])
  })

  it('未解码/失败 ⇒ 无 animation（不猜帧数）', async () => {
    const out = await textureResourcesOf([resource({ assetId: 'ext', payload: null })], stripDecoder)
    expect(out[0]!.state).toBe('unrequested')
    expect(out[0]!.animation).toBeUndefined()
  })

  it('绑定键含序列：只有动画声明不同的两个绑定 ⇒ 键不同', async () => {
    const base = bindTexture(material('material:0'), {
      identity: { id: 'material:0', version: 'v1' },
      required: true,
      state: 'ready',
    })
    const animated = bindTexture(material('material:0'), {
      identity: { id: 'material:0', version: 'v1' },
      required: true,
      state: 'ready',
      animation: {
        sequence: {
          id: 'material:0',
          resource: { assetId: 'material:0', contentVersion: 'v1', url: '' },
          frames: [{ index: 0, duration: { num: 1, den: 20 } }],
          loop: 'loop',
        },
        stripFrameCount: 4,
      },
    })
    expect(textureBindingKey(base)).not.toBe(textureBindingKey(animated))
    expect(textureBindingKey(base)).toContain('|an:-')
    expect(textureBindingKey(animated)).toContain('|an:')
  })
})

