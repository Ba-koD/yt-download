# yt-download — Android

폰 단독으로 도는 안드로이드 앱. PC 서버 없이 공유 시트 → 구간 모달 → 받기.

## 0단계 결정 기록

### 도구 라이브러리 좌표

`io.github.junkfood02.youtubedl-android` **0.18.1** (Maven Central, 2025-11-16 릴리스)

- `library` — python 3.11 + yt-dlp 포함
- `ffmpeg` — ffmpeg 7.x (별도 아티팩트라 반드시 같이 넣어야 한다)
- `aria2c` — 안 씀

고른 이유:

- 저장소는 원본(yausername/youtubedl-android) 그대로지만, 실제 릴리스·Maven Central
  배포는 JunkFood02(Seal 개발자)가 하고 있다. 원본 JitPack 좌표
  (`com.github.yausername`)는 갱신이 멈췄고, Maven Central 좌표가 유지되는 쪽이다.
- 최근 릴리스가 활발하다: 0.18.0(2025-09, 16KB 페이지 크기 대응), 0.18.1(2025-11, quickJS 추가).
- **quickJS 포함이 결정적이다.** 2025년 이후 yt-dlp 는 유튜브 nsig/JS 챌린지 해결에
  JS 런타임을 요구하는데, 0.18.1 이 이를 내장한다. 이게 없는 포크는 최신 yt-dlp 로
  갱신해도 유튜브에서 깨진다 (완료 조건 6번과 직결).
- yt-dlp 자체 갱신 API(`updateYoutubeDL`, 채널 STABLE/NIGHTLY/MASTER + 커스텀 URL)를
  라이브러리가 제공한다 — 5단계가 공짜로 풀린다.

### Rust 코어(src/) 재사용 여부

**재사용하지 않는다. Kotlin 으로 얇게 새로 쓰고 web/ 만 재활용한다** (지시서 권장안 채택).

- 데스크톱 코어의 다운로드·라이브·도구 실행 계층(download.rs, live/, tools.rs, proc.rs)은
  youtubedl-android 라이브러리가 통째로 대체한다.
- 살아남는 로직(구간 계산, 포맷 선택, 작업 큐)은 얇아서 uniffi 바인딩 유지 비용이
  Kotlin 재작성 비용을 넘는다.
- 나중에 로직이 두꺼워지면 그때 코어를 .so 로 빼는 것을 재검토한다.

### 조용히 실패하는 Gradle 설정 (이미 반영됨)

- `ndk { abiFilters "arm64-v8a" }` — 폰 단독 목표라 arm64 만
- `packaging { jniLibs { useLegacyPackaging = true } }` + 매니페스트
  `android:extractNativeLibs="true"` — 이걸 빼면 .so 가 디스크에 안 풀리고,
  안드로이드 10+ W^X 정책상 nativeLibraryDir 밖에서는 exec 금지라
  "파일 없음"이 아니라 **"권한 거부"** 로 증상이 나온다.

## 스파이크 실행

```
cd android && gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

앱을 열면 화면에 로그가 흐른다 (adb 없이 폰에서 바로 판정 가능):
Big Buck Bunny 1:00–1:10 구간을 720p 로 받아 파일 크기를 찍는다.
10초 구간이면 1–5 MB, 수십 MB 면 `--download-sections` 무시된 것.
