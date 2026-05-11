plugins {
    id("com.gtnewhorizons.gtnhconvention")
}

// Local web build output → mod resources
val webDistDir = layout.projectDirectory.dir("../../web/dist-workbench")
val workbenchWebOut = layout.projectDirectory.dir("src/main/resources/assets/lightning/web")

tasks.register<Copy>("syncWeb") {
    group = "Lightning"
    description = "Copy web/dist-workbench into mod resources"
    duplicatesStrategy = org.gradle.api.file.DuplicatesStrategy.INCLUDE
    from(webDistDir)
    into(workbenchWebOut)
}

// Ensure syncWeb runs before processResources
tasks.named("processResources") {
    dependsOn("syncWeb")
}
