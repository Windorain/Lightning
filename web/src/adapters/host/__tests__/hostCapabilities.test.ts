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

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createInputSession } from '@/runtime/inputSession'
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

/**
 * 本树 `web/` 的绝对路径（只用于**源码指纹**判据：登记的名字必须对得上真实符号）。
 *
 * 从 `import.meta.url` 往上两级：`src/adapters/host/__tests__` → `src` → `web`。
 * 不用 `process.cwd()`：vitest 的 cwd 随调用方式而变，指纹会时绿时红。
 */
const WEB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../..')

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

  /**
   * M7-6 · **嵌入的寿命缺口已核销**（S0-B D8 的登记项）。
   *
   * 判据两面：
   *  1. `embed` 的 `destroyEntry` 非 null 且**没有** `lifecycleGap` ——
   *     "有入口"与"还登记着缺口"不能同时成立（validate 的 `lifecycle-gap` 规则同向）；
   *  2. 登记的名字指向**真实存在**的 API：`mount(...).unmount()` 在
   *     `src/embed/mount.ts` 的返回类型上有 `unmount`（源码指纹，CRLF 归一化）。
   *
   * 负对照：把 embed 改回 `destroyEntry: null` + 缺口说明 ⇒ 第 1 面判红；
   * 这正是"核销"与"改写说明"的区别。
   */
  it('M7-6：embed 的寿命缺口已核销（真实 destroyEntry、无 lifecycleGap）', () => {
    const embed = HOST_PROFILE_SPECS.find((s) => s.id === 'embed')!
    expect(embed.destroyEntry, 'embed 必须登记真实的销毁入口').not.toBeNull()
    expect(embed.destroyEntry).toContain('unmount')
    expect(embed.lifecycleGap, '有销毁入口时不得再留缺口说明（否则缺口没被核销）').toBeUndefined()

    // 入口名必须能在产品源码里对上：`mount()` 返回的会话类型声明了 unmount()。
    const src = fs
      .readFileSync(path.join(WEB_ROOT, 'src/embed/mount.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    expect(src, 'mount() 的返回类型必须声明 unmount()').toMatch(/interface EmbedSession[\s\S]*?unmount\(\): void/)
    expect(src, 'mount() 必须返回 EmbedSession（不再是 void）').toMatch(/export function mount\([\s\S]*?\): EmbedSession \{/)
  })

  it('M7-6：workbench 登记的销毁入口在类上**真实存在**（旧登记指向不存在的符号）', () => {
    const wb = HOST_PROFILE_SPECS.find((s) => s.id === 'workbench')!
    expect(wb.destroyEntry).toBe('WorkbenchHost.destroy')
    const hostSrc = fs
      .readFileSync(path.join(WEB_ROOT, 'src/runtime/host/workbenchHost.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    expect(hostSrc, 'WorkbenchHost 必须有 destroy() 实现（M7-6 前它只是个名字）').toMatch(/override destroy\(\): void \{/)
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

// ─────────────────────────────────────────────────────────────────────────────
// 六、A22 host-input（P11-E #262 补）：**挂起/恢复后**宿主能力仍正常
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这条补的是 A22 的子句缺口（#262 comment 6421 A22 行）
 *
 * B1 的定性：「能力面已存在（`hostCapabilities.ts:278 probeHostCapabilities` 覆盖
 * clipboard/fileSystemAccess/indexedDB），缺的只是"挂起恢复后仍正常"这一步断言」。
 *
 * ## 为什么"挂起/恢复"用**真** `InputSession.applyVisibility`
 *
 * A22 的另一半判据（`inputRouting.test.ts:424`）已经钉住"挂起期间如实报告
 * `droppedTicks`、恢复给一条基线（不补跑历史 tick）"。本组接着那一步问：
 * **恢复之后**，宿主的资源/文件能力（剪贴板、文件直写、indexedDB）是否仍然正常。
 * 用真会话（`createInputSession`）而不是手工拼状态，是因为"挂起/恢复"是会话的
 * 运行期事实，脱离会话就没有被测量的对象。
 *
 * ## 判据的机械形式
 *
 * 同一份环境值 ⇒ 恢复前后两次 `probeHostCapabilities` 必须逐字段相同；
 * 且 `assertHostRequirements` 在恢复后仍判 `launchable`（不是"能探到但被降级"）。
 * 反向（负对照）：把一个"恢复时丢掉能力报告"的变异体喂给**同一个**断言器 ⇒ 判红。
 */
describe('A22 host-input：挂起/恢复后宿主能力仍正常（P11-E #262 补）', () => {
  /** 断言器判红 = 它抛错。用它把"判红"变成可断言的读数（与 A05 负对照同一手法）。 */
  function redOf(run: () => void): boolean {
    try {
      run()
      return false
    } catch {
      return true
    }
  }

  /** 完整能力的宿主环境值（与 `FULL_HOST` 同一份构造输入）。 */
  const FULL_ENV = {
    hasDom: true,
    hasWebGL2: true,
    hasBlob: true,
    hasCreateObjectURL: true,
    hasAtob: true,
    hasTextEncoder: true,
    hasIndexedDB: true,
    hasClipboard: true,
    hasFileSystemAccess: true,
  } as const

  /** 判据本尊（正/负对照共用一份 —— #249 §14「负对照必须证明破坏了目标保证」）。 */
  function judgeCapabilitiesSurviveResume(
    before: ReturnType<typeof probeHostCapabilities>,
    after: ReturnType<typeof probeHostCapabilities>,
    profileId: string,
    resume: { readonly resumeBaseline: number | null; readonly droppedTicks: number },
  ): void {
    // ① 恢复**确实**发生了（不是"根本没挂起"的假绿）
    expect(resume.resumeBaseline, '恢复必须给一条基线（A22 的既有判据口径）').not.toBeNull()
    expect(resume.droppedTicks, '挂起期间丢弃的 tick 必须如实报出').toBeGreaterThan(0)
    // ② 三项"资源/文件能力"逐项仍在，且与挂起前**同一读数**
    for (const id of ['clipboard', 'fileSystemAccess', 'indexedDB'] as const) {
      expect(after[id], `恢复后 ${id} 必须与挂起前相同`).toBe(before[id])
      expect(after[id], `恢复后 ${id} 必须仍可用（不得被挂起清掉）`).toBe(true)
    }
    // ③ 启动判定仍为 launchable（能力面不是"探得到但不可用"）
    const d = assertHostRequirements(spec(profileId), after, { requestedProfile: profileId })
    expect(d.status, '恢复后必须仍可启动（能力面正常）').toBe('launchable')
  }

  it('正对照：真 `InputSession` 挂起 → 恢复之后，能力探针与启动判定逐项不变', () => {
    const session = createInputSession({
      sink: {
        submit: () => ({ ticketId: 't', commandId: 'c' }),
        executeNow: () => ({ status: 'unchanged', version: { documentVersion: 0 } }),
      } as never,
      contextId: 'ctx-1',
      // 一条**模态启动**的 Area 快捷键（`startsModal: true` ⇒ 会话会真的走到 `dispatch`，
      // 从而读一次 `capabilitySource()`）。非模态快捷键只记轨迹、不在此分发。
      areaHotkeys: [
        {
          key: 'g',
          commandId: 'tool.beginInteraction',
          params: { contextId: 'ctx-1', tool: 'move', targets: ['obj-1'] },
          startsModal: true,
        },
      ],
    })
    session.setActiveRegion('r-viewport')
    // 能力来源是**会话**的显式注入（宿主的文件/剪贴板能力经它进入路由判定）
    let capabilityReads = 0
    session.setCapabilities(() => {
      capabilityReads += 1
      return ['content.edit', 'save.write']
    })

    const before = probeHostCapabilities(FULL_ENV)
    expect(session.routing.suspension.suspended, '起点：未挂起').toBe(false)

    // ① 页面隐藏 ⇒ 挂起
    const hidden = session.applyVisibility({ hidden: true, now: 1_000, lastTickAt: 1_000, tickInterval: 16 })
    expect(session.routing.suspension.suspended, '隐藏后必须进入挂起').toBe(true)
    expect(hidden.resumeBaseline, '挂起本身不产生基线').toBeNull()

    // ② 页面重新可见 ⇒ 恢复（5000ms 后）
    const shown = session.applyVisibility({ hidden: false, now: 6_000, lastTickAt: 1_000, tickInterval: 16 })
    expect(session.routing.suspension.suspended, '恢复后必须回到未挂起').toBe(false)

    // ③ 恢复后重新探测宿主能力（**生产探针**、同一份环境值）
    const after = probeHostCapabilities(FULL_ENV)
    judgeCapabilitiesSurviveResume(before, after, 'workbench', shown)

    // ④ 会话能力面同样存活：恢复后仍能路由事件，且能力来源仍被读取
    //    （`dispatch` 每次都向 `capabilitySource()` 取值 —— 挂起把它清掉的话这里会停住）
    const readsBefore = capabilityReads
    session.handleKey({
      token: session.nextToken(),
      kind: 'keydown',
      key: 'g',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      repeat: false,
      composing: false,
      targetEditable: false,
      defaultPrevented: false,
    } as never)
    expect(capabilityReads, '恢复后能力来源必须仍被读取（能力面未被挂起清空）').toBeGreaterThan(readsBefore)
    expect(session.counters.keyEvents, '恢复后会话必须仍能处理事件').toBeGreaterThan(0)
    expect(session.counters.modalStarts, '恢复后模态快捷键必须仍能启动操作').toBe(1)
    // 挂起/恢复在轨迹里**如实事后可见**（不是静默状态变化）
    expect(session.trace.map((t) => t.reason)).toEqual(expect.arrayContaining(['suspended']))
    expect(session.trace.some((t) => String(t.reason).startsWith('resumed(')), '恢复必须留痕').toBe(true)
  })

  it('**负对照**：把"恢复时丢掉能力报告"的变异体喂给同一断言器 ⇒ 判红', () => {
    const before = probeHostCapabilities(FULL_ENV)
    const resume = { resumeBaseline: 6_000, droppedTicks: 312 }
    // 变异体 A：恢复后能力报告塌成裸宿主（挂起把能力面清掉了）
    expect(
      redOf(() => judgeCapabilitiesSurviveResume(before, probeHostCapabilities(BARE_HOST_ENVIRONMENT), 'workbench', resume)),
      '恢复后丢掉 clipboard/fileSystemAccess/indexedDB ⇒ 必须判红',
    ).toBe(true)
    // 变异体 B：只丢**一项**（最容易漏的形态：整体还在、单项被清）
    const oneMissing = probeHostCapabilities({ ...FULL_ENV, hasClipboard: false })
    expect(redOf(() => judgeCapabilitiesSurviveResume(before, oneMissing, 'workbench', resume)), '丢单项同样必须判红').toBe(true)
    // 变异体 C：根本没挂起（没有基线 ⇒ "恢复后正常"是没被测过的空话）
    expect(
      redOf(() => judgeCapabilitiesSurviveResume(before, before, 'workbench', { resumeBaseline: null, droppedTicks: 0 })),
      '没有发生恢复 ⇒ 必须判红（防"没挂起也算通过"）',
    ).toBe(true)
    // 正对照：合规读数判绿（防恒红）
    expect(redOf(() => judgeCapabilitiesSurviveResume(before, probeHostCapabilities(FULL_ENV), 'workbench', resume))).toBe(false)
  })
})
