/**
 * `adapters/saveTarget` —— **保存目标写入的串行化与远端条件版本**。
 *
 * ## 为什么核心层不够，还要一个适配器层
 *
 * `domain/document` 的 `SaveLedger` 已经把保存竞态的**语义**判据钉住了：
 * `beginSave` 在途时返回 `null`（串行化）、`completeSave` 只在**绑定代数相符**且
 * `committed` 时推进基线、且基线取**该请求捕获的基线值**。
 *
 * 但这些是**决策**，不是**执行**。保存目标写入的要求是：
 *
 * > 每个保存目标写入**串行化**，或由远端条件版本控制保证顺序；
 * > **仅忽略旧响应不足以阻止旧请求最后覆盖远端**。
 *
 * 后半句指向的正是"本地决策正确、远端仍被覆盖"这一独立失败模式：
 * 两次写入都在途时，**旧的那次**可能最后到达远端。本地忽略它的响应不能撤销
 * 已经写进远端的内容。⇒ 需要在**写入通道**上做两件事之一：
 *
 * | 手段 | 本文件 |
 * |---|---|
 * | **串行化**写入（前一个未完成不发下一个） | {@link SaveCoordinator.enqueue} 经 `SaveLedger` 的 `beginSave` |
 * | **远端条件版本**（compare-and-set） | {@link SaveTargetPort.write} 携带 `expectedRevision`；远端已变 ⇒ 拒绝 |
 *
 * 两者**同时**启用（本文件的默认组合）：串行化管住本实例的并发，
 * 条件版本管住**别的**写入者（另一个标签页、另一个设备、宿主后台任务）在两次读之间插队。
 *
 * ## 本模块**不**重新实现任何核心政策
 *
 * 它只做三件事：把请求交给端口、把端口的结局翻译回 `SaveOutcome`、把结局送回
 * `completeSave`。所有"基线怎么推进""旧绑定要不要回写"的判定都在 `domain/document`
 * 里 —— 若在那里再写一份，就会出现两套"什么算保存成功"的定义。
 *
 * ## 保存竞态负对照的可执行形态
 *
 * 「仅忽略响应却允许旧请求覆盖远端」：{@link createUnconditionalTarget} 是那个**对照实现**
 * （无条件写入、只按到达顺序记录），测试用它证明"条件版本不是可选项"。
 */

import {
  beginSave,
  completeSave,
  createSaveLedger,
  rebindSaveLedger,
  type Document,
  type SaveLedger,
  type SaveOutcome,
  type SaveRequest,
} from '@/domain/document'
import { invalidValue, versionConflict, type DomainError, type Result, ok, err } from '@/domain/errors'

// ─────────────────────────────────────────────────────────────────────────────
// 端口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 保存目标端口（由具体适配器实现：内存/浏览器存储/宿主 REST…）。
 *
 * ## 为什么 `write` **必须**接收 `expectedRevision`
 *
 * 把条件版本放进签名而不是"让实现自己决定"：保存规则允许"串行化**或**条件版本"，
 * 但一旦选择条件版本，`expectedRevision` 就是那条要求的**唯一**落点。
 * 签名里没有它，"我以为我也做了条件检查"就无法与"真的做了"区分。
 */
export interface SaveTargetPort {
  /** 目标身份（诊断与多目标串行化用；不是 URL）。 */
  readonly targetId: string
  /** 读取当前远端修订号（条件比较的基准）。 */
  readRevision(): Result<number>
  /**
   * **条件写入**：仅当远端修订等于 `expectedRevision` 时成功。
   *
   * 失败必须是结构化的：修订不符 ⇒ `VersionConflict`（内核契约 §4.2 的"提交所依据的版本
   * 已不是当前版本"）；存储不可用 ⇒ `UnsupportedOperation`；内容非法 ⇒ `InvalidValue`。
   * **不得**返回"成功"而没写。
   */
  write(input: {
    readonly request: SaveRequest
    readonly bytes: Uint8Array
    readonly expectedRevision: number
  }): Result<{ readonly revision: number }>
}

/** 内容序列化端口（由 `adapters/files` 或调用方提供；本模块只需"给定场景得字节"）。 */
export interface SaveSerializePort {
  serialize(request: SaveRequest): Result<Uint8Array>
}

// ─────────────────────────────────────────────────────────────────────────────
// 协调器
// ─────────────────────────────────────────────────────────────────────────────

/** 一次保存发起的结局（**发起**不等于完成）。 */
export type SaveDispatch =
  | { readonly kind: 'dispatched'; readonly request: SaveRequest; readonly revision: number }
  | { readonly kind: 'rejected'; readonly error: DomainError }

/** 一次保存完成的结局（翻译自端口 + 核心判定）。 */
export interface SaveResolution {
  readonly ledger: SaveLedger
  readonly doc: Document
  /** 核心是否接纳了这次完成（推进了基线）。 */
  readonly applied: boolean
  /** 送往核心的结局分类（`superseded` = 旧绑定/序号不符，不写回）。 */
  readonly outcome: SaveOutcome
  /** 端口层是否真的写到了远端（`superseded` 时为 `false`）。 */
  readonly wroteRemote: boolean
}

/**
 * 保存协调器：把"发起保存 → 端口条件写入 → 完成事件"接成一条链。
 *
 * ## 串行化在哪
 *
 * `dispatch()` 调 `beginSave`：在途时返回 `null` ⇒ 本函数返回 `rejected`
 * （与 `application/commands.reduceSave` 同一判据 `saveAlreadyInFlight`）。
 * 于是"两次并发写入"在本实例内**不可能发生**。
 *
 * ## 条件版本在哪
 *
 * `dispatch()` 先读一次 `readRevision()`，把它作为 `expectedRevision` 交给 `write`。
 * 若在读写之间**别的**写入者推进了远端修订，`write` 返回 `VersionConflict` ⇒
 * `resolve()` 把它翻成 `{kind:'failed'}` ⇒ `completeSave` **不**推进基线。
 *
 * ## 旧绑定在哪
 *
 * `rebind()` 推进绑定代数（`rebindSaveLedger`）并清在途。`resolve()` 用**当前**
 * 绑定代数调用 `completeSave`，于是迟到的完成事件拿到 `applied: false`。
 */
export class SaveCoordinator {
  private ledger: SaveLedger
  private doc: Document
  private bindingGeneration: number

  constructor(
    private readonly opts: {
      readonly doc: Document
      readonly target: SaveTargetPort
      readonly serialize: SaveSerializePort
      readonly ledger?: SaveLedger
    },
  ) {
    this.doc = opts.doc
    this.ledger = opts.ledger ?? createSaveLedger()
    this.bindingGeneration = this.ledger.bindingGeneration
  }

  get currentLedger(): SaveLedger {
    return this.ledger
  }

  get currentDocument(): Document {
    return this.doc
  }

  /**
   * 发起一次保存。
   *
   * 顺序：**先** `beginSave`（串行化判定）→ **再** 序列化捕获的基线值 → **再** 读远端修订
   * → **最后** 条件写入。顺序不可换：先读修订再判定串行化会让"两次并发"产生两次读，
   * 而第二次读会拿到"第一次写完之后"的修订，于是条件检查形同虚设。
   */
  dispatch(currentDoc: Document): SaveDispatch {
    this.doc = currentDoc
    const started = beginSave(this.ledger, currentDoc, this.bindingGeneration)
    if (started === null) {
      return Object.freeze({
        kind: 'rejected' as const,
        error: invalidValue({ reason: 'saveAlreadyInFlight', documentId: currentDoc.id }),
      })
    }
    this.ledger = started.ledger
    const request = started.request

    const bytes = this.opts.serialize.serialize(request)
    if (!bytes.ok) {
      // 序列化失败：释放在途槽位（否则永久卡死），不改基线。
      this.ledger = Object.freeze({ ...this.ledger, inFlight: null })
      return Object.freeze({ kind: 'rejected' as const, error: bytes.error })
    }

    const rev = this.opts.target.readRevision()
    if (!rev.ok) {
      this.ledger = Object.freeze({ ...this.ledger, inFlight: null })
      return Object.freeze({ kind: 'rejected' as const, error: rev.error })
    }

    const written = this.opts.target.write({ request, bytes: bytes.value, expectedRevision: rev.value })
    if (!written.ok) {
      this.ledger = Object.freeze({ ...this.ledger, inFlight: null })
      return Object.freeze({ kind: 'rejected' as const, error: written.error })
    }

    return Object.freeze({ kind: 'dispatched' as const, request, revision: written.value.revision })
  }

  /**
   * 结算一次保存（把端口结局送回核心）。
   *
   * `remoteOk` 是**端口层**的事实（写到远端了吗）；核心只认 `SaveOutcome`。
   * 两条判据在此交汇：
   *  - 远端失败 ⇒ `{kind:'failed'}` ⇒ 不推进基线（失败不改基线）；
   *  - 绑定已重绑 ⇒ `completeSave` 返回 `applied: false`（旧完成事件不回写）。
   */
  resolve(request: SaveRequest, remoteOk: boolean, failureCode = 'IO'): SaveResolution {
    const outcome: SaveOutcome = remoteOk ? { kind: 'committed' } : { kind: 'failed', code: failureCode }
    const result = completeSave(this.ledger, this.doc, request, outcome, this.bindingGeneration)
    this.ledger = result.ledger
    this.doc = result.doc
    return Object.freeze({
      ledger: result.ledger,
      doc: result.doc,
      applied: result.applied,
      outcome,
      wroteRemote: remoteOk,
    })
  }

  /**
   * 重绑/关闭文档：推进绑定代数并丢弃在途写入。
   *
   * 内核契约 §3.3：「文档关闭也释放租约、取消归属作业。**资源加载回调不能重新激活已关闭的交互**」。
   */
  rebind(): void {
    this.ledger = rebindSaveLedger(this.ledger)
    this.bindingGeneration = this.ledger.bindingGeneration
  }

  /** 当前绑定代数（诊断与断言用）。 */
  get binding(): number {
    return this.bindingGeneration
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 目标实现
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **条件版本**目标（内存实现；`revision` 由目标自己拥有）。
 *
 * `revision` 每次成功写入 +1；`write` 只在 `expectedRevision === revision` 时成功，
 * 否则 `VersionConflict`。于是"另一个写入者插队"必然表现为可见的失败 ——
 * 这正是"旧请求不能覆盖远端"的机械判据。
 */
export function createConditionalTarget(targetId = 'mem') {
  const state = { revision: 0, bytes: new Uint8Array(0), writes: 0, conflicts: 0 }
  const port: SaveTargetPort = {
    targetId,
    readRevision: () => ok(state.revision),
    write: ({ bytes, expectedRevision }) => {
      if (expectedRevision !== state.revision) {
        state.conflicts += 1
        return err(versionConflict({ target: targetId, expected: expectedRevision, actual: state.revision }))
      }
      state.revision += 1
      state.writes += 1
      state.bytes = new Uint8Array(bytes)
      return ok({ revision: state.revision })
    },
  }
  return {
    port,
    stats: () => Object.freeze({ ...state, bytes: state.bytes }),
    /** 模拟"另一个标签页/另一台设备"直接写远端（不经过本协调器）。 */
    externalWrite(bytes: Uint8Array = new Uint8Array([0xff])) {
      state.revision += 1
      state.bytes = new Uint8Array(bytes)
      return state.revision
    },
  }
}

/**
 * **对照实现**：无条件写入目标（保存竞态负对照的载体）。
 *
 * 它"也做了版本检查"—— 但检查发生在**响应处理**处（`recordResponse`），
 * 写入本身无条件。于是两次写入都到远端，旧的那次最后到达即覆盖新的那次。
 * 本实现存在的唯一目的是让测试能证明"仅忽略响应不足以阻止覆盖"。
 */
export function createUnconditionalTarget(targetId = 'naive') {
  const state = { revision: 0, bytes: new Uint8Array(0), arrivals: [] as number[] }
  const port: SaveTargetPort = {
    targetId,
    readRevision: () => ok(state.revision),
    write: ({ bytes, request }) => {
      // 无条件写：忽略 `expectedRevision`（这正是负对照的"缺陷"）
      state.revision += 1
      state.arrivals.push(request.sequence)
      state.bytes = new Uint8Array(bytes)
      return ok({ revision: state.revision })
    },
  }
  return {
    port,
    stats: () => Object.freeze({ ...state, arrivals: Object.freeze([...state.arrivals]), bytes: state.bytes }),
    /**
     * 模拟"旧请求的响应最后到达"：把远端内容改成旧请求写的那份。
     *
     * 真实系统里这是网络乱序；本函数把它变成一次可复现的注入。
     */
    applyStaleOverwrite(bytes: Uint8Array) {
      state.bytes = new Uint8Array(bytes)
      return state.bytes
    },
  }
}

/** 便捷：把 `Document` 的**捕获内容**序列化成字节（默认实现：规范化 JSON 的 UTF-8）。 */
export function jsonSerializePort(): SaveSerializePort {
  return {
    serialize(request) {
      const text = JSON.stringify({
        documentId: request.documentId,
        sequence: request.sequence,
        contentVersion: request.capturedVersion.contentVersion ?? 0,
        objects: Object.keys(request.capturedScene.objects).sort(),
      })
      const out = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
      return ok(out)
    },
  }
}
