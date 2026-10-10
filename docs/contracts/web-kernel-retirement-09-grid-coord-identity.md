# 退役 #9（`grid-coord-as-identity`）· 语义替代与删除点清单（P3）

> **地位**：#254（P3）对 #249 §15 第 9 条「格坐标/批次序号兼任对象身份 → 对象/元素引用
> 与来源映射」的可执行交接物。**本文件不是设计文档**，是给 **P5（#256）** 与
> **P11（#262）** 的**删除点清单**与**替代语义索引**。
>
> **为什么单列成文件而不写进 issue**：#250 与工作区规则要求"要改变 Agent 行为的裁决
> 当场蒸馏进指令或契约"。文件在 `docs/contracts/` 下与代码同生共死（改替代实现必须同 PR
> 改本文件），而 issue 正文会随讨论漂移。

---

## 0. 为什么 P3 只交付"语义 + 清单"而不直接删文件

#254 委派约束明文：

> 注意 `render/` 内文件本体由 **P5 重写** —— 你交付**身份/映射语义与删除点清单**，
> **跨区旧文件不直接动**（避免与 P5 写冲突）。

故本文件的作用是让 P5 的退役**不需要重新推导语义**：每一条删除点都指出
① 旧形态在哪、② 它错在哪、③ P3 提供的替代是什么、④ 删除后的可执行判据是什么。

**"删了但没接上替代"是本条退役最常见的失败**（#249 §15 明文要求"移动、分批、
撤销后身份测试稳定"）—— 故清单里每条删除点都配一条**已经存在并通过**的替代实现或
测试，P5 删旧实现时可直接引用。

---

## 1. 三条旧形态（删除点清单）

### D1 · `blockMesh.ts` 的 `batchIdx`

| 项 | 内容 |
|---|---|
| 位置 | `web/src/render/mesh/blockMesh.ts:114`（`let batchIdx = 0`）、`:132`（`mesh.renderOrder = … : batchIdx`）、`:135`（`batchIdx++`） |
| 旧形态 | 批次循环的**局部递增整数**同时充当 ① `renderOrder` 缺省值与 ② 网格的隐含身份 |
| 错在哪 | 重新分批 / 移出一个对象 / 改变分组顺序后，**同一序号指向另一个对象**。A18 负对照原文即「把 batch index 当对象 ID」必须判红 |
| P3 替代 | `domain/geometry#LocalOrdinal` 仅为**局部序号**；取身份**必须**经 `GeometrySourceMap` + `resolveByOrdinal` 回表 |
| 已通过的判据 | `geometryOwnership.test.ts > **负对照**：把局部序号当身份 ⇒ 重新分批后"身份"指向了另一个对象（判红）`；`> 重新分批（改变局部序号）后，对象身份与元素身份**不变**` |
| 删除后应保持 | 呈现侧仍可用局部序号做**排序/绘制顺序**（那是它的正当用途），但它**不得**出现在任何"对象/元素身份"字段、拾取映射的键、或选择/动画轨道的目标里 |
| 归口 | **P5（#256）** 重写 `render/` 时删除；**P11（#262）** 终局审计"零身份用途" |

### D2 · `materialTypes.ts` 的帧号+下标派生身份 / `materialPaletteBridge.ts` 的 `String(i)`

| 项 | 内容 |
|---|---|
| 位置 | `web/src/pure/materialTypes.ts:39`（注释即规范：「键由 … World 多帧 `frameIndex:localIndex` 派生」）、`web/src/pure/materialPaletteBridge.ts:20-25`（`indexedRegistryFromMaterialPalette` 用 `String(i)` 作键） |
| 旧形态 | 材质身份 = 数组下标（单结构）或 `帧号:槽号`（World 多帧） |
| 错在哪 | **插入一个调色板条目即让所有后续材质换身份**；同一份内容在不同帧序下得到不同身份。这是 §15 第 9 条"批次序号兼任身份"的材质版本 |
| P3 替代 | 材质身份须由**具名领域数据**决定（`BlockCellDomainData` / `blockCellIdentityKey` 的同一思路：只由内容身份构成，与枚举顺序无关） |
| 已通过的判据 | `geometryOwnership.test.ts > 元素身份不由下标决定`、`> 顶点身份按**语义角色**构造（不随枚举顺序漂移）`（同一政策在顶点上的可执行证明） |
| 删除后应保持 | `MaterialRegistryData.materials` 的键**可以**继续是字符串，但必须是**内容身份**（如 locator + 内容版本），不得是"帧号:下标"这类**位置**编码 |
| 归口 | **P5（#256）** 重写 `render/` 时删除；P4（#255）已接管材质/纹理序列的求值面 |
| 备注 | `materialTypes.ts` 与 `materialPaletteBridge.ts` 在 `pure/`（旧层），**不属** P3 写权范围 |

### D3 · `bundleResolve.ts` 的合成键

| 项 | 内容 |
|---|---|
| 位置 | `web/src/render/data/bundleResolve.ts:23`（`World：materialId = \`${frameIndex}:${slotIndex}\``） |
| 旧形态 | **合成键**（帧号 + 槽号拼接）当材质身份 |
| 错在哪 | 同上 D2；且它把"帧"这一**时间/播放**维度混进了**身份** —— 换帧序即换身份，而身份应跨保存/重开稳定（#249 §3.1） |
| P3 替代 | 同 D2 |
| 归口 | **P5（#256）** |

---

## 2. 替代语义索引（P5/P11 消费面）

| 需要什么 | 用哪个 | 位置 |
|---|---|---|
| 稳定的顶点/边/面身份 | `VertexId` / `EdgeId` / `FaceId` | `domain/geometry.ts` |
| 跨边界携带子元素引用 | `ElementRef{ elementId, topologyVersion }` | `domain/identity.ts`（契约 §1.2） |
| 解析元素引用（**先验版本**） | `resolveVertex` / `resolveEdge` / `resolveFace` / `resolveElement` | `domain/geometry.ts` |
| 对象/数据/元素 → 局部序号映射 | `buildGeometrySourceMap` / `resolveByOrdinal` / `consumersOfData` | `domain/geometry.ts` |
| 共享几何的消费者（A07 事实） | `GeometrySourceMap.byData` | `domain/geometry.ts` |
| 共享判定的单一实现点 | `objectsSharingData` / `isDataShared` | `domain/scene.ts` |
| 拓扑版本（供 `ObjectData`） | `topologyVersionOf(payload)` | `domain/geometry.ts` |
| 具名 MC 身份键（与坐标无关） | `blockCellIdentityKey` | `domain/geometry.ts` |
| 顶点写（唯一写路由） | `setProperty` + `PropertyRef.element`（属性 `mesh.vertexPosition`） | `application/commands.ts` |

---

## 3. 当前**未**迁移的旧消费者（留给 P5/P11 的诚实账）

P3 的写权边界是 `web/src/domain/`、`web/src/application/`、`web/tests/architecture/`。
下列旧消费者**仍在**用旧形态，P3 **未**动它们（避免跨区写冲突）：

| 旧消费者 | 旧身份/序号用法 | 归口 |
|---|---|---|
| `render/mesh/blockMesh.ts` | D1（`batchIdx`） | P5（#256） |
| `render/interaction/scenePick.ts` | `blockId`/`column`/`row`/`zSlice` 作为拾取结果字段（不含对象身份） | P5（#256） |
| `render/data/bundleResolve.ts` | D3（合成键） | P5（#256） |
| `pure/materialPaletteBridge.ts` | D2（下标键） | P5（#256） |
| `runtime/hover/state.ts`、`viewer/tooltip.ts` | 以 `blockId` 作悬停/提示标识 | P5/P6 |
| `context/queries.ts` | `materialId: String(i)` | P9 收口（文件适配） |
| `workbench/ux/panels/useMaterialAnimation.ts` | `materialId` 作动画 canvas 键 | P4（#255，B5 已定） |

**P11（#262）的终局判据**（#249 §15 原文）：「移动、分批、撤销后**身份测试稳定**」。
它需要的不是"这些文件被删"，而是"**身份不再由位置/序号派生**" —— 即上表每一行
或已被替代实现接管、或已被证明与身份无关。

---

## 4. 本单的诚实边界

1. **P3 没有改 `render/` 的任何文件**：上表所有旧消费者原样保留。故"退役 #9 已完成"
   **不成立** —— 成立的是"退役 #9 的**语义替代已交付且被测试证明**，删除点已定位"。
2. **P3 的替代实现尚未被生产路径消费**：`domain/geometry` 的消费者目前只有本批测试
   与 `application/commands.ts` 的顶点写。生产渲染路径改用来源映射是 **P5** 的活。
3. **`Grid` 的格坐标仍用于结构语义**（`context/grid.ts`）：格坐标作为"结构内的位置"
   是**正当**的（它就是位置）；本条的退役对象是"格坐标**兼任对象身份**"。
   两者不可混为一谈 —— 故清单里没有把 `grid.ts` 列为删除点。

---

## 5. 修订记录

| 版本 | 日期 | 条目 | 依据 |
|---|---|---|---|
| v1 | 2026-10-11 | 首次交付：D1/D2/D3 删除点、替代语义索引、未迁移消费者诚实账、P11 终局判据 | #249 §15 第 9 条 + §14 A07/A18；#254 委派约束（跨区旧文件不直接动） |
