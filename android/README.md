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

### 스파이크 결과 (2026-08-08, Galaxy S24+ SM-S926N)

**통과.** 1:00–1:10 구간 → h264 1280×720, 정확히 10.000초, 1.4 MB.

단, 번들 yt-dlp(2025.11.12)로는 nsig 챌린지 실패로 403 이 났고,
`updateYoutubeDL(STABLE)` 로 2026.07.04 갱신(0.5초) 후에야 성공했다.
**첫 실행부터 갱신이 전제다** — 앱은 init 직후 갱신을 시도해야 하고,
추출 실패 시 갱신 → 재시도 경로(5단계)는 선택이 아니라 필수임이 실측으로 확인됐다.

## 갱신 전략 (완료 조건 6번)

- **yt-dlp**: 앱 시작 시 하루 1회 갱신 확인 + 추출 실패 시 즉시 갱신·1회 재시도.
  순수 파이썬 zip 이라 W^X 와 무관하게 파일 교체로 끝난다. APK 재설치 불필요.
- **ffmpeg**: 네이티브라 APK 에 묶이지만 유튜브 변경과 무관 — 몇 년에 한 번.
- **앱 본체**: GitHub 릴리스 APK. [Obtainium](https://github.com/ImranR98/Obtainium) 에
  `https://github.com/Ba-koD/yt-download` 을 등록하면 사용자 쪽 갱신이 자동화된다.

## 릴리스

`v*` 태그를 밀면 release 워크플로가 `yt-download-android-arm64.apk` 를 서명해
기존 릴리스 자산에 합류시킨다. 버전은 `VERSION` 파일이 단일 출처
(versionName 직접, versionCode 는 `major·minor·patch → M*1000000+m*1000+p`).

서명 키: `~/.android-keys/yt-download.jks` (저장소 밖, 공개 저장소이므로 절대 커밋 금지).
비밀번호는 같은 폴더의 txt. GitHub 시크릿 `ANDROID_KEYSTORE_B64`·`ANDROID_KEYSTORE_PASS`
로 등록돼 있다. **키를 잃으면 기존 사용자는 재설치해야 하니 백업할 것.**
시크릿이 없는 포크에서는 안드로이드 잡이 조용히 빠진다.

## 스파이크 실행

```
cd android && gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

앱을 열면 화면에 로그가 흐른다 (adb 없이 폰에서 바로 판정 가능):
Big Buck Bunny 1:00–1:10 구간을 720p 로 받아 파일 크기를 찍는다.
10초 구간이면 1–5 MB, 수십 MB 면 `--download-sections` 무시된 것.
