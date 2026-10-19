/**
 * `composition/contributedObjectTypes` —— **贡献类型 → 内核属性注册缝**（`#262` P11-F 段①；
 * A21 `extension-proof` 的属性写半边）。
 *
 * ## 它修的缺口（P11-E 实测，Lead 裁决 comment 6553 ①）
 *
 * P11-E 的实测读数是：`contributes.objectTypes` 能建对象（`ExecutionInputs.objectFactories`）、
 * 能被选中（`select` 类型无关）、能撤销（历史随文档），**但写不了属性** ——
 * `reduceCommand` 用的 `kernelPropertyRegistry()`/`kernelWritePorts()` 是**构造期固定**到
 * `KERNEL_OBJECT_TYPES`/`KERNEL_OBJECT_TYPE_IDS` 的实例，而贡献的类型描述
 * **没有通向它们的缝** ⇒ 贡献类型的属性写被结构性拒绝
 * （`MissingTarget: property-not-registered`）。A21 是 #249 的**扩展性证明**，
 * "能注册类型却结构性写不了属性"= 扩展性骨架半残。
 *
 * ## 缝的形态（为什么是"装配期派生 + 显式输入"而不是"写进全局注册表"）
 *
 * 本模块是**纯派生**：装配结果（`Assembly.contributions.objectTypes`）→ 内核声明清单，
 * 后者经 `ExecutionInputs.contributedObjectTypes` 进入 `reduceCommand` 使用的注册表与写端口
 * （`kernelPropertyRegistry(contributed)` / `kernelWritePorts(contributed)`）。于是：
 *
 * | 约束（Lead 裁决） | 本形态如何满足 |
 * |---|---|
 * | 唯一更新入口 `reduceCommand` 不动（GF-5） | 只多喂一个**输入**；属性写仍只经 `reduceSetProperty` → `applySetProperty` |
 * | 不引入第二写通路 | 贡献类型与内置类型共用**同一个** `PropertyWriteHandler`（同一份属性词汇） |
 * | 不改既有类型行为 | 缺省（无贡献）时 `reduceCommand` 走的那两个单例**逐字不变** |
 * | 不依赖可变全局（#249 §2.1） | 声明清单是值，经输入传递；注册表是**按清单身份缓存**的派生实例，不是可变权威 |
 *
 * ⚠️ 为什么**不**选"装配期把贡献并进 `kernelPropertyRegistry()` 单例"：那会让
 * `reduceCommand` 依赖可变全局（与 `ExecutionInputs` 的 A02 纯性保证冲突），且
 * `freeze-convergence.test.ts` 的既有判据「注册表的 `objectTypes()` 必须等于
 * `domain/scene` 的类型集」会在任何触发过装配注册的进程里判红。两处说明见
 * `application/kernel-properties`。
 *
 * ## 不静默：缺声明的贡献类型不会被"顺手猜一个"
 *
 * 贡献项**没有** `rna` 时本函数跳过它（= 该类型由内核自己的 `KERNEL_OBJECT_TYPES` 描述，
 * 例如 `block`/`annotation`/`camera`）。于是"贡献了一个新类型却忘了给声明"的表现是
 * **属性写被拒且原因明确**（`MissingTarget: property-not-registered`，
 * 与未注册类型同一语义）—— 而不是被猜出一份错描述。
 */

import type { ObjectTypeDecl } from '@/application/properties'
import type { Assembly } from './resolver'

/**
 * 装配结果里**带 RNA 声明**的对象类型贡献 → 内核对象类型声明清单。
 *
 * 顺序取装配结果的顺序（`resolveComposition` 已按 `类型@模块` 稳定排序 ⇒
 * 同一装配多次派生得到**逐位相同**的数组内容与顺序）。返回的数组被冻结，
 * 且**同一次装配调用返回同一个数组引用**吗？—— 不保证；需要身份稳定的调用方
 * （如 `KernelSessionOptions.contributedObjectTypes`）应当只派生一次并复用。
 */
export function objectTypeDeclarationsOf(assembly: Assembly): readonly ObjectTypeDecl[] {
  const out: ObjectTypeDecl[] = []
  for (const x of assembly.contributions.objectTypes) {
    const decl = x.contribution.rna
    if (decl !== undefined) out.push(decl)
  }
  return Object.freeze(out)
}

/**
 * 贡献声明与它的 `type` 字段是否自洽（`rna.id` 必须等于 `contribution.type`）。
 *
 * ## 为什么需要这条校验（而不是"取其中一个就行"）
 *
 * `contribution.type` 是**装配面**的类型 id（`contributes.objectTypes[].type`，
 * 供 `dataKind`/`editable` 查询与 `DEFAULT_TYPES` 对账使用），`rna.id` 是**RNA 面**的
 * objectTypeId（限定式属性 ID 的第一段）。两者若不一致，就会出现
 * 「按 A 类型建对象、属性 ID 却写成 B 类型」的静默错配（写面按 `rna.id` 解析，
 * 而对象 `type` 是 A ⇒ 描述符存在但落不到任何对象上）。
 *
 * 返回不一致项（`{ moduleId, type, rnaId }`）；空数组 = 自洽。
 * 调用方（装配）据此显式失败，不静默取其一。
 */
export function inconsistentObjectTypeDeclarations(
  assembly: Assembly,
): readonly { readonly moduleId: string; readonly type: string; readonly rnaId: string }[] {
  const bad: { moduleId: string; type: string; rnaId: string }[] = []
  for (const x of assembly.contributions.objectTypes) {
    const decl = x.contribution.rna
    if (decl === undefined) continue
    if (decl.id !== x.contribution.type) bad.push({ moduleId: x.moduleId, type: x.contribution.type, rnaId: decl.id })
  }
  return Object.freeze(bad)
}
