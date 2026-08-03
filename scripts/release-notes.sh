#!/usr/bin/env bash
# 릴리스 본문을 만든다. CHANGELOG 의 해당 버전 칸 + 받는 방법 안내.
#
#   ./scripts/release-notes.sh 0.2.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:?버전을 넘겨주세요 (예: 0.1.0)}"
version="${version#v}"

"$root/scripts/changelog-section.sh" "$version"

cat <<'NOTES'

---

## 앱 받기

도구(yt-dlp, ffmpeg, ffprobe, deno)를 모두 담은 포터블 빌드입니다.
풀어서 실행 파일 하나만 두고 쓰면 되고, 처음 실행할 때 도구를 풀어내느라 몇 초 걸립니다.

| 파일 | 대상 |
| --- | --- |
| `yt-download-windows-x64.zip` | Windows 10/11 (x64) — Microsoft Edge WebView2 런타임 필요 |
| `yt-download-linux-x64.tar.gz` | Linux (x64) — `libwebkit2gtk-4.1-0` 필요 |
| `yt-download-macos-arm64.tar.gz` | macOS (Apple Silicon) — 앱 번들 |
| `yt-download-macos-x64.tar.gz` | macOS (Intel) — 앱 번들 |

macOS 는 서명이 없어 처음 열 때 우클릭 → 열기 를 한 번 해줘야 합니다.

한 번 받아두면 다음부터는 앱이 스스로 갱신합니다. 오른쪽 위 **업데이트 확인** 을 누르면
새 버전을 받아 실행 파일을 바꿔 끼우고, **다시 켜기** 로 새 버전이 뜹니다.
관리자 권한은 필요 없고, 받다가 실패해도 쓰던 실행 파일은 그대로 남습니다.

## 확장 관리자 받기 (`yt-download-manager-<플랫폼>`)

크롬 확장을 설치·갱신·삭제하는 작은 프로그램입니다(4MB). 앱과 따로 올라갑니다.

압축하지 않았습니다. 받아서 그대로 실행하면 됩니다.

| 파일 | 대상 |
| --- | --- |
| `yt-download-manager-windows-x64.exe` | Windows 10/11 (x64) |
| `yt-download-manager-linux-x64` | Linux (x64) |
| `yt-download-manager-macos-arm64` | macOS (Apple Silicon) |
| `yt-download-manager-macos-x64` | macOS (Intel) |

리눅스·macOS 는 받은 파일에 실행 권한이 없습니다(깃허브가 권한을 지워서 보냅니다).
한 번만 `chmod +x yt-download-manager-*` 를 해주세요. 그 뒤의 갱신은 관리자가 알아서 합니다.

## 크롬 확장 받기 (`yt-download-extension.zip`)

앱을 켜지 않고 유튜브 페이지에서 바로 구간을 받는 확장입니다. 앱과 아무것도 공유하지 않습니다.
유튜브 이용약관 때문에 크롬 웹 스토어에는 올릴 수 없어서 직접 넣어야 합니다.

1. `yt-download-extension.zip` 을 받아 **원하는 폴더에 풀어둡니다**
   (확장은 이 폴더를 계속 참조하니 지우거나 옮기지 마세요)
2. 주소창에 `chrome://extensions` 를 입력해 엽니다
3. 오른쪽 위 **개발자 모드**를 켭니다
4. **압축해제된 확장 프로그램을 로드**를 누르고 1번에서 푼 폴더를 고릅니다
5. 유튜브 영상 페이지를 열면 오른쪽 아래에 **구간 받기** 패널이 나타납니다

쓰는 법: 재생하다가 **현재 위치 IN** / **OUT** 을 누르거나 시간 칸을 직접 고치고,
화질을 고른 뒤 **구간 받기** 를 누르면 mp4 로 저장됩니다.

지금은 mp4 화질(H.264 · AV1 4K)만 됩니다. VP9(webm)만 있는 영상, 진행 중인 라이브,
비공개·연령 제한 영상은 아직 지원하지 않습니다. 그런 영상은 앱을 쓰세요.

Edge, Brave, Whale 등 크로미움 계열 브라우저도 같은 방법으로 됩니다.

---

`SHA256SUMS.txt` 로 받은 파일이 온전한지 확인할 수 있습니다.
NOTES
