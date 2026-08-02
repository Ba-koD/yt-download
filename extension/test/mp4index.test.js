// 실제 유튜브가 준 sidx 바이트로 색인 해석을 확인한다.
//   deno test --allow-read extension/test/
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

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
import { decodeBase64, withFallback } from "../src/net.js";

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
