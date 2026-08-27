// 실제 유튜브가 준 sidx 바이트로 색인 해석을 확인한다.
//   deno test --allow-read extension/test/
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";

import { findBox, mergeRanges, parseSidx, segmentsForRange } from "../src/mp4index.js";
import { buildPlayerRequest, extractVisitorData, formatLabel, readFormats } from "../src/innertube.js";

const here = new URL(".", import.meta.url);
const readFixture = (name) => Deno.readFileSync(new URL(`fixtures/${name}`, here));

// aqz-KE-bpKQ (10분 34초 = 634초) 의 4K AV1 트랙과 AAC 트랙.
const VIDEO_INDEX_END = 2208;
const AUDIO_INDEX_END = 1522;

Deno.test("mp4 박스를 찾는다", () => {
  const bytes = readFixture("itag401-index.bin");
  assert(findBox(bytes, "ftyp"), "ftyp 가 있어야 한다");
  assert(findBox(bytes, "moov"), "moov 가 있어야 한다");
  assert(findBox(bytes, "sidx"), "sidx 가 있어야 한다");
  assertEquals(findBox(bytes, "zzzz"), null);
});

Deno.test("영상 sidx 를 읽어 조각 표를 만든다", () => {
  const bytes = readFixture("itag401-index.bin");
  const { segments, totalDuration } = parseSidx(bytes, VIDEO_INDEX_END);

  assert(segments.length > 50, `조각이 너무 적다: ${segments.length}`);
  // 실제 길이 634초와 1초 이내로 맞아야 한다.
  assert(Math.abs(totalDuration - 634) < 1, `길이가 어긋난다: ${totalDuration}`);

  // 첫 조각은 색인 바로 뒤에서 시작한다.
  assertEquals(segments[0].start, VIDEO_INDEX_END + 1);
  assertEquals(segments[0].time, 0);

  // 조각은 빈틈없이 이어져야 한다.
  for (let i = 1; i < segments.length; i += 1) {
    assertEquals(segments[i].start, segments[i - 1].end + 1, `${i}번째 조각이 어긋난다`);
    assert(segments[i].time >= segments[i - 1].time, "시간이 거꾸로 간다");
  }
});

Deno.test("소리 sidx 도 같은 길이를 가리킨다", () => {
  const bytes = readFixture("itag140-index.bin");
  const { segments, totalDuration } = parseSidx(bytes, AUDIO_INDEX_END);
  assert(segments.length > 50);
  assert(Math.abs(totalDuration - 634) < 1, `길이가 어긋난다: ${totalDuration}`);
});

Deno.test("구간에 걸치는 조각만 고른다", () => {
  const bytes = readFixture("itag401-index.bin");
  const { segments } = parseSidx(bytes, VIDEO_INDEX_END);

  const picked = segmentsForRange(segments, 100, 130);
  assert(picked.length > 0);
  // 고른 조각이 요청 구간을 완전히 덮어야 한다.
  assert(picked[0].time <= 100, "시작을 덮지 못했다");
  const last = picked[picked.length - 1];
  // 마지막 조각이 아주 조금만 걸치면 버리므로 1초까지는 모자랄 수 있다.
  assert(last.time + last.duration >= 129, "끝을 덮지 못했다");
  // 필요 이상으로 받지 않아야 한다(앞뒤로 조각 하나씩까지만 허용).
  assert(picked.length < segments.length / 4, `너무 많이 골랐다: ${picked.length}`);

  // 순서를 뒤집어 넣어도 같은 결과여야 한다.
  assertEquals(segmentsForRange(segments, 130, 100).length, picked.length);
});

Deno.test("전체 구간은 모든 조각을 고른다", () => {
  const bytes = readFixture("itag401-index.bin");
  const { segments, totalDuration } = parseSidx(bytes, VIDEO_INDEX_END);
  assertEquals(segmentsForRange(segments, 0, totalDuration).length, segments.length);
});

Deno.test("끝에 살짝만 걸쳐도 그 조각까지 받는다", () => {
  const segments = [
    { time: 0, duration: 10, start: 0, end: 9 },
    { time: 10, duration: 10, start: 10, end: 19 },
    { time: 20, duration: 10, start: 20, end: 29 },
  ];
  // 20.1초까지 요청하면 세 번째 조각은 0.1초만 기여한다. 그래도 받아야 한다 —
  // 버리면 요청보다 0.1초 짧은 파일이 나온다(실측으로 겪은 문제다).
  assertEquals(segmentsForRange(segments, 0, 20.1).map((s) => s.time), [0, 10, 20]);
  assertEquals(segmentsForRange(segments, 0, 25).map((s) => s.time), [0, 10, 20]);
  // 경계에 딱 맞으면 그 뒤 조각은 필요 없다.
  assertEquals(segmentsForRange(segments, 0, 20).map((s) => s.time), [0, 10]);
  // 하나만 걸쳐도 남긴다.
  assertEquals(segmentsForRange(segments, 20.05, 20.1).map((s) => s.time), [20]);
});

Deno.test("이어진 조각을 한 번의 요청으로 묶는다", () => {
  const bytes = readFixture("itag401-index.bin");
  const { segments } = parseSidx(bytes, VIDEO_INDEX_END);
  const picked = segmentsForRange(segments, 60, 120);

  const ranges = mergeRanges(picked, 8 * 1024 * 1024);
  assert(ranges.length <= picked.length, "묶은 뒤 개수가 늘었다");
  assertEquals(ranges[0].start, picked[0].start);
  assertEquals(ranges[ranges.length - 1].end, picked[picked.length - 1].end);

  // 묶은 조각의 총 바이트는 그대로여야 한다.
  const before = picked.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  const after = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  assertEquals(after, before);

  // 한도가 작으면 잘게 나뉜다.
  assert(mergeRanges(picked, 1024).length > ranges.length);
});

Deno.test("sidx 가 없으면 알려준다", () => {
  assertThrows(() => parseSidx(new Uint8Array(32), 0), Error, "sidx");
});

Deno.test("방문자 ID를 뽑아낸다", () => {
  assertEquals(extractVisitorData('x"VISITOR_DATA":"CgtBQkMifQ%3D%3D",y'), "CgtBQkMifQ%3D%3D");
  assertEquals(extractVisitorData('{"visitorData":"Zm9v"}'), "Zm9v");
  assertEquals(extractVisitorData("아무것도 없음"), null);
});

Deno.test("player 요청 본문에 클라이언트와 방문자 ID가 들어간다", () => {
  const body = buildPlayerRequest("abc123", "VISITOR");
  assertEquals(body.videoId, "abc123");
  assertEquals(body.context.client.clientName, "ANDROID_VR");
  assertEquals(body.context.client.visitorData, "VISITOR");
});

Deno.test("주소 없는 포맷과 webm 은 걸러낸다", () => {
  const response = {
    playabilityStatus: { status: "OK" },
    videoDetails: { lengthSeconds: "634", title: "제목" },
    streamingData: {
      adaptiveFormats: [
        // 주소 없음(SABR) — 버린다
        { itag: 315, mimeType: 'video/webm; codecs="vp9"', indexRange: { start: "1", end: "2" } },
        // webm — 아직 색인을 못 읽으므로 버린다
        {
          itag: 303, url: "u", mimeType: 'video/webm; codecs="vp9"', height: 1080,
          initRange: { start: "0", end: "1" }, indexRange: { start: "2", end: "3" },
        },
        {
          itag: 401, url: "u", mimeType: 'video/mp4; codecs="av01.0.13M.08"', height: 2160,
          qualityLabel: "2160p60", fps: 60, bitrate: 8982000, contentLength: "712345",
          initRange: { start: "0", end: "700" }, indexRange: { start: "701", end: "2208" },
        },
        {
          itag: 140, url: "u", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000,
          initRange: { start: "0", end: "722" }, indexRange: { start: "723", end: "1522" },
        },
      ],
    },
  };

  const formats = readFormats(response);
  assertEquals(formats.video.map((f) => f.itag), [401]);
  assertEquals(formats.audio.map((f) => f.itag), [140]);
  assertEquals(formats.durationSeconds, 634);
  assertEquals(formats.video[0].indexRange, { start: 701, end: 2208 });
  assertEquals(formatLabel(formats.video[0]), "2160p60 AV1");
  assertEquals(formatLabel(formats.audio[0]), "129kbps AAC");
});

Deno.test("재생할 수 없는 영상은 이유를 그대로 알려준다", () => {
  assertThrows(
    () => readFormats({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "로그인 필요" } }),
    Error,
    "로그인 필요",
  );
});

// --- 요청 통로 ---
import { decodeBase64, withFallback, withRetry } from "../src/net.js";

Deno.test("base64 로 온 바이트를 원래대로 되돌린다", () => {
  const original = new Uint8Array([0, 1, 127, 128, 255, 66, 0, 9]);
  const encoded = btoa(String.fromCharCode(...original));
  assertEquals([...decodeBase64(encoded)], [...original]);
});

Deno.test("페이지 요청이 막히면 예비 통로로 넘어가고 그 뒤로는 계속 예비를 쓴다", async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const fetcher = withFallback(
    async () => {
      primaryCalls += 1;
      throw new Error("Failed to fetch");
    },
    async () => {
      secondaryCalls += 1;
      return { bytes: new Uint8Array([1, 2, 3]) };
    },
  );

  assertEquals([...(await fetcher("u"))], [1, 2, 3]);
  assertEquals([...(await fetcher("u"))], [1, 2, 3]);
  // 한 번 막히면 다시 시도하지 않는다.
  assertEquals(primaryCalls, 1);
  assertEquals(secondaryCalls, 2);
});

Deno.test("서버가 상태 코드로 거절한 것은 통로 문제가 아니므로 갈아타지 않는다", async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const fetcher = withFallback(
    async () => {
      primaryCalls += 1;
      throw new Error("조각을 받지 못했습니다 (HTTP 503)");
    },
    async () => {
      secondaryCalls += 1;
      return new Uint8Array();
    },
  );

  await assertRejects(() => fetcher("u"), Error, "HTTP 503");
  await assertRejects(() => fetcher("u"), Error, "HTTP 503");
  // 예비 통로로 보내봐야 같은 답이 온다. 다음에도 빠른 통로를 그대로 쓴다.
  assertEquals(primaryCalls, 2);
  assertEquals(secondaryCalls, 0);
});

Deno.test("일시적인 실패(503)는 쉬었다가 다시 받아서 살려낸다", async () => {
  let calls = 0;
  const waits = [];
  const fetcher = withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("HTTP 503");
      return new Uint8Array([9]);
    },
    { waitMs: 10, sleep: async (ms) => waits.push(ms) },
  );

  assertEquals([...(await fetcher("u"))], [9]);
  assertEquals(calls, 3);
  // 쉬는 시간은 점점 길어진다.
  assertEquals(waits, [10, 20]);
});

Deno.test("403 은 여기서 붙잡지 않고 바로 넘긴다(위층이 클라이언트를 갈아탄다)", async () => {
  // 403 은 "이 영상·이 클라이언트 몫을 다 썼다"는 뜻이다. 기다려도 잘 열리지 않고,
  // 다른 클라이언트로 주소를 새로 받으면 곧바로 이어진다. 그 갈아타기는 download.js 가
  // 하므로 여기서 붙잡으면 갈아타기만 늦어진다.
  let calls = 0;
  const fetcher = withRetry(
    async () => {
      calls += 1;
      throw new Error("조각을 받지 못했습니다 (HTTP 403)");
    },
    { sleep: async () => {} },
  );

  await assertRejects(() => fetcher("https://g.example/videoplayback?itag=137"), Error, "HTTP 403");
  assertEquals(calls, 1);
});

Deno.test("라이브 조각의 401 은 일시적인 것으로 보고 다시 받아 본다", async () => {
  let liveCalls = 0;
  const liveFetcher = withRetry(
    async () => {
      liveCalls += 1;
      if (liveCalls < 2) throw new Error("요청 실패 (HTTP 401)");
      return new Uint8Array([3]);
    },
    { sleep: async () => {} },
  );
  assertEquals([...(await liveFetcher("https://g.example/videoplayback?live=1&sq=7"))], [3]);
  assertEquals(liveCalls, 2);

  // 라이브가 아니면 401 은 다시 물어도 같다 — 바로 던진다.
  let vodCalls = 0;
  const vodFetcher = withRetry(
    async () => {
      vodCalls += 1;
      throw new Error("요청 실패 (HTTP 401)");
    },
    { sleep: async () => {} },
  );
  await assertRejects(() => vodFetcher("https://g.example/videoplayback?vprv=1"), Error, "HTTP 401");
  assertEquals(vodCalls, 1);
});

Deno.test("계속 실패하면 정해진 횟수만 시도하고, 쉬는 시간에는 상한이 있다", async () => {
  let calls = 0;
  const waits = [];
  const fetcher = withRetry(
    async () => {
      calls += 1;
      throw new Error("HTTP 503");
    },
    { tries: 5, waitMs: 3000, maxWaitMs: 8000, sleep: async (ms) => waits.push(ms) },
  );

  await assertRejects(() => fetcher("u"), Error, "HTTP 503");
  assertEquals(calls, 5);
  assertEquals(waits, [3000, 6000, 8000, 8000]);
});

Deno.test("예비 통로로 갈아탔어도 식힌 뒤에는 빠른 통로를 다시 두드려 본다", async () => {
  let primaryCalls = 0;
  let primaryBlocked = true;
  let clock = 0;
  const fetcher = withFallback(
    async () => {
      primaryCalls += 1;
      if (primaryBlocked) throw new Error("Failed to fetch");
      return new Uint8Array([5]);
    },
    async () => ({ bytes: new Uint8Array([1]) }),
    { coolOffMs: 1000, now: () => clock },
  );

  assertEquals([...(await fetcher("u"))], [1]); // 막혀서 예비 통로로
  clock = 999;
  assertEquals([...(await fetcher("u"))], [1]); // 아직 식지 않았다 — 예비 그대로
  assertEquals(primaryCalls, 1);

  clock = 1000;
  primaryBlocked = false; // 서버 교대가 끝났다
  assertEquals([...(await fetcher("u"))], [5]); // 빠른 통로로 되돌아온다
  assertEquals(primaryCalls, 2);
});

Deno.test("페이지 요청이 되면 예비 통로는 쓰지 않는다", async () => {
  let secondaryCalls = 0;
  const fetcher = withFallback(
    async () => new Uint8Array([7]),
    async () => {
      secondaryCalls += 1;
      return new Uint8Array();
    },
  );
  assertEquals([...(await fetcher("u"))], [7]);
  assertEquals(secondaryCalls, 0);
});

Deno.test("통로 계량기는 지나간 바이트를 알려준다", async () => {
  const { withMeter } = await import("../src/net.js");
  const counted = [];
  const fetcher = withMeter(async () => new Uint8Array(7), (n) => counted.push(n));
  await fetcher("u");
  await fetcher("u");
  assertEquals(counted, [7, 7]);
});

// --- 조각 저장소와 이어받기 ---
import { fetchSegments } from "../src/download.js";
import { useTransport } from "../src/net.js";
import { openMemory } from "../src/store.js";

Deno.test("받아둔 조각은 다시 받지 않는다(이어받기)", async () => {
  // 10바이트짜리 조각 셋. 내용은 바이트 위치 그대로라 어긋나면 바로 보인다.
  const index = {
    segments: [
      { time: 0, duration: 5, start: 0, end: 9 },
      { time: 5, duration: 5, start: 10, end: 19 },
      { time: 10, duration: 5, start: 20, end: 29 },
    ],
  };
  const asked = [];
  useTransport({
    json: async () => {
      throw new Error("여기서는 안 쓴다");
    },
    text: async () => {
      throw new Error("여기서는 안 쓴다");
    },
    bytes: async (_url, headers) => {
      asked.push(headers.Range);
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
      return new Uint8Array(Array.from({ length: to - from + 1 }, (_, i) => from + i));
    },
  });

  const media = openMemory();
  const track = await media.track(401);
  const seen = [];
  const first = await fetchSegments(
    { url: "u" }, index, 0, 15, (done, total) => seen.push([done, total]), null, track,
  );
  assertEquals(first.totalBytes, 30);
  assertEquals(first.segments.map((s) => s.name), ["s0-9", "s10-19", "s20-29"]);
  // 이어진 조각은 한 요청으로 묶인다.
  assertEquals(asked, ["bytes=0-29"]);
  // 저장된 조각의 내용이 제 바이트 범위와 맞는다.
  assertEquals([...(await track.read("s10-19"))], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  // 같은 구간을 다시 — 전부 저장돼 있으니 요청이 없어야 하고, 진행률은 처음부터 꽉 차 있다.
  const before = asked.length;
  const again = await fetchSegments(
    { url: "u" }, index, 0, 15, (done, total) => seen.push([done, total]), null, track,
  );
  assertEquals(asked.length, before);
  assertEquals(again.totalBytes, 30);
  assertEquals(seen[seen.length - 1], [30, 30]);
});

Deno.test("일부만 받아뒀으면 없는 조각만 받는다", async () => {
  const index = {
    segments: [
      { time: 0, duration: 5, start: 0, end: 9 },
      { time: 5, duration: 5, start: 10, end: 19 },
      { time: 10, duration: 5, start: 20, end: 29 },
    ],
  };
  const asked = [];
  useTransport({
    json: async () => {
      throw new Error("여기서는 안 쓴다");
    },
    text: async () => {
      throw new Error("여기서는 안 쓴다");
    },
    bytes: async (_url, headers) => {
      asked.push(headers.Range);
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
      return new Uint8Array(to - from + 1);
    },
  });

  const media = openMemory();
  const track = await media.track(401);
  // 가운데 조각만 미리 받아둔 상태를 만든다.
  await track.write("s10-19", new Uint8Array(10));

  await fetchSegments({ url: "u" }, index, 0, 15, null, null, track);
  // 가운데는 건너뛰고 양옆만 따로 받는다(이어져 있지 않으니 두 요청).
  assertEquals(asked, ["bytes=0-9", "bytes=20-29"]);
});

// --- 소리 조각 뒤 잘라내기 ---
import { concat, listBoxes, makeBox, readSamples } from "../src/mp4mux.js";
import { writeProgressive } from "../src/download.js";

const beU32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

/**
 * 유튜브 **영상** 조각과 같은 뼈대. trun 이 길이·크기·플래그·화면순서 보정을 모두 담는다
 * (유튜브 H.264 조각의 flags 는 0xe01 이다). 소리 조각만 다루던 옛 파서는 이 모양을
 * 아예 읽지 못해서, 영상은 조각째 담는 수밖에 없었다.
 *
 * 샘플 i 의 바이트는 전부 i 로 채운다 — 어느 바이트가 어느 샘플인지 알아보려고.
 */
function fakeVideoFragment({ count = 6, dur = 256, base = 0, ctos = null, syncAt = [0] } = {}) {
  const sizes = Array.from({ length: count }, (_, i) => 4 + i);
  // B프레임이 하나 낀 흔한 배치. 디코딩 순서 0,1,2,3 이 화면에서는 1,3,2,4 로 나온다.
  // 이렇게 해야 화면 시각이 서로 겹치지 않는다(유튜브 H.264 도 첫 화면 시각이 256이다).
  const offsets = ctos || Array.from({ length: count }, (_, i) => [256, 512, 0, 256][i % 4]);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    // sample_flags 의 16번 비트가 1이면 "키프레임 아님".
    const flags = syncAt.includes(i) ? 0 : 0x00010000;
    entries.push(beU32(dur), beU32(sizes[i]), beU32(flags), beU32(offsets[i]));
  }
  const tfhd = makeBox("tfhd", beU32(0x020000), beU32(1)); // default-base-is-moof
  const tfdt = makeBox("tfdt", beU32(0), beU32(base));
  const trun = makeBox("trun", beU32(0x000f01), beU32(count), beU32(0), ...entries);
  const moof = makeBox("moof", makeBox("traf", tfhd, tfdt, trun));
  // data_offset 은 moof 시작이 기준이다. moof 를 다 짓고 나서야 값을 알 수 있다.
  const traf = listBoxes(moof, 8, moof.length).find((x) => x.type === "traf");
  const at = listBoxes(moof, traf.start + 8, traf.end).find((x) => x.type === "trun");
  new DataView(moof.buffer, moof.byteOffset).setUint32(at.start + 16, moof.length + 8);

  const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let o = 0;
  sizes.forEach((size, i) => {
    payload.fill(i, o, o + size);
    o += size;
  });
  return { bytes: concat([moof, makeBox("mdat", payload)]), sizes, offsets };
}

/** 앞머리(ftyp+moov) 흉내. 표는 비어 있어도 된다 — 우리가 채워 넣을 자리다. */
function fakeInit({ timescale = 15360, movieTimescale = 1000 } = {}) {
  const mvhd = makeBox("mvhd", beU32(0), beU32(0), beU32(0), beU32(movieTimescale),
    beU32(0), beU32(0x00010000), new Uint8Array(76), beU32(2));
  const tkhd = makeBox("tkhd", beU32(0), beU32(0), beU32(0), beU32(1), beU32(0), beU32(0),
    new Uint8Array(60));
  const mdhd = makeBox("mdhd", beU32(0), beU32(0), beU32(0), beU32(timescale), beU32(0), beU32(0));
  const hdlr = makeBox("hdlr", beU32(0), beU32(0), new TextEncoder().encode("vide"),
    new Uint8Array(13));
  const stbl = makeBox("stbl", makeBox("stsd", beU32(0), beU32(0)));
  const minf = makeBox("minf", makeBox("dinf"), stbl);
  const trak = makeBox("trak", tkhd, makeBox("mdia", mdhd, hdlr, minf));
  return concat([makeBox("ftyp", new TextEncoder().encode("isom")), makeBox("moov", mvhd, trak)]);
}

/** 지어진 파일 속에서 표 하나를 찾아 준다. */
function findTable(file, type) {
  let found = null;
  const walk = (from, to) => {
    for (const box of listBoxes(file, from, to)) {
      if (box.type === type) found = found || box;
      else if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(box.type)) {
        walk(box.start + 8, box.end);
      }
    }
  };
  walk(0, file.length);
  return found;
}

/** 조각 하나를 저장소에 넣고 트랙 하나짜리 파일을 짓는다. */
async function buildOne({ start, end, count = 6, timescale = 15360, ctos = null }) {
  const { bytes } = fakeVideoFragment({ count, ctos });
  const store = openMemory();
  const cache = await store.track("t");
  await cache.write("f0", bytes);
  const output = await store.output();
  const span = await writeProgressive(
    output,
    [{
      cache,
      init: fakeInit({ timescale }),
      segments: [{ time: 0, duration: (count * 256) / timescale, name: "f0" }],
      firstTime: 0,
      snap: true,
    }],
    { start, end },
    null,
    null,
  );
  const blob = await output.close();
  return { file: new Uint8Array(await blob.arrayBuffer()), span };
}

Deno.test("영상 조각의 trun 을 샘플 단위로 읽는다", () => {
  const { bytes, sizes, offsets } = fakeVideoFragment({ count: 6, syncAt: [0, 3] });
  const read = readSamples(bytes);

  assertEquals(read.samples.length, 6);
  assertEquals(read.samples.map((s) => s.size), sizes);
  assertEquals(read.samples.map((s) => s.cto), offsets);
  assertEquals(read.samples.map((s) => s.sync), [true, false, false, true, false, false]);
  // 샘플 바이트가 정말 그 자리에 있는지. i 번 샘플은 전부 i 로 채워 두었다.
  read.samples.forEach((sample, i) => {
    const slice = bytes.subarray(sample.at, sample.at + sample.size);
    assert(slice.every((byte) => byte === i), `${i}번 샘플이 엉뚱한 자리를 가리킨다`);
  });
});

Deno.test("조각화 흔적 없는 일반 mp4 로 짓는다", async () => {
  const { file } = await buildOne({ start: 0, end: 1 });
  // moof 나 mvex 가 남아 있으면 재생기가 편집 목록을 무시한다(실측으로 확인한 함정이다).
  assertEquals(listBoxes(file).map((b) => b.type), ["ftyp", "moov", "mdat"]);
  assertEquals(findTable(file, "mvex"), null);
});

Deno.test("덩어리 위치가 진짜 샘플 바이트를 가리킨다", async () => {
  const { file } = await buildOne({ start: 0, end: 1 });
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const stco = findTable(file, "stco");
  const at = dv.getUint32(stco.start + 16);
  const stsz = findTable(file, "stsz");
  const firstSize = dv.getUint32(stsz.start + 20);
  assert(file.subarray(at, at + firstSize).every((b) => b === 0), "덩어리가 엉뚱한 자리를 가리킨다");
});

Deno.test("키프레임 자리를 표로 옮긴다", async () => {
  const { file } = await buildOne({ start: 0, end: 1 });
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const stss = findTable(file, "stss");
  assertEquals(dv.getUint32(stss.start + 12), 1); // 항목 하나
  assertEquals(dv.getUint32(stss.start + 16), 1); // 1번 샘플(1부터 센다)
  assert(findTable(file, "ctts"), "화면순서 보정이 있으면 ctts 를 넣어야 한다");
});

Deno.test("보정값이 전부 0이면 ctts 를 넣지 않는다", async () => {
  const { file } = await buildOne({ start: 0, end: 1, count: 4, ctos: [0, 0, 0, 0] });
  assertEquals(findTable(file, "ctts"), null);
});

Deno.test("뒤는 실제로 잘라내고 앞은 편집 목록으로 가린다", async () => {
  const timescale = 15360;
  const frame = 256 / timescale; // 16.67ms
  const { file, span } = await buildOne({ start: 0.02, end: 0.05, count: 8, timescale });
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);

  const kept = dv.getUint32(findTable(file, "stsz").start + 16);
  assert(kept < 8, `뒤가 잘리지 않았다 (${kept}개 그대로)`);

  const elst = findTable(file, "elst");
  assert(elst, "편집 목록이 없다");
  assert(dv.getInt32(elst.start + 20) > 0, "앞을 건너뛰라고 적혀 있어야 한다");
  // 고른 지점보다 뒤에서 시작하면 그 순간 화면에 떠 있던 프레임을 잃는다.
  assert(span.start <= 0.02 + 1e-9, "고른 지점을 지나쳐 시작했다");
  assert(0.02 - span.start < frame + 1e-9, "한 프레임 넘게 앞당겼다");
});

Deno.test("고른 지점이 프레임 한가운데면 그 프레임부터 시작한다", async () => {
  // 화면에 나오는 순서로 프레임은 0ms, 16.67ms, 33.3ms … 25ms 를 고르면 둘째 장 안이다.
  const { span } = await buildOne({ start: 0.025, end: 0.09, count: 8 });
  assertEquals(span.start.toFixed(5), (256 / 15360).toFixed(5));
});

Deno.test("SAPISIDHASH 해시가 유튜브 방식과 같다", async () => {
  const { sha1 } = await import("../src/innertube.js");
  // 유튜브는 "시각 SAPISID 출처" 를 SHA-1 로 해시한다.
  assertEquals(
    await sha1("1785680789 TESTSAPISID https://www.youtube.com"),
    "34f704ae8aa2cceb8d411121f5dd513207cbe18c",
  );
});

Deno.test("화질 이름이 없으면 높이와 주사율로 짓는다", () => {
  const base = { mimeType: "video/mp4", codec: "av01.0.12M.08" };
  assertEquals(formatLabel({ ...base, height: 1080, fps: 60 }), "1080p60 AV1");
  assertEquals(formatLabel({ ...base, height: 1080, fps: 30 }), "1080p AV1");
});
