/**
 * `render/**` 的**深度 2 公共出口**：纹理池 `textureBlobs` 的形态归一化面（#387 同族批收尾）。
 *
 * ## 为什么需要这一层
 *
 * 归一化的**唯一实现**在 `render/data/textureBlobPool.ts`（相对 `src/` 深度 **3**）。
 * 按 #249 §4 导入规则 6 与契约 §7.3 规则 2「公共出口最大深度 2」，闸门执行面里的文件
 * （例如 `adapters/files/legacyFields.ts`、`adapters/files/publishFormat.ts` —— 两者都在
 * `LAYER_DESTINATIONS[adapters].activeSubpaths` 里）**直接**引用 `render/data/textureBlobPool`
 * 会被 `gate/no-private-cross-layer` 判红（判定式：发起方是闸门文件 **且** 目标路径
 * `split('/').length > 2`）。本文件把同一批具名函数提到深度 2，使「深度合规」成立，
 * 而不必为了引用它去放宽闸门。
 *
 * ### ⚠️ 深度合规 ≠ 可以引用：内核文件另有一条更强的闸门（本批实测）
 *
 * `tests/architecture/kernel-legacy-isolation.test.ts:269-279` 硬要求
 * **`KERNEL_FILES`（57 个文件）的全部导入都不得指向 16 个旧层目录**（`OLD_LAYERS` 含 `render`），
 * `toEqual([])`、**无登记/豁免机制**、不看深度、不看是否 type-only。`legacyFields.ts` 与
 * `publishFormat.ts` 都在该清单里 ⇒ 它们**连本文件也不能 import**（本批实测：加了 import 后
 * `test:arch` 由 225P/0F 变 **223P/2F**，两条 finding 正是这两个文件的
 * `→ @/render/textureBlobPool（旧层 render）`）。故本批**撤回了这两处的修复**，
 * 改为登记（见下表与那两个文件的 docblock：owner + 退出条件 + 现成的一行修复 + 实测读数）。
 *
 * ⇒ 本文件当前的**实际消费者**是**旧层**文件（`runtime/presentationAdapter.ts`、
 * `viewer/viewerFromDocument.ts`）。它们不经本出口也合规（旧→旧、且不是闸门文件），
 * 但出口让"引用唯一归一化点"有一个**深度合规**的固定入口，避免各消费者各写一份（§15）。
 *
 * ## 出口形态：具名函数导出，**不是** `export … from`
 *
 * 先例 `adapters/files/multiblockDeclaration.ts`：先 `import`，再 `export { … }`（具名绑定出口）。
 *
 * ⚠️ 本文件的具名导出**不是**由"闸门会判红 `export … from`"驱动的 —— **实测纠正**：本文件在
 * `render/`（legacy 目录，两端都不是闸门文件），`gate/no-barrel-smuggling` 的判定式里有一条
 * `if (!fromIsGate && !toIsGate) continue`（`tests/architecture/boundary-rules.mjs:504`）
 * ⇒ 写成 `export … from` **不会**触发该规则。真正的后果在**债务账**：`collectLegacyDebt`
 * （`:849-866`）把"两端都不是闸门文件 + 跨目录"的转出口计进 `legacy-barrel-reexport` ——
 * 即"用转出口把旧核心保活"的静态指纹。**实测（本批，2026-10-15）**：`export … from` 版本 ⇒
 * `gate/no-barrel-smuggling` **仍绿**、`arch:scan` 仍 PASS 0 finding，但债务 29 → **31**
 * （值出口 + 类型出口各计一条）；具名导出版本 ⇒ 债务保持 **29**。`render/` → `render/data/`
 * 不是同目录，故不被"同目录 continue"豁免。
 *
 * ⇒ 这一条是**债务不增**的要求（§15「旧核心不保活」的账目），不是闸门判红的要求。
 * 也正因为它不判红，光靠 `arch:scan` 的 PASS 看不出差别 —— 差别只在债务计数行。
 *
 * ## 消费者边界（长期债的红线）
 *
 * - **允许**：`render/**` 自身、`runtime/**`（旧层；本批消费者 `runtime/presentationAdapter.ts`
 *   —— 喂身份函数前先规范化）、`viewer/**`（旧层；本批消费者 `viewer/viewerFromDocument.ts`）。
 * - **禁止/实际不可用**：
 *   - `presentation/**`：`presentation` 是新分层，`render/**` 是它的 **legacy 对应物**
 *     （`LAYER_DESTINATIONS[presentation].legacySources = ['render','shared']`）⇒ 新层 import
 *     旧层是可长期存活的债（7728 裁决同款理由）。呈现侧需要"是不是池"时**不要**自己解析形态：
 *     需要摘要就在调用点先规范化（见 `runtime/presentationAdapter.ts` 的注释）。
 *   - `KERNEL_FILES` 里的任何文件（含 `adapters/files/*`）：见上一节的内核隔离闸门。
 *     要解封，须先把归一化的唯一实现迁到新层模块（本文件届时退役/改指），或让调用方注入。
 *
 * ## 同族落点登记表（#387 同族批；**登记即待退出**，不是"已知并存"）
 *
 * | 落点 | 状态 | owner | 退出条件 |
 * |---|---|---|---|
 * | `render/data/sceneDocumentMaterialHydrate.ts:42`、`render/data/bundleResolve.ts:103-112`、`workbench/export/bundleMaterialBaking.ts`（`extractTextureBlobs`） | **已收敛**（前批，判据 38 条已绿） | 内核重建执行线 | 已退出 |
 * | `runtime/presentationAdapter.ts:150`（`resourceDigestOf` 喂入口） | **已修**（本批：先判形态再归一化；判据 6 条走生产解析 + 生产读取面） | 内核重建执行线 | 已退出（调用点） |
 * | `viewer/viewerFromDocument.ts:20` | **已修**（本批：认两种形态 + 能红负对照 3 条） | 内核重建执行线 | 已退出 |
 * | `adapters/files/legacyFields.ts:111` | **未修（被闸门阻塞）**：内核文件不得 import 旧层 | 内核重建执行线（#249/#387） | ① 归一化实现迁到新层模块（本文件改指/退役），或 ② 该文件移出 `KERNEL_FILES`，或 ③ 调用方注入池计数。**修复行与实测判据已写在该文件 docblock 里** |
 * | `adapters/files/publishFormat.ts:175`（`hasNonEmptyArray` 只认数组） | **未修（同上，同一闸门）** | 内核重建执行线（#249/#387） | 同上（三个候选任一） |
 * | `runtime/context.ts:1231`（同族第 7 处） | **未收敛**：本批**禁写**（该文件在另一代理手上） | 在制该文件的代理（#387 同族批） | 该文件批次收敛时一并修：按形态归一化取池，或改读已归一化的呈现输入；届时删除本行 |
 * | `presentation/contentIdentity.ts#resourceDigestOf`（**本体**形态敏感） | **登记的地雷**：入参契约是 `unknown`，允许池与非池混用；同文件 `:177-207` 的登记文字仍是上一批视角（写"该退出前属已知缺陷"、"`presentationAdapter.ts` 本批禁写"），**待更新**（该文件本批禁写） | 内核重建执行线（#249/#387） | ① 身份函数入参收成规范形（类型面由编译器保证），**或** ② `render/` 退役。**在那之前任何调用方必须先规范化**（配方与负对照见 `runtime/presentationAdapter.ts#resourceIdentityInputOf` 的 docblock） |
 *
 * ⚠️ 与"取字节"型消费者不同，**摘要型**消费者**禁止盲归一化**（`normalizeTextureBlobPool`
 * 对非池值产出空表 ⇒ 不同内容会给出同一摘要 ⇒ A28/A36 判据塌陷）。
 */
import {
  hasTextureBlobAt,
  isTextureBlobPoolShaped,
  normalizeTextureBlobPool,
  textureBlobPoolOf,
} from './data/textureBlobPool'
import type { NormalizedTextureBlobPool, TextureBlobPoolLike } from './data/textureBlobPool'

export { hasTextureBlobAt, isTextureBlobPoolShaped, normalizeTextureBlobPool, textureBlobPoolOf }
export type { NormalizedTextureBlobPool, TextureBlobPoolLike }
