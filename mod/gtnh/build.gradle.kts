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
