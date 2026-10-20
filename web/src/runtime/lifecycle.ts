/**
 * `runtime/lifecycle` —— **作用域与资源清理**：编辑器实例与归属资源的记账（#249 §3.4 §10；
 * 契约 §6 所有权表末行）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #10 的**资源**半边）
 *
 * 旧实现里"切换工作台视图"用 `v-show` 把整个 `<WorkbenchShell>` 保活在 DOM 里，
 * 于是：
 *  - 「切走再切回状态还在」靠的是**组件从没被卸载**；
 *  - 「关闭 Area 释放运行资源」**无法发生** —— 因为没有任何东西被关闭，
 *    渲染器、监听器、作业全都随着那个隐藏的 DOM 子树活着。
 *
 * 本模块给"实例与它的资源"一个**显式登记处**，使 A13 的那条判据
 * ——「关闭后实例/监听/作业回到预期基线」—— 成为**可测量**的事实：
 *
 * ```
 * acquire('i1', 'renderer')   → 活跃计数 { renderer: 1 }
 * ...
 * releaseInstance('i1')       → 活跃计数 {}        ← 回基线
 * ```
 *
 * ## 为什么记账是**纯状态**，而"真正 dispose"是接线层的事
 *
 * #249 §2.1：「接线层负责获取输入、调用规则、持有运行实例、调度、发起效果、
 * 管理订阅和释放资源」。⇒ 本模块只做**记账与判定**：
 *  - `acquire`/`release` 返回新的账本，不改输入；
 *  - `leaks()` 报告"哪些实例还持有资源"（诊断，§19.9）；
 *  - 真正调 `renderer.dispose()` 由 `editors/AreaHost.vue` 的 `onBeforeUnmount` 做。
 *
 * 分成两层的好处是**可测试**：账本可以在 Node 里跑 100 次循环并对账，
 * 不需要 WebGL（A13 的 100 次循环因此不需要浏览器）。
 *
 * ## 计数回基线的判据
 *
 * `totalActive()` 为 0 ⇔ 所有资源都还回去了。
 * 这不等于"内存一定释放了"（JS 的 GC 时机不可作为判据 ——
 * A19 明文：「不以不稳定 GC 时机作唯一判断」）。
 * 故主判据是**显式计数**，与本模块同族。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 资源种类
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归属资源的种类（#249 §3.4 末行「GPU 缓冲、纹理、DOM、Worker 句柄 |
 * 适配器/呈现器 | 显式获取、引用计数或独占释放」）。
 *
 * 开放字符串是刻意的：新编辑器类型会带来新的资源种类，
 * 核心不为它加一个枚举分支（与 A21「无核心 switch」同一纪律）。
 */
export type ResourceKind = string

/** 一个实例的登记项。 */
export interface InstanceRecord {
  readonly instanceId: string
  /** 该实例拥有的编辑器类型（供诊断与"切回恢复"对账）。 */
  readonly editorType: string
  /** 该实例当前**持有**的资源：种类 → 计数。 */
  readonly resources: Readonly<Record<ResourceKind, number>>
}

/** 资源账本（纯值）。 */
export interface LifecycleLedger {
  readonly instances: Readonly<Record<string, InstanceRecord>>
  /**
   * 已释放实例的**累计**记录（只增）。
   *
   * 为什么要留它：A13「关闭后实例/监听/作业回到预期基线」需要两个方向的对账 ——
   * "现在还有几个活的"与"一共释放过几个"。只留前者的话，
   * "从未创建过"与"创建后都释放了"不可区分（那是同一类假绿）。
   * 它只存**计数**，不存实例对象（不是泄漏源）。
   */
  readonly releasedTotal: number
}

export function createLifecycleLedger(): LifecycleLedger {
  return Object.freeze({ instances: Object.freeze({}), releasedTotal: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// 登记 / 释放
// ─────────────────────────────────────────────────────────────────────────────

/** 打开一个编辑器实例（Area 挂载时调用）。已存在同 id 时返回 `null`（不静默覆盖）。 */
export function openInstance(ledger: LifecycleLedger, instanceId: string, editorType: string): LifecycleLedger | null {
  if (Object.prototype.hasOwnProperty.call(ledger.instances, instanceId)) return null
  return Object.freeze({
    ...ledger,
    instances: Object.freeze({
      ...ledger.instances,
      [instanceId]: Object.freeze({ instanceId, editorType, resources: Object.freeze({}) }),
    }),
  })
}

/**
 * 为一个实例获取一份资源（引用计数 +1）。
 *
 * 实例未登记时返回 `null` —— 这是**显式失败**：
 * "给一个不存在的实例加资源"意味着调用顺序错了（先 acquire 后 open），
 * 静默接受会让账本与实际持有不一致，从而让 `leaks()` 说谎。
 */
export function acquireResource(ledger: LifecycleLedger, instanceId: string, kind: ResourceKind): LifecycleLedger | null {
  const rec = ledger.instances[instanceId]
  if (!rec) return null
  const next: InstanceRecord = Object.freeze({
    ...rec,
    resources: Object.freeze({ ...rec.resources, [kind]: (rec.resources[kind] ?? 0) + 1 }),
  })
  return Object.freeze({ ...ledger, instances: Object.freeze({ ...ledger.instances, [instanceId]: next }) })
}

/**
 * 释放一份资源（引用计数 -1；归零时删掉该键）。
 *
 * 计数为 0 时释放返回 `null`（**过度释放**是缺陷，不静默钳到 0）——
 * 否则"少一次 dispose"与"多一次 dispose"会得到同一个账本，
 * 而 A19 的两条负对照正是这两个方向。
 */
export function releaseResource(ledger: LifecycleLedger, instanceId: string, kind: ResourceKind): LifecycleLedger | null {
  const rec = ledger.instances[instanceId]
  if (!rec) return null
  const cur = rec.resources[kind] ?? 0
  if (cur <= 0) return null
  const resources: Record<string, number> = { ...rec.resources }
  if (cur === 1) delete resources[kind]
  else resources[kind] = cur - 1
  const next: InstanceRecord = Object.freeze({ ...rec, resources: Object.freeze(resources) })
  return Object.freeze({ ...ledger, instances: Object.freeze({ ...ledger.instances, [instanceId]: next }) })
}

/**
 * 释放整个实例（Area 卸载/关闭时调用）。
 *
 * 返回 `{ ledger, released }`：
 *  - `released` 是该实例**仍然持有**的资源清单 —— 非空表示调用方
 *    **没有**逐一 release 就在关实例（资源泄漏，A13 的红灯）；
 *  - 已登记但无资源的实例正常移除。
 */
export function closeInstance(ledger: LifecycleLedger, instanceId: string): { ledger: LifecycleLedger; released: Readonly<Record<ResourceKind, number>> } | null {
  const rec = ledger.instances[instanceId]
  if (!rec) return null
  const instances = { ...ledger.instances }
  delete instances[instanceId]
  return {
    ledger: Object.freeze({ ...ledger, instances: Object.freeze(instances), releasedTotal: ledger.releasedTotal + 1 }),
    released: rec.resources,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定（A13 / A19 的判据面）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 全部活跃实例持有的资源总数（**主判据**）。
 *
 * A13：「关闭后实例/监听/作业回到预期基线」⇔ 本函数返回 0。
 * 用显式计数而非内存统计：GC 时机不可作为判据（A19 明文）。
 */
export function totalActive(ledger: LifecycleLedger): number {
  let n = 0
  for (const rec of Object.values(ledger.instances)) {
    for (const c of Object.values(rec.resources)) n += c
  }
  return n
}

/** 按种类汇总活跃计数（供诊断与"每类回基线"的分项断言）。 */
export function activeByKind(ledger: LifecycleLedger): Readonly<Record<ResourceKind, number>> {
  const out: Record<string, number> = {}
  for (const rec of Object.values(ledger.instances)) {
    for (const [k, c] of Object.entries(rec.resources)) out[k] = (out[k] ?? 0) + c
  }
  return Object.freeze(out)
}

/** 活跃实例 id（稳定排序）。 */
export function activeInstanceIds(ledger: LifecycleLedger): readonly string[] {
  return Object.freeze(Object.keys(ledger.instances).sort())
}

/** 一个实例是否还持有资源。 */
export function hasResources(ledger: LifecycleLedger, instanceId: string): boolean {
  const rec = ledger.instances[instanceId]
  if (!rec) return false
  return Object.keys(rec.resources).length > 0
}

/**
 * 泄漏报告（诊断面，§19.9）。
 *
 * 返回**仍持有资源**的活跃实例；调用方在关闭一批 Area 之后查它，
 * 非空即表示有资源没人还。
 */
export function leaks(ledger: LifecycleLedger): readonly InstanceRecord[] {
  return Object.freeze(
    Object.values(ledger.instances)
      .filter((rec) => Object.keys(rec.resources).length > 0)
      .sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)),
  )
}

/** 账本摘要（供测试与诊断对账，不参与语义）。 */
export function ledgerSummary(ledger: LifecycleLedger): {
  readonly activeInstances: number
  readonly activeResources: number
  readonly releasedTotal: number
} {
  return Object.freeze({
    activeInstances: Object.keys(ledger.instances).length,
    activeResources: totalActive(ledger),
    releasedTotal: ledger.releasedTotal,
  })
}
