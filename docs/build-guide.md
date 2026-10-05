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
| `JsonObject.keySet()` | `entrySet()` 遍历 |
| `JsonElement.deepCopy()` | 手写递归深拷贝（control-plane 里用 `Json.copy/copyObject/copyArray`；不要用 `parse(toString())` 文本往返——数字会变成 `LazilyParsedNumber`，改变 equals/哈希口径） |
| `JsonParser.parseString/parseReader` | `new JsonParser().parse(...)` |
| `JsonArray.add(String/Number/Boolean)` 标量重载 | `arr.add(new JsonPrimitive(v))` |
| `JsonArray.set(int,·)` / `remove(int)` | 重建数组再替换回去 |

注：`JsonNull.INSTANCE` 在 2.2.4 **存在**（javap 实证），不是雷区。

**编译期护栏**：`cd mod/gtnh && ./gradlew gsonCompatCheck` —— 用 gson 2.2.4 重编译
**全部 main 源码**（已挂 `check`，`build` 也会跑），2.2.4 没有的 API 直接编译报错。
单测 classpath 上是 gson 2.8.9，**单测抓不到这类问题**，护栏是唯一防线。
