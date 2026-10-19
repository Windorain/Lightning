# 验收过程中确认的产品事实

> 本文件只记**在验收里被机械复现过**的事实（含数值与复现入口）。规格性结论仍以 `README` 与判据文件为准。

## F1 · World 形态导出件打不开（已立单 #408）

- 现象：cp 默认 `shape:"world"` 的导出件在 Web 装载后 `docLoaded=true`、`frameCount=1`，但帧网格为 null，装配以 `unsupportedDocumentShape` 拒绝。
- 原因：契约把 `blockPalette` 放在顶层（帧内移除），而 `RuntimeDocument.fromV2Plain` 只认帧内 `structure.blockPalette`。
- 现状：本树带临时补丁（解析期把顶层表回落各帧，注释写明绑 #301 退出）；判据：三组对照 A/B/C 全过。

## F2 · 透明方块被画成不透明（**两个独立根因，均已修**）

### 现象（机械读数，不是"看着像"）

- 同一对图上：游戏侧玻璃格采样 `game_bg_ratio = 0.88`（透出天空），Web 侧 `web_bg_ratio = 0.00`（不透）。
- `glass-transparent` 记 `blocked`；同一根因把 `pair-silhouette` 也拖红（front/back IoU 0.8189 / 0.8187）。

### 根因①（导出侧：权威字段从来不产出）

- 契约 `docs/contracts/format-multiblock-doc.md` 把 `blend` 列在 `materialPalette` 条目里，
  但生产侧**全历史零处**写它（`git log -S 'addProperty("blend"' -- mod/gtnh/src` 无命中）；
  于是消费侧 `runtime/presentationAdapter#asBlend` 只能按 `opaque` 兜底。
- 判定规则**不是挑的**，从 MC 1.7.10 的渲染分工推（`EntityRenderer` pass 0 有 alpha test 无混合、
  pass 1 才有混合）：`getRenderBlockPass() > 0` ⇒ `translucent`；pass 0 且 `!isOpaqueCube()` ⇒ `cutout`；
  其余 ⇒ `opaque`。**不扫贴图像素**：那在本工程已有唯一一条多级回退链（`TextureBlobEmbedder`）。
- 修复：`client/export/MaterialBlendMode`（纯判定 + 方块入口）+ `SamplerTable` 写 `blend`（并进缓存键，
  否则同一贴图跨 pass 时一方覆盖另一方且不报错）。判据：`MaterialBlendModeTest` 5/5。

### 根因②（Web 侧：**加了 blend 也没用**的原因 —— 纹理解码把 alpha 弄没了）

- `adapters/textureDecode` 为省分配复用模块级 `OffscreenCanvas`；而 `drawImage` 是 **source-over 合成**，
  同尺寸的下一张纹理不触发 resize ⇒ 画布既不清空也不重置 ⇒ 新图的透明像素透出上一张的颜色、
  alpha 被顶成上一张的 255。
- 实测（同一份导出件，浏览器内读材质贴图）：玻璃贴图中心本该 `(0,0,0,0)`，Web 解出
  `[131,45,43,255]` = **前一张红羊毛**的像素；残留色随解码顺序变（同一文档一次偏蓝一次偏红）。
  ⇒ 玻璃贴图"永远不透明"，任何 `blend` 都无效。这才是为什么"只补 blend"跑出来 `web_bg_ratio` 仍是 0.00。
- 修复：绘制前 `clearRect`。判据：`src/adapters/__tests__/textureDecodeSharedCanvas.test.ts` 3/3；
  负对照去掉 `clearRect` ⇒ 2/3 红（`expected 255 to be +0` / `+128`）。

### 单变量对照（同一 run、同一机位、只改导出件的 `blend`）

| 文档 | web_bg_ratio（front/back/top/bottom） | 分类 |
|---|---|---|
| 原导出件（无 `blend`）+ 修前解码 | 0.00 / 0.00 / 0.00 / 0.00 | content（且颜色随解码顺序漂） |
| 原导出件（无 `blend`）+ 修后解码 | 0.08 / 0.08 / 0.08 / 0.12 | content（中心变黑：alpha 丢失被修好，但 opaque 仍不吃 alpha） |
| `blend:"cutout"` + 修后解码 | **0.80 / 0.80 / 0.80 / 0.80** | background ✔（游戏 0.88/0.88/0.80/0.80） |

⇒ 两个根因**都必需**；② 是 ① 的前置（不修 ②，① 无法被观测）。

### 复验（新 run `20261019-230757-accept-calibration-1`，全链真端到端）

- 导出件：`glass = cutout`、四块羊毛 = `opaque`；批处理新增不变量 `verifyExportPalette` 通过
  （**逐条必须声明**，缺席/越词表即失败）。
- `glass-transparent`：front / back 均 **pass**；`pair-silhouette` front **1.0** / back **0.9999**。
- 玻璃格 bg 比在 9 个机位上 game 与 Web 逐台一致（0.88/0.80、0.80/0.80、0.44/0.44、0.68/0.64…）。

## F3 · 近裁剪面落在内容之内 1 cm，把朝向相机的那一层面裁掉（**已更正：不是绕向**）

> 更正记录（2026-10-19 晚）：本文初稿把现象归因为"三角形绕向反了"，**那是错的**。
> 用户实测推翻了它：导出件里每个方块 6 个面全部是"从外部看逆时针"（逐面统计：6/6 outwardCCW、0 inverted）。
> 真因是裁剪面：`initialCamera.ts` 的 `near = -maxZ + 1e-2` 把近平面放在**最近表面之内** 1 cm。

- 现象：六视图里 `front`/`bottom` 内容比 **0.00**（整幅空），`left` 0.328；斜视轮廓 IoU 0.81~0.86。
- 现场读数（同一帧）：内容包围盒 `[-1.5,-1,-1]..[1.5,1,1]`；front 相机在 `z=-11`；
  `near=10.01 / far=12.01` ⇒ 最近的那一层（距离 10.00）**落在近平面之前**，被裁掉。
  剩下的侧棱面积为 0，背面又被背面剔除 ⇒ 空画面。
- 为什么最初的 DoubleSide 实验骗了我：双面材质并没有"恢复绕向"，它把**远侧背面**也画出来了
  （那层在 far 之内），于是画面有了内容——但那是盒子内壁，所以 `anchor-white` 色差 0.157~0.247。
  这个实验只能证明"几何在、机位在"，**不能**证明绕向。
- 修复：`near = -maxZ - eps`（`fitOrthoFrustumToWorldBox` 与 `syncClipPlanesToGroup` 两处同改）。
- 复验（同文档、同机位、同分辨率）：`front` 0.00 → **1.203**、`bottom` 0.00 → **1.22**、
  `left`/`right` 轮廓 IoU **1.0** 且五个判据全过；`front/back` 四个染色标记色差 ≤0.006。
- 回归判据：`web/src/render/interaction/__tests__/clipPlanesCoverContent.test.ts`
  —— 把包围盒 8 个角点投到视空间，断言每个角点深度都落在 `[near, far]`。
  负对照实测：改前 6/6 失败（`9.9999 < 10.0099`），改后 6/6 通过。
- 影响面：**用户可见**。初始取景也走同一函数 ⇒ 任何文档最近的那层面都被切掉 1 cm，
  表现就是"方块被切开/能看见内壁"（本轮标定图里的白块被切，正是这个）。

## F4 · PR91 faithful 捕获把箱子几何拆成两片（同内核、只切换捕获模式的对照）

- 输入：同一世界（4 管 + 1 箱）、同一导出管线、同一 Web 内核与同一机位（persp-row，正交高 7）。
- 对照：`-Dsde.sceneCapture=legacy` 的导出件 ⇒ 渲染出**一个完整的箱子**；faithful（PR91 新默认）⇒ 箱子被拆成**两片**（一片箱体、一片偏移的盖/侧），另有一小段管子碎片。
- 导出件读数：legacy 的箱子四元面在格内（0.06..0.94）；faithful 的在 (2.18..3.12, -2.06..-1.12, -0.75..1.06)，z 跨度 1.8 格 —— 不在格内，任何消费方都无法摆放。
- 结论：faithful 捕获把 TESR 几何写进了与格无关的另一套坐标（疑似摄像机相对），是**PR91 自身**的缺陷；与 Web 渲染器无关。
- **机械判定**（同一机位、同一内核，箱格 [5,0,1]）：legacy 的箱子 = `pass`（game/web 内容覆盖率 1.0 / 0.96）；faithful 同一格 = `fail`（web 背景占比 1.0，即该格没有箱子）。
- 未决：管子两种模式在 Web 侧都不渲染（`web_bg=1.0`，属 Web 侧缺口，另计）；因此 PR91 的“管子数量”尚不能用画面判定。
## F5 · `/sde pos1|pos2` 静默忽略坐标 ⇒ 导出网格退化成 1×1×1（本轮实测）

- 现象：用例里写 `/sde pos1 62 10 62` / `/sde pos2 68 15 67`，两条命令都返回 `status:ok`，
  但回执是「pos1 已记录（64, 13, 64，脚下方块）」——命令行参数被忽略，两角都记为玩家所在格。
- 后果：导出件 `cellGrid` = 1×1×1，Web 侧按这个网格取景，看起来像"渲染错"，真因在导出选区。
- 契约事实（`CommandSde.java:55-67,361-388`）：`pos1/pos2` 与 WorldEdit `//pos1` 同口径，**取玩家脚下体素**，不接受坐标。
- 现行做法：用例的 `action` 段先 `scene.player.pose`（allowFlying 默认开，全虚空世界不坠落）站到角点，
  再发 `/sde pos1`/`/sde pos2`；批处理随后用导出件的 `provenance.selection` 与 `cellGrid` **两路交叉核对**选区，
  不符即失败（实测通过：selection min [63,11,63] / max [67,14,66]、grid 5×4×4）。

## F6 · 判据执行器把"全 blocked"算成 pass（已修）

- 现象：首次标定跑出 `verdict: pass` 而 `counts.blocked = 7`——所有判据都没能判，却被计为通过。
- 修法：`fail` > `blocked` > `pass`；只要还有 blocked 就不能报 pass（"判不了"≠"通过"）。

## F7 · 标定场景的像素落点（机位对齐的正向证据）

- 机位：`right`（相机在 +X 看向 -X），1920×1080，正交高 4 ⇒ 270 px/格，两侧同。
- 判据：`verify/px-check.py --tol 1`，五个方块（白/红/绿/蓝/玻璃）逐个比较"预测矩形中心"与"实际同色区中心"。
- 结果：**两侧每个方块误差均为 0.5 px**（整数包围盒的量化半像素，非系统偏移），判定 `pass`（worst 0.5 < 1）。
  ⇒ 世界→像素映射在两侧一致到亚像素；其余机位的失败不是机位算错，而是 F3 让内容没画出来。

## F8 · 绕向缺陷在干净数据场景上再次成立（本轮端到端复现）

- 场景：`calibration`（4 个染色标记 + 1 块玻璃），两侧同分辨率 1920×1080、同 px/格（270）。
- 单位置：`front` 内容比 **0.00**（Web 整幅空）、`bottom` **0.00**、`left` **0.328**、`back` 0.902、`right` 0.984、`iso-*` 1.15。
- **双面实验**（同文档、同机位，仅把材质 `side` 改成 DoubleSide）：`front` 0 → **1.203**、`left` 0.328 → **0.984** 且五个判据全过、
  `top` 0.915 → 1.219、`bottom` 0 → 1.22。⇒ 缺的是**面**，不是几何缺失；坐实 F3。
- 双面下仍有残余差异：`front/top/bottom` 的 `anchor-white` 色差 0.157~0.247、轮廓 IoU 0.81~0.86；
  `iso-*` IoU 0.84~0.86。属另一条待定性缺陷（随 F3 修完后重判）。

## F9 · 斜视/俯视机位的残余差异（**未定性**，本轮不追）

F2 修完后（run `20261019-230757-accept-calibration-1`）已经过 6 台、还红 3 台：

- `pair-silhouette`：`top` **0.9858**、`bottom` **0.9946**、`iso-ne` **0.9930**（阈值 0.995）；
  其余 front/back/left/right **1.0/0.9999**、iso-nw 0.9959、iso-high 0.9985。
- `iso-ne` 的 `axis-x-red` 色差 **0.1267**（阈值 0.04），而 `iso-nw` 同项 **0.002**
  —— 同一格、两台相机结论相反，指向"取样落在哪个面"而不是"颜色错"。
- 玻璃格 bg 比：`iso-ne` game 0.32 / web 0.44（其余机位差 ≤0.04）。
- 目视对照（`temp/accept-run/v2/cmp-{game,web}-iso-ne.png`）：内容、朝向、玻璃透明度一致；
  游戏侧多出几条白色直线（游戏侧叠加物），边缘宽度/亮部略有差。

待定的两个方向（都要用判据说清，而不是调阈值糊过去）：

1. 斜视机位的 5×5 取样是否**跨面**：跨两个面时，"亮度归一化"消不掉面间的色度差，
   判据应显式声明 `face`；标定场景的 `expect` 目前没标；
2. `silhouetteIoU 0.995` 对 1–2 px 边缘差是否过严（当前差异量级 = 边缘带，不是内容缺口）。
