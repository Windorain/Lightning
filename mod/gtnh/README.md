# Lightning

GTNH 1.7.10 模组，用 `/sde` 命令捕获游戏内方块结构并导出为 JSON 场景。命令要求 OP 权限等级 2。

## `/sde` 命令

| 子命令 | 说明 |
|--------|------|
| `pos1` / `pos2` | 以玩家脚下的方块作为选区角点。 |
| `hpos1` / `hpos2` | 以准星指向的方块作为选区角点。 |
| `sel [cuboid\|extend]` | 选择选区模式；默认 `cuboid`，`extend` 把新点并入并扩张包围盒。 |
| `start` / `end` | 开始或结束一次导出会话。 |
| `setname <name>` | 设置输出文件名（不含后缀）。 |
| `setframe <n>` | 设置活动帧号。 |
| `setstructureid <id>` | 设置结构 id。 |
| `record [N\|cycle]` | 把当前选区写入活动帧。`N` 为连续记录的 tick 数，上限 256；`cycle` 从下一 tick 起比较 scan，最多 256 tick。记录只写内存，未落盘。 |
| `export [raw]` | 写出场景文件到 `structure_exports/`。默认写 Envelope；`raw` 写 Plain。 |
| `multiblock [all\|<name,...>] [limit=N]` | 登记一次多方块导出；`limit` 限制本次导出的台数。 |
| `dump` | 请求转储注册表：先写 `pending_dump.json`，随后由客户端生成 `block_registry.json` 与 `material_registry.json`。 |
| `status` | 显示当前会话、选区与输出状态。 |
| `web [port]` | 启动本机 Workbench 服务；默认端口 `37564`，被占用时依次尝试后续端口，最多 128 个。 |
| `webstop` | 停止本机 Web 服务。 |
| `hajimi [name]` / `hjm [name]` | 设置名称（默认 `export`）、记录当前选区、导出，并把场景发给客户端写入本地 `structure_exports/`。 |

## 最短流程

1. `/sde start`
2. 选角点：`/sde pos1` 与 `/sde pos2`（脚下方块），或 `/sde hpos1` 与 `/sde hpos2`（准星方块）。
3. 可选：`/sde setname <name>`、`/sde setframe <n>`。
4. `/sde record`
5. `/sde export`（需要明文时用 `/sde export raw`）
6. 打开生成的场景：用 `/sde web` 启动工作台，或在文件系统中打开 `structure_exports/<name>.json`。

多帧场景在每次 `record` 前用 `setframe` 切换活动帧，最后一次 `export` 写出全部帧。

## 多方块导出

`/sde multiblock` 只登记导出请求；实际导出由控制面动作 `export.multiblock` 执行，每台机器生成一份多方块文档。产物目录默认 `<mcDataDir>/sde_multiblock_exports/`，与 `/sde export` 的场景目录相互独立；目录名与导出台数上限可在 `<mcDataDir>/config/sde_multiblock.cfg` 中调整。

该动作的前置是枚举事实层 `<mcDataDir>/multiblock_scan/run-*/machines.json`。仓库当前没有用户可达的入口生成这份枚举数据；缺少时导出以 `CP-STATE-001` 显式失败，不会代为扫描。

## 本机工作台

`/sde web [port]` 在 `127.0.0.1` 上启动 HTTP 服务，从 jar 内提供 Workbench，并在聊天栏输出带 token 的访问链接。服务只读 `structure_exports/` 下的场景文件，写入限于工作区 JSON；停止服务用 `/sde webstop`。
