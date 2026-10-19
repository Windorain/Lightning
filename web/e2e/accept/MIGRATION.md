# 旧 e2e 的收敛口径（迁移/合并/删除）

> 本文件回答一个问题：**哪些旧 spec 要被这条流水线取代，哪些不归它管**。
> 规则先于清单：先按判据分类，再谈删；删除的前提是"新设施已覆盖同一件事并有判据"，不是"看起来像"。

## 判定规则

| 判据 | 归属 | 处置 |
|---|---|---|
| 断言的是**内核行为**（双区/撤销/寿命/拾取/保存往返/故障恢复） | 不归本流水线 | **保留**，它们守的是别的入口 |
| 断言的是**渲染结果与游戏是否一致** | 本流水线 | 收编：场景 + 判据进 `accept/`，旧 spec 删除 |
| 自己在 spec 里算机位/裁切/缩放 | 本流水线 | 机位改成读 `runner/camera-plan.mjs` 的产物 |
| 为了让图出来而改文档 | 本流水线 | 删除；改为 `blocked(#单号)` |
| 依赖真实游戏产物（产物门控） | 两者交界 | 产物侧保留；渲染侧收编进 `accept/` |

## 当前实测（树 `feat/e2e-accept-pipeline`，2026-10-19）

- 旧 spec 共 **73** 份：
  - 含自算机位的 **7** 份：`kernel-dual-edit`、`kernel-m8-camera-initial-fit`、`kernel-viewport-camera`、`kernel-viewport-host-lifetime`、`p10b-a05a17-product`、`p10b-area-wiring`、`texture-uv-orientation`；
  - 触碰旧载体内部（`RuntimeDocument`/`plainForSave`/`frameDeclarations`）的 **19** 份 —— 多为内核行为用例，**保留**；
  - 真实产物门控 **2** 份：`multiblock-real-acceptance`、`parts-real-export`（`parts-real-export-evidence`、`texture-uv-orientation` 属同族门控）。

## 首批收编候选（下一批执行）

1. `texture-uv-orientation` —— 它同时做"真实产物 + 朝向/机位"，与新流水线的标定场景重叠；收编后由 `calibration` 场景 + 六视图判据取代。
2. `p10b-a05a17-product` / `p10b-area-wiring` 里的机位部分 —— 只把**机位数学**换成计划产物，行为断言不动。

## 不做的事

- 不因为"有新的了"就删内核行为用例；
- 不在流水线尚未覆盖前删旧 spec；
- 不用放宽判据换绿。
