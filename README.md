# Lightning

Lightning 将 Minecraft 1.7.10（GTNH）中的方块结构导出为 JSON，在浏览器中查看、编辑，并嵌入灰机 Wiki。

## 定位与边界

- 目标运行时：Minecraft 1.7.10 + Forge + GTNH；不覆盖其它版本。
- 组成：游戏内 Mod（捕获、导出、本机工作台）、Web 查看器与工作台、Wiki Gadget、格式契约与构建/验收脚本。
- 无中心服务端：不含账号、协作或数据库；分享经由 Wiki 页面与附件。
- Web 端不是 Minecraft 客户端，也不模拟游戏；客户端侧行为以游戏内真实导出为准。
- 场景产物是 JSON：Plain 场景文档或可选的 Envelope；字段与容器规则由 `docs/` 下的契约定义。

## 能力

- **捕获**：`/sde` 选区（脚下方块或准星）、逐帧记录、单结构/多帧/多方块导出，以及本机工作台服务。
- **查看（Embed）**：正交/轨道相机、方块高亮与 NEI 风格 Tooltip、注解层、日间/暗夜主题；构建为 IIFE，产物包含 `StructureRender.js` 与 `StructureRender.css`。
- **编辑（Workbench）**：打开/保存场景与工程、选择与移动、注解（包围盒/标记点/线段/文本/选面）、属性编辑、撤销/重做。
- **产出**：Plain/Envelope 场景、OBJ/MTL 与贴图 ZIP、PNG/GIF；Wiki 宿主下可加载与回存。
- **自动化**：本机 control plane HTTP 接口（`/cp/v1`）供脚本化捕获与验收使用。

## 快速开始

前置：Node.js ≥ 22.13.0、pnpm 11.28.5（`web/package.json` 固定，可用 `corepack enable`）；Mod 构建使用仓库内的 Gradle wrapper。

```powershell
cd web
pnpm install --frozen-lockfile
pnpm run dev          # Workbench 开发服务器
pnpm test             # 单元测试
pnpm run build:all    # Embed + Workbench 产物
```

```powershell
cd mod\gtnh
.\gradlew.bat build
```

完整前置与平台限制见[构建指南](docs/build-guide.md)。

没有游戏内导出文件时，可在 Workbench 的「内置示例场景」面板加载 `web/data/scenes/*.json`。

## 文档

- [文档索引](docs/README.md)：公开文档的唯一入口
- [Mod 使用说明](mod/gtnh/README.md)：`/sde` 命令与最短流程

## 许可

许可全文见 [LICENSE](LICENSE)；第三方组件与素材声明见 [NOTICE](NOTICE)。
