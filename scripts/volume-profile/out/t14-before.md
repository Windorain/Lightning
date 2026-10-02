# 体积剖析原始输出

- 工具：`scripts/volume-profile/volume-profile.mjs`（本文件不含时间戳，便于逐字节比对两次运行结果）
- 文件数：7

## 汇总表

| 文件 | 落盘 | 未压缩 JSON | gzip | base64 | 帧 | cellGrid 规模 | palette 条目 | quad | 材质 | textureBlob |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| mod/gtnh/run/client/variant_capture/run-0015/machines/mtebrickedblastfurnace.json | 10,243 | 6,573 | 2,787 | 3,716 | 1 | ? | 0 | 0 | 0 | 0 |
| mod/gtnh/run/client/variant_capture/run-0015/machines/mtedistillationtower.json | 983,036 | 436,317 | 29,332 | 39,112 | 1 | ? | 0 | 0 | 0 | 0 |
| mod/gtnh/run/client/variant_capture/run-0015/machines/mteelectricblastfurnace.json | 1,461,649 | 744,630 | 45,467 | 60,624 | 1 | ? | 0 | 0 | 0 | 0 |
| mod/gtnh/run/client/variant_capture/run-0015/machines/mtequantumforcetransformer.json | 18,588,583 | 2,557,490 | 61,466 | 81,956 | 1 | ? | 0 | 0 | 0 | 0 |
| mod/gtnh/run/client/variant_capture/run-0015/manifest.json | 593 | 512 | 324 | 432 | 1 | ? | 0 | 0 | 0 | 0 |
| mod/gtnh/run/client/variant_capture/run-0015/palette.json | 541,796 | 294,913 | 102,872 | 137,164 | 1 | ? | 47 | 338 | 56 | 51 |
| mod/gtnh/run/client/variant_capture/run-0015/report.json | 29,082 | 21,989 | 5,884 | 7,848 | 1 | ? | 0 | 0 | 0 | 0 |

## 逐文件明细

### mod/gtnh/run/client/variant_capture/run-0015/machines/mtebrickedblastfurnace.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 10,243 | 10.0 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 6,573 | 6.4 | 分桶统计口径 |
| gzip(level 9) | 2,787 | 2.7 | 压缩后 payload |
| base64(gzip) | 3,716 | 3.6 | 信封 payload 字符串本体 |
| 压缩率 | 42.40% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 6,573 vs 去空白 6,573）
- 三分解闭合：Σ叶子 3,763 + 分隔符 561 + 键名(不含冒号) 2,249 = 6,573；去空白原文 6,573 → **闭合**；叶子 233 个，对象 28 个 / 数组 52 个 / 键 169 个，空白缩进 3,670 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 56、`[]` 104、`,` 232、`:` 169（合计 561）
- 键名审计：键名总量（含冒号）2,418；扫描器逐条定位到的键 token 2,092（142 个），未定位差额 326 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, generatedBy, machine, factsSource, channels, totalTierDomain, tierSample, tierSamplePolicy, runstates, gridConvention, variantCount, variants, variantSignatures, stateKeyVerification, machineAssertions, replaceValueChecks, notes]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 3,763 | 57.25% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.machineAssertions[].detail | 484 | 7.36% | — | — |
| other:$.stateKeyVerification.rule | 379 | 5.77% | — | — |
| other:$.variants[].runState.mechanism | 298 | 4.53% | — | — |
| other:$.stateKeyVerification.verifiedKeysSample | 232 | 3.53% | — | — |
| other:$.variants[].warnings[] | 220 | 3.35% | — | — |
| other:$.variants[].grid.cellGrid[][][] | 138 | 2.10% | — | — |
| other:$.machineAssertions[].id | 135 | 2.05% | — | — |
| other:$.variants[].layoutSignature | 132 | 2.01% | — | — |
| other:$.gridConvention.variantKey | 122 | 1.86% | — | — |
| other:$.variants[].runState.escapeHatchReason | 116 | 1.76% | — | — |
| other:$.variantSignatures.tt:1|runstate:idle | 111 | 1.69% | — | — |
| other:$.variantSignatures.tt:1|runstate:active | 111 | 1.69% | — | — |
| other:$.gridConvention.cellGrid | 107 | 1.63% | — | — |
| other:$.gridConvention.origin | 98 | 1.49% | — | — |
| other:$.variants[].geometrySignature | 92 | 1.40% | — | — |
| other:$.factsSource | 91 | 1.38% | — | — |
| other:$.generatedBy | 85 | 1.29% | — | — |
| other:$.variants[].build.captureMode | 70 | 1.06% | — | — |
| other:$.machine.fqcn | 68 | 1.03% | — | — |
| other:$.gridConvention.value | 68 | 1.03% | — | — |
| other:$.machine.role | 58 | 0.88% | — | — |
| other:$.machineAssertions[].status | 45 | 0.68% | — | — |
| other:$.variants[].key | 42 | 0.64% | — | — |
| other:$.schema | 40 | 0.61% | — | — |
| other:$.variants[].build.hatchPlan | 32 | 0.49% | — | — |
| other:$.machine.simpleName | 24 | 0.37% | — | — |
| other:$.machine.displayName | 23 | 0.35% | — | — |
| other:$.tierSamplePolicy | 23 | 0.35% | — | — |
| other:$.variants[].runState.errorDisplayId | 22 | 0.33% | — | — |
| other:$.totalTierDomain.source | 15 | 0.23% | — | — |
| other:$.runstates[].name | 15 | 0.23% | — | — |
| other:$.runstates[].id | 14 | 0.21% | — | — |
| other:$.variants[].runstate | 14 | 0.21% | — | — |
| other:$.variants[].grid.origin[] | 10 | 0.15% | — | — |
| other:$.variants[].build.machineFormed | 10 | 0.15% | — | — |
| other:$.variants[].build.machineFormedKnown | 10 | 0.15% | — | — |
| other:$.variants[].build.isMultiBlockBase | 10 | 0.15% | — | — |
| other:$.variants[].build.selfDisabled | 10 | 0.15% | — | — |
| other:$.variants[].build.controllerInstanceReused | 10 | 0.15% | — | — |
| other:$.variants[].runState.serverBranchExecuted | 10 | 0.15% | — | — |
| other:$.runstates[].materialSwap | 9 | 0.14% | — | — |
| other:$.variants[].runState.requestedActive | 9 | 0.14% | — | — |
| other:$.variants[].runState.activeObserved | 9 | 0.14% | — | — |
| other:$.variants[].runState.escapeHatchUsed | 9 | 0.14% | — | — |
| other:$.variants[].paletteRefs[] | 8 | 0.12% | — | — |
| other:$.variants[].build.controllerPlaced | 8 | 0.12% | — | — |
| other:$.variants[].build.structureBuilt | 8 | 0.12% | — | — |
| other:$.variants[].runState.assertionPassed | 8 | 0.12% | — | — |
| other:$.variants[].assertions.buildOk | 8 | 0.12% | — | — |
| other:$.variants[].assertions.stateAssertionOk | 8 | 0.12% | — | — |
| other:$.variants[].assertions.geometryCoverageOk | 8 | 0.12% | — | — |
| other:$.variants[].assertions.instanceFresh | 8 | 0.12% | — | — |
| other:$.variants[].grid.size[] | 6 | 0.09% | — | — |
| other:$.variants[].build.quadCount | 6 | 0.09% | — | — |
| other:$.variants[].runState.stateMachineTicks | 6 | 0.09% | — | — |
| other:$.machine.allowEscapeHatch | 4 | 0.06% | — | — |
| other:$.variants[].build.blocksAfterConstruct | 4 | 0.06% | — | — |
| other:$.variants[].build.regularBlocks | 4 | 0.06% | — | — |
| other:$.variants[].build.positionsShared | 4 | 0.06% | — | — |
| other:$.variants[].build.shapeKey | 4 | 0.06% | — | — |
| other:$.machine.mteId | 3 | 0.05% | — | — |
| other:$.variants[].index | 2 | 0.03% | — | — |
| other:$.variants[].totalTier | 2 | 0.03% | — | — |
| other:$.variants[].build.positionsCaptured | 2 | 0.03% | — | — |
| other:$.variants[].build.hatchCandidateTries | 2 | 0.03% | — | — |
| other:$.variants[].build.controllerInstanceOrdinal | 2 | 0.03% | — | — |
| other:$.variants[].runState.maxProgressTime | 2 | 0.03% | — | — |
| other:$.variants[].runState.progressTime | 2 | 0.03% | — | — |
| other:$.stateKeyVerification.fullVerifyUpTo | 2 | 0.03% | — | — |
| other:$.totalTierDomain.min | 1 | 0.02% | — | — |
| other:$.totalTierDomain.max | 1 | 0.02% | — | — |
| other:$.totalTierDomain.default | 1 | 0.02% | — | — |
| other:$.tierSample[] | 1 | 0.02% | — | — |
| other:$.variantCount | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.verifiedStateKeys | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.unstableStateKeys | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.keysNewlyVerified | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.fullCaptureVariants | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.sampledCaptureVariants | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.anchoredCaptureVariants | 1 | 0.02% | — | — |
| other:$.stateKeyVerification.verifyPositionsPerKey | 1 | 0.02% | — | — |
| （分隔符 `{}[],:`，非键名） | 561 | 8.53% | | |
| （键名 `"key":`，共 169 个键） | 2,418 | 36.79% | | |
| **Σ 未压缩 JSON** | **6,573** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| variants | 2,916 | 44.36% | 14 | 45 | 101 | 172 | 101 | 391 | 13.4% |
| stateKeyVerification | 655 | 9.97% | 1 | 1 | 11 | 10 | 11 | 25 | 3.8% |
| machineAssertions | 559 | 8.50% | 6 | 1 | 18 | 17 | 18 | 49 | 8.8% |
| gridConvention | 292 | 4.44% | 1 | 0 | 4 | 3 | 4 | 9 | 3.1% |
| variantSignatures | 269 | 4.09% | 1 | 0 | 2 | 1 | 2 | 5 | 1.9% |
| machine | 231 | 3.51% | 1 | 0 | 6 | 5 | 6 | 13 | 5.6% |
| runstates | 103 | 1.57% | 2 | 1 | 6 | 5 | 6 | 17 | 16.5% |
| factsSource | 91 | 1.38% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| totalTierDomain | 54 | 0.82% | 1 | 0 | 4 | 3 | 4 | 9 | 16.7% |
| generatedBy | 49 | 0.75% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| schema | 40 | 0.61% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSamplePolicy | 23 | 0.35% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSample | 3 | 0.05% | 0 | 1 | 0 | 0 | 0 | 2 | 66.7% |
| channels | 2 | 0.03% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| replaceValueChecks | 2 | 0.03% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| notes | 2 | 0.03% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| variantCount | 1 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **5,292** | — | | | | | | | |（与未压缩 6,573 的差 = 顶层键名与顶层分隔符 1,281） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| variants | 1,189 |
| stateKeyVerification | 552 |
| machineAssertions | 509 |
| gridConvention | 418 |
| machine | 208 |
| variantSignatures | 193 |
| generatedBy | 96 |
| factsSource | 93 |
| runstates | 81 |
| totalTierDomain | 63 |
| schema | 49 |
| tierSamplePolicy | 42 |
| replaceValueChecks | 23 |
| tierSample | 16 |
| variantCount | 16 |
| channels | 13 |
| notes | 10 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.machineAssertions[].detail` | 6 | 484 | other:$.machineAssertions[].detail |
| `$.stateKeyVerification.rule` | 1 | 379 | other:$.stateKeyVerification.rule |
| `$.variants[].runState.mechanism` | 2 | 298 | other:$.variants[].runState.mechanism |
| `$.stateKeyVerification.verifiedKeysSample` | 1 | 232 | other:$.stateKeyVerification.verifiedKeysSample |
| `$.variants[].warnings[]` | 2 | 220 | other:$.variants[].warnings[] |
| `$.variants[].grid.cellGrid[][][]` | 72 | 138 | other:$.variants[].grid.cellGrid[][][] |
| `$.machineAssertions[].id` | 6 | 135 | other:$.machineAssertions[].id |
| `$.variants[].layoutSignature` | 2 | 132 | other:$.variants[].layoutSignature |
| `$.gridConvention.variantKey` | 1 | 122 | other:$.gridConvention.variantKey |
| `$.variants[].runState.escapeHatchReason` | 1 | 116 | other:$.variants[].runState.escapeHatchReason |
| `$.variantSignatures.tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.tt:1|runstate:idle |
| `$.variantSignatures.tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.tt:1|runstate:active |
| `$.gridConvention.cellGrid` | 1 | 107 | other:$.gridConvention.cellGrid |
| `$.gridConvention.origin` | 1 | 98 | other:$.gridConvention.origin |
| `$.variants[].geometrySignature` | 2 | 92 | other:$.variants[].geometrySignature |
| `$.factsSource` | 1 | 91 | other:$.factsSource |
| `$.generatedBy` | 1 | 85 | other:$.generatedBy |
| `$.variants[].build.captureMode` | 2 | 70 | other:$.variants[].build.captureMode |
| `$.machine.fqcn` | 1 | 68 | other:$.machine.fqcn |
| `$.gridConvention.value` | 1 | 68 | other:$.gridConvention.value |
| `$.machine.role` | 1 | 58 | other:$.machine.role |
| `$.machineAssertions[].status` | 6 | 45 | other:$.machineAssertions[].status |
| `$.variants[].key` | 2 | 42 | other:$.variants[].key |
| `$.schema` | 1 | 40 | other:$.schema |
| `$.variants[].build.hatchPlan` | 2 | 32 | other:$.variants[].build.hatchPlan |
| `$.machine.simpleName` | 1 | 24 | other:$.machine.simpleName |
| `$.machine.displayName` | 1 | 23 | other:$.machine.displayName |
| `$.tierSamplePolicy` | 1 | 23 | other:$.tierSamplePolicy |
| `$.variants[].runState.errorDisplayId` | 2 | 22 | other:$.variants[].runState.errorDisplayId |
| `$.totalTierDomain.source` | 1 | 15 | other:$.totalTierDomain.source |
| `$.runstates[].name` | 2 | 15 | other:$.runstates[].name |
| `$.runstates[].id` | 2 | 14 | other:$.runstates[].id |
| `$.variants[].runstate` | 2 | 14 | other:$.variants[].runstate |
| `$.variants[].grid.origin[]` | 6 | 10 | other:$.variants[].grid.origin[] |
| `$.variants[].build.machineFormed` | 2 | 10 | other:$.variants[].build.machineFormed |
| `$.variants[].build.machineFormedKnown` | 2 | 10 | other:$.variants[].build.machineFormedKnown |
| `$.variants[].build.isMultiBlockBase` | 2 | 10 | other:$.variants[].build.isMultiBlockBase |
| `$.variants[].build.selfDisabled` | 2 | 10 | other:$.variants[].build.selfDisabled |
| `$.variants[].build.controllerInstanceReused` | 2 | 10 | other:$.variants[].build.controllerInstanceReused |
| `$.variants[].runState.serverBranchExecuted` | 2 | 10 | other:$.variants[].runState.serverBranchExecuted |
| `$.runstates[].materialSwap` | 2 | 9 | other:$.runstates[].materialSwap |
| `$.variants[].runState.requestedActive` | 2 | 9 | other:$.variants[].runState.requestedActive |
| `$.variants[].runState.activeObserved` | 2 | 9 | other:$.variants[].runState.activeObserved |
| `$.variants[].runState.escapeHatchUsed` | 2 | 9 | other:$.variants[].runState.escapeHatchUsed |
| `$.variants[].paletteRefs[]` | 4 | 8 | other:$.variants[].paletteRefs[] |
| `$.variants[].build.controllerPlaced` | 2 | 8 | other:$.variants[].build.controllerPlaced |
| `$.variants[].build.structureBuilt` | 2 | 8 | other:$.variants[].build.structureBuilt |
| `$.variants[].runState.assertionPassed` | 2 | 8 | other:$.variants[].runState.assertionPassed |
| `$.variants[].assertions.buildOk` | 2 | 8 | other:$.variants[].assertions.buildOk |
| `$.variants[].assertions.stateAssertionOk` | 2 | 8 | other:$.variants[].assertions.stateAssertionOk |
| `$.variants[].assertions.geometryCoverageOk` | 2 | 8 | other:$.variants[].assertions.geometryCoverageOk |
| `$.variants[].assertions.instanceFresh` | 2 | 8 | other:$.variants[].assertions.instanceFresh |
| `$.variants[].grid.size[]` | 6 | 6 | other:$.variants[].grid.size[] |
| `$.variants[].build.quadCount` | 2 | 6 | other:$.variants[].build.quadCount |
| `$.variants[].runState.stateMachineTicks` | 2 | 6 | other:$.variants[].runState.stateMachineTicks |
| `$.machine.allowEscapeHatch` | 1 | 4 | other:$.machine.allowEscapeHatch |
| `$.variants[].build.blocksAfterConstruct` | 2 | 4 | other:$.variants[].build.blocksAfterConstruct |
| `$.variants[].build.regularBlocks` | 2 | 4 | other:$.variants[].build.regularBlocks |
| `$.variants[].build.positionsShared` | 2 | 4 | other:$.variants[].build.positionsShared |
| `$.variants[].build.shapeKey` | 2 | 4 | other:$.variants[].build.shapeKey |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `controllerInstanceOrdinal` | 2 | 56 | 28.00 |
| `controllerInstanceReused` | 2 | 54 | 27.00 |
| `status` | 6 | 54 | 9.00 |
| `detail` | 6 | 54 | 9.00 |
| `blocksAfterConstruct` | 2 | 46 | 23.00 |
| `serverBranchExecuted` | 2 | 46 | 23.00 |
| `hatchCandidateTries` | 2 | 44 | 22.00 |
| `machineFormedKnown` | 2 | 42 | 21.00 |
| `geometryCoverageOk` | 2 | 42 | 21.00 |
| `id` | 8 | 40 | 5.00 |
| `geometrySignature` | 2 | 40 | 20.00 |
| `positionsCaptured` | 2 | 40 | 20.00 |
| `stateMachineTicks` | 2 | 40 | 20.00 |
| `controllerPlaced` | 2 | 38 | 19.00 |
| `isMultiBlockBase` | 2 | 38 | 19.00 |
| `stateAssertionOk` | 2 | 38 | 19.00 |
| `layoutSignature` | 2 | 36 | 18.00 |
| `positionsShared` | 2 | 36 | 18.00 |
| `hatchPlacements` | 2 | 36 | 18.00 |
| `structureErrors` | 2 | 36 | 18.00 |
| `requestedActive` | 2 | 36 | 18.00 |
| `assertionPassed` | 2 | 36 | 18.00 |
| `maxProgressTime` | 2 | 36 | 18.00 |
| `escapeHatchUsed` | 2 | 36 | 18.00 |
| `structureBuilt` | 2 | 34 | 17.00 |
| `activeObserved` | 2 | 34 | 17.00 |
| `errorDisplayId` | 2 | 34 | 17.00 |
| `regularBlocks` | 2 | 32 | 16.00 |
| `machineFormed` | 2 | 32 | 16.00 |
| `instanceFresh` | 2 | 32 | 16.00 |
| `materialSwap` | 2 | 30 | 15.00 |
| `selfDisabled` | 2 | 30 | 15.00 |
| `progressTime` | 2 | 30 | 15.00 |
| `captureMode` | 2 | 28 | 14.00 |
| `anchoredCaptureVariants` | 1 | 26 | 26.00 |
| `sampledCaptureVariants` | 1 | 25 | 25.00 |
| `totalTier` | 2 | 24 | 12.00 |
| `effective` | 2 | 24 | 12.00 |
| `quadCount` | 2 | 24 | 12.00 |
| `hatchPlan` | 2 | 24 | 12.00 |
| `mechanism` | 2 | 24 | 12.00 |
| `verifyPositionsPerKey` | 1 | 24 | 24.00 |
| `tt:1|runstate:active` | 1 | 23 | 23.00 |
| `runstate` | 2 | 22 | 11.00 |
| `shapeKey` | 2 | 22 | 11.00 |
| `fullCaptureVariants` | 1 | 22 | 22.00 |
| `tt:1|runstate:idle` | 1 | 21 | 21.00 |
| `verifiedKeysSample` | 1 | 21 | 21.00 |
| `replaceValueChecks` | 1 | 21 | 21.00 |
| `buildOk` | 2 | 20 | 10.00 |
| `escapeHatchReason` | 1 | 20 | 20.00 |
| `verifiedStateKeys` | 1 | 20 | 20.00 |
| `unstableStateKeys` | 1 | 20 | 20.00 |
| `keysNewlyVerified` | 1 | 20 | 20.00 |
| `allowEscapeHatch` | 1 | 19 | 19.00 |
| `tierSamplePolicy` | 1 | 19 | 19.00 |
| `values` | 2 | 18 | 9.00 |
| `fullVerifyUpTo` | 1 | 17 | 17.00 |
| `index` | 2 | 16 | 8.00 |
| `variantCount` | 1 | 15 | 15.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/machines/mtedistillationtower.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 983,036 | 960.0 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 436,317 | 426.1 | 分桶统计口径 |
| gzip(level 9) | 29,332 | 28.6 | 压缩后 payload |
| base64(gzip) | 39,112 | 38.2 | 信封 payload 字符串本体 |
| 压缩率 | 6.72% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 436,317 vs 去空白 436,317）
- 三分解闭合：Σ叶子 207,044 + 分隔符 57,920 + 键名(不含冒号) 171,353 = 436,317；去空白原文 436,317 → **闭合**；叶子 28,658 个，对象 1,566 个 / 数组 7,161 个 / 键 11,809 个，空白缩进 546,719 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 3,132、`[]` 14,322、`,` 28,657、`:` 11,809（合计 57,920）
- 键名审计：键名总量（含冒号）183,162；扫描器逐条定位到的键 token 154,379（9,156 个），未定位差额 28,783 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, generatedBy, machine, factsSource, channels, totalTierDomain, tierSample, tierSamplePolicy, runstates, gridConvention, variantCount, variants, variantSignatures, stateKeyVerification, machineAssertions, replaceValueChecks, notes]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 207,044 | 47.45% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.variants[].grid.cellGrid[][][] | 28,710 | 6.58% | — | — |
| other:$.variants[].build.hatchPlacements[] | 24,860 | 5.70% | — | — |
| other:$.variants[].warnings[] | 22,560 | 5.17% | — | — |
| other:$.variants[].runState.mechanism | 15,400 | 3.53% | — | — |
| other:$.variants[].layoutSignature | 14,520 | 3.33% | — | — |
| other:$.variants[].build.shapeKey | 14,520 | 3.33% | — | — |
| other:$.variants[].build.captureMode | 11,827 | 2.71% | — | — |
| other:$.variants[].geometrySignature | 10,120 | 2.32% | — | — |
| other:$.variants[].key | 6,642 | 1.52% | — | — |
| other:$.variants[].paletteRefs[] | 3,520 | 0.81% | — | — |
| other:$.variants[].build.hatchPlan | 1,800 | 0.41% | — | — |
| other:$.variants[].runstate | 1,540 | 0.35% | — | — |
| other:$.variants[].build.machineFormed | 1,100 | 0.25% | — | — |
| other:$.variants[].build.controllerInstanceReused | 1,100 | 0.25% | — | — |
| other:$.variants[].runState.escapeHatchUsed | 1,100 | 0.25% | — | — |
| other:$.variants[].runState.requestedActive | 990 | 0.23% | — | — |
| other:$.variants[].runState.activeObserved | 990 | 0.23% | — | — |
| other:$.variants[].grid.origin[] | 880 | 0.20% | — | — |
| other:$.variants[].build.controllerPlaced | 880 | 0.20% | — | — |
| other:$.variants[].build.structureBuilt | 880 | 0.20% | — | — |
| other:$.variants[].build.machineFormedKnown | 880 | 0.20% | — | — |
| other:$.variants[].build.isMultiBlockBase | 880 | 0.20% | — | — |
| other:$.variants[].build.selfDisabled | 880 | 0.20% | — | — |
| other:$.variants[].runState.assertionPassed | 880 | 0.20% | — | — |
| other:$.variants[].runState.serverBranchExecuted | 880 | 0.20% | — | — |
| other:$.variants[].assertions.buildOk | 880 | 0.20% | — | — |
| other:$.variants[].assertions.stateAssertionOk | 880 | 0.20% | — | — |
| other:$.variants[].assertions.geometryCoverageOk | 880 | 0.20% | — | — |
| other:$.variants[].assertions.instanceFresh | 880 | 0.20% | — | — |
| other:$.stateKeyVerification.verifiedKeysSample | 780 | 0.18% | — | — |
| other:$.variants[].grid.size[] | 726 | 0.17% | — | — |
| other:$.variants[].build.quadCount | 660 | 0.15% | — | — |
| other:$.machineAssertions[].perValue[].layoutSignature | 660 | 0.15% | — | — |
| other:$.variants[].index | 550 | 0.13% | — | — |
| other:$.machineAssertions[].detail | 530 | 0.12% | — | — |
| other:$.variants[].build.controllerInstanceOrdinal | 444 | 0.10% | — | — |
| other:$.variants[].build.blocksAfterConstruct | 440 | 0.10% | — | — |
| other:$.variants[].build.regularBlocks | 440 | 0.10% | — | — |
| other:$.variants[].runState.maxProgressTime | 440 | 0.10% | — | — |
| other:$.variants[].runState.errorDisplayId | 440 | 0.10% | — | — |
| other:$.variants[].runState.stateMachineTicks | 440 | 0.10% | — | — |
| other:$.variants[].build.positionsShared | 439 | 0.10% | — | — |
| other:$.stateKeyVerification.rule | 379 | 0.09% | — | — |
| other:$.machineAssertions[].perValue[].variantKey | 291 | 0.07% | — | — |
| other:$.channels[].notes[] | 290 | 0.07% | — | — |
| other:$.variants[].build.hatchCandidateTries | 254 | 0.06% | — | — |
| other:$.variants[].totalTier | 242 | 0.06% | — | — |
| other:$.variants[].effective.height | 242 | 0.06% | — | — |
| other:$.variants[].values.height | 240 | 0.06% | — | — |
| other:$.variants[].build.positionsCaptured | 221 | 0.05% | — | — |
| other:$.variants[].runState.progressTime | 220 | 0.05% | — | — |
| other:$.machineAssertions[].id | 135 | 0.03% | — | — |
| other:$.gridConvention.variantKey | 122 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:1|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:1|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:2|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:2|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:3|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:3|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:4|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:4|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:5|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:5|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:6|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:6|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:7|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:7|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:8|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:8|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:9|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:9|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:0|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:1|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:2|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:3|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:4|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:5|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:6|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:7|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:8|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:9|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:10|runstate:idle | 111 | 0.03% | — | — |
| other:$.variantSignatures.height:10|tt:10|runstate:active | 111 | 0.03% | — | — |
| other:$.gridConvention.cellGrid | 107 | 0.02% | — | — |
| other:$.gridConvention.origin | 98 | 0.02% | — | — |
| other:$.factsSource | 91 | 0.02% | — | — |
| other:$.generatedBy | 85 | 0.02% | — | — |
| other:$.machine.role | 77 | 0.02% | — | — |
| other:$.channels[].valueSemantics | 74 | 0.02% | — | — |
| other:$.gridConvention.value | 68 | 0.02% | — | — |
| other:$.machine.fqcn | 66 | 0.02% | — | — |
| other:$.machineAssertions[].perValue[].status | 60 | 0.01% | — | — |
| other:$.schema | 40 | 0.01% | — | — |
| other:$.machineAssertions[].status | 39 | 0.01% | — | — |
| other:$.channels[].discoverySource | 35 | 0.01% | — | — |
| other:$.tierSamplePolicy | 23 | 0.01% | — | — |
| other:$.machine.simpleName | 22 | 0.01% | — | — |
| other:$.machine.displayName | 20 | 0.00% | — | — |
| other:$.channels[].enum | 18 | 0.00% | — | — |
| other:$.channels[].name | 18 | 0.00% | — | — |
| other:$.channels[].registryAgreement | 16 | 0.00% | — | — |
| other:$.runstates[].name | 15 | 0.00% | — | — |
| other:$.channels[].domainSource | 14 | 0.00% | — | — |
| other:$.runstates[].id | 14 | 0.00% | — | — |
| other:$.machineAssertions[].perValue[].expectedSize | 13 | 0.00% | — | — |
| other:$.machineAssertions[].perValue[].observedSize | 13 | 0.00% | — | — |
| other:$.channels[].kind | 11 | 0.00% | — | — |
| other:$.tierSample[] | 11 | 0.00% | — | — |
| other:$.machineAssertions[].perValue[].value | 11 | 0.00% | — | — |
| other:$.runstates[].materialSwap | 9 | 0.00% | — | — |
| other:$.channels[].id | 8 | 0.00% | — | — |
| other:$.channels[].key | 8 | 0.00% | — | — |
| other:$.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.machineAssertions[].channel | 8 | 0.00% | — | — |
| other:$.machine.mteId | 4 | 0.00% | — | — |
| other:$.machine.allowEscapeHatch | 4 | 0.00% | — | — |
| other:$.variantCount | 3 | 0.00% | — | — |
| other:$.stateKeyVerification.anchoredCaptureVariants | 3 | 0.00% | — | — |
| other:$.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.channels[].max | 2 | 0.00% | — | — |
| other:$.channels[].observedMax | 2 | 0.00% | — | — |
| other:$.totalTierDomain.max | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.fullVerifyUpTo | 2 | 0.00% | — | — |
| other:$.machineAssertions[].checkedGroups | 2 | 0.00% | — | — |
| other:$.machineAssertions[].sizeCeiling | 2 | 0.00% | — | — |
| other:$.channels[].domain.min | 1 | 0.00% | — | — |
| other:$.channels[].min | 1 | 0.00% | — | — |
| other:$.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.verifiedStateKeys | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.unstableStateKeys | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.keysNewlyVerified | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.fullCaptureVariants | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.sampledCaptureVariants | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.verifyPositionsPerKey | 1 | 0.00% | — | — |
| other:$.machineAssertions[].failedGroups | 1 | 0.00% | — | — |
| other:$.machineAssertions[].missingGroups | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 57,920 | 13.27% | | |
| （键名 `"key":`，共 11,809 个键） | 183,162 | 41.98% | | |
| **Σ 未压缩 JSON** | **436,317** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| variants | 380,416 | 87.19% | 1,540 | 7,151 | 11,440 | 28,289 | 11,440 | 57,111 | 15.0% |
| variantSignatures | 31,503 | 7.22% | 1 | 0 | 220 | 219 | 220 | 441 | 1.4% |
| machineAssertions | 2,604 | 0.60% | 16 | 2 | 84 | 82 | 84 | 202 | 7.8% |
| stateKeyVerification | 1,205 | 0.28% | 1 | 1 | 11 | 10 | 11 | 25 | 2.1% |
| channels | 575 | 0.13% | 2 | 3 | 17 | 16 | 17 | 43 | 7.5% |
| gridConvention | 292 | 0.07% | 1 | 0 | 4 | 3 | 4 | 9 | 3.1% |
| machine | 248 | 0.06% | 1 | 0 | 6 | 5 | 6 | 13 | 5.2% |
| runstates | 103 | 0.02% | 2 | 1 | 6 | 5 | 6 | 17 | 16.5% |
| factsSource | 91 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| generatedBy | 49 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| totalTierDomain | 48 | 0.01% | 1 | 0 | 4 | 3 | 4 | 9 | 18.8% |
| schema | 40 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSamplePolicy | 23 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSample | 22 | 0.01% | 0 | 1 | 0 | 9 | 0 | 11 | 50.0% |
| variantCount | 3 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| replaceValueChecks | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| notes | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| **Σ 子树** | **417,226** | — | | | | | | | |（与未压缩 436,317 的差 = 顶层键名与顶层分隔符 19,091） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| variants | 24,942 |
| variantSignatures | 2,017 |
| machineAssertions | 1,264 |
| stateKeyVerification | 627 |
| channels | 482 |
| gridConvention | 418 |
| machine | 221 |
| generatedBy | 96 |
| factsSource | 93 |
| runstates | 81 |
| totalTierDomain | 60 |
| schema | 49 |
| tierSamplePolicy | 42 |
| tierSample | 35 |
| replaceValueChecks | 23 |
| variantCount | 18 |
| notes | 10 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.variants[].grid.cellGrid[][][]` | 14850 | 28,710 | other:$.variants[].grid.cellGrid[][][] |
| `$.variants[].build.hatchPlacements[]` | 1320 | 24,860 | other:$.variants[].build.hatchPlacements[] |
| `$.variants[].warnings[]` | 240 | 22,560 | other:$.variants[].warnings[] |
| `$.variants[].runState.mechanism` | 220 | 15,400 | other:$.variants[].runState.mechanism |
| `$.variants[].layoutSignature` | 220 | 14,520 | other:$.variants[].layoutSignature |
| `$.variants[].build.shapeKey` | 220 | 14,520 | other:$.variants[].build.shapeKey |
| `$.variants[].build.captureMode` | 220 | 11,827 | other:$.variants[].build.captureMode |
| `$.variants[].geometrySignature` | 220 | 10,120 | other:$.variants[].geometrySignature |
| `$.variants[].key` | 220 | 6,642 | other:$.variants[].key |
| `$.variants[].paletteRefs[]` | 1760 | 3,520 | other:$.variants[].paletteRefs[] |
| `$.variants[].build.hatchPlan` | 220 | 1,800 | other:$.variants[].build.hatchPlan |
| `$.variants[].runstate` | 220 | 1,540 | other:$.variants[].runstate |
| `$.variants[].build.machineFormed` | 220 | 1,100 | other:$.variants[].build.machineFormed |
| `$.variants[].build.controllerInstanceReused` | 220 | 1,100 | other:$.variants[].build.controllerInstanceReused |
| `$.variants[].runState.escapeHatchUsed` | 220 | 1,100 | other:$.variants[].runState.escapeHatchUsed |
| `$.variants[].runState.requestedActive` | 220 | 990 | other:$.variants[].runState.requestedActive |
| `$.variants[].runState.activeObserved` | 220 | 990 | other:$.variants[].runState.activeObserved |
| `$.variants[].grid.origin[]` | 660 | 880 | other:$.variants[].grid.origin[] |
| `$.variants[].build.controllerPlaced` | 220 | 880 | other:$.variants[].build.controllerPlaced |
| `$.variants[].build.structureBuilt` | 220 | 880 | other:$.variants[].build.structureBuilt |
| `$.variants[].build.machineFormedKnown` | 220 | 880 | other:$.variants[].build.machineFormedKnown |
| `$.variants[].build.isMultiBlockBase` | 220 | 880 | other:$.variants[].build.isMultiBlockBase |
| `$.variants[].build.selfDisabled` | 220 | 880 | other:$.variants[].build.selfDisabled |
| `$.variants[].runState.assertionPassed` | 220 | 880 | other:$.variants[].runState.assertionPassed |
| `$.variants[].runState.serverBranchExecuted` | 220 | 880 | other:$.variants[].runState.serverBranchExecuted |
| `$.variants[].assertions.buildOk` | 220 | 880 | other:$.variants[].assertions.buildOk |
| `$.variants[].assertions.stateAssertionOk` | 220 | 880 | other:$.variants[].assertions.stateAssertionOk |
| `$.variants[].assertions.geometryCoverageOk` | 220 | 880 | other:$.variants[].assertions.geometryCoverageOk |
| `$.variants[].assertions.instanceFresh` | 220 | 880 | other:$.variants[].assertions.instanceFresh |
| `$.stateKeyVerification.verifiedKeysSample` | 1 | 780 | other:$.stateKeyVerification.verifiedKeysSample |
| `$.variants[].grid.size[]` | 660 | 726 | other:$.variants[].grid.size[] |
| `$.variants[].build.quadCount` | 220 | 660 | other:$.variants[].build.quadCount |
| `$.machineAssertions[].perValue[].layoutSignature` | 10 | 660 | other:$.machineAssertions[].perValue[].layoutSignature |
| `$.variants[].index` | 220 | 550 | other:$.variants[].index |
| `$.machineAssertions[].detail` | 6 | 530 | other:$.machineAssertions[].detail |
| `$.variants[].build.controllerInstanceOrdinal` | 220 | 444 | other:$.variants[].build.controllerInstanceOrdinal |
| `$.variants[].build.blocksAfterConstruct` | 220 | 440 | other:$.variants[].build.blocksAfterConstruct |
| `$.variants[].build.regularBlocks` | 220 | 440 | other:$.variants[].build.regularBlocks |
| `$.variants[].runState.maxProgressTime` | 220 | 440 | other:$.variants[].runState.maxProgressTime |
| `$.variants[].runState.errorDisplayId` | 220 | 440 | other:$.variants[].runState.errorDisplayId |
| `$.variants[].runState.stateMachineTicks` | 220 | 440 | other:$.variants[].runState.stateMachineTicks |
| `$.variants[].build.positionsShared` | 220 | 439 | other:$.variants[].build.positionsShared |
| `$.stateKeyVerification.rule` | 1 | 379 | other:$.stateKeyVerification.rule |
| `$.machineAssertions[].perValue[].variantKey` | 10 | 291 | other:$.machineAssertions[].perValue[].variantKey |
| `$.channels[].notes[]` | 2 | 290 | other:$.channels[].notes[] |
| `$.variants[].build.hatchCandidateTries` | 220 | 254 | other:$.variants[].build.hatchCandidateTries |
| `$.variants[].totalTier` | 220 | 242 | other:$.variants[].totalTier |
| `$.variants[].effective.height` | 220 | 242 | other:$.variants[].effective.height |
| `$.variants[].values.height` | 220 | 240 | other:$.variants[].values.height |
| `$.variants[].build.positionsCaptured` | 220 | 221 | other:$.variants[].build.positionsCaptured |
| `$.variants[].runState.progressTime` | 220 | 220 | other:$.variants[].runState.progressTime |
| `$.machineAssertions[].id` | 6 | 135 | other:$.machineAssertions[].id |
| `$.gridConvention.variantKey` | 1 | 122 | other:$.gridConvention.variantKey |
| `$.variantSignatures.height:0|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.height:0|tt:1|runstate:idle |
| `$.variantSignatures.height:0|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.height:0|tt:1|runstate:active |
| `$.variantSignatures.height:1|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.height:1|tt:1|runstate:idle |
| `$.variantSignatures.height:1|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.height:1|tt:1|runstate:active |
| `$.variantSignatures.height:2|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.height:2|tt:1|runstate:idle |
| `$.variantSignatures.height:2|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.height:2|tt:1|runstate:active |
| `$.variantSignatures.height:3|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.height:3|tt:1|runstate:idle |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `controllerInstanceOrdinal` | 220 | 6,160 | 28.00 |
| `controllerInstanceReused` | 220 | 5,940 | 27.00 |
| `blocksAfterConstruct` | 220 | 5,060 | 23.00 |
| `serverBranchExecuted` | 220 | 5,060 | 23.00 |
| `hatchCandidateTries` | 220 | 4,840 | 22.00 |
| `machineFormedKnown` | 220 | 4,620 | 21.00 |
| `geometryCoverageOk` | 220 | 4,620 | 21.00 |
| `geometrySignature` | 220 | 4,400 | 20.00 |
| `positionsCaptured` | 220 | 4,400 | 20.00 |
| `stateMachineTicks` | 220 | 4,400 | 20.00 |
| `controllerPlaced` | 220 | 4,180 | 19.00 |
| `isMultiBlockBase` | 220 | 4,180 | 19.00 |
| `stateAssertionOk` | 220 | 4,180 | 19.00 |
| `layoutSignature` | 230 | 4,140 | 18.00 |
| `height` | 440 | 3,960 | 9.00 |
| `positionsShared` | 220 | 3,960 | 18.00 |
| `structureErrors` | 220 | 3,960 | 18.00 |
| `requestedActive` | 220 | 3,960 | 18.00 |
| `assertionPassed` | 220 | 3,960 | 18.00 |
| `maxProgressTime` | 220 | 3,960 | 18.00 |
| `escapeHatchUsed` | 220 | 3,960 | 18.00 |
| `structureBuilt` | 220 | 3,740 | 17.00 |
| `activeObserved` | 220 | 3,740 | 17.00 |
| `errorDisplayId` | 220 | 3,740 | 17.00 |
| `regularBlocks` | 220 | 3,520 | 16.00 |
| `machineFormed` | 220 | 3,520 | 16.00 |
| `instanceFresh` | 220 | 3,520 | 16.00 |
| `selfDisabled` | 220 | 3,300 | 15.00 |
| `progressTime` | 220 | 3,300 | 15.00 |
| `captureMode` | 220 | 3,080 | 14.00 |
| `totalTier` | 220 | 2,640 | 12.00 |
| `quadCount` | 220 | 2,640 | 12.00 |
| `hatchPlan` | 220 | 2,640 | 12.00 |
| `mechanism` | 220 | 2,640 | 12.00 |
| `runstate` | 220 | 2,420 | 11.00 |
| `shapeKey` | 220 | 2,420 | 11.00 |
| `buildOk` | 220 | 2,200 | 10.00 |
| `index` | 220 | 1,760 | 8.00 |
| `key` | 221 | 1,326 | 6.00 |
| `expectedSize` | 10 | 150 | 15.00 |
| `observedSize` | 10 | 150 | 15.00 |
| `status` | 16 | 144 | 9.00 |
| `variantKey` | 11 | 143 | 13.00 |
| `value` | 11 | 88 | 8.00 |
| `detail` | 6 | 54 | 9.00 |
| `id` | 9 | 45 | 5.00 |
| `height:10|tt:10|runstate:active` | 1 | 34 | 34.00 |
| `height:10|tt:1|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:2|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:3|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:4|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:5|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:6|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:7|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:8|runstate:active` | 1 | 33 | 33.00 |
| `height:10|tt:9|runstate:active` | 1 | 33 | 33.00 |
| `height:0|tt:10|runstate:active` | 1 | 33 | 33.00 |
| `height:1|tt:10|runstate:active` | 1 | 33 | 33.00 |
| `height:2|tt:10|runstate:active` | 1 | 33 | 33.00 |
| `height:3|tt:10|runstate:active` | 1 | 33 | 33.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/machines/mteelectricblastfurnace.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 1,461,649 | 1427.4 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 744,630 | 727.2 | 分桶统计口径 |
| gzip(level 9) | 45,467 | 44.4 | 压缩后 payload |
| base64(gzip) | 60,624 | 59.2 | 信封 payload 字符串本体 |
| 压缩率 | 6.11% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 744,630 vs 去空白 744,630）
- 三分解闭合：Σ叶子 332,756 + 分隔符 87,170 + 键名(不含冒号) 324,704 = 744,630；去空白原文 744,630 → **闭合**；叶子 40,172 个，对象 2,985 个 / 数组 9,250 个 / 键 22,529 个，空白缩进 717,019 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 5,970、`[]` 18,500、`,` 40,171、`:` 22,529（合计 87,170）
- 键名审计：键名总量（含冒号）347,233；扫描器逐条定位到的键 token 292,423（17,475 个），未定位差额 54,810 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, generatedBy, machine, factsSource, channels, totalTierDomain, tierSample, tierSamplePolicy, runstates, gridConvention, variantCount, variants, variantSignatures, stateKeyVerification, machineAssertions, replaceValueChecks, notes]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 332,756 | 44.69% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.variants[].warnings[] | 40,066 | 5.38% | — | — |
| other:$.variants[].build.hatchPlacements[] | 30,240 | 4.06% | — | — |
| other:$.variants[].runState.mechanism | 29,400 | 3.95% | — | — |
| other:$.variants[].layoutSignature | 27,720 | 3.72% | — | — |
| other:$.variants[].build.shapeKey | 27,720 | 3.72% | — | — |
| other:$.variants[].build.captureMode | 22,380 | 3.01% | — | — |
| other:$.variants[].grid.cellGrid[][][] | 20,880 | 2.80% | — | — |
| other:$.variants[].geometrySignature | 19,320 | 2.59% | — | — |
| other:$.variants[].key | 12,050 | 1.62% | — | — |
| other:$.variants[].build.hatchPlan | 3,364 | 0.45% | — | — |
| other:$.variants[].paletteRefs[] | 3,300 | 0.44% | — | — |
| other:$.variants[].runstate | 2,940 | 0.39% | — | — |
| other:$.variants[].build.machineFormed | 2,100 | 0.28% | — | — |
| other:$.variants[].build.controllerInstanceReused | 2,100 | 0.28% | — | — |
| other:$.variants[].runState.escapeHatchUsed | 2,100 | 0.28% | — | — |
| other:$.variants[].runState.requestedActive | 1,890 | 0.25% | — | — |
| other:$.variants[].runState.activeObserved | 1,890 | 0.25% | — | — |
| other:$.variants[].grid.origin[] | 1,680 | 0.23% | — | — |
| other:$.variants[].build.controllerPlaced | 1,680 | 0.23% | — | — |
| other:$.variants[].build.structureBuilt | 1,680 | 0.23% | — | — |
| other:$.variants[].build.machineFormedKnown | 1,680 | 0.23% | — | — |
| other:$.variants[].build.isMultiBlockBase | 1,680 | 0.23% | — | — |
| other:$.variants[].build.selfDisabled | 1,680 | 0.23% | — | — |
| other:$.variants[].runState.assertionPassed | 1,680 | 0.23% | — | — |
| other:$.variants[].runState.serverBranchExecuted | 1,680 | 0.23% | — | — |
| other:$.variants[].assertions.buildOk | 1,680 | 0.23% | — | — |
| other:$.variants[].assertions.stateAssertionOk | 1,680 | 0.23% | — | — |
| other:$.variants[].assertions.geometryCoverageOk | 1,680 | 0.23% | — | — |
| other:$.variants[].assertions.instanceFresh | 1,680 | 0.23% | — | — |
| other:$.variants[].grid.size[] | 1,260 | 0.17% | — | — |
| other:$.variants[].build.quadCount | 1,260 | 0.17% | — | — |
| other:$.variants[].index | 1,150 | 0.15% | — | — |
| other:$.variants[].build.controllerInstanceOrdinal | 1,044 | 0.14% | — | — |
| other:$.variants[].build.blocksAfterConstruct | 840 | 0.11% | — | — |
| other:$.variants[].build.regularBlocks | 840 | 0.11% | — | — |
| other:$.variants[].runState.maxProgressTime | 840 | 0.11% | — | — |
| other:$.variants[].runState.errorDisplayId | 840 | 0.11% | — | — |
| other:$.variants[].runState.stateMachineTicks | 840 | 0.11% | — | — |
| other:$.variants[].build.positionsShared | 839 | 0.11% | — | — |
| other:$.variants[].totalTier | 570 | 0.08% | — | — |
| other:$.variants[].effective.coil | 570 | 0.08% | — | — |
| other:$.variants[].values.coil | 560 | 0.08% | — | — |
| other:$.replaceValueChecks[].detail | 559 | 0.08% | — | — |
| other:$.machineAssertions[].detail | 452 | 0.06% | — | — |
| other:$.variants[].build.positionsCaptured | 434 | 0.06% | — | — |
| other:$.variants[].build.hatchCandidateTries | 424 | 0.06% | — | — |
| other:$.variants[].runState.progressTime | 420 | 0.06% | — | — |
| other:$.stateKeyVerification.rule | 379 | 0.05% | — | — |
| other:$.channels[].notes[] | 258 | 0.03% | — | — |
| other:$.machine.role | 164 | 0.02% | — | — |
| other:$.replaceValueChecks[].id | 161 | 0.02% | — | — |
| other:$.channels[].expectedStates[].blocksKey | 150 | 0.02% | — | — |
| other:$.machineAssertions[].id | 135 | 0.02% | — | — |
| other:$.gridConvention.variantKey | 122 | 0.02% | — | — |
| other:$.replaceValueChecks[].expectedBlocksKey | 121 | 0.02% | — | — |
| other:$.variantSignatures.coil:0|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:1|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:1|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:2|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:2|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:3|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:3|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:4|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:4|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:5|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:5|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:6|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:6|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:7|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:7|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:8|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:8|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:9|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:9|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:10|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:10|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:11|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:11|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:12|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:12|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:13|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:13|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:0|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:1|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:2|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:3|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:4|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:5|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:6|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:7|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:8|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:9|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:10|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:11|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:12|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:13|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:14|runstate:idle | 111 | 0.01% | — | — |
| other:$.variantSignatures.coil:14|tt:14|runstate:active | 111 | 0.01% | — | — |
| other:$.gridConvention.cellGrid | 107 | 0.01% | — | — |
| other:$.gridConvention.origin | 98 | 0.01% | — | — |
| other:$.factsSource | 91 | 0.01% | — | — |
| other:$.generatedBy | 85 | 0.01% | — | — |
| other:$.replaceValueChecks[].channel | 78 | 0.01% | — | — |
| other:$.replaceValueChecks[].status | 78 | 0.01% | — | — |
| other:$.machine.fqcn | 69 | 0.01% | — | — |
| other:$.gridConvention.value | 68 | 0.01% | — | — |
| other:$.channels[].expectedStates[].expectedResolvable | 64 | 0.01% | — | — |
| other:$.channels[].valueSemantics | 52 | 0.01% | — | — |
| other:$.channels[].expectedStates[].expectedItemId | 48 | 0.01% | — | — |
| other:$.schema | 40 | 0.01% | — | — |
| other:$.machineAssertions[].status | 39 | 0.01% | — | — |
| other:$.replaceValueChecks[].diffPositions | 26 | 0.00% | — | — |
| other:$.replaceValueChecks[].matched | 26 | 0.00% | — | — |
| other:$.machine.simpleName | 25 | 0.00% | — | — |
| other:$.machine.displayName | 24 | 0.00% | — | — |
| other:$.channels[].expectedStates[].value | 23 | 0.00% | — | — |
| other:$.tierSamplePolicy | 23 | 0.00% | — | — |
| other:$.channels[].expectedStates[].expectedMeta | 22 | 0.00% | — | — |
| other:$.tierSample[] | 19 | 0.00% | — | — |
| other:$.runstates[].name | 15 | 0.00% | — | — |
| other:$.channels[].enum | 14 | 0.00% | — | — |
| other:$.channels[].name | 14 | 0.00% | — | — |
| other:$.channels[].discoverySource | 14 | 0.00% | — | — |
| other:$.runstates[].id | 14 | 0.00% | — | — |
| other:$.replaceValueChecks[].mismatched | 13 | 0.00% | — | — |
| other:$.channels[].kind | 9 | 0.00% | — | — |
| other:$.runstates[].materialSwap | 9 | 0.00% | — | — |
| other:$.channels[].domainSource | 8 | 0.00% | — | — |
| other:$.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.channels[].registryAgreement | 7 | 0.00% | — | — |
| other:$.channels[].id | 6 | 0.00% | — | — |
| other:$.channels[].key | 6 | 0.00% | — | — |
| other:$.machine.mteId | 4 | 0.00% | — | — |
| other:$.machine.allowEscapeHatch | 4 | 0.00% | — | — |
| other:$.variantCount | 3 | 0.00% | — | — |
| other:$.stateKeyVerification.anchoredCaptureVariants | 3 | 0.00% | — | — |
| other:$.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.channels[].max | 2 | 0.00% | — | — |
| other:$.channels[].observedMax | 2 | 0.00% | — | — |
| other:$.totalTierDomain.max | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.verifiedStateKeys | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.keysNewlyVerified | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.sampledCaptureVariants | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.fullVerifyUpTo | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.verifiedKeysSample | 2 | 0.00% | — | — |
| other:$.machineAssertions[].checkedGroups | 2 | 0.00% | — | — |
| other:$.channels[].domain.min | 1 | 0.00% | — | — |
| other:$.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.unstableStateKeys | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.fullCaptureVariants | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.verifyPositionsPerKey | 1 | 0.00% | — | — |
| other:$.machineAssertions[].failedGroups | 1 | 0.00% | — | — |
| other:$.machineAssertions[].missingGroups | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 87,170 | 11.71% | | |
| （键名 `"key":`，共 22,529 个键） | 347,233 | 46.63% | | |
| **Σ 未压缩 JSON** | **744,630** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| variants | 644,884 | 86.60% | 2,940 | 9,241 | 21,840 | 39,481 | 21,840 | 85,683 | 13.3% |
| variantSignatures | 59,511 | 7.99% | 1 | 0 | 420 | 419 | 420 | 841 | 1.4% |
| replaceValueChecks | 2,103 | 0.28% | 13 | 1 | 104 | 103 | 104 | 235 | 11.2% |
| channels | 2,013 | 0.27% | 18 | 3 | 96 | 93 | 96 | 231 | 11.5% |
| machineAssertions | 605 | 0.08% | 6 | 1 | 21 | 20 | 21 | 55 | 9.1% |
| stateKeyVerification | 430 | 0.06% | 1 | 1 | 11 | 10 | 11 | 25 | 5.8% |
| gridConvention | 292 | 0.04% | 1 | 0 | 4 | 3 | 4 | 9 | 3.1% |
| machine | 281 | 0.04% | 1 | 0 | 6 | 5 | 6 | 13 | 4.6% |
| runstates | 103 | 0.01% | 2 | 1 | 6 | 5 | 6 | 17 | 16.5% |
| factsSource | 91 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| generatedBy | 49 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| totalTierDomain | 48 | 0.01% | 1 | 0 | 4 | 3 | 4 | 9 | 18.8% |
| schema | 40 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSample | 34 | 0.00% | 0 | 1 | 0 | 13 | 0 | 15 | 44.1% |
| tierSamplePolicy | 23 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| variantCount | 3 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| notes | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| **Σ 子树** | **710,512** | — | | | | | | | |（与未压缩 744,630 的差 = 顶层键名与顶层分隔符 34,118） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| variants | 39,840 |
| variantSignatures | 3,197 |
| channels | 675 |
| machineAssertions | 539 |
| stateKeyVerification | 465 |
| gridConvention | 418 |
| machine | 306 |
| replaceValueChecks | 258 |
| generatedBy | 96 |
| factsSource | 93 |
| runstates | 81 |
| totalTierDomain | 60 |
| schema | 49 |
| tierSample | 47 |
| tierSamplePolicy | 42 |
| variantCount | 18 |
| notes | 10 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.variants[].warnings[]` | 422 | 40,066 | other:$.variants[].warnings[] |
| `$.variants[].build.hatchPlacements[]` | 1680 | 30,240 | other:$.variants[].build.hatchPlacements[] |
| `$.variants[].runState.mechanism` | 420 | 29,400 | other:$.variants[].runState.mechanism |
| `$.variants[].layoutSignature` | 420 | 27,720 | other:$.variants[].layoutSignature |
| `$.variants[].build.shapeKey` | 420 | 27,720 | other:$.variants[].build.shapeKey |
| `$.variants[].build.captureMode` | 420 | 22,380 | other:$.variants[].build.captureMode |
| `$.variants[].grid.cellGrid[][][]` | 15120 | 20,880 | other:$.variants[].grid.cellGrid[][][] |
| `$.variants[].geometrySignature` | 420 | 19,320 | other:$.variants[].geometrySignature |
| `$.variants[].key` | 420 | 12,050 | other:$.variants[].key |
| `$.variants[].build.hatchPlan` | 420 | 3,364 | other:$.variants[].build.hatchPlan |
| `$.variants[].paletteRefs[]` | 2940 | 3,300 | other:$.variants[].paletteRefs[] |
| `$.variants[].runstate` | 420 | 2,940 | other:$.variants[].runstate |
| `$.variants[].build.machineFormed` | 420 | 2,100 | other:$.variants[].build.machineFormed |
| `$.variants[].build.controllerInstanceReused` | 420 | 2,100 | other:$.variants[].build.controllerInstanceReused |
| `$.variants[].runState.escapeHatchUsed` | 420 | 2,100 | other:$.variants[].runState.escapeHatchUsed |
| `$.variants[].runState.requestedActive` | 420 | 1,890 | other:$.variants[].runState.requestedActive |
| `$.variants[].runState.activeObserved` | 420 | 1,890 | other:$.variants[].runState.activeObserved |
| `$.variants[].grid.origin[]` | 1260 | 1,680 | other:$.variants[].grid.origin[] |
| `$.variants[].build.controllerPlaced` | 420 | 1,680 | other:$.variants[].build.controllerPlaced |
| `$.variants[].build.structureBuilt` | 420 | 1,680 | other:$.variants[].build.structureBuilt |
| `$.variants[].build.machineFormedKnown` | 420 | 1,680 | other:$.variants[].build.machineFormedKnown |
| `$.variants[].build.isMultiBlockBase` | 420 | 1,680 | other:$.variants[].build.isMultiBlockBase |
| `$.variants[].build.selfDisabled` | 420 | 1,680 | other:$.variants[].build.selfDisabled |
| `$.variants[].runState.assertionPassed` | 420 | 1,680 | other:$.variants[].runState.assertionPassed |
| `$.variants[].runState.serverBranchExecuted` | 420 | 1,680 | other:$.variants[].runState.serverBranchExecuted |
| `$.variants[].assertions.buildOk` | 420 | 1,680 | other:$.variants[].assertions.buildOk |
| `$.variants[].assertions.stateAssertionOk` | 420 | 1,680 | other:$.variants[].assertions.stateAssertionOk |
| `$.variants[].assertions.geometryCoverageOk` | 420 | 1,680 | other:$.variants[].assertions.geometryCoverageOk |
| `$.variants[].assertions.instanceFresh` | 420 | 1,680 | other:$.variants[].assertions.instanceFresh |
| `$.variants[].grid.size[]` | 1260 | 1,260 | other:$.variants[].grid.size[] |
| `$.variants[].build.quadCount` | 420 | 1,260 | other:$.variants[].build.quadCount |
| `$.variants[].index` | 420 | 1,150 | other:$.variants[].index |
| `$.variants[].build.controllerInstanceOrdinal` | 420 | 1,044 | other:$.variants[].build.controllerInstanceOrdinal |
| `$.variants[].build.blocksAfterConstruct` | 420 | 840 | other:$.variants[].build.blocksAfterConstruct |
| `$.variants[].build.regularBlocks` | 420 | 840 | other:$.variants[].build.regularBlocks |
| `$.variants[].runState.maxProgressTime` | 420 | 840 | other:$.variants[].runState.maxProgressTime |
| `$.variants[].runState.errorDisplayId` | 420 | 840 | other:$.variants[].runState.errorDisplayId |
| `$.variants[].runState.stateMachineTicks` | 420 | 840 | other:$.variants[].runState.stateMachineTicks |
| `$.variants[].build.positionsShared` | 420 | 839 | other:$.variants[].build.positionsShared |
| `$.variants[].totalTier` | 420 | 570 | other:$.variants[].totalTier |
| `$.variants[].effective.coil` | 420 | 570 | other:$.variants[].effective.coil |
| `$.variants[].values.coil` | 420 | 560 | other:$.variants[].values.coil |
| `$.replaceValueChecks[].detail` | 13 | 559 | other:$.replaceValueChecks[].detail |
| `$.machineAssertions[].detail` | 6 | 452 | other:$.machineAssertions[].detail |
| `$.variants[].build.positionsCaptured` | 420 | 434 | other:$.variants[].build.positionsCaptured |
| `$.variants[].build.hatchCandidateTries` | 420 | 424 | other:$.variants[].build.hatchCandidateTries |
| `$.variants[].runState.progressTime` | 420 | 420 | other:$.variants[].runState.progressTime |
| `$.stateKeyVerification.rule` | 1 | 379 | other:$.stateKeyVerification.rule |
| `$.channels[].notes[]` | 1 | 258 | other:$.channels[].notes[] |
| `$.machine.role` | 1 | 164 | other:$.machine.role |
| `$.replaceValueChecks[].id` | 13 | 161 | other:$.replaceValueChecks[].id |
| `$.channels[].expectedStates[].blocksKey` | 16 | 150 | other:$.channels[].expectedStates[].blocksKey |
| `$.machineAssertions[].id` | 6 | 135 | other:$.machineAssertions[].id |
| `$.gridConvention.variantKey` | 1 | 122 | other:$.gridConvention.variantKey |
| `$.replaceValueChecks[].expectedBlocksKey` | 13 | 121 | other:$.replaceValueChecks[].expectedBlocksKey |
| `$.variantSignatures.coil:0|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.coil:0|tt:1|runstate:idle |
| `$.variantSignatures.coil:0|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.coil:0|tt:1|runstate:active |
| `$.variantSignatures.coil:1|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.coil:1|tt:1|runstate:idle |
| `$.variantSignatures.coil:1|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.coil:1|tt:1|runstate:active |
| `$.variantSignatures.coil:2|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.coil:2|tt:1|runstate:idle |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `controllerInstanceOrdinal` | 420 | 11,760 | 28.00 |
| `controllerInstanceReused` | 420 | 11,340 | 27.00 |
| `blocksAfterConstruct` | 420 | 9,660 | 23.00 |
| `serverBranchExecuted` | 420 | 9,660 | 23.00 |
| `hatchCandidateTries` | 420 | 9,240 | 22.00 |
| `machineFormedKnown` | 420 | 8,820 | 21.00 |
| `geometryCoverageOk` | 420 | 8,820 | 21.00 |
| `geometrySignature` | 420 | 8,400 | 20.00 |
| `positionsCaptured` | 420 | 8,400 | 20.00 |
| `stateMachineTicks` | 420 | 8,400 | 20.00 |
| `controllerPlaced` | 420 | 7,980 | 19.00 |
| `isMultiBlockBase` | 420 | 7,980 | 19.00 |
| `stateAssertionOk` | 420 | 7,980 | 19.00 |
| `layoutSignature` | 420 | 7,560 | 18.00 |
| `positionsShared` | 420 | 7,560 | 18.00 |
| `structureErrors` | 420 | 7,560 | 18.00 |
| `requestedActive` | 420 | 7,560 | 18.00 |
| `assertionPassed` | 420 | 7,560 | 18.00 |
| `maxProgressTime` | 420 | 7,560 | 18.00 |
| `escapeHatchUsed` | 420 | 7,560 | 18.00 |
| `structureBuilt` | 420 | 7,140 | 17.00 |
| `activeObserved` | 420 | 7,140 | 17.00 |
| `errorDisplayId` | 420 | 7,140 | 17.00 |
| `regularBlocks` | 420 | 6,720 | 16.00 |
| `machineFormed` | 420 | 6,720 | 16.00 |
| `instanceFresh` | 420 | 6,720 | 16.00 |
| `selfDisabled` | 420 | 6,300 | 15.00 |
| `progressTime` | 420 | 6,300 | 15.00 |
| `coil` | 840 | 5,880 | 7.00 |
| `captureMode` | 420 | 5,880 | 14.00 |
| `totalTier` | 420 | 5,040 | 12.00 |
| `quadCount` | 420 | 5,040 | 12.00 |
| `hatchPlan` | 420 | 5,040 | 12.00 |
| `mechanism` | 420 | 5,040 | 12.00 |
| `runstate` | 420 | 4,620 | 11.00 |
| `shapeKey` | 420 | 4,620 | 11.00 |
| `buildOk` | 420 | 4,200 | 10.00 |
| `index` | 420 | 3,360 | 8.00 |
| `key` | 421 | 2,526 | 6.00 |
| `expectedResolvable` | 16 | 336 | 21.00 |
| `expectedItemId` | 16 | 272 | 17.00 |
| `expectedBlocksKey` | 13 | 260 | 20.00 |
| `expectedMeta` | 16 | 240 | 15.00 |
| `diffPositions` | 13 | 208 | 16.00 |
| `blocksKey` | 16 | 192 | 12.00 |
| `status` | 19 | 171 | 9.00 |
| `detail` | 19 | 171 | 9.00 |
| `mismatched` | 13 | 169 | 13.00 |
| `value` | 17 | 136 | 8.00 |
| `channel` | 13 | 130 | 10.00 |
| `matched` | 13 | 130 | 10.00 |
| `id` | 22 | 110 | 5.00 |
| `coil:10|tt:10|runstate:active` | 1 | 32 | 32.00 |
| `coil:11|tt:10|runstate:active` | 1 | 32 | 32.00 |
| `coil:12|tt:10|runstate:active` | 1 | 32 | 32.00 |
| `coil:13|tt:10|runstate:active` | 1 | 32 | 32.00 |
| `coil:14|tt:10|runstate:active` | 1 | 32 | 32.00 |
| `coil:10|tt:11|runstate:active` | 1 | 32 | 32.00 |
| `coil:11|tt:11|runstate:active` | 1 | 32 | 32.00 |
| `coil:12|tt:11|runstate:active` | 1 | 32 | 32.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/machines/mtequantumforcetransformer.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 18,588,583 | 18152.9 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 2,557,490 | 2497.5 | 分桶统计口径 |
| gzip(level 9) | 61,466 | 60.0 | 压缩后 payload |
| base64(gzip) | 81,956 | 80.0 | 信封 payload 字符串本体 |
| 压缩率 | 2.40% | — | gzip/未压缩 |
| base64 膨胀 | 133.34% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 2,557,490 vs 去空白 2,557,490）
- 三分解闭合：Σ叶子 1,285,382 + 分隔符 1,105,702 + 键名(不含冒号) 166,406 = 2,557,490；去空白原文 2,557,490 → **闭合**；叶子 956,798 个，对象 1,436 个 / 数组 67,412 个 / 键 11,209 个，空白缩进 16,031,093 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 2,872、`[]` 134,824、`,` 956,797、`:` 11,209（合计 1,105,702）
- 键名审计：键名总量（含冒号）177,615；扫描器逐条定位到的键 token 154,971（8,992 个），未定位差额 22,644 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, generatedBy, machine, factsSource, channels, totalTierDomain, tierSample, tierSamplePolicy, runstates, gridConvention, variantCount, variants, variantSignatures, stateKeyVerification, machineAssertions, replaceValueChecks, notes]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 1,285,382 | 50.26% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.variants[].grid.cellGrid[][][] | 1,131,600 | 44.25% | — | — |
| other:$.variants[].warnings[] | 29,200 | 1.14% | — | — |
| other:$.variants[].runState.mechanism | 14,000 | 0.55% | — | — |
| other:$.variants[].layoutSignature | 13,200 | 0.52% | — | — |
| other:$.variants[].build.shapeKey | 13,200 | 0.52% | — | — |
| other:$.variants[].build.captureMode | 10,648 | 0.42% | — | — |
| other:$.variants[].key | 9,400 | 0.37% | — | — |
| other:$.variants[].geometrySignature | 9,200 | 0.36% | — | — |
| other:$.variants[].build.hatchPlan | 2,800 | 0.11% | — | — |
| other:$.variants[].paletteRefs[] | 2,400 | 0.09% | — | — |
| other:$.variants[].runstate | 1,400 | 0.05% | — | — |
| other:$.variants[].grid.size[] | 1,200 | 0.05% | — | — |
| other:$.variants[].grid.origin[] | 1,000 | 0.04% | — | — |
| other:$.variants[].build.machineFormed | 1,000 | 0.04% | — | — |
| other:$.variants[].build.controllerInstanceReused | 1,000 | 0.04% | — | — |
| other:$.variants[].runState.escapeHatchUsed | 1,000 | 0.04% | — | — |
| other:$.variants[].runState.requestedActive | 900 | 0.04% | — | — |
| other:$.variants[].runState.activeObserved | 900 | 0.04% | — | — |
| other:$.variants[].build.controllerPlaced | 800 | 0.03% | — | — |
| other:$.variants[].build.structureBuilt | 800 | 0.03% | — | — |
| other:$.variants[].build.quadCount | 800 | 0.03% | — | — |
| other:$.variants[].build.machineFormedKnown | 800 | 0.03% | — | — |
| other:$.variants[].build.isMultiBlockBase | 800 | 0.03% | — | — |
| other:$.variants[].build.selfDisabled | 800 | 0.03% | — | — |
| other:$.variants[].runState.assertionPassed | 800 | 0.03% | — | — |
| other:$.variants[].runState.serverBranchExecuted | 800 | 0.03% | — | — |
| other:$.variants[].assertions.buildOk | 800 | 0.03% | — | — |
| other:$.variants[].assertions.stateAssertionOk | 800 | 0.03% | — | — |
| other:$.variants[].assertions.geometryCoverageOk | 800 | 0.03% | — | — |
| other:$.variants[].assertions.instanceFresh | 800 | 0.03% | — | — |
| other:$.variants[].build.blocksAfterConstruct | 600 | 0.02% | — | — |
| other:$.variants[].build.regularBlocks | 600 | 0.02% | — | — |
| other:$.variants[].build.positionsShared | 600 | 0.02% | — | — |
| other:$.variants[].build.hatchCandidateTries | 600 | 0.02% | — | — |
| other:$.channels[].notes[] | 506 | 0.02% | — | — |
| other:$.variants[].index | 490 | 0.02% | — | — |
| other:$.machineAssertions[].detail | 449 | 0.02% | — | — |
| other:$.variants[].runState.maxProgressTime | 400 | 0.02% | — | — |
| other:$.variants[].runState.errorDisplayId | 400 | 0.02% | — | — |
| other:$.variants[].runState.stateMachineTicks | 400 | 0.02% | — | — |
| other:$.variants[].build.controllerInstanceOrdinal | 384 | 0.02% | — | — |
| other:$.stateKeyVerification.rule | 379 | 0.01% | — | — |
| other:$.replaceValueChecks[].detail | 270 | 0.01% | — | — |
| other:$.variants[].build.positionsCaptured | 207 | 0.01% | — | — |
| other:$.variants[].values.manipulator | 200 | 0.01% | — | — |
| other:$.variants[].values.shielding | 200 | 0.01% | — | — |
| other:$.variants[].totalTier | 200 | 0.01% | — | — |
| other:$.variants[].effective.manipulator | 200 | 0.01% | — | — |
| other:$.variants[].effective.shielding | 200 | 0.01% | — | — |
| other:$.variants[].runState.progressTime | 200 | 0.01% | — | — |
| other:$.machineAssertions[].id | 135 | 0.01% | — | — |
| other:$.channels[].expectedStates[].blocksKey | 129 | 0.01% | — | — |
| other:$.machine.role | 124 | 0.00% | — | — |
| other:$.gridConvention.variantKey | 122 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:1|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:1|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:2|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:2|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:3|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:3|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:0|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:1|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:2|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:3|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:0|shielding:4|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:0|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:1|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:2|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:3|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:1|shielding:4|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:0|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:1|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:2|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:3|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:2|shielding:4|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:0|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:1|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:2|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:3|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:3|shielding:4|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:0|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:1|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:2|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:3|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:4|runstate:idle | 111 | 0.00% | — | — |
| other:$.variantSignatures.manipulator:4|shielding:4|tt:4|runstate:active | 111 | 0.00% | — | — |
| other:$.replaceValueChecks[].id | 108 | 0.00% | — | — |
| other:$.gridConvention.cellGrid | 107 | 0.00% | — | — |
| other:$.channels[].valueSemantics | 104 | 0.00% | — | — |
| other:$.machine.fqcn | 99 | 0.00% | — | — |
| other:$.gridConvention.origin | 98 | 0.00% | — | — |
| other:$.factsSource | 91 | 0.00% | — | — |
| other:$.generatedBy | 85 | 0.00% | — | — |
| other:$.replaceValueChecks[].channel | 72 | 0.00% | — | — |
| other:$.gridConvention.value | 68 | 0.00% | — | — |
| other:$.replaceValueChecks[].expectedBlocksKey | 64 | 0.00% | — | — |
| other:$.channels[].expectedStates[].expectedItemId | 48 | 0.00% | — | — |
| other:$.channels[].expectedStates[].expectedResolvable | 48 | 0.00% | — | — |
| other:$.schema | 40 | 0.00% | — | — |
| other:$.machineAssertions[].status | 39 | 0.00% | — | — |
| other:$.replaceValueChecks[].status | 36 | 0.00% | — | — |
| other:$.channels[].enum | 32 | 0.00% | — | — |
| other:$.channels[].name | 32 | 0.00% | — | — |
| other:$.machine.simpleName | 28 | 0.00% | — | — |
| other:$.channels[].discoverySource | 28 | 0.00% | — | — |
| other:$.machine.displayName | 27 | 0.00% | — | — |
| other:$.channels[].id | 24 | 0.00% | — | — |
| other:$.channels[].key | 24 | 0.00% | — | — |
| other:$.tierSamplePolicy | 23 | 0.00% | — | — |
| other:$.channels[].expectedStates[].expectedMeta | 21 | 0.00% | — | — |
| other:$.channels[].kind | 18 | 0.00% | — | — |
| other:$.replaceValueChecks[].diffPositions | 18 | 0.00% | — | — |
| other:$.replaceValueChecks[].matched | 18 | 0.00% | — | — |
| other:$.channels[].domainSource | 16 | 0.00% | — | — |
| other:$.runstates[].name | 15 | 0.00% | — | — |
| other:$.channels[].registryAgreement | 14 | 0.00% | — | — |
| other:$.runstates[].id | 14 | 0.00% | — | — |
| other:$.channels[].expectedStates[].value | 12 | 0.00% | — | — |
| other:$.runstates[].materialSwap | 9 | 0.00% | — | — |
| other:$.totalTierDomain.source | 8 | 0.00% | — | — |
| other:$.replaceValueChecks[].mismatched | 6 | 0.00% | — | — |
| other:$.machine.mteId | 5 | 0.00% | — | — |
| other:$.machine.allowEscapeHatch | 4 | 0.00% | — | — |
| other:$.tierSample[] | 4 | 0.00% | — | — |
| other:$.variantCount | 3 | 0.00% | — | — |
| other:$.stateKeyVerification.anchoredCaptureVariants | 3 | 0.00% | — | — |
| other:$.channels[].domain.min | 2 | 0.00% | — | — |
| other:$.channels[].domain.max | 2 | 0.00% | — | — |
| other:$.channels[].max | 2 | 0.00% | — | — |
| other:$.channels[].observedMax | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.verifiedStateKeys | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.keysNewlyVerified | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.fullVerifyUpTo | 2 | 0.00% | — | — |
| other:$.stateKeyVerification.verifiedKeysSample | 2 | 0.00% | — | — |
| other:$.totalTierDomain.min | 1 | 0.00% | — | — |
| other:$.totalTierDomain.max | 1 | 0.00% | — | — |
| other:$.totalTierDomain.default | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.unstableStateKeys | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.fullCaptureVariants | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.sampledCaptureVariants | 1 | 0.00% | — | — |
| other:$.stateKeyVerification.verifyPositionsPerKey | 1 | 0.00% | — | — |
| other:$.machineAssertions[].checkedGroups | 1 | 0.00% | — | — |
| other:$.machineAssertions[].failedGroups | 1 | 0.00% | — | — |
| other:$.machineAssertions[].missingGroups | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 1,105,702 | 43.23% | | |
| （键名 `"key":`，共 11,209 个键） | 177,615 | 6.94% | | |
| **Σ 未压缩 JSON** | **2,557,490** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| variants | 2,497,410 | 97.65% | 1,400 | 67,401 | 10,800 | 956,399 | 10,800 | 1,104,801 | 44.2% |
| variantSignatures | 32,001 | 1.25% | 1 | 0 | 200 | 199 | 200 | 401 | 1.3% |
| channels | 2,085 | 0.08% | 16 | 5 | 92 | 87 | 92 | 221 | 10.6% |
| replaceValueChecks | 1,073 | 0.04% | 6 | 1 | 48 | 47 | 48 | 109 | 10.2% |
| machineAssertions | 601 | 0.02% | 6 | 1 | 21 | 20 | 21 | 55 | 9.2% |
| stateKeyVerification | 429 | 0.02% | 1 | 1 | 11 | 10 | 11 | 25 | 5.8% |
| machine | 297 | 0.01% | 1 | 0 | 6 | 5 | 6 | 13 | 4.4% |
| gridConvention | 292 | 0.01% | 1 | 0 | 4 | 3 | 4 | 9 | 3.1% |
| runstates | 103 | 0.00% | 2 | 1 | 6 | 5 | 6 | 17 | 16.5% |
| factsSource | 91 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| generatedBy | 49 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| totalTierDomain | 47 | 0.00% | 1 | 0 | 4 | 3 | 4 | 9 | 19.1% |
| schema | 40 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSamplePolicy | 23 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tierSample | 9 | 0.00% | 0 | 1 | 0 | 3 | 0 | 5 | 55.6% |
| variantCount | 3 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| notes | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| **Σ 子树** | **2,534,555** | — | | | | | | | |（与未压缩 2,557,490 的差 = 顶层键名与顶层分隔符 22,935） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| variants | 55,526 |
| variantSignatures | 2,748 |
| channels | 673 |
| machineAssertions | 538 |
| stateKeyVerification | 460 |
| gridConvention | 418 |
| machine | 286 |
| replaceValueChecks | 253 |
| generatedBy | 96 |
| factsSource | 93 |
| runstates | 81 |
| totalTierDomain | 59 |
| schema | 49 |
| tierSamplePolicy | 42 |
| tierSample | 22 |
| variantCount | 18 |
| notes | 10 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.variants[].grid.cellGrid[][][]` | 945000 | 1,131,600 | other:$.variants[].grid.cellGrid[][][] |
| `$.variants[].warnings[]` | 400 | 29,200 | other:$.variants[].warnings[] |
| `$.variants[].runState.mechanism` | 200 | 14,000 | other:$.variants[].runState.mechanism |
| `$.variants[].layoutSignature` | 200 | 13,200 | other:$.variants[].layoutSignature |
| `$.variants[].build.shapeKey` | 200 | 13,200 | other:$.variants[].build.shapeKey |
| `$.variants[].build.captureMode` | 200 | 10,648 | other:$.variants[].build.captureMode |
| `$.variants[].key` | 200 | 9,400 | other:$.variants[].key |
| `$.variants[].geometrySignature` | 200 | 9,200 | other:$.variants[].geometrySignature |
| `$.variants[].build.hatchPlan` | 200 | 2,800 | other:$.variants[].build.hatchPlan |
| `$.variants[].paletteRefs[]` | 1200 | 2,400 | other:$.variants[].paletteRefs[] |
| `$.variants[].runstate` | 200 | 1,400 | other:$.variants[].runstate |
| `$.variants[].grid.size[]` | 600 | 1,200 | other:$.variants[].grid.size[] |
| `$.variants[].grid.origin[]` | 600 | 1,000 | other:$.variants[].grid.origin[] |
| `$.variants[].build.machineFormed` | 200 | 1,000 | other:$.variants[].build.machineFormed |
| `$.variants[].build.controllerInstanceReused` | 200 | 1,000 | other:$.variants[].build.controllerInstanceReused |
| `$.variants[].runState.escapeHatchUsed` | 200 | 1,000 | other:$.variants[].runState.escapeHatchUsed |
| `$.variants[].runState.requestedActive` | 200 | 900 | other:$.variants[].runState.requestedActive |
| `$.variants[].runState.activeObserved` | 200 | 900 | other:$.variants[].runState.activeObserved |
| `$.variants[].build.controllerPlaced` | 200 | 800 | other:$.variants[].build.controllerPlaced |
| `$.variants[].build.structureBuilt` | 200 | 800 | other:$.variants[].build.structureBuilt |
| `$.variants[].build.quadCount` | 200 | 800 | other:$.variants[].build.quadCount |
| `$.variants[].build.machineFormedKnown` | 200 | 800 | other:$.variants[].build.machineFormedKnown |
| `$.variants[].build.isMultiBlockBase` | 200 | 800 | other:$.variants[].build.isMultiBlockBase |
| `$.variants[].build.selfDisabled` | 200 | 800 | other:$.variants[].build.selfDisabled |
| `$.variants[].runState.assertionPassed` | 200 | 800 | other:$.variants[].runState.assertionPassed |
| `$.variants[].runState.serverBranchExecuted` | 200 | 800 | other:$.variants[].runState.serverBranchExecuted |
| `$.variants[].assertions.buildOk` | 200 | 800 | other:$.variants[].assertions.buildOk |
| `$.variants[].assertions.stateAssertionOk` | 200 | 800 | other:$.variants[].assertions.stateAssertionOk |
| `$.variants[].assertions.geometryCoverageOk` | 200 | 800 | other:$.variants[].assertions.geometryCoverageOk |
| `$.variants[].assertions.instanceFresh` | 200 | 800 | other:$.variants[].assertions.instanceFresh |
| `$.variants[].build.blocksAfterConstruct` | 200 | 600 | other:$.variants[].build.blocksAfterConstruct |
| `$.variants[].build.regularBlocks` | 200 | 600 | other:$.variants[].build.regularBlocks |
| `$.variants[].build.positionsShared` | 200 | 600 | other:$.variants[].build.positionsShared |
| `$.variants[].build.hatchCandidateTries` | 200 | 600 | other:$.variants[].build.hatchCandidateTries |
| `$.channels[].notes[]` | 2 | 506 | other:$.channels[].notes[] |
| `$.variants[].index` | 200 | 490 | other:$.variants[].index |
| `$.machineAssertions[].detail` | 6 | 449 | other:$.machineAssertions[].detail |
| `$.variants[].runState.maxProgressTime` | 200 | 400 | other:$.variants[].runState.maxProgressTime |
| `$.variants[].runState.errorDisplayId` | 200 | 400 | other:$.variants[].runState.errorDisplayId |
| `$.variants[].runState.stateMachineTicks` | 200 | 400 | other:$.variants[].runState.stateMachineTicks |
| `$.variants[].build.controllerInstanceOrdinal` | 200 | 384 | other:$.variants[].build.controllerInstanceOrdinal |
| `$.stateKeyVerification.rule` | 1 | 379 | other:$.stateKeyVerification.rule |
| `$.replaceValueChecks[].detail` | 6 | 270 | other:$.replaceValueChecks[].detail |
| `$.variants[].build.positionsCaptured` | 200 | 207 | other:$.variants[].build.positionsCaptured |
| `$.variants[].values.manipulator` | 200 | 200 | other:$.variants[].values.manipulator |
| `$.variants[].values.shielding` | 200 | 200 | other:$.variants[].values.shielding |
| `$.variants[].totalTier` | 200 | 200 | other:$.variants[].totalTier |
| `$.variants[].effective.manipulator` | 200 | 200 | other:$.variants[].effective.manipulator |
| `$.variants[].effective.shielding` | 200 | 200 | other:$.variants[].effective.shielding |
| `$.variants[].runState.progressTime` | 200 | 200 | other:$.variants[].runState.progressTime |
| `$.machineAssertions[].id` | 6 | 135 | other:$.machineAssertions[].id |
| `$.channels[].expectedStates[].blocksKey` | 12 | 129 | other:$.channels[].expectedStates[].blocksKey |
| `$.machine.role` | 1 | 124 | other:$.machine.role |
| `$.gridConvention.variantKey` | 1 | 122 | other:$.gridConvention.variantKey |
| `$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:idle |
| `$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:0|tt:1|runstate:active |
| `$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:idle |
| `$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:1|tt:1|runstate:active |
| `$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:idle` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:idle |
| `$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:active` | 1 | 111 | other:$.variantSignatures.manipulator:0|shielding:2|tt:1|runstate:active |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `manipulator` | 400 | 5,600 | 14.00 |
| `controllerInstanceOrdinal` | 200 | 5,600 | 28.00 |
| `controllerInstanceReused` | 200 | 5,400 | 27.00 |
| `shielding` | 400 | 4,800 | 12.00 |
| `blocksAfterConstruct` | 200 | 4,600 | 23.00 |
| `serverBranchExecuted` | 200 | 4,600 | 23.00 |
| `hatchCandidateTries` | 200 | 4,400 | 22.00 |
| `machineFormedKnown` | 200 | 4,200 | 21.00 |
| `geometryCoverageOk` | 200 | 4,200 | 21.00 |
| `geometrySignature` | 200 | 4,000 | 20.00 |
| `positionsCaptured` | 200 | 4,000 | 20.00 |
| `stateMachineTicks` | 200 | 4,000 | 20.00 |
| `controllerPlaced` | 200 | 3,800 | 19.00 |
| `isMultiBlockBase` | 200 | 3,800 | 19.00 |
| `stateAssertionOk` | 200 | 3,800 | 19.00 |
| `layoutSignature` | 200 | 3,600 | 18.00 |
| `positionsShared` | 200 | 3,600 | 18.00 |
| `hatchPlacements` | 200 | 3,600 | 18.00 |
| `structureErrors` | 200 | 3,600 | 18.00 |
| `requestedActive` | 200 | 3,600 | 18.00 |
| `assertionPassed` | 200 | 3,600 | 18.00 |
| `maxProgressTime` | 200 | 3,600 | 18.00 |
| `escapeHatchUsed` | 200 | 3,600 | 18.00 |
| `structureBuilt` | 200 | 3,400 | 17.00 |
| `activeObserved` | 200 | 3,400 | 17.00 |
| `errorDisplayId` | 200 | 3,400 | 17.00 |
| `regularBlocks` | 200 | 3,200 | 16.00 |
| `machineFormed` | 200 | 3,200 | 16.00 |
| `instanceFresh` | 200 | 3,200 | 16.00 |
| `selfDisabled` | 200 | 3,000 | 15.00 |
| `progressTime` | 200 | 3,000 | 15.00 |
| `captureMode` | 200 | 2,800 | 14.00 |
| `totalTier` | 200 | 2,400 | 12.00 |
| `quadCount` | 200 | 2,400 | 12.00 |
| `hatchPlan` | 200 | 2,400 | 12.00 |
| `mechanism` | 200 | 2,400 | 12.00 |
| `runstate` | 200 | 2,200 | 11.00 |
| `shapeKey` | 200 | 2,200 | 11.00 |
| `buildOk` | 200 | 2,000 | 10.00 |
| `index` | 200 | 1,600 | 8.00 |
| `key` | 202 | 1,212 | 6.00 |
| `expectedResolvable` | 12 | 252 | 21.00 |
| `expectedItemId` | 12 | 204 | 17.00 |
| `expectedMeta` | 12 | 180 | 15.00 |
| `blocksKey` | 12 | 144 | 12.00 |
| `expectedBlocksKey` | 6 | 120 | 20.00 |
| `status` | 12 | 108 | 9.00 |
| `detail` | 12 | 108 | 9.00 |
| `value` | 13 | 104 | 8.00 |
| `diffPositions` | 6 | 96 | 16.00 |
| `id` | 16 | 80 | 5.00 |
| `mismatched` | 6 | 78 | 13.00 |
| `channel` | 6 | 60 | 10.00 |
| `matched` | 6 | 60 | 10.00 |
| `manipulator:0|shielding:0|tt:1|runstate:active` | 1 | 49 | 49.00 |
| `manipulator:0|shielding:1|tt:1|runstate:active` | 1 | 49 | 49.00 |
| `manipulator:0|shielding:2|tt:1|runstate:active` | 1 | 49 | 49.00 |
| `manipulator:0|shielding:3|tt:1|runstate:active` | 1 | 49 | 49.00 |
| `manipulator:0|shielding:4|tt:1|runstate:active` | 1 | 49 | 49.00 |
| `manipulator:1|shielding:0|tt:1|runstate:active` | 1 | 49 | 49.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/manifest.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 593 | 0.6 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 512 | 0.5 | 分桶统计口径 |
| gzip(level 9) | 324 | 0.3 | 压缩后 payload |
| base64(gzip) | 432 | 0.4 | 信封 payload 字符串本体 |
| 压缩率 | 63.28% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 512 vs 去空白 512）
- 三分解闭合：Σ叶子 288 + 分隔符 34 + 键名(不含冒号) 190 = 512；去空白原文 512 → **闭合**；叶子 14 个，对象 2 个 / 数组 1 个 / 键 15 个，空白缩进 81 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4、`[]` 2、`,` 13、`:` 15（合计 34）
- 键名审计：键名总量（含冒号）205；扫描器逐条定位到的键 token 196（14 个），未定位差额 9 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, runIndex, runDir, startedAtEpochMs, api, config, factsFile]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 288 | 56.25% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.factsFile | 91 | 17.77% | — | — |
| other:$.runDir | 76 | 14.84% | — | — |
| other:$.schema | 40 | 7.81% | — | — |
| other:$.api | 37 | 7.23% | — | — |
| other:$.startedAtEpochMs | 13 | 2.54% | — | — |
| other:$.config.globalBudgetMs | 7 | 1.37% | — | — |
| other:$.config.exit | 4 | 0.78% | — | — |
| other:$.config.cleanupTrigger | 4 | 0.78% | — | — |
| other:$.config.maxVariantsPerMachine | 4 | 0.78% | — | — |
| other:$.config.includeThumbnails | 4 | 0.78% | — | — |
| other:$.config.embedTextures | 4 | 0.78% | — | — |
| other:$.runIndex | 2 | 0.39% | — | — |
| other:$.config.limitPerMachine | 2 | 0.39% | — | — |
| （分隔符 `{}[],:`，非键名） | 34 | 6.64% | | |
| （键名 `"key":`，共 15 个键） | 205 | 40.04% | | |
| **Σ 未压缩 JSON** | **512** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| config | 170 | 33.20% | 1 | 1 | 8 | 7 | 8 | 19 | 11.2% |
| factsFile | 91 | 17.77% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| runDir | 76 | 14.84% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| schema | 40 | 7.81% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| api | 37 | 7.23% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| startedAtEpochMs | 13 | 2.54% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| runIndex | 2 | 0.39% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| **Σ 子树** | **429** | — | | | | | | | |（与未压缩 512 的差 = 顶层键名与顶层分隔符 83） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| config | 128 |
| factsFile | 92 |
| runDir | 78 |
| schema | 49 |
| api | 43 |
| startedAtEpochMs | 32 |
| runIndex | 13 |

**最大字段族（Top 13，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.factsFile` | 1 | 91 | other:$.factsFile |
| `$.runDir` | 1 | 76 | other:$.runDir |
| `$.schema` | 1 | 40 | other:$.schema |
| `$.api` | 1 | 37 | other:$.api |
| `$.startedAtEpochMs` | 1 | 13 | other:$.startedAtEpochMs |
| `$.config.globalBudgetMs` | 1 | 7 | other:$.config.globalBudgetMs |
| `$.config.exit` | 1 | 4 | other:$.config.exit |
| `$.config.cleanupTrigger` | 1 | 4 | other:$.config.cleanupTrigger |
| `$.config.maxVariantsPerMachine` | 1 | 4 | other:$.config.maxVariantsPerMachine |
| `$.config.includeThumbnails` | 1 | 4 | other:$.config.includeThumbnails |
| `$.config.embedTextures` | 1 | 4 | other:$.config.embedTextures |
| `$.runIndex` | 1 | 2 | other:$.runIndex |
| `$.config.limitPerMachine` | 1 | 2 | other:$.config.limitPerMachine |

**按 JSON 键名聚合（Top 14，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `maxVariantsPerMachine` | 1 | 24 | 24.00 |
| `includeThumbnails` | 1 | 20 | 20.00 |
| `startedAtEpochMs` | 1 | 19 | 19.00 |
| `limitPerMachine` | 1 | 18 | 18.00 |
| `cleanupTrigger` | 1 | 17 | 17.00 |
| `globalBudgetMs` | 1 | 17 | 17.00 |
| `embedTextures` | 1 | 16 | 16.00 |
| `factsFile` | 1 | 12 | 12.00 |
| `runIndex` | 1 | 11 | 11.00 |
| `machines` | 1 | 11 | 11.00 |
| `schema` | 1 | 9 | 9.00 |
| `runDir` | 1 | 9 | 9.00 |
| `exit` | 1 | 7 | 7.00 |
| `api` | 1 | 6 | 6.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/palette.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 541,796 | 529.1 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 294,913 | 288.0 | 分桶统计口径 |
| gzip(level 9) | 102,872 | 100.5 | 压缩后 payload |
| base64(gzip) | 137,164 | 133.9 | 信封 payload 字符串本体 |
| 压缩率 | 34.88% | — | gzip/未压缩 |
| base64 膨胀 | 133.33% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **不一致**（重建 281,905 vs 去空白 294,913）
- 三分解闭合：Σ叶子 203,339 + 分隔符 26,758 + 键名(不含冒号) 64,816 = 294,913；去空白原文 294,913 → **闭合**；叶子 10,712 个，对象 2,015 个 / 数组 447 个 / 键 11,123 个，空白缩进 246,883 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 4,030、`[]` 894、`,` 10,711、`:` 11,123（合计 26,758）
- 键名审计：键名总量（含冒号）75,939；扫描器逐条定位到的键 token 70,916（10,661 个），未定位差额 5,023 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, encoding, semantics, stats, blockPalette, materialPalette, textureBlobs, tooltipPalette, paletteContentSha256]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 47，quad 338，材质 56，textureBlob 51，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette | 97,588 | 33.09% | — | 288.72 |
| texture | 59,382 | 20.14% | — | 175.69 |
| geometry | 41,461 | 14.06% | — | 122.67 |
| material | 4,487 | 1.52% | — | 13.28 |
| other | 279 | 0.09% | — | 0.83 |
| annotations | 142 | 0.05% | — | 0.42 |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| palette.meta | 97,588 | 33.09% | — | 288.72 |
| texture.blobs | 59,382 | 20.14% | — | 175.69 |
| palette.geometry | 41,461 | 14.06% | — | 122.67 |
| material.entries | 4,487 | 1.52% | — | 13.28 |
| other:$.semantics | 147 | 0.05% | — | 0.43 |
| stats | 142 | 0.05% | — | 0.42 |
| other:$.paletteContentSha256 | 66 | 0.02% | — | 0.20 |
| other:$.schema | 48 | 0.02% | — | 0.14 |
| other:$.encoding | 18 | 0.01% | — | 0.05 |
| （分隔符 `{}[],:`，非键名） | 26,758 | 9.07% | | |
| （键名 `"key":`，共 11,123 个键） | 75,939 | 25.75% | | |
| **Σ 未压缩 JSON** | **294,913** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blockPalette | 210,412 | 71.35% | 1,784 | 433 | 10,562 | 10,130 | 10,562 | 25,126 | 11.9% |
| textureBlobs | 59,434 | 20.15% | 0 | 1 | 0 | 50 | 0 | 52 | 0.1% |
| materialPalette | 11,232 | 3.81% | 229 | 11 | 539 | 511 | 539 | 1,530 | 13.6% |
| stats | 408 | 0.14% | 1 | 1 | 13 | 12 | 13 | 29 | 7.1% |
| paletteContentSha256 | 66 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| semantics | 55 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| schema | 48 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| encoding | 18 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| tooltipPalette | 2 | 0.00% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| **Σ 子树** | **281,675** | — | | | | | | | |（与未压缩 294,913 的差 = 顶层键名与顶层分隔符 13,238） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| blockPalette | 62,318 |
| textureBlobs | 38,538 |
| materialPalette | 1,105 |
| stats | 266 |
| semantics | 159 |
| paletteContentSha256 | 78 |
| schema | 57 |
| encoding | 29 |
| tooltipPalette | 19 |

**最大字段族（Top 41，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.blockPalette[].thumbnailPNG` | 46 | 95,388 | palette.meta |
| `$.textureBlobs[]` | 51 | 59,382 | texture.blobs |
| `$.blockPalette[].geometry.quads[].vertices[].brightness` | 1352 | 10,816 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].color` | 1352 | 8,776 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].x` | 1352 | 4,120 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].z` | 1352 | 4,120 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].y` | 1352 | 4,056 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].u` | 1352 | 4,056 | palette.geometry |
| `$.blockPalette[].geometry.quads[].vertices[].v` | 1352 | 4,056 | palette.geometry |
| `$.materialPalette[].locator` | 56 | 2,696 | material.entries |
| `$.blockPalette[].registryId` | 47 | 1,356 | palette.meta |
| `$.blockPalette[].geometry.encoding` | 47 | 846 | palette.geometry |
| `$.blockPalette[].geometry.quads[].materialIndex` | 338 | 615 | palette.geometry |
| `$.blockPalette[].renderMode` | 47 | 564 | palette.meta |
| `$.materialPalette[].kind` | 56 | 560 | material.entries |
| `$.materialPalette[].atlas` | 56 | 448 | material.entries |
| `$.materialPalette[].linear` | 56 | 224 | material.entries |
| `$.materialPalette[].useMipmaps` | 56 | 224 | material.entries |
| `$.blockPalette[].occludesAdjacentFaces` | 47 | 218 | palette.meta |
| `$.materialPalette[].animation.frameSequence[].index` | 156 | 210 | material.entries |
| `$.semantics` | 1 | 147 | other:$.semantics |
| `$.materialPalette[].textureBlobIndex` | 56 | 98 | material.entries |
| `$.stats.dedupKey` | 1 | 94 | stats |
| `$.paletteContentSha256` | 1 | 66 | other:$.paletteContentSha256 |
| `$.blockPalette[].meta` | 47 | 62 | palette.meta |
| `$.schema` | 1 | 48 | other:$.schema |
| `$.encoding` | 1 | 18 | other:$.encoding |
| `$.stats.geometryEncoding` | 1 | 18 | stats |
| `$.materialPalette[].animation.defaultFrametimeTicks` | 17 | 18 | material.entries |
| `$.stats.referenceEvents` | 1 | 6 | stats |
| `$.stats.dedupRatio` | 1 | 5 | stats |
| `$.materialPalette[].animation.frameSequence[].timeTicks` | 2 | 5 | material.entries |
| `$.stats.internCalls` | 1 | 4 | stats |
| `$.stats.duplicateCapturesSuppressed` | 1 | 4 | stats |
| `$.materialPalette[].animation.interpolate` | 1 | 4 | material.entries |
| `$.stats.paletteEntries` | 1 | 2 | stats |
| `$.stats.paletteEntriesExcludingAir` | 1 | 2 | stats |
| `$.stats.referencedEntries` | 1 | 2 | stats |
| `$.stats.materialEntries` | 1 | 2 | stats |
| `$.stats.textureBlobs` | 1 | 2 | stats |
| `$.stats.unreferencedEntries` | 1 | 1 | stats |

**按 JSON 键名聚合（Top 43，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `brightness` | 1,352 | 17,576 | 13.00 |
| `color` | 1,352 | 10,816 | 8.00 |
| `materialIndex` | 338 | 5,408 | 16.00 |
| `x` | 1,352 | 5,408 | 4.00 |
| `y` | 1,352 | 5,408 | 4.00 |
| `z` | 1,352 | 5,408 | 4.00 |
| `u` | 1,352 | 5,408 | 4.00 |
| `v` | 1,352 | 5,408 | 4.00 |
| `index` | 156 | 1,248 | 8.00 |
| `occludesAdjacentFaces` | 47 | 1,128 | 24.00 |
| `textureBlobIndex` | 56 | 1,064 | 19.00 |
| `useMipmaps` | 56 | 728 | 13.00 |
| `thumbnailPNG` | 46 | 690 | 15.00 |
| `registryId` | 47 | 611 | 13.00 |
| `renderMode` | 47 | 611 | 13.00 |
| `locator` | 56 | 560 | 10.00 |
| `encoding` | 48 | 528 | 11.00 |
| `linear` | 56 | 504 | 9.00 |
| `tooltip` | 47 | 470 | 10.00 |
| `atlas` | 56 | 448 | 8.00 |
| `defaultFrametimeTicks` | 17 | 408 | 24.00 |
| `kind` | 56 | 392 | 7.00 |
| `meta` | 47 | 329 | 7.00 |
| `duplicateCapturesSuppressed` | 1 | 30 | 30.00 |
| `paletteEntriesExcludingAir` | 1 | 29 | 29.00 |
| `unreferencedEntryList` | 1 | 24 | 24.00 |
| `timeTicks` | 2 | 24 | 12.00 |
| `paletteContentSha256` | 1 | 23 | 23.00 |
| `unreferencedEntries` | 1 | 22 | 22.00 |
| `referencedEntries` | 1 | 20 | 20.00 |
| `geometryEncoding` | 1 | 19 | 19.00 |
| `referenceEvents` | 1 | 18 | 18.00 |
| `materialEntries` | 1 | 18 | 18.00 |
| `paletteEntries` | 1 | 17 | 17.00 |
| `tooltipPalette` | 1 | 17 | 17.00 |
| `textureBlobs` | 1 | 15 | 15.00 |
| `internCalls` | 1 | 14 | 14.00 |
| `interpolate` | 1 | 14 | 14.00 |
| `dedupRatio` | 1 | 13 | 13.00 |
| `semantics` | 1 | 12 | 12.00 |
| `dedupKey` | 1 | 11 | 11.00 |
| `schema` | 1 | 9 | 9.00 |
| `quads` | 1 | 8 | 8.00 |


---

### mod/gtnh/run/client/variant_capture/run-0015/report.json

输入形态：**Plain(V2 JSON)**

| 形态 | 字节 | KiB | 说明 |
|---|---:|---:|---|
| 落盘（原始文本，含空白） | 29,082 | 28.4 | 文件真实大小 |
| 未压缩 JSON（去结构性空白） | 21,989 | 21.5 | 分桶统计口径 |
| gzip(level 9) | 5,884 | 5.7 | 压缩后 payload |
| base64(gzip) | 7,848 | 7.7 | 信封 payload 字符串本体 |
| 压缩率 | 26.76% | — | gzip/未压缩 |
| base64 膨胀 | 133.38% | — | base64/gzip |

- 重建一致性：`JSON.stringify(JSON.parse(text)) === 去空白原文` → **一致**（重建 21,989 vs 去空白 21,989）
- 三分解闭合：Σ叶子 12,868 + 分隔符 1,270 + 键名(不含冒号) 7,851 = 21,989；去空白原文 21,989 → **闭合**；叶子 526 个，对象 79 个 / 数组 28 个 / 键 531 个，空白缩进 7,093 字节
- 分隔符（字符扫描，已跳过字符串字面量）：`{}` 158、`[]` 56、`,` 525、`:` 531（合计 1,270）
- 键名审计：键名总量（含冒号）8,382；扫描器逐条定位到的键 token 7,760（492 个），未定位差额 622 字节（空对象/空数组的父键等），已计入键名总量
- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**全部一致**
- 形状：format=null / documentFormat=Plain(隐式) / 帧数=1 / 顶层键=[schema, task, runIndex, runDir, status, config, environment, dataset, totals, machines, paletteDedup, runStateFacts, signatureComparison, failures, notes]
  - 帧 0：cellGrid n/a，格 0（非空 0），palette 条目 0，quad 0，材质 0，textureBlob 0，cellTooltipGrid=false
- 注解 0 条 / 标签 0 条

**分桶（按 JSON 字段路径 → 桶）**

| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other | 12,868 | 58.52% | — | — |

| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |
|---|---:|---:|---:|---:|
| other:$.machines[].machineAssertions[].detail | 1,915 | 8.71% | — | — |
| other:$.machines[].stateKeyVerification.rule | 1,516 | 6.89% | — | — |
| other:$.runStateFacts[].examples[].sample | 1,220 | 5.55% | — | — |
| other:$.machines[].stateKeyVerification.verifiedKeysSample | 1,016 | 4.62% | — | — |
| other:$.machines[].machineAssertions[].perValue[].layoutSignature | 660 | 3.00% | — | — |
| other:$.machines[].machineAssertions[].id | 540 | 2.46% | — | — |
| other:$.runStateFacts[].examples[].activeKey | 454 | 2.06% | — | — |
| other:$.runStateFacts[].examples[].idleKey | 428 | 1.95% | — | — |
| other:$.machines[].role | 423 | 1.92% | — | — |
| other:$.machines[].machineAssertions[].perValue[].variantKey | 291 | 1.32% | — | — |
| other:$.signatureComparison.perMachine[].currentFileSha256 | 264 | 1.20% | — | — |
| other:$.signatureComparison.perMachine[].previousFileSha256 | 264 | 1.20% | — | — |
| other:$.environment.stateDriving | 226 | 1.03% | — | — |
| other:$.dataset.palette.json.blockPalette[] | 195 | 0.89% | — | — |
| other:$.machines[].machineAssertions[].status | 162 | 0.74% | — | — |
| other:$.machines[].machineFile | 155 | 0.70% | — | — |
| other:$.dataset.variants[].geometrySignature | 151 | 0.69% | — | — |
| other:$.dataset.variants[].key | 143 | 0.65% | — | — |
| other:$.dataset.variants[].layoutSignature | 130 | 0.59% | — | — |
| other:$.dataset.purpose | 123 | 0.56% | — | — |
| other:$.dataset.variants[].grid | 122 | 0.55% | — | — |
| other:$.dataset.variants[].effective | 113 | 0.51% | — | — |
| other:$.notes[] | 113 | 0.51% | — | — |
| other:$.dataset.machineAssertions[] | 100 | 0.45% | — | — |
| other:$.dataset.variants[].build | 99 | 0.45% | — | — |
| other:$.machines[].simpleName | 99 | 0.45% | — | — |
| other:$.runStateFacts[].simpleName | 99 | 0.45% | — | — |
| other:$.signatureComparison.perMachine[].simpleName | 99 | 0.45% | — | — |
| other:$.paletteDedup.dedupKey | 94 | 0.43% | — | — |
| other:$.dataset.variants[].paletteRefs | 93 | 0.42% | — | — |
| other:$.environment.factsFile | 91 | 0.41% | — | — |
| other:$.dataset.variants[].runState | 91 | 0.41% | — | — |
| other:$.dataset.variants[].values | 89 | 0.40% | — | — |
| other:$.environment.worldMode | 79 | 0.36% | — | — |
| other:$.runDir | 76 | 0.35% | — | — |
| other:$.dataset.palette.json.materialPalette[]/textureBlobs[] | 73 | 0.33% | — | — |
| other:$.signatureComparison.palette.currentSha256 | 66 | 0.30% | — | — |
| other:$.signatureComparison.palette.previousSha256 | 66 | 0.30% | — | — |
| other:$.runStateFacts[].examples[].layoutDiffers | 65 | 0.30% | — | — |
| other:$.machines[].machineAssertions[].perValue[].status | 60 | 0.27% | — | — |
| other:$.runStateFacts[].examples[].materialLayerOnly | 52 | 0.24% | — | — |
| other:$.schema | 40 | 0.18% | — | — |
| other:$.machines[].channelKeys[] | 38 | 0.17% | — | — |
| other:$.machines[].tierSample[] | 35 | 0.16% | — | — |
| other:$.task | 34 | 0.15% | — | — |
| other:$.machines[].tierSamplePolicy | 24 | 0.11% | — | — |
| other:$.dataset.perMachineFile | 22 | 0.10% | — | — |
| other:$.machines[].phaseTiming.captureMs | 19 | 0.09% | — | — |
| other:$.machines[].phaseTiming.totalMs | 19 | 0.09% | — | — |
| other:$.paletteDedup.geometryEncoding | 18 | 0.08% | — | — |
| other:$.runStateFacts[].materialSwapOnly | 16 | 0.07% | — | — |
| other:$.signatureComparison.perMachine[].allMatch | 16 | 0.07% | — | — |
| other:$.dataset.globalPaletteFile | 14 | 0.06% | — | — |
| other:$.machines[].phaseTiming.buildMs | 13 | 0.06% | — | — |
| other:$.machines[].machineAssertions[].perValue[].expectedSize | 13 | 0.06% | — | — |
| other:$.machines[].machineAssertions[].perValue[].observedSize | 13 | 0.06% | — | — |
| other:$.runStateFacts[].examples[].differingCells | 13 | 0.06% | — | — |
| other:$.runStateFacts[].examples[].sameStateDifferentGeometryCells | 13 | 0.06% | — | — |
| other:$.runStateFacts[].examples[].structuralCells | 13 | 0.06% | — | — |
| other:$.machines[].phaseTiming.perBuildMs | 12 | 0.05% | — | — |
| other:$.machines[].machineAssertions[].perValue[].value | 11 | 0.05% | — | — |
| other:$.machines[].variantCount | 10 | 0.05% | — | — |
| other:$.machines[].buildCount | 10 | 0.05% | — | — |
| other:$.machines[].captureCount | 10 | 0.05% | — | — |
| other:$.machines[].phaseTiming.builds | 10 | 0.05% | — | — |
| other:$.machines[].stateKeyVerification.anchoredCaptureVariants | 10 | 0.05% | — | — |
| other:$.runStateFacts[].variantsCompared | 10 | 0.05% | — | — |
| other:$.runStateFacts[].geometryDifferingPairs | 10 | 0.05% | — | — |
| other:$.runStateFacts[].cellGridDifferingPairs | 10 | 0.05% | — | — |
| other:$.runStateFacts[].materialLayerOnlyPairs | 10 | 0.05% | — | — |
| other:$.signatureComparison.perMachine[].variants | 10 | 0.05% | — | — |
| other:$.signatureComparison.perMachine[].previousVariants | 10 | 0.05% | — | — |
| other:$.runStateFacts[].activeMechanismHistogram.onPostTick 服务端分支：setActive(mMaxProgresstime > 0) | 9 | 0.04% | — | — |
| other:$.environment.minecraftVersion | 8 | 0.04% | — | — |
| other:$.environment.mod.gregtech | 8 | 0.04% | — | — |
| other:$.environment.mod.structurelib | 8 | 0.04% | — | — |
| other:$.machines[].stateKeyVerification.fullVerifyUpTo | 8 | 0.04% | — | — |
| other:$.machines[].machineAssertions[].channel | 8 | 0.04% | — | — |
| other:$.config.globalBudgetMs | 7 | 0.03% | — | — |
| other:$.totals.elapsedMs | 6 | 0.03% | — | — |
| other:$.machines[].paletteRefsUsed | 6 | 0.03% | — | — |
| other:$.machines[].phaseTiming.driveMs | 6 | 0.03% | — | — |
| other:$.machines[].stateKeyVerification.verifiedStateKeys | 6 | 0.03% | — | — |
| other:$.machines[].stateKeyVerification.keysNewlyVerified | 6 | 0.03% | — | — |
| other:$.paletteDedup.referenceEvents | 6 | 0.03% | — | — |
| other:$.environment.mod.lightning | 5 | 0.02% | — | — |
| other:$.machines[].stateKeyVerification.sampledCaptureVariants | 5 | 0.02% | — | — |
| other:$.machines[].machineAssertions[].checkedGroups | 5 | 0.02% | — | — |
| other:$.paletteDedup.dedupRatio | 5 | 0.02% | — | — |
| other:$.status | 4 | 0.02% | — | — |
| other:$.config.exit | 4 | 0.02% | — | — |
| other:$.config.cleanupTrigger | 4 | 0.02% | — | — |
| other:$.config.maxVariantsPerMachine | 4 | 0.02% | — | — |
| other:$.config.includeThumbnails | 4 | 0.02% | — | — |
| other:$.config.embedTextures | 4 | 0.02% | — | — |
| other:$.totals.duplicateCapturesSuppressed | 4 | 0.02% | — | — |
| other:$.totals.internCalls | 4 | 0.02% | — | — |
| other:$.machines[].channels | 4 | 0.02% | — | — |
| other:$.machines[].failureCount | 4 | 0.02% | — | — |
| other:$.machines[].stateKeyVerification.unstableStateKeys | 4 | 0.02% | — | — |
| other:$.machines[].stateKeyVerification.fullCaptureVariants | 4 | 0.02% | — | — |
| other:$.machines[].stateKeyVerification.verifyPositionsPerKey | 4 | 0.02% | — | — |
| other:$.paletteDedup.internCalls | 4 | 0.02% | — | — |
| other:$.paletteDedup.duplicateCapturesSuppressed | 4 | 0.02% | — | — |
| other:$.runStateFacts[].geometryIdenticalPairs | 4 | 0.02% | — | — |
| other:$.runStateFacts[].structuralDiffPairs | 4 | 0.02% | — | — |
| other:$.signatureComparison.palette.allMatch | 4 | 0.02% | — | — |
| other:$.signatureComparison.perMachine[].mismatched | 4 | 0.02% | — | — |
| other:$.signatureComparison.allMatch | 4 | 0.02% | — | — |
| other:$.totals.builds | 3 | 0.01% | — | — |
| other:$.totals.variants | 3 | 0.01% | — | — |
| other:$.totals.captures | 3 | 0.01% | — | — |
| other:$.totals.hatchPlanCacheHits | 3 | 0.01% | — | — |
| other:$.totals.anchoredCaptureVariants | 3 | 0.01% | — | — |
| other:$.machines[].machineAssertions[].failedGroups | 3 | 0.01% | — | — |
| other:$.machines[].machineAssertions[].missingGroups | 3 | 0.01% | — | — |
| other:$.signatureComparison.comparedVariants | 3 | 0.01% | — | — |
| other:$.runIndex | 2 | 0.01% | — | — |
| other:$.config.limitPerMachine | 2 | 0.01% | — | — |
| other:$.totals.paletteEntries | 2 | 0.01% | — | — |
| other:$.totals.hatchPlanCacheStores | 2 | 0.01% | — | — |
| other:$.machines[].machineAssertions[].sizeCeiling | 2 | 0.01% | — | — |
| other:$.paletteDedup.paletteEntries | 2 | 0.01% | — | — |
| other:$.paletteDedup.paletteEntriesExcludingAir | 2 | 0.01% | — | — |
| other:$.paletteDedup.referencedEntries | 2 | 0.01% | — | — |
| other:$.paletteDedup.materialEntries | 2 | 0.01% | — | — |
| other:$.paletteDedup.textureBlobs | 2 | 0.01% | — | — |
| other:$.signatureComparison.previousRunIndex | 2 | 0.01% | — | — |
| other:$.totals.machines | 1 | 0.00% | — | — |
| other:$.totals.failureCount | 1 | 0.00% | — | — |
| other:$.totals.fullCaptureVariants | 1 | 0.00% | — | — |
| other:$.totals.unstableStateKeys | 1 | 0.00% | — | — |
| other:$.paletteDedup.unreferencedEntries | 1 | 0.00% | — | — |
| other:$.runStateFacts[].activeMechanismHistogram.公开逃生门 IGregTechTileEntity#setActive(boolean)（IMachineProgress）：本机不是 MTEMultiBlockBase：公开面没有进度字段可写（不引入反射），无法用状态机派生 | 1 | 0.00% | — | — |
| other:$.signatureComparison.comparedMachines | 1 | 0.00% | — | — |
| other:$.signatureComparison.matchedMachines | 1 | 0.00% | — | — |
| other:$.signatureComparison.mismatchedVariants | 1 | 0.00% | — | — |
| （分隔符 `{}[],:`，非键名） | 1,270 | 5.78% | | |
| （键名 `"key":`，共 531 个键） | 8,382 | 38.12% | | |
| **Σ 未压缩 JSON** | **21,989** | **100.00%** | | |

**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**

| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| machines | 9,083 | 41.31% | 46 | 18 | 272 | 284 | 272 | 684 | 7.5% |
| runStateFacts | 5,399 | 24.55% | 21 | 5 | 148 | 139 | 148 | 339 | 6.3% |
| signatureComparison | 1,471 | 6.69% | 6 | 1 | 39 | 36 | 39 | 89 | 6.1% |
| dataset | 1,293 | 5.88% | 1 | 0 | 15 | 14 | 15 | 31 | 2.4% |
| environment | 441 | 2.01% | 1 | 0 | 7 | 6 | 7 | 15 | 3.4% |
| paletteDedup | 408 | 1.86% | 1 | 1 | 13 | 12 | 13 | 29 | 7.1% |
| totals | 294 | 1.34% | 1 | 0 | 14 | 13 | 14 | 29 | 9.9% |
| config | 170 | 0.77% | 1 | 1 | 8 | 7 | 8 | 19 | 11.2% |
| notes | 105 | 0.48% | 0 | 1 | 0 | 0 | 0 | 2 | 1.9% |
| runDir | 76 | 0.35% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| schema | 40 | 0.18% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| task | 18 | 0.08% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| status | 4 | 0.02% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| runIndex | 2 | 0.01% | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |
| failures | 2 | 0.01% | 0 | 1 | 0 | 0 | 0 | 2 | 100.0% |
| **Σ 子树** | **18,806** | — | | | | | | | |（与未压缩 21,989 的差 = 顶层键名与顶层分隔符 3,183） |

**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**

| 顶层键 | gzip 增量字节 |
|---|---:|
| machines | 2,832 |
| dataset | 1,287 |
| runStateFacts | 857 |
| signatureComparison | 499 |
| environment | 467 |
| paletteDedup | 269 |
| totals | 199 |
| config | 128 |
| notes | 121 |
| runDir | 78 |
| schema | 49 |
| task | 44 |
| runIndex | 13 |
| status | 13 |
| failures | 13 |

**最大字段族（Top 60，路径已按数组下标归一化）**

| 字段路径 | 出现次数 | 字节 | 桶 |
|---|---:|---:|---|
| `$.machines[].machineAssertions[].detail` | 24 | 1,915 | other:$.machines[].machineAssertions[].detail |
| `$.machines[].stateKeyVerification.rule` | 4 | 1,516 | other:$.machines[].stateKeyVerification.rule |
| `$.runStateFacts[].examples[].sample` | 13 | 1,220 | other:$.runStateFacts[].examples[].sample |
| `$.machines[].stateKeyVerification.verifiedKeysSample` | 4 | 1,016 | other:$.machines[].stateKeyVerification.verifiedKeysSample |
| `$.machines[].machineAssertions[].perValue[].layoutSignature` | 10 | 660 | other:$.machines[].machineAssertions[].perValue[].layoutSignature |
| `$.machines[].machineAssertions[].id` | 24 | 540 | other:$.machines[].machineAssertions[].id |
| `$.runStateFacts[].examples[].activeKey` | 13 | 454 | other:$.runStateFacts[].examples[].activeKey |
| `$.runStateFacts[].examples[].idleKey` | 13 | 428 | other:$.runStateFacts[].examples[].idleKey |
| `$.machines[].role` | 4 | 423 | other:$.machines[].role |
| `$.machines[].machineAssertions[].perValue[].variantKey` | 10 | 291 | other:$.machines[].machineAssertions[].perValue[].variantKey |
| `$.signatureComparison.perMachine[].currentFileSha256` | 4 | 264 | other:$.signatureComparison.perMachine[].currentFileSha256 |
| `$.signatureComparison.perMachine[].previousFileSha256` | 4 | 264 | other:$.signatureComparison.perMachine[].previousFileSha256 |
| `$.environment.stateDriving` | 1 | 226 | other:$.environment.stateDriving |
| `$.dataset.palette.json.blockPalette[]` | 1 | 195 | other:$.dataset.palette.json.blockPalette[] |
| `$.machines[].machineAssertions[].status` | 24 | 162 | other:$.machines[].machineAssertions[].status |
| `$.machines[].machineFile` | 4 | 155 | other:$.machines[].machineFile |
| `$.dataset.variants[].geometrySignature` | 1 | 151 | other:$.dataset.variants[].geometrySignature |
| `$.dataset.variants[].key` | 1 | 143 | other:$.dataset.variants[].key |
| `$.dataset.variants[].layoutSignature` | 1 | 130 | other:$.dataset.variants[].layoutSignature |
| `$.dataset.purpose` | 1 | 123 | other:$.dataset.purpose |
| `$.dataset.variants[].grid` | 1 | 122 | other:$.dataset.variants[].grid |
| `$.dataset.variants[].effective` | 1 | 113 | other:$.dataset.variants[].effective |
| `$.notes[]` | 1 | 113 | other:$.notes[] |
| `$.dataset.machineAssertions[]` | 1 | 100 | other:$.dataset.machineAssertions[] |
| `$.dataset.variants[].build` | 1 | 99 | other:$.dataset.variants[].build |
| `$.machines[].simpleName` | 4 | 99 | other:$.machines[].simpleName |
| `$.runStateFacts[].simpleName` | 4 | 99 | other:$.runStateFacts[].simpleName |
| `$.signatureComparison.perMachine[].simpleName` | 4 | 99 | other:$.signatureComparison.perMachine[].simpleName |
| `$.paletteDedup.dedupKey` | 1 | 94 | other:$.paletteDedup.dedupKey |
| `$.dataset.variants[].paletteRefs` | 1 | 93 | other:$.dataset.variants[].paletteRefs |
| `$.environment.factsFile` | 1 | 91 | other:$.environment.factsFile |
| `$.dataset.variants[].runState` | 1 | 91 | other:$.dataset.variants[].runState |
| `$.dataset.variants[].values` | 1 | 89 | other:$.dataset.variants[].values |
| `$.environment.worldMode` | 1 | 79 | other:$.environment.worldMode |
| `$.runDir` | 1 | 76 | other:$.runDir |
| `$.dataset.palette.json.materialPalette[]/textureBlobs[]` | 1 | 73 | other:$.dataset.palette.json.materialPalette[]/textureBlobs[] |
| `$.signatureComparison.palette.currentSha256` | 1 | 66 | other:$.signatureComparison.palette.currentSha256 |
| `$.signatureComparison.palette.previousSha256` | 1 | 66 | other:$.signatureComparison.palette.previousSha256 |
| `$.runStateFacts[].examples[].layoutDiffers` | 13 | 65 | other:$.runStateFacts[].examples[].layoutDiffers |
| `$.machines[].machineAssertions[].perValue[].status` | 10 | 60 | other:$.machines[].machineAssertions[].perValue[].status |
| `$.runStateFacts[].examples[].materialLayerOnly` | 13 | 52 | other:$.runStateFacts[].examples[].materialLayerOnly |
| `$.schema` | 1 | 40 | other:$.schema |
| `$.machines[].channelKeys[]` | 4 | 38 | other:$.machines[].channelKeys[] |
| `$.machines[].tierSample[]` | 29 | 35 | other:$.machines[].tierSample[] |
| `$.task` | 1 | 34 | other:$.task |
| `$.machines[].tierSamplePolicy` | 4 | 24 | other:$.machines[].tierSamplePolicy |
| `$.dataset.perMachineFile` | 1 | 22 | other:$.dataset.perMachineFile |
| `$.machines[].phaseTiming.captureMs` | 4 | 19 | other:$.machines[].phaseTiming.captureMs |
| `$.machines[].phaseTiming.totalMs` | 4 | 19 | other:$.machines[].phaseTiming.totalMs |
| `$.paletteDedup.geometryEncoding` | 1 | 18 | other:$.paletteDedup.geometryEncoding |
| `$.runStateFacts[].materialSwapOnly` | 4 | 16 | other:$.runStateFacts[].materialSwapOnly |
| `$.signatureComparison.perMachine[].allMatch` | 4 | 16 | other:$.signatureComparison.perMachine[].allMatch |
| `$.dataset.globalPaletteFile` | 1 | 14 | other:$.dataset.globalPaletteFile |
| `$.machines[].phaseTiming.buildMs` | 4 | 13 | other:$.machines[].phaseTiming.buildMs |
| `$.machines[].machineAssertions[].perValue[].expectedSize` | 10 | 13 | other:$.machines[].machineAssertions[].perValue[].expectedSize |
| `$.machines[].machineAssertions[].perValue[].observedSize` | 10 | 13 | other:$.machines[].machineAssertions[].perValue[].observedSize |
| `$.runStateFacts[].examples[].differingCells` | 13 | 13 | other:$.runStateFacts[].examples[].differingCells |
| `$.runStateFacts[].examples[].sameStateDifferentGeometryCells` | 13 | 13 | other:$.runStateFacts[].examples[].sameStateDifferentGeometryCells |
| `$.runStateFacts[].examples[].structuralCells` | 13 | 13 | other:$.runStateFacts[].examples[].structuralCells |
| `$.machines[].phaseTiming.perBuildMs` | 4 | 12 | other:$.machines[].phaseTiming.perBuildMs |

**按 JSON 键名聚合（Top 60，与所在位置无关）**

| 键名 | 出现次数 | 字节 | 平均字节 |
|---|---:|---:|---:|
| `sameStateDifferentGeometryCells` | 13 | 442 | 34.00 |
| `status` | 35 | 315 | 9.00 |
| `materialLayerOnly` | 13 | 260 | 20.00 |
| `structuralCells` | 13 | 234 | 18.00 |
| `differingCells` | 13 | 221 | 17.00 |
| `detail` | 24 | 216 | 9.00 |
| `layoutDiffers` | 13 | 208 | 16.00 |
| `公开逃生门 IGregTechTileEntity#setActive(boolean)（IMachineProgress）：本机不是 MTEMultiBlockBase：公开面没有进度字段可写（不引入反射），无法用状态机派生` | 1 | 196 | 196.00 |
| `onPostTick 服务端分支：setActive(mMaxProgresstime > 0)` | 3 | 189 | 63.00 |
| `layoutSignature` | 10 | 180 | 18.00 |
| `simpleName` | 12 | 156 | 13.00 |
| `activeKey` | 13 | 156 | 12.00 |
| `expectedSize` | 10 | 150 | 15.00 |
| `observedSize` | 10 | 150 | 15.00 |
| `anchoredCaptureVariants` | 5 | 130 | 26.00 |
| `variantKey` | 10 | 130 | 13.00 |
| `idleKey` | 13 | 130 | 10.00 |
| `id` | 24 | 120 | 5.00 |
| `sample` | 13 | 117 | 9.00 |
| `fullCaptureVariants` | 5 | 110 | 22.00 |
| `unstableStateKeys` | 5 | 100 | 20.00 |
| `sampledCaptureVariants` | 4 | 100 | 25.00 |
| `geometryIdenticalPairs` | 4 | 100 | 25.00 |
| `geometryDifferingPairs` | 4 | 100 | 25.00 |
| `cellGridDifferingPairs` | 4 | 100 | 25.00 |
| `materialLayerOnlyPairs` | 4 | 100 | 25.00 |
| `verifyPositionsPerKey` | 4 | 96 | 24.00 |
| `structuralDiffPairs` | 4 | 88 | 22.00 |
| `verifiedKeysSample` | 4 | 84 | 21.00 |
| `previousFileSha256` | 4 | 84 | 21.00 |
| `verifiedStateKeys` | 4 | 80 | 20.00 |
| `keysNewlyVerified` | 4 | 80 | 20.00 |
| `value` | 10 | 80 | 8.00 |
| `currentFileSha256` | 4 | 80 | 20.00 |
| `tierSamplePolicy` | 4 | 76 | 19.00 |
| `variantsCompared` | 4 | 76 | 19.00 |
| `materialSwapOnly` | 4 | 76 | 19.00 |
| `previousVariants` | 4 | 76 | 19.00 |
| `failureCount` | 5 | 75 | 15.00 |
| `paletteRefsUsed` | 4 | 72 | 18.00 |
| `fullVerifyUpTo` | 4 | 68 | 17.00 |
| `allMatch` | 6 | 66 | 11.00 |
| `duplicateCapturesSuppressed` | 2 | 60 | 30.00 |
| `variantCount` | 4 | 60 | 15.00 |
| `captureCount` | 4 | 60 | 15.00 |
| `unstableKeys` | 4 | 60 | 15.00 |
| `machineFile` | 4 | 56 | 14.00 |
| `variants` | 5 | 55 | 11.00 |
| `buildCount` | 4 | 52 | 13.00 |
| `perBuildMs` | 4 | 52 | 13.00 |
| `mismatched` | 4 | 52 | 13.00 |
| `palette.json.materialPalette[]/textureBlobs[]` | 1 | 48 | 48.00 |
| `captureMs` | 4 | 48 | 12.00 |
| `checkedGroups` | 3 | 48 | 16.00 |
| `missingGroups` | 3 | 48 | 16.00 |
| `builds` | 5 | 45 | 9.00 |
| `failedGroups` | 3 | 45 | 15.00 |
| `channels` | 4 | 44 | 11.00 |
| `buildMs` | 4 | 40 | 10.00 |
| `driveMs` | 4 | 40 | 10.00 |


---

