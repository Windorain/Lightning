/**
 * `embed/embedAssemblyProbe` —— **生产嵌入实例的装配只读面**。
 *
 * ## 为什么需要它
 *
 * 此前，`EMBED_PROFILE` 的装配结果在生产里**零消费者**：`EmbedRoot` 不传
 * `shell`，`createEmbedHost` 落到 `EMPTY_SHELL`（能力空集）。于是
 * 「可选落点裁剪可查询」与「查看器无内容编辑面」两条判据**只活在** `assembly.test.ts`
 * 里 —— 测试事实 ≠ 生产事实（铁律⑦：判据输入必须来自生产装配）。
 *
 * 段 A 把 `EMBED_PROFILE` 接进 `EmbedRoot` 之后，本模块把**该实例真实的**
 * `ShellRuntime` 暴露成一个只读观测面，供：
 *   1. e2e 读 `capabilities()` / `pruned()` / `prunedLandings()` —— 断言的是运行中
 *      实例的装配结果，不是测试里另解析一份；
 *   2. 同一实例上的**负对照**：`attemptCommand()` 走 `Context#submitContentEditSettlement`
 *      （与 operator 同一条生产写入口），被裁能力的命令必须得到**结构化拒绝**
 *      （`status: 'rejected'` + `error.code`），而不是"UI 上悄悄没有按钮"。
 *
 * ## 为什么不是"再加一个 window.__vm__"
 *
 * `window.__vm__` 是**工作台**的观测面（`WorkbenchRoot` 安装，指向唯一 ctx）。
 * 嵌入是**可多实例**的（同页两个 `mount()` 是 Wiki 的真实形态）：后挂载者覆盖前者
 * 会让读数指向错误实例。故这里是**按实例登记的数组**（`register` 返回注销函数，
 * `EmbedRoot` 在卸载时调用），全局只装一个**读取器**。
 *
 * 多实例的偏好/日志隔离不在本面；本面只解决"装配结果可查询 + 负对照可执行"。
 */

import type { Assembly } from '@/composition/resolver'
import type { Context } from '@/runtime/context'

/**
 * 命令与结算的类型**从生产写入口推出来**（不在本文件 import 内核层类型）。
 *
 * ## 为什么不写 `import type { Command } from '@/application/commands'`
 *
 * `embed/` 属旧层；那会新增一条"旧层 → 内核层"的反向依赖边，而
 * `tests/architecture/kernel-legacy-isolation.test.ts` 对未登记的边一律判红。
 * 登记一条**迁移**边（理由 + 退出阶段）在本处是错的口径：这里不需要任何新能力，
 * 只是要一个已经被 `Context` 公开的方法的入参/返回类型 —— 从它推出来即可，
 * 于是既没有新依赖边、也不会与内核契约漂移（签名变了这里跟着变）。
 */
type ContentEditCommand = Parameters<Context['submitContentEditSettlement']>[0]
type ContentEditOutcome = ReturnType<Context['submitContentEditSettlement']>

export interface EmbedAssemblyProbe {
  /**
   * **本实例身份**（与持久化键、`__log__` 登记同一个键）。
   *
   * 为什么观测面必须有它：多实例页上"这条读数属于谁"必须能指名 ——
   * 否则失败/寿命判据只能靠"第几个 probe"猜测（顺序会随卸载变化）。
   */
  readonly instanceId: string
  /** 本实例的 profile（生产嵌入恒为 `'embed'`）。 */
  readonly profileId: string
  /** 本实例的视口 region（独立嵌入 = `r-embed`；Wiki 预览走工作台 ctx，不经本面）。 */
  readonly regionId: string
  /** 解析后的装配（`modules` / `capabilities` / `contributions` / `pruned` / `prunedLandings`）。 */
  assembly(): Assembly
  /** 能力集合（= `Assembly.capabilities`，与内核会话收到的同一份）。 */
  capabilities(): readonly string[]
  /** 模块级裁剪记录（"裁剪原因可查询"面）。 */
  pruned(): Assembly['pruned']
  /** 可选落点裁剪记录（落点级记录；嵌入必须留 `editor:inspector`）。 */
  prunedLandings(): Assembly['prunedLandings']
  /** 内核编辑上下文 id（构造负对照命令时需要；来自本实例会话，不是硬编码）。 */
  contextId(): string
  /**
   * **寿命读面**：本实例此刻还持有多少运行资源。
   *
   * 为什么要在这里读：嵌入页没有 `__vm__`（那是工作台的观测面），
   * 而"卸载后资源回基线"这条判据需要**本实例自己的**账：
   *  - `viewportLive`：本实例的视口槽位是否仍持有 camera/domElement
   *    （`runtime/viewportManager#isSlotLive` 的同一判据）；
   *  - `frameClockRunning`：外壳帧循环是否还在推进（`composition/useKernelFrameLoop`）。
   *
   * 两者都为 `false` ⇒ 本实例的呈现与时钟都已退出；配合 DOM 的 canvas 计数
   * 与 `__log__.instanceIds()` 的在册数，就是"回基线"的三面读数。
   */
  lifecycle(): {
    readonly viewportSlotPresent: boolean
    readonly viewportLive: boolean
    readonly frameClockRunning: boolean
  }
  /**
   * **生产写入口**（`Context#submitContentEditSettlement`）：与 operator 同一条路径。
   *
   * 返回 `null` = 本实例没有会话/未装配；`rejected` = 内核结构化拒绝
   * （被裁能力 ⇒ `UnsupportedOperation`）。夹具不得直接调 `reduceCommand` ——
   * 那会绕过"这个实例到底有没有能力"这一被测事实。
   */
  attemptCommand(command: ContentEditCommand): ContentEditOutcome
}

const probes: EmbedAssemblyProbe[] = []

/** 登记一个生产嵌入实例（返回注销函数；`EmbedRoot` 在 `onBeforeUnmount` 调用）。 */
export function registerEmbedAssemblyProbe(probe: EmbedAssemblyProbe): () => void {
  probes.push(probe)
  return () => {
    const i = probes.indexOf(probe)
    if (i >= 0) probes.splice(i, 1)
  }
}

/** 当前在场的生产嵌入实例（快照；顺序 = 挂载顺序）。 */
export function embedAssemblyProbes(): readonly EmbedAssemblyProbe[] {
  return probes.slice()
}

/**
 * 全局读取器（只读；**一个**函数引用，不随实例覆盖）。
 *
 * 命名带 `__lk_` 前缀：与 `__vm__`/`__log__`/`__areaHost__` 同一族观测面命名空间，
 * 而不是产品 API（不导出到 `main.ts` 的公开契约面）。
 */
declare global {
  interface Window {
    __lk_embed__?: {
      readonly probes: () => readonly EmbedAssemblyProbe[]
    }
  }
}

if (typeof window !== 'undefined') {
  window.__lk_embed__ = Object.freeze({
    probes: () => embedAssemblyProbes(),
  })
}

/** 供 `EmbedRoot` 组装的便捷构造（把 `ShellRuntime` + `Context` 收成一个只读面）。 */
export function createEmbedAssemblyProbe(input: {
  readonly instanceId: string
  readonly profileId: string
  readonly regionId: string
  readonly assembly: Assembly
  readonly ctx: Context
}): EmbedAssemblyProbe {
  return Object.freeze({
    instanceId: input.instanceId,
    profileId: input.profileId,
    regionId: input.regionId,
    assembly: () => input.assembly,
    capabilities: () => input.assembly.capabilities,
    pruned: () => input.assembly.pruned,
    prunedLandings: () => input.assembly.prunedLandings,
    contextId: () => input.ctx.requireKernelSession().contextId,
    lifecycle: () => {
      const slot = input.ctx.viewports.get(input.regionId)
      return {
        viewportSlotPresent: slot !== undefined,
        viewportLive: slot !== undefined && slot.camera.value !== null && slot.domElement.value !== null,
        frameClockRunning: input.ctx.getFrameClock()?.running === true,
      }
    },
    attemptCommand: (command: ContentEditCommand) => input.ctx.submitContentEditSettlement(command),
  })
}
