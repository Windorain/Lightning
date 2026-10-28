# 构建指南

本文件覆盖构建、测试、真实资产配置与平台限制。命令以仓库根 `package.json`、`web/package.json` 与 `mod/gtnh` 的 Gradle 脚本为准。

## 前置

- **Node.js ≥ 22.13.0**：`web/package.json` 的 `engines.node`。
- **pnpm 11.28.5**：由 `web/package.json` 的 `packageManager` 固定；首次使用可执行 `corepack enable`。依赖安装与锁文件只由 pnpm 负责，`npm run` 只执行脚本。
- **JDK**：Mod 使用 `mod/gtnh` 的 Gradle wrapper（9.2.1）。daemon JVM 由 `gradle/gradle-daemon-jvm.properties` 指定为 Java 25；本机无匹配 JDK 时 Gradle 会尝试自动下载，需要网络。
- **PowerShell 7（`pwsh`）**：静态检查与 `scripts/acceptance` 需要。
- **Playwright Chromium**：仅 E2E 需要，浏览器不会随依赖安装自动下载。

## Web

```powershell
cd web
pnpm install --frozen-lockfile
pnpm run dev          # Workbench 开发服务器
pnpm test             # Vitest 单元测试
pnpm run typecheck    # vue-tsc --noEmit
pnpm run build:all    # Embed + Workbench
```

| 目的 | 命令（`web/` 下） | 产物 |
|------|------|------|
| Embed 查看器 | `pnpm run build:embed` | `dist/StructureRender.js` 与 `dist/StructureRender.css`（IIFE） |
| Workbench | `pnpm run build:workbench` | `dist-workbench/` |
| Wiki 工作台 | `pnpm run build:wiki-workbench` | `dist-wiki-workbench/bundled/StructureWorkbench.bundle.js` |

仓库根别名：`npm run dev:web`、`npm run build:web`。

架构边界检查：`pnpm run test:arch`、`pnpm run arch:scan`。

## Mod

Windows：

```powershell
cd mod\gtnh
.\gradlew.bat build
.\gradlew.bat test
.\gradlew.bat gsonCompatCheck
.\gradlew.bat spotlessApply
```

POSIX 使用 `./gradlew` 执行同一组任务；`build` 仍会受下面 `syncWeb` 的 Windows 限制。

`build` 执行 `check`；`gsonCompatCheck` 与 IC2 运行期版本校验挂在 `check` 下。`processResources` 依赖 `syncWeb`：`syncWeb` 在 `web/` 中执行 `npm.cmd run build:workbench`，再把 `dist-workbench` 的 `index.html` 与 `bundled/` 复制进 jar 的 `assets/lightning/web/`。因此完整构建需要先完成 `web` 的依赖安装，并确保 `npm` 在 `PATH` 中；该调用仅在 Windows 可用。

`.\gradlew.bat test` 是纯 JVM 单测，不需要 `web/node_modules`。

### 静态检查

```powershell
# 仓库根
npm run gates:mod-static
pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1 -SkipSpotless
```

该入口默认运行 `gsonCompatCheck` 与 `spotlessJavaCheck`；`-SkipSpotless` 只运行前者。它不运行 `build`，不需要游戏客户端。退出码：`0` 全部通过，`1` 有检查未通过，`2` 编排失败或检查未真正执行（NOT RUN 不算通过）。

## Gson 运行期兼容

`gsonCompatCheck` 使用 gson 2.2.4 编译全部 main 源码，防止误用 2.8+ 独有 API。

```powershell
cd mod\gtnh
.\gradlew.bat gsonCompatCheck
```

该任务挂在 `check` 与 `build` 下；单元测试的 classpath 使用 2.8.9。

协议 schema 与 buf 命令见[协议](protocol.md)。

## E2E

首次安装浏览器：

```powershell
cd web
pnpm exec playwright install chromium
```

`test:e2e:tree`、`test:e2e:smoke`、`test:e2e:full` 要求显式设置 `PLAYWRIGHT_PORT`；未设置时以退出码 2 中止。Wiki 入口使用相邻端口，可用 `PLAYWRIGHT_WIKI_PORT` 覆盖。

```powershell
$env:PLAYWRIGHT_PORT = 5209
cd web
pnpm run test:e2e:smoke   # @smoke 子集，120s 硬预算
pnpm run test:e2e:full    # 浏览器全量，720s 软预算
```

不设 `PLAYWRIGHT_PORT`、只想使用配置缺省端口 5199 时执行 `pnpm run test:e2e`。`full` 只覆盖浏览器端，不是 Minecraft 客户端的产品级 E2E；客户端侧行为需由游戏内真实导出验证。

## 真实资产

真实产物的唯一夹具根键是 `LIGHTNING_REAL_FIXTURES_DIR`。在仓库根复制 `.env.example` 为 `.env`（已被 `.gitignore` 忽略）并填写该键；值可为本机绝对路径，或依次相对当前工作目录、`web/`、仓库根解析的相对路径。

固定目录布局：

| 相对夹具根的路径 | 内容 |
|---|---|
| `multiblock/gg-antimatter-casing-ctm-glass.json` | GG 真实导出件 |
| `tesr/tesr-capture-placeholder.ctm.json` | TESR 捕获占位真实导出件 |
| `multiblock/ic2-nuclear-reactor-pair-postfix.json` | IC2 裁列棘轮基线件 |
| `structuredata/structuredata-exported-envelope.json` | StructureData 真实信封 |

两类验收归档使用独立环境变量：

- **parts**：`PARTS_ACCEPTANCE_DIR` 指向既有的部件验收归档，通常必须显式设置。归档由游戏内部件验收导出产生；仓库不提供该导出的生成入口。
- **multiblock**：`MB_REAL_EXPORTS_DIR` 指向多方块真实产物目录；缺省为 `mod/gtnh/run/client/sde_multiblock_exports`。产物由多方块导出动作（`export.multiblock`）产出；其前置为 `multiblock_scan/run-*/machines.json`，仓库当前没有用户可达的入口生成这份枚举数据。

缺件时，E2E 入口层按产物门控排除对应 spec，打印启动横幅，并把缺失产物与再生方式写入 `web/test-results/e2e-exclusions.json`；不会静默跳过。产物就绪后这些 spec 自动纳入，且必须通过。Vitest 侧依赖真实件的用例在缺件时逐条显式 skip。

## 当前限制

- **干净检出无法跑完整 E2E**：真实产物 spec 会被显式排除，结果是“少跑并登记”，不是“全部通过”。
- **parts 与多方块枚举数据缺少仓库内生成入口**：部件归档需游戏内导出；`multiblock_scan/run-*/machines.json` 缺失时多方块导出无法开始。
- **Wiki 保存/上传只在 Wiki 宿主外壳可用**：需要可用的 MediaWiki（灰机）页面环境。
- **CI 不执行检查**：工作流仅手动触发，不跑构建或测试；不要以 CI 状态代替本地验证。
