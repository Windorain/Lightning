/**
 * 资源诊断发射点（`resource.*` 族）的判据。
 *
 * ## 本文件证什么（D2/D7 + 画面形态）
 *
 * 1. **可定位**：失败记录带 `assetId`（不是只有计数）；
 * 2. **有界**：一次同步 57 张失败不会写 57 条（否则挤爆容量 512 的共享记录器）；
 * 3. **不静默降级**：有绑定指向未就绪资源 ⇒ 必有 `resource.degraded`；
 * 4. **通道不互染**：资源事实**不**落 `effect` / `recovery` 通道（后者会被 S6-b 判据误伤）；
 * 5. **重试/恢复**：显式重试发 `resource.retryRequested`，从失败转就绪发 `resource.recovered`。
 *
 * 负对照写在每条断言旁：把对应行为改坏（不封顶 / 不带 assetId / 不区分通道）
 * 都会让某一条红。
 */

import { describe, expect, it } from 'vitest'
import {
  RESOURCE_FAILURE_REPORT_MAX,
  createResourceDiagnostics,
  type ResourceOutcomeFacts,
} from '@/composition/resourceDiagnostics'
import type { DiagnosticRecord } from '@/application/diagnostics'
import type { TextureResource } from '@/presentation/textureBinding'

/** 收集器：把 `record(` 的入参收成记录列表（`seq`/`at` 由记录器分配，这里不需要）。 */
function collector(): {
  records: DiagnosticRecord[]
  recorder: { record(entry: Omit<DiagnosticRecord, 'seq' | 'at'>): DiagnosticRecord }
} {
  const records: DiagnosticRecord[] = []
  let seq = 0
  return {
    records,
    recorder: {
      record(entry) {
        const full = { ...entry, seq: ++seq, at: 0 } as DiagnosticRecord
        records.push(full)
        return full
      },
    },
  }
}

/** 一条五态资源（只填本模块读的字段）。 */
function resource(id: string, state: TextureResource['state'], failure?: string): TextureResource {
  return {
    identity: { id, version: `v:${id}` },
    locator: { kind: 'inline', url: `gregtech:iconsets/${id}` },
    state,
    pixels: null,
    ...(failure === undefined ? {} : { failure }),
  } as TextureResource
}

function facts(over: Partial<ResourceOutcomeFacts> & { resources: readonly TextureResource[] }): ResourceOutcomeFacts {
  return {
    viewportId: 'r-viewport',
    degradedMaterials: 1,
    missingRequired: 1,
    attempt: 0,
    ...over,
  }
}

describe('resource.* 诊断', () => {
  it('失败逐条记录**点名** assetId + locator（D7：只报计数不可定位）', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(
      facts({
        resources: [
          resource('GODFORGE_TRIM', 'failed', '解码返回 null（字节不是可解码图像）'),
          resource('ok', 'ready'),
        ],
      }),
    )
    const failed = records.filter((r) => r.code === 'resource.failed')
    expect(failed, '一张失败 ⇒ 恰好一条逐条记录').toHaveLength(1)
    expect(failed[0]!.params.assetId).toBe('GODFORGE_TRIM')
    expect(String(failed[0]!.params.locator)).toContain('GODFORGE_TRIM')
    expect(failed[0]!.params.state).toBe('failed')
    expect(failed[0]!.params.reason).toContain('解码')
    expect(failed[0]!.channel, '资源事实落 resource 通道').toBe('resource')
    expect(failed[0]!.correlation.viewportId, '多 Area 可定位是哪一侧').toBe('r-viewport')
  })

  it('**有界**：57 张坏图只写 %s 条逐条记录 + 一条汇总（负对照：不封顶 ⇒ 57 条）'.replace('%s', String(RESOURCE_FAILURE_REPORT_MAX)), () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    const resources = Array.from({ length: 57 }, (_, i) => resource(`r${i}`, 'failed'))
    port.reportOutcome(facts({ resources, degradedMaterials: 57 }))
    const failed = records.filter((r) => r.code === 'resource.failed')
    expect(failed).toHaveLength(RESOURCE_FAILURE_REPORT_MAX)
    const degraded = records.filter((r) => r.code === 'resource.degraded')
    expect(degraded, '降级汇总必须有且只有一条').toHaveLength(1)
    expect(degraded[0]!.params.failed, '汇总里给出真实条数').toBe(57)
    expect(degraded[0]!.params.omitted, '被省略的条数必须显式').toBe(57 - RESOURCE_FAILURE_REPORT_MAX)
    expect(records.length, '总记录数仍受记录器容量支配').toBeLessThanOrEqual(RESOURCE_FAILURE_REPORT_MAX + 1)
  })

  it('**不静默降级**：绑定指向未就绪资源 ⇒ 必有 resource.degraded（即使逐条记录被上界截掉）', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(
      facts({ resources: [resource('ok', 'ready')], degradedMaterials: 0, missingRequired: 0 }),
    )
    expect(records.filter((r) => r.code === 'resource.degraded'), '全部就绪 ⇒ 零降级记录（反恒真）').toHaveLength(0)

    records.length = 0
    port.reportOutcome(facts({ resources: [resource('x', 'failed')], degradedMaterials: 3, missingRequired: 2 }))
    const degraded = records.filter((r) => r.code === 'resource.degraded')
    expect(degraded).toHaveLength(1)
    expect(degraded[0]!.params.degradedMaterials, '材质条数与资源条数分开给，不互相冒充').toBe(3)
    expect(degraded[0]!.params.missingRequired).toBe(2)
    expect(degraded[0]!.params.total).toBe(1)
  })

  it('**未请求（外链）不得冒充就绪**（D8）：`unrequested` 进汇总的 `unrequested` 计数，不与 `failed` 混计', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(
      facts({
        resources: [resource('ok', 'ready'), resource('ext', 'unrequested')],
        // `resource()` 给了 locator ⇒ 它是"外链未取回"（会被计入）
        degradedMaterials: 1,
        missingRequired: 0,
      }),
    )
    const degraded = records.filter((r) => r.code === 'resource.degraded')
    expect(degraded, '有未请求资源 ⇒ 必须有汇总（否则"全就绪"是假就绪）').toHaveLength(1)
    expect(degraded[0]!.params.unrequested, '未请求单独计数').toBe(1)
    expect(degraded[0]!.params.failed, '未请求**不得**被算成失败（"没人去取"≠"取回来是坏的"）').toBe(0)
    expect(records.filter((r) => r.code === 'resource.failed'), '未请求不产逐条失败记录').toHaveLength(0)

    // 边界：`payload===null && locator===''` = "本来就没有贴图"，**不得**算成未请求。
    records.length = 0
    port.reportOutcome(
      facts({
        resources: [
          resource('ok', 'ready'),
          { identity: { id: 'plain', version: 'v:plain' }, locator: { kind: 'inline', url: '' }, state: 'unrequested', pixels: null } as TextureResource,
        ],
        degradedMaterials: 0,
        missingRequired: 0,
      }),
    )
    expect(records.filter((r) => r.code === 'resource.degraded'), '无贴图材质不得被算成"没到"').toHaveLength(0)
  })

  it('**通道不互染**：所有记录只在 resource 通道，码只在 resource.* 族', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(facts({ resources: [resource('a', 'failed'), resource('b', 'missing')] }))
    port.reportRetryRequested({ viewportId: 'r-viewport', failed: ['a', 'b'], attempt: 1 })
    port.reportOutcome(facts({ resources: [resource('a', 'ready'), resource('b', 'ready')] }))
    expect(records.length, '反空洞真：确实产生了记录').toBeGreaterThan(0)
    for (const r of records) {
      expect(r.channel, '不得借 effect/recovery 通道（S6-b 会按 recovery 过滤）').toBe('resource')
      expect(r.code.startsWith('resource.'), '码必须在 resource.* 族：' + r.code).toBe(true)
    }
  })

  it('重试后从失败转就绪 ⇒ resource.recovered（占位恢复为正常呈现）', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(facts({ resources: [resource('a', 'failed'), resource('b', 'ready')] }))
    expect(port.failedAssets('r-viewport')).toEqual(['a'])
    records.length = 0
    port.reportOutcome(facts({ resources: [resource('a', 'ready'), resource('b', 'ready')], degradedMaterials: 0, missingRequired: 0, attempt: 1 }))
    const recovered = records.filter((r) => r.code === 'resource.recovered')
    expect(recovered, '失败转就绪必须有一条恢复记录（否则"重试成功"在账上不可见）').toHaveLength(1)
    expect(recovered[0]!.params.assetId).toBe('a')
    expect(recovered[0]!.params.attempt).toBe(1)
    expect(port.failedAssets('r-viewport'), '失败集已收敛').toEqual([])
  })

  it('显式重试请求发 resource.retryRequested，且点名失败资源（有界：最多 3 条入参）', () => {
    const { records, recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportRetryRequested({ viewportId: 'r-viewport', failed: ['a', 'b', 'c', 'd', 'e'], attempt: 2 })
    const retried = records.filter((r) => r.code === 'resource.retryRequested')
    expect(retried).toHaveLength(1)
    expect(retried[0]!.params.attempt).toBe(2)
    expect(retried[0]!.params.failed).toBe(5)
    expect(String(retried[0]!.params.assets)).toBe('a,b,c')
  })

  it('视口之间互不覆盖（失败集按 viewportId 分桶）', () => {
    const { recorder } = collector()
    const port = createResourceDiagnostics(recorder)
    port.reportOutcome(facts({ viewportId: 'r-a', resources: [resource('x', 'failed')] }))
    port.reportOutcome(facts({ viewportId: 'r-b', resources: [resource('y', 'ready')], degradedMaterials: 0, missingRequired: 0 }))
    expect(port.failedAssets('r-a')).toEqual(['x'])
    expect(port.failedAssets('r-b')).toEqual([])
  })
})
