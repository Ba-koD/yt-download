#!/usr/bin/env bash
# VERSION, Cargo.toml, (태그가 있으면) git 태그가 같은 버전을 가리키는지 본다.
#
#   ./scripts/check-version.sh          VERSION 과 Cargo.toml 만 비교
#   ./scripts/check-version.sh v0.2.0   태그까지 함께 비교(릴리스 워크플로가 쓰는 방식)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(tr -d '[:space:]' < VERSION)"
# Cargo.toml 의 첫 version 줄([package] 것)만 꺼낸다.
manifest="$(sed -n '0,/^version = "/s|^version = "\([^"]*\)".*|\1|p' Cargo.toml)"

if [[ "$version" != "$manifest" ]]; then
  echo "VERSION($version) 과 Cargo.toml($manifest) 의 버전이 다릅니다." >&2
  exit 1
fi

# 확장 관리자도 같은 버전을 달고 나가야 한다.
manager="$(sed -n '0,/^version = "/s|^version = "\([^"]*\)".*|\1|p' manager/Cargo.toml)"
if [[ "$version" != "$manager" ]]; then
  echo "VERSION($version) 과 manager/Cargo.toml($manager) 의 버전이 다릅니다." >&2
  exit 1
fi

# 확장도 같은 버전을 달고 나가야 한다.
extension="$(sed -n 's|^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*|\1|p' extension/manifest.json | head -1)"
if [[ "$version" != "$extension" ]]; then
  echo "VERSION($version) 과 extension/manifest.json($extension) 의 버전이 다릅니다." >&2
  exit 1
fi

if ! grep -q "^## \[$version\]" CHANGELOG.md; then
  echo "CHANGELOG.md 에 ## [$version] 항목이 없습니다." >&2
  exit 1
fi

# 빈 칸으로 릴리스가 나가면 설명 없는 릴리스가 된다. 빌드를 시작하기 전에 잡는다.
if [[ -z "$(bash "$root/scripts/changelog-section.sh" "$version" 2>/dev/null)" ]]; then
  echo "CHANGELOG.md 의 [$version] 칸이 비어 있습니다. 무엇이 바뀌었는지 적어주세요." >&2
  exit 1
fi

tag="${1:-}"
if [[ -n "$tag" ]]; then
  if [[ "${tag#v}" != "$version" ]]; then
    echo "태그($tag) 와 VERSION($version) 이 다릅니다." >&2
    exit 1
  fi
  echo "버전 확인: $version (태그 $tag)"
else
  echo "버전 확인: $version"
fi
