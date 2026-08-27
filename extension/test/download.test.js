// 라이브 조각의 전체 용량 어림이 실제 크기로 수렴하는지 확인한다.
//   deno test extension/test/
//
// 조각 크기는 트랙 안에서도 배로 오르내린다(화면이 많이 움직이면 커진다).
// 그래서 앞머리 몇 개만 재서 평균을 고정하면 실제와 크게 어긋난다. 여기서는
// 앞 다섯 조각만 작고 나머지는 열 배로 큰, 가장 심한 모양을 일부러 만든다.
import { assert, assertEquals } from "jsr:@std/assert@1";

import { fetchLiveSegments } from "../src/download.js";
import { useTransport } from "../src/net.js";
import { openMemory } from "../src/store.js";

const STEP = 5;
const COUNT = 20;
const FORMAT = { url: "https://rr1.googlevideo.com/videoplayback?id=abc", segmentSeconds: STEP };

/** i번째 조각의 크기(바이트). 앞 다섯 개만 작다. */
const sizeOf = (sq) => (sq < 5 ? 1_024 : 10_240);
const totalBytes = Array.from({ length: COUNT }, (_, sq) => sizeOf(sq)).reduce((a, b) => a + b, 0);

function box(type, length) {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

/** 앞머리(ftyp+moov)가 붙은 라이브 조각 한 개를 흉내 낸다. */
function fakeSegment(total) {
  const parts = [box("ftyp", 8), box("moov", 8), box("moof", 8), box("mdat", total - 24)];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function fakeTransport(seen = []) {
  return {
    json: async () => ({}),
    text: async () => "",
    bytes: async (url) => {
      const sq = Number(new URL(url).searchParams.get("sq"));
      seen.push(sq);
      return fakeSegment(sizeOf(sq));
    },
  };
}

/** 조각을 다 받아 보고, 진행 보고를 순서대로 모은다. */
async function runFetch(track) {
  const fetched = [];
  useTransport(fakeTransport(fetched));
  const reports = [];
  await fetchLiveSegments(
    FORMAT,
    0,
    (COUNT - 1) * STEP,
    (done, total, size) => reports.push({ done, total, ...size }),
    null,
    track,
  );
  return { fetched, reports };
}

Deno.test("구간에 있는 조각만, 한 번씩만 받는다", async () => {
  const store = openMemory();
  const { fetched } = await runFetch(await store.track("137"));

  // 동시에 여러 개를 받다 보면 끝에서 목록에 없는 자리까지 집어 오기 쉽다(sq=undefined).
  assertEquals([...fetched].sort((a, b) => a - b), Array.from({ length: COUNT }, (_, sq) => sq));
});

Deno.test("다 받으면 어림이 아니라 실측이 된다", async () => {
  const store = openMemory();
  const { fetched, reports } = await runFetch(await store.track("137"));

  assertEquals(fetched.length, COUNT);
  const last = reports[reports.length - 1];
  assertEquals(last.done, COUNT);
  assertEquals(last.bytes, totalBytes);
  // 크기를 모르는 조각이 없으면 어림은 받은 양과 같아야 한다.
  assertEquals(last.estimated, totalBytes);
});

Deno.test("앞머리 몇 개로 어림을 고정하지 않는다", async () => {
  const store = openMemory();
  const { reports } = await runFetch(await store.track("137"));

  // 작은 조각만 받은 시점에도 어림은 낮게 잡히지만, 큰 조각이 들어오면 따라 올라간다.
  const early = reports.find((report) => report.done === 5);
  assert(early.estimated < totalBytes, "표본이 작을 때는 아직 실제보다 낮다");
  const later = reports.find((report) => report.done === COUNT - 1);
  assert(
    Math.abs(later.estimated - totalBytes) < totalBytes * 0.05,
    `거의 다 받은 시점의 어림(${later.estimated})이 실제(${totalBytes})와 5% 안이어야 한다`,
  );
});

Deno.test("이어받은 조각도 받은 양에 넣는다", async () => {
  const store = openMemory();
  const track = await store.track("137");
  // 절반은 이미 받아둔 상태로 만든다.
  for (let sq = 0; sq < COUNT / 2; sq += 1) {
    await track.write(`q${sq}`, fakeSegment(sizeOf(sq)));
  }

  const { fetched, reports } = await runFetch(track);

  assertEquals(fetched.length, COUNT / 2);
  const last = reports[reports.length - 1];
  // 새로 받은 것만 세면 여기서 절반으로 보인다. 진행률은 100%인데 용량만 반토막 나던 자리다.
  assertEquals(last.bytes, totalBytes);
  assertEquals(last.estimated, totalBytes);
  // 시작하자마자 이미 가진 만큼이 잡혀 있어야 한다.
  assert(reports[0].bytes > 0, "이어받은 조각의 크기를 처음부터 세야 한다");
});
