# Lightning

Minecraft 结构数据在线重放平台 —— 导出游戏内方块几何，在 Web 端 3D 渲染、编辑和分享。

## 架构

```
mod (Java, GTNH) 导出场景 → protocol (V2 Plain/Envelope) → web (Vue 3 + Three.js) 渲染+编辑
```

| 层 | 技术 | 产出 |
|----|------|------|
| **Web 前端** | Vue 3 + TypeScript + Vite + Three.js | Workbench SPA + Embed 嵌入库 |
| **MC Mod** | Java, Minecraft 1.7.10 + Forge + GTNH | `/sde` 命令, Web 服务, 导出管线 |
| **协议** | Buf + Protobuf → TS/Java 代码生成 | V2 Plain / Envelope |

## 目录

```
protocol/       数据协议定义
web/            前端：Embed 查看器 + Workbench 编辑器
mod/gtnh/       MC 1.7.10 GTNH Mod
scripts/        辅助脚本（灰机 Wiki gadget）
```

## 快速开始

```bash
# 前端
cd web
npm install
npm run dev              # Workbench 开发服务器
npm run build:embed      # Embed IIFE 库（Wiki 嵌入用）
npm run build:workbench  # Workbench SPA（SDE 内嵌用）
npm run test             # 单元测试

# Mod
cd mod/gtnh
./gradlew build          # 完整构建（自动触发 web build → syncWeb）
./gradlew spotlessApply  # 代码格式化
```

## Workbench — 3D 结构编辑器

受 Blender 架构启发：Operator 系统 / EventDispatcher / Tool + Gizmo / RNA 属性系统 / Panel 面板。

```
WorkbenchRoot.vue
  └─ createWorkbenchContext() — VM 组装
       ├─ SceneContext        场景数据唯一真源
       ├─ SelectionContext    选中状态
       ├─ UndoManager         撤销/重做
       ├─ ToolRegistry        工具注册+激活
       ├─ OperatorRegistry    操作符注册表
       ├─ EventDispatcher     事件路由
       ├─ RNARegistry         属性描述符+自动UI
       └─ Screen/Area/Region  布局系统
```

### 功能

- **选择工具**：单击/Shift追加/Ctrl减少/框选/按类型选择
- **移动工具**：自由移动 + 面拖拽 + Gizmo 轴向锁定
- **注解工具**：包围盒 / 标记点 / 线段 / 文本标签 / 选面
- **Tooltip 编辑**：单元格级 Tooltip 编辑，支持 § 颜色码，实时 NEI 风格预览
- **分层预览**：按 Y 层过滤显示，注解 overlay 跟随分层
- **Wiki 预览模式**：模拟 Wiki 嵌入效果的视口配置面板

## Embed — Wiki 嵌入查看器

IIFE 库，供灰机 Wiki 通过 Gadget 加载。支持：

- 3D 正交渲染 + 轨道相机（左键旋转/中键平移/滚轮缩放）
- 方块高亮 + NEI 风格 Tooltip 悬浮框
- 注解层显示/隐藏
- 日间/暗夜双主题
- 分层预览 / 多帧 World 播放
- 偏好设置持久化（localStorage）

Wiki 嵌入用法见 `scripts/huiji/Gadget-LightningRender.js`。

## Mod — `/sde` 命令

| 子命令 | 说明 |
|--------|------|
| `pos1` / `pos2` | 以脚下方块为选区角点 |
| `hpos1` / `hpos2` | 以准星指向方块为选区角点 |
| `start` | 开始导出会话 |
| `end` | 结束导出会话 |
| `record` | 将当前选区写入活动帧 |
| `export` | 写出场景文件 |
| `web` | 启动内嵌 Web 服务（Workbench SPA） |
| `webstop` | 停止 Web 服务 |
| `sel` | 选区模式（Cuboid / Extend） |

### 使用流程

1. `/sde start` 开始会话
2. 使用选择工具（`pos1/pos2` 或 `hpos1/hpos2`）划定选区
3. `/sde record` 记录当前帧
4. `/sde setname <名称>` 设置文件名
5. `/sde export` 导出场景
6. `/sde web` 启动 Web 服务，浏览器打开查看结果
