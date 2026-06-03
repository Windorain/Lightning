/** Screen 树 layout region id（与 WM 输入域 wmInputId 可能不同） */
export const REGION = {
  WORKBENCH_HEADER: 'r-header',
  WORKBENCH_TOOLSHELF: 'r-toolshelf',
  WORKBENCH_VIEWPORT: 'r-viewport',
  WORKBENCH_PROPS: 'r-props-main',
  EMBED: 'r-embed',
  CHROME: 'r-chrome',
} as const

/** Region.keymapId → 基础键位表预设 */
export const REGION_KEYMAP = {
  WORKBENCH_VIEWPORT: 'workbench-viewport',
  EMBED_VIEWPORT: 'embed-viewport',
} as const
