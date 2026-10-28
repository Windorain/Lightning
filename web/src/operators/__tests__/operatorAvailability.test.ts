/**
 * **算子可用性结算**的判据（单一 gate + 可见拒绝 + 求值次数）。
 *
 * ## 这条判据要钉的四件事
 *
 * | # | 判据 | 防的缺陷形态 |
 * |---|---|---|
 * | ① | 非 Wiki 载入文档 ⇒ **不可用且原因给出下一步**（"另存为 Wiki 结构"） | 旧形态：菜单可点、点了只写 info（"点了没反应"） |
 * | ② | 直接入口（`registry.invoke`，即 Ctrl+S 的同一条路）⇒ **底栏成句拒绝**，与菜单**同一句** | 旧形态：只有 `log.info`，用户无可见原因 |
 * | ③ | 有可审计变更 ⇒ **可用**（正对照）+ `invoke` 真的打开确认模态 | "拒绝"可能只是"整条路坏了" |
 * | ④ | 未声明 `pollReason` 的算子 ⇒ **通用原因**（不 TypeError）且 exec/invoke 保持旧行为 | 把"撤销栈空/没选中"也变成拒绝噪声 |
 *
 * ## 输入来自生产（铁律⑦）
 *
 * 能力集合 = `resolveComposition(WIKI_PROFILE)` 的解析结果；算子 = 生产
 * `registerWorkbenchOperators`；产物 plain = 生产 `plainForSave()`（真 `KernelSession`）；
 * 底栏读面 = 生产 `createLogCenter().liveStatus`（`origin: 'rejection'`）。
 * 全部装配见 `availabilityTestHost`。
 */
import { describe, expect } from 'vitest'
import { LOG_LEVEL } from '@/logging/LogCenter'
import { POLL_REASON, operatorAvailability, type OperatorAvailabilityInput } from '@/operators/availability'
import { WikiSaveConfirmOperator } from '@/operators/builtin/wikiOperators'
import { makeAvailabilityHost } from './availabilityTestHost'
import { withRealFixture } from '../../../e2e/real-fixture-vitest'

/** 底栏的拒绝文案（生产 `liveStatus` 的 `rejection` 渠道；无则 `null`）。 */
function rejectionOf(log: { readonly liveStatus: { readonly value: { message: string; level: number; origin: string | null } | null } }) {
  return log.liveStatus.value
}

describe('算子可用性：唯一结算点', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '能力缺口优先于 poll：`requires` 缺一项 ⇒ 不可用且点名能力（不再进 poll）',
    async () => {
    const host = await makeAvailabilityHost('wiki-dirty')
    try {
      // 负对照：把能力集合清空（= 非 Wiki 外壳）
      ;(host.ctx as unknown as { capabilities: readonly string[] }).capabilities = []
      let pollCalls = 0
      const op: OperatorAvailabilityInput = {
        id: 'OPERATOR_PROBE_REQUIRES',
        label: '探针',
        requires: ['wiki.upload'],
        poll: () => {
          pollCalls += 1
          return true
        },
      }
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled).toBe(false)
      if (a.enabled) throw new Error('unreachable')
      expect(a.source, '缺能力是**装配事实**，必须先结算成它').toBe('capability')
      expect(a.capability).toBe('wiki.upload')
      expect(a.reason, '原因必须点名缺的能力').toContain('wiki.upload')
      expect(pollCalls, '能力门拒绝后不得再求值 poll（那是第二条判定）').toBe(0)
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '未声明 `pollReason` ⇒ 通用原因（不 TypeError），且 exec/invoke 保持旧行为（只记 info）',
    async () => {
    const host = await makeAvailabilityHost('wiki-clean')
    try {
      const id = 'OPERATOR_PROBE_GENERIC_POLL'
      host.registry.register({
        id,
        label: '通用原因探针',
        poll: () => false,
        // ⚠️ 故意**不**实现 pollReason —— 钉"可选字段"这条契约
      })
      const op = host.registry.find(id)!
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled).toBe(false)
      if (a.enabled) throw new Error('unreachable')
      expect(a.source, '没声明原因 ⇒ 走通用路径').toBe('poll-generic')
      expect(a.reason.length, '通用原因也必须是一句话（不能是空串/未定义）').toBeGreaterThan(0)
      expect(a.reason).toContain('前提')

      const before = host.log.entries.value.length
      host.registry.invoke(host.ctx, id, {})
      const added = host.log.entries.value.slice(before)
      expect(added.some((e) => e.message.includes('poll failed')), '旧行为：留一条 info 可查').toBe(true)
      expect(
        added.filter((e) => e.level === LOG_LEVEL.WARN),
        '通用 poll 拒绝**不得**弹底栏拒绝（"现在没什么可做"不是失败）',
      ).toEqual([])
      expect(rejectionOf(host.log), '通用 poll 拒绝不得写 rejection 渠道').toBeNull()
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'poll 求值次数：gate 只调一次 poll；pollReason 只在 false 时求值',
    async () => {
    const host = await makeAvailabilityHost('wiki-clean')
    try {
      let pollCalls = 0
      let reasonCalls = 0
      const op: OperatorAvailabilityInput = {
        id: 'OPERATOR_PROBE_COUNT',
        label: '计数探针',
        poll: () => {
          pollCalls += 1
          return pollCalls > 1
        },
        pollReason: () => {
          reasonCalls += 1
          return POLL_REASON.GENERIC
        },
      }
      const first = operatorAvailability(host.ctx, op)
      expect(first.enabled, '第一次 poll=false').toBe(false)
      expect(pollCalls, '一次结算只求值一次 poll').toBe(1)
      expect(reasonCalls, 'poll=false ⇒ 求值一次 pollReason').toBe(1)

      const second = operatorAvailability(host.ctx, op)
      expect(second.enabled, '第二次 poll=true').toBe(true)
      expect(pollCalls).toBe(2)
      expect(reasonCalls, 'poll=true ⇒ **不**求值 pollReason（成功路径不付第二次开销）').toBe(1)
    } finally {
      host.dispose()
    }
    },
  )
})

describe('Wiki 保存：不可用时说明为什么 + 下一步', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '非 Wiki 载入文档（local-file 绑定）⇒ 不可用，原因指向"另存为 Wiki 结构"',
    async () => {
    const host = await makeAvailabilityHost('local-file')
    try {
      const op = host.registry.find(WikiSaveConfirmOperator.id)!
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled, '非 wiki-data 文档上"保存到 Wiki"必须不可用').toBe(false)
      if (a.enabled) throw new Error('unreachable')
      expect(a.source, '原因由算子自己声明 ⇒ poll-declared').toBe('poll-declared')
      expect(a.error.params.reason).toBe(POLL_REASON.NOT_WIKI_DATA_DOCUMENT)
      expect(a.reason, '原因必须说清**为什么**（不是 Wiki 载入的结构数据）').toContain('Wiki')
      expect(a.reason, '原因必须给出**下一步**（另存为 Wiki 结构）').toContain('另存为 Wiki 结构')
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '从未写过绑定的文档（sourceId 仍是 empty，OPERATOR_OPEN_SCENE 的真实形态）⇒ 同一句原因',
    async () => {
    const host = await makeAvailabilityHost('never-bound')
    try {
      const op = host.registry.find(WikiSaveConfirmOperator.id)!
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled).toBe(false)
      if (a.enabled) throw new Error('unreachable')
      expect(a.error.params.reason, '同一个用户事实（不是 Wiki 载入文档）不得分裂成两种原因').toBe(
        POLL_REASON.NOT_WIKI_DATA_DOCUMENT,
      )
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'Wiki 载入但**无**可审计变更 ⇒ 不可用，原因说清"与基线一致"',
    async () => {
    const host = await makeAvailabilityHost('wiki-clean')
    try {
      const op = host.registry.find(WikiSaveConfirmOperator.id)!
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled, '刚装载（基线 = 当前产物）⇒ 不可用（防重复提交空编辑）').toBe(false)
      if (a.enabled) throw new Error('unreachable')
      expect(a.error.params.reason).toBe(POLL_REASON.NO_AUDITABLE_CHANGES)
      expect(a.reason, '原因必须说清为什么（没有可审计的变更）').toContain('没有可审计的变更')
      expect(a.reason, '不得把"另存为"这下一步贴到这条原因上（两类不可用的下一步不同）').not.toContain('另存为')
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '**直接入口**（Ctrl+S 同一条 `invoke`）⇒ 底栏成句拒绝，与菜单原因同源',
    async () => {
    const host = await makeAvailabilityHost('local-file')
    try {
      const op = host.registry.find(WikiSaveConfirmOperator.id)!
      const gate = operatorAvailability(host.ctx, op)
      if (gate.enabled) throw new Error('前提：本场景必须不可用')

      const result = host.registry.invoke(host.ctx, WikiSaveConfirmOperator.id, {})
      expect(result, '不可用的 invoke 不得报 FINISHED').not.toBe('FINISHED')
      expect(host.wikiUi.modal.value, '不得打开保存确认模态（"点了没反应"的另一种伪装）').toBeNull()

      const live = rejectionOf(host.log)
      expect(live, '直接入口的拒绝必须写底栏实时状态（不许只进日志）').not.toBeNull()
      expect(live!.origin, '必须走 rejection 渠道（与纹理五态区分）').toBe('rejection')
      expect(live!.level, '用户可见的警告级（不是 info）').toBe(LOG_LEVEL.WARN)
      expect(live!.message, '底栏必须成句（含"被拒"），不是裸错误码').toContain('被拒')
      expect(live!.message, '底栏原因必须与菜单 title/aria 的原因**同一句**').toContain(gate.reason)
      expect(live!.message, '底栏不得把错误码原样贴给用户').not.toContain('UnsupportedOperation')
    } finally {
      host.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '有可审计变更 ⇒ 可用（正对照）+ `invoke` 真的打开确认模态',
    async () => {
    const host = await makeAvailabilityHost('wiki-dirty')
    try {
      const op = host.registry.find(WikiSaveConfirmOperator.id)!
      const a = operatorAvailability(host.ctx, op)
      expect(a.enabled, '有变更时"保存到 Wiki"必须可用（否则"拒绝"可能只是整条路坏了）').toBe(true)

      const result = host.registry.invoke(host.ctx, WikiSaveConfirmOperator.id, {})
      expect(result).toBe('FINISHED')
      expect(host.wikiUi.modal.value, '可用路径必须真的走到保存确认模态').toBe('save-confirm')
      expect(rejectionOf(host.log), '可用路径不得留下拒绝文案').toBeNull()
    } finally {
      host.dispose()
    }
    },
  )
})
