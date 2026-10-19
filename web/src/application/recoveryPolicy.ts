/**
 * `application/recoveryPolicy` —— **恢复副本的写入/保留策略常量与纯规划**（M8-4）。
 *
 * ## 本模块存在的理由（把 Q2 暂定默认从逻辑深处提出来）
 *
 * SPEC §9 只钉语义（恢复副本与正式保存分开记录、写入不改变基线、采纳是显式操作、
 * 损坏副本与存储失败不得破坏当前有效内容），**不钉**"多久写一次"与"保留几份"。
 * 后者是产品策略，来自调度者的 Q2 暂定默认：
 *
 * | 策略 | 暂定默认 | 常量 |
 * |---|---|---|
 * | 写触发 | 编辑提交后**防抖**自动写（本模块只给窗口；接线在 `composition/recoverySession`） | {@link RECOVERY_WRITE_DEBOUNCE_MS} |
 * | 保留 | **每文档最近 3 份**（最新 1 份 + 历史 2 份） | {@link RECOVERY_RETENTION_LIMIT} |
 *
 * 两者都是**策略点**：验收对齐后改常量即可，不需要动写入/采纳的判定。
 *
 * ## 为什么"每文档"在实现里表现为"每个文档身份一个键族"
 *
 * 恢复副本键（`application/recovery#recoveryStoreKey`）的形态已被判据钉死：
 * `lk.recovery.v1.<scope>.<instanceId>.<documentId>`。一个键只能装一份载荷，
 * 故"最近 3 份"由**同一键族的历史槽**表达：rank 0 = 规范键（最新），
 * rank 1..N-1 = `<规范键>~r<rank>`。
 *
 * `~r` 后缀**不**改变 `parseRecoveryStoreKey` 的判定（它仍把这族键识别为
 * `recovery-copy`，只是 `documentId` 段带上后缀）—— 分类器/GC/诊断因此不需要
 * 第二套键格式；读取侧用 {@link recoveryBaseKeyOf} 还原文档身份。
 *
 * ## 为什么旋转是**纯规划**（不在这里碰存储）
 *
 * 写入顺序（先写最新、后挪历史）与"配额不足时不得破坏现有副本"都是可判定的
 * 行为；把它们写成 `(previous, next) => writes` 的纯函数，才能用单测钉住
 * "3 份上限"与"内容未变不重复写"两条，而不必伪造一个存储。
 */

/** 每文档保留的恢复副本份数上限（Q2 暂定默认：最近 3 份）。 */
export const RECOVERY_RETENTION_LIMIT = 3

/**
 * 编辑提交后自动写恢复副本的**防抖**窗口（毫秒）。
 *
 * ## 取值依据（不是随手挑的）
 *
 * - 判据 S5 的读数点：一次真实字段编辑提交后约 1.2 s（`saveReopen#writeField`
 *   的 Tab + 500 ms + blur + 700 ms）就会触发页面刷新。窗口必须小于它，
 *   否则"编辑后刷新"在判据里根本来不及写副本；
 * - 窗口同时要**合并连续编辑**（拖动/逐格输入）—— 单次写入是整份文档载荷
 *   （夹具约 1.3 MB），逐次同步写会让编辑明显卡顿；
 * - 关闭/刷新还有 pagehide 的**同步冲刷**（`composition/recoverySession`），
 *   故窗口不是"最后一道保险"：正常关闭不会丢掉窗口内的编辑。
 *
 * 400 ms 是本批的取舍点；Q2 的"2 s 左右"是建议值，验收对齐后改本常量即可。
 */
export const RECOVERY_WRITE_DEBOUNCE_MS = 400

/** 历史槽的键后缀分隔符（`<规范键>~r<rank>`）。 */
export const RECOVERY_HISTORY_MARKER = '~r'

/** 规范键（rank 0）或历史槽键（rank ≥ 1）。 */
export function recoveryRetainedKey(baseKey: string, rank: number): string {
  if (!Number.isInteger(rank) || rank < 0) throw new Error('recoveryRetainedKey: rank 必须是非负整数')
  return rank === 0 ? baseKey : `${baseKey}${RECOVERY_HISTORY_MARKER}${rank}`
}

/** 该文档身份下的全部保留槽键（rank 0..limit-1；用于"保存后作废/用户放弃"）。 */
export function recoveryRetainedKeys(baseKey: string, limit: number = RECOVERY_RETENTION_LIMIT): readonly string[] {
  const out: string[] = []
  for (let rank = 0; rank < Math.max(1, Math.trunc(limit)); rank += 1) out.push(recoveryRetainedKey(baseKey, rank))
  return Object.freeze(out)
}

/** 从任一保留槽键还原**文档身份的规范键**（非本族后缀原样返回）。 */
export function recoveryBaseKeyOf(key: string): string {
  const at = key.lastIndexOf(RECOVERY_HISTORY_MARKER)
  if (at < 0) return key
  const tail = key.slice(at + RECOVERY_HISTORY_MARKER.length)
  if (!/^\d+$/.test(tail)) return key
  return key.slice(0, at)
}

/** 该键的保留 rank（规范键 = 0；非本族后缀 = 0）。 */
export function recoveryRankOf(key: string): number {
  const base = recoveryBaseKeyOf(key)
  if (base === key) return 0
  const tail = key.slice(base.length + RECOVERY_HISTORY_MARKER.length)
  return Number(tail)
}

/** 一次保留规划里要写的槽（按写入顺序）。 */
export interface RecoveryRetentionWrite {
  readonly key: string
  readonly raw: string
}

export interface RecoveryRetentionPlan {
  /** 内容与现有最新副本相同 ⇒ 不写（避免每次编辑都重写同一份 1.3 MB 载荷）。 */
  readonly unchanged: boolean
  /**
   * 要写的槽，**规范键在前**。
   *
   * 顺序是语义的一部分：最新副本先落地，历史槽随后移动。于是"历史槽写失败"
   * 不会让用户失去**最新**副本（配额不足时最坏结果是历史变短，而不是最新丢失）。
   */
  readonly writes: readonly RecoveryRetentionWrite[]
}

/**
 * 规划一次"保留 N 份"的写入（**纯**）。
 *
 * @param baseKey 规范键（`recoveryStoreKey` 的产物）
 * @param previous 现有槽的原文，下标 = rank（0 = 规范键；缺省/null = 空槽）
 * @param nextRaw 本次要写的最新载荷（`serializeRecoveryCopy` 的产物）
 */
export function planRecoveryRetention(
  baseKey: string,
  previous: readonly (string | null)[],
  nextRaw: string,
  limit: number = RECOVERY_RETENTION_LIMIT,
): RecoveryRetentionPlan {
  const keep = Math.max(1, Math.trunc(limit))
  if (previous[0] === nextRaw) return Object.freeze({ unchanged: true, writes: Object.freeze([]) })
  const writes: RecoveryRetentionWrite[] = [Object.freeze({ key: recoveryRetainedKey(baseKey, 0), raw: nextRaw })]
  for (let rank = 1; rank < keep; rank += 1) {
    const raw = previous[rank - 1]
    if (typeof raw === 'string') writes.push(Object.freeze({ key: recoveryRetainedKey(baseKey, rank), raw }))
  }
  return Object.freeze({ unchanged: false, writes: Object.freeze(writes) })
}
