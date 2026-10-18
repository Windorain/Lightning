/**
 * A19 `resource-release` · A36 `asset-states` · A30 `graphics-recovery` —— 资源生命周期
 * 的判据（**显式计数为主判据**，#249 §14 尾部明文「不以不稳定 GC 时机作唯一判断」）。
 *
 * 三个负对照（#256 验收清单原文）逐条对应本文件的用例：
 *  1. 「少一次 dispose」⇒ `release` 计数不守恒，`ledger().balanced === false`；
 *  2. 「提前释放共享资源」⇒ 一方 release 后另一方读到 `refCount === 0` / 状态异常；
 *  3. 「null 同时代表加载中/缺失/失败」⇒ 与 `resolveAssetReadiness` 的三态判别式对照。
 */

import { describe, expect, it } from 'vitest'
import { AssetStateStore, preflightRequiredAssets, resolveAssetReadiness } from '../assetState'
import { assetRequest, contentIdentityKey, contentVersionOfBytes } from '../assetIdentity'
import { OwnershipRegistry } from '../ownership'
import { ContentCache, deviceScopeCount, nextDeviceScope } from '../resourceCache'
import { DeviceStateMachine, ViewportDeviceRegistry, type DeviceState } from '../deviceState'
// A36（P11-E #262）：内容编辑侧走**真命令层**（另一条轴必须是生产路径，不是手工拼状态）
import { ALL_CAPABILITIES, openDocumentState, reduceCommand } from '@/application/commands'
import { propertyRef } from '@/domain/identity'

const IDENTITY = { id: 'tex:stone', version: 'v1' }

describe('A19 resource-release：归属资源 acquire/release 平衡', () => {
  it('两个视口共享源数据：关闭其一不影响另一方，全部关闭后回基线', () => {
    const registry = new OwnershipRegistry()
    const scopeA = nextDeviceScope('viewport-a')
    const scopeB = nextDeviceScope('viewport-b')
    // 内容身份相同、设备作用域不同 ⇒ 两条独立条目（GPU 句柄不跨 context，§11 明文）
    const entryA = { identity: IDENTITY, deviceScope: scopeA }
    const entryB = { identity: IDENTITY, deviceScope: scopeB }

    let disposedA = 0
    let disposedB = 0
    registry.acquire(entryA, () => { disposedA += 1 })
    registry.acquire(entryB, () => { disposedB += 1 })
    expect(registry.activeCount()).toBe(2)

    // 关闭视口 A ⇒ A 的句柄释放，B 不受影响
    const relA = registry.release(entryA)
    expect(relA).toEqual({ ok: true, key: OwnershipRegistry.key(entryA), released: true, disposed: true })
    expect(disposedA).toBe(1)
    expect(disposedB, 'A 被关闭不得触发 B 的释放').toBe(0)
    expect(registry.refCountOf(entryB), 'B 仍持有其份额').toBe(1)
    expect(registry.activeCount()).toBe(1)

    // 关闭视口 B ⇒ 回基线
    registry.release(entryB)
    expect(disposedB).toBe(1)
    expect(registry.activeCount()).toBe(0)
    expect(registry.ledger().balanced).toBe(true)
  })

  it('重复 100 次「两个视口获取 → 逐个释放」：活跃计数每次归零、账守恒', () => {
    const registry = new OwnershipRegistry()
    let disposed = 0
    for (let i = 0; i < 100; i++) {
      const entryA = { identity: { id: 'tex:shared', version: `v${i}` }, deviceScope: 'a' }
      const entryB = { identity: { id: 'tex:shared', version: `v${i}` }, deviceScope: 'b' }
      registry.acquire(entryA, () => { disposed += 1 })
      registry.acquire(entryB, () => { disposed += 1 })
      expect(registry.activeCount()).toBe(2)
      registry.release(entryA)
      expect(registry.activeCount()).toBe(1)
      registry.release(entryB)
      expect(registry.activeCount(), `第 ${i} 轮必须回基线`).toBe(0)
    }
    const ledger = registry.ledger()
    expect(ledger).toEqual({
      acquireTotal: 200,
      releaseTotal: 200,
      disposeTotal: 200,
      zeroCrossings: 200,
      activeCount: 0,
      liveRefs: 0,
      abandonedTotal: 0,
      lastAbandonReason: '',
      balanced: true,
      atBaseline: true,
    })
    expect(disposed).toBe(200)
  })

  it('共享条目的账：两次 acquire/两次 release 只产生**一次** dispose（不得误报泄漏）', () => {
    const registry = new OwnershipRegistry()
    // 同一作用域内两个消费者（例如同一视口的两个批次引用同一纹理）
    const entry = { identity: IDENTITY, deviceScope: 's-shared' }
    let disposed = 0
    registry.acquire(entry, () => { disposed += 1 })
    registry.acquire(entry, () => { disposed += 1 })
    registry.release(entry)
    registry.release(entry)

    const ledger = registry.ledger()
    expect(ledger.acquireTotal).toBe(2)
    expect(ledger.releaseTotal).toBe(2)
    // 归零只发生一次 —— 这正是"disposeTotal === releaseTotal"这条错误守恒式会误判的地方
    expect(ledger.zeroCrossings).toBe(1)
    expect(ledger.disposeTotal).toBe(1)
    expect(disposed).toBe(1)
    expect(ledger.balanced, '正确的共享行为必须被判为平衡').toBe(true)
  })

  it('同一作用域内多次获取 ⇒ 引用计数累加，只在归零时释放一次', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    let disposed = 0
    registry.acquire(entry, () => { disposed += 1 })
    registry.acquire(entry, () => { disposed += 1 }) // 第二个回调被忽略（非新拥有者）
    expect(registry.refCountOf(entry)).toBe(2)
    registry.release(entry)
    expect(disposed).toBe(0)
    expect(registry.refCountOf(entry)).toBe(1)
    registry.release(entry)
    expect(disposed, '必须恰好释放一次').toBe(1)
    expect(registry.ledger().balanced).toBe(true)
  })

  it('负对照：少一次 dispose ⇒ 份额仍在服役（atBaseline === false 且 liveRefs 暴露它）', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    registry.acquire(entry, () => {})
    registry.acquire(entry, () => {})
    registry.release(entry)
    // 破坏方式：忘记第二次 release
    const ledger = registry.ledger()
    // M8 裁决② 起 `balanced` 是"记账守恒"（每一次 acquire 都有明确去向：
    // 已释放 / 已放弃 / 仍活跃且被计入），而**漏释放**在账上是"仍然活跃"——
    // 它由 `liveRefs`（份额数）与 `atBaseline`（回基线）两个独立读数判红，
    // 分辨力没有降低：漏一次 release ⇒ liveRefs 恰为 1、atBaseline 恰为 false。
    expect(ledger.liveRefs, '少一次 dispose ⇒ 仍有一份份额在服役').toBe(1)
    expect(ledger.atBaseline, '少一次 dispose 必须被判红（活跃计数未回基线）').toBe(false)
    expect(ledger.balanced, '账本身没说谎（份额确实还在，不是丢了账）').toBe(true)
    expect(ledger.acquireTotal).toBe(2)
    expect(ledger.releaseTotal).toBe(1)
    expect(ledger.activeCount).toBe(1)
    // 补上那次 release ⇒ 回基线
    registry.release(entry)
    expect(registry.ledger().liveRefs).toBe(0)
    expect(registry.ledger().atBaseline, '补齐后必须回基线').toBe(true)
  })

  it('负对照：提前释放共享资源 ⇒ 未知条目/计数已零，显式报错', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    registry.acquire(entry, () => {})
    registry.release(entry)
    // 破坏方式：再释放一次（"提前释放"在生产上表现为第二个视口发现资源已经没了）
    const second = registry.release(entry)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('unknown-entry')
    // 破坏方式之二：完全没 acquire 就 release
    const never = registry.release({ identity: IDENTITY, deviceScope: 'never' })
    expect(never.ok).toBe(false)
  })

  it('ContentCache：同内容身份共享同一实例；跨设备作用域各自实例化', () => {
    const cache = new ContentCache()
    let created = 0
    let disposed = 0
    const valueA = cache.acquire(IDENTITY, 'attributes', () => { created += 1; return { n: 1 } }, () => { disposed += 1 })
    const valueB = cache.acquire(IDENTITY, 'attributes', () => { created += 1; return { n: 2 } }, () => { disposed += 1 })
    expect(created, '同内容身份必须共享，不得重复创建').toBe(1)
    expect(valueA).toBe(valueB)

    cache.release(IDENTITY)
    expect(disposed, '仍有引用时不得释放').toBe(0)
    cache.release(IDENTITY)
    expect(disposed).toBe(1)
    expect(cache.ledger().balanced).toBe(true)

    // 设备作用域是单调分配的，不同渲染器必得不同作用域
    const s1 = nextDeviceScope('viewport')
    const s2 = nextDeviceScope('viewport')
    expect(s1).not.toBe(s2)
    expect(deviceScopeCount()).toBeGreaterThanOrEqual(2)
  })

  it('放弃全部（设备丢失）在账上单列，不冒充正常回收（裁决②：按**份额**记账）', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    registry.acquire(entry, () => {})
    registry.acquire(entry, () => {})
    const ledgerBefore = registry.ledger()
    expect(ledgerBefore.liveRefs, '前提：两次 acquire 同一条目 ⇒ 两份份额').toBe(2)
    const abandoned = registry.abandonAll('webgl-context-lost')
    // 放弃的是**份额**（2），不是条目数（1）：balanced 按 acquire 次数记账，
    // 按条目计数会让共享条目永远差一份（裁决② 的 A19 口径）。
    expect(abandoned, '放弃数必须等于被放弃的份额数').toBe(2)
    expect(registry.abandoned.total).toBe(2)
    expect(registry.abandoned.lastReason).toBe('webgl-context-lost')
    expect(registry.activeCount()).toBe(0)
    // 正常账**不**因放弃而变化（放弃是另一类事实，单独记）
    expect(registry.ledger().acquireTotal).toBe(2)
    expect(registry.ledger().releaseTotal, '严禁在 abandonAll 里偷偷加 releaseTotal').toBe(0)
    expect(registry.ledger().abandonedTotal).toBe(2)
    expect(registry.ledger().lastAbandonReason).toBe('webgl-context-lost')
    expect(registry.ledger().balanced, 'acquired(2) === released(0) + abandoned(2) + live(0)').toBe(true)
    expect(registry.ledger().atBaseline).toBe(true)
  })

  it('**新代次重新 acquire 后仍守恒**（acquired === released + abandoned + live）', () => {
    const registry = new OwnershipRegistry()
    const gen1 = { identity: IDENTITY, deviceScope: 's1', deviceGeneration: 1 }
    registry.acquire(gen1, () => {})
    registry.acquire({ ...gen1, identity: { id: 'tex:dirt', version: 'v1' } }, () => {})
    registry.abandonAll('webgl-context-lost')
    // 恢复：同一内容身份在**新代次**重新获取 ⇒ 键不同（代次段进键）
    const gen2 = { identity: IDENTITY, deviceScope: 's1', deviceGeneration: 2 }
    const snap = registry.acquire(gen2, () => {})
    expect(snap.deviceGeneration, '快照必须暴露份额所属设备代次').toBe(2)
    expect(snap.key, '代次进归属键（新旧设备的份额可区分）').toContain('#g2')
    const ledger = registry.ledger()
    expect(ledger.acquireTotal).toBe(3)
    expect(ledger.releaseTotal).toBe(0)
    expect(ledger.abandonedTotal).toBe(2)
    expect(ledger.liveRefs).toBe(1)
    expect(ledger.balanced, '3 === 0 + 2 + 1').toBe(true)
    expect(ledger.activeCount, '恢复后新代次的份额重新建立').toBe(1)
    expect(ledger.atBaseline, '仍有活跃份额 ⇒ 未回基线').toBe(false)
  })
})

describe('A36 asset-states：五态显式、占位与真实资源可区分', () => {
  function store() {
    return new AssetStateStore()
  }

  it('完整状态流转：idle → loading → available（完成事件验证版本）', () => {
    const s = store()
    expect(s.get(IDENTITY.id), '未请求 ⇒ 无记录').toBeUndefined()
    expect(resolveAssetReadiness(s, IDENTITY.id).status).toBe('unavailable')

    const req = assetRequest(IDENTITY, { kind: 'bundled', url: '/tex/stone.png' }, true)
    const { requestId, deduped } = s.begin(req)
    expect(deduped).toBe(false)
    expect(s.get(IDENTITY.id)!.state.phase).toBe('loading')

    expect(s.complete(IDENTITY.id, requestId, 'v1')).toBe(true)
    expect(s.get(IDENTITY.id)!.state).toEqual({ phase: 'available', version: 'v1' })
    expect(resolveAssetReadiness(s, IDENTITY.id)).toEqual({ status: 'ready', version: 'v1' })
  })

  it('并发请求去重：同内容身份在途 ⇒ 复用在途请求', () => {
    const s = store()
    const req = assetRequest(IDENTITY, { kind: 'external', url: 'https://a/1.png' }, true)
    const first = s.begin(req)
    const second = s.begin(req)
    expect(second.deduped).toBe(true)
    expect(second.requestId).toBe(first.requestId)
    expect(s.inflightCount()).toBe(1)
  })

  it('替换资源时旧请求晚到 ⇒ 旧结果被丢弃，不覆盖新版本（A28/A12）', () => {
    const s = store()
    const v1 = assetRequest({ id: 'tex:x', version: 'v1' }, { kind: 'external', url: '/x.png' }, true)
    const r1 = s.begin(v1)
    // 内容被替换：同 id 新版本发起请求（不复用，而是替换权威）
    const v2 = assetRequest({ id: 'tex:x', version: 'v2' }, { kind: 'external', url: '/x.png' }, true)
    const r2 = s.begin(v2)
    expect(r2.deduped).toBe(false)
    expect(r2.requestId).not.toBe(r1.requestId)

    // 旧请求晚到 ⇒ 必须被拒
    expect(s.complete('tex:x', r1.requestId, 'v1'), '旧请求结果不得被接纳').toBe(false)
    expect(s.get('tex:x')!.state.phase).toBe('loading')
    // 新版本到达 ⇒ 接纳
    expect(s.complete('tex:x', r2.requestId, 'v2')).toBe(true)
    expect(s.get('tex:x')!.state).toEqual({ phase: 'available', version: 'v2' })
  })

  it('完成事件内容版本与登记不符 ⇒ 拒绝（不只是 requestId 校验）', () => {
    const s = store()
    const req = assetRequest({ id: 'tex:y', version: 'v1' }, { kind: 'inline', url: '' }, true)
    const { requestId } = s.begin(req)
    expect(s.complete('tex:y', requestId, 'v9')).toBe(false)
    expect(s.get('tex:y')!.state.phase).toBe('loading')
  })

  it('负对照：null 兼表三态 ⇒ 三态判别式必须判红', () => {
    const s = store()
    const loadingReq = assetRequest({ id: 'tex:load', version: 'v1' }, { kind: 'external', url: '/a' }, true)
    s.begin(loadingReq)
    const missingReq = assetRequest({ id: 'tex:miss', version: 'v1' }, { kind: 'external', url: '/b' }, true)
    const m = s.begin(missingReq)
    s.markMissing('tex:miss', m.requestId, '404')
    const failedReq = assetRequest({ id: 'tex:fail', version: 'v1' }, { kind: 'external', url: '/c' }, true)
    const f = s.begin(failedReq)
    s.markFailed('tex:fail', f.requestId, 'decode error', true)

    const loading = resolveAssetReadiness(s, 'tex:load')
    const missing = resolveAssetReadiness(s, 'tex:miss')
    const failed = resolveAssetReadiness(s, 'tex:fail')

    // 三者**必须**是不同判别式 —— 用 null 兼表会让下面三条断言全部塌成一条
    expect(loading.status).toBe('placeholder')
    expect(missing.status).toBe('placeholder')
    expect(failed.status).toBe('placeholder')
    expect(loading.status === 'placeholder' && loading.phase).toBe('loading')
    expect(missing.status === 'placeholder' && missing.phase).toBe('missing')
    expect(failed.status === 'placeholder' && failed.phase).toBe('failed')
    // 且"可重试性"只对 failed 有意义
    expect(s.get('tex:fail')!.state.phase === 'failed' && (s.get('tex:fail')!.state as { retryable: boolean }).retryable).toBe(true)
    expect(s.counts()).toEqual({ idle: 0, loading: 1, available: 0, missing: 1, failed: 1 })
  })

  it('可保留上一可用版本：替换期间状态是 loading 但 heldVersion 指向仍在显示的版本', () => {
    const s = store()
    const v1 = assetRequest({ id: 'tex:z', version: 'v1' }, { kind: 'external', url: '/z' }, true)
    const r1 = s.begin(v1)
    s.complete('tex:z', r1.requestId, 'v1')
    const v2 = assetRequest({ id: 'tex:z', version: 'v2' }, { kind: 'external', url: '/z' }, true)
    s.begin(v2)
    const st = s.get('tex:z')!.state
    expect(st.phase).toBe('loading')
    expect(st.phase === 'loading' && st.heldVersion).toBe('v1')
    // 呈现版本可查询，且**不**被误报为 ready（那会让导出把旧版本当新版本）
    expect(resolveAssetReadiness(s, 'tex:z').status).toBe('placeholder')
  })

  it('内容身份按字节派生（同一 URL 换内容必须换版本）', () => {
    expect(contentVersionOfBytes('abc')).toBe(contentVersionOfBytes('abc'))
    expect(contentVersionOfBytes('abc')).not.toBe(contentVersionOfBytes('abd'))
    // 长度参与，避免"截断到同一哈希前缀"被误判为同版本
    expect(contentVersionOfBytes('a')).not.toBe(contentVersionOfBytes('aa'))
    expect(contentIdentityKey({ id: 'a', version: 'v1' })).toBe('a@v1')
  })

  it('G4：必需资源未就绪 ⇒ 预检列出阻断项；可选资源缺失不阻断', () => {
    const s = store()
    const required = assetRequest({ id: 'tex:req', version: 'v1' }, { kind: 'bundled', url: '/r' }, true)
    const optional = assetRequest({ id: 'tex:opt', version: 'v1' }, { kind: 'bundled', url: '/o' }, false)
    const reqId = s.begin(required)
    const optId = s.begin(optional)
    s.markMissing('tex:opt', optId.requestId, '404')

    const blocking = preflightRequiredAssets(s, [required, optional])
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.id).toBe('tex:req')
    expect(blocking[0]!.phase).toBe('loading')

    // 必需资源就绪后预检通过
    s.complete('tex:req', reqId.requestId, 'v1')
    expect(preflightRequiredAssets(s, [required, optional])).toEqual([])
  })

  it('负对照：占位被当正式资源 ⇒ ready 断言判红', () => {
    const s = store()
    const req = assetRequest({ id: 'tex:ph', version: 'v1' }, { kind: 'external', url: '/p' }, true)
    const r = s.begin(req)
    s.markFailed('tex:ph', r.requestId, 'network', true)
    const readiness = resolveAssetReadiness(s, 'tex:ph')
    expect(readiness.status, '占位绝不能被当成 ready').not.toBe('ready')
    if (readiness.status !== 'placeholder') return
    expect(readiness.heldVersion, '没有上一可用版本 ⇒ 无 heldVersion').toBeUndefined()
  })

  it('清空缓存后回基线（reset）', () => {
    const s = store()
    const r = s.begin(assetRequest(IDENTITY, { kind: 'bundled', url: '/x' }, true))
    s.complete(IDENTITY.id, r.requestId, 'v1')
    expect(s.all()).toHaveLength(1)
    s.reset()
    expect(s.all()).toHaveLength(0)
    expect(s.inflightCount()).toBe(0)
    expect(s.counts()).toEqual({ idle: 0, loading: 0, available: 0, missing: 0, failed: 0 })
  })
})

describe('A30 graphics-recovery：设备状态机与失败隔离', () => {
  it('丢失 ⇒ 不可提交；恢复 ⇒ 推进设备代次、需显式重建并回到可提交', () => {
    const m = new DeviceStateMachine()
    expect(m.canSubmit()).toBe(true)
    expect(m.deviceGeneration, '设备代次从第 1 代起（number，不是结构世代）').toBe(1)
    m.markPresented(0)
    expect(m.heldGeneration(), '已呈现 ⇒ 本代次已服役').toBe(1)

    m.markLost('webglcontextlost', 10)
    expect(m.canSubmit()).toBe(false)
    expect(m.current.phase).toBe('lost')
    expect(m.heldGeneration(), '丢失瞬间仍记录在显示的那一代（设备代次）').toBe(1)

    expect(m.markRecovering(11)).toBe(true)
    expect(m.current.phase).toBe('recovering')
    expect(m.canSubmit()).toBe(false)

    m.markRestored(12)
    expect(m.canSubmit()).toBe(true)
    expect(m.deviceGeneration, '恢复必须推进设备代次（旧代次此后不服役）').toBe(2)
    // 恢复后必须由调用方用**当前有效版本**重新编译并 present
    expect(m.heldGeneration(), '只 markRestored 不重建 ⇒ 本代次尚未呈现').toBeNull()
    m.markPresented(13)
    expect(m.heldGeneration()).toBe(2)
    expect(m.transitions.map((t) => t.to)).toEqual(['ready', 'lost', 'recovering', 'ready', 'ready'])
    expect(m.transitions.map((t) => t.deviceGeneration)).toEqual([1, 1, 1, 2, 2])
  })

  it('**设备代次与结构世代不同空间**：内容编辑不推进代次，只有设备生命周期推进它', () => {
    const m = new DeviceStateMachine()
    // 反复"内容变了 ⇒ 重新呈现"：代次必须**不动**（S3-b 的显式要求）
    for (let i = 0; i < 5; i++) m.markPresented(i)
    expect(m.deviceGeneration, '呈现（内容侧）不得推进设备代次').toBe(1)
    // 只有丢失 → 恢复推进它，且严格递增
    m.markLost('lost', 10)
    m.markRestored(11)
    expect(m.deviceGeneration).toBe(2)
    m.markLost('lost', 20)
    m.markRestored(21)
    expect(m.deviceGeneration).toBe(3)
    expect(typeof m.deviceGeneration, 'S3-b：必须是 number（不得拿 CompileGeneration 冒充）').toBe('number')
  })

  it('恢复失败 ⇒ 可诊断、可重试、保留内容（不进入"已恢复"、不推进代次）', () => {
    const m = new DeviceStateMachine()
    m.markLost('lost', 1)
    m.markRecovering(2)
    m.markRestoreFailed('context create failed', true, 3)
    // 取快照：`current` 是 getter，直接反复读会被 TS 控制流窄化钉在首个分支上
    const failedState: DeviceState = m.current
    expect(failedState.phase).toBe('failed')
    expect(m.canSubmit()).toBe(false)
    expect(m.deviceGeneration, '恢复失败不得推进代次（没有新的有效设备）').toBe(1)
    if (failedState.phase === 'failed') {
      expect(failedState.retryable).toBe(true)
      expect(failedState.reason).toBe('context create failed')
    }

    // 重试路径存在
    expect(m.markRecovering(4)).toBe(true)
    const retryState: DeviceState = m.current
    expect(retryState.phase).toBe('recovering')
    if (retryState.phase === 'recovering') {
      expect(retryState.attempts).toBe(2)
    }
    m.markRestored(5)
    expect(m.canSubmit()).toBe(true)
    expect(m.deviceGeneration, '真正恢复成功才推进').toBe(2)
  })

  it('负对照：只 resize 而不重建 ⇒ heldGeneration 不更新，可被断言抓住', () => {
    const m = new DeviceStateMachine()
    m.markPresented(0)
    expect(m.heldGeneration()).toBe(1)
    m.markLost('lost', 1)
    m.markRecovering(2)
    m.markRestored(3)
    // 破坏方式：恢复后没有用当前有效版本重新 present（只做了 resize）
    expect(m.heldGeneration(), '未重建时 heldGeneration 必须仍为空 —— 这正是负对照的读数').toBeNull()
    expect(m.current.phase).toBe('ready')
  })

  it('两视口失败隔离：一个丢失，另一个继续可提交；注销后退出读面', () => {
    const reg = new ViewportDeviceRegistry()
    const a = reg.machineFor('r-viewport')
    const b = reg.machineFor('r-wiki-preview')
    a.markPresented(0)
    b.markPresented(0)

    a.markLost('webglcontextlost', 1)
    expect(reg.submittableViewports()).toEqual(['r-wiki-preview'])
    expect(reg.pending()).toEqual([{ viewportId: 'r-viewport', state: a.current }])
    expect(reg.summary()).toEqual({ ready: 1, lost: 1, recovering: 0, failed: 0 })

    // b 不受 a 的状态影响（"其他 Area 继续可用"）
    expect(b.canSubmit()).toBe(true)
    expect(b.heldGeneration()).toBe(1)

    a.markRecovering(2)
    a.markRestored(3)
    a.markPresented(4)
    expect(reg.submittableViewports()).toEqual(['r-viewport', 'r-wiki-preview'])
    expect(reg.summary().ready).toBe(2)
    expect(a.deviceGeneration, 'A 的恢复只推进 A 的代次').toBe(2)
    expect(b.deviceGeneration, 'B 的设备生命周期不受 A 的丢失影响').toBe(1)

    // M8-3：视口拆解后不得继续出现在"可提交视口"读面里
    reg.remove('r-wiki-preview')
    expect(reg.submittableViewports()).toEqual(['r-viewport'])
  })

  it('状态转移有界（不无限增长）', () => {
    const m = new DeviceStateMachine(8)
    for (let i = 0; i < 50; i++) {
      m.markLost('flap', i)
      m.markRecovering(i)
      m.markRestored(i)
    }
    expect(m.transitions.length).toBeLessThanOrEqual(8)
    expect(m.deviceGeneration, '50 次真实恢复 ⇒ 代次严格递增到 51').toBe(51)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A36（P11-E #262 补）：资源失败 × 内容编辑 —— 两条轴互不回滚
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这条补的是 A36 的子句缺口（#262 comment 6421 A36 行）
 *
 * B1 的定性：「`markFailed/markMissing` 全树 4 处调用**全在纯存储层测试**，
 * 无任何用例把"资源失败"与"内容编辑"放进同一条断言；承载面已具备」。
 *
 * ## 判据的语义（为什么"放在同一条断言里"不是形式主义）
 *
 * 资源五态（#249 §19.3）与内容编辑（`#249 §6` 的受控提交）是**两条独立的轴**：
 * 纹理加载失败只应让**该资源**进入 `missing`/`failed` 并在呈现上退化为占位，
 * **不应**回滚用户刚做出的内容编辑、也不应清空历史。B1 之所以把它列为缺口，
 * 是因为"两轴互不干扰"此前**没有任何判据**——只有各自的轴被单独测过；
 * 而"资源失败顺手重置文档"（旧实现里"整库失败 ⇒ 重建整个场景"的形态）
 * 恰好只在两轴交叉处才可见。
 *
 * 本组的机械形式：① 先在**真命令层**做出一次内容编辑；② 在**真资源层**让两个
 * 资源分别 `markMissing`/`markFailed`；③ 断言内容事实（内容身份/字段/历史长度/
 * 选择）逐项不变，且失败后**仍能**继续编辑；④ 注入"失败即回滚"的变异体，
 * 喂给**同一个**断言器 ⇒ 判红（证明断言器有区分力，不是恒绿）。
 */
describe('A36 资源失败 × 内容编辑：两条轴互不回滚（P11-E #262 补）', () => {
  /** 内容侧的可核对事实（跨"失败前/失败后"比对的最小闭集）。 */
  type ContentFacts = {
    /** 内容身份摘要（`Version.contentVersion` 在类型上可选 ⇒ 原样保留该宽度，不做 `?? 0` 归一）。 */
    readonly contentVersion: number | undefined
    readonly objectName: string
    readonly historyPast: number
    readonly selection: unknown
  }

  /** 判据本尊（正/负对照共用一份）。 */
  function judgeContentSurvivesAssetFailure(before: ContentFacts, after: ContentFacts): void {
    expect(after.contentVersion, '资源失败不得回滚内容 ⇒ 内容身份必须不变').toBe(before.contentVersion)
    expect(after.objectName, '资源失败不得把字段值退回编辑前').toBe(before.objectName)
    expect(after.historyPast, '资源失败不得清空/改动历史栈').toBe(before.historyPast)
    expect(after.selection, '资源失败不得改选择').toEqual(before.selection)
  }

  /** 断言器判红 = 它抛错。 */
  function redOf(run: () => void): boolean {
    try {
      run()
      return false
    } catch {
      return true
    }
  }

  /** 造"已编辑过一次"的应用状态（真命令层，非手工拼状态）。 */
  function editedState() {
    let st = openDocumentState('doc-1', 'ctx-1')
    const added = reduceCommand(st, { kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' }, { capabilities: ALL_CAPABILITIES })
    expect(added.status).toBe('applied')
    st = added.state
    const objectId = Object.keys(st.docs['doc-1']!.scene.objects)[0]!
    const named = reduceCommand(
      st,
      { kind: 'setProperty', refs: [propertyRef({ kind: 'object', id: objectId }, 'block.name')], value: 'A-edited' },
      { capabilities: ALL_CAPABILITIES },
    )
    expect(named.status, '前置：内容编辑必须真的生效').toBe('applied')
    st = named.state
    const selected = reduceCommand(st, { kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id: objectId } }, { capabilities: ALL_CAPABILITIES })
    expect(selected.status).toBe('applied')
    return { state: selected.state, objectId }
  }

  function factsOf(state: ReturnType<typeof openDocumentState>, objectId: string): ContentFacts {
    const doc = state.docs['doc-1']!
    return {
      contentVersion: doc.version.contentVersion,
      objectName: doc.scene.objects[objectId]!.name,
      historyPast: doc.history.past.length,
      selection: state.contexts['ctx-1']!.selection.selected,
    }
  }

  it('正对照：`markMissing`/`markFailed` 之后，内容/字段/历史/选择逐项不变，且仍可继续编辑', () => {
    const { state, objectId } = editedState()
    const before = factsOf(state, objectId)

    // 资源轴：两个资源分别在途 → 一个缺失、一个失败（真 `AssetStateStore`）
    const s = new AssetStateStore()
    const missingReq = s.begin(assetRequest({ id: 'tex:missing', version: 'v1' }, { kind: 'external', url: '/m.png' }, true))
    const failedReq = s.begin(assetRequest({ id: 'tex:failed', version: 'v1' }, { kind: 'external', url: '/f.png' }, true))
    s.markMissing('tex:missing', missingReq.requestId, '404')
    s.markFailed('tex:failed', failedReq.requestId, 'decode error', true)

    // 资源侧读数（五态里的两态，且**不**冒充 ready）
    expect(resolveAssetReadiness(s, 'tex:missing').status).toBe('placeholder')
    expect(resolveAssetReadiness(s, 'tex:failed').status).toBe('placeholder')
    expect(s.counts()).toEqual({ idle: 0, loading: 0, available: 0, missing: 1, failed: 1 })

    // 内容侧：**逐项不变**（同一个断言器，与负对照共用）
    expect(redOf(() => judgeContentSurvivesAssetFailure(before, factsOf(state, objectId)))).toBe(false)
    // 且状态**引用**都没被资源失败触碰（"没有第二次写"的可核对形式）
    expect(state.docs['doc-1']!.scene.objects[objectId]!.name).toBe('A-edited')

    // 失败之后**仍能**继续编辑（资源失败不冻结内容面）
    const after2 = reduceCommand(
      state,
      { kind: 'setProperty', refs: [propertyRef({ kind: 'object', id: objectId }, 'block.name')], value: 'A-after-failure' },
      { capabilities: ALL_CAPABILITIES },
    )
    expect(after2.status, '资源失败不得冻结内容编辑').toBe('applied')
    if (after2.status === 'applied') {
      expect(after2.state.docs['doc-1']!.scene.objects[objectId]!.name).toBe('A-after-failure')
      expect(after2.state.docs['doc-1']!.history.past.length, '继续编辑照常记历史').toBe(before.historyPast + 1)
    }
    // 撤销也照常（历史里既有编辑仍在）
    const undone = reduceCommand(state, { kind: 'undo', contextId: 'ctx-1' }, { capabilities: ALL_CAPABILITIES })
    expect(undone.status).toBe('applied')
    if (undone.status === 'applied') {
      expect(undone.state.docs['doc-1']!.scene.objects[objectId]!.name, '撤销回到编辑前的值').toBe('A')
    }
  })

  it('**负对照（注入）**：把"资源失败 ⇒ 回滚内容编辑"的变异体喂给同一断言器 ⇒ 判红', () => {
    const { state, objectId } = editedState()
    const before = factsOf(state, objectId)

    // 变异体 A′（**真回滚**，不是伪造读数）：用命令层真的撤销那次内容编辑，
    // 于是"回滚后的内容事实"是**生产实现算出来的**——断言器若抓不到它，
    // 说明它只会对伪造读数判红（判据无效）。
    const rolledBack = reduceCommand(state, { kind: 'undo', contextId: 'ctx-1' }, { capabilities: ALL_CAPABILITIES })
    expect(rolledBack.status, '前置：撤回应生效（这就是"内容被回滚"的真实形态）').toBe('applied')
    expect(
      redOf(() => judgeContentSurvivesAssetFailure(before, factsOf(rolledBack.state, objectId))),
      '内容被**真回滚**（经命令层撤销）⇒ 必须判红',
    ).toBe(true)

    // 变异体 A：失败把内容身份退回编辑前（"整库失败 ⇒ 重建场景"的形态）
    expect(
      redOf(() => judgeContentSurvivesAssetFailure(before, { ...before, contentVersion: (before.contentVersion ?? 0) - 1 })),
      '资源失败回滚内容身份 ⇒ 必须判红',
    ).toBe(true)
    // 变异体 B：失败把字段值退回（内容身份可能因实现不同而不变，字段却已被改回）
    expect(
      redOf(() => judgeContentSurvivesAssetFailure(before, { ...before, objectName: 'A' })),
      '资源失败回滚字段值 ⇒ 必须判红',
    ).toBe(true)
    // 变异体 C：失败清空历史（"重建"最隐蔽的副作用）
    expect(
      redOf(() => judgeContentSurvivesAssetFailure(before, { ...before, historyPast: 0 })),
      '资源失败清空历史 ⇒ 必须判红',
    ).toBe(true)
    // 变异体 D：失败顺手清选择（用户看到"资源坏了，选中也没了"）
    expect(
      redOf(() => judgeContentSurvivesAssetFailure(before, { ...before, selection: [] })),
      '资源失败清选择 ⇒ 必须判红',
    ).toBe(true)
    // 正对照（防恒红）：原读数判绿
    expect(redOf(() => judgeContentSurvivesAssetFailure(before, factsOf(state, objectId)))).toBe(false)
  })
})