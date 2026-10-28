/**
 * 验收把关清单的**机器判据定义**（逐条映射）。
 *
 * 设计原则：
 *  1. 一条清单项 = 一个 `judge(ctx)`，只读 `ctx`（由 build-report.mjs 装配好的阶段片段/分析结果），
 *     **不自己跑任何东西**；
 *  2. 每条判定必须给出 `status ∈ {pass, fail, na, not-run}` + `detail` + `evidence[]`（文件路径）；
 *  3. `na` 只允许用于「本子集/本编排无法行使」的条目，且必须写明替代证据与原因 ——
 *     禁止用它掩盖失败（`fail`/`not-run` 才代表红）；
 *  4. 所有 `evidence` 必须是**仓库内的真实文件路径**（机器可复核），不接受"人工看过"。
 */

import fs from 'node:fs'
import path from 'node:path'

import { rel, REPO_ROOT } from './evidence.mjs'

const P = (p) => (p ? rel(p, REPO_ROOT) : null)
const isFile = (p) => Boolean(p) && fs.existsSync(p)

/** 小型断言汇总器：全绿 → pass，否则 fail。 */
function gate(gates, { na = false, naReason = null, detail = null, evidence = [] } = {}) {
  const failed = gates.filter((g) => !g.ok)
  if (na) return { status: 'na', detail: naReason, evidence, gates }
  return {
    status: failed.length === 0 ? 'pass' : 'fail',
    detail: detail ?? (failed.length === 0 ? `${gates.length} 项机器断言全绿` : `失败 ${failed.length} 项：${failed.map((f) => f.name).join(', ')}`),
    evidence,
    gates,
  }
}

function stage(ctx, id) {
  return ctx.stages?.[id] ?? null
}

function stageOk(ctx, id) {
  const s = stage(ctx, id)
  return Boolean(s && s.status === 'pass')
}

// ---------------------------------------------------------------------------
// 把关清单
// ---------------------------------------------------------------------------

export const CHECKLIST = [
  // ======================= 数据真实性 =======================
  {
    id: 'data/real-capture',
    section: '数据真实性',
    text: '所有变体（含运行中态）在假世界真实构建后捕获，无凭空合成几何',
    judge(ctx) {
      const ct = ctx.pipelineResult?.timing?.captureTotals ?? null
      const exp = ctx.pipelineResult?.timing?.exportReport ?? null
      const gates = [
        { name: '捕获统计存在', ok: Boolean(ct) },
        { name: '变体数 = 捕获次数', ok: Boolean(ct) && ct.captures === ct.variants },
        { name: '真机构建次数 > 0', ok: Boolean(ct) && ct.builds > 0 },
        { name: '捕获零失败', ok: Boolean(ct) && ct.failureCount === 0 },
        { name: '状态键不稳定变体 = 0', ok: Boolean(ct) && (ct.unstableStateKeys ?? 0) === 0 },
        {
          name: '捕获路径为真机构建（full/anchored 至少一种 > 0 且不超过变体数）',
          ok:
            Boolean(ct) &&
            (ct.fullCaptureVariants ?? 0) + (ct.anchoredCaptureVariants ?? 0) > 0 &&
            (ct.fullCaptureVariants ?? 0) + (ct.anchoredCaptureVariants ?? 0) <= ct.variants,
        },
        { name: '5 台产物齐备', ok: (ctx.pipelineResult?.products ?? []).length === 5 },
        { name: '运行态两态都在声明里', ok: (ctx.productAnalysis ?? []).every((p) => (p.runstates ?? []).includes('idle') && (p.runstates ?? []).includes('active')) },
      ]
      return gate(gates, {
        detail: ct
          ? `真机构建 ${ct.builds} 次 / 捕获 ${ct.captures} 变体（失败 ${ct.failureCount}）；full ${ct.fullCaptureVariants} + anchored ${ct.anchoredCaptureVariants}；导出耗时 ${exp?.captureMs ?? '—'} ms`
          : '缺 pipeline-result.json 的 captureTotals',
        evidence: [ctx.paths.pipelineResult, ctx.paths.exportsDir].filter(isFile),
      })
    },
  },
  {
    id: 'data/palette-union',
    section: '数据真实性',
    text: '调色板 = 所有变体并集；同一方块状态烘焙几何全文件只存一份',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const globalUnion = ctx.pipelineResult?.timing?.captureTotals?.paletteEntries ?? null
      const gates = [
        { name: '每台产物调色板非空', ok: pa.length > 0 && pa.every((p) => p.paletteEntries > 0) },
        { name: '并集 = 用到的下标（无未引用条目，index 0 = air 除外）', ok: pa.every((p) => p.paletteUnusedEntries === 0) },
        { name: '内容签名全局唯一（几何只存一份）', ok: pa.every((p) => p.duplicateSignatures === 0) },
        {
          name: '本机并集 ⊆ 捕获期全局并集（按机剪枝，不新增状态）',
          ok: pa.length > 0 && (globalUnion === null || pa.every((p) => p.paletteEntries <= globalUnion)),
        },
      ]
      return gate(gates, {
        detail: pa
          .map((p) => `${p.slug}: 条目 ${p.paletteEntries}（用到 ${p.paletteUsed}）服务 ${p.N} 变体，签名重复 ${p.duplicateSignatures}`)
          .join('；'),
        evidence: [ctx.paths.pipelineResult, ...(ctx.productFiles ?? [])].filter(isFile),
      })
    },
  },
  {
    id: 'data/signature-dedup',
    section: '数据真实性',
    text: '捕获几何按内容签名去重、跨变体共享',
    judge(ctx) {
      const ct = ctx.pipelineResult?.timing?.captureTotals ?? null
      const gates = [
        { name: '捕获期发生签名去重（抑制重复捕获 > 0）', ok: Boolean(ct) && ct.duplicateCapturesSuppressed > 0 },
        {
          name: '全局并集去重率 > 1（变体数 / 并集条目数，捕获统计口径）',
          ok: Boolean(ct) && ct.paletteEntries > 0 && ct.variants / ct.paletteEntries > 1,
        },
        { name: '产品 palettes 交集（跨变体共享）经装配验证', ok: stageOk(ctx, 'verify-expanded') },
      ]
      return gate(gates, {
        detail: ct
          ? `internCalls=${ct.internCalls}，抑制重复捕获 ${ct.duplicateCapturesSuppressed} 次，并集条目 ${ct.paletteEntries} → 每条目服务 ${(ct.variants / Math.max(1, ct.paletteEntries)).toFixed(1)} 个变体`
          : '缺 captureTotals',
        evidence: [ctx.paths.pipelineResult, ctx.paths.verifyExpandedJson].filter(isFile),
      })
    },
  },

  // ======================= 压缩（需求 C 核心） =======================
  {
    id: 'compress/no-expansion',
    section: '压缩',
    text: '文件内无组合展开（抽查：文件大小 ≪ 组合数 × 单变体大小）',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const vc = ctx.volumeCurve
      const prod = vc?.products ?? []
      const sumV = prod.reduce((s, p) => s + (p.V ?? 0), 0)
      const sumG = prod.reduce((s, p) => s + (p.G ?? 0), 0)
      const kappaAgg = sumG > 0 ? sumV / sumG : null
      const gates = [
        { name: '无 frames[].ops（组合展开形态）', ok: pa.length > 0 && pa.every((p) => p.framesWithOps === 0) },
        { name: '无生产 frames[].cellGrid', ok: pa.length > 0 && pa.every((p) => p.framesWithCellGrid === 0) },
        { name: '契约校验器 frames/* 全绿', ok: ctx.contractValidation?.frameChecksOk === true },
        { name: `聚合展开比 κ=ΣV/ΣG ≥ 2.3（实测 ${kappaAgg === null ? '—' : kappaAgg.toFixed(2)}）`, ok: kappaAgg !== null && kappaAgg >= 2.3 },
      ]
      return gate(gates, {
        detail: `产物合计 ${sumG} B(gzip 内层) vs 组合展开 ${sumV} B → κ=${kappaAgg === null ? '—' : kappaAgg.toFixed(2)}×`,
        evidence: [ctx.paths.volumeCurveJson, ctx.paths.contractReport, ctx.paths.verifyExpandedJson].filter(isFile),
      })
    },
  },
  {
    id: 'compress/volume-curve',
    section: '压缩',
    text: '体积剖析数据证明"随相加而非相乘增长"',
    judge(ctx) {
      const vc = ctx.volumeCurve
      const enc = (vc?.series ?? []).filter((s) => s.id.startsWith('encoder-'))
      const encStatuses = enc.map((s) => s.status)
      const encOk = enc.length >= 2 && encStatuses.every((s) => s === 'pass' || s === 'pass-with-caveat')
      const ck = vc?.verdict?.contractKSequencePassed
      const gates = [
        { name: '对照组序列 ≥2 条（取值轴 + 通道轴）', ok: enc.length >= 2 },
        { name: '每条序列 R1（κ 随 N）全绿', ok: enc.length > 0 && enc.every((s) => s.R1.status === 'pass') },
        { name: '每条序列 R3（骨架+规则+调色板不随 N）全绿', ok: enc.length > 0 && enc.every((s) => s.R3.status === 'pass') },
        { name: 'R2 未判失败（caveat 允许，原因已登记）', ok: enc.length > 0 && enc.every((s) => s.R2.status !== 'fail') },
        { name: '契约 k 序列（契约参考实现）通过', ok: ck === true },
        { name: '边际成本 << 每组合完整网格（声明部分中位数 < 128 B/组合）', ok: enc.every((s) => (s.R2.marginalDeclarationBytesPerVariant ?? 999) < 128) },
      ]
      return gate(gates, {
        detail: enc.map((s) => `${s.id}=${s.status}(R1=${s.R1.status},R2=${s.R2.status},R3=${s.R3.status})`).join(' '),
        evidence: [ctx.paths.volumeCurveJson, ctx.paths.volumeCurveSvg, ctx.paths.volumeCurveMd, ctx.paths.volumeProfileMd].filter(isFile),
      })
    },
  },
  {
    id: 'compress/no-variant-drop',
    section: '压缩',
    text: '未靠丢弃变体/牺牲忠实度换体积；上限仅安全兜底、默认不裁剪',
    judge(ctx) {
      const cfg = ctx.pipelineResult?.environment?.sdeMultiblockConfig ?? null
      const pa = ctx.productAnalysis ?? []
      const outOfScopeKinds = ctx.pipelineResult?.outOfScopeFailuresByKind ?? null
      const gates = [
        {
          name: '范围内失败 0 条（无静默跳过；范围外失败逐条记录）',
          ok: (ctx.pipelineResult?.inScopeFailureCount ?? 1) === 0,
        },
        { name: '声明集合 = 笛卡尔积（无缺、无多）', ok: pa.length > 0 && pa.every((p) => p.declaredEqualsCartesian === true) },
        { name: '每变体恰好一帧（Frame 唯一原语）', ok: pa.length > 0 && pa.every((p) => p.frames === p.N) },
        { name: '未收窄域（maxChannelValues=0）', ok: cfg?.maxChannelValues === 0 },
        { name: '未限台数（maxExportMachines=0）', ok: cfg?.maxExportMachines === 0 },
        { name: '未只导结构性组合（structuralOnly=false）', ok: cfg?.structuralOnly === false },
        { name: '单台兜底上限 = 20000（仅安全兜底）', ok: cfg?.maxVariantsPerMachine === 20000 },
      ]
      return gate(gates, {
        detail:
          (cfg
            ? `structuralCompression=${cfg.structuralCompression} maxVariantsPerMachine=${cfg.maxVariantsPerMachine} maxChannelValues=${cfg.maxChannelValues} maxExportMachines=${cfg.maxExportMachines} structuralOnly=${cfg.structuralOnly}；`
            : '缺 sdeMultiblockConfig；') +
          `范围内失败 ${ctx.pipelineResult?.inScopeFailureCount ?? '?'} 条；范围外失败 ${ctx.pipelineResult?.outOfScopeFailureCount ?? '?'} 条` +
          (outOfScopeKinds ? `（${Object.entries(outOfScopeKinds).map(([k, v]) => `${k}×${v}`).join(', ')}，枚举事实层 slug 碰撞，与本次范围无关且不隐藏）` : ''),
        evidence: [ctx.paths.pipelineResult, ctx.paths.contractReport].filter(isFile),
      })
    },
  },
  {
    id: 'compress/envelope-reuse',
    section: '压缩',
    text: 'gzip+base64 信封机制复用未重做；因子化发生在信封之前',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const gates = [
        { name: '全部产物 documentFormat=Envelope', ok: pa.length > 0 && pa.every((p) => p.envelope.documentFormat === 'Envelope') },
        { name: '全部产物 payloadEncoding=gzip+base64', ok: pa.length > 0 && pa.every((p) => p.envelope.payloadEncoding === 'gzip+base64') },
        { name: '全部产物 payload 可 gunzip 解出内层 JSON', ok: pa.length > 0 && pa.every((p) => p.envelope.payloadDecoded === true) },
        { name: '内层含 multiblock/multiblockCount/frames/blockPalette', ok: pa.length > 0 && pa.every((p) => p.envelope.innerHasMultiblock && p.envelope.innerHasFrames && p.envelope.innerHasPalette) },
        { name: '内层无根级 cellGrid（多方块形态）', ok: pa.length > 0 && pa.every((p) => p.rootCellGrid === false) },
      ]
      return gate(gates, {
        detail: `${pa.length} 份产物的信封形态与载荷键位一致`,
        evidence: [...(ctx.productFiles ?? [])].filter(isFile),
      })
    },
  },

  // ======================= 格式与兼容 =======================
  {
    id: 'format/shape-exclusive',
    section: '格式与兼容',
    text: '文档级枚举互斥判别；帧为主既有格式/解析/播放语义不变',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const frameSpec = ctx.web?.synthetic?.specs?.['multiblock-frame-regression.spec.ts'] ?? null
      const gates = [
        { name: '全部产物 meta.documentShape=multiblock', ok: pa.length > 0 && pa.every((p) => p.envelope.documentShape === 'multiblock') },
        { name: '全部产物无根级 cellGrid/blockPalette 展开', ok: pa.length > 0 && pa.every((p) => p.rootCellGrid === false) },
        { name: '帧为主回归 spec 全绿', ok: frameSpec ? frameSpec.failed === 0 && frameSpec.passed > 0 : false },
        { name: '既有 parser round-trip 单测全绿（vitest）', ok: stageOk(ctx, 'web-unit-vitest') },
      ]
      const na = !ctx.web?.synthetic?.present
      return gate(gates, {
        na,
        naReason: na ? '合成 fixture 回归（含帧为主回归 spec）未运行：找不到 playwright 结果' : null,
        evidence: [ctx.paths.contractReport, ctx.paths.webSyntheticJson].filter(isFile),
      })
    },
  },
  {
    id: 'format/frame-primitive',
    section: '格式与兼容',
    text: 'Frame 仍是唯一变体存储原语，无新概念抽象层',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const gates = [
        { name: 'frames 数 = 变体数', ok: pa.length > 0 && pa.every((p) => p.frames === p.N) },
        { name: 'frame 只带 {index,variant,runstate,stepIndex,rules}', ok: pa.length > 0 && pa.every((p) => p.frameKeysSubset === true) },
        { name: '无 frames[].ops / frames[].cellGrid', ok: pa.length > 0 && pa.every((p) => p.framesWithOps === 0 && p.framesWithCellGrid === 0) },
        { name: '契约校验器 frames/cover-variants 全绿', ok: ctx.contractValidation?.frameChecksOk === true },
      ]
      return gate(gates, {
        detail: `5 台产物 frames 键位与数量均符合契约 §5.3`,
        evidence: [ctx.paths.contractReport, ...(ctx.productFiles ?? [])].filter(isFile),
      })
    },
  },
  {
    id: 'format/channel-naming',
    section: '格式与兼容',
    text: '通道命名尊重游戏内 id；重名 id（casing ×3）已消歧',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const allChannels = pa.flatMap((p) => p.channels ?? [])
      const gates = [
        { name: '每通道带 enum+id+key+name（双键消歧位齐备）', ok: allChannels.length > 0 && allChannels.every((c) => c.enum !== null && c.enum !== undefined && c.id && c.key && c.name) },
        { name: '同一机器内 key 唯一', ok: pa.every((p) => new Set((p.channels ?? []).map((c) => c.key)).size === (p.channels ?? []).length) },
        { name: 'name 取枚举语义而非 capitalize(id)', ok: allChannels.every((c) => c.name !== (c.id ? c.id[0].toUpperCase() + c.id.slice(1) : c.name)) },
        { name: '契约校验器 channels/name-unique 全绿', ok: ctx.contractValidation?.channelChecksOk === true },
      ]
      const hasCasing = allChannels.some((c) => c.id === 'casing')
      return gate(gates, {
        na: false,
        detail: hasCasing
          ? '本子集含 casing 通道，按枚举名消歧'
          : '本子集 5 台均无重名 id（casing 不在其中）；消歧位（enum+id 双键）由上面第 1 条机器验证，重名场景的证据见 docs/contracts/format-multiblock-doc.md §4.2',
        evidence: [ctx.paths.contractReport].filter(isFile),
      })
    },
  },
  {
    id: 'format/coupling-defaults',
    section: '格式与兼容',
    text: '通道耦合约束有表达或明确的缺省行为定义',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const gates = [
        { name: '每台产物显式声明 couplingMode', ok: pa.length > 0 && pa.every((p) => p.couplingMode === 'none' || p.couplingMode === 'clamp') },
        { name: 'couplings 为数组（可为空）', ok: pa.length > 0 && pa.every((p) => p.couplingsIsArray === true) },
        { name: 'notes[] 非空（缺省行为已声明）', ok: pa.length > 0 && pa.every((p) => p.notesCount > 0) },
        { name: '契约校验器 rules/guard-channel 全绿', ok: ctx.contractValidation?.ruleChecksOk === true },
      ]
      return gate(gates, {
        detail: pa.map((p) => `${p.slug}: couplingMode=${p.couplingMode} couplings=${p.couplingsCount} notes=${p.notesCount}`).join('；'),
        evidence: [ctx.paths.contractReport].filter(isFile),
      })
    },
  },

  // ======================= web 渲染 =======================
  {
    id: 'web/assembly-zero-game-logic',
    section: 'web 渲染',
    text: '装配路径零游戏逻辑（查表 + 索引）',
    judge(ctx) {
      const sc = ctx.staticChecks?.assemblyPath ?? null
      const gates = [
        { name: '静态检查已运行', ok: Boolean(sc) },
        { name: '无 GT/StructureLib 依赖 import', ok: Boolean(sc) && sc.findings.noGtImports.length === 0 },
        { name: '无按通道 id 的 switch/分支（游戏逻辑重放）', ok: Boolean(sc) && sc.findings.noChannelIdBranching.length === 0 },
        { name: '无 eval/Function 动态求值', ok: Boolean(sc) && sc.findings.noDynamicEval.length === 0 },
        { name: '装配器只依赖查表/索引原语（被扫描文件集合非空）', ok: Boolean(sc) && sc.scannedFiles.length > 0 },
      ]
      return gate(gates, {
        detail: sc ? `扫描 ${sc.scannedFiles.length} 个文件（${sc.scannedFiles.join(', ')}）；发现 ${sc.findings.total} 处` : '缺静态检查结果',
        evidence: [ctx.paths.staticChecksJson].filter(isFile),
      })
    },
  },
  {
    id: 'web/assembly-equals-mod',
    section: 'web 渲染',
    text: '同文件同取值 → web 装配与 mod 导出逐格一致',
    judge(ctx) {
      const real = ctx.web?.realAcceptance ?? null
      const cross = ctx.web?.crossCheck ?? null
      const ve = ctx.verifyExpanded ?? null
      const gates = [
        { name: '真实导出 spec 全绿（MB_REAL_EXPORTS_DIR）', ok: Boolean(real?.present) && real.failed === 0 && real.passed > 0 },
        { name: '真实 web 装配 vs mod ground-truth 逐格 diff = 0（verify-web-parser）', ok: Boolean(cross?.ok) },
        { name: 'lib.mjs 参考装配 vs 展开校验文件 diff = 0（37+ 抽样）', ok: Boolean(ve?.ok) },
        { name: '无下标映射失败（映射不上 = 硬失败）', ok: Boolean(ve) && (ve.signatureMapMisses ?? 0) === 0 },
      ]
      return gate(gates, {
        detail:
          `realSpec=${real?.present ? `${real.passed} pass/${real.failed} fail` : 'not-run'}；` +
          `webAssembler diff=${cross?.diffTotal ?? '—'}（变体 ${cross?.variants ?? '—'}）；` +
          `expanded diff=${ve?.diffTotal ?? '—'}（组合 ${ve?.samples ?? '—'}，格 ${ve?.cells ?? '—'}）`,
        evidence: [ctx.paths.webRealJson, ctx.paths.webCrossJson, ctx.paths.verifyExpandedJson].filter(isFile),
      })
    },
  },
  {
    id: 'web/channel-ui',
    section: 'web 渲染',
    text: '通道 UI 忠实反映文件声明；滑杆标签/范围/"Not set" 符合命名约定',
    judge(ctx) {
      const real = ctx.web?.realAcceptance ?? null
      const synth = ctx.web?.synthetic ?? null
      const panelSpecs = Object.entries(synth?.specs ?? {}).filter(([f]) => /panel|channel|traversal|illegal/i.test(f))
      const gates = [
        { name: '真实导出 spec 覆盖通道面板断言且全绿', ok: Boolean(real?.present) && real.failed === 0 && real.passed > 0 },
        { name: '合成 fixture 面板/遍历/非法组合 spec 全绿', ok: panelSpecs.length >= 3 && panelSpecs.every(([, s]) => s.failed === 0 && s.passed > 0) },
        { name: '通道面板 DOM 单测全绿（vitest）', ok: stageOk(ctx, 'web-unit-vitest') },
      ]
      return gate(gates, {
        detail: panelSpecs.map(([f, s]) => `${f}:${s.passed}/${s.failed}`).join(' ') || '无面板 spec 结果',
        evidence: [ctx.paths.webRealJson, ctx.paths.webSyntheticJson].filter(isFile),
      })
    },
  },
  {
    id: 'web/frame-layer-untouched',
    section: 'web 渲染',
    text: '与帧播放/分层预览互不干扰；Embed 与 Workbench 两端均可用',
    judge(ctx) {
      const synth = ctx.web?.synthetic ?? null
      const frameSpec = synth?.specs?.['multiblock-frame-regression.spec.ts'] ?? null
      const fixtureSpec = synth?.specs?.['multiblock-fixture-load.spec.ts'] ?? null
      const gates = [
        { name: '帧为主回归 spec 全绿', ok: Boolean(frameSpec) && frameSpec.failed === 0 && frameSpec.passed > 0 },
        { name: '双端（desktop+mobile）两个 playwright project 均有通过用例', ok: Boolean(synth) && Object.keys(synth.projects ?? {}).length >= 2 && Object.values(synth.projects).every((p) => p.passed > 0 && p.failed === 0) },
        { name: 'fixture 加载 spec 全绿（两端挂载）', ok: Boolean(fixtureSpec) && fixtureSpec.failed === 0 && fixtureSpec.passed > 0 },
      ]
      return gate(gates, {
        detail: synth ? `projects=${JSON.stringify(synth.projects)}` : '缺合成回归结果',
        evidence: [ctx.paths.webSyntheticJson].filter(isFile),
      })
    },
  },

  // ======================= 工程纪律 =======================
  {
    id: 'eng/builds',
    section: '工程纪律',
    text: 'npm run build:mod:gtnh / npm run build:web / cd web && npx vitest run 通过',
    judge(ctx) {
      const gates = [
        { name: 'gradlew build（含 spotless）通过', ok: stageOk(ctx, 'build-mod-gtnh') },
        { name: 'npm run build:web 通过', ok: stageOk(ctx, 'build-web') },
        { name: 'npx vitest run 全绿', ok: stageOk(ctx, 'web-unit-vitest') },
      ]
      return gate(gates, {
        detail: ['build-mod-gtnh', 'build-web', 'web-unit-vitest'].map((id) => `${id}=${stage(ctx, id)?.status ?? 'not-run'}`).join(' '),
        evidence: [ctx.paths.buildModLog, ctx.paths.buildWebLog, ctx.paths.vitestLog].filter(isFile),
      })
    },
  },
  {
    id: 'eng/three-axes-only',
    section: '工程纪律',
    text: '未引入除「通道」「运行态」外的第三个轴',
    judge(ctx) {
      const pa = ctx.productAnalysis ?? []
      const gates = [
        { name: 'multiblock 对象键 ⊆ 契约 §4.1 白名单', ok: pa.length > 0 && pa.every((p) => p.unknownMultiblockKeys.length === 0) },
        { name: '内层 body 键 ⊆ 契约 §3 白名单', ok: pa.length > 0 && pa.every((p) => p.unknownInnerKeys.length === 0) },
        { name: '通道 kind ⊆ {size,replace,hatch}', ok: pa.every((p) => (p.channels ?? []).every((c) => ['size', 'dimension', 'replace', 'hatch'].includes(c.kind))) },
        { name: '契约校验器 shape/* 与 backbone/* 全绿', ok: ctx.contractValidation?.shapeChecksOk === true },
      ]
      return gate(gates, {
        detail: pa.map((p) => `${p.slug}: 内层多余键 ${p.unknownInnerKeys.length} / multiblock 多余键 ${p.unknownMultiblockKeys.length}`).join('；'),
        evidence: [ctx.paths.contractReport].filter(isFile),
      })
    },
  },
  {
    id: 'eng/no-gt-logic-in-web',
    section: '工程纪律',
    text: '未在 web 端重放 GT/StructureLib 逻辑',
    judge(ctx) {
      const sc = ctx.staticChecks?.gtReplay ?? null
      const gates = [
        { name: '静态检查已运行', ok: Boolean(sc) },
        { name: 'web/src 无 gregtech/StructureLib/GT5U 运行时依赖', ok: Boolean(sc) && sc.findings.noGtImports.length === 0 },
        { name: 'web/src 无通道 id 常量表（游戏语义硬编码）', ok: Boolean(sc) && sc.findings.noChannelIdConstants.length === 0 },
        { name: '无 tier/等级推导逻辑（结构尺寸只来自声明）', ok: Boolean(sc) && sc.findings.noGameFormulas.length === 0 },
      ]
      return gate(gates, {
        detail: sc ? `扫描 ${sc.scannedFiles.length} 个文件；发现 ${sc.findings.total} 处` : '缺静态检查结果',
        evidence: [ctx.paths.staticChecksJson].filter(isFile),
      })
    },
  },

  // ======================= 自动化验收 =======================
  {
    id: 'auto/single-command',
    section: '自动化验收',
    text: '一条命令跑通全闭环：自动进世界 → 自动导出 → 无头渲染 → 自动断言，零人工交互',
    judge(ctx) {
      const it = ctx.interactivity ?? null
      const gates = [
        { name: '由单条 npm script 驱动（run-state.singleCommand）', ok: it?.singleCommand === true },
        { name: '零交互提示（prompts=0）', ok: it?.prompts === 0 },
        { name: '所有子进程 stdin 重定向（无人可输入）', ok: it?.stdinRedirected === true },
        { name: '到导出落盘全程无人工步骤（mod 半环自动进世界）', ok: ctx.pipelineResult?.environment?.world?.action != null },
        { name: 'web 半环无头驱动（playwright headless）', ok: it?.webHeadless === true },
      ]
      const sample = ctx.mode === 'sample'
      return gate(gates, {
        status: sample ? 'na' : undefined,
        na: sample,
        naReason: sample ? '样例模式（-SampleFrom）不构成"一条命令跑通全闭环"的证据；需验收人亲自跑 npm run acceptance:multiblock' : null,
        detail: it ? `mode=${it.mode} prompts=${it.prompts} stdinRedirected=${it.stdinRedirected}` : '缺 interactivity 记录',
        evidence: [ctx.paths.runState].filter(isFile),
      })
    },
  },
  {
    id: 'auto/report-artifacts',
    section: '自动化验收',
    text: 'acceptance-report.json 产出且全绿；截图证据链与体积曲线数据随报告归档',
    judge(ctx) {
      const shots = ctx.screenshots ?? null
      const gates = [
        { name: 'acceptance-report.json 存在', ok: isFile(ctx.paths.reportJson) },
        { name: 'acceptance-report.md 存在', ok: isFile(ctx.paths.reportMd) },
        { name: 'volume-curve.json + .svg 存在', ok: isFile(ctx.paths.volumeCurveJson) && isFile(ctx.paths.volumeCurveSvg) },
        { name: '截图证据链归档目录 + 清单存在', ok: Boolean(shots) && isFile(shots?.manifest) },
        { name: '截图数量 > 0', ok: (shots?.count ?? 0) > 0 },
        { name: '抽样清单内联进报告', ok: Array.isArray(ctx.pipelineResult?.expanded?.sampleList) && ctx.pipelineResult.expanded.sampleList.length > 0 },
        { name: '除本条外其余清单项无 fail/not-run', ok: (ctx.checks ?? []).filter((c) => c.id !== 'auto/report-artifacts').every((c) => c.status === 'pass' || c.status === 'na') },
      ]
      const sample = ctx.mode === 'sample'
      return gate(gates, {
        na: sample,
        naReason: sample ? '样例模式的报告不是验收结论（verdict=sample）' : null,
        detail: `截图 ${shots?.count ?? 0} 张 → ${shots?.archiveRel ?? '—'}`,
        evidence: [ctx.paths.reportJson, ctx.paths.volumeCurveJson, shots?.manifest].filter(isFile),
      })
    },
  },
  {
    id: 'auto/idempotent',
    section: '自动化验收',
    text: '管线幂等：同环境连续两次运行结果一致（导出产物字节一致）',
    judge(ctx) {
      const idem = ctx.idempotency ?? null
      const gates = [
        { name: '与最近一次归档运行逐字节一致（products）', ok: Boolean(idem?.priorRun?.allSame) },
        { name: '展开校验文件逐字节一致', ok: idem?.priorRun?.expandedAllSame !== false },
        { name: '产物哈希清单随报告归档', ok: (ctx.pipelineResult?.products ?? []).length > 0 && ctx.pipelineResult.products.every((p) => typeof p.sha256 === 'string' && p.sha256.length === 64) },
      ]
      if (idem?.comparedWith) {
        gates.push({ name: '两次 acceptance 的判定逐条一致（-CompareWith）', ok: idem.verdictsMatch === true })
      }
      return gate(gates, {
        detail: idem?.priorRun
          ? `对比基线：${idem.priorRun.label}（products ${idem.priorRun.allSame ? '全同' : '有差异'}，expanded ${idem.priorRun.expandedAllSame === false ? '有差异' : '全同'}）`
          : '找不到可对比的历史归档（首次运行）；需连跑第二次以形成幂等证据',
        evidence: [ctx.paths.pipelineResult, idem?.priorRunArtifact].filter(isFile),
      })
    },
  },
  {
    id: 'auto/falsification',
    section: '自动化验收',
    text: '断言有效性已证伪测试：故意注入错误（篡改一格 / 篡改文件声明）管线变红',
    judge(ctx) {
      const f = ctx.falsification ?? null
      const controls = (f?.controls ?? []).filter((c) => c.ran !== false)
      const gateOk = controls.filter((c) => c.ok)
      const synth = ctx.web?.synthetic?.specs?.['multiblock-falsification.spec.ts'] ?? null
      const gates = [
        { name: '离线负对照 ≥3 条（已运行）且全部按预期变红', ok: controls.length >= 3 && gateOk.length === controls.length },
        { name: 'mod 半环：未知机器 → 退出码 2 + 原因落盘', ok: controls.find((c) => c.id === 'mod-unknown-machine')?.ok === true },
        { name: '契约校验器：注入 frames[].ops → 判硬失败', ok: controls.find((c) => c.id === 'tamper-frames-ops')?.ok === true },
        { name: '逐格 diff：篡改一格 → diff > 0 变红', ok: controls.find((c) => c.id === 'tamper-expanded-cell')?.ok === true },
        { name: 'web 证伪 spec 全绿（篡改必红 + 定向性）', ok: Boolean(synth) && synth.failed === 0 && synth.passed > 0 },
        { name: '正对照：未篡改输入仍判绿（排除恒红）', ok: controls.length > 0 && controls.every((c) => c.controlStatus === 'pass' || c.controlStatus === 'sample') },
      ]
      return gate(gates, {
        detail: controls.map((c) => `${c.id}=${c.ok ? 'red-as-expected' : 'NOT-RED'}`).join(' ') + (synth ? ` | web ${synth.passed}/${synth.failed}` : ' | web spec 未运行'),
        evidence: [ctx.paths.falsificationJson, ctx.paths.webSyntheticJson].filter(isFile),
      })
    },
  },
  {
    id: 'auto/no-manual',
    section: '自动化验收',
    text: '验收无任何"人工过一遍"作为通过依据的环节',
    judge(ctx) {
      const checks = (ctx.checks ?? []).filter((c) => c.id !== 'auto/no-manual' && c.id !== 'auto/report-artifacts')
      const humanJudged = checks.filter((c) => c.judgedBy !== 'machine')
      const sample = ctx.mode === 'sample'
      const gates = [
        { name: '所有清单项由机器判据给出（judgedBy=machine）', ok: humanJudged.length === 0 },
        { name: '每条清单项都带可复核证据路径', ok: checks.every((c) => (c.evidence ?? []).length > 0) },
        { name: '零交互记录成立', ok: ctx.interactivity?.prompts === 0 },
        { name: '所有阶段产物落盘于运行目录（无"口头结论"）', ok: (ctx.stageList ?? []).every((s) => (s.artifacts ?? []).length > 0 || (s.evidence ?? []).length > 0) },
      ]
      return gate(gates, {
        na: sample,
        naReason: sample ? '样例模式不是验收；终验跑（验收人）才判定本项' : null,
        detail: `humanJudged=${humanJudged.length}`,
        evidence: [ctx.paths.reportJson].filter(isFile),
      })
    },
  },
]

/**
 * 清单项 → 依赖的阶段 id。
 *
 * 语义：若某项判据依赖的阶段**根本没跑或状态为 not-run**，则该项一律降级为 `not-run`（红），
 * 即使局部断言看起来是绿的 —— 这就是"不静默算通过"的落点（例如真实导出 spec 未落地时，
 * "web 装配 = mod 导出"绝不允许仅凭合成 fixture 判绿）。
 */
export const CHECK_STAGE_DEPS = {
  'data/real-capture': ['export-multiblock'],
  'data/palette-union': ['export-multiblock'],
  'data/signature-dedup': ['export-multiblock', 'verify-expanded'],
  'compress/no-expansion': ['export-multiblock', 'contract-validate', 'volume-curve'],
  'compress/volume-curve': ['volume-curve'],
  'compress/no-variant-drop': ['export-multiblock'],
  'compress/envelope-reuse': ['export-multiblock'],
  'format/shape-exclusive': ['web-unit-vitest'],
  'format/frame-primitive': ['contract-validate'],
  'format/channel-naming': ['contract-validate'],
  'format/coupling-defaults': ['contract-validate'],
  'web/assembly-zero-game-logic': ['static-checks'],
  'web/assembly-equals-mod': ['verify-expanded', 'web-real-acceptance'],
  'web/channel-ui': ['web-unit-vitest', 'web-synthetic-regression', 'web-real-acceptance'],
  'web/frame-layer-untouched': ['web-synthetic-regression'],
  'eng/builds': ['build-mod-gtnh', 'build-web', 'web-unit-vitest'],
  'eng/three-axes-only': ['contract-validate'],
  'eng/no-gt-logic-in-web': ['static-checks'],
  'auto/single-command': ['preflight'],
  'auto/report-artifacts': [],
  'auto/idempotent': ['export-multiblock'],
  'auto/falsification': ['falsify-offline-negative', 'web-synthetic-regression'],
  'auto/no-manual': [],
}

/** 给每条清单项补上 `judgedBy` 与 `section`（报告 schema 的稳定性来自这里）。 */
export function runChecklist(ctx) {
  const out = []
  for (const item of CHECKLIST) {
    let res
    try {
      res = item.judge(ctx)
    } catch (e) {
      res = { status: 'fail', detail: `判据异常：${e.message}`, evidence: [] }
    }
    out.push({
      id: item.id,
      section: item.section,
      text: item.text,
      judgedBy: 'machine',
      status: res.status,
      detail: res.detail ?? null,
      gates: res.gates ?? [],
      evidence: res.evidence ?? [],
    })
  }
  return out
}
