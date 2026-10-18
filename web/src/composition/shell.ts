/**
 * `composition/shell` —— **外壳运行实例：能力装配结果 + 宿主端口**（#249 §10；契约 §7）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #7 的**运行时**半边）
 *
 * 旧实现里"我现在是不是 wiki 宿主"的答案是**一个模块级全局变量**：
 * `runtime/hostProfile.ts` 的 `let hostProfile`，由 `workbenchHost.ts` 在
 * `createWorkbenchHost` 里 `setHostProfile(deps.profile)` 写入，
 * 之后 19 处消费点（组件、operator poll、输入屏蔽、面板查询）调
 * `isWikiHostProfile()` 反查。
 *
 * 它的三个问题，逐条对应本模块的设计：
 *
 * | 问题 | 本模块的答复 |
 * |---|---|
 * | **模块级可变单例**（#249 §2.1 禁止"依赖可变单例"） | `ShellRuntime` 是**值**，由装配结果派生，经依赖注入送达消费者 |
 * | 组件在**询问宿主名**（#249 §10 明文禁止） | 组件问的是**能力**（`shell.has(cap)`），不是名字；类型上不存在"当前宿主名"这个可读字段 |
 * | 构建期常量无法表达**运行期 profile 组合** | 差异全部落在 `Assembly`（哪些模块被采纳、哪些落点被裁剪、哪些能力存在） |
 *
 * ## 唯一的构建期输入：`resolveShellProfile()`
 *
 * `#249` §4 规则 5 说「功能模块不得反向依赖 profile 或**宿主名**」，
 * §10 说「组件不得询问宿主名称」。两者不冲突：**装配根选择哪个 profile** 是
 * 装配根自己的职责（`#250`：「装配根由 P0/P1/P11 按阶段拥有」，本批属于 P6），
 * 禁止的是**功能模块与组件**去问。
 *
 * 故本文件是**全 `src/` 唯一**读取构建期 profile 变量的地方，
 * 且它只做一件事：把构建期输入映射成一个 `ProfileDecl`。
 * 组件拿到的永远是 `ShellRuntime`，其中**没有** `hostName` / `isWiki` 之类的字段
 * （类型上不存在 ⇒ 组件想问也问不到）。
 *
 * ## 宿主端口（`#249` §4 规则 4：adapters 实现端口）
 *
 * 旧 `wikiInputShield` 里那两处宿主判别（`getFloatingUiTeleportTarget`、
 * `shouldSkipWorkbenchDocumentKeydown`）本质是**宿主端口**行为：
 * "宿主是否在页面级接管键盘"与"浮层 UI 该挂到哪个容器"。
 * 它们现在由 `ShellRuntime.pageKeyboard` 这个**显式端口实例**承载：
 * 存在即宿主接管（wiki profile 提供它），不存在即不接管。
 * 调用方（`chromeBinder`/`viewportBinder`）拿到的是端口对象，不是"当前宿主名"。
 */

import { inject, type InjectionKey } from 'vue'
import { CAPABILITY, type CapabilityId, type ModuleDecl, type ProfileId } from './modules'
import { ALL_PROFILES, EMBED_PROFILE, profileById, type ProfileDecl } from './profiles'
import { capabilitiesOf, resolveComposition, type Assembly } from './resolver'

// ─────────────────────────────────────────────────────────────────────────────
// 宿主端口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **页面级键盘接管**端口（旧 `wikiInputShield` 的宿主判别 → 端口）。
 *
 * `#249` §19.1：「外壳翻译事实，不能在 Wiki 再叠一套领域快捷键策略」。
 * 于是"宿主接管了页面键盘"是一个**事实**，由外壳实现本端口来声明，
 * 而不是功能模块去猜宿主名。
 */
export interface PageKeyboardClaim {
  /** 宿主是否在页面级接管 document keydown（wiki 词条是）。 */
  claimsDocumentKeyboard(): boolean;
  /** 浮层 UI 的挂载目标容器；`null` = 用默认（`body` / fullscreenElement）。 */
  floatingUiScope(): HTMLElement | null
}

/**
 * 外壳运行实例。
 *
 * **没有** `hostName` / `isWiki` / `profileName` 这类字段 —— 这是刻意的：
 * 组件想问宿主名，就必须先有人往这里加字段，而那会被
 * `composition/__tests__/assembly.test.ts` 的"组件不得询问宿主名"断言拦下。
 */
export interface ShellRuntime {
  readonly profileId: ProfileId
  /** 解析后的装配（含裁剪记录，供 H3「裁剪原因可查询」）。 */
  readonly assembly: Assembly
  /** 能力查询（组件与接线层的唯一分叉依据）。 */
  readonly has: (capability: CapabilityId) => boolean
  /** 该外壳是否可调整 Area 布局（由 `shellLayouts` 贡献的 `adjustableLayout` 决定）。 */
  readonly adjustableLayout: boolean
  /** 该外壳的落点清单（`shellLayouts.regions`）。 */
  readonly regions: readonly string[]
  /** 页面级键盘接管端口；`null` = 无宿主接管（独立页面/嵌入）。 */
  readonly pageKeyboard: PageKeyboardClaim | null
}

/** Vue 依赖注入键（外壳在其根组件 provide，子组件 inject）。 */
export const shellKey: InjectionKey<ShellRuntime> = Symbol('shell')

/**
 * 构造外壳运行实例。
 *
 * 端口实例由装配结果决定 —— **不是**由"当前宿主名"决定：
 *  - `pageKeyboard` 存在 ⟺ 装配里有 `wiki.upload`（= 宿主在页面级接管键盘的 profile）；
 *  - `adjustableLayout` 取自 `shellLayouts` 贡献（工作台 true、嵌入 false）。
 *
 * 于是"嵌入没有布局编辑"与"wiki 接管键盘"都是**装配**的后果，
 * 换一个 profile 就换掉，不需要改任何组件。
 */
export function createShellRuntime(assembly: Assembly, options?: { floatingUiScope?: () => HTMLElement | null }): ShellRuntime {
  const shellLayout = assembly.contributions.shellLayouts[0]?.contribution
  const hasWikiKeyboardOwner = capabilitiesOf(assembly).includes(CAPABILITY.WIKI_UPLOAD)
  const scope = options?.floatingUiScope
  const pageKeyboard: PageKeyboardClaim | null = hasWikiKeyboardOwner
    ? Object.freeze({
        claimsDocumentKeyboard: () => true,
        floatingUiScope: () => (scope ? scope() : null),
      })
    : null
  return Object.freeze({
    profileId: assembly.profileId,
    assembly,
    has: (capability: CapabilityId) => capabilitiesOf(assembly).includes(capability),
    adjustableLayout: shellLayout?.adjustableLayout ?? false,
    regions: Object.freeze([...(shellLayout?.regions ?? [])]),
    pageKeyboard,
  })
}

/**
 * **生产嵌入外壳**（EmbedRoot 唯一的装配入口）。
 *
 * ## 为什么要有这个工厂，而不是让 EmbedRoot 直接写 `createShellRuntimeForProfile(resolveShellProfile())`
 *
 * 工作台是"整个页面就是一个宿主"，它的 profile 来自**构建期**变量
 * （`resolveShellProfile()`）。嵌入不是：`StructureRender.js` 被打进任意 Wiki 页面，
 * 它**只有一个**装配形态。若照抄工作台的解析路径，就需要给嵌入库构建注入
 * `VITE_SHELL_PROFILE=embed` 之类的构建期常量 —— 那会让"嵌入用哪个 profile"
 * 变成构建配置的事实，而不是产品代码的事实（忘配一个就静默退回工作台装配）。
 *
 * ⇒ 嵌入的 profile **在这一行写死**，并由 `EmbedRoot` 消费、`provide(shellKey)`。
 * 生产事实因此可被测试直接调用（`assembly.test.ts` 的"生产装配输入"组）与
 * 运行实例读取（嵌入实例的 debug 只读面，见 `embed/embedAssemblyProbe`）。
 *
 * 无 `floatingUiScope`：嵌入不是页面所有者，浮层 UI 没有"宿主容器"可接管
 * （`pageKeyboard` 也因 EMBED_PROFILE 无 `wiki.upload` 而自然为 `null`）。
 */
export function createEmbedShellRuntime(): ShellRuntime {
  return createShellRuntimeForProfile(EMBED_PROFILE)
}

/** 解析一个 profile 并构造外壳运行实例（失败时抛 —— 启动期失败必须显式）。 */
export function createShellRuntimeForProfile(
  profile: ProfileDecl,
  options?: { floatingUiScope?: () => HTMLElement | null },
): ShellRuntime {
  const r = resolveComposition({ profileId: profile.id, modules: profile.modules })
  if (!r.ok) {
    throw new Error(`外壳装配失败（profile=${profile.id}）：${r.error.failures.map((f) => f.detail).join(' | ')}`)
  }
  return createShellRuntime(r.value, options)
}

/**
 * 在组件里取外壳运行实例。
 *
 * ## M7-5：未 `provide` ⇒ **抛错**（删除 `EMPTY_SHELL_RUNTIME` 兜底）
 *
 * 旧实现是 `inject(shellKey, EMPTY_SHELL_RUNTIME)`：忘了 `provide(shellKey)` 时静默拿到
 * 一个**能力空集**的外壳 —— 页面照常启动，只有若干能力面悄悄消失（Wiki 状态入口、
 * 可调整布局的菜单项…）。"失败关闭"本身没错（少做事，不多给能力），错的是**没有任何信号**：
 * 装配遗漏与"这个外壳本来就没有该能力"在运行期完全同形。那正是"忘了装配也能跑"的旁路。
 *
 * 因此兜底被**删除**而不是保留：未 provide 立即抛，装配遗漏在挂载时就响亮失败。
 * 能力查询仍只有 `shell.has(cap)` 一个入口（组件依旧问不到宿主名）。
 */
export function useShell(): ShellRuntime {
  const shell = inject(shellKey)
  if (shell === undefined) {
    throw new Error(
      '外壳运行实例未 provide：根组件必须 provide(shellKey, shell)（见 workbench/WorkbenchRoot.vue 与 embed/EmbedRoot.vue）',
    )
  }
  return shell
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建期输入（全 src/ 唯一读取处）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建期外壳 id 的环境变量名。
 *
 * 变量名与旧 `VITE_HOST_PROFILE` **不同**：旧变量描述的是"宿主是谁"
 * （`'desktop' | 'wiki'`），本变量描述的是"装配哪个 profile"
 * （`'workbench' | 'embed' | 'wiki' | 'headless'`）。
 * 两者语义不同，**不做名字映射** —— 那样会让旧判别在两个系统里同时存活
 * （`#171` 明令禁止的"新门面包旧核心"）。
 */
export const SHELL_PROFILE_ENV = 'VITE_SHELL_PROFILE'

/** 旧变量名（仅用于**兼容读取一次的迁移窗口**，见 `resolveShellProfile`）。 */
const LEGACY_HOST_PROFILE_ENV = 'VITE_HOST_PROFILE'

/**
 * 把构建期输入解析成一个 profile。
 *
 * 读取顺序（都只在本函数内发生）：
 *  1. `VITE_SHELL_PROFILE`（新变量，取值是 profile id）；
 *  2. `VITE_HOST_PROFILE`（**旧变量**，由本批不可触碰的共享文件
 *     `vite.wiki-workbench.config.ts` 定义）——**只**作为"该构建想跑 wiki 工作台"
 *     这一**一次性的构建期事实**被读入并**立刻**转成 `'wiki'` profile。
 *     转完即止：没有任何运行期代码能再看见它（能力来自装配结果）。
 *  3. 缺省 `'workbench'`。
 *
 * ## 为什么这一步是必要的、而不是"又留了一个旁路"
 *
 * `vite.wiki-workbench.config.ts` 属共享瓶颈文件（`#250`：构建配置由 P0/P1/P11 拥有），
 * 本批**不得**修改。若不读旧变量，wiki 构建会静默退化成工作台 profile
 * —— 那是**功能丢失**，比为迁移窗口读一次构建期常量严重得多。
 * 迁移窗口的退出条件是：某个后续批次把该 vite 配置改为注入 `VITE_SHELL_PROFILE`；
 * 届时本函数删掉第 2 步即可（**一行**，不是一次重构）。
 */
export function resolveShellProfile(env: Record<string, string | boolean | undefined> = readBuildEnv()): ProfileDecl {
  const direct = env[SHELL_PROFILE_ENV]
  if (typeof direct === 'string' && direct !== '') {
    const p = profileById(direct)
    if (p) return p
    // 未知 profile id：**不静默退回**工作台（那会让"我明明选了 embed"变成"跑了工作台"）
    throw new Error(`未知的 ${SHELL_PROFILE_ENV}=${direct}；可选：${ALL_PROFILES.map((x) => x.id).join(', ')}`)
  }
  const legacy = env[LEGACY_HOST_PROFILE_ENV]
  if (legacy === 'wiki') return profileById('wiki') ?? ALL_PROFILES[0]
  return profileById('workbench') ?? ALL_PROFILES[0]
}

/**
 * 读取构建期注入的环境变量。
 *
 * `import.meta.env` 只在 Vite 构建/开发期存在；在纯 Node（测试/扫描器）下
 * 会退化为一个空对象 ⇒ 拿到默认 profile。这条退化是**刻意的**：
 * 它让"装配根在非 Vite 环境里也能解析"成为事实，而不是靠 try/catch 兜。
 */
function readBuildEnv(): Record<string, string | boolean | undefined> {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | boolean | undefined> }
    return meta.env ?? {}
  } catch {
    return {}
  }
}

/** 未使用占位，保持 `ModuleDecl` 类型可达（供下游 `import type`）。 */
export type { ModuleDecl }