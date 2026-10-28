# Web 内核 · 几何与坐标数学契约

本文件定义场景坐标、仿射变换、枢轴、父链与轴序 profile 的数学契约及数值容限。实现位于 `web/src/domain/spatial.ts` 与 `web/src/domain/geometry.ts`。

本文件只定义数学。具体外部格式的轴序与原点 `AxisProfile` 由适配器（`adapters/files`）构造，本文件不含格式名。

## 1. 数值与空间误差容限

`MATH_CONTRACT` 是容限的唯一来源，测试直接引用该对象，不各写一份魔数：

| 常量 | 值 | 语义 |
|---|---|---|
| `positionEps` | `1e-9` | 位置/长度的绝对容限（场景单位） |
| `rotationEps` | `1e-9` | 四元数分量容限（已归一化，量级 1） |
| `scaleEps` | `1e-9` | 缩放分量容限（无量纲） |
| `pivotEps` | `1e-9` | 枢轴比较容限（场景单位） |
| `shearEps` | `1e-9` | 判定仿射带剪切的容限 |
| `singularDeterminantEps` | `1e-12` | 判定不可逆的 3×3 行列式下限 |
| `unitScaleEps` | `1e-9` | 单位向量/正交性容限 |

`1e-9` 覆盖 10⁶ 量级上的累积舍入误差（IEEE-754 `double` 约 15–17 位十进制有效数字），同时远小于建模精度。

两条可执行约束：

1. 非有限值判不等：`approxVec3(NaN, NaN)`、`approxQuat`、`approxNumber` 对 `NaN`/`Infinity` 返回 `false`。
2. 不四舍五入：`web/src/domain/spatial.ts` 不出现 `Math.round`、`toFixed`、`Math.trunc`；`Math.floor` 只出现在 `pixelSnap(value, gridSize)`，且没有求值路径调用它。`mathContract.test.ts` 对此做静态断言。

跨 6 个数量级的缩放往返测试使用显式放宽到 `1e-6` 的预算，不修改 `MATH_CONTRACT`。

## 2. 坐标约定

```
handedness = 'right'
up         = 'y'
right      = (1, 0, 0)
upVector   = (0, 1, 0)
forward    = (0, 0, −1)
```

`isRightHandedYUp` 的三条判据缺一即 `false`：

1. 三个基向量两两正交。
2. 三者均为单位向量。
3. `cross(right, upVector) === −forward`。

`forward` 写成 `+z` 时第 3 条失败。参数类型为 `CoordinateConvention`，负对照可以构造违反约定的输入。

Minecraft 单位默认映射一个场景单位；轴序翻转、原点平移与单位换算只发生在适配器。`domain/spatial` 不含格式知识。

## 3. 仿射

### 3.1 存储与读法

`Affine` 是 4×4 矩阵，列主序存储：`m[12..14]` 是平移。分量只经 `at(m, row, col) = m[col * 4 + row]` 访问；构造侧用 `affineFromRows(行主序 16 个分量)`。

`multiplyAffine(a, b)` 等于 `M_a · M_b`，即先应用 `b`，再应用 `a`。

### 3.2 变换语义

`Transform`（TRS + pivot）到仿射是单射：

```
M = T(position) · R(rotation) · S(scale) · T(−pivot)
```

对象空间一点满足 `p ↦ position + R·S·(p − pivot)`。`pivot` 是局部空间中落在 `position` 的锚点。

### 3.3 反向分解

`decomposeTrs(m)` 返回 `Result`。拒绝条件：

| 条件 | 错误参数 |
|---|---|
| 奇异（`\|det\| ≤ 1e-12`） | `InvalidValue{reason:'singularTransform', det}` |
| 镜像（`det < 0`） | `InvalidValue{reason:'handednessFlip', det}` |
| 带剪切（剪切量 > `shearEps`） | `InvalidValue{reason:'lossyTrsDecomposition', shear}` |

剪切量 `shearMagnitude(m)` 是 3×3 部分各列归一化后，两两夹角余弦绝对值的最大值。纯旋转/缩放为 0。

枢轴不从矩阵猜测：`T(position)·R·S·T(−pivot)` 对不同 pivot 可给出同一矩阵。`decomposeTrs` 返回的 `pivot` 恒为零，调用方必须显式提供枢轴。

## 4. 逆变换

`invertAffine(m)` 返回 `Result`。拒绝条件：

| 条件 | 错误参数 |
|---|---|
| 最后一行不是 `[0,0,0,1]` | `InvalidValue{reason:'notAffine', det}` |
| `\|det\| ≤ singularDeterminantEps` | `InvalidValue{reason:'singularTransform', det}` |

判据不是 `det === 0`：数学上奇异的矩阵在浮点下的行列式常为 `~1e-17` 的非零小数。`1e-12` 意味着某轴缩放小于 `1e-4` 即判不可逆。

## 5. 枢轴

对象有局部变换与显式原点/枢轴；原点不随网格包围盒自动移动。多选默认使用选择包围盒中心作为共同枢轴，策略是工具参数。

| | 持久枢轴 | 多选枢轴 |
|---|---|---|
| 字段 | `Transform.pivot` | `PivotStrategy` |
| 生命周期 | 随文档保存 | 一次交互，结束即失效 |
| 写入者 | 属性命令 | 工具只读计算，不写对象 |
| 求值 | 参与 `toAffine` | 作为该次变换的参照点 |

策略：

| `kind` | 语义 |
|---|---|
| `selectionBoundsCenter`（默认） | 所有选中对象世界 AABB 并集的中心 |
| `activeObjectOrigin` | 活动对象的世界原点 |
| `individualOrigins` | 逐对象各自原点，`individualPivots` 给出逐个值 |

`selectionBoundsCenter` 不是各对象原点的平均。把包围盒中心写入 `transform.pivot` 会使持久枢轴断言失败。

## 6. 父链与集合

- 世界变换：`W = M_root · … · M_parent · M_local`，左乘祖先。
- `sceneParentChain` 判环；有环时 `worldMatrix` 返回 `InvalidValue{reason:'parentCycle'}`，不递归、不截断父链。
- `canParent(scene, childId, parentId)` 在挂接前判环：自环、经候选父向上遇到 child、既有环都拒绝。
- 集合不形成变换父子：`ObjectCollection.members` 与 `SceneObject.parentId` 是两个字段，父链求值只看 `parentId`。把对象加入集合不改变其世界矩阵。
- `localMatrix` 对非有限分量返回 `InvalidValue{reason:'nonFiniteTransform'}`，对零长度旋转返回 `InvalidValue{reason:'degenerateRotation'}`。

## 7. 轴序 / 原点 profile

```ts
interface AxisProfile {
  id: string
  permutation: [number, number, number]
  signs: [number, number, number]
  origin: Vec3 | null
}
```

`applyAxisProfile(p, profile)` 按 profile 做纯数学：`permutation` 选择输入分量，`signs` 取符号，`origin` 做场景单位平移。profile 是显式数据，本模块不含「格式名 → 约定」的映射。

固定样本 `AXIS_PROFILE_SAMPLES`：

| 样本 | `permutation` | `signs` | `origin` | 输入 | 期望 |
|---|---|---|---|---|---|
| `identity` | `[0,1,2]` | `[1,1,1]` | `null` | `(1,2,3)` | `(1,2,3)` |
| `yUpToZUp` | `[0,2,1]` | `[1,1,−1]` | `null` | `(1,2,3)` | `(1,3,−2)` |
| `yUpToZUpWithOrigin` | `[0,2,1]` | `[1,1,−1]` | `(0,0,64)` | `(1,2,3)` | `(1,3,62)` |

`checkAxisProfileSamples()` 返回不一致项的描述；空数组表示全部通过。样本包含不同轴序：忽略 profile 直接返回输入时，第 2、3 条检查失败。

切分：

| 面 | 归属 | 验收 |
|---|---|---|
| 给定正确 profile 得到正确结果 | 本契约（数学侧） | 固定样本 + `checkAxisProfileSamples` |
| 某具体格式的 profile 构造正确 | 适配器侧 | 该格式的往返验收 |
| 适配器输出经往返后语义保真 | 适配器侧 | 真实夹具往返 |

## 8. 与对象数据体系的关系

几何是对象数据的一种载荷：

```
Scene → SceneObject.dataId → ObjectData.payload(kind: 'mesh') → MeshData
                                └── topologyVersion ← 由 MeshData.topology.version 导出
```

- `ObjectData.topologyVersion` 由 `topologyVersionOf(payload)` 导出，不得硬编码为 0。
- `ObjectData.contentVersion` 用键序稳定的 `digestOf` 计算；`JSON.stringify` 会因键序不同误判为脏。
- 顶点写走 `setProperty` 路由，由 `PropertyRef.element` 承载子元素寻址，不新增命令。
- `vertexPosition` 声明为 `animatable: false`；元素引用过期由 `staleReason(ref, facts)` 判定，`facts.topologyVersion` 取自 `ObjectData.topologyVersion`。
- `applySetProperty` 依次执行全量预检、无变化判定与单次提交；顶点写只在已通过预检的引用上执行。
