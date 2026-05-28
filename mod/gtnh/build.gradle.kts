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
        exec {
            workingDir = webDir
            commandLine("npm", "run", "build:workbench")
        }

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
