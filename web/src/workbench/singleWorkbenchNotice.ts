/**
 * **同页只允许一个工作台**的用户可见提示（M7-6 / M7-0 Q3 裁决）。
 *
 * ## 结构禁止不变，改的只是"怎么说"
 *
 * `adapters/inputBinding#claimExclusive` 是进程级独占：document keydown 只许挂一条
 * （A22「两个 handler 各启动操作」的结构防御）。第二个工作台实例装配时**仍然**不许挂
 * —— 本文件不放松那条结构，也不提供"降级成一个没键盘的工作台"的产品语义。
 *
 * 旧形态的问题是**人读不了**：抛出的是一句带内部符号名的英文/混排诊断
 * （`[inputBinding] document keydown 已被 workbench 持有；workbench 不得再挂第二条`），
 * 而它出现在一个 `onMounted` 的异步回调里 ⇒ 用户看到的是"第二个工作台白屏/半死"，
 * 没有任何解释。Q3 的裁决是：**保持结构禁止、把报错改成一句人话**。
 *
 * ## 为什么文案单独一处
 *
 * 判据要**逐字**钉这句话（宽松匹配会让文案漂移静默通过）。文案与判据的单一真源
 * 在这里，e2e 从页面读它渲染出的文本，不复制一份常量去比对。
 */

/**
 * 第二个工作台实例的提示文案（**定稿**；改这句必须同批改
 * `e2e/kernel-workbench-single-instance.spec.ts` 的逐字断言）。
 */
export const SINGLE_WORKBENCH_NOTICE =
  '已有一个工作台实例在运行：本页只能运行一个工作台，当前实例的键盘快捷键未启用。'

/** 提示的 DOM 标记（判据读它；与文案分离，改文案不动选择器）。 */
export const SINGLE_WORKBENCH_NOTICE_ATTR = 'data-lk-workbench-conflict'
