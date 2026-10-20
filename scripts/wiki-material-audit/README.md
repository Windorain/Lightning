# wiki-material-audit —— Wiki 错材质自动清点

一条命令回答：**GTNH 灰机 Wiki（gtnh.huijiwiki.com）上哪些页面嵌入了「带坏材质」的结构。**

只读：全程只发 MediaWiki `query` 读请求，不写任何 Wiki 页面，不提交任何凭据。

## 用法

```powershell
# 站点由 Cloudflare 托管，匿名请求会被挑战页拦下（HTTP 403，cf-mitigated: challenge）。
# 需要团队的灰机共享 key（向 Wiki 维护者索取）；只通过环境变量传入，禁止写进仓库。
$env:HUIJI_AUTHKEY = "..."

node scripts/wiki-material-audit/audit.mjs
```

常用选项（调试用小样本，避免每次全站）：

```powershell
node scripts/wiki-material-audit/audit.mjs --page 工业高炉      # 只审计一个页面及其结构
node scripts/wiki-material-audit/audit.mjs --limit 5            # 最多审计 5 个结构
node scripts/wiki-material-audit/audit.mjs --out ./audit-out    # 指定输出目录
node scripts/wiki-material-audit/audit.mjs --no-sweep           # 跳过文章命名空间全量扫描（快，但覆盖不完整）
```

默认输出到 `scripts/wiki-material-audit/.out/`（已 gitignore，产物不入库）：

| 文件 | 内容 |
|---|---|
| `wiki-material-audit.json` | 机读全量事实：每个页面/挂载点/结构/坏 blob/引用方块 |
| `wiki-material-audit.md` | 人读汇总：读数、命中页面、坏材质明细、未判型、缺口 |

退出码：`0` 跑完；`1` 参数或前置错误（如没给 `HUIJI_AUTHKEY`）；`2` 跑完但有结构/页面无法判定。

## 判据

两类可判定的坏材质，加一个「未判型」兜底桶。判据只看贴图本身与材质 locator，不需要对照
任何上游记录或工单。

### missingTexture（缺失材质占位图）

Minecraft 找不到材质时会用一张 16x16 的黑/洋红棋盘占位。判据：

- 贴图 16x16；
- 颜色数 <= 4；
- 洋红像素（`|r-255| < 24` 且 `g < 24` 且 `|b-255| < 24`）占比 > 10%；
- 纯黑像素（`max(r,g,b) < 24`）占比 > 10%。

命中说明导出时材质没解析出来，页面上的方块会显示成黑/洋红棋盘。

### ic2FaceStrip（IC2 横向多面带）

IC2 的部分机器贴图是一张 PNG 横向排多个面（每面 32px）。导出器如果把整条带当成一个面，
就会把 N 个面压进同一个面的 UV 里。判据：

- 贴图高 32、宽 > 32（横向带）；
- 宽为 384 或 192（即 12 面或 6 面，N x 32）；
- 材质 locator 以 `ic2:` 或 `ic2/` 开头。

### 未判型

- 横向带但 locator 不是 IC2，或宽度不是 384/192；
- 像占位图（尺寸 <= 32、颜色数 <= 8、洋红与纯黑都出现）但没达到 missingTexture 门槛；
- 贴图解码失败（隔行 PNG、非 PNG 等）。

这些如实列出，不硬塞进上面两类。

判定分两层，避免冤枉页面：

- **blob 坏**：贴图本身符合判据；
- **结构命中（status=bad）**：坏 blob 还被**实际出现在 `cellGrid` 里的方块**引用（`geometry.quads[].materialIndex`）；
- 坏 blob 存在但没被任何方块使用 → `status=warn`，不记页面命中。

## 侦察结论（2026-10-21，只读实测）

### 结构怎么嵌进页面

1. **模板调用（主流）**：词条里写 `{{渲染器|结构名称=X}}`。`Template:渲染器` 产出
   `<div class="web-structure-renderer" data-wsr-structure="X">`。
2. **直接写 div（高级用法，站内 1 页）**：`<div class="web-structure-renderer" data-wsr-structure="X">`。
3. 客户端（`零件:StructureRenderEntry.js`）把名字归一化后取
   `Data:Structures/X.json?action=raw`；`X.json` 可能是普通 Envelope，也可能是
   `Envelope/multipart` 分片索引（分片页 `X_01.json` …）。

因此枚举口径是：`Data:Structures/*.json` 为结构全集；
页面侧用 `embeddedin`（模板反链）∪ 文章命名空间全量正文扫描 ∪
`insource:"data-wsr-structure"` 搜索补漏，再逐页解析出挂载点。

### 结构数据格式（实测 71 页）

- 单页：`{documentFormat:"Envelope", payloadEncoding:"gzip+base64", payload:"<gzip base64>"}`；
  解压后是 Plain 文档：`textureBlobs[]`（base64 PNG）、`materialPalette[]`
  （`locator` + `textureBlobIndex`）、`blockPalette[]`（`geometry.quads[].materialIndex`）、`cellGrid`。
- 多帧/大结构：`frames[]` 里放各帧几何，**但 `textureBlobs`/`materialPalette` 仍在根上**，
  两层都要看（本工具已处理）。
- 分片：索引页 `{documentFormat:"Envelope/multipart", partCount, base}`，分片页
  `{documentFormat:"Envelope/part", part, payload}`，按 part 顺序拼 payload 再解 gzip。
- **分片命名**：站内 `PseudoBiosphere` 的分片页实际标题是 `PseudoBiosphere 01.json`（空格），
  客户端拼的是 `PseudoBiosphere_01.json`（下划线）。MediaWiki 把下划线规范化为空格，两者等价，
  所以客户端能正常取到（实测该结构 2850 个方块、52 条材质全部审到）。工具仍按
  `_NN` 优先、` NN` 退让的顺序取，不依赖这一规范化行为。

## 测试

```powershell
node --test "scripts/wiki-material-audit/*.test.mjs"
```

36 条，全部离线：PNG 解码往返、missingTexture / ic2FaceStrip 正负对照、未判型边界、frames 布局、
Envelope/分片拼装、wikitext 提取（嵌套模板 / pre / 注释 / 参数化名字）、
以及一条本地假 MediaWiki 的端到端（`audit.test.mjs`，不碰真站）。
文本断言统一按 LF，不受 `core.autocrlf` 影响。

## 设计取舍与已知缺口

- **零依赖**：只用 Node 内置 `fetch` / `zlib`；PNG 解码是自写最小实现（非隔行、8 位展开），
  隔行或非 PNG 贴图会明确记入未判型，不猜像素。
- **礼貌爬取**：相邻请求默认间隔 1000ms（`--min-interval` 只能调大）、API continue 分页、
  失败重试 3 次并指数退避、进度日志打到 stderr。
- **全量扫描的边界**：文章命名空间（ns=0）逐页读正文；其它命名空间靠 template links
  + insource 搜索覆盖。若某页在其它命名空间里直接写挂载 div 且未被搜索索引，会漏。
- **只判贴图材质**：判据对象是 `textureBlobs`。几何已经烘焙成顶点色的导出件没有贴图可判，
  工具会记 `no-textures`，不会假装判过。
- 批量取页面正文每批 20 标题；`--limit` 只影响结构审计数量，不会伪造成覆盖率。
