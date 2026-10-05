# T0.1 体积剖析基线

> **任务**：《Lightning 多方块接入 + 渲染器多通道 — 执行计划》T0.1。
> **目标**：建立可复用的体积剖析方法，回答"几何 / 纹理 / 网格 / 变体规则各占多少字节"。
> **依据**：计划文档为唯一依据（《需求书》原文不在仓库）。格式定义以 `protocol/lightning/v2/plain_v2.proto`、
> `protocol/lightning/v2/envelope_v2.proto` 与 `mod/gtnh/.../client/export/SceneEnvelopeBuilder.java` 为准。
> **状态**：完成。自检 1–3 全部满足（§7），且额外对仓库内**真实导出产物**（`web/e2e/fixtures/structuredata-exported-envelope.json`）做了完整分桶（§5），并给出按顶层键的子树体积/分隔符分解（§5.5）。
> **对 T0.5 的用途**：§8 给出 8 条格式层面结论，其中 F1/F2/F3/F6 直接影响 T0.5 的格式选型与体积预算；T1.4 完成前必须重跑本工具（计划 §3 T1.4「验证前置」）。

---

## 1. 产出物与用法

### 1.1 文件清单

| 路径 | 说明 |
|---|---|
| `docs/plan/volume-profile-baseline.md` | 本报告 |
| `scripts/volume-profile/volume-profile.mjs` | 剖析工具（零第三方依赖，Node ≥ 18） |
| `scripts/volume-profile/samples/*.plain.json` | **合成样例**（6 个场景 × Plain 形态） |
| `scripts/volume-profile/samples/*.envelope.json` | **合成样例**（同 6 个场景 × Envelope 形态） |
| `scripts/volume-profile/out/samples-run1.md` | 合成样例完整剖析报告（第 1 次运行） |
| `scripts/volume-profile/out/samples-run2.md` | 合成样例完整剖析报告（第 2 次运行，用于一致性比对） |
| `scripts/volume-profile/out/samples-profile.json` | 合成样例机器可读结果（含逐字段桶归属） |
| `scripts/volume-profile/out/samples-summary.csv` | 合成样例 CSV 汇总（供 T3.2 体积增长曲线） |
| `scripts/volume-profile/out/repo-fixtures.md` | 仓库内既有 fixture 剖析报告（含**真实导出产物**） |
| `scripts/volume-profile/out/repo-fixtures-profile.json` | 同上，机器可读 |
| `scripts/volume-profile/out/repo-fixtures-summary.csv` | 同上，CSV |
| `scripts/volume-profile/out/real-run1.md` | 真实产物单独剖析（确定性验证用） |

### 1.2 用法（可直接复制执行）

```bash
# ① 生成合成样例（只在需要受控对照数据时才用；会覆盖 samples/ 目录内容）
node scripts/volume-profile/volume-profile.mjs synth

# ② 剖析：接受单个文件或目录（目录递归收集 *.json），Plain 与 Envelope 都支持
node scripts/volume-profile/volume-profile.mjs analyse scripts/volume-profile/samples \
  --md  scripts/volume-profile/out/samples-run1.md \
  --json scripts/volume-profile/out/samples-profile.json \
  --csv scripts/volume-profile/out/samples-summary.csv \
  --max-paths 16

# ③ 剖析真实产物（把 <dir> 换成 /sde export 的输出目录）
node scripts/volume-profile/volume-profile.mjs analyse "<dir>"

# ④ 列出内置合成样例的用途
node scripts/volume-profile/volume-profile.mjs list
```

参数：`--md` / `--json` / `--csv` 为输出路径（可选，stdout 始终打印 Markdown）；
`--max-paths N` 控制明细表条数；`--verify false` 关闭值级自校验（7.1 万叶子的真实产物省约 1 秒）。

**幂等性**：报告正文不含时间戳，同一输入连跑两次产物**逐字节相同**（§7 自检 2）。
**退出码**：0 = 正常；2 = 路径不存在 / 无 JSON / 未知命令。

---

## 2. 剖析方法

### 2.1 为什么不能"解析成对象再算"

把 JSON 解析成对象后逐字段 `JSON.stringify` 统计，会丢掉两类东西：**结构性分隔符**与**键名本身**。真实产物里这两项合计占未压缩体积的 **43.1%**（§5.2：分隔符 13.29% + 键名 29.85%），恰恰是压缩格式设计最该看的地方。因此本工具改为**扫描原始文本、按字节区间归户**：

1. **单遍文本扫描**（`scanLocators`）：深度优先遍历 JSON 文本，为每个叶子值记录 `[start, end)` 字节区间与其精确路径。空容器（`{}` / `[]`）补一条零字节占位 locator，用于键名归属。
2. **规则分类**（`BUCKET_RULES`）：把"数组下标无关"的归一化路径（`$.a[0].b` → `$.a[].b`）按**最长前缀**匹配到桶。规则表即桶映射表（§3），唯一真源。
3. **三分解闭合**：`Σ叶子 token + 分隔符 + 键名 = 去结构性空白后的文件字节`。不闭合即报错（实际全部闭合）。
4. **重建断言**：`JSON.stringify(JSON.parse(text)) === 去结构性空白后的原文`。不等价即说明扫描器/剥离器与真实 JSON 语义有出入——开发期正是靠它发现"剥离空白时误伤字符串内空格"的 bug（`"Synthetic A-small"` 被压成 `"SyntheticA-small"`）。
5. **值级自校验**（`verifyLocators`）：把每个叶子 token 的原文用 `JSON.parse` 求值，与 DOM 中同路径取值逐一比对。真实产物 7.1 万个叶子全部一致——开发期靠它发现并修掉了 122 处路径歧义（NBT 键 `extRM.DOWN` 含 `.`，被字符串路径切错）。
6. **压缩形态**：`zlib.gzipSync(level 9)` 重算 gzip，base64 用标准编码重算，均为确定性，不依赖系统工具。

**为什么要保留"原始键 token"**：真实产物的 NBT 里存在形如 `extRM.DOWN`、`gt.covers[0].id` 的键。若用 `$.a.b.c` 拼接路径，这些键会被误当成分段。工具对每个键保存原始文本 token（含引号转义），取值时精确回读，路径永不含歧义。

### 2.2 口径定义

| 口径 | 定义 | 用途 |
|---|---|---|
| **落盘字节** | 文件实际字节数 | 用户感知的真实体积 |
| **未压缩 JSON 字节** | 去掉字符串外的空白后的字节数 | **分桶统计口径**（三分解之和 = 此值） |
| **gzip 字节** | 对未压缩 JSON 跑 `gzip(level 9)` 的字节数 | Envelope 形态 payload 的真实内容 |
| **base64 字节** | `base64(gzip)` 的字节数 | Envelope 形态 payload 字符串本体 |
| **分隔符字节** | 结构性 `{` `}` `[` `]` `,` `:` 的字符数（字符扫描得到，**跳过字符串字面量**） | 结构开销 |
| **键名字节** | 所有 `"key"` token（不含其后的 `:`） | 键名开销 |

> 三分解闭合关系：`Σ叶子 + 分隔符 + 键名(不含冒号) = 未压缩 JSON`。工具按此断言，且报告中同时打印各方与合计以便复核（工具内部把冒号计入分隔符、键名 token 按 `"key":` 计，报表展示时做了换算，避免重复计数——这个 1 列的重复曾是开发期的偏差来源，已在报告中显式拆开）。

对 Envelope 输入，工具**同时**输出两层：外层信封分解（payload / meta / 骨架）+ 把 payload 解压后的内层 JSON 完整分桶（这才是"几何/纹理占多少"的真实答案）。

---

## 3. 桶映射表（字段路径 → 桶）

匹配规则：对叶子路径 P（数组下标归一化后），取**路径段数最多**且满足 `P == field` 或 `P` 以 `field + "."` / `field + "["` 开头的规则。`[]` 表示任意数组下标。

| 桶 (`bucket`) | 汇总桶 (`rollup`) | JSON 字段路径 (`field`) | 实际收走的字段 |
|---|---|---|---|
| `palette.geometry` | `geometry` | `$.blockPalette[].geometry`<br>`$.frames[].structure.blockPalette[].geometry` | `encoding`、`quads[].materialIndex`、`quads[].vertices[].{x,y,z,u,v,brightness,color}` |
| `palette.meta` | `palette` | `$.blockPalette`<br>`$.frames[].structure.blockPalette` | `registryId`、`meta`、`facing`、`nbt.*`、`thumbnailPNG`、`renderMode`、`occludesAdjacentFaces`、`tooltip[]` |
| `grid.cellGrid` | `grid` | `$.cellGrid`<br>`$.frames[].structure.cellGrid` | `cellGrid[][][]` 全部元素 |
| `grid.cellTooltipGrid` | `grid` | `$.cellTooltipGrid`<br>`$.frames[].structure.cellTooltipGrid` | `cellTooltipGrid[][][]` 全部元素 |
| `texture.blobs` | `texture` | `$.textureBlobs`<br>`$.frames[].structure.textureBlobs` | 每条 base64 PNG 字符串（含 JSON 引号） |
| `material.entries` | `material` | `$.materialPalette`<br>`$.frames[].structure.materialPalette` | 材质条目全字段（`locator`/`atlas`/`kind`/`blend`/`textureBlobIndex`…） |
| `pool.tooltip` | `pools` | `$.tooltipPalette`<br>`$.frames[].structure.tooltipPalette` | 共享 ToolTip 文案池 |
| `annotations` | `annotations` | `$.annotations` | 注解全字段 |
| `labels` | `annotations` | `$.labels` | 标签全字段 |
| `stats` | `annotations` | `$.stats` / `$.statsTemplate` / `$.stats_template` | 统计模板 |
| `frames.meta` | `frames_meta` | `$.frames` | **兜底**：未被上面更长前缀收走的帧内字段（`index`/`label`/`durationMs` 等） |
| `doc.meta` | `doc_meta` | `$.meta`、`$.format_version`、`$.schemaVersion`、`$.id`、`$.label`、`$.author`、`$.gtnhVersion`、`$.description`、`$.modSource`、`$.mode`、`$.structureId`、`$.playback`、`$.globalConfig`、`$.source`、`$.axis`、`$.initialCamera`、`$.scanBounds`、`$.sdeCellNotes`、`$.geometryPhase`、`$.frames[].structure.geometryPhase`、`$.documentFormat`、`$.payloadEncoding` | 文档级元数据 |
| `other:<路径>` | `other` | （未登记路径兜底） | 兜底桶名带实际路径，因此**任何字节仍可追溯**；真实产物与合成样例中均为空 |
| （分隔符 / 键名） | — | `{}` `[]` `,` `:` 与所有 `"key"` | 单列成行，不摊入任何桶 |

**按设计排除在分桶之外的项**：Envelope 外层的 `$.payload`（base64 blob 本体）与 `$.meta.*`。理由：外层是**传输封装**，其内容已在"内层 payload 剖析"里被完整拆解；外层体积在"信封分解"表里单独给出。若把 `$.payload` 计入分桶，会把 99.9% 的体积塞进一个不可解释的桶。

---

## 4. 样例数据来源标注（**必读**）

| 文件 | 来源 | 说明 |
|---|---|---|
| `scripts/volume-profile/samples/*.json` | **合成样例**（本工具生成） | 由 `synth` 子命令确定性生成；字段顺序、字段名、几何/纹理形状按 §4.1 的仓库代码对齐；**不是任何一次真实 `/sde export` 的产物** |
| `web/e2e/fixtures/structuredata-exported-envelope.json` | **真实产物**（仓库内既有） | 204,887 B；`meta.source = "StructureDataExporter scan"`、内层 `mode = "multiblock"`、`geometryPhase = "baked"`、`scanBounds = {minX:-91,maxY:62,minZ:20}`；由 `/sde export` 的信封分支（`SceneEnvelopeBuilder.toEnvelope` 的 else 分支）写出 |
| `web/e2e/fixtures/minimal-v2.json` | **手工构造的最小 fixture** | 3,278 B；用于验证工具对 pretty-print 输入的鲁棒性 |

> 凡涉及"真实体积"的结论，一律以 §5 的真实产物为准；§6 的合成样例只用于**受控对照**（隔离单一变量），其绝对字节数不代表真实游戏场景。

### 4.1 合成样例的建模依据（保证形状可信）

- `blockPalette` 条目字段与**顺序**：`MeshCaptureService.java` L580–624（`registryId` → `meta` → `facing?` → `nbt?` → `thumbnailPNG?` → `renderMode` → `geometry` → `occludesAdjacentFaces` → `tooltip`），air 条目见 L649–659。
- 几何：`geometry = { encoding: "bakedQuadsJsonV1", quads: [{ materialIndex, vertices: [{x,y,z,u,v,brightness,color}] }] }`，见 `bakedQuadsGeometryFromCapture`（同文件 L794–818）。
- `textureBlobs`：标准 base64 PNG 字符串数组（`TextureBlobEmbedder` L116）。合成样例用 **16×16、逐像素伪随机（近不可压缩）** 的 PNG，避免纯色块让 gzip 表现虚高——真实 MC 纹理多为手绘噪点，此建模更保守。
- `materialPalette` 条目：`{ locator, atlas, blendMode, textureBlobIndex }`（`TextureBlobEmbedder` L74–110）。真实产物里出现的键名是 `kind`/`blend`，两者都被 `material.entries` 收走。
- `meta`：V2 定义为 `{name, author, created_at_ms, description, tags, origin}`（`plain_v2.proto` L19–27）。
- **Plain 形态额外把首帧的 `cellGrid`/`blockPalette`/`cellTooltipGrid` 展开到根级**：这是 `RuntimeDocument.serialize()` 的真实行为（`web/src/context/runtimeDocument.ts` L134–144，为兼容 `loadStructureData` 直读顶层字段）。不做这一步，Plain 形态会被低估约一倍。
- Envelope 包装按 `SceneEnvelopeBuilder.toEnvelope`：meta 收元数据键、inner 收 `frames`/`materialPalette`/`blockPalette`/`textureBlobs`/`tooltipPalette`，`gzip + base64` 后放入 `payload`，`payloadEncoding = "gzip+base64"`。

### 4.2 合成样例矩阵（受控对照设计）

| 样例 | 构造 | 隔离的变量 |
|---|---|---|
| `A-small-shell` | 7×5×7 中空壳，6 种方块状态，4 材质，42 quad | 基线 |
| `B-medium-solid` | 15×11×15 实心为主，14 状态，12 材质，127 quad，含 `cellTooltipGrid` | 规模 ↑（网格 + 调色板几何 ↑） |
| `C-large-solid` | 31×17×31 实心为主，24 状态，24 材质，240 quad | 规模 ↑↑ |
| `D-texture-only` | 3×3×3、仅 3 状态、**96 材质** | 纹理变量（其他压到最小） |
| `E-frames8` | 8 帧逐级变大、共享同一 `blockPalette` | 帧/变体数变量 |
| `F-decorated` | A + 2 注解 + 2 标签 | 注解/标签变量 |

---

## 5. 剖析结果：真实产物（`web/e2e/fixtures/structuredata-exported-envelope.json`）

**数据来源：真实产物**（§4）。完整报告见 `scripts/volume-profile/out/repo-fixtures.md`。

### 5.1 三种形态的体积

| 形态 | 字节 | 相对未压缩 |
|---|---:|---:|
| **落盘（Envelope 文件）** | **204,887** | — |
| 其中：`payload` base64 字符串 | 204,612 | — |
| 其中：信封骨架 + `meta`（`meta` 本体 130 B） | 275 | — |
| payload 解 base64 → gzip 流 | 153,458 | — |
| payload 解压 → 内层未压缩 JSON | 1,333,749 | 100% |
| 内层重新 gzip(level 9) | 151,423 | 11.35% |
| 内层重新 gzip 后 base64 | 201,900 | — |

> **未压缩 JSON 1.30 MiB → 落盘 200 KiB（6.5×）**。mod 侧实际 gzip 流比 node zlib level 9 重压**多 2,035 字节（+1.34%）**，见 §8 F7。

### 5.2 内层未压缩 JSON 的三分解

规模：`cellGrid` 19×6×7 = 798 格（非空 173），`blockPalette` 68 条，quad 2,207，`materialPalette` 62 条，`textureBlobs` 57 条。

| 组成 | 字节 | 占未压缩 | 说明 |
|---|---:|---:|---|
| 叶子值（所有标量/字符串 token） | 758,375 | **56.86%** | 真正的"数据" |
| 分隔符（`{}` 28,742 + `[]` 5,052 + `,` 71,319 + `:` 72,158） | 177,271 | **13.29%** | 结构开销 |
| 键名（72,158 个 `"key"`） | 398,103 | **29.85%** | `"brightness"` 这类字段名 |
| **Σ** | **1,333,749** | **100%** | 闭合（`758,375 + 177,271 + 398,103 = 1,333,749`） |

**最贵的 14 个键名**（同一键名在整个文档中累加）：

| 键名 | 出现次数 | 字节 | 平均 |
|---|---:|---:|---:|
| `brightness` | 8,828 | 114,764 | 13.0 |
| `color` | 8,828 | 70,624 | 8.0 |
| `x` / `y` / `z` | 各 8,894 | 各 35,576 | 4.0 |
| `materialIndex` | 2,207 | 35,312 | 16.0 |
| `u` / `v` | 各 8,828 | 各 35,312 | 4.0 |
| `occludesAdjacentFaces` | 68 | 1,632 | 24.0 |
| `textureBlobIndex` | 62 | 1,178 | 19.0 |
| `thumbnailPNG` | 67 | 1,005 | 15.0 |
| `registryId` / `renderMode` | 各 68 | 各 884 | 13.0 |

> **键名比数据本身更值得优化**：8,828 个顶点把 `"brightness":` 重复写了 8,828 次，累计 114,764 B——比全部 `x` 坐标之和（87,180 B）还贵。这是"对象化的顶点"带来的固有开销（§8 F6）。

### 5.3 内层未压缩 JSON 的分桶

| 桶 | 字节 | 占未压缩 | 每 quad | 每格 |
|---|---:|---:|---:|---:|
| `palette.geometry` | 533,990 | **40.04%** | 241.95 | 669.16 |
| `texture.blobs` | 135,662 | **10.17%** | 61.47 | 170.00 |
| `palette.meta` | 81,280 | 6.09% | 36.83 | 101.86 |
| `material.entries` | 4,508 | 0.34% | 2.04 | 5.65 |
| `grid.cellTooltipGrid` | 1,586 | 0.12% | 0.72 | 1.99 |
| `grid.cellGrid` | 897 | **0.07%** | 0.41 | 1.12 |
| `pool.tooltip` | 398 | 0.03% | 0.18 | 0.50 |
| `doc.meta` | 54 | 0.00% | 0.02 | 0.07 |
| （分隔符 + 键名） | 575,374 | 43.14% | 260.71 | 721.02 |
| **Σ** | **1,333,749** | 100.00% | | |

**桶 → 字段证据（该产物中最重的叶子路径）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 57 | 135,662 | texture.blobs |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 8,828 | 87,180 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 8,828 | 81,558 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 8,828 | 81,014 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 8,828 | 77,104 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 8,828 | 73,678 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 8,828 | 65,808 | palette.geometry |
| `$.blockPalette[].thumbnailPNG` | 67 | 62,750 | palette.meta |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 8,828 | 62,672 | palette.geometry |
| `$.blockPalette[].tooltip[]` | 239 | 8,634 | palette.meta |
| `$.blockPalette[].geometry.quads[].materialIndex` | 2,207 | 3,752 | palette.geometry |
| `$.blockPalette[].registryId` | 68 | 2,290 | palette.meta |
| `$.materialPalette[].locator` | 62 | 2,179 | material.entries |
| `$.cellTooltipGrid[][][]` | 798 | 1,586 | grid.cellTooltipGrid |
| `$.cellGrid[][][]` | 798 | 897 | grid.cellGrid |

### 5.4 gzip 后的桶分布（真正决定落盘体积的那一层）

gzip 是流式的，逐字段精确归户不可加；下表用**单键增量法**（单独 gzip 该顶层键 − 空文档 gzip 基线的 2 B）：

| 顶层键 | gzip 增量字节 | 占 gzip 总量 |
|---|---:|---:|
| `blockPalette` | 104,184 | **68.8%** |
| `textureBlobs` | 44,759 | **29.6%** |
| `materialPalette` | 1,125 | 0.7% |
| `tooltipPalette` | 298 | 0.2% |
| `cellGrid` | 221 | 0.1% |
| `cellTooltipGrid` | 102 | 0.1% |
| 其他（`source`/`scanBounds`/`geometryPhase`/`mode`） | 131 | 0.1% |
| 信封 + gzip 头等余量 | 1,654 | 1.1% |

> **结论：真实产物的体积 ≈ 调色板（几何 + 缩略图 + NBT）69% + 纹理 30% + 其他 1%。`cellGrid` 在 gzip 后只占 0.1%——网格不是体积问题，调色板才是。**

### 5.5 按顶层键的子树体积与分隔符（一句话看清"括号花在哪"）

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | 分隔符合计 | 分隔符占子树 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `blockPalette` | 1,179,471 | **88.43%** | 14,224 | 2,421 | 71,622 | 174,042 | 14.8% |
| `textureBlobs` | 135,720 | 10.18% | 0 | 1 | 0 | 58 | 0.0% |
| `materialPalette` | 10,743 | 0.81% | 144 | 3 | 522 | 1,329 | 12.4% |
| `cellTooltipGrid` | 2,483 | 0.19% | 0 | 50 | 0 | 897 | 36.1% |
| `cellGrid` | 1,794 | 0.13% | 0 | 50 | 0 | 897 | 50.0% |
| `tooltipPalette` | 171 | 0.01% | 0 | 1 | 0 | 17 | 9.9% |
| `source` / `scanBounds` / `mode` / `geometryPhase` | 88 | 0.01% | — | — | — | 10 | — |

> `blockPalette` 的 14,224 个对象 + 2,421 个数组 = **16,645 个容器**，贡献了 174,042 B 分隔符（占全文档分隔符 177,271 B 的 **98.2%**）。→ 结构开销的战场在方块调色板的几何对象层级，不在网格。

### 5.6 按顶层键的 gzip 贡献（同 §5.4，此处并列便于对照）

见 §5.4 表。

---

## 6. 剖析结果：合成样例矩阵（受控对照）

**数据来源：合成样例**（§4.1/§4.2），用于隔离单变量。完整报告见 `scripts/volume-profile/out/samples-run1.md`。

### 6.1 汇总表

| 样例 | 形态 | 落盘 | 未压缩 | gzip | base64 | gzip% | 帧 | 尺寸 | 格数 | palette | quad | 材质 | blob |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| A-small-shell | Plain | 37,103 | 37,102 | 5,420 | 7,228 | 14.6% | 1 | 7×5×7 | 245 | 7 | 42 | 4 | 4 |
| A-small-shell | **Envelope** | **7,247** | 7,184 | 5,433 | 7,244 | 75.6% | 1 | — | — | — | — | — | — |
| B-medium-solid | Plain | 132,428 | 132,427 | 15,657 | 20,876 | 11.8% | 1 | 15×11×15 | 2,475 | 15 | 127 | 12 | 12 |
| B-medium-solid | **Envelope** | **21,138** | 21,075 | 15,743 | 20,992 | 74.7% | 1 | — | — | — | — | — | — |
| C-large-solid | Plain | 281,716 | 281,715 | 30,250 | 40,336 | 10.7% | 1 | 31×17×31 | 16,337 | 25 | 240 | 24 | 24 |
| C-large-solid | **Envelope** | **40,023** | 39,960 | 30,010 | 40,016 | 75.1% | 1 | — | — | — | — | — | — |
| D-texture-only | Plain | 144,776 | 144,775 | 93,590 | 124,788 | 64.6% | 1 | 3×3×3 | 27 | 3 | 5 | 96 | 96 |
| D-texture-only | **Envelope** | **124,226** | 124,163 | 93,541 | 124,724 | 75.3% | 1 | — | — | — | — | — | — |
| E-frames8 | Plain | 420,171 | 420,170 | 21,060 | 28,080 | **5.0%** | **8** | 19×11×19 ↓ | 16,032 | 104 | 768 | 10 | 10 |
| E-frames8 | **Envelope** | **27,967** | 27,904 | 20,028 | 26,704 | 71.8% | **8** | — | — | — | — | — | — |
| F-decorated | Plain | 39,618 | 39,617 | 5,994 | 7,992 | 15.1% | 1 | 7×5×7 | 245 | 7 | 42 | 4 | 4 |
| F-decorated | **Envelope** | **7,393** | 7,330 | 5,542 | 7,392 | 75.6% | 1 | — | — | — | — | — | — |

### 6.2 各样例分桶（未压缩 JSON 口径）

| 样例 | `palette.geometry` | `texture.blobs` | `palette.meta` | `grid.cellGrid` | `grid.cellTooltipGrid` | `material.entries` | `annotations`+`labels` | 分隔符 | 键名 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-small-shell | 7,728 (20.8%) | 5,376 (14.5%) | 622 (1.7%) | 490 (1.3%) | 0 | 231 (0.6%) | 0 | 18.9% | 40.9% |
| B-medium-solid | 23,192 (17.5%) | 16,124 (12.2%) | 1,456 (1.1%) | 6,362 (4.8%) | 9,612 (7.3%) | 678 (0.5%) | 0 | 22.8% | 33.4% |
| C-large-solid | 43,902 (15.6%) | 32,224 (11.4%) | 2,568 (0.9%) | 47,836 (17.0%) | 0 | 1,356 (0.5%) | 0 | 25.0% | 29.4% |
| D-texture-only | 998 (0.7%) | **128,748 (88.9%)** | 200 (0.1%) | 54 (0.0%) | 0 | 5,570 (3.8%) | 0 | 1.4% | 4.7% |
| E-frames8 | 79,002 (18.8%) | 13,440 (3.2%) | 5,742 (1.4%) | 22,000 (5.2%) | 39,343 (9.4%) | 524 (0.1%) | 0 | 26.0% | 35.7% |
| F-decorated | 7,728 (19.5%) | 5,376 (13.6%) | 618 (1.6%) | 490 (1.2%) | 922 (2.3%) | 223 (0.6%) | **369 (0.9%)** | 19.7% | 39.5% |

### 6.3 合成样例读出的规律

1. **纹理是唯一不可压的桶**：D（96 材质、几乎无几何）落盘 124,226 B，其中 `texture.blobs` 128,748 B，gzip 只压到 93,541 B（gzip% = 64.6%，而其他样例是 5%–15%）。→ 纹理体积几乎是"加法"，任何"多通道 × 多运行态"的变体都必须**共享同一份纹理池**才可控（计划 §2 T0.5 硬约束 5 正是并集去重）。
2. **键名与分隔符的开销随"对象/数组元素个数"线性增长，与语义无关**：D（只有 96 个 blob + 5 个 quad）的键名+分隔符只占 6.1%；A 的顶点/四边形密度高，键名+分隔符就占 59.8%。→ 结构开销的优化对象是**几何的对象层级**（每个 quad 一个对象、每个顶点一个对象），不是 cellGrid。
3. **E-frames8 证明"跨帧共享调色板"几乎免费**：8 帧、104 个 palette 条目引用、768 quad，`palette.geometry` 只有 79,002 B（1 份调色板几何），`frames.meta` 仅 73 B（8 帧的 `index`/`label`/`structure` 包装）。若朴素地**每帧复制一份完整 structure**，这一项会变成 8 × 79 KB ≈ 632 KB（约 8×）。→ 这是需求 C「不组合展开」在**帧**维度上的现成正面证据，T0.5 必须把该机制延续到"多方块变体"维度。
4. **网格本身很便宜，网格的括号也不贵**：C 的 `cellGrid` 47,836 B 里，数值 token 约 16,337 × 1.1 ≈ 18 KB，其余是嵌套数组的括号与逗号；`cellTooltipGrid` 同理。E 的 8 帧 `cellGrid` 合计 22,000 B，占 5.2%。→ 网格表示方式的优化上限只有个位数百分比（§8 F2）。
5. **注解/标签可忽略**（F：369 B，0.9%）。T0.5 无需为注解体积做特殊设计。

---

## 7. 自检

### 7.1 自检 1：每个字节桶可追溯到具体 JSON 字段

- **映射表**：§3 给出 `field → bucket` 的完整规则表，且该表就是工具里的 `BUCKET_RULES` 常量（唯一真源，不存在"报告写一套、代码跑一套"）。
- **可追溯的下钻证据**：每份报告都有「最大字段族」表，逐行给出**字段路径 → 字节 → 桶**（真实产物 15 行见 §5.3；完整 20 行见 `out/repo-fixtures.md`）。
- **兜底不丢字节**：未登记路径落入 `other:<实际路径>`，桶名自带路径，永远可追溯。真实产物与全部合成样例中 `other` 桶均为 0 字节。
- **三分解闭合**：全部 23 次分析（含 Envelope 内层下钻）均报闭合，且无任何 `不一致 / 不闭合` 字样。真实产物实例：
  `Σ叶子 758,375 + 分隔符 177,271 + 键名(不含冒号) 398,103 = 1,333,749`，与去空白原文完全相等。
- **值级自校验**：全部 23 次分析均报「全部一致」（真实产物 7.1 万个叶子逐一与 DOM 比对）。

### 7.2 自检 2：同一文件重复剖析两次结果一致

同一输入连跑两次，Markdown 报告**逐字节相同**（报告正文刻意不含时间戳）：

| 输入 | 运行 | SHA-256 |
|---|---|---|
| `scripts/volume-profile/samples/`（12 文件） | 第 1 次 → `out/samples-run1.md` | `D3CBF1DDB88B1A9D3EC308E17E39D44A06DACDB016FC7C2DFAA3E567BD5E1F74` |
| 同上 | 第 2 次 → `out/samples-run2.md` | `D3CBF1DDB88B1A9D3EC308E17E39D44A06DACDB016FC7C2DFAA3E567BD5E1F74` |

```
PS> Get-FileHash scripts/volume-profile/out/samples-run1.md,scripts/volume-profile/out/samples-run2.md | Select Hash
Hash
----
D3CBF1DDB88B1A9D3EC308E17E39D44A06DACDB016FC7C2DFAA3E567BD5E1F74
D3CBF1DDB88B1A9D3EC308E17E39D44A06DACDB016FC7C2DFAA3E567BD5E1F74
PS> Compare-Object (Get-Content ...run1.md) (Get-Content ...run2.md)   # 无输出
```

**确定性来源**：不引入时间/随机/文件系统顺序依赖（目录按文件名排序；`gzipSync` 不写 mtime；无并发；无 locale 依赖的格式化）。

### 7.3 自检 3：V2 plain 与 Envelope 两种输入都能工作

| 输入形态 | 是否支持 | 证据 |
|---|---|---|
| V2 plain JSON（compact，真实产物的内层形态） | ✅ | 真实产物内层 1,333,749 B 完整分桶（§5.2/§5.3） |
| V2 plain JSON（pretty-print，带缩进/换行） | ✅ | `web/e2e/fixtures/minimal-v2.json`：落盘 3,278 / 去空白 1,761，空白字节单列 1,517 |
| Envelope（gzip+base64，紧凑单行） | ✅ | 真实产物 204,887 B 外层分解 + 内层下钻（§5.1–5.4） |
| Envelope（payload 结构相同但外层格式化） | ✅ | 6 个合成 envelope 样例（缩进 2 空格），外层分隔符 20 B |

**同一逻辑场景的两种形态可直接对照**：每个合成场景同时产出 `*.plain.json` 与 `*.envelope.json`。例：A-small-shell 的内层未压缩 36,507 B vs Plain 形态 37,102 B，差 595 B——等于根级重复的 `cellGrid`/`blockPalette`/`cellTooltipGrid`（信封形态把它们移出了内层，只保留帧内一份）。

### 7.4 自检 4（超出要求）：真实产物端到端复算

对 `web/e2e/fixtures/structuredata-exported-envelope.json`：
- payload base64 → gzip 流**逐字节回环一致**（`payloadBase64RoundTripExact = true`，sha256 `96d65f1c…8f1f89`）；
- 用独立实现（node zlib level 9）重压内层 JSON 得 151,423 B，与 mod 侧写出的 153,458 B 差 **−2,035 B（mod 侧重 1.34%）**——这是 T1.4 可用的"压缩器开销"基线（§8 F7）。

---

## 8. 格式层面体积热点（对 T0.5 有直接意义的观察）

> 每条标注**证据**与**对 T0.5 的动作建议**。F1–F3、F6 建议在 T0.5 定稿时逐条回应，并把结论写进 `docs/contracts/format-multiblock-doc.md`。

**F1｜因子化必须发生在信封之内，且绝不能"每变体一份调色板"。**
- 证据（真实产物，gzip 后）：`blockPalette` 68.8% + `textureBlobs` 29.6% = **98.4%**；`cellGrid` + `cellTooltipGrid` 合计 0.2%。
- 动作：T0.5 硬约束 4/5（骨干 + 差异规则、调色板并集去重）是**体积的主要杠杆**。只要每个变体的调色板增量是"新方块状态的几何"而非"整份调色板的副本"，体积就随"取值数之和"增长而非"组合数"。E-frames8 已证明帧维度上现成机制有效（§6.3 第 3 条）。

**F2｜网格字段：不要为"压缩网格表示"投入 T0.5 的设计预算——收益只有个位数百分比。**
- 证据（工具口径，各自独立、可复核）：真实产物 `grid.cellGrid` 桶 **897 B（0.07%）**、`grid.cellTooltipGrid` 桶 **1,586 B（0.12%）**；gzip 后两键合计 **323 B（0.2%）**。而 `blockPalette` 一个键就吃掉未压缩的 88.43%（1,179,471 B）与 gzip 的 68.8%（§5.2–5.4）。
- 受控实验（把网格换成扁平一维后重算，真实产物 + 4 个合成样例）：
  A-small 未压缩 −0.5% / gzip −1.38%，B-medium −0.5% / −1.63%，C-large −0.8% / −1.65%，E-frames8 −0.6% / −2.99%。
- 动作：T0.5 的网格字段**沿用既有约定**即可，表示方式不是体积杠杆；把设计预算放到 F1/F3/F6。
- 形态确认：真实产物的 `cellGrid` / `cellTooltipGrid` 均为数组（`Array.isArray` 为真），`runtimeDocument.ts` `_fromV2CellGrid` 的 `cellGrid[z][row][x]` 读法与之兼容。工具新增的「按顶层键的子树体积与分隔符」表（见 `out/repo-fixtures.md`）可作为该项的独立佐证。

**F3｜`thumbnailPNG` 是"元数据里的隐藏纹理"，必须显式决策。**
- 证据：真实产物 `$.blockPalette[].thumbnailPNG` = 62,750 B / 67 条（平均 936 B/条），占未压缩 4.7%；与 `textureBlobs` 一样**不可压**（都已是 PNG）。键名 `thumbnailPNG` 本身还另计 1,005 B。合成样例未包含它，故 §6.2 的调色板占比是**低估**。
- 动作：T0.5 应明确 thumbnail 的去留与复用策略（例如：与 `textureBlobs` 共用同一 blob 池，或导出时可关闭）。多方块全量导出会把这个数字乘以方块状态数，是 T3.2 体积预算里必须先算清的一项。

**F4｜Plain 形态存在根级/帧内重复，Envelope 形态消除了它。**
- 证据：`RuntimeDocument.serialize()` 会把首帧的 `cellGrid`/`blockPalette`/`cellTooltipGrid` 展开到根级；合成 A-small-shell 因此从信封内层的 36,507 B 膨胀到 37,102 B。
- 动作：多方块文档**必须走 Envelope 分支**，不要复用 Plain 的"根级展开"约定；T2.3 的 round-trip 也不要把这个展开写回新格式。

**F5｜多帧 = 结构复制，成本与帧数线性；这是需求 C 要消灭的模式。**
- 证据：E-frames8 若朴素地每帧复制 structure，`palette.geometry` 将从 79,002 B 涨到约 632 KB（8×）。当前共享调色板时，8 帧的额外成本只有 `frames.meta` 73 B + 各帧 `cellGrid`。
- 动作：T0.5 的"变体帧 ↔ 通道取值组合"映射必须只存**差异**。建议 T1.4 完成后用本工具对"取值数 +1 / 通道数 +1"两组对照导出重跑，直接产出增量字节，作为 T3.2 判定式的输入。

**F6｜键名（29.9%）比顶点数值更值得优化——"对象化顶点"是最大的可压缩结构。**
- 证据：真实产物键名合计 398,103 B（29.85%）。单看 `brightness`：8,828 次 × 13 B = **114,764 B**，比全部 `x` 坐标之和（87,180 B）还贵；`color` 键名 70,624 B，而它承载的值多数是同一个常量 `16777215`。键名在 gzip 下能压得很好（`blockPalette` 整块 gzip 后仅 104,184 B），但它是**未压缩体积与解码成本**的主要来源。
- 动作（对 T0.5 的格式建议，属可选优化）：
  1. 顶点改为**位置数组**（`[x,y,z,u,v,brightness,color]`）而非对象，一次性消掉全部顶点级键名（本例约 470 KB 未压缩）；
  2. `brightness`/`color` 提到条目级默认值，缺省时省略（本例 `brightness` 8,828 次全是 0.85）；
  3. 顶点坐标量化（本例 `x/y/z` 平均 9.2–9.8 B，说明小数位过长）。
  这三条都不影响 web 侧"查表 + 索引、零求值"的硬约束。

**F7｜mod 侧 gzip 比 node zlib level 9 重 1.34%，有一个便宜的收益。**
- 证据：真实产物 mod 侧 gzip 流 153,458 B vs 同内容 node `gzipSync(level 9)` 151,423 B。
- 动作：`SceneEnvelopeBuilder` 用的是默认 `GZIPOutputStream`（未显式设 level）。若 T1.4 的产物走信封，可在 mod 侧显式 `setLevel(9)`（约省 1.3% 落盘体积，零格式变更）。**不阻塞** T0.5，登记为可选优化。

**F8｜基线与增长模型（供 T3.2 使用）。**
- 真实产物基线：**200 KiB 落盘 / 1.30 MiB 未压缩 / 152 KiB gzip**，对应 68 个方块状态、2,207 quad、57 张 16×16 纹理、798 格。
- CSV（`out/samples-summary.csv`、`out/repo-fixtures-summary.csv`）每行都带可用的归一化指标：`gzip_ratio`、`palette.geometry`、`texture.blobs`、`palette.meta`、`palette_entries`、`quads`、`cells`、`delimiter_bytes`、`keyName_bytes`。
- T3.2 建议判定式（**由 T0.5 最终拍板**）：以"通道取值数之和 S"为自变量，对 `gzip_bytes` 做线性拟合，要求斜率变异系数 < 阈值，且 `gzip_bytes(S=2k) / gzip_bytes(S=k) < 2 × 安全系数`；同时要求 `palette.geometry + texture.blobs` 的增量只来自**新增方块状态**，而非整体复制。

---

## 9. 开放项 / 风险

| # | 开放项 / 风险 | 影响 | 建议处理 |
|---|---|---|---|
| 1 | 仓库内**只有 1 份真实产物**，且是**单变体单帧**（`mode="multiblock"` 但没有多通道/多运行态） | §6 的"多通道/多变体"数字全部来自**合成样例**，不能作为需求 C 的最终证据 | T1.4/T1.6 产出真实多变体导出后**必须**用本工具重跑并更新本报告；§6 的数字届时可替换 |
| 2 | 报告未对网格字段做"逐字符分解"（工具的口径是分桶值 + 全文档分隔符总量 + 新增的按顶层键子树统计） | 不影响结论（网格桶合计 0.19%），只影响精细度 | 新增的「按顶层键的子树体积与分隔符」表已覆盖该需求（`out/repo-fixtures.md`）；如需更细，可再按二级键切分 |
| 3 | 合成样例缺 `thumbnailPNG`、`nbt` 被简化 | 合成数据的 `palette.meta` 占比被低估（真实产物中 thumbnail 占未压缩 4.7%） | 已在 §8 F3 单列；如需更准，可在 `SAMPLE_SPECS` 中给部分条目加 thumbnail |
| 4 | 合成纹理是"伪随机 16×16"，真实 MC 纹理有 16×16/32×32/动画竖条等 | `texture.blobs` 的 gzip 表现可能仍有偏差 | 属保守建模（噪声宁可不可压）；真实产物给出的是 135,662 B 的实测值，优先采信 |
| 5 | gzip 后逐桶精确归户不可加，§5.4 用"单键增量法"近似 | 单键增量之和 ≠ 整体 gzip 体积（本例差 1,654 B，1.1%） | 已在表内标注余量；若 T3.2 需要精确归因，可改为"逐桶顺序拼接后测增量"（工具已预留 `gzipContribution` 结构） |
| 6 | 键名审计差额（真实产物 30,776 B，占键名 7.7%）：空对象/空数组的父键，扫描器未能逐条定位 | 不影响三分解闭合（键名总量按差额法给出，已含该部分），只影响"键名分布表"的完整性 | 已在报告"键名审计"行显式披露；如需精确分布，可扩展扫描器记录键所在 offset |
| 7 | `BUCKET_RULES` 需随格式演进维护（新增字段落入 `other:<路径>`） | 未登记字段不丢字节，但会污染"其他"分类 | 兜底桶名自带路径，肉眼可见；T0.5 若新增字段，请同步在 `volume-profile.mjs` 的 `BUCKET_RULES` 登记并更新本报告 §3 |
| 8 | **未回答"变体规则（差异规则）本身占多少字节"** | T0.1 目标中"变体规则"这一项目前**无数据**——现有格式里根本不存在差异规则（由 T0.5/T1.4 引入） | T1.4 完成差异规则编码后，用本工具对同一多方块导出两组对照（仅骨干 / 骨干 + 规则）即可量出规则开销；工具无需改动 |
| 9 | 工具只做体积统计，不做**解码正确性**验证 | 无法保证"省了字节但装配语义不变" | 该验证属 T2.2/T2.6/T3.3（逐格 diff），不在 T0.1 范围 |
| 10 | 大文件性能 | 真实产物 1.3 MiB / 7.1 万叶子，全量分析（含 3 次 gzip + 值级校验）约 1 秒 | 若 T3.2 批量跑上百个文件，可加 `--verify false`；实测 12 个样例（含 420 KB 的 E-frames8）合计 < 1 秒 |
