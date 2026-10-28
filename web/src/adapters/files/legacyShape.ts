/**
 * `adapters/files/legacyShape` —— **旧格式形态判别与终态硬约束**。
 *
 * ## 本模块替代的旧机制
 *
 * 形态判别在旧实现里散在**四处**，各写一遍判据：
 *
 * | 旧位置 | 旧判据 |
 * |---|---|
 * | `render/data/bundleResolve.ts:49-55` `isWorldDocument` | `Array.isArray(frames) && typeof id === 'string' && !format_version` |
 * | `context/parsers/builtinParsers.ts:72` `WorldParser.detect` | 同上（**复写**） |
 * | `context/parsers/builtinParsers.ts:45` `V2PlainParser.detect` | `format_version === '2.0' && Array.isArray(frames)` |
 * | `context/parsers/multiblockDocument.ts:330-338` `isMultiblockDocument` | `documentShape` + `multiblock` + `multiblockCount === 1` + 无根级 `cellGrid` |
 *
 * 四条判据**顺序敏感**：注册顺序一变，同一份文件会走不同解析链（`parserRegistry.ts:50-63`
 * 为此写了"Virtual 优先"的说明）。这件事收敛成一条要求：
 * **单一 `classifyShape`**，`adapters/files` 只消费它。
 *
 * 收敛的判据不是"少写一个函数"，而是可证伪性：本模块有一个**唯一**的判别入口
 * （{@link classifyShape}），且它的每条分支都对应契约里一句明文（见各分支注释的出处）。
 * 复写品无法再各自漂移，因为它们不存在了（旧四处已按其归口退役）。
 *
 * ## 终态硬约束
 *
 * `docs/contracts/format-scene-file.md` §3.1（烘焙终态约束）原文：
 *
 * > **烘焙终态的硬约束**：`cellTypes` 与 `worldGrid` 是 **scan 中间态专有**字段，
 * > 烘焙后**必须消失**（`finalizeSingleStructure` 的 `structure.remove(...)`）。
 * > 消费方（`web/src/render/data/bundleResolve.ts:44`）会拒绝带它们的「终态」。
 *
 * 旧消费方只有 `loadStructureData` 一条路径做这件事，而它**只覆盖裸单结构**
 * （`bundleResolve.ts:43-45` 在 `isBakedStructureData` 之后）。World 形态里
 * **每帧**的 `structure` 走的是另一条路径，没有这条校验 —— 于是"World 里塞一个
 * 带 `cellTypes` 的 baked 帧"在旧实现下可以过关。「`geometryPhase:'baked'` 里混入
 * `cellTypes` 仍被接受」正是指定的负对照之一。
 *
 * 本模块把它变成**贯穿两种形态**的单一校验：{@link checkBakedTerminal} 对裸结构与
 * World 的每个内嵌结构都跑同一条判据。
 */

import { invalidValue, type Result, ok, err } from '@/domain/errors'

// ─────────────────────────────────────────────────────────────────────────────
// 形态判别（B-4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档形态。
 *
 * 四个取值各自对应契约里一个**互斥**的形态，不是"标签"：
 *  - `world` / `structure`：`format-scene-file.md` §1（判别式 = `frames` 的**存在性**，不是帧数）；
 *  - `v2plain`：`format_version === '2.0'`（`builtinParsers.ts:45`），它**优先于** world
 *    ——因为 V2 文档为了复用帧语义天然带 `frames`；
 *  - `multiblock`：`documentShape === 'multiblock'`（`format-multiblock-doc.md` §2），
 *    它必须**最先**判别（`parserRegistry.ts:50-57` 的"Virtual 优先"就是这件事）。
 */
export type LegacyShape = 'multiblock' | 'v2plain' | 'world' | 'structure' | 'unknown'

/** 判别结论（带**判据**，不是光秃秃一个字符串）。 */
export interface ShapeVerdict {
  readonly shape: LegacyShape
  /** 命中的判据标识（稳定；供诊断与证据对账，不随语言变化）。 */
  readonly criterion: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 多方块形态键的判别（与 `format-multiblock-doc.md` §2 同一处事实）。 */
export function readDocumentShape(doc: unknown): unknown {
  if (!isPlainObject(doc)) return undefined
  if (doc.documentShape !== undefined) return doc.documentShape
  const meta = doc.meta
  return isPlainObject(meta) ? meta.documentShape : undefined
}

/**
 * **单一**形态判别入口（B-4）。
 *
 * 判定顺序**是判据的一部分**，不是实现细节：
 *  1. `multiblock`（形态键最先，否则多层/多帧的多方块文档会被 v2plain 接走）；
 *  2. `v2plain`（`format_version` 判据**优先于** world —— `builtinParsers.ts:72` 原文
 *     排除了 `format_version`，这条排除必须在这里保留，否则 V2 文档会被判成 world）；
 *  3. `world`（有 `frames`）；
 *  4. `structure`（无 `frames`，有 `geometryPhase` + `cellGrid`）；
 *  5. 其余 `unknown`。
 *
 * `unknown` 是**显式**结果而不是"当 structure 处理"：静默回落正是 B-4 要避免的
 * "凭名称/凭形状猜约定"。
 */
export function classifyShape(doc: unknown): ShapeVerdict {
  if (!isPlainObject(doc)) return Object.freeze({ shape: 'unknown' as const, criterion: 'notObject' })

  if (readDocumentShape(doc) === 'multiblock') {
    return Object.freeze({ shape: 'multiblock' as const, criterion: 'documentShape=multiblock' })
  }

  const hasFrames = Array.isArray(doc.frames)
  if (doc.format_version === '2.0') {
    // V2Plain 的**必要条件**是 `frames`（`builtinParsers.ts:45`）。
    // 只写 `format_version` 而没有 `frames` 的文档不是 V2Plain —— 报 unknown 而不是
    // 猜成 structure，因为"该带帧的文档没有帧"是一个需要人看的形态缺陷。
    return hasFrames
      ? Object.freeze({ shape: 'v2plain' as const, criterion: 'format_version=2.0+frames' })
      : Object.freeze({ shape: 'unknown' as const, criterion: 'format_version=2.0-without-frames' })
  }

  if (hasFrames) {
    // 契约 `format-scene-file.md` §1：**判别式是 `frames` 的存在性，不是帧数**。
    // 故这里**不**看 `frames.length`，也**不**看 `id` 是不是字符串 —— 旧 `isWorldDocument`
    // 多要求了 `typeof id === 'string'`，那让"缺 id 的 World"掉进 structure 分支去按
    // `cellGrid` 解析，是形态误判的来源。判别式按契约收窄到唯一那一条。
    return Object.freeze({ shape: 'world' as const, criterion: 'hasFrames' })
  }

  if (doc.geometryPhase === 'scan' || doc.geometryPhase === 'baked' || Array.isArray(doc.cellGrid)) {
    return Object.freeze({ shape: 'structure' as const, criterion: 'geometryPhase/cellGrid-without-frames' })
  }

  return Object.freeze({ shape: 'unknown' as const, criterion: 'noShapeMarker' })
}

/** 便捷：判别结果是否属于某个形态（可读性包装，不引入第二套判据）。 */
export function isShape(doc: unknown, shape: LegacyShape): boolean {
  return classifyShape(doc).shape === shape
}

// ─────────────────────────────────────────────────────────────────────────────
// 终态硬约束
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `scan` 中间态**专有**、`baked` 终态**必须消失**的字段（契约 `format-scene-file.md` §3.1）。
 *
 * 常量化是为了让"要消失的是哪两个"只有一处定义：写在两处（校验一处、文档一处）
 * 必然会漂移，而漂移的表现是"某天有人只挡住了一个"。
 */
export const SCAN_ONLY_FIELDS = Object.freeze(['cellTypes', 'worldGrid'] as const)

/** 终态缺陷（结构化；参数是稳定键名，不是拼好的自然语言）。 */
export interface TerminalDefect {
  readonly code: 'BakedTerminalCarriesScanField' | 'BakedTerminalMissingPalette' | 'GeometryPhaseUnknown'
  /** 缺陷所在的路径（`frames[2].structure` 或根）。 */
  readonly at: string
  readonly detail: Readonly<Record<string, string | number>>
}

/**
 * 校验一个**裸结构**是否满足终态硬约束。
 *
 * 判据（逐条来自契约）：
 *  1. `geometryPhase === 'baked'`（`builtinParsers.ts:125` 的 detect 条件）；
 *  2. `cellTypes` / `worldGrid` **必须不在**（否则 `BakedTerminalCarriesScanField`）；
 *  3. `blockPalette` 与 `cellGrid` 必须在（终态可渲染的定义，`format-scene-file.md` §3.1）。
 *
 * `geometryPhase` 不是 `baked` 时：
 *  - `scan` ⇒ **不报错**（它是合法中间态，契约明说"Wiki 不直接渲染"而已），
 *    由调用方决定要不要继续；
 *  - 其它/缺失 ⇒ `GeometryPhaseUnknown`（不猜成 baked）。
 */
export function checkBakedTerminal(doc: unknown, at = 'root'): readonly TerminalDefect[] {
  if (!isPlainObject(doc)) return Object.freeze([Object.freeze({ code: 'GeometryPhaseUnknown' as const, at, detail: Object.freeze({ reason: 'notObject' }) })])
  const phase = doc.geometryPhase
  if (phase !== 'baked') {
    if (phase === 'scan') return Object.freeze([])
    return Object.freeze([
      Object.freeze({ code: 'GeometryPhaseUnknown' as const, at, detail: Object.freeze({ reason: 'missingOrUnknownPhase', phase: String(phase) }) }),
    ])
  }
  const out: TerminalDefect[] = []
  for (const field of SCAN_ONLY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(doc, field)) {
      out.push(
        Object.freeze({
          code: 'BakedTerminalCarriesScanField' as const,
          at,
          detail: Object.freeze({ field, phase: 'baked' }),
        }),
      )
    }
  }
  if (!Array.isArray(doc.blockPalette)) {
    out.push(Object.freeze({ code: 'BakedTerminalMissingPalette' as const, at, detail: Object.freeze({ field: 'blockPalette' }) }))
  }
  if (!Array.isArray(doc.cellGrid)) {
    out.push(Object.freeze({ code: 'BakedTerminalMissingPalette' as const, at, detail: Object.freeze({ field: 'cellGrid' }) }))
  }
  return Object.freeze(out)
}

/**
 * 对**整份文档**（裸结构 / World / 多方块内层 body）跑终态硬约束。
 *
 * 这是旧实现缺失的那一半（见文件头）：World 的**每一帧**都要过同一条判据。
 * 多方块为主文档的 body **禁止根级 `cellGrid`**（`format-multiblock-doc.md` §3），
 * 故它的 `cellGrid` 在每帧的 `structure` 里 —— 同一段循环覆盖它。
 */
export function checkDocumentTerminal(doc: unknown): readonly TerminalDefect[] {
  if (!isPlainObject(doc)) {
    return Object.freeze([Object.freeze({ code: 'GeometryPhaseUnknown' as const, at: 'root', detail: Object.freeze({ reason: 'notObject' }) })])
  }
  if (Array.isArray(doc.frames)) {
    const out: TerminalDefect[] = []
    doc.frames.forEach((frame, i) => {
      if (!isPlainObject(frame)) return
      const structure = frame.structure
      if (structure === undefined) return
      // 帧里可以是 `structureRef`（仅引用）——那不是本判据的面，跳过而不是报错。
      for (const d of checkBakedTerminal(structure, `frames[${i}].structure`)) out.push(d)
    })
    return Object.freeze(out)
  }
  return checkBakedTerminal(doc, 'root')
}

/** 终态缺陷列表 → 一条结构化错误（第一个缺陷；内核契约 §4.2 的 `InvalidValue`）。 */
export function terminalDefectError(doc: unknown): ReturnType<typeof invalidValue> | null {
  const defects = checkDocumentTerminal(doc)
  if (defects.length === 0) return null
  const first = defects[0]!
  return invalidValue({ reason: first.code, at: first.at, ...first.detail })
}

/** `Result` 形态：终态合格则 `ok(void)`，否则显式拒绝（**不夹取、不修剪**）。 */
export function requireBakedTerminal(doc: unknown): Result<null> {
  const e = terminalDefectError(doc)
  return e === null ? ok(null) : err(e)
}
