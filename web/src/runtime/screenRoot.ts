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
import { createViewerPreferences } from '@/preview/preferences'
import { defaultWikiConfig } from '@/runtime/wikiConfigDefaults'
import { readPersistedPanelWidths } from '@/workbench/layout/panelLayoutStorage'
import { REGION, REGION_KEYMAP } from '@/runtime/regionIds'
import { createViewportHoverState } from '@/runtime/viewportHover'
import type { ConnectionState, UIWorkspace, WorkbenchWorkspaceMode } from '@/runtime/types'

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
  initialCamera?: import('@/preview/previewConfig').InitialCamera
}): EmbedSession {
  return {
    layerWorldY: ref(extras?.initialLayerWorldY ?? -1),
    initialCamera: extras?.initialCamera,
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
  const wiki = defaultWikiConfig()

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
          state: { wiki },
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
    initialCamera?: import('@/preview/previewConfig').InitialCamera
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
