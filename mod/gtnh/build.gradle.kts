plugins {
    id("com.gtnewhorizons.gtnhconvention")
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
