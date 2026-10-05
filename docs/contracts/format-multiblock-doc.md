# 多方块为主文档格式契约

> **范围**：多方块为主文档的**格式契约**（核心留白：文件格式如何同时承载骨架、差异规则表与变体清单）。
> **依据来源**：本契约的通道语义、运行态裁决、体积剖析结论来自治理前的过程性探针/计划文档（正文里的 `T0.x/T1.x/T2.x/T3.x`
> 任务编号与「留白 #N」编号即其标识）。这些过程性文档已按 #51 裁决从仓库删除（不再入库），原文见 issue #51 与 git 历史。
> **状态**：定稿。7 条硬约束的含义逐条落在 §2–§8 与 §12 的规则里；3 份 fixture 由独立校验器全组合装配通过（§10.1）。
> **结论绑定版本**：GT5U **5.09.52.283**（本文里的 GT5U 类名、行号与实测数字均对该版本成立；换版本须重新核对 §4.2、§6.2、§9.5）。
> **章节编号**：沿用定稿时的编号，不重排 —— §11（硬约束逐条核对表）与 §13（交付清单）属过程留痕，已按 #51 裁决删除，故编号有缺号。
> **本文件是契约**：编码端（mod 侧因子化）与解析/装配端（web 侧）都按本文件实现；凡与本文件不符的实现即视为缺陷。

---

## 0. 一句话契约

**一份文件 = 一台多方块。** 文件声明「**尺寸型通道定骨架** + **一张按引用复用的差异规则表** + **所有变体的声明式清单**」，
再用「**每变体一帧（Frame）**」把它们绑起来；装配 = 取骨架阶 → 克隆 → 按相位把规则表写进去。
**没有任何一步需要游戏逻辑**：内容差异只来自声明好的**查表**（`index` / `indexTable` / `indexRole`）。

> **7 条硬约束的落点**：1 → §2；2 → §5.3；3 → §4.2；4 → §4.4/§4.5/§9.6；5 → §6.1；6 → §8；7 → §12.1。
> 约束原文属治理前的过程性计划（已按 #51 裁决删除），此处只保留"含义落在哪一节"的索引。

---

## 1. 术语与三个轴（只有三个轴，不许有第四个）

| 轴 | 承载 | 说明 |
|---|---|---|
| **尺寸型通道** | `multiblock.backbone.sizeSteps` | 决定"结构有几层/几片"→ 选哪一阶骨架。本轮**只允许一个骨架通道**（见 §4.6） |
| **替换型通道** | `multiblock.rules` | 决定"某位置的方块是谁"。域 = 取值数，**含"未设置"** |
| **运行态** | `multiblock.runstates` + 运行态相位规则 | 本轮**只承诺纹理/材质层**差异（T0.3 裁决） |

三个轴之外的一切（等级、Tier）都不是新轴：**总 Tier 是"总通道"**（GT 的 `stackSize`），它与具名通道同构，
只是没有 `id`/`enum`（见 §5.1）。→ 满足「未引入除「通道」「运行态」外的第三个轴」这一约束。

**变体（variant）** = 一次通道取值 + 总 Tier + 运行态的具体选择。
**帧（frame）** = 变体的存储原语，仍然是唯一一个（硬约束 2）。一个变体至少一帧，通常恰好一帧。

---

## 2. 文档级形态枚举与判别（硬约束 1）

### 2.1 枚举量

| 字段 | 位置 | 取值 | 含义 |
|---|---|---|---|
| `documentFormat` | 信封根（与既有机制一致） | `"Envelope"` | 传输封装形态（既有枚举，不动） |
| `documentShape` | **信封 `meta`**（真实产物）／内层 body（裸体形态） | `"multiblock"` \| **缺省** | **文档级形态枚举**：`"multiblock"` = 多方块为主；**缺省 = 帧为主（frames）** |

> **为什么缺省是"帧为主"**：既有 V2Plain / World / StructureData 三类文档都不带该字段，缺省即"不是多方块文档"，
> 于是**既有格式与解析零改动**。`"multiblock"` 与缺省是**互斥**的：前者要求内层存在 `multiblock` 对象、
> 且**不得**有根级 `cellGrid`/`blockPalette`（那是帧为主形态的根级展开约定，见 T0.1 §8 F4）。

### 2.2 判别规则（T2.1 照此实现，判别函数只用这几个键）

```
isMultiblockDocument(inner):
    inner 是对象
    且 inner.documentShape === "multiblock"
    且 inner.multiblock 是对象
    且 inner.multiblockCount === 1
    → true

isEnvelope(raw):            既有 isEnvelopeDocument(raw)（documentFormat==="Envelope" 或结构判定）
normalizeEnvelope(raw):     既有 normalizeEnvelopeToPlain（payload base64 → gzip 解压 → JSON）
                            ↑ **本格式不重做信封**（硬约束 6）
```

判别优先级（T2.1 注册顺序）：`Multiblock` **先于** `V2Plain`。理由：多方块文档为了复用 `frames` 语义，
天然带 `format_version:"2.0"` + `frames`（V2Plain 的判别条件），必须先被多方块判别器接走。
**既有四类 parser 的 `detect` 一行不改**，只把新 parser 插到注册表前面。

### 2.3 形态互斥的机器断言（写进校验器，也写进 T2.1）

| 断言 | 违反时 |
|---|---|
| `documentShape==="multiblock"` ⇒ `multiblockCount===1` 且 `multiblock` 是对象 | 解析失败并报错（不静默退化） |
| `documentShape==="multiblock"` ⇒ 无根级 `cellGrid`/`blockPalette` | 解析失败并报错 |
| `documentShape` 缺省 ⇒ **必须**有根级或帧内 `cellGrid`+`blockPalette`，且不得有 `multiblock` 对象 | 走既有 parser（不受影响） |

---

## 3. 内层 body 骨架（与既有 V2 字段名对齐，能复用的一个都不新造）

真实 `/sde multiblock` 产物的**信封**：

```jsonc
{
  "documentFormat": "Envelope",
  "payloadEncoding": "base64(gzip(json))",   // 生产形态（既有 SceneEnvelopeBuilder 的 gzip+base64）
  "meta": {
    // 既有 meta 字段（id/mode/label/author/description/modSource/gtnhVersion/schemaVersion/globalConfig…）
    "documentShape": "multiblock",           // ★ 文档级形态枚举（判别用）
    "fixtureFile": "…"                       // 仅 fixture
  },
  "payload": "<base64>"
}
```

`payload` 解压后的**内层 body**：

```jsonc
{
  "schemaVersion": 1,
  "multiblockCount": 1,
  "multiblock":  { …§4… },
  "blockPalette": [ …§6… ],          // 所有变体的并集，签名全局去重
  "materialPalette": [ … ],          // 既有结构（locator/atlas/blend/textureBlobIndex）
  "textureBlobs": [ … ],             // 既有结构（base64 PNG）
  "tooltipPalette": [ … ],           // 既有结构
  "frames": [ …§5.3… ],              // Frame = 变体存储原语
  "cellGrid": 不存在,                 // ★ 多方块文档禁止根级展开
  "blockPalette" 的根级位置就是唯一一份（不是"首帧展开"）
}
```

> **`blockPalette` 放根级**与 `liftBlockPaletteToRoot` 的既有做法完全一致（帧内不再各自持有一份调色板），
> 故这是**复用**而不是新约定。帧为主的既有形态另有"把首帧 structure 展开到根级"的兼容约定，多方块文档**不采用**。

---

## 4. `multiblock` 对象

### 4.1 完整结构（注释标注必填/可选）

```jsonc
"multiblock": {
  "id": "gregtech:metaTileEntity_electricBlastFurnace",   // 必填：稳定标识（枚举实例键）
  "displayName": "Electric Blast Furnace",                // 必填：多方块显示名（硬约束 3）
  "sourceClass": "gregtech....MTEElectricBlastFurnace",   // 可选：来源类全名（诊断/比对用）
  "hasScopeOverlap": false,                               // 必填：是否存在"一位置多通道"例外（T0.4 §3.4）
  "scopeOverlapNote": "…",                                // hasScopeOverlap=true 时必填：说明是哪片区域

  "totalTierDomain": { "min": 1, "max": 14, "default": 2, "source": "probed" },  // 必填：总 Tier 域
  "tierSample": [1, 2, 14],                               // 必填：本文档**实际声明**的总 Tier 取值清单

  "channels": [ …§4.2… ],                                 // 必填：通道清单（可为空数组=仅总 Tier）
  "runstates": [ …§7.1… ],                                // 必填：运行态清单（单态也要显式声明）
  "couplingMode": "none" | "clamp",                       // 必填：缺省 "none"
  "couplings": [ …§7.2… ],                                // 必填：可为 []（缺省行为见 §7.3）
  "notes": [ { "kind": "note", "text": "…", "source": "…" } ],  // 必填：软约束/范围声明（不参与装配）

  "viewerSemantics": { …§7.4… },                          // 必填：给 UI/验收的语义声明
  "paletteSource": "union-all-variants",                  // 必填：只有这一个合法取值
  "geometryEncoding": "bakedQuadsJsonV1",                 // 必填：调色板几何编码（见 §6.3）
  "opsLegend": { "<legend id>": "说明" },                  // 可选：规则说明池（一处解释，全文引用）

  "backbone": { …§4.4… },                                 // 必填
  "rules": [ …§4.5… ],                                    // 必填：差异规则表（**按引用复用**）
  "variants": [ …§5.1… ]                                  // 必填：变体清单
}
```

### 4.2 通道清单（硬约束 3：id + 呈现名 + 取值域含"未设置"）

```jsonc
{
  "enum": "HEATING_COIL",       // 必填：GTStructureChannels 枚举名；null 表示"非枚举通道"（合成/无具名）
  "id": "coil",                 // 必填：游戏内通道 id（小写，与 ChannelDescription 对齐）
  "key": "coil",                // 必填：本文档内唯一键（= id；重名 id 时必须用 enum 派生以免歧义）
  "name": "Coil",               // 必填：**呈现名（UI 标签）**，取 enumName 语义，不是 capitalize(id)
  "kind": "replace",            // 必填："size" | "replace" | "hatch"
  "slot": "coil-slot",          // 可选：位置集合的稳定名字（语义说明，装配器不使用）
  "min": 1, "max": 3,           // 必填（replace）：**有效取值**下界/上界
  "axis": "y", "unit": "layers",// 必填（size）：尺寸作用轴与单位
  "valueSemantics": "clamped-offset", // 必填（size）：值 1 → min、值 ≥ max−min+1 → max（GT getValueClamped）
  "domainSource": "game-lang",  // 必填："game-lang" | "probed"（无书面取值域时标 probed）
  "domain": { "min": 1, "max": 3 }  // 必填：**取值域**；缺 max ⇒ max = 总 Tier 域上界
}
```

**通道清单的实测数量（GT5U 5.09.52.283，依据 `GTStructureChannels` 的运行时枚举）**：

- 枚举常量 **30 条** = **27 替换型（`replace`）+ 2 尺寸型（`size`）+ 1 舱口布局型（`hatch`，即 `gt_hatch`）**；
- **28 个唯一 `id`**（30 − 2，差值全部来自 `casing` 重复 3 次）；重名 id **只有 `casing`**，无其他重名；
- 另有 **6 个 id 无书面取值域**（`en_US.lang` 无对应描述）→ 只能标 `domainSource:"probed"`。
- **不得硬编码 30 或 27**：一切以运行时枚举为准（本契约只固定"怎么表达"，不固定"有几条"）。

**四条不可妥协的规则**：

1. **"未设置"（Not set）恒在域内**：`domain` 的取值集合恒为 `0..max`，**`0` 就是"未设置"**。
   GT 数据层不允许通道值为 0（`ChannelDataAccessor.setChannelData` 对 `<=0` 抛异常），
   "未设置"的物理形态是**该通道键不存在**，此时该位置回落到**主通道值（总 Tier）** —— 见 §5.2。
2. **双键消歧**：`{enum, id}`。`casing` 在 GTStructureChannels 中出现 3 次（`METAL_MACHINE_CASING`/`TIER_CASING`/`ALCHEMICAL_CASING`），
   只按 id 消歧**不安全**（三条共用同一个 `ChannelDescription` 值表，同一个 `(id, 值)` 指向不同方块；
   证据：历史通道探针报告 §2.4，见 issue #51 / git 历史）。
3. **导出期断言**：同一多方块内 `id` 不得重复（当前 GT5U 满足）；违反则**导出失败并落盘原因**，不得静默改名。
4. **`gt_hatch` 标 `kind:"hatch"`、不生成滑杆**：它只读 `hasValue` 布尔（`HatchElementBuilder:527`），
   不是取值通道（T0.4 §3.6）。`hatch` 通道**不得**出现在 `rules[].indexTable` 里。

### 4.3 三个通道种类的装配含义

| `kind` | 装配角色 | 取值注入机制（T0.4 §2.3 的四种） | 规则里的表达 |
|---|---|---|---|
| `size` | **选骨架阶**（`frame.stepIndex`） | `getValueClamped`（机制 C） | 不进规则表；由 `backbone.sizeSteps` 承载 |
| `replace` | 规则表写内容 | ① `withChannel` 下标 ② 自定义元素直读 ③（尺寸型） | `rules[].indexTable`（查表） |
| `hatch` | 本轮**不参与装配** | 机制 D（布尔） | 无（UI 不出现滑杆） |

### 4.4 骨架（尺寸型 → 骨干）

```jsonc
"backbone": {
  "kind": "sizeSteps",
  "sizeChannel": "height",          // 必填：决定取哪一阶的尺寸型通道 key（本轮只允许一个，见 §4.6）
  "sizeSteps": [
    {
      "channel": "height",          // 必填
      "layers": 3,                  // 可选：语义标注（层数）
      "w": 3, "hh": 3, "d": 3,      // 必填：该阶的三维尺寸（声明与 cellGrid 实际形状必须一致）
      "roles": { "casing": 1, "controllerFace": 8 },  // 可选：语义角色 → 调色板下标（规则可用 indexRole）
      "cellGrid": [ [ [1,1,1],[1,0,1],[1,1,1] ], … ]  // 必填：[z][y][x]（row 0 = 顶部，与既有 cellGrid 约定一致）
    },
    …
  ]
}
```

- **阶数必须 = 尺寸通道域长度**（`max − min + 1`）。第 k 阶对应有效值 `min + k`。
- **`cellGrid` 是"只有骨架方块"的完整布局**，不得包含任何替换型通道的内容。
  §4.5 的规则在它之上写入内容；装配结果必然是完整网格。
- **`roles` 只作语义别名**：规则写 `indexRole:"casing"` 时取 `step.roles.casing`。
  这是"语义名 → 下标"的**查表**，不是求值。

### 4.5 差异规则表（硬约束 4 的核心）

规则**只存一份**（`multiblock.rules`），frame **按 id 引用**。这是本格式的压缩杠杆：
若把 ops 放进 frame，每条规则会随组合数重复一次，体积立刻退化为"组合展开"（反模式与机器判据见 §9.6）。

```jsonc
{
  "id": "glass.rod",              // 必填：文件内唯一
  "phase": "backbone"|"replace"|"runstate",  // 必填：装配相位（见 §5.3 顺序）
  "legend": "glass.replace",      // 可选：指向 multiblock.opsLegend 的说明键
  "kind": "setCell" | "fill",     // 必填：两种差异表达（装配器只认这两种）
  "guard": { "clauses": [ … ] },  // 可选：生效条件（见下）

  // —— 写入什么（三选一；纯查表，无函数） ——
  "index": 7,                     // ① 常量下标
  "indexRole": "casing",          // ② 骨架角色名 → step.roles[名] 查表
  "channel": "glass",             // ③ 取值查表：配 indexTable，下标 = 该通道**有效取值**
  "indexTable": [7, 7, 6],        //    表长必须 ≥ domain.max + 1（第 0 档就是"未设置"分支）
  "indexAliases": { "1": 9, "2": 9 },  // 可选：「旧下标 → 新下标」整表批量替换（见 §4.5.2）

  // —— 写到哪里（kind 决定用哪组） ——
  "x": 1, "y": 1, "z": 1,         // kind="setCell"：单格（index:0 = 置空/删除）
  "sel": { "x": 1, "y": [2, 4], "z": 1 }  // kind="fill"：区间
}
```

#### 4.5.1 `fill` 的 `sel` 语义（**"查表 + 索引"可实现的边界**）

| 轴写法 | 含义 |
|---|---|
| `[a, b, …]`（数组） | **逐层取一个坐标**：第 i 层用 `sel.y[i]`（长度不足则重复最后一个）；`x`/`z` 的数组则**每层都写全部列出的坐标** |
| 数字 | 每层同一个坐标 |
| 缺省 | 该轴**全长**（`0..size−1`） |
| 越界坐标 | 该层跳过（不报错）。这让"同一张规则表适配所有骨架阶"成立 |

> `fill` **不做算术**（不允许 `y: "h-2"` 这类表达式）。需要"随尺寸变化的位置"时，只能：
> ① 用骨架阶的固定坐标 + 越界跳过（推荐）；② 为每一阶各写一条规则、由 frame 按 `stepIndex` 选择引用（§5.3）。
> 这样装配器永远只有"查表 + 索引 + 区间写入"。

#### 4.5.2 `indexAliases`：**"旧下标 → 新下标"的批量替换表达**（硬约束 4 明文要求）

`indexAliases` 在写入之前对**当前网格**做一次整表替换：值为 `v` 的格子，若 `v` 在表中则改成 `aliases[v]`，否则保持。

用途（也是"结构性替换"的通用表达）：

- **调色板重编号**：当骨干的 `index` 命名与并集调色板的最终编号不一致时，一条规则完成整块替换（不是逐格数据）。
- **系统性换料**：把一阶骨架里所有"钴机壳"换成"钛机壳"只需一条 `{"1": 17}`，与出现多少次无关。

一条规则可以**同时**做"整表替换 + 区间写入"（先替换、后写 `fill`/`setCell`）。

**代价实测（取舍已量化，不是免费能力）**：同一台 EBF 的两种实现对照 —— `indexAliases` 规则版 = 5 条规则 / 108,754 B，
编码期直接换下标版 = 4 条规则 / 108,494 B → `indexAliases` 的代价是 **+260 B（+0.24%）**，换来"旧下标 → 新下标批量替换"
这条硬约束明文要求的能力；两条路径的逐格 diff 均为 0（等价性已验证）。故**保留 `indexAliases`**，不要为了 260 B 改回编码期直接换下标。

#### 4.5.3 `guard`：条件生效（表达例外，T0.4 §5.3 的落法）

```jsonc
"guard": { "clauses": [ { "channel": "coil", "not": true, "value": 0 } ] }
```

- `clauses` 之间 **AND**；`guard.not:true` 对整体取反；无 `clauses` = 恒真。
- 单条 clause 四种形态：`{value}`（等于）、`{not:true, value}`（不等于）、`{min}`（≥）、`{max}`（≤）。
- **只管声明值/有效值的比较，不做算术**。已足够表达 T0.4 的两类例外：
  - `MTEIndustrialCokeOven` 的"`length` 仅在 `coil` 达上限+1 时生效" → 两条互斥 guard 的规则组。
  - `MTELapotronicSuperCapacitor` 的"`'C'` 列受 `BOROGLASS` 影响" → 同一位置多条规则 + 各自 guard；
    文件标 `hasScopeOverlap: true`。

### 4.6 尺寸型通道允许多个吗？

**本轮只允许一个骨架通道**（`backbone.sizeChannel` 是单值）。理由：两个尺寸轴会引入"维度组合"，
而 `sizeSteps` 是扁平数组，会把阶数变成乘积（回到组合展开）。

- 现实中 GT5U 的 10 处尺寸型读取点**每台机器只用一条**（`height` 或 `length`，见历史通道探针报告 §3.5，issue #51），
  故本限制**不损失覆盖面**。
- **扩展位**：若将来出现真需要两个尺寸轴的机器，把 `backbone` 换成 `"kind":"sizeGrid"`、
  `sizeSteps` 改成以有序 `[stepA, stepB]` 为键的表即可；`frame.stepIndex` 变成数组。
  装配器改一行（取阶方式），其余不动。**本轮不实现**，只留位置。

---

## 5. 变体、帧与装配

### 5.1 变体清单（`multiblock.variants`）

```jsonc
{
  "key": "height:3|coil:3|glass:0|tt:2|runstate:active",  // 必填：**主键**（派生规则见下）
  "totalTier": 2,                          // 必填：总 Tier（"总通道"的声明值）
  "values": { "height": 3, "coil": 3, "glass": 0 },  // 必填：**每个通道**的声明值（未设置写 0）
  "runstate": "active",                    // 必填：运行态 id
  "height": 3                              // 可选：fixture/工具用的冗余标注（生产建议省）
}
```

**变体键的派生规则（唯一）**：`<通道key>:<声明值>` 按 `channels` 数组顺序用 `|` 连接，
再按序追加 `tt:<总Tier>`、`runstate:<id>`。

- **总 Tier 必须进键**：通道未设置（0）时其有效值回落总 Tier，故"全部通道未设置"在 `tt:1` 与 `tt:3` 下是两个不同变体（§5.2）。
- 键里的值恒为**声明值**（未设置写 0），有效值是装配期产物 —— 键是**声明**，不是求值结果。
- 键即主键：`variants` 内不得重复；`frames[].variant` 必须命中它。

### 5.2 有效值解析（装配第 0 步；**这是"Not set"的唯一落点**）

```
对每个通道 ch（按 channels 数组顺序）：
    raw = variant.values[ch.key] ?? 0
    value = (raw > 0) ? raw : 总Tier                      // ★ 未设置 → 回落主通道（GT ChannelDataAccessor）
    if value < 0                 : value = 0
    if value > ch.domain.max     : value = ch.domain.max, 记 report.clamped += {field, was, now, reason:"domain"}
    if value < (ch.kind=="size" ? ch.min : 0) : clamp 到该下界, 同样记 clamped
    effective[ch.key] = value

对每个 size 通道：stepIndex 由 effective[sizeChannel] 决定：
    k = min(max(effective[sizeChannel], sizeChannel.min), sizeChannel.max) - sizeChannel.min

然后执行耦合夹取（§7.2）
```

三条推论（写进实现，不要"改进"）：

1. **UI 默认态（Tier=1、所有通道 Not set）必然得到确定结构**：未设置 → 有效值 = 1 → 第 0 阶骨架 + 每张 `indexTable` 的第 1 档。
2. **"设置 0"与"不设置"在数据层等价**，都表示"该通道键不存在"。UI 把 0 显示为 `Not set` 即可。
3. **只有两种夹取**：域夹取（上表）与耦合夹取（§7.2），都会落 `report.clamped` 并由 UI 提示；
   其余**任何情况都不拒绝装配** —— 滑杆走到任何位置都必然得到一个合法网格（T2.4 不需要错误分支）。

### 5.3 帧（Frame = 变体存储原语，硬约束 2）

```jsonc
{
  "index": 0,                      // 必填：帧序号（沿用既有帧语义：帧播放/分层预览都按它走）
  "variant": "height:3|coil:0|glass:0|tt:2|runstate:idle",  // 必填：变体主键（frame → variant 的引用）
  "runstate": "idle",              // 必填：与 variant 的 runstate 一致（冗余但有校验价值）
  "stepIndex": 2,                  // 必填：本帧用哪一阶骨架
  "rules": [ "coil.slot", "glass.rod", "runstate.face.h3.idle" ],  // 必填：本条变体引用的规则 id（**按序**）
  "label": "…",                    // 可选：既有帧标注（UI 显示用）
  "durationMs": 0,                 // 可选：既有帧字段（多方块文档不用，保留兼容）
  "cellGrid": [ … ]                // 可选：参考网格（校验/取证用；**生产产物必须省略**，见 §9.6）
}
```

- `frame.rules` 是**有序引用**。相位相同、顺序关键（"后写者胜"）时不靠数组下标隐式约定，
  而是显式给出 `{ "id": "…", "order": 0 }` 形式；纯字符串形式 = 声明顺序。
- **帧不携带内联 ops**。校验器把 `frames[].ops` 的存在判为**硬失败**（那是组合展开的形态）。

### 5.4 装配算法（T2.2 照此实现；也是 T3.3 的判据来源）

```
ASSEMBLE(doc, variantKey) → cellGrid          # 纯查表 + 索引 + 区间写入；零游戏逻辑
  mb = doc.multiblock
  variant = variants.find(v => v.key == variantKey)          # 找不到 → 抛错
  effective, stepIndexRaw = RESOLVE(mb, variant)             # §5.2

  frames = doc.frames.filter(f => f.variant == variantKey)   # 每变体 ≥1 帧
  for frame in frames:                                       # 通常是 1 帧
      step = mb.backbone.sizeSteps[frame.stepIndex]          # 尺寸型已定阶
      grid = deepCopy(step.cellGrid)                         # ★ 必须深拷贝（同阶可能被多帧复用）
      dims = shape(grid) = {w, h, d}

      ops = []
      for ref in frame.rules:                                # 按 order/声明序
          rule = mb.rules[ref.id]                            # 未声明 → 抛错
          if not EVAL_GUARD(rule.guard, effective): continue
          ops.push({rule, phase: rule.phase, order: ref.order})

      for {rule, phase} in STABLE_SORT(ops, by (phaseRank[phase], order)):
          # phaseRank = {backbone:0, replace:1, runstate:2}
          #   —— 即「尺寸型 → 骨干 → 替换型 → 运行态」的相位序；
          #      "尺寸型"已在上一步由 stepIndex 完成
          if rule.indexAliases: APPLY_ALIASES(grid, rule.indexAliases)     # 旧下标 → 新下标
          index = rule.index
                  ?? step.roles[rule.indexRole]                            # 角色查表
                  ?? rule.indexTable[effective[rule.channel]]              # 取值查表
          if index == null: 抛错
          cells = EXPAND(rule, dims)                 # setCell → 1 格；fill → 区间内全部格（越界跳过）
          for c in cells: grid[c.z][c.y][c.x] = index
      ASSERT 每个下标 ∈ [0, blockPalette.length)                  # 越界即抛错
      yield grid
```

**"零游戏逻辑"的机器判据**：装配器代码里不得出现 `switch(channel.id)`、不得 import 任何 GT/StructureLib 知识、
不得调用除"查表/索引/深拷贝/排序"以外的任何函数；所有内容差异都来自声明数据（`index`/`indexTable`/`indexRole`/`indexAliases`）。

---

## 6. 调色板：并集 + 全局去重（硬约束 5）

### 6.1 规则

1. **`blockPalette` 是根级唯一一份**，内容 = 所有变体装配结果里出现过的方块状态的**并集**。
2. **`blockPalette[0]` 恒为 air**（既有约定）。
3. **按内容签名全局去重**：签名 = 条目对象的规范化 JSON（键排序、数组顺序保留）。
   与 `MeshCaptureService.entryEqualitySignature` 同口径；同一方块状态的**烘焙几何全文件只存一份**。
4. **不得有从未被任何变体引用的条目**（校验器判 warn）：并集是"用到的并集"，不是"枚举到的并集"。
5. **几何编码全文件统一**（`multiblock.geometryEncoding`）；同一文件内不得混用编码 ——
   否则 web 侧渲染路径要分叉。

### 6.2 "未设置"不需要独立条目

GT 里通道值不可为 0；"未设置"的位置由**主通道值**（总 Tier）决定方块。
因此 `indexTable` 的**第 0 档**就写"未设置时该位置到底该显示什么"，通常与第 1 档同一内容：

```jsonc
"channel": "coil", "indexTable": [1, 1, 2, 3]   // 档 0（未设置）与档 1 同内容；档 2/3 是更高线圈
```

**不要**为"未设置"造独立方块条目（第一稿这么做过，结果是 3 条永远无法被引用的死条目）。

### 6.3 几何编码：本轮沿用 `bakedQuadsJsonV1`（**决策**）

- 取值：`"bakedQuadsJsonV1"`（既有契约：`geometry = {encoding, quads:[{materialIndex, vertices:[{x,y,z,u,v,brightness,color}]}]}`）。
- **理由**：`web/src/render/mesh/bakedGeometryDecode.ts` 已实现该编码，`blockPalette` 条目在渲染管线里是**不透明数据**，
  故多方块文档**不需要任何渲染层改动**即可显示（本契约写范围内不能改 `web/src/render/`）。
- **已量化的后续优化**（本次实测，见 §9.6）："对象化顶点"是未压缩体积最大开销（`brightness` 键名重复 8828 次 = 114,764 B，
  T0.1 §8 F6）。若换成"顶点位置数组 + 条目级 brightness/color 默认值"，能消掉绝大部分顶点级键名。
  这需要 `bakedGeometryDecode.ts` 新增一条解码分支（约 20 行），属**渲染层**工作，**不在本契约范围**。
  触发条件：T3.2 体积曲线显示 `palette.geometry` 占比过高且落盘体积超预算时，作为独立任务立项；
  届时用 `multiblock.geometryEncoding` 加新取值实现（**格式已经预留了判别位**）。
- **`thumbnailPNG` 政策**（T0.1 §8 F3 要求显式决策）：~~按既有字段原样进条目、参与签名去重~~
  **【修订 · 缩略图确定性修复后】multiblock 导出产物不携带 `thumbnailPNG`**——GPU 渲染像素跨运行不确定，
  会破坏幂等字节一致性与签名对齐（证据：缩略图确定性修复的历史报告，见 issue #51 / git 历史）。web 3D 渲染不使用 per-block 缩略图；
  若将来需要，须确定性软件光栅另行立项并走独立 blob 池，不得进主产物条目。条目字段集合恒为
  `{registryId, meta, renderMode, geometry, occludesAdjacentFaces, nbt, tooltip}`。

### 6.4 两套签名口径：**去重键** 与 **对齐签名**（不要混用）

本格式同时存在两把"签名"，口径与敏感字段完全不同，实现与验收都必须分清：

| | ① **去重键**（调色板内合并同内容条目） | ② **对齐签名**（跨产物逐格比对） |
|---|---|---|
| 定义 | `MeshCaptureService#fullEqualitySignature(registryId, meta, nbt=null, geometry, tooltip=null)`（本数据集 nbt/tooltip 传 `null`） | `entrySignature(entry)` = 条目**全文**的 `canonicalJson`（对象键排序、数组保序），即 `palette.signatures[i]` |
| 覆盖字段 | `registryId` + `meta` + **`geometrySignature`**（四边形按 quantization 后的顶点/uv/brightness/color 排序后哈希） | 条目**全部键**（含 `renderMode`、`occludesAdjacentFaces`、`nbt`、`tooltip` 等渲染性/元数据字段） |
| 对渲染性字段 | **不敏感** —— 不在键里，故**去重永不受缩略图影响**（加/去 `thumbnailPNG` 不改变任何下标） | **敏感** —— 任一条目字段变化即签名变化 |
| 用途 | `GeometryPalette#intern` 的全局去重；air 恒下标 0 | 展开校验文件（`palette.signatures`）与产物调色板的跨下标空间比对 |

推论（实现纪律）：

- **修渲染性字段漂移的正确路径是"从条目里去掉易变字段"，而不是改签名口径**。反例：`thumbnailPNG` 曾进条目，
  剥离它才是正解（§6.3）；若改成"对齐签名忽略该字段"，就会让两套签名从此漂移、并掩盖真实的内容差异。
- `canonicalJson` 必须**五方逐字符同口径**：mod 侧（`MultiblockExpandedVerifier#canonical`）、
  `scripts/multiblock-fixtures/lib.mjs#canonicalJson`（`entrySignature` 即其包装）、两个 pipeline 校验器
  （`scripts/multiblock-pipeline/verify-expanded.mjs`、`scripts/multiblock-encode/verify-encoded.mjs`）、
  `web/e2e/helpers/multiblock/referenceGrids.ts#canonicalJson`。任一处改用别的序列化（键序/空值处理不同）都会造成假失败。
- **推论：跨"年代"的产物不可对齐，必须同年份/同批次成对使用**。对齐签名取条目全文，而条目字段集合随实现演进而变
  （例：`thumbnailPNG` 的移除、`occludesAdjacentFaces`/`tooltip` 的引入），旧年代的展开校验文件与新年份的产物
  逐格比对必然全红，且**红的原因不是渲染错，而是口径不同代**。故配对规则：**展开校验文件与其产物同一轮导出**（同 run 目录）。

---

## 7. 运行态与约束

### 7.1 运行态清单（含呈现名）

```jsonc
"runstates": [
  { "id": "idle",   "name": "Idle",    "materialSwap": false },
  { "id": "active", "name": "Running", "materialSwap": true  }
]
```

- `id` 是装配/键用的稳定标识；`name` 是 **UI 呈现名**（硬约束 3），由文件自带，**不依赖 GT 语言文件**。
- `materialSwap` 声明本态差异是否只落在材质/纹理层。
- **单态也要显式声明**（如 `[{id:"idle", name:"Idle", materialSwap:false}]`）。没有运行态轴的机器 = 只有 `idle` 一态。

### 7.2 通道耦合约束

```jsonc
"couplingMode": "clamp",              // "none"（缺省）| "clamp"
"couplings": [
  { "id": "capacitor-ge-glass", "a": "capacitor", "b": "glass", "requires": "ge",
    "kind": "value", "source": "coupling probe §4.1.2（历史探针报告，见 issue #51）" }
]
```

`requires ∈ {ge, le, eq}`，语义为 **`effective[a] (requires) effective[b]`**；违反时把 `effective[b]` 夹到满足为止，
并落 `report.clamped += {coupling, a, b, requires, bWas, bNow}`。

- **方向即语义**：`b` 是被夹取的一方。导出期必须选"用户会显式设置的那一侧"作为 `a`，
  否则用户设 `b` 的值会被静默改掉（fixture #3 就是这么定的：`capacitor` 为 `a`，`glass` 被夹）。
- **耦合只夹取，不拒绝**：滑杆任意位置都得到确定性网格（§5.2 推论 3）。
- **顺序**：`couplings` 数组顺序执行（可级联）。
- **本轮表达力的边界**：只能表达"**通道值之间**的 `≥/≤/=`"。T0.4 §4.3 的主导模式
  （"玻璃等级 ≥ 能量仓等级"）其另一方是**可变结构内容**而非通道 → **无法表达** → 走 §7.3 的软约束。

### 7.3 缺省行为（**必须写进实现**，T0.4 §4.4 的裁决落点）

| 情形 | 缺省行为 | 本次实测 |
|---|---|---|
| 未探测到任何通道间约束 | `couplings: []` + `couplingMode: "none"` → **不拒绝任何组合**，装配按各通道独立生效 | fixture #1/#2 |
| 已知约束但无法机器表达 | `notes[]` 里的 `{kind:"note"}` **软约束**：**不参与装配夹取**，只在 UI 提示 | fixture #1 有两条 |
| 结构里"一个位置由多通道共同决定" | 该位置**不得进入骨架**，整体落入差异规则（多组规则 + guard / 多个 `indexTable`）；文件标 `hasScopeOverlap: true` | fixture #3 |
| 通道取值超出声明域 | **夹取**到域端（与 GT `getValueClamped` 一致），落 `report.clamped` | 三份 fixture 都验证 |
| 尺寸型取值超出 `min..max` | 夹取到 `max`；UI 滑杆上限 = `max` | 三份 fixture 都验证 |
| 无书面取值域的通道（6 个 id） | 全走运行时探测；标 `domainSource:"probed"` | fixture #2 的 `structTier` |

### 7.4 `viewerSemantics`（给 UI 与验收的显式声明）

```jsonc
"viewerSemantics": {
  "frameIsVariant": true,
  "playback": "variant-frames",           // 帧播放 = 变体播放（帧语义不变）
  "layerPreview": "supported",            // 既有分层预览照旧可用
  "runstateCoverage": {
    "kind": "texture-material-swap",      // "texture-material-swap" | "none"
    "geometryDelta": false,               // cellGrid 是否随运行态变化（本轮恒 false）
    "tesr": "not-covered"                 // ★ 恒为 "not-covered"（T0.3 裁决，见下）
  }
}
```

**"不覆盖"声明（硬约束：T0.3 裁决必须落到格式里）**：

> 本轮运行态轴**只承诺纹理/材质层**两态差异。以下两类**明确不覆盖**，也不得作为验收条件：
> ① 经 shader/VAO + 延迟后处理的 TESR 活动几何（GT5U 唯一 `IMTERenderer` 多方块 `MTEExoFoundry`）；
> ② 由真实配方运行才创建/展开的附属渲染方块（虫洞 / 激光 / 黑洞 / 纳米锻炉）。
> 证据：历史运行态探针报告 §3.2/§5（见 issue #51 / git 历史）——TESR 调用链成立但两态动态扩展四边形数均为 0。

---

## 8. 与既有信封的组合（硬约束 6）

### 8.1 因子化发生在信封**之前**

```
变体集合（编码端内存里）
   → 因子化（骨架 + 规则表 + 变体/帧清单 + 并集调色板）      ← ★ 体积杠杆在这一步
   → 内层 body JSON（compact）
   → gzip → base64                                         ← 既有 SceneEnvelopeBuilder，机制不重做
   → 信封 {documentFormat:"Envelope", meta:{documentShape:"multiblock",…}, payload}
```

**硬约束 6 的落点**：`SceneEnvelopeBuilder` 现有两条分支（有 `frames` / 无 `frames`）**都不改**
——多方块产物走"有 `frames`"分支，把 `multiblock` 作为新的 inner 键加进去即可（一行 `copyIfPresent`）。
`meta` 里新增 `documentShape`（一行）。**这是本格式对既有信封的全部要求**。

### 8.2 `meta` / inner 的分工

- `meta`：既有元数据键 + `documentShape`。
- inner：`multiblock` / `frames` / `blockPalette` / `materialPalette` / `textureBlobs` / `tooltipPalette` / `schemaVersion` / `multiblockCount`。

### 8.3 载荷形态：两种，同一把钥匙

| 形态 | payload | 用途 |
|---|---|---|
| **生产** | `base64(gzip(JSON))` | `/sde multiblock` 实际产物（既有机制，`payloadEncoding:"gzip+base64"`） |
| **fixture** | `base64(JSON)` | 便于人工阅读 / 逐行 diff；`payloadEncoding:"base64(json)"` 且带 `payloadNote` 说明 |

读取路径对两者**同一实现**：`payload` 解 base64 得字节 → 先当 UTF-8 JSON 文本解析 → 失败则 gunzip 后再解析。
本契约的参考实现（`scripts/multiblock-fixtures/lib.mjs` 的 `readFixtureDocument`）已按此实现并**两条路径都实测通过**。

### 8.4 不做的事

- **不新增信封层**、不改 gzip/base64 编解码、不改 `payloadEncoding` 字符串。
- **不在 inner 里重复 `meta` 已承载的元数据**（既有约定：`meta` 是唯一元数据真源）。

---

## 9. 体积：设计结论与机器判定式

### 9.1 设计结论（对应 T0.1 的 F1/F5/F6）

| 决策 | 理由（T0.1 实测） |
|---|---|
| **规则表按引用复用**（frame 只存 id） | `blockPalette` gzip 后占 68.8%、`textureBlobs` 29.6%、`cellGrid` 仅 0.1%。若把 ops 放进每个 frame，规则体会随组合数重复 → 直接把文件推向"组合展开"（反模式与机器判据见 §9.6） |
| **并集调色板 + 内容签名去重** | 同一方块状态的几何全文件只存一份；`liftBlockPaletteToRoot` 的既有机制直接复用（T0.1 §6.3 第 3 条：帧维度上已验证有效） |
| **网格字段沿用既有约定** | 网格不是体积杠杆（`cellGrid` 未压缩 0.07%、gzip 0.1%）；不为"压缩网格"投入设计预算（T0.1 §8 F2） |
| **多方块文档走 Envelope 分支** | Plain 形态有根级/帧内重复展开（T0.1 §8 F4），多方块文档**禁止**根级 `cellGrid` |
| **本轮不动顶点表示** | 顶点键名是未压缩体积的最大开销（29.85%），但需渲染层改动；已在 §6.3 记录触发条件与实现位 |

### 9.2 记号

| 记号 | 定义 |
|---|---|
| `N` | 文档声明的变体数（= ∏(各通道域长度) × \|tierSample\| × \|runstates\|），即"组合数" |
| `S` | 轴展维度和 = `totalTierDomain` 长度 + Σ(每通道域长度)。**不含组合**，用来表达"骨架/调色板只存一份" |
| `C` | 单变体完整 `cellGrid` 的字节数（由骨架阶决定） |
| `G` | 信封文件 gzip 字节数 |
| `V` | **"组合展开"体积** = `blockPalette` × 1 + Σ<sub>v∈变体</sub> 完整 `cellGrid`（既有格式已共享调色板，故口径①） |
| `κ` | `V / G` = **展开比**（因子化省了多少倍）。**注意 κ 不是"有没有展开"的判据**，见下 |

**κ 的两套口径必须分清（否则数字会被读反）**：

| 口径 | 定义 | 回答的问题 | 真实数据集实测（842 变体 / 4 台） |
|---|---|---|---|
| **κ②（字面口径，本节的记号定义）** | `V / G`（`G` 取落盘文件字节），`V` = `blockPalette`×1 + Σ完整网格，**不含材质池** | "文件比'调色板 + 全部网格'小多少倍" | 合计 **7.62×**；逐台 BBF **0.24×** / DT 1.28× / EBF 1.33× / QFT 25.11× |
| **κ①（校验器口径）** | `(内层 − Σ网格 + Σ网格×N) / G`，即"按组合展开写文件会多大" | "若每个组合物化一份完整网格，文件会大多少倍" | 合计 **1332.76×**；逐台 BBF 1.44× / DT 131.49× / EBF 191.53× / QFT 4543.17× |

**κ < 1 不代表"展开了"**：κ 的绝对值只取决于「**每变体网格字节 / 每文件常数池字节**」这个比值。
真实产物里材质池是**每文件一份的常数**（`materialPalette` + `textureBlobs` ≈ 70 KB 未压缩 / ≈ 45 KB gzip），
对 BBF 这种「2 变体 / 36 格」的小机器，常数池直接压过网格体积 → κ = 0.24×。这是 §9.4「常数项下限」分支的正常形态，
**不是**每组合物化网格。

真正"没有展开"的机器判据是这两条（都已在真实数据集上跑通）：

- **逐格 diff = 0**：闭环验证器按 `canonicalJson(entry)` 对齐，842 个变体逐格与参考网格比对，差异 0；
- **边际成本量级**：实测 **10–30 B/组合**（13.5 B/组合@取值轴、29 B/组合@通道轴、10→50 实测 28.1 B/组合），
  而"每组合一份完整网格"是 **2,560–10,281 B/组合**（`perVariantGridCost`：小机器 2,560 B，DT 级 10,281 B）——
  两者差 **2 个数量级**，这才是"没展开"的可判证据。

### 9.3 判定式（编码端与验收端都按此实现；本文件附带的校验器已实现并跑通）

**R1 展开比随 N 同步增长**（核心判据）：

```
对同一台多方块的放大序列 k = 1,2,4,8（通道域 ×k）：
    κ(N) / κ(N_prev)  ≥  1 / sqrt(λ)          λ = 1.35（安全系数，§9.4）
⇒ 含义：G 与 N 同阶（每个组合的边际成本有界），而不是"每个组合都物化一份完整网格"（那会让 κ 恒定甚至下降）
```

**R2 常数项有界 + 边际成本上限**：

```
线性拟合 G ≈ a + b·N（最小二乘）
    R² ≥ 0.95
    b·N_max ≥ 2·max(a, 4096)          （否则：文件的变量部分还没信封常数大 → 该点无判定意义）
    b ≤ 2048 B/组合                    （边际成本上限）
若 b·N_max < 4096：改判"max(G) ≤ 4096 B"（小结构，gzip 被常数主导，本来就小）
```

**R3 `S` 的独立复核**：骨架与调色板的"那一份"必须**不随 N 增长**：

```
size(multiblock.backbone) + size(multiblock.rules) + size(blockPalette) 在 k 序列上增长 < 2·λ × (|S| 增长)
```

### 9.4 阈值取值与理由

| 阈值 | 取值 | 理由 |
|---|---|---|
| 安全系数 `λ` | **1.35** | 允许"G 比 N 长得快"最多 1.35 倍。来源：① gzip 的常数开销（信封骨架 + gzip 头 ≈ 300–400 B）在小文件上会造成虚假的比例偏差；② 调色板按"新增方块状态"增长（每条新状态 gzip 后约 15 B）与 N 的增长来自不同变量族，两者相位不同会产生 ±20% 的抖动。1.35 既容得下这些抖动，又足以拦住"每组合物化一份网格"这种成倍增长 |
| 拟合优度 `ρ` | **0.95** | 实测整机曲线的 R² 为 **0.9999**（§9.5），阈值留了 5 个百分点的余量以兼容真实产物中"某些通道取值新增方块状态、某些不新增"的不均匀性 |
| 常数项下限 | **4096 B** | 小于它的文件（如仅总 Tier 的 1×1 柱）本来就只有几 KB，gzip 被信封常数主导，线性拟合无意义；改为直接判"文件足够小" |
| 边际成本上限 | **2048 B/组合** | 实测边际为 **14–18 B/组合**（§9.5）。上限设为实测值的 100 倍以上，既不会误杀真实产物（其单帧描述可能带更多元数据），又能拦住"每组合存一份几何"（那会是每组合数十 KB） |
| `tierSample` 抽样 | 由导出方定 | **真实产物建议给全 `1..max`**（T3.2 要用全量曲线）；fixture 用代表值以控制仓库体积。抽样集必须落在 `totalTierDomain` 内且**每个抽样值都有完整变体**（校验器强制） |

### 9.5 设计保证与实测基线

**自变量必须是 `N`（组合数），不是 `S`（取值数之和）**：硬约束 2 规定 `Frame` 是唯一的变体存储原语 → 每个组合至少一帧；
而 `N` 是各通道域之**积**（两个通道的域各放大 2 倍时 `S` 只增加常数、`N` 涨 4 倍），故 `G` 必然至少随 `N` 增长。
"体积随相加而非相乘增长"在"每组合一帧"的前提下**不可实现**，除非新增第二套组合索引原语（那就引入了新抽象层）。
**故 §9.3 的 R1/R2/R3 一律以 `N` 为自变量。**（#51 治理前的过程性计划曾以 `S` 为自变量，此条即其修正。）

本格式真正提供的保证（机器判定见 §9.3）：

1. **文件 ≪ 组合展开**：κ = V/G 基线 = **53.57×（EBF, N=432）/ 11.37×（作用域相交例外, N=108）/ 0.57×（仅总 Tier, N=12，结构太小）**；
   合计 **40.5×**（①口径 = `blockPalette`×1 + N×完整网格；若按"每变体各自一份调色板"的朴素展开口径则为 9.4×）。
2. **每组合边际成本 ≈ 常量且极小**：实测 **14–18 B/组合**，即"一条帧描述"，不含任何几何。
3. **几何与调色板只存一份**：随 `S` 变的那一份（骨架 + 规则 + 并集调色板）与 `N` 无关。

### 9.6 反模式：内联 `ops` / 每帧带参考 `cellGrid`

把差异规则放进 `frames[].ops`（每个变体一份）、或把每个变体的参考 `cellGrid` 写进 frame，等于把"组合展开"直接写进文件：
`rules` 随组合数重复、`κ` 掉到 1 附近，因子化的收益全部丢掉（未压缩体积成倍膨胀）。

判据（校验器已实现）：

- `frames[].ops` 存在 → **判硬失败**（`frames/op-inline`）。
- `frames[].cellGrid` 存在 → 只作**校验/取证**用途；**生产产物必须省略**
  （`--verify-grids` 会把参考网格落到 `scripts/multiblock-fixtures/.out/`，不进产物）。
- **`V/G ≥ 2.3×`（最差 fixture）才是"真的没展开"**。

---

## 10. fixture 与校验器

### 10.1 文件清单

| 文件 | 角色 |
|---|---|
| `web/src/context/__tests__/fixtures/multiblock-ebf-2ch.json` | **多通道**：`height` 尺寸型 + `coil`/`glass` 双替换型 + 运行态两态 |
| `web/src/context/__tests__/fixtures/multiblock-tier-only.json` | **仅总 Tier**：柱高由 Tier 决定；另一个无书面取值域的通道（`domainSource:"probed"`）；单运行态 |
| `web/src/context/__tests__/fixtures/multiblock-lsc-overlap.json` | **作用域相交例外**：同一片顶盖区被两通道叠加改写（`hasScopeOverlap:true`）+ `clamp` 型通道耦合 |
| `scripts/multiblock-fixtures/generate-fixtures.mjs` | fixture 生成器（确定性、幂等） |
| `scripts/multiblock-fixtures/lib.mjs` | **参考装配器**（T2.2 的对照蓝本）+ 信封读取 + 取值解析 |
| `scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs` | **格式校验 + 全组合装配验证 + 体积判定式** |
| `scripts/multiblock-fixtures/ops-legend.mjs` | 规则说明池（fixture 的 `opsLegend`） |

用法：

```bash
node scripts/multiblock-fixtures/generate-fixtures.mjs
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs                    # 格式校验 + 全组合装配
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --verify-grids     # 全量参考网格落盘 + 确定性断言
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --volume           # 体积增长判定式
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --all              # 全部
# 退出码：0 = 全绿；1 = 有硬失败；2 = 找不到 fixture
```

---

## 12. 拍板项

### 12.1 `protocol/`（protobuf）：**不动**（留白 #3）

**决策：本次不修改 `protocol/**` 任何文件，不运行 `npm run protocol:gen`。**

理由（四条，按权重排序）：

1. **proto 当前不是本项目的运行时契约**。web 侧解析走的是 JSON（`parserRegistry` + `builtinParsers`），
   不 import 任何生成代码；`web/src/render/proto/` 目前是**空目录**（无 `.ts` 产物）。
   改 proto **不会改变任何一端的运行时行为**，却会让"格式真源"出现两份（proto + 本文档）并从此需要同步。
2. **本格式的载荷层可以完整承载**：信封仍是 `{documentFormat, payloadEncoding, meta, payload}`（既有字段名），
   inner 复用既有 `frames`/`blockPalette`/`materialPalette`/`textureBlobs`/`tooltipPalette`；
   新增的只有 `meta.documentShape` 与 inner 的 `multiblock`（+ `multiblockCount`/`schemaVersion`）。
   `EnvelopeMeta` / `PlainSceneDocument` 若不含这些键，protobuf 边界上也不会丢失——因为**线路上跑的是 JSON，不是 protobuf**。
3. **改 proto 的成本是链路延迟**：`buf generate` 依赖外部插件（`buf.build/community/timostamm-protobuf-ts`，需网络）
   与 `buf` CLI（本机未验证可用）。在 Phase 0 引入一个可能失败的外部依赖，去换一个**当前没有消费者**的类型定义，收益为负。
4. **收益不抵成本的量化**：本格式的全部收益在"因子化 + 并集调色板"（§9），与 protobuf 无关；
   改用 protobuf 编码载荷不会改变 §9.5 的任何基线数字（体积由 gzip 后的信息量决定，不由 JSON 的括号决定；
   T0.1 §5.2 实测键名+分隔符占未压缩 43.1%，但 gzip 后这部分压得极好）。

**触发条件（何时应该改 proto）**——满足任一条即应立独立任务：

- 引入**非 JSON 的二进制载荷**（例如 §6.3 的顶点位置数组要变成真正的二进制 buffer）；
- web/mod 之间出现**除文件以外的 protobuf 通道**（网络/流式）；
- `buf generate` 在 CI 中可用且已被其它任务使用（那时同步成本已由别人付掉）。

**若将来改动，必须做的三件事**（写进那个任务）：改 `protocol/lightning/v2/envelope_v2.proto` 的 `EnvelopeMeta`（加 `documentShape`）
与 `plain_v2.proto`（加 `MultiblockDecl` 系列 message）→ 跑 `npm run protocol:gen` → 检查 `web/src/render/proto/` 与
`mod/gtnh/build/` 两端生成物并提交；同时**保持 JSON 形态为规范真源**，protobuf 只作可选镜像。

### 12.2 体积增长的机器判定式 + 安全系数（留白 #9）

**决策：按 §9.3 的 R1/R2/R3 实现；安全系数 `λ = 1.35`；拟合容差 `R² ≥ 0.95`；常数项下限 4096 B；边际上限 2048 B/组合。**

阈值理由见 §9.4；**自变量必须是 `N`（组合数）而非 `S`（取值数之和）**，理由见 §9.5
（"每组合至少一帧"是硬约束 2 的必然结果）。

### 12.3 几何编码：本轮沿用 `bakedQuadsJsonV1`

理由与后续触发条件见 §6.3。**不改渲染层**（不在本契约的写范围内）。

---

## 14. 开放项与风险

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| 1 | **`tierSample` 抽样 vs 全量** | fixture 用代表值（1,2,14）控制体积；真实产物若也抽样，则"总 Tier 的每个值"不会都有变体 | T1.5/T1.6 **默认给全 `totalTierDomain`**；只有配置面上限触发时才抽样，并在 `notes` 里记录抽样清单 |
| 2 | **变体键串占体积**（EBF 60 KB / 432 条） | 未压缩体积的大头之一；gzip 后影响小（键串重复度高） | 已在 §5.1 说明键是主键。若 T3.2 发现键串成为 gzip 热点，可加"通道值数组按 `channels` 顺序"的紧凑写法（`values` 从 map 改数组），**格式预留**（`values` 的读取按 `channels` 顺序即可兼容） |
| 3 | **骨架只支持一个尺寸通道**（§4.6） | 两个尺寸轴的机器无法表达 | 当前 GT5U 无此类机器（T0.4 §3.5 实测 10 处读取点均为单通道）；扩展位已留（`sizeGrid`） |
| 4 | **`indexAliases` 的语义边界** | 只做"整表替换"，不做"按下标范围替换" | 已足够（fixture 未用到它，但它是硬约束 4 明文要求的能力）；若 T1.4 需要区间替换，加 `indexRangeAliases`，**不要**改成表达式 |
| 5 | **运行态只覆盖材质层** | TESR/部件展开不支持（T0.3 裁决） | 已在 `viewerSemantics.runstateCoverage` 显式声明；**不得**作为验收条件。用户若裁决追加投入，按历史运行态探针报告 §5 立项（见 issue #51） |
| 6 | **`MTELapotronicSuperCapacitor` 的挂起项** | T0.4 R9：`glassTier = BOROGLASS.getValue(trigger)+2` 疑似把下标当电压等级（变体玻璃不成立） | 不属本契约范围；比对几何时留意；如需可向上游报告 |
| 7 | ~~**`thumbnailPNG` 的隐藏纹理成本**~~（已消解） | 每条目约 936 B 且 GPU 渲染跨运行不确定 | **已修订为不产出**（§6.3 修订条）：体积风险与幂等风险一并消除 |
| 8 | **几何编码的长尾** | 顶点对象化是未压缩体积最大开销，但改动在渲染层 | 触发条件与实现位已定（§6.3）；届时用 `geometryEncoding` 加新取值，不破坏本契约 |
| 9 | **`opsLegend` 是否必须** | fixture 用它把说明集中一处（否则说明文字会主导体积，实测翻倍） | 生产产物可省（`opsLegend` 可选）；但**必须**保留 `notes[]` 里的软约束声明（那是语义，不是注释） |
| 10 | **参考网格产物位置** | `--verify-grids` 落盘到 `scripts/multiblock-fixtures/.out/`（非提交物） | T3.3 的正式对照物是 T1.6 的展开校验文件（留白 #10），不要在 CI 里依赖本目录 |

---

## 15. 附：一页速查（打印版）

```
文档形态   documentShape: "multiblock"（缺省 = 帧为主）；与根级 cellGrid 互斥
信封       documentFormat:"Envelope" + payloadEncoding + meta{documentShape} + payload(base64)
内层       multiblockCount:1, multiblock{}, blockPalette[], materialPalette[], textureBlobs[], frames[]
通道       {enum, id, key, name, kind:size|replace|hatch, min, max, domain:{min?,max}}
           domain 恒含 0 = "Not set"；双键 {enum,id} 消歧；gt_hatch 不出滑杆
总 Tier    totalTierDomain{min,max,default} + tierSample[]（本文档实际声明的取值）
骨架       backbone.sizeSteps[k]{channel, w,hh,d, roles?, cellGrid[z][y][x]}；阶数 = 尺寸域长度
规则表     rules[i]{id, phase:backbone|replace|runstate, kind:setCell|fill,
                    guard?, index|indexRole|(channel+indexTable), indexAliases?,
                    x,y,z | sel{x?,y?,z?}}
           ★ 只存一份，frame 按 id 引用
变体       variants[i]{key, totalTier, values{每通道声明值}, runstate}
           key = "<ch>:<v>|…|tt:<T>|runstate:<id>"（未设置写 0）
帧         frames[i]{index, variant, runstate, stepIndex, rules:[id…], label?}
           ★ 禁止 ops、生产产物禁止 cellGrid
运行态     runstates[i]{id, name, materialSwap}；单态也要显式声明
耦合       couplingMode:"none"|"clamp" + couplings[i]{id,a,b,requires:ge|le|eq}
           缺省 couplings:[] → 不拒绝任何组合
装配       解析有效值(未设置→总Tier→域夹取→耦合夹取) → 取 step → 深拷贝 →
           按 (phase, order) 应用规则(guard → indexAliases → 查表取 index → 写格) → 越界断言
不覆盖     TESR(shader/VAO) 活动几何、运行中才生成的附属渲染方块（T0.3 裁决）
体积判据   R1 κ=V/G 随 N 同步增长（相邻点 κ 比 ≥ 1/√1.35）；
           R2 拟合 G≈a+b·N 且 R²≥0.95、b≤2048 B/组合（b·N_max<4096 → 改判"文件足够小"）；
           R3 size(backbone)+size(rules)+size(blockPalette) 增长 < 2λ×(S 增长)；
           基线：κ=53.57×（EBF, N=432；11.37× 是 lsc-overlap）、边际 14–18 B/组合
```

