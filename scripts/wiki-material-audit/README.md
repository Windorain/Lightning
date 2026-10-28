# `scripts/wiki-material-audit/` —— Wiki 异常材质审计

只读清点 GTNH 灰机 Wiki（gtnh.huijiwiki.com）上嵌入了异常材质结构的页面。全程只发 MediaWiki `query` 读请求，不写任何 Wiki 页面；鉴权只用 `HUIJI_AUTHKEY` 环境变量（作为 `X-authkey` 请求头），不读取用户账号或密码。

## 用法

站点由 Cloudflare 托管，匿名请求会被挑战页拦下（HTTP 403，`cf-mitigated: challenge`）。需要团队的灰机共享 key，只能经环境变量传入：

```powershell
$env:HUIJI_AUTHKEY = "<团队共享 key>"
node scripts/wiki-material-audit/audit.mjs
```

| 选项 | 作用 |
|---|---|
| `--out <dir>` | 报告输出目录，默认 `scripts/wiki-material-audit/.out`（已 gitignore） |
| `--page <标题>` | 只审计指定页面，可重复 |
| `--limit <n>` | 最多审计 n 个被引用结构（正整数） |
| `--min-interval <ms>` | 相邻请求最小间隔，默认 1000；不允许小于 1000 |
| `--no-sweep` | 跳过文章命名空间全量正文扫描，只靠模板反链与搜索 |
| `--verbose` | 打印每次命中与判型的中间读数 |
| `--help` | 打印帮助 |

另有两个环境变量：`HUIJI_AUTHKEY`（必填）与 `HUIJI_API_BASE`（覆盖 API 基址）。

退出码：`0` 跑完（无论有无命中）；`1` 参数或前置错误（例如未给 `HUIJI_AUTHKEY`）；`2` 跑完但有结构或页面无法判定。

## 输出

两个文件同名不同后缀，落在 `--out` 目录，写盘前统一为 LF：

| 文件 | 内容 |
|---|---|
| `wiki-material-audit.json` | 机读全量事实：页面、挂载点、结构、异常纹理的读数与引用方块 |
| `wiki-material-audit.md` | 人读汇总：读数表、命中页面、异常材质明细、未判型与缺口清单 |

## 判据

判据只看贴图本身与材质 locator（`detect.mjs` 的 `CRITERIA`），不需要对照上游记录。

### missing-texture（缺失材质占位图）

- 贴图 16×16；
- 颜色数 ≤ 4；
- 洋红像素（`|r-255| < 24` 且 `g < 24` 且 `|b-255| < 24`）占比 > 10%；
- 纯黑像素（`max(r,g,b) < 24`）占比 > 10%。

### ic2-face-strip（IC2 横向多面带）

- 贴图高 32、宽 > 32；
- 宽为 384 或 192（12 面或 6 面，N × 32）；
- 材质 locator 以 `ic2:` 或 `ic2/` 开头。

### unclassified（未判型）

- 横向带但 locator 不是 IC2，或宽度不是 384/192；
- 像占位图（每一维 ≤ 32、颜色数 ≤ 8、洋红与纯黑都出现）但未达 missing-texture 门槛；
- 贴图解码失败（隔行 PNG、非 PNG 等），记为 `error`。

未判型与解码失败如实列出，不并入上面两类。

### 两层判定

- **blob 层**：贴图本身命中上表判据；
- **结构层**：异常纹理被**实际出现在 `cellGrid` 里的方块**引用（`geometry.quads[].materialIndex`）才记 `status=bad`；
- 异常纹理存在但没有任何方块使用 → `status=warn`，不记页面命中；
- 文档既无 `textureBlobs` 也无 `materialPalette` → `status=no-textures`（几何已烘焙成顶点色的导出件没有贴图可判）；
- 结构取不到或解析失败 → `status=unresolved`；页面状态由挂载结构状态归并（含 `bad` 即 `bad`，含 `unresolved`/`error` 即 `unresolved`，含 `warn` 即 `warn`，含 `unaudited` 即 `unaudited`）。

## 枚举口径

- 结构全集：`allpages` 取 Data 命名空间 `Structures/` 前缀下的 `*.json` 页，即 `Data:Structures/*.json`。
- 页面候选：模板 `Template:渲染器` 的反链（`embeddedin`）∪ 文章命名空间（ns=0）全量正文扫描 ∪ `insource:"data-wsr-structure"` 搜索。
- 挂载点：`{{渲染器|结构名称=X}}` 展开出的 `<div class="web-structure-renderer" data-wsr-structure="X">`，或页面里直接写出的同一 div。名字归一化（去 `Data:` 前缀、去 `.json`、标题下划线视同空格）后取 `Data:Structures/X.json`。

## 结构数据格式

- 单页：`{documentFormat:"Envelope", payloadEncoding:"gzip+base64", payload:"<gzip base64>"}`，解压后是 Plain 文档。
- 多帧：几何放在 `frames[].structure`，`textureBlobs` 与 `materialPalette` 仍在根上，两层都要读。
- 分片：索引页 `{documentFormat:"Envelope/multipart", partCount, base}`，分片页 `{documentFormat:"Envelope/part", part, payload}`，按 `part` 顺序拼接 payload 后解 gzip。分片名按 `_NN` 优先、` NN` 退让取（MediaWiki 把下划线规范化为空格，两种写法等价）。

## 测试

```powershell
node --test "scripts/wiki-material-audit/*.test.mjs"
```

当前 36 条，全部离线：PNG 解码往返、missing-texture / ic2-face-strip 的正负对照、未判型边界、frames 布局、Envelope 与分片拼装、wikitext 提取（嵌套模板、`pre`、注释、参数化名字），以及一个本地假 MediaWiki 的端到端用例。文本断言统一按 LF，不受 `core.autocrlf` 影响。

## 边界

- 零依赖：只用 Node 内置 `fetch` 与 `zlib`；PNG 解码是自写最小实现（非隔行、8 位展开），其它形态明确记入未判型，不猜像素。
- 请求节流：相邻请求间隔 ≥ 1000ms，API continue 分页，失败重试 3 次并指数退避，进度日志写 stderr。
- 覆盖范围：结构只经 `allpages(apprefix=Structures/)` 枚举；正文全量扫描只覆盖 ns=0，其它命名空间靠模板反链与 `insource` 搜索；在其它命名空间里直接写挂载 div 且未被搜索索引的页面不会被发现。`--no-sweep` 会明确记录覆盖不完整。
- 判据对象是 `textureBlobs`；几何已烘焙、没有贴图的导出件记 `no-textures`，不进入两类判据。
- `--limit` 只影响结构审计数量，不改变覆盖率口径；批量取正文每批 20 个标题。
