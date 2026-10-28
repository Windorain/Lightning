# 架构

Lightning 是 Minecraft 1.7.10（GTNH）结构数据的捕获、导出与浏览器查看/编辑链路。仓库由游戏内 Mod、Web 前端、格式 schema 与测试/验收脚本组成，不包含中心服务端。

## 组件

| 路径 | 职责 | 技术 |
|------|------|------|
| `mod/gtnh/` | 游戏内捕获、烘焙、导出，本机工作台服务，控制面接口 | Java |
| `web/` | 浏览器端查看、编辑、导出与 Wiki 嵌入 | Vue 3 + TypeScript + Vite + Three.js |
| `protocol/` | 场景与信封格式的 schema 描述 | Protobuf / Buf |
| `scripts/` | Wiki Gadget、夹具、静态检查与验收编排 | Node.js / PowerShell |
| `test/` | 测试资产、判据与期望产物 | JSON / Node.js |

### mod/gtnh

- 注册 `/sde` 命令：选区、逐帧录制、单结构/多帧/多方块导出、注册表转储、本机 Web 服务。
- 客户端捕获并烘焙方块几何；`/sde export` 把帧写入游戏目录的 `structure_exports/`，默认写出 Envelope，`raw` 写出 Plain 场景。
- `/sde web [port]` 在客户端内启动仅监听 `127.0.0.1` 的 HTTP 服务：从 jar 内的 `assets/lightning/web/` 提供 Workbench，场景接口只读 `structure_exports/` 下的 JSON，工作区文档（`structure_exports/_sde_workspace.json`）可读写。服务不修改场景文件。
- 控制面在 `/cp/v1` 下提供动作、观察与用例执行接口，供脚本化捕获与验收。
- 仅支持 Minecraft 1.7.10 + Forge + GTNH。

### web

三个构建入口，产物用途不同：

| 入口 | 产物 | 用途 |
|------|------|------|
| `src/main.ts` | `dist/StructureRender.js` 与 `dist/StructureRender.css`（IIFE） | Wiki Gadget / 第三方页面嵌入 |
| `src/main-workbench.ts` | `dist-workbench/` | 完整 Workbench，供 Mod 内嵌或本地开发 |
| `src/main-wiki-workbench.ts` | `dist-wiki-workbench/bundled/StructureWorkbench.bundle.js` | Wiki 工作台 |

Embed 库导出挂载、数据校验、视图组件与场景导出辅助（`mount`、`EmbedViewport`、文档格式判别、`buildEnvelopePackage` 等），不包含 Workbench 整站。

运行时处理链路：读取 JSON → 按文档格式选择解析器（Envelope / World / V2 Plain / StructureData / Multiblock）→ 归一化为运行时文档 → Three.js 渲染。编辑侧在此之上提供选择、工具、注解、属性与撤销/重做；内核契约见 [Web 内核契约](contracts/web-kernel-contracts.md)。

### protocol

`protocol/lightning/v1/` 与 `v2/` 是场景与信封格式的 schema 描述；`buf.yaml`、`buf.gen.yaml` 只服务校验与可选的 TypeScript 类型生成。运行期两侧均手写 JSON 类型（Java Gson / TypeScript），不使用 protobuf 序列化。详见[协议](protocol.md)。

### scripts

`scripts/` 包含 Wiki Gadget 入口与样式、确定性夹具与格式校验、静态检查、控制面与验收编排、Wiki 素材审计。诊断与验收脚本不参与浏览器运行时。

### test

`test/` 存放测试资产、用例、判据与期望产物；`web/e2e/` 存放浏览器测试与真实产物解析器。资产导航见[测试资产](../test/README.md)。

## 数据流

1. **捕获**：游戏中用 `/sde` 选定区域并 `record`；客户端捕获方块几何并烘焙为场景帧。
2. **导出**：`/sde export` 把帧合并为场景文档，写入 `structure_exports/`；默认包成 Envelope，需要明文时用 `raw`。
3. **装载**：Workbench 可打开本地文件，或经 `/sde web` 读取场景；Wiki 端由 Gadget 把场景 JSON 交给 Embed 查看器。多帧文档提供帧数据；场景的多帧自动播放未实现。
4. **编辑与产出**：Workbench 修改场景（可撤销/重做），保存工程或场景，导出 OBJ/MTL 与贴图 ZIP、PNG/GIF；Wiki 宿主下可回存页面。
5. **自动化**：控制面动作按用例驱动捕获、导出与观察，产物写入运行目录；渲染与编辑本身仍在客户端或浏览器内完成。

```text
游戏内（MC 1.7.10 + GTNH）
  /sde 选区 + record
        │  捕获并烘焙几何
        ▼
  /sde export
        │  structure_exports/*.json
        ▼
  Plain 场景（World 多帧 / Structure 单结构）
        │  可选：Envelope（meta + gzip+base64 payload）
        ├──────────────────────────────┐
        ▼                              ▼
  本机 Workbench                  灰机 Wiki
  （文件 / /sde web）             （Gadget + Embed 查看器）
  查看 / 编辑 / 注解 / 导出        查看 / Tooltip / 注解
```

## 边界

- **运行时是 JSON**：`.proto` 只是 schema 文档，不被运行时代码消费；修改 proto 不改变任何一端的行为。
- **无中心服务端**：仓库不提供账号、协作或托管服务；跨用户分享经由 Wiki。
- **Web 不是 Minecraft 客户端**：浏览器测试不能替代客户端侧验证；客户端行为以游戏内真实导出为准。
- **单版本目标**：仅 Minecraft 1.7.10 / GTNH，不承诺其它版本兼容。
- **本机 Web 只读场景**：`/sde web` 只写工作区 JSON，不写场景文件；监听回环地址并校验 token。
- **多方块只读求值**：多方块声明用于装配与查看，不编辑或回写生成结果。
- **Wiki 写面受限**：保存与上传只在 Wiki 宿主外壳可用，普通本地开发不具备该环境。
- **格式与构建各有权威**：场景字段以 [场景文件格式契约](contracts/format-scene-file.md) 为准，容器以[协议](protocol.md)为准，构建与测试命令见[构建指南](build-guide.md)。
