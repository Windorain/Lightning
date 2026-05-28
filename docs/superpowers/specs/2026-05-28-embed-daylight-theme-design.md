# Embed 日光主题

## 目标

为 Embed 端增加亮色主题支持，使其能嵌入 Wiki 等亮色页面。

## 约束

- 复用 `nei-tokens.css` 已有的 MC NEI 亮色设计语言
- 3D 场景背景保持不变（`#5a5a5a` / `0x5a5a5a`），仅改 UI 层
- 向后兼容：未指定主题时默认暗色

## 方案

### 1. CSS: `embed-nei-tokens.css`

在文件末尾新增 `[data-nei-theme="light"]` 选择器块，覆盖所有 `--nei-*` 变量：

| Token 组 | 暗色值 | 日光值 |
|---|---|---|
| bg-deep | `#0a0e18` | `#b0b0b0` |
| bg-panel / bg | `#1a1e28` | `#c6c6c6` |
| bg-surface | `#242830` | `#d0d0d0` |
| bg-elevated | `#2a2e38` | `#dadada` |
| bg-input | `#10141c` | `#373737` |
| inset-bg | `#12161e` | `#373737` |
| bevel-light / highlight | `#5a5e68` / `#3a4a5e` | `#ffffff` |
| bevel-dark / shadow | `#0a0e18` | `#555555` |
| border-slot | `#000000` | `#000000` (不变) |
| border-active | `#6060a0` | `#5a8c3e` |
| border-panel | `#3a3e48` | `#8b8b8b` |
| border-subtle | `#2a2e38` | `#a0a0a0` |
| text | `#e8e8e8` | `#303030` |
| text-dim | `#8a8e98` | `#606060` |
| text-id | `#98a0a8` | `#505050` |
| text-accent | `#c0c0f0` | `#2a5a1a` |
| text-mono | `#6a6e78` | `#707070` |
| text-shadow | `1px 1px 0 #0a0e18` | `1px 1px 0 rgba(255,255,255,0.6)` |
| accent | `#5050a0` | `#5a8c3e` |
| accent-glow | `rgba(80,80,160,0.25)` | `rgba(90,140,62,0.2)` |
| accent-border-light | `#8088c0` | `#7ab85e` |
| accent-border-dark | `#2a2a50` | `#3a6a2a` |
| icon-color | `#8a8e98` | `#606060` |
| icon-hover | `var(--nei-text)` | `var(--nei-text)` (自动跟随) |
| icon-active | `var(--nei-text-accent)` | `var(--nei-text-accent)` (自动跟随) |
| titlebar-sep | `#3a3e48` | `#a0a0a0` |
| scrollbar-track | `#1a1e28` | `#c6c6c6` |
| scrollbar-thumb | `#3a3e48` | `#8b8b8b` |
| viewport-bg | `#151920` | `#5a5a5a` |

以下 Token **不覆盖**（亮暗通用）：
- tooltip-bg / tooltip-border / tooltip-text / tooltip-dim（保持 MC 紫色暗底风格）
- status 色（loading/ok/warn/error）
- 尺寸 token（title-height、icon-btn-size 等）

### 2. 类型: `embedContract.ts`

```ts
export interface EmbedUiOptions {
  // ... existing fields
  /** UI 主题，默认 'dark' */
  theme?: 'light' | 'dark';
}
```

### 3. 初始化逻辑: `mount.ts`

在挂载时读取主题配置，设置 `document.documentElement.dataset.neiTheme`：

```
优先级: options.theme > html[data-nei-theme] > 默认 'dark'
```

## 不变部分

- `ViewerCore.vue` — 不改动
- `previewConfig.ts` — sceneBackground 保持 `0x5a5a5a`
- `SelectionOutlinePass.ts` — 描边颜色保持 `0xff8800`
- 所有 3D 渲染、注解颜色、材质库均不变

## 影响文件

| 文件 | 改动 |
|---|---|
| `web/src/styles/embed-nei-tokens.css` | 新增 `[data-nei-theme="light"]` 块 (~50 行) |
| `web/src/embed/embedContract.ts` | `EmbedUiOptions` 新增 `theme` 字段 |
| `web/src/embed/mount.ts` | 新增主题检测逻辑 (~5 行) |
