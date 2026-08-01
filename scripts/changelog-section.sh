#!/usr/bin/env bash
# CHANGELOG.md 에서 한 버전의 내용만 꺼낸다. 릴리스 설명으로 그대로 쓴다.
#
#   ./scripts/changelog-section.sh 0.1.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:?버전을 넘겨주세요 (예: 0.1.0)}"
version="${version#v}"

# "## [버전]" 다음 줄부터, 다음 버전 제목이나 맨 아래 링크 목록을 만나기 전까지.
section="$(awk -v v="$version" '
  $0 ~ "^## \\[" v "\\]" { inside = 1; next }
  inside && (/^## / || /^\[[^]]+\]: /) { exit }
  inside { print }
' "$root/CHANGELOG.md")"

# 앞뒤 빈 줄 정리
section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"

if [[ -z "$section" ]]; then
  echo "CHANGELOG.md 에 [$version] 항목이 없습니다." >&2
  exit 1
fi

printf '%s\n' "$section"
