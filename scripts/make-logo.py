#!/usr/bin/env python3
"""로고를 그려서 필요한 크기·형식으로 내보낸다.

    python scripts/make-logo.py

만드는 것(전부 assets/ 아래):

    icon-16/32/48/128/256/512.png   확장 아이콘, 문서용
    icon.ico                        윈도우 실행 파일 아이콘
    icon-64.rgba                    앱·관리자 창 아이콘(생 RGBA, 디코더 없이 바로 쓴다)

`assets/icon.svg` 는 같은 모양을 손으로 적어둔 것이다(웹 파비콘용). 여기 값을 고치면
그쪽도 같이 고쳐야 한다.

모양: 둥근 사각형 바탕에 흰 내려받기 화살표, 그 아래 구간 막대.
막대 양 끝의 홈은 이 앱이 하는 일(구간 고르기)을 가리킨다.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

# 그릴 때 쓰는 크기. 크게 그려서 줄이면 가장자리가 부드럽다.
CANVAS = 2048

# 앱 화면과 같은 청록 계열.
TOP_LEFT = (60, 208, 176)
BOTTOM_RIGHT = (13, 106, 96)
GLYPH = (255, 255, 255, 255)


def draw_logo(size: int = CANVAS) -> Image.Image:
    # 2x2 짜리 그림을 늘려서 대각선 그러데이션을 만든다(줄마다 계산할 것 없이 매끈하다).
    corners = Image.new("RGB", (2, 2))
    corners.putpixel((0, 0), TOP_LEFT)
    corners.putpixel((1, 0), _mix(TOP_LEFT, BOTTOM_RIGHT, 0.45))
    corners.putpixel((0, 1), _mix(TOP_LEFT, BOTTOM_RIGHT, 0.55))
    corners.putpixel((1, 1), BOTTOM_RIGHT)
    background = corners.resize((size, size), Image.BILINEAR).convert("RGBA")

    # 둥근 사각형으로 잘라낸다.
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * 0.225), fill=255
    )
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    image.paste(background, mask=mask)

    draw = ImageDraw.Draw(image)
    unit = size / 100  # 100 칸 기준으로 자리를 잡는다

    # 화살표 대: 위에서 내려온다.
    draw.rounded_rectangle(
        (43 * unit, 20 * unit, 57 * unit, 52 * unit), radius=7 * unit, fill=GLYPH
    )
    # 화살표 촉.
    draw.polygon(
        [(27 * unit, 44 * unit), (73 * unit, 44 * unit), (50 * unit, 73 * unit)],
        fill=GLYPH,
    )
    # 구간 막대: 앱의 타임라인처럼 양 끝에 시작·끝 손잡이를 세운다.
    draw.rounded_rectangle(
        (26 * unit, 82 * unit, 74 * unit, 87 * unit), radius=2.5 * unit, fill=GLYPH
    )
    for x in (29, 71):
        draw.rounded_rectangle(
            ((x - 1.6) * unit, 77 * unit, (x + 1.6) * unit, 92 * unit),
            radius=1.2 * unit,
            fill=GLYPH,
        )
    return image


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    master = draw_logo()

    # macOS 아이콘(.icns)은 16~1024 를 다 요구해서 그 크기들을 함께 만들어 둔다.
    sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    for size in sizes:
        master.resize((size, size), Image.LANCZOS).save(ASSETS / f"icon-{size}.png")

    # 확장은 자기 폴더 안에 있는 것만 쓸 수 있다(압축본에 그것만 들어간다).
    extension_icons = ROOT / "extension" / "icons"
    extension_icons.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(extension_icons / f"icon-{size}.png")

    # 윈도우 실행 파일용. 여러 크기를 한 파일에 담는다.
    master.resize((256, 256), Image.LANCZOS).save(
        ASSETS / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )

    # 창 아이콘용 생 RGBA. 이러면 앱에 PNG 해독기를 넣지 않아도 된다.
    (ASSETS / "icon-64.rgba").write_bytes(
        master.resize((64, 64), Image.LANCZOS).convert("RGBA").tobytes()
    )

    made = ", ".join(f"icon-{size}.png" for size in sizes)
    print(f"만들었습니다: assets/{{{made}}}, icon.ico, icon-64.rgba, extension/icons/*")


if __name__ == "__main__":
    main()
