<script setup lang="ts">
/**
 * 下拉菜单（`menuBar` 的 File/Edit/View 三项都渲染成本组件）。
 *
 * ## 菜单项**必须**服从算子的 `poll`（灰显 + 原因），点击不得照旧 invoke
 *
 * 旧实现把每个 operator 项无条件渲染成可点按钮、点击一律 `ctx.getOperators().invoke(...)`。
 * 而 `OperatorType.poll` 的契约是"返回 false 时操作符在 UI 中灰掉"—— 本组件从未实现它，
 * 于是"保存到 Wiki"在 `poll` 为 false（非 Wiki 载入文档 / 没有可审计变更）时**可以点**，
 * 点了只会在日志里留一条 `invoke: poll failed`，用户看到的是"点了没反应"
 * （SPEC §10.7「不可编辑不能表现为静默成功」）。
 *
 * ## 单一结算点：`operators/availability#operatorAvailability`
 *
 * 本组件**不自己判断**可用性：它把注册表里的算子交给那条共享结算，拿到
 * `{ enabled, reason }`。同一个函数也是 `OperatorRegistry#exec/#invoke` 的执行前防线
 * ⇒ 菜单、Ctrl+S、脚本、命令面对"能不能用"只有一个答案、一句原因。
 *
 * ## 求值时机（**禁止**在渲染循环里反复求值）
 *
 * `poll` 可能有真实开销（Wiki 保存要做 `plainForSave()` 的差集）。故：
 *
 *  - **只在**"菜单被打开"与"items 引用变化（布局重算）"时，对每项求值**一次**，
 *    结果存进 `availability`（普通 ref，不是 computed）；
 *  - 渲染期只读缓存 —— 反复重渲染**不会**再求值（判据见
 *    `__tests__/uimenuAvailability.dom.test.ts` 的求值次数断言）；
 *  - 菜单关闭时不求值（`items` 变了也只在下次打开时算）。
 *
 * ## 缓存**不是**可点旁路
 *
 * 缓存可能过期（例如菜单开着时用户改了文档）。方向不对称，但两个方向都安全：
 *
 * | 缓存 | 实际 | 结果 |
 * |---|---|---|
 * | 不可用（灰） | 现在可用 | 关掉重开即可用（不会误执行） |
 * | 可用 | 现在不可用 | 点击 → `invoke` → registry **重新 poll** → 同一句原因写成底栏拒绝 |
 *
 * 第二行是"最终防线"的语义（`operators/availability` 文件头）：UI 的灰显是**呈现**，
 * 不是权威；过期快照永远不会变成"绕过 gate 执行"。
 */
import { ref, watch } from 'vue'
import { useContext } from '@/runtime/context'
import {
  operatorAvailability,
  operatorAvailabilityFailed,
  type OperatorAvailability,
} from '@/operators/availability'
import type { UIOperator, UILabel, UISeparator } from './types/layout'

const props = defineProps<{
  label: string
  icon?: string
  items: (UIOperator | UILabel | UISeparator)[]
}>()

const ctx = useContext()
const open = ref(false)

/** 缺省（未结算 / 未注册的项）：按可用处理 —— `invoke` 会在"没这个算子"时记 warn。 */
const AVAILABLE: OperatorAvailability = Object.freeze({ enabled: true })

/** 每项可用性快照（下标 → 结算结果）。只在打开/items 变化时整体替换。 */
const availability = ref<ReadonlyMap<number, OperatorAvailability>>(new Map())

/**
 * 对**当前 items** 的每个 operator 项求值一次。
 *
 * 算子取自**注册表**（`main.registries.operators`）而不是 `ctx.getOperators()` 门面：
 * 门面的 `find` 在嵌入外壳里被**收窄成 `{id,label}`**（`wrapOperatorRegistry` 的
 * sanitize 分支），读不到 `poll`；而可用性结算需要的正是算子的 `requires/poll/pollReason`。
 * 这里读的是**同一个注册表对象**，不构成第二份权威。
 */
function evaluateAvailability(): void {
  const registry = ctx.main.registries.operators
  const next = new Map<number, OperatorAvailability>()
  props.items.forEach((item, index) => {
    if (item.kind !== 'operator') return
    const op = registry.find(item.id)
    // 未注册：不伪造原因（`invoke` 会以 "op not found" 记 warn，那是另一条事实）
    if (op === undefined) return
    try {
      next.set(index, operatorAvailability(ctx, op))
    } catch (error) {
      // ── **逐项异常隔离**（复核）──
      //
      // `poll`/`pollReason` 是算子自己的代码，可能抛（读一个尚未装配的读面…）。
      // 两种错误处置都不能接受：
      //  ① 让异常冒出去 ⇒ 整份菜单打不开，用户连别的命令都点不到（比缺陷更糟）；
      //  ② 把异常吞成"可用" ⇒ 用户点到一条必然抛错的路径（假成功）。
      // ⇒ 该项 = 不可用 + **通用原因**，异常另写一条 error 日志（可见、可诊断）。
      // registry 的 exec/invoke **不**做这个隔离：那里异常照旧抛给调用方（原语义）。
      next.set(index, operatorAvailabilityFailed(ctx, op))
      ctx.log.error('Operator', `availability failed: ${op.label}`, {
        opId: op.id,
        error: String(error),
      })
    }
  })
  availability.value = next
}

watch(open, (isOpen) => {
  if (isOpen) evaluateAvailability()
})
watch(
  () => props.items,
  () => {
    // 菜单关着 ⇒ 不求值（打开时会算）；开着 ⇒ 布局重算过，重算这一次。
    if (open.value) evaluateAvailability()
  },
)

function toggle() { open.value = !open.value }
function close() { open.value = false }

function availabilityOf(index: number): OperatorAvailability {
  return availability.value.get(index) ?? AVAILABLE
}

function isUnavailable(index: number): boolean {
  return !availabilityOf(index).enabled
}

/** 不可用原因（可用 ⇒ `null`；供 `data-unavailable-reason` 读面与 title/aria 共用）。 */
function unavailableReason(index: number): string | null {
  const a = availabilityOf(index)
  return a.enabled ? null : a.reason
}

/**
 * `title`：不可用 ⇒ 原因；可用 ⇒ 算子项的 `title`（若有）。
 *
 * 文案由**本实例语言**组装：`不可用`/`unavailable` 走 `domain/i18n` 的
 * `operatorUnavailable` 键，原因句本身已由 `domain/rejectionText` 按语言成句 ——
 * 组件里不出现硬编码中文（en 实例不会混出中文）。
 */
function titleOf(item: UIOperator, index: number): string | undefined {
  const reason = unavailableReason(index)
  if (reason !== null) return `${item.label} — ${ctx.t('operatorUnavailable')}: ${reason}`
  return item.title
}

/**
 * `aria-label`：不可用 ⇒ 把原因并进可访问名（tooltip 对读屏不可靠）。
 * 与 `title` 用**同一份**文本（两个读面不该各自拼一遍而漂移）。
 */
function ariaLabelOf(item: UIOperator, index: number): string | undefined {
  const reason = unavailableReason(index)
  return reason === null ? undefined : titleOf(item, index)
}

function invokeOp(item: UIOperator, index: number) {
  // 原生 `disabled` 已经拦下鼠标点击；这里再守一次是为了"将来换成非原生控件"时
  // 不会静默退回旧形态（点击照旧 invoke）。
  if (isUnavailable(index)) return
  close()
  ctx.getOperators().invoke(item.id, item.props ?? {})
}
</script>

<template>
  <div class="ux-menu" @mouseleave="close">
    <button class="ux-menu-btn" @click="toggle">
      <span v-if="icon" class="ux-icon">{{ icon }}</span>
      {{ label }}
      <svg class="ux-arrow" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <Transition name="menu-drop">
      <div v-if="open" class="ux-menu-dropdown">
        <template v-for="(item, i) in items" :key="i">
          <hr v-if="item.kind === 'separator'" class="ux-menu-sep" />
          <span v-else-if="item.kind === 'label'" class="ux-menu-label">{{ item.text }}</span>
          <button
            v-else-if="item.kind === 'operator'"
            class="ux-menu-item"
            :data-op-id="item.id"
            :disabled="isUnavailable(i)"
            :aria-disabled="isUnavailable(i) ? 'true' : undefined"
            :aria-label="ariaLabelOf(item, i)"
            :title="titleOf(item, i)"
            :data-unavailable-reason="unavailableReason(i) ?? undefined"
            @click="invokeOp(item, i)"
          >
            <span v-if="item.icon" class="ux-icon">{{ item.icon }}</span>
            {{ item.label }}
          </button>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ux-menu { position: relative; }
.ux-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  cursor: pointer;
  font-size: 13px;
}
.ux-menu-btn:hover { background: var(--wb-bg-hover); }
.ux-arrow { width: 10px; height: 10px; flex-shrink: 0; }
.ux-menu-btn:focus-visible,
.ux-menu-item:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 2px;
}

.ux-menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 180px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  z-index: 2100;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ux-menu-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--wb-radius-sm);
}
.ux-menu-item:hover { background: var(--wb-bg-hover); }
/* 不可用项（算子 poll=false / 缺能力）—— 灰显 + 不可点，原因在 title/aria。 */
.ux-menu-item:disabled {
  color: var(--wb-text-dim);
  cursor: default;
}
.ux-menu-item:disabled:hover { background: transparent; }
.ux-menu-label {
  display: block;
  padding: 5px 14px 3px;
  font-size: 10px;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ux-menu-sep {
  margin: 4px 8px;
  border: none;
  border-top: 1px solid var(--wb-border);
}

.menu-drop-enter-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.menu-drop-leave-active {
  transition: opacity 0.08s ease;
}
.menu-drop-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.menu-drop-leave-to {
  opacity: 0;
}
</style>
