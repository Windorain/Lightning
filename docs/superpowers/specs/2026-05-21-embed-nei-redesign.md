# Embed Viewer — Modern NEI Redesign

## 目标

将嵌入查看器从通用暗色风格改造为 **Modern NEI** 设计语言。基于 NEI 源码 (`ItemsGrid.java`, `PanelWidget.java`) 的真实视觉参数，保留 MC 物品栏基因但更现代。

## 设计语言

**NEI 基因 + 现代执行**——3px bevel 厚边框、18px 槽位比例、紫色 Tooltip、#555 高亮，扔掉原版 bevel 纹理改为 Web CSS 近似。

### 与 Workbench 的关系

工作台走 Precision Workshop（冷钢蓝），嵌入查看器走 Modern NEI（MC 物品栏）。两套设计语言并行，共享部分底层组件（ViewerCore 等）但 CSS token 独立。

---

## 色彩体系

### 暗色面板层级

| Token | 值 | 用途 |
|-------|------|------|
| `--nei-bg-deep` | `#0a0e18` | 视口底色 |
| `--nei-bg-panel` | `#1a1e28` | 面板底色 |
| `--nei-bg-surface` | `#242830` | 侧栏/底栏 |
| `--nei-bg-input` | `#10141c` | 输入框/槽位底 |
| `--nei-bg-hover` | `rgba(85,85,85,0.26)` | 悬停高亮 (NEI: `0xEE555555`) |

### 边框

| Token | 值 | 用途 |
|-------|------|------|
| `--nei-border-bevel-light` | `#5a5e68` | bevel 亮边 |
| `--nei-border-bevel-dark` | `#0a0e18` | bevel 暗边 |
| `--nei-border-slot` | `#000000` | 槽位黑边 |
| `--nei-border-active` | `#6060a0` | 选中边框 |
| `--nei-border-panel` | `#3a3e48` | 面板分割线 |

### 文字

| Token | 值 | 用途 |
|-------|------|------|
| `--nei-text` | `#e8e8e8` | 主文字 |
| `--nei-text-dim` | `#8a8e98` | 次级文字 |
| `--nei-text-id` | `#98a0a8` | 方块 ID |
| `--nei-text-accent` | `#c0c0f0` | 选中态文字 |
| `--nei-text-shadow` | `1px 1px 0 #0a0e18` | 标题阴影 |
| `--nei-text-mono` | `#6a6e78` | 等宽数字 |

### 功能色

| Token | 值 | 用途 |
|-------|------|------|
| `--nei-tooltip-bg` | `rgba(16,0,16,0.92)` | Tooltip 底 |
| `--nei-tooltip-border` | `#500080` | Tooltip 紫边 |
| `--nei-accent` | `#5050a0` | 播放按钮/accent |

---

## 布局结构

```
┌─ Title Bar (40px) ──────────────────────────────────────┐
│ LIGHTNING  Steam Turbine · GTNH    ↺ 📷 ⛶ | 🖥 ⚙      │
├─ Sidebar ────┬─ Viewport ───────────────────────────────┤
│ 方块类型 [12]◀│                                           │
│ ┌──┐ stonebrick│        3D Canvas                        │
│ │🧱│ 842      │                                          │
│ └──┘          │                                          │
│ ┌──┐ copper   │                                          │
│ │🔌│ 56   ◀sel│                                          │
│ └──┘          │                                          │
├───────────────┴──────────────────────────────────────────┤
│ [帧控制▾] [分层预览] [线圈类型 3] [材料变体 4]  12/247  │
│ ⏮ ◀ ▶ ⏭ | Frame [12] /247 ═══╪══════                 │
└──────────────────────────────────────────────────────────┘
```

---

## 组件规格

### 1. 标题栏

- 高度: 40px，3px bevel 底边框
- 品牌名/标题: 15px bold white，`text-shadow: 2px 2px 0 #0a0e18`
- 5 枚 SVG 图标: 24×24 viewBox，1.8px stroke，颜色 `#8a8e98`
  - 操作组: 复位 ↺ / 截屏 / 全屏
  - 分隔线: `1px #3a3e48`
  - 功能组: 工作台编辑 / 齿轮设置

### 2. 方块侧栏 (可收起)

**展开态 (220px)**:
- 标题行: 11px bold uppercase + 总数 badge + ◀ chevron
- 槽位行: 40×40 硬角槽 + 2px 黑边 + 中文名 (12px) + ID (9px `#98a0a8`) + 数量
- 选中态: `rgba(85,85,85,0.26)` 背景 + `#6060a0` 边框 + glow
- 滚动: `overflow-y: auto` + 自定义暗色滚动条

**收起态 (50px → 88px)**:
- 默认 50px 宽，纯图标列
- 溢出时自动扩展为 88px 双列
- `flex-direction: column; flex-wrap: wrap`（先填满第一列再溢出到第二列）
- 顶部 ▶ 展开箭头，底部总数 badge
- hover 时 tooltip 显示方块名

### 3. 槽位 (Slot)

基于 NEI 源码 `ItemsGrid.java:127-128`:

| 参数 | NEI | Web (2x) |
|------|-----|----------|
| 尺寸 | 18×18px | 40×40px |
| 边框 | 0.75px BLACK | 2px `#000` |
| 物品偏移 | x+1, y+1 | +2, +2 |
| 计数位置 | 右下角 | 右下角 |
| 计数字体 | MC font | monospace bold 10px |
| 计数阴影 | 无 (MC 自带) | `text-shadow: 1px 1px 0 #000` |

### 4. 底部控制栏

- Tab 栏: 34px 高，3px bevel 底边框
- 激活 Tab: 凸起 bevel 按钮，`#2a2e38` 底
- 非激活 Tab: 透明，`#6a6e78` 文字
- 数据驱动 Tab: 线圈类型/材料变体等，带计数 badge
- Tab 内容: 48px 高，播控 + 帧号输入 + scrubber

### 5. 滚动条

- 宽度: 6px
- 轨道: `#1a1e28`
- 滑块: `#3a3e48`
- 悬停: `#5050a0`
- Firefox: `scrollbar-width: thin`
- WebKit: `::-webkit-scrollbar` 伪元素

### 6. Tooltip

- 背景: `rgba(16,0,16,0.92)`
- 边框: `1px solid #500080`
- 文字: `#ffffff`, `#808080` (ID)
- 阴影: `2px 2px 0 rgba(0,0,0,0.4)`

---

## 实现阶段

### Phase 1: CSS Tokens + Embed Shell
- 创建 `embed-nei-tokens.css`
- EmbedViewer.vue 布局重写
- 标题栏 + 5 枚 SVG 图标

### Phase 2: Sidebar + Slot Grid
- 方块侧栏展开/收起逻辑
- 槽位渲染组件
- 多列溢出

### Phase 3: Bottom Dock
- 多 Tab 控制栏
- Frame 导航 + Scrubber
- 数据驱动 Tab

### Phase 4: Scrollbar + Tooltip
- 自定义滚动条
- NEI Tooltip 样式更新

## 不变更

- ViewerCore 3D 渲染管线
- EmbedShell / EmbedContext 架构
- 数据加载流程
