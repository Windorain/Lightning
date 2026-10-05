# 观测记录规范（lightning.observation/1）

> 承载 Issue #57 交付物三、#47 评论 id=664 的 A10。每次 `case.run` 在 run 目录落 `observation.json`。
> 判据：**仅据本文件即可解释一次观测**——它是什么版本产出的、在什么客户端配置下、以什么观察条件、
> 读了哪些运行期状态、产出了什么。截图类证据必须另标注渲染模式与观测条件（V11，逐图在机位产物里）。

## 1. 结构

```jsonc
{
  "schema": "lightning.observation/1",
  "runId": "20261006-120000-lp-pipe-row-7",
  "caseId": "lp-pipe-row",
  "caseSha256": "...",                 // 用例文件内容哈希
  "createdAt": "2026-10-06T12:00:00+08:00",
  "versions": {                        // 世界与模组版本
    "mod": "0.3",
    "minecraft": "1.7.10",
    "forge": "10.13.4.1614",
    "mods": [ {"id":"logisticspipes","version":"1.5.28-GTNH"}, ... ]  // 与场景相关的模组，构建期声明
  },
  "clientConfig": {                    // 渲染相关客户端配置（快照）
    "fovSetting": 70, "renderDistanceChunks": 12, "fancyGraphics": true,
    "fboEnable": true, "displayWidth": 854, "displayHeight": 480,
    "guiScale": 0, "anaglyph": false
  },
  "observation": {                     // 观察条件
    "camera": {"mode": "player" },     // PR-2 起：{mode:"injected", pos, yaw, pitch, projection:{type:"ortho",...}}
    "projection": "perspective",       // PR-2 起可为 "ortho"
    "target": {"bbox": [[65,12,64],[68,13,64]]},
    "worldTime": 6000,
    "lighting": "natural",             // natural | neutral-flat
    "renderMode": "本色",               // 豁免一：本色 | 参与光照（逐图在机位产物标注，此栏为会话默认）
    "playerPos": [64.5, 13.0, 70.5]    // 门控位置（A3：观察位置与门控位置分离记录）
  },
  "runtimeReads": [                    // 读取过的关键运行期状态摘要与哈希
    {"key": "world.sceneManifest", "summary": "5 blocks, 2 TE", "sha256": "..."},
    {"key": "te.lpPipe[65,12,64].state", "summary": "...", "sha256": "..."}
  ],
  "artifacts": [                       // 扫描数据引用与哈希
    {"path": "world/scene-manifest.json", "role": "scene-manifest", "bytes": 1234, "sha256": "..."}
  ]
}
```

## 2. 规则

1. **哈希口径**：`sha256` 对被引文件的字节内容计算；`runtimeReads[].sha256` 对摘要对象的规范化 JSON（键排序、无空白）计算。
2. **不含**的东西：本文件不是日志（日志走事件流水与 log tail），不是判据结论（走 `criteria.json`）。
3. PR-1 时 `observation.camera/projection` 为占位值（player/perspective），PR-2 起由拍摄动作填充真实机位与投影参数；字段一经引入不得改义（契约版本化规则同 contract.md §5）。
4. 观测记录随产物落盘、随产物归档上 Gitea；`temp/` 只放可弃副本。
