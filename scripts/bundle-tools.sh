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
  x86_64-apple-darwin|aarch64-apple-darwin)
    yt_asset="yt-dlp_macos"
    deno_asset="deno-${target}.zip"
    ;;
  x86_64-unknown-linux-gnu)
    yt_asset="yt-dlp_linux"
    deno_asset="deno-x86_64-unknown-linux-gnu.zip"
    ;;
  aarch64-unknown-linux-gnu)
    yt_asset="yt-dlp_linux_aarch64"
    deno_asset="deno-aarch64-unknown-linux-gnu.zip"
    ;;
  x86_64-unknown-linux-musl)
    yt_asset="yt-dlp_musllinux"
    deno_asset="deno-x86_64-unknown-linux-gnu.zip"
    ;;
  aarch64-unknown-linux-musl)
    yt_asset="yt-dlp_musllinux_aarch64"
    deno_asset="deno-aarch64-unknown-linux-gnu.zip"
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

for tool in ffmpeg ffprobe; do
  source_path="$(command -v "$tool" || true)"
  if [[ -z "$source_path" ]]; then
    echo "$tool not found in PATH" >&2
    exit 1
  fi
  echo "Copying $tool from $source_path"
  cp "$source_path" "$tools_dir/$tool"
  chmod +x "$tools_dir/$tool"
done

if [[ $skip_build -eq 0 ]]; then
  cargo build --release
fi
echo "Bundled tools in $tools_dir"
