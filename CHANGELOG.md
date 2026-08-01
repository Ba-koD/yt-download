# 변경 기록

이 파일은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르고,
버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.

버전 번호의 단일 출처는 `VERSION` 파일입니다. `scripts/release.ps1`(또는 `release.sh`)이
`VERSION`, `Cargo.toml`, 이 파일, git 태그를 한 번에 맞춰줍니다.

## [Unreleased]

## [0.1.0] - 2026-08-02

첫 공개 버전.

### 추가

- YouTube 영상·라이브에서 원하는 구간만 골라 받는 데스크톱 앱(Rust + 시스템 webview).
- 진행 중인 라이브의 구간 다운로드. `&sq=N` 으로 DASH 조각을 직접 받아오고,
  HLS DVR 재생목록만 있는 경우에는 `sq × target` 으로 위치를 계산한다.
- 4K(2160p)까지 화질 선택. 라이브 메타데이터를 읽을 때 `--live-from-start` 를 붙여야
  고화질 포맷이 목록에 나온다.
- 타임라인 구간 편집기: 구간 길이에 맞춘 확대·축소, 선으로 표시되는 범위, 미리보기 연동.
- 미리보기는 영상의 실제 화면 비율을 따라가고 창 크기에 맞춰 커진다.
- 여러 연결로 나눠 받는 다운로드와, 영상·음성 합치기 진행률까지 하나로 이어지는 진행 표시.
- 로그 전용 콘솔 창(앱 창에서 "콘솔 창" 버튼).
- 비공개·연령 제한 영상을 위한 브라우저 쿠키 로그인.
- 받아둔 파일을 영상/쇼츠/라이브로 나눠 보여주는 보관함.
- 도구(yt-dlp, ffmpeg, ffprobe, deno)를 gzip 으로 압축해 실행 파일 안에 담는 포터블 빌드.
  파일 하나만 복사하면 되고 첫 실행 때 사용자 폴더로 풀어 쓴다.
- Windows 설치·제거 스크립트(`scripts/install.ps1`)와 Linux·macOS 설치 스크립트(`scripts/install.sh`).
- Windows·Linux·macOS(Apple Silicon/Intel) 빌드와 릴리스를 만드는 GitHub Actions 워크플로.

### 고침

- 라이브 구간 다운로드가 `This format cannot be partially downloaded` 로 실패하던 문제.
  `--live-from-start` 와 `--download-sections` 는 같이 쓸 수 없어서, 조각을 직접 받아오는 방식으로 바꿨다.
- 미리보기에서 고른 위치와 실제로 받아진 구간이 어긋나던 문제. 방송 시각 헤더
  (`X-Walltime-Ms` − `X-Head-Time-Millis`)에는 DASH 머리 지연이 섞여 있어 보정값이 매번 달라졌다.
  보정을 빼고 조각 번호만으로 위치를 잡으니 오차가 사라졌다.
- 작업을 취소해도 yt-dlp 자식 프로세스가 살아남아 멈춰 있던 문제(`taskkill /T`).
- 취소된 작업이 임시 파일을 남겨 디스크를 채우던 문제.
- 영상·음성 길이가 다를 때 긴 쪽 기준으로 잘리던 문제.
- 6시간짜리 영상을 열 때 화면이 몇 초간 비어 있던 문제. 메타데이터를 기다리지 않고
  미리보기를 먼저 띄운다.

[Unreleased]: https://github.com/OWNER/yt-download/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/yt-download/releases/tag/v0.1.0
