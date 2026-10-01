plugins {
    kotlin("jvm") version "2.2.21"
    application
}
repositories { mavenCentral() }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
kotlin { jvmToolchain(21) }
application { mainClass.set("com.yunx.desktop.CoreMainKt") }
tasks.test { useJUnit() }
