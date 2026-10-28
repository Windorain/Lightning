# 观测记录规范（lightning.observation/1）

每次 `case.run` 在 run 目录落 `observation.json`。本文件定义该记录的结构与解释规则：仅凭它即可解释一次观测由哪个版本产出、在什么客户端配置与观察条件下取得、读取了哪些运行期状态、产出了什么。截图类证据另由逐机位产物标注渲染模式与观测条件。

记录骨架与哈希口径由 `core/ObservationRecord` 保证，取值由 `mc/ObservationCollector` 采集。下例只表示字段形态：尖括号与 `0`/`[]` 是占位，不是任何一次运行的取值，也不构成对当前版本的承诺；字段实际取值以当次采集结果为准。

## 1. 结构

```jsonc
{
  "schema": "lightning.observation/1",
  "runId": "<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>",
  "caseId": "<caseId>",
  "caseSha256": "...",                 // 用例文件内容哈希
  "createdAt": "<ISO-8601 带偏移>",
  "versions": {
    "mod": "<modVersion>",
    "minecraft": "<minecraftVersion>",
    "forge": "<forgeVersion>",
    "mods": [ {"id": "<modId>", "version": "<version>"} ],  // 只列场景相关模组
    "modsTotal": 0                                          // 整合包模组总数，全量清单不进本记录
  },
  "clientConfig": {                    // 渲染相关客户端配置快照（13 个字段，见 §1.1）
    "fovSetting": 70.0,
    "renderDistanceChunks": 12,
    "fancyGraphics": true,
    "fboEnable": true,
    "guiScale": 0,
    "anaglyph": false,
    "pauseOnLostFocus": false,
    "viewBobbing": false,
    "ambientOcclusion": 1,
    "gamma": 0.5,
    "particles": 0,
    "displayWidth": 854,
    "displayHeight": 480
  },
  "observation": {                     // 观察条件（§1.2）
    "camera": {"mode": "player"},      // 有拍摄段时为 {"mode":"injected","name","pos","yaw","pitch","projection"}
    "projection": "perspective",       // 有拍摄段时为首个机位的投影类型
    "worldTime": 6000,
    "lighting": "natural",             // natural | neutral-flat
    "renderMode": "本色",               // 本色 | 参与光照
    "target": {"bbox": [[65,12,64],[68,13,64]]},
    "playerPos": [64.5, 13.0, 70.5],   // 真实玩家位置，与机位分别记录
    "sceneSha256": "...",              // 本次场景清单哈希（无清单时不出现）
    "cameraCount": 3                   // 有机位时出现
  },
  "runtimeReads": [                    // 读取过的运行期状态摘要与哈希（§1.3）
    {"key": "world.sceneManifest", "summary": "5 blocks, 2 TE", "sha256": "..."},
    {"key": "te.lp-pipe[65,12,64].state", "summary": "lp-pipe pipeType=basic initialized=true", "sha256": "..."}
  ],
  "artifacts": [                       // 产物引用与哈希
    {"path": "world/scene-manifest.json", "role": "scene-manifest", "bytes": 1234, "sha256": "..."}
  ]
}
```

### 1.1 `clientConfig` 字段（完整 13 个）

| 字段 | 类型 | 来源与口径 |
|---|---|---|
| `fovSetting` | number | 视野设置 |
| `renderDistanceChunks` | int | 渲染距离（区块） |
| `fancyGraphics` | boolean | 精细画质开关 |
| `fboEnable` | boolean | FBO 渲染开关 |
| `guiScale` | int | GUI 缩放档位（0 = 自动） |
| `anaglyph` | boolean | 立体渲染开关 |
| `pauseOnLostFocus` | boolean | 失焦是否暂停；无人值守必须为 `false` |
| `viewBobbing` | boolean | 视角摇晃 |
| `ambientOcclusion` | int | 平滑光照档位 |
| `gamma` | number | 亮度（`gammaSetting`） |
| `particles` | int | 粒子等级（`particleSetting`） |
| `displayWidth` | int | 客户端渲染宽度（像素） |
| `displayHeight` | int | 客户端渲染高度（像素） |

### 1.2 `observation` 字段

| 字段 | 说明 |
|---|---|
| `camera` | 无拍摄段时为占位值 `{"mode":"player"}`；有拍摄段时为 `{"mode":"injected", name, pos, yaw, pitch, projection}`，记录首个机位 |
| `projection` | `perspective` 或 `ortho`；有拍摄段时取首个机位的投影类型 |
| `worldTime` | 世界时刻；有拍摄段且会话声明 `worldTime` 时取该值 |
| `lighting` | 会话光照口径，默认 `natural` |
| `renderMode` | 会话渲染模式，默认 `本色` |
| `target` | `{bbox:[[minx,miny,minz],[maxx,maxy,maxz]]}`，由规范化计划的 `build` 步坐标推出（无 `build` 步时用 `world.base`）；推不出时 `bbox` 为 `null` 并给 `note` |
| `playerPos` | 真实玩家位置（三位小数），与机位分别记录 |
| `sceneSha256` | 本次场景清单哈希，无清单时不出现 |
| `cameraCount` | 机位数，仅在有拍摄段时出现 |
| `cameras[]` | 有拍摄段时追加全部机位摘要 `{name, pos, yaw, pitch, projection, resolution, tile?}`，按机位声明序 |

### 1.3 `runtimeReads` 的键

| key | 摘要对象 | 出现条件 |
|---|---|---|
| `world.sceneManifest` | 场景清单的块/TE 子集 | 有场景清单 |
| `world.sceneSha256` | 清单哈希 | 有场景清单 |
| `world.sceneMeta` | `{folder, seed, stepCount, settleTicks, void}` | 有场景清单 |
| `world.info` | 世界描述对象 | 每次 |
| `criteria.summary` | 判据计数对象 | 跑了判据段 |
| `run.manifest` | `{runId, caseId, jobSeq, createdAt, artifactCount}` | 每次（有 run） |
| `run.failure` | 失败信封 | 作业失败时 |
| `te.<族>[x,y,z].state` | 该族描述器输出 | 规范化计划的 `te` 步且该族有描述器 |

`te.*` 条目的族名即 `te` 步声明的 completer 名（`lp-pipe`、`ae2-part` 等）；位置取自规范化计划的 `te` 步，不取场景清单。描述器不认领该位置时写 `{"te":"absent","family":...}` 并给说明；该族没有描述器时整条跳过。

## 2. 规则

1. **哈希口径**：`artifacts[].sha256` 对被引文件的字节内容计算（登记产物时算好）；`runtimeReads[].sha256` 对摘要对象的规范化 JSON（键排序、无空白）计算（`ObservationRecord.hashSummary`）。同一份摘要不论字段书写顺序，哈希一致。
2. **本文件不承担的职责**：不是日志（日志走事件流水与 `logs/tail`），不是判据结论（走 `criteria.json`），不是证据核对（走 `evidence.json`）。
3. **字段一经引入不得改义**（版本规则同 `contract.md` §13）；只增字段。
4. **多机位口径**：`observation.camera` 记录首个机位作为会话代表，`observation.cameras[]` 追加全部机位摘要；逐机位的实际 `renderMode`/`lighting`/`worldTime` 落 `shots/<name>.meta.json`（schema `lightning.shot-meta/1`），`artifacts` 引用全部机位产物。
5. **落盘与归档**：记录随本次 run 的产物一起保存，不使用临时副本充当正式证据。
