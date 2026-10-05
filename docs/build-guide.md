# Build Guide

## Prerequisites

- Node.js 18+, npm
- Java 8 (for GTNH mod)
- buf CLI (`npm install -g @bufbuild/buf` or download from buf.build)

## Quick Start

    # Install web dependencies
    cd web && npm install && cd ..

    # Generate protocol code
    npm run protocol:gen

    # Build web (embed + workbench)
    npm run build:web

    # Build mod (GTNH)
    npm run build:mod:gtnh

## Development

    # Start web dev server
    npm run dev:web

    # Build everything
    npm run build:all

## Mod 侧工程约定（准入线）

### Gson 运行期兼容（硬规则）

GTNH 1.7.10 运行期的 gson 是 **2.2.4**（整合包打包的旧版），而 mod 编译期依赖是 2.8.9
（`mod/gtnh/dependencies.gradle`）。**mod 代码只允许使用 gson 2.2.4 兼容 API**——编译能过、
游戏内 `NoSuchMethodError` 的事故已发生三次（issue #56 主线、部件轮 F6、控制面 PR-1），
属系统性隐患，任何 mod 代码评审必须过这条线。

已知 2.8+ API 雷区（写代码时逐条自查）：

| 2.8+ 写法（禁止） | 2.2.4 兼容写法 |
|---|---|
| `JsonObject.size()` | `obj.entrySet().size()` |
| `JsonElement.deepCopy()` | `new JsonParser().parse(e.toString())` 或手写深拷贝 |
| `JsonParser.parseString/parseReader` | `new JsonParser().parse(...)` |
| `JsonNull.INSTANCE` | `new JsonNull()` |

**编译期护栏**：`cd mod/gtnh && ./gradlew gsonCompatCheck` —— 用 gson 2.2.4 重编译
`client/controlplane/**` 源集，2.2.4 没有的 API 直接编译报错。新增 mod 代码若用到 gson，
应把对应包纳入该护栏的源集（见 `mod/gtnh/build.gradle.kts` 中该 task 的定义）。
单测 classpath 上是 gson 2.8.9，**单测抓不到这类问题**，护栏是唯一防线。
