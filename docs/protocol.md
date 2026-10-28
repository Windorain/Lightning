# 数据协议

Lightning 的运行时契约是 JSON 文档。本文件是运行时 JSON、Plain/Envelope 容器与 proto schema 工具的唯一权威；场景字段表由[场景文件格式契约](contracts/format-scene-file.md)定义，本文件不复制。

## 运行时是 JSON，不是 protobuf

Mod 与 Web 两侧都手写 JSON 类型（Java Gson / TypeScript），运行期不进行 protobuf 序列化。`protocol/lightning/v1/`、`v2/` 下的 `.proto` 是格式的 schema 描述，供阅读、评审与可选类型生成使用，不是线路格式。

## Plain

Plain 是未包装的场景 JSON。`/sde export raw` 写出时在根上标记 `documentFormat: "Plain"`。

场景文档有两种顶层形态，判别式是顶层是否存在 `frames` 数组，而不是帧数：

| 形态 | 判别式 | 内容 |
|------|--------|------|
| World（多帧） | 顶层有 `frames` | 一个结构 + N 帧；N=1 也是 World |
| Structure（裸单结构） | 顶层无 `frames`，有 `geometryPhase`、`cellGrid`、`blockPalette` | 单帧的 `StructureData` |

字段、必填性、烘焙阶段与形态差异以[场景文件格式契约](contracts/format-scene-file.md)为准。读取端还接受带 `format_version: "2.0"` 的 V2 Plain 与无该键的 World，并在装载时归一化为运行时文档。

## Envelope

Envelope 是场景文档的可选包装，本身仍是 JSON：

```json
{
  "documentFormat": "Envelope",
  "payloadEncoding": "gzip+base64",
  "meta": { "...": "元数据" },
  "payload": "<base64(gzip(UTF-8 JSON))>"
}
```

### meta

元数据以 `meta` 为准。打包时，元数据键从正文移到 `meta`，正文不再持有同一事实；解包时，从 payload 解析出的正文剔除这些键，再与 `meta` 合并，`meta` 胜出，最终得到 Plain。

正文字段（`frames`、调色板、纹理、部件与多方块声明等）随文档形态而异，见[场景文件格式契约](contracts/format-scene-file.md)。打包只搬运文档已有的键：原本没有的键不会凭空出现。

### 编码

生产编码是 `gzip+base64`：正文序列化为 UTF-8 JSON，gzip 压缩后做 base64。读取端还接受 `base64(json)`（未压缩的 UTF-8 JSON 直接 base64），仅用于兼容读取。

解码顺序固定：base64 → 字节 → 先按 UTF-8 JSON 解析 → 失败再 gunzip。两种编码共用这一条读取路径。编码侧拒绝 Envelope 作为输入，避免嵌套包装。

不支持的 `payloadEncoding`、缺失或非对象的 `meta`、空 `payload`、非法 base64、无效 gzip 或非对象 JSON 都会显式报错，不静默降级为 Plain。

gzip 头包含 MTIME，不同实现或时刻可能产生不同字节；Envelope 的相等判据是解包后语义子树的 canonical 摘要，不是文件逐字节比较。

Mod 侧的生成入口是 `SceneEnvelopeBuilder`；Web 侧的读取入口是 `decodeEnvelope` / `readEnvelopeLayers`。

## proto schema

协议命令需要 buf CLI。

- `protocol/buf.yaml`：buf v2 模块 `buf.build/lightning/protocol`；lint 使用 `STANDARD`，breaking 检查粒度 `FILE`。
- `protocol/buf.gen.yaml`：仅注册远程插件 `buf.build/community/timostamm-protobuf-ts`，输出到 `web/src/render/proto/`（已被 `.gitignore` 忽略）。
- 生成：`npm run protocol:gen`；校验：`npm run protocol:lint`；兼容检查：`npm run protocol:breaking`（与 `main` 分支比较）。
- 没有 Java 生成插件；mod 侧没有 protobuf 生成物。
- 生成的 TypeScript 目录不被运行时代码 import，因此生成不是构建或运行的前置。

## 多方块文档

多方块为主文档有独立的判别式、通道、变体、帧与体积约束，以[多方块文档格式契约](contracts/format-multiblock-doc.md)为准。本文件只定义其外层 Plain/Envelope 容器；Envelope 的 `meta`/正文分工同样适用。

## 多帧与播放

多帧场景提供帧数据；场景的多帧自动播放未实现。World 文档的 `playback` 恒为：

```json
{ "loop": false, "defaultFrameIndex": 0 }
```

`loop` 固定为 `false`，`defaultFrameIndex` 固定为 `0`；本协议不新增多帧自动播放相关字段。消费方不得依赖多帧自动播放行为或据此实现时间轴。

## 版本与兼容

- `format_version: "2.0"` 标记 V2 Plain；生产导出的 World/Structure 以字段形态判别，不以该键是否存在为前提。
- 无 `format_version` 的 World 仍可读取，装载时归一化。
- 场景字段变更必须同步两侧手写实现与[场景文件格式契约](contracts/format-scene-file.md)；只改 proto 不产生运行时效果。
