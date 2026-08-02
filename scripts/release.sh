#!/usr/bin/env bash
# 버전을 올리고 릴리스 태그를 만든다.
#
#   ./scripts/release.sh                 patch 한 칸 (0.1.0 -> 0.1.1)
#   ./scripts/release.sh minor           minor 한 칸 (0.1.0 -> 0.2.0)
#   ./scripts/release.sh 1.2.0           버전 직접 지정
#   ./scripts/release.sh minor --push    만들고 바로 밀기(= 릴리스 시작)
#
# VERSION, Cargo.toml, Cargo.lock, CHANGELOG.md 를 함께 고치고 v<버전> 태그를 만든다.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

what="patch"
push=0
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    patch|minor|major) what="$arg" ;;
    v*.*.*|*.*.*) what="${arg#v}" ;;
    *) echo "모르는 인자: $arg" >&2; exit 1 ;;
  esac
done

[[ -d .git ]] || { echo "git 저장소가 아닙니다. 먼저 git init 을 하세요." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "커밋하지 않은 변경이 있습니다." >&2; exit 1; }

current="$(tr -d '[:space:]' < VERSION)"
if [[ "$what" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next="$what"
else
  IFS=. read -r major minor patch <<< "$current"
  case "$what" in
    major) next="$((major + 1)).0.0" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    patch) next="$major.$minor.$((patch + 1))" ;;
  esac
fi
[[ "$next" != "$current" ]] || { echo "지금 버전과 같습니다: $next" >&2; exit 1; }

tag="v$next"
[[ -z "$(git tag --list "$tag")" ]] || { echo "태그가 이미 있습니다: $tag" >&2; exit 1; }
echo "$current -> $next"

# 1) VERSION — 단일 출처
printf '%s\n' "$next" > VERSION

# 2) Cargo.toml 의 [package] 버전만 (첫 version 줄 하나만) 바꾼다.
awk -v v="$next" '
  !seen && /^version = "/ { print "version = \"" v "\""; seen = 1; next }
  { print }
' Cargo.toml > Cargo.toml.tmp && mv Cargo.toml.tmp Cargo.toml

# 2-1) 확장 관리자도 같은 버전으로 나간다.
awk -v v="$next" '
  !seen && /^version = "/ { print "version = \"" v "\""; seen = 1; next }
  { print }
' manager/Cargo.toml > manager/Cargo.toml.tmp && mv manager/Cargo.toml.tmp manager/Cargo.toml

# 3) 확장 매니페스트도 같은 버전을 달아야 한다.
awk -v v="$next" '
  !seen && /^[[:space:]]*"version"[[:space:]]*:/ { sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" v "\""); seen = 1 }
  { print }
' extension/manifest.json > extension/manifest.json.tmp && mv extension/manifest.json.tmp extension/manifest.json

# 4) CHANGELOG — Unreleased 아래에 새 칸을 만들고 비교 링크를 옮긴다.
grep -q '^## \[Unreleased\]' CHANGELOG.md || { echo "CHANGELOG 에 ## [Unreleased] 가 없습니다." >&2; exit 1; }
repo_url="$(sed -n 's|^\[Unreleased\]: \(.*\)/compare/v[0-9.]*\.\.\.HEAD$|\1|p' CHANGELOG.md | head -1)"
[[ -n "$repo_url" ]] || { echo "CHANGELOG 의 [Unreleased] 링크를 찾지 못했습니다." >&2; exit 1; }

awk -v v="$next" -v d="$(date +%F)" -v tag="$tag" -v url="$repo_url" '
  /^## \[Unreleased\]/ && !added { print; print ""; print "## [" v "] - " d; added = 1; next }
  /^\[Unreleased\]: .*\/compare\// && !linked {
    print "[Unreleased]: " url "/compare/" tag "...HEAD"
    print "[" v "]: " url "/releases/tag/" tag
    linked = 1; next
  }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# 5) Cargo.lock 에도 자기 버전이 적혀 있다.
cargo update --workspace --offline >/dev/null 2>&1 ||
  echo "경고: Cargo.lock 갱신 실패 — cargo check 를 한 번 돌려주세요." >&2

git add VERSION Cargo.toml Cargo.lock CHANGELOG.md extension/manifest.json manager/Cargo.toml
git commit -m "release: $tag" >/dev/null
git tag -a "$tag" -m "yt-download $tag"

echo
echo "커밋과 태그를 만들었습니다: $tag"
echo "CHANGELOG.md 의 [$next] 칸을 먼저 채워두면 릴리스 설명으로 그대로 올라갑니다."
if (( push )); then
  git push origin HEAD
  git push origin "$tag"
  echo "밀었습니다. GitHub Actions 의 release 워크플로가 빌드를 시작합니다."
else
  echo
  echo "밀 준비가 되면:  git push origin HEAD && git push origin \"$tag\""
fi
