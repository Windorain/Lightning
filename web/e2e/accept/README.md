# 渲染验收流水线（accept）

> 本目录是**唯一**的「游戏实拍 ↔ Web 视口渲染」验收设施。它不是一份测试集合，而是一条流水线：
> **场景是数据 → 两侧各出一套图 → 按机位配对 → 机械判定**。
> 改动本目录前请先读完本文件；与旧 `e2e/*.spec.ts` 里的临时验收 spec 没有任何继承关系（那批要删）。

## 1. 目标（唯一）

同一场景、同一机位，得到两类图：

| 类 | 来源 | 地位 |
|---|---|---|
| A 类 | GTNH 客户端内真实渲染截图 | **真值**（ground truth） |
| B 类 | Web 视口（产品渲染链）渲染图 | 被测对象 |

判定 = **A 与 B 逐机位机械比对**。各自与基线的比对只作辅助（抓单侧回归），不能替代配对比对。

## 2. 铁律

1. **不许改文档**：B 类渲染必须直接用游戏导出的文件。为了让画面出来而补字段、补调色板、补 blend 一律禁止；产品做不到就记 `blocked(#单号)`。
2. **机位只有一处权威**：`runner/camera-plan.mjs`。任何 spec / 脚本不得自行推导机位、缩放、裁切。
3. **场景是数据**：搭什么、拍什么、判什么，全部在本目录的 JSON 里；spec 里不得出现坐标字面量。
4. **配对不上 = 失败**：A 有而 B 没有（或反之）不能算“跳过”。
5. **允许差异要事先声明**：写在 `expect/*.json` 的 `compare` 里；事后解释不算。
6. **棘轮**：入库场景只增不减；判据只收紧；基线图带 sha256，变更必须写理由。

## 3. 目录

```
accept/
  README.md            本文件（规范）
  schema/              scene / expect 的 JSON Schema（编辑器与工具用）
  blocks/blocks.json   基础方块库（普通、实心、透明、薄面、发光、TESR 部件…）
  scenes/<id>.json     场景定义（数据）
  expect/<id>.json     判据定义（与场景 1:1，独立可跑）
  baselines/<id>/      基线图 + sha256（棘轮）
  runner/              客户端批次执行器 + 机位权威（camera-plan）
  renderer/            Web 侧唯一 replay spec（消费 plan，不做数学）
  verify/              独立验证器（无外部依赖）
```

## 4. 场景定义（scenes/<id>.json）

```jsonc
{
  "schema": "lightning.accept.scene/1",
  "id": "glass-seam",                       // 与文件名一致
  "title": "相邻玻璃不得出现接缝",
  "world": {
    "region": "cp_accept_glass-seam",       // 客户端侧区域标签（执行器据此清区/重建）
    "origin": [64, 12, 64],                 // 场景原点（世界坐标）；块坐标相对它
    "dim": 0,
    "time": 6000,                           // 固定时间（禁日光循环）
    "weather": "clear"
  },
  "blocks": [ { "block": "stone", "at": [0,0,0] } ],   // block 引用 blocks/blocks.json 的 id
  "cameras": {
    "views": ["front","back","left","right","top","bottom"],
    "axonometric": [ { "name": "iso-ne", "yaw": 225, "pitch": 30 } ],
    "orthoHeight": "auto",                  // auto = 内容跨度 × margin，取整到 0.5
    "resolution": [1920, 1080]
  },
  "export": { "name": "glass-seam", "shape": "world" }
}
```

**相机约定（与游戏侧一致，全部由 camera-plan 解释）**

- `views` 六视图（**按相机所在侧命名**）：front = 相机在 -Z（yaw 0）、back = 相机在 +Z（yaw 180）、left = 相机在 -X（yaw 270）、right = 相机在 +X（yaw 90）、top = 相机在上方（pitch +90）、bottom = 相机在下方（pitch -90）。外推距离 = 最大跨度×2+4（正交投影下不影响缩放，取远以避开近平面裁剪）。
- 轴测：`yaw`/`pitch` 是**游戏口径**（yaw 0 朝 +Z、90 朝 -X、180 朝 -Z、270 朝 +X；pitch 向下为正）。
- 分辨率恒为 **1920×1080（16:9）**：两侧同宽高是配对的前提。
- `orthoHeight`：世界单位，必为「内容跨度 × (1 + margin)」向上取到 0.5 的倍数；两侧共用同一值。

## 5. 判据定义（expect/<id>.json）

```jsonc
{
  "schema": "lightning.accept.expect/1",
  "scene": "glass-seam",
  "compare": {
    "pairs": "all-cameras",                 // 或显式机位名列表
    "normalize": "per-face-luminance",      // 逐面亮度归一化后比色度
    "exclude": ["sky"],                     // 天空盒像素整体排除
    "thresholds": { "silhouetteIoU": 0.98, "faceColorDelta": 0.06, "seamEdgeMax": 0 }
  },
  "checks": [
    { "kind": "region", "id": "glass-interior", "at": [1,0,0], "face": "+y", "expect": "background" },
    { "kind": "seam",   "between": [[1,0,0],[2,0,0]], "axis": "x", "expect": "no-edge" },
    { "kind": "opaque", "at": [0,0,0], "expect": "not-background" }
  ]
}
```

判据类型（首版）：`region`（采样区域期望为背景/非背景/指定方块色）、`seam`（相邻两格之间不得出现边线）、`silhouette`（轮廓 IoU）、`pair`（A/B 配对整体）。

## 6. 判定口径

- **天空盒不问**：`exclude: ["sky"]` 的像素不参与统计，报告里单列 `unchecked`，既不算过也不算错。
- **光照不问**（另立特性）：逐面亮度归一化后只比色度；亮度差异不计入 fail。
- 其余全部机械判定：轮廓、布局、面朝向、纹理、透明度覆盖率、接缝。
- 输出固定格式：`{ scene, camera, verdict: "pass"|"fail"|"blocked", checks: [{id, verdict, value, threshold}] , images:{game,web,diff} }`。

## 7. 与客户端的联动（长驻，不反复点火）

客户端是**常驻服务**，不是一次性工具：

1. 一次点火（`runClient`，`pauseOnLostFocus=false`，cp 端口见 `server.json`）；
2. 一个**批次** = 同一进程内串行提交的场景作业：清区 → 按定义搭世界 → 固定时间/天气 → 六视图 + 轴测拍图 → `export.scene`；
3. 单个作业失败只算该场景红，**不重启客户端**；只有 JVM 崩溃/设备丢失才重启并重放整批（场景是数据，重放幂等）；
4. 批次结束才 `core.shutdown`；窗口可跨批次复用。

产物清单（每场景一次）：`shots/<scene>/<camera>.png`、`export/<scene>.json`、`run.json`（客户端 SHA / 世界 / 时间 / 机位 / 分辨率）。

## 8. 分工

| 件 | 内容 | 完成判据 |
|---|---|---|
| A 定义 | schema、校验器、方块库 | 校验器拒绝坏定义；方块库覆盖首版六类 |
| B 客户端 | 批次执行器、产物清单 | 同场景两次运行逐像素一致 |
| C 机位 | `camera-plan` + 标定场景 + 单测 | 标定场景两侧投影落点一致（±1 px） |
| D Web | replay spec（只消费 plan） | 同一导出件产出全套图 |
| E 判定 | 验证器 + 报告 | 每对图输出 pass/fail + 数值 |

## 9. 批次执行器（长驻联动）

```powershell
node e2e/accept/runner/batch.mjs --out temp/accept-cases            # 只生成用例 + 机位计划（无需客户端）
node e2e/accept/runner/batch.mjs --submit --mc-dir <run/client>      # 提交给常驻客户端（同一进程内逐个作业）
```

- 端口从 `<mc-dir>/controlplane/server.json` 读，**不假设**；token 来自 `tokens.json` 的 `tokens.scene`。
- `--submit` 只提交**作业**：单场景失败不重启客户端；进程崩溃才重放整批（场景是数据，重放幂等）。
- 生成的用例与 `manifest.json` 落在 `--out` 指定目录（默认 `temp/accept-cases`，不入库）。

## 10. 判据执行器

```powershell
python e2e/accept/verify/judge.py --scene scenes/glass-seam.json --expect expect/glass-seam.json `
  --plan <plan.json> --camera front --game <game.png> --web <web.png> `
  --shot-meta <shot-meta.json> --out <report.json>
```

- 输出固定格式：`{verdict, counts, checks[{id, verdict, value, threshold}]}`；退出码 0 = 无 fail（blocked 允许）。
- **机位健康检查（前置闸门）**：先比两侧**中心区内容像素量**；比值落在 [0.5, 2] 之外即判 `blocked` 并给出读数。
  实测（PR109 北向）：game 57216 px / web 14400 px（正好一格）= 0.25 ⇒ 该机位只渲染出 1 格，不能拿去判内容。
- **同一根因不重复计红**：透明缺陷已计入 `blocked` 时，形状判据同标 `blocked`。
- 天空盒：两图各自角落色即背景，背景色本身不参与比较；光照：只比色度。
- 投影数学在 `verify/pairmap.py`（与 `runner/camera-plan.mjs` 同式；改动必须两处同批）。

## 11. 禁止

- 在 spec 里写死机位/坐标/缩放；
- 为了让图出来而修补导出件；
- 用“看起来差不多”代替数值判据；
- 新增未在 `blocks.json` 登记的方块 id；
- 让 A/B 两侧分辨率、正交高度、裁切窗口不一致。
