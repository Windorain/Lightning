# Lightning

Minecraft 结构数据在线重放平台。

## 目录

- `protocol/` — 数据协议定义（buf + protobuf），Java + TypeScript 代码生成
- `web/` — 前端（EmbedViewer + Workbench）
- `mod/` — MC mod（按版本分子目录）
- `docs/` — 文档

## 快速开始

    npm run build:web       # 构建前端
    npm run build:mod:gtnh  # 构建 GTNH mod
    npm run build:all       # 全部构建
    npm run protocol:gen    # 生成协议代码
