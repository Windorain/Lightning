# T3.2 体积增长曲线 —— 结果归档

> **本文件的模板由编排生成**（`scripts/acceptance/volume-doc.mjs`），**实际数据随终验填入**。
> 判据真源：`docs/plan/format-multiblock-doc.md` §9.2/§9.3/§9.4（留白 #9 定稿）+ §10 对计划 §T3.2 建议式的修正。
> 生成时间：2026-10-02T16:02:58.586Z；模式：`template`

## 判据（机器判定，λ=1.35 / R²≥0.95 / b≤2048 B/组合 / 常数项下限 4096 B）

| 记号 | 定义 |
|---|---|
| `N` | 文档声明的变体数（= ∏各通道域 × \|tierSample\| × 运行态数），即"组合数" |
| `S` | 轴展维度和 = 总 Tier 域长度 + Σ(每通道域长度)（不含组合） |
| `G` | 内层 body JSON 的 gzip 字节数（level 9） |
| `V` | 组合展开体积 = `blockPalette`×1 + Σ(每变体完整 `cellGrid`) |
| `κ` | `V / G`（展开比） |

- **R1**：`κ` 随 `N` 同步增长（相邻点 `κ` 增长 ≥ 1/√λ）——在**真实编码器对照组**上判。
- **R2**：`G ≈ a + b·N` 线性拟合，`R² ≥ 0.95`、`b ≤ 2048 B/组合`、常数项闸门；
  正式判定落在**契约 k 序列**（T0.5 参考实现对 fixture 做通道域 ×1/×2/×4/×8 放大）——
  真实对照序列 `N≤60` 时变量部分 `b·N_max < 4096 B`，按契约 §9.3 属"该点无判定意义"。
- **R3**：`size(backbone)+size(rules)+size(blockPalette)` 的增长 < 2λ ×（`S` 的增长）——在真实序列上判。
- **风险 4**：调色板并集体量占比（`blockPalette` 占内层字节比 ≥40% 标红、≥25% 标黄）+ 并集去重率。

## 数据（**待终验填入**）

> 终验跑一条命令即可填满本节：
> ```powershell
> npm run acceptance:multiblock
> ```
> 编排会调用本工具的 `--mode data`，把该次运行的 `volume/volume-curve.json`（机读真源）、
> `volume/volume-curve.svg`（曲线图）、`volume/profile.md`（T0.1 分桶）与验收报告的判定一并写进本文件。

| 序列 | 轴 | 判定 | N 范围 | R1 | R2 | R3 | G ≈ a + b·N | R² | B/组合（声明部分） |
|---|---|---|---|---|---|---|---|---|---|
| `encoder-values` | EBF coil 取值数 +1 ×3 档 | 【待填】 | | | | | | | |
| `encoder-channels` | QFT 通道数 +1（含退化对照） | 【待填】 | | | | | | | |
| 契约 k 序列 | fixture 通道域 ×1/×2/×4/×8 | 【待填】 | | — | — | — | | | — |

**风险 4（调色板并集体量占比）**：【待填】

**无组合展开的其它机器证据**（终验报告里带出）：聚合 `κ = ΣV/ΣG`、`frames[].ops/cellGrid` 零出现、
契约校验器 `frames/*` 全绿、每组合边际 < 单变体完整网格。

## 产物位置（终验）

- 机读数据：`scripts/acceptance/.out/acceptance-<label>/volume/volume-curve.json`
- 曲线图：`…/volume/volume-curve.svg`（左：`G vs N` + 拟合线；右：`κ vs N`，log10）
- 人读表格：`…/volume/volume-curve.md`
- T0.1 分桶：`…/volume/profile.md`（每台产物的字节桶占比）
- 验收报告：`…/acceptance-report.json`（`volumeCurve` 段）

## 已知边界（判据适用性，需知悉）

1. **R2 的常数项闸门在真实产物上不可满足**：每文件 `materialPalette+textureBlobs` 池 ≈40 KB gzip
   （T1.4 开放项 2：未按机剪枝），而契约 §9.4 的 4096 B 下限是按"信封头 300–400 B"设的。
   故 R2 的正式判定落在契约 k 序列；真实序列上如实记录斜率/拟合度/边际与补充判据。
2. **对照组是"域子集重编码"不是"多轮游戏内导出"**（调度者裁决）：与生产同一 Java 编码器
   （`MultiblockFactorizeTool`），避免 2.5 min/轮 ×N 的游戏内空转与同路径重复。
3. **`validate-multiblock-fixtures.mjs --volume` 只能跑 fixture**：对真实产物（含 `size` 通道）会抛
   `装配越界`（`scaleDocument` 的合成下标不适用于真实骨架）。

> 模板文件：`docs/plan/volume-profile-result.md`
