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
      balanced: true,
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

  it('负对照：少一次 dispose ⇒ 账不守恒（balanced === false）', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    registry.acquire(entry, () => {})
    registry.acquire(entry, () => {})
    registry.release(entry)
    // 破坏方式：忘记第二次 release
    const ledger = registry.ledger()
    expect(ledger.balanced, '少一次 dispose 必须被判红').toBe(false)
    expect(ledger.acquireTotal).toBe(2)
    expect(ledger.releaseTotal).toBe(1)
    expect(ledger.activeCount).toBe(1)
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

  it('放弃全部（设备丢失）在账上单列，不冒充正常回收', () => {
    const registry = new OwnershipRegistry()
    const entry = { identity: IDENTITY, deviceScope: 's1' }
    registry.acquire(entry, () => {})
    registry.acquire(entry, () => {})
    const abandoned = registry.abandonAll('webgl-context-lost')
    expect(abandoned).toBe(1)
    expect(registry.abandoned.total).toBe(1)
    expect(registry.abandoned.lastReason).toBe('webgl-context-lost')
    expect(registry.activeCount()).toBe(0)
    // 正常账**不**因放弃而变化（放弃是另一类事实，单独记）
    expect(registry.ledger().acquireTotal).toBe(2)
    expect(registry.ledger().releaseTotal).toBe(0)
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
  it('丢失 ⇒ 不可提交；恢复 ⇒ 需显式重建并回到可提交', () => {
    const m = new DeviceStateMachine()
    expect(m.canSubmit()).toBe(true)
    m.markPresented('g:1', 0)

    m.markLost('webglcontextlost', 10)
    expect(m.canSubmit()).toBe(false)
    expect(m.current.phase).toBe('lost')
    expect(m.heldGeneration(), '丢失瞬间仍记录在显示的那一代').toBe('g:1')

    expect(m.markRecovering(11)).toBe(true)
    expect(m.current.phase).toBe('recovering')
    expect(m.canSubmit()).toBe(false)

    m.markRestored(12)
    expect(m.canSubmit()).toBe(true)
    // 恢复后必须由调用方用**当前有效版本**重新编译并 present
    expect(m.heldGeneration()).toBeNull()
    m.markPresented('g:2', 13)
    expect(m.heldGeneration()).toBe('g:2')
    expect(m.transitions.map((t) => t.to)).toEqual(['ready', 'lost', 'recovering', 'ready', 'ready'])
  })

  it('恢复失败 ⇒ 可诊断、可重试、保留内容（不进入"已恢复"）', () => {
    const m = new DeviceStateMachine()
    m.markLost('lost', 1)
    m.markRecovering(2)
    m.markRestoreFailed('context create failed', true, 3)
    // 取快照：`current` 是 getter，直接反复读会被 TS 控制流窄化钉在首个分支上
    const failedState: DeviceState = m.current
    expect(failedState.phase).toBe('failed')
    expect(m.canSubmit()).toBe(false)
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
  })

  it('负对照：只 resize 而不重建 ⇒ heldGeneration 不更新，可被断言抓住', () => {
    const m = new DeviceStateMachine()
    m.markPresented('g:1', 0)
    m.markLost('lost', 1)
    m.markRecovering(2)
    m.markRestored(3)
    // 破坏方式：恢复后没有用当前有效版本重新 present（只做了 resize）
    expect(m.heldGeneration(), '未重建时 heldGeneration 必须仍为空 —— 这正是负对照的读数').toBeNull()
    expect(m.current.phase).toBe('ready')
  })

  it('两视口失败隔离：一个丢失，另一个继续可提交', () => {
    const reg = new ViewportDeviceRegistry()
    const a = reg.machineFor('r-viewport')
    const b = reg.machineFor('r-wiki-preview')
    a.markPresented('g:1', 0)
    b.markPresented('g:1', 0)

    a.markLost('webglcontextlost', 1)
    expect(reg.submittableViewports()).toEqual(['r-wiki-preview'])
    expect(reg.pending()).toEqual([{ viewportId: 'r-viewport', state: a.current }])
    expect(reg.summary()).toEqual({ ready: 1, lost: 1, recovering: 0, failed: 0 })

    // b 不受 a 的状态影响
    expect(b.canSubmit()).toBe(true)
    expect(b.heldGeneration()).toBe('g:1')

    a.markRecovering(2)
    a.markRestored(3)
    a.markPresented('g:2', 4)
    expect(reg.submittableViewports()).toEqual(['r-viewport', 'r-wiki-preview'])
    expect(reg.summary().ready).toBe(2)
  })

  it('状态转移有界（不无限增长）', () => {
    const m = new DeviceStateMachine(8)
    for (let i = 0; i < 50; i++) {
      m.markLost('flap', i)
      m.markRecovering(i)
      m.markRestored(i)
    }
    expect(m.transitions.length).toBeLessThanOrEqual(8)
  })
})
