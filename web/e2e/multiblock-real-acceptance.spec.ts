/**
 * T3.1 / T3.3 —— **真实导出产物**（T1.6 `/sde multiblock` 的 5 台产物 / 1262 变体）的无头验收。
 *
 * 计划依据：`docs/plan/multiblock-channel-renderer-plan.md` §5 Phase 3（T3.1 通过标准、T3.3 逐格比对）、
 * §10 判据修正（**像素断言只在真实导出产物上生效**）；产物格式见 `docs/plan/probe-export-pipeline.md` §5。
 *
 * ## 与第二阶段（合成 fixture）spec 的区别（判据框架的变化）
 *
 * 合成 fixture 的几何在视口里**视觉不可见**（0..16 像素单位 + 共面双四边形，见 README §7.1），
 * 因此第二阶段把 **cellGrid 级断言当门禁、像素只作诊断**。真实产物是 0..1 逐面绕组的真实烘焙几何，
 * 几何**确实可见**，所以本 spec 把**像素断言重新升为门禁**（计划 §10 的明文要求）：
 * 截图非空 + 相邻取值/等级对照组的画面必须真的变。
 *
 * ## 七条交付（逐条对应本文件的用例）
 *
 * 1. **加载与声明一致性**：`slug：加载与声明一致性` —— 逐台注入真实产物，面板条数/标签/取值域/
 *    运行态/软约束提示 + 解析结果的通道清单/变体数/规则数/骨架逐格，全部与产物 JSON 的**声明节**比对。
 *    反同义反复：期望值来自文件声明**本身**，断言目标是"UI/解析器忠实呈现文件声明"（不是"文件正确"）；
 *    文件正确性由 T1.5/T1.6 的导出期自检承担。`产物目录完整性` 用例给出这条边界的机器说明。
 * 2. **全组合遍历（T3.1）**：`slug：全部合法组合遍历` —— desktop 全量（5 台 1262 组合）、
 *    mobile 每台抽样；DOM 驱动滑杆 → 等 mesh 世代更新（`pollComboSettled`）→
 *    `data-mb-variant` 与期望变体键一致、`data-mb-dims` 与**声明派生的骨架阶尺寸**一致。
 * 3. **像素门禁（真实产物上生效）**：`像素门禁：真实几何可见 + 相邻对照差异` ——
 *    每个 Tier 档位首条 + 抽样组合截图存档、截图非空、相邻取值/运行态对照对必须产生可观测差异。
 * 4. **T3.3 逐格比对**：`T3.3：逐格 diff = 0` —— 35 个抽样组合的 web 渲染网格与 mod 展开校验文件
 *    逐格 diff **必须为 0**（`idMeta` 门禁 + `full` 旁证；映射不上 = 硬失败）。
 * 5. **证伪**：`证伪：篡改真实产物一条规则的 indexTable` —— 目标组合必须变红、对照组必须仍绿。
 * 6. **环境变量接管**：`MB_REAL_EXPORTS_DIR`（默认 `mod/gtnh/run/client/sde_multiblock_exports`）；
 *    目录缺产物 / 缺展开清单 / 缺展开文件 → **显式失败**（`realExports.ts` 的 `resolveRealExportsDir` 等）。
 * 7. **`cd web && npx playwright test --retries=0` 全绿**（既有 67 项不红 + 本 spec 两个 project 全绿）。
 *
 * ## 像素判据的口径（含实测标定，**必须读**）
 *
 * 真实产物的同态像素**不是绝对确定**的：实测 4 台机器（EBF / AdvEBF / DT / BBF）连续 9 张截图
 * 逐张 0 差异，而 **QFT**（15×21×15，21660 顶点 / 7220 三角形）存在**持续的小幅振荡**
 * （相机位置/四元数/zoom 逐帧完全相同 ⇒ 不是相机动画；噪声集中在结构所在屏幕区域：
 * 64 分格下 max ≈ 11.1、16 分格下 max ≤ 8.06 且变化格 ≤ 1）。因此门禁必须**按实测噪声地板标定**：
 *
 * | 判据 | 门限 | 实测依据 |
 * |------|------|----------|
 * | 「结构级变化」 | `changedCells ≥ 3` **且** `maxAbs > max(8, 本次会话噪声地板)` | 结构信号：EBF `coil 1→14` 15~33 格 / `tier 1→2` 16~33 格；QFT 运行态 7~9 格、manipulator 13~19 格 |
 * | 「单格强变化」 | `maxAbs ≥ max(12, 本次会话噪声地板)` | BBF 单方块材质切换在窄视口只覆盖 1 个签名格、但幅度 27.8~65.4；同态振荡 ≤ 8.06 |
 * | 噪声地板可信 | 本次会话所有重复截图 `maxAbs < 12` | 实测最差 8.06（QFT） |
 *
 * 逐对结论**全部打印**（含"内容变了但画面不可观测"的对），绝不静默丢弃；
 * 硬门禁只有两条：① 每台机器至少一对满足上述判据；
 * ② 有取值/Tier 轴的机器，至少一对**取值/Tier 对**满足判据（BBF 无通道且 Tier 域退化为单点，故退化为运行态对）。
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import {
  SIGNATURE_CELL_DELTA,
  TIER_SLIDER,
  VIEWPORT_CANVAS,
  captureEvidence,
  describeRealGridDiff,
  diffRenderedVsExpanded,
  dimsText,
  drivePanel,
  enumerateRealCombos,
  expectedDimsFor,
  expectedInitialSelection,
  gotoWorkbench,
  injectSceneDocumentOk,
  loadExpandedGrid,
  loadExpandedManifest,
  loadRealProducts,
  openChannelTabReady,
  paletteSignatures,
  panelModelValues,
  pixelPairSpecs,
  pollComboSettled,
  readChannelPanel,
  readContentMesh,
  readDocObservation,
  readRenderedDefinition,
  realDeclarationViolations,
  realPanelViolations,
  rewrapProduct,
  resolveRealExportsDir,
  resolveRealExportsDirInfo,
  sampleRealCombos,
  signatureDiff,
  signatureGrid,
  unknownRenderedEntries,
  waitForMeshIdle,
  MB_REAL_EXPORTS_DIR_ENV,
  type ComboSnapshot,
  type ExpandedGrid,
  type ExpandedSample,
  type RealCombo,
  type RealPixelPair,
  type RealProduct,
  type SignatureDiff,
} from './helpers/multiblock'

/** 证据截图目录。 */
const SHOT_DIR = 'e2e/screenshots/multiblock-real'

/** 单组合「装配 → mesh 重建」落定超时（真实产物实测 30~60 ms；给 30 s 余量）。 */
const SETTLE_TIMEOUT_MS = 30_000

/** T1.6 默认验收子集：5 台 / 1262 变体（`probe-export-pipeline.md` §0）。 */
const EXPECTED_MACHINES = 5
const EXPECTED_VARIANTS = 1262

// ---------------------------------------------------------------------------
// 像素门禁的阈值常量（标定依据见文件头表格）
// ---------------------------------------------------------------------------

/** 「结构级变化」所需的最少变化签名格数（16×16 = 256 格 → 3 格 ≈ 1.2%）。 */
const MIN_STRUCTURAL_CELLS = 3
/** 单格强变化门限（真实产物实测：稳态同态振荡 ≤ 7.14；被判为显著的信号 ≥ 10.44）。 */
const MIN_SINGLE_CELL_MAXABS = 12
/**
 * 同态振荡上限：**粗粒度可信性守卫**（不是逐对门限）。
 * 取 16 = 2 × `SIGNATURE_CELL_DELTA`；实测最差 **10.07**（QFT，含热帧的一次采样）。
 * 超过它说明"同一组合重复截图"的抖动已与单格信号门限同量级，像素判据不再可信 → 必须报红。
 * 逐对的严格标定由 `pixelVerdict` 用**本次会话实测**的振荡地板完成。
 */
const MAX_TRUSTED_OSCILLATION = 16

type PixelVerdict = 'structural' | 'single-cell' | 'none'

/**
 * 一对对照组的像素判定（**按本次会话实测的噪声地板标定**）。
 *
 * - `structural`：≥3 个签名格超过 `SIGNATURE_CELL_DELTA`（8）且峰值 > 噪声地板 ⇒ 结构/材质整体变了；
 * - `single-cell`：峰值 ≥ 12 且 ≥ 噪声地板 ⇒ 单方块级别的强变化（BBF 的材质切换、运行态面切换）；
 * - `none`：不满足以上任一（**如实记录**，不静默降级）。
 */
function pixelVerdict(signal: SignatureDiff, oscillation: SignatureDiff): PixelVerdict {
  const floor = Math.max(SIGNATURE_CELL_DELTA, oscillation.maxAbs)
  if (signal.changedCells >= MIN_STRUCTURAL_CELLS && signal.maxAbs > floor) return 'structural'
  if (signal.maxAbs >= Math.max(MIN_SINGLE_CELL_MAXABS, oscillation.maxAbs)) return 'single-cell'
  return 'none'
}

// ---------------------------------------------------------------------------
// 产物装载（模块加载期；缺产物 → 显式失败，见 `requireLoad()`）
// ---------------------------------------------------------------------------

interface RealLoad {
  dir: string | null
  products: RealProduct[]
  manifest: ReturnType<typeof loadExpandedManifest> | null
  error: Error | null
}

const LOAD: RealLoad = (() => {
  try {
    const dir = resolveRealExportsDir()
    return { dir, products: loadRealProducts(dir), manifest: loadExpandedManifest(dir), error: null }
  } catch (e) {
    return { dir: null, products: [], manifest: null, error: e as Error }
  }
})()

/** 取装载结果；产物缺失时抛出**带环境变量与候选路径**的显式错误。 */
function requireLoad(): { dir: string; products: RealProduct[]; manifest: ReturnType<typeof loadExpandedManifest> } {
  if (LOAD.error) throw LOAD.error
  return { dir: LOAD.dir!, products: LOAD.products, manifest: LOAD.manifest! }
}

/** 一台机器在展开清单里的条目（缺条目 = 硬失败：T3.3 无从比对）。 */
function manifestMachine(slug: string): ReturnType<typeof loadExpandedManifest>['machines'][number] {
  const { manifest } = requireLoad()
  const m = manifest.machines.find((x) => x.slug === slug)
  if (!m) {
    throw new Error(
      `T3.3：展开清单里没有 ${slug} 的条目（清单只含 ${manifest.machines.map((x) => x.slug).join(', ')}）。\n` +
        `  展开校验文件是 mod 侧独立导出的 ground-truth，缺失即无法验收 —— 显式失败，不静默跳过。`,
    )
  }
  return m
}

/** 是否 desktop 项目（决定遍历全量还是抽样；`mobile-chrome` 走 `sampleRealCombos`）。 */
function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'desktop-chrome'
}

/** 组合的可读标签。 */
function comboLabel(p: RealProduct, combo: RealCombo): string {
  return `${p.slug} :: ${combo.variantKey}`
}

function shotName(p: RealProduct, combo: RealCombo, testInfo: TestInfo, prefix = 'traverse'): string {
  return `${prefix}-${p.slug}-${combo.variantKey.replace(/[|:]/g, '_')}-${testInfo.project.name}`
}

// ---------------------------------------------------------------------------
// 驱动 + 落定
// ---------------------------------------------------------------------------

interface DriveOutcome {
  snap: ComboSnapshot
  /** 实际派发过的控件（空 = 面板已在该组合上，不触发 mesh 重建）。 */
  payloadKeys: string[]
}

/**
 * 驱动器的**跟踪状态**：`combo` = 上一次落定后面板所处的组合，`meshUuid` = 其 mesh 世代。
 *
 * 为什么要跟踪"面板当前组合"而不是每次都读面板：真实产物全量遍历 1262 组合，
 * 每次多一次 CDP 往返 ≈ +100 ms/组合。跟踪是安全的 ——
 * 每次落定都断言 `data-mb-variant` = 期望键，所以"面板在当前组合"这件事每轮都被验证过；
 * 若某轮没落定，断言立刻报红，不会静默地把后面的驱动建立在错误状态上。
 */
interface DriveState {
  meshUuid: string | null
  combo: RealCombo | null
}

/**
 * 驱动到某组合并等**装配 + mesh 重建**落定。
 *
 * 落定判据（`pollComboSettled`）三条同时满足：`data-mb-variant` / `data-mb-dims` + 渲染定义形状 /
 * **`contentGroup` 世代 uuid 变化**（`definition` 在 `loadStructureAndResources()` 里先写，
 * mesh 在其后的 `rebuildContentMesh()` 才落地 —— 只看定义会提前放行，截图会拍到上一代网格）。
 *
 * 关于 `waitForMeshIdle`：既有原语的语义是"帧/层滑杆重新可交互"（那两个滑杆绑定 `meshBusy`），
 * **通道面板的滑杆不受 `meshBusy` 门控**（`MultiblockChannelPanel.vue` 没有 disabled 分支），
 * 所以它在 `openProduct()` 里作为"面板已可交互"的挂载守卫调用一次；
 * 逐组合的"mesh 已重建"由上面的**世代 uuid** 判定 —— 这是同一语义的更强形式。
 */
async function driveCombo(
  page: Page,
  p: RealProduct,
  combo: RealCombo,
  state: DriveState,
): Promise<DriveOutcome> {
  const prev = state.combo
  const payload: { tier?: number; runstate?: string; values?: Record<string, number> } = {}
  if (!prev || prev.totalTier !== combo.totalTier) payload.tier = combo.totalTier
  if (!prev || prev.runstate !== combo.runstate) payload.runstate = combo.runstate
  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries(combo.values)) {
    if (!prev || (prev.values[k] ?? 0) !== v) values[k] = v
  }
  if (Object.keys(values).length > 0) payload.values = values
  const expectMeshChange = Object.keys(payload).length > 0
  if (expectMeshChange) await drivePanel(page, payload)
  const snap = await pollComboSettled(page, {
    expectedVariant: combo.variantKey,
    expectedDims: dimsText(expectedDimsFor(p, combo.variantKey)),
    previousMeshUuid: state.meshUuid,
    expectMeshChange,
    timeoutMs: SETTLE_TIMEOUT_MS,
  })
  state.meshUuid = snap.meshUuid
  state.combo = combo
  return { snap, payloadKeys: Object.keys(payload) }
}

/**
 * 注入一台真实产物、切到通道 tab、并把驱动器状态对齐到**面板初始选中**
 * （Tier = 声明 default 吸附抽样 / 通道全 0 / 运行态首项 —— 由声明一致性用例独立验证）。
 *
 * `envelope` / `fileName` 可覆盖：证伪用例用它注入**内存篡改副本**（仓库产物一字不改，
 * 注入路径与原件完全相同）。
 */
async function openProduct(
  page: Page,
  p: RealProduct,
  envelope = p.envelope,
  fileName = p.file,
): Promise<DriveState> {
  await gotoWorkbench(page)
  const injected = await injectSceneDocumentOk(page, envelope, fileName)
  expect(injected.docLoaded, `${p.file}：真实产物必须能被 Multiblock 解析器加载`).toBe(true)
  expect(injected.isMultiblock, `${p.file}：必须判为「多方块为主」形态`).toBe(true)
  await openChannelTabReady(page)
  await waitForMeshIdle(page, TIER_SLIDER)
  // 等"挂载期装配"的 mesh 世代稳定（否则首次驱动的世代变化可能来自挂载重建，而非本次驱动）
  let uuid = (await readContentMesh(page)).uuid
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50)
    const cur = (await readContentMesh(page)).uuid
    if (cur !== null && cur === uuid) break
    uuid = cur
  }
  const initial = expectedInitialSelection(p)
  return {
    meshUuid: uuid,
    combo: {
      productFile: p.file,
      slug: p.slug,
      variantKey: initial.variantKey,
      values: initial.values,
      totalTier: initial.tier,
      runstate: initial.runstate,
    },
  }
}

/** 断言一个组合落定且面板观测与声明一致。 */
function expectSettled(p: RealProduct, combo: RealCombo, snap: ComboSnapshot): void {
  const label = comboLabel(p, combo)
  const wantDims = dimsText(expectedDimsFor(p, combo.variantKey))
  expect(
    snap.panelVariant,
    `${label}：面板 data-mb-variant 必须 = 声明派生的期望变体键`,
  ).toBe(combo.variantKey)
  expect(snap.panelDims, `${label}：面板 data-mb-dims 必须 = 骨架阶尺寸（文件声明）`).toBe(wantDims)
  expect(
    snap.settled,
    `${label}：装配未落定（mesh 世代未更新 / 定义形状不符）。最后一次观测 ${JSON.stringify(snap)}`,
  ).toBe(true)
}

// ---------------------------------------------------------------------------
// 用例 0：产物目录与清单完整性（环境变量接管 + 缺产物显式失败）
// ---------------------------------------------------------------------------

test.describe('T3.1 · 真实导出产物验收（T1.6 产物 + T3.3 逐格比对）', () => {
  test('产物目录与清单完整性：MB_REAL_EXPORTS_DIR 接管 + 缺产物显式失败', () => {
    // ── ① 缺产物必须显式失败（验收管线语义），而不是静默跳过 ──
    const saved = process.env[MB_REAL_EXPORTS_DIR_ENV]
    try {
      process.env[MB_REAL_EXPORTS_DIR_ENV] = 'e2e/__no_such_exports_dir__'
      const info = resolveRealExportsDirInfo()
      expect(info.source, '环境变量必须被接管').toBe('env')
      expect(() => resolveRealExportsDir(), '环境变量指向的目录没有产物 → 必须抛错').toThrow(
        /MB_REAL_EXPORTS_DIR/,
      )
      // 空目录（存在但没有产物）同样必须失败
      process.env[MB_REAL_EXPORTS_DIR_ENV] = 'e2e/fixtures'
      expect(() => resolveRealExportsDir(), '目录存在但没有 *multiblock.json → 必须抛错').toThrow(
        /找不到任何/,
      )
    } finally {
      if (saved === undefined) delete process.env[MB_REAL_EXPORTS_DIR_ENV]
      else process.env[MB_REAL_EXPORTS_DIR_ENV] = saved
    }

    // ── ② 真实产物必须齐备（缺失时 requireLoad 抛出带候选路径的错误）──
    const { dir, products, manifest } = requireLoad()
    console.log(`[T3.1] 产物目录 ${dir}（来源 ${resolveRealExportsDirInfo().source}）`)
    expect(products.length, `默认验收子集应有 ${EXPECTED_MACHINES} 台产物`).toBe(EXPECTED_MACHINES)

    // ── ③ 产物 ↔ 展开清单：两向覆盖，缺一即硬失败 ──
    const slugs = products.map((p) => p.slug).sort()
    const manifestSlugs = manifest.machines.map((m) => m.slug).sort()
    expect(manifestSlugs, '展开清单必须与产物目录一一对应（不多不少）').toEqual(slugs)
    expect(manifest.totalSamples, '展开抽样条数（T1.6 默认子集 = 35）').toBe(35)
    for (const m of manifest.machines) {
      const p = products.find((x) => x.slug === m.slug)!
      expect(m.productFile, `${m.slug}：清单的 productFile 必须指向该产物`).toBe(p.file)
      expect(m.variantTotal, `${m.slug}：清单的变体总数必须 = 产物声明数`).toBe(p.variantKeys.length)
      for (const s of m.samples) {
        expect(
          p.declaredKeys.has(s.variant),
          `${m.slug}：抽样组合 ${s.variant} 必须在产物声明里（否则无从装配）`,
        ).toBe(true)
      }
    }

    // ── ④ 契约 §2.3 形态互斥 + 覆盖规模（1262 变体）──
    let total = 0
    for (const p of products) {
      expect(p.documentShape, `${p.file}：收信 meta.documentShape`).toBe('multiblock')
      expect(p.inner.multiblockCount, `${p.file}：multiblockCount`).toBe(1)
      expect('cellGrid' in p.inner, `${p.file}：多方块文档不得有根级 cellGrid（契约 §2.3）`).toBe(false)
      expect(
        p.variantKeys.length,
        `${p.file}：每个变体至少一帧（Frame 是唯一变体存储原语，契约 §5.3）`,
      ).toBeLessThanOrEqual(p.inner.frames ? (p.inner.frames as unknown[]).length : 0)
      // 组合枚举与声明键集合的交叉自检（不一致时 enumerateRealCombos 抛错）
      const combos = enumerateRealCombos(p)
      expect(combos.length, `${p.file}：枚举组合数 = 声明变体数`).toBe(p.variantKeys.length)
      total += combos.length
      console.log(
        `[T3.1] ${p.slug}: 变体 ${p.variantKeys.length} / 通道 ${p.channels.length} / 规则 ${p.ruleCount} / ` +
          `骨架阶 ${p.steps.length}（${p.steps.map((s) => `${s.w}×${s.h}×${s.d}`).join(' → ')}）/ 调色板 ${p.paletteSize} / ` +
          `运行态 ${p.runstates.map((r) => `${r.id}=${r.name}`).join(',')}`,
      )
    }
    expect(total, '默认验收子集的组合总数（T1.6 实测 1262）').toBe(EXPECTED_VARIANTS)
  })

  // -------------------------------------------------------------------------
  // 用例 1：加载与声明一致性（逐台）
  // -------------------------------------------------------------------------

  for (const p of LOAD.products) {
    test(`${p.slug}：加载与声明一致性（面板 + 解析 ↔ 产物声明节）`, async ({ page }, testInfo) => {
      test.setTimeout(180_000)
      await openProduct(page, p)

      const doc = await readDocObservation(page)
      const panel = await readChannelPanel(page)

      expect(realDeclarationViolations(doc, p), `${p.file}：解析结果与文件声明不一致`).toEqual([])
      expect(realPanelViolations(panel, p), `${p.file}：通道面板与文件声明不一致`).toEqual([])

      // 初始选中：Tier = 声明 default（吸附抽样）/ 通道全 Not set / 运行态首项
      const initial = expectedInitialSelection(p)
      expect(panel.tier, `${p.file}：初始 Tier = 声明 default 吸附抽样`).toBe(initial.tier)
      expect(panelModelValues(panel).values, `${p.file}：初始通道值必须全部为 0（Not set）`).toEqual(
        initial.values,
      )
      expect(panel.runstate, `${p.file}：初始运行态 = 声明首项`).toBe(initial.runstate)
      expect(panel.variantKey, `${p.file}：初始变体键（声明派生）`).toBe(initial.variantKey)
      for (const c of panel.channels) {
        if (c.value === 0) expect(c.valueText, `${p.file}：0 必须显示为 Not set`).toBe('Not set')
      }
      console.log(
        `[T3.1][${testInfo.project.name}] ${p.slug} 声明一致性通过：滑杆 ${panel.channels.length}(${panel.channels
          .map((c) => `${c.name} 0..${c.sliderMax}`)
          .join(', ') || '无'}) / Tier ${panel.tierMin}..${panel.tierMax} 抽样 ${JSON.stringify(panel.tierSamples)} / ` +
          `运行态 ${panel.runstateOptions.map((o) => `${o.id}=${o.name}`).join(',')} / 提示 ${panel.notices.length} 条`,
      )
    })
  }

  // -------------------------------------------------------------------------
  // 用例 2：全组合遍历（desktop 全量 / mobile 每台抽样）
  // -------------------------------------------------------------------------

  for (const p of LOAD.products) {
    test(`${p.slug}：全部合法组合遍历（变体键 + 骨架尺寸 + mesh 落定）`, async ({ page }, testInfo) => {
      const desktop = isDesktop(testInfo)
      test.setTimeout(desktop ? 1_800_000 : 900_000)

      const all = enumerateRealCombos(p)
      const sample = sampleRealCombos(p)
      const combos = desktop ? all : sample
      const sampleKeys = new Set(sample.map((c) => c.variantKey))

      let state = await openProduct(page, p)
      const t0 = Date.now()
      const settleMs: number[] = []
      let probes = 0
      let shots = 0
      const shotTiers = new Set<number>()

      for (const combo of combos) {
        const { snap } = await driveCombo(page, p, combo, state)
        settleMs.push(snap.elapsedMs)
        probes += snap.probes
        expectSettled(p, combo, snap)

        // 截图策略（控制总量）：**每个 Tier 档位的第一条** + 抽样组合
        const firstOfTier = !shotTiers.has(combo.totalTier)
        if (firstOfTier) shotTiers.add(combo.totalTier)
        if (firstOfTier || sampleKeys.has(combo.variantKey)) {
          await captureEvidence(
            page,
            page.locator(VIEWPORT_CANVAS),
            `${comboLabel(p, combo)} 视口`,
            `${SHOT_DIR}/${shotName(p, combo, testInfo)}.png`,
          )
          shots++
        }
      }

      const elapsed = Date.now() - t0
      const sum = settleMs.reduce((a, b) => a + b, 0)
      console.log(
        `[T3.1][${testInfo.project.name}] ${p.slug} 遍历完成：组合 ${combos.length}/${all.length}` +
          `${desktop ? '（全量）' : '（抽样）'} / 截图 ${shots} 张 / 总耗时 ${elapsed} ms` +
          `（${(elapsed / Math.max(combos.length, 1)).toFixed(1)} ms/组合；驱动→落定 mean ${(sum / Math.max(settleMs.length, 1)).toFixed(1)} ms / ` +
          `max ${Math.max(0, ...settleMs)} ms；收敛探测 ${probes} 次 = ${(probes / Math.max(combos.length, 1)).toFixed(2)}/组合）`,
      )
      expect(combos.length, `${p.slug}：覆盖组合数`).toBe(desktop ? all.length : sample.length)
      expect(shotTiers.size, `${p.slug}：Tier 档位截图覆盖`).toBe(
        new Set(combos.map((c) => c.totalTier)).size,
      )
    })
  }

  // -------------------------------------------------------------------------
  // 用例 3：像素门禁（真实几何可见 + 相邻对照差异）
  // -------------------------------------------------------------------------

  test('像素门禁：真实几何可见 + 相邻取值/运行态对照差异（5 台 × 抽样对）', async ({ page }, testInfo) => {
    test.setTimeout(900_000)
    const { products } = requireLoad()
    const table: string[] = []
    let totalStrong = 0

    for (const p of products) {
      const state = await openProduct(page, p)
      const pairs = pixelPairSpecs(p)
      /** 本次会话该机器的同态振荡地板（重复截图 maxAbs 的最大值）。 */
      let oscillationMax = 0
      let oscillationCells = 0
      const verdicts: Array<{ pair: RealPixelPair; kind: PixelVerdict; signal: SignatureDiff }> = []

      for (const pair of pairs) {
        // ① 组合 A：先丢一张**热帧**（mesh 刚落地那一帧；实测 QFT 上它与稳态差 up to ~10），
        //    再连拍两张稳态图 —— 前者作对照基线，两张之差作**本次会话的振荡地板**。
        await driveCombo(page, p, pair.a, state)
        await captureEvidence(page, page.locator(VIEWPORT_CANVAS), `${pair.label} A 热帧（丢弃）`, null)
        await page.waitForTimeout(120)
        const a1 = await captureEvidence(
          page,
          page.locator(VIEWPORT_CANVAS),
          `${pair.label} A1`,
          `${SHOT_DIR}/pixel-${p.slug}-${pair.label}-A1-${testInfo.project.name}.png`,
        )
        await page.waitForTimeout(120)
        const a2 = await captureEvidence(page, page.locator(VIEWPORT_CANVAS), `${pair.label} A2`, null)
        const oscillation = signatureDiff(a1.signature, a2.signature)
        oscillationMax = Math.max(oscillationMax, oscillation.maxAbs)
        oscillationCells = Math.max(oscillationCells, oscillation.changedCells)

        // ② 组合 B：落定 → 丢热帧 → 稳态截图 → 差异信号（A1 稳态 vs B1 稳态）
        const defA = await readRenderedDefinition(page)
        await driveCombo(page, p, pair.b, state)
        const defB = await readRenderedDefinition(page)
        await captureEvidence(page, page.locator(VIEWPORT_CANVAS), `${pair.label} B 热帧（丢弃）`, null)
        await page.waitForTimeout(120)
        const b = await captureEvidence(
          page,
          page.locator(VIEWPORT_CANVAS),
          `${pair.label} B1`,
          `${SHOT_DIR}/pixel-${p.slug}-${pair.label}-B1-${testInfo.project.name}.png`,
        )
        const signal = signatureDiff(a1.signature, b.signature)

        // 前置证据：两个组合的**渲染内容**确实不同。用 `full`（条目全文）口径：
        // 真实产物的渲染调色板是按**并集下标**（`SlotBlock.paletteIndex`）缓存的，条目全文被原样带出，
        // 因此 `full` 对"运行态换面（同 name:meta、仅 nbt/tooltip 不同）"也能分辨
        // （合成 fixture 里"按 name:meta 归并"的盲区在真实产物上不适用，见 README §8.8）。
        // 形状不同（尺寸型通道换了骨架阶）记 -1。
        const contentDiff = (() => {
          const ga = signatureGrid(defA.cellGrid, defA.palette, 'full')
          const gb = signatureGrid(defB.cellGrid, defB.palette, 'full')
          if (ga.d !== gb.d || ga.h !== gb.h || ga.w !== gb.w) return -1
          let n = 0
          for (let z = 0; z < ga.d; z++) {
            for (let y = 0; y < ga.h; y++) {
              for (let x = 0; x < ga.w; x++) {
                if (ga.rows[z]?.[y]?.[x] !== gb.rows[z]?.[y]?.[x]) n++
              }
            }
          }
          return n
        })()

        const kind = pixelVerdict(signal, oscillation)
        verdicts.push({ pair, kind, signal })
        table.push(
          `  ${p.slug} ${pair.label} [${pair.intent}]\n` +
            `    A=${pair.a.variantKey} B=${pair.b.variantKey}；渲染调色板条目差异 ${contentDiff}\n` +
            `    振荡地板(A1↔A2 稳态重复)：maxAbs=${oscillation.maxAbs.toFixed(2)} 变化格=${oscillation.changedCells}（该机累计 ${oscillationMax.toFixed(2)}/${oscillationCells}）\n` +
            `    信号(A1→B)：meanAbs=${signal.meanAbs.toFixed(3)} maxAbs=${signal.maxAbs.toFixed(2)} 变化格=${signal.changedCells} → 判定 ${kind}` +
            `\n    A 像素 unique=${a1.stats.uniqueColors} σ=${a1.stats.stdDevLuma.toFixed(2)} nonBlack=${a1.stats.nonBlackRatio.toFixed(4)}` +
            ` / B 像素 unique=${b.stats.uniqueColors} σ=${b.stats.stdDevLuma.toFixed(2)} nonBlack=${b.stats.nonBlackRatio.toFixed(4)}`,
        )
      }

      // ③ 判定
      expect(
        oscillationMax,
        `${p.slug}：本次会话的同态振荡 maxAbs=${oscillationMax.toFixed(2)} 超过可信上限 ${MAX_TRUSTED_OSCILLATION} —— 像素判据不可信，必须报红`,
      ).toBeLessThan(MAX_TRUSTED_OSCILLATION)

      const strong = verdicts.filter((v) => v.kind !== 'none')
      const strongStructural = strong.filter((v) => v.pair.kind !== 'runstate')
      const hasValueAxis = p.channels.some((c) => c.slider) || p.tierSample.length > 1
      expect(
        strong.length,
        `${p.slug}：至少一对抽样对照必须产生可观测的像素差异（真实几何必须可见）。逐对实测：\n${table.join('\n')}`,
      ).toBeGreaterThanOrEqual(1)
      if (hasValueAxis) {
        expect(
          strongStructural.length,
          `${p.slug}：有取值/Tier 轴的机器，至少一对**取值/Tier 对**必须像素显著（相邻取值截图必须有差异）。\n${table.join('\n')}`,
        ).toBeGreaterThanOrEqual(1)
      }
      totalStrong += strong.length
    }
    console.log(
      `[T3.1][${testInfo.project.name}] 像素门禁逐对实测（strong=${totalStrong}）：\n${table.join('\n')}`,
    )
  })

  // -------------------------------------------------------------------------
  // 用例 4：T3.3 逐格比对（35 抽样组合；差异必须为 0）
  // -------------------------------------------------------------------------

  test('T3.3：web 渲染网格 vs mod 展开校验文件逐格 diff = 0（35 抽样组合）', async ({ page }, testInfo) => {
    test.setTimeout(1_200_000)
    const { dir, products, manifest } = requireLoad()
    let totalCells = 0
    let totalCombos = 0
    let totalFullMismatch = 0
    const perMachine: string[] = []

    for (const p of products) {
      const m = manifestMachine(p.slug)
      const state = await openProduct(page, p)
      let cells = 0
      let diffs = 0
      let fullDiffs = 0
      let unmappedTotal = 0
      let labelConflicts = 0

      for (const s of m.samples) {
        const combo: RealCombo = {
          productFile: p.file,
          slug: p.slug,
          variantKey: s.variant,
          values: s.values,
          totalTier: s.totalTier,
          runstate: s.runstate,
        }
        // 声明派生期望：清单尺寸 = 骨架阶尺寸
        const wantDims = expectedDimsFor(p, combo.variantKey)
        expect(
          s.dims,
          `${comboLabel(p, combo)}：清单 dims 必须 = frames[].stepIndex 派生的骨架阶尺寸（两条独立来源互证）`,
        ).toEqual(wantDims)

        const { snap } = await driveCombo(page, p, combo, state)
        expectSettled(p, combo, snap)

        const rendered = await readRenderedDefinition(page)
        const expanded = loadExpandedGrid(dir, s)

        // 对齐口径硬前置：签名表必须覆盖网格用到的每一个全局下标；标签与签名推出的身份必须一致
        expect(
          expanded.unmappedIndices,
          `${comboLabel(p, combo)}：展开网格用到的下标必须在文件内联签名表里（映射不上 = 硬失败，不得当作 air）`,
        ).toEqual([])
        expect(
          expanded.labelConflicts,
          `${comboLabel(p, combo)}：展开文件的 labels 与 signatures 推出的身份必须一致（对齐口径自洽）`,
        ).toEqual([])
        unmappedTotal += expanded.unmappedIndices.length
        labelConflicts += expanded.labelConflicts.length

        expect(
          unknownRenderedEntries(rendered, expanded),
          `${comboLabel(p, combo)}：渲染调色板不得出现展开文件未声明的方块身份`,
        ).toEqual([])

        const idMeta = diffRenderedVsExpanded(rendered, expanded, 'idMeta')
        const full = diffRenderedVsExpanded(rendered, expanded, 'full')
        cells += idMeta.cells
        diffs += idMeta.count
        fullDiffs += full.count
        totalCells += idMeta.cells
        totalCombos++
        totalFullMismatch += full.count

        expect(
          idMeta.count,
          `${comboLabel(p, combo)}：逐格 diff 必须为 0（T3.3 门禁，idMeta 口径）。${describeRealGridDiff(idMeta)}`,
        ).toBe(0)
        // `full` 口径（canonicalJson 全文）是**更强的旁证**：渲染侧调色板条目是产物并集条目的拷贝，
        // 因此两边全文也必须逐字节一致（air 两侧都归一为空串）。
        expect(
          full.count,
          `${comboLabel(p, combo)}：逐格 diff 必须为 0（full 签名口径旁证）。${describeRealGridDiff(full)}`,
        ).toBe(0)

        await captureEvidence(
          page,
          page.locator(VIEWPORT_CANVAS),
          `${comboLabel(p, combo)} T3.3 视口`,
          `${SHOT_DIR}/t33-${shotName(p, combo, testInfo, 'sample')}.png`,
        )
      }

      perMachine.push(
        `${p.slug}: 抽样 ${m.samples.length} / 格 ${cells} / idMeta diff ${diffs} / full diff ${fullDiffs}`,
      )
    }

    console.log(
      `[T3.1][${testInfo.project.name}] T3.3 逐格比对：${totalCombos} 组合 / ${totalCells} 格 / ` +
        `idMeta 差异 0 / full 差异 ${totalFullMismatch}\n  ${perMachine.join('\n  ')}`,
    )
    expect(totalCombos, 'T3.3 覆盖的抽样组合数（T1.6 清单 35 条）').toBe(35)
    expect(totalCells, 'T3.3 比对的总格数（T1.6 自检 3 实测 43,749）').toBe(43_749)
  })

  // -------------------------------------------------------------------------
  // 用例 5：证伪（内存篡改真实产物一条规则的 indexTable）
  // -------------------------------------------------------------------------

  test('证伪：篡改真实产物一条规则的 indexTable → 目标组合变红、对照组仍绿', async ({ page }, testInfo) => {
    test.setTimeout(900_000)
    const { dir, products, manifest } = requireLoad()

    // 选一台"有 indexTable 型替换规则 + 抽样里存在受影响组合"的机器
    const picked = (() => {
      for (const p of products) {
        const m = manifest.machines.find((x) => x.slug === p.slug)
        if (!m || m.samples.length < 3) continue
        for (const rule of p.rules.values()) {
          const table = rule.indexTable
          const channel = rule.channel
          if (!Array.isArray(table) || typeof channel !== 'string') continue
          const sigs = paletteSignatures(p.blockPalette)
          const ch = p.channels.find((c) => c.key === channel)
          if (!ch) continue
          /** 生效值：声明值 > 0 时用声明值，否则回落总 Tier（契约 §5.2）。 */
          const eff = (s: ExpandedSample): number => (s.values[channel] ?? 0) > 0 ? s.values[channel]! : s.totalTier
          // 找一对"内容不同"的表项位置，且存在生效值命中其中一项的抽样
          for (let i = 0; i < table.length && i < ch.domainHi + 1; i++) {
            for (let j = i + 1; j < table.length; j++) {
              const a = sigs[table[i] as number]
              const b = sigs[table[j] as number]
              if (!a || !b || a.idMeta === '' || b.idMeta === '' || a.full === b.full) continue
              const target = m.samples.find((s) => eff(s) === i)
              if (!target) continue
              const controls = m.samples.filter((s) => eff(s) !== i && eff(s) !== j).slice(0, 2)
              if (controls.length < 2) continue
              return { p, m, ruleId: String(rule.id), channel, i, j, table: table as number[], target, controls }
            }
          }
        }
      }
      throw new Error(
        'T3.1：找不到可证伪的目标（需要"indexTable 型替换规则 + 表项内容不同 + 抽样里存在生效值命中该位置"。' +
          '若产物集被更换，请检查产物是否含替换型通道规则。',
      )
    })()

    const { p, ruleId, channel, i, j, table, target, controls } = picked
    // 该规则必须真的被某些 frame 引用（否则篡改不可观测）
    const referenced = [...p.framesByVariant.values()].some((fs) => fs.some((f) => f.rules.includes(ruleId)))
    expect(referenced, `${p.file}：被篡改的规则 ${ruleId} 必须被 frame 引用`).toBe(true)
    expect(table[i], '被互换的两项必须是不同调色板条目').not.toBe(table[j])

    const sigs = paletteSignatures(p.blockPalette)
    const entryA = sigs[table[i] as number]!
    const entryB = sigs[table[j] as number]!
    const toCombo = (s: ExpandedSample): RealCombo => ({
      productFile: p.file,
      slug: p.slug,
      variantKey: s.variant,
      values: s.values,
      totalTier: s.totalTier,
      runstate: s.runstate,
    })
    const expandedOf = (s: ExpandedSample): ExpandedGrid => loadExpandedGrid(dir, s)

    // ── 基线：未篡改产物 → 目标组合必须 diff = 0 ──
    const state = await openProduct(page, p)
    await driveCombo(page, p, toCombo(target), state)
    const cleanTargetDiff = diffRenderedVsExpanded(
      await readRenderedDefinition(page),
      expandedOf(target),
      'idMeta',
    )
    expect(
      cleanTargetDiff.count,
      `基线：未篡改时 ${target.variant} 必须 diff=0。${describeRealGridDiff(cleanTargetDiff)}`,
    ).toBe(0)

    // ── 篡改：内存互换 indexTable[i] / indexTable[j]（仓库产物文件一字不改）──
    const tamperedInner = JSON.parse(JSON.stringify(p.inner)) as Record<string, unknown>
    const tRules = ((tamperedInner.multiblock as Record<string, unknown>).rules ?? []) as Array<
      Record<string, unknown>
    >
    const tRule = tRules.find((r) => String(r.id) === ruleId)!
    const tTable = tRule.indexTable as number[]
    ;[tTable[i], tTable[j]] = [tTable[j]!, tTable[i]!]
    expect(tTable, '篡改必须真的互换了两个表项').not.toEqual(table)

    // 重新起干净页面注入篡改副本（注入路径与原件完全相同：Envelope → Multiblock parser）
    const tamperedState = await openProduct(
      page,
      p,
      rewrapProduct(p.envelope, tamperedInner),
      `tampered-${p.file}`,
    )

    // ── 目标组合：逐格 diff 必须变红，且差异必须指向被互换的两个条目 ──
    const bad = await driveCombo(page, p, toCombo(target), tamperedState)
    expect(bad.snap.panelVariant, '变体键不受 indexTable 篡改影响（键只由声明值派生）').toBe(target.variant)
    const badRendered = await readRenderedDefinition(page)
    const badDiff = diffRenderedVsExpanded(badRendered, expandedOf(target), 'idMeta')
    expect(
      badDiff.count,
      `${target.variant}：篡改 ${ruleId}.indexTable[${i}]↔[${j}] 后逐格 diff 必须 > 0（管线变红）。${describeRealGridDiff(badDiff)}`,
    ).toBeGreaterThan(0)
    expect(badDiff.shape, '篡改的是内容而不是形状：形状必须不变').toBeNull()
    // 差异必须**定向**指向被互换的两个条目：
    //  参考（未篡改产物）= 原表项 table[i]（entryA）；渲染（篡改副本）= 换入的表项 table[j]（entryB）
    const badRenderedSigs = paletteSignatures(badRendered.palette)
    const badExpanded = expandedOf(target)
    for (const d of badDiff.details) {
      expect(
        d.referenceIndex === null ? null : badExpanded.signatures[d.referenceIndex]!.idMeta,
        `差异格 (x=${d.x},row=${d.row},z=${d.z}) 的参考侧必须是原表项 [${table[i]}] = ${entryA.idMeta}`,
      ).toBe(entryA.idMeta)
      expect(
        d.renderedIndex === null ? null : badRenderedSigs[d.renderedIndex]?.idMeta ?? null,
        `差异格 (x=${d.x},row=${d.row},z=${d.z}) 的渲染侧必须是被换入的表项 [${table[j]}] = ${entryB.idMeta}`,
      ).toBe(entryB.idMeta)
    }
    console.log(
      `[T3.1][${testInfo.project.name}] 证伪（indexTable）：${p.slug} ${target.variant} :: 篡改 ${ruleId}.indexTable[${i}]↔[${j}] ` +
        `→ 差异 ${badDiff.count}/${badDiff.cells} 格（参考 ${entryA.idMeta} vs 渲染 ${entryB.idMeta}），例：${JSON.stringify(badDiff.details[0])}`,
    )

    // ── 定向性：生效值未命中被篡改位置的抽样必须仍 diff = 0 ──
    for (const c of controls) {
      await driveCombo(page, p, toCombo(c), tamperedState)
      const d = diffRenderedVsExpanded(await readRenderedDefinition(page), expandedOf(c), 'idMeta')
      expect(
        d.count,
        `${p.slug} 对照组 ${c.variant}（${channel} 生效值未命中 ${i}/${j}）：逐格 diff 必须仍为 0（证伪是定向的）。${describeRealGridDiff(d)}`,
      ).toBe(0)
      console.log(
        `[T3.1][${testInfo.project.name}] 证伪对照组仍绿：${c.variant}（${channel} 生效值 ∉ {${i},${j}}）diff=0`,
      )
    }
  })
})
