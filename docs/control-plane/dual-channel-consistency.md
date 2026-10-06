# 双通道一致性测试方法（D2 判据口径）

> **归属**：Gitea #100（收口T3）定义方法；**#102**（收口T5）执行 D2 验收。
> **上游判据**：#96 §8.2「命令不扭曲行为」、§10-D2「同语义经 API 与经命令执行结果一致，可复算」。
> **本文是方法定义，不是执行记录**——本单只交付「怎么比、比什么、什么算通过」，
> 实际对照记录由 #102 在导出能力搬迁完成后产出。

---

## 1. 为什么需要一份方法定义

#100 交付了**两条语义通道**：

| 通道 | 入口 | 语义 |
|---|---|---|
| **命令通道** | `cmd.exec {command:"/sde <sub> [...]"}` | 把命令文本原样交给服务端真实命令处理器 |
| **API 通道** | 自述动作（`export.session` 及 #102 将新增的导出动作） | 直接调用实现 |

两条通道都能驱动同一份 `ExportSession` 状态。**没有方法定义，D2 就会退化成两种错误的验证**：

- **比文本**：拿 `cmd.exec` 的 `reply` 与 API 返回的 JSON 字符串比对——它们形态必然不同（一个是给人看的
  一行中文摘要，一个是结构化 JSON），比字符串只会恒红或恒绿，不构成判据；
- **比「看起来对」**：两边都没报错就算通过——这正违反 #96 §8.5「不空转绿」。

正确的判据是：**把两条通道的产物各自读回，规范化后逐字段比对；差异必须为空**。

---

## 2. 比对口径（三条，缺一不可）

### 2.1 口径一：状态读面比对（同语义 → 同状态）

**方法**：同一语义分别经两条通道执行，之后**都**用唯一的结构化读面 `export.session` 读回，逐字段比对。

```
步骤 A（命令通道）：POST /cp/v1/actions/cmd.exec   {"command":"/sde setframe 5","confirm":true}
步骤 B（API 通道）  ：POST /cp/v1/actions/<等价动作> {...}
步骤 C（两侧共用）  ：POST /cp/v1/actions/export.session  {}   → 快照 S_A / S_B
断言                ：canonical(S_A) == canonical(S_B)                （排除时间戳类字段）
```

**为什么用 `export.session` 做裁判**（而不是各通道的返回值）：它是**唯一**的结构化单例态读面，
且经 `ExportSession.snapshot()` 在同一临界区取数（contract.md §4.3.5）——两侧读的是同一把锁保护的同一份
状态，比对的是**状态**而不是两条通道各自的**自述**。用返回值比对会陷入「两边各自说自己对了」的循环论证。

**规范化口径**（"canonical" 的含义，必须写进 #102 的驱动脚本）：

1. 剔除**时间戳类**字段（`contractVersion` 可比，`elapsedMs`/`serverTick`/`ts` 不可比）；
2. 剔除**通道自述类**字段（`command`/`reply`/`status`/`executedOnThread`/`senderName`——它们是「怎么做的」，
   不是「做成了什么」）；
3. 残余字段按 `Json.canonical(...)`（键字典序、无空白）序列化后比对——同一份摘要不论字段书写顺序
   哈希必须一致（口径与 observation-record.md §2.1 一致）。

### 2.2 口径二：产物比对（同语义 → 同产物）

**方法**：对**产出文件**的语义（`export` / `dump` / `multiblock`），两条通道各自执行后，
把产物按**内容规范化**后比对哈希。

```
产物比对 = sha256( canonicalize(读回产物 JSON) )
```

**关键**：不能直接比文件字节。原因：产物含 `author`、`gtnhVersion`、以及 JSON 键顺序差异；
且 **#102 之前**，命令通道的 `export` 产物会被客户端 enrich **覆盖**（contract.md §4.3.4 的已知事实），
两侧的文件形态本就不同（服务端 scan 中间态 vs 客户端烘焙信封）。
因此规范化必须包含：**解析 JSON → 摘出语义子树 → 键排序 → 去空白 → 哈希**。
**语义子树的定义由 #102 在搬迁导出动作时一并写进该动作的自述**（例如场景文件的 `frames[].structure` 部分）。

> **#102 注意**：若产物纪律搬迁（写进 run 目录、进哈希清单）改变了字节，**不得**把「字节哈希相等」
> 当作 D2 判据——那会把「搬迁」误判成「不一致」。判据锚定的是**语义**，不是字节。

### 2.3 口径三：并发口径（裁决 13 的必比项）

**要求**：D2 的比对必须在**两条通道并发**时仍然成立。这是 #100 裁决 13（`ExportSession` 加锁）
的直接验收面，也是「同语义」在集成服里的**真实运行条件**——命令在 `Server thread`、
cp 动作在 `Client thread`，二者**本来就并行**。

**方法**（三步）：

```
① 并发写：线程 A 循环 POST cmd.exec {command:"/sde setframe <k>"}（服务端线程执行）
          线程 B 循环 POST export.session（客户端 tick 线程执行）
          持续 N 秒 / M 次；记录全部响应与耗时
② 交叉读：并发结束后，先经 export.session 读回终态 S_cmd；
          再用 API 通道设同一终值，读回 S_api
③ 断言：
   (a) S_cmd == S_api                      —— 并发写入后语义仍然一致（口径一在并发下成立）
   (b) 无 5xx、无 CP-EXEC-001、无死锁       —— 全部请求在各自 timeout 内返回
   (c) 无撕裂：S_cmd 内部自洽               —— recordedFrameCount == len(recordedFrames)，
                                               activeFrame 在合法域内
```

**并发口径的「撕裂」定义**（可判定，不许含糊）：快照 `S` 撕裂 ⇔ 存在字段对 `(x, y)` 满足
「不可能同时成立」的关系。当前已识别的只有一条：

> `recordedFrameCount != len(recordedFrames)`

（二者在同一临界区算出，不等即为锁失效）。**其余跨字段关系不构成撕裂判据**——
例如「`activeFrame` 必须是已登记帧之一」是**错的**：`setActiveFrame` 与 `record`
本就是两次独立写，快照合法地落在两次写之间（该反例已在 #100 的单测里踩过并记录，
见 `ExportSessionConcurrencyTest` 的类注释）。**#102 不要发明跨字段不变式**：
只断言真正在同一临界区内成立的关系。

---

## 3. 判据汇总表（#102 直接照此落断言）

| # | 判据 | 观测手段 | 通过条件 |
|---|---|---|---|
| D2-1 | 状态一致（串行） | 两通道各执行同语义 → `export.session` ×2 | `canonical(S_A) == canonical(S_B)` |
| D2-2 | 状态一致（并发） | 口径三步骤 ①→③(a) | `canonical(S_cmd) == canonical(S_api)` |
| D2-3 | 产物语义一致 | 两侧产物规范化哈希 | 哈希相等（**按 §2.2 的语义子树口径**） |
| D2-4 | 无空转绿 | 全部请求的错误码与作业终态 | 无 5xx；无 `state=failed`；**拒绝也必须是预期的那个码** |
| D2-5 | 无死锁 | 并发调用的完成率与耗时 | 100% 在 timeout 内返回；无超时作业 |
| D2-6 | 无撕裂 | 口径三 ③(c) | `recordedFrameCount == len(recordedFrames)` 恒成立 |

**负对照（必须做，否则 D2-4 无意义）**：故意构造一条**应当被拒**的调用
（如 `cmd.exec {command:"/sde web"}`），断言它**确实**以 `CP-VALID-002` 被拒、
且带 `context.alternatives[]`。若负对照「通过」了，说明判据没有判别力。

---

## 4. 与 #100 已交付部分的关系

| 判据 | #100 是否已可执行 | 说明 |
|---|---|---|
| D2-1 | **可**（部分） | `setframe`/`setname`/`setstructureid`/`sel`/`start`/`end` 的语义已可由命令通道驱动；API 侧的**等价动作**尚未存在（#102 交付），故当前只能做「命令通道 → `export.session` 读回 = 期望值」的**单侧**验证 |
| D2-2 | **可** | 并发口径不依赖 API 侧动作：A 打 `cmd.exec`、B 打 `export.session`（`export.session` 本身就是只读 API 通道），即可验证锁在并发下成立 |
| D2-3 | **不可** | 需 #102 的导出动作落地后才有第二条产物通道 |
| D2-4/5/6 | **可** | 已在 #100 实现（`cmd.exec` 的拒绝路径 + `ExportSession` 的锁） |

**#100 自评**：D2 的**方法**已定义（本文），D2-2/D2-4/D2-5/D2-6 所依赖的实现已交付并有实机证据；
D2-1（API 侧等价动作）与 D2-3（第二条产物通道）**明确留给 #102**——这是任务单「双通道一致性测试方法
已定义…供 #102 执行 D2 验收」的字面要求。

---

## 5. 复算入口

- 调用工具：`scripts/control-plane/caller.mjs`（零硬编码动作知识，全部参数自 `GET /cp/v1/actions` 探测）；
- 白名单表：`client/controlplane/mc/cmd/SdeCommandWhitelist.java`（唯一权威，可静态审阅）；
- 锁口径：`core/session/ExportSession.java` 类注释「线程语义与互斥口径」；
- 单测（可离线复算锁的承重性）：`core/session/ExportSessionConcurrencyTest.java`
  （**已验证**：去掉写路径的锁后该测试以 `ArrayIndexOutOfBoundsException` 稳定变红，见 #100 证据目录）。
