# Precision Workshop — 前端视觉重设计规范

## 目标

将 Lightning 工作台 + Embed 查看器的视觉语言从 NEI/Blender 复古工业风升级为 **Precision Workshop**（精密车间）。统一工作台（专业工具）和嵌入端（读者展示）的设计语言。

## 设计方向

**"工业车间"隐喻**——蓝图、钢材、精密仪器。冷钢午夜底色 + 蓝图蓝点缀。对标 Factorio / Satisfactory 的 UI 品质。

### 核心原则

- **扔掉 bevel 边框**——全部改为 1px 干净分割线
- **全局 sans-serif**——等宽字体仅保留给数据/坐标/代码
- **蓝图网格视口背景**——32px 极淡蓝线网格
- **发光状态指示**——激活态/连接态用 box-shadow glow
- **呼吸感间距**——4px 基准网格，告别拥挤控件

---

## Design Tokens (CSS Custom Properties)

### 色彩体系

| Token | 色值 | 用途 |
|-------|------|------|
| `--wb-bg-deepest` | `#0b1217` | 视口底色 |
| `--wb-bg-surface` | `#101820` | 输入框/卡片底色 |
| `--wb-bg-elevated` | `#0f161d` | 侧栏/顶栏/底栏 |
| `--wb-bg-hover` | `#1a2532` | 悬停交互态 |
| `--wb-border` | `#1a2532` | 默认边框 |
| `--wb-border-light` | `#1a3040` | 轻边框（卡片内） |
| `--wb-accent` | `#4dabf7` | 主强调色（激活/焦点） |
| `--wb-accent-muted` | `#7aa2c4` | 次级文字/标签 |
| `--wb-text` | `#c5d8e8` | 主文字 |
| `--wb-text-muted` | `#56728a` | 辅助文字 |
| `--wb-text-dim` | `#3a5068` | 最暗文字/占位 |
| `--wb-success` | `#2ecc71` | 在线/成功 |
| `--wb-danger` | `#e74c3c` | 错误/删除 |
| `--wb-danger-bg` | `#301a1a` | 危险按钮边框 |

### 字体

| 层级 | 字体 | 大小 | 用途 |
|------|------|------|------|
| Display | system-ui sans-serif | 12-14px/600-700 | 标题/品牌 |
| UI | system-ui sans-serif | 10-12px/400-500 | 标签/按钮/面板 |
| Data | ui-monospace | 10-11px | Block ID/坐标/数值输入 |
| Caption | system-ui sans-serif | 8-9px | Section header/提示 |

### 间距 & 圆角

- 基准网格: 4px
- 面板内边距: 10-12px
- 元素间距: 4-8px (gap)
- 输入框内边距: 5px 8px
- 圆角: 输入框 3px / 卡片 4-6px / 菜单 6px / toggle 10px

---

## 组件规格

### 1. WorkbenchShell

主布局壳。三栏结构（工具架 42px + 视口 flex + 属性面板 290px），顶栏 32px，底栏 26px。

- 视口背景: `#0b1217` + 32px 蓝图网格 overlay
- 分割线: 1px `#1a2532`
- 滚动条: 6px thin, track `#0d141c`, thumb `#1a2532` → hover `#4dabf7`

### 2. 菜单栏 (MenuBar)

- 高度: 32px，背景 `#0f161d`
- 品牌名左对齐，字号 12px/600
- 菜单项: `#7aa2c4`，padding 4px 10px
- 下拉菜单: `#0f161d` 底，6px 圆角，分组标签 `#3a5068` 9px uppercase
- 主题切换: 24×24 图标按钮
- 连接状态: 绿点 + glow + "Connected"

### 3. 工作空间标签 (WorkspaceTabs)

- 高度: 34px，背景 `#0d141c`
- 激活态: 底部 2px `#4dabf7` 边框 + `#c5d8e8` 文字
- 非激活: `#56728a`，透明底边

### 4. 工具架 (ToolShelf)

- 宽度: 42px，背景 `#0f161d`
- 工具按钮: 34×34，border-radius 5px，间距 3px
- 三态: inactive (透明底 + `#56728a` 图标) / active (`#151f29` 底 + `#4dabf7` 图标 + glow) / hover (`#1a2532` 底)

#### 工具图标 (原创 SVG)

6 枚图标，24×24 viewBox，1.5px stroke，round cap/join:

- **Select**: 鼠标指针多边形 `M4 4l6 16 2-6 6-2z`
- **Move**: 十字箭头 + 四向箭头尖
- **Box**: 矩形 + 十字分割线
- **Point**: 实心圆 + 虚线靶心圆
- **Line**: 斜线 + 两端实心圆点
- **Text**: 大写 T 字型 + 基线

### 5. 属性面板 (PanelTabs + UIRenderer)

- PanelTabs: 32px 高，激活态底部 2px `#4dabf7`
- 内容区: padding 10px 12px
- Section header: 9px uppercase `#3a5068`，letter-spacing 0.8px
- 渐变分割线: `linear-gradient(90deg, #1a2532, transparent)`

### 6. 表单控件 (RNAWidget)

#### 文本输入
- padding 5px 8px，border 1px `#1a2532`，bg `#101820`
- 等宽字体用于数据/坐标

#### 步进器 (Number Stepper)
- 输入框 + 右侧 ▴▾ 上下按钮
- 标准: 输入 52px + 按钮 16px 宽，每半高 13px
- 紧凑 (Vector3): 输入 40px + 按钮 13px 宽，每半高 10px
- X/Y/Z 标签: 9px `#3a5068`，内联于输入框左侧
- 步进行为: 点击 ▴/▾ 增减，拖拽输入框左右 scrubbing

#### 下拉选择
- 同文本输入样式，标准 `<select>` 外观

#### Slider
- `accent-color: #4dabf7`
- 上方: 标签 + 数值读数（右对齐，monospace, `#4dabf7`）
- 下方: 最小/最大标注（9px `#3a5068`）

#### Toggle 开关
- 32×18px 胶囊，border-radius 10px
- ON: `#4dabf7` 底 + 白色滑块靠右
- OFF: `#1a2532` 底 + `#56728a` 滑块靠左

#### 颜色选择
- 24×24 色块 + 右侧 hex 文本输入

#### 复选框 (备选)
- 16×16，标准样式，accent-color `#4dabf7`

### 7. 按钮 (OperatorBtn)

| 类型 | 边框 | 背景 | 文字 |
|------|------|------|------|
| Primary | `#4dabf7` | `#151f29` | `#4dabf7` |
| Secondary | `#1a2532` | `#101820` | `#7aa2c4` |
| Danger | `#301a1a` | `#101820` | `#e74c3c` |
| Success | `#1a2a1a` | `#101820` | `#2ecc71` |
| Disabled | `#1a2532` | `#101820` | `#3a5068` |

- padding: 6px 14px，border-radius 4px，font-size 11px
- 图标按钮: 30×30，用于 reset view 等
- 工具架按钮: 独立规格（见工具架）

### 8. 菜单 (UIMenu)

- 容器: bg `#0f161d`，border 1px `#1a2532`，radius 6px，padding 4px
- 菜单项: padding 5px 12px，hover bg `#1a2532`
- 分隔线: 1px `#1a2532`，margin 4px 8px
- 分组标签: 9px uppercase `#3a5068`
- 禁用项: `#56728a`
- 子菜单箭头: `▶` 8px

### 9. Frame 导航栏

- 容器: bg `#0f161d`，padding 10px 14px
- 控制按钮: 28×26，⏮ ◀ ▶ ⏭ 四键
- 播放按钮: 32×26，accent 样式
- 帧号输入: 44px 宽 monospace 输入框
- 帧数显示: `Frame 12 / 247`
- Scrubber: 4px 高轨道 + 关键帧刻度线 (1.5px × 10px)
- 进度填充: `#4dabf7` + 10px 圆形滑块 + glow
- Loop toggle + 方块计数 右对齐

### 10. 上下文菜单 (ContextMenu)

- 固定定位，z-index 2000
- 同菜单栏下拉样式
- 检查 / 移动选中 / 分割线 / 撤销 / 重做

### 11. 设置抽屉 (WorkbenchSettingsDrawer)

- 右侧滑入，动画 0.18s ease-out
- 宽度: min(420px, 100vw)
- 标题区: 16px padding，14px/600 标题 + ✕ 关闭按钮
- 内容区: 16px 18px padding
- 分段按钮 (Segmented): flex 均分，gap 6px，激活态 accent 边框

### 12. 状态栏 (StatusBar)

- 高度: 26px，bg `#0d141c`
- 文字: 10px `#56728a`
- 显示: 状态信息 / Layer / 尺寸

### 13. Embed 查看器

Design tokens 与工作台一致。嵌入端视觉适配:
- 更轻量的面板边框
- 方块图标侧栏（保留 MC 材质）
- LayerPreviewBar / FrameScrubber 使用相同 accent slider 风格
- Tooltip 使用工作台卡片样式

---

## 实现阶段

### Phase 1: 基础设施
- 替换全局 CSS tokens（`--nei-*` → `--wb-*`）
- 自定义滚动条 CSS
- RNAWidget 重写（步进器、toggle、slider 新样式）
- UIRenderer 样式更新

### Phase 2: 核心视觉 DNA
- WorkbenchShell 布局 + 蓝图网格
- MenuBar 新样式
- StatusBar 新样式
- WorkspaceTabs
- PanelTabs

### Phase 3: 交互组件
- OperatorBtn 五态按钮
- UIMenu 下拉/上下文菜单
- 工具架 + 6 枚 SVG 图标组件
- Frame 导航栏 + Scrubber
- 设置抽屉

### Phase 4: 面板
- 8 个 PanelDeclaration 的 layout 微调
- annotationPanel 三态控件更新
- MarkdownEditor 样式

### Phase 5: Embed 统一
- EmbedViewer / ViewerCore
- BlockStatsSidebar / BlockSlotPreview
- LayerPreviewBar / WorldFrameScrubber
- ToolTipBox

---

## 技术约束

- Vue 3 + TypeScript，不引入新依赖
- 图标: 原创内联 SVG，不依赖外部图标库
- CSS: 全部通过 custom properties 控制，支持未来亮色主题扩展
- 滚动条: `scrollbar-width: thin` (Firefox) + `::-webkit-scrollbar` (Chrome)
- 动画: CSS transition/transform，不引入 motion 库

## 不变更

- RNA 系统架构（PropertyDescriptor / RNARegistry / struct）
- Panel 声明机制（PanelDeclaration.poll / layout / owner）
- 布局引擎（computeLayout / WidgetRect）
- 事件系统 / 操作符系统 / 工具系统
- 3D 渲染管线
