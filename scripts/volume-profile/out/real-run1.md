# 体积剖析原始输出

- 工具：`scripts/volume-profile/volume-profile.mjs`（本文件不含时间戳，便于逐字节比对两次运行结果）
- 文件数：1

## 汇总表

| 文件 | 落盘 | 未压缩 JSON | gzip | base64 | 帧 | cellGrid 规模 | palette 条目 | quad | 材质 | textureBlob |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| web/e2e/fixtures/structuredata-exported-envelope.json | 204,887 | 204,824 | 152,774 | 203,700 | 1 | ? | 0 | 0 | 0 | 0 |

## 逐文件明细

### web/e2e/fixtures/structuredata-exported-envelope.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 204,887 | 200.1 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 204,824 | 200.0 | 分桶统计口径 |
| gzip(level 9) | 152,774 | 149.2 | 压缩后 payload |
| base64(gzip) | 203,700 | 198.9 | 信封 payload 字符串本体 |
| 压缩率 | 74.59% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 204,824 vs 去空白 204,824）
- 三分解闭合：Σ叶子 204,708 + 分隔符 20 + 键名(不含冒号) 96 = 204,824；去空白原文 204,824 → **闭合**；叶子 8 个，对象 2 个 / 数组 0 个 / 键 9 个，空白缩进 63 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 7、`:` 9（合计 20）
- 键名审计：键名总量（含冒号）105；扫描器逐条定位到的键 token 98（8 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 204,614 | 99.90% | — | — |
| doc_meta | 94 | 0.05% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 204,614 | 99.90% | — | — |
| doc.meta | 94 | 0.05% | — | — |
| （分隔符 `{}[],:`，非键名） | 20 | 0.01% | | |
| （键名 `"key":`，共 9 个键） | 105 | 0.05% | | |
| **Σ 未压缩 JSON** | **204,824** | **100.00%** | | |

**最大字段族（Top 8，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 204,614 | other:$.payload |
| `$.meta.id` | 1 | 24 | doc.meta |
| `$.meta.label` | 1 | 24 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.meta.author` | 1 | 11 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.documentFormat` | 1 | 7 | doc.meta |
| `$.meta.gtnhVersion` | 1 | 5 | doc.meta |

**按 JSON 键名聚合（Top 7，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `documentFormat` | 2 | 34 | 17.00 |
| `payloadEncoding` | 1 | 18 | 18.00 |
| `gtnhVersion` | 1 | 14 | 14.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 204,887 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 204,612 | 99.87% 的文件 |
| 非 payload 结构开销 | 275 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 130） |
| payload 解 base64 后（gzip 流） | 153,458 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 1,333,749 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 151,423 | 与 mod 侧 gzip 流差 -2,035 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 201,900 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`96d65f1cdc720a667ed18c2bebcbf9a003a126cb3299158cc5126a45008f1f89`
- meta 键：[id, label, author, gtnhVersion, documentFormat]
- payload 内层键：[blockPalette, materialPalette, cellGrid, cellTooltipGrid, textureBlobs, geometryPhase, source, scanBounds, tooltipPalette]

**内层 payload 剖析（信封内的真实内容）**

### web/e2e/fixtures/structuredata-exported-envelope.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 1,333,749 | 1302.5 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 1,333,749 | 1302.5 | 分桶统计口径 |
| gzip(level 9) | 151,423 | 147.9 | 压缩后 payload |
| base64(gzip) | 201,900 | 197.2 | 信封 payload 字符串本体 |
| 压缩率 | 11.35% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 1,333,749 vs 去空白 1,333,749）
- 三分解闭合：Σ叶子 758,375 + 分隔符 177,271 + 键名(不含冒号) 398,103 = 1,333,749；去空白原文 1,333,749 → **闭合**；叶子 71,320 个，对象 14,371 个 / 数组 2,526 个 / 键 72,158 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 28,742、`[]` 5,052、`,` 71,319、`:` 72,158（合计 177,271）
- 键名审计：键名总量（含冒号）470,261；扫描器逐条定位到的键 token 439,485（69,258 个），未定位差额 30,776 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[blockPalette, materialPalette, cellGrid, cellTooltipGrid, textureBlobs, geometryPhase, mode, source, scanBounds, tooltipPalette]
  - 帧 0：cellGrid 19×6×7(x×y×z)，格 798（非空 173），palette 条目 68，quad 2,207，材质 62，textureBlob 57，cellTooltipGrid=true
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| geometry | 533,990 | 40.04% | 669.160 | 241.95 |
| texture | 135,662 | 10.17% | 170.003 | 61.47 |
| palette | 81,280 | 6.09% | 101.855 | 36.83 |
| material | 4,508 | 0.34% | 5.649 | 2.04 |
| grid | 2,483 | 0.19% | 3.112 | 1.13 |
| pools | 398 | 0.03% | 0.499 | 0.18 |
| doc_meta | 54 | 0.00% | 0.068 | 0.02 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.geometry | 533,990 | 40.04% | 669.160 | 241.95 |
| texture.blobs | 135,662 | 10.17% | 170.003 | 61.47 |
| palette.meta | 81,280 | 6.09% | 101.855 | 36.83 |
| material.entries | 4,508 | 0.34% | 5.649 | 2.04 |
| grid.cellTooltipGrid | 1,586 | 0.12% | 1.987 | 0.72 |
| grid.cellGrid | 897 | 0.07% | 1.124 | 0.41 |
| pool.tooltip | 398 | 0.03% | 0.499 | 0.18 |
| doc.meta | 54 | 0.00% | 0.068 | 0.02 |
| （分隔符 `{}[],:`，非键名） | 177,271 | 13.29% | | |
| （键名 `"key":`，共 72,158 个键） | 470,261 | 35.26% | | |
| **Σ 未压缩 JSON** | **1,333,749** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blockPalette | 1,179,471 | 88.43% | 14,224 | 2,421 | 71,622 | 69,130 | 71,622 | 174,042 | 14.8% |
| textureBlobs | 135,720 | 10.18% | 0 | 1 | 0 | 56 | 0 | 58 | 0.0% |
| materialPalette | 10,743 | 0.81% | 144 | 3 | 522 | 513 | 522 | 1,329 | 12.4% |
| cellTooltipGrid | 2,483 | 0.19% | 0 | 50 | 0 | 797 | 0 | 897 | 36.1% |
| cellGrid | 1,794 | 0.13% | 0 | 50 | 0 | 797 | 0 | 897 | 50.0% |
| tooltipPalette | 171 | 0.01% | 0 | 1 | 0 | 15 | 0 | 17 | 9.9% |
| source | 37 | 0.00% | 1 | 0 | 1 | 0 | 1 | 3 | 8.1% |
| scanBounds | 32 | 0.00% | 1 | 0 | 3 | 2 | 3 | 7 | 21.9% |
| mode | 12 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| geometryPhase | 7 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **1,330,470** | — | | | | | | | |（与未压缩 1,333,749 的差 = 顶层键名与顶层分隔符 3,279） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| blockPalette | 104,184 |
| textureBlobs | 44,759 |
| materialPalette | 1,125 |
| tooltipPalette | 298 |
| cellGrid | 221 |
| cellTooltipGrid | 102 |
| source | 46 |
| scanBounds | 43 |
| geometryPhase | 23 |
| mode | 19 |

**最大字段族（Top 20，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 57 | 135,662 | texture.blobs |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 8828 | 87,180 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 8828 | 81,558 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 8828 | 81,014 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 8828 | 77,104 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 8828 | 73,678 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 8828 | 65,808 | palette.geometry |
| `$.blockPalette[].thumbnailPNG` | 67 | 62,750 | palette.meta |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 8828 | 62,672 | palette.geometry |
| `$.blockPalette[].tooltip[]` | 239 | 8,634 | palette.meta |
| `$.blockPalette[].geometry.quads[].materialIndex` | 2207 | 3,752 | palette.geometry |
| `$.blockPalette[].registryId` | 68 | 2,290 | palette.meta |
| `$.materialPalette[].locator` | 62 | 2,179 | material.entries |
| `$.cellTooltipGrid[][][]` | 798 | 1,586 | grid.cellTooltipGrid |
| `$.blockPalette[].geometry.encoding` | 68 | 1,224 | palette.geometry |
| `$.blockPalette[].nbt.id` | 65 | 1,164 | palette.meta |
| `$.cellGrid[][][]` | 798 | 897 | grid.cellGrid |
| `$.blockPalette[].renderMode` | 68 | 816 | palette.meta |
| `$.materialPalette[].kind` | 62 | 620 | material.entries |
| `$.materialPalette[].blend` | 62 | 501 | material.entries |

**按 JSON 键名聚合（Top 20，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 8,828 | 114,764 | 13.00 |
| `color` | 8,828 | 70,624 | 8.00 |
| `x` | 8,894 | 35,576 | 4.00 |
| `y` | 8,894 | 35,576 | 4.00 |
| `z` | 8,894 | 35,576 | 4.00 |
| `materialIndex` | 2,207 | 35,312 | 16.00 |
| `u` | 8,828 | 35,312 | 4.00 |
| `v` | 8,828 | 35,312 | 4.00 |
| `occludesAdjacentFaces` | 68 | 1,632 | 24.00 |
| `textureBlobIndex` | 62 | 1,178 | 19.00 |
| `thumbnailPNG` | 67 | 1,005 | 15.00 |
| `registryId` | 68 | 884 | 13.00 |
| `renderMode` | 68 | 884 | 13.00 |
| `Damage` | 91 | 819 | 9.00 |
| `useMipmaps` | 62 | 806 | 13.00 |
| `id` | 159 | 795 | 5.00 |
| `encoding` | 68 | 748 | 11.00 |
| `Count` | 91 | 728 | 8.00 |
| `cellRestrictionAmount` | 26 | 624 | 24.00 |
| `locator` | 62 | 620 | 10.00 |


---

