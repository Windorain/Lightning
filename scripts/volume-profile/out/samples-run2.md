# 体积剖析原始输出

- 工具：`scripts/volume-profile/volume-profile.mjs`（本文件不含时间戳，便于逐字节比对两次运行结果）
- 文件数：12

## 汇总表

| 文件 | 落盘 | 未压缩 JSON | gzip | base64 | 帧 | cellGrid 规模 | palette 条目 | quad | 材质 | textureBlob |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| scripts/volume-profile/samples/A-small-shell.envelope.json | 7,247 | 7,184 | 5,433 | 7,244 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/A-small-shell.plain.json | 37,103 | 37,102 | 5,420 | 7,228 | 1 | 7×5×7 | 7 | 42 | 4 | 4 |
| scripts/volume-profile/samples/B-medium-solid.envelope.json | 21,138 | 21,075 | 15,743 | 20,992 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/B-medium-solid.plain.json | 132,428 | 132,427 | 15,657 | 20,876 | 1 | 15×11×15 | 15 | 127 | 12 | 12 |
| scripts/volume-profile/samples/C-large-solid.envelope.json | 40,023 | 39,960 | 30,010 | 40,016 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/C-large-solid.plain.json | 281,716 | 281,715 | 30,250 | 40,336 | 1 | 31×17×31 | 25 | 240 | 24 | 24 |
| scripts/volume-profile/samples/D-texture-only.envelope.json | 124,226 | 124,163 | 93,541 | 124,724 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/D-texture-only.plain.json | 144,776 | 144,775 | 93,590 | 124,788 | 1 | 3×3×3 | 3 | 5 | 96 | 96 |
| scripts/volume-profile/samples/E-frames8.envelope.json | 27,967 | 27,904 | 20,028 | 26,704 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/E-frames8.plain.json | 420,171 | 420,170 | 21,060 | 28,080 | 8 | 19×11×19 / 18×10×18 / 17×9×17 / 16×8×16 / 15×7×15 / 14×6×14 / 13×5×13 / 12×4×12 | 104 | 768 | 10 | 10 |
| scripts/volume-profile/samples/F-decorated.envelope.json | 7,393 | 7,330 | 5,542 | 7,392 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/volume-profile/samples/F-decorated.plain.json | 39,618 | 39,617 | 5,994 | 7,992 | 1 | 7×5×7 | 7 | 42 | 4 | 4 |

## 逐文件明细

### scripts/volume-profile/samples/A-small-shell.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 7,247 | 7.1 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 7,184 | 7.0 | 分桶统计口径 |
| gzip(level 9) | 5,433 | 5.3 | 压缩后 payload |
| base64(gzip) | 7,244 | 7.1 | 信封 payload 字符串本体 |
| 压缩率 | 75.63% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 7,184 vs 去空白 7,184）
- 三分解闭合：Σ叶子 7,041 + 分隔符 24 + 键名(不含冒号) 119 = 7,184；去空白原文 7,184 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 6,818 | 94.91% | — | — |
| doc_meta | 223 | 3.10% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 6,818 | 94.91% | — | — |
| doc.meta | 223 | 3.10% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.33% | | |
| （键名 `"key":`，共 11 个键） | 130 | 1.81% | | |
| **Σ 未压缩 JSON** | **7,184** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 6,818 | other:$.payload |
| `$.meta.description` | 1 | 103 | doc.meta |
| `$.meta.id` | 1 | 25 | doc.meta |
| `$.meta.label` | 1 | 25 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 7,247 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 6,816 | 94.05% 的文件 |
| 非 payload 结构开销 | 431 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 286） |
| payload 解 base64 后（gzip 流） | 5,112 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 36,507 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 5,112 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 6,816 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`eb9bcd7525b7308f79ff84ccf7e2e54db2f87eed315313694572c621d2279503`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, textureBlobs, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/A-small-shell.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 36,507 | 35.7 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 36,507 | 35.7 | 分桶统计口径 |
| gzip(level 9) | 5,112 | 5.0 | 压缩后 payload |
| base64(gzip) | 6,816 | 6.7 | 信封 payload 字符串本体 |
| 压缩率 | 14.00% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 36,507 vs 去空白 36,507）
- 三分解闭合：Σ叶子 14,514 + 分隔符 6,980 + 键名(不含冒号) 15,013 = 36,507；去空白原文 36,507 → **闭合**；叶子 3,031 个，对象 455 个 / 数组 194 个 / 键 2,652 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 910、`[]` 388、`,` 3,030、`:` 2,652（合计 6,980）
- 键名审计：键名总量（含冒号）17,665；扫描器逐条定位到的键 token 16,348（2,531 个），未定位差额 1,317 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, textureBlobs, tooltipPalette]
  - 帧 0：cellGrid 7×5×7(x×y×z)，格 245（非空 170），palette 条目 7，quad 42，材质 4，textureBlob 4，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 7,728 | 21.17% | 31.543 | 184.00 |
| texture | 5,376 | 14.73% | 21.943 | 128.00 |
| palette | 622 | 1.70% | 2.539 | 14.81 |
| grid | 490 | 1.34% | 2.000 | 11.67 |
| material | 231 | 0.63% | 0.943 | 5.50 |
| pools | 50 | 0.14% | 0.204 | 1.19 |
| frames_meta | 10 | 0.03% | 0.041 | 0.24 |
| doc_meta | 7 | 0.02% | 0.029 | 0.17 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 7,728 | 21.17% | 31.543 | 184.00 |
| texture.blobs | 5,376 | 14.73% | 21.943 | 128.00 |
| palette.meta | 622 | 1.70% | 2.539 | 14.81 |
| grid.cellGrid | 490 | 1.34% | 2.000 | 11.67 |
| material.entries | 231 | 0.63% | 0.943 | 5.50 |
| pool.tooltip | 50 | 0.14% | 0.204 | 1.19 |
| frames.meta | 10 | 0.03% | 0.041 | 0.24 |
| doc.meta | 7 | 0.02% | 0.029 | 0.17 |
| （分隔符 `{}[],:`，非键名） | 6,980 | 19.12% | | |
| （键名 `"key":`，共 2,652 个键） | 17,665 | 48.39% | | |
| **Σ 未压缩 JSON** | **36,507** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 15,313 | 41.95% | 226 | 96 | 1,318 | 1,505 | 1,318 | 3,467 | 22.6% |
| blockPalette | 14,641 | 40.10% | 224 | 52 | 1,312 | 1,257 | 1,312 | 3,121 | 21.3% |
| textureBlobs | 5,381 | 14.74% | 0 | 1 | 0 | 3 | 0 | 5 | 0.1% |
| cellGrid | 575 | 1.58% | 0 | 43 | 0 | 244 | 0 | 330 | 57.4% |
| materialPalette | 452 | 1.24% | 4 | 1 | 16 | 15 | 16 | 41 | 9.1% |
| tooltipPalette | 53 | 0.15% | 0 | 1 | 0 | 1 | 0 | 3 | 5.7% |
| **Σ 子树** | **36,415** | — | | | | | | | |（与未压缩 36,507 的差 = 顶层键名与顶层分隔符 92） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 3,928 |
| frames | 747 |
| blockPalette | 585 |
| materialPalette | 161 |
| cellGrid | 126 |
| tooltipPalette | 70 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 4 | 5,376 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 245 | 245 | grid.cellGrid |
| `$.cellGrid[][][]` | 245 | 245 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 168 | 168 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 336 | 4,368 | 13.00 |
| `color` | 336 | 2,688 | 8.00 |
| `materialIndex` | 84 | 1,344 | 16.00 |
| `x` | 336 | 1,344 | 4.00 |
| `y` | 336 | 1,344 | 4.00 |
| `z` | 336 | 1,344 | 4.00 |
| `u` | 336 | 1,344 | 4.00 |
| `v` | 336 | 1,344 | 4.00 |
| `occludesAdjacentFaces` | 14 | 336 | 24.00 |
| `registryId` | 14 | 182 | 13.00 |
| `renderMode` | 14 | 182 | 13.00 |
| `encoding` | 14 | 154 | 11.00 |
| `meta` | 14 | 98 | 7.00 |
| `textureBlobIndex` | 4 | 76 | 19.00 |
| `blendMode` | 4 | 48 | 12.00 |
| `locator` | 4 | 40 | 10.00 |


---

### scripts/volume-profile/samples/A-small-shell.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 37,103 | 36.2 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 37,102 | 36.2 | 分桶统计口径 |
| gzip(level 9) | 5,420 | 5.3 | 压缩后 payload |
| base64(gzip) | 7,228 | 7.1 | 信封 payload 字符串本体 |
| 压缩率 | 14.61% | — | gzip/未压缩 |
| base64 膨胀 | 133.36% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 37,102 vs 去空白 37,102）
- 三分解闭合：Σ叶子 14,881 + 分隔符 7,029 + 键名(不含冒号) 15,192 = 37,102；去空白原文 37,102 → **闭合**；叶子 3,050 个，对象 457 个 / 数组 197 个 / 键 2,672 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 914、`[]` 394、`,` 3,049、`:` 2,672（合计 7,029）
- 键名审计：键名总量（含冒号）17,864；扫描器逐条定位到的键 token 16,524（2,548 个），未定位差额 1,340 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, tooltipPalette, cellGrid, blockPalette]
  - 帧 0：cellGrid 7×5×7(x×y×z)，格 245（非空 170），palette 条目 7，quad 42，材质 4，textureBlob 4，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 7,728 | 20.83% | 31.543 | 184.00 |
| texture | 5,376 | 14.49% | 21.943 | 128.00 |
| palette | 622 | 1.68% | 2.539 | 14.81 |
| grid | 490 | 1.32% | 2.000 | 11.67 |
| doc_meta | 374 | 1.01% | 1.527 | 8.90 |
| material | 231 | 0.62% | 0.943 | 5.50 |
| pools | 50 | 0.13% | 0.204 | 1.19 |
| frames_meta | 10 | 0.03% | 0.041 | 0.24 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 7,728 | 20.83% | 31.543 | 184.00 |
| texture.blobs | 5,376 | 14.49% | 21.943 | 128.00 |
| palette.meta | 622 | 1.68% | 2.539 | 14.81 |
| grid.cellGrid | 490 | 1.32% | 2.000 | 11.67 |
| doc.meta | 374 | 1.01% | 1.527 | 8.90 |
| material.entries | 231 | 0.62% | 0.943 | 5.50 |
| pool.tooltip | 50 | 0.13% | 0.204 | 1.19 |
| frames.meta | 10 | 0.03% | 0.041 | 0.24 |
| （分隔符 `{}[],:`，非键名） | 7,029 | 18.95% | | |
| （键名 `"key":`，共 2,672 个键） | 17,864 | 48.15% | | |
| **Σ 未压缩 JSON** | **37,102** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 15,313 | 41.27% | 226 | 96 | 1,318 | 1,505 | 1,318 | 3,467 | 22.6% |
| blockPalette | 14,641 | 39.46% | 224 | 52 | 1,312 | 1,257 | 1,312 | 3,121 | 21.3% |
| textureBlobs | 5,381 | 14.50% | 0 | 1 | 0 | 3 | 0 | 5 | 0.1% |
| cellGrid | 575 | 1.55% | 0 | 43 | 0 | 244 | 0 | 330 | 57.4% |
| materialPalette | 452 | 1.22% | 4 | 1 | 16 | 15 | 16 | 41 | 9.1% |
| meta | 250 | 0.67% | 2 | 1 | 9 | 8 | 9 | 23 | 9.2% |
| description | 103 | 0.28% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tooltipPalette | 53 | 0.14% | 0 | 1 | 0 | 1 | 0 | 3 | 5.7% |
| id | 25 | 0.07% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 25 | 0.07% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.06% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.05% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| annotations | 2 | 0.01% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| labels | 2 | 0.01% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **36,874** | — | | | | | | | |（与未压缩 37,102 的差 = 顶层键名与顶层分隔符 228） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 3,928 |
| frames | 747 |
| blockPalette | 585 |
| meta | 163 |
| materialPalette | 161 |
| cellGrid | 126 |
| description | 101 |
| tooltipPalette | 70 |
| label | 33 |
| author | 31 |
| id | 30 |
| modSource | 29 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |
| annotations | 16 |
| labels | 11 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 4 | 5,376 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 245 | 245 | grid.cellGrid |
| `$.cellGrid[][][]` | 245 | 245 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 168 | 168 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 336 | 4,368 | 13.00 |
| `color` | 336 | 2,688 | 8.00 |
| `x` | 337 | 1,348 | 4.00 |
| `y` | 337 | 1,348 | 4.00 |
| `z` | 337 | 1,348 | 4.00 |
| `materialIndex` | 84 | 1,344 | 16.00 |
| `u` | 336 | 1,344 | 4.00 |
| `v` | 336 | 1,344 | 4.00 |
| `occludesAdjacentFaces` | 14 | 336 | 24.00 |
| `registryId` | 14 | 182 | 13.00 |
| `renderMode` | 14 | 182 | 13.00 |
| `encoding` | 14 | 154 | 11.00 |
| `meta` | 14 | 98 | 7.00 |
| `textureBlobIndex` | 4 | 76 | 19.00 |
| `blendMode` | 4 | 48 | 12.00 |
| `locator` | 4 | 40 | 10.00 |


---

### scripts/volume-profile/samples/B-medium-solid.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 21,138 | 20.6 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 21,075 | 20.6 | 分桶统计口径 |
| gzip(level 9) | 15,743 | 15.4 | 压缩后 payload |
| base64(gzip) | 20,992 | 20.5 | 信封 payload 字符串本体 |
| 压缩率 | 74.70% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 21,075 vs 去空白 21,075）
- 三分解闭合：Σ叶子 20,932 + 分隔符 24 + 键名(不含冒号) 119 = 21,075；去空白原文 21,075 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 20,706 | 98.25% | — | — |
| doc_meta | 226 | 1.07% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 20,706 | 98.25% | — | — |
| doc.meta | 226 | 1.07% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.11% | | |
| （键名 `"key":`，共 11 个键） | 130 | 0.62% | | |
| **Σ 未压缩 JSON** | **21,075** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 20,706 | other:$.payload |
| `$.meta.description` | 1 | 104 | doc.meta |
| `$.meta.id` | 1 | 26 | doc.meta |
| `$.meta.label` | 1 | 26 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 21,138 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 20,704 | 97.95% 的文件 |
| 非 payload 结构开销 | 434 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 289） |
| payload 解 base64 后（gzip 流） | 15,528 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 131,827 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 15,528 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 20,704 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`86516ee467626be968280fc792ec8f30458e11a51a74a93d4e6a38976284c7d0`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/B-medium-solid.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 131,827 | 128.7 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 131,827 | 128.7 | 分桶统计口径 |
| gzip(level 9) | 15,528 | 15.2 | 压缩后 payload |
| base64(gzip) | 20,704 | 20.2 | 信封 payload 字符串本体 |
| 压缩率 | 11.78% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 131,827 vs 去空白 131,827）
- 三分解闭合：Σ叶子 57,596 + 分隔符 30,138 + 键名(不含冒号) 44,093 = 131,827；去空白原文 131,827 → **闭合**；叶子 17,503 个，对象 1,345 个 / 数组 1,022 个 / 键 7,902 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 2,690、`[]` 2,044、`,` 17,502、`:` 7,902（合计 30,138）
- 键名审计：键名总量（含冒号）51,995；扫描器逐条定位到的键 token 48,428（7,573 个），未定位差额 3,567 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]
  - 帧 0：cellGrid 15×11×15(x×y×z)，格 2,475（非空 1,968），palette 条目 15，quad 127，材质 12，textureBlob 12，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 23,192 | 17.59% | 9.371 | 182.61 |
| texture | 16,124 | 12.23% | 6.515 | 126.96 |
| grid | 15,974 | 12.12% | 6.454 | 125.78 |
| palette | 1,456 | 1.10% | 0.588 | 11.46 |
| material | 678 | 0.51% | 0.274 | 5.34 |
| pools | 155 | 0.12% | 0.063 | 1.22 |
| frames_meta | 10 | 0.01% | 0.004 | 0.08 |
| doc_meta | 7 | 0.01% | 0.003 | 0.06 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 23,192 | 17.59% | 9.371 | 182.61 |
| texture.blobs | 16,124 | 12.23% | 6.515 | 126.96 |
| grid.cellTooltipGrid | 9,612 | 7.29% | 3.884 | 75.69 |
| grid.cellGrid | 6,362 | 4.83% | 2.571 | 50.09 |
| palette.meta | 1,456 | 1.10% | 0.588 | 11.46 |
| material.entries | 678 | 0.51% | 0.274 | 5.34 |
| pool.tooltip | 155 | 0.12% | 0.063 | 1.22 |
| frames.meta | 10 | 0.01% | 0.004 | 0.08 |
| doc.meta | 7 | 0.01% | 0.003 | 0.06 |
| （分隔符 `{}[],:`，非键名） | 30,138 | 22.86% | | |
| （键名 `"key":`，共 7,902 个键） | 51,995 | 39.44% | | |
| **Σ 未压缩 JSON** | **131,827** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 57,097 | 43.31% | 667 | 510 | 3,927 | 8,719 | 3,927 | 15,000 | 26.3% |
| blockPalette | 43,322 | 32.86% | 665 | 147 | 3,920 | 3,766 | 3,920 | 9,310 | 21.5% |
| textureBlobs | 16,137 | 12.24% | 0 | 1 | 0 | 11 | 0 | 13 | 0.1% |
| cellTooltipGrid | 7,642 | 5.80% | 0 | 181 | 0 | 2,474 | 0 | 2,836 | 37.1% |
| cellGrid | 6,017 | 4.56% | 0 | 181 | 0 | 2,474 | 0 | 2,836 | 47.1% |
| materialPalette | 1,339 | 1.02% | 12 | 1 | 48 | 47 | 48 | 121 | 9.0% |
| tooltipPalette | 162 | 0.12% | 0 | 1 | 0 | 5 | 0 | 7 | 4.3% |
| **Σ 子树** | **131,716** | — | | | | | | | |（与未压缩 131,827 的差 = 顶层键名与顶层分隔符 111） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 11,574 |
| frames | 1,741 |
| blockPalette | 985 |
| cellGrid | 457 |
| cellTooltipGrid | 252 |
| materialPalette | 222 |
| tooltipPalette | 88 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 12 | 16,124 | texture.blobs |
| `$.frames[].structure.cellTooltipGrid[][][]` | 2475 | 4,806 | grid.cellTooltipGrid |
| `$.cellTooltipGrid[][][]` | 2475 | 4,806 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 508 | 4,064 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 508 | 4,064 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 2475 | 3,181 | grid.cellGrid |
| `$.cellGrid[][][]` | 2475 | 3,181 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 508 | 2,032 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 508 | 2,032 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 508 | 1,270 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 508 | 1,270 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 508 | 1,270 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 508 | 1,270 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 508 | 1,016 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 508 | 1,016 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 508 | 1,016 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 1,016 | 13,208 | 13.00 |
| `color` | 1,016 | 8,128 | 8.00 |
| `materialIndex` | 254 | 4,064 | 16.00 |
| `x` | 1,016 | 4,064 | 4.00 |
| `y` | 1,016 | 4,064 | 4.00 |
| `z` | 1,016 | 4,064 | 4.00 |
| `u` | 1,016 | 4,064 | 4.00 |
| `v` | 1,016 | 4,064 | 4.00 |
| `occludesAdjacentFaces` | 30 | 720 | 24.00 |
| `registryId` | 30 | 390 | 13.00 |
| `renderMode` | 30 | 390 | 13.00 |
| `encoding` | 30 | 330 | 11.00 |
| `textureBlobIndex` | 12 | 228 | 19.00 |
| `meta` | 30 | 210 | 7.00 |
| `blendMode` | 12 | 144 | 12.00 |
| `locator` | 12 | 120 | 10.00 |


---

### scripts/volume-profile/samples/B-medium-solid.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 132,428 | 129.3 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 132,427 | 129.3 | 分桶统计口径 |
| gzip(level 9) | 15,657 | 15.3 | 压缩后 payload |
| base64(gzip) | 20,876 | 20.4 | 信封 payload 字符串本体 |
| 压缩率 | 11.82% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 132,427 vs 去空白 132,427）
- 三分解闭合：Σ叶子 57,968 + 分隔符 30,187 + 键名(不含冒号) 44,272 = 132,427；去空白原文 132,427 → **闭合**；叶子 17,522 个，对象 1,347 个 / 数组 1,025 个 / 键 7,922 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 2,694、`[]` 2,050、`,` 17,521、`:` 7,922（合计 30,187）
- 键名审计：键名总量（含冒号）52,194；扫描器逐条定位到的键 token 48,604（7,590 个），未定位差额 3,590 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, tooltipPalette, cellGrid, blockPalette, cellTooltipGrid]
  - 帧 0：cellGrid 15×11×15(x×y×z)，格 2,475（非空 1,968），palette 条目 15，quad 127，材质 12，textureBlob 12，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 23,192 | 17.51% | 9.371 | 182.61 |
| texture | 16,124 | 12.18% | 6.515 | 126.96 |
| grid | 15,974 | 12.06% | 6.454 | 125.78 |
| palette | 1,456 | 1.10% | 0.588 | 11.46 |
| material | 678 | 0.51% | 0.274 | 5.34 |
| doc_meta | 379 | 0.29% | 0.153 | 2.98 |
| pools | 155 | 0.12% | 0.063 | 1.22 |
| frames_meta | 10 | 0.01% | 0.004 | 0.08 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 23,192 | 17.51% | 9.371 | 182.61 |
| texture.blobs | 16,124 | 12.18% | 6.515 | 126.96 |
| grid.cellTooltipGrid | 9,612 | 7.26% | 3.884 | 75.69 |
| grid.cellGrid | 6,362 | 4.80% | 2.571 | 50.09 |
| palette.meta | 1,456 | 1.10% | 0.588 | 11.46 |
| material.entries | 678 | 0.51% | 0.274 | 5.34 |
| doc.meta | 379 | 0.29% | 0.153 | 2.98 |
| pool.tooltip | 155 | 0.12% | 0.063 | 1.22 |
| frames.meta | 10 | 0.01% | 0.004 | 0.08 |
| （分隔符 `{}[],:`，非键名） | 30,187 | 22.80% | | |
| （键名 `"key":`，共 7,922 个键） | 52,194 | 39.41% | | |
| **Σ 未压缩 JSON** | **132,427** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 57,097 | 43.12% | 667 | 510 | 3,927 | 8,719 | 3,927 | 15,000 | 26.3% |
| blockPalette | 43,322 | 32.71% | 665 | 147 | 3,920 | 3,766 | 3,920 | 9,310 | 21.5% |
| textureBlobs | 16,137 | 12.19% | 0 | 1 | 0 | 11 | 0 | 13 | 0.1% |
| cellTooltipGrid | 7,642 | 5.77% | 0 | 181 | 0 | 2,474 | 0 | 2,836 | 37.1% |
| cellGrid | 6,017 | 4.54% | 0 | 181 | 0 | 2,474 | 0 | 2,836 | 47.1% |
| materialPalette | 1,339 | 1.01% | 12 | 1 | 48 | 47 | 48 | 121 | 9.0% |
| meta | 252 | 0.19% | 2 | 1 | 9 | 8 | 9 | 23 | 9.1% |
| tooltipPalette | 162 | 0.12% | 0 | 1 | 0 | 5 | 0 | 7 | 4.3% |
| description | 104 | 0.08% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| id | 26 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 26 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| annotations | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| labels | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **132,180** | — | | | | | | | |（与未压缩 132,427 的差 = 顶层键名与顶层分隔符 247） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 11,574 |
| frames | 1,741 |
| blockPalette | 985 |
| cellGrid | 457 |
| cellTooltipGrid | 252 |
| materialPalette | 222 |
| meta | 165 |
| description | 101 |
| tooltipPalette | 88 |
| label | 34 |
| id | 31 |
| author | 31 |
| modSource | 29 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |
| annotations | 16 |
| labels | 11 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 12 | 16,124 | texture.blobs |
| `$.frames[].structure.cellTooltipGrid[][][]` | 2475 | 4,806 | grid.cellTooltipGrid |
| `$.cellTooltipGrid[][][]` | 2475 | 4,806 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 508 | 4,064 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 508 | 4,064 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 2475 | 3,181 | grid.cellGrid |
| `$.cellGrid[][][]` | 2475 | 3,181 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 508 | 2,032 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 508 | 2,032 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 508 | 1,270 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 508 | 1,270 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 508 | 1,270 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 508 | 1,270 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 508 | 1,016 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 508 | 1,016 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 508 | 1,016 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 1,016 | 13,208 | 13.00 |
| `color` | 1,016 | 8,128 | 8.00 |
| `x` | 1,017 | 4,068 | 4.00 |
| `y` | 1,017 | 4,068 | 4.00 |
| `z` | 1,017 | 4,068 | 4.00 |
| `materialIndex` | 254 | 4,064 | 16.00 |
| `u` | 1,016 | 4,064 | 4.00 |
| `v` | 1,016 | 4,064 | 4.00 |
| `occludesAdjacentFaces` | 30 | 720 | 24.00 |
| `registryId` | 30 | 390 | 13.00 |
| `renderMode` | 30 | 390 | 13.00 |
| `encoding` | 30 | 330 | 11.00 |
| `textureBlobIndex` | 12 | 228 | 19.00 |
| `meta` | 30 | 210 | 7.00 |
| `blendMode` | 12 | 144 | 12.00 |
| `locator` | 12 | 120 | 10.00 |


---

### scripts/volume-profile/samples/C-large-solid.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 40,023 | 39.1 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 39,960 | 39.0 | 分桶统计口径 |
| gzip(level 9) | 30,010 | 29.3 | 压缩后 payload |
| base64(gzip) | 40,016 | 39.1 | 信封 payload 字符串本体 |
| 压缩率 | 75.10% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 39,960 vs 去空白 39,960）
- 三分解闭合：Σ叶子 39,817 + 分隔符 24 + 键名(不含冒号) 119 = 39,960；去空白原文 39,960 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 39,594 | 99.08% | — | — |
| doc_meta | 223 | 0.56% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 39,594 | 99.08% | — | — |
| doc.meta | 223 | 0.56% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.06% | | |
| （键名 `"key":`，共 11 个键） | 130 | 0.33% | | |
| **Σ 未压缩 JSON** | **39,960** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 39,594 | other:$.payload |
| `$.meta.description` | 1 | 103 | doc.meta |
| `$.meta.id` | 1 | 25 | doc.meta |
| `$.meta.label` | 1 | 25 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 40,023 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 39,592 | 98.92% 的文件 |
| 非 payload 结构开销 | 431 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 286） |
| payload 解 base64 后（gzip 流） | 29,692 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 281,120 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 29,692 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 39,592 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`66928eb9f9fa7845e7c9333fd88a8e69cfff1bec7bdd0a7dc1d45e7179e16185`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, textureBlobs, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/C-large-solid.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 281,120 | 274.5 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 281,120 | 274.5 | 分桶统计口径 |
| gzip(level 9) | 29,692 | 29.0 | 压缩后 payload |
| base64(gzip) | 39,592 | 38.7 | 信封 payload 字符串本体 |
| 压缩率 | 10.56% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 281,120 vs 去空白 281,120）
- 三分解闭合：Σ叶子 128,209 + 分隔符 70,272 + 键名(不含冒号) 82,639 = 281,120；去空白原文 281,120 → **闭合**；叶子 47,009 个，对象 2,527 个 / 数组 1,668 个 / 键 14,874 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 5,054、`[]` 3,336、`,` 47,008、`:` 14,874（合计 70,272）
- 键名审计：键名总量（含冒号）97,513；扫描器逐条定位到的键 token 91,056（14,275 个），未定位差额 6,457 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, textureBlobs, tooltipPalette]
  - 帧 0：cellGrid 31×17×31(x×y×z)，格 16,337（非空 12,132），palette 条目 25，quad 240，材质 24，textureBlob 24，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| grid | 47,836 | 17.02% | 2.928 | 199.32 |
| geometry | 43,902 | 15.62% | 2.687 | 182.93 |
| texture | 32,224 | 11.46% | 1.972 | 134.27 |
| palette | 2,568 | 0.91% | 0.157 | 10.70 |
| material | 1,356 | 0.48% | 0.083 | 5.65 |
| pools | 306 | 0.11% | 0.019 | 1.27 |
| frames_meta | 10 | 0.00% | 0.001 | 0.04 |
| doc_meta | 7 | 0.00% | 0.000 | 0.03 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| grid.cellGrid | 47,836 | 17.02% | 2.928 | 199.32 |
| palette.geometry | 43,902 | 15.62% | 2.687 | 182.93 |
| texture.blobs | 32,224 | 11.46% | 1.972 | 134.27 |
| palette.meta | 2,568 | 0.91% | 0.157 | 10.70 |
| material.entries | 1,356 | 0.48% | 0.083 | 5.65 |
| pool.tooltip | 306 | 0.11% | 0.019 | 1.27 |
| frames.meta | 10 | 0.00% | 0.001 | 0.04 |
| doc.meta | 7 | 0.00% | 0.000 | 0.03 |
| （分隔符 `{}[],:`，非键名） | 70,272 | 25.00% | | |
| （键名 `"key":`，共 14,874 个键） | 97,513 | 34.69% | | |
| **Σ 未压缩 JSON** | **281,120** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 122,940 | 43.73% | 1,252 | 833 | 7,389 | 23,439 | 7,389 | 34,998 | 28.5% |
| blockPalette | 81,471 | 28.98% | 1,250 | 273 | 7,383 | 7,099 | 7,383 | 17,528 | 21.5% |
| cellGrid | 41,372 | 14.72% | 0 | 559 | 0 | 16,336 | 0 | 17,454 | 42.2% |
| textureBlobs | 32,249 | 11.47% | 0 | 1 | 0 | 23 | 0 | 25 | 0.1% |
| materialPalette | 2,677 | 0.95% | 24 | 1 | 96 | 95 | 96 | 241 | 9.0% |
| tooltipPalette | 319 | 0.11% | 0 | 1 | 0 | 11 | 0 | 13 | 4.1% |
| **Σ 子树** | **281,028** | — | | | | | | | |（与未压缩 281,120 的差 = 顶层键名与顶层分隔符 92） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 22,983 |
| frames | 2,911 |
| blockPalette | 1,663 |
| cellGrid | 1,130 |
| materialPalette | 297 |
| tooltipPalette | 107 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 24 | 32,224 | texture.blobs |
| `$.frames[].structure.cellGrid[][][]` | 16337 | 23,918 | grid.cellGrid |
| `$.cellGrid[][][]` | 16337 | 23,918 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 960 | 7,680 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 960 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 960 | 3,840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 960 | 3,840 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 960 | 2,400 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 960 | 2,400 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 960 | 2,400 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 960 | 2,400 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 960 | 1,920 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 960 | 1,920 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 960 | 1,920 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 960 | 1,920 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 960 | 960 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 1,920 | 24,960 | 13.00 |
| `color` | 1,920 | 15,360 | 8.00 |
| `materialIndex` | 480 | 7,680 | 16.00 |
| `x` | 1,920 | 7,680 | 4.00 |
| `y` | 1,920 | 7,680 | 4.00 |
| `z` | 1,920 | 7,680 | 4.00 |
| `u` | 1,920 | 7,680 | 4.00 |
| `v` | 1,920 | 7,680 | 4.00 |
| `occludesAdjacentFaces` | 50 | 1,200 | 24.00 |
| `registryId` | 50 | 650 | 13.00 |
| `renderMode` | 50 | 650 | 13.00 |
| `encoding` | 50 | 550 | 11.00 |
| `textureBlobIndex` | 24 | 456 | 19.00 |
| `meta` | 50 | 350 | 7.00 |
| `blendMode` | 24 | 288 | 12.00 |
| `locator` | 24 | 240 | 10.00 |


---

### scripts/volume-profile/samples/C-large-solid.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 281,716 | 275.1 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 281,715 | 275.1 | 分桶统计口径 |
| gzip(level 9) | 30,250 | 29.5 | 压缩后 payload |
| base64(gzip) | 40,336 | 39.4 | 信封 payload 字符串本体 |
| 压缩率 | 10.74% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 281,715 vs 去空白 281,715）
- 三分解闭合：Σ叶子 128,576 + 分隔符 70,321 + 键名(不含冒号) 82,818 = 281,715；去空白原文 281,715 → **闭合**；叶子 47,028 个，对象 2,529 个 / 数组 1,671 个 / 键 14,894 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 5,058、`[]` 3,342、`,` 47,027、`:` 14,894（合计 70,321）
- 键名审计：键名总量（含冒号）97,712；扫描器逐条定位到的键 token 91,232（14,292 个），未定位差额 6,480 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, tooltipPalette, cellGrid, blockPalette]
  - 帧 0：cellGrid 31×17×31(x×y×z)，格 16,337（非空 12,132），palette 条目 25，quad 240，材质 24，textureBlob 24，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| grid | 47,836 | 16.98% | 2.928 | 199.32 |
| geometry | 43,902 | 15.58% | 2.687 | 182.93 |
| texture | 32,224 | 11.44% | 1.972 | 134.27 |
| palette | 2,568 | 0.91% | 0.157 | 10.70 |
| material | 1,356 | 0.48% | 0.083 | 5.65 |
| doc_meta | 374 | 0.13% | 0.023 | 1.56 |
| pools | 306 | 0.11% | 0.019 | 1.27 |
| frames_meta | 10 | 0.00% | 0.001 | 0.04 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| grid.cellGrid | 47,836 | 16.98% | 2.928 | 199.32 |
| palette.geometry | 43,902 | 15.58% | 2.687 | 182.93 |
| texture.blobs | 32,224 | 11.44% | 1.972 | 134.27 |
| palette.meta | 2,568 | 0.91% | 0.157 | 10.70 |
| material.entries | 1,356 | 0.48% | 0.083 | 5.65 |
| doc.meta | 374 | 0.13% | 0.023 | 1.56 |
| pool.tooltip | 306 | 0.11% | 0.019 | 1.27 |
| frames.meta | 10 | 0.00% | 0.001 | 0.04 |
| （分隔符 `{}[],:`，非键名） | 70,321 | 24.96% | | |
| （键名 `"key":`，共 14,894 个键） | 97,712 | 34.68% | | |
| **Σ 未压缩 JSON** | **281,715** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 122,940 | 43.64% | 1,252 | 833 | 7,389 | 23,439 | 7,389 | 34,998 | 28.5% |
| blockPalette | 81,471 | 28.92% | 1,250 | 273 | 7,383 | 7,099 | 7,383 | 17,528 | 21.5% |
| cellGrid | 41,372 | 14.69% | 0 | 559 | 0 | 16,336 | 0 | 17,454 | 42.2% |
| textureBlobs | 32,249 | 11.45% | 0 | 1 | 0 | 23 | 0 | 25 | 0.1% |
| materialPalette | 2,677 | 0.95% | 24 | 1 | 96 | 95 | 96 | 241 | 9.0% |
| tooltipPalette | 319 | 0.11% | 0 | 1 | 0 | 11 | 0 | 13 | 4.1% |
| meta | 250 | 0.09% | 2 | 1 | 9 | 8 | 9 | 23 | 9.2% |
| description | 103 | 0.04% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| id | 25 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 25 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| annotations | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| labels | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **281,487** | — | | | | | | | |（与未压缩 281,715 的差 = 顶层键名与顶层分隔符 228） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 22,983 |
| frames | 2,911 |
| blockPalette | 1,663 |
| cellGrid | 1,130 |
| materialPalette | 297 |
| meta | 164 |
| tooltipPalette | 107 |
| description | 100 |
| label | 33 |
| author | 31 |
| id | 30 |
| modSource | 29 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |
| annotations | 16 |
| labels | 11 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 24 | 32,224 | texture.blobs |
| `$.frames[].structure.cellGrid[][][]` | 16337 | 23,918 | grid.cellGrid |
| `$.cellGrid[][][]` | 16337 | 23,918 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 960 | 7,680 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 960 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 960 | 3,840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 960 | 3,840 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 960 | 2,400 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 960 | 2,400 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 960 | 2,400 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 960 | 2,400 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 960 | 1,920 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 960 | 1,920 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 960 | 1,920 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 960 | 1,920 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 960 | 960 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 1,920 | 24,960 | 13.00 |
| `color` | 1,920 | 15,360 | 8.00 |
| `x` | 1,921 | 7,684 | 4.00 |
| `y` | 1,921 | 7,684 | 4.00 |
| `z` | 1,921 | 7,684 | 4.00 |
| `materialIndex` | 480 | 7,680 | 16.00 |
| `u` | 1,920 | 7,680 | 4.00 |
| `v` | 1,920 | 7,680 | 4.00 |
| `occludesAdjacentFaces` | 50 | 1,200 | 24.00 |
| `registryId` | 50 | 650 | 13.00 |
| `renderMode` | 50 | 650 | 13.00 |
| `encoding` | 50 | 550 | 11.00 |
| `textureBlobIndex` | 24 | 456 | 19.00 |
| `meta` | 50 | 350 | 7.00 |
| `blendMode` | 24 | 288 | 12.00 |
| `locator` | 24 | 240 | 10.00 |


---

### scripts/volume-profile/samples/D-texture-only.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 124,226 | 121.3 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 124,163 | 121.3 | 分桶统计口径 |
| gzip(level 9) | 93,541 | 91.3 | 压缩后 payload |
| base64(gzip) | 124,724 | 121.8 | 信封 payload 字符串本体 |
| 压缩率 | 75.34% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 124,163 vs 去空白 124,163）
- 三分解闭合：Σ叶子 124,020 + 分隔符 24 + 键名(不含冒号) 119 = 124,163；去空白原文 124,163 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 123,794 | 99.70% | — | — |
| doc_meta | 226 | 0.18% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 123,794 | 99.70% | — | — |
| doc.meta | 226 | 0.18% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.02% | | |
| （键名 `"key":`，共 11 个键） | 130 | 0.10% | | |
| **Σ 未压缩 JSON** | **124,163** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 123,794 | other:$.payload |
| `$.meta.description` | 1 | 104 | doc.meta |
| `$.meta.id` | 1 | 26 | doc.meta |
| `$.meta.label` | 1 | 26 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 124,226 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 123,792 | 99.65% 的文件 |
| 非 payload 结构开销 | 434 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 289） |
| payload 解 base64 后（gzip 流） | 92,844 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 144,175 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 92,844 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 123,792 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`203f65a35b44e3a94f6d3e462a4eaccbaf5e2fdedc46d4c7aedf21c21591c110`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, textureBlobs]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/D-texture-only.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 144,175 | 140.8 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 144,175 | 140.8 | 分桶统计口径 |
| gzip(level 9) | 92,844 | 90.7 | 压缩后 payload |
| base64(gzip) | 123,792 | 120.9 | 信封 payload 字符串本体 |
| 压缩率 | 64.40% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 144,175 vs 去空白 144,175）
- 三分解闭合：Σ叶子 135,587 + 分隔符 2,023 + 键名(不含冒号) 6,565 = 144,175；去空白原文 144,175 → **闭合**；叶子 863 个，对象 161 个 / 数组 49 个 / 键 741 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 322、`[]` 98、`,` 862、`:` 741（合计 2,023）
- 键名审计：键名总量（含冒号）7,306；扫描器逐条定位到的键 token 6,992（713 个），未定位差额 314 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, textureBlobs]
  - 帧 0：cellGrid 3×3×3(x×y×z)，格 27（非空 26），palette 条目 3，quad 5，材质 96，textureBlob 96，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture | 128,748 | 89.30% | 4768.444 | 25749.60 |
| material | 5,570 | 3.86% | 206.296 | 1114.00 |
| geometry | 998 | 0.69% | 36.963 | 199.60 |
| palette | 200 | 0.14% | 7.407 | 40.00 |
| grid | 54 | 0.04% | 2.000 | 10.80 |
| frames_meta | 10 | 0.01% | 0.370 | 2.00 |
| doc_meta | 7 | 0.00% | 0.259 | 1.40 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture.blobs | 128,748 | 89.30% | 4768.444 | 25749.60 |
| material.entries | 5,570 | 3.86% | 206.296 | 1114.00 |
| palette.geometry | 998 | 0.69% | 36.963 | 199.60 |
| palette.meta | 200 | 0.14% | 7.407 | 40.00 |
| grid.cellGrid | 54 | 0.04% | 2.000 | 10.80 |
| frames.meta | 10 | 0.01% | 0.370 | 2.00 |
| doc.meta | 7 | 0.00% | 0.259 | 1.40 |
| （分隔符 `{}[],:`，非键名） | 2,023 | 1.40% | | |
| （键名 `"key":`，共 741 个键） | 7,306 | 5.07% | | |
| **Σ 未压缩 JSON** | **144,175** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| textureBlobs | 128,845 | 89.37% | 0 | 1 | 0 | 95 | 0 | 97 | 0.1% |
| materialPalette | 10,851 | 7.53% | 96 | 1 | 384 | 383 | 384 | 961 | 8.9% |
| frames | 2,251 | 1.56% | 33 | 24 | 179 | 192 | 179 | 485 | 21.5% |
| blockPalette | 2,075 | 1.44% | 31 | 10 | 173 | 162 | 173 | 417 | 20.1% |
| cellGrid | 79 | 0.05% | 0 | 13 | 0 | 26 | 0 | 52 | 65.8% |
| **Σ 子树** | **144,101** | — | | | | | | | |（与未压缩 144,175 的差 = 顶层键名与顶层分隔符 74） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 91,446 |
| materialPalette | 719 |
| frames | 417 |
| blockPalette | 341 |
| cellGrid | 44 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 96 | 128,748 | texture.blobs |
| `$.materialPalette[].locator` | 96 | 3,862 | material.entries |
| `$.materialPalette[].blendMode` | 96 | 838 | material.entries |
| `$.materialPalette[].atlas` | 96 | 688 | material.entries |
| `$.materialPalette[].textureBlobIndex` | 96 | 182 | material.entries |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 20 | 160 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 20 | 160 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 20 | 80 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 20 | 80 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.encoding` | 3 | 54 | palette.geometry |
| `$.blockPalette[].geometry.encoding` | 3 | 54 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 20 | 50 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 20 | 50 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 20 | 50 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 20 | 50 | palette.geometry |
| `$.frames[].structure.blockPalette[].registryId` | 3 | 43 | palette.meta |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `textureBlobIndex` | 96 | 1,824 | 19.00 |
| `blendMode` | 96 | 1,152 | 12.00 |
| `locator` | 96 | 960 | 10.00 |
| `atlas` | 96 | 768 | 8.00 |
| `brightness` | 40 | 520 | 13.00 |
| `color` | 40 | 320 | 8.00 |
| `materialIndex` | 10 | 160 | 16.00 |
| `x` | 40 | 160 | 4.00 |
| `y` | 40 | 160 | 4.00 |
| `z` | 40 | 160 | 4.00 |
| `u` | 40 | 160 | 4.00 |
| `v` | 40 | 160 | 4.00 |
| `occludesAdjacentFaces` | 6 | 144 | 24.00 |
| `registryId` | 6 | 78 | 13.00 |
| `renderMode` | 6 | 78 | 13.00 |
| `encoding` | 6 | 66 | 11.00 |


---

### scripts/volume-profile/samples/D-texture-only.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 144,776 | 141.4 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 144,775 | 141.4 | 分桶统计口径 |
| gzip(level 9) | 93,590 | 91.4 | 压缩后 payload |
| base64(gzip) | 124,788 | 121.9 | 信封 payload 字符串本体 |
| 压缩率 | 64.65% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 144,775 vs 去空白 144,775）
- 三分解闭合：Σ叶子 135,959 + 分隔符 2,072 + 键名(不含冒号) 6,744 = 144,775；去空白原文 144,775 → **闭合**；叶子 882 个，对象 163 个 / 数组 52 个 / 键 761 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 326、`[]` 104、`,` 881、`:` 761（合计 2,072）
- 键名审计：键名总量（含冒号）7,505；扫描器逐条定位到的键 token 7,168（730 个），未定位差额 337 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, cellGrid, blockPalette]
  - 帧 0：cellGrid 3×3×3(x×y×z)，格 27（非空 26），palette 条目 3，quad 5，材质 96，textureBlob 96，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture | 128,748 | 88.93% | 4768.444 | 25749.60 |
| material | 5,570 | 3.85% | 206.296 | 1114.00 |
| geometry | 998 | 0.69% | 36.963 | 199.60 |
| doc_meta | 379 | 0.26% | 14.037 | 75.80 |
| palette | 200 | 0.14% | 7.407 | 40.00 |
| grid | 54 | 0.04% | 2.000 | 10.80 |
| frames_meta | 10 | 0.01% | 0.370 | 2.00 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture.blobs | 128,748 | 88.93% | 4768.444 | 25749.60 |
| material.entries | 5,570 | 3.85% | 206.296 | 1114.00 |
| palette.geometry | 998 | 0.69% | 36.963 | 199.60 |
| doc.meta | 379 | 0.26% | 14.037 | 75.80 |
| palette.meta | 200 | 0.14% | 7.407 | 40.00 |
| grid.cellGrid | 54 | 0.04% | 2.000 | 10.80 |
| frames.meta | 10 | 0.01% | 0.370 | 2.00 |
| （分隔符 `{}[],:`，非键名） | 2,072 | 1.43% | | |
| （键名 `"key":`，共 761 个键） | 7,505 | 5.18% | | |
| **Σ 未压缩 JSON** | **144,775** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| textureBlobs | 128,845 | 89.00% | 0 | 1 | 0 | 95 | 0 | 97 | 0.1% |
| materialPalette | 10,851 | 7.50% | 96 | 1 | 384 | 383 | 384 | 961 | 8.9% |
| frames | 2,251 | 1.55% | 33 | 24 | 179 | 192 | 179 | 485 | 21.5% |
| blockPalette | 2,075 | 1.43% | 31 | 10 | 173 | 162 | 173 | 417 | 20.1% |
| meta | 252 | 0.17% | 2 | 1 | 9 | 8 | 9 | 23 | 9.1% |
| description | 104 | 0.07% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| cellGrid | 79 | 0.05% | 0 | 13 | 0 | 26 | 0 | 52 | 65.8% |
| id | 26 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 26 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| annotations | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| labels | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **144,565** | — | | | | | | | |（与未压缩 144,775 的差 = 顶层键名与顶层分隔符 210） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 91,446 |
| materialPalette | 719 |
| frames | 417 |
| blockPalette | 341 |
| meta | 165 |
| description | 101 |
| cellGrid | 44 |
| label | 34 |
| id | 31 |
| author | 31 |
| modSource | 29 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |
| annotations | 16 |
| labels | 11 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 96 | 128,748 | texture.blobs |
| `$.materialPalette[].locator` | 96 | 3,862 | material.entries |
| `$.materialPalette[].blendMode` | 96 | 838 | material.entries |
| `$.materialPalette[].atlas` | 96 | 688 | material.entries |
| `$.materialPalette[].textureBlobIndex` | 96 | 182 | material.entries |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 20 | 160 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 20 | 160 | palette.geometry |
| `$.description` | 1 | 104 | doc.meta |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 20 | 80 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 20 | 80 | palette.geometry |
| `$.meta.description` | 1 | 72 | doc.meta |
| `$.frames[].structure.blockPalette[].geometry.encoding` | 3 | 54 | palette.geometry |
| `$.blockPalette[].geometry.encoding` | 3 | 54 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 20 | 50 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 20 | 50 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 20 | 50 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `textureBlobIndex` | 96 | 1,824 | 19.00 |
| `blendMode` | 96 | 1,152 | 12.00 |
| `locator` | 96 | 960 | 10.00 |
| `atlas` | 96 | 768 | 8.00 |
| `brightness` | 40 | 520 | 13.00 |
| `color` | 40 | 320 | 8.00 |
| `x` | 41 | 164 | 4.00 |
| `y` | 41 | 164 | 4.00 |
| `z` | 41 | 164 | 4.00 |
| `materialIndex` | 10 | 160 | 16.00 |
| `u` | 40 | 160 | 4.00 |
| `v` | 40 | 160 | 4.00 |
| `occludesAdjacentFaces` | 6 | 144 | 24.00 |
| `registryId` | 6 | 78 | 13.00 |
| `renderMode` | 6 | 78 | 13.00 |
| `encoding` | 6 | 66 | 11.00 |


---

### scripts/volume-profile/samples/E-frames8.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 27,967 | 27.3 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 27,904 | 27.3 | 分桶统计口径 |
| gzip(level 9) | 20,028 | 19.6 | 压缩后 payload |
| base64(gzip) | 26,704 | 26.1 | 信封 payload 字符串本体 |
| 压缩率 | 71.77% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 27,904 vs 去空白 27,904）
- 三分解闭合：Σ叶子 27,761 + 分隔符 24 + 键名(不含冒号) 119 = 27,904；去空白原文 27,904 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 27,550 | 98.73% | — | — |
| doc_meta | 211 | 0.76% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 27,550 | 98.73% | — | — |
| doc.meta | 211 | 0.76% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.09% | | |
| （键名 `"key":`，共 11 个键） | 130 | 0.47% | | |
| **Σ 未压缩 JSON** | **27,904** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 27,550 | other:$.payload |
| `$.meta.description` | 1 | 99 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.id` | 1 | 21 | doc.meta |
| `$.meta.label` | 1 | 21 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 27,967 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 27,548 | 98.50% 的文件 |
| 非 payload 结构开销 | 419 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 274） |
| payload 解 base64 后（gzip 流） | 20,661 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 419,595 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 20,661 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 27,548 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`c61fb623c345fb303694415cb3bc9f00dd7ac771a1b33fcd4eacb1281219f64b`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/E-frames8.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 419,595 | 409.8 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 419,595 | 409.8 | 分桶统计口径 |
| gzip(level 9) | 20,661 | 20.2 | 压缩后 payload |
| base64(gzip) | 27,548 | 26.9 | 信封 payload 字符串本体 |
| 压缩率 | 4.92% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 419,595 vs 去空白 419,595）
- 三分解闭合：Σ叶子 160,320 + 分隔符 109,248 + 键名(不含冒号) 150,027 = 419,595；去空白原文 419,595 → **闭合**；叶子 65,808 个，对象 4,581 个 / 数组 3,696 个 / 键 26,887 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 9,162、`[]` 7,392、`,` 65,807、`:` 26,887（合计 109,248）
- 键名审计：键名总量（含冒号）176,914；扫描器逐条定位到的键 token 164,438（25,732 个），未定位差额 12,476 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=8 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]
  - 帧 0：cellGrid 19×11×19(x×y×z)，格 3,971（非空 1,370），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 1：cellGrid 18×10×18(x×y×z)，格 3,240（非空 1,192），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 2：cellGrid 17×9×17(x×y×z)，格 2,601（非空 1,026），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 3：cellGrid 16×8×16(x×y×z)，格 2,048（非空 872），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 4：cellGrid 15×7×15(x×y×z)，格 1,575（非空 730），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 5：cellGrid 14×6×14(x×y×z)，格 1,176（非空 600），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 6：cellGrid 13×5×13(x×y×z)，格 845（非空 482），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 7：cellGrid 12×4×12(x×y×z)，格 576（非空 376），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 79,002 | 18.83% | 4.928 | 102.87 |
| grid | 61,343 | 14.62% | 3.826 | 79.87 |
| texture | 13,440 | 3.20% | 0.838 | 17.50 |
| palette | 5,742 | 1.37% | 0.358 | 7.48 |
| material | 524 | 0.12% | 0.033 | 0.68 |
| pools | 140 | 0.03% | 0.009 | 0.18 |
| frames_meta | 73 | 0.02% | 0.005 | 0.10 |
| doc_meta | 56 | 0.01% | 0.003 | 0.07 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 79,002 | 18.83% | 4.928 | 102.87 |
| grid.cellTooltipGrid | 39,343 | 9.38% | 2.454 | 51.23 |
| grid.cellGrid | 22,000 | 5.24% | 1.372 | 28.65 |
| texture.blobs | 13,440 | 3.20% | 0.838 | 17.50 |
| palette.meta | 5,742 | 1.37% | 0.358 | 7.48 |
| material.entries | 524 | 0.12% | 0.033 | 0.68 |
| pool.tooltip | 140 | 0.03% | 0.009 | 0.18 |
| frames.meta | 73 | 0.02% | 0.005 | 0.10 |
| doc.meta | 56 | 0.01% | 0.003 | 0.07 |
| （分隔符 `{}[],:`，非键名） | 109,248 | 26.04% | | |
| （键名 `"key":`，共 26,887 个键） | 176,914 | 42.16% | | |
| **Σ 未压缩 JSON** | **419,595** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 350,787 | 83.60% | 4,064 | 3,121 | 23,864 | 54,951 | 23,864 | 93,185 | 26.6% |
| blockPalette | 33,026 | 7.87% | 506 | 114 | 2,976 | 2,857 | 2,976 | 7,073 | 21.4% |
| textureBlobs | 13,451 | 3.21% | 0 | 1 | 0 | 9 | 0 | 11 | 0.1% |
| cellTooltipGrid | 12,259 | 2.92% | 0 | 229 | 0 | 3,970 | 0 | 4,428 | 36.1% |
| cellGrid | 8,739 | 2.08% | 0 | 229 | 0 | 3,970 | 0 | 4,428 | 50.7% |
| materialPalette | 1,075 | 0.26% | 10 | 1 | 40 | 39 | 40 | 101 | 9.4% |
| tooltipPalette | 147 | 0.04% | 0 | 1 | 0 | 5 | 0 | 7 | 4.8% |
| **Σ 子树** | **419,484** | — | | | | | | | |（与未压缩 419,595 的差 = 顶层键名与顶层分隔符 111） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 9,673 |
| frames | 8,401 |
| blockPalette | 857 |
| cellGrid | 329 |
| cellTooltipGrid | 311 |
| materialPalette | 204 |
| tooltipPalette | 83 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.frames[].structure.cellTooltipGrid[][][]` | 16032 | 31,512 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 3072 | 24,576 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 16032 | 17,689 | grid.cellGrid |
| `$.textureBlobs[]` | 10 | 13,440 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 3072 | 12,288 | palette.geometry |
| `$.cellTooltipGrid[][][]` | 3971 | 7,831 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 3072 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 3072 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 3072 | 6,144 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 3072 | 6,144 | palette.geometry |
| `$.cellGrid[][][]` | 3971 | 4,311 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 3072 | 3,072 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 384 | 3,072 | palette.geometry |
| `$.frames[].structure.blockPalette[].registryId` | 104 | 2,120 | palette.meta |
| `$.frames[].structure.blockPalette[].geometry.encoding` | 104 | 1,872 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 384 | 1,536 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 3,456 | 44,928 | 13.00 |
| `color` | 3,456 | 27,648 | 8.00 |
| `materialIndex` | 864 | 13,824 | 16.00 |
| `x` | 3,456 | 13,824 | 4.00 |
| `y` | 3,456 | 13,824 | 4.00 |
| `z` | 3,456 | 13,824 | 4.00 |
| `u` | 3,456 | 13,824 | 4.00 |
| `v` | 3,456 | 13,824 | 4.00 |
| `occludesAdjacentFaces` | 117 | 2,808 | 24.00 |
| `registryId` | 117 | 1,521 | 13.00 |
| `renderMode` | 117 | 1,521 | 13.00 |
| `encoding` | 117 | 1,287 | 11.00 |
| `meta` | 117 | 819 | 7.00 |
| `textureBlobIndex` | 10 | 190 | 19.00 |
| `geometryPhase` | 8 | 128 | 16.00 |
| `blendMode` | 10 | 120 | 12.00 |


---

### scripts/volume-profile/samples/E-frames8.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 420,171 | 410.3 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 420,170 | 410.3 | 分桶统计口径 |
| gzip(level 9) | 21,060 | 20.6 | 压缩后 payload |
| base64(gzip) | 28,080 | 27.4 | 信封 payload 字符串本体 |
| 压缩率 | 5.01% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 420,170 vs 去空白 420,170）
- 三分解闭合：Σ叶子 160,667 + 分隔符 109,297 + 键名(不含冒号) 150,206 = 420,170；去空白原文 420,170 → **闭合**；叶子 65,827 个，对象 4,583 个 / 数组 3,699 个 / 键 26,907 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 9,166、`[]` 7,398、`,` 65,826、`:` 26,907（合计 109,297）
- 键名审计：键名总量（含冒号）177,113；扫描器逐条定位到的键 token 164,614（25,749 个），未定位差额 12,499 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=8 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, tooltipPalette, cellGrid, blockPalette, cellTooltipGrid]
  - 帧 0：cellGrid 19×11×19(x×y×z)，格 3,971（非空 1,370），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 1：cellGrid 18×10×18(x×y×z)，格 3,240（非空 1,192），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 2：cellGrid 17×9×17(x×y×z)，格 2,601（非空 1,026），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 3：cellGrid 16×8×16(x×y×z)，格 2,048（非空 872），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 4：cellGrid 15×7×15(x×y×z)，格 1,575（非空 730），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 5：cellGrid 14×6×14(x×y×z)，格 1,176（非空 600），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 6：cellGrid 13×5×13(x×y×z)，格 845（非空 482），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
  - 帧 7：cellGrid 12×4×12(x×y×z)，格 576（非空 376），palette 条目 13，quad 96，材质 10，textureBlob 10，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 79,002 | 18.80% | 4.928 | 102.87 |
| grid | 61,343 | 14.60% | 3.826 | 79.87 |
| texture | 13,440 | 3.20% | 0.838 | 17.50 |
| palette | 5,742 | 1.37% | 0.358 | 7.48 |
| material | 524 | 0.12% | 0.033 | 0.68 |
| doc_meta | 403 | 0.10% | 0.025 | 0.52 |
| pools | 140 | 0.03% | 0.009 | 0.18 |
| frames_meta | 73 | 0.02% | 0.005 | 0.10 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 79,002 | 18.80% | 4.928 | 102.87 |
| grid.cellTooltipGrid | 39,343 | 9.36% | 2.454 | 51.23 |
| grid.cellGrid | 22,000 | 5.24% | 1.372 | 28.65 |
| texture.blobs | 13,440 | 3.20% | 0.838 | 17.50 |
| palette.meta | 5,742 | 1.37% | 0.358 | 7.48 |
| material.entries | 524 | 0.12% | 0.033 | 0.68 |
| doc.meta | 403 | 0.10% | 0.025 | 0.52 |
| pool.tooltip | 140 | 0.03% | 0.009 | 0.18 |
| frames.meta | 73 | 0.02% | 0.005 | 0.10 |
| （分隔符 `{}[],:`，非键名） | 109,297 | 26.01% | | |
| （键名 `"key":`，共 26,907 个键） | 177,113 | 42.15% | | |
| **Σ 未压缩 JSON** | **420,170** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 350,787 | 83.49% | 4,064 | 3,121 | 23,864 | 54,951 | 23,864 | 93,185 | 26.6% |
| blockPalette | 33,026 | 7.86% | 506 | 114 | 2,976 | 2,857 | 2,976 | 7,073 | 21.4% |
| textureBlobs | 13,451 | 3.20% | 0 | 1 | 0 | 9 | 0 | 11 | 0.1% |
| cellTooltipGrid | 12,259 | 2.92% | 0 | 229 | 0 | 3,970 | 0 | 4,428 | 36.1% |
| cellGrid | 8,739 | 2.08% | 0 | 229 | 0 | 3,970 | 0 | 4,428 | 50.7% |
| materialPalette | 1,075 | 0.26% | 10 | 1 | 40 | 39 | 40 | 101 | 9.4% |
| meta | 242 | 0.06% | 2 | 1 | 9 | 8 | 9 | 23 | 9.5% |
| tooltipPalette | 147 | 0.03% | 0 | 1 | 0 | 5 | 0 | 7 | 4.8% |
| description | 99 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| id | 21 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 21 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| annotations | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| labels | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **419,923** | — | | | | | | | |（与未压缩 420,170 的差 = 顶层键名与顶层分隔符 247） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 9,673 |
| frames | 8,401 |
| blockPalette | 857 |
| cellGrid | 329 |
| cellTooltipGrid | 311 |
| materialPalette | 204 |
| meta | 162 |
| description | 98 |
| tooltipPalette | 83 |
| author | 31 |
| label | 29 |
| modSource | 29 |
| id | 26 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |
| annotations | 16 |
| labels | 11 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.frames[].structure.cellTooltipGrid[][][]` | 16032 | 31,512 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 3072 | 24,576 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 16032 | 17,689 | grid.cellGrid |
| `$.textureBlobs[]` | 10 | 13,440 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 3072 | 12,288 | palette.geometry |
| `$.cellTooltipGrid[][][]` | 3971 | 7,831 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 3072 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 3072 | 7,680 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 3072 | 6,144 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 3072 | 6,144 | palette.geometry |
| `$.cellGrid[][][]` | 3971 | 4,311 | grid.cellGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].z` | 3072 | 3,072 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 384 | 3,072 | palette.geometry |
| `$.frames[].structure.blockPalette[].registryId` | 104 | 2,120 | palette.meta |
| `$.frames[].structure.blockPalette[].geometry.encoding` | 104 | 1,872 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 384 | 1,536 | palette.geometry |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 3,456 | 44,928 | 13.00 |
| `color` | 3,456 | 27,648 | 8.00 |
| `x` | 3,457 | 13,828 | 4.00 |
| `y` | 3,457 | 13,828 | 4.00 |
| `z` | 3,457 | 13,828 | 4.00 |
| `materialIndex` | 864 | 13,824 | 16.00 |
| `u` | 3,456 | 13,824 | 4.00 |
| `v` | 3,456 | 13,824 | 4.00 |
| `occludesAdjacentFaces` | 117 | 2,808 | 24.00 |
| `registryId` | 117 | 1,521 | 13.00 |
| `renderMode` | 117 | 1,521 | 13.00 |
| `encoding` | 117 | 1,287 | 11.00 |
| `meta` | 117 | 819 | 7.00 |
| `textureBlobIndex` | 10 | 190 | 19.00 |
| `geometryPhase` | 8 | 128 | 16.00 |
| `blendMode` | 10 | 120 | 12.00 |


---

### scripts/volume-profile/samples/F-decorated.envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 7,393 | 7.2 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 7,330 | 7.2 | 分桶统计口径 |
| gzip(level 9) | 5,542 | 5.4 | 压缩后 payload |
| base64(gzip) | 7,392 | 7.2 | 信封 payload 字符串本体 |
| 压缩率 | 75.61% | — | gzip/未压缩 |
| base64 膨胀 | 133.38% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 7,330 vs 去空白 7,330）
- 三分解闭合：Σ叶子 7,187 + 分隔符 24 + 键名(不含冒号) 119 = 7,330；去空白原文 7,330 → **闭合**；叶子 10 个，对象 2 个 / 数组 0 个 / 键 11 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 9、`:` 11（合计 24）
- 键名审计：键名总量（含冒号）130；扫描器逐条定位到的键 token 123（10 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 6,970 | 95.09% | — | — |
| doc_meta | 217 | 2.96% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 6,970 | 95.09% | — | — |
| doc.meta | 217 | 2.96% | — | — |
| （分隔符 `{}[],:`，非键名） | 24 | 0.33% | | |
| （键名 `"key":`，共 11 个键） | 130 | 1.77% | | |
| **Σ 未压缩 JSON** | **7,330** | **100.00%** | | |

**最大字段族（Top 10，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 6,970 | other:$.payload |
| `$.meta.description` | 1 | 101 | doc.meta |
| `$.meta.id` | 1 | 23 | doc.meta |
| `$.meta.label` | 1 | 23 | doc.meta |
| `$.meta.author` | 1 | 22 | doc.meta |
| `$.meta.modSource` | 1 | 17 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 7 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 10，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 7,393 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 6,968 | 94.25% 的文件 |
| 非 payload 结构开销 | 425 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 280） |
| payload 解 base64 后（gzip 流） | 5,225 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 38,113 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 5,225 | 与 mod 侧 gzip 流差 0 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 6,968 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`2abade748a897d8e384d51ea5c4685b0f4cdb0a9aef1733d5ce6d9447cc132ad`
- meta 键：[id, label, author, gtnhVersion, description, modSource, schemaVersion]
- payload 内层键：[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### scripts/volume-profile/samples/F-decorated.envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 38,113 | 37.2 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 38,113 | 37.2 | 分桶统计口径 |
| gzip(level 9) | 5,225 | 5.1 | 压缩后 payload |
| base64(gzip) | 6,968 | 6.8 | 信封 payload 字符串本体 |
| 压缩率 | 13.71% | — | gzip/未压缩 |
| base64 膨胀 | 133.36% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 38,113 vs 去空白 38,113）
- 三分解闭合：Σ叶子 15,422 + 分隔符 7,644 + 键名(不含冒号) 15,047 = 38,113；去空白原文 38,113 → **闭合**；叶子 3,521 个，对象 455 个 / 数组 280 个 / 键 2,654 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 910、`[]` 560、`,` 3,520、`:` 2,654（合计 7,644）
- 键名审计：键名总量（含冒号）17,701；扫描器逐条定位到的键 token 16,348（2,531 个），未定位差额 1,353 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[frames, materialPalette, blockPalette, cellGrid, cellTooltipGrid, textureBlobs, tooltipPalette]
  - 帧 0：cellGrid 7×5×7(x×y×z)，格 245（非空 170），palette 条目 7，quad 42，材质 4，textureBlob 4，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 7,728 | 20.28% | 31.543 | 184.00 |
| texture | 5,376 | 14.11% | 21.943 | 128.00 |
| grid | 1,412 | 3.70% | 5.763 | 33.62 |
| palette | 618 | 1.62% | 2.522 | 14.71 |
| material | 223 | 0.59% | 0.910 | 5.31 |
| pools | 48 | 0.13% | 0.196 | 1.14 |
| frames_meta | 10 | 0.03% | 0.041 | 0.24 |
| doc_meta | 7 | 0.02% | 0.029 | 0.17 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 7,728 | 20.28% | 31.543 | 184.00 |
| texture.blobs | 5,376 | 14.11% | 21.943 | 128.00 |
| grid.cellTooltipGrid | 922 | 2.42% | 3.763 | 21.95 |
| palette.meta | 618 | 1.62% | 2.522 | 14.71 |
| grid.cellGrid | 490 | 1.29% | 2.000 | 11.67 |
| material.entries | 223 | 0.59% | 0.910 | 5.31 |
| pool.tooltip | 48 | 0.13% | 0.196 | 1.14 |
| frames.meta | 10 | 0.03% | 0.041 | 0.24 |
| doc.meta | 7 | 0.02% | 0.029 | 0.17 |
| （分隔符 `{}[],:`，非键名） | 7,644 | 20.06% | | |
| （键名 `"key":`，共 2,654 个键） | 17,701 | 46.44% | | |
| **Σ 未压缩 JSON** | **38,113** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 16,121 | 42.30% | 226 | 139 | 1,319 | 1,750 | 1,319 | 3,799 | 23.6% |
| blockPalette | 14,639 | 38.41% | 224 | 52 | 1,312 | 1,257 | 1,312 | 3,121 | 21.3% |
| textureBlobs | 5,381 | 14.12% | 0 | 1 | 0 | 3 | 0 | 5 | 0.1% |
| cellTooltipGrid | 791 | 2.08% | 0 | 43 | 0 | 244 | 0 | 330 | 41.7% |
| cellGrid | 575 | 1.51% | 0 | 43 | 0 | 244 | 0 | 330 | 57.4% |
| materialPalette | 444 | 1.16% | 4 | 1 | 16 | 15 | 16 | 41 | 9.2% |
| tooltipPalette | 51 | 0.13% | 0 | 1 | 0 | 1 | 0 | 3 | 5.9% |
| **Σ 子树** | **38,002** | — | | | | | | | |（与未压缩 38,113 的差 = 顶层键名与顶层分隔符 111） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 3,928 |
| frames | 835 |
| blockPalette | 583 |
| materialPalette | 161 |
| cellGrid | 126 |
| cellTooltipGrid | 110 |
| tooltipPalette | 68 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 4 | 5,376 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.frames[].structure.cellTooltipGrid[][][]` | 245 | 461 | grid.cellTooltipGrid |
| `$.cellTooltipGrid[][][]` | 245 | 461 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 245 | 245 | grid.cellGrid |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 336 | 4,368 | 13.00 |
| `color` | 336 | 2,688 | 8.00 |
| `materialIndex` | 84 | 1,344 | 16.00 |
| `x` | 336 | 1,344 | 4.00 |
| `y` | 336 | 1,344 | 4.00 |
| `z` | 336 | 1,344 | 4.00 |
| `u` | 336 | 1,344 | 4.00 |
| `v` | 336 | 1,344 | 4.00 |
| `occludesAdjacentFaces` | 14 | 336 | 24.00 |
| `registryId` | 14 | 182 | 13.00 |
| `renderMode` | 14 | 182 | 13.00 |
| `encoding` | 14 | 154 | 11.00 |
| `meta` | 14 | 98 | 7.00 |
| `textureBlobIndex` | 4 | 76 | 19.00 |
| `blendMode` | 4 | 48 | 12.00 |
| `locator` | 4 | 40 | 10.00 |


---

### scripts/volume-profile/samples/F-decorated.plain.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 39,618 | 38.7 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 39,617 | 38.7 | 分桶统计口径 |
| gzip(level 9) | 5,994 | 5.9 | 压缩后 payload |
| base64(gzip) | 7,992 | 7.8 | 信封 payload 字符串本体 |
| 压缩率 | 15.13% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 39,617 vs 去空白 39,617）
- 三分解闭合：Σ叶子 16,148 + 分隔符 7,815 + 键名(不含冒号) 15,654 = 39,617；去空白原文 39,617 → **闭合**；叶子 3,590 个，对象 465 个 / 数组 283 个 / 键 2,730 个，空白缩进 1 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 930、`[]` 566、`,` 3,589、`:` 2,730（合计 7,815）
- 键名审计：键名总量（含冒号）18,384；扫描器逐条定位到的键 token 16,961（2,598 个），未定位差额 1,423 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=2.0 / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[format_version, id, label, gtnhVersion, author, description, modSource, schemaVersion, meta, frames, annotations, labels, materialPalette, textureBlobs, tooltipPalette, cellGrid, blockPalette, cellTooltipGrid]
  - 帧 0：cellGrid 7×5×7(x×y×z)，格 245（非空 170），palette 条目 7，quad 42，材质 4，textureBlob 4，cellTooltipGrid=true
- 注解 2 条 / 标签 2 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 7,728 | 19.51% | 31.543 | 184.00 |
| texture | 5,376 | 13.57% | 21.943 | 128.00 |
| grid | 1,412 | 3.56% | 5.763 | 33.62 |
| palette | 618 | 1.56% | 2.522 | 14.71 |
| annotations | 369 | 0.93% | 1.506 | 8.79 |
| doc_meta | 364 | 0.92% | 1.486 | 8.67 |
| material | 223 | 0.56% | 0.910 | 5.31 |
| pools | 48 | 0.12% | 0.196 | 1.14 |
| frames_meta | 10 | 0.03% | 0.041 | 0.24 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 7,728 | 19.51% | 31.543 | 184.00 |
| texture.blobs | 5,376 | 13.57% | 21.943 | 128.00 |
| grid.cellTooltipGrid | 922 | 2.33% | 3.763 | 21.95 |
| palette.meta | 618 | 1.56% | 2.522 | 14.71 |
| grid.cellGrid | 490 | 1.24% | 2.000 | 11.67 |
| doc.meta | 364 | 0.92% | 1.486 | 8.67 |
| annotations | 286 | 0.72% | 1.167 | 6.81 |
| material.entries | 223 | 0.56% | 0.910 | 5.31 |
| labels | 83 | 0.21% | 0.339 | 1.98 |
| pool.tooltip | 48 | 0.12% | 0.196 | 1.14 |
| frames.meta | 10 | 0.03% | 0.041 | 0.24 |
| （分隔符 `{}[],:`，非键名） | 7,815 | 19.73% | | |
| （键名 `"key":`，共 2,730 个键） | 18,384 | 46.40% | | |
| **Σ 未压缩 JSON** | **39,617** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 16,121 | 40.69% | 226 | 139 | 1,319 | 1,750 | 1,319 | 3,799 | 23.6% |
| blockPalette | 14,639 | 36.95% | 224 | 52 | 1,312 | 1,257 | 1,312 | 3,121 | 21.3% |
| textureBlobs | 5,381 | 13.58% | 0 | 1 | 0 | 3 | 0 | 5 | 0.1% |
| cellTooltipGrid | 791 | 2.00% | 0 | 43 | 0 | 244 | 0 | 330 | 41.7% |
| annotations | 709 | 1.79% | 6 | 1 | 40 | 35 | 40 | 89 | 12.6% |
| cellGrid | 575 | 1.45% | 0 | 43 | 0 | 244 | 0 | 330 | 57.4% |
| materialPalette | 444 | 1.12% | 4 | 1 | 16 | 15 | 16 | 41 | 9.2% |
| meta | 246 | 0.62% | 2 | 1 | 9 | 8 | 9 | 23 | 9.3% |
| labels | 212 | 0.54% | 2 | 1 | 16 | 15 | 16 | 37 | 17.5% |
| description | 101 | 0.25% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tooltipPalette | 51 | 0.13% | 0 | 1 | 0 | 1 | 0 | 3 | 5.9% |
| id | 23 | 0.06% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| label | 23 | 0.06% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| author | 22 | 0.06% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| modSource | 17 | 0.04% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| gtnhVersion | 7 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| format_version | 5 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| schemaVersion | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **39,368** | — | | | | | | | |（与未压缩 39,617 的差 = 顶层键名与顶层分隔符 249） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 3,928 |
| frames | 835 |
| blockPalette | 583 |
| annotations | 333 |
| meta | 161 |
| materialPalette | 161 |
| cellGrid | 126 |
| labels | 121 |
| cellTooltipGrid | 110 |
| description | 98 |
| tooltipPalette | 68 |
| label | 31 |
| author | 31 |
| modSource | 29 |
| id | 28 |
| format_version | 22 |
| gtnhVersion | 21 |
| schemaVersion | 17 |

**最大字段族（Top 16，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 4 | 5,376 | texture.blobs |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 168 | 1,344 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 168 | 672 | palette.geometry |
| `$.frames[].structure.cellTooltipGrid[][][]` | 245 | 461 | grid.cellTooltipGrid |
| `$.cellTooltipGrid[][][]` | 245 | 461 | grid.cellTooltipGrid |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 168 | 420 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 168 | 420 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.frames[].structure.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 168 | 336 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 168 | 336 | palette.geometry |
| `$.frames[].structure.cellGrid[][][]` | 245 | 245 | grid.cellGrid |

**按 JSON 键名聚合（Top 16，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 336 | 4,368 | 13.00 |
| `color` | 340 | 2,720 | 8.00 |
| `x` | 343 | 1,372 | 4.00 |
| `y` | 343 | 1,372 | 4.00 |
| `z` | 343 | 1,372 | 4.00 |
| `materialIndex` | 84 | 1,344 | 16.00 |
| `u` | 336 | 1,344 | 4.00 |
| `v` | 336 | 1,344 | 4.00 |
| `occludesAdjacentFaces` | 14 | 336 | 24.00 |
| `registryId` | 14 | 182 | 13.00 |
| `renderMode` | 14 | 182 | 13.00 |
| `encoding` | 14 | 154 | 11.00 |
| `meta` | 14 | 98 | 7.00 |
| `textureBlobIndex` | 4 | 76 | 19.00 |
| `description` | 4 | 56 | 14.00 |
| `blendMode` | 4 | 48 | 12.00 |


---

