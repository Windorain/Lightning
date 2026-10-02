# T3.2 体积增长曲线 —— 结果归档

> **本文件的模板由编排生成**（`scripts/acceptance/volume-doc.mjs`），**实际数据随终验填入**。
> 判据真源：`docs/plan/format-multiblock-doc.md` §9.2/§9.3/§9.4（留白 #9 定稿）+ §10 对计划 §T3.2 建议式的修正。
> 生成时间：2026-10-02T17:49:24.549Z；模式：`data`

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

## 数据（本次运行）

> 运行目录：`scripts/acceptance/.out/acceptance-run-20261003-012505`；判定：**pass-with-caveat**（无验收报告）

| 序列 | 轴 | 判定 | N 范围 | R1 | R2 | R3 | G ≈ a + b·N | R² | 声明部分 B/组合 |
|---|---|---|---|---|---|---|---|---|---|
| `encoder-values` | 取值数 +1 ×3 档 | **pass-with-caveat** | 48–60 | pass | not-applicable（pool-dominated） | pass | G ≈ 43763 + 23.75·N | 0.9958 | 10.8 |
| `encoder-channels` | 通道数 +1（1→2 通道，含退化对照） | **pass-with-caveat** | 10–50 | pass | not-applicable（pool-dominated） | pass | G ≈ 44811 + 31.88·N | 0.9660 | 23.7 |
| 契约 k 序列 `multiblock-ebf-2ch.json` | fixture 通道域 ×1/×2/×4/×8 | **pass** | 432/1260/4212/15300 | — | pass | — | G ≈ 4248 + 9.47·N | 1.0000 | — |
| 契约 k 序列 `multiblock-lsc-overlap.json` | fixture 通道域 ×1/×2/×4/×8 | **pass** | 108/300/972/3468 | — | pass | — | G ≈ 3112 + 9.79·N | 0.9996 | — |
| 契约 k 序列 `multiblock-tier-only.json` | fixture 通道域 ×1/×2/×4/×8 | **pass** | 12/21/39/75 | — | pass | — | G ≈ 2141 + 6.36·N | 0.2011 | — |

### 逐点数据（对照组）

| 文档 | 类 | N | S | G(gzip 内层) | V(展开) | κ | B/组合 | 单变体完整网格 B |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ctl-values-12values.multiblock.json | 对照 | 48 | 26 | 44898 | 42009 | 0.936 | 935.4 | 115.0 |
| ctl-values-13values.multiblock.json | 对照 | 52 | 27 | 44999 | 44255 | 0.983 | 865.4 | 115.3 |
| ctl-values-14values.multiblock.json | 对照 | 56 | 28 | 45103 | 46501 | 1.031 | 805.4 | 115.6 |
| ctl-values-15values.multiblock.json | 对照 | 60 | 29 | 45180 | 48747 | 1.079 | 753.0 | 115.8 |
| mteelectricblastfurnace.multiblock.json | 全量域 | 420 | 29 | 48765 | 90819 | 1.862 | 116.1 | 116.7 |
| ctl-chan-1-shielding.multiblock.json | 对照 | 10 | 9 | 44991 | 131182 | 2.916 | 4499.1 | 10139.4 |
| ctl-chan-1-manipulator.multiblock.json | 对照 | 10 | 9 | 45116 | 131368 | 2.912 | 4511.6 | 10158.2 |
| ctl-chan-2-degenerate.multiblock.json | 对照 | 10 | 10 | 45283 | 131182 | 2.897 | 4528.3 | 10139.4 |
| ctl-chan-2-both.multiblock.json | 对照 | 50 | 14 | 46405 | 549179 | 11.834 | 928.1 | 10281.0 |
| mtequantumforcetransformer.multiblock.json | 全量域 | 200 | 14 | 49083 | 2099829 | 42.781 | 245.4 | 10323.5 |

### R1/R2/R3 逐条读数

**encoder-values**（pass-with-caveat）

- R1 N 48→52：κ ×1.051 ≥ 0.861 → ✔；边际 25.3 B/组合（声明部分 12.3 B/组合）
- R1 N 52→56：κ ×1.048 ≥ 0.861 → ✔；边际 26.0 B/组合（声明部分 12.3 B/组合）
- R1 N 56→60：κ ×1.047 ≥ 0.861 → ✔；边际 19.3 B/组合（声明部分 8.0 B/组合）
- R2：not-applicable（pool-dominated）G ≈ 43763 + 23.75·N，R²=0.9958；b·N_max=1425 B，闸门 87525 B（满足=false）
- 变量部分 b·N_max=1425 B < 4096 B → 按契约 §9.3 "该点无判定意义"。该序列的常数由**每文件固定池**主导（池 gzip 40163 B 占截距 a=43763 的 92%；T1.4 开放项 2：materialPalette/textureBlobs 未按机剪枝），与 N 无关 → R2 的 k 序列判定改由契约 k 序列承担；本序列的边际成本证据：48→52 边际 25.3 B/组合 vs 单变体网格 115 B；52→56 边际 26.0 B/组合 vs 单变体网格 116 B；56→60 边际 19.3 B/组合 vs 单变体网格 116 B
- R3 N 48→52：spart 37593→39377 B（×1.047）≤ 2.804 → ✔
- R3 N 52→56：spart 39377→41161 B（×1.045）≤ 2.800 → ✔
- R3 N 56→60：spart 41161→42945 B（×1.043）≤ 2.796 → ✔

**encoder-channels**（pass-with-caveat）

- R1 N 10→10：跳过（N 相同（通道轴声明成本，无组合增量））
- R1 N 10→10：跳过（N 相同（通道轴声明成本，无组合增量））
- R1 N 10→50：κ ×4.085 ≥ 0.861 → ✔；边际 28.1 B/组合（声明部分 23.0 B/组合）
- R2：not-applicable（pool-dominated）G ≈ 44811 + 31.88·N，R²=0.9660；b·N_max=1594 B，闸门 89623 B（满足=false）
- 变量部分 b·N_max=1594 B < 4096 B → 按契约 §9.3 "该点无判定意义"。该序列的常数由**每文件固定池**主导（池 gzip 40163 B 占截距 a=44811 的 90%；T1.4 开放项 2：materialPalette/textureBlobs 未按机剪枝），与 N 无关 → R2 的 k 序列判定改由契约 k 序列承担；本序列的边际成本证据：10→50 边际 28.1 B/组合 vs 单变体网格 10281 B
- R3 N 10→10：spart 45120→46949 B（×1.041）≤ 2.700 → ✔
- R3 N 10→10：spart 46949→45120 B（×0.961）≤ 3.000 → ✔
- R3 N 10→50：spart 45120→56071 B（×1.243）≤ 3.780 → ✔

### 风险 4：调色板并集体量占比

判定：**pass**（依据：deliverable-products；阈值 warn 0.25 / red 0.4）

| 文件 | 调色板条目 | 未引用条目 | 并集字节 | 内层字节 | 占比 | 固定池占比 |
|---|---:|---:|---:|---:|---:|---:|
| mteadvebf.multiblock.json | 25 | 0 | 50573 | 232587 | 21.7% | 31.1% |
| mtebrickedblastfurnace.multiblock.json | 4 | 0 | 6336 | 82365 | 7.7% | 87.8% |
| mtedistillationtower.multiblock.json | 10 | 0 | 23422 | 155504 | 15.1% | 46.5% |
| mteelectricblastfurnace.multiblock.json | 22 | 0 | 41799 | 223832 | 18.7% | 32.3% |
| mtequantumforcetransformer.multiblock.json | 14 | 0 | 35129 | 343476 | 10.2% | 21.0% |

去重率证据（mod 捕获统计）：变体 1262 → 并集条目 57（每条目服务 22.1 个变体）；抑制重复捕获 10592 次 → ✔ 真去重

### 判据说明（机器生成）

- R1/R3 在**真实编码器对照组**上判定（离线 MultiblockFactorizeTool 对捕获数据集做域子集重编码，与生产同一 Java 编码器）。
- R2 的正式判定落在**契约 k 序列**（T0.5 参考实现 `validate-multiblock-fixtures.mjs --volume` 对契约 fixture 做通道域 ×1/×2/×4/×8 放大）：真实产物序列的变量部分 b·N_max≈1.4 KB < 4096 B 下限，按契约 §9.3 属"该点无判定意义"；R2 在真实序列上的可判部分（斜率 b ≤ 2048、R² ≥ 0.95）与补充判据（每组合边际 < 单变体完整网格、截距主要来自固定池）如实记录，不静默算通过。
- R2 的恒定项闸门 `b·N_max ≥ 2·max(a,4096)` 在真实产物上必然不满足：每文件 materialPalette+textureBlobs 池 ≈40 KB gzip（T1.4 开放项 2：未按机剪枝）、而契约 §9.4 的 4096 B 下限是按"信封头 300–400 B"设的。该差异已登记为 openItem，需调度者知悉（不影响"无组合展开"结论：见 R1/R3/边际/κ 四路证据）。
- V 的口径 = blockPalette×1 + Σ 每变体完整 cellGrid（不含材质/贴图池，与契约 §9.2 字面口径一致）；κ①（含池）见 contractKSequence。
- G 的口径 = 内层 body JSON 的 gzip level 9（确定性，同一输入两次运行逐字节一致）。

### 产物位置

- 机读数据：`scripts/acceptance/.out/acceptance-run-20261003-012505/volume/volume-curve.json`
- 曲线图：`scripts/acceptance/.out/acceptance-run-20261003-012505/volume/volume-curve.svg`
- 人读表格：`scripts/acceptance/.out/acceptance-run-20261003-012505/volume/volume-curve.md`
- T0.1 分桶：`scripts/acceptance/.out/acceptance-run-20261003-012505/volume/profile.md`
- 验收报告：`scripts/acceptance/.out/acceptance-run-20261003-012505/acceptance-report.json`（`volumeCurve` 段）

