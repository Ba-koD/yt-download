# yt-download

Rust 로컬 앱으로 YouTube 영상/라이브의 특정 구간을 `yt-dlp`와 `ffmpeg`로 다운로드합니다.

## 준비

- Rust toolchain
- Windows: Microsoft Edge WebView2 런타임이 필요합니다. 보통 Windows 10/11에는 이미 설치되어 있습니다.
- macOS: 시스템 WebKit을 사용합니다.
- Linux: WebKitGTK 개발 패키지가 필요합니다.

`yt-dlp`, `ffmpeg`, `ffprobe`는 앱에 내장할 수 있습니다. 내장 빌드를 만들 때만 로컬에 `ffmpeg`와 `ffprobe`가 필요합니다.

Windows:

```powershell
winget install Gyan.FFmpeg
```

macOS:

```bash
brew install ffmpeg
```

Linux 예시:

```bash
sudo apt install ffmpeg
sudo apt install libwebkit2gtk-4.1-dev
```

## 실행

```bash
cargo run
```

실행하면 데스크톱 앱 창이 열립니다.

내부 로컬 서버의 기본 주소는 `http://127.0.0.1:8765`입니다. 포트를 바꾸려면:

```bash
YT_DOWNLOAD_ADDR=127.0.0.1:9000 cargo run
```

Windows PowerShell:

```powershell
$env:YT_DOWNLOAD_ADDR="127.0.0.1:9000"; cargo run
```

외부 브라우저에서 열고 싶으면:

```bash
cargo run -- --browser
```

## 도구 준비

`scripts/bundle-tools.ps1`(Windows) 또는 `scripts/bundle-tools.sh`(macOS/Linux)가
[yt-dlp 공식 릴리즈](https://github.com/yt-dlp/yt-dlp/releases)와 Deno를 받고,
시스템의 `ffmpeg`/`ffprobe`를 `tools/<target-triple>/`로 복사합니다.
아래 배포용 빌드 스크립트가 필요할 때 알아서 부르므로 따로 실행하지 않아도 됩니다.

개발 중에는 도구를 빼고 빌드하면 훨씬 빠릅니다(이때는 `tools/` 폴더를 그대로 씁니다):

```bash
YT_DOWNLOAD_EMBED_TOOLS=0 cargo build
```

## 배포용 빌드

도구(yt-dlp, ffmpeg, ffprobe, deno)를 실행 파일 안에 **압축해서** 담습니다.
받는 사람은 파일 하나만 있으면 되고, 따로 설치할 것이 없습니다.

| | 크기 |
| --- | --- |
| 도구 원본 | 303 MB |
| 실행 파일에 담긴 상태(gzip) | **132 MB** |
| 첫 실행 때 푸는 시간 | 약 5초 (한 번만) |

### 포터블 (파일 하나)

Windows:

```powershell
.\scriptsuild-portable.ps1
# → dist\yt-download.exe
```

macOS / Linux:

```bash
./scripts/build-portable.sh
# → dist/yt-download           (macOS는 dist/yt-download.app 도 함께)
```

`dist` 의 결과물만 복사하면 다른 PC에서도 그대로 돌아갑니다.
설정과 받은 도구는 사용자 폴더(`%LOCALAPPDATA%\yt-download`, `~/.local/share/yt-download`)에 들어갑니다.

### 설치본 (시작 메뉴 / 런처 등록)

Windows — 관리자 권한 없이 사용자 계정에 설치합니다:

```powershell
.\scripts\install.ps1 -Desktop      # 시작 메뉴 + 바탕화면 바로가기
.\scripts\install.ps1 -Uninstall    # 제거
```

macOS / Linux:

```bash
./scripts/install.sh              # macOS: ~/Applications, Linux: ~/.local/bin + 런처 등록
./scripts/install.sh --uninstall
```

### 여러 플랫폼 한 번에

`.github/workflows/build.yml` 이 Windows·Linux·macOS(Intel/Apple Silicon) 빌드를 만듭니다.
Actions 탭에서 수동 실행하거나 `v` 로 시작하는 태그를 밀면 각 플랫폼 결과물이 릴리즈로 올라갑니다.

### 실행에 필요한 시스템 구성 요소

실행 파일에 담을 수 없는 것들입니다.

- **Windows**: Microsoft Edge WebView2 런타임 (Windows 10/11에는 대부분 이미 있습니다)
- **Linux**: `libwebkit2gtk-4.1-0`
- **macOS**: 시스템 WebKit (별도 설치 없음). 서명이 없어서 처음 열 때 우클릭 → 열기

이 구성 요소가 없어 앱 창을 못 만들면, 앱이 종료되지 않고 **기본 브라우저로 화면을 열어** 그대로 쓸 수 있게 합니다.

## 비공개 영상

앱 안에서 Google 비밀번호를 받지 않습니다.

권장 흐름:

1. 로그인 브라우저에서 Chrome, Edge, Brave, Vivaldi, Whale 중 하나를 선택합니다.
2. `앱 로그인 열기`를 눌러 앱 전용 브라우저 프로필을 엽니다.
3. 열린 브라우저에서 YouTube 로그인을 완료합니다.
4. 앱으로 돌아와 `로그인 적용`을 누릅니다.

이 방식은 기존에 사용 중인 Chrome/Edge를 닫지 않아도 됩니다. 앱이 전용 프로필의 쿠키를 `cookies.txt`로 저장하고, 이후 `yt-dlp --cookies`로 사용합니다.

기존 브라우저 쿠키를 직접 쓰고 싶으면 쿠키 파일을 비워두고 로그인 브라우저만 선택하면 `yt-dlp --cookies-from-browser`를 사용합니다. Chromium 계열 브라우저가 쿠키 DB를 잠그고 있으면 실패할 수 있습니다.

지원 브라우저는 `yt-dlp` 기준으로 Chrome, Edge, Firefox, Brave, Vivaldi, Whale, Safari 등입니다. Safari 쿠키는 macOS에서만 의미가 있습니다.

일부 Chromium 계열 브라우저는 쿠키 DB가 잠겨 있으면 실패할 수 있으므로, 비공개 영상 다운로드가 실패하면 해당 브라우저를 닫은 뒤 다시 시도하세요.

## 라이브 다운로드 방식

`yt-dlp` 옵션만으로는 진행 중인 라이브의 구간을 받을 수 없습니다.
`--live-from-start`(조각 생성기 프로토콜)와 `--download-sections`(ffmpeg 다운로더)를 같이 쓸 수 없어서
그 조합은 `This format cannot be partially downloaded`로 바로 실패합니다.
대신 조각 주소를 직접 불러오면 원하는 지점만 받을 수 있습니다.

앱은 영상 상태에 따라 방식을 나눕니다.

| 상태 | 방식 |
| --- | --- |
| 일반 영상 / 처리 끝난 다시보기 | `--download-sections`로 구간만 받음 |
| 방금 끝난 라이브(`post_live`) | 전체를 받은 뒤 로컬에서 잘라냄 |
| 진행 중인 라이브 + 구간 지정 | **그 구간의 조각만 직접 받음** (`<조각주소>&sq=<번호>`) |
| 진행 중인 라이브 + 구간 없음 | 지금부터 녹화. `중지`를 누르면 그때까지 받은 부분을 저장 |

진행 중인 라이브도 구간만 받습니다. 조각을 받는 방법은 스트림에 따라 둘 중 하나입니다.

- **DASH**: `<조각주소>&sq=<번호>`로 임의 지점을 바로 받습니다. 0번 조각에 재생용 초기화 정보가 있어서 항상 같이 받습니다.
- **HLS**: 재생목록(m3u8)에 남아 있는 조각 주소 중 필요한 것만 골라 받습니다. 위치는 `조각 번호 × 조각 길이`로 계산합니다(`EXT-X-PROGRAM-DATE-TIME`은 몇 시간 방송에서 수십 초씩 어긋납니다).

방송 4시간 지점의 30초 4K 구간이 약 13초 / 108MB로 끝납니다.

조각 주소를 못 받거나(포맷 정보 없음, 주소 만료 등) 요청 지점이 남아 있는 범위를 벗어나면,
방송 처음부터 받다가 필요한 지점에서 멈추는 방식으로 자동으로 넘어갑니다.
OUT 지점이 아직 방송되지 않았으면 나온 데까지만 잘라 저장합니다.

> 진행 중인 라이브의 고화질(4K 등) 조각 포맷은 `--live-from-start`를 줘야 목록에 나옵니다.
> 이 옵션 없이 보면 HLS만 보여서 1080p까지로 보입니다. 앱은 정보 조회와 다운로드 모두에 이 옵션을 씁니다.

### 라이브 시간축

라이브에는 시간 기준이 두 개 있고, 섞으면 엉뚱한 구간이 받아집니다.

- **영상 시간축**: 실제 송출이 시작된 순간이 0. 조각 번호와 미리보기 플레이어가 이 기준입니다.
- **시계 기준**: `지금 − release_timestamp`(방송 등록 시각). 예약해두고 늦게 시작하면 그만큼 앞서 있습니다.

앱은 **영상 시간축**으로 통일합니다. 타임라인 길이도 `지금 − 등록 시각`이 아니라
조각 응답 헤더(`X-Head-Time-Millis`)가 알려주는 **실제로 받을 수 있는 최신 지점**까지만 씁니다.
유튜브가 조각을 내주기까지 1~5분 걸리므로, 그 사이 구간은 아직 받을 수 없고 타임라인에도 나오지 않습니다.

> `X-Walltime-Ms − X-Head-Time-Millis`로 두 기준의 차이를 구하려 하면 안 됩니다.
> 그 값에는 "조각이 늦게 나오는 시간"이 통째로 섞여 있어서 몇 분씩 틀립니다(실측 87초~290초로 계속 변동).

다운로드 중에는 `중지` 버튼으로 언제든 멈출 수 있고, 라이브 녹화는 멈춘 지점까지 파일로 저장됩니다.

## 콘솔 창

오른쪽 위 `콘솔 창` 버튼을 누르면 yt-dlp/ffmpeg 출력이 **별도 창**으로 열립니다.
진행률, 속도, 저장 경로, 로그를 한 화면에서 볼 수 있고 `복사` 버튼으로 로그를 그대로 가져갈 수 있습니다.
로그를 본 창에서 뺀 덕분에 미리보기 화면을 더 크게 씁니다.

- 데스크톱 앱에서는 앱 자체 창으로 열리고(닫아도 앱은 그대로), 브라우저 모드(`--browser`)에서는 새 창으로 열립니다.
- 항상 가장 최근 작업을 따라갑니다. 새 다운로드를 시작하면 자동으로 그 작업으로 바뀝니다.

## 화질과 속도

- `화질`에서 최고(4K/8K 포함)부터 720p까지 고를 수 있습니다. 영상에 없는 화질은 목록에서 빠집니다.
- **라이브가 끝난 직후에는 화질이 낮게 보입니다.** 유튜브가 다시보기 화질을 낮은 것부터 새로 만들기 때문이고,
  길이가 길수록 오래 걸립니다(6시간 방송 실측: 종료 직후 1080p → 몇 분 뒤 1440p). 나중에 다시 `불러오기`하면 올라갑니다.
  방송 중에는 이미 4K로 받을 수 있으므로, 4K가 필요하면 **라이브 진행 중에 받는 편이 빠릅니다.**
- `MP4 우선`은 같은 해상도면 H.264를 골라 호환성을 챙깁니다. 4K는 유튜브에 H.264가 없어서 VP9/AV1로 받아 mp4로 담습니다. 코덱을 그대로 두려면 `원본 코덱`을 고르세요.
- 다운로드는 통짜 파일을 조각으로 나눠 16개씩 동시에 받습니다(`youtube:formats=dashy` + `-N 16`). 같은 회선에서 단일 연결보다 2~3배 빨랐습니다.
- 진행률은 영상 → 음성 → 합치기까지 하나로 이어서 보여줍니다. 합치는 단계는 ffmpeg가 남기는 진행 정보를 그대로 읽습니다.

## 구간 편집

- 타임라인은 선 하나로 구간을 표시합니다. IN/OUT 손잡이를 끌어 조절합니다.
- 빈 곳을 끌면 새 구간이 그려지고, 구간 안쪽을 끌면 구간이 통째로 움직입니다.
- 마우스 휠로 확대/축소하고, `Shift + 휠`로 좌우 이동합니다. `구간에 맞추기`를 누르면 선택 구간이 화면을 채웁니다.
- 아래 미니맵은 전체 영상에서 지금 보고 있는 범위를 보여줍니다. 눌러서 이동할 수 있습니다.
- 시간은 항상 **영상(방송) 시작이 00:00:00**인 절대 시각입니다. 라이브 플레이어는 되감기 가능한 구간 안의 위치를 주기 때문에, 앱이 그 구간의 실제 시작 시각을 받아 방송 시작 기준으로 바꿔서 표시합니다.

브라우저 없이 구간 편집 로직만 확인하려면:

```bash
deno run --allow-read web/timeline-check.js
```

## 불러오기 속도

`불러오기`는 유튜브에서 정보를 받아오는 과정이라 **4~5초**가 걸립니다.
영상 길이와는 상관없고(6시간짜리도 같습니다), yt-dlp가 웹페이지 → 플레이어 API → 플레이어 JS 해석까지
여러 번 왕복해야 하기 때문입니다. 실측으로 줄일 방법을 찾아봤지만 의미 있는 차이가 없었습니다.

| 방식 | 시간 |
| --- | --- |
| 기본 | 4.25초 |
| 플레이어 JS 건너뛰기 | 추출 실패 |
| 웹페이지·설정 건너뛰기 | 3.68초 (형식 목록이 달라질 위험) |
| 캐시 끄기 | 4.46초 |

그래서 **기다림 자체를 없앴습니다.**

- 주소를 붙여넣으면 버튼을 누르지 않아도 0.4초 뒤 자동으로 불러옵니다.
- 미리보기는 주소만으로 바로 띄웁니다(0.5초). 제목·길이·화질은 준비되는 대로 채워집니다.
- 불러오는 동안 버튼이 진행 중임을 표시하고, 주소를 바꾸면 이전 응답은 버립니다.

## 코드 구조

```
src/
  main.rs        앱 창(webview)과 실행 방식
  server.rs      로컬 HTTP 서버: 라우팅, 요청/응답 타입
  download.rs    영상 상태에 맞는 다운로드 방식 선택
  live/          진행 중인 라이브 처리
    source.rs      조각 주소와 시간 기준 확인
    fetch.rs       필요한 구간의 조각만 받아 잘라내기
    capture.rs     조각을 못 받을 때 쓰는 방식(처음부터 받기)
  progress.rs    yt-dlp/ffmpeg 출력 → 하나의 진행률
  jobs.rs        작업 상태 보관
  media.rs       ffmpeg/ffprobe 호출
  youtube.rs     메타데이터 해석, 내 채널 목록
  tools.rs       내장 도구 경로와 공통 인자
  login.rs       브라우저 로그인과 쿠키

web/
  app.js         시작점(이벤트 연결)
  state.js       공유 상태와 DOM 참조
  timeline.js    구간 편집 타임라인
  player.js      미리보기 플레이어와 라이브 시간 기준
  video.js       영상 정보 표시
  jobs.js        다운로드 시작과 진행 표시
  library.js     내 영상 목록
  login.js       로그인 브라우저와 도구 상태
  api.js         서버 호출
  settings.js    설정 저장
  format.js      시간 표시
  ui.js          메시지와 알림
  console.html   콘솔 창
```

검사:

```bash
cargo test                              # 로직 단위 테스트
cargo clippy --all-targets              # 린트
deno run --allow-read web/timeline-check.js   # 구간 편집 로직
```

## 참고

- `정확 컷`은 `ffmpeg` 재인코딩이 들어가서 느릴 수 있습니다. 끄면 키프레임 단위로 잘라내 훨씬 빠릅니다.
