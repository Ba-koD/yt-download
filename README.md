# yt-download

YouTube 영상·라이브의 원하는 **구간만** 골라 받는 데스크톱 앱(Rust). `yt-dlp`·`ffmpeg` 를
실행 파일 안에 담아 **파일 하나로** 돌아갑니다. 브라우저에서 바로 쓰는 확장도 함께 있습니다.

## 세 가지

| | 무엇 | 어디 |
|---|---|---|
| **앱** | 구간 다운로드·라이브 캡처. yt-dlp·ffmpeg 를 품는다 | `src/`, `web/` |
| **확장** | 유튜브 페이지에 "구간 받기" 패널. 앱 없이 브라우저 안에서 완결 | `extension/` |
| **확장 관리자** | 확장을 설치·갱신한다(스토어 밖 확장은 크롬이 자동 갱신을 안 해준다) | `manager/` |

## 실행

```bash
cargo run                 # 앱 창이 열린다
cargo run -- --browser    # 창 대신 기본 브라우저로
```

로컬 서버 기본 주소는 `http://127.0.0.1:8765`. `YT_DOWNLOAD_ADDR=127.0.0.1:9000` 으로 바꾼다.

- **Rust toolchain** 필요.
- 내장 빌드를 만들 때만 로컬에 `ffmpeg`/`ffprobe` 가 필요하다(도구를 담기 위해).
- 앱 **창**은 시스템 webview 를 쓴다(Windows: Edge WebView2, Linux: WebKitGTK).
  없으면 창을 못 만들 뿐, 기본 브라우저로 넘어가 그대로 다 쓸 수 있다.

## 배포용 빌드 (파일 하나)

도구(yt-dlp·ffmpeg·ffprobe·deno)를 gzip 으로 압축해 실행 파일에 담는다.
받는 사람은 **exe 하나만** 있으면 되고, 처음 실행할 때 도구를 사용자 폴더에 풀어 쓴다.

```bash
./scripts/build-portable.sh      # dist/yt-download (macOS 는 .app 도)
.\scripts\build-portable.ps1     # dist\yt-download.exe
```

| | 크기 |
|---|---|
| 도구 원본 | 387 MB |
| 담은 실행 파일(gzip) | **169 MB** |
| 첫 실행 때 푸는 시간 | 약 5초(한 번만) |

## 확장

유튜브 영상 페이지에 **구간 받기** 버튼을 붙여, 앱 없이 브라우저 안에서 받는다.
일반 영상·라이브·숏츠에서 되고, Chrome·Edge 등 크로미움 계열에서 확인했다.
파이어폭스는 별도 빌드로 된다. 자세한 내용은 [`extension/README.md`](extension/README.md).

스토어 밖 확장이라 **처음 한 번은 사람이 얹어야 한다.** 브라우저가 프로그램으로 확장을 넣는
길을 전부 막아뒀다(정책·레지스트리·웹사이트·개발자 도구를 하나씩 재본 결과는
[`manager/src/browser.rs`](manager/src/browser.rs) 머리말에 있다).

```
chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램을 로드 → 관리자가 알려주는 폴더
```

**그 한 번이 끝이다.** 자리가 고정이라 그 뒤로는 관리자가 폴더만 갈아 끼우면 되고, 확장이
스스로 알아채고 새 판으로 갈아탄다 — 브라우저를 다시 켤 필요도 없다.

확장은 **프로필마다 따로 저장된다**(공용 자리가 없다). 프로필을 여러 개 쓰면 그 프로필마다
한 번씩 얹어야 하고, 관리자가 어느 프로필에 아직 없는지 이름·계정과 함께 보여준다.

## 비공개 영상

앱 안에서 비밀번호를 받지 않는다. **앱 로그인**을 쓴다 — 브라우저를 켜둔 채로 된다.

1. 브라우저를 고르고(기본 브라우저가 미리 선택됨) `로그인 적용` → 전용 프로필로 브라우저가 열린다
2. 그 창에서 YouTube 로그인 → 앱으로 돌아와 `로그인 적용` 다시

한 번 해두면 다음부터는 `로그인 적용` 한 번이면 된다. 앱이 전용 프로필의 쿠키를
`cookies.txt` 로 저장해 `yt-dlp --cookies` 로 쓴다.

("브라우저 쿠키 직접 읽기"는 그 브라우저를 완전히 종료해야만 된다 — 크로미움이 실행 중에
쿠키 DB 를 잠그기 때문. 그래서 켜둔 채로 되는 앱 로그인을 권한다.)

## 릴리스

버전의 단일 출처는 **`VERSION`** 파일. 바뀐 내용은 [`CHANGELOG.md`](CHANGELOG.md) 의
`## [Unreleased]` 칸에 적어둔다.

```bash
./scripts/release.sh minor --push     # VERSION·Cargo.toml·CHANGELOG·태그를 맞추고 밀기
```

태그를 밀면 GitHub Actions 가 네 플랫폼을 빌드해 릴리스로 올린다. 앱·관리자·확장이
각각 자산으로 나가고, 버전은 함께 간다.

## 코드 구조

```
src/         앱(서버·다운로드·라이브·로그인). tools.rs 가 내장 도구를 푼다
web/         화면(타임라인 구간 편집·미리보기·목록)
extension/   브라우저 확장
manager/     확장 관리자
update/      앱·관리자가 함께 쓰는 자동 업데이트
scripts/     빌드·릴리스·도구 내려받기·로고
HANDOFF.md   이어받을 때 먼저 읽는 문서(직접 재서 확인한 사실들)
```

검사:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
deno test --allow-read extension/test/
```
