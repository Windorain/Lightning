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
import { buildWikiEditSummaryDraft, hasWikiAuditableChanges } from '@/wiki/wikiEditSummary'

const ctx = useContext()
const shell = useShell()
const log = ctx.log
/** 本实例的翻译（#259 A33：消费本实例语言，无模块级全局读源）。 */
const t = ctx.t

// #301 P10f C′1（D8 修复 + #31）：帧数走**唯一读取面** `ctx.frameDeclarations()`，
// 与 `composition/useKernelFrameLoop` 的 FrameSource **同一个函数**。
//
// ## 为什么原来那行是一个真实缺陷（不是"风格问题"）
//
// 原写法 `ctx.getDoc().value?.frameCount ?? 0` 直读 legacy，而帧循环读内核 ——
// 装配失败时内核是**空文档**⇒ 帧循环报 0，状态栏报 N ⇒ **同一时刻两个读数不一致**。
// 那是 #249 §19.9 诊断一致性要防的形态（用户看到"帧 0"但状态栏说"共 432 帧"）。
//
// 收敛后两侧必然一致：装配成功 ⇒ 都用内核帧轴；否则 ⇒ 都用 legacy。
// ⚠️ 该读面**不经** `getDoc()`（它内部按 GF-16 分流），故本行的旧符号一并消失。
const frameCount = computed(() => ctx.frameDeclarations().count)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

// B5 #7：旧实现是 `isWikiHostProfile()`（组件在问宿主名 —— #249 §10 明文禁止）。
// 现在问**能力**：只有装配了 Wiki 上传的外壳才显示 Wiki 绑定行。
const wikiHost = computed(() => shell.has(CAPABILITY.WIKI_UPLOAD))
const binding = computed(() => ctx.getDocumentBinding().value)
const wikiName = computed(() =>
  binding.value.sourceId === 'wiki-data' && binding.value.locator
    ? displayNameFromLocator(binding.value.locator)
    : null,
)
const wikiDirty = computed(() => {
  if (binding.value.sourceId !== 'wiki-data') return false
  // #301 P10f D3（R3）：产物 plain 的唯一入口（与保存/导出同一个分流点）。
  const draft = buildWikiEditSummaryDraft(binding.value.saveBaseline, ctx.plainForSave().plain)
  return hasWikiAuditableChanges(draft) || (ctx.kernelDirty() ?? false)
})

/**
 * **实时状态槽**（#399 缺陷 B）：资源生命周期（纹理五态）的唯一用户可见写面。
 *
 * ## 为什么必须**排在** `lastDisplayable` 之前且能占住主位
 *
 * `lastDisplayable` 一旦被任一非 DEBUG 日志写过就再无代码清（`LogCenter.clear()` 全树零调用）
 * ⇒ 载入期它恒为「初始化视口相机 → FINISHED」，把"正在加载 3/57"这类真实进展**永久遮蔽**
 * （#399 的零反馈就是这么来的）。故实时状态有两条特权：
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
 * 判据无法区分"真的经历了加载"与"压根没写过加载态"（后者正是 #399 的原缺陷）。
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
 * **悬停格读数**（M3-shell B1）：编辑器视口的悬停信息落在**固定位**（底栏）。
 *
 * 数据源是唯一读面 `ctx.getHoveredBlock()`（`runtime/hover/access`：本 region 的
 * `viewportBlock` 经 `blockRefFromViewportHover` 换成内核世界坐标的 `BlockRef`）——
 * 与右栏「方块检查器」无选中时的回落读的是**同一个**读面，两处不会分叉。
 * 悬浮 ToolTipBox 已从编辑器视口撤除（见 `WorkbenchViewport` 的注释）。
 */
const hoveredBlock = computed(() => ctx.getHoveredBlock().value)

/**
 * **恢复副本**（M8-4；SPEC §9:299）的常驻提示与显式入口。
 *
 * 为什么不只靠 `liveStatus`：纹理链在编辑后会写 `loading/ready`，按"更晚的事实胜"
 * 的既有口径会把"有一份可采纳副本"顶掉。候选/损坏数是**状态**（不是一次性事件），
 * 故由状态栏常驻一行渲染；`liveStatus` 只负责"刚刚检测/采纳/放弃/写入失败"那一句。
 */
const recoveryCandidate = computed(() => ctx.getRecoverySession()?.candidate.value ?? null)
const recoveryCorrupt = computed(() => ctx.getRecoverySession()?.corruptCount.value ?? 0)

function recoveryTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

/**
 * **资源失败重试入口**（M8-5 / D6）。
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
</style>
