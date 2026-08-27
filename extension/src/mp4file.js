// 받아온 조각들을 "일반 mp4"(샘플 표가 있는 보통 파일) 하나로 짓는다.
//
// 왜 조각 그대로가 아니라 일반 mp4 인가:
//
// 영상은 키프레임에서만 시작할 수 있어서, 고른 지점보다 앞선 조각 경계에서 파일이
// 시작한다. 그 앞부분을 잘라내면 남은 프레임들이 참조할 그림이 사라져 화면이 안 나온다
// (실측: 13.000초부터 자르면 15.650초까지 160프레임이 아예 안 그려졌다).
//
// mp4 에는 이걸 위한 장치가 있다 — 편집 목록(elst). "파일은 여기서 시작하지만 보여줄
// 곳은 여기부터 이만큼"이라고 적어두면, 앞부분은 디코딩에만 쓰이고 화면에는 안 나온다.
// 바이트를 한 비트도 건드리지 않고 정확한 구간이 된다.
//
// 그런데 편집 목록은 **조각화 mp4(fMP4)에서는 거의 지원되지 않는다**. ffmpeg 도 크롬도
// 무시한다(실측). 일반 mp4 에서는 제대로 동작한다 — QuickTime 시절부터 쓰던 길이다.
// 그래서 조각을 그대로 이어 붙이는 대신, 샘플 표(stbl)를 만들어 일반 mp4 로 담는다.
// 샘플 바이트는 원본 그대로 옮겨 담을 뿐이라 다시 인코딩하는 곳은 한 군데도 없다.

import { boxBytes, concat, findPath, listBoxes, makeBox } from "./mp4mux.js";

const HEADER = 8;

const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** 표 하나를 만든다: version/flags(0) + 항목 수 + 항목들. mp4 의 표는 죄다 이 모양이다. */
function table(type, entries, width, fill) {
  const body = new Uint8Array(8 + entries.length * width);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0);
  dv.setUint32(4, entries.length);
  entries.forEach((entry, i) => fill(dv, 8 + i * width, entry));
  return makeBox(type, body);
}

/** 같은 값이 이어지면 하나로 묶는다. stts·ctts·stsc 가 모두 이 방식이다. */
function runLength(values) {
  const out = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last.value === value) last.count += 1;
    else out.push({ count: 1, value });
  }
  return out;
}

/**
 * 샘플들을 담을 표들을 만든다.
 *
 * @param samples [{size, duration, cto, sync}] — 트랙 전체, 디코딩 순서
 * @param chunks  덩어리별 샘플 수. 덩어리 하나가 stco 의 자리 하나다.
 */
export function sampleTableBoxes(samples, chunks, largeOffsets) {
  const boxes = [];

  // stts — 샘플 길이. 대개 전부 같아서 항목 하나로 줄어든다.
  boxes.push(
    table("stts", runLength(samples.map((s) => s.duration)), 8, (dv, at, e) => {
      dv.setUint32(at, e.count);
      dv.setUint32(at + 4, e.value);
    }),
  );

  // ctts — 화면 순서 보정. B프레임이 없으면(AV1 등) 전부 0이라 아예 넣지 않는다.
  if (samples.some((s) => s.cto !== 0)) {
    const negative = samples.some((s) => s.cto < 0);
    const runs = runLength(samples.map((s) => s.cto));
    const body = new Uint8Array(8 + runs.length * 8);
    const dv = new DataView(body.buffer);
    dv.setUint8(0, negative ? 1 : 0); // 음수 보정은 version 1 에서만 쓸 수 있다
    dv.setUint32(4, runs.length);
    runs.forEach((run, i) => {
      dv.setUint32(8 + i * 8, run.count);
      if (negative) dv.setInt32(12 + i * 8, run.value);
      else dv.setUint32(12 + i * 8, run.value);
    });
    boxes.push(makeBox("ctts", body));
  }

  // stss — 키프레임 자리(1부터 센다). 소리처럼 전부 키프레임이면 넣지 않는다
  // (없는 것이 곧 "전부 키프레임"이라는 뜻이다).
  const syncs = [];
  samples.forEach((s, i) => {
    if (s.sync) syncs.push(i + 1);
  });
  if (syncs.length !== samples.length) {
    boxes.push(table("stss", syncs, 4, (dv, at, n) => dv.setUint32(at, n)));
  }

  // stsc — 덩어리마다 샘플이 몇 개인지.
  const perChunk = runLength(chunks);
  let chunkNo = 1;
  const stsc = perChunk.map((run) => {
    const entry = { first: chunkNo, count: run.value };
    chunkNo += run.count;
    return entry;
  });
  boxes.push(
    table("stsc", stsc, 12, (dv, at, e) => {
      dv.setUint32(at, e.first);
      dv.setUint32(at + 4, e.count);
      dv.setUint32(at + 8, 1); // sample_description_index
    }),
  );

  // stsz — 샘플 크기. 전부 같으면 값 하나로 끝난다.
  const uniform = samples.every((s) => s.size === samples[0].size);
  const stszBody = new Uint8Array(12 + (uniform ? 0 : samples.length * 4));
  const sdv = new DataView(stszBody.buffer);
  sdv.setUint32(0, 0);
  sdv.setUint32(4, uniform ? samples[0].size : 0);
  sdv.setUint32(8, samples.length);
  if (!uniform) samples.forEach((s, i) => sdv.setUint32(12 + i * 4, s.size));
  boxes.push(makeBox("stsz", stszBody));

  // stco/co64 — 덩어리가 파일 어디에 있는지. 자리는 비워 두고 나중에 채운다
  // (머리 크기를 알아야 mdat 이 어디서 시작하는지 알 수 있다).
  const width = largeOffsets ? 8 : 4;
  const body = new Uint8Array(8 + chunks.length * width);
  new DataView(body.buffer).setUint32(4, chunks.length);
  boxes.push(makeBox(largeOffsets ? "co64" : "stco", body));

  return boxes;
}

/**
 * 앞머리가 이미 적어둔 "내용은 여기서 시작한다" 값(미디어 시간 단위).
 *
 * 코덱은 앞머리에 버릴 것을 얹어 보낸다 — AAC 는 인코더가 워밍업으로 만든 샘플
 * 1024개(48kHz 에서 21.33ms), H.264 는 B프레임 재정렬 때문에 생기는 어긋남이다.
 * 이 값을 무시하면 그만큼 소리가 늦게 나온다(실측 21.33ms).
 *
 * 빈 구간을 뜻하는 음수는 0으로 본다.
 */
export function editStartOf(init) {
  const moov = findPath(init, ["moov"]);
  if (!moov) return 0;
  const trak = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  if (!trak) return 0;
  const edts = listBoxes(init, trak.start + HEADER, trak.end).find((b) => b.type === "edts");
  if (!edts) return 0;
  const elst = listBoxes(init, edts.start + HEADER, edts.end).find((b) => b.type === "elst");
  if (!elst || !view(init).getUint32(elst.start + HEADER + 4)) return 0;
  const wide = init[elst.start + HEADER] === 1;
  const at = elst.start + HEADER + 8;
  const mediaTime = wide
    ? Number(view(init).getBigInt64(at + 8))
    : view(init).getInt32(at + 4);
  return mediaTime > 0 ? mediaTime : 0;
}

/** 박스 하나를 자식들만 바꿔 다시 만든다. 크기는 다시 잰다. */
function rebuild(bytes, box, mapChild) {
  const head = bytes.subarray(box.start, box.start + HEADER);
  const children = listBoxes(bytes, box.start + HEADER, box.end).map(mapChild).filter(Boolean);
  const out = concat([head, ...children]);
  view(out).setUint32(0, out.length);
  return out;
}

/** mvhd·mdhd 는 구조가 같다: version/flags, 시각 둘, timescale, duration. */
function setScaleDuration(bytes, box, seconds) {
  const version = bytes[box.start + HEADER];
  const base = box.start + HEADER + 4 + (version === 1 ? 16 : 8);
  const timescale = view(bytes).getUint32(base);
  const value = Math.round(seconds * timescale);
  if (version === 1) view(bytes).setBigUint64(base + 4, BigInt(value));
  else view(bytes).setUint32(base + 4, value);
}

/** tkhd: version/flags, 시각 둘, track_ID, 예약(4), duration. 길이는 영화 시간 단위다. */
function setTrackHeader(bytes, tkhd, trackId, seconds, movieTimescale) {
  const version = bytes[tkhd.start + HEADER];
  const idAt = tkhd.start + HEADER + 4 + (version === 1 ? 16 : 8);
  view(bytes).setUint32(idAt, trackId);
  const durAt = idAt + 4 + 4;
  const value = Math.round(seconds * movieTimescale);
  if (version === 1) view(bytes).setBigUint64(durAt, BigInt(value));
  else view(bytes).setUint32(durAt, value);
}

/**
 * 편집 목록. "미디어 시간축의 여기부터 이만큼을 보여줘라".
 *
 * @param mediaTime  트랙의 미디어 시간 단위. 앞머리에서 얼마나 건너뛸지.
 * @param seconds    보여줄 길이(초).
 */
function editList(mediaTime, seconds, movieTimescale) {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0); // version 0 + flags
  dv.setUint32(4, 1); // 항목 하나
  dv.setUint32(8, Math.max(0, Math.round(seconds * movieTimescale)));
  dv.setInt32(12, Math.max(0, Math.round(mediaTime)));
  dv.setUint16(16, 1); // 1배속
  dv.setUint16(18, 0);
  return makeBox("edts", makeBox("elst", body));
}

/**
 * 트랙 하나의 `trak` 을 짓는다. 원본 앞머리의 trak 을 본으로 삼아,
 * 표가 비어 있던 `stbl` 만 진짜 표로 갈아 끼우고 편집 목록을 붙인다.
 *
 * `stsd`(코덱 설명)는 원본 것을 그대로 옮긴다 — 그래야 avc1 이든 av01 이든
 * 코덱을 가리지 않는다. 우리가 손대는 것은 "어느 바이트가 몇 번째 샘플인가" 뿐이다.
 */
function buildTrak(track, movieTimescale) {
  const { init, trackId, samples, chunks, editMediaTime, presentSeconds, largeOffsets } = track;
  const moov = findPath(init, ["moov"]);
  const source = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  if (!source) throw new Error("앞머리에서 trak 을 찾지 못했습니다");

  const mediaSeconds = samples.reduce((sum, s) => sum + s.duration, 0) / track.timescale;
  const tables = sampleTableBoxes(samples, chunks, largeOffsets);

  const bytes = rebuild(init, source, (child) => {
    if (child.type === "edts") return null; // 우리가 새로 붙인다
    if (child.type !== "mdia") return boxBytes(init, child);
    return rebuild(init, child, (inner) => {
      if (inner.type !== "minf") return boxBytes(init, inner);
      return rebuild(init, inner, (leaf) => {
        if (leaf.type !== "stbl") return boxBytes(init, leaf);
        // stsd 만 남기고 나머지 표는 우리가 만든 것으로 바꾼다.
        const stsd = listBoxes(init, leaf.start + HEADER, leaf.end).find((b) => b.type === "stsd");
        if (!stsd) throw new Error("stsd 를 찾지 못했습니다");
        const out = concat([
          init.subarray(leaf.start, leaf.start + HEADER),
          boxBytes(init, stsd),
          ...tables,
        ]);
        view(out).setUint32(0, out.length);
        return out;
      });
    });
  });

  // tkhd/mdhd 의 길이와 번호를 실제 내용에 맞춘다. 그 다음 편집 목록을 tkhd 뒤에 끼운다.
  const tkhd = findPath(bytes, ["tkhd"], HEADER, bytes.length);
  if (tkhd) setTrackHeader(bytes, tkhd, trackId, mediaSeconds, movieTimescale);
  const mdhd = findPath(bytes, ["mdia", "mdhd"], HEADER, bytes.length);
  if (mdhd) setScaleDuration(bytes, mdhd, mediaSeconds);

  const edts = editList(editMediaTime, presentSeconds, movieTimescale);
  const head = bytes.subarray(0, tkhd ? tkhd.end : HEADER);
  const rest = bytes.subarray(tkhd ? tkhd.end : HEADER);
  const out = concat([head, edts, rest]);
  view(out).setUint32(0, out.length);
  return out;
}

/**
 * 파일의 머리(ftyp + moov)를 짓는다. 이 뒤에 mdat 이 이어진다.
 *
 * @param tracks 트랙마다:
 *   init            원본 앞머리(ftyp+moov)
 *   timescale       미디어 시간 단위
 *   samples         디코딩 순서의 전체 샘플 [{size, duration, cto, sync}]
 *   chunks          덩어리별 샘플 수(stco 자리 수와 같다)
 *   editMediaTime   앞머리에서 건너뛸 만큼(미디어 시간 단위)
 * @param presentSeconds 실제로 보여줄 길이(초) — 편집 목록에 적힌다.
 */
export function buildHead({ tracks, presentSeconds, largeOffsets = false }) {
  const first = tracks[0];
  const ftyp = findPath(first.init, ["ftyp"]);
  const moov = findPath(first.init, ["moov"]);
  if (!ftyp || !moov) throw new Error("ftyp/moov 를 찾지 못했습니다");
  const mvhd = findPath(first.init, ["mvhd"], moov.start + HEADER, moov.end);
  if (!mvhd) throw new Error("mvhd 를 찾지 못했습니다");
  const movieTimescale = view(first.init).getUint32(
    mvhd.start + HEADER + 4 + (first.init[mvhd.start + HEADER] === 1 ? 16 : 8),
  );

  const mvhdBytes = boxBytes(first.init, mvhd).slice();
  setScaleDuration(mvhdBytes, { start: 0, end: mvhdBytes.length }, presentSeconds);
  // next_track_ID 는 mvhd 의 맨 끝 4바이트다. 우리가 쓴 번호보다 커야 한다.
  view(mvhdBytes).setUint32(mvhdBytes.length - 4, tracks.length + 1);

  const traks = tracks.map((track, index) =>
    buildTrak({ ...track, trackId: index + 1, largeOffsets }, movieTimescale),
  );
  const moovBytes = makeBox("moov", mvhdBytes, ...traks);
  return { head: concat([boxBytes(first.init, ftyp), moovBytes]), movieTimescale };
}

/**
 * 덩어리들이 파일 어디에 앉는지를 표에 적어 넣는다.
 *
 * 머리를 다 짓고 나서야 mdat 이 어디서 시작하는지 알 수 있어서, 표에는 자리만 비워
 * 두었다가 여기서 채운다. 항목 폭이 고정이라 채워 넣어도 머리 크기는 그대로다.
 *
 * @param offsets 트랙 순서대로, 그 트랙의 덩어리 위치 목록
 */
export function fillChunkOffsets(head, offsets) {
  const found = [];
  const walk = (from, to) => {
    for (const box of listBoxes(head, from, to)) {
      if (box.type === "stco" || box.type === "co64") found.push(box);
      else if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type)) {
        walk(box.start + HEADER, box.end);
      }
    }
  };
  walk(0, head.length);
  if (found.length !== offsets.length) {
    throw new Error(`덩어리 표 수가 맞지 않습니다 (${found.length} ≠ ${offsets.length})`);
  }
  found.forEach((box, index) => {
    const wide = box.type === "co64";
    const list = offsets[index];
    const dv = view(head);
    list.forEach((value, i) => {
      const at = box.start + HEADER + 8 + i * (wide ? 8 : 4);
      if (wide) dv.setBigUint64(at, BigInt(value));
      else dv.setUint32(at, value);
    });
  });
  return head;
}

/** mdat 상자의 머리. 4GB 를 넘으면 64비트 크기 형식을 쓴다. */
export function mdatHeader(size) {
  if (size + HEADER <= 0xfffffffe) {
    return concat([u32(size + HEADER), new Uint8Array([0x6d, 0x64, 0x61, 0x74])]);
  }
  const out = new Uint8Array(16);
  view(out).setUint32(0, 1); // 크기 1 = "진짜 크기는 뒤에 64비트로"
  out.set([0x6d, 0x64, 0x61, 0x74], 4);
  view(out).setBigUint64(8, BigInt(size + 16));
  return out;
}
