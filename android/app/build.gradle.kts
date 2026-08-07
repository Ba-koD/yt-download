plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val youtubedlAndroid = "0.18.1"

android {
    namespace = "me.intp.ytdownload"
    compileSdk = 35

    defaultConfig {
        applicationId = "me.intp.ytdownload"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = rootProject.file("../VERSION").readText().trim()
        // 폰 단독 실행이 목표라 arm64 만 담는다. 에뮬레이터 검증이 필요하면
        // 로컬에서만 x86_64 를 추가할 것 (릴리스 APK 크기와 직결).
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    packaging {
        // .so 를 디스크에 풀어야 nativeLibraryDir 에서 exec 가능 (W^X 정책)
        jniLibs { useLegacyPackaging = true }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:$youtubedlAndroid")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:$youtubedlAndroid")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
}

// 데스크톱 web/ 의 헬퍼를 단일 출처로 재사용한다 — assets/web 은 커밋하지 않는다.
val copyWebAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../web")) { include("format.js") }
    into(layout.projectDirectory.dir("src/main/assets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }
