/**
 * 存储适配器的 A31 用例（#260）：**注入假 `Storage`**，不依赖 jsdom。
 *
 * ## 为什么用假 `Storage` 而不是 jsdom
 *
 * 真实 `localStorage` 的三类失败（配额不足、隐私模式被禁、根本没有存储）
 * **在 jsdom 里造不出来** —— jsdom 的 `localStorage` 永远成功。若只在 jsdom 里测，
 * 那么"失败可见"这条判据测的其实是"成功路径"，与 #249 §14 的
 * 「负对照必须证明确实破坏了目标保证」不符。
 *
 * ⇒ 判据的驱动方式是**注入**一个受控的 `StorageLike`：成功、配额、安全异常、
 * 缺失四种形态都在**同一段生产代码路径**（`browserStoragePort` 的 `try/catch`
 * → `classify`）上被真的走一遍。这一点与本批 `adapters/saveTarget` 的
 * `createUnconditionalTarget`（对照实现）是同一手法。
 *
 * ## 覆盖
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 读写删与键枚举 | 端口的正常面（枚举顺序可复现） |
 * | 配额不足（两种浏览器写法） | `QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED` ⇒ `quotaExceeded` |
 * | 安全异常 | `SecurityError` ⇒ `unavailable('security')`（**不**退化成"读到空"） |
 * | 没有存储 | `unavailable('noStorage')`（**不**退化成 `value: null`） |
 * | 其他异常 | `failed` + 稳定码 |
 * | 两个适配器同端口同语义 | 内存端口与浏览器端口在 `writeRecoveryCopy` 下给出同一组判别式 |
 */

import { describe, expect, it } from 'vitest'
import {
  createMemoryStoragePort,
  quotaFailureOn,
  unavailableFailureOn,
} from '@/adapters/storage/memory'
import { browserStoragePort, storageLikeFromRecord, type StorageLike } from '@/adapters/storage/browser'
import {
  instanceIdentity,
  planRecoveryWrite,
  readRecoveryCopy,
  recoveryStoreKey,
  recoverySourceSnapshot,
  removeRecoveryCopy,
  writeRecoveryCopy,
} from '@/application/recovery'
import { unwrap } from '@/domain/errors'
import { addBlockObject, createDocument, withScene } from '@/domain/document'

const CLOCK = 1_700_000_000_000
const IDENTITY = instanceIdentity('workbench', 'tab-a')

function committedDoc() {
  const doc = createDocument('doc-1')
  return withScene(doc, addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!).doc
}

function planFor(doc = committedDoc()) {
  return unwrap(planRecoveryWrite({ snapshot: recoverySourceSnapshot(doc), identity: IDENTITY, writtenAt: CLOCK }))
}

/** 一个"写入必抛"的假 `Storage`（按名称造出浏览器会抛的异常形态）。 */
function throwingStorage(errorName: string): StorageLike {
  const throwIt = (): never => {
    const e = new Error(`${errorName}: simulated`)
    e.name = errorName
    throw e
  }
  return {
    get length() {
      return throwIt()
    },
    key: throwIt,
    getItem: throwIt,
    setItem: throwIt,
    removeItem: throwIt,
  }
}

describe('A31 存储适配器：注入假 Storage（不依赖 jsdom）', () => {
  it('正常面：set/get/remove/keys 经端口可用，键枚举顺序可复现（已排序）', () => {
    const storage = storageLikeFromRecord({ b: '2', a: '1' })
    const port = browserStoragePort({ storage })

    expect(port.id).toBe('browser')
    expect(port.get('a')).toEqual({ status: 'ok', value: '1' })
    expect(port.set('c', '3').status).toBe('ok')
    expect(port.get('c')).toEqual({ status: 'ok', value: '3' })

    const keys = port.keys()
    expect(keys.status).toBe('ok')
    if (keys.status === 'ok') expect(keys.value, '枚举顺序不得依赖 Storage 的实现顺序').toEqual(['a', 'b', 'c'])

    expect(port.remove('a').status).toBe('ok')
    expect(port.get('a'), '`value: null` 的唯一含义是"键不存在"').toEqual({ status: 'ok', value: null })
  })

  it('键不存在 ≠ 失败：`get` 回 `{status:\'ok\', value:null}`，与三类失败分支不兼表', () => {
    const port = browserStoragePort({ storage: storageLikeFromRecord({}) })
    const got = port.get('nope')
    expect(got.status).toBe('ok')
    expect(got).toEqual({ status: 'ok', value: null })
  })

  it('配额不足（Chrome 写法）：`QuotaExceededError` ⇒ `quotaExceeded`，**不**是 ok', () => {
    const port = browserStoragePort({ storage: throwingStorage('QuotaExceededError') })
    const ack = port.set('k', 'v')
    expect(ack.status).toBe('quotaExceeded')
    if (ack.status === 'quotaExceeded') expect(ack.detail).toBe('QuotaExceededError')
  })

  it('配额不足（Firefox 写法）：`NS_ERROR_DOM_QUOTA_REACHED` 归入**同一**判别式', () => {
    const port = browserStoragePort({ storage: throwingStorage('NS_ERROR_DOM_QUOTA_REACHED') })
    expect(port.set('k', 'v').status, '两个浏览器的配额错误必须映射到同一个分支').toBe('quotaExceeded')
  })

  it('安全异常：`SecurityError` ⇒ `unavailable(security)`（隐私模式/被策略禁用）', () => {
    const port = browserStoragePort({ storage: throwingStorage('SecurityError') })
    const ack = port.set('k', 'v')
    expect(ack.status).toBe('unavailable')
    if (ack.status === 'unavailable') expect(ack.reason).toBe('security')
    // 读路径同样**不**退化成"空值"：不可用不等于"没有内容"。
    expect(port.get('k').status).toBe('unavailable')
  })

  it('没有存储：`storage: null` ⇒ `unavailable(noStorage)`（**不**返回 `value: null`）', () => {
    const port = browserStoragePort({ storage: null })
    for (const ack of [port.get('k'), port.set('k', 'v'), port.remove('k'), port.keys()]) {
      expect(ack.status, '缺存储必须与"键不存在"分开').toBe('unavailable')
      if (ack.status === 'unavailable') expect(ack.reason).toBe('noStorage')
    }
  })

  it('其他异常 ⇒ `failed` + 稳定诊断码（供 #249 §19.9 关联）', () => {
    const port = browserStoragePort({ storage: throwingStorage('InvalidStateError') })
    const ack = port.set('k', 'v')
    expect(ack.status).toBe('failed')
    if (ack.status === 'failed') {
      expect(ack.code).toBe('InvalidStateError')
      expect(ack.detail.length).toBeGreaterThan(0)
    }
  })

  it('`browserStoragePort` 与内存端口是**同一个端口契约**的两实现：同一组判别式、同一件事**都不**被吞', () => {
    const doc = committedDoc()
    const plan = planFor(doc)
    const key = unwrap(recoveryStoreKey(IDENTITY, 'doc-1'))
    expect(plan.key).toBe(key)

    // 成功：两者都给出 ok，且都不含"已保存"字样。
    const okBrowser = writeRecoveryCopy(browserStoragePort({ storage: storageLikeFromRecord({}) }), plan)
    const okMemory = writeRecoveryCopy(createMemoryStoragePort(), plan)
    expect(okBrowser.status).toBe('ok')
    expect(okMemory.status).toBe('ok')
    if (okBrowser.status === 'ok' && okMemory.status === 'ok') {
      for (const outcome of [okBrowser, okMemory]) {
        expect(Object.keys(outcome).sort()).toEqual(['artifact', 'key', 'serializedLength', 'status'])
      }
    }

    // 失败：同一个键上的配额故障，两实现给出**同一**判别式（不是"一个报错一个静默"）。
    const failBrowser = writeRecoveryCopy(browserStoragePort({ storage: throwingStorage('QuotaExceededError') }), plan)
    const failMemory = writeRecoveryCopy(createMemoryStoragePort({ failures: [quotaFailureOn(key)] }), plan)
    expect(failBrowser.status).toBe('quotaExceeded')
    expect(failMemory.status, '端口实现不同不得改变失败判别式').toBe('quotaExceeded')

    // 不可用：同样一致。
    expect(writeRecoveryCopy(browserStoragePort({ storage: null }), plan).status).toBe('unavailable')
    expect(writeRecoveryCopy(createMemoryStoragePort({ failures: [unavailableFailureOn(key)] }), plan).status).toBe('unavailable')
  })

  it('浏览器端口写的副本能被读回并通过校验（端到端：写→读→校验）', () => {
    const storage = storageLikeFromRecord({})
    const port = browserStoragePort({ storage })
    const plan = planFor()
    expect(writeRecoveryCopy(port, plan).status).toBe('ok')

    const read = readRecoveryCopy(port, plan.key)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.raw).toBe(plan.json)
    // 与内存端口读回的**完全一致**（同一份存储表示，不含实现差异）。
    const memPort = createMemoryStoragePort()
    writeRecoveryCopy(memPort, plan)
    const memRead = readRecoveryCopy(memPort, plan.key)
    expect(memRead.status).toBe('ok')
    if (memRead.status === 'ok') expect(memRead.raw).toBe(read.raw)

    // 删除也走端口（用户显式"丢弃副本"）。
    expect(removeRecoveryCopy(port, plan.key).status).toBe('ok')
    expect(readRecoveryCopy(port, plan.key).status).toBe('missing')
  })

  it('**负对照**：`StorageLike` 按插入顺序枚举时，端口返回的是**排序**结果（否则多标签对账不可复现）', () => {
    // 对照形态：`Storage` 的枚举顺序无契约保证 —— 假 Storage 按**插入顺序**给键。
    const storage = storageLikeFromRecord({ z: '1', a: '2' })
    storage.setItem('m', '3')
    const port = browserStoragePort({ storage })

    // 先证明"插入顺序 ≠ 排序结果"（否则本用例是空转）。
    const insertionOrder: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k !== null) insertionOrder.push(k)
    }
    expect(insertionOrder, '假 Storage 确实按插入顺序枚举（证明归一化不是空转）').toEqual(['z', 'a', 'm'])

    const keys = port.keys()
    expect(keys.status).toBe('ok')
    if (keys.status === 'ok') {
      expect(keys.value, '端口必须把枚举归一为排序结果').toEqual(['a', 'm', 'z'])
      expect(keys.value).not.toEqual(insertionOrder)
    }
  })
})
