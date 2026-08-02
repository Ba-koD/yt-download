"""확장 압축본에 필요한 파일이 다 들어갔는지 확인한다.

담을 것을 손으로 적다 보니 새 폴더를 빠뜨리기 쉽다. 실제로 `vendor/` 를 빠뜨린 적이 있고,
그 상태로 릴리스가 나가면 로그인이 필요한 영상이 조용히 실패한다.

규칙은 간단하다 — 검사용 파일(`test/`)만 빼고 나머지는 전부 들어가야 한다.
어느 파일이 어디서 불리는지 따지지 않는다. 확장은 모듈을 이름으로 불러오기도 해서
코드를 훑어 알아내는 방식은 반드시 빈틈이 생긴다.
"""

import json
import sys
import zipfile
from pathlib import Path

SKIP_DIRS = {"test", "node_modules", ".git"}
SKIP_NAMES = {".DS_Store"}


def wanted_files(extension_dir):
    for path in sorted(extension_dir.rglob("*")):
        if not path.is_file() or path.name in SKIP_NAMES:
            continue
        relative = path.relative_to(extension_dir)
        if relative.parts[0] in SKIP_DIRS:
            continue
        yield str(relative).replace("\\", "/")


def main():
    archive_path, extension_dir = Path(sys.argv[1]), Path(sys.argv[2])
    with zipfile.ZipFile(archive_path) as archive:
        inside = {name for name in archive.namelist() if not name.endswith("/")}
        # 압축을 푼 자리에 manifest.json 이 바로 있어야 크롬이 폴더로 인식한다.
        manifest = json.loads(archive.read("manifest.json"))

    wanted = sorted(wanted_files(extension_dir))
    missing = [name for name in wanted if name not in inside]

    print(f"확장 {manifest.get('version')} · 있어야 할 파일 {len(wanted)}개 / 압축본 {len(inside)}개")
    for name in wanted:
        print(f"  {'있음' if name in inside else '없음 <-'}  {name}")

    extra = sorted(inside - set(wanted))
    if extra:
        print("\n들어가면 안 되는 파일:")
        for name in extra:
            print(f"  {name}")

    if missing or extra:
        sys.exit(1)
    print("\n다 들어 있습니다.")


if __name__ == "__main__":
    main()
