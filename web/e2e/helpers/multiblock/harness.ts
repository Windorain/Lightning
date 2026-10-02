/**
 * T2.6 无头渲染断言管线 —— 骨架 harness（第一阶段）。
 *
 * 零替身五原则的落点（逐条）：
 *  1. **入口挂载**：`gotoWorkbench()` 打开 `/`（`index.html` → `main-dev.ts` → `DevApp.vue`
 *     → 完整 `WorkbenchRoot.vue`），不挂测试壳、不 import 内部模块拼装。
 *  2. **DOM 事件注入**：`setSliderValue()` / `pressSliderKey()` / `clickLocator()` 全部
 *     作用在真实 DOM 元素上（range input、tab 按钮），由浏览器派发
 *     `input`/`change`/`click`/`keydown`；绝不直接调用 operator 或内部函数。
 *     （`ctx.getOperators().exec(...)` 仅用于**等价于生产路径的 IO 接管**，
 *     见第 3 条——它不是观测点。）
 *  3. **IO 接管**：`injectSceneDocument()` 用 `File` + `OPERATOR_OPEN_SCENE` 注入场景。
 *     该 seam 就是**生产代码自己的入口**——`WorkbenchViewport.vue` 的
 *     `onDrop()` 对拖入的 .json 走同一 operator、同一 `file` 属性。
 *     因此没有为测试新开 src 侧后门；仓库 fixture 原件永不被改写
 *     （篡改只在测试内对注入副本进行）。
 *  4. **公开观测**：观测集合 = `window.__vm__`（`WorkbenchRoot.vue` 显式声明的
 *     「测试层通过 window.__vm__ 访问公开观测面」）上的
 *     `ctx.getDoc()` / `ctx.getCurrentFrameIndex()` / `ctx.getLayerWorldY()` /
 *     `ctx.viewports.get('r-viewport')`（`definition` / `layerPreview`），
 *     加上 DOM（`.vp-dock__stat`、`#wm-layer-range` 的 aria）与截图。不读任何私有字段。
 *  5. **零替身**：全程生产类实例；无 Mock/Fake/Stub，无测试专用 URL 参数。
 */

import { expect, type Locator, type Page } from '@playwright/test'

/** Workbench 入口（`web/index.html`，与 `obj-export.spec.ts` 同入口）。 */
export const WORKBENCH_URL = '/'
/** 视口 region id（`src/runtime/regionIds.ts` 的 `REGION.WORKBENCH_VIEWPORT`）。 */
export const VIEWPORT_REGION = 'r-viewport'
/** 帧滑杆（`WorldFrameScrubber.vue`）。 */
export const FRAME_SLIDER = 'input.nei-slider__range[aria-label^="当前帧"]'
/** 分层预览滑杆（`LayerPreviewBar.vue`，id 固定）。 */
export const LAYER_SLIDER = '#wm-layer-range'
/** 顶部 dock 的 tab 行（`ViewportFrameLayerDock.vue`）。 */
export const DOCK = '.vp-dock'
/** 播放/暂停按钮（`WorldFramePlayerControls.vue`）。 */
export const PLAYBACK_BUTTON = '.wm-wfp-controls .nei-ctrl-btn'
/** dock 右上角状态容器：含 `帧 i/N` 与 `层 <label>` 两个 stat。 */
export const DOCK_STAT = '.vp-dock__stat'
/** dock 状态行容器（读整行文本用这个；`.vp-dock__stat` 有两个）。 */
export const DOCK_STATUS = '.vp-dock__tab-status'
/** 真实 3D 画布容器（`RenderEngineHost.vue`）。 */
export const VIEWPORT_CANVAS = '.vc-viewport'

// ---------------------------------------------------------------------------
// 入口挂载
// ---------------------------------------------------------------------------

/**
 * 打开完整 Workbench 并等到 `__vm__` 公开观测面就绪。
 *
 * 此时**还没有**场景：`RenderEngineHost` 只在 `loadStatus === 'ok'` 时挂载，
 * 所以 `.vc-viewport` 要等注入场景之后才出现（见 `waitForViewportMounted`）。
 */
export async function gotoWorkbench(page: Page): Promise<void> {
  // 生产路径在「有未保存修改」时会走 window.confirm 询问；
  // 测试视作「确认丢弃」，避免 headless 下默认 dismiss 造成误判。
  page.on('dialog', (d) => {
    void d.accept()
  })
  await page.goto(WORKBENCH_URL)
  await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, {
    timeout: 90_000,
  })
  await expect(page.locator('.wb-shell')).toBeVisible({ timeout: 90_000 })
}

/** 等到真实 3D 容器（`.vc-viewport`）挂载——即 `loadStatus === 'ok'` 且定义就绪。 */
export async function waitForViewportMounted(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator(VIEWPORT_CANVAS)).toBeVisible({ timeout })
}

/** 等到 doc 非空（加载成功后才有 document）。 */
export async function waitForDocLoaded(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const ctx = (window as any).__vm__
      return !!ctx && ctx.getDoc().value !== null
    },
    undefined,
    { timeout },
  )
}

/**
 * 等到「已渲染网格」= 视口 slot 的 `definition` 非空。
 * 仅对帧为主文档有意义（多方块文档的网格由 T2.2/T2.5 装配后写入，同理适用）。
 */
export async function waitForRenderedGrid(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (regionId) => {
      const ctx = (window as any).__vm__
      const slot = ctx?.viewports?.get(regionId)
      return !!slot && slot.definition.value !== null
    },
    VIEWPORT_REGION,
    { timeout },
  )
}

/** 等到当前帧索引为 `index`（公开观测点 `ctx.getCurrentFrameIndex()`）。 */
export async function waitForFrameIndex(page: Page, index: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (i) => {
      const ctx = (window as any).__vm__
      return !!ctx && ctx.getCurrentFrameIndex().value === i
    },
    index,
    { timeout },
  )
}

/** 等到图层 Y 为 `y`（公开观测点 `ctx.getLayerWorldY()`）。 */
export async function waitForLayerY(page: Page, y: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (v) => {
      const ctx = (window as any).__vm__
      return !!ctx && ctx.getLayerWorldY().value === v
    },
    y,
    { timeout },
  )
}

// ---------------------------------------------------------------------------
// IO 接管：场景注入
// ---------------------------------------------------------------------------

export interface InjectResult {
  docLoaded: boolean
  docId: string | null
  isMultiblock: boolean | null
  frameCount: number | null
  /** 解析失败时 parser registry 返回的原因（生产 UI 会把它写进日志）。 */
  parseError: string | null
}

/**
 * 通过**生产代码自己的拖放路径**注入场景文档（IO 接管）。
 *
 * 走 `OPERATOR_OPEN_SCENE` + `{ file }`：与 `WorkbenchViewport.vue#onDrop` 中的
 * `ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })` 完全一致，
 * 因此无需在 src 侧新增任何注入口。
 *
 * `json` 由调用方给出——可以是仓库 fixture 原件，也可以是测试内动态篡改的副本
 * （篡改副本在内存里，不落盘、不改仓库原件）。
 */
export async function injectSceneDocument(
  page: Page,
  json: unknown,
  fileName: string,
): Promise<InjectResult> {
  const text = JSON.stringify(json)
  return await page.evaluate(
    async ({ text, fileName }) => {
      const ctx = (window as any).__vm__
      if (!ctx) throw new Error('T2.6: window.__vm__ 未就绪')
      const file = new File([text], fileName, { type: 'application/json' })
      // 与生产拖放同一入口
      await ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
      const doc = ctx.getDoc().value
      return {
        docLoaded: doc !== null,
        docId: doc?.id ?? null,
        isMultiblock: doc ? doc.isMultiblock : null,
        frameCount: doc ? doc.frameCount : null,
        parseError: doc ? null : '解析失败（见 ctx.log 的场景加载 error 记录）',
      }
    },
    { text, fileName },
  )
}

/** 注入并断言加载成功；返回注入结果。 */
export async function injectSceneDocumentOk(
  page: Page,
  json: unknown,
  fileName: string,
): Promise<InjectResult> {
  const result = await injectSceneDocument(page, json, fileName)
  expect(result.docLoaded, `场景注入失败（${fileName}）：${result.parseError}`).toBe(true)
  await waitForDocLoaded(page)
  return result
}

// ---------------------------------------------------------------------------
// 公开观测：文档形态 / 多方块声明
// ---------------------------------------------------------------------------

export interface ChannelObservation {
  key: string
  enumName: string | null
  id: string
  name: string
  kind: string
  min: number
  max: number
  slider: boolean
  domainLo: number
  domainHi: number
  slot: string | null
}

export interface RunstateObservation {
  id: string
  name: string
  materialSwap: boolean
}

export interface BackboneStepObservation {
  channel: string
  layers: number | null
  d: number
  h: number
  w: number
  cellGrid: number[][][]
  roles: Record<string, number>
}

export interface BackboneObservation {
  kind: string
  sizeChannel: string
  stepCount: number
  steps: BackboneStepObservation[]
}

export interface FrameGridObservation {
  index: number
  /** 帧是否带自己的 grid（多方块帧为 false：网格由 T2.2 装配产生）。 */
  present: boolean
  d: number
  h: number
  w: number
  solidCells: number
}

export interface DocObservation {
  hasDoc: boolean
  docId: string | null
  /**
   * 契约**内层 body** 的形态键（`multiblockSource.documentShape`）。
   * 真实产物的形态键在**信封 meta**（契约 §2.1），因此信封形态下这里是 null ——
   * 形态判别的公开观测点用 `isMultiblock`。
   */
  documentShape: string | null
  /** `doc.multiblockSource` 是否非空（T2.2 装配器的输入是否就绪）。 */
  multiblockSourcePresent: boolean
  isMultiblock: boolean
  frameCount: number
  /** 逐帧 `doc.frames[i].grid` 的形状/实心数（帧为主文档的「当前帧数据」公开观测点）。 */
  frameGrids: FrameGridObservation[]
  channelCount: number
  channels: ChannelObservation[]
  runstateCount: number
  runstates: RunstateObservation[]
  variantCount: number
  ruleCount: number
  multiblockFrameCount: number
  totalTierDomain: { min: number; max: number; default: number | null } | null
  backbone: BackboneObservation | null
  blockPaletteSize: number
  warnings: string[]
  /**
   * `decl.backbone.sizeSteps[i].cellGrid` 是否与 `multiblockSource`（契约内层 JSON 原文）
   * 逐格一致 —— 证明解析器把格级数据**原样透传**，而不是自己算了一份。
   */
  backboneMatchesSource: boolean | null
}

/**
 * 一次性读回全部公开的文档/多方块声明观测点。
 *
 * 数据来源（全部公开）：
 *  - `ctx.getDoc().value` → `RuntimeDocument` 的公开 getter：
 *    `isMultiblock` / `multiblockChannels` / `multiblockRunstates` /
 *    `multiblockVariants` / `multiblockRules` / `multiblockFrames` /
 *    `multiblockSource` / `frameCount`
 *  - `ctx.getDoc().value.multiblock`（公开 readonly 字段）→ `decl.backbone` /
 *    `decl.totalTierDomain` / `blockPalette` / `warnings`
 */
export async function readDocObservation(page: Page): Promise<DocObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const doc = ctx.getDoc().value
    if (!doc) {
      return {
        hasDoc: false,
        docId: null,
        documentShape: null,
        multiblockSourcePresent: false,
        isMultiblock: false,
        frameCount: 0,
        frameGrids: [],
        channelCount: 0,
        channels: [],
        runstateCount: 0,
        runstates: [],
        variantCount: 0,
        ruleCount: 0,
        multiblockFrameCount: 0,
        totalTierDomain: null,
        backbone: null,
        blockPaletteSize: 0,
        warnings: [],
        backboneMatchesSource: null,
      }
    }
    const mb = doc.multiblock
    const decl = mb?.decl ?? null
    const backbone = decl?.backbone
      ? {
          kind: decl.backbone.kind,
          sizeChannel: decl.backbone.sizeChannel,
          stepCount: decl.backbone.sizeSteps.length,
          steps: decl.backbone.sizeSteps.map((s: any) => ({
            channel: s.channel,
            layers: s.layers ?? null,
            d: s.cellGrid.length,
            h: s.cellGrid[0]?.length ?? 0,
            w: s.cellGrid[0]?.[0]?.length ?? 0,
            cellGrid: s.cellGrid,
            roles: s.roles ?? {},
          })),
        }
      : null
    return {
      hasDoc: true,
      docId: doc.id ?? null,
      documentShape: (doc.multiblockSource?.documentShape as string) ?? null,
      multiblockSourcePresent: doc.multiblockSource !== null,
      isMultiblock: doc.isMultiblock,
      frameCount: doc.frameCount,
      frameGrids: doc.frames.map((f: any) => {
        const grid = f.grid
        if (!grid) return { index: f.index, present: false, d: 0, h: 0, w: 0, solidCells: 0 }
        return {
          index: f.index,
          present: true,
          d: grid.depth,
          h: grid.height,
          w: grid.width,
          solidCells: grid.count(),
        }
      }),
      channelCount: doc.multiblockChannels.length,
      channels: doc.multiblockChannels.map((c: any) => ({
        key: c.key,
        enumName: c.enumName ?? null,
        id: c.id,
        name: c.name,
        kind: c.kind,
        min: c.min,
        max: c.max,
        slider: c.slider,
        domainLo: c.domain.lo,
        domainHi: c.domain.hi,
        slot: c.slot ?? null,
      })),
      runstateCount: doc.multiblockRunstates.length,
      runstates: doc.multiblockRunstates.map((r: any) => ({
        id: r.id,
        name: r.name,
        materialSwap: !!r.materialSwap,
      })),
      variantCount: doc.multiblockVariants.length,
      ruleCount: doc.multiblockRules.length,
      multiblockFrameCount: doc.multiblockFrames.length,
      totalTierDomain: decl
        ? {
            min: decl.totalTierDomain.min,
            max: decl.totalTierDomain.max,
            default: decl.totalTierDomain.default ?? null,
          }
        : null,
      backbone,
      blockPaletteSize: mb ? mb.blockPalette.length : 0,
      warnings: mb ? [...mb.warnings] : [],
      backboneMatchesSource: (() => {
        const rawSteps = (doc.multiblockSource as any)?.multiblock?.backbone?.sizeSteps
        if (!Array.isArray(rawSteps) || !backbone) return null
        if (rawSteps.length !== backbone.steps.length) return false
        return rawSteps.every(
          (s: any, i: number) =>
            JSON.stringify(s.cellGrid) === JSON.stringify(backbone.steps[i]!.cellGrid),
        )
      })(),
    }
  })
}

// ---------------------------------------------------------------------------
// 公开观测：视口渲染态
// ---------------------------------------------------------------------------

export interface RenderedGridObservation {
  present: boolean
  d: number
  h: number
  w: number
  /** 非空格数（下标 ≠ 0）。 */
  solidCells: number
  /** 逐格下标，`cellGrid[z][y][x]`（原样取自渲染定义）。 */
  cellGrid: number[][][]
  /** 调色板条目指纹：`registryId@meta`。 */
  palette: string[]
}

/**
 * 读回**视口实际渲染的定义**（`ctx.viewports.get('r-viewport').definition`）。
 *
 * 这是 T3.3「web 装配 vs mod 导出逐格 diff」的网格来源：
 * 它比 `doc.frames[i].grid` 更贴近「真正画出来的东西」，
 * 且与 `drwMeshPipeline` 使用的同一份 `StructureDefinition`。
 *
 * 注：**不**从这里读「分层预览模式」——`slot.layerPreview` 是 attach 时刻的快照
 * （`attachViewport` 只在装配时写一次），分层预览的公开观测点用
 * `ctx.getLayerWorldY()` + dock 的 `层` 标签（见 `readDockStatus`）。
 */
export async function readRenderedGrid(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<RenderedGridObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const slot = ctx.viewports.get(rid)
    const def = slot?.definition?.value ?? null
    if (!def) {
      return {
        present: false,
        d: 0,
        h: 0,
        w: 0,
        solidCells: 0,
        cellGrid: [],
        palette: [],
      }
    }
    let solidCells = 0
    for (const slice of def.cellGrid as number[][][]) {
      for (const row of slice) {
        for (const idx of row) if (idx !== 0) solidCells++
      }
    }
    return {
      present: true,
      d: def.cellGrid.length,
      h: def.cellGrid[0]?.length ?? 0,
      w: def.cellGrid[0]?.[0]?.length ?? 0,
      solidCells,
      cellGrid: def.cellGrid,
      palette: (def.blockPalette as any[]).map((p) => `${p.registryId}@${p.meta}`),
    }
  }, regionId)
}

export interface ViewportObservation {
  frameIndex: number
  layerWorldY: number
  docFrameCount: number
}

/** 读回视口状态类公开观测点（帧索引 / 图层 Y）。 */
export async function readViewportState(page: Page): Promise<ViewportObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    return {
      frameIndex: ctx.getCurrentFrameIndex().value,
      layerWorldY: ctx.getLayerWorldY().value,
      docFrameCount: ctx.getDoc().value?.frameCount ?? 0,
    }
  })
}

// ---------------------------------------------------------------------------
// DOM 事件注入辅助
// ---------------------------------------------------------------------------

/**
 * 驱动 range 滑杆：设值后由浏览器派发 `input` + `change`。
 *
 * 这是**元素级 DOM 事件注入**：目标元素就是生产 DOM（`WorldFrameScrubber` /
 * `LayerPreviewBar` 的 `<input type=range>`），事件由 DOM 派发并被 Vue 的
 * `@input`/`@change` 监听器消费，最终经 `ctx.getOperators().exec(...)` 生效——
 * 与真人拖动滑杆的事件路径一致，不跳过监听器、不直接调 operator。
 *
 * 前置条件只要求**已挂载 + 未禁用**（`meshBusy` 会禁用滑杆），不要求可见：
 * 窄视口下（`mobile-chrome` = Pixel 5）Workbench 视口列会被压到约 250 CSS px，
 * 滑杆的 flex 宽度实测被挤到 **0**——元素仍在生产 DOM 里且事件路径完全一样，
 * 因此功能断言照跑，布局问题单列为开放项（见报告）。
 */
export async function setSliderValue(page: Page, selector: string, value: number): Promise<void> {
  const slider = page.locator(selector).first()
  await expect(slider).toBeAttached()
  await expect(slider).toBeEnabled()
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

/**
 * 用真实键盘驱动已聚焦的 range 滑杆（键盘 → 原生值变更 → `input`/`change`）。
 * 与 `setSliderValue` 互为独立通道：证明帧/层切换不依赖某一种事件注入方式。
 */
export async function pressSliderKey(
  page: Page,
  selector: string,
  key: string,
): Promise<void> {
  const slider = page.locator(selector).first()
  await expect(slider).toBeAttached()
  await slider.focus()
  await page.keyboard.press(key)
}

/** 读元素的 CSS 像素盒（布局诊断用，例如窄视口下滑杆被挤成 0 宽）。 */
export async function elementBox(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

/** 点击 dock 上的 tab（`帧控制` / `分层预览`）。 */
export function dockTab(page: Page, label: string): Locator {
  return page.locator(`${DOCK} .vp-dock__tab`, { hasText: label })
}

/**
 * 等网格重建结束：`meshBusy` 会把滑杆置为 `disabled`
 * （`WorldFrameScrubber` / `LayerPreviewBar` 的 `:disabled="meshBusy"`），
 * 所以「滑杆重新可交互」是装配完成的公开信号。
 */
export async function waitForMeshIdle(page: Page, selector: string, timeout = 30_000): Promise<void> {
  await expect(page.locator(selector).first()).toBeEnabled({ timeout })
}

/** 读 dock 状态行文本（`帧 i/N` + `层 <label>`）。 */
export async function readDockStatus(page: Page): Promise<string> {
  return (await page.locator(DOCK_STATUS).first().innerText()).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 第二阶段（通道滑杆遍历）通用原语
// ---------------------------------------------------------------------------

/**
 * 轮询直到 `probe()` 返回真值，返回命中的值（超时抛错并带上 `label`）。
 *
 * 用途：多方块通道装配是**异步**的（`useMultiblockChannels.commit` → `revision++` →
 * `bindMultiblockMeshSync` 的 `watch(..., {flush:'post'})` → `loadStructureAndResources()`
 * → `rebuildContentMesh()`），而面板的 `data-*` 属性是**同步**更新的。
 * 因此断言前必须等"渲染定义真的跟上"，而不是等一个固定时长。
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeout = 20_000,
  interval = 25,
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown = null
  for (;;) {
    const v = await probe()
    if (v) return v as T
    if (Date.now() > deadline) {
      throw new Error(`T2.6：等待超时（${timeout}ms）—— ${label}${last === null ? '' : `（最后一次观测：${JSON.stringify(last)}）`}`)
    }
    last = v === undefined ? null : v
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * 等到"渲染定义与参考基线逐格一致"，返回命中的渲染观测。
 *
 * 收敛判据用**逐格比对结果**（不是形状）：形状一致但内容还停留在上一次装配时，
 * 本函数会继续轮询；真出现实现级错配时则**超时后**由调用方给出完整 diff 证据
 * （因此不会把"异步没跟上"误报成"逻辑错了"）。
 */
export async function waitForRenderMatch<T extends { diffCount: number }>(
  probe: () => Promise<T>,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await probe()
  while (last.diffCount !== 0 && Date.now() <= deadline) {
    await new Promise((r) => setTimeout(r, 25))
    last = await probe()
  }
  if (last.diffCount !== 0) {
    // 再给一次机会：装配走的是 `watch(flush:'post')` 微任务 + 异步 mesh 重建，
    // 页面上其它区域仍在收尾时，首个读回可能刚好落在旧定义上。这里显式让出一轮宏任务
    // 再读一次，避免把"刚好慢半拍"判成实现错配（真错配仍会带着完整 diff 报红）。
    await new Promise((r) => setTimeout(r, 150))
    last = await probe()
  }
  return last
}

// ---------------------------------------------------------------------------
// 第三阶段（真实产物验收）：内容 mesh 的「世代」观测
// ---------------------------------------------------------------------------

export interface ContentMeshObservation {
  /** 视口 slot 里是否已有内容 mesh 组。 */
  present: boolean
  /**
   * 当前 `contentGroup` 的 uuid。
   *
   * 为什么它是"装配真的落定"的判据：`presentContentMesh()` 每次重建都会
   * **新建一个 Group 并整体替换** `slot.contentGroup.value`（`mainMeshGroup.value = result.group`），
   * 且 `loadStructureAndResources()` 每次都会 `clearAllMeshStorage()`（world mesh 缓存必空）。
   * 因此 uuid 变化 ⇔ 新一代 mesh 已经挂进场景 —— 比"definition 已更新"更强
   * （definition 在 `loadStructureAndResources()` 里先写，mesh 在之后的 `rebuildContentMesh()` 才落地）。
   *
   * 观测口径与 README §7.1 已登记的 `slot.contentGroup`（mesh 数 / 三角形数）一致：
   * 它是**公开字段**（`ViewportSlot.contentGroup`），不是测试专用后门。
   */
  uuid: string | null
  /** 组内 mesh 数。 */
  meshes: number
  /** 顶点数合计。 */
  vertices: number
  /** 三角形数合计。 */
  triangles: number
}

/** 读视口内容 mesh 的观测（mesh 数 / 顶点数 / 三角形数 / 世代 uuid）。 */
export async function readContentMesh(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<ContentMeshObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const slot = ctx?.viewports?.get(rid)
    const group = slot?.contentGroup?.value ?? null
    if (!group) return { present: false, uuid: null, meshes: 0, vertices: 0, triangles: 0 }
    let meshes = 0
    let vertices = 0
    let triangles = 0
    group.traverse((o: any) => {
      if (!o?.isMesh || !o.geometry) return
      meshes++
      const pos = o.geometry.getAttribute?.('position')
      if (pos) vertices += pos.count
      const idx = o.geometry.getIndex?.()
      if (idx) triangles += idx.count / 3
      else if (pos) triangles += pos.count / 3
    })
    return {
      present: true,
      uuid: typeof group.uuid === 'string' ? group.uuid : null,
      meshes,
      vertices: Math.round(vertices),
      triangles: Math.round(triangles),
    }
  }, regionId)
}

/**
 * 等到「新一代内容 mesh 已挂进场景」：
 * `contentGroup.uuid` 从 `previousUuid` 变成别的值（`previousUuid === null` 时只要求非空）。
 *
 * 超时抛错（带上最后一次观测），因为"mesh 世代没变"意味着装配根本没落地 ——
 * 那是必须报红的实现问题，不是可以放过的噪声。
 */
export async function waitForMeshGeneration(
  page: Page,
  previousUuid: string | null,
  timeout = 30_000,
  regionId: string = VIEWPORT_REGION,
): Promise<ContentMeshObservation> {
  const deadline = Date.now() + timeout
  let last: ContentMeshObservation = { present: false, uuid: null, meshes: 0, vertices: 0, triangles: 0 }
  for (;;) {
    last = await readContentMesh(page, regionId)
    const changed = last.present && last.uuid !== null && (previousUuid === null || last.uuid !== previousUuid)
    if (changed) return last
    if (Date.now() > deadline) {
      throw new Error(
        `T3.1：等待内容 mesh 世代更新超时（${timeout}ms）—— previousUuid=${previousUuid ?? '<首次>'}，` +
          `最后一次观测 ${JSON.stringify(last)}。装配/mesh 重建未落地，属必须报红的实现问题。`,
      )
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

export interface RenderedDefinitionObservation {
  present: boolean
  /** `[d, h, w]`。 */
  shape: [number, number, number]
  /** `cellGrid[z][row][x]` 下标（**原样**取自渲染定义，不做任何翻转）。 */
  cellGrid: number[][][]
  /** 渲染调色板条目（原样；用于重建签名）。 */
  palette: unknown[]
  solidCells: number
}

/**
 * 读渲染定义的**原样**内容（`cellGrid` + `blockPalette`），供签名级逐格比对。
 *
 * 与 `readRenderedGrid()` 的差别：后者已把调色板压成 `registryId@meta` 字符串
 * （够用于"有没有东西"的诊断，但**不足以**做签名对齐——渲染调色板是重编号的，
 * 且 `name:meta` 会归并内容不同的条目）。本函数把原始条目交回，由 helper 侧统一建表。
 */
export async function readRenderedDefinition(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<RenderedDefinitionObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const def = ctx.viewports.get(rid)?.definition?.value ?? null
    if (!def) {
      return { present: false, shape: [0, 0, 0], cellGrid: [], palette: [], solidCells: 0 }
    }
    const cellGrid = def.cellGrid as number[][][]
    let solid = 0
    for (const slice of cellGrid) {
      for (const row of slice) {
        for (const idx of row) if (idx !== 0) solid++
      }
    }
    return {
      present: true,
      shape: [cellGrid.length, cellGrid[0]?.length ?? 0, cellGrid[0]?.[0]?.length ?? 0],
      cellGrid,
      palette: def.blockPalette ?? [],
      solidCells: solid,
    }
  }, regionId)
}
