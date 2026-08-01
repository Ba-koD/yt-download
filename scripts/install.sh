#!/usr/bin/env bash
# yt-download 을 사용자 계정에 설치한다(sudo 필요 없음).
#
#   ./scripts/install.sh              설치
#   ./scripts/install.sh --uninstall  제거
#
# Linux : ~/.local/bin 에 실행 파일, ~/.local/share/applications 에 실행기 등록
# macOS : ~/Applications 에 yt-download.app 설치
set -euo pipefail

app="yt-download"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
os="$(uname -s)"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ "$os" == "Darwin" ]]; then
    rm -rf "$HOME/Applications/$app.app"
    echo "제거: ~/Applications/$app.app"
  else
    rm -f "$HOME/.local/bin/$app" "$HOME/.local/share/applications/$app.desktop"
    echo "제거: ~/.local/bin/$app, 실행기 등록"
  fi
  echo "받아둔 영상과 설정은 그대로 있습니다."
  exit 0
fi

if [[ "$os" == "Darwin" ]]; then
  bundle="$root/dist/$app.app"
  [[ -d "$bundle" ]] || { echo "먼저 ./scripts/build-portable.sh 를 실행하세요" >&2; exit 1; }
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$app.app"
  cp -R "$bundle" "$HOME/Applications/"
  echo "설치 완료: ~/Applications/$app.app"
  echo "서명이 없어서 처음 열 때 우클릭 → 열기 를 한 번 해줘야 합니다."
  exit 0
fi

binary="$root/dist/$app"
[[ -f "$binary" ]] || binary="$root/target/release/$app"
[[ -f "$binary" ]] || { echo "먼저 ./scripts/build-portable.sh 를 실행하세요" >&2; exit 1; }

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m 755 "$binary" "$HOME/.local/bin/$app"

cat > "$HOME/.local/share/applications/$app.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=yt-download
Comment=YouTube 구간 다운로드
Exec=$HOME/.local/bin/$app
Terminal=false
Categories=AudioVideo;Video;Network;
DESKTOP

echo "설치 완료: ~/.local/bin/$app"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "참고: ~/.local/bin 이 PATH 에 없습니다. 셸 설정에 추가하면 터미널에서도 바로 실행됩니다." ;;
esac
echo "제거하려면: $0 --uninstall"
