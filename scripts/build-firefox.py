#!/usr/bin/env python3
"""크롬 확장(`extension/`)에서 파이어폭스용을 뽑는다.

    python scripts/build-firefox.py

만드는 것:
    dist/firefox/                        about:debugging 으로 바로 얹을 수 있는 폴더
    dist/yt-download-extension-firefox.zip  서명(AMO)이나 배포용

소스는 `extension/` 하나다. 여기서는 **매니페스트만** 파이어폭스에 맞게 바꾸고
나머지 파일은 그대로 베낀다. 두 브라우저가 갈라져 관리되지 않도록.

파이어폭스와 크롬이 다른 점(직접 옮긴 것):
- 배경: 크롬은 `service_worker`, 파이어폭스는 `background.scripts`(이벤트 페이지).
  background.js 는 `import` 를 쓰지 않아 그대로 이벤트 페이지로 돈다.
- `browser_specific_settings.gecko` 로 확장 ID 와 최소 버전을 못박아야 한다.
  `world: "MAIN"`(page-fetch 가 페이지 문맥에서 도는 데 필요)은 파이어폭스 128부터다.

검증은 못 했다(이 개발 기계에 파이어폭스가 없다). 얹어보고 콘솔을 봐야 한다.
"""

import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
OUT_DIR = ROOT / "dist" / "firefox"
OUT_ZIP = ROOT / "dist" / "yt-download-extension-firefox.zip"

# 담을 것. 크롬용 압축과 같은 목록(테스트 픽스처 제외).
INCLUDE = ["manifest.json", "icons", "src", "vendor", "README.md"]
SKIP_NAMES = {".DS_Store"}
SKIP_DIRS = {"_metadata", "test"}


def firefox_manifest(chrome_manifest: dict) -> dict:
    """크롬 매니페스트를 파이어폭스용으로 바꾼다."""
    manifest = json.loads(json.dumps(chrome_manifest))  # 깊은 복사

    # 배경: service_worker → scripts. 파이어폭스는 service_worker 배경을 아직 안 받는다.
    worker = manifest.get("background", {}).get("service_worker")
    if worker:
        manifest["background"] = {"scripts": [worker]}

    # 확장 ID·최소 버전. world:"MAIN" 이 파이어폭스 128부터라 그 아래는 막는다.
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": "yt-download@ba-kod.github",
            "strict_min_version": "128.0",
        }
    }
    return manifest


def copy_tree(name: str, out: Path):
    source = SRC / name
    if source.is_file():
        if source.name not in SKIP_NAMES:
            shutil.copy2(source, out / name)
        return
    for path in source.rglob("*"):
        if not path.is_file() or path.name in SKIP_NAMES:
            continue
        relative = path.relative_to(SRC)
        if relative.parts[0] in SKIP_DIRS or any(part in SKIP_DIRS for part in relative.parts):
            continue
        target = out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def main():
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    chrome_manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    manifest = firefox_manifest(chrome_manifest)
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    for name in INCLUDE:
        if name == "manifest.json":
            continue
        copy_tree(name, OUT_DIR)

    OUT_ZIP.parent.mkdir(parents=True, exist_ok=True)
    if OUT_ZIP.exists():
        OUT_ZIP.unlink()
    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(OUT_DIR.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(OUT_DIR).as_posix())

    files = sum(1 for _ in OUT_DIR.rglob("*") if _.is_file())
    print(f"만들었습니다: {OUT_DIR}  ({files}개 파일)")
    print(f"           {OUT_ZIP}")
    print("얹기: 파이어폭스 about:debugging → 이 Firefox → 임시 부가 기능 로드 →")
    print(f"      {OUT_DIR / 'manifest.json'} 고르기")


if __name__ == "__main__":
    main()
