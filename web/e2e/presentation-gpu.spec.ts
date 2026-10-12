/**
 * P5 · A18 `gpu-batching` / A19 `resource-release` / A30 `graphics-recovery` —— **真实运行证据**。
 *
 * ## 被测对象与运行环境
 *
 * 被测的是 `src/presentation/**`（**生产模块**）在**真实 Chromium + 真实 WebGL** 下的行为：
 *  - A18 的判据是 `WebGLRenderer.info.render.calls`（真实 GL 统计）；
 *  - A19 的判据是**显式资源计数**（#249 §14 尾部明文：不以 GC 时机为唯一判断）；
 *  - A30 的判据是真实 `WEBGL_lose_context` 后的重建行为。
 *
 * ## 为什么直接驱动呈现层，而不走 Workbench UI
 *
 * #256 明文的集成边界是「A18/A19 需要真实可运行证据」+「集成在 Lead 合流时验证」：
 * 呈现层与 legacy `blockMesh` 渲染路径的接线属于**合流时**的集成项（P0 的
 * `boundary-rules` 也把 `presentation` 与旧 `render/` 并列为迁移中状态）。
 * 本批的可验收部分是呈现层自身在真实 GL 下的行为，因此探针直接驱动它 ——
 * 全程生产实现、零替身（无 Mock/Fake/Stub）。
 *
 * ## 探针为何在 `e2e/helpers/` 而非 `page.evaluate(() => import('three'))`
 *
 * 后者**必然失败**：Playwright 把函数序列化后在页面里裸执行，`three` 是裸说明符，
 * 页面没有 import map 可解析（实测 `Failed to resolve module specifier 'three'`）。
 * 只有经 vite dev server 转译的模块才会被重写说明符，故探针放在 vite root 之内，
 * 由 spec 以静态绝对路径加载 —— 与产品代码同一台 dev server、同一份 three 实例。
 *
 * ## 两侧分工（都跑、都报）
 *
 * | 判据 | 环境 | 数字 |
 * |---|---|---|
 * | 结构性绘制数 / 资源计数 | vitest（无 GPU） | `drawCallEstimate` / `ledger()` |
 * | **实测绘制数 / 真实上下文丢失** | **本 spec（真 Chromium）** | `info.render.calls` / `isContextLost()` |
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/** A18 夹具规模（#249 A18 原文：10,000 个同几何/材质不透明对象）。 */
const A18_COUNT = 10_000

/** 证据目录（走既有 gitignore 的 `web/e2e/screenshots/`；上传 Gitea 后即持久）。 */
const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'presentation')

type ProbeModule = {
  installP5Harness(): { ok: true }
  runA18(count: number): Record<string, unknown>
  runA18Negative(count: number): Record<string, unknown>
  runA19(rounds: number): Record<string, unknown>
  runA30(count: number, envelope?: Record<string, unknown>): Promise<Record<string, unknown>>
  runA30Negative(count: number): Record<string, unknown>
  runKernelInputs(envelope: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * 从夹具读**真实内核载荷**（`blockGrid` 的 `cells`/`cellGeometry`/`geometry`）。
 *
 * ## 为什么走信封解包而不是直接读 JSON
 *
 * 多方块夹具是**信封**（`documentFormat: 'Envelope'` + base64 内层），
 * 内层才有 `cells`/`geometry`。`plainRootOf` 是生产解包实现（D1 交付），
 * 用它保证 spec 读到的东西与内核读到的**同一份**。
 *
 * ## 为什么不用内层**完整** body 直接喂
 *
 * `kernelPresentationInputs` 要吃的是**内核场景**（`Scene`），而夹具是旧格式 plain。
 * 故这里只取它需要的四个字段，由探针在浏览器里组装成最小内核场景
 * —— 这样本判据证明的是"内核**承载的内容**能被吃下"，不掺入场景装配那一环
 * （那一环由 `kernelAssembly` 的单测把守）。
 */
/**
 * 读一份多方块夹具的**原始信封 JSON**（原样透传给探针）。
 *
 * ## 为什么只读字节、不在 Node 侧解包
 *
 * 第一版在这里解包并取 `cells`/`geometry` —— **实测失败**：磁盘上的夹具是**声明**
 * （`multiblock` 节点），逐格网格是**装配产物**（`.out/expanded-fixtures` 只含
 * `variant`/`dims`/`cellGrid` 的参考签名，不含带几何资产的载荷）。
 *
 * ⇒ 交给探针在浏览器里走**完整生产链**
 * （解析 → 内核装配 → 呈现输入 → 编译 → 真 GL）。
 * spec 只负责"把外部事实（磁盘上的字节）送进去"，不做任何解读 —— 这样失败的定位
 * 也清晰：解析/装配/编译哪一步坏了，探针会报出对应的一步。
 */
function loadKernelEnvelope(name: string): Record<string, unknown> {
  return JSON.parse(
    fs
      .readFileSync(
        path.join(import.meta.dirname, '..', 'src', 'context', '__tests__', 'fixtures', `${name}.json`),
        'utf8',
      )
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
}

/**
 * 信封 → 内层 plain（**最小实现**，与 `adapters/files/envelopeCodec` 同算法）。
 *
 * ## 为什么 spec 不 import 生产解包器
 *
 * `e2e/` 的文件在 **Node** 里跑（Playwright 侧），而 `plainRootOf` 依赖浏览器/Node 均可的
 * 纯函数 —— 技术上可以 import。但本 spec 已 import 了 `@/composition/...`（探针经 vite 转译），
 * 再加一条生产 import 会让"spec 读到的数据"与"页面里探针读到的数据"两条链路耦合。
 * 这里用最小实现读**磁盘上的字节**，使判据的输入是**外部事实**而非另一份生产代码的输出。
 */
function decodeEnvelopeToPlain(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope.documentFormat !== 'Envelope') return envelope
  const payload = envelope.payload
  if (typeof payload !== 'string') throw new Error('信封缺 payload')
  const bytes = Buffer.from(payload, 'base64')
  let text: string
  try {
    text = bytes[0] === 0x1f ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
  } catch {
    text = bytes.toString('utf8')
  }
  const inner = JSON.parse(text) as Record<string, unknown>
  const meta = envelope.meta
  return typeof meta === 'object' && meta !== null ? { ...inner, ...(meta as Record<string, unknown>) } : inner
}

/**
 * 加载探针模块。
 *
 * 用 `page.evaluate` 里**静态路径**的动态 import：vite 会把 `/e2e/helpers/...` 当模块请求
 * 转译后再返回，因此探针内部的 `three` / `@/presentation/*` 说明符由 vite 重写。
 */
async function loadProbe(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(async () => {
    const mod = (await import('/e2e/helpers/presentation/probe.ts')) as unknown as ProbeModule
    mod.installP5Harness()
  })
}

async function callProbe<T>(
  page: Page,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return await page.evaluate(
    async ({ fn, args }) => {
      const mod = (await import('/e2e/helpers/presentation/probe.ts')) as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >
      return await mod[fn]!(...args)
    },
    { fn, args },
  ) as T
}

/** 把一次测量落盘（附件名由上传者加提交短 SHA 前缀）。 */
function writeEvidence(name: string, payload: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

test.describe('P5 · A18 gpu-batching（真实 WebGL 实测绘制数）', () => {
  test('10,000 个同几何/同材质不透明对象 ⇒ 主色彩 pass 实测绘制数 ≤ 32', async ({ page }) => {
    await loadProbe(page)
    const m = await callProbe<Record<string, any>>(page, 'runA18', [A18_COUNT])
    console.log('[A18·实测] ' + JSON.stringify(m, null, 2))
    writeEvidence('a18-batching.json', m)

    // ── 主判据：实测绘制数 ≤ 32 ──
    expect(m.calls, `主色彩 pass 实测绘制数必须 ≤ ${m.budget}（A18 结构性门槛）`).toBeLessThanOrEqual(m.budget)
    // 结构性估计与实测一致（两侧口径对齐）
    expect(m.drawCallEstimate).toBeLessThanOrEqual(m.budget)
    expect(m.structBatches).toBeLessThanOrEqual(m.budget)
    // 真的画了东西（0 三角形 = 测了个空场景的假绿）
    expect(m.triangles, '必须真的提交了三角形').toBeGreaterThan(0)
    expect(m.instanceCount).toBe(A18_COUNT)
    expect(m.instanceable, '同质夹具应走实例化路径').toBe(true)

    // ── 拾取身份稳定（抽样 + 边界） ──
    expect(m.probes.every((p: any) => p.objectId !== null), '全部抽样槽位必须解回对象身份').toBe(true)
    expect(m.staleRejected, '错误世代上的批次索引必须被拒').toBe(true)

    // ── G2：移出一个对象不重建基础几何 ──
    expect(m.geometryBuildsAfterRemove, 'G2：移出一个实例不得重建基础几何').toBe(m.geometryBuildsBeforeRemove)

    // ── A19 侧的正面对照：dispose 后账守恒 ──
    expect(m.ledgerBalancedAfterDispose).toBe(true)
    expect(m.ledgerActiveAfterDispose).toBe(0)

    // ── 环境与夹具（证据可复现） ──
    expect(m.env.webgl2 ?? true).toBeTruthy()
    expect(m.fixtureHash).toMatch(/^[0-9a-f]{8}$/)
  })

  test('负对照：一对象一绘制（每对象独立材质）⇒ 实测绘制数远超 32', async ({ page }) => {
    await loadProbe(page)
    const m = await callProbe<Record<string, any>>(page, 'runA18Negative', [64])
    console.log('[A18·负对照] ' + JSON.stringify(m, null, 2))
    writeEvidence('a18-negative.json', m)

    expect(m.calls, '负对照：一对象一绘制必须被判红（实测绘制数 > 32）').toBeGreaterThan(32)
    // 一对象一绘制的**结构性**检出口：不同 tint ⇒ 互不相同的兼容性键（每对象一组）
    expect(m.distinctCompatKeys, '不同 tint 必须产生互不相同的兼容性组').toBe(m.objectCount)
    expect(m.homogeneous).toBe(false)
  })
})

/**
 * ## D3c（#289 P10d）· **内核场景**作为第二输入源
 *
 * 上面两条的输入来自 `pickFixture`（**自造图元**）⇒ 它们证明"编译 → 呈现"，
 * 但**绕过**了"内核场景 → `PresentationInputs`"。本组补上那一环。
 *
 * 判据刻意**不**与硬编码三角形数比，而与**渲染路径同一收集器**的独立复算比
 * —— 那样任一侧偏离立刻判红（D3a 修的那处"不剔除遮挡"缺陷正是这样被抓到的）。
 */
test.describe('D3c · 内核承载的内容真的能被呈现层吃下（真实 GL）', () => {
  test('多方块夹具：内核 → PresentationInputs → compileScene → 真实 GL 绘制 + 与渲染路径逐位一致', async ({ page }) => {
    await loadProbe(page)
    // 真实载荷由 spec 从磁盘读（浏览器里没有 fs）
    const payload = loadKernelEnvelope('multiblock-ebf-2ch')
    const m = await callProbe<Record<string, any>>(page, 'runKernelInputs', [payload])
    console.log('[D3c·内核输入] ' + JSON.stringify(m, null, 2))
    writeEvidence('d3c-kernel-inputs.json', m)

    // ① 接线真的成立（不是空产出）
    expect(m.primitives, '内核场景必须产出可呈现对象').toBeGreaterThan(0)
    expect(m.skipped, '本路径不得跳过任何对象').toEqual([])
    expect(m.compileSkipped, `编译不得跳过（实测：${JSON.stringify(m.compileSkipped)}）`).toEqual([])
    expect(m.payloads, '必须有批次').toBeGreaterThan(0)
    // ② 真实 GL 真的画了
    expect(m.measuredCalls, '真实 GL 绘制数必须 > 0').toBeGreaterThan(0)
    expect(m.measuredTriangles, '真实 GL 必须提交了三角形').toBeGreaterThan(0)
    // ③ 与渲染路径**逐位一致**（同一收集器；任一侧偏离立刻判红）
    expect(m.kernelTriangles, '内核侧三角形数').toBe(m.referenceTriangles)
    expect(m.bitsEqual, 'positions/uvs 必须与渲染路径逐位相同').toBe(true)
    // ④ 身份链没断：拾取能解回**内核对象 id**（由装配产出，故断言"非空且不是批次号"）
    expect(m.pickedObjectId, '拾取必须解回内核对象身份（不得为空）').toBeTruthy()
    expect(String(m.pickedObjectId), '对象身份不得是批次位置（A18 负对照：批次号不得当对象 ID）').not.toMatch(/^\d+$/)
  })

  test('**负对照**：另一份夹具 ⇒ 三角形数不同（证明上一条的"一致"不是常数巧合）', async ({ page }) => {
    await loadProbe(page)
    const a = await callProbe<Record<string, any>>(page, 'runKernelInputs', [loadKernelEnvelope('multiblock-ebf-2ch')])
    const b = await callProbe<Record<string, any>>(page, 'runKernelInputs', [loadKernelEnvelope('multiblock-tier-only')])
    expect(a.referenceTriangles, '两份夹具的三角形数必须不同（否则判据无区分力）').not.toBe(b.referenceTriangles)
    expect(b.bitsEqual, '第二份同样必须逐位一致').toBe(true)
    expect(b.measuredCalls, '第二份也必须在真实 GL 下画出东西').toBeGreaterThan(0)
  })
})

test.describe('P5 · A19 resource-release（真实 GL 下的显式计数平衡）', () => {
  test('两视口共享源数据：关其一不破坏另一方；全关回基线；重复 100 轮', async ({ page }) => {
    await loadProbe(page)
    const m = await callProbe<Record<string, any>>(page, 'runA19', [100])
    console.log('[A19·实测] ' + JSON.stringify(m, null, 2))
    writeEvidence('a19-resource-release.json', m)

    expect(m.rounds).toBe(100)
    expect(m.allRoundsBackToBaseline, '每轮全部关闭后活跃计数必须回基线（100/100）').toBe(true)
    expect(m.allRoundsPreservedOtherSide, '关闭其一不得破坏另一方（100/100）').toBe(true)
    expect(m.balancedEveryRound, '每轮账必须守恒（100/100）').toBe(true)
    expect(m.firstCloseActive, '关闭其一时另一方必须仍有资源').toBeGreaterThan(0)

    // 共享条目：恰好一次 dispose（"少一次 dispose"的判据面）
    expect(m.sharedAcquire).toBe(2)
    expect(m.sharedRelease).toBe(2)
    expect(m.sharedZeroCrossings, '归零只发生一次').toBe(1)
    expect(m.sharedDispose).toBe(1)
    expect(m.sharedDisposeCalls).toBe(1)
    expect(m.sharedBalanced).toBe(true)

    // 负对照 1：少一次 dispose ⇒ 判红
    expect(m.negativeLeakBalanced, '负对照：少一次 dispose 必须判红').toBe(false)
    expect(m.negativeLeakActive).toBeGreaterThan(0)
    // 负对照 2：提前释放 ⇒ 显式报错
    expect(m.negativeEarlySecondReleaseOk, '负对照：重复释放必须被拒').toBe(false)
    expect(m.negativeNeverAcquiredOk, '负对照：未 acquire 就 release 必须被拒').toBe(false)

    // 计数不是在真空里做的：同一夹具在真实 GL 上确实提交了绘制
    expect(m.liveGlDrawCalls).toBeGreaterThan(0)
  })
})

test.describe('P5 · A30 graphics-recovery（真实 WEBGL_lose_context）', () => {
  test('真实上下文丢失/恢复：旧句柄不复用、重建后才可提交、恢复失败可重试', async ({ page }) => {
    await loadProbe(page)
    // P11-E #262：传真实信封 ⇒ 会话面（文档/选择/时间/机位）四项也能被核对
    const m = await callProbe<Record<string, any>>(page, 'runA30', [512, loadKernelEnvelope('multiblock-ebf-2ch')])
    console.log('[A30·实测] ' + JSON.stringify(m, null, 2))
    writeEvidence('a30-graphics-recovery.json', m)

    // 前置：真实浏览器必须提供该扩展，否则本用例的"丢失"路径不成立
    expect(m.hadLoseExt, 'A30：真实上下文丢失需要 WEBGL_lose_context 扩展').toBe(true)
    expect(m.contextLostFlag, 'A30：真实上下文必须确实进入 lost 状态').toBe(true)

    // ── 丢失：受影响视口暂停提交，其他 Area 继续可用 ──
    expect(m.afterLossActive, 'A30：丢失后旧 GPU 句柄必须全部放弃').toBe(0)
    expect(m.afterLossChildren, 'A30：丢失后必须清空挂载（恢复时必然重建）').toBe(0)
    expect(m.submittableAfterLoss, 'A30：受影响视口必须被暂停提交').not.toContain('r-viewport')
    expect(m.submittableAfterLoss, 'A30：其他 Area 必须继续可用').toContain('r-wiki-preview')

    // ── 恢复：必须重建后才可提交 ──
    expect(m.canSubmitWhileRecovering, '恢复中不得提交').toBe(false)
    expect(m.afterRestoreActive, 'A30：恢复后归属资源必须重建').toBeGreaterThan(0)
    expect(m.afterRestoreChildren, 'A30：恢复后场景必须重新挂载').toBeGreaterThan(0)
    expect(m.restores).toBeGreaterThan(0)
    expect(m.generationUnchangedByRestore, 'A30：重建的必须是当前有效版本').toBe(true)

    // ── 恢复失败：可诊断、可重试（不冒充成功） ──
    expect(m.failedPhase).toBe('failed')
    expect(m.failedRetryable).toBe(true)
    expect(m.retryWorks, 'A30：恢复失败后必须允许重试').toBe(true)

    // ── P11-E #262 补 / P11-F 段② 升级：恢复后「文档 / 选择 / 时间 / 机位」四项不丢
    //    **且** GPU 真的重建（真 Chromium + 真上下文丢失） ──
    // 四项都不是 `null` ⇒ 判据**真的跑过**（缺信封时探针返回 null，本断言会判红）
    expect(m.sessionDetail, 'A30 会话面必须真的跑了（否则四项字段是没测过的空话）').not.toBeNull()
    expect(m.sessionDetail.firstApplied, '前置：会话面首次应用必须真的编了').toBe(true)
    expect(m.sessionDocPreserved, 'A30：恢复后**文档**不丢（同一输入 ⇒ 同一世代；且重建确实发生）').toBe(true)
    expect(m.sessionSelectionPreserved, 'A30：恢复后**选择**不丢（EditContext 选择引用不变）').toBe(true)
    expect(m.sessionTimePreserved, 'A30：恢复后**时间**不丢（求值键的时间逐字段不变）').toBe(true)
    expect(m.sessionCameraPreserved, 'A30：恢复后**机位**不丢（视口相机矩阵逐位不变）').toBe(true)
    // P11-F 段②（原 P11-E 缺口登记已升级为**正向判据**）：
    // 内容未变 + 上下文丢失 ⇒ 恢复必须**强制重建**（`needsRebuild` 绕过内容身份短路），
    // 否则画面永久空白；且返回值世代必须与实际世代同源。
    expect(
      m.sessionForcedRebuildAfterRestore,
      'A30：内容未变的上下文丢失后，恢复必须**真的重建**（不得走内容身份短路）',
    ).toBe(true)
    expect(m.sessionGpuRebuiltAfterRestore, 'A30：恢复后呈现器实际世代必须非空').toBe(true)
    expect(m.sessionMountedBatchesAfterRestore, 'A30：重建后必须有挂载的批次（画面非空白的结构代理）').toBeGreaterThan(0)
    expect(m.sessionGenerationConsistent, 'A30：会话返回结果的世代必须与实际世代同源（不得静默不一致）').toBe(true)
    expect(m.sessionGpuRebuiltAfterContentChange, '对照：内容变一次之后也重建，且**换世代**').toBe(true)
  })

  test('负对照：只 resize 而不重建归属资源 ⇒ 判红', async ({ page }) => {
    await loadProbe(page)
    const m = await callProbe<Record<string, any>>(page, 'runA30Negative', [64])
    console.log('[A30·负对照] ' + JSON.stringify(m, null, 2))
    writeEvidence('a30-negative.json', m)

    expect(m.children, '负对照：未重建时挂载必须为空 —— 判红读数').toBe(0)
    expect(m.active).toBe(0)
    expect(m.generation, '未重建时不得声称有当前世代').toBeNull()
  })
})
