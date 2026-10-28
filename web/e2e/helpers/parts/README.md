# `web/e2e/helpers/parts/` —— 部件无头断言包

部件数据、物品索引、统计侧栏与描边通道的无头断言。格式契约见 [docs/contracts/format-parts-contract.md](../../../../docs/contracts/format-parts-contract.md)。本目录只做测试，不改 `web/src/`；入口挂载、IO 接管与等待原语复用 `helpers/multiblock`。

## 1. 运行

```powershell
cd web

# fixture 包（仓库内 fixture，无需外部产物）
npx playwright test parts-hover-stats.spec.ts parts-falsification.spec.ts --retries=0
npx playwright test parts-item-select-b5.spec.ts parts-outline-b1.spec.ts --retries=0
npx playwright test parts-probe-hover-ratchet.spec.ts --retries=0

# 真实导出包（需要部件验收归档）
npx playwright test parts-real-export.spec.ts --retries=0
npx playwright test parts-real-export-evidence.spec.ts --retries=0

# helper 纯函数的离线单测（零浏览器）
npm run test:e2e:unit
```

两个 project（`desktop-chrome` / `mobile-chrome`）都跑。下列用例只在 desktop 运行，理由是窄布局下侧栏展开态会在约 50ms 内被生产的折叠 watcher 折回，展开态交互在 mobile 不可保持：

- 依赖展开态统计侧栏的用例（`EXPANDED_SIDEBAR_DESKTOP_ONLY`）：物品行文本、图标键、移除锁读数、物品点选与行悬停；
- 真实导出包里需要同格多部件多轮候选试探的 AE2 用例；
- 证据截图包（`parts-real-export-evidence.spec.ts`）全部用例，截图只出一份。

mobile 的覆盖是解析级观测与单盒区悬停。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `hover.ts` | 切入 Wiki 工作区（生产 `WorkspaceTabs` DOM click）、格内局部坐标经视口相机投影为 client 坐标并注入 `pointermove`、悬停状态与 tooltip 文本读取、`probeHover`（目标必须在调用点显式声明）、`compactTooltipText` |
| `statsSidebar.ts` | 统计侧栏 DOM 读取（物品行键、图标键、选中态、无对应标记、锚点、会话提示、`[data-stats-itemless]`）、稳定性等待、行点击与行悬停驱动、移除锁读取、行图标槽观测 |
| `outline.ts` | 部件级描边 mask 的公开观测（`outlinePass.maskScene` 的 mesh 数与顶点 AABB）与 mask 局部 AABB 换算 |
| `fixtures.ts` | fixture 只读读取、内存深拷贝、几何增强（追加双绕组面）、`textureBlobs` 归一化、解析级部件观测 |
| `realExport.ts` | 真实产物的归档解析、部件与盒读入、oracle 读入、格映射、悬停探针候选推导、`itemIndex` 与 `blockPalette[].hostItem` 读面 |
| `oraclePath.ts` | oracle 解析路径（canonical -> 归档 -> 显式失败），无浏览器依赖 |
| `index.ts` | helper 出口（`export *`） |
| `../../../e2e/parts-hover-stats.spec.ts` | fixture 主断言包：加载解析、悬停、统计行集与计数、移除锁、无部件回归、物品行 tooltip、截断与帧时间登记 |
| `../../../e2e/parts-item-select-b5.spec.ts` | 物品点选：行点选 -> 生产描边 mask（部件级 / 并集 / 无对应不高亮 / 多选语义 / 证伪） |
| `../../../e2e/parts-outline-b1.spec.ts` | 同格三部件悬停时 mask 几何各自贴合部件盒；满方块格为整格 |
| `../../../e2e/parts-falsification.spec.ts` | fixture 证伪：篡改计数、displayName、`itemIndex` 归属与说明 -> 对应断言失败，定向对照仍通过 |
| `../../../e2e/parts-probe-hover-ratchet.spec.ts` | 悬停探测目标的棘轮：帧时钟闸门驱动确定性悬停序列，旧口径（任何非空悬停即落定）必读错，新口径必须等到目标 `localId` |
| `../../../e2e/parts-real-export.spec.ts` | 真实产物主断言包：逐格与 oracle 一致、悬停命中、AE2 同格多部件各自 tooltip、统计行集、`itemIndex` 逐键与 `hostItem` 逐条 |
| `../../../e2e/parts-real-export-evidence.spec.ts` | 真实产物的证据包：mask 贴合文件盒 union、物品点选归属、侧栏行悬停 tooltip、FMP 行键与归属 |

## 3. fixture 口径

### 3.1 原件几何对悬停不可达（几何增强副本）

悬停拾取是真实 raycast：射线命中三角形 -> 命中点换算格内坐标 -> 判部件盒。fixture 原件的几何有两处物理不可达：全部 quad 为单绕组、法线朝 `(+x, -y, +z)` 半球，而视口 init 相机在 `(-x, +y, -z)` 象限（背面剔除）；AE2 fixture 为切换总线补的 `z=0.3125` 面同时落在线缆颈盒 `z∈[0.3125, 0.375]` 的最小边界上，按最小体积盒规则会被判给线缆。

悬停用例因此注入**几何增强的内存副本**（`augmentFixtureGeometry`）：只向调色板条目追加双绕组四边形，注入面取目标部件独占的盒边界；部件数据（盒、说明、物品身份、计数）与原件逐字节一致，断言目标仍是原件数据。统计与回归用例注入原件。

### 3.2 `textureBlobs` 归一化

fixture 与 `minimal-v2` 的 `textureBlobs` 是对象数组，渲染管线只接受 `string[]`，副本需先经 `normalizeTextureBlobsForRender` 归一化，网格才能构建（悬停的前提）。真实导出的 `textureBlobs` 已是 `string[]`。

## 4. 真实产物与 oracle

归档目录由 `PARTS_ACCEPTANCE_DIR` 指定。仓内没有 `scripts/parts-acceptance/.out/`，因此通常必须显式设置该变量指向既有归档；未设置时解析器会尝试该缺省根下最近的目录，但该根不存在，实际等价于缺件失败。缺件即抛错（不静默跳过），并由 `web/e2e/real-artifact-gate.ts` 把两份真实产物的 spec 从本次收集排除、在 `web/test-results/e2e-exclusions.json` 登记。

归档内的固定文件名：`sde_parts_acceptance_export_full_a.json`、`_full_b.json`、`_fullcube_only.json`、`_degraded_ae2.json`、`_degraded_all.json`、`sde_parts_acceptance_result.json`。

oracle 解析顺序（`oraclePath.ts`，唯一实现）：仓内 canonical [test/expected/parts-acceptance/](../../../../test/expected/parts-acceptance/README.md) -> 归档同名副本 -> 抛错。canonical 优先；三份文件为 `full`、`degraded_ae2`、`degraded_all`。

期望值的边界：fixture 包的期望值硬编码在 spec 内，不读被测文件（篡改内存副本必须让对应断言失败，见 `parts-falsification.spec.ts`）。真实产物包的规模不允许硬编码，期望值来自 oracle 与导出文件自身的部件数据，断言目标是「web 解析、渲染、悬停、统计忠实呈现文件内容」：解析级逐格比对 `localId` 集合、`typeKey`、物品件数、来源四元组、盒数与盒静态合理性；统计行集必须吻合 oracle 的 `expectedCounts`；同格多部件必须得到两个不同 tooltip 且各自包含自己的 displayName。导出件本身是否正确由 mod 侧（游戏内 L1 验证器）承担，L2 不重算。

## 5. 坐标与格映射

- oracle 的 `cells[].grid` 是 `[zi, ri, ci]`，`gridIndex.rowAxis = y-top-first`：`row` 自上而下。
- 导出文件的 `cellPartsGrid[z][row][col]` 与 oracle 同一套下标，直接按 `gridIndexOf()` 取用。
- 页面侧 `Grid.partsAt` 是 Y-up 空间（`y = 0` 为结构底部），必须换算：`x = col`、`y = height - 1 - row`、`z = zi`（`gridApiPosOf()`）。两套下标混用会让格定位整体错位。
- 悬停注入点是**格内局部坐标**：部件盒 `min` / `max` 位于 `0..1` 的格内空间，与 raycast 命中点换算出的格内坐标同一空间。
- 描边 mask 的世界顶点减去该格世界角即格内局部坐标，与 `PartRecord.boxes` 同空间。

真实产物的悬停探针按「盒面中心 -> 面中心内缩 -> 盒内 3×3×3 采样」给出候选序列，并按与相机方向的夹角让面向相机的面先试；同格多部件盒重叠时逐个试探到命中目标部件为止。`probeHover` 的目标必须在调用点显式声明（`{localId}` 或 `{hostOnly: true}`），且命中格必须等于注入点所在格。

## 6. 当前限制

- 真实导出链**没有产出端**：仓内不存在产出 `sde_parts_acceptance_export_*.json` 的编排脚本，控制面也没有部件导出动作；`te` 步补全器不覆盖 EnderIO 与 FMP 两族。真实产物因此只能消费既有归档，无法在仓内重新导出。
- 平面类部件（如 AE2 破坏面板）的碰撞盒在某一轴零厚度，判据是「逐轴 `min <= max` 且非全轴退化」，不视为契约违例。
- FMP 三行的行图标键是 `part.typeKey`（`...#mat=<材料串>`），而 `partIconTextures` 的键是物品身份键（`PartItem.iconKey()`，`...#<材料串>`），这三行取不到嵌入纹理，落回退或占位。
- 真实导出包的 `itemIndex` 归属自检要求「归属必须指向真实存在的同键部件」；归属被清空的键在侧栏显示为「没有对应方块」。
