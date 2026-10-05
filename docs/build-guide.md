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

### 版本锁步纪律（准入线）

编译期看到的 jar 与运行期真正装载的 jar **必须是同一个版本**，否则症状是"编译能过、游戏里
`NoSuchMethodError`/`NoClassDefFoundError`"——与 gson 那条同源，都是**编译期/运行期脱钩**。
四条纪律（`mod/gtnh/dependencies.gradle` 是唯一落点）：

1. **同一依赖的 `compileOnly` 与 `runtimeOnlyNonPublishable` 必须用同一个变量展开，禁止各写字面量。**
   正确样例：GT5U 两侧都是 `${gt5Ver}`，StructureLib 两侧都是 `${structureLibVer}`。
   反例（现存）：GTNHLib 的 `compileOnly` 用 `${gtnhLibVer}`（默认 **0.9.62**），而
   `runtimeOnlyNonPublishable` 写死字面量 **0.9.20** —— 两个数字漂在文件里，谁也不知道该跟谁。
2. **StructureLib 版本单点化。** 编译与运行都取 `${structureLibVer}`
   （`gtnhRun.structureLibVersion`，默认 **1.4.28**），它与 **GT5U 5.09.52.283 自声明的 StructureLib 版本一致**。
   本树 `gradle.properties` 只覆写了 `gtnhRun.gt5Version`，故 StructureLib 走默认值 = 1.4.28。
3. **升级 GT5U 时必须同时核对并同步其声明的 StructureLib 版本**（GT5U 的 `dependencies.gradle`
   会声明 StructureLib 坐标）。只改 `gtnhRun.gt5Version` 而不同步 StructureLib，等于把第 1 条的漂移
   重新引入一次；版本对不上时优先相信 GT5U 的声明。
4. **`compileOnly` 取"运行期实际解析结果"，不取某个 jar 的自声明元数据。**
   例：GTNHLib 的模块元数据声明 0.9.20，但本树 `runtimeClasspath` 实际解析到 **0.9.62**
   （LogisticsPipes 等运行时条目把版本抬上来了），故 `compileOnly` 用 0.9.62。
   取法（也是复核手段）：`cd mod/gtnh && ./gradlew dependencies --configuration runtimeClasspath`
   —— 升级任何运行期条目后都要重看这张解析表，别照抄上游仓库里写的版本号。
