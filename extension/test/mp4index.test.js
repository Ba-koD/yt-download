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

Deno.test("끝에 살짝만 걸치는 조각은 버린다", () => {
  const segments = [
    { time: 0, duration: 10, start: 0, end: 9 },
    { time: 10, duration: 10, start: 10, end: 19 },
    { time: 20, duration: 10, start: 20, end: 29 },
  ];
  // 20.1초까지 요청하면 세 번째 조각은 0.1초만 기여한다 -> 버린다.
  assertEquals(segmentsForRange(segments, 0, 20.1).map((s) => s.time), [0, 10]);
  // 25초까지면 실제로 필요하므로 남긴다.
  assertEquals(segmentsForRange(segments, 0, 25).map((s) => s.time), [0, 10, 20]);
  // 하나뿐이면 아무리 조금 걸쳐도 남긴다.
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
      return new Uint8Array([1, 2, 3]);
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

Deno.test("다시 물어도 답이 같은 실패(403)는 바로 던진다", async () => {
  let calls = 0;
  const fetcher = withRetry(
    async () => {
      calls += 1;
      throw new Error("조각을 받지 못했습니다 (HTTP 403)");
    },
    { sleep: async () => {} },
  );

  await assertRejects(() => fetcher("u"), Error, "HTTP 403");
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
    async () => new Uint8Array([1]),
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
import { concat, dropLeadingSamples, dropTrailingSamples, listBoxes, makeBox } from "../src/mp4mux.js";

const beU32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

/** 유튜브 소리 조각과 같은 뼈대의 작은 조각. 샘플마다 3바이트, 길이는 전부 같다. */
function fakeAudioFragment({ samples = 10, size = 3, sampleDuration = 1024, base = 1000 } = {}) {
  const tfhd = makeBox("tfhd", beU32(0x000008), beU32(2), beU32(sampleDuration));
  const tfdt = makeBox("tfdt", beU32(0), beU32(base));
  const trun = makeBox(
    "trun",
    beU32(0x000201), // data_offset + sample_size
    beU32(samples),
    beU32(0),
    ...Array.from({ length: samples }, () => beU32(size)),
  );
  const payload = new Uint8Array(samples * size).map((_, i) => i);
  return concat([makeBox("moof", makeBox("traf", tfhd, tfdt, trun)), makeBox("mdat", payload)]);
}

function trunSampleCount(fragment) {
  const moof = listBoxes(fragment).find((b) => b.type === "moof");
  const traf = listBoxes(fragment, moof.start + 8, moof.end).find((b) => b.type === "traf");
  const trun = listBoxes(fragment, traf.start + 8, traf.end).find((b) => b.type === "trun");
  return new DataView(fragment.buffer, fragment.byteOffset + trun.start + 8 + 4).getUint32(0);
}

Deno.test("소리 조각의 뒤를 잘라 영상 끝에 맞춘다", () => {
  const fragment = fakeAudioFragment(); // 10 샘플 × 1024/44100초
  const keepSeconds = (4 * 1024) / 44100; // 딱 4샘플 어치
  const cut = dropTrailingSamples(fragment, keepSeconds, 44100);

  assertEquals(trunSampleCount(cut), 4);
  const mdat = listBoxes(cut).find((b) => b.type === "mdat");
  assertEquals(mdat.end - mdat.start - 8, 4 * 3); // 남은 샘플 바이트만
  // 시작 시각(tfdt)은 그대로다 — 뒤만 잘랐다.
  const moof = listBoxes(cut).find((b) => b.type === "moof");
  const traf = listBoxes(cut, moof.start + 8, moof.end).find((b) => b.type === "traf");
  const tfdt = listBoxes(cut, traf.start + 8, traf.end).find((b) => b.type === "tfdt");
  assertEquals(new DataView(cut.buffer, cut.byteOffset + tfdt.start + 8 + 4).getUint32(0), 1000);

  // 조각이 남길 길이보다 짧으면 손대지 않고, 남길 것이 없으면 통째로 버린다.
  assertEquals(dropTrailingSamples(fragment, 999, 44100), fragment);
  assertEquals(dropTrailingSamples(fragment, Infinity, 44100), fragment);
  assertEquals(dropTrailingSamples(fragment, 0, 44100), null);
});

/** 조각 안 moof 짝들의 (샘플 수, 시작 시각) 목록. */
function fragmentsInfo(bytes) {
  const out = [];
  for (const box of listBoxes(bytes)) {
    if (box.type !== "moof") continue;
    const traf = listBoxes(bytes, box.start + 8, box.end).find((b) => b.type === "traf");
    const kids = listBoxes(bytes, traf.start + 8, traf.end);
    const trun = kids.find((b) => b.type === "trun");
    const tfdt = kids.find((b) => b.type === "tfdt");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    out.push({
      samples: view.getUint32(trun.start + 8 + 4),
      time: view.getUint32(tfdt.start + 8 + 4),
    });
  }
  return out;
}

Deno.test("moof 짝이 여러 개인 조각(라이브 출신)도 앞뒤를 자를 수 있다", () => {
  // 5샘플짜리 짝 둘 = 총 10샘플. 라이브 조각을 이어붙인 다시보기가 이런 모양이다.
  const multi = concat([
    fakeAudioFragment({ samples: 5, base: 1000 }),
    fakeAudioFragment({ samples: 5, base: 1000 + 5 * 1024 }),
  ]);

  // 뒤 자르기: 7샘플 어치만 남기면 → 첫 짝은 통째로, 둘째 짝은 2샘플만.
  const tail = dropTrailingSamples(multi, (7 * 1024) / 44100, 44100);
  assertEquals(fragmentsInfo(tail), [
    { samples: 5, time: 1000 },
    { samples: 2, time: 1000 + 5 * 1024 },
  ]);

  // 앞 자르기: 6샘플 어치를 버리면 → 첫 짝은 통째로 사라지고, 둘째 짝은 1샘플을 잃고
  // 시작 시각이 그만큼 뒤로 밀린다.
  const head = dropLeadingSamples(multi, (6 * 1024) / 44100, 44100);
  assertEquals(fragmentsInfo(head), [{ samples: 4, time: 1000 + 6 * 1024 }]);

  // 전부 버려야 하면 null.
  assertEquals(dropLeadingSamples(multi, 999, 44100), null);
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
