#!/usr/bin/env bash
# 도구를 모두 담은 단일 실행 파일(포터블)을 만든다.
#
#   ./scripts/build-portable.sh              # 도구가 없으면 받아서 빌드
#   ./scripts/build-portable.sh --skip-tools # 이미 tools/ 에 있을 때
#
# macOS 에서는 dist/yt-download.app 도 함께 만든다.
set -euo pipefail

skip_tools=0
[[ "${1:-}" == "--skip-tools" ]] && skip_tools=1

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

target="$(rustc -vV | awk '/^host:/ { print $2 }')"
tools_dir="$root/tools/$target"

if [[ $skip_tools -eq 0 ]]; then
  missing=()
  for tool in yt-dlp ffmpeg ffprobe deno; do
    [[ -f "$tools_dir/$tool" ]] || missing+=("$tool")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "도구 준비 중: ${missing[*]}"
    "$root/scripts/bundle-tools.sh" "$target" --skip-build
  else
    echo "도구가 이미 준비되어 있습니다: $tools_dir"
  fi
fi

echo "빌드 중 (도구를 압축해 실행 파일에 담습니다. 몇 분 걸립니다)"
YT_DOWNLOAD_EMBED_TOOLS=1 cargo build --release

# 확장 관리자는 도구를 담지 않아 금방 빌드된다.
cargo build --release -p yt-download-extension-manager

mkdir -p dist
cp "target/release/yt-download" "dist/yt-download"
cp "target/release/yt-download-extension-manager" "dist/yt-download-extension-manager"
chmod +x "dist/yt-download" "dist/yt-download-extension-manager"

if command -v shasum >/dev/null; then
  (cd dist && shasum -a 256 yt-download > yt-download.sha256)
elif command -v sha256sum >/dev/null; then
  (cd dist && sha256sum yt-download > yt-download.sha256)
fi

size="$(du -h dist/yt-download | cut -f1)"
echo
echo "완성: dist/yt-download ($size)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  app="dist/yt-download.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp dist/yt-download "$app/Contents/MacOS/yt-download"
  version="$(tr -d '[:space:]' < VERSION)"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>yt-download</string>
  <key>CFBundleDisplayName</key><string>yt-download</string>
  <key>CFBundleIdentifier</key><string>dev.local.yt-download</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>yt-download</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
  echo "앱 번들: $app  (Finder에서 바로 실행할 수 있습니다)"
  echo "서명이 없어서 처음 열 때 우클릭 → 열기 를 한 번 해줘야 합니다."
fi

echo "이 파일만 복사해서 쓰면 됩니다. 처음 실행할 때 도구를 풀어내느라 몇 초 걸립니다."
