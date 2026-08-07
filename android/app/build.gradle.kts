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
        // VERSION 파일이 데스크톱·확장·안드로이드의 단일 출처다
        val ver = rootProject.file("../VERSION").readText().trim()
        versionName = ver
        versionCode = ver.split(".").let { (a, b, c) ->
            a.toInt() * 1_000_000 + b.toInt() * 1_000 + c.toInt()
        }
        // 폰 단독 실행이 목표라 arm64 만 담는다. 에뮬레이터 검증이 필요하면
        // 로컬에서만 x86_64 를 추가할 것 (릴리스 APK 크기와 직결).
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    packaging {
        // .so 를 디스크에 풀어야 nativeLibraryDir 에서 exec 가능 (W^X 정책)
        jniLibs { useLegacyPackaging = true }
    }

    // CI 가 시크릿으로 넘기는 키로 서명한다. Obtainium 갱신은 서명 일관성이 전제라
    // 로컬 debug 키로 릴리스를 만들면 안 된다.
    val ksFile = System.getenv("ANDROID_KEYSTORE_FILE")
    if (ksFile != null) {
        signingConfigs {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASS")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "ytdownload"
                keyPassword = System.getenv("ANDROID_KEY_PASS")
                    ?: System.getenv("ANDROID_KEYSTORE_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (ksFile != null) signingConfig = signingConfigs.getByName("release")
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
