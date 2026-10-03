# P2.5 部件 E2E 断言包 —— helpers/parts 说明

> 计划依据：`docs/plan/non-full-cube-parts-plan.md` §4 P2.5；契约：`docs/plan/format-parts-contract.md`。
> 运行：`cd web && npx playwright test parts-hover-stats.spec.ts parts-falsification.spec.ts --retries=0`
> （两个 project 都跑；展开态统计交互为 desktop-only，理由见 §3）。
> 本目录只做**测试**，不改 `web/src/`。零替身五原则与多方块轮完全一致
> （`helpers/multiblock/README.md` §2），此处只登记部件轮的增量口径。

## 1. 文件

| 文件 | 作用 |
|------|------|
| `helpers/parts/hover.ts` | Wiki 工作区切入（生产 WorkspaceTabs DOM click）、格内局部坐标 → 正交相机投影 → `pointermove` 注入、悬停状态/tooltip DOM 读取 |
| `helpers/parts/statsSidebar.ts` | 统计侧栏 DOM 读取（行/视图按钮/来源徽标/provenance 面板）、视图切换驱动、窄布局自愈展开 |
| `helpers/parts/fixtures.ts` | fixture 只读读取、内存深拷贝、**几何增强**（双绕组面追加）、textureBlobs 归一化、解析级部件观测（Grid API） |
| `../../parts-hover-stats.spec.ts` | 主断言包：加载解析 / 悬停 / 统计三视图+provenance / 图标键 / 无部件回归 |
| `../../parts-falsification.spec.ts` | 证伪：篡改计数 / displayName 的内存副本 → 对应断言必红 + 定向对照仍绿 |

## 2. 为什么经 Wiki 工作区（EmbedPreview）

部件 tooltip（`ToolTipBox`）与统计侧栏（`BlockStatsSidebar`）的生产宿主是
**EmbedViewport**；Workbench 预览视口不渲染这两个 DOM。`WorkbenchRoot` 的
Wiki 工作区内嵌生产 `EmbedPreview`（= EmbedViewport，特性开关来自
`embedPublish` 默认值：侧栏/标题栏开），因此断言路径 = WorkbenchRoot 挂载 →
`OPERATOR_OPEN_SCENE` 注入 → **生产 WorkspaceTabs 点击**切 Wiki 工作区 →
DOM 事件注入 → 公开观测（`ctx.viewports.get('r-wiki-preview')` /
`ctx.region('r-wiki-preview').state.hover` / 生产 DOM）。没有为测试新开任何
src 侧后门。

## 3. 已登记的口径与发现（全部已上报调度者）

1. **几何增强副本**（`fixtures.ts` 文件头）：悬停是真实 raycast，fixture 几何
   （含 c98351a 补全后）单绕组背向 init 相机、AE2 切换总线补面被最小体积规则
   判给线缆 —— 原件几何对悬停物理不可达。悬停用例注入**几何增强内存副本**
   （部件数据与原件逐字节一致，只追加双绕组命中面）；统计/回归用例注入原件。
2. **textureBlobs 归一化**：fixture 与 minimal-v2 的 textureBlobs 是对象数组，
   渲染管线只认 string[]（multiblock README §7 开放项 4 的既有口径）——
   内存副本归一化后网格才能构建（悬停前提）；侧栏不受影响。
3. **mobile 窄布局自动折叠振荡（实现发现，不代修）**：展开侧栏 → 嵌入根宽
   361→445px → profile tiny→narrow → 生产 watcher ~50ms 内再折叠。展开按钮
   在该带宽带自失效；窄布局折叠本身是 embed-mobile.spec 锁定的预期。
   因此**展开态统计交互（视图切换/徽标/provenance/行文本）仅 desktop 跑**
   （`EXPANDED_SIDEBAR_DESKTOP_ONLY`），mobile 跑解析级 + 悬停（不依赖展开态）。
4. **历史阻断（已闭环）**：深响应式 `ref` 下 `structuredClone` 遇 Vue Proxy 必炸
   （serialize/clone 对含部件文档全表面不可用）——本包擒获上报后由实现侧
   c98351a 修复（`deepCopyPlain` + `reactivePartsDoc.test.ts` 回归锁定）。

## 4. 反同义反复

期望值（部件名/localId/typeKey/计数/行键/图标键/provenance 迁移）全部硬编码于
spec，不读被测文件；篡改内存副本 → 对应断言必红（`parts-falsification.spec.ts`，
含「红色来自断言而非解析失败」「定向对照仍绿」两条纪律）。
