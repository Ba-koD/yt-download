// 따로 받은 영상 트랙과 소리 트랙을 mp4 파일 하나로 묶는다.
//
// 유튜브가 주는 조각은 이미 조각 mp4(fragmented mp4)라서 다시 인코딩할 필요가 없다.
// 앞머리(ftyp+moov)만 트랙 두 개짜리로 새로 쓰고, 그 뒤에 두 트랙의 조각을
// 시간 순서대로 붙이면 그대로 재생되는 파일이 된다.
//
// 트랙 번호가 겹치는 것만 조심하면 된다. 유튜브는 두 트랙 모두 1번으로 주기 때문에,
// 소리 쪽을 2번으로 바꾸고 조각 안의 번호까지 같이 고쳐야 한다.

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

/** tkhd 가 들고 있는 트랙 번호. tkhd 는 version 에 따라 위치가 다르다. */
export function readTrackId(bytes, trakBox) {
  const tkhd = findPath(bytes, ["tkhd"], trakBox.start + HEADER, trakBox.end);
  if (!tkhd) throw new Error("tkhd 를 찾지 못했습니다");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[tkhd.start + HEADER];
  // version(1) + flags(3) + creation/modification(4 또는 8 씩) 다음이 track_ID.
  const offset = tkhd.start + HEADER + 4 + (version === 1 ? 16 : 8);
  return { value: view.getUint32(offset), offset };
}

function writeU32At(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

/** trak 안의 트랙 번호를 바꾼다(복사본을 돌려준다). */
export function withTrackId(bytes, trakBox, newId) {
  const copy = boxBytes(bytes, trakBox).slice();
  const { offset } = readTrackId(bytes, trakBox);
  writeU32At(copy, offset - trakBox.start, newId);
  return copy;
}

/** mvex 안의 trex(조각 기본값) 트랙 번호를 바꾼다. */
export function trexWithTrackId(bytes, moovBox, newId) {
  const mvex = findPath(bytes, ["mvex"], moovBox.start + HEADER, moovBox.end);
  if (!mvex) throw new Error("mvex 를 찾지 못했습니다");
  const trex = findPath(bytes, ["trex"], mvex.start + HEADER, mvex.end);
  if (!trex) throw new Error("trex 를 찾지 못했습니다");
  const copy = boxBytes(bytes, trex).slice();
  // trex: version+flags(4) 다음이 track_ID
  writeU32At(copy, HEADER + 4, newId);
  return copy;
}

/**
 * 조각(moof+mdat) 안의 트랙 번호를 바꾼다.
 *
 * moof/traf/tfhd 의 track_ID 만 고치면 된다. 크기가 변하지 않으므로 제자리에서 쓴다.
 */
export function retagFragments(bytes, newId) {
  const copy = bytes.slice();
  for (const box of listBoxes(copy)) {
    if (box.type !== "moof") continue;
    for (const traf of listBoxes(copy, box.start + HEADER, box.end)) {
      if (traf.type !== "traf") continue;
      const tfhd = listBoxes(copy, traf.start + HEADER, traf.end).find((b) => b.type === "tfhd");
      if (tfhd) writeU32At(copy, tfhd.start + HEADER + 4, newId);
    }
  }
  return copy;
}

function writeU64At(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(value));
}

function readU64At(bytes, offset) {
  return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset));
}

function readU32At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** 조각들이 들고 있는 첫 재생 시각(tfdt). 구간을 잘라내면 이 값이 0이 아니다. */
export function firstDecodeTime(bytes) {
  for (const moof of listBoxes(bytes)) {
    if (moof.type !== "moof") continue;
    for (const traf of listBoxes(bytes, moof.start + HEADER, moof.end)) {
      if (traf.type !== "traf") continue;
      const tfdt = listBoxes(bytes, traf.start + HEADER, traf.end).find((b) => b.type === "tfdt");
      if (!tfdt) continue;
      const version = bytes[tfdt.start + HEADER];
      const at = tfdt.start + HEADER + 4;
      return version === 1 ? readU64At(bytes, at) : readU32At(bytes, at);
    }
  }
  return 0;
}

/**
 * 모든 조각의 재생 시각을 앞으로 당긴다.
 *
 * 구간만 잘라낸 파일은 원본의 시각을 그대로 물고 있어서, 재생기가
 * "10분짜리인데 1분 지점부터 30초만 있는 파일"로 본다. 0에서 시작하도록 옮긴다.
 */
export function rebaseDecodeTimes(bytes, delta) {
  if (!delta) return bytes;
  const copy = bytes.slice();
  for (const moof of listBoxes(copy)) {
    if (moof.type !== "moof") continue;
    for (const traf of listBoxes(copy, moof.start + HEADER, moof.end)) {
      if (traf.type !== "traf") continue;
      const tfdt = listBoxes(copy, traf.start + HEADER, traf.end).find((b) => b.type === "tfdt");
      if (!tfdt) continue;
      const version = copy[tfdt.start + HEADER];
      const at = tfdt.start + HEADER + 4;
      if (version === 1) {
        writeU64At(copy, at, Math.max(0, readU64At(copy, at) - delta));
      } else {
        writeU32At(copy, at, Math.max(0, readU32At(copy, at) - delta));
      }
    }
  }
  return copy;
}

/** mvhd / tkhd / mdhd 에 적힌 길이를 실제로 담은 구간 길이로 바꾼다. */
export function patchDurations(init, seconds) {
  const copy = init.slice();
  const moov = findPath(copy, ["moov"]);
  if (!moov) return copy;

  const mvhd = findPath(copy, ["mvhd"], moov.start + HEADER, moov.end);
  if (mvhd) setHeaderDuration(copy, mvhd, seconds, true);

  for (const trak of listBoxes(copy, moov.start + HEADER, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = findPath(copy, ["tkhd"], trak.start + HEADER, trak.end);
    // tkhd 는 영화 전체 시간 단위(mvhd 의 timescale)를 쓴다.
    if (tkhd && mvhd) setTkhdDuration(copy, tkhd, seconds, movieTimescale(copy, mvhd));
    const mdhd = findPath(copy, ["mdia", "mdhd"], trak.start + HEADER, trak.end);
    if (mdhd) setHeaderDuration(copy, mdhd, seconds, true);
  }
  return copy;
}

function movieTimescale(bytes, mvhd) {
  const version = bytes[mvhd.start + HEADER];
  return readU32At(bytes, mvhd.start + HEADER + 4 + (version === 1 ? 16 : 8));
}

// mvhd 와 mdhd 는 구조가 같다: version/flags, 생성/수정 시각, timescale, duration.
function setHeaderDuration(bytes, box, seconds) {
  const version = bytes[box.start + HEADER];
  const base = box.start + HEADER + 4 + (version === 1 ? 16 : 8);
  const timescale = readU32At(bytes, base);
  const at = base + 4;
  const value = Math.round(seconds * timescale);
  if (version === 1) writeU64At(bytes, at, value);
  else writeU32At(bytes, at, value);
}

// tkhd: version/flags, 생성/수정 시각, track_ID, 예약(4), duration.
function setTkhdDuration(bytes, tkhd, seconds, timescale) {
  const version = bytes[tkhd.start + HEADER];
  const at = tkhd.start + HEADER + 4 + (version === 1 ? 16 : 8) + 4 + 4;
  const value = Math.round(seconds * timescale);
  if (version === 1) writeU64At(bytes, at, value);
  else writeU32At(bytes, at, value);
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

/** 박스 하나를 다른 박스 바로 뒤에 끼워 넣고 바깥 크기를 고친다. */
function insertBoxAfter(parentBytes, afterType, newBox) {
  const children = listBoxes(parentBytes, HEADER, parentBytes.length);
  const target = children.find((child) => child.type === afterType);
  if (!target) return parentBytes;

  const head = parentBytes.subarray(0, target.end);
  const tail = parentBytes.subarray(target.end);
  const out = concat([head, newBox, tail]);
  writeU32At(out, 0, out.length);
  return out;
}

/** 같은 종류의 박스가 이미 있으면 갈아 끼우고, 없으면 끼워 넣는다. */
function replaceOrInsert(parentBytes, type, afterType, newBox) {
  const existing = listBoxes(parentBytes, HEADER, parentBytes.length).find(
    (child) => child.type === type,
  );
  if (!existing) return insertBoxAfter(parentBytes, afterType, newBox);

  const out = concat([
    parentBytes.subarray(0, existing.start),
    newBox,
    parentBytes.subarray(existing.end),
  ]);
  writeU32At(out, 0, out.length);
  return out;
}

/** 이미 들어 있는 편집 목록의 media_time. 인코더 지연 보정 등이 담겨 있다. */
function existingMediaTime(trakBytes) {
  const edts = listBoxes(trakBytes, HEADER, trakBytes.length).find((box) => box.type === "edts");
  if (!edts) return 0;
  const elst = listBoxes(trakBytes, edts.start + HEADER, edts.end).find((box) => box.type === "elst");
  if (!elst) return 0;
  const version = trakBytes[elst.start + HEADER];
  const count = readU32At(trakBytes, elst.start + HEADER + 4);
  if (!count) return 0;
  const at = elst.start + HEADER + 8;
  // version 0: duration(4) + media_time(4), version 1: duration(8) + media_time(8)
  const mediaTime = version === 1 ? readU64At(trakBytes, at + 8) : readU32At(trakBytes, at + 4);
  // 음수(빈 구간 표시)는 그대로 두면 곤란하니 무시한다.
  return mediaTime > 0x7fffffff ? 0 : mediaTime;
}

/**
 * 잘라낸 구간을 정확히 가리키는 편집 목록(elst)을 트랙에 붙인다.
 *
 * 조각은 통째로만 받을 수 있어서 앞뒤로 몇 초씩 더 담기게 된다.
 * 편집 목록은 "이 파일에서 실제로 보여줄 곳은 여기부터 이만큼"이라고 알려주는 표라,
 * 다시 인코딩하지 않고도 요청한 구간만 재생되게 만든다.
 *
 * @param mediaTime  트랙 시간 단위로, 조각 시작에서 얼마나 건너뛸지
 * @param duration   영화 시간 단위로, 보여줄 길이
 */
export function withEditList(trakBytes, mediaTime, duration) {
  // 원래 있던 값(인코더 지연 보정)에 우리가 건너뛸 만큼을 더한다.
  const total = existingMediaTime(trakBytes) + Math.max(0, Math.round(mediaTime));

  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0); // version 0 + flags
  view.setUint32(4, 1); // entry_count
  view.setUint32(8, Math.max(0, Math.round(duration)));
  view.setInt32(12, total);
  view.setUint16(16, 1); // media_rate_integer = 1배속
  view.setUint16(18, 0);

  const edts = makeBox("edts", makeBox("elst", payload));
  return replaceOrInsert(trakBytes, "edts", "tkhd", edts);
}

/**
 * 두 앞머리를 트랙 두 개짜리 앞머리 하나로 합친다.
 *
 * @param edits  {video: {skip, seconds}, audio: {skip, seconds}} — 초 단위. 없으면 붙이지 않는다.
 * @returns {{init: Uint8Array, audioTrackId: number}}
 */
export function combineInit(videoInit, audioInit, edits) {
  const videoFtyp = findPath(videoInit, ["ftyp"]);
  const videoMoov = findPath(videoInit, ["moov"]);
  const audioMoov = findPath(audioInit, ["moov"]);
  if (!videoFtyp || !videoMoov || !audioMoov) throw new Error("ftyp/moov 를 찾지 못했습니다");

  const videoTrak = findPath(videoInit, ["trak"], videoMoov.start + HEADER, videoMoov.end);
  const audioTrak = findPath(audioInit, ["trak"], audioMoov.start + HEADER, audioMoov.end);
  if (!videoTrak || !audioTrak) throw new Error("trak 을 찾지 못했습니다");

  const videoId = readTrackId(videoInit, videoTrak).value;
  const audioId = readTrackId(audioInit, audioTrak).value;
  const audioTrackId = audioId === videoId ? videoId + 1 : audioId;

  const mvhd = findPath(videoInit, ["mvhd"], videoMoov.start + HEADER, videoMoov.end);
  if (!mvhd) throw new Error("mvhd 를 찾지 못했습니다");

  const videoMvex = findPath(videoInit, ["mvex"], videoMoov.start + HEADER, videoMoov.end);
  if (!videoMvex) throw new Error("mvex 를 찾지 못했습니다");
  const videoTrex = findPath(videoInit, ["trex"], videoMvex.start + HEADER, videoMvex.end);
  if (!videoTrex) throw new Error("trex 를 찾지 못했습니다");

  const mvex = makeBox(
    "mvex",
    boxBytes(videoInit, videoTrex),
    trexWithTrackId(audioInit, audioMoov, audioTrackId),
  );

  const movieScale = movieTimescale(videoInit, mvhd);
  let videoTrakBytes = boxBytes(videoInit, videoTrak).slice();
  let audioTrakBytes = withTrackId(audioInit, audioTrak, audioTrackId);
  if (edits) {
    videoTrakBytes = withEditList(
      videoTrakBytes,
      edits.video.skip * readMediaTimescale(videoInit, videoTrak),
      edits.video.seconds * movieScale,
    );
    audioTrakBytes = withEditList(
      audioTrakBytes,
      edits.audio.skip * readMediaTimescale(audioInit, audioTrak),
      edits.audio.seconds * movieScale,
    );
  }

  const moov = makeBox(
    "moov",
    boxBytes(videoInit, mvhd),
    videoTrakBytes,
    audioTrakBytes,
    mvex,
  );

  return { init: concat([boxBytes(videoInit, videoFtyp), moov]), audioTrackId };
}

/**
 * 조각 앞부분의 샘플을 실제로 잘라낸다.
 *
 * 영상과 소리는 조각 길이가 달라서(영상 5초, 소리 10초 같은 식) 구간을 잡으면
 * 두 트랙의 시작 시각이 서로 어긋난다. 편집 목록으로 가리려 해도 그걸 무시하는
 * 재생기에서는 소리가 몇 초씩 앞서 나온다. 그래서 소리 쪽 앞 샘플을 아예 버려
 * 두 트랙이 같은 지점에서 시작하게 만든다.
 *
 * 소리(AAC)는 샘플마다 독립이라 아무 데서나 잘라도 되지만, 영상은 키프레임에서만
 * 자를 수 있어서 이 함수는 소리에만 쓴다.
 *
 * @param seconds  버릴 길이(초). 0 이하면 그대로 돌려준다.
 * @returns 잘라낸 조각. 통째로 버려야 하면 `null`.
 */
export function dropLeadingSamples(fragment, seconds, timescale) {
  if (!(seconds > 0)) return fragment;
  const pairs = fragmentPairs(fragment);
  if (!pairs) return fragment;

  // 라이브에서 온 조각은 moof+mdat 짝이 여러 개다(원래 방송 조각들을 이어붙인 것).
  // 짝을 순서대로 걸어가며 통째로 버리다가, 경계에 걸친 짝만 안에서 자른다.
  let dropLeft = seconds * timescale;
  const parts = [];
  let started = false;
  for (const pair of pairs) {
    const whole = fragment.subarray(pair.moof.start, pair.mdat.end);
    if (started) {
      parts.push(whole);
      continue;
    }
    const info = pairSamples(fragment, pair.moof);
    if (!info) {
      // 못 읽는 짝은 자르지 않고 그대로 둔다(모자라게 버리는 쪽이 안전하다).
      parts.push(whole);
      started = true;
      continue;
    }
    const total = info.sizes.length * info.sampleDuration;
    if (dropLeft >= total) {
      dropLeft -= total; // 짝을 통째로 버린다
      continue;
    }
    started = true;
    const drop = Math.floor(dropLeft / info.sampleDuration);
    if (drop <= 0) parts.push(whole);
    else parts.push(slicePair(fragment, pair, info, drop, info.sizes.length));
  }
  if (!parts.length) return null;
  return concat(parts);
}

/**
 * 조각 뒷부분의 샘플을 실제로 잘라낸다.
 *
 * 소리 조각이 영상 트랙보다 뒤까지 이어지면 영상이 멈춘 채 소리만 계속 나온다
 * (조각이 긴 라이브에서 두드러진다 — 실측 9초). 그래서 영상이 끝나는 지점 뒤의
 * 소리 샘플을 아예 버려 두 트랙이 같은 지점에서 끝나게 만든다.
 *
 * @param seconds  남길 길이(초, 조각의 시작 샘플부터). 조각이 그보다 짧으면 그대로 둔다.
 *                 유한한 수가 아니면 자르지 않는다.
 * @returns 잘라낸 조각. 남길 것이 없으면 `null`.
 */
export function dropTrailingSamples(fragment, seconds, timescale) {
  if (!Number.isFinite(seconds)) return fragment;
  if (!(seconds > 0)) return null;
  const pairs = fragmentPairs(fragment);
  if (!pairs) return fragment;

  // 짝을 순서대로 담다가, 남길 길이를 넘어서는 짝에서 자르고 그 뒤는 통째로 버린다.
  // 딱 떨어지지 않으면 한 샘플(수십 ms)을 더 남기는 쪽으로 둔다. 모자라면 소리가 먼저 끊긴다.
  let keepLeft = seconds * timescale;
  const parts = [];
  let ended = false;
  for (const pair of pairs) {
    if (ended) break;
    const whole = fragment.subarray(pair.moof.start, pair.mdat.end);
    const info = pairSamples(fragment, pair.moof);
    if (!info) {
      // 못 읽는 짝은 자르지 않고 그대로 둔다(길이도 모르니 세지 않는다).
      parts.push(whole);
      continue;
    }
    const total = info.sizes.length * info.sampleDuration;
    if (total <= keepLeft) {
      parts.push(whole);
      keepLeft -= total;
      continue;
    }
    ended = true;
    const keep = Math.ceil(keepLeft / info.sampleDuration);
    if (keep >= info.sizes.length) parts.push(whole);
    else if (keep > 0) parts.push(slicePair(fragment, pair, info, 0, keep));
  }
  if (!ended) return fragment; // 전부 남길 길이 안에 든다 — 손대지 않는다
  if (!parts.length) return null;
  return concat(parts);
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

/** 짝 하나의 샘플 정보. 다루지 못하는 형태면 null. */
function pairSamples(bytes, moof) {
  const traf = listBoxes(bytes, moof.start + HEADER, moof.end).find((b) => b.type === "traf");
  if (!traf) return null;
  const children = listBoxes(bytes, traf.start + HEADER, traf.end);
  const tfhd = children.find((b) => b.type === "tfhd");
  const trun = children.find((b) => b.type === "trun");
  if (!tfhd || !trun) return null;
  const sampleDuration = defaultSampleDuration(bytes, tfhd);
  if (!sampleDuration) return null;
  const sizes = readTrunSizes(bytes, trun);
  if (!sizes) return null;
  return { traf, trun, sampleDuration, sizes };
}

/**
 * 짝 하나에서 샘플 [from, to) 만 남긴 바이트를 만든다.
 *
 * trun 을 남은 샘플만으로 다시 쓰고(크기 목록만 줄이면 된다), data_offset 을 다시 재고,
 * mdat 은 남은 샘플 바이트만 담는다. 앞을 잘랐으면 시작 시각(tfdt)을 그만큼 뒤로 민다.
 */
function slicePair(bytes, pair, info, from, to) {
  const keptSizes = info.sizes.slice(from, to);
  const leadBytes = info.sizes.slice(0, from).reduce((sum, size) => sum + size, 0);
  const keptBytes = keptSizes.reduce((sum, size) => sum + size, 0);

  const newTrun = concat([
    boxBytes(bytes, info.trun).subarray(0, HEADER + 4), // size+type+version/flags
    u32be(keptSizes.length),
    new Uint8Array(4), // data_offset 자리. 아래에서 다시 계산한다.
    ...keptSizes.map(u32be),
  ]);
  writeU32At(newTrun, 0, newTrun.length);

  const newTraf = rebuildBox(bytes, info.traf, (child) =>
    child.type === "trun" ? newTrun : boxBytes(bytes, child),
  );
  const newMoof = rebuildBox(bytes, pair.moof, (child) =>
    child.type === "traf" ? newTraf : boxBytes(bytes, child),
  );

  // 샘플 데이터는 moof 바로 뒤(mdat 안)에서 시작한다.
  const dataOffset = newMoof.length + HEADER;
  const trunInNew = listBoxes(newMoof, HEADER, newMoof.length)
    .filter((b) => b.type === "traf")
    .flatMap((t) => listBoxes(newMoof, t.start + HEADER, t.end))
    .find((b) => b.type === "trun");
  writeU32At(newMoof, trunInNew.start + HEADER + 8, dataOffset);

  const newMdat = concat([
    u32be(HEADER + keptBytes),
    ascii("mdat"),
    bytes.subarray(
      pair.mdat.start + HEADER + leadBytes,
      pair.mdat.start + HEADER + leadBytes + keptBytes,
    ),
  ]);

  const result = concat([newMoof, newMdat]);
  if (from > 0) shiftDecodeTime(result, from * info.sampleDuration);
  return result;
}

function u32be(value) {
  return u32(value);
}

/** 상자의 자식들을 하나씩 바꿔 새로 만든다. */
function rebuildBox(bytes, box, mapChild) {
  const head = bytes.subarray(box.start, box.start + HEADER);
  const children = listBoxes(bytes, box.start + HEADER, box.end).map(mapChild);
  const out = concat([head, ...children]);
  writeU32At(out, 0, out.length);
  return out;
}

/** tfhd 의 default_sample_duration. 소리 조각은 이 값 하나로 모든 샘플 길이를 정한다. */
function defaultSampleDuration(bytes, tfhd) {
  const flags = readU32At(bytes, tfhd.start + HEADER) & 0xffffff;
  let offset = tfhd.start + HEADER + 4 + 4; // version/flags + track_ID
  if (flags & 0x000001) offset += 8; // base_data_offset
  if (flags & 0x000002) offset += 4; // sample_description_index
  if (!(flags & 0x000008)) return 0; // default_sample_duration 없음
  return readU32At(bytes, offset);
}

/** trun 의 샘플 크기 목록. 크기 항목이 없으면 손대지 않는다. */
function readTrunSizes(bytes, trun) {
  const flags = readU32At(bytes, trun.start + HEADER) & 0xffffff;
  if (!(flags & 0x000200)) return null; // sample-size 없음
  // 이 함수는 "크기만 있는" 단순한 형태만 다룬다(유튜브 소리 조각이 그렇다).
  if (flags & (0x000100 | 0x000400 | 0x000800)) return null;

  const count = readU32At(bytes, trun.start + HEADER + 4);
  let offset = trun.start + HEADER + 8;
  if (flags & 0x000001) offset += 4; // data_offset
  if (flags & 0x000004) offset += 4; // first_sample_flags

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    sizes.push(readU32At(bytes, offset));
    offset += 4;
  }
  return sizes;
}

/** 조각의 시작 시각을 뒤로 민다(앞을 잘라냈으면 그만큼 늦게 시작한다). */
function shiftDecodeTime(bytes, delta) {
  for (const moof of listBoxes(bytes)) {
    if (moof.type !== "moof") continue;
    for (const traf of listBoxes(bytes, moof.start + HEADER, moof.end)) {
      if (traf.type !== "traf") continue;
      const tfdt = listBoxes(bytes, traf.start + HEADER, traf.end).find((b) => b.type === "tfdt");
      if (!tfdt) continue;
      const version = bytes[tfdt.start + HEADER];
      const at = tfdt.start + HEADER + 4;
      if (version === 1) writeU64At(bytes, at, readU64At(bytes, at) + delta);
      else writeU32At(bytes, at, readU32At(bytes, at) + delta);
    }
  }
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
