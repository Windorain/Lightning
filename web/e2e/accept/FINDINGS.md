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

## F10 · 场景用 `block` 步铺 LP 管 ⇒ 空壳管（不报错，实拍与导出双双是空的）

- 现象：`tesr-pipes` 场景在 PR91（faithful）构建上跑，游戏实拍**整格背景**、导出件 4 根管 **0 quads**，
  而用例/判据/导出链全部"成功"（不报任何错）。
- 根因（机械证实）：LP 通用管块在 `setBlock` 之后只是**空壳**——活世界 `read.blocks` 显示块与
  `LogisticsTileGenericPipe` TE 都在，但 TE 的 NBT 里 **`pipeId = -1`**（没有管型）⇒ LP 渲染器什么都不画。
  **等待无关**：`settleTicks: 60`（3 s）之外再做一次显式 `wait 400`（20 s）探针，导出仍是 0 quads。
- 权威写法（之前漏在布景侧）：必须走 **`te` 步 + completer `lp-pipe`**，
  参数 `{"pipe":"LogisticsPipes:item.PipeItemsBasicLogistics"}`——出处 `test/cases/anchor/lp-pipe-row.json`
  （控制面技能的权威范例）。教训：**先读入库用例，别猜注册名**（我猜了 20 个候选，全错）。
- 修好后（run `20261020-001717-accept-tesr-pipes-lp-27`，同一 PR91 合并构建）：
  每根管 **174 / 188 / 188 / 188 quads**，包围盒**在格内**（`0.00..1.00 × 0.19..0.81 × 0.19..0.81`）；
  游戏实拍四管互连 + 箱子（对比图 `temp/pr91-lp/cmp-front.png`）。
- 同日固化进管线：`blocks.json` 条目可带 `te:{completer,params}`，`caseForScene` 遇它就发 `te` 步而不是
  `block` 步（`lp-pipe` 已登记）；生成结果与手写用例逐字段一致，runner 单测 11/11。
- **对 F4 的更正**：F4 当时那 4 根管很可能也是空壳（同用 block 步）⇒ "管子数量不能用画面判定"现在要分两半：
  **导出侧已可判**（in-cell 几何），**Web 侧仍不渲染**（见 F11）。

## F11 · LP 管与箱子的 Web 侧结论（PR91 合并构建实测）

- **PR91 的忠实捕获对 LP 管有效**：导出 174–188 quads/管、坐标在格内；游戏实拍可见四管互连。
- **PR91 的忠实捕获对 TESR（箱子）仍无效**：同一次导出里箱子 18 quads 落在
  `(2.96..3.90, -2.24..-1.31, -0.47..1.34)`，而该格是 `(4..5, 0..1, 0..1)`——与格无关的另一套坐标
  （与 F4 同一现象，在合并构建上复现）。Web 侧把它画在画面外（整幅只剩左下角一小块）。
- **Web 侧缺口（既有，与 PR 无关）**：LP 管的 174–188 quads **一个都没画**——把它们材质从 `translucent`
  强改为 `opaque` 重渲，PNG **逐字节相同**（同 sha256）⇒ 不是混合模式问题，是几何没进渲染。
  **根因已定位并修复，见 F12。**
  台账：8 个机位 × 5 个格子的 `web_bg_ratio` 全 1.0；游戏侧同格 0.16–0.48。
- 判定读数（run `…-lp-27`）：`left/right/top/bottom/iso-ne` = fail，`front/back/iso-se` = blocked
  （"该机位整体无内容"——视图级缺陷优先于内容判定，判据行为正确）。
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
## F12 · Web 装配把**整条调色板条目**丢成"无几何"——一条零长度棱就够了（已修）

- 现象（承 F11）：导出件里 4 根 LP 管各 174/188/188/188 quads 都在，Web 渲染里**一格都没有**。
  判定读数（run `…-lp-27`）：8 机位 × 4 根管的 `web_bg_ratio` **全 1.0**；游戏侧同格 0.16–0.24。
- 定位（逐段实测，不是猜）：原始导出 → 解析 → 装配 → 投影 → 采几何，五段逐一读数：

  | 段 | 读数 | 结论 |
  |---|---|---|
  | 导出件 `blockPalette[1..4]` | 174/188/188/188 quads，`decodeBlockGeometry` **skipped=0** | **导出没问题** |
  | `assemblePaletteContent` | `withGeometry: 1`，诊断 `blockGeometryNoAsset` × 4（"拓扑不合法（174 个四边形未产出资产）"） | 丢在这里 |
  | `blockGeometryAsset` | 管道 174 quads → **null**；箱子 18 quads → 资产 | 就是它 |
  | `meshTopology` | `InvalidValue / degenerateEdge` | 机械原因 |
  | `cellGeometry` | 只有 `"5,1,1"`（箱子），4 个管格**没有几何引用** | ⇒ 4 格空渲染 |

- 根因：每根管的四边里有 **8 个退化四边形**（两个角顶点**逐位相同** → 零面积；LP 的 Tessellator 对
  1/16 薄片本来就这么发，游戏里只是"什么也不画"）。`blockGeometryAsset` 为每个四边形的 4 条棱
  无条件建边 ⇒ 其中 8 条满足 `a === b` ⇒ `meshTopology` 以 `degenerateEdge` **拒绝整个拓扑**
  ⇒ `blockGeometryAsset` 返回 `null` ⇒ 该调色板条目"无几何" ⇒ **整格静默不渲染**
  （箱子 0 退化 ⇒ 不受影响。这同时解释了"把材质强改 `opaque` 重渲 PNG 逐字节相同"：根本没有几何）。
- 修法（消费端，一处）：`domain/blockGeometry#blockGeometryAsset` **跳过零长度棱**，四边形与面**原样保留**。
  不放宽 `meshTopology`（`degenerateEdge` 是"不许静默修正坏数据"的守卫，该留）；不丢四边形
  （`faces[k] === quads[k]` 是不变量，且丢它会破坏"装配 → 编码"逐字节往返）。
- 回归判据：`domain/__tests__/blockGeometry.test.ts` 新增 4 条（退化四边形仍产出资产、零长度棱不进拓扑、
  正常四边形仍 4 条棱、退化与正常混排 5 条棱）。**负对照**：禁用修复后 3 红 / 25 绿，恢复后 28/28 绿。
- 修后实测（同一份导出、同一批机位、未改任何产物）：
  - 采几何 `pieces` = **756**（管 174/188/188/188 + 箱 18），修前 **18**；5 个材质图元 560/472/376/68/36 三角形 = 1512 = 756×2；
  - 8 机位 `web_bg_ratio` 1.00 → **0.72–0.76**（游戏侧 0.16–0.24）；
  - 目视：4 根管**画出来了**（顶/底导轨 + 红绿连接点，位置与游戏一致）。对比图 `temp/pr91-lp-after/cmp-4views.png`。
- 判据仍 `fail`，但原因**换了**：`expect/tesr-pipes.json` 的逐管判据假设"实心方块"
  （`bg_ratio` 小于阈值才算内容），而 LP 管是**空心框**——游戏自己也只有 0.16–0.24 的内容比。
  这是本场景判据的标定缺口（应按"两侧相对差值"或按 `frame` 类型判），**不是**渲染缺陷。

## F13 · LP 管的接缝（竖直隔板）：**已修**——混合模式的 `depthWrite` 写错了

F12 修完后，游戏实拍与 Web 重渲逐机位对比（`temp/pr91-lp-after/zoom-seam.png`）：游戏在每两段管之间有
**竖直深色隔板**，Web 没有。三段取证（导出件 / 纹理 / GPU 缓冲逐条核过）：

| 段 | 读数 | 结论 |
|---|---|---|
| 导出件 | 每根管在 `x 0.438..0.562`（格中心）有 **16 个四边形**：前/后板（`z=0.1875 / 0.812`）、左右板、上下板 | 导出有 |
| 该处纹理 | 材质 `PipeModel`（blob 2，100×100）在 UV `0.87..0.97 × 0.00..0.30` 上 **100% 不透明** | 不是空纹理 |
| Web GPU 缓冲 | 逐网格读 `position`：格中心切片里 40–60 个三角形（含前板）；全场景 4536 顶点 = 756×6 | 装配有 |
| Web 像素 | 管带内游戏有 4 道 20 px 竖条，Web **一条都没有** | 没画出来 |

⇒ 只剩光栅阶段。**根因（实测）**：前板 `z=0.1875` 紧贴在两张**全透明**四边形（`z=0.1872`，材质
`new_texture/basic`，纹理是空图）之后仅 **0.0003**。游戏里前板可见 ⇒ MC 的混合 pass 不写深度；
而两条 Web 渲染链（`render/materials/simpleMaterialLibrary`、`presentation/presenter#createMaterial`）
都给了 `depthWrite: true` ⇒ 全透明的两张先写深度 ⇒ 前板被**深度剔除**。

**修法**：`domain/materialPass#materialPassStateOf` —— 混合模式 → `{transparent, alphaTest, depthWrite}`
的**唯一纯映射**（按 MC 三段 pass：opaque / cutout 写深度，**translucent 不写**），两条渲染链共用它。
判据 `domain/__tests__/materialPass.test.ts` 5 条（含"三种模式 depthWrite 不得同值"的负对照）。
提交 `8189c7f5`。

**修后实测**（同一份导出、同一批机位）：竖板回来了（`temp/pr91-lp-seamfix/cmp-seam.png`：上=游戏、中=修前、下=修后）；
`content_ratio` 全线上升（front 0.473→0.565、bottom 0.624→0.697、iso-se 0.35→0.467）。
判据仍 `fail` 的原因仍是 F12 记的那条标定缺口（期望值按实心方块写）。

## F14 · 箱子（TESR）导出坐标：**整块平移 + 盖子位移**，两处独立缺陷（实测）

同一份导出（run `…-lp-27`）里箱子 18 个四边形分三组盒子：箱体（`y −2.245..−1.620`）、盖子
（`y −1.620..−1.307`）、锁扣（`z 1.279..1.342`）。按该格（`x 68..69, y 12..13, z 63..64`）应有的格内坐标
（`x 1.5..2.44, y −0.5..0.44, z −0.5..0.44`）对照：

1. **整块平移**：箱体实测 `x 2.96..3.90, y −2.24..−1.31, z −0.47..0.40` ⇒ 相对应有坐标偏移 **(+1.46, −1.74, +0.03)**。
   三个盒子**同处这一个平移里** ⇒ 是一个**帧**（frame）错误，不是单个盒子错位。
2. **盖子位移**：盖子实测 `z 0.404..1.279` —— 比箱体整整多出一个箱子深度（+0.875）。
   与平移无关（同一帧内两处 z 不同）⇒ **模型变换（枢轴）** 也丢了。

代码依据（只读，未改）：捕获侧的"窗口系 → 块局部"只有一条减法
（`CaptureDumpAssembler.blockLocal(w, tessOffset) = w − tessOffset`，第 117 行），即**只补偿 Tessellator 的
`setTranslation`**；而原版箱子是用 **GL 状态**（`glTranslatef` + `glScalef(1,-1,-1)`）画 `ModelChest` 的
（`TileEntitySpecialRendererPostRenderStrategy` 只把 `staticPlayer` 钉到方块坐标再调 `renderTileEntityAt`）。
⇒ 该路径没有可减的 tessOffset，帧补偿**无从生效**。管线自己也**检测**到了这件事
（`blockLocal` / `tesrNonBlockLocal` 诊断码），但那只是**报告**，不改写产物。

**尚未证明的是"帧原点到底是谁"**（我试过用玩家姿态对：三份姿态的视点高度 12.62 / 14.62 都对不上实测平移量）。
判别实验（二选一，需一次客户端点火）：

1. `-Dsde.tesrCapture=off` 重导出：箱子的 18 quads 若消失 ⇒ 坐实 TESR 路径；
2. 把玩家挪到**很不一样**的位置重导出：平移量若按视点差等量变化 ⇒ 坐实"相机/视点帧"。

## F15 · 导出里两张 LP 纹理是"空/近空"（导出侧，未修）

- `logisticspipes:pipes/new_texture/basic`（blob 3）：18×18，**每个像素 (0,0,0,0)**。用它的是管内核上下
  表面（每格 8–10 个四边形，UV 全 0..1），因此在**任何**消费端都画不出东西。
- 另两张 `PipeModel*`（blob 0/1/2）是 **100×100**（不是 16×16），且**大面积透明**
  （blob 0 = 44.5% 全透明 / blob 1、2 = 34.3%）。是否与游戏侧纹理逐像素一致，**尚未核**；
  现在把它当已知量，不当结论。
## F16 · GG 反物质外壳（ACC，CTM 玻璃）：成对玻璃的**共享面被画出来**（web 侧已修；导出侧多录另计）

> 用户裁决（2026-10-20）：此前登记为「已知器具层差异」的 ACC 白框，**推翻**为缺陷。
> 本文件按机械读数逐段记：复现 → 根因 → 修后实测。截图证据在 `temp/pb-fix-translucent/`（临时目录，
> 结论与读数在本文件；需要长期留存的图按里程碑材料处理）。

### F16.1 复现（本批修复**前**，SHA 7cb442e4）

- **输入**：`temp/pb-refresh-acceptance/export/cp-gg-casing-r2.json`（#87 验收轮真实导出件，14 207 B，
  sha256 `28621a6ab0257f2ed9eb35aac0e08b8141dcc222af3bb4fdd7f0fa319cf5fe7e`）。
  本批把它复制成**夹具** `web/e2e/fixtures/gg-antimatter-casing-ctm-glass.json`（逐字节相同），
  使生产装配判据能吃真实输入（见 F16.3）。
- **路径**：**产品视口**（`npm run dev`，本树 test slot 5212；`OPERATOR_OPEN_SCENE` 注入 +
  `main.ensureCamera` 机位 yaw 235 / elev 22 / dist 12 / zoom 2.31 = 5×1×3 的自动 fit 缩放）。
  首帧取景与用户截图同形（透视斜视、结构占满画面）。
- **症状 1（邻接面错显）**：成对两格的**中间**浮出一个完整的白框环。
  截图 `temp/pb-fix-translucent/repro-before/vp-iso-a.png`（sha256 `1e124b02…c4ea6fb`）。
  游戏实拍同机位 `temp/pb-refresh-acceptance/caserun/shots/ortho-iso.png`（3× 放大版
  `temp/pb-fix-translucent/repro-before/game-iso-zoom.png`）**没有**这个环：
  成对的两块合起来只有**外侧框 + 一道中缝**。
- **症状 2（深度/穿透乱）**：这个环就在共享面上（2 层 × 2 侧 = **同平面 4 片**），斜视时与两侧玻璃互叠，
  看起来"互相穿透"。**正视图看不见它**：共享面与世界 x 面平行，`front`/`back` 机位里它退化成正投影线
  —— 这解释了历轮 `front`/`back` 的 `seam-glass-pair` 判据一直绿（判据位置对、可见性不对）。
- **症状 3（web 白框 / 游戏深框）**：**不是玻璃专属**，同图逐像素比可见它是**整体**亮度差：

  | 采样 | 游戏 | web | 比值 |
  |---|---|---|---|
  | 石料纹素（同一行同一列） | 89–100 | 127–143 | ≈0.70 |
  | 玻璃黑倒角 | 25 | 34 | ≈0.74 |
  | 玻璃白框（贴图原色 242,247,252） | 163–171 | 233–245 | ≈0.70 |

  ⇒ 游戏侧把整幅乘了光图（web 侧 `MeshBasicMaterial` 无光照）；贴图白框本色就是近白（242,247,252），
  不是 web 把它画错了颜色。而导出件的逐顶点 `brightness` 对这些面**恒为 `0xF00000`**
  （MC 打包：`sky<<20 \| block<<4` ⇒ sky 15 / block 0 = 满亮度）⇒ **只吃导出件无法复原那 0.70**。
  这属已登记的「光照模型（另立特性）」，`expect/*.json` 的 `normalize: per-face-luminance` 也据此只比色度。
### F16.2 根因：(a)–(d) 逐条判定（代码级 + 读数）

| 假设 | 判定 | 证据 |
|---|---|---|
| (a) 材质水合/装配链没把 `blend` 送到 `materialPassStateOf` 的消费点 | **证伪** | 生产链完整：`content.resources[].blend` → `runtime/presentationAdapter#structureMaterialGroups`（`asBlend`）→ `MaterialDescriptor.blend` → `presentation/presenter#createMaterial` → `materialPassStateOf`。判据 ④（真实信封）断言 ACC 两组材质 `blend==='translucent'` 且 pass 状态 `{transparent:true, alphaTest:0, depthWrite:false}`。若这条断了，玻璃中心会像 F2 那样**不透**，与现场（中心确实透出天空）不符。 |
| (b) 同一面多片 translucent quad 的绘制顺序 | **存在，但非本场景根因** | 事实：`structureMaterialPrimitives` 把**全场景同 `materialIndex` 的四边形并进一个 geometry**（本件只有两个半透明批次），且 `transparency` 恒为 `null` ⇒ 组内绘制顺序 = 采集顺序（`z,row,col`），three 的透明排序只作用于 object。但本场景的可见错显**全部**由 (c) 造成（修后同机位与游戏一致）；重叠的几片是同一平面同一贴图、α 只有 {0,255}（贴图直方图：`242..,255` 与 `0,0,0,0` 两类），同色叠加换序不改结果。真正的顺序风险属"不同深度上互遮的半透明面"，MC 同 pass 也不做三角形级排序 ⇒ 按 MC 保真口径不新造排序机制（列残余风险）。 |
| (c) 合面/邻接面合并对 translucent 的交互 | **证实 = 根因** | `render/mesh/structureGeometryCore` 判"邻格是不是同一方块"用的是 **palette 下标相等**（旧 `nidx === paletteIndex`，函数名 `shouldCullQuadFacingSamePaletteNeighbor`）。本件成对两格是 `blockPalette[2]` / `blockPalette[3]`（同 `registryId`、同 meta 0、无 facing/nbt，只是 CTM 象限贴图互为镜像）⇒ 判成"不同方块" ⇒ 共享面留在几何里。生产读数（真实信封 → 内核 → 投影 → 生产收集器）：关掉剔除 **102** 片 / 开剔除 **96** 片，差额 **6** = 成对共享面 **4**（每面 2 层 × 2 侧）+ magneticFlux↔gravityStabilization 的**不透明**邻面 2（另一条规则）。 |
| (d) 视口路径与离屏导出路径不一致 | **证伪** | 两侧同源：视口走 `composition/kernelPresentationInputs → runtime/presentationAdapter#structureMaterialPrimitives → collectStructureGeometryPiecesPure`；`OPERATOR_EXPORT_SHOT_PNG` 走同一 presenter/`compileScene`（差异只在机位与读回）。实测同一份导出件：**修前**的离屏 `ortho-iso`（`temp/pb-refresh-acceptance/web/web/ortho-iso.png`）与**修前**的视口截图（`repro-before/vp-iso-a.png`）都出现同一道共享面框环 ⇒ 一条路径上不存在另一条没有的问题。 |

**游戏侧锚点（版本已双核）**：`goodgenerator.blocks.regularBlock.BlockFrame`（运行期绑定 5.09.54.194 的
`GT5-Unofficial-5.09.54.194-dev.jar`，`javap -c` 复核字节码）：`isOpaqueCube()=false`、
`getRenderBlockPass()=1`、`renderAsNormalBlock()=false`，`shouldSideBeRendered()` 为
`getBlock(x,y,z) instanceof BlockFrame ? false : super…`（`instanceof` + `iconst_0 ireturn` 分支在字节码里可见）。
本地源码仓 HEAD 是 `5.09.52.525`（与运行期不同版本）⇒ 语义与符号按 **jar** 为准复核，源码只作可读参照。
⇒ **游戏侧剔除同块邻面**，判据是方块身份而非渲染变体；web 用调色板槽位当身份 ⇒ 同一方块的两个烘焙变体之间不剔除。

**修复落点**（机制级，非 ACC 专属）：`structureGeometryCore` 把"同一方块"的判据改为**方块状态**相等
（`registryId` + `meta` + `facing` + `nbt`，即 `VoxelState` 的四个字段 —— `render/data/grid#buildVoxelVolume` 还原的那一套），
不对任何方块类型写特判。取"同状态"而非 MC 的 `instanceof` 是**保守**选择：不改变既有夹具的剔除结果
（`domain/blockGeometry` 记的 `4882 → 4862` 那条历史观测仍成立），偏差方向只会"多画"，不会画出空洞。
### F16.3 修后实测（同一导出件、同一批机位）

| 项 | 读数 |
|---|---|
| 生产装配读数 | 剔除总量 102 → **96** 片；成对两格各 **34** 片（未剔除各 36）；Δ=6 = 共享面 4（2 层 × 2 侧）+ 不透明邻面 2 |
| 视口（同机位 yaw 235 / elev 22 / dist 12 / zoom 2.31） | 共享面白框环**消失**：成对玻璃回到"外侧框 + 一道中缝"，与游戏实拍同形（`repro-after2/vp-iso-a.png`） |
| 六轴器具（`shot-ortho.spec.ts`，port 5212） | `1 passed`，6 机位 1280×720；输出 `temp/pb-fix-translucent/web/` |
| 修前/修后**逐像素**（同机位、同输入、只换代码） | `south` / `north` / `east` / `west` / `top`：**0 px 差**；`iso`：**2667 px 差**（maxd 224，差异区域 72×122@495,280 = 共享面处）—— 修复的作用面精确等于"只有斜视看得见的共享面" |
| 三对齐目验（`sbs/sbs-ortho-*.png`，左=游戏实拍 / 右=web 修后） | `iso` 与游戏同形（成对=外侧框+中缝，孤立 ACC 六面框完整）；其余五机位与修前逐像素相同（游戏侧差异仍是已登记的整体亮度与底色常量） |
| 3× 放大三方对照 | `sbs/zoom-iso-game-prefixweb-postfixweb.png`（左=游戏 / 中=web 修前 / 右=web 修后）：修前中间多出共享面框环，修后与游戏一致 |
| L0 | `npm run typecheck`：仅 4 条既有登记错误（#407）；`npm run arch:scan`：**PASS（0 finding）** |
| L1 | `npm test`：**3145 passed / 1 failed**（唯一红 `partMaskEnvelopeExemption` 为既有：缺 mod 侧脚本）；`npm run test:arch`：**265 passed / 5 skipped / 0 failed**（270） |
| L2 | `PLAYWRIGHT_PORT=5212 npm run test:e2e:smoke`：**26 passed / 0 failed / 2 skipped**，墙钟 26.3 s（预算 120 s 硬限） |
| L3 | **未跑**（未获授权） |

**残余差异（都不是本缺陷）**：① 整体亮度：游戏乘光图、web 无光照（本篇 F16.1 已量化 ≈0.70，属"光照模型"另立特性）；
② 底色常量 `#BCD5FF` vs `#9EC6E8`（已登记）；③ `ortho-top` 游戏侧那块大白面（已登记）。

### F16.4 捕获侧判定：共享面**确实多录**了（建议另立单，不在本批范围）

- **读数**：同一份导出件里，成对两格朝共享面的四边形**都在**（左格 `+x` 2 片、右格 `-x` 2 片，每面 2 层）。
- **游戏侧行为**：`BlockFrame#shouldSideBeRendered` 在邻格是 `BlockFrame` 时**返回 false**
  （运行期 jar 5.09.54.194 `javap -c` 复核：`getBlock(...) instanceof BlockFrame` + `iconst_0 ireturn`）
  ⇒ 游戏**从不发**这个面。
- **判定**：导出侧**多录**（捕获未按 `shouldSideBeRendered` 剔除同块邻面）。**建议另立捕获侧单**
  同批核实两件事：(a) 同块邻面剔除；(b) 每面 **2 层完全相同的四边形**（位置/UV/材质/brightness 逐字段同，
  实测每格 36 = 2 × 18）——本批**不判**它是缺陷：若游戏确实两遍渲染则是忠实记录，若是重复录制则是捕获缺陷；
  两种情况下对本批症状都无影响（贴图 α 只有 {0,255}，叠两遍不变色），但对**真半透明**贴图会双重混合。
- **为什么 web 侧仍必须修**：捕获多录只是"多给了面"，而"该不该画"是渲染期的判据（游戏在渲染期剔除）；
  消费端不得依赖捕获端预先剔除（OBJ 导出、其他消费端同样吃这份数据）。⇒ 两侧各自成立，web 侧已修并有用例把守。

### F16.5 遗留风险

1. **同一批次内 translucent 三角形的绘制顺序**不是深度序：`structureMaterialPrimitives` 把全场景同 `materialIndex`
   的四边形并进一个 geometry，`transparency` 恒 `null`（`runtime/presentationAdapter.ts`）⇒ three 的透明排序
   只作用于 object。本场景无影响（同一平面同一贴图、α∈{0,255}），但"不同深度上互遮的半透明面"仍依赖绘制顺序。
   MC 同 pass 也不做三角形级排序，故本轮**不新造排序机制**；若将来要与游戏逐像素对齐，这是要单独立项的课题。
2. **判据偏窄**（有意）：身份取 `registryId+meta+facing+nbt`，比 MC 的 `instanceof` 窄。跨 meta/facing/NBT 的同方块邻面
   仍会多画（有深度兜底，只在半透明时可见）。要放宽须先有"哪些差异不影响邻面渲染"的证据。
3. 三条正视图判据（`front`/`back`/`seam-*`）**看不见**这类缺陷（共享面在正视图里退化成线）。
   以后凡"同块邻面/内部结构"类判据，必须至少含一台**斜视**机位。
