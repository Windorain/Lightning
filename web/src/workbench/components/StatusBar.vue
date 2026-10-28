<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态 + Wiki 绑定
 */
import { computed, ref, watch } from 'vue'
import { LOG_LEVEL } from '@/logging/LogCenter'
import { useContext } from '@/runtime/context'
import { useShell } from '@/composition/shell'
import { CAPABILITY } from '@/composition/modules'
import { buildWikiDataPageUrl, displayNameFromLocator } from '@/wiki/wikiUrls'
import { wikiRemoteDirtyOf } from '@/wiki/wikiRemoteDirty'
import { diagnosticSeverityOf } from '@/runtime/diagnosticProjection'

const ctx = useContext()
const shell = useShell()
const log = ctx.log
/** 本实例的翻译（消费本实例语言，无模块级全局读源）。 */
const t = ctx.t

// 帧数走**唯一读取面** `ctx.frameDeclarations()`，
// 与 `composition/useKernelFrameLoop` 的 FrameSource **同一个函数**。
//
// ## 为什么原来那行是一个真实缺陷（不是"风格问题"）
//
// 原写法 `ctx.getDoc().value?.frameCount ?? 0` 直读 legacy，而帧循环读内核 ——
// 装配失败时内核是**空文档**⇒ 帧循环报 0，状态栏报 N ⇒ **同一时刻两个读数不一致**。
// 那是诊断一致性要防的形态（用户看到"帧 0"但状态栏说"共 432 帧"）。
//
// 收敛后两侧必然一致：装配成功 ⇒ 都用内核帧轴；否则 ⇒ 都用 legacy。
// ⚠️ 该读面**不经** `getDoc()`，故本行的旧符号一并消失。
const frameCount = computed(() => ctx.frameDeclarations().count)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

// 旧实现是 `isWikiHostProfile()`（组件在问宿主名 —— 禁止的形态）。
// 现在问**能力**：只有装配了 Wiki 上传的外壳才显示 Wiki 绑定行。
const wikiHost = computed(() => shell.has(CAPABILITY.WIKI_UPLOAD))
const binding = computed(() => ctx.getDocumentBinding().value)
const wikiName = computed(() =>
  binding.value.sourceId === 'wiki-data' && binding.value.locator
    ? displayNameFromLocator(binding.value.locator)
    : null,
)
/**
 * 「· 未保存」= **Wiki 远端落后于当前完整产物**（不是"摘要字段有变化"）。
 *
 * 旧实现用 `buildWikiEditSummaryDraft`（少数字段）+ `kernelDirty()`：本地保存后
 * 内核已干净，而只改过 `cellGrid` 又不在摘要字段表里 ⇒ 明明 Wiki 页陈旧却无提示。
 * 现在与保存门/丢弃确认共用同一条全量判据（`wiki/wikiRemoteDirty`）。
 * 仍是 computed：`plainForSave()` 的响应式依赖只在内容变更时重算，不新增渲染循环求值。
 */
const wikiDirty = computed(() => wikiRemoteDirtyOf(ctx))

/**
 * **实时状态槽**：资源生命周期（纹理五态）的唯一用户可见写面。
 *
 * ## 为什么必须**排在** `lastDisplayable` 之前且能占住主位
 *
 * `lastDisplayable` 一旦被任一非 DEBUG 日志写过就再无代码清（`LogCenter.clear()` 全树零调用）
 * ⇒ 载入期它恒为「初始化视口相机 → FINISHED」，把"正在加载 3/57"这类真实进展**永久遮蔽**
 * （零反馈就是这么来的）。故实时状态有两条特权：
 *  1. 渲染在最前（同一行左侧）；
 *  2. 处于 `loading` 时**顶替**最后一条日志的位置（陈旧日志不得压过"此刻在干什么"）。
 * 非 `loading` 时两者并存：终态是可查询事实，不该赶走操作反馈。
 */
const live = computed(() => log.liveStatus.value)
/** 加载中：实时状态占主位（见上）。 */
const showLastLog = computed(() => log.lastDisplayable.value !== null && live.value?.state !== 'loading')

/**
 * 粘性「loading 曾被观察到」标记（e2e 反假绿用）。
 *
 * 只暴露**当前**状态是不够的：终态一旦落地，`data-texture-state` 就变成 `ready`/`missing`，
 * 判据无法区分"真的经历了加载"与"压根没写过加载态"（后者正是原缺陷）。
 * 故首次进入 `loading` 后本标记保持，供 `data-texture-loading-seen` 读面断言。
 */
const loadingSeen = ref(false)
watch(
  () => live.value?.state,
  (state) => {
    if (state === 'loading') loadingSeen.value = true
  },
)

/**
 * **悬停格读数**：编辑器视口的悬停信息落在**固定位**（底栏）。
 *
 * 数据源是唯一读面 `ctx.getHoveredBlock()`（`runtime/hover/access`：本 region 的
 * `viewportBlock` 经 `blockRefFromViewportHover` 换成内核世界坐标的 `BlockRef`）——
 * 与右栏「方块检查器」无选中时的回落读的是**同一个**读面，两处不会分叉。
 * 悬浮 ToolTipBox 已从编辑器视口撤除（见 `WorkbenchViewport` 的注释）。
 */
const hoveredBlock = computed(() => ctx.getHoveredBlock().value)

/**
 * **恢复副本**（SPEC §9:299）的常驻提示与显式入口。
 *
 * 为什么不只靠 `liveStatus`：纹理链在编辑后会写 `loading/ready`，按"更晚的事实胜"
 * 的既有口径会把"有一份可采纳副本"顶掉。候选/损坏数是**状态**（不是一次性事件），
 * 故由状态栏常驻一行渲染；`liveStatus` 只负责"刚刚检测/采纳/放弃/写入失败"那一句。
 */
const recoveryCandidate = computed(() => ctx.getRecoverySession()?.candidate.value ?? null)
const recoveryCorrupt = computed(() => ctx.getRecoverySession()?.corruptCount.value ?? 0)

/**
 * **诊断列表**（暂定默认）：底栏常驻区 + 可点开的列表。
 *
 * ## 数据源是**生产读面**，不是特权读面
 *
 * `ctx.getDiagnostics()` 是 `DiagnosticsReadView`（只有查询方法；e2e 经 `__vm__` 拿到的是
 * **同一个**对象）。本组件不读 `__vm__`、不读日志缓冲、不读诊断记录器的写面 ——
 * 于是"用户看到的诊断"与"判据读到的诊断"是**同一份数据**，不可能分叉。
 *
 * ## 为什么用 `wm.diagnosticEpoch` 而不是把记录器变成响应式
 *
 * 记录器是纯对象（`application/diagnostics` 不依赖 Vue），它**不该**为了 UI 变成响应式
 * 状态（那会让"记录一条诊断"变成"触发一次渲染"）。`diagnosticEpoch` 只在记录落地后 +1，
 * 用作失效通知；数据仍然现读。
 *
 * ## 为什么是"常驻区 + 可点开列表"而不是面板/弹窗
 *
 * 暂定默认：不弹窗、不造新面板。有诊断时底栏显示条数与最高级别，
 * 点开是列表；空态**不显示**（"0 条诊断"不是信息，是噪声）。
 */
const diagnosticsOpen = ref(false)
const diagnosticsEpoch = computed(() => ctx.wm.diagnosticEpoch.value)
interface DiagnosticRow {
  readonly seq: number
  readonly code: string
  readonly channel: string
  readonly time: string
  readonly object: string
}
/**
 * 当前有效诊断（**新→旧**；有界 = 记录器容量 512 —— 复用同一口径，不另立上限）。
 *
 * 排序取 `seq` 降序：最新的一条在列表顶。行内"对象"取最贴近用户的那个名字：
 * `params.locator` → `params.assetId` → `correlation.objectId` → `correlation.viewportId`。
 */
const diagnosticRows = computed<DiagnosticRow[]>(() => {
  void diagnosticsEpoch.value
  const records = ctx.getDiagnostics().snapshot()
  const out: DiagnosticRow[] = []
  for (const r of records) {
    // 只收**需要用户知道**的（WARN/ERROR）：info 级逐条事件（装配汇总/呈现版本/句柄获取）
    // 是"过程"，常驻显示会把底栏变成心跳计数器。它们仍可从 `getDiagnostics()` 与
    // `__log__` 读到 —— 用户面与机读面的差别只在**采样**，不在数据。
    if (diagnosticSeverityOf(r.code) === 'info') continue
    const params = r.params as Record<string, string | number | boolean>
    const pick = (k: string): string => (typeof params[k] === 'string' ? String(params[k]) : '')
    const where =
      pick('locator') ||
      pick('assetId') ||
      pick('property') ||
      pick('operator') ||
      r.correlation.objectId ||
      r.correlation.viewportId ||
      pick('documentId') ||
      ''
    const d = new Date(r.at)
    const time = Number.isNaN(d.getTime())
      ? String(r.at)
      : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    out.push({ seq: r.seq, code: r.code, channel: r.channel, time, object: where })
  }
  out.sort((a, b) => b.seq - a.seq)
  return out
})
const diagnosticCount = computed(() => diagnosticRows.value.length)
/** 最高级别（只用于底栏那个小圆点的颜色；级别由投影表给出，见 `diagnosticProjection`）。 */
/** 最高级别（底栏那个小圆点的颜色）—— 与日志级别**同一个**映射函数。 */
const diagnosticLevel = computed<'error' | 'warn' | 'info'>(() => {
  for (const r of diagnosticRows.value) {
    const severity = diagnosticSeverityOf(r.code as never)
    if (severity === 'error') return 'error'
    if (severity === 'warn') return 'warn'
  }
  return 'info'
})
function toggleDiagnostics(): void {
  diagnosticsOpen.value = !diagnosticsOpen.value
}

function recoveryTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

/**
 * **资源失败重试入口**。
 *
 * 只在"当前实时状态是资源终态失败"时出现 —— 它是那条点名文案旁边的**动作**，
 * 而不是一个常驻按钮（常驻会让人以为"总能重试出别的东西"，而内嵌字节重解不会变好；
 * 见 `operators/builtin/resourceOperators` 的二选一论证）。
 *
 * 判据取 `live.origin === 'texture'` + 终态：不猜文本、不看计数（同一状态机）。
 */
const canRetryResources = computed(() => {
  const l = live.value
  return l !== null && l.origin === 'texture' && (l.state === 'missing' || l.state === 'failed')
})

function retryResources(): void {
  void ctx.getOperators().exec('OPERATOR_RETRY_RESOURCES')
}

function adoptRecovery(): void {
  void ctx.getOperators().exec('OPERATOR_RECOVERY_ADOPT')
}

function discardRecovery(): void {
  void ctx.getOperators().exec('OPERATOR_RECOVERY_DISCARD')
}

function logClass(level: number): string {
  if (level & LOG_LEVEL.ERROR) return 'sb-item sb-item--error'
  if (level & LOG_LEVEL.WARN) return 'sb-item sb-item--warn'
  return 'sb-item'
}

function openWikiDataPage() {
  if (!binding.value.locator) return
  window.open(buildWikiDataPageUrl(binding.value.locator), '_blank', 'noopener')
}
</script>

<template>
  <div
    class="sb-root"
    :data-texture-state="live ? live.state : undefined"
    :data-texture-loading-seen="loadingSeen ? '1' : undefined"
  >
    <span
      v-if="live"
      :class="logClass(live.level)"
      :data-live-status="live.state"
      :data-live-origin="live.origin ?? undefined"
    >
      {{ live.message }}
      <button
        v-if="canRetryResources"
        class="sb-recovery-btn"
        data-lk-resource-retry
        type="button"
        title="对未就绪的纹理资源发起一次新请求（画面保留，成功后占位恢复）"
        @click="retryResources"
      >重试</button>
    </span>
    <span v-if="showLastLog && log.lastDisplayable.value" :class="logClass(log.lastDisplayable.value.level)">
      {{ log.lastDisplayable.value.message }}
    </span>
    <span v-if="log.statusMessage && !log.lastDisplayable.value" class="sb-item">{{ log.statusMessage }}</span>
    <span v-if="hoveredBlock" class="sb-item" data-hovered-cell>
      {{ t('hover') }} {{ hoveredBlock.pos.x }}, {{ hoveredBlock.pos.y }}, {{ hoveredBlock.pos.z }}
    </span>
    <span
      v-if="recoveryCandidate"
      class="sb-item sb-item--recovery"
      data-lk-recovery="available"
      :title="'恢复副本（未采纳）：' + (recoveryCandidate.label || recoveryCandidate.documentId)"
    >
      恢复副本可选（{{ recoveryTime(recoveryCandidate.writtenAt) }}）
      <button class="sb-recovery-btn" data-lk-recovery-adopt type="button" @click="adoptRecovery">采纳</button>
      <button class="sb-recovery-btn" data-lk-recovery-discard type="button" @click="discardRecovery">放弃</button>
    </span>
    <span
      v-else-if="recoveryCorrupt > 0"
      class="sb-item sb-item--warn"
      data-lk-recovery="corrupt"
    >
      损坏的恢复副本 {{ recoveryCorrupt }} 份（当前内容未受影响）
      <button class="sb-recovery-btn" data-lk-recovery-discard type="button" @click="discardRecovery">放弃</button>
    </span>
    <span v-if="wikiHost && wikiName" class="sb-item sb-item--link" @click="openWikiDataPage">
      {{ t('wikiStructure') }}: {{ wikiName }}
      <span v-if="wikiDirty" class="sb-unsaved"> · {{ t('unsaved') }}</span>
    </span>
    <!--
      **诊断常驻区**：有诊断时才出现，点开是列表。
      空态不显示（`v-if` 在计数 > 0）；不弹窗、不占新面板。
    -->
    <span v-if="diagnosticCount > 0" class="sb-diagnostics" data-lk-diagnostics-root>
      <button
        class="sb-diag-btn"
        :class="'sb-diag-btn--' + diagnosticLevel"
        data-lk-diagnostics
        type="button"
        :aria-expanded="diagnosticsOpen ? 'true' : 'false'"
        :title="'诊断 ' + diagnosticCount + ' 条（点开查看码 / 对象 / 时间 / 通道）'"
        @click="toggleDiagnostics"
      >
        <span class="sb-diag-dot" />诊断 {{ diagnosticCount }}
      </button>
      <ul v-if="diagnosticsOpen" class="sb-diag-list" data-lk-diagnostics-list>
        <li
          v-for="row in diagnosticRows"
          :key="row.seq"
          class="sb-diag-row"
          data-lk-diagnostic-row
          :data-diag-code="row.code"
          :data-diag-channel="row.channel"
        >
          <code class="sb-diag-code" data-lk-diag-code>{{ row.code }}</code>
          <span class="sb-diag-object" data-lk-diag-object>{{ row.object }}</span>
          <span class="sb-diag-time" data-lk-diag-time>{{ row.time }}</span>
          <span class="sb-diag-channel">{{ row.channel }}</span>
        </li>
      </ul>
    </span>
    <span class="sb-spacer" />
    <span v-if="hasWorldMultiFrame" class="sb-item">
      Frame {{ (ctx.getFrameIndex()) + 1 }} / {{ frameCount }}
    </span>
  </div>
</template>

<style scoped>
.sb-root {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 14px;
  color: var(--wb-text-muted);
}
.sb-item { white-space: nowrap; font-size: 10px; }
.sb-item--link { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.sb-item--link:hover { color: var(--wb-text); }
.sb-unsaved { color: var(--wb-warn); }
.sb-item--recovery { color: var(--wb-accent, #7fb3ff); }
.sb-recovery-btn {
  margin-left: 6px;
  padding: 0 5px;
  font-size: 10px;
  line-height: 14px;
  color: var(--wb-text);
  background: transparent;
  border: 1px solid var(--wb-border, #555);
  border-radius: 3px;
  cursor: pointer;
}
.sb-recovery-btn:hover { background: var(--wb-hover, rgba(255, 255, 255, 0.12)); }
.sb-item--error { color: var(--wb-danger); }
.sb-item--warn { color: var(--wb-warn); }
.sb-spacer { flex: 1; }
.sb-diagnostics { position: relative; }
.sb-diag-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  font-size: 10px;
  line-height: 14px;
  color: var(--wb-text);
  background: transparent;
  border: 1px solid var(--wb-border, #555);
  border-radius: 3px;
  cursor: pointer;
}
.sb-diag-btn:hover { background: var(--wb-hover, rgba(255, 255, 255, 0.12)); }
.sb-diag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-text-muted, #999);
}
.sb-diag-btn--error .sb-diag-dot { background: var(--wb-danger, #ff6b6b); }
.sb-diag-btn--warn .sb-diag-dot { background: var(--wb-warn, #ffb86b); }
.sb-diag-list {
  position: absolute;
  bottom: 18px;
  left: 0;
  z-index: 20;
  max-height: 40vh;
  min-width: 320px;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--wb-bg-surface, #1b1f24);
  border: 1px solid var(--wb-border, #555);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.sb-diag-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 8px;
  font-size: 10px;
  white-space: nowrap;
}
.sb-diag-row:hover { background: var(--wb-hover, rgba(255, 255, 255, 0.08)); }
.sb-diag-code { color: var(--wb-accent, #7fb3ff); }
.sb-diag-object { color: var(--wb-text); max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.sb-diag-time { color: var(--wb-text-muted, #999); }
.sb-diag-channel { color: var(--wb-text-muted, #999); }
</style>
