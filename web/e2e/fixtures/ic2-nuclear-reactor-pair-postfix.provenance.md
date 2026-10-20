# `ic2-nuclear-reactor-pair-postfix.json` —— #9 棘轮场景的入仓导出件（**判据基线，勿随手再生成**）

## 这是什么

一份**游戏内真实导出**的场景信封（Envelope，`payloadEncoding = gzip+base64`），
作为 E2E 棘轮 `web/e2e/ic2-texture-strip-ratchet.spec.ts` 的**输入与基线**。
它被**提交进仓**（不是 `temp/`、不是 `mod/gtnh/run/` 的树外产物），所以：

- 产物门控（`web/e2e/real-artifact-gate.ts` 的 `committed: true` 条目）**永远不排除**这份 spec；
- 删掉/替换/改坏它 ⇒ spec 自己判红（**不是**"本次没跑"）。

## 来源（可追溯）

| 项 | 值 |
|---|---|
| 游戏内动作 | `export.scene`（`shape=world`，1 帧） |
| runId | `20261021-034525-export-scene-10` |
| exportId | `20261021-034525-export-scene-10#cp-ic2-strip-postfix` |
| 文档 id | `ic2-nuclear-reactor-pair` |
| 采集时间 | 2026-10-21T03:45:25+08:00 |
| 采集世界 | `cp_ic2_strip`，dimension 0，选区 (63,12,63)..(68,14,67) = 6×3×5 |
| 原树外路径 | `temp/pb-ic2-fix/postfix/cp-ic2-strip-postfix.json`（**temp 随时会被删**，故入仓固化） |
| 文件大小 | 20732 B（LF） |
| `sha256(LF)` | `370c50e2569142f39d5b3edb1926651a6bb23e04a5ca7ca49ee118df3b8f200f` |

> 指纹按**CRLF 归一化后**计算：本仓 `core.autocrlf=true`，新鲜检出是 CRLF、工作树常是 LF，
> 不归一化的字节级判据只在其中一种形态下成立（工作区铁律 6）。

## 它固定住的事实（#9 修复批）

IC2 的方块面是**横向多面子图带里的一列**（`blockNuclearReactor` 384×32 = 12 列 × 32px）。
修前导出把**整条带**塞进一个面（384×32），web 侧把 12 列横压到一格 = 黄黑竖条。
修后每面 blob 是**该面自己的 32×32 一格**（`TextureStripCrop` / `TextureBlobEmbedder`，
契约见 `docs/contracts/format-multiblock-doc.md` §3.2）。

本件里 4 条 IC2 面号材质的 blob 全部 32×32：

```
ic2:generator/blockNuclearReactor:4   → 32×32（原带 384×32，面号 4）
ic2:generator/blockRTGenerator:10     → 32×32（原带 384×32，面号 10）
ic2:machine/blockLathe:0              → 32×32（原带 384×32，面号 0）
ic2:machine/blockMiner:7              → 32×32（原带 384×32，面号 7）
```

对照材质（裁列**不该**碰）：`stone` 16×16、`lava_still` 16×16、`lava_flow` 32×32。

## 怎么验证这份件没被动过

```powershell
cd web
$env:PLAYWRIGHT_PORT=5212
npm run test:e2e:tree -- e2e/ic2-texture-strip-ratchet.spec.ts --project=desktop-chrome
```

spec ① 的第一步就是 `sha256(LF)` 比对；读数（黄/黑像素计数）在 spec ② 里逐机位钉死。

## 换件规矩（棘轮口径：只许收紧）

**不要因为"想让它绿"而换件**。确需换（例如场景本身要升级）时，必须在同一个 PR 里：

1. 说明新件的 runId / 来源 / 采集时间，并更新本文件的表格；
2. 同步更新 spec 里的 `PRODUCT_SHA256_LF`、材料清单与像素读数（**不得放宽**容差）；
3. 在 PR 里给出换件前后的负对照读数（旧件/新件各自在哪些判据上红/绿）。

## 负对照（开发期，不入套件）

把本文件**就地覆盖**为修前产物（384×32，`temp/pb-ic2-fix/prefix/cp-ic2-strip-prefix-final.json`，
`sha256(LF) = 08c1ccec38d363fa63f5a4d37276c9638ff87b8015c65c47a2c4762dd8cf50e5`，
36859 B）后定向跑本 spec ⇒ **必须红**（① 报 384×32 整条带；② 黄/黑计数偏离 30%+）。
验证完 `git checkout -- web/e2e/fixtures/ic2-nuclear-reactor-pair-postfix.json` 恢复。
