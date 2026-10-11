import { reactive, ref, shallowReactive } from 'vue'
import type { Ref } from 'vue'
import type { PanelDeclaration } from '@/workbench/ux/types/panel'
import type { Rect } from '@/shared/types'
import { RegionType, SpaceType } from '@/runtime/screenTypes'
import type {
  EmbedSession,
  RegionState,
  ToolSettings,
  WorkbenchSession,
} from '@/runtime/contextAccess'
import { createViewerPreferences } from '@/viewer/preferences'
import { readPersistedPanelWidths } from '@/workbench/layout/panelLayoutStorage'
import { REGION, REGION_KEYMAP } from '@/runtime/regionIds'
import { createViewportHoverState } from '@/runtime/hover'
import type { ConnectionState, UIWorkspace, WorkbenchWorkspaceMode } from '@/runtime/types'
import { createDocumentBindingRef } from '@/workbench/document/binding'

export interface ScreenLayout {
  leftWidth: Ref<number>
  rightWidth: Ref<number>
}

export interface RegionNode {
  id: string
  type: RegionType
  bounds: Rect
  panels: PanelDeclaration[]
  visible: boolean
  collapsed: boolean
  /** WM 输入域 id；默认与 layout region id 相同时可省略 */
  wmInputId?: string
  /** 基础键位预设 id，见 `resolveRegionBaseKeymap` */
  keymapId?: string
  readonly state: RegionState
}

export interface AreaNode {
  id: string
  spaceType: SpaceType
  regions: RegionNode[]
  splitDir: 'none' | 'h' | 'v'
  parentArea: string | null
}

export class ScreenRoot {
  readonly areas: AreaNode[]
  readonly popupRegions: RegionNode[]
  readonly layout: ScreenLayout
  session: WorkbenchSession | EmbedSession

  private readonly _byId = new Map<string, RegionNode>()
  private readonly _byInputId = new Map<string, RegionNode>()

  constructor(
    readonly id: string,
    readonly bounds: { width: number; height: number },
    areas: AreaNode[],
    popupRegions: RegionNode[],
    session: WorkbenchSession | EmbedSession,
    layout?: Partial<{ leftWidth: number; rightWidth: number }>,
  ) {
    this.areas = areas
    this.popupRegions = popupRegions
    this.session = session
    this.layout = {
      leftWidth: ref(layout?.leftWidth ?? 220),
      rightWidth: ref(layout?.rightWidth ?? 300),
    }
    this.reindex()
  }

  reindex(): void {
    this._byId.clear()
    this._byInputId.clear()
    const add = (r: RegionNode) => {
      this._byId.set(r.id, r)
      const inputId = r.wmInputId ?? r.id
      this._byInputId.set(inputId, r)
    }
    for (const a of this.areas) {
      for (const r of a.regions) add(r)
    }
    for (const r of this.popupRegions) add(r)
  }

  region(regionId: string): RegionNode | undefined {
    return this._byId.get(regionId)
  }

  regionByInputId(wmInputId: string): RegionNode | undefined {
    return this._byInputId.get(wmInputId)
  }

  area(areaId: string): AreaNode | undefined {
    return this.areas.find(a => a.id === areaId)
  }

  /**
   * **按需登记一个 3D 视口 region**（#282 P10b Area 产品接线）。
   *
   * ## 为什么需要它
   *
   * `createWorkbenchScreenRoot` 静态声明 region 列表，其中只有一个
   * `REGION.WORKBENCH_VIEWPORT`。Area 分割出第二个 3D 视口时，那个视口需要一个
   * **自己的** region —— 因为 region 是"输入域 + 相机键 + 视口槽位 + viewer 偏好"
   * 的共同键（见 `mainCameras#cameraMainKeyForRegion` 的说明）。共用一个 region
   * 会让两个视口共享机位与槽位，那正是 A05 判红的形态。
   *
   * ## 幂等
   *
   * 已有该 region 时**返回它**（不重建）—— 重挂同一个 Area 不应重置 viewer 偏好
   * 或 hover 状态。这与 `ViewportManager.register(id)` 的幂等语义一致。
   *
   * ## 输入域 id 与 region id 相同
   *
   * `wmInputId` 取 region id：`hitTest` 经 `data-wm-region` 读出的就是 region id
   * （`WorkbenchRoot` 的 hitTest 实现），故两者同值才让"指针命中哪个 Area"与
   * "事件路由到哪个输入域"是同一个事实。**不**复用 `REGION.WORKBENCH_VIEWPORT`。
   */
  ensureViewportRegion(regionId: string, areaId: string): RegionNode {
    const existing = this._byId.get(regionId)
    if (existing) return existing
    const node = createRegionNode(regionId, RegionType.MAIN, {
      wmInputId: regionId,
      keymapId: REGION_KEYMAP.WORKBENCH_VIEWPORT,
      state: {
        // 每个视口**自己的** viewer 偏好实例：共享会让"关掉 A 的注解显示"改到 B。
        viewer: createViewerPreferences(`lightning.prefs.viewport.${regionId}`),
        hover: createViewportHoverState(),
      },
    })
    const area = this.areas.find(a => a.id === areaId)
    if (area) {
      area.regions.push(node)
    } else {
      // 找不到宿主 Area：**不静默吞** —— 加进 popup 区会让它可见但语义错位。
      // 抛错是响亮的（调用方传了错的 areaId，那是编程错误）。
      throw new Error(`ensureViewportRegion: 未知 area ${areaId}`)
    }
    this.reindex()
    return node
  }

  /**
   * 注销一个按需登记的视口 region（Area 被合并/关闭时调用）。
   *
   * 根 region（`REGION.WORKBENCH_VIEWPORT`）**不**允许注销：它是装配期静态声明的，
   * 移除它会让单视口装配在合并后彻底没有视口。故显式拒绝（响亮），而不是静默保留
   * 一个"注销失败"的错觉。
   */
  releaseViewportRegion(regionId: string): boolean {
    if (regionId === REGION.WORKBENCH_VIEWPORT) return false
    const node = this._byId.get(regionId)
    if (!node) return false
    for (const a of this.areas) {
      const i = a.regions.indexOf(node)
      if (i >= 0) a.regions.splice(i, 1)
    }
    this.reindex()
    return true
  }

  /** 枚举需向 WM 注册的输入域 id */
  wmInputRegionIds(): string[] {
    return [...this._byInputId.keys()]
  }

  forEachRegion(fn: (r: RegionNode) => void): void {
    for (const a of this.areas) {
      for (const r of a.regions) fn(r)
    }
    for (const r of this.popupRegions) fn(r)
  }
}

function createRegionNode(
  id: string,
  type: RegionType,
  init: Partial<Pick<RegionNode, 'wmInputId' | 'keymapId' | 'panels'>> & { state?: RegionState },
): RegionNode {
  return shallowReactive({
    id,
    type,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    panels: init.panels ?? [],
    visible: true,
    collapsed: false,
    wmInputId: init.wmInputId,
    keymapId: init.keymapId,
    state: init.state ?? {},
  }) as RegionNode
}

export function createWorkbenchSession(): WorkbenchSession {
  return {
    workspaceMode: ref<WorkbenchWorkspaceMode>('local-file'),
    uiWorkspace: ref<UIWorkspace>('preview'),
    localFileName: ref<string | null>(null),
    documentBinding: createDocumentBindingRef(),
    connection: reactive<ConnectionState>({
      apiBase: '',
      token: '',
      connected: null,
      exports: [],
      exportsLoading: false,
      selectedExportName: null,
    }),
    layerWorldY: ref(-1),
  }
}

export function createEmbedSession(extras?: {
  initialLayerWorldY?: number
}): EmbedSession {
  return {
    layerWorldY: ref(extras?.initialLayerWorldY ?? -1),
  }
}

/** 构建 Workbench Screen 树并挂载各 Region state */
export function createWorkbenchScreenRoot(
  tool: ToolSettings,
  panels: {
    toolShelf: PanelDeclaration[]
    header: PanelDeclaration[]
    properties: PanelDeclaration[]
  },
): ScreenRoot {
  const session = createWorkbenchSession()

  const areas: AreaNode[] = [
    {
      id: 'viewport-area',
      spaceType: SpaceType.VIEW_3D,
      splitDir: 'none',
      parentArea: null,
      regions: [
        createRegionNode(REGION.WORKBENCH_HEADER, RegionType.HEADER, { panels: panels.header }),
        createRegionNode(REGION.WORKBENCH_TOOLSHELF, RegionType.TOOLSHELF, {
          panels: panels.toolShelf,
          state: { tool },
        }),
        createRegionNode(REGION.WORKBENCH_VIEWPORT, RegionType.MAIN, {
          wmInputId: REGION.WORKBENCH_VIEWPORT,
          keymapId: REGION_KEYMAP.WORKBENCH_VIEWPORT,
          state: {
            viewer: createViewerPreferences('lightning.prefs.viewport'),
            hover: createViewportHoverState(),
          },
        }),
      ],
    },
    {
      id: 'properties-area',
      spaceType: SpaceType.PROPERTIES,
      splitDir: 'none',
      parentArea: null,
      regions: [
        createRegionNode(REGION.WORKBENCH_PROPS, RegionType.MAIN, {
          panels: panels.properties,
        }),
      ],
    },
  ]

  const wikiPreview = createRegionNode(REGION.WIKI_PREVIEW, RegionType.MAIN, {
    wmInputId: REGION.WIKI_PREVIEW,
    keymapId: REGION_KEYMAP.EMBED_VIEWPORT,
    state: { viewer: createViewerPreferences('lightning.prefs.wiki-preview'), hover: createViewportHoverState() },
  })
  wikiPreview.visible = false

  const { leftWidth, rightWidth } = readPersistedPanelWidths()
  return new ScreenRoot('workbench', { width: 1400, height: 800 }, areas, [wikiPreview], session, {
    leftWidth,
    rightWidth,
  })
}

/** Embed：单 Region 退化树 */
export function createEmbedScreenRoot(
  tool: ToolSettings,
  extras?: {
    initialLayerWorldY?: number
  },
): ScreenRoot {
  const session = createEmbedSession(extras)
  const areas: AreaNode[] = [
    {
      id: 'embed-area',
      spaceType: SpaceType.VIEW_3D,
      splitDir: 'none',
      parentArea: null,
      regions: [
        createRegionNode(REGION.EMBED, RegionType.MAIN, {
          wmInputId: REGION.EMBED,
          keymapId: REGION_KEYMAP.EMBED_VIEWPORT,
          state: { tool, viewer: createViewerPreferences('lightning.prefs.embed'), hover: createViewportHoverState() },
        }),
      ],
    },
  ]
  return new ScreenRoot('embed', { width: 800, height: 600 }, areas, [], session)
}
