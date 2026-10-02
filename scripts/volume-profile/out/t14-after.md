# 体积剖析原始输出

- 工具：`scripts/volume-profile/volume-profile.mjs`（本文件不含时间戳，便于逐字节比对两次运行结果）
- 文件数：4

## 汇总表

| 文件 | 落盘 | 未压缩 JSON | gzip | base64 | 帧 | cellGrid 规模 | palette 条目 | quad | 材质 | textureBlob |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| scripts/multiblock-encode/.out/profile-after/mtebrickedblastfurnace.multiblock.json | 62,244 | 62,175 | 46,939 | 62,588 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/multiblock-encode/.out/profile-after/mtedistillationtower.multiblock.json | 69,847 | 69,778 | 52,072 | 69,432 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/multiblock-encode/.out/profile-after/mteelectricblastfurnace.multiblock.json | 108,754 | 108,685 | 80,352 | 107,136 | 1 | ? | 0 | 0 | 0 | 0 |
| scripts/multiblock-encode/.out/profile-after/mtequantumforcetransformer.multiblock.json | 90,596 | 90,527 | 66,404 | 88,540 | 1 | ? | 0 | 0 | 0 | 0 |

## 逐文件明细

### scripts/multiblock-encode/.out/profile-after/mtebrickedblastfurnace.multiblock.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 62,244 | 60.8 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 62,175 | 60.7 | 分桶统计口径 |
| gzip(level 9) | 46,939 | 45.8 | 压缩后 payload |
| base64(gzip) | 62,588 | 61.1 | 信封 payload 字符串本体 |
| 压缩率 | 75.49% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 62,175 vs 去空白 62,175）
- 三分解闭合：Σ叶子 62,022 + 分隔符 26 + 键名(不含冒号) 127 = 62,175；去空白原文 62,175 → **闭合**；叶子 11 个，对象 2 个 / 数组 0 个 / 键 12 个，空白缩进 69 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 10、`:` 12（合计 26）
- 键名审计：键名总量（含冒号）139；扫描器逐条定位到的键 token 132（11 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 61,738 | 99.30% | — | — |
| doc_meta | 284 | 0.46% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 61,738 | 99.30% | — | — |
| doc.meta | 284 | 0.46% | — | — |
| （分隔符 `{}[],:`，非键名） | 26 | 0.04% | | |
| （键名 `"key":`，共 12 个键） | 139 | 0.22% | | |
| **Σ 未压缩 JSON** | **62,175** | **100.00%** | | |

**最大字段族（Top 11，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 61,738 | other:$.payload |
| `$.meta.description` | 1 | 125 | doc.meta |
| `$.meta.id` | 1 | 45 | doc.meta |
| `$.meta.author` | 1 | 27 | doc.meta |
| `$.meta.label` | 1 | 23 | doc.meta |
| `$.meta.modSource` | 1 | 16 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.meta.mode` | 1 | 12 | doc.meta |
| `$.meta.documentShape` | 1 | 12 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 11，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `documentShape` | 1 | 16 | 16.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `mode` | 1 | 7 | 7.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 62,244 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 61,736 | 99.18% 的文件 |
| 非 payload 结构开销 | 508 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 357） |
| payload 解 base64 后（gzip 流） | 46,302 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 89,938 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 46,196 | 与 mod 侧 gzip 流差 -106 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 61,596 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`6e91f17325590548735ef790781469928d8025d1510ac03be4fbe1bc567f5c82`
- meta 键：[id, mode, label, author, description, modSource, schemaVersion, documentShape]
- payload 内层键：[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]

**内层 payload 剖析（信封内的真实内容）**

### scripts/multiblock-encode/.out/profile-after/mtebrickedblastfurnace.multiblock.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 89,938 | 87.8 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 89,938 | 87.8 | 分桶统计口径 |
| gzip(level 9) | 46,196 | 45.1 | 压缩后 payload |
| base64(gzip) | 61,596 | 60.2 | 信封 payload 字符串本体 |
| 压缩率 | 51.36% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **不一致**（重建 88,888 vs 去空白 89,938）
- 三分解闭合：Σ叶子 76,895 + 分隔符 3,379 + 键名(不含冒号) 9,664 = 89,938；去空白原文 89,938 → **闭合**；叶子 1,275 个，对象 356 个 / 数组 68 个 / 键 1,257 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 712、`[]` 136、`,` 1,274、`:` 1,257（合计 3,379）
- 键名审计：键名总量（含冒号）10,921；扫描器逐条定位到的键 token 10,018（1,183 个），未定位差额 903 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=2 / 顶层键=[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 1：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture | 59,637 | 66.31% | — | — |
| palette | 8,364 | 9.30% | — | — |
| material | 4,487 | 4.99% | — | — |
| geometry | 2,370 | 2.64% | — | — |
| other | 1,905 | 2.12% | — | — |
| frames_meta | 132 | 0.15% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture.blobs | 59,637 | 66.31% | — | — |
| palette.meta | 8,364 | 9.30% | — | — |
| material.entries | 4,487 | 4.99% | — | — |
| palette.geometry | 2,370 | 2.64% | — | — |
| other:$.multiblock.notes[].text | 567 | 0.63% | — | — |
| other:$.multiblock.opsLegend.palette.renumber | 174 | 0.19% | — | — |
| other:$.multiblock.opsLegend.channel.replace | 166 | 0.18% | — | — |
| frames.meta | 132 | 0.15% | — | — |
| other:$.multiblock.opsLegend.runstate.overlay | 117 | 0.13% | — | — |
| other:$.multiblock.opsLegend.tier.overlay | 107 | 0.12% | — | — |
| other:$.multiblock.notes[].source | 96 | 0.11% | — | — |
| other:$.multiblock.sourceClass | 68 | 0.08% | — | — |
| other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] | 68 | 0.08% | — | — |
| other:$.multiblock.rules[].id | 54 | 0.06% | — | — |
| other:$.multiblock.rules[].legend | 54 | 0.06% | — | — |
| other:$.multiblock.id | 45 | 0.05% | — | — |
| other:$.multiblock.variants[].key | 42 | 0.05% | — | — |
| other:$.multiblock.rules[].phase | 30 | 0.03% | — | — |
| other:$.multiblock.rules[].kind | 27 | 0.03% | — | — |
| other:$.multiblock.displayName | 23 | 0.03% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.kind | 23 | 0.03% | — | — |
| other:$.multiblock.paletteSource | 20 | 0.02% | — | — |
| other:$.multiblock.notes[].kind | 18 | 0.02% | — | — |
| other:$.multiblock.geometryEncoding | 18 | 0.02% | — | — |
| other:$.multiblock.viewerSemantics.playback | 16 | 0.02% | — | — |
| other:$.multiblock.totalTierDomain.source | 15 | 0.02% | — | — |
| other:$.multiblock.runstates[].name | 15 | 0.02% | — | — |
| other:$.multiblock.runstates[].id | 14 | 0.02% | — | — |
| other:$.multiblock.variants[].runstate | 14 | 0.02% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.tesr | 13 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.layerPreview | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.kind | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeChannel | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].channel | 11 | 0.01% | — | — |
| other:$.multiblock.runstates[].materialSwap | 9 | 0.01% | — | — |
| other:$.multiblock.couplingMode | 6 | 0.01% | — | — |
| other:$.multiblock.hasScopeOverlap | 5 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.geometryDelta | 5 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.frameIsVariant | 4 | 0.00% | — | — |
| other:$.multiblock.rules[].x | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].y | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].z | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].index | 3 | 0.00% | — | — |
| other:$.multiblock.variants[].totalTier | 2 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.max | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.multiblock.tierSample[] | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].layers | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].w | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].hh | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].d | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].roles.casing | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.0 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.31 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.32 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.33 | 1 | 0.00% | — | — |
| other:$.multiblockCount | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 3,379 | 3.76% | | |
| （键名 `"key":`，共 1,257 个键） | 10,921 | 12.14% | | |
| **Σ 未压缩 JSON** | **89,938** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| textureBlobs | 59,434 | 66.08% | 0 | 1 | 0 | 50 | 0 | 52 | 0.1% |
| blockPalette | 14,846 | 16.51% | 103 | 28 | 605 | 578 | 605 | 1,445 | 9.7% |
| materialPalette | 11,232 | 12.49% | 229 | 11 | 539 | 511 | 539 | 1,530 | 13.6% |
| multiblock | 2,405 | 2.67% | 21 | 24 | 96 | 118 | 96 | 304 | 12.6% |
| frames | 251 | 0.28% | 2 | 3 | 10 | 11 | 10 | 31 | 12.4% |
| tooltipPalette | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| multiblockCount | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **88,171** | — | | | | | | | |（与未压缩 89,938 的差 = 顶层键名与顶层分隔符 1,767） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 38,538 |
| blockPalette | 4,440 |
| multiblock | 1,643 |
| materialPalette | 1,105 |
| frames | 119 |
| tooltipPalette | 19 |
| multiblockCount | 19 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 51 | 59,637 | texture.blobs |
| `$.blockPalette[].thumbnailPNG` | 3 | 8,204 | palette.meta |
| `$.materialPalette[].locator` | 56 | 2,696 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 76 | 608 | palette.geometry |
| `$.multiblock.notes[].text` | 3 | 567 | other:$.multiblock.notes[].text |
| `$.materialPalette[].kind` | 56 | 560 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 76 | 512 | palette.geometry |
| `$.materialPalette[].atlas` | 56 | 448 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 76 | 228 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 76 | 228 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 76 | 228 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 76 | 228 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 76 | 228 | palette.geometry |
| `$.materialPalette[].linear` | 56 | 224 | material.entries |
| `$.materialPalette[].useMipmaps` | 56 | 224 | material.entries |
| `$.materialPalette[].animation.frameSequence[].index` | 156 | 210 | material.entries |
| `$.multiblock.opsLegend.palette.renumber` | 1 | 174 | other:$.multiblock.opsLegend.palette.renumber |
| `$.multiblock.opsLegend.channel.replace` | 1 | 166 | other:$.multiblock.opsLegend.channel.replace |
| `$.multiblock.opsLegend.runstate.overlay` | 1 | 117 | other:$.multiblock.opsLegend.runstate.overlay |
| `$.multiblock.opsLegend.tier.overlay` | 1 | 107 | other:$.multiblock.opsLegend.tier.overlay |
| `$.materialPalette[].textureBlobIndex` | 56 | 98 | material.entries |
| `$.multiblock.notes[].source` | 3 | 96 | other:$.multiblock.notes[].source |
| `$.blockPalette[].registryId` | 4 | 86 | palette.meta |
| `$.frames[].rules[]` | 4 | 72 | frames.meta |
| `$.blockPalette[].geometry.encoding` | 4 | 72 | palette.geometry |
| `$.multiblock.sourceClass` | 1 | 68 | other:$.multiblock.sourceClass |
| `$.multiblock.backbone.sizeSteps[].cellGrid[][][]` | 36 | 68 | other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] |
| `$.multiblock.rules[].id` | 3 | 54 | other:$.multiblock.rules[].id |
| `$.multiblock.rules[].legend` | 3 | 54 | other:$.multiblock.rules[].legend |
| `$.blockPalette[].renderMode` | 4 | 48 | palette.meta |
| `$.multiblock.id` | 1 | 45 | other:$.multiblock.id |
| `$.frames[].variant` | 2 | 42 | frames.meta |
| `$.multiblock.variants[].key` | 2 | 42 | other:$.multiblock.variants[].key |
| `$.blockPalette[].geometry.quads[].materialIndex` | 19 | 38 | palette.geometry |
| `$.multiblock.rules[].phase` | 3 | 30 | other:$.multiblock.rules[].phase |
| `$.multiblock.rules[].kind` | 3 | 27 | other:$.multiblock.rules[].kind |
| `$.multiblock.displayName` | 1 | 23 | other:$.multiblock.displayName |
| `$.multiblock.viewerSemantics.runstateCoverage.kind` | 1 | 23 | other:$.multiblock.viewerSemantics.runstateCoverage.kind |
| `$.multiblock.paletteSource` | 1 | 20 | other:$.multiblock.paletteSource |
| `$.blockPalette[].occludesAdjacentFaces` | 4 | 19 | palette.meta |
| `$.materialPalette[].animation.defaultFrametimeTicks` | 17 | 18 | material.entries |
| `$.multiblock.notes[].kind` | 3 | 18 | other:$.multiblock.notes[].kind |
| `$.multiblock.geometryEncoding` | 1 | 18 | other:$.multiblock.geometryEncoding |
| `$.multiblock.viewerSemantics.playback` | 1 | 16 | other:$.multiblock.viewerSemantics.playback |
| `$.multiblock.totalTierDomain.source` | 1 | 15 | other:$.multiblock.totalTierDomain.source |
| `$.multiblock.runstates[].name` | 2 | 15 | other:$.multiblock.runstates[].name |
| `$.frames[].runstate` | 2 | 14 | frames.meta |
| `$.multiblock.runstates[].id` | 2 | 14 | other:$.multiblock.runstates[].id |
| `$.multiblock.variants[].runstate` | 2 | 14 | other:$.multiblock.variants[].runstate |
| `$.multiblock.viewerSemantics.runstateCoverage.tesr` | 1 | 13 | other:$.multiblock.viewerSemantics.runstateCoverage.tesr |
| `$.multiblock.viewerSemantics.layerPreview` | 1 | 11 | other:$.multiblock.viewerSemantics.layerPreview |
| `$.multiblock.backbone.kind` | 1 | 11 | other:$.multiblock.backbone.kind |
| `$.multiblock.backbone.sizeChannel` | 1 | 11 | other:$.multiblock.backbone.sizeChannel |
| `$.multiblock.backbone.sizeSteps[].channel` | 1 | 11 | other:$.multiblock.backbone.sizeSteps[].channel |
| `$.multiblock.runstates[].materialSwap` | 2 | 9 | other:$.multiblock.runstates[].materialSwap |
| `$.blockPalette[].meta` | 4 | 7 | palette.meta |
| `$.multiblock.couplingMode` | 1 | 6 | other:$.multiblock.couplingMode |
| `$.materialPalette[].animation.frameSequence[].timeTicks` | 2 | 5 | material.entries |
| `$.multiblock.hasScopeOverlap` | 1 | 5 | other:$.multiblock.hasScopeOverlap |
| `$.multiblock.viewerSemantics.runstateCoverage.geometryDelta` | 1 | 5 | other:$.multiblock.viewerSemantics.runstateCoverage.geometryDelta |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `index` | 161 | 1,288 | 8.00 |
| `textureBlobIndex` | 56 | 1,064 | 19.00 |
| `brightness` | 76 | 988 | 13.00 |
| `useMipmaps` | 56 | 728 | 13.00 |
| `color` | 76 | 608 | 8.00 |
| `locator` | 56 | 560 | 10.00 |
| `linear` | 56 | 504 | 9.00 |
| `kind` | 64 | 448 | 7.00 |
| `atlas` | 56 | 448 | 8.00 |
| `defaultFrametimeTicks` | 17 | 408 | 24.00 |
| `x` | 79 | 316 | 4.00 |
| `y` | 79 | 316 | 4.00 |
| `z` | 79 | 316 | 4.00 |
| `materialIndex` | 19 | 304 | 16.00 |
| `u` | 76 | 304 | 4.00 |
| `v` | 76 | 304 | 4.00 |
| `occludesAdjacentFaces` | 4 | 96 | 24.00 |
| `registryId` | 4 | 52 | 13.00 |
| `renderMode` | 4 | 52 | 13.00 |
| `thumbnailPNG` | 3 | 45 | 15.00 |
| `runstate` | 4 | 44 | 11.00 |
| `encoding` | 4 | 44 | 11.00 |
| `tooltip` | 4 | 40 | 10.00 |
| `source` | 4 | 36 | 9.00 |
| `id` | 6 | 30 | 5.00 |
| `materialSwap` | 2 | 30 | 15.00 |
| `meta` | 4 | 28 | 7.00 |
| `legend` | 3 | 27 | 9.00 |
| `stepIndex` | 2 | 24 | 12.00 |
| `timeTicks` | 2 | 24 | 12.00 |
| `phase` | 3 | 24 | 8.00 |
| `totalTier` | 2 | 24 | 12.00 |
| `text` | 3 | 21 | 7.00 |
| `variant` | 2 | 20 | 10.00 |
| `geometryEncoding` | 1 | 19 | 19.00 |
| `palette.renumber` | 1 | 19 | 19.00 |
| `runstate.overlay` | 1 | 19 | 19.00 |
| `hasScopeOverlap` | 1 | 18 | 18.00 |
| `channel.replace` | 1 | 18 | 18.00 |
| `values` | 2 | 18 | 9.00 |
| `multiblockCount` | 1 | 18 | 18.00 |
| `tooltipPalette` | 1 | 17 | 17.00 |
| `frameIsVariant` | 1 | 17 | 17.00 |
| `geometryDelta` | 1 | 16 | 16.00 |
| `paletteSource` | 1 | 16 | 16.00 |
| `couplingMode` | 1 | 15 | 15.00 |
| `layerPreview` | 1 | 15 | 15.00 |
| `tier.overlay` | 1 | 15 | 15.00 |
| `interpolate` | 1 | 14 | 14.00 |
| `displayName` | 1 | 14 | 14.00 |
| `sourceClass` | 1 | 14 | 14.00 |
| `name` | 2 | 14 | 7.00 |
| `sizeChannel` | 1 | 14 | 14.00 |
| `couplings` | 1 | 12 | 12.00 |
| `key` | 2 | 12 | 6.00 |
| `channels` | 1 | 11 | 11.00 |
| `playback` | 1 | 11 | 11.00 |
| `default` | 1 | 10 | 10.00 |
| `channel` | 1 | 10 | 10.00 |
| `layers` | 1 | 9 | 9.00 |


---

### scripts/multiblock-encode/.out/profile-after/mtedistillationtower.multiblock.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 69,847 | 68.2 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 69,778 | 68.1 | 分桶统计口径 |
| gzip(level 9) | 52,072 | 50.9 | 压缩后 payload |
| base64(gzip) | 69,432 | 67.8 | 信封 payload 字符串本体 |
| 压缩率 | 74.63% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 69,778 vs 去空白 69,778）
- 三分解闭合：Σ叶子 69,625 + 分隔符 26 + 键名(不含冒号) 127 = 69,778；去空白原文 69,778 → **闭合**；叶子 11 个，对象 2 个 / 数组 0 个 / 键 12 个，空白缩进 69 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 10、`:` 12（合计 26）
- 键名审计：键名总量（含冒号）139；扫描器逐条定位到的键 token 132（11 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 69,346 | 99.38% | — | — |
| doc_meta | 279 | 0.40% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 69,346 | 99.38% | — | — |
| doc.meta | 279 | 0.40% | — | — |
| （分隔符 `{}[],:`，非键名） | 26 | 0.04% | | |
| （键名 `"key":`，共 12 个键） | 139 | 0.20% | | |
| **Σ 未压缩 JSON** | **69,778** | **100.00%** | | |

**最大字段族（Top 11，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 69,346 | other:$.payload |
| `$.meta.description` | 1 | 125 | doc.meta |
| `$.meta.id` | 1 | 43 | doc.meta |
| `$.meta.author` | 1 | 27 | doc.meta |
| `$.meta.label` | 1 | 20 | doc.meta |
| `$.meta.modSource` | 1 | 16 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.meta.mode` | 1 | 12 | doc.meta |
| `$.meta.documentShape` | 1 | 12 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 11，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `documentShape` | 1 | 16 | 16.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `mode` | 1 | 7 | 7.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 69,847 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 69,344 | 99.28% 的文件 |
| 非 payload 结构开销 | 503 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 352） |
| payload 解 base64 后（gzip 流） | 52,006 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 167,461 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 51,518 | 与 mod 侧 gzip 流差 -488 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 68,692 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`31f41786489c7b73103e9683dd7a9d69214e6f6597d461d3f22d2ccf7b34c42f`
- meta 键：[id, mode, label, author, description, modSource, schemaVersion, documentShape]
- payload 内层键：[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]

**内层 payload 剖析（信封内的真实内容）**

### scripts/multiblock-encode/.out/profile-after/mtedistillationtower.multiblock.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 167,461 | 163.5 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 167,461 | 163.5 | 分桶统计口径 |
| gzip(level 9) | 51,518 | 50.3 | 压缩后 payload |
| base64(gzip) | 68,692 | 67.1 | 信封 payload 字符串本体 |
| 压缩率 | 30.76% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **不一致**（重建 164,356 vs 去空白 167,461）
- 三分解闭合：Σ叶子 113,925 + 分隔符 14,932 + 键名(不含冒号) 38,604 = 167,461；去空白原文 167,461 → **闭合**；叶子 5,843 个，对象 1,316 个 / 数组 598 个 / 键 5,262 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 2,632、`[]` 1,196、`,` 5,842、`:` 5,262（合计 14,932）
- 键名审计：键名总量（含冒号）43,866；扫描器逐条定位到的键 token 38,373（4,667 个），未定位差额 5,493 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=220 / 顶层键=[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 1：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 2：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 3：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 4：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 5：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 6：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 7：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 8：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 9：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 10：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 11：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 12：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 13：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 14：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 15：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 16：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 17：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 18：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 19：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 20：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 21：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 22：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 23：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 24：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 25：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 26：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 27：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 28：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 29：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 30：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 31：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 32：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 33：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 34：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 35：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 36：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 37：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 38：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 39：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 40：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 41：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 42：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 43：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 44：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 45：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 46：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 47：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 48：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 49：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 50：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 51：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 52：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 53：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 54：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 55：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 56：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 57：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 58：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 59：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 60：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 61：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 62：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 63：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 64：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 65：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 66：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 67：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 68：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 69：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 70：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 71：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 72：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 73：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 74：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 75：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 76：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 77：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 78：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 79：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 80：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 81：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 82：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 83：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 84：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 85：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 86：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 87：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 88：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 89：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 90：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 91：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 92：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 93：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 94：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 95：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 96：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 97：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 98：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 99：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 100：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 101：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 102：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 103：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 104：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 105：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 106：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 107：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 108：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 109：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 110：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 111：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 112：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 113：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 114：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 115：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 116：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 117：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 118：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 119：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 120：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 121：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 122：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 123：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 124：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 125：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 126：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 127：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 128：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 129：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 130：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 131：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 132：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 133：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 134：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 135：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 136：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 137：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 138：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 139：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 140：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 141：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 142：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 143：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 144：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 145：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 146：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 147：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 148：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 149：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 150：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 151：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 152：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 153：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 154：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 155：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 156：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 157：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 158：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 159：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 160：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 161：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 162：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 163：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 164：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 165：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 166：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 167：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 168：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 169：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 170：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 171：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 172：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 173：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 174：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 175：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 176：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 177：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 178：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 179：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 180：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 181：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 182：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 183：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 184：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 185：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 186：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 187：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 188：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 189：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 190：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 191：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 192：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 193：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 194：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 195：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 196：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 197：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 198：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 199：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 200：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 201：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 202：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 203：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 204：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 205：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 206：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 207：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 208：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 209：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 210：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 211：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 212：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 213：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 214：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 215：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 216：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 217：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 218：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 219：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture | 59,637 | 35.61% | — | — |
| frames_meta | 16,872 | 10.08% | — | — |
| other | 13,349 | 7.97% | — | — |
| palette | 10,849 | 6.48% | — | — |
| geometry | 8,731 | 5.21% | — | — |
| material | 4,487 | 2.68% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture.blobs | 59,637 | 35.61% | — | — |
| frames.meta | 16,872 | 10.08% | — | — |
| palette.meta | 10,849 | 6.48% | — | — |
| palette.geometry | 8,731 | 5.21% | — | — |
| other:$.multiblock.variants[].key | 6,642 | 3.97% | — | — |
| material.entries | 4,487 | 2.68% | — | — |
| other:$.multiblock.variants[].runstate | 1,540 | 0.92% | — | — |
| other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] | 1,295 | 0.77% | — | — |
| other:$.multiblock.notes[].text | 820 | 0.49% | — | — |
| other:$.multiblock.rules[].id | 378 | 0.23% | — | — |
| other:$.multiblock.rules[].legend | 378 | 0.23% | — | — |
| other:$.multiblock.variants[].totalTier | 242 | 0.14% | — | — |
| other:$.multiblock.variants[].values.height | 240 | 0.14% | — | — |
| other:$.multiblock.rules[].phase | 210 | 0.13% | — | — |
| other:$.multiblock.rules[].kind | 189 | 0.11% | — | — |
| other:$.multiblock.opsLegend.palette.renumber | 174 | 0.10% | — | — |
| other:$.multiblock.opsLegend.channel.replace | 166 | 0.10% | — | — |
| other:$.multiblock.notes[].source | 161 | 0.10% | — | — |
| other:$.multiblock.opsLegend.runstate.overlay | 117 | 0.07% | — | — |
| other:$.multiblock.opsLegend.tier.overlay | 107 | 0.06% | — | — |
| other:$.multiblock.backbone.sizeSteps[].channel | 80 | 0.05% | — | — |
| other:$.multiblock.sourceClass | 66 | 0.04% | — | — |
| other:$.multiblock.id | 43 | 0.03% | — | — |
| other:$.multiblock.rules[].y | 25 | 0.01% | — | — |
| other:$.multiblock.notes[].kind | 24 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.kind | 23 | 0.01% | — | — |
| other:$.multiblock.rules[].x | 22 | 0.01% | — | — |
| other:$.multiblock.rules[].z | 21 | 0.01% | — | — |
| other:$.multiblock.rules[].index | 21 | 0.01% | — | — |
| other:$.multiblock.displayName | 20 | 0.01% | — | — |
| other:$.multiblock.paletteSource | 20 | 0.01% | — | — |
| other:$.multiblock.channels[].enum | 18 | 0.01% | — | — |
| other:$.multiblock.channels[].name | 18 | 0.01% | — | — |
| other:$.multiblock.geometryEncoding | 18 | 0.01% | — | — |
| other:$.multiblock.channels[].valueSemantics | 16 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.playback | 16 | 0.01% | — | — |
| other:$.multiblock.runstates[].name | 15 | 0.01% | — | — |
| other:$.multiblock.runstates[].id | 14 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.tesr | 13 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].hh | 13 | 0.01% | — | — |
| other:$.multiblock.tierSample[] | 11 | 0.01% | — | — |
| other:$.multiblock.channels[].domainSource | 11 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.layerPreview | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.kind | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].layers | 11 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].w | 10 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].d | 10 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].roles.casing | 10 | 0.01% | — | — |
| other:$.multiblock.runstates[].materialSwap | 9 | 0.01% | — | — |
| other:$.multiblock.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].id | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].key | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].unit | 8 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeChannel | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].kind | 6 | 0.00% | — | — |
| other:$.multiblock.couplingMode | 6 | 0.00% | — | — |
| other:$.multiblock.hasScopeOverlap | 5 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.geometryDelta | 5 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.frameIsVariant | 4 | 0.00% | — | — |
| other:$.multiblock.channels[].axis | 3 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.max | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].max | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.multiblock.channels[].min | 1 | 0.00% | — | — |
| other:$.multiblock.channels[].domain.min | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.0 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.22 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.23 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.24 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.25 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.26 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.27 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.28 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.29 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.30 | 1 | 0.00% | — | — |
| other:$.multiblockCount | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 14,932 | 8.92% | | |
| （键名 `"key":`，共 5,262 个键） | 43,866 | 26.19% | | |
| **Σ 未压缩 JSON** | **167,461** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| textureBlobs | 59,434 | 35.49% | 0 | 1 | 0 | 50 | 0 | 52 | 0.1% |
| blockPalette | 34,256 | 20.46% | 370 | 91 | 2,189 | 2,099 | 2,189 | 5,210 | 15.2% |
| frames | 29,853 | 17.83% | 220 | 221 | 1,100 | 1,319 | 1,100 | 3,301 | 11.1% |
| multiblock | 28,748 | 17.17% | 496 | 273 | 1,427 | 1,857 | 1,427 | 4,822 | 16.8% |
| materialPalette | 11,232 | 6.71% | 229 | 11 | 539 | 511 | 539 | 1,530 | 13.6% |
| tooltipPalette | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| multiblockCount | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **163,526** | — | | | | | | | |（与未压缩 167,461 的差 = 顶层键名与顶层分隔符 3,935） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 38,538 |
| blockPalette | 6,165 |
| multiblock | 3,354 |
| frames | 1,294 |
| materialPalette | 1,105 |
| tooltipPalette | 19 |
| multiblockCount | 19 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 51 | 59,637 | texture.blobs |
| `$.blockPalette[].thumbnailPNG` | 9 | 10,422 | palette.meta |
| `$.frames[].rules[]` | 440 | 7,920 | frames.meta |
| `$.frames[].variant` | 220 | 6,642 | frames.meta |
| `$.multiblock.variants[].key` | 220 | 6,642 | other:$.multiblock.variants[].key |
| `$.materialPalette[].locator` | 56 | 2,696 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 280 | 2,240 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 280 | 1,976 | palette.geometry |
| `$.frames[].runstate` | 220 | 1,540 | frames.meta |
| `$.multiblock.variants[].runstate` | 220 | 1,540 | other:$.multiblock.variants[].runstate |
| `$.multiblock.backbone.sizeSteps[].cellGrid[][][]` | 675 | 1,295 | other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 280 | 840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 280 | 840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 280 | 840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 280 | 840 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 280 | 840 | palette.geometry |
| `$.multiblock.notes[].text` | 4 | 820 | other:$.multiblock.notes[].text |
| `$.materialPalette[].kind` | 56 | 560 | material.entries |
| `$.frames[].index` | 220 | 550 | frames.meta |
| `$.materialPalette[].atlas` | 56 | 448 | material.entries |
| `$.multiblock.rules[].id` | 21 | 378 | other:$.multiblock.rules[].id |
| `$.multiblock.rules[].legend` | 21 | 378 | other:$.multiblock.rules[].legend |
| `$.blockPalette[].registryId` | 10 | 248 | palette.meta |
| `$.multiblock.variants[].totalTier` | 220 | 242 | other:$.multiblock.variants[].totalTier |
| `$.multiblock.variants[].values.height` | 220 | 240 | other:$.multiblock.variants[].values.height |
| `$.materialPalette[].linear` | 56 | 224 | material.entries |
| `$.materialPalette[].useMipmaps` | 56 | 224 | material.entries |
| `$.frames[].stepIndex` | 220 | 220 | frames.meta |
| `$.materialPalette[].animation.frameSequence[].index` | 156 | 210 | material.entries |
| `$.multiblock.rules[].phase` | 21 | 210 | other:$.multiblock.rules[].phase |
| `$.multiblock.rules[].kind` | 21 | 189 | other:$.multiblock.rules[].kind |
| `$.blockPalette[].geometry.encoding` | 10 | 180 | palette.geometry |
| `$.multiblock.opsLegend.palette.renumber` | 1 | 174 | other:$.multiblock.opsLegend.palette.renumber |
| `$.multiblock.opsLegend.channel.replace` | 1 | 166 | other:$.multiblock.opsLegend.channel.replace |
| `$.multiblock.notes[].source` | 4 | 161 | other:$.multiblock.notes[].source |
| `$.blockPalette[].geometry.quads[].materialIndex` | 70 | 135 | palette.geometry |
| `$.blockPalette[].renderMode` | 10 | 120 | palette.meta |
| `$.multiblock.opsLegend.runstate.overlay` | 1 | 117 | other:$.multiblock.opsLegend.runstate.overlay |
| `$.multiblock.opsLegend.tier.overlay` | 1 | 107 | other:$.multiblock.opsLegend.tier.overlay |
| `$.materialPalette[].textureBlobIndex` | 56 | 98 | material.entries |
| `$.multiblock.backbone.sizeSteps[].channel` | 10 | 80 | other:$.multiblock.backbone.sizeSteps[].channel |
| `$.multiblock.sourceClass` | 1 | 66 | other:$.multiblock.sourceClass |
| `$.blockPalette[].occludesAdjacentFaces` | 10 | 49 | palette.meta |
| `$.multiblock.id` | 1 | 43 | other:$.multiblock.id |
| `$.multiblock.rules[].y` | 21 | 25 | other:$.multiblock.rules[].y |
| `$.multiblock.notes[].kind` | 4 | 24 | other:$.multiblock.notes[].kind |
| `$.multiblock.viewerSemantics.runstateCoverage.kind` | 1 | 23 | other:$.multiblock.viewerSemantics.runstateCoverage.kind |
| `$.multiblock.rules[].x` | 21 | 22 | other:$.multiblock.rules[].x |
| `$.multiblock.rules[].z` | 21 | 21 | other:$.multiblock.rules[].z |
| `$.multiblock.rules[].index` | 21 | 21 | other:$.multiblock.rules[].index |
| `$.multiblock.displayName` | 1 | 20 | other:$.multiblock.displayName |
| `$.multiblock.paletteSource` | 1 | 20 | other:$.multiblock.paletteSource |
| `$.materialPalette[].animation.defaultFrametimeTicks` | 17 | 18 | material.entries |
| `$.multiblock.channels[].enum` | 1 | 18 | other:$.multiblock.channels[].enum |
| `$.multiblock.channels[].name` | 1 | 18 | other:$.multiblock.channels[].name |
| `$.multiblock.geometryEncoding` | 1 | 18 | other:$.multiblock.geometryEncoding |
| `$.multiblock.channels[].valueSemantics` | 1 | 16 | other:$.multiblock.channels[].valueSemantics |
| `$.multiblock.viewerSemantics.playback` | 1 | 16 | other:$.multiblock.viewerSemantics.playback |
| `$.multiblock.runstates[].name` | 2 | 15 | other:$.multiblock.runstates[].name |
| `$.multiblock.runstates[].id` | 2 | 14 | other:$.multiblock.runstates[].id |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `runstate` | 440 | 4,840 | 11.00 |
| `brightness` | 280 | 3,640 | 13.00 |
| `index` | 397 | 3,176 | 8.00 |
| `stepIndex` | 220 | 2,640 | 12.00 |
| `totalTier` | 220 | 2,640 | 12.00 |
| `color` | 280 | 2,240 | 8.00 |
| `variant` | 220 | 2,200 | 10.00 |
| `height` | 220 | 1,980 | 9.00 |
| `key` | 221 | 1,326 | 6.00 |
| `x` | 301 | 1,204 | 4.00 |
| `y` | 301 | 1,204 | 4.00 |
| `z` | 301 | 1,204 | 4.00 |
| `materialIndex` | 70 | 1,120 | 16.00 |
| `u` | 280 | 1,120 | 4.00 |
| `v` | 280 | 1,120 | 4.00 |
| `textureBlobIndex` | 56 | 1,064 | 19.00 |
| `useMipmaps` | 56 | 728 | 13.00 |
| `kind` | 84 | 588 | 7.00 |
| `locator` | 56 | 560 | 10.00 |
| `linear` | 56 | 504 | 9.00 |
| `atlas` | 56 | 448 | 8.00 |
| `defaultFrametimeTicks` | 17 | 408 | 24.00 |
| `occludesAdjacentFaces` | 10 | 240 | 24.00 |
| `legend` | 21 | 189 | 9.00 |
| `phase` | 21 | 168 | 8.00 |
| `thumbnailPNG` | 9 | 135 | 15.00 |
| `registryId` | 10 | 130 | 13.00 |
| `renderMode` | 10 | 130 | 13.00 |
| `id` | 25 | 125 | 5.00 |
| `encoding` | 10 | 110 | 11.00 |
| `tooltip` | 10 | 100 | 10.00 |
| `channel` | 10 | 100 | 10.00 |
| `layers` | 10 | 90 | 9.00 |
| `casing` | 10 | 90 | 9.00 |
| `meta` | 10 | 70 | 7.00 |
| `hh` | 10 | 50 | 5.00 |
| `source` | 5 | 45 | 9.00 |
| `w` | 10 | 40 | 4.00 |
| `d` | 10 | 40 | 4.00 |
| `materialSwap` | 2 | 30 | 15.00 |
| `text` | 4 | 28 | 7.00 |
| `timeTicks` | 2 | 24 | 12.00 |
| `name` | 3 | 21 | 7.00 |
| `geometryEncoding` | 1 | 19 | 19.00 |
| `palette.renumber` | 1 | 19 | 19.00 |
| `runstate.overlay` | 1 | 19 | 19.00 |
| `hasScopeOverlap` | 1 | 18 | 18.00 |
| `min` | 3 | 18 | 6.00 |
| `max` | 3 | 18 | 6.00 |
| `channel.replace` | 1 | 18 | 18.00 |
| `multiblockCount` | 1 | 18 | 18.00 |
| `tooltipPalette` | 1 | 17 | 17.00 |
| `valueSemantics` | 1 | 17 | 17.00 |
| `frameIsVariant` | 1 | 17 | 17.00 |
| `geometryDelta` | 1 | 16 | 16.00 |
| `paletteSource` | 1 | 16 | 16.00 |
| `domainSource` | 1 | 15 | 15.00 |
| `couplingMode` | 1 | 15 | 15.00 |
| `layerPreview` | 1 | 15 | 15.00 |
| `tier.overlay` | 1 | 15 | 15.00 |


---

### scripts/multiblock-encode/.out/profile-after/mteelectricblastfurnace.multiblock.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 108,754 | 106.2 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 108,685 | 106.1 | 分桶统计口径 |
| gzip(level 9) | 80,352 | 78.5 | 压缩后 payload |
| base64(gzip) | 107,136 | 104.6 | 信封 payload 字符串本体 |
| 压缩率 | 73.93% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 108,685 vs 去空白 108,685）
- 三分解闭合：Σ叶子 108,532 + 分隔符 26 + 键名(不含冒号) 127 = 108,685；去空白原文 108,685 → **闭合**；叶子 11 个，对象 2 个 / 数组 0 个 / 键 12 个，空白缩进 69 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 10、`:` 12（合计 26）
- 键名审计：键名总量（含冒号）139；扫描器逐条定位到的键 token 132（11 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 108,246 | 99.60% | — | — |
| doc_meta | 286 | 0.26% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 108,246 | 99.60% | — | — |
| doc.meta | 286 | 0.26% | — | — |
| （分隔符 `{}[],:`，非键名） | 26 | 0.02% | | |
| （键名 `"key":`，共 12 个键） | 139 | 0.13% | | |
| **Σ 未压缩 JSON** | **108,685** | **100.00%** | | |

**最大字段族（Top 11，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 108,246 | other:$.payload |
| `$.meta.description` | 1 | 125 | doc.meta |
| `$.meta.id` | 1 | 46 | doc.meta |
| `$.meta.author` | 1 | 27 | doc.meta |
| `$.meta.label` | 1 | 24 | doc.meta |
| `$.meta.modSource` | 1 | 16 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.meta.mode` | 1 | 12 | doc.meta |
| `$.meta.documentShape` | 1 | 12 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 11，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `documentShape` | 1 | 16 | 16.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `mode` | 1 | 7 | 7.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 108,754 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 108,244 | 99.53% 的文件 |
| 非 payload 结构开销 | 510 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 359） |
| payload 解 base64 后（gzip 流） | 81,183 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 281,607 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 80,726 | 与 mod 侧 gzip 流差 -457 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 107,636 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`df1553a7f3cd5d66ced162523d3cb227e4019e7f7e16628ffa8a016716c6fef6`
- meta 键：[id, mode, label, author, description, modSource, schemaVersion, documentShape]
- payload 内层键：[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]

**内层 payload 剖析（信封内的真实内容）**

### scripts/multiblock-encode/.out/profile-after/mteelectricblastfurnace.multiblock.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 281,607 | 275.0 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 281,607 | 275.0 | 分桶统计口径 |
| gzip(level 9) | 80,726 | 78.8 | 压缩后 payload |
| base64(gzip) | 107,636 | 105.1 | 信封 payload 字符串本体 |
| 压缩率 | 28.67% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **不一致**（重建 275,857 vs 去空白 281,607）
- 三分解闭合：Σ叶子 191,293 + 分隔符 24,752 + 键名(不含冒号) 65,562 = 281,607；去空白原文 281,607 → **闭合**；叶子 9,873 个，对象 2,232 个 / 数组 644 个 / 键 9,128 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4,464、`[]` 1,288、`,` 9,872、`:` 9,128（合计 24,752）
- 键名审计：键名总量（含冒号）74,690；扫描器逐条定位到的键 token 64,971（8,054 个），未定位差额 9,719 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=420 / 顶层键=[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 1：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 2：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 3：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 4：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 5：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 6：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 7：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 8：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 9：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 10：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 11：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 12：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 13：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 14：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 15：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 16：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 17：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 18：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 19：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 20：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 21：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 22：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 23：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 24：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 25：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 26：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 27：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 28：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 29：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 30：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 31：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 32：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 33：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 34：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 35：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 36：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 37：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 38：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 39：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 40：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 41：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 42：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 43：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 44：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 45：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 46：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 47：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 48：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 49：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 50：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 51：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 52：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 53：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 54：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 55：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 56：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 57：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 58：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 59：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 60：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 61：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 62：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 63：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 64：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 65：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 66：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 67：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 68：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 69：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 70：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 71：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 72：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 73：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 74：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 75：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 76：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 77：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 78：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 79：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 80：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 81：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 82：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 83：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 84：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 85：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 86：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 87：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 88：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 89：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 90：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 91：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 92：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 93：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 94：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 95：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 96：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 97：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 98：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 99：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 100：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 101：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 102：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 103：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 104：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 105：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 106：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 107：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 108：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 109：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 110：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 111：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 112：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 113：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 114：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 115：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 116：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 117：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 118：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 119：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 120：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 121：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 122：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 123：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 124：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 125：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 126：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 127：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 128：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 129：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 130：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 131：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 132：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 133：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 134：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 135：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 136：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 137：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 138：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 139：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 140：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 141：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 142：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 143：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 144：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 145：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 146：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 147：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 148：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 149：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 150：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 151：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 152：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 153：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 154：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 155：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 156：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 157：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 158：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 159：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 160：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 161：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 162：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 163：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 164：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 165：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 166：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 167：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 168：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 169：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 170：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 171：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 172：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 173：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 174：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 175：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 176：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 177：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 178：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 179：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 180：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 181：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 182：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 183：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 184：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 185：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 186：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 187：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 188：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 189：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 190：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 191：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 192：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 193：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 194：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 195：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 196：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 197：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 198：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 199：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 200：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 201：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 202：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 203：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 204：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 205：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 206：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 207：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 208：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 209：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 210：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 211：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 212：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 213：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 214：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 215：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 216：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 217：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 218：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 219：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 220：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 221：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 222：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 223：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 224：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 225：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 226：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 227：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 228：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 229：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 230：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 231：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 232：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 233：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 234：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 235：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 236：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 237：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 238：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 239：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 240：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 241：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 242：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 243：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 244：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 245：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 246：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 247：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 248：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 249：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 250：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 251：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 252：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 253：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 254：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 255：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 256：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 257：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 258：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 259：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 260：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 261：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 262：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 263：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 264：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 265：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 266：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 267：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 268：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 269：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 270：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 271：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 272：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 273：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 274：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 275：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 276：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 277：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 278：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 279：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 280：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 281：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 282：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 283：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 284：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 285：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 286：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 287：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 288：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 289：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 290：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 291：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 292：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 293：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 294：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 295：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 296：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 297：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 298：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 299：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 300：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 301：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 302：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 303：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 304：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 305：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 306：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 307：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 308：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 309：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 310：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 311：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 312：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 313：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 314：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 315：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 316：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 317：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 318：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 319：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 320：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 321：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 322：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 323：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 324：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 325：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 326：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 327：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 328：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 329：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 330：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 331：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 332：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 333：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 334：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 335：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 336：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 337：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 338：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 339：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 340：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 341：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 342：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 343：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 344：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 345：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 346：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 347：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 348：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 349：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 350：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 351：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 352：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 353：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 354：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 355：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 356：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 357：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 358：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 359：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 360：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 361：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 362：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 363：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 364：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 365：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 366：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 367：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 368：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 369：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 370：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 371：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 372：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 373：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 374：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 375：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 376：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 377：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 378：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 379：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 380：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 381：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 382：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 383：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 384：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 385：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 386：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 387：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 388：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 389：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 390：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 391：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 392：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 393：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 394：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 395：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 396：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 397：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 398：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 399：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 400：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 401：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 402：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 403：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 404：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 405：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 406：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 407：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 408：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 409：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 410：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 411：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 412：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 413：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 414：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 415：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 416：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 417：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 418：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 419：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture | 59,637 | 21.18% | — | — |
| palette | 50,405 | 17.90% | — | — |
| frames_meta | 41,760 | 14.83% | — | — |
| other | 18,206 | 6.47% | — | — |
| geometry | 16,798 | 5.97% | — | — |
| material | 4,487 | 1.59% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| texture.blobs | 59,637 | 21.18% | — | — |
| palette.meta | 50,405 | 17.90% | — | — |
| frames.meta | 41,760 | 14.83% | — | — |
| palette.geometry | 16,798 | 5.97% | — | — |
| other:$.multiblock.variants[].key | 12,050 | 4.28% | — | — |
| material.entries | 4,487 | 1.59% | — | — |
| other:$.multiblock.variants[].runstate | 2,940 | 1.04% | — | — |
| other:$.multiblock.variants[].totalTier | 570 | 0.20% | — | — |
| other:$.multiblock.notes[].text | 568 | 0.20% | — | — |
| other:$.multiblock.variants[].values.coil | 560 | 0.20% | — | — |
| other:$.multiblock.opsLegend.palette.renumber | 174 | 0.06% | — | — |
| other:$.multiblock.opsLegend.channel.replace | 166 | 0.06% | — | — |
| other:$.multiblock.opsLegend.runstate.overlay | 117 | 0.04% | — | — |
| other:$.multiblock.opsLegend.tier.overlay | 107 | 0.04% | — | — |
| other:$.multiblock.notes[].source | 96 | 0.03% | — | — |
| other:$.multiblock.rules[].legend | 88 | 0.03% | — | — |
| other:$.multiblock.rules[].id | 78 | 0.03% | — | — |
| other:$.multiblock.sourceClass | 69 | 0.02% | — | — |
| other:$.multiblock.rules[].indexTable[] | 54 | 0.02% | — | — |
| other:$.multiblock.rules[].phase | 48 | 0.02% | — | — |
| other:$.multiblock.id | 46 | 0.02% | — | — |
| other:$.multiblock.rules[].kind | 39 | 0.01% | — | — |
| other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] | 36 | 0.01% | — | — |
| other:$.multiblock.displayName | 24 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.kind | 23 | 0.01% | — | — |
| other:$.multiblock.paletteSource | 20 | 0.01% | — | — |
| other:$.multiblock.tierSample[] | 19 | 0.01% | — | — |
| other:$.multiblock.notes[].kind | 18 | 0.01% | — | — |
| other:$.multiblock.geometryEncoding | 18 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.playback | 16 | 0.01% | — | — |
| other:$.multiblock.runstates[].name | 15 | 0.01% | — | — |
| other:$.multiblock.channels[].enum | 14 | 0.00% | — | — |
| other:$.multiblock.channels[].name | 14 | 0.00% | — | — |
| other:$.multiblock.runstates[].id | 14 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.tesr | 13 | 0.00% | — | — |
| other:$.multiblock.rules[].channel | 12 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.layerPreview | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.kind | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeChannel | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].channel | 11 | 0.00% | — | — |
| other:$.multiblock.channels[].kind | 9 | 0.00% | — | — |
| other:$.multiblock.runstates[].materialSwap | 9 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].domainSource | 8 | 0.00% | — | — |
| other:$.multiblock.channels[].id | 6 | 0.00% | — | — |
| other:$.multiblock.channels[].key | 6 | 0.00% | — | — |
| other:$.multiblock.couplingMode | 6 | 0.00% | — | — |
| other:$.multiblock.hasScopeOverlap | 5 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.geometryDelta | 5 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.frameIsVariant | 4 | 0.00% | — | — |
| other:$.multiblock.rules[].sel.y[] | 4 | 0.00% | — | — |
| other:$.multiblock.rules[].x | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].y | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].z | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].index | 3 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.max | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].max | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.10 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.11 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.12 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.13 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.14 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.15 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.16 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.17 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.18 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.19 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.20 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.21 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].sel.z[] | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].sel.x[] | 2 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.multiblock.channels[].min | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].layers | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].w | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].hh | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].d | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].roles.casing | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.0 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.1 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.2 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.3 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.4 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.5 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.6 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.7 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.8 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.9 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].sel.z | 1 | 0.00% | — | — |
| other:$.multiblockCount | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 24,752 | 8.79% | | |
| （键名 `"key":`，共 9,128 个键） | 74,690 | 26.52% | | |
| **Σ 未压缩 JSON** | **281,607** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blockPalette | 95,813 | 34.02% | 719 | 180 | 4,247 | 4,068 | 4,247 | 10,113 | 10.6% |
| frames | 67,381 | 23.93% | 420 | 421 | 2,100 | 3,359 | 2,100 | 7,141 | 10.6% |
| textureBlobs | 59,434 | 21.11% | 0 | 1 | 0 | 50 | 0 | 52 | 0.1% |
| multiblock | 41,277 | 14.66% | 863 | 30 | 2,235 | 1,878 | 2,235 | 5,899 | 14.3% |
| materialPalette | 11,232 | 3.99% | 229 | 11 | 539 | 511 | 539 | 1,530 | 13.6% |
| tooltipPalette | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| multiblockCount | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **275,140** | — | | | | | | | |（与未压缩 281,607 的差 = 顶层键名与顶层分隔符 6,467） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 38,538 |
| blockPalette | 33,604 |
| multiblock | 3,908 |
| frames | 2,060 |
| materialPalette | 1,105 |
| tooltipPalette | 19 |
| multiblockCount | 19 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.textureBlobs[]` | 51 | 59,637 | texture.blobs |
| `$.blockPalette[].thumbnailPNG` | 21 | 49,448 | palette.meta |
| `$.frames[].rules[]` | 1680 | 25,200 | frames.meta |
| `$.frames[].variant` | 420 | 12,050 | frames.meta |
| `$.multiblock.variants[].key` | 420 | 12,050 | other:$.multiblock.variants[].key |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 540 | 4,320 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 540 | 3,768 | palette.geometry |
| `$.frames[].runstate` | 420 | 2,940 | frames.meta |
| `$.multiblock.variants[].runstate` | 420 | 2,940 | other:$.multiblock.variants[].runstate |
| `$.materialPalette[].locator` | 56 | 2,696 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 540 | 1,620 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 540 | 1,620 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 540 | 1,620 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 540 | 1,620 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 540 | 1,620 | palette.geometry |
| `$.frames[].index` | 420 | 1,150 | frames.meta |
| `$.blockPalette[].registryId` | 22 | 571 | palette.meta |
| `$.multiblock.variants[].totalTier` | 420 | 570 | other:$.multiblock.variants[].totalTier |
| `$.multiblock.notes[].text` | 3 | 568 | other:$.multiblock.notes[].text |
| `$.materialPalette[].kind` | 56 | 560 | material.entries |
| `$.multiblock.variants[].values.coil` | 420 | 560 | other:$.multiblock.variants[].values.coil |
| `$.materialPalette[].atlas` | 56 | 448 | material.entries |
| `$.frames[].stepIndex` | 420 | 420 | frames.meta |
| `$.blockPalette[].geometry.encoding` | 22 | 396 | palette.geometry |
| `$.blockPalette[].renderMode` | 22 | 264 | palette.meta |
| `$.materialPalette[].linear` | 56 | 224 | material.entries |
| `$.materialPalette[].useMipmaps` | 56 | 224 | material.entries |
| `$.blockPalette[].geometry.quads[].materialIndex` | 135 | 214 | palette.geometry |
| `$.materialPalette[].animation.frameSequence[].index` | 156 | 210 | material.entries |
| `$.multiblock.opsLegend.palette.renumber` | 1 | 174 | other:$.multiblock.opsLegend.palette.renumber |
| `$.multiblock.opsLegend.channel.replace` | 1 | 166 | other:$.multiblock.opsLegend.channel.replace |
| `$.multiblock.opsLegend.runstate.overlay` | 1 | 117 | other:$.multiblock.opsLegend.runstate.overlay |
| `$.multiblock.opsLegend.tier.overlay` | 1 | 107 | other:$.multiblock.opsLegend.tier.overlay |
| `$.materialPalette[].textureBlobIndex` | 56 | 98 | material.entries |
| `$.multiblock.notes[].source` | 3 | 96 | other:$.multiblock.notes[].source |
| `$.blockPalette[].occludesAdjacentFaces` | 22 | 95 | palette.meta |
| `$.multiblock.rules[].legend` | 5 | 88 | other:$.multiblock.rules[].legend |
| `$.multiblock.rules[].id` | 5 | 78 | other:$.multiblock.rules[].id |
| `$.multiblock.sourceClass` | 1 | 69 | other:$.multiblock.sourceClass |
| `$.multiblock.rules[].indexTable[]` | 30 | 54 | other:$.multiblock.rules[].indexTable[] |
| `$.multiblock.rules[].phase` | 5 | 48 | other:$.multiblock.rules[].phase |
| `$.multiblock.id` | 1 | 46 | other:$.multiblock.id |
| `$.multiblock.rules[].kind` | 5 | 39 | other:$.multiblock.rules[].kind |
| `$.multiblock.backbone.sizeSteps[].cellGrid[][][]` | 36 | 36 | other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] |
| `$.blockPalette[].meta` | 22 | 27 | palette.meta |
| `$.multiblock.displayName` | 1 | 24 | other:$.multiblock.displayName |
| `$.multiblock.viewerSemantics.runstateCoverage.kind` | 1 | 23 | other:$.multiblock.viewerSemantics.runstateCoverage.kind |
| `$.multiblock.paletteSource` | 1 | 20 | other:$.multiblock.paletteSource |
| `$.multiblock.tierSample[]` | 14 | 19 | other:$.multiblock.tierSample[] |
| `$.materialPalette[].animation.defaultFrametimeTicks` | 17 | 18 | material.entries |
| `$.multiblock.notes[].kind` | 3 | 18 | other:$.multiblock.notes[].kind |
| `$.multiblock.geometryEncoding` | 1 | 18 | other:$.multiblock.geometryEncoding |
| `$.multiblock.viewerSemantics.playback` | 1 | 16 | other:$.multiblock.viewerSemantics.playback |
| `$.multiblock.runstates[].name` | 2 | 15 | other:$.multiblock.runstates[].name |
| `$.multiblock.channels[].enum` | 1 | 14 | other:$.multiblock.channels[].enum |
| `$.multiblock.channels[].name` | 1 | 14 | other:$.multiblock.channels[].name |
| `$.multiblock.runstates[].id` | 2 | 14 | other:$.multiblock.runstates[].id |
| `$.multiblock.viewerSemantics.runstateCoverage.tesr` | 1 | 13 | other:$.multiblock.viewerSemantics.runstateCoverage.tesr |
| `$.multiblock.rules[].channel` | 2 | 12 | other:$.multiblock.rules[].channel |
| `$.multiblock.viewerSemantics.layerPreview` | 1 | 11 | other:$.multiblock.viewerSemantics.layerPreview |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `runstate` | 840 | 9,240 | 11.00 |
| `brightness` | 540 | 7,020 | 13.00 |
| `stepIndex` | 420 | 5,040 | 12.00 |
| `totalTier` | 420 | 5,040 | 12.00 |
| `index` | 579 | 4,632 | 8.00 |
| `color` | 540 | 4,320 | 8.00 |
| `variant` | 420 | 4,200 | 10.00 |
| `coil` | 420 | 2,940 | 7.00 |
| `key` | 421 | 2,526 | 6.00 |
| `z` | 544 | 2,176 | 4.00 |
| `x` | 543 | 2,172 | 4.00 |
| `y` | 543 | 2,172 | 4.00 |
| `materialIndex` | 135 | 2,160 | 16.00 |
| `u` | 540 | 2,160 | 4.00 |
| `v` | 540 | 2,160 | 4.00 |
| `textureBlobIndex` | 56 | 1,064 | 19.00 |
| `useMipmaps` | 56 | 728 | 13.00 |
| `locator` | 56 | 560 | 10.00 |
| `occludesAdjacentFaces` | 22 | 528 | 24.00 |
| `linear` | 56 | 504 | 9.00 |
| `kind` | 67 | 469 | 7.00 |
| `atlas` | 56 | 448 | 8.00 |
| `defaultFrametimeTicks` | 17 | 408 | 24.00 |
| `thumbnailPNG` | 21 | 315 | 15.00 |
| `registryId` | 22 | 286 | 13.00 |
| `renderMode` | 22 | 286 | 13.00 |
| `encoding` | 22 | 242 | 11.00 |
| `tooltip` | 22 | 220 | 10.00 |
| `meta` | 22 | 154 | 7.00 |
| `id` | 9 | 45 | 5.00 |
| `legend` | 5 | 45 | 9.00 |
| `phase` | 5 | 40 | 8.00 |
| `source` | 4 | 36 | 9.00 |
| `materialSwap` | 2 | 30 | 15.00 |
| `channel` | 3 | 30 | 10.00 |
| `timeTicks` | 2 | 24 | 12.00 |
| `name` | 3 | 21 | 7.00 |
| `text` | 3 | 21 | 7.00 |
| `geometryEncoding` | 1 | 19 | 19.00 |
| `palette.renumber` | 1 | 19 | 19.00 |
| `runstate.overlay` | 1 | 19 | 19.00 |
| `hasScopeOverlap` | 1 | 18 | 18.00 |
| `max` | 3 | 18 | 6.00 |
| `channel.replace` | 1 | 18 | 18.00 |
| `multiblockCount` | 1 | 18 | 18.00 |
| `tooltipPalette` | 1 | 17 | 17.00 |
| `frameIsVariant` | 1 | 17 | 17.00 |
| `geometryDelta` | 1 | 16 | 16.00 |
| `paletteSource` | 1 | 16 | 16.00 |
| `domainSource` | 1 | 15 | 15.00 |
| `couplingMode` | 1 | 15 | 15.00 |
| `layerPreview` | 1 | 15 | 15.00 |
| `tier.overlay` | 1 | 15 | 15.00 |
| `interpolate` | 1 | 14 | 14.00 |
| `displayName` | 1 | 14 | 14.00 |
| `sourceClass` | 1 | 14 | 14.00 |
| `sizeChannel` | 1 | 14 | 14.00 |
| `min` | 2 | 12 | 6.00 |
| `couplings` | 1 | 12 | 12.00 |
| `playback` | 1 | 11 | 11.00 |


---

### scripts/multiblock-encode/.out/profile-after/mtequantumforcetransformer.multiblock.json

输入形态：**Envelope(gzip+base64)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 90,596 | 88.5 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 90,527 | 88.4 | 分桶统计口径 |
| gzip(level 9) | 66,404 | 64.8 | 压缩后 payload |
| base64(gzip) | 88,540 | 86.5 | 信封 payload 字符串本体 |
| 压缩率 | 73.35% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 90,527 vs 去空白 90,527）
- 三分解闭合：Σ叶子 90,374 + 分隔符 26 + 键名(不含冒号) 127 = 90,527；去空白原文 90,527 → **闭合**；叶子 11 个，对象 2 个 / 数组 0 个 / 键 12 个，空白缩进 69 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 0、`,` 10、`:` 12（合计 26）
- 键名审计：键名总量（含冒号）139；扫描器逐条定位到的键 token 132（11 个），未定位差额 7 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Envelope / 帧数=1 / 顶层键=[documentFormat, payloadEncoding, meta, payload]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 90,086 | 99.51% | — | — |
| doc_meta | 288 | 0.32% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.payload | 90,086 | 99.51% | — | — |
| doc.meta | 288 | 0.32% | — | — |
| （分隔符 `{}[],:`，非键名） | 26 | 0.03% | | |
| （键名 `"key":`，共 12 个键） | 139 | 0.15% | | |
| **Σ 未压缩 JSON** | **90,527** | **100.00%** | | |

**最大字段族（Top 11，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.payload` | 1 | 90,086 | other:$.payload |
| `$.meta.description` | 1 | 125 | doc.meta |
| `$.meta.id` | 1 | 45 | doc.meta |
| `$.meta.label` | 1 | 27 | doc.meta |
| `$.meta.author` | 1 | 27 | doc.meta |
| `$.meta.modSource` | 1 | 16 | doc.meta |
| `$.payloadEncoding` | 1 | 13 | doc.meta |
| `$.meta.mode` | 1 | 12 | doc.meta |
| `$.meta.documentShape` | 1 | 12 | doc.meta |
| `$.documentFormat` | 1 | 10 | doc.meta |
| `$.meta.schemaVersion` | 1 | 1 | doc.meta |

**按 JSON 键名聚合（Top 11，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `payloadEncoding` | 1 | 18 | 18.00 |
| `documentFormat` | 1 | 17 | 17.00 |
| `schemaVersion` | 1 | 16 | 16.00 |
| `documentShape` | 1 | 16 | 16.00 |
| `description` | 1 | 14 | 14.00 |
| `modSource` | 1 | 12 | 12.00 |
| `payload` | 1 | 10 | 10.00 |
| `author` | 1 | 9 | 9.00 |
| `label` | 1 | 8 | 8.00 |
| `mode` | 1 | 7 | 7.00 |
| `id` | 1 | 5 | 5.00 |

**信封（Envelope）分解**

| 组成部分 | 字节 | 说明 |
|---|---:|---|
| 文件落盘 | 90,596 | `documentFormat` + `payloadEncoding` + `meta` + `payload` |
| payload 字段（base64 字符串） | 90,084 | 99.43% 的文件 |
| 非 payload 结构开销 | 512 | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 361） |
| payload 解 base64 后（gzip 流） | 67,561 | 与 mod 侧写出的 gzip 流逐字节比对：一致 |
| payload 解压 + 解 base64 后（内层 JSON） | 376,678 | 内层为不含元数据键的 body |
| 内层 JSON 重新 gzip（node zlib level 9） | 66,919 | 与 mod 侧 gzip 流差 -642 字节（头部/压缩器实现差异） |
| 内层重新 gzip 后 base64 | 89,228 | 理论最优 payload 长度参考 |

- 内层 gzip 流 sha256：`da0aee1efaf97dce1da86c1ab8303ec7ab64f6f5ecb786877147bd362111e261`
- meta 键：[id, mode, label, author, description, modSource, schemaVersion, documentShape]
- payload 内层键：[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]

**内层 payload 剖析（信封内的真实内容）**

### scripts/multiblock-encode/.out/profile-after/mtequantumforcetransformer.multiblock.json :: payload(解压后内层 JSON)

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 376,678 | 367.8 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 376,678 | 367.8 | 分桶统计口径 |
| gzip(level 9) | 66,919 | 65.4 | 压缩后 payload |
| base64(gzip) | 89,228 | 87.1 | 信封 payload 字符串本体 |
| 压缩率 | 17.77% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **不一致**（重建 372,315 vs 去空白 376,678）
- 三分解闭合：Σ叶子 291,707 + 分隔符 35,150 + 键名(不含冒号) 49,821 = 376,678；去空白原文 376,678 → **闭合**；叶子 23,330 个，对象 1,563 个 / 数组 858 个 / 键 6,979 个，空白缩进 0 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 3,126、`[]` 1,716、`,` 23,329、`:` 6,979（合计 35,150）
- 键名审计：键名总量（含冒号）56,800；扫描器逐条定位到的键 token 49,746（6,170 个），未定位差额 7,054 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=200 / 顶层键=[frames, materialPalette, blockPalette, textureBlobs, tooltipPalette, multiblock, multiblockCount]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 1：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 2：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 3：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 4：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 5：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 6：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 7：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 8：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 9：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 10：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 11：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 12：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 13：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 14：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 15：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 16：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 17：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 18：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 19：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 20：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 21：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 22：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 23：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 24：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 25：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 26：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 27：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 28：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 29：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 30：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 31：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 32：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 33：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 34：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 35：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 36：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 37：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 38：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 39：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 40：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 41：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 42：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 43：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 44：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 45：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 46：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 47：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 48：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 49：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 50：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 51：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 52：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 53：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 54：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 55：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 56：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 57：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 58：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 59：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 60：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 61：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 62：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 63：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 64：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 65：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 66：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 67：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 68：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 69：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 70：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 71：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 72：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 73：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 74：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 75：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 76：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 77：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 78：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 79：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 80：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 81：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 82：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 83：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 84：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 85：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 86：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 87：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 88：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 89：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 90：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 91：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 92：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 93：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 94：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 95：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 96：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 97：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 98：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 99：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 100：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 101：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 102：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 103：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 104：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 105：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 106：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 107：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 108：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 109：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 110：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 111：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 112：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 113：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 114：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 115：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 116：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 117：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 118：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 119：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 120：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 121：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 122：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 123：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 124：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 125：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 126：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 127：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 128：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 129：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 130：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 131：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 132：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 133：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 134：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 135：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 136：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 137：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 138：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 139：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 140：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 141：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 142：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 143：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 144：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 145：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 146：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 147：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 148：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 149：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 150：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 151：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 152：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 153：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 154：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 155：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 156：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 157：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 158：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 159：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 160：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 161：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 162：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 163：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 164：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 165：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 166：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 167：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 168：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 169：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 170：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 171：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 172：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 173：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 174：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 175：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 176：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 177：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 178：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 179：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 180：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 181：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 182：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 183：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 184：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 185：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 186：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 187：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 188：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 189：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 190：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 191：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 192：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 193：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 194：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 195：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 196：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 197：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 198：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
  - 帧 199：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 56，textureBlob 51，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| frames_meta | 162,890 | 43.24% | — | — |
| texture | 59,637 | 15.83% | — | — |
| palette | 28,234 | 7.50% | — | — |
| other | 22,843 | 6.06% | — | — |
| geometry | 13,616 | 3.61% | — | — |
| material | 4,487 | 1.19% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| frames.meta | 162,890 | 43.24% | — | — |
| texture.blobs | 59,637 | 15.83% | — | — |
| palette.meta | 28,234 | 7.50% | — | — |
| palette.geometry | 13,616 | 3.61% | — | — |
| other:$.multiblock.variants[].key | 9,400 | 2.50% | — | — |
| other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] | 5,279 | 1.40% | — | — |
| material.entries | 4,487 | 1.19% | — | — |
| other:$.multiblock.variants[].runstate | 1,400 | 0.37% | — | — |
| other:$.multiblock.rules[].legend | 1,023 | 0.27% | — | — |
| other:$.multiblock.rules[].id | 775 | 0.21% | — | — |
| other:$.multiblock.rules[].channel | 695 | 0.18% | — | — |
| other:$.multiblock.notes[].text | 571 | 0.15% | — | — |
| other:$.multiblock.rules[].phase | 543 | 0.14% | — | — |
| other:$.multiblock.rules[].indexTable[] | 410 | 0.11% | — | — |
| other:$.multiblock.rules[].kind | 369 | 0.10% | — | — |
| other:$.multiblock.rules[].sel.x[] | 220 | 0.06% | — | — |
| other:$.multiblock.variants[].totalTier | 200 | 0.05% | — | — |
| other:$.multiblock.variants[].values.manipulator | 200 | 0.05% | — | — |
| other:$.multiblock.variants[].values.shielding | 200 | 0.05% | — | — |
| other:$.multiblock.opsLegend.palette.renumber | 174 | 0.05% | — | — |
| other:$.multiblock.opsLegend.channel.replace | 166 | 0.04% | — | — |
| other:$.multiblock.rules[].sel.z[] | 137 | 0.04% | — | — |
| other:$.multiblock.opsLegend.runstate.overlay | 117 | 0.03% | — | — |
| other:$.multiblock.opsLegend.tier.overlay | 107 | 0.03% | — | — |
| other:$.multiblock.sourceClass | 99 | 0.03% | — | — |
| other:$.multiblock.notes[].source | 96 | 0.03% | — | — |
| other:$.multiblock.rules[].sel.y | 92 | 0.02% | — | — |
| other:$.multiblock.rules[].sel.y[] | 52 | 0.01% | — | — |
| other:$.multiblock.id | 45 | 0.01% | — | — |
| other:$.multiblock.channels[].enum | 32 | 0.01% | — | — |
| other:$.multiblock.channels[].name | 32 | 0.01% | — | — |
| other:$.multiblock.displayName | 27 | 0.01% | — | — |
| other:$.multiblock.channels[].id | 24 | 0.01% | — | — |
| other:$.multiblock.channels[].key | 24 | 0.01% | — | — |
| other:$.multiblock.rules[].sel.z | 24 | 0.01% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.kind | 23 | 0.01% | — | — |
| other:$.multiblock.paletteSource | 20 | 0.01% | — | — |
| other:$.multiblock.channels[].kind | 18 | 0.00% | — | — |
| other:$.multiblock.notes[].kind | 18 | 0.00% | — | — |
| other:$.multiblock.geometryEncoding | 18 | 0.00% | — | — |
| other:$.multiblock.channels[].domainSource | 16 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.playback | 16 | 0.00% | — | — |
| other:$.multiblock.runstates[].name | 15 | 0.00% | — | — |
| other:$.multiblock.runstates[].id | 14 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.tesr | 13 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.layerPreview | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.kind | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeChannel | 11 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].channel | 11 | 0.00% | — | — |
| other:$.multiblock.runstates[].materialSwap | 9 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.multiblock.couplingMode | 6 | 0.00% | — | — |
| other:$.multiblock.hasScopeOverlap | 5 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.runstateCoverage.geometryDelta | 5 | 0.00% | — | — |
| other:$.multiblock.rules[].y | 5 | 0.00% | — | — |
| other:$.multiblock.tierSample[] | 4 | 0.00% | — | — |
| other:$.multiblock.viewerSemantics.frameIsVariant | 4 | 0.00% | — | — |
| other:$.multiblock.rules[].x | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].z | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].index | 3 | 0.00% | — | — |
| other:$.multiblock.rules[].sel.x | 3 | 0.00% | — | — |
| other:$.multiblock.channels[].min | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].max | 2 | 0.00% | — | — |
| other:$.multiblock.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].layers | 2 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].w | 2 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].hh | 2 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].d | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.43 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.44 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.45 | 2 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.46 | 2 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.max | 1 | 0.00% | — | — |
| other:$.multiblock.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.multiblock.backbone.sizeSteps[].roles.casing | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.0 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.34 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.35 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.36 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.37 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.38 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.39 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.40 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.41 | 1 | 0.00% | — | — |
| other:$.multiblock.rules[].indexAliases.42 | 1 | 0.00% | — | — |
| other:$.multiblockCount | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 35,150 | 9.33% | | |
| （键名 `"key":`，共 6,979 个键） | 56,800 | 15.08% | | |
| **Σ 未压缩 JSON** | **376,678** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frames | 186,091 | 49.40% | 200 | 201 | 1,000 | 12,599 | 1,000 | 14,401 | 7.7% |
| blockPalette | 65,959 | 17.51% | 598 | 143 | 3,545 | 3,403 | 3,545 | 8,430 | 12.8% |
| textureBlobs | 59,434 | 15.78% | 0 | 1 | 0 | 50 | 0 | 52 | 0.1% |
| multiblock | 48,879 | 12.98% | 535 | 501 | 1,888 | 6,760 | 1,888 | 10,720 | 21.9% |
| materialPalette | 11,232 | 2.98% | 229 | 11 | 539 | 511 | 539 | 1,530 | 13.6% |
| tooltipPalette | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| multiblockCount | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **371,598** | — | | | | | | | |（与未压缩 376,678 的差 = 顶层键名与顶层分隔符 5,080） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| textureBlobs | 38,538 |
| blockPalette | 19,648 |
| multiblock | 3,884 |
| frames | 2,316 |
| materialPalette | 1,105 |
| tooltipPalette | 19 |
| multiblockCount | 19 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.frames[].rules[]` | 11800 | 151,400 | frames.meta |
| `$.textureBlobs[]` | 51 | 59,637 | texture.blobs |
| `$.blockPalette[].thumbnailPNG` | 13 | 27,509 | palette.meta |
| `$.frames[].variant` | 200 | 9,400 | frames.meta |
| `$.multiblock.variants[].key` | 200 | 9,400 | other:$.multiblock.variants[].key |
| `$.multiblock.backbone.sizeSteps[].cellGrid[][][]` | 4725 | 5,279 | other:$.multiblock.backbone.sizeSteps[].cellGrid[][][] |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 456 | 3,648 | palette.geometry |
| `$.materialPalette[].locator` | 56 | 2,696 | material.entries |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 456 | 2,520 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 456 | 1,432 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 456 | 1,432 | palette.geometry |
| `$.frames[].runstate` | 200 | 1,400 | frames.meta |
| `$.multiblock.variants[].runstate` | 200 | 1,400 | other:$.multiblock.variants[].runstate |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 456 | 1,368 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 456 | 1,368 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 456 | 1,368 | palette.geometry |
| `$.multiblock.rules[].legend` | 60 | 1,023 | other:$.multiblock.rules[].legend |
| `$.multiblock.rules[].id` | 60 | 775 | other:$.multiblock.rules[].id |
| `$.multiblock.rules[].channel` | 57 | 695 | other:$.multiblock.rules[].channel |
| `$.multiblock.notes[].text` | 3 | 571 | other:$.multiblock.notes[].text |
| `$.materialPalette[].kind` | 56 | 560 | material.entries |
| `$.multiblock.rules[].phase` | 60 | 543 | other:$.multiblock.rules[].phase |
| `$.frames[].index` | 200 | 490 | frames.meta |
| `$.blockPalette[].registryId` | 14 | 466 | palette.meta |
| `$.materialPalette[].atlas` | 56 | 448 | material.entries |
| `$.multiblock.rules[].indexTable[]` | 285 | 410 | other:$.multiblock.rules[].indexTable[] |
| `$.multiblock.rules[].kind` | 60 | 369 | other:$.multiblock.rules[].kind |
| `$.blockPalette[].geometry.encoding` | 14 | 252 | palette.geometry |
| `$.blockPalette[].geometry.quads[].materialIndex` | 114 | 228 | palette.geometry |
| `$.materialPalette[].linear` | 56 | 224 | material.entries |
| `$.materialPalette[].useMipmaps` | 56 | 224 | material.entries |
| `$.multiblock.rules[].sel.x[]` | 165 | 220 | other:$.multiblock.rules[].sel.x[] |
| `$.materialPalette[].animation.frameSequence[].index` | 156 | 210 | material.entries |
| `$.frames[].stepIndex` | 200 | 200 | frames.meta |
| `$.multiblock.variants[].totalTier` | 200 | 200 | other:$.multiblock.variants[].totalTier |
| `$.multiblock.variants[].values.manipulator` | 200 | 200 | other:$.multiblock.variants[].values.manipulator |
| `$.multiblock.variants[].values.shielding` | 200 | 200 | other:$.multiblock.variants[].values.shielding |
| `$.multiblock.opsLegend.palette.renumber` | 1 | 174 | other:$.multiblock.opsLegend.palette.renumber |
| `$.blockPalette[].renderMode` | 14 | 168 | palette.meta |
| `$.multiblock.opsLegend.channel.replace` | 1 | 166 | other:$.multiblock.opsLegend.channel.replace |
| `$.multiblock.rules[].sel.z[]` | 104 | 137 | other:$.multiblock.rules[].sel.z[] |
| `$.multiblock.opsLegend.runstate.overlay` | 1 | 117 | other:$.multiblock.opsLegend.runstate.overlay |
| `$.multiblock.opsLegend.tier.overlay` | 1 | 107 | other:$.multiblock.opsLegend.tier.overlay |
| `$.multiblock.sourceClass` | 1 | 99 | other:$.multiblock.sourceClass |
| `$.materialPalette[].textureBlobIndex` | 56 | 98 | material.entries |
| `$.multiblock.notes[].source` | 3 | 96 | other:$.multiblock.notes[].source |
| `$.multiblock.rules[].sel.y` | 46 | 92 | other:$.multiblock.rules[].sel.y |
| `$.blockPalette[].occludesAdjacentFaces` | 14 | 70 | palette.meta |
| `$.multiblock.rules[].sel.y[]` | 26 | 52 | other:$.multiblock.rules[].sel.y[] |
| `$.multiblock.id` | 1 | 45 | other:$.multiblock.id |
| `$.multiblock.channels[].enum` | 2 | 32 | other:$.multiblock.channels[].enum |
| `$.multiblock.channels[].name` | 2 | 32 | other:$.multiblock.channels[].name |
| `$.multiblock.displayName` | 1 | 27 | other:$.multiblock.displayName |
| `$.multiblock.channels[].id` | 2 | 24 | other:$.multiblock.channels[].id |
| `$.multiblock.channels[].key` | 2 | 24 | other:$.multiblock.channels[].key |
| `$.multiblock.rules[].sel.z` | 17 | 24 | other:$.multiblock.rules[].sel.z |
| `$.multiblock.viewerSemantics.runstateCoverage.kind` | 1 | 23 | other:$.multiblock.viewerSemantics.runstateCoverage.kind |
| `$.blockPalette[].meta` | 14 | 21 | palette.meta |
| `$.multiblock.paletteSource` | 1 | 20 | other:$.multiblock.paletteSource |
| `$.materialPalette[].animation.defaultFrametimeTicks` | 17 | 18 | material.entries |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 456 | 5,928 | 13.00 |
| `runstate` | 400 | 4,400 | 11.00 |
| `color` | 456 | 3,648 | 8.00 |
| `index` | 359 | 2,872 | 8.00 |
| `manipulator` | 200 | 2,800 | 14.00 |
| `stepIndex` | 200 | 2,400 | 12.00 |
| `totalTier` | 200 | 2,400 | 12.00 |
| `shielding` | 200 | 2,400 | 12.00 |
| `y` | 505 | 2,020 | 4.00 |
| `variant` | 200 | 2,000 | 10.00 |
| `z` | 476 | 1,904 | 4.00 |
| `x` | 462 | 1,848 | 4.00 |
| `materialIndex` | 114 | 1,824 | 16.00 |
| `u` | 456 | 1,824 | 4.00 |
| `v` | 456 | 1,824 | 4.00 |
| `key` | 202 | 1,212 | 6.00 |
| `textureBlobIndex` | 56 | 1,064 | 19.00 |
| `kind` | 123 | 861 | 7.00 |
| `useMipmaps` | 56 | 728 | 13.00 |
| `channel` | 58 | 580 | 10.00 |
| `locator` | 56 | 560 | 10.00 |
| `legend` | 60 | 540 | 9.00 |
| `linear` | 56 | 504 | 9.00 |
| `phase` | 60 | 480 | 8.00 |
| `atlas` | 56 | 448 | 8.00 |
| `defaultFrametimeTicks` | 17 | 408 | 24.00 |
| `occludesAdjacentFaces` | 14 | 336 | 24.00 |
| `id` | 65 | 325 | 5.00 |
| `thumbnailPNG` | 13 | 195 | 15.00 |
| `registryId` | 14 | 182 | 13.00 |
| `renderMode` | 14 | 182 | 13.00 |
| `encoding` | 14 | 154 | 11.00 |
| `tooltip` | 14 | 140 | 10.00 |
| `meta` | 14 | 98 | 7.00 |
| `source` | 4 | 36 | 9.00 |
| `max` | 5 | 30 | 6.00 |
| `domainSource` | 2 | 30 | 15.00 |
| `materialSwap` | 2 | 30 | 15.00 |
| `name` | 4 | 28 | 7.00 |
| `timeTicks` | 2 | 24 | 12.00 |
| `text` | 3 | 21 | 7.00 |
| `geometryEncoding` | 1 | 19 | 19.00 |
| `palette.renumber` | 1 | 19 | 19.00 |
| `runstate.overlay` | 1 | 19 | 19.00 |
| `hasScopeOverlap` | 1 | 18 | 18.00 |
| `min` | 3 | 18 | 6.00 |
| `channel.replace` | 1 | 18 | 18.00 |
| `multiblockCount` | 1 | 18 | 18.00 |
| `tooltipPalette` | 1 | 17 | 17.00 |
| `frameIsVariant` | 1 | 17 | 17.00 |
| `geometryDelta` | 1 | 16 | 16.00 |
| `paletteSource` | 1 | 16 | 16.00 |
| `couplingMode` | 1 | 15 | 15.00 |
| `layerPreview` | 1 | 15 | 15.00 |
| `tier.overlay` | 1 | 15 | 15.00 |
| `interpolate` | 1 | 14 | 14.00 |
| `displayName` | 1 | 14 | 14.00 |
| `sourceClass` | 1 | 14 | 14.00 |
| `enum` | 2 | 14 | 7.00 |
| `sizeChannel` | 1 | 14 | 14.00 |


---

