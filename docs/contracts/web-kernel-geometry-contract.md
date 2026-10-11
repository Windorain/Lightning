# Web 内核 · 几何与坐标数学契约（P3）

> **地位**：本文件是 #254（P3「几何、坐标关系与固定拓扑形变」）交付的**数学契约**：
> 坐标约定、仿射表达、枢轴语义、父链规则与**数值容限**的权威来源。
> 与代码同生共死：改 `web/src/domain/spatial.ts` / `geometry.ts` 的实现必须同 PR 改本文件。
>
> **它的边界**（#254 验收 E2 明文）：本文件只冻结**数学**。
> 某个**具体外部格式**的轴序/原点 `AxisProfile` 构造属 **#260（适配器）**，
> 不在本文件也不在本批代码里 —— 本批不含任何格式名、不含 `.nbt`/`.mcmeta` 之类知识。

---

## 1. 数值与空间误差容限（E3）

#249 §19.2 末段：「数值与空间误差容限在**数学契约**和测试中明确，**不任意四舍五入到整数**」。

| 常量 | 值 | 语义 |
|---|---|---|
| `MATH_CONTRACT.positionEps` | `1e-9` | 位置/长度的绝对容限（场景单位） |
| `MATH_CONTRACT.rotationEps` | `1e-9` | 四元数分量容限（已归一化，量级 1） |
| `MATH_CONTRACT.scaleEps` | `1e-9` | 缩放分量容限（无量纲） |
| `MATH_CONTRACT.pivotEps` | `1e-9` | 枢轴比较容限（场景单位） |
| `MATH_CONTRACT.shearEps` | `1e-9` | 判定"仿射带剪切"的容限 |
| `MATH_CONTRACT.singularDeterminantEps` | `1e-12` | 判定"不可逆"的 3×3 行列式下限 |
| `MATH_CONTRACT.unitScaleEps` | `1e-9` | 单位向量/正交性容限 |

**取值依据**（不是随手定的）：

- IEEE-754 `double` 约 15–17 位十进制有效数字；
- 场景坐标量级 10⁰–10⁶（MC 1 格 = 1 场景单位、世界高度 10²、结构尺寸 10³）；
- 故 `1e-9` 足以容纳 10⁶ 量级上的累积舍入误差（10⁶ × 10⁻¹⁵ ≈ 10⁻⁹），
  同时远小于任何有意义的建模精度（10⁻⁹ 单位 = 纳米级）。

**两条可执行保证**：

1. **非有限值判不等**：`approxVec3(NaN, NaN)` 返回 `false`。
   `NaN` 与自身"相等"会让损坏的变换被当成一致，从而掩盖真实缺陷。
2. **不四舍五入**：`web/src/domain/spatial.ts` 内**不出现**
   `Math.round` / `toFixed` / `Math.trunc`；`Math.floor` **只**出现在显式命名的
   `pixelSnap(value, gridSize)`（像素吸附工具），且**没有**任何求值路径调用它。
   由 `web/src/domain/__tests__/mathContract.test.ts` 的静态判据逐字断言（含负对照）。

**大动态范围的显式误差预算**：缩放跨 6 个数量级（如 `1000` 与 `0.001` 同存）时，
往返测试使用放宽到 `1e-6` 的**显式**预算（而非悄悄调大 `MATH_CONTRACT`）。

---

## 2. 坐标约定：右手、Y-up

```
handedness = 'right'
up         = 'y'
right      = (1, 0, 0)
upVector   = (0, 1, 0)
forward    = (0, 0, −1)
```

**判据**（`isRightHandedYUp`，三条缺一即 false）：

1. 三个基向量两两正交；
2. 三者均为单位向量；
3. `cross(right, upVector) === −forward` —— 右手系的**定义**。

把 `forward` 写成 `+z`（左手系的常见笔误）会使第 3 条失败 ⇒ 约定可被证伪，
而不是靠读代码推断。`isRightHandedYUp` 的参数类型是 `CoordinateConvention`
（而非 `typeof COORDINATE_CONVENTION`），**专门为**让负对照在类型层面可写。

### 单位映射

「Minecraft 单位默认映射**一个场景单位**」是**约定**，其**具体**执行（某格式的
轴序翻转、原点平移、单位换算）**只在适配器**（`adapters/files`，实现归 #260）。
本批的 `domain/spatial` 不含任何格式知识。

---

## 3. 仿射表达（不丢剪切）

### 3.1 存储与读法

`Affine` 是 4×4 矩阵，**列主序**存储（`m[12..14]` 是平移，与 Three.js
`Matrix4.elements` 同布局）。

> **陷阱**：存储数组的"行主序读法"是实际矩阵的**转置**。故本模块内部
> **只**经 `at(m, row, col) = m[col * 4 + row]` 访问分量，所有几何量
> （点变换、行列式、逆、列向量）都从 `at` 推导。构造侧用
> `affineFromRows(行主序 16 个分量)`，避免手写列主序。

`multiplyAffine(a, b)` 的语义是**教科书约定**：`M_a · M_b`（先应用 `b`，再应用 `a`）。

### 3.2 变换语义

`Transform`（TRS + pivot）→ 仿射是**单射**：

```
M = T(position) · R(rotation) · S(scale) · T(−pivot)
```

即对象空间一点 `p ↦ position + R·S·(p − pivot)`。`pivot` 是**局部空间**里落在
`position` 的那个锚点（旋转与缩放绕它发生）。

### 3.3 反向分解：可能丢剪切 ⇒ 显式拒绝

`decomposeTrs(m)` 返回 `Result`。拒绝条件（全部显式，附结构化参数）：

| 条件 | 错误 | 参数 |
|---|---|---|
| 奇异（`|det| ≤ 1e-12`） | `InvalidValue` | `reason: 'singularTransform'`, `det` |
| 镜像（`det < 0`） | `InvalidValue` | `reason: 'handednessFlip'`, `det` |
| 带剪切（剪切量 > `shearEps`） | `InvalidValue` | `reason: 'lossyTrsDecomposition'`, `shear` |

**剪切量** `shearMagnitude(m)`：3×3 部分各列归一化后，两两夹角余弦绝对值的最大值。
纯旋转/缩放（含非均匀缩放）的列为正交 ⇒ 0。

**枢轴不猜**：枢轴是创作事实，数学上不可从矩阵唯一恢复
（`T(p)·R·S·T(−pivot)` 对不同 `pivot` 可给出同一矩阵）。故 `decomposeTrs` 返回的
`pivot` 恒为零，且**文档明确**"枢轴必须由调用方显式给出"。静默编造一个枢轴正是
A26 负对照要判红的形态。

拒绝而非丢弃，就是 #249 §19.2「**不以有损 TRS 分解悄悄丢剪切**」的落点。

---

## 4. 逆变换：奇异明确拒绝

`invertAffine(m)` 返回 `Result`。拒绝条件：

| 条件 | 错误 | 参数 |
|---|---|---|
| 最后一行不是 `[0,0,0,1]` | `InvalidValue` | `reason: 'notAffine'`, `det` |
| `|det| ≤ singularDeterminantEps` | `InvalidValue` | `reason: 'singularTransform'`, `det` |

**判据为什么不是 `det === 0`**：浮点下"数学上奇异"的矩阵其行列式常是一个
~1e-17 的非零小数。取 `1e-12` 意味着"某轴缩放 < 1e-4"被判不可逆 —— 这是**有意**的：
那种变换在场景单位下已无法稳定求逆（1e-4 单位 = 0.1 微米）。

---

## 5. 枢轴语义：持久枢轴 vs 多选工具枢轴

#249 §19.2：「对象有局部变换和**显式原点/枢轴**语义…对象原点**不是**随网格包围盒
变化而自动移动的中心」+「多选默认使用**选择包围盒中心**作为共同变换枢轴…
**策略是工具参数**，不是另一套几何算法」。

| | 持久枢轴 | 多选枢轴 |
|---|---|---|
| 字段 | `Transform.pivot`（`domain/scene`） | `PivotStrategy`（`domain/spatial`） |
| 生命周期 | 随文档保存 | 一次交互，结束即失效 |
| 谁写 | 创作（属性命令） | 工具（读面计算，**从不**写入对象） |
| 求值 | 参与 `toAffine` | 只作为该次变换的参照点 |

**三种策略**（共用同一份"取世界位置 → 求枢轴"算术）：

| `kind` | 语义 |
|---|---|
| `selectionBoundsCenter`（默认） | 所有选中对象**世界 AABB 并集**的中心 |
| `activeObjectOrigin` | 活动对象的世界原点 |
| `individualOrigins` | 逐对象各自原点（`individualPivots` 给出逐个值） |

`selectionBoundsCenter` **不是**"各对象原点平均"：前者是包围盒并集的中心，
两者在有尺寸差异时不同（`coordinatesRelations.test.ts` 用 A 尺寸 4、B 在 x=10
的用例锁定：4.25 vs 5）。

**负对照**：把 `boundsCenter(...)` 写进 `transform.pivot` ⇒
"持久枢轴不变"断言器判红。

---

## 6. 父链与集合

- **世界变换**：`W = M_root · … · M_parent · M_local`（左乘祖先）。
- **无环**：`sceneParentChain` 判环；有环 ⇒ `worldMatrix` 返回
  `InvalidValue{reason:'parentCycle'}`（**不**递归到栈溢出，**不**"取一段当父"）。
- **准入判据**：`canParent(scene, childId, parentId)` 在挂接**之前**判环
  （自环、经候选父向上遇到 child、既有环都拒绝）—— 于是"先设父子再发现成环"不可发生。
- **集合不形成变换父子**：#249 §19.2 明文。`ObjectCollection.members` 与
  `SceneObject.parentId` 是两个不同字段；父链求值**只**看 `parentId`。
  测试断言"把对象加入集合不改变其世界矩阵"。
- **奇异/退化**：`localMatrix` 对非有限分量（`nonFiniteTransform`）与零长度旋转
  （`degenerateRotation`）显式拒绝。

---

## 7. 轴序 / 原点 profile（E2）

```ts
interface AxisProfile {
  id: string
  permutation: [number, number, number]   // 输出轴取自输入分量的下标
  signs: [number, number, number]         // 各输出轴的符号（±1）
  origin: Vec3 | null                     // 原点平移（场景单位）
}
```

`applyAxisProfile(p, profile)` 按 profile 做**纯数学**。`profile` 是**显式数据** ——
本模块不含"格式名 → 约定"的映射（那会诱使"凭名称猜矩阵约定"，#249 §19.2 明令禁止）。

### 固定样本期望（`AXIS_PROFILE_SAMPLES`）

| 样本 | `permutation` | `signs` | `origin` | 输入 | 期望 |
|---|---|---|---|---|---|
| `identity` | `[0,1,2]` | `[1,1,1]` | `null` | `(1,2,3)` | `(1,2,3)` |
| `yUpToZUp` | `[0,2,1]` | `[1,1,−1]` | `null` | `(1,2,3)` | `(1,3,−2)` |
| `yUpToZUpWithOrigin` | `[0,2,1]` | `[1,1,−1]` | `(0,0,64)` | `(1,2,3)` | `(1,3,62)` |

**期望值是手算的**（推导写在测试里），不是"跑一遍实现再抄下来"。
`checkAxisProfileSamples()` 返回不一致项的描述（空数组 = 全通过）。

**为什么样本含两个不同轴序**：若有人忽略 profile 直接返回输入，
`yUpToZUp` 立刻判红 —— 于是"profile 真的被使用"是被**证明**的，而不是被假设的。

### 本批与 #260 的切分

| 面 | 归属 | 验收方式 |
|---|---|---|
| 数学（给定正确 profile 得到正确结果） | **本批（#254）** | 固定样本 + `checkAxisProfileSamples` |
| 某具体格式的 profile 构造正确 | **#260（适配器）** | 该格式的往返验收 |
| 适配器输出经往返后语义保真 | **#260** | 真实夹具往返 |

这个切分让"适配器写错了 profile"与"数学算错了"**不会长得一模一样**。

---

## 8. 与 P1 体系的关系（不另起平行结构）

本批的几何**就是**对象数据的一种载荷：

```
Scene → SceneObject.dataId → ObjectData.payload(kind: 'mesh') → MeshData
                                └── topologyVersion ← 由 MeshData.topology.version 导出
```

- `ObjectData.topologyVersion` 由 `topologyVersionOf(payload)` **导出**
  （P1 曾硬编码 `0`，会让 `StaleReference` 永不触发）；
- `ObjectData.contentVersion` 用键序稳定的 `digestOf`（原 `JSON.stringify` 会因
  键序不同而误判"仍脏"）；
- 顶点写走**既有** `setProperty` 路由（`PropertyRef.element` 承载子元素寻址），
  **不**新加命令。

### 8.1 合流后（GF-5 收敛，P2 #253）的落点更正

P2 的 GF-5 收敛把属性语义的唯一权威从 `commands.ts` 的内联白名单移到 **RNA 注册表**，
故上一条里"由 `commands.ts#validatePropertyWrite` 自动覆盖"的表述**已失效**。
当前的正确落点：

| 面 | 落点 | 说明 |
|---|---|---|
| 属性声明（含 `vertexPosition`） | `application/kernel-properties.ts` 的 `KERNEL_OBJECT_TYPES` | 走公开注册路径；`vertexPosition` 标 `animatable: false` |
| 元素引用过期判定 | `application/properties.ts#staleReason(ref, facts)` | `facts.topologyVersion` ← `ObjectData.topologyVersion`（即本模块 §8 第 1 条的导出值） |
| 顶点写应用 | `kernel-properties.ts#applyKernelPropertyValue` | 交给 `commitGeometryEdit`（按对象独立编辑，A07） |
| 顶点读面 | `kernel-properties.ts#readRawKernelValue` | **必需**：`applySetProperty` 的"无变化 ⇒ unchanged"（D5）依赖它；缺读面会把"写相同值"误报 `applied` |
| 类型能力（`dataKind`/`editable`） | `domain/scene.ts` 的 `DEFAULT_TYPES` | `domain/` 不得 import `application/`，故此处**必须**单独登记 `mesh` |

**两处登记是分工而非重复**：`domain` 侧供能力/呈现查询，RNA 侧供逐属性描述与值域。
任一缺失都表现为**显式失败**（类型级查询判未知 / 属性写判 `property-not-registered`），
不是静默半可用。

**A08 原子性不变量在新形态下的承担者**：`applySetProperty` 的三阶段
（① 全量预检 → ② 无变化判定 → ③ 单次提交）。本模块的 `vertexPosition` 写
**不新增**第二个校验入口 —— 过期判定统一由 `staleReason` 在预检阶段完成，
写应用只在**已通过预检**的引用上执行。

---

## 9. 修订记录

| 版本 | 日期 | 条目 | 依据 |
|---|---|---|---|
| v1 | 2026-10-11 | 首次冻结：容限表、右手 Y-up 判据、仿射/剪切/逆、枢轴两类语义、父链与集合、轴序 profile 与固定样本、与 P1 的接入关系 | #249 §3.1/§3.2/§14 A07/A26/§19.2；#254 正文与验收 E1/E2/E3 |
| v1.1 | 2026-10-11 | §8.1 新增：合流 GF-5 收敛后的落点更正（属性声明/过期判定/写应用/读面/两处登记分工、A08 承担者） | P2 #253 合入 `integration/web-kernel` @ `96b2e3b`；#250 收敛裁决 |
