#!/usr/bin/env bash
set -euo pipefail

skip_build=0
args=()
for arg in "$@"; do
  if [[ "$arg" == "--skip-build" ]]; then skip_build=1; else args+=("$arg"); fi
done
target="${args[0]:-$(rustc -vV | awk '/^host:/ { print $2 }')}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_dir="$root/tools/$target"
mkdir -p "$tools_dir"

case "$target" in
  x86_64-apple-darwin)
    yt_asset="yt-dlp_macos"
    deno_asset="deno-${target}.zip"
    ffmpeg_slug="darwin-x64"
    ;;
  aarch64-apple-darwin)
    yt_asset="yt-dlp_macos"
    deno_asset="deno-${target}.zip"
    ffmpeg_slug="darwin-arm64"
    ;;
  x86_64-unknown-linux-gnu)
    yt_asset="yt-dlp_linux"
    deno_asset="deno-x86_64-unknown-linux-gnu.zip"
    ffmpeg_slug="linux-x64"
    ;;
  aarch64-unknown-linux-gnu)
    yt_asset="yt-dlp_linux_aarch64"
    deno_asset="deno-aarch64-unknown-linux-gnu.zip"
    ffmpeg_slug="linux-arm64"
    ;;
  x86_64-unknown-linux-musl)
    yt_asset="yt-dlp_musllinux"
    deno_asset="deno-x86_64-unknown-linux-gnu.zip"
    ffmpeg_slug="linux-x64"
    ;;
  aarch64-unknown-linux-musl)
    yt_asset="yt-dlp_musllinux_aarch64"
    deno_asset="deno-aarch64-unknown-linux-gnu.zip"
    ffmpeg_slug="linux-arm64"
    ;;
  *)
    echo "Unsupported target for automatic yt-dlp bundling: $target" >&2
    exit 1
    ;;
esac

yt_url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$yt_asset"
echo "Downloading yt-dlp: $yt_url"
curl -L "$yt_url" -o "$tools_dir/yt-dlp"
chmod +x "$tools_dir/yt-dlp"

deno_url="https://github.com/denoland/deno/releases/latest/download/$deno_asset"
deno_zip="$tools_dir/deno.zip"
echo "Downloading Deno: $deno_url"
curl -L "$deno_url" -o "$deno_zip"
python3 - <<PY
import zipfile
zipfile.ZipFile("$deno_zip").extractall("$tools_dir")
PY
rm -f "$deno_zip"
chmod +x "$tools_dir/deno"

# ffmpeg/ffprobe 는 정적 빌드를 받아온다.
# 패키지 매니저로 깔린 것을 복사하면 공유 라이브러리에 묶여 있어서
# 다른 PC 로 옮겼을 때 실행되지 않는다(포터블 빌드의 목적과 어긋난다).
ffmpeg_base="https://github.com/eugeneware/ffmpeg-static/releases/latest/download"
for tool in ffmpeg ffprobe; do
  url="$ffmpeg_base/$tool-$ffmpeg_slug"
  echo "Downloading $tool: $url"
  if curl -fL "$url" -o "$tools_dir/$tool"; then
    chmod +x "$tools_dir/$tool"
    continue
  fi
  # 받지 못하면 PATH 의 것으로 때운다(그 PC 안에서는 동작한다).
  source_path="$(command -v "$tool" || true)"
  if [[ -z "$source_path" ]]; then
    echo "$tool: 정적 빌드를 받지 못했고 PATH 에도 없습니다." >&2
    exit 1
  fi
  echo "경고: 정적 빌드 대신 PATH 의 $tool 을 씁니다 ($source_path). 다른 PC 에서는 안 돌 수 있습니다." >&2
  cp "$source_path" "$tools_dir/$tool"
  chmod +x "$tools_dir/$tool"
done

if [[ $skip_build -eq 0 ]]; then
  cargo build --release
fi
echo "Bundled tools in $tools_dir"
