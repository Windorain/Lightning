import type { RNAStruct } from '../types'

function feat(owner: any): Record<string, any> {
  if (!owner.features || typeof owner.features !== 'object') {
    owner.features = {}
  }
  return owner.features
}

export const wikiConfigRNA: RNAStruct = {
  name: 'WikiConfig',
  description: 'Wiki 视口配置',
  properties: [
    {
      name: 'viewWidth',
      type: 'number', label: '视口宽度', description: 'Wiki 预览视口宽度 (px)',
      default: 600, min: 200, max: 2000,
      get(o: any) { return o.viewWidth },
      set(o: any, v: unknown) { o.viewWidth = v as number },
    },
    {
      name: 'viewHeight',
      type: 'number', label: '视口高度', description: 'Wiki 预览视口高度 (px)',
      default: 400, min: 150, max: 1500,
      get(o: any) { return o.viewHeight },
      set(o: any, v: unknown) { o.viewHeight = v as number },
    },
    {
      name: 'showStats',
      type: 'boolean', label: '方块统计栏', description: '左侧方块统计侧栏',
      default: false,
      get(o: any) { return feat(o).blockStatsSidebar ?? false },
      set(o: any, v: unknown) { feat(o).blockStatsSidebar = v as boolean },
    },
    {
      name: 'showLayerBar',
      type: 'boolean', label: '分层预览条', description: '底部分层预览滑块',
      default: false,
      get(o: any) { return feat(o).layerBar ?? false },
      set(o: any, v: unknown) { feat(o).layerBar = v as boolean },
    },
    {
      name: 'showFrameControls',
      type: 'boolean', label: '帧控制', description: '底部帧切换控件',
      default: false,
      get(o: any) { return feat(o).frameControls ?? false },
      set(o: any, v: unknown) { feat(o).frameControls = v as boolean },
    },
    {
      name: 'showTitle',
      type: 'boolean', label: '标题栏', description: '顶部场景标题',
      default: false,
      get(o: any) { return feat(o).titleBar ?? false },
      set(o: any, v: unknown) { feat(o).titleBar = v as boolean },
    },
    {
      name: 'showDebugStatus',
      type: 'boolean', label: '调试状态栏', description: '底部调试信息条',
      default: false,
      get(o: any) { return feat(o).debugStatusBar ?? false },
      set(o: any, v: unknown) { feat(o).debugStatusBar = v as boolean },
    },
    {
      name: 'showAxesGizmo',
      type: 'boolean', label: '坐标轴', description: '视口内坐标轴指示器',
      default: false,
      get(o: any) { return feat(o).showAxesGizmo ?? false },
      set(o: any, v: unknown) { feat(o).showAxesGizmo = v as boolean },
    },
    {
      name: 'cameraYaw',
      type: 'number', label: '偏航角 (°)', description: '初始相机水平旋转角',
      default: 45, min: 0, max: 360,
      get(o: any) { return o.cameraYaw },
      set(o: any, v: unknown) { o.cameraYaw = v as number },
    },
    {
      name: 'cameraElevation',
      type: 'number', label: '俯仰角 (°)', description: '初始相机仰角（水平面以上）',
      default: 30, min: 5, max: 85,
      get(o: any) { return o.cameraElevation },
      set(o: any, v: unknown) { o.cameraElevation = v as number },
    },
    {
      name: 'cameraZoom',
      type: 'number', label: '缩放', description: '初始正交相机 zoom',
      default: 1, min: 0.05, max: 50,
      get(o: any) { return o.cameraZoom },
      set(o: any, v: unknown) { o.cameraZoom = v as number },
    },
    {
      name: 'sceneBackgroundHex',
      type: 'string', label: '背景色', description: '视口背景色 (如 #5a5a5a)',
      default: '#5a5a5a',
      get(o: any) { return o.sceneBackgroundHex ?? '#5a5a5a' },
      set(o: any, v: unknown) { o.sceneBackgroundHex = v as string },
    },
  ],
}
