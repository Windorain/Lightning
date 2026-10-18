/**
 * M7-1 · **寿命/隔离判据的共用探针**（G1/G2/G4/G5 共用；纯读面 + 真实 UI 操作）。
 *
 * ## 纪律（横切规则 §6-5）
 *
 * - **输入来自生产路径**：切工作区 = 真实点击工作区标签（`.wt-tab`）；分割/合并 =
 *   真实点击菜单（视图 → 水平/垂直分割区域 / 合并区域）。不调内部函数制造输入。
 * - **测量前把被测状态挪离默认值**：机位由调用方先设成显著非默认值
 *   （与 H1/DE-1..6 同口径：写权威逻辑机位 `main.ensureCamera(region)`，
 *   这是本仓既有的"制造非默认机位"手法，只作**前提**，不作观测）。
 * - **观测只用生产读面**：`window.__vm__`（WorkbenchRoot 显式声明的测试观测面）、
 *   `window.__areaHost__()`（WorkbenchRoot 显式暴露）、`window.__log__`（LogCenter 显式暴露）、
 *   以及真实 DOM。
 * - **CRLF 归一化**：文本读数一律 `replace(/\r\n/g, '\n')`（本仓 core.autocrlf=true）。
 */

import { expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  waitForViewportMounted,
} from './multiblock/harness'

/** 真实游戏内导出信封（与 H1 / embed-mobile 同一份夹具）。 */
export const FIXTURE = 'structuredata-exported-envelope.json'
/** 根 Area 的 region（`AreaLayoutHost#regionIdFor`：根 Area 复用该静态 region）。 */
export const ROOT_REGION = 'r-viewport'
/** 工作区标签文案（`domain/i18n.ts` 的 preview/export 词条，zh 默认语言）。 */
export const TAB_PREVIEW = '编辑'
export const TAB_EXPORT = '导出'
/** 视图菜单项文案（`workbench/ux/panels/menuBar.ts`）。 */
export const MENU_VIEW = '视图'
export const MENU_SPLIT_H = '水平分割区域'
export const MENU_MERGE = '合并区域'

export interface CameraPose {
  target: { x: number; y: number; z: number }
  yawDeg: number
  elevationDeg: number
  distance: number
  zoom: number
}

export interface EnginePose {
  m: number[] | null
  zoom: number | null
  frustum: (number | null)[]
}

export interface CameraReading {
  logical: CameraPose | null
  engine: EnginePose
}

/** 签名用的非默认机位（与 fit 机位显著不同；两区各用一档以便区分"串位"）。 */
export const POSE_A: CameraPose = {
  target: { x: 9, y: 1, z: 5 }, yawDeg: 35, elevationDeg: 20, distance: 6, zoom: 2.4,
}
export const POSE_B: CameraPose = {
  target: { x: -4, y: 3, z: 2 }, yawDeg: 128, elevationDeg: 55, distance: 17, zoom: 0.65,
}

/** 打开工作台 → 注入夹具 → 等真实 3D 视口挂载 → 等自动框选落地（机位基线稳定）。 */
export async function openWorkbenchWithScene(page: Page, settleMs = 1200): Promise<void> {
  const fixturePath = path.join(import.meta.dirname, '..', 'fixtures', FIXTURE)
  const json = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown
  await gotoWorkbench(page)
  await page.waitForFunction(
    () => typeof (window as any).__p7_input__?.counters === 'function',
    undefined,
    { timeout: 30_000 },
  )
  await injectSceneDocumentOk(page, json, FIXTURE)
  await waitForViewportMounted(page)
  await page.waitForTimeout(settleMs)
}

/** 读某 region 的机位：权威逻辑机位 + 真实 THREE 相机的取景三要素（与 H1 同口径）。 */
export async function readCamera(page: Page, region: string): Promise<CameraReading> {
  return (await page.evaluate((r) => {
    const vm = (window as any).__vm__
    const ref = vm.main.cameras[r]
    const logical = ref?.value ? JSON.parse(JSON.stringify(ref.value)) : null
    const cam = vm.viewports.get(r)?.camera?.value ?? null
    return {
      logical,
      engine: {
        m: cam?.matrixWorld?.elements ? Array.from(cam.matrixWorld.elements as number[]) : null,
        zoom: typeof cam?.zoom === 'number' ? cam.zoom : null,
        frustum: [cam?.left ?? null, cam?.right ?? null, cam?.top ?? null, cam?.bottom ?? null],
      },
    }
  }, region)) as CameraReading
}

/** 把机位挪到**显著非默认**位置（前提设置，不是观测）。 */
export async function setCamera(page: Page, region: string, pose: CameraPose): Promise<void> {
  await page.evaluate(({ r, p }) => {
    const vm = (window as any).__vm__
    vm.main.ensureCamera(r).value = {
      target: { x: p.target.x, y: p.target.y, z: p.target.z },
      yawDeg: p.yawDeg,
      elevationDeg: p.elevationDeg,
      distance: p.distance,
      zoom: p.zoom,
    }
  }, { r: region, p: pose })
  await page.waitForTimeout(900)
}

/** 引擎机位"取景是否相同"（浮点容差；容差远小于重新框选造成的差异）。 */
export function expectEngineClose(actual: EnginePose, expected: EnginePose, label: string): void {
  expect(actual.m, label + '：引擎相机必须存在').not.toBeNull()
  expect(expected.m, label + '：基线引擎相机必须存在').not.toBeNull()
  expect(actual.m!.length, label + '：矩阵长度').toBe(expected.m!.length)
  for (let i = 0; i < expected.m!.length; i++) {
    expect(
      Math.abs(actual.m![i]! - expected.m![i]!),
      label + '：matrixWorld[' + i + '] ' + actual.m![i] + ' vs ' + expected.m![i],
    ).toBeLessThan(1e-3)
  }
  expect(actual.zoom, label + '：zoom').toBeCloseTo(expected.zoom ?? NaN, 4)
  expect(actual.frustum, label + '：正交取景框').toEqual(expected.frustum)
}

export interface LeafInfo { areaId: string; region: string }

export interface AreaState {
  areaIds: string[]
  leaves: LeafInfo[]
  leafCount: number
  canvasCount: number
  hasLayout: boolean
  activeAreaId: string | null
  cameraKeys: string[]
}

/** Area 布局的真实观测（DOM 叶子 + 会话读面 + `Main` 实际分配的相机键）。 */
export async function readAreaState(page: Page): Promise<AreaState> {
  return (await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const host = (window as any).__areaHost__?.() ?? null
    // 只取叶子：`.area-host` 自身也带 `data-area-id`（同一 Area 会被数两次）。
    const cells = Array.from(
      document.querySelectorAll('.area-node--leaf[data-area-id]'),
    ) as HTMLElement[]
    const leaves = cells.map((c) => ({
      areaId: c.dataset.areaId ?? '',
      region: c.dataset.wmRegion ?? '',
    }))
    return {
      areaIds: host ? [...(host.areaIds.value as string[])] : [],
      leaves,
      leafCount: cells.length,
      canvasCount: document.querySelectorAll('.vc-viewport canvas').length,
      hasLayout: host ? host.workspace.value.layout !== null : false,
      activeAreaId: host ? (host.activeAreaId.value as string | null) : null,
      cameraKeys: ctx ? [...(ctx.main.cameraKeys() as string[])] : [],
    }
  })) as AreaState
}

/** 真实点击工作区标签（工作台顶栏 `.wt-tab`）。 */
export async function clickWorkspaceTab(page: Page, label: string): Promise<void> {
  const tab = page.locator('.wt-tab', { hasText: new RegExp('^' + label + '$') })
  await expect(tab, '工作区标签「' + label + '」必须可见').toBeVisible({ timeout: 15_000 })
  await tab.click()
}

/** 切到另一工作区（默认导出）再从列表切回，返回"离开态"的观测（用于证明呈现真的被卸载）。 */
export async function leaveAndReturnWorkspace(
  page: Page,
  away: string = TAB_EXPORT,
  back: string = TAB_PREVIEW,
  opts: { expectLeaves?: number } = {},
): Promise<{ awayArea: AreaState }> {
  const expectLeaves = opts.expectLeaves ?? 1
  await clickWorkspaceTab(page, away)
  // 呈现真的被卸载（否则"状态没丢"是空转：组件根本没走）
  await expect
    .poll(async () => await page.locator('.area-node--leaf').count(), {
      message: '离开工作区后 Area 呈现必须真的被卸载（否则判据空转）',
      timeout: 20_000,
    })
    .toBe(0)
  await expect
    .poll(async () => await page.locator('.vc-viewport canvas').count(), {
      message: '离开工作区后 3D 画布必须真的被销毁',
      timeout: 20_000,
    })
    .toBe(0)
  const awayArea = await readAreaState(page)

  await clickWorkspaceTab(page, back)
  if (expectLeaves === 1) {
    await waitForViewportMounted(page, 60_000)
  } else {
    // 多区往返：不能读"第一个 .vc-viewport"（strict 模式会因多个匹配失败），
    // 改为等"叶子数 = 画布数 = 期望区数"这一事实（每个区都真的挂上了画布）。
    await expect
      .poll(async () => {
        const leaves = await page.locator('.area-node--leaf').count()
        const canvases = await page.locator('.vc-viewport canvas').count()
        return leaves + ':' + canvases
      }, { message: '切回后必须仍有 ' + expectLeaves + ' 个 Area 且各自挂上画布', timeout: 60_000 })
      .toBe(expectLeaves + ':' + expectLeaves)
  }
  // 重挂后的自动框选（缺陷形态）在 @ready 之后若干百毫秒内落地，等够再读
  await page.waitForTimeout(1800)
  return { awayArea }
}

/** 真实点击菜单项（顶栏 `.ux-menu-btn` → 下拉 `.ux-menu-item`）。 */
export async function clickMenuItem(page: Page, menu: string, item: string): Promise<void> {
  // 顶栏菜单只有 文件/编辑/视图/帮助 四项，直接用文案子串匹配（避免正则转义在字符串里失真）。
  const btn = page.locator('.ux-menu-btn', { hasText: menu })
  await expect(btn, '菜单「' + menu + '」必须可见').toBeVisible({ timeout: 15_000 })
  await btn.click()
  const entry = page.locator('.ux-menu-item', { hasText: item })
  await expect(entry, '菜单项「' + item + '」必须可见').toBeVisible({ timeout: 10_000 })
  await entry.click()
}

export interface LayoutSignature {
  /** 叶子 Area（id + 编辑器类型）；`instanceId`/`localState` 刻意不取（见下）。 */
  areas: { id: string; editorType: string }[]
  /** 分割节点（id + 方向 + 比例）。 */
  splits: { id: string; direction: string; ratio: number }[]
}

/**
 * 布局**结构**签名（分割树的值面）。
 *
 * `instanceId` 与 `localState` 刻意**不**纳入：`instanceId` 是接线层分配的运行期身份
 * （S0-B §2.2：重挂时必然换代，属 M7-2 的"实例身份跨承载保持"工作包），
 * 本判据钉的是 §7.3-a 的**布局与观察视角**：区数、分割方向与比例、各区的类型。
 */
export async function readLayoutSignature(page: Page): Promise<LayoutSignature> {
  return (await page.evaluate(() => {
    const host = (window as any).__areaHost__?.() ?? null
    const out = { areas: [] as { id: string; editorType: string }[], splits: [] as { id: string; direction: string; ratio: number }[] }
    if (!host) return out
    const walk = (n: any): void => {
      if (n === null || n === undefined) return
      if (n.kind === 'area') {
        out.areas.push({ id: String(n.id), editorType: String(n.editorType) })
        return
      }
      out.splits.push({ id: String(n.id), direction: String(n.direction), ratio: Number(n.ratio) })
      walk(n.first)
      walk(n.second)
    }
    walk(host.workspace.value.layout)
    return out
  })) as LayoutSignature
}

export interface LedgerReading {
  /** 活跃资源总数（等价 `runtime/lifecycle#totalActive`：所有实例的资源计数之和）。 */
  totalActive: number
  /** 仍持有资源的活跃实例（等价 `leaks()`）。 */
  leaks: { instanceId: string; editorType: string; resources: Record<string, number> }[]
  /** 活跃实例 id（稳定排序）。 */
  activeInstanceIds: string[]
  /** 已关闭实例的累计数（`closeInstance` 每次 +1）。 */
  releasedTotal: number
}

/**
 * 读 Area 资源账本。
 *
 * ## 读面核实（本包前置，S0-B 提示"先核实该调试读面存在与用法"）
 *
 * `WorkbenchRoot.vue:162-166` 暴露 `window.__areaHost__ = () => ctx.requireAreaSession()`，
 * 其返回对象（`editors/useAreaHost.ts:84-108` 的 `AreaHostApi`）带
 * `ledger: Ref<LifecycleLedger>`。`runtime/lifecycle` 的 `totalActive`/`leaks` 是**纯函数**，
 * 生产没有把它们挂到 window 上，故这里按**其定义**（`lifecycle.ts:162-168` / `:197-203`）
 * 从账本值现算 —— 与读面同源，不是替身（没有第二套判定语义：
 * totalActive = Σ 各实例 resources 计数；leaks = 仍持有资源的实例，按 id 排序）。
 */
export async function readLedger(page: Page): Promise<LedgerReading> {
  return (await page.evaluate(() => {
    const host = (window as any).__areaHost__?.() ?? null
    if (!host) return { totalActive: -1, leaks: [], activeInstanceIds: [], releasedTotal: -1 }
    const ledger = host.ledger.value as {
      instances: Record<string, { instanceId: string; editorType: string; resources: Record<string, number> }>
      releasedTotal: number
    }
    const instances = Object.values(ledger.instances)
    let totalActive = 0
    for (const rec of instances) for (const c of Object.values(rec.resources)) totalActive += c
    const leaks = instances
      .filter((rec) => Object.keys(rec.resources).length > 0)
      .map((rec) => ({ instanceId: rec.instanceId, editorType: rec.editorType, resources: { ...rec.resources } }))
      .sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0))
    return {
      totalActive,
      leaks,
      activeInstanceIds: Object.keys(ledger.instances).sort(),
      releasedTotal: ledger.releasedTotal,
    }
  })) as LedgerReading
}

export interface HintReading {
  /** 底栏文本（状态栏 = 用户可见面）。 */
  statusBar: string
  /** 实时状态槽（#399 读面：`data-live-status` + 文案）。 */
  liveStatus: { message: string; state: string } | null
  /** 最后一条可显示日志（底栏第二条位的来源）。 */
  lastDisplayable: string | null
  /** 近若干条 WARN/ERROR 日志（生产诊断面）。 */
  warnings: string[]
}

/** 收集"用户能看到/能查到的提示"（CRLF 归一化）。 */
export async function collectHint(page: Page): Promise<HintReading> {
  return (await page.evaluate(() => {
    const norm = (s: string | null | undefined): string => (s ?? '').replace(/\r\n/g, '\n')
    const log = (window as any).__log__ ?? null
    const live = log?.liveStatus?.() ?? null
    const last = log?.lastDisplayable?.() ?? null
    const warns = (log?.recent?.(8 | 16, 40) ?? []) as { source?: string; message?: string }[]
    const liveEl = document.querySelector('.sb-root [data-live-status]')
    return {
      statusBar: norm(document.querySelector('.sb-root')?.textContent ?? ''),
      liveStatus: live
        ? { message: norm(live.message), state: String(live.state) }
        : liveEl
          ? { message: norm(liveEl.textContent), state: liveEl.getAttribute('data-live-status') ?? '' }
          : null,
      lastDisplayable: last ? norm(last.message) : null,
      warnings: warns.map((w) => norm((w.source ? w.source + ' ' : '') + (w.message ?? ''))),
    }
  })) as HintReading
}
