import java.util.UUID

plugins {
    id("com.android.application") version "8.12.0"
    id("org.jetbrains.kotlin.android") version "2.1.20"
}

// The server's version is the npm package version plus a per-build ID, e.g.
// "0.1.0+3f9c2a1b". The CLI only talks to the exact build shipped beside it,
// so a rebuilt server always replaces the one on the device, even when the
// package version hasn't changed. The full version is written next to the
// APK for the CLI to read.
val packageVersion: String = groovy.json.JsonSlurper()
    .parse(rootDir.resolve("../package.json"))
    .let { (it as Map<*, *>)["version"] as String }
val serverVersion = "$packageVersion+${UUID.randomUUID().toString().take(8)}"
layout.buildDirectory.file("outputs/adze-server.version").get().asFile.apply {
    parentFile.mkdirs()
    writeText(serverVersion)
}

android {
    namespace = "dev.adze.server"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.adze.server"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = serverVersion
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
