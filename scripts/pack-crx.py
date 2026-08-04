#!/usr/bin/env python3
"""확장을 서명해 `.crx` 로 묶고, 브라우저가 볼 `update.xml` 을 만든다.

    python scripts/pack-crx.py --key crx-key.pem

만드는 것:
    dist/yt-download.crx   서명된 확장
    dist/update.xml        브라우저가 "새 버전 있나" 물어볼 때 보는 답

왜 필요한가:
    크롬 웹 스토어에 못 올리는 확장을 사람 손 없이 넣는 길은 **정책 강제 설치**뿐이다.
    정책은 `<확장ID>;<update.xml 주소>` 만 받으므로, 서명된 CRX 와 그 주소가 있어야 한다.
    폴더(압축해제 확장)로는 정책에 못 건다.

왜 크롬을 안 쓰나:
    `chrome.exe --pack-extension` 이 같은 일을 하지만 CI 러너에 크롬을 깔아야 하고,
    윈도우·리눅스에서 실행 파일 자리가 제각각이다. CRX3 는 형식이 단순해서 직접 쓴다.

CRX3 형식(크로미움 `components/crx_file/crx3.proto` 를 그대로 따른다):

    "Cr24" | 버전 3 | 헤더 길이 | CrxFileHeader(protobuf) | zip 바이트

    CrxFileHeader 는 서명 하나(`sha256_with_rsa`)와 `signed_header_data` 를 담는다.
    서명 대상은 zip 자체가 아니라 다음을 이어 붙인 것이다:

        b"CRX3 SignedData\\x00" | signed_header_data 길이(LE4) | signed_header_data | zip

    `signed_header_data` 안에는 확장 ID(공개키 SHA-256 의 앞 16바이트)가 들어간다.
    그래서 서명이 "이 키로 만든 이 ID 의 확장"을 함께 못박는다.

protobuf 를 손으로 쓰는 이유:
    필드가 다섯 개뿐이라 라이브러리(`protobuf`)를 하나 더 들이는 값이 없다.
    varint 와 길이 앞세운 바이트열, 두 가지만 쓴다.
"""

import argparse
import hashlib
import struct
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
OUT_DIR = ROOT / "dist"

# 담을 것. 크롬용 압축과 같은 목록(테스트 픽스처 제외).
INCLUDE = ["manifest.json", "icons", "src", "vendor", "README.md"]
SKIP_NAMES = {".DS_Store"}
SKIP_DIRS = {"_metadata", "test"}

CRX_MAGIC = b"Cr24"
CRX_VERSION = 3
# 서명 앞에 붙는 표시. 이게 있어서 다른 데서 만든 서명을 CRX 에 옮겨 붙일 수 없다.
SIGNED_DATA_PREFIX = b"CRX3 SignedData\x00"


# ── 아주 작은 protobuf 쓰기 ────────────────────────────────────────────────


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        out.append(chunk | (0x80 if value else 0))
        if not value:
            return bytes(out)


def field(number: int, payload: bytes) -> bytes:
    """길이를 앞세운 필드(wire type 2). 이 파일에 필요한 유일한 형태다."""
    return varint((number << 3) | 2) + varint(len(payload)) + payload


def crx_id(public_key_der: bytes) -> bytes:
    """확장 ID 의 원본 16바이트. 사람이 보는 `abcdefgh…` 는 이걸 a~p 로 옮긴 것이다."""
    return hashlib.sha256(public_key_der).digest()[:16]


def readable_id(public_key_der: bytes) -> str:
    return "".join(
        chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0xF))
        for byte in crx_id(public_key_der)
    )


# ── 묶기 ───────────────────────────────────────────────────────────────────


def build_zip(target: Path) -> bytes:
    """확장 폴더를 zip 으로 묶는다. 매번 같은 바이트가 나오도록 시각을 못박는다."""
    if target.exists():
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)

    paths = []
    for name in INCLUDE:
        source = SRC / name
        if source.is_file():
            paths.append(source)
            continue
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.name in SKIP_NAMES:
                continue
            relative = path.relative_to(SRC)
            if any(part in SKIP_DIRS for part in relative.parts):
                continue
            paths.append(path)

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            info = zipfile.ZipInfo(path.relative_to(SRC).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    return target.read_bytes()


def sign(private_key, zip_bytes: bytes) -> bytes:
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )

    # SignedData { bytes crx_id = 1; }
    signed_header_data = field(1, crx_id(public_der))

    to_sign = (
        SIGNED_DATA_PREFIX
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_bytes
    )
    signature = private_key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    # AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
    proof = field(1, public_der) + field(2, signature)
    # CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
    #                 bytes signed_header_data = 10000; }
    header = field(2, proof) + field(10000, signed_header_data)

    return (
        CRX_MAGIC
        + struct.pack("<II", CRX_VERSION, len(header))
        + header
        + zip_bytes
    )


UPDATE_XML = """<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='{app_id}'>
    <updatecheck codebase='{codebase}' version='{version}' />
  </app>
</gupdate>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", required=True, help="서명 개인키 PEM 파일")
    parser.add_argument(
        "--codebase",
        default="https://github.com/Ba-koD/yt-download/releases/latest/download/yt-download.crx",
        help="브라우저가 CRX 를 받아갈 주소(https 여야 한다)",
    )
    args = parser.parse_args()

    private_key = serialization.load_pem_private_key(
        Path(args.key).read_bytes(), password=None
    )
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    app_id = readable_id(public_der)

    # 매니페스트의 `key` 는 이 서명키의 공개키여야 한다. 어긋나면 크롬이 설치를 거부하는데,
    # 그때 나오는 말("CRX_ID_INVALID")로는 무엇이 어긋났는지 알기 어렵다. 여기서 먼저 잡는다.
    import json

    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    import base64

    declared = manifest.get("key")
    if declared and base64.b64decode(declared) != public_der:
        print(
            "manifest.json 의 key 가 이 서명키의 공개키와 다릅니다.\n"
            f"  이 키로 나오는 확장 ID: {app_id}\n"
            "  둘이 어긋나면 브라우저가 설치를 거부합니다.",
            file=sys.stderr,
        )
        return 1

    version = manifest["version"]
    zip_bytes = build_zip(OUT_DIR / "yt-download-extension-crx.zip")
    crx = sign(private_key, zip_bytes)

    crx_path = OUT_DIR / "yt-download.crx"
    crx_path.write_bytes(crx)
    (OUT_DIR / "update.xml").write_text(
        UPDATE_XML.format(app_id=app_id, codebase=args.codebase, version=version),
        encoding="utf-8",
    )
    # 묶는 중간물이라 남길 이유가 없다(릴리스 자산으로 딸려 올라가면 헷갈린다).
    (OUT_DIR / "yt-download-extension-crx.zip").unlink()

    print(f"확장 ID: {app_id}")
    print(f"버전:    {version}")
    print(f"만들었습니다: {crx_path}  ({len(crx):,} 바이트)")
    print(f"           {OUT_DIR / 'update.xml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
