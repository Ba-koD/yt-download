#!/usr/bin/env bash
# 크롬 확장(`extension/`)을 사파리 확장으로 바꾼다.
#
#   ./scripts/build-safari.sh
#
# **macOS + Xcode 에서만 된다.** 사파리 확장은 웹 확장을 감싼 맥 앱으로만 배포되고,
# 그 변환·서명·빌드를 애플 도구(`xcrun`, Xcode)가 한다. 윈도우·리눅스에서는 만들 수 없다.
#
# 이 스크립트가 하는 일:
#   1. safari-web-extension-converter 로 extension/ 을 Xcode 프로젝트로 바꾼다
#      (dist/safari/ 에 맥 앱 + 확장이 생긴다).
#   2. 그 프로젝트를 빌드해 앱을 만든다.
#
# 그 뒤 사람이 해야 하는 것(자동으로 못 한다):
#   - 처음 시험: 사파리 → 설정 → 고급 → "메뉴 막대에서 개발자용 메뉴 보기" 켜기 →
#     개발자용 → "서명 없는 확장 프로그램 허용" → 앱을 한 번 실행해 확장을 켠다.
#     ("서명 없는 확장 허용"은 사파리를 새로 켤 때마다 다시 켜야 한다.)
#   - 남들에게 배포: Apple Developer 계정으로 서명·공증(notarize)하고 앱 스토어에 올리거나
#     공증된 앱으로 내보내야 한다. 서명 없이는 다른 맥에서 켜지지 않는다.
#
# 파이어폭스처럼 "폴더만 갈아 끼우면 자동 갱신"은 사파리에선 안 된다. 확장이 앱 번들 안에
# 서명된 채로 들어가서, 갱신하려면 앱을 다시 빌드·서명해야 한다.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "이 스크립트는 macOS 에서만 됩니다(사파리 확장은 Xcode 로만 만듭니다)." >&2
  echo "지금 OS: $(uname -s)" >&2
  exit 1
fi

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "safari-web-extension-converter 를 찾지 못했습니다. Xcode(명령줄 도구 포함)를 설치하세요." >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out="dist/safari"
rm -rf "$out"
mkdir -p "$out"

echo "변환 중: extension/ → Xcode 프로젝트"
xcrun safari-web-extension-converter extension \
  --project-location "$out" \
  --app-name "yt-download" \
  --bundle-identifier "dev.local.yt-download" \
  --no-open --force --macos-only

project="$(find "$out" -name '*.xcodeproj' -maxdepth 2 | head -1)"
if [[ -z "$project" ]]; then
  echo "변환은 됐지만 Xcode 프로젝트를 찾지 못했습니다. $out 을 확인하세요." >&2
  exit 1
fi

echo "빌드 중: $project"
xcodebuild -project "$project" -scheme "yt-download (macOS)" -configuration Release build \
  || echo "빌드에 실패했습니다. Xcode 로 프로젝트를 열어 스킴·서명을 확인하세요: $project"

echo
echo "완료. Xcode 프로젝트: $project"
echo "처음 시험은 사파리 개발자용 메뉴에서 '서명 없는 확장 프로그램 허용'을 켜야 합니다."
echo "배포하려면 Apple Developer 서명·공증이 필요합니다(위 주석 참고)."
