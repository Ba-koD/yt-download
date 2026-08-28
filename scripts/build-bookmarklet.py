#!/usr/bin/env python3
"""확장(`extension/`)에서 북마클릿판을 뽑는다.

    python scripts/build-bookmarklet.py
    python scripts/build-bookmarklet.py --base https://내가/올린/곳/

만드는 것:
    docs/bookmarklet/panel.js  패널 전체를 담은 한 덩이(로더가 받아서 eval 한다)
    docs/index.html            배포 페이지(scripts/site.html 에 북마클릿 한 줄을 넣은 것)
    docs/.nojekyll             깃허브 페이지가 파일을 손대지 않게

`docs/` 를 깃허브 페이지로 켜면(설정 → Pages → main /docs) 그대로 배포 페이지가 된다.
받을 파일 목록은 페이지가 릴리스 API 를 물어보므로 새 판을 내도 여기를 고칠 일이 없다.

왜 되나 — 유튜브 watch 페이지의 CSP 를 실제로 재서 확인했다(2026-08-05):
- `connect-src` 지시어가 **없다** → 어디서든 fetch 로 코드를 받아올 수 있다.
- `script-src` 에 `'unsafe-eval'` 이 있다 → 받아온 코드를 eval 로 돌릴 수 있다.
  (외부 도메인 `<script src>` 는 `strict-dynamic`+nonce 로 막히므로 fetch+eval 이어야 한다.)
- `require-trusted-types-for 'script'` 는 있지만 정책 이름을 제한하는 `trusted-types`
  지시어가 없다 → `trustedTypes.createPolicy` 로 자체 정책을 만들면 eval 이 통과한다.

확장과 무엇이 다른가:
- 처음부터 페이지(MAIN) 세계라 content script/MAIN 분리가 필요 없다. 미디어도 그대로 부른다.
- 배경 일꾼과 DNR 규칙이 없다. googlevideo 가 다른 호스트로 넘길 때(cms_redirect) 쓰던
  예비 통로가 없어서, 그 경우엔 재시도로만 버틴다.
- 갱신이 없다 — 누를 때마다 배포처에서 최신을 받아온다.

소스는 `extension/src/` 하나다. 여기서는 ES 모듈을 eval 할 수 있는 한 덩이로 엮기만 한다.
"""

import argparse
import base64
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension" / "src"
SITE_TEMPLATE = Path(__file__).resolve().parent / "site.html"
DOCS = ROOT / "docs"
OUT_DIR = DOCS / "bookmarklet"

# 기본 배포처 — 깃허브 페이지(`docs/` 를 그대로 내보낸다).
#
# 전에는 jsDelivr 를 썼는데 `@main` 이 밀어 올린 뒤에도 한참 옛 판을 내줬다. 파일 경로를
# 퍼지해도 소용없다 — 브랜치 이름을 커밋으로 푸는 단계가 따로 캐시되기 때문이다(실측했다).
# 페이지는 밀면 곧바로 바뀌고, `Access-Control-Allow-Origin: *` 라 유튜브에서 받아올 수 있다.
DEFAULT_BASE = "https://ba-kod.github.io/yt-download/"

# 패널이 쓰는 모듈. content.js 가 부르는 이름 그대로다(의존 순서는 레지스트리가 알아서 푼다).
MODULES = [
    "net.js",
    "innertube.js",
    "mp4index.js",
    "mp4mux.js",
    "mp4file.js",
    "store.js",
    "sabr.js",
    "download.js",
    "nsig.js",
]

IMPORT_RE = re.compile(r'^import\s*\{([^}]*)\}\s*from\s*"\./([^"]+)";?\s*$', re.M | re.S)
EXPORT_DECL_RE = re.compile(r"^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)


def write(path: Path, text: str) -> None:
    """만든 파일은 어느 OS 에서 빌드해도 같아야 한다(CI 가 소스와 대조한다).
    윈도우에서 그냥 쓰면 줄바꿈이 CRLF 로 바뀌므로 LF 로 못박는다."""
    with open(path, "w", encoding="utf-8", newline="\n") as file:
        file.write(text)


def to_factory(name: str, source: str) -> str:
    """ES 모듈 하나를 레지스트리가 부를 수 있는 공장 함수로 바꾼다.

    `import {a} from "./x.js"` → `const {a} = __need("x.js")`
    `export function f` → `function f` + 내보내기 표에 등록

    쓰는 문법이 위 두 가지뿐이라(기본 내보내기도, 이름 바꾸기도 없다) 이 정도로 충분하다.
    새 문법을 쓰기 시작하면 여기서 걸리도록 아래에서 검사한다.
    """
    exported = [match.group(2) for match in EXPORT_DECL_RE.finditer(source)]
    body = IMPORT_RE.sub(lambda m: f'const {{{m.group(1)}}} = __need("{m.group(2)}");', source)
    body = EXPORT_DECL_RE.sub(r"\1 \2", body)

    leftover = re.search(r"^\s*(import|export)\b", body, re.M)
    if leftover:
        line = body[: leftover.start()].count("\n") + 1
        raise SystemExit(f"{name}:{line} 옮기지 못한 모듈 문법이 남았습니다: {leftover.group(1)}")

    table = ", ".join(f"{item}: {item}" for item in exported)
    return f'__define("{name}", (__need) => {{\n{body}\nreturn {{{table}}};\n}});'


def build_panel(base: str) -> str:
    parts = [
        "// yt-download 북마클릿판 — scripts/build-bookmarklet.py 가 만든 파일입니다.",
        "// 고칠 곳은 extension/src/ 입니다. 이 파일을 직접 고치지 마세요.",
        "(() => {",
        "const __mods = {};",
        "const __ready = {};",
        "const __define = (name, factory) => { __mods[name] = factory; };",
        "const __need = (name) => {",
        "  if (!(name in __ready)) {",
        "    if (!__mods[name]) throw new Error(`모듈을 찾지 못했습니다: ${name}`);",
        "    __ready[name] = __mods[name](__need);",
        "  }",
        "  return __ready[name];",
        "};",
    ]

    for name in MODULES:
        parts.append(to_factory(name, (SRC / name).read_text(encoding="utf-8")))

    # 해결기 원본을 어디서 받아올지. nsig.js 가 이 값을 기준으로 vendor/ 를 찾는다.
    parts.append(f"window.__ytdlBase = {json.dumps(base)};")
    # content.js 는 확장에서 하던 대로 이름으로 모듈을 찾는다. 미리 다 만들어 넘긴다.
    parts.append("window.__ytdlModules = Object.fromEntries(")
    parts.append(f"  {json.dumps(MODULES)}.map((name) => [name, __need(name)]),")
    parts.append(");")

    # 패널 모양새. 확장은 매니페스트가 넣어주지만 여기서는 직접 붙인다.
    css = (SRC / "overlay.css").read_text(encoding="utf-8")
    parts.append("const __styleId = 'ytdl-overlay-style';")
    parts.append("document.getElementById(__styleId)?.remove();")
    parts.append("const __style = document.createElement('style');")
    parts.append("__style.id = __styleId;")
    parts.append(f"__style.textContent = {json.dumps(css)};")
    parts.append("document.documentElement.append(__style);")

    # 페이지 쪽 다리(재생 위치 읽기, n 풀기). 북마클릿도 같은 약속을 그대로 쓴다.
    parts.append("(() => {")
    parts.append((SRC / "page-fetch.js").read_text(encoding="utf-8"))
    parts.append("})();")

    # 패널 본체.
    parts.append((SRC / "content.js").read_text(encoding="utf-8"))
    parts.append("})();")
    return "\n".join(parts) + "\n"


def build_loader(base: str) -> str:
    """북마크에 담을 한 줄. 누를 때마다 최신 panel.js 를 받아 돌린다."""
    url = base + "bookmarklet/panel.js"
    return (
        "javascript:(async()=>{"
        "try{"
        f"const r=await fetch({json.dumps(url)}+'?t='+Date.now());"
        "if(!r.ok)throw new Error('HTTP '+r.status);"
        "const s=await r.text();"
        "const p=window.trustedTypes&&window.trustedTypes.createPolicy"
        "?window.trustedTypes.createPolicy('ytdl-boot-'+Date.now(),{createScript:t=>t}):null;"
        "(0,eval)(p?p.createScript(s):s);"
        "}catch(e){"
        "console.error('[yt-download]',e);"
        "const d=document.createElement('div');"
        "d.textContent='yt-download 를 불러오지 못했습니다: '+e.message;"
        "d.style.cssText='position:fixed;z-index:99999;left:50%;top:24px;transform:translateX(-50%);"
        "background:#c00;color:#fff;padding:10px 16px;border-radius:8px;font:14px sans-serif';"
        "document.body.appendChild(d);setTimeout(()=>d.remove(),6000);"
        "}})()"
    )


# 북마크 바에 보일 이름. 끌어다 놓으면 이 글자가 그대로 북마크 이름이 된다.
# 크롬은 북마클릿에 아이콘을 못 붙이므로(아래 build_import_file 참고) 이모지로 표시한다.
BOOKMARK_NAME = "✂️ 구간 받기"


def build_import_file(loader: str) -> str:
    """로고가 박힌 북마크를 만들어 주는 가져오기 파일.

    크롬은 북마크 아이콘을 화면에서 바꾸지 못하고, `javascript:` 주소는 불러올 페이지가
    없어서 파비콘을 알아낼 수도 없다. 다만 **북마크 가져오기**로 들어오는 파일의
    `ICON=` 속성은 그대로 받아준다. 그래서 아이콘을 data URI 로 박아 넣은 파일을 만들어 둔다.
    """
    icon = base64.b64encode((ROOT / "assets" / "icon-32.png").read_bytes()).decode()
    # 로더 안에는 따옴표가 들어 있다. 그대로 두면 HREF 속성이 거기서 끊긴다.
    loader = loader.replace("&", "&amp;").replace('"', "&quot;")
    # 넷스케이프 북마크 파일 형식. 크롬·엣지·파이어폭스가 모두 이 형식을 읽는다.
    return (
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n"
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n'
        "<TITLE>Bookmarks</TITLE>\n"
        "<H1>Bookmarks</H1>\n"
        "<DL><p>\n"
        f'    <DT><A HREF="{loader}" ICON="data:image/png;base64,{icon}">{BOOKMARK_NAME}</A>\n'
        "</DL><p>\n"
    )


def main():
    parser = argparse.ArgumentParser(description="북마클릿판을 만든다")
    parser.add_argument(
        "--base",
        default=DEFAULT_BASE,
        help=f"panel.js 와 vendor/ 를 올려둘 곳 (기본: {DEFAULT_BASE})",
    )
    args = parser.parse_args()
    base = args.base if args.base.endswith("/") else args.base + "/"

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    panel = build_panel(base)
    write(OUT_DIR / "panel.js", panel)

    # 북마클릿은 href 안에 통째로 들어간다. HTML 특수문자만 피해서 넣는다.
    loader = build_loader(base).replace("&", "&amp;").replace('"', "&quot;")
    template = SITE_TEMPLATE.read_text(encoding="utf-8")
    if "__LOADER__" not in template:
        raise SystemExit(f"{SITE_TEMPLATE} 에 __LOADER__ 자리가 없습니다")
    page = template.replace("__LOADER__", loader).replace("__BOOKMARK_NAME__", BOOKMARK_NAME)
    write(DOCS / "index.html", page)

    # 로고까지 붙이고 싶은 사람을 위한 가져오기 파일(끌어다 놓기로는 아이콘을 못 붙인다).
    write(DOCS / "bookmarklet.html", build_import_file(build_loader(base)))

    # 깃허브 페이지가 Jekyll 로 다시 굽지 않게 한다(파일을 그대로 내보낸다).
    write(DOCS / ".nojekyll", "")

    # 화면 탭에 뜨는 아이콘. 앱과 같은 것을 쓴다.
    shutil.copyfile(ROOT / "assets" / "icon-128.png", DOCS / "icon.png")

    # 로그인 영상의 주소를 푸는 해결기. 배포처 한 곳에서 다 받을 수 있어야 해서 함께 담는다.
    vendor = DOCS / "vendor"
    vendor.mkdir(exist_ok=True)
    for name in ("yt-solver-lib.js", "yt-solver-core.js"):
        shutil.copyfile(ROOT / "extension" / "vendor" / name, vendor / name)

    print(f"만들었습니다: {OUT_DIR / 'panel.js'}  ({len(panel) / 1024:.0f} KB)")
    print(f"           {DOCS / 'index.html'}")
    print(f"배포처: {base}")
    print("배포: 저장소 설정 → Pages → Source 를 main 브랜치 /docs 로 두면 그대로 올라갑니다.")


if __name__ == "__main__":
    main()
