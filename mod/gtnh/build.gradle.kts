plugins {
    id("com.gtnewhorizons.gtnhconvention")
}

/**
 * 纯 JVM 单元测试基建（`src/test` 下的 JUnit4 单测，用于零 MC 依赖的 control-plane 核心类）。
 *
 * 只做两件事，不改动 convention 插件建立的 sourceSet 结构（main + `mixin`，见
 * `separateMixinSourceSet=mixin`）：
 *  1. 声明 JUnit 4.13.2 依赖。仓库由 convention 插件提供（`includeWellKnownRepositories=true`
 *     已含 mavenCentral），无需在此重复声明 repositories。
 *  2. 显式把标准 `test` task 固定为 JUnit4 引擎（Gradle 默认即 JUnit4，写出来是为了不受
 *     convention 插件未来改动影响）。
 *
 * `testImplementation` 在 Gradle 中 extendsFrom `implementation`，故 main 的 `implementation`
 * 依赖（如 `dependencies.gradle` 里的 gson）在 test 的编译/运行 classpath 上直接可见；
 * `compileOnly` 的 MC/GT 依赖则**不可见**——这正是纯 JVM 单测与游戏内代码的边界。
 */
dependencies {
    testImplementation("junit:junit:4.13.2")
}

// gtnhconvention 不在本脚本的 plugins {} 块内，Kotlin DSL 因此不生成 `sourceSets` 类型安全访问器。
// 用扩展查找取得（`SourceSetContainer` 由 java 插件注册，convention 插件已应用它）。
val lightningSourceSets = extensions.getByType(SourceSetContainer::class.java)

/**
 * 纯 JVM 单测与「web 资源管线」解耦。
 *
 * 背景（实测，非推测）：本脚本让 `processResources` dependsOn `syncWeb`，而 `syncWeb` 会调
 * `npm run build:workbench`（vite）。`web/node_modules` 不入库，新工作树里 vite 不存在 →
 * `syncWeb` 必失败 → 连带 `processResources` 失败。而 java 插件的默认设置把 `main` 的
 * **resources 目录**塞进 test 的 compile/runtime classpath，于是 `gradlew test`
 * （哪怕只跑一个 1+1=2 的测试）也会被拖进 npm 依赖里。
 *
 * 修法：test 的 compile/runtime classpath 只取 `main` 的 **classesDirs**（由 compileJava 产出），
 * 不含 `main` 的 resources 目录。代价：`src/test` 下的单测读不到 `src/main/resources` 里的
 * 资源文件（本仓库的单测是零 MC 依赖的逻辑测试，不需要资源；将来若真需要，再显式加回
 * `mainSourceSet.output.resourcesDir` 并接受必须装好 npm 依赖这件事）。
 *
 * 注意：**不**改动 `processResources dependsOn syncWeb` —— 打包/发布路径的行为保持原样，
 * 免得静默产出没有 web UI 的 jar。
 */
val lightningMainSourceSet = lightningSourceSets.getByName("main")
val lightningTestSourceSet = lightningSourceSets.getByName("test")
val lightningTestCompileClasspath =
    lightningMainSourceSet.output.classesDirs + configurations.getByName("testCompileClasspath")
val lightningTestRuntimeClasspath =
    lightningTestSourceSet.output +
        lightningMainSourceSet.output.classesDirs +
        configurations.getByName("testRuntimeClasspath")

lightningTestSourceSet.compileClasspath = lightningTestCompileClasspath
lightningTestSourceSet.runtimeClasspath = lightningTestRuntimeClasspath

tasks.named<Test>("test") {
    // Test.classpath 在插件应用时就被赋成了 sourceSets.test.runtimeClasspath 的旧值，必须显式重设。
    classpath = lightningTestRuntimeClasspath
    useJUnit()
    testLogging {
        events("passed", "skipped", "failed")
    }
}

tasks.named<JavaCompile>("compileTestJava") {
    classpath = lightningTestCompileClasspath
}

val syncWeb by tasks.registering {
    group = "lightning"
    description = "Build web frontend and copy dist to mod resources"

    val webDir = projectDir.resolve("../../web")
    val destDir = projectDir.resolve("src/main/resources/assets/lightning/web")
    val bundledDest = destDir.resolve("bundled")
    val sourceDist = webDir.resolve("dist-workbench")
    val sourceBundled = sourceDist.resolve("bundled")

    outputs.upToDateWhen { false }

    doLast {
        // 1. Build web
        val pb = ProcessBuilder("npm.cmd", "run", "build:workbench")
            .directory(webDir)
            .inheritIO()
            .start()
        val exitCode = pb.waitFor()
        if (exitCode != 0) throw RuntimeException("npm build:workbench failed (exit $exitCode)")

        // 2. Clean old bundled files
        if (bundledDest.exists()) {
            bundledDest.listFiles()?.forEach { it.delete() }
        }
        bundledDest.mkdirs()

        // 3. Copy bundled assets
        if (sourceBundled.isDirectory) {
            sourceBundled.listFiles()?.forEach { f ->
                f.copyTo(bundledDest.resolve(f.name), overwrite = true)
            }
        }

        // 4. Copy index.html
        val sourceHtml = sourceDist.resolve("index.html")
        if (sourceHtml.exists()) {
            sourceHtml.copyTo(destDir.resolve("index.html"), overwrite = true)
        }
    }
}

tasks.named("processResources") {
    dependsOn(syncWeb)
}

/**
 * T1.6 游戏内自动导出管线 —— 外层编排的 gradle 半环（留白 #8 拍板）。
 *
 * `gradlew runClientSdePipeline` 与普通 `runClient` 的**唯一**差别是把 `-Dfml.queryResult=confirm`
 * 注入被 fork 的客户端 JVM（T0.3 §4.4(2)）：不压制 FML 的 `StartupQuery` 确认框，一进世界就会
 * 客户端/服务端两侧互等死锁。改写只在**本任务被请求时**发生，故普通 `runClient` 行为不变。
 *
 * 触发文件与产物路径由外层 `scripts/multiblock-pipeline/run-pipeline.ps1` 负责；
 * 本任务只负责「以正确的 JVM 参数把客户端拉起来」。
 */
val runClientSdePipeline by tasks.registering {
    group = "lightning"
    description = "T1.6：无人值守多方块导出（自动进专用干净世界 → /sde multiblock → 结构化结果 → 退出码）"
    dependsOn("runClient")
}

tasks.matching { it.name == "runClient" }.configureEach {
    val pipelineRequested = project.gradle.startParameter.taskNames.any { it.contains("runClientSdePipeline") }
    if (pipelineRequested) {
        val exec = this as? JavaExec
        if (exec != null) {
            exec.jvmArgs("-Dfml.queryResult=confirm")
        } else {
            logger.warn(
                "[T1.6] runClient 不是 JavaExec（${this.javaClass.name}）：无法注入 -Dfml.queryResult=confirm；" +
                    "管线会退回进程内 System.setProperty 兜底。",
            )
        }
    }
}

/**
 * ============================ gson 运行期兼容护栏 ============================
 *
 * 事故（实测，非推测）：GTNH 1.7.10 运行期装载的 gson 是 **2.2.4**（Minecraft 打包的旧版），
 * 而 `dependencies.gradle` 给编译期的是 **2.8.9**。任何 2.8 才有的 gson API 都能编译通过，
 * 却在游戏内抛 `java.lang.NoSuchMethodError` —— control-plane 的 HTTP 端点曾因此全部 500：
 *
 *   java.lang.NoSuchMethodError: com.google.gson.JsonObject.size()I
 *
 * 同类事故此前已在 MeshCaptureService 上发生过一次（issue #56，`JsonParser.parseString` →
 * `new JsonParser().parse(...)`）。根因是**编译期 API 版本 ≠ 运行期 API 版本**，靠 code review
 * 拦不住，必须让编译器来拦：本任务用 gson 2.2.4 编译 control-plane 全部源码，
 * 任何 2.2.4 不存在的 gson 方法/字段/类都会**在编译期**报错。
 *
 * 为什么单测拦不住：`src/test` 的 compile/runtime classpath 走 `implementation`
 * （dependencies.gradle 的 gson 2.8.9）—— 单测里调 2.8 API 一样编译通过、一样全绿。
 * 所以**新写的 control-plane 代码必须过 `gsonCompatCheck`**，单测绿不等于运行期安全。
 *
 * 已知雷区（2.2.4 缺失，历史踩点）：
 *  - `JsonObject.size()`             → 2.8.6+；用 `entrySet().size()`
 *  - `JsonObject.keySet()`           → 2.8+；用 `entrySet()` 遍历
 *  - `JsonElement/JsonObject/JsonArray.deepCopy()` → 2.8.2+；用 `new JsonParser().parse(x.toString())`
 *  - `JsonParser.parseString/parseReader`          → 2.8.6+；用 `new JsonParser().parse(...)`
 *  - `JsonArray.set/isEmpty/remove(int)` 等         → 2.8+；手写等价循环
 *  （`JsonNull.INSTANCE` 在 2.2.4 **存在**，不是雷区。）
 *
 * 接入：`check` → `gsonCompatCheck`，故 `build` 也会跑它。
 *
 * 范围：mod 全部 main 源码（`src/main/java` 整树）。2026-10-06 实测全量编译仅剩
 * MeshCaptureService 一处旧错（#56 修复随 main 合入后消除），扩围零成本；发现新错先修
 * 再合（这是 mod 级准入线，不只是 control-plane 的事）。
 */
val gsonCompatRuntimeVersion = "2.2.4"

// 仅本 task 使用的依赖配置：钉死运行期 gson 版本（2.2.4）
val gsonCompat: Configuration = configurations.create("gsonCompat") {
    isCanBeConsumed = false
    isCanBeResolved = true
    description = "GTNH 1.7.10 运行期实际装载的 gson（2.2.4），仅用于 gsonCompatCheck 的编译期 API 校验"
}

// main 编译 classpath 去掉 gson（2.8.9），交给 gsonCompat 提供 2.2.4
val gsonCompatCompileClasspath: Configuration = configurations.create("gsonCompatCompileClasspath") {
    isCanBeConsumed = false
    isCanBeResolved = true
    description = "compileClasspath 去掉 gson 后的副本：gsonCompatCheck 的非 gson 编译依赖"
    extendsFrom(configurations.getByName("compileClasspath"))
    exclude(mapOf("group" to "com.google.code.gson", "module" to "gson"))
}

/**
 * main 源码集**完整**编译 classpath，去掉 gson。
 *
 * 为什么不能只用 [gsonCompatCompileClasspath]：1.7.10 的 MC/Forge/patchedMC 是
 * RetroFuturaGradle 直接注入到 source set 的 compileClasspath 上的（不在任何 configuration
 * 里，`gradlew :dependencies --configuration compileClasspath` 里看不到 `net.minecraft:minecraft`），
 * 用 configuration 重建会漏掉它们 → `程序包 net.minecraft.client 不存在`。
 *
 * 用文件名字过滤（而不是 configuration.exclude）就能同时覆盖「configuration 依赖」与
 * 「直接注入的文件」。过滤条件是唯一一类需要剔除的构件：`gson-*.jar`。
 */
val gsonCompatMainCompileClasspath: FileCollection =
    lightningMainSourceSet.compileClasspath.filter(
        org.gradle.api.specs.Spec<java.io.File> { it.name.indexOf("gson-") != 0 },
    )

dependencies {
    gsonCompat("com.google.code.gson:gson:$gsonCompatRuntimeVersion")
}

val lightningCompileJava = tasks.named<JavaCompile>("compileJava")

val gsonCompatCheck = tasks.register<JavaCompile>("gsonCompatCheck") {
    group = "verification"
    description = "用运行期 gson 2.2.4 编译全部 main 源码：编译期拦住 2.8+ 独有 API（NoSuchMethodError 防回归）"

    // mod 全部 main 源码（见上方块注释「范围」）
    source = fileTree(projectDir.resolve("src/main/java")) {
        include("**/*.java")
    }

    // main 输出（跨包引用）+ 非 gson 的 main 编译依赖 + 运行期 gson 2.2.4
    classpath = files(
        gsonCompatMainCompileClasspath,
        lightningMainSourceSet.output.classesDirs,
        gsonCompat,
    )

    // 语言级别与 compileJava 锁步（Property 延迟求值，读到的是 convention 插件配置后的值）
    options.release.set(lightningCompileJava.flatMap { it.options.release })
    // 编码：compileJava 为 UTF-8（源码含中文注释）；CompileOptions.encoding 是普通 String 属性，
    // 无法惰性继承，故显式对齐（`enableModernJavaSyntax` 未改变它）。
    options.encoding = "UTF-8"
    // jabel 等注解处理器与 compileJava 同源（java 插件不为自建 JavaCompile 自动接线）
    options.annotationProcessorPath = configurations.getByName("annotationProcessor")
    // 默认 javac 只报 100 条错误，扫荡期需要一次看全
    options.compilerArgs.addAll(listOf("-Xmaxerrs", "1000"))

    destinationDirectory.set(layout.buildDirectory.dir("classes/java/gsonCompatCheck"))
}

tasks.named("check") {
    dependsOn(gsonCompatCheck)
}
