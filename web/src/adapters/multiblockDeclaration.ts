/**
 * `adapters/multiblockDeclaration` —— **适配器层对"多方块声明 → 内核承载"的公共出口**（深度 2）。
 *
 * ## 为什么需要它（与 `adapters/projectFile.ts` 同一处境，不是新造形态）
 *
 * 实现在 `adapters/files/multiblockDeclaration.ts` —— 它与该目录的 `plainCodec` /
 * `envelopeCodec` / `projectFormat` / `publishFormat` / `documentBinding` **同族**
 * （都是"外部文件格式 → 内核"的边界编解码/转换），按职责属 `adapters/files/`。
 * 而「**公共出口最大深度 2**」：`composition/**` 的新实现
 * **不得**直接 import 深度 3 的 `adapters/files/*`（闸门 `gate/no-private-cross-layer`
 * 逐条判定，类型导入同计）。
 *
 * ⇒ 本文件就是那个出口：**实现留在 `files/`（族内），出口在深度 2**。
 * 先例：`adapters/projectFile.ts` 对 `files/projectFormat`、`adapters/plainRoot.ts`
 * 对 `files/envelopeCodec` + `files/plainCodec` 做的是同一件事 —— 本次是第三个。
 * 首次接线时 `composition/kernelAssembly.ts` 直接 import 了深度 3 的实现，
 * `arch:scan` **当场判红 1 条**（`gate/no-private-cross-layer`，
 * `src/composition/kernelAssembly.ts:83`：`adapters/files/multiblockDeclaration`，
 * 深度 3 > 2）—— 该红正是这条规则的用途：**接线必须经公共出口**。
 *
 * ## ⚠️ 为什么这里定义**函数**而不是 `export … from`
 *
 * 先例实测（`projectFile.ts` 文件头第 18-25 行）：纯 `export … from` 转出口会被
 * `gate/no-barrel-smuggling` 判红（跨目录 `export-from` 未登记在 `APPROVED_BARRELS`）。
 * ⇒ 出口必须**自己定义**该层对外承诺的操作；类型用 `export type { … }`（本地再出口，
 * 不是 `export type { … } from '…'`，后者同样是 `ExportDeclaration`）。
 *
 * ## 出口承诺的是**内容面 / 承运面**两个值
 *
 * 上层（装配）需要两件事：①「已解析声明 → `DocumentContent.multiblock` 的承载值」
 * （`multiblockDeclarationContentOf`）；②「已解析结果 → **内核面 body 承运**」
 * （`multiblockBodyContentOf` —— 让多方块再装配不再需要 `RuntimeDocument`）。
 * 承载的**形状与不变量**（`decl` 摊平、去 `raw`、逐层冻结、调色板**保序等长**、
 * 取证通道不进声明）由 `files/` 的实现族与它的判据负责：
 * `adapters/files/__tests__/multiblockDeclarationFrozen.test.ts`。
 * 未承载字段（帧声明 `cellGrid` 等）的**诊断**留在 `MultiblockAdapterResult` 上，
 * 出口不吞掉它 —— 需要诊断的调用方走 `files/` 的完整结果。
 */

import type { MultiblockBody, MultiblockDeclaration } from '@/domain/multiblockDocument'
import {
  multiblockBodyOf,
  multiblockDeclarationOf,
  type MultiblockAdapterDiagnostic,
  type MultiblockAdapterDiagnosticCode,
  type MultiblockAdapterResult,
  type MultiblockBodyResult,
  type ParsedMultiblockDocument,
} from './files/multiblockDeclaration'

export type {
  MultiblockAdapterDiagnostic,
  MultiblockAdapterDiagnosticCode,
  MultiblockAdapterResult,
  MultiblockBodyResult,
  MultiblockBody,
  ParsedMultiblockDocument,
}

/**
 * **内容权威入口**：已解析的多方块声明 → `DocumentContent.multiblock` 的承载值。
 *
 * @param parsed 旧解析器的产出（`RuntimeDocument.multiblock`）——**真实解析结果**，
 *               不是投影面/旁挂面；`null` / `undefined` ⇒ 显式空声明
 *               （`EMPTY_MULTIBLOCK_DECLARATION`，「无」在类型上只有一个值）。
 *
 * 与 `files/` 里的 `multiblockDeclarationOf` 的差别**只在返回面**：这里只给承载值，
 * 因为装配需要的就是这一个值；诊断的消费者是"要报未承载字段"的调用方。
 */
export function multiblockDeclarationContentOf(
  parsed: ParsedMultiblockDocument | null | undefined,
): MultiblockDeclaration {
  return multiblockDeclarationOf(parsed).declaration
}

/**
 * **承运入口（内核面 body）**：已解析的多方块文档 → 内层 body 的**内核承载**。
 *
 * 与 {@link multiblockDeclarationContentOf} 的分工：那个只给**声明**（内容权威那一半），
 * 本函数给**承运**（声明 + 逐帧参考网格的取证通道），供
 * `composition/kernelAssembly#assembleMultiblockKernelFace` 使用 ——
 * 那是"多方块再装配不再需要 `RuntimeDocument`"的入口。
 *
 * 诊断（`FrameCellGridNotCarried` 等）的消费者仍走 `files/` 的完整结果
 * （{@link MultiblockBodyResult}），出口不吞掉它。
 */
export function multiblockBodyContentOf(
  parsed: ParsedMultiblockDocument | null | undefined,
): MultiblockBody {
  return multiblockBodyOf(parsed).body
}
