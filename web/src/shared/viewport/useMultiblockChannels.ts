/**
 * `useMultiblockChannels` —— 「通道」面板的**视口本地状态**（T2.5 接线）。
 *
 * 状态归属拍板（留白 #4 配套决策，理由的历史记录见 issue #51 / git 历史）：
 * **视口本地**（每个视口各持一份 `{totalTier, values, runstate}`），不写文档、不写 ctx.main。
 *  - 写文档会经 `replaceDoc` 触发呈现层的内容比较 + 让 wiki 编辑判定误报"已修改"；
 *  - 两端用**同一份** composable ⇒ 行为一致（Workbench / Embed 同一实现，无分支）。
 *
 * 渲染接线：`renderDoc` 是给 DRW 的**视图文档**（帧为主文档原样返回，行为零变化）。
 *
 * ## 退役改造（#249 §15 第 5 条，本批 P5）
 *
 * **被删除**：`revision` 计数 + `bindMultiblockMeshSync()`。
 *
 * 旧形状是「取值改动 ⇒ `revision++` ⇒ `watch(revision)` ⇒ 手工调
 * `loadStructureAndResources()` + `rebuildContentMesh()`」。它与 `structEpoch` 链是
 * **同一种病**：调用方自己决定重建范围（而且为了效率不得不**手工挑**该调哪两个函数，
 * 注释里写着"单独 `rebuildContentMesh()` 不够"）。两条手推链并存还互相打补丁
 * （旧注释：「文档切换由 `rebuildAll` 覆盖，避免两条重建链并发」）。
 *
 * **替代物**：`commit()` 只调 `ctx.main.requestContentRefresh()` —— 表达"取值变了，
 * 请重读并自行判断"。`renderDoc` 是内容的一部分（它进了结构摘要），因此呈现层会读到新的
 * 装配结果并按内容身份决定重建范围。于是**只剩一条**重建通路，且这条通路不含任何
 * 调用方决策。
 */
import { computed, ref, watch, type ComputedRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import {
  assembleForSelection,
  buildChannelPanelModel,
  buildMultiblockRenderView,
  clampChannelValue,
  initialMultiblockSelection,
  snapTierToSample,
  tierSampleValues,
  type MultiblockChannelPanelModel,
  type MultiblockSelectionState,
} from './multiblockChannelUi'

export interface MultiblockChannelControls {
  /** 当前文档是否为「多方块为主」形态（通道 tab 的唯一显隐条件） */
  isMultiblock: ComputedRef<boolean>
  /** 给 DRW 的渲染视图文档（帧为主文档 = 原文档本身） */
  renderDoc: ComputedRef<RuntimeDocument | null>
  /** 面板模型（非多方块文档为 null） */
  panel: ComputedRef<MultiblockChannelPanelModel | null>
  setTier(value: number): void
  setChannelValue(key: string, value: number): void
  setRunstate(id: string): void
}

export function useMultiblockChannels(ctx: Context): MultiblockChannelControls {
  const state = ref<MultiblockSelectionState>({ totalTier: 1, values: {}, runstate: '' })

  const doc = computed(() => ctx.getDoc().value)
  const decl = computed(() => doc.value?.multiblock?.decl ?? null)
  const isMultiblock = computed(() => decl.value !== null)

  /**
   * 文档切换即重置取值。
   *
   * `flush: 'sync'`：必须在**任何**内容重读之前落定，否则新文档会先用旧文档的取值装配
   * 一次（T2.2 不会拒绝，但会白白产生一次回落提示）。
   */
  watch(decl, (d) => {
    if (d) state.value = initialMultiblockSelection(d)
  }, { immediate: true, flush: 'sync' })

  const outcome = computed(() => {
    const d = doc.value
    if (!d || !d.isMultiblock) return null
    return assembleForSelection(d, state.value)
  })

  const renderDoc = computed<RuntimeDocument | null>(() => {
    const d = doc.value
    if (!d) return null
    // 帧为主文档：原样返回（渲染路径行为零变化）
    if (!d.isMultiblock) return d
    const current = ctx.getCurrentFrameIndex().value ?? 0
    return buildMultiblockRenderView(d, outcome.value?.result ?? null, current)
  })

  const panel = computed<MultiblockChannelPanelModel | null>(() => {
    const d = doc.value
    const o = outcome.value
    if (!d || !d.isMultiblock || !o) return null
    return buildChannelPanelModel(d, state.value, o)
  })

  /**
   * 取值改动 ⇒ 请求内容重读（**不是**指定重建动作）。
   *
   * 重建范围由呈现层按内容身份算出：`renderDoc` 进了结构摘要 ⇒ 取值变化被识别为
   * 结构变化 ⇒ 重解结构 + 重建几何，且**不**重解码纹理（新旧内容身份都不含资源变化）。
   */
  function commit(next: MultiblockSelectionState): void {
    state.value = next
    ctx.main.requestContentRefresh()
  }

  function setTier(value: number): void {
    const d = decl.value
    if (!d) return
    const next = snapTierToSample(tierSampleValues(d), value)
    if (next === state.value.totalTier) return
    commit({ ...state.value, totalTier: next })
  }

  function setChannelValue(key: string, value: number): void {
    const d = decl.value
    if (!d) return
    const next = clampChannelValue(d, key, value)
    if (next === null) return
    if ((state.value.values[key] ?? 0) === next) return
    commit({ ...state.value, values: { ...state.value.values, [key]: next } })
  }

  function setRunstate(id: string): void {
    const d = decl.value
    if (!d) return
    if (!d.runstates.some((r) => r.id === id)) return
    if (state.value.runstate === id) return
    commit({ ...state.value, runstate: id })
  }

  return { isMultiblock, renderDoc, panel, setTier, setChannelValue, setRunstate }
}
