/**
 * `application/captureInput` —— **导出捕获输入的归一政策**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 时间的唯一归一入口挂在**旧烘焙链**的文件上 | `workbench/exportIsometricImage#normalizeIsoSeconds`（已删除） | 归一到 `application/`（纯层）：它描述的是"用户输入的秒怎么进请求"，不是烘焙细节 |
 *
 * ## 为什么归到 `application/` 而不是 `operators/`
 *
 * 同一份政策现在有两个入口在用：导出命令（`operators/builtin/exportOperators`）与导出卡片的
 * 预览（`workbench/components/ExportWorkspace.vue`）。挂在任一调用方都会让另一个"照着抄一遍"，
 * 而两份归一政策漂移的表现是"预览接受、下载拒绝"（或反之）—— 正是要避免的形态。
 *
 * ## 政策本身（逐字保留旧入口的语义）
 *
 * - 缺省（`undefined`）= **0 秒**，与改造前"帧偏移 0"逐位一致；
 * - 非有限数 / 非 number ⇒ **抛**，不静默当 0（把"写了 NaN"伪装成"t=0"正是要防的）；
 * - 负数**允许**：采样器对负时间取模（`domain/materials#sampleTextureSequence`），
 *   钳制它会制造第二种语义。
 *
 * ## 纯度
 *
 * 纯函数、无 IO/时钟/DOM/Three（`application/` 属 `corePurity` 执行面）。
 */

/**
 * 导出时间的**唯一**归一入口（导出时间可固定、可重现）。
 *
 * @throws 时间为非有限数或非 number（不把非法值伪装成 t=0）
 */
export function normalizeIsoSeconds(raw: unknown): number {
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('等轴导出的时间不是有限数：' + String(raw))
  }
  return raw
}
