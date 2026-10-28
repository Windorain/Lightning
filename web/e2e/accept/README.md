# `web/e2e/accept/` —— 渲染配对验收

同一场景、同一机位，分别取游戏内实拍与 Web 视口渲染，再按机位逐项比对。场景与判据都是数据；机位由 `runner/camera-plan.mjs` 唯一决定；Web 侧只使用本次运行导出的场景文件。

## 1. 入口与退出码

```powershell
cd web
node e2e/accept/runner/run-accept.mjs --out <dir> [--scenes a,b] [--mc-dir <run/client>] [--no-submit] [--baseline]
node e2e/accept/runner/batch.mjs --out <dir> [--scenes a,b] [--submit] [--mc-dir <run/client>]
node e2e/accept/verify/validate.mjs [scenes/<id>.json]
node e2e/accept/runner/baseline.mjs --run <run.json> --scene <id> --camera <name> --game <g.png> --web <w.png> [--report <json>] [--force]
```

| 入口 | 作用 | 退出码 |
|---|---|---|
| `run-accept.mjs` | 提交作业、Web 复渲、逐机位判定，汇总到 `<dir>/summary.json` | `0` 全部 `pass`；`1` 存在 `fail` 或 `blocked`；`2` 无匹配场景；`3` 缺运行清单或清单场景不符；提交失败时返回该步的退出码 |
| `batch.mjs` | 生成 `case` 与机位计划；加 `--submit` 时提交给常驻客户端并复核产物 | `2` 无匹配场景；提交或复核失败为非 0 |
| `validate.mjs` | 校验 `scenes/` 与 `expect/` 的静态一致性 | `0` 通过；`1` 有错误（逐条打印） |
| `baseline.mjs` | 登记基线（棘轮） | `0` 登记成功；`1` 拒绝（场景不符、截图 sha256 与清单不符、同名基线已存在）；`2` 参数缺失 |

提交从 `<mc-dir>/controlplane/server.json` 读端口，从 `tokens.json` 取 `tokens.forensic`，以 `inline` + `confirm:true` 提交 `case.run`。

## 2. 目录职责

| 路径 | 职责 |
|---|---|
| `scenes/<id>.json`、`expect/<id>.json` | 场景定义与判据定义（数据） |
| `schema/*.json` | 场景与判据的 JSON Schema，供编辑器与工具使用；权威校验器是 `verify/validate.mjs` |
| `blocks/blocks.json` | 方块库；场景 `blocks[].block` 只能引用这里登记的 id |
| `runner/camera-plan.mjs` | 机位唯一权威：六视图与轴测、正交高度、每格像素数、Web 侧 orbit 参数 |
| `runner/batch.mjs`、`runner/run-accept.mjs` | 场景到用例的转换、提交、产物复核、汇总 |
| `runner/baseline.mjs` | 基线登记 |
| `renderer/replay.spec.ts` | Web 侧唯一 replay spec：读计划、渲染、落盘，不做机位数学 |
| `verify/validate.mjs` | 场景与判据校验器 |
| `verify/judge.py`、`verify/pairmap.py` | 判据执行器与两侧世界点到像素的映射（唯一实现） |
| `verify/ratchet.py` | 与已登记基线比对 |

Web 复渲使用独立配置 `web/playwright.accept.config.ts`（`testDir` 为 `e2e/accept`，project 名 `accept-replay`）；普通 e2e 入口不收集该目录。

## 3. 场景与判据字段

场景（`lightning.accept.scene/1`）必需字段：`schema`、`id`（与文件名一致，小写连字符）、`title`、`world`、`blocks`、`cameras`、`export`。

- `world`：`region`（客户端侧区域标签）、`origin`（三个整数，`blocks[].at` 相对它）、`dim`（-1..1）、`time`（0..24000）、`weather`（`clear` / `rain` / `thunder`）。
- `blocks`：非空，每项 `{block, at}`；`block` 必须在 `blocks.json` 登记，`at` 不得重复。
- `cameras`：必须给 `resolution`（两整数、≥160、16:9）；默认给 `views`（六视图子集）与 `axonometric`（`name` / `yaw` / `pitch`），也可改用 `explicit` 逐条给出 `name` / `pos` / `yaw` / `pitch` / `orthoHeight`。`orthoHeight` 取 `auto` 或正数。
- `export`：`name` 与 `shape`（`world` / `structure`）。
- `notes`：可选字符串，供人读；场景 schema 声明该字段，构建与判定不读取。

判据（`lightning.accept.expect/1`）必需字段：`schema`、`scene`（等于场景 `id`）、`compare`、`checks`。

- `compare`：`pairs`（`all-cameras` 或机位名数组）、`normalize`（`per-face-luminance` / `none`）、`exclude`（只允许 `sky`）、`thresholds`（`silhouetteIoU` / `faceColorDelta` / `seamEdgeMax`）。
- `checks`：非空，每项 `kind` 与 `id`；`kind` 取 `region` / `seam` / `opaque` / `silhouette` / `pair`，各类型的参数与判定语义由执行器实现。
- `notes`：可选字符串。`expect/calibration.json` 使用该字段；权威校验器不拒绝它，但 `expect.schema.json` 未声明它，按该 schema 校验会失败。

## 4. 机位

机位只由 `runner/camera-plan.mjs` 产生，spec 与脚本不得自行推导机位、缩放或裁切。六视图按相机所在侧命名（`front` 在 -Z、`back` 在 +Z、`left` 在 -X、`right` 在 +X、`top` 在上方、`bottom` 在下方）；轴测的 `yaw` / `pitch` 为游戏口径（yaw 0 朝 +Z、90 朝 -X、180 朝 -Z、270 朝 +X，pitch 向下为正）。两侧共用同一 `orthoHeight` 与 16:9 分辨率。

## 5. 当前 scenes 与 expect

`scenes/` 有 7 份：`atypical-tesr`、`calibration`、`ctm-glass`、`glass-seam`、`lp-pipe-single`、`opaque-mix`、`tesr-pipes`。`expect/` 有 5 份：`calibration`、`ctm-glass`、`glass-seam`、`opaque-mix`、`tesr-pipes`。两者不是一一对应：`atypical-tesr` 与 `lp-pipe-single` 没有判据文件。

`verify/validate.mjs` 的全量校验要求每份场景都有对应判据、每份判据都有对应场景，因此在当前树上以退出码 `1` 结束并逐条报这两处缺失。单场景校验（传入有判据的 `scenes/<id>.json`）不受影响。

## 6. 配对闸门

一次运行的产物清单 `runs/<scene>.run.json`（`lightning.accept.run/1`）逐机位登记截图与导出件的 `sha256`，并登记 `manifestSha256`。判据执行器在内容判定之前先核对：运行清单的场景 id 与场景定义一致、截图的 sha256 等于清单值、导出件的 sha256 等于清单值；任一不符即输出 `blocked` 并退出码 `2`，不进入内容判定。因此历史截图与历史导出件无法顶替本次产物。

产物复核同样以哈希为准：导出网格必须等于场景声明的选区，`materialPalette` 必须逐条声明 `blend` 且取值属于 `opaque` / `cutout` / `translucent`，否则本次提交失败。

## 7. 基线

基线写入 `baselines/<scene>/<camera>/{game,web,report}` 与 `baselines/<scene>/manifest.json`。`baseline.mjs` 的 `--run` 必填，基线因此可追溯到具体一次运行；同路径再次登记必须显式 `--force`。`verify/ratchet.py` 与基线比对：两侧 sha256 相同判 `pass(identical)`，不同则按逐像素平均差与 `--max-mean-diff` 判定，没有基线时输出 `blocked`。

## 8. 约束

- 不为让画面出现而修补导出件；缺字段时修改导出链。
- 不复用历史产物与外部附件；配对闸门按 sha256 拒绝。
- Web 侧只消费本次运行导出的场景文件，不直接从场景 JSON 搭建。
- 机位、缩放、裁切只在 `camera-plan.mjs` 中确定；两侧分辨率、正交高度与取景必须一致。
- 允许的差异只能写在 `expect/<id>.json` 的 `compare` 中。
- 新增方块必须先在 `blocks/blocks.json` 登记。
