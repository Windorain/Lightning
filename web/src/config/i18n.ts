/**
 * 轻量 i18n：从 localStorage 读取语言设置，提供 t() 翻译函数。
 */
import { ref, type Ref } from 'vue'

export type Lang = 'zh' | 'en'

const LS_KEY = 'wsr-wb-lang'

/** 默认 ref；Workbench 启动后由 bindI18nLang(wm.settings.lang) 接管 */
export const currentLang: Ref<Lang> = ref(loadLang())

let activeLang: Ref<Lang> = currentLang

/** 绑定 WM shell 语言为 t() 唯一读源 */
export function bindI18nLang(lang: Ref<Lang>): void {
  activeLang = lang
  currentLang.value = lang.value
}

function loadLang(): Lang {
  try { const v = localStorage.getItem(LS_KEY); if (v === 'zh' || v === 'en') return v } catch { /* */ }
  return 'zh'
}

/** Set runtime language. NOTE: also persists to localStorage. */
export function setLang(v: Lang): void {
  activeLang.value = v
  if (activeLang !== currentLang) currentLang.value = v
  try { localStorage.setItem(LS_KEY, v) } catch { /* */ }
}

/** 翻译字典 */
const dict: Record<string, Record<Lang, string>> = {
  'file': { zh: '文件', en: 'File' },
  'edit': { zh: '编辑', en: 'Edit' },
  'view': { zh: '视图', en: 'View' },
  'help': { zh: '帮助', en: 'Help' },
  'openScene': { zh: '打开场景…', en: 'Open Scene…' },
  'newFile': { zh: '新建文件', en: 'New File' },
  'saveToFile': { zh: '保存到文件', en: 'Save to File' },
  'loadFromWiki': { zh: '从 Wiki 加载…', en: 'Load from Wiki…' },
  'saveToWiki': { zh: '保存到 Wiki', en: 'Save to Wiki' },
  'wikiSavePreview': { zh: '保存预检（分片）', en: 'Save dry-run' },
  'wikiSaveAs': { zh: '另存为 Wiki 结构…', en: 'Save as new structure…' },
  'copyWikiEmbed': { zh: '复制 {{渲染器}} 模板', en: 'Copy {{renderer}} wikitext' },
  'wikiReload': { zh: '重新载入 Wiki 数据', en: 'Reload from Wiki' },
  'wikiReady': { zh: 'Wiki 已就绪', en: 'Wiki ready' },
  'wikiLoginRequired': { zh: '请登录 Wiki', en: 'Wiki login required' },
  'wikiStructure': { zh: '结构', en: 'Structure' },
  'unsaved': { zh: '未保存', en: 'Unsaved' },
  'language': { zh: '语言', en: 'Language' },
  'chinese': { zh: '中文', en: '中文' },
  'english': { zh: 'English', en: 'English' },
  'resetLayout': { zh: '重置布局', en: 'Reset Layout' },
  'fullscreen': { zh: '全屏', en: 'Fullscreen' },
  'exitFullscreen': { zh: '退出全屏', en: 'Exit fullscreen' },
  'preview': { zh: '编辑', en: 'Edit' },
  'wiki': { zh: 'Wiki 查看器', en: 'Wiki Viewer' },
  'materials': { zh: '材质', en: 'Materials' },
  'export': { zh: '导出', en: 'Export' },
  'sceneInfo': { zh: '场景信息', en: 'Scene Info' },
  'previewConfig': { zh: '预览配置', en: 'Preview Config' },
  'blockInspector': { zh: '方块检查器', en: 'Block Inspector' },
  'tooltipEditor': { zh: '注解编辑', en: 'Tooltip Editor' },
  'blockStats': { zh: '方块统计', en: 'Block Stats' },
  'wikiConfig': { zh: 'Wiki 配置', en: 'Wiki Config' },
  'tools': { zh: '工具', en: 'Tools' },
  'select': { zh: '选取', en: 'Select' },
  'previewMode': { zh: '预览模式', en: 'Preview Mode' },
  'editMode': { zh: '编辑模式', en: 'Edit Mode' },
  'connected': { zh: 'SDE 已连接', en: 'SDE Connected' },
  'offline': { zh: 'SDE 离线', en: 'SDE Offline' },
  'noScene': { zh: '无场景数据', en: 'No scene loaded' },
  'noSceneHint': { zh: '文件 > 打开场景', en: 'File > Open Scene' },
  'syncPreview': { zh: '同步预览', en: 'Sync Preview' },
  'applyToPreview': { zh: '应用到预览', en: 'Apply to Preview' },
  'restoreFromConfig': { zh: '从配置还原', en: 'Restore from Config' },
  'rebuildingPreview': { zh: '正在重建预览…', en: 'Rebuilding preview…' },
  'appliedReloaded': { zh: '已应用并重载预览壳', en: 'Applied & reloaded preview' },
  'saveToSde': { zh: '同步到 SDE', en: 'Sync to SDE' },
  'sdeSaved': { zh: '已保存到 SDE 工作区', en: 'Saved to SDE workspace' },
  'saving': { zh: '正在保存…', en: 'Saving…' },
  'saved': { zh: '已完成', en: 'Done' },
  'noSceneToSave': { zh: '无场景可保存', en: 'No scene to save' },
  'downloadPlain': { zh: '下载 Plain', en: 'Download Plain' },
  'downloadEnvelope': { zh: '下载 Envelope', en: 'Download Envelope' },
  'copyToClipboard': { zh: '复制到剪贴板', en: 'Copy to Clipboard' },
  'objBlock': { zh: '方块模式 .zip', en: 'Block mode .zip' },
  'objConnected': { zh: '连通模式 .zip', en: 'Connected mode .zip' },
  'objLayered': { zh: '分层模式 .zip', en: 'Layered mode .zip' },
  'json': { zh: 'JSON', en: 'JSON' },
  'obj': { zh: 'OBJ 3D 模型', en: 'OBJ 3D Model' },
  'isoPng': { zh: '等轴 PNG', en: 'Isometric PNG' },
  'isoDir': { zh: '方向', en: 'Direction' },
  'downloadPng': { zh: '下载 PNG', en: 'Download PNG' },
  'rendering': { zh: '渲染中…', en: 'Rendering…' },
  'sdeSync': { zh: 'SDE 同步', en: 'SDE Sync' },
  'putToSde': { zh: '同步到 SDE', en: 'PUT to SDE' },
  'plainDesc': { zh: 'Plain 为完整明文 JSON；Envelope 为 gzip+Base64 信封。', en: 'Plain is full plain JSON; Envelope is gzip+Base64 envelope.' },
  'objDesc': { zh: '导出 Wavefront .obj + .mtl + 纹理，zip 打包。', en: 'Export Wavefront .obj + .mtl + textures in .zip.' },
  'isoDesc': { zh: '等轴视角渲染，4 个方向可选。', en: 'Isometric render, 4 directions.' },
  'block': { zh: '方块', en: 'Block' },
  'position': { zh: '坐标', en: 'Position' },
  'tooltipMd': { zh: 'Tooltip (Markdown + MC 码)', en: 'Tooltip (Markdown + MC codes)' },
  'saveTooltip': { zh: '保存 Tooltip', en: 'Save Tooltip' },
  'clear': { zh: '清除', en: 'Clear' },
  'savedToMemory': { zh: '已保存到内存（同步预览生效）', en: 'Saved to memory (sync preview to apply)' },
  'enterEditMode': { zh: '进入编辑模式并点击方块以查看', en: 'Enter edit mode and click a block' },
  'noSceneData': { zh: '无场景数据，无法重建材质库', en: 'No scene data, cannot rebuild material library' },
  'bgMustBeHex': { zh: '场景背景色须为 #RRGGBB', en: 'Background must be #RRGGBB' },
  'iconClearMustBeHex': { zh: '图标 clearColor 须为 #RRGGBB', en: 'Icon clearColor must be #RRGGBB' },
}

/** 获取翻译文本 */
export function t(key: string): string {
  const entry = dict[key]
  if (!entry) return key
  return entry[activeLang.value] ?? key
}
