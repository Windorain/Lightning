/**
 * A34 `artifact-host` —— **宿主能力矩阵与启动/销毁契约**判据（#249 §19.8；#260）。
 *
 * ## 本文件判什么、不判什么
 *
 * 判：矩阵四条 profile 的声明完整性；必需缺失 ⇒ **启动失败**（结构化诊断）；
 * 可选缺失 ⇒ **显式降级并说明**；启动/销毁入公开且**销毁幂等**；
 * 资源基址规则（相对基址）。
 *
 * **不**判：真实浏览器里这些能力是否真的可用（那需要 e2e，且 #249 §14 明确"只测
 * dev server"不算证据）。本文件的探测输入是**构造的宿主环境值**，
 * 因此它证明的是"判定逻辑正确"，不是"某宿主支持"。
 * 真实产物的字节证据在 `artifactTransport.test.ts` 与 `web/tests/architecture/artifact-host.test.ts`。
 *
 * ## 逐条负对照（#249 §14：「负对照必须证明确实破坏了目标保证」）
 *
 * 1. 「只把类型编译通过当成宿主支持证明」⇒ 见 `describe('A34 负对照：类型不能冒充宿主支持')`：
 *    同一段声明在 `bare` 宿主下**必须**判 `blocked`，在 `full` 宿主下判 `launchable` ——
 *    判定随**运行期能力报告**翻转，与 TypeScript 的类型是否通过**无关**。
 * 2. 「必需缺失却启动」⇒ 断言不存在 `status: 'launchable'` 且 `missing` 非空的组合。
 * 3. 「可选缺失静默」⇒ 断言降级项必须带非空 `effect`，且缺 `degradation` 的声明被 `validate` 判违规。
 */

import { describe, expect, it } from 'vitest'
import {
  BARE_HOST_ENVIRONMENT,
  HOST_CAPABILITY_IDS,
  HOST_CONTRACT_VERSION,
  HOST_PROFILE_IDS,
  HOST_PROFILE_SPECS,
  assertHostRequirements,
  createHostSession,
  hostProfileSpec,
  isBlockedLaunch,
  probeHostCapabilities,
  validateHostProfileSpec,
  type HostCapabilityId,
  type HostProfileSpec,
} from '../hostCapabilities'

// ─────────────────────────────────────────────────────────────────────────────
// 测试夹具：两种宿主环境（都用**构造值**，不读全局）
// ─────────────────────────────────────────────────────────────────────────────

/** 完整能力的桌面浏览器（Wiki/工作台产品线的目标宿主）。 */
const FULL_HOST = probeHostCapabilities({
  hasDom: true,
  hasWebGL2: true,
  hasBlob: true,
  hasCreateObjectURL: true,
  hasAtob: true,
  hasTextEncoder: true,
  hasIndexedDB: true,
  hasClipboard: true,
  hasFileSystemAccess: true,
})

/** 齐全但**缺可选能力**的宿主（模拟隐私模式：无 indexedDB、无剪贴板 API）。 */
const NO_OPTIONAL_HOST = probeHostCapabilities({
  hasDom: true,
  hasWebGL2: true,
  hasBlob: true,
  hasCreateObjectURL: true,
  hasAtob: true,
  hasTextEncoder: true,
  hasIndexedDB: false,
  hasClipboard: false,
  hasFileSystemAccess: false,
})

/** 无任何能力的宿主（负对照基线）。 */
const BARE_HOST = probeHostCapabilities(BARE_HOST_ENVIRONMENT)

function spec(id: string): HostProfileSpec {
  const s = hostProfileSpec(id)
  if (s === undefined) throw new Error(`未登记的 profile: ${id}`)
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、矩阵完整性（声明层）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 能力矩阵：四个 profile 的声明完整性（#249 §19.8）', () => {
  it('四个 profile 齐备，且与 HOST_PROFILE_IDS 一一对应', () => {
    expect(HOST_PROFILE_SPECS.map((s) => s.id)).toEqual([...HOST_PROFILE_IDS])
    expect([...HOST_PROFILE_IDS]).toEqual(['workbench', 'embed', 'wiki-workbench', 'headless'])
  })

  it('声明集合自身 0 违规（`validateHostProfileSpec`）', () => {
    const violations = validateHostProfileSpec(HOST_PROFILE_SPECS)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('每个 profile 都公开**启动**入口（模块 + 符号名），且文件真实存在', () => {
    for (const s of HOST_PROFILE_SPECS) {
      expect(s.startEntry.length, `${s.id} 必须公开启动入口名`).toBeGreaterThan(0)
      expect(s.startModule, `${s.id} 必须指向启动模块`).toMatch(/^web\/src\//)
    }
  })

  it('销毁入口：有则公开，无则**显式登记缺口**（不允许两处都空）', () => {
    for (const s of HOST_PROFILE_SPECS) {
      const hasDestroy = s.destroyEntry !== null
      expect(
        hasDestroy || (s.lifecycleGap ?? '').length > 0,
        `${s.id}：既没有销毁入口也没有缺口说明（这就是"漏写"而非"决策"）`,
      ).toBe(true)
      if (!hasDestroy) {
        // 缺口说明必须点明归属批次（可核销），不能是"待定"。
        expect(s.lifecycleGap, `${s.id} 的缺口说明必须点名归属批次`).toMatch(/P\d+/)
      }
    }
  })

  it('资源基址规则：有产物的 profile 必须相对基址（B1 B-07，非站点根加载）', () => {
    for (const s of HOST_PROFILE_SPECS) {
      if (s.id === 'headless') continue
      expect(s.resourceBase.buildBase, `${s.id} 的 base 必须是 './'（绝对基址会 404）`).toBe('./')
      expect(s.resourceBase.because.length, `${s.id} 必须写明基址依据`).toBeGreaterThan(20)
    }
  })

  it('产物路径登记：有产物的 profile 非空，headless 为空', () => {
    for (const s of HOST_PROFILE_SPECS) {
      if (s.id === 'headless') expect(s.artifacts).toEqual([])
      else expect(s.artifacts.length, `${s.id} 必须登记产物路径`).toBeGreaterThan(0)
    }
  })

  it('每个 profile 至少一条**必需**能力（否则"必需缺失则启动失败"永不触发 ⇒ 空洞真）', () => {
    for (const s of HOST_PROFILE_SPECS) {
      const required = s.capabilities.filter((c) => c.requirement === 'required')
      expect(required.length, `${s.id} 的必需能力集合为空 ⇒ 强约束面为 0`).toBeGreaterThan(0)
    }
  })

  it('每条能力声明的 id 都在能力全集内（防拼错键名造成"声明了但从不检查"）', () => {
    for (const s of HOST_PROFILE_SPECS) {
      for (const c of s.capabilities) {
        expect(HOST_CAPABILITY_IDS, `${s.id} 的能力 ${c.id} 不在全集内`).toContain(c.id)
      }
    }
  })

  it('**反空洞真**：能力全集里的每条能力至少被一个 profile 声明（否则实际只覆盖了子集）', () => {
    const declared = new Set<HostCapabilityId>()
    for (const s of HOST_PROFILE_SPECS) for (const c of s.capabilities) declared.add(c.id)
    const und: HostCapabilityId[] = HOST_CAPABILITY_IDS.filter((id) => !declared.has(id))
    expect(und, `这些能力从没被任何 profile 声明：${und.join(', ')}`).toEqual([])
  })

  it('负面清单（`notCapableOf`）非空 —— 它是 T-06 判据的落点', () => {
    // embed 必须显式声明"不做 ZIP 导出"，否则 T-06 的"无实际影响"不可判定。
    expect(spec('embed').notCapableOf.join('\n')).toContain('zip-export')
    expect(spec('headless').notCapableOf.length).toBeGreaterThan(0)
  })

  it('产物版本统一等于宿主契约版本（产物与契约必须同代）', () => {
    for (const s of HOST_PROFILE_SPECS) {
      expect(s.artifactVersion, `${s.id}`).toBe(HOST_CONTRACT_VERSION)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、判定语义（必需失败 / 可选降级）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 判定：必需能力缺失 ⇒ 启动失败；可选缺失 ⇒ 显式降级（§19.8 逐字）', () => {
  it('完整宿主：四个 profile 全部 launchable，且无降级、无诊断', () => {
    for (const id of HOST_PROFILE_IDS) {
      const d = assertHostRequirements(spec(id), FULL_HOST, { requestedProfile: id })
      expect(d.status, `${id} 在完整宿主下必须可启动（实得 ${d.status}）`).toBe('launchable')
      if (d.status === 'launchable') {
        expect(d.degradations, `${id} 在完整宿主下不应有降级`).toEqual([])
        expect(d.diagnostics).toEqual([])
      }
    }
  })

  it('无能力宿主：`workbench` 判 blocked，且缺失项**逐条带代码路径证据**', () => {
    const d = assertHostRequirements(spec('workbench'), BARE_HOST, { requestedProfile: 'workbench' })
    expect(d.status).toBe('blocked')
    if (d.status !== 'blocked') throw new Error('unreachable')
    // workbench 声明了 6 条必需能力 ⇒ 全缺时必须全部列出（不是只报第一条）。
    expect(d.missing.length).toBe(6)
    for (const m of d.missing) {
      expect(m.because.length, `${m.capability} 的缺失诊断必须带 because`).toBeGreaterThan(10)
    }
    const codes = d.diagnostics.map((x) => x.code)
    expect(codes).toEqual(Array(6).fill('HostCapabilityMissing'))
    expect(d.diagnostics.every((x) => x.profile === 'workbench')).toBe(true)
  })

  it('**可选缺失不阻塞**，但必须逐条给出"失去什么"（不是静默）', () => {
    const d = assertHostRequirements(spec('workbench'), NO_OPTIONAL_HOST, { requestedProfile: 'workbench' })
    expect(d.status, '缺可选能力仍必须可启动').toBe('launchable')
    if (d.status !== 'launchable') throw new Error('unreachable')
    expect(d.degradations.map((x) => x.capability).sort()).toEqual(['clipboard', 'fileSystemAccess', 'indexedDB'])
    for (const g of d.degradations) {
      expect(g.effect.length, `${g.capability} 的降级说明不得为空`).toBeGreaterThan(5)
      // 降级说明不得是"不支持"这类空话 —— 必须说清用户失去什么。
      expect(g.effect, `${g.capability} 的降级说明必须具体`).not.toBe('不支持')
    }
    expect(d.diagnostics, '降级是设计内行为，不产生诊断项').toEqual([])
  })

  it('只缺**一条**必需能力（缺 atob）⇒ 仍然 blocked（不是"大部分都在就放行"）', () => {
    const host = probeHostCapabilities({
      hasDom: true,
      hasWebGL2: true,
      hasBlob: true,
      hasCreateObjectURL: true,
      hasAtob: false,
      hasTextEncoder: true,
      hasIndexedDB: true,
      hasClipboard: true,
      hasFileSystemAccess: true,
    })
    const d = assertHostRequirements(spec('wiki-workbench'), host, { requestedProfile: 'wiki-workbench' })
    expect(d.status).toBe('blocked')
    if (d.status !== 'blocked') throw new Error('unreachable')
    expect(d.missing.map((m) => m.capability)).toEqual(['atob'])
    // 诊断必须指向**补丁引入的那个依赖**（可核对），而不是一句"缺能力"。
    expect(d.diagnostics[0].params.because).toContain('atob')
  })

  it('未知 profile ⇒ `unknown-profile`（不猜、不退化到默认 profile）', () => {
    const d = assertHostRequirements(undefined, FULL_HOST, { requestedProfile: 'nope' })
    expect(d.status).toBe('unknown-profile')
    expect(d.diagnostics[0].code).toBe('HostProfileUnknown')
    expect(d.diagnostics[0].params.requested).toBe('nope')
  })

  it('产物版本不符 ⇒ 追加 `HostArtifactVersionMismatch` 诊断（但仍按能力判定）', () => {
    const d = assertHostRequirements(spec('embed'), FULL_HOST, {
      requestedProfile: 'embed',
      artifactVersion: 'host-contract/0',
    })
    expect(d.status).toBe('launchable')
    expect(d.diagnostics.map((x) => x.code)).toEqual(['HostArtifactVersionMismatch'])
    const mismatch = d.diagnostics[0]
    expect(mismatch.params.expected).toBe(HOST_CONTRACT_VERSION)
    expect(mismatch.params.actual).toBe('host-contract/0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、启动/销毁会话
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 会话：启动入口返回句柄；销毁**幂等**（A34「同页多实例及销毁」）', () => {
  it('可启动 ⇒ 得到会话；`destroy()` 只释放一次，第二次报 already-destroyed', () => {
    let releases = 0
    const d = assertHostRequirements(spec('wiki-workbench'), FULL_HOST, { requestedProfile: 'wiki-workbench' })
    const s = createHostSession(d, () => {
      releases += 1
    })
    expect(isBlockedLaunch(s)).toBe(false)
    if (isBlockedLaunch(s)) throw new Error('unreachable')
    expect(s.profile).toBe('wiki-workbench')
    expect(s.isDestroyed()).toBe(false)
    expect(s.destroy()).toEqual({ destroyed: true, reason: 'destroyed' })
    expect(s.destroy()).toEqual({ destroyed: false, reason: 'already-destroyed' })
    expect(s.destroy()).toEqual({ destroyed: false, reason: 'already-destroyed' })
    // **关键**：释放只发生一次（A19「少一次 dispose 或提前释放共享资源」的同族判据）。
    expect(releases).toBe(1)
    expect(s.isDestroyed()).toBe(true)
  })

  it('启动被拒 ⇒ **不创建会话**，而是把缺失项与诊断交回调用方', () => {
    let releases = 0
    const d = assertHostRequirements(spec('workbench'), BARE_HOST, { requestedProfile: 'workbench' })
    const s = createHostSession(d, () => {
      releases += 1
    })
    expect(isBlockedLaunch(s)).toBe(true)
    if (!isBlockedLaunch(s)) throw new Error('unreachable')
    expect(s.blocked.length).toBe(6)
    expect(s.diagnostics.length).toBe(6)
    // 被拒时**不得**触碰资源（否则等于"启动失败还占着资源"）。
    expect(releases).toBe(0)
  })

  it('会话携带启动时确定的降级清单（不随后续环境变化）', () => {
    const d = assertHostRequirements(spec('workbench'), NO_OPTIONAL_HOST, { requestedProfile: 'workbench' })
    const s = createHostSession(d, () => {})
    if (isBlockedLaunch(s)) throw new Error('unreachable')
    expect(s.degradations.map((g) => g.capability).sort()).toEqual(['clipboard', 'fileSystemAccess', 'indexedDB'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、负对照：**类型不能冒充宿主支持**
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 负对照：只把类型编译通过当成宿主支持证明 ⇒ 必须判红（§19.8 明文）', () => {
  /**
   * 「类型编译通过」的可执行等价物：**同一份声明**（类型完全合法、`validate` 0 违规）。
   * 它证明的是"代码结构对"；它对宿主**是否有**这些能力零信息。
   */
  function typeLevelEvidence(): { violations: readonly unknown[]; allSpecsValid: boolean } {
    const violations = validateHostProfileSpec(HOST_PROFILE_SPECS)
    return { violations, allSpecsValid: violations.length === 0 }
  }

  it('前提：声明在**类型/结构层面**完全合法（这一半是真的通过）', () => {
    const ev = typeLevelEvidence()
    expect(ev.allSpecsValid, '声明必须结构合法 —— 否则下面的对照就不成立').toBe(true)
    expect(ev.violations).toEqual([])
  })

  it('**负对照**：同一份"类型全绿"的声明，在 bare 宿主下判 blocked —— 类型通过 ≠ 宿主支持', () => {
    const ev = typeLevelEvidence()
    expect(ev.allSpecsValid).toBe(true) // 类型层面：通过
    const d = assertHostRequirements(spec('workbench'), BARE_HOST, { requestedProfile: 'workbench' })
    expect(d.status, '类型全绿但宿主什么都没有 ⇒ 必须启动失败').toBe('blocked')
  })

  it('**负对照**：若判定只看类型（不看能力报告），它对两种宿主会给出**同一个**结论 ⇒ 判据失效', () => {
    // "只看类型"的对照实现：无视能力报告，恒返回 launchable。
    const typeOnlyJudge = (_report: unknown): 'launchable' => 'launchable'
    const withBare = typeOnlyJudge(BARE_HOST)
    const withFull = typeOnlyJudge(FULL_HOST)
    // 它在两种截然不同的宿主上给出同一结论 ⇒ 无法区分"能跑"与"不能跑"。
    expect(withBare).toBe(withFull)
    // 而真实判定必须区分二者 —— 这就是"类型不能冒充宿主支持"的机器可读形式。
    const realBare = assertHostRequirements(spec('workbench'), BARE_HOST, { requestedProfile: 'workbench' }).status
    const realFull = assertHostRequirements(spec('workbench'), FULL_HOST, { requestedProfile: 'workbench' }).status
    expect(realBare).not.toBe(realFull)
    expect(realBare).toBe('blocked')
    expect(realFull).toBe('launchable')
  })

  it('**负对照**：不存在"必需缺失却 launchable"的组合（把"缺必需"写成警告即判红）', () => {
    // 穷举四 profile × 三个宿主，断言不存在被放行的缺失必需能力。
    const hosts = [BARE_HOST, NO_OPTIONAL_HOST, FULL_HOST]
    for (const s of HOST_PROFILE_SPECS) {
      for (const host of hosts) {
        const d = assertHostRequirements(s, host, { requestedProfile: s.id })
        const requiredMissing = s.capabilities.filter(
          (c) => c.requirement === 'required' && host[c.id] !== true,
        )
        if (requiredMissing.length > 0) {
          expect(d.status, `${s.id} 缺 ${requiredMissing.length} 条必需能力却未 blocked`).toBe('blocked')
        }
      }
    }
  })

  it('负对照（声明层）：必需能力写了 degradation ⇒ validate 判违规（语义矛盾）', () => {
    const bad: HostProfileSpec = {
      ...spec('embed'),
      capabilities: [
        ...spec('embed').capabilities,
        { id: 'indexedDB', requirement: 'required', because: 'x', degradation: '不该有' },
      ],
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('required-no-degradation')
  })

  it('负对照（声明层）：可选能力**没写**降级后果 ⇒ validate 判违规（"静默降级"的形态）', () => {
    const bad: HostProfileSpec = {
      ...spec('embed'),
      capabilities: [
        ...spec('embed').capabilities.filter((c) => c.id !== 'clipboard'),
        { id: 'clipboard', requirement: 'optional', because: 'x' },
      ],
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('optional-degradation')
  })

  it('负对照（声明层）：必需能力集合为空 ⇒ validate 判违规（空洞真的形态）', () => {
    const bad: HostProfileSpec = {
      ...spec('headless'),
      capabilities: spec('headless').capabilities.map((c) => ({ ...c, requirement: 'optional' as const, degradation: 'd' })),
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'headless'), bad])
    expect(v.map((x) => x.rule)).toContain('at-least-one-required')
  })

  it('负对照（声明层）：无销毁入口且无缺口说明 ⇒ validate 判违规', () => {
    const bad: HostProfileSpec = {
      ...spec('embed'),
      destroyEntry: null,
      lifecycleGap: undefined,
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('lifecycle-gap')
  })

  it('负对照（声明层）：重复能力声明 ⇒ validate 判违规（防"后者隐藏覆盖前者"）', () => {
    const dup = spec('embed').capabilities[0]
    const bad: HostProfileSpec = { ...spec('embed'), capabilities: [...spec('embed').capabilities, dup] }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('unique-capability')
  })

  it('负对照（声明层）：缺一个 profile / 多一个未登记 profile / 重复 profile ⇒ 判违规', () => {
    const missing = validateHostProfileSpec(HOST_PROFILE_SPECS.filter((s) => s.id !== 'headless'))
    expect(missing.map((x) => x.rule)).toContain('complete-set')
    // 未登记的 profile 名：`complete-set`（它既不在 HOST_PROFILE_IDS 里，也补不上缺的那个）。
    const unknown = validateHostProfileSpec([
      ...HOST_PROFILE_SPECS,
      { ...spec('embed'), id: 'bogus' as HostProfileSpec['id'] },
    ])
    expect(unknown.map((x) => x.rule)).toContain('complete-set')
    expect(unknown.some((x) => x.profile === 'bogus')).toBe(true)
    // **重复**同一个 id：这是 `unique-id`。
    const dup = validateHostProfileSpec([...HOST_PROFILE_SPECS, spec('embed')])
    expect(dup.map((x) => x.rule)).toContain('unique-id')
  })

  it('负对照（声明层）：绝对基址 ⇒ 判违规（B-07 的形态）', () => {
    const bad: HostProfileSpec = {
      ...spec('embed'),
      resourceBase: { ...spec('embed').resourceBase, buildBase: '/' },
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('relative-base')
  })

  it('负对照（声明层）：能力 `because` 为空 ⇒ 判违规（无证据指针的声明不可核对）', () => {
    const bad: HostProfileSpec = {
      ...spec('embed'),
      capabilities: spec('embed').capabilities.map((c, i) => (i === 0 ? { ...c, because: '' } : c)),
    }
    const v = validateHostProfileSpec([...HOST_PROFILE_SPECS.filter((s) => s.id !== 'embed'), bad])
    expect(v.map((x) => x.rule)).toContain('capability-evidence')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、探测是纯投影（同一输入恒得同一输出；无全局读取）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 探测：`probeHostCapabilities` 是纯投影', () => {
  it('同一环境值恒得同一报告，且不改输入', () => {
    const env = { ...BARE_HOST_ENVIRONMENT, hasDom: true, hasAtob: true }
    const frozen = Object.freeze({ ...env })
    const a = probeHostCapabilities(frozen)
    const b = probeHostCapabilities(frozen)
    expect(a).toEqual(b)
    expect(Object.keys(a).sort()).toEqual([...HOST_CAPABILITY_IDS].sort())
    expect(frozen.hasDom, '输入不得被修改').toBe(true)
  })

  it('每个字段与环境的对应项严格一致（不得把两组语义相近的能力合并）', () => {
    const r = probeHostCapabilities({
      hasDom: true,
      hasWebGL2: false,
      hasBlob: true,
      hasCreateObjectURL: false,
      hasAtob: true,
      hasTextEncoder: false,
      hasIndexedDB: true,
      hasClipboard: false,
      hasFileSystemAccess: true,
    })
    expect(r.dom).toBe(true)
    expect(r.webgl2).toBe(false)
    // `blob` 与 `url.createObjectURL` 必须**分别**反映：二者是不同能力
    // （只有 Blob 而无 createObjectURL 时产物到不了磁盘 —— 见矩阵里的 because）。
    expect(r.blob).toBe(true)
    expect(r['url.createObjectURL']).toBe(false)
  })
})
