#!/usr/bin/env bash
# 릴리스 본문을 만든다. CHANGELOG 의 해당 버전 칸 + 이전 버전과의 비교 링크 + 짧은 받기 안내.
# 설치 방법 같은 가이드는 여기 늘어놓지 않는다 — README 에 두고 링크한다.
#
#   ./scripts/release-notes.sh 0.2.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:?버전을 넘겨주세요 (예: 0.1.0)}"
version="${version#v}"

"$root/scripts/changelog-section.sh" "$version"

repo_url="$(sed -n 's|^\[Unreleased\]: \(.*\)/compare/v[0-9.]*\.\.\.HEAD$|\1|p' "$root/CHANGELOG.md" | head -1)"
# CHANGELOG 에서 이 버전 제목 바로 다음에 오는 버전 제목이 이전 버전이다.
prev="$(grep -oE '^## \[[0-9.]+\]' "$root/CHANGELOG.md" | tr -d '#[] ' |
  awk -v v="$version" 'seen { print; exit } $0 == v { seen = 1 }')"

echo
if [[ -n "$repo_url" && -n "$prev" ]]; then
  echo "**전체 변경 내역**: [v$prev → v$version]($repo_url/compare/v$prev...v$version)"
  echo
fi

cat <<NOTES
---

## 받기

| 파일 | 무엇 |
| --- | --- |
| \`yt-download-<플랫폼>.zip/.tar.gz\` | 데스크톱 앱 (도구 내장, 파일 하나로 동작) |
| \`yt-download-extension.zip\` | 크롬 확장 (Edge·Brave 등 크로미움 계열 포함) |
| \`yt-download-extension-firefox.zip\` | 파이어폭스 확장 |
| \`SHA256SUMS.txt\` | 받은 파일 검증용 |

- **앱** 플랫폼별 파일·요구 사항·자동 갱신: [README의 "받기"]($repo_url#받기)
- **확장** 설치·새 버전 갱신(웹 스토어에 없어 직접 얹습니다): [extension/README]($repo_url/blob/v$version/extension/README.md)
NOTES
