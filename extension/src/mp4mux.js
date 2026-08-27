// mp4 바이트를 읽는 연장들. 상자를 훑고, 조각(fragment) 안의 샘플 표를 꺼낸다.
//
// 여기는 "읽기"만 한다. 읽어낸 표로 파일을 짓는 일은 mp4file.js 가 맡는다.
//
// mp4 는 온통 상자(box)다. 상자마다 앞 4바이트가 크기, 다음 4바이트가 이름이고,
// 그 안에 또 상자가 들어 있다. 그래서 훑는 함수 하나면 어디든 닿을 수 있다.

const HEADER = 8;

/** 한 겹만 훑어서 박스 목록을 만든다. */
export function listBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset + HEADER <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (size < HEADER || offset + size > end) break;
    boxes.push({ type, start: offset, end: offset + size, size });
    offset += size;
  }
  return boxes;
}

/** 경로로 박스를 찾는다. 예: findPath(bytes, ["moov", "trak", "tkhd"]) */
export function findPath(bytes, path, start = 0, end = bytes.length) {
  let from = start;
  let to = end;
  let found = null;
  for (const type of path) {
    found = listBoxes(bytes, from, to).find((box) => box.type === type);
    if (!found) return null;
    from = found.start + HEADER;
    to = found.end;
  }
  return found;
}

export function boxBytes(bytes, box) {
  return bytes.subarray(box.start, box.end);
}

function u32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function ascii(text) {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

export function makeBox(type, ...payloads) {
  const size = HEADER + payloads.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(ascii(type), 4);
  let offset = HEADER;
  for (const part of payloads) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readU64At(bytes, offset) {
  return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset));
}

function readU32At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** 앞머리(init)에 담긴 트랙의 시간 단위. 조각의 tfdt 와 샘플 길이가 이 단위를 쓴다. */
export function mediaTimescaleOf(init) {
  const moov = findPath(init, ["moov"]);
  if (!moov) return 0;
  const trak = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  return trak ? readMediaTimescale(init, trak) : 0;
}

export function readMediaTimescale(bytes, trakBox) {
  const mdhd = findPath(bytes, ["mdia", "mdhd"], trakBox.start + HEADER, trakBox.end);
  if (!mdhd) throw new Error("mdhd 를 찾지 못했습니다");
  const version = bytes[mdhd.start + HEADER];
  return readU32At(bytes, mdhd.start + HEADER + 4 + (version === 1 ? 16 : 8));
}

/**
 * 조각 안의 샘플을 하나하나 읽어 표로 만든다.
 *
 * `trun` 은 무엇을 담을지 플래그로 정한다. 소리 조각은 "크기만" 담은 단순한 모양이지만
 * 영상 조각은 길이·플래그·화면순서 보정까지 담는다(유튜브 영상은 `0xe01`). 그래서
 * 소리 전용으로 짜여 있던 `readTrunSizes` 로는 영상 조각을 아예 못 건드렸다.
 *
 * 라이브에서 온 조각은 moof+mdat 짝이 여러 개다. 순서대로 이어 읽는다.
 *
 * @returns {{decodeTime: number, samples: Array<{at, size, duration, cto, sync}>}|null}
 *   `at` 은 조각 안에서 그 샘플의 바이트가 시작하는 자리다. 다루지 못하는 모양이면 null.
 */
export function readSamples(fragment) {
  const pairs = fragmentPairs(fragment);
  if (!pairs) return null;

  const samples = [];
  let decodeTime = null;

  for (const pair of pairs) {
    const traf = listBoxes(fragment, pair.moof.start + HEADER, pair.moof.end)
      .find((box) => box.type === "traf");
    if (!traf) return null;
    const children = listBoxes(fragment, traf.start + HEADER, traf.end);
    const tfhd = children.find((box) => box.type === "tfhd");
    if (!tfhd) return null;

    const head = readTfhd(fragment, tfhd, pair.moof.start);
    if (decodeTime === null) {
      const tfdt = children.find((box) => box.type === "tfdt");
      decodeTime = tfdt ? readDecodeTime(fragment, tfdt) : 0;
    }

    for (const trun of children.filter((box) => box.type === "trun")) {
      const read = readTrun(fragment, trun, head, pair);
      if (!read) return null;
      samples.push(...read);
    }
  }
  return samples.length ? { decodeTime: decodeTime || 0, samples } : null;
}

/** tfhd 의 기본값들. 여기 없는 값은 샘플마다 trun 이 들고 있다. */
function readTfhd(bytes, tfhd, moofStart) {
  const flags = readU32At(bytes, tfhd.start + HEADER) & 0xffffff;
  let at = tfhd.start + HEADER + 4 + 4; // version/flags + track_ID
  // 샘플 바이트가 어디부터인지의 기준점. 0x020000 은 "moof 시작이 기준"이라는 뜻이고,
  // 유튜브 조각이 그렇다. 기준점이 따로 적혀 있으면 그것을 쓴다.
  let base = moofStart;
  if (flags & 0x000001) {
    base = readU64At(bytes, at);
    at += 8;
  }
  if (flags & 0x000002) at += 4; // sample_description_index
  const duration = flags & 0x000008 ? readU32At(bytes, (at += 4) - 4) : 0;
  const size = flags & 0x000010 ? readU32At(bytes, (at += 4) - 4) : 0;
  const sampleFlags = flags & 0x000020 ? readU32At(bytes, (at += 4) - 4) : null;
  return { base, duration, size, sampleFlags };
}

function readDecodeTime(bytes, tfdt) {
  const at = tfdt.start + HEADER + 4;
  return bytes[tfdt.start + HEADER] === 1 ? readU64At(bytes, at) : readU32At(bytes, at);
}

/** `sample_is_non_sync_sample` 은 sample_flags 의 16번 비트다. 없으면 키프레임으로 본다. */
const isSync = (flags) => (flags === null || flags === undefined ? true : ((flags >>> 16) & 1) === 0);

function readTrun(bytes, trun, head, pair) {
  const word = readU32At(bytes, trun.start + HEADER);
  const version = word >>> 24;
  const flags = word & 0xffffff;
  const count = readU32At(bytes, trun.start + HEADER + 4);
  let at = trun.start + HEADER + 8;

  let cursor = head.base;
  if (flags & 0x000001) {
    cursor += new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at);
    at += 4;
  }
  let firstFlags = null;
  if (flags & 0x000004) {
    firstFlags = readU32At(bytes, at);
    at += 4;
  }

  const out = [];
  for (let i = 0; i < count; i += 1) {
    const duration = flags & 0x000100 ? readU32At(bytes, (at += 4) - 4) : head.duration;
    const size = flags & 0x000200 ? readU32At(bytes, (at += 4) - 4) : head.size;
    const own = flags & 0x000400 ? readU32At(bytes, (at += 4) - 4) : head.sampleFlags;
    // 화면 순서 보정. version 1 은 음수를 허용한다(B프레임이 앞뒤로 오갈 때 쓴다).
    let cto = 0;
    if (flags & 0x000800) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      cto = version === 0 ? view.getUint32(at) : view.getInt32(at);
      at += 4;
    }
    if (!size) return null; // 크기를 모르면 샘플을 떼어낼 수 없다
    out.push({
      at: cursor,
      size,
      duration,
      cto,
      sync: isSync(i === 0 && firstFlags !== null ? firstFlags : own),
    });
    cursor += size;
  }
  // 샘플 바이트가 mdat 밖을 가리키면 우리가 잘못 읽은 것이다. 조용히 틀리느니 포기한다.
  const last = out[out.length - 1];
  if (out[0] && (out[0].at < pair.mdat.start || last.at + last.size > pair.mdat.end)) return null;
  return out;
}

/** 조각 속의 moof+mdat 짝들. 하나짜리(일반 영상)도, 여러 개짜리(라이브 출신)도 있다. */
function fragmentPairs(bytes) {
  const boxes = listBoxes(bytes);
  const pairs = [];
  for (let i = 0; i < boxes.length; i += 1) {
    if (boxes[i].type !== "moof") continue;
    const next = boxes[i + 1];
    if (!next || next.type !== "mdat") return null; // 예상 밖 구조 — 손대지 않는다
    pairs.push({ moof: boxes[i], mdat: next });
  }
  return pairs.length ? pairs : null;
}

/**
 * 라이브 조각을 앞머리(ftyp+moov)와 본체(moof+mdat)로 가른다.
 *
 * 라이브는 조각마다 앞머리를 다시 붙여서 준다(중간부터 봐도 재생되도록).
 * 파일로 묶을 때는 앞머리가 하나만 있어야 하므로 첫 조각의 것만 쓰고 나머지는 버린다.
 */
export function splitLiveSegment(bytes) {
  const boxes = listBoxes(bytes);
  const firstMoof = boxes.find((box) => box.type === "moof");
  if (!firstMoof) return { init: null, media: bytes };

  const headParts = boxes
    .filter((box) => box.start < firstMoof.start && (box.type === "ftyp" || box.type === "moov"))
    .map((box) => boxBytes(bytes, box));

  return {
    init: headParts.length ? concat(headParts) : null,
    media: bytes.subarray(firstMoof.start),
  };
}
