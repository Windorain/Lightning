/**
 * 语言与翻译（纯层；#249 §19.7）。
 *
 * ## 这里**没有**"活动语言"这个全局状态
 *
 * 旧实现（`config/i18n.ts`）有一个模块级 `activeLang`，由
 * `bindI18nLang(wm.settings.lang)` 在挂载期改写，`t()` 再去读它。后果是
 * **同页第二个实例挂载时会改掉第一个实例的语言** —— 这正是 A33 的负对照
 * 「模块级 activeLang…覆盖所有实例」。
 *
 * 本模块只提供**纯翻译函数**：`translate(key, lang)` 把语言作为**显式输入**。
 * "当前实例用什么语言"由实例自己的设置对象持有（见 `domain/instanceSettings.ts`），
 * 不在这里、也不在任何模块级可变量里。
 */

import type { AppLanguage } from './instanceSettings'

export type Lang = AppLanguage

/** 应用默认语言（仅在调用方没有给出默认时使用）。 */
export const DEFAULT_LANG: Lang = 'zh'

/** 支持的语言清单（用于设置 UI 与校验）。 */
export const SUPPORTED_LANGS: readonly Lang[] = ['zh', 'en']

/** 是否为受支持语言（纯校验；不读存储、不抛异常）。 */
export function isSupportedLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en'
}

/**
 * 翻译字典。
 *
 * 键是**稳定标识**（不是中文文案），与 #249 §19.7「RNA 描述保留翻译键」
 * 同一口径：改语言不改键，改键才是契约变更。
 */
const DICT: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  'file': { zh: '文件', en: 'File' },
  'edit': { zh: '编辑', en: 'Edit' },
  'view': { zh: '视图', en: 'View' },
  'help': { zh: '帮助', en: 'Help' },
  'openScene': { zh: '打开场景…', en: 'Open Scene…' },
  'newFile': { zh: '新建文件', en: 'New File' },
  'saveToFile': { zh: '保存到文件', en: 'Save to File' },
  // R1-α（#387）：工程格式的生产开/存入口标签（`adapters/files/projectFormat` 接生产）。
  'openProject': { zh: '打开工程…', en: 'Open Project…' },
  'saveProject': { zh: '保存工程', en: 'Save Project' },
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
  // M3-shell B1：菜单正式化的新标签。键位提示写**实际绑定**（inputHotkeys：Ctrl+Z / Ctrl+Shift+Z），
  // 不是设计简报里笔误的 Ctrl+Y —— 见 B1 回报的偏差项。
  'undo': { zh: '撤销 (Ctrl+Z)', en: 'Undo (Ctrl+Z)' },
  'redo': { zh: '重做 (Ctrl+Shift+Z)', en: 'Redo (Ctrl+Shift+Z)' },
  'toggleTheme': { zh: '切换主题', en: 'Toggle Theme' },
  'hover': { zh: '悬停', en: 'Hover' },
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
  'isoTime': { zh: '时间（秒）', en: 'Time (s)' },
  'takeCurrentTime': { zh: '取当前预览时间', en: 'Use current time' },
  'isoTimeInvalid': { zh: '时间必须是有限数', en: 'Time must be finite' },
  'animGif': { zh: '动画 GIF', en: 'Animated GIF' },
  'animGifDesc': { zh: '按纹理序列的一个循环逐帧渲染（同一台等轴相机）。', en: 'Renders one loop of the texture sequence frame by frame (same isometric camera).' },
  'generateGif': { zh: '生成 GIF', en: 'Generate GIF' },
  'downloadGif': { zh: '下载 GIF', en: 'Download GIF' },
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

/** 字典的键清单（供测试对账"键未随语言改变"）。 */
export const TRANSLATION_KEYS: readonly string[] = Object.keys(DICT)

/**
 * 纯翻译：`key` + `lang` → 文案。
 *
 * **找不到键时回退为键本身**（不是空串、不是英文）：这样"缺键"在 UI 上可见，
 * 且断言可以稳定地引用键。语言不是受支持值时回退应用默认语言。
 */
export function translate(key: string, lang: Lang): string {
  const entry = DICT[key]
  if (!entry) return key
  return entry[lang] ?? entry[DEFAULT_LANG] ?? key
}

/** 该键是否存在于字典（诊断/测试用）。 */
export function hasTranslation(key: string): boolean {
  return key in DICT
}
