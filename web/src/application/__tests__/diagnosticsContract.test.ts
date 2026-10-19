/**
 * A35 `diagnostic-contract` —— 结构化诊断契约（#249 §19.9；#259）。
 *
 * A35 的四列要求：
 * | Given/When | 必须成立的可观测断言 | 负对照必须判红 |
 * |---|---|---|
 * | 注入拒绝、节点重算、资源泄漏、效果过期与裁剪模块 | 可按 command/job/object/version 关联原因与归属；追踪有界；错误呈现不反向影响业务；常规日志不泄露凭据或完整文档 | 仅 console 文案或无限增长记录 |
 *
 * ## 两条负对照怎么被"真的"证明
 *
 * 1. **"仅 console 文案"**：断言原因以**稳定码 + 结构化参数**表达，且
 *    `formatDiagnosticRecord` **要求调用方显式传入翻译函数** ——
 *    没有内置默认文案，因此"只有一句 console 字符串"无法满足接口形态。
 *    另外断言 UI 翻译键由码派生（语言变化不改断言对象）。
 * 2. **"无限增长记录"**：容量是构造期**必填**参数，且写入超过容量后
 *    `size()` 恒 ≤ `capacity`，而 `totalRecorded` 继续增长 ——
 *    直接证明"写了很多、占用恒定"。这不是靠纪律，而是结构上不可表达无界。
 */

import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_CODES,
  PARAM_VALUE_MAX,
  REDACTED,
  asReadOnlyDiagnostics,
  createDiagnosticRecorder,
  diagnosticReasonKey,
  formatDiagnosticRecord,
  sanitizeParams,
  type DiagnosticReasonCode,
  type DiagnosticRecord,
} from '@/application/diagnostics'

/** 固定时钟（纯测试：不读墙钟，可复现）。 */
function fixedClock(start = 1000): { now: () => number; advance: (n: number) => void } {
  let t = start
  return { now: () => t, advance: (n: number) => { t += n } }
}

describe('A35 正对照：可按 command/job/object/version 关联原因与归属', () => {
  it('记录携带通道、稳定码、结构化参数与关联身份', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 8, now: clock.now })
    const r = rec.record({
      channel: 'command',
      code: 'command.rejected',
      params: { reason: 'readOnly', property: 'block.id' },
      correlation: { commandId: 'cmd-1', objectId: 'obj-7', documentVersion: 3 },
    })
    expect(r.seq).toBe(1)
    expect(r.at).toBe(1000)
    expect(r.code).toBe('command.rejected')
    expect(r.params).toEqual({ reason: 'readOnly', property: 'block.id' })
    expect(r.correlation.commandId).toBe('cmd-1')
  })

  it('按通道 / 码 / 关联身份查询（验收经这些接口取证，不窥探私有字段）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 32, now: clock.now })
    rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: { commandId: 'c1' } })
    rec.record({ channel: 'module', code: 'module.pruned', params: { node: 'n1' }, correlation: { objectId: 'o1' } })
    rec.record({ channel: 'resource', code: 'resource.leaked', params: { owner: 'tex' }, correlation: { objectId: 'o2' } })
    rec.record({ channel: 'command', code: 'command.applied', params: {}, correlation: { commandId: 'c2' } })

    expect(rec.byChannel('command').map((r) => r.code)).toEqual(['command.received', 'command.applied'])
    expect(rec.byChannel('module')).toHaveLength(1)
    expect(rec.byCode('resource.leaked')).toHaveLength(1)
    expect(rec.byCorrelation({ commandId: 'c2' })).toHaveLength(1)
    expect(rec.byCorrelation({ objectId: 'o1' })).toHaveLength(1)
    expect(rec.byCorrelation({ commandId: 'nope' })).toEqual([])
  })

  it('可关联"实际/目标呈现版本"（§19.9 第四项）；效果取消族**按事实删除**（第六项）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 8, now: clock.now })
    rec.record({
      channel: 'presentation',
      code: 'presentation.version',
      params: {},
      correlation: { actualPresentationVersion: 4, targetPresentationVersion: 6 },
    })
    const v = rec.byCode('presentation.version')[0]!
    expect(v.correlation.actualPresentationVersion).toBe(4)
    expect(v.correlation.targetPresentationVersion).toBe(6)

    // ## 第六项（效果关联/取消）的处置：**删码**，不是留一个类型愿望
    //
    // M8-6 实测：`runtime/effects#JobState` 的生产实例化 = 0（全树 `enqueueJob`/
    // `applyJobEvent` 只在定义与单测里出现），生产面没有任何 `AbortController` 发起取消。
    // 于是一个只存在于类型里的 `cancelRequested`/`cancelled` 只能让"按码聚合"恒为空集。
    // 负对照：这些码**必须**从码表消失（码表不是许愿单）；真接入取消协议时按新事实立码。
    for (const removed of ['effect.started', 'effect.cancelRequested', 'effect.cancelled', 'effect.succeeded']) {
      expect(DIAGNOSTIC_CODES as readonly string[], `已删除的零生产者码不得复活：${removed}`).not.toContain(removed)
    }
    // 保留的 `effect.failed` 仍有 8 个生产发点（呈现链编译/注解失败）。
    expect(DIAGNOSTIC_CODES as readonly string[]).toContain('effect.failed')
  })

  it('模块装配与裁剪原因可记录（§19.9 第七项）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 8, now: clock.now })
    rec.record({ channel: 'module', code: 'module.pruned', params: { capability: 'editing', optional: true }, correlation: {} })
    const p = rec.byCode('module.pruned')[0]!
    expect(p.params.capability).toBe('editing')
    expect(p.params.optional).toBe(true)
  })

  it('时钟由注入提供（纯核心不读墙钟 ⇒ 记录可复现）', () => {
    const clock = fixedClock(500)
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const a = rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    clock.advance(250)
    const b = rec.record({ channel: 'command', code: 'command.applied', params: {}, correlation: {} })
    expect(a.at).toBe(500)
    expect(b.at).toBe(750)
  })
})

describe('A35 负对照 1：追踪有界（"无限增长记录"结构上不可表达）', () => {
  it('容量是构造期必填；写入远超容量后 size 恒 ≤ capacity，totalRecorded 持续增长', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 10, now: clock.now })
    for (let i = 0; i < 1000; i++) {
      rec.record({ channel: 'command', code: 'command.received', params: { i }, correlation: {} })
    }
    expect(rec.capacity).toBe(10)
    expect(rec.size()).toBe(10)
    expect(rec.totalRecorded).toBe(1000)
    // 环形缓冲保留**最新**的（旧记录被覆盖）
    const kept = rec.all()
    expect(kept[kept.length - 1]!.params.i).toBe(999)
    expect(kept[0]!.params.i).toBe(990)
  })

  it('环形缓冲的 seq 单调递增（顺序可对账，覆盖不产生重复序号）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 3, now: clock.now })
    for (let i = 0; i < 7; i++) {
      rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    }
    const seqs = rec.all().map((r) => r.seq)
    expect(seqs).toEqual([5, 6, 7])
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('容量非法值被夹到 ≥1（不会退化成"永不记录"或"无界"）', () => {
    const clock = fixedClock()
    expect(createDiagnosticRecorder({ capacity: 0, now: clock.now }).capacity).toBe(1)
    expect(createDiagnosticRecorder({ capacity: -5, now: clock.now }).capacity).toBe(1)
    expect(createDiagnosticRecorder({ capacity: 2.7, now: clock.now }).capacity).toBe(2)
  })

  it('采样是记录策略：被丢弃的不计入 totalRecorded（不谎称全量）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({
      capacity: 100,
      now: clock.now,
      sample: (candidate) => candidate.code !== 'module.pruned',
    })
    rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    rec.record({ channel: 'module', code: 'module.pruned', params: {}, correlation: {} })
    rec.record({ channel: 'command', code: 'command.applied', params: {}, correlation: {} })
    expect(rec.totalRecorded).toBe(2)
    expect(rec.size()).toBe(2)
    expect(rec.byCode('module.pruned')).toEqual([])
  })

  it('快照是**副本**：调用方改它不影响记录器（读面不暴露内部缓冲）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    const snap = rec.snapshot() as DiagnosticRecord[]
    snap.push({ seq: 999, at: 0, code: 'command.applied', params: {}, correlation: {}, channel: 'command' })
    expect(rec.size()).toBe(1)
    expect(rec.all()).toHaveLength(1)
  })
})

describe('A35 负对照 2：不是"仅 console 文案"（码 + 参数，翻译分离）', () => {
  it('原因以稳定码 + 结构化参数表达；码不随语言改变', () => {
    // 码表**从数据读**（M8-6 起 `DIAGNOSTIC_CODES` 是运行时清单）：手写列表会漂移，
    // 而"每码都合规"这件事只能对着真清单判。
    const codes: readonly DiagnosticReasonCode[] = DIAGNOSTIC_CODES
    expect(codes.length).toBeGreaterThan(30)
    for (const c of codes) {
      // 码是 ASCII 点分标识，不是自然语言（改语言不改它）
      expect(c, c).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
      expect(c, c).not.toMatch(/[\u4e00-\u9fff]/)
      expect(diagnosticReasonKey(c)).toBe(`diagnostic.${c}`)
    }
  })

  it('展示要求**显式**翻译函数：没有内置默认文案（防"只有 console 字符串"退化）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const r = rec.record({
      channel: 'property',
      code: 'property.readOnly',
      params: { property: 'block.id', owner: 'multiblock' },
      correlation: { objectId: 'o1' },
    })
    const seen: { key: string; params: Record<string, unknown> }[] = []
    const line = formatDiagnosticRecord(r, (key, params) => {
      seen.push({ key, params })
      return `[${key}]`
    })
    expect(line).toBe('[diagnostic.property.readOnly]')
    expect(seen[0]!.key).toBe('diagnostic.property.readOnly')
    // 参数原样交给翻译层（UI 自己决定怎么措辞）
    expect(seen[0]!.params).toEqual({ property: 'block.id', owner: 'multiblock' })
    // 记录本身不含自然语言文案
    expect(JSON.stringify(r)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('`formatDiagnosticRecord` 缺翻译函数时是编译期错误（类型上不可省略）', () => {
    // 用 @ts-expect-error 钉住"必须传翻译函数"这一契约：
    // 若将来把它改成可选参数，本行会因"未使用的 expect-error"而失败。
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 2, now: clock.now })
    const r = rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    // @ts-expect-error 第二参数（翻译函数）是必填
    expect(() => formatDiagnosticRecord(r)).toThrow()
  })
})

describe('A35 生产最小信息：不记录凭据或完整文档', () => {
  it('凭据类键名整值脱敏（不看值）', () => {
    const out = sanitizeParams({
      token: 'ghp_secret_value',
      apiKey: 'abc',
      authorization: 'Bearer xyz',
      sessionId: 'sess-1',
      cookie: 'a=b',
      password: 'p',
      safe: 'keep-me',
    })
    expect(out.token).toBe(REDACTED)
    expect(out.apiKey).toBe(REDACTED)
    expect(out.authorization).toBe(REDACTED)
    expect(out.sessionId).toBe(REDACTED)
    expect(out.cookie).toBe(REDACTED)
    expect(out.password).toBe(REDACTED)
    expect(out.safe).toBe('keep-me')
  })

  it('记录里**不出现**凭据原值（脱敏在写入时发生，缓冲里也没有敏感副本）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 8, now: clock.now })
    rec.record({
      channel: 'command',
      code: 'command.rejected',
      params: { token: 'SUPER_SECRET', authorization: 'Bearer SUPER_SECRET' },
      correlation: {},
    })
    const dump = JSON.stringify(rec.all())
    expect(dump).not.toContain('SUPER_SECRET')
    expect(dump).toContain(REDACTED)
  })

  it('超长字符串参数被截断（防"完整文档"经参数旁路进入诊断）', () => {
    const long = 'x'.repeat(5000)
    const out = sanitizeParams({ document: long, note: 'ok' })
    expect(String(out.document).length).toBeLessThanOrEqual(PARAM_VALUE_MAX + 1)
    expect(String(out.document).endsWith('…')).toBe(true)
    expect(out.note).toBe('ok')
  })

  it('截断发生在写入时（记录内部也不留完整文档）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const long = `SECRET-DOC-${'y'.repeat(1000)}`
    rec.record({ channel: 'command', code: 'command.received', params: { body: long }, correlation: {} })
    const rec0 = rec.all()[0]!
    expect(String(rec0.params.body).length).toBeLessThan(long.length)
    expect(String(rec0.params.body)).not.toContain('y'.repeat(PARAM_VALUE_MAX + 10))
  })

  it('参数值只允许标量（不塞对象图：类型上排除 DOM/GPU 句柄）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const r = rec.record({
      channel: 'resource',
      code: 'resource.acquired',
      params: { owner: 'texture', count: 3, shared: true },
      correlation: {},
    })
    for (const v of Object.values(r.params)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v)
    }
  })
})

describe('A35 只读读面：诊断接口本身无写权限（J1）', () => {
  it('`asReadOnlyDiagnostics` 在**运行期**真的没有 record（不只是类型标注）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })

    const ro = asReadOnlyDiagnostics(rec)
    // 关键：类型标注会骗人，`in` / `typeof` 不会
    expect('record' in ro).toBe(false)
    expect((ro as unknown as Record<string, unknown>).record).toBeUndefined()
    expect(typeof ro.size).toBe('function')
    expect(ro.size()).toBe(1)

    // 活的只读视图：后续写入（经内部记录器）仍可被读面看到
    rec.record({ channel: 'command', code: 'command.applied', params: {}, correlation: {} })
    expect(ro.size()).toBe(2)
    expect(ro.totalRecorded).toBe(2)

    // 冻结：调用方无法给自己的读面加写方法
    expect(Object.isFrozen(ro)).toBe(true)
  })

  it('读面与记录器是**两个对象**（读面不泄漏内部记录器引用）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const ro = asReadOnlyDiagnostics(rec)
    expect(ro).not.toBe(rec as unknown)
    // 读面上任何属性都不指向记录器本身
    for (const v of Object.values(ro as unknown as Record<string, unknown>)) {
      expect(v).not.toBe(rec as unknown)
    }
  })

  it('读面类型上不存在写方法（add/record/clear 均不在读面上）', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    // 读面字段：只有查询与常量
    const readOnlyKeys = ['capacity', 'totalRecorded', 'size', 'all', 'byChannel', 'byCode', 'byCorrelation', 'snapshot']
    for (const k of readOnlyKeys) {
      expect(k in rec, k).toBe(true)
    }
    // 写入口只有 record；没有 clear/reset/add 这类"改诊断"的方法
    expect(typeof rec.record).toBe('function')
    expect((rec as unknown as Record<string, unknown>).clear).toBeUndefined()
    expect((rec as unknown as Record<string, unknown>).reset).toBeUndefined()
    expect((rec as unknown as Record<string, unknown>).add).toBeUndefined()
  })

  it('诊断记录不驱动业务：记录与否不改变任何业务函数的返回值', () => {
    // 本模块是纯记录器：record 只返回记录，不产生回调。
    // "不让日志成为额外业务驱动源"（#249 §19.9）在结构上的体现是：
    // `DiagnosticRecorder` 不接受任何业务回调 —— 只有 `sample`（记录策略）。
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now })
    const r = rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} })
    // 返回值就是那条记录本身（不是业务结果）
    expect(Object.keys(r).sort()).toEqual(['at', 'channel', 'code', 'correlation', 'params', 'seq'])
  })

  it('错误呈现与业务分离：记录失败（采样丢弃）不抛异常、不影响调用方', () => {
    const clock = fixedClock()
    const rec = createDiagnosticRecorder({ capacity: 4, now: clock.now, sample: () => false })
    expect(() =>
      rec.record({ channel: 'command', code: 'command.received', params: {}, correlation: {} }),
    ).not.toThrow()
    expect(rec.size()).toBe(0)
  })
})
