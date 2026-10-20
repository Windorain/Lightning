/**
 * 「本树身份」核验 —— 消除 e2e 的**连错服务假绿**。
 *
 * ## 背景
 *
 * `web/playwright.config.ts` 的 `webServer.reuseExistingServer: true` 会把「端口上已经有东西」
 * 当作「我的服务已就绪」。多棵工作树同时跑 e2e 时，端口上跑的可能是**另一棵树**的 vite，
 * 于是本树的测试对着别人的代码跑，并**把别人的绿当自己的证据**。仅靠"记得换端口"是人的纪律，
 * 不是机器判据 —— 所以这里给出可执行的判据。
 *
 * ## 判据
 *
 * 本树的服务在 `vite.config.ts` 暴露 `GET /__tree__` → `{ root, nonce, pid }`：
 *  - `root`  = 该 vite 的规范化项目根（`...\<本树>\web`），**每棵树互不相同** —— 主判据；
 *  - `nonce` = 本次运行新生成的随机串，经 `webServer.env.VITE_TREE_NONCE` 交给 vite —— 第二因子。
 *
 * 断言（见 `assertTreeIdentity`）：
 *  1. 端点必须可达且是 JSON（否则端口上是别的东西 / 不是 vite）——**失败**；
 *  2. `root` 必须等于本配置所在目录 ——**失败**即说明连上了别棵树的服务；
 *  3. 两侧都有 nonce 时必须逐字相等（同树手工起的 server 没有 nonce，不算失败）。
 *
 * 注意**故意不校验** nonce 缺席的情况：同一棵树上，用户自己 `npx vite` 起的服务没有
 * `VITE_TREE_NONCE`，但它确实是本树的服务，`root` 判据已足够，不应当误伤。
 *
 * ## 来源
 *
 * 机制沿用 `integration/edit-arch` 的 PR #243（提交 b4e5649，Gitea #171 / #173 端口隔离），
 * 按本树 `dbeb8c8` 基线的现状适配：本树 `vite.config.ts` 此前无 `treeIdentityPlugin`，
 * `playwright.config.ts` 此前无 `globalSetup`，`web/scripts/` 此前不存在 —— 均为本单新增。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 默认端口；不设 `PLAYWRIGHT_PORT` 时行为与改动前**完全一致**。 */
export const DEFAULT_E2E_PORT = 5199

/** 本树 `web/` 的绝对路径（本模块、`playwright.config.ts`、`global-setup.ts` 同在 `web/e2e` 下）。 */
export const TREE_WEB_ROOT = path.resolve(import.meta.dirname, '..')

/** 子进程（vite）侧读的环境变量名。 */
export const TREE_NONCE_INJECTED_ENV = 'VITE_TREE_NONCE'
/**
 * 外壳 profile 的**构建期输入**变量名（M8-2）。
 *
 * 必须与 `src/composition/shell.ts#SHELL_PROFILE_ENV` 逐字相同：
 * 它就是客户端 `import.meta.env.VITE_SHELL_PROFILE` 的来源，而这正是
 * `resolveShellProfile()` 的唯一输入。e2e 侧注入它、`/__tree__` 报告它、
 * globalSetup 断言它 —— 三处用的是同一个字符串。
 */
export const SHELL_PROFILE_ENV = 'VITE_SHELL_PROFILE'
/** 本次 playwright 运行持有的 nonce（config 生成 → globalSetup 比对）。 */
export const TREE_NONCE_ENV = 'PLAYWRIGHT_TREE_NONCE'
/** 服务身份端点。 */
export const TREE_IDENTITY_PATH = '/__tree__'

export interface TreeIdentity {
  root: string | null
  nonce: string | null
  pid: number | null
  /**
   * 该服务**实际按哪个外壳 profile 装配**（M8-2）。
   *
   * 取自服务进程的 `VITE_SHELL_PROFILE`（与客户端 `import.meta.env` 同一个变量）。
   * `null` = 服务没声明 ⇒ 应用按 `composition/shell#resolveShellProfile` 的缺省
   * 回落成 `'workbench'`（这也是手工 `npx vite` 起的服务的样子）。
   */
  profile: string | null
}

/**
 * 解析本次运行使用的端口：`PLAYWRIGHT_PORT` 优先，缺省 5199。
 * 非法值（非数字 / 越界）直接抛 —— 静默回落到默认端口会让两棵树又撞到一起。
 */
export function resolvePort(raw: string | undefined = process.env.PLAYWRIGHT_PORT): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_E2E_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[e2e 端口隔离] PLAYWRIGHT_PORT 非法：${JSON.stringify(raw)}（应为 1..65535 的整数）`)
  }
  return port
}

/** 与端口绑定的 baseURL（config 与 globalSetup 用**同一个**函数，杜绝两处漂移）。 */
export function resolveBaseURL(port: number = resolvePort()): string {
  return `http://localhost:${port}`
}

// ─────────────────────────────────────────────────────────────────────────────
// M8-2：**同一次运行里的第二个服务** —— wiki-profile 入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * wiki-profile 服务的端口（**同树、同一次运行、同一条身份核验链**）。
 *
 * 为什么需要第二个服务而不是"一次运行一个 profile"：S1 的三条生产保存路径里，
 * 「保存到文件」只在 workbench profile 的菜单里（wiki 文件菜单以 Wiki 三项取代它），
 * 而「保存到 Wiki」只在 wiki profile 里（`wiki.upload` 能力 + `isWikiApiAvailable()`）。
 * 一条 spec 要同时判这两族，就必须**同时**有两个服务，否则只能靠"跳过"——
 * 而静默跳过正是本仓库明令禁止的假绿形态。
 *
 * 端口取主槽 **+1**（例如 5216 → 5217），保持"每棵树一对端口、互不共享"的口径；
 * 需要时可用 `PLAYWRIGHT_WIKI_PORT` 显式覆盖。与服务身份一起被
 * `e2e/global-setup.ts` 核验（root + nonce + **profile**），连错服务会直接失败。
 */
export const WIKI_PORT_OFFSET = 1
export const WIKI_PORT_ENV = 'PLAYWRIGHT_WIKI_PORT'

/** 解析 wiki-profile 服务端口：`PLAYWRIGHT_WIKI_PORT` 优先，缺省主槽 +1。 */
export function resolveWikiPort(mainPort: number = resolvePort(), raw: string | undefined = process.env[WIKI_PORT_ENV]): number {
  if (raw === undefined || raw.trim() === '') return mainPort + WIKI_PORT_OFFSET
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[e2e 端口隔离] ${WIKI_PORT_ENV} 非法：${JSON.stringify(raw)}（应为 1..65535 的整数）`)
  }
  if (port === mainPort) {
    throw new Error(
      `[e2e 端口隔离] wiki-profile 服务不能与主服务共用端口（${port}）—— 两个 profile 必须是两个服务。`,
    )
  }
  return port
}

export function resolveWikiBaseURL(port: number = resolveWikiPort()): string {
  return `http://localhost:${port}`
}

/**
 * wiki-profile 服务用的 nonce（由主服务的 nonce 派生，**唯一**换算点）。
 *
 * 为什么派生而不是复用同一个值：两个服务的证据文件按端口分别落盘，凭据里
 * "这个 nonce 是本次运行的两个服务之一"要能分别核对；派生规则只有这一处，
 * config 与 globalSetup 不会各写一份而漂移。
 */
export function wikiNonceOf(nonce: string | null): string | null {
  return nonce === null ? null : `${nonce}w`
}

/** 主服务的 profile 期望值（应用缺省值 ⇒ `null` 也算成立，见 `TreeIdentity.profile`）。 */
export const MAIN_PROFILE_EXPECTATIONS: readonly (string | null)[] = ['workbench', null]
/** wiki-profile 服务的期望值：**必须**显式为 `'wiki'`（缺省回落是 workbench，不能接受）。 */
export const WIKI_PROFILE_EXPECTATIONS: readonly (string | null)[] = ['wiki']

/** 本次运行的服务身份标记（随机 nonce + 本树根）。 */
export function newTreeNonce(): string {
  return crypto.randomBytes(8).toString('hex')
}

/** 读取 `baseURL` 上服务的身份；连不上/不是 JSON/非 2xx ⇒ `null`。 */
export async function readTreeIdentity(baseURL: string, timeoutMs = 15_000): Promise<TreeIdentity | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(new URL(TREE_IDENTITY_PATH, baseURL), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<TreeIdentity>
    return {
      root: typeof body.root === 'string' ? body.root : null,
      nonce: typeof body.nonce === 'string' ? body.nonce : null,
      pid: typeof body.pid === 'number' ? body.pid : null,
      profile: typeof body.profile === 'string' ? body.profile : null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 路径归一化后再比较。
 *
 * 注意 **vite 报告的 `root` 用正斜杠**（`D:/Workspace/.../web`），而本进程的
 * `path.resolve()` 在 Windows 上给反斜杠 —— 只 lowercase 不比会**处处误报**。
 * 这里统一分隔符 + 去尾部斜杠 + 大小写无关（Windows 路径大小写不敏感）。
 */
export function normalizeTreePath(p: string): string {
  return path.resolve(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 断言 `baseURL` 上的服务属于**本树**（`TREE_WEB_ROOT`）；不一致则抛错。
 * 抛出的错会让整次 playwright 运行判失败 —— 不会有一份"看起来是绿的"报告流出去。
 */
export function assertTreeIdentity(
  identity: TreeIdentity | null,
  baseURL: string,
  expectedNonce: string | null,
  expectedProfiles?: readonly (string | null)[],
): void {
  if (identity === null) {
    throw new Error(
      `[e2e 端口隔离] ${baseURL} 上的服务没有回应 ${TREE_IDENTITY_PATH}（拿不到身份）⇒ 无法证明` +
        `「跑的是本树」。可能端口上是别的进程，或不是本树的 vite。\n` +
        `  本树 web 根：${TREE_WEB_ROOT}`,
    )
  }
  if (identity.root === null) {
    throw new Error(`[e2e 端口隔离] ${baseURL} 的身份响应缺少 root 字段 ⇒ 无法证明是本树。`)
  }
  if (normalizeTreePath(identity.root) !== normalizeTreePath(TREE_WEB_ROOT)) {
    throw new Error(
      `[e2e 端口隔离] 连错服务（假绿）！${baseURL} 上跑的是**另一棵树**的服务：\n` +
        `  端口服务的 web 根：${identity.root}\n` +
        `  本树的   web 根：${TREE_WEB_ROOT}\n` +
        '两棵树共用了同一端口。每棵树必须用自己的 test slot' +
        '（约定见工作区根的 .workspace/ports.json），例如：\n' +
        '  $env:PLAYWRIGHT_PORT=5209; npm run test:e2e:tree',
    )
  }
  if (identity.nonce !== null && expectedNonce !== null && identity.nonce !== expectedNonce) {
    throw new Error(
      `[e2e 端口隔离] ${baseURL} 的服务身份 nonce 不匹配（期望 ${expectedNonce}，实得 ` +
        `${identity.nonce}）⇒ 该服务不是本次运行拉起的。`,
    )
  }
  if (expectedProfiles !== undefined) {
    const ok = expectedProfiles.some((p) => p === identity.profile)
    if (!ok) {
      throw new Error(
        `[e2e 外壳 profile 核验] ${baseURL} 上的服务按 **${identity.profile ?? '(未声明 ⇒ workbench 缺省)'}** ` +
          `装配，而本次运行要求 ${expectedProfiles.map((p) => p ?? '(未声明)').join(' | ')} ⇒ ` +
          `判据会跑错外壳（例如 S1 的 Wiki 半边会因为根本没有 wiki.upload 而假绿/假红）。`,
      )
    }
  }
}

/**
 * 在 `web/test-results/` 下留一份**机器可读**的身份核验凭据（证据纪律：结论要能落盘）。
 * 文件名带端口，便于并发时分别归档。
 */
export function writeIdentityEvidence(
  baseURL: string,
  identity: TreeIdentity,
  expectedNonce: string | null,
  port: number,
  expectedProfiles?: readonly (string | null)[],
): string {
  const dir = path.join(TREE_WEB_ROOT, 'test-results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `tree-identity-${port}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        baseURL,
        port,
        served: identity,
        expected: { root: TREE_WEB_ROOT, nonce: expectedNonce, profile: expectedProfiles ?? null },
        verdict: 'match',
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  )
  return file
}
