# P1.8 部件验收（建造 → 导出 → oracle 落盘）

## 一条命令

```powershell
npm run acceptance:parts
# 等价：pwsh -File scripts/parts-acceptance/run-acceptance.ps1 -Label <label> -Runs 2
```

流程：前置检查 → 写触发文件 `sde_parts_acceptance.json` → `gradlew runClientSdePipeline`
→ 游戏内自动进专用世界（`sde_parts_acceptance_world`）→ 清场（FMP `remPart` 通道，跨轮幂等）
→ 建造八分区（同步记录放置意图）→ 全量导出 ×2（同轮幂等哈希对）→ 满方块-only 字节干净对照
→ 退化导出两轮（关 ae2 ⇒ 档 2；全关 {ae2,eio,fmp,generic} ⇒ 档 3 inferred）+ 退化 oracle
（同一建造产物 + 期望档位变换）→ 合并语义等价实验 → oracle↔导出逐格核对 → 结果落盘。
`-Runs 2`（默认）再跑第二轮并逐文件比对 sha256（跨轮幂等证据）。

## 输出位置（留白 #9 拍板）

- **验收命令名**：`npm run acceptance:parts`（编排脚本 `scripts/parts-acceptance/run-acceptance.ps1`）。
- **oracle canonical 目录**：`scripts/parts-acceptance/oracle/`
  （`sde_parts_acceptance_oracle_full.json` / `_degraded_ae2.json` / `_degraded_all.json`，
  每轮第 1 轮刷新；`builtAtEpochMs` 恒为 0 —— 契约示例值，保证跨轮字节幂等）。
- **归档**：`scripts/parts-acceptance/.out/<label>[-rN]/`（导出文件 + oracle + dump + 结果 + gradle 日志）。
- **游戏内落盘**（被收走归档前）：`mod/gtnh/run/client/sde_parts_acceptance_*.json`。

## 提供者开关机制（P3.3 依赖，拍板：注册表级探针开关 + 触发文件驱动）

- `PartProviderRegistry.setFamilyEnabledForProbe(family, false)` /
  `clearFamilySwitchesForProbe()` / `isFamilyEnabled(family)`：
  按 `PartProvider.family()` 字符串（ae2/eio/fmp/generic/inferred）在 `dispatch` 时跳过该族。
  **默认全开，生产行为不变**；探针/验收专用，导出结束后恢复全开。
- 触发文件层：`sde_parts_acceptance.json` 的 `disabledFamilies: ["ae2", ...]` —— 自定义退化轮
  （P3.3 外部驱动形态：本轮只做单轮导出 + 变换 oracle 核对）。
- 退化语义：**只关 ae2 ⇒ 该格落档 2 通用盒；全关 = {ae2,eio,fmp,generic} ⇒ 落档 3 inferred**
  （只关三族会落档 2 通用盒——「落档 3」要求档 2 也关闭，拍板记录在案）。

## 分区内容清单（oracle `zones[]` + 每格 `zone` 扩展字段）

| 分区 | 行（z 偏移） | 内容 |
|------|------|------|
| full-cube | z+0 | 石头×2 / 熔炉 / 工作台（快速否定 + 字节干净对照） |
| single-box | z+2 / z+4 | 下半/上半 slab、地面火把+挂墙火把（含承载柱）、单箱+双箱；孤立/东西三连/四向十字栅栏（臂格也入 oracle） |
| ae2 | z+6 | 纯线缆 / 线缆+切換总线(N)+存储总线(U) / 线缆+成型面板(N)+破坏面板(S)+终端(U)+伪装板(E) |
| enderio | z+8 | 5 导管束 + 邻格（能量+物品）⇒ 跨格连接段 |
| fmp | z+10 | slab+panel 主格 / 跨格对（y 层上半 slab + y+1 层下半 slab，两格各一部件） |
| overlay | z+12 | 5 导管束+邻格 / AE2 facade+线缆格 / FMP 三微方块格（已裁决 = 最大复杂度真实格组合） |
| degraded | （不占世界格） | 同一建造产物 + 提供者开关关闭后重导出 + 期望档位变换 oracle |
| variants | z+14 | 异色 AE2 玻璃线缆（Fluix/Red/Blue，typeKey 落到 damage 变体） |

##  oracle 期望值来源（ground truth 可信度）

建造器常量（每部件 localId/typeKey/盒数/来源）取自探针基准（P0.2/P0.3/P1.3–P1.6 归档）+
首轮校准轮（p18-calib-1）的实测 dump 核对修正；此后 oracle 纯由建造意图生成，
验证器对导出文件做逐格精确比对（p18-final4/release 两轮 36 格 / 598 项断言全绿）。
轮内双导出哈希对 + 跨轮（默认 Runs=2）9 个产物文件 sha256 全等 = 幂等证据。

## 契约缺口登记（上报，不打临时补丁）

0. **动画纹理图标的跨进程不确定性（P1.7 资产实测发现）**：EnderIO 导管物品图标是
   `.mcmeta` 动画纹理，图标离屏渲染取当前动画帧 ⇒ 同一世界两次启动的导出文件仅该图标
   base64 不同（p18-final2 实证唯一 diff）。处置（不动 P1.7 渲染器）：验收自动化在 EXPORT
   阶段起始把方块/物品图集全部动画精灵复位到帧 0（反射 `TextureAtlasSprite` 的
   `frameCounter/tickCounter` 清零 + `framesTextureData` 帧 0 基底经 `glTexSubImage2D` 重传；
   注意 GTNH 修补版 1.7.10 该字段是 `List<int[][]>` mip 层级）。视觉-only 副作用，仅限验收会话。
   **建议** P1.7/P2 侧拍板长期方案（如图标渲染固定帧 0）；方块调色板缩略图（
   `BlockThumbnailRenderer`）对动画方块纹理有同款隐患（本结构未命中），一并登记。

1. **oracle 格映射通道**：契约 §11 cells 只有世界 `pos`，但导出文件 finalize 后不含 `worldGrid`
   （`MeshCaptureService` L707 移除）⇒ 下游（P2.5/P3.1）无法从 oracle 定位 `cellPartsGrid` 下标。
   本轮在 oracle 追加扩展字段：每格 `"zone"` + `"grid":[zi,ri,ci]`，root 追加
   `"gridIndex":{origin,size,rowAxis:"y-top-first"}`。建议契约 §11 吸收该扩展。
2. **退化格「不校验」哨兵**：退化档（关族后落 generic/inferred）的盒数/盒来源/档 3 localId
   岛序号是下游提供者实现细节，建造侧静态不可预测。本轮在退化 oracle 格使用
   `boxCount:-1` / `boxProvenance:"*"` / `localId:"inferred:*"` 哨兵（验证器跳过对应维度，
   仍精确断言档位/族/fallback/typeKey/物品计数）。契约 §11 未定义哨兵语义，建议登记。
3. **oracle 幂等**：`builtAtEpochMs` 恒写 0（契约示例值）以保住「重复运行字节一致」自检；
   真实运行时刻在 `sde_parts_acceptance_result.json` 里。建议契约明确此口径。
