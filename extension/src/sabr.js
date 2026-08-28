// SABR — 주소 대신 "요청을 보내면 조각을 내어주는" 길.
//
// 공식 뮤직비디오는 웹 계열 클라이언트가 포맷마다 주소를 주지 않고
// `serverAbrStreamingUrl` 하나만 준다. 그 주소에 protobuf 요청을 POST 하면
// UMP 라는 형식으로 조각이 돌아온다. 이 파일이 그 요청을 만들고 답을 푼다.
//
// 왜 이게 필요한가 — 주소를 주는 `ANDROID_VR`·`IOS` 로는 앞 60초까지밖에 못 받는다
// (안드로이드·iOS 토큰을 브라우저에서 만들 수 없어서다). SABR 은 그 벽이 없다.
// 실측: 213초 뮤직비디오에서 90·150·200초 조각을 모두 받았다.

import { request } from "./net.js";

/* ── protobuf 쓰기 ─────────────────────────────────────────────── */

function varint(value) {
  const out = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

const tag = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
/** 숫자 필드 */
const num = (field, value) => [...tag(field, 0), ...varint(value)];
/** 길이가 붙는 필드(바이트·문자열·중첩) */
const buf = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const utf8 = (text) => [...new TextEncoder().encode(text)];

/* ── protobuf 읽기 (필요한 필드만 훑는다) ──────────────────────── */

/**
 * 최상위 필드를 훑어 `{필드번호: 값}` 으로 만든다.
 * 숫자는 Number, 길이 필드는 Uint8Array 로 준다. 같은 번호가 여럿이면 마지막 것을 쓴다
 * (우리가 읽는 곳은 전부 하나씩만 온다).
 */
function readFields(bytes) {
  const out = {};
  let p = 0;
  const readVarint = () => {
    let x = 0n;
    let shift = 0n;
    while (p < bytes.length) {
      const b = bytes[p++];
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return x;
  };
  while (p < bytes.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (!field) break;
    if (wire === 0) out[field] = Number(readVarint());
    else if (wire === 2) {
      const len = Number(readVarint());
      out[field] = bytes.subarray(p, p + len);
      p += len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else break;
  }
  return out;
}

/* ── UMP 읽기 ──────────────────────────────────────────────────── */

/**
 * UMP 의 길이 앞머리는 **유튜브 고유 varint** 다. 첫 바이트로 몇 바이트짜리인지 가른다.
 * 흔한 little-endian varint 로 읽으면 엉뚱한 데서 어긋난다.
 */
function umpVarint(data, at) {
  const first = data[at];
  const size = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
  let value;
  if (size === 1) value = first;
  else if (size === 2) value = (first & 0x3f) | (data[at + 1] << 6);
  else if (size === 3) value = (first & 0x1f) | (data[at + 1] << 5) | (data[at + 2] << 13);
  else if (size === 4)
    value = (first & 0x0f) | (data[at + 1] << 4) | (data[at + 2] << 12) | (data[at + 3] << 20);
  else value = data[at + 1] | (data[at + 2] << 8) | (data[at + 3] << 16) | (data[at + 4] << 24);
  return { value: value >>> 0, size };
}

/** 답을 부위별로 가른다. `{type, at, size}` 목록. */
export function readUmp(data) {
  const parts = [];
  let p = 0;
  while (p < data.length) {
    const type = umpVarint(data, p);
    p += type.size;
    if (p >= data.length) break;
    const size = umpVarint(data, p);
    p += size.size;
    if (size.value > data.length - p) break; // 잘려 왔다
    parts.push({ type: type.value, at: p, size: size.value });
    p += size.value;
  }
  return parts;
}

/** UMP 부위 번호. 이름을 붙여두지 않으면 나중에 무슨 뜻인지 알 수 없다. */
const PART = {
  MEDIA_HEADER: 20,
  MEDIA: 21,
  MEDIA_END: 22,
  STATUS: 35,
  CONTEXT_UPDATE: 57,
};

/* ── 요청 만들기 ───────────────────────────────────────────────── */

const formatId = (format) => [...num(1, format.itag), ...num(2, format.lastModified || 0)];

const clientInfo = (clientVersion) => [
  ...buf(1, utf8("en_US")),
  ...num(16, 1), // WEB
  ...buf(17, utf8(clientVersion)),
  ...buf(18, utf8("Windows")),
  ...buf(19, utf8("10.0")),
];

/**
 * 재생기 상태. 서버는 이걸 보고 "지금 어디를 보고 있으니 이 조각들을 주자"고 정한다.
 * **f28(재생 위치 ms)이 핵심**이고 나머지는 그럴듯하면 된다(실측으로 확인).
 */
const abrState = (playerTimeMs) => [
  ...num(28, Math.max(0, Math.round(playerTimeMs))),
  ...num(29, 1),
  ...num(34, 3),
  ...num(57, 222),
  ...num(59, 8192),
  ...num(71, 1),
  ...num(80, 4),
  ...num(85, 1),
];

/**
 * 한 번 물어볼 요청을 만든다.
 *
 * **선호 포맷(16·17)을 안 주면 서버가 멋대로 고른다.** 우리가 고른 화질이 아닌 것을
 * 받아오게 되므로 반드시 넣는다.
 *
 * **고른 포맷(2)은 일부러 안 보낸다.** 그 자리는 "이 포맷들은 이미 받아뒀다"는 뜻이라,
 * 넣으면 서버가 앞머리(ftyp+moov)를 생략한다. 조각은 `moof`+`mdat` 뿐이라 앞머리가 없으면
 * 파일을 만들 수 없다. 빼두면 어느 재생 위치에서 물어도 앞머리를 함께 준다(실측).
 */
export function buildRequest({ playerTimeMs, video, audio, config, poToken, contexts, clientVersion }) {
  const out = [...buf(1, abrState(playerTimeMs))];
  out.push(...buf(5, [...config]));
  if (audio) out.push(...buf(16, formatId(audio)));
  if (video) out.push(...buf(17, formatId(video)));

  const context = [...buf(1, clientInfo(clientVersion))];
  if (poToken) context.push(...buf(2, [...poToken]));
  // 서버가 준 컨텍스트는 그대로 되돌려준다. 웹 클라이언트로 물을 때는 이게 없으면
  // 계속 실패한다(TVHTML5_SIMPLY 는 없어도 바로 준다 — 실측).
  for (const value of contexts || []) context.push(...buf(5, value));
  out.push(...buf(19, context));
  return new Uint8Array(out);
}

/**
 * base64url 을 바이트로. PO 토큰과 ustreamer 설정이 둘 다 이 꼴로 온다.
 * 요청에는 바이트로 넣어야 한다.
 */
export function decodeBase64Url(text) {
  if (!text) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* ── 한 번 주고받기 ────────────────────────────────────────────── */

/** 무작위 16자. 유튜브가 재생 한 번을 가리키는 값(cpn)이다. */
function playbackNonce() {
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => ABC[b & 63]).join("");
}

/**
 * SABR 한 판. 주소·설정·토큰을 쥐고 있다가 `pull(재생위치)` 로 조각을 받아온다.
 */
export function openSession({ url, config, poToken, clientVersion = "2.20260826.01.00" }) {
  const cpn = playbackNonce();
  const contexts = [];
  let requestNumber = 0;

  const target = (() => {
    const u = new URL(url);
    u.searchParams.set("cpn", cpn);
    u.searchParams.set("cver", clientVersion);
    return u;
  })();

  return {
    async pull({ playerTimeMs, video, audio }) {
      target.searchParams.set("rn", String(requestNumber++));
      const body = buildRequest({
        playerTimeMs,
        video,
        audio,
        config,
        poToken,
        contexts,
        clientVersion,
      });
      const answer = await request.post(target.toString(), body);
      return readAnswer(answer, contexts);
    },
  };
}

/**
 * 답을 풀어 조각으로 만든다.
 *
 * 미디어 한 조각이 여러 부위에 나뉘어 오므로(32KB 씩), **머리말 번호로 이어 붙인다.**
 * 첫 바이트가 머리말 번호이고 나머지가 내용이다.
 */
function readAnswer(data, contexts) {
  const parts = readUmp(data);
  const byHeader = new Map();
  const errors = [];

  for (const part of parts) {
    const bytes = data.subarray(part.at, part.at + part.size);
    if (part.type === PART.MEDIA_HEADER) {
      const f = readFields(bytes);
      byHeader.set(f[1] || 0, {
        itag: f[3],
        startMs: f[11] || 0,
        durationMs: f[12] || 0,
        byteAt: f[6] || 0,
        expected: f[14] || 0,
        // 조각 번호가 없으면 앞머리(init)다.
        sequence: f[9] ?? null,
        chunks: [],
        got: 0,
      });
    } else if (part.type === PART.MEDIA) {
      const entry = byHeader.get(bytes[0]);
      if (!entry) continue;
      const chunk = bytes.subarray(1);
      entry.chunks.push(chunk);
      entry.got += chunk.length;
    } else if (part.type === PART.STATUS) {
      const f = readFields(bytes);
      if (f[4]) errors.push(f[4]);
    } else if (part.type === PART.CONTEXT_UPDATE) {
      // 서버가 "이 값을 다음부터 같이 보내라"고 알려준다.
      const f = readFields(bytes);
      if (f[3]) contexts.push(new Uint8Array([...num(1, f[1] || 0), ...buf(2, [...f[3]])]));
    }
  }

  const segments = [];
  for (const entry of byHeader.values()) {
    if (!entry.got) continue;
    const bytes = new Uint8Array(entry.got);
    let at = 0;
    for (const chunk of entry.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    segments.push({
      itag: entry.itag,
      sequence: entry.sequence,
      time: entry.startMs / 1000,
      duration: entry.durationMs / 1000,
      init: entry.sequence === null,
      bytes,
    });
  }
  return { segments, errors };
}

/* ── 구간 받기 ─────────────────────────────────────────────────── */

/**
 * 고른 구간을 덮을 때까지 재생 위치를 밀어가며 조각을 모은다.
 *
 * 서버가 한 번에 얼마를 줄지는 서버가 정한다. 그래서 "받은 조각 중 가장 뒤쪽 끝"을
 * 다음 재생 위치로 삼아 되풀이한다. 더 나아가지 못하면 그만둔다(끝에 닿았거나 막혔다).
 *
 * @returns `{video, audio}` — 각각 `{init, segments}`. 라이브 경로와 같은 모양이라
 *          합치는 쪽(writeProgressive)을 그대로 쓴다.
 */
export async function fetchSabrSection({
  session,
  videoFormat,
  audioFormat,
  start,
  end,
  caches,
  onProgress,
  control,
}) {
  const tracks = {
    video: { format: videoFormat, cache: caches.video, init: null, seen: new Set(), segments: [], bytes: 0 },
    audio: { format: audioFormat, cache: caches.audio, init: null, seen: new Set(), segments: [], bytes: 0 },
  };
  const byItag = new Map();
  if (videoFormat) byItag.set(Number(videoFormat.itag), tracks.video);
  if (audioFormat) byItag.set(Number(audioFormat.itag), tracks.audio);

  const covered = (track) => {
    if (!track.format) return Infinity;
    let last = start;
    for (const s of track.segments) last = Math.max(last, s.time + s.duration);
    return last;
  };
  const 남은트랙 = () => [tracks.video, tracks.audio].filter((t) => t.format);

  let playerTimeMs = Math.max(0, start) * 1000;
  let guard = 0;

  while (guard++ < 400) {
    control?.throwIfStopped?.();
    const { segments, errors } = await session.pull({
      playerTimeMs,
      video: videoFormat,
      audio: audioFormat,
    });
    if (!segments.length) {
      if (errors.length) throw new Error(`조각을 받지 못했습니다 (SABR ${errors[0]})`);
      break;
    }

    let 진전 = false;
    for (const segment of segments) {
      const track = byItag.get(Number(segment.itag));
      if (!track) continue;
      if (segment.init) {
        if (!track.init) track.init = segment.bytes;
        continue;
      }
      const name = `q${segment.sequence}`;
      if (track.seen.has(name)) continue;
      track.seen.add(name);
      // 고른 구간에 안 걸치는 조각은 버린다(서버가 넉넉히 보내준다).
      if (segment.time + segment.duration <= start || segment.time >= end) continue;
      await track.cache.write(name, segment.bytes);
      track.segments.push({ time: segment.time, duration: segment.duration, name, live: true });
      track.bytes += segment.bytes.length;
      진전 = true;
    }

    const 진행 = 남은트랙().map(covered);
    const 가장뒤처진 = Math.min(...진행);
    onProgress?.(
      Math.min(가장뒤처진 - start, end - start),
      Math.max(0.001, end - start),
      { bytes: 남은트랙().reduce((n, t) => n + t.bytes, 0), estimated: 0 },
    );
    if (가장뒤처진 >= end) break;
    const 다음 = 가장뒤처진 * 1000;
    if (!진전 || 다음 <= playerTimeMs) break; // 더 안 나간다
    playerTimeMs = 다음;
  }

  for (const track of 남은트랙()) {
    if (!track.segments.length) throw new Error("해당 구간에 받을 조각이 없습니다");
    if (!track.init) throw new Error("조각에서 앞머리를 찾지 못했습니다");
    track.segments.sort((a, b) => a.time - b.time);
  }
  return {
    video: videoFormat ? { init: tracks.video.init, segments: tracks.video.segments } : null,
    audio: audioFormat ? { init: tracks.audio.init, segments: tracks.audio.segments } : null,
  };
}
