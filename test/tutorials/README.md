# `test/tutorials/` —— 教程复现程序

本目录存放「教程 → 场景文件」的复现程序。当前没有教程资产，目录只含本文件；新增教程须满足下列最小结构。

## 目录结构

一个教程一个目录，两级，目录名为教程 slug（kebab-case）：

```text
tutorials/<slug>/
  program.json    # lightning.case/1 固定程序，用 action 段编排 L0/L1
  SOURCE.md       # 教程出处（URL + 取用日期）
  frames.md       # 逐帧的世界状态与 export 顺序
```

## 约束

- `program.json` 自包含（无 `include` / `ref` / `extends`），`world` 段 `void: true`、`seed` 与 `base` 固定。
- `frames.md` 逐帧写死世界状态与导出顺序；多帧必须在同一会话、同一导出缓冲内完成，跨会话拼接不构成合法产物（`frames: "all"` 与 `expectFrames` 的口径见 [case-file.md](../../docs/control-plane/case-file.md) §3.3）。
- 期望产物 = 场景文件（`format_version: "2.0"` 与 `frames[]`）+ 关键帧的读面记录；两者都进 run 目录并登记哈希。
- `SOURCE.md` 记录教程原文 URL 与取用日期：教程原文会变，基准需要可追溯。
