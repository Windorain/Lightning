/** Screen 树 layout region id（与 WM 输入域 wmInputId 可能不同） */
export const REGION = {
  WORKBENCH_HEADER: 'r-header',
  WORKBENCH_TOOLSHELF: 'r-toolshelf',
  WORKBENCH_VIEWPORT: 'r-viewport',
  WORKBENCH_PROPS: 'r-props-main',
  /** Workbench「Wiki」工作区内的嵌入预览（与独立 Embed 的 r-embed 分离） */
  WIKI_PREVIEW: 'r-wiki-preview',
  EMBED: 'r-embed',
  CHROME: 'r-chrome',
} as const

/** Region.keymapId → 基础键位表预设 */
export const REGION_KEYMAP = {
  WORKBENCH_VIEWPORT: 'workbench-viewport',
  EMBED_VIEWPORT: 'embed-viewport',
} as const
