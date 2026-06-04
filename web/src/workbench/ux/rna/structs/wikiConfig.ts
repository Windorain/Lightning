import type { RNAStruct } from '../types'
import type { Main } from '@/runtime/main'

export type WikiConfigOwner = { main: Main }

function pub(o: WikiConfigOwner) {
  return o.main.embedPublish.value
}

/** 写入经 RNAWidget → OPERATOR_SET_WIKI_CONFIG；descriptor.set 为 no-op */
export const wikiConfigRNA: RNAStruct = {
  name: 'WikiConfig',
  description: 'Wiki 嵌入发布壳配置（视角见文档 meta.embed_initial_view）',
  properties: [
    {
      name: 'viewWidth',
      type: 'number', label: '视口宽度', description: 'Wiki 预览视口宽度 (px)',
      default: 600, min: 200, max: 2000, uiWidget: 'number',
      get(o: WikiConfigOwner) { return pub(o).viewWidth },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'viewHeight',
      type: 'number', label: '视口高度', description: 'Wiki 预览视口高度 (px)',
      default: 400, min: 150, max: 1500, uiWidget: 'number',
      get(o: WikiConfigOwner) { return pub(o).viewHeight },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showStats',
      type: 'boolean', label: '方块统计栏', description: '左侧方块统计侧栏',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.blockStatsSidebar ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showLayerBar',
      type: 'boolean', label: '分层预览条', description: '底部分层预览滑块',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.layerBar ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showFrameControls',
      type: 'boolean', label: '帧控制', description: '底部帧切换控件',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.frameControls ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showTitle',
      type: 'boolean', label: '标题栏', description: '顶部场景标题',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.titleBar ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showDebugStatus',
      type: 'boolean', label: '调试状态栏', description: '底部调试信息条',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.debugStatusBar ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'showAxesGizmo',
      type: 'boolean', label: '坐标轴', description: '视口内坐标轴指示器',
      default: false,
      get(o: WikiConfigOwner) { return pub(o).features.showAxesGizmo ?? false },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
    {
      name: 'sceneBackgroundHex',
      type: 'string', label: '背景色', description: '视口背景色 (如 #5a5a5a)',
      default: '#5a5a5a',
      get(o: WikiConfigOwner) { return pub(o).sceneBackgroundHex ?? '#5a5a5a' },
      set(_o: WikiConfigOwner, _v: unknown) { /* OPERATOR_SET_WIKI_CONFIG */ },
    },
  ],
}
