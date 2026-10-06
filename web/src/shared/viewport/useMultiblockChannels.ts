/**
 * `useMultiblockChannels` —— 「通道」面板的**视口本地状态**（T2.5 接线）。
 *
 * 状态归属拍板（留白 #4 配套决策，理由的历史记录见 issue #51 / git 历史）：
 * **视口本地**（每个视口各持一份 `{totalTier, values, runstate}`），不写文档、不写 ctx.main。
 *  - 写文档会经 `replaceDoc` → `structEpoch` 全量重建（含纹理重解码）+ 让 wiki 编辑判定误报"已修改"；
 *  - 两端用**同一份** composable ⇒ 行为一致（Workbench / Embed 同一实现，无分支）。
 *
 * 渲染接线：`renderDoc` 是给 DRW 的**视图文档**（帧为主文档原样返回，行为零变化）；
 * 取值变化时由 `bindMultiblockMeshSync` 经 DRW 既有公开接口重建 mesh。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
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

/** 装配产物进入 mesh 管线所需的最小 DRW 接口（`drw` 整体可赋值）。 */
export interface MultiblockMeshSink {
  loadStructureAndResources(): Promise<void>
  rebuildContentMesh(): Promise<void>
}

export interface MultiblockChannelControls {
  /** 当前文档是否为「多方块为主」形态（通道 tab 的唯一显隐条件） */
  isMultiblock: ComputedRef<boolean>
  /** 给 DRW 的渲染视图文档（帧为主文档 = 原文档本身） */
  renderDoc: ComputedRef<RuntimeDocument | null>
  /** 面板模型（非多方块文档为 null） */
  panel: ComputedRef<MultiblockChannelPanelModel | null>
  /** 取值变更计数：仅在**取值被用户改动**时 +1（文档切换由 structEpoch 全量重建覆盖） */
  revision: Ref<number>
  setTier(value: number): void
  setChannelValue(key: string, value: number): void
  setRunstate(id: string): void
}

export function useMultiblockChannels(ctx: Context): MultiblockChannelControls {
  const state = ref<MultiblockSelectionState>({ totalTier: 1, values: {}, runstate: '' })
  const revision = ref(0)

  const doc = computed(() => ctx.getDoc().value)
  const decl = computed(() => doc.value?.multiblock?.decl ?? null)
  const isMultiblock = computed(() => decl.value !== null)

  /**
   * 文档切换即重置取值。
   *
   * `flush: 'sync'`：必须早于 DRW 的 `structEpoch` 观察者（后者会立刻读 `renderDoc` 装配），
   * 否则新文档会先用旧文档的取值装配一次（T2.2 不会拒绝，但会白白产生一次回落提示）。
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

  /** 取值改动才 bump：文档切换由 `structEpoch` 的 `rebuildAll` 覆盖，避免两条重建链并发。 */
  function commit(next: MultiblockSelectionState): void {
    state.value = next
    revision.value += 1
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

  return { isMultiblock, renderDoc, panel, revision, setTier, setChannelValue, setRunstate }
}

/**
 * 取值变更 → DRW 重建（**接线核心**：多方块文档的 `frame.grid` 恒为 null，渲染必须吃装配产物）。
 *
 * 用 DRW 既有公开接口：`loadStructureAndResources()` 重新解析文档
 * （对 `format_version:"2.0"` 文档解析顶层展开的 structure，故必须经它，单独 `rebuildContentMesh()` 不够），
 * 再 `rebuildContentMesh()` 重建 mesh。纹理缓存由 DRW 自行复用，不触发全量 `rebuildAll`。
 *
 * 串行化：链式排队，快速拖动滑杆不会让两次重建并发。
 */
export function bindMultiblockMeshSync(
  revision: Ref<number>,
  sink: MultiblockMeshSink,
): () => void {
  let chain: Promise<void> = Promise.resolve()
  const run = async (): Promise<void> => {
    try {
      await sink.loadStructureAndResources()
      await sink.rebuildContentMesh()
    } catch (e) {
      console.error('[multiblock] 通道装配后重建 mesh 失败', e)
    }
  }
  return watch(revision, () => {
    chain = chain.then(run)
  }, { flush: 'post' })
}
