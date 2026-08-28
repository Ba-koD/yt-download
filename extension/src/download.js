// 고른 구간만 받아서 재생 가능한 mp4 하나로 만든다.
//
// 브라우저 API(fetch)만 쓴다. 확장의 content script 는 youtube.com 오리진에서 돌기 때문에
// InnerTube 는 동일 출처로, googlevideo 는 Range 를 허용하는 CORS 로 그대로 부를 수 있다.
//
// 받은 조각은 저장소(store.js — 되도록 OPFS 디스크)에 조각 단위로 쌓는다. 그래서
//  - 메모리에는 한 번에 조각 하나 크기만 남고(전에는 완성본까지 통째로 들고 있었다),
//  - 받다 죽어도 조각이 남아, 같은 구간을 다시 받으면 없는 것만 마저 받는다(이어받기).

import { fetchPlayerResponse, fetchVisitorData, readFormats } from "./innertube.js";
import { mergeRanges, parseSidx, segmentsForRange } from "./mp4index.js";
import { request } from "./net.js";
import { openMemory } from "./store.js";
import { buildHead, editStartOf, fillChunkOffsets, mdatHeader } from "./mp4file.js";
import { mediaTimescaleOf, readSamples, splitLiveSegment } from "./mp4mux.js";

/** 한 번에 보내는 요청 수. 너무 늘리면 유튜브가 속도를 깎는다. */
const CONCURRENCY = 6;

/** 웹 계열 클라이언트가 준 주소인가. 이쪽만 PO 토큰이 통한다. */
const isWebUrl = (url) => /[?&]c=(WEB|MWEB|TVHTML5)/.test(url);

export async function getFormats(videoId, visitorData, unlock, client, mintPot) {
  const visitor = visitorData || (await fetchVisitorData());
  const player = await fetchPlayerResponse(videoId, visitor, client);
  const formats = readFormats(player);

  // 웹 계열이 주는 주소에는 `n` 이 붙어 있고, 풀지 않으면 403 이다.
  // ANDROID_VR 주소에는 아예 없으므로 이 길로 오지 않는다.
  const tracks = [...formats.video, ...formats.audio];
  if (unlock && tracks.some((track) => track.url.includes("n="))) {
    const solved = await unlock(tracks.map((track) => track.url));
    tracks.forEach((track, index) => {
      track.url = solved[index];
    });
  }

  // PO 토큰이 없으면 유튜브는 앞부분 약 60초까지만 내어준다. 웹 계열 주소에만 통하므로
  // 그쪽일 때만 붙인다(ANDROID_VR 주소에 붙여봐야 403 그대로다 — 실측).
  // 못 만들어도 받기를 막지는 않는다. 앞 60초까지는 그대로 되니까.
  if (mintPot && tracks.some((track) => isWebUrl(track.url) && !/[?&]pot=/.test(track.url))) {
    try {
      const token = await mintPot();
      if (token) {
        for (const track of tracks) {
          if (isWebUrl(track.url) && !/[?&]pot=/.test(track.url)) {
            track.url += `&pot=${encodeURIComponent(token)}`;
          }
        }
      }
    } catch {
      // 발급기가 없거나 아직 안 덥혀졌다. 앞부분만이라도 받게 두고 넘어간다.
    }
  }
  return formats;
}

async function fetchRange(url, start, end) {
  return request.bytes(url, { Range: `bytes=${start}-${end}` });
}

/** 오류 문구에 섞여 오는 HTTP 상태를 꺼낸다. */
const statusOf = (error) => Number(/HTTP (\d{3})/.exec(error?.message || "")?.[1]) || 0;

/**
 * 조각을 받아 온다. 403 이 나면 주소를 새로 받아 한 번 더 해본다.
 *
 * 403 의 큰 원인은 두 가지다.
 * - **주소 만료.** 새로 받으면 풀린다. 이 갈아타기가 그 경우를 잡는다.
 * - **60초 벽.** 로그인하지 않으면 유튜브가 앞부분 약 60초까지만 내어준다(PO 토큰이
 *   없어서다). 이건 갈아타도 못 넘는다 — 세 클라이언트의 경계가 바이트까지 같다.
 *   로그인해 있으면 `WEB_CREATOR` 로 물어 끝까지 받으므로 애초에 여기 오지 않는다.
 *
 * 영상과 소리가 거의 동시에 403 을 맞으므로 갈아타기는 한 번만 한다(같은 약속을 나눠 쓴다).
 *
 * @param renew 새 주소표를 받아 오는 함수. `(itag) => 새 주소` 를 돌려준다.
 * @returns `(format, run)` — `run(주소)` 로 실제 요청을 만든다.
 */
function makePuller(renew) {
  let pending = null;
  return async (format, run) => {
    // 갈아탈 곳은 몇 군데뿐이지만, 끝없이 도는 일이 없도록 횟수를 묶어 둔다.
    for (let hop = 0; hop < 8; hop += 1) {
      try {
        return await run(format.url);
      } catch (error) {
        if (!renew || statusOf(error) !== 403) throw error;
        if (!pending) {
          pending = Promise.resolve(renew()).finally(() => {
            pending = null;
          });
        }
        const lookup = await pending;
        const fresh = lookup?.(format.itag);
        // 갈아탈 곳이 더 없으면 여기까지다.
        //
        // "받은 주소가 지금 것과 같으면 그만" 같은 검사를 두면 안 된다. 일꾼 여럿이
        // 함께 갈아타므로, 먼저 간 일꾼이 이미 같은 주소를 넣어 둔 상태에서 뒤따르는
        // 일꾼이 그 검사에 걸려 엉뚱하게 포기해 버린다(실제로 그래서 한 번밖에 못 갈아탔다).
        if (!fresh) throw error;
        format.url = fresh;
      }
    }
    return run(format.url);
  };
}

// 조각 파일의 이름. 이 이름이 곧 이어받기의 근거다 —
// 일반 영상은 sidx 가 정한 바이트 경계(세션이 바뀌어도 같다), 라이브는 조각 번호.
const rangeName = (segment) => `s${segment.start}-${segment.end}`;
const liveName = (sq) => `q${sq}`;

/**
 * 라이브 조각을 번호로 받아 저장소에 쌓는다.
 *
 * 라이브에는 색인이 없다. 대신 조각이 일정한 길이(`targetDurationSec`)로 잘려 있고
 * `&sq=N` 으로 N번째 조각을 바로 집어올 수 있다. 조각마다 앞머리가 붙어 오므로
 * 통째로 저장해 두고, 엮을 때 앞머리를 떼어낸다(첫 조각의 것만 쓴다).
 */
export async function fetchLiveSegments(format, start, end, onProgress, control, track, pull) {
  const step = format.segmentSeconds;
  if (!(step > 0)) throw new Error("조각 길이를 알 수 없습니다");

  const first = Math.max(0, Math.floor(Math.min(start, end) / step));
  const last = Math.max(first, Math.floor(Math.max(start, end) / step));
  const numbers = [];
  for (let sq = first; sq <= last; sq += 1) numbers.push(sq);

  // 이미 받아둔 조각은 건너뛴다. 진행률에는 처음부터 받은 것으로 잡힌다.
  const have = numbers.filter((sq) => track.has(liveName(sq)));
  const missing = numbers.filter((sq) => !track.has(liveName(sq)));
  let done = have.length;

  // 전체 용량 어림. 크기를 아는 조각은 실제 값을 그대로 쓰고, 아직 모르는 조각만
  // 지금까지의 평균으로 메운다. 그래서 받을수록 어림이 실제 크기로 수렴하고,
  // 다 받으면 어림이 아니라 실측이 된다.
  //
  // 앞머리 몇 개만 보고 평균을 고정하면 안 된다. 영상 조각은 화면이 얼마나 움직이느냐에
  // 따라 크기가 배로 오르내리고(균일한 것은 소리뿐이다), 동시에 여러 개를 받으므로
  // 먼저 끝나는 작은 것부터 표본에 들어와 어림이 낮은 쪽으로 치우친다.
  let gotBytes = 0;
  let known = 0;
  // 이어받은 조각도 디스크에서 크기를 읽어 표본에 넣는다. 이러지 않으면 받은 양이
  // 이번에 새로 받은 것만 세어, 진행률은 100%인데 용량은 절반으로 보인다.
  const cached = await Promise.all(have.map((sq) => track.size?.(liveName(sq))));
  for (const size of cached) {
    if (size > 0) {
      gotBytes += size;
      known += 1;
    }
  }
  const sizeReport = () => ({
    bytes: gotBytes,
    estimated: known > 0 ? gotBytes + (gotBytes / known) * (numbers.length - known) : 0,
  });
  onProgress?.(done, numbers.length, sizeReport());

  await mapWithLimit(missing, CONCURRENCY, async (sq) => {
    // 라이브 조각도 몫에 걸린다. 주소를 갈아탈 수 있게 같은 통로로 받는다.
    const fetchOne = (url) => request.bytes(`${url}&sq=${sq}`, {});
    const bytes = pull ? await pull(format, fetchOne) : await fetchOne(format.url);
    await track.write(liveName(sq), bytes);
    done += 1;
    gotBytes += bytes.length;
    known += 1;
    onProgress?.(done, numbers.length, sizeReport());
  }, control);

  // 앞머리(ftyp+moov)가 든 첫 조각을 찾는다. 대개 첫 번째 조각에 있다.
  let init = null;
  for (const sq of numbers) {
    init = splitLiveSegment(await track.read(liveName(sq))).init;
    if (init) break;
  }
  if (!init) throw new Error("조각에서 앞머리를 찾지 못했습니다");

  const segments = numbers.map((sq) => ({
    time: sq * step,
    duration: step,
    name: liveName(sq),
    live: true,
  }));
  return { init, segments, firstTime: first * step };
}

/**
 * 앞머리(init)와 조각 색인(sidx)을 한 번에 받아 온다. 둘이 파일 맨 앞에 붙어 있다.
 *
 * 이 첫 요청도 `pull` 을 거쳐야 한다. 몫이 떨어진 뒤 다시 눌러 이어받을 때 맨 처음
 * 하는 일이 바로 여기라서, 여기서 갈아타지 못하면 조각 받기까지 가보지도 못하고
 * 403 으로 끝난다. 클라이언트가 달라도 initRange/indexRange 는 같으므로(실측) 그대로 쓴다.
 */
export async function fetchIndex(format, pull) {
  const fetchOne = (url) => fetchRange(url, 0, format.indexRange.end);
  const head = pull ? await pull(format, fetchOne) : await fetchOne(format.url);
  const init = head.subarray(format.initRange.start, format.initRange.end + 1);
  const index = parseSidx(head, format.indexRange.end);
  return { init: init.slice(), ...index };
}

/** 여러 요청을 동시에 보내되, 결과 순서는 그대로 지킨다. */
async function mapWithLimit(items, limit, worker, control) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      // 차례는 기다리기 전에 집는다. gate() 를 먼저 기다리면 그 사이에 다른 일꾼이
      // 마지막 것을 가져가, 목록에 없는 자리(undefined)까지 집어 오게 된다.
      const index = next;
      next += 1;
      // 조각을 새로 받기 직전에만 멈춘다. 이미 나간 요청은 그대로 끝나게 둔다.
      await control?.gate();
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 받기를 그만뒀을 때 던진다. 실패와 구분해서 조용히 끝내려는 것이다. */
export class Stopped extends Error {
  constructor() {
    super("받기를 멈췄습니다");
    this.name = "Stopped";
  }
}

/**
 * 받는 도중 잠깐 멈추거나 아예 그만두게 해준다.
 *
 * 이미 나간 요청을 중간에 끊지는 않는다. 조각 하나는 길어야 몇 초라,
 * 다음 조각을 집지 않는 것만으로 충분히 빨리 멈춘다.
 */
export function createControl() {
  let paused = false;
  let stopped = false;
  let wake = null;

  const release = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  return {
    get paused() {
      return paused;
    },
    get stopped() {
      return stopped;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      release();
    },
    stop() {
      stopped = true;
      paused = false;
      release();
    },
    async gate() {
      if (stopped) throw new Stopped();
      while (paused) {
        await new Promise((resolve) => {
          wake = resolve;
        });
        if (stopped) throw new Stopped();
      }
    },
  };
}

/**
 * 구간에 걸치는 조각들을 받아 저장소에 쌓는다.
 *
 * 이어진 조각은 한 요청으로 묶어 받고(8MB 상한 — mergeRanges), 받은 뒤 조각별로
 * 쪼개 저장한다. 조각 단위로 저장해야 다음에 다른 구간을 받아도 겹치는 만큼 다시 쓴다.
 */
export async function fetchSegments(format, index, start, end, onProgress, control, track, pull) {
  const wanted = segmentsForRange(index.segments, start, end);
  if (!wanted.length) throw new Error("해당 구간에 받을 조각이 없습니다");

  const size = (segment) => segment.end - segment.start + 1;
  const totalBytes = wanted.reduce((sum, s) => sum + size(s), 0);

  // 이미 받아둔 조각은 건너뛴다. 진행률에는 처음부터 받은 것으로 잡힌다.
  const missing = wanted.filter((segment) => !track.has(rangeName(segment)));
  let done = totalBytes - missing.reduce((sum, s) => sum + size(s), 0);
  onProgress?.(done, totalBytes);

  const ranges = mergeRanges(missing);
  await mapWithLimit(ranges, CONCURRENCY, async (range) => {
    const bytes = pull
      ? await pull(format, (url) => fetchRange(url, range.start, range.end))
      : await fetchRange(format.url, range.start, range.end);
    // 묶어 받은 덩어리를 조각 단위로 잘라 저장한다.
    // slice(복사)를 쓴다 — subarray 로 두면 덩어리 전체가 메모리에 붙들린다.
    for (const segment of missing) {
      if (segment.start < range.start || segment.end > range.end) continue;
      const from = segment.start - range.start;
      await track.write(rangeName(segment), bytes.slice(from, from + size(segment)));
    }
    done += bytes.length;
    onProgress?.(done, totalBytes);
  }, control);

  const segments = wanted.map((segment) => ({
    time: segment.time,
    duration: segment.duration,
    name: rangeName(segment),
  }));
  return { segments, totalBytes, firstTime: wanted[0].time };
}

/** 저장해 둔 조각에서 본체(moof+mdat)만 꺼낸다. 라이브 조각에는 앞머리가 붙어 있다. */
async function readMedia(cache, segment) {
  const bytes = await cache.read(segment.name);
  return segment.live ? splitLiveSegment(bytes).media : bytes;
}

/**
 * 트랙의 조각들을 훑어 샘플 표를 만든다. 바이트는 아직 옮기지 않는다.
 *
 * 여기서 나오는 `c0` 이 편집 목록의 기준점이다. 화면에 처음 나오는 시각(= 조각의 시작
 * 시각)이 미디어 시간축에서 어디인지를 뜻한다. B프레임이 있으면 0이 아니다 — 디코딩
 * 순서의 첫 샘플이 화면에서는 첫 장이 아니기 때문이다(유튜브 H.264 는 256, AV1 은 0).
 *
 * `runs` 는 "이어 붙은 샘플 묶음"이다. 대개 조각 하나가 묶음 하나지만, 라이브 조각은
 * moof+mdat 짝이 여럿이라 여러 묶음으로 갈린다. 이 묶음이 곧 mp4 의 덩어리(chunk)다.
 */
async function indexTrack(track, control) {
  const timescale = mediaTimescaleOf(track.init);
  if (!timescale) throw new Error("트랙의 시간 단위를 읽지 못했습니다");

  const samples = [];
  const runs = [];
  let decodeTime = 0;
  let c0 = Infinity;

  for (const segment of track.segments) {
    await control?.gate();
    const read = readSamples(await readMedia(track.cache, segment));
    if (!read) throw new Error("조각의 샘플 표를 읽지 못했습니다");
    let run = null;
    for (const sample of read.samples) {
      const cts = decodeTime + sample.cto;
      if (cts < c0) c0 = cts;
      decodeTime += sample.duration;
      if (run && sample.at === run.at + run.bytes) {
        run.bytes += sample.size;
        run.count += 1;
      } else {
        if (run) runs.push(run);
        run = { segment, at: sample.at, bytes: sample.size, count: 1, time: segment.time };
      }
      samples.push({
        size: sample.size,
        duration: sample.duration,
        cto: sample.cto,
        sync: sample.sync,
        cts,
      });
    }
    if (run) runs.push(run);
  }
  if (!samples.length) throw new Error("해당 구간에 담을 샘플이 없습니다");
  // 조각의 시작 시각이 미디어 시간축에서 어디인가. 우리가 잰 값(c0)과 앞머리가 적어둔
  // 값 중 큰 쪽을 쓴다. 둘은 같은 뜻이지만 한쪽만 있을 때가 있다 — 유튜브 H.264 는
  // 둘 다 256, AV1 은 앞머리에 없어서 c0(0)만, AAC 는 c0 가 0이라 앞머리 값이 있어야 한다.
  return { ...track, timescale, samples, runs, c0: Math.max(c0, editStartOf(track.init)) };
}

/**
 * 뒤쪽을 실제로 잘라낸다. 화면 순서(CTS)로 골라야 B프레임을 빠뜨리지 않는다.
 *
 * 뒤를 자르는 데는 손실이 없다 — 프레임은 디코딩 순서상 자기보다 **앞**의 것만
 * 참조하므로, 뒤를 버려도 남은 것들은 참조할 것을 모두 갖고 있다.
 * 앞은 그럴 수 없어서 편집 목록으로 가린다.
 */
function trimTail(track, endTime) {
  // 눈금 단위로 반올림해서 센다. 초를 곱해 얻은 값은 아주 조금씩 어긋나서
  // (13초가 36095.9995 처럼 나온다), 그대로 비교하면 경계에 딱 맞춘 요청이
  // 프레임 하나만큼 밀린다. 눈금 하나는 0.065ms 라 반올림해도 잃을 것이 없다.
  const limit = Math.round(track.c0 + (endTime - track.firstTime) * track.timescale);
  let keep = 0;
  for (let i = 0; i < track.samples.length; i += 1) {
    if (track.samples[i].cts < limit) keep = i + 1;
  }
  if (!keep) throw new Error("해당 구간에 담을 샘플이 없습니다");
  if (keep >= track.samples.length) {
    return { ...track, chunks: track.runs.map((run) => run.count) };
  }

  const chunks = [];
  const runs = [];
  let seen = 0;
  for (const run of track.runs) {
    if (seen >= keep) break;
    const take = Math.min(run.count, keep - seen);
    let bytes = 0;
    for (let i = 0; i < take; i += 1) bytes += track.samples[seen + i].size;
    runs.push({ ...run, count: take, bytes });
    chunks.push(take);
    seen += take;
  }
  return { ...track, samples: track.samples.slice(0, keep), runs, chunks };
}

/** 고른 지점을 담고 있는 프레임의 시작 시각(초). 없으면 첫 프레임으로. */
function snapToFrame(track, time) {
  const target = Math.round(track.c0 + (time - track.firstTime) * track.timescale);
  let best = track.c0;
  for (const sample of track.samples) {
    if (sample.cts <= target && sample.cts > best) best = sample.cts;
  }
  return track.firstTime + (best - track.c0) / track.timescale;
}

/** 트랙이 화면에 내놓는 마지막 시각(초). 두 트랙 중 이른 쪽에서 파일이 끝나야 한다. */
function trackEndTime(track) {
  let last = 0;
  for (const sample of track.samples) last = Math.max(last, sample.cts + sample.duration);
  return track.firstTime + (last - track.c0) / track.timescale;
}

/**
 * 트랙들을 일반 mp4 하나로 엮어 출력에 흘려 쓴다.
 *
 * 앞은 편집 목록으로 가리고(바이트를 지키면서 정확해지는 길은 이것뿐이다),
 * 뒤는 실제로 잘라낸다(무손실이고, 편집 목록을 무시하는 재생기에서도 정확해진다).
 *
 * 덩어리는 두 트랙을 시간 순서로 번갈아 놓는다. 한쪽을 몰아 놓으면 재생기가 소리를
 * 찾으러 파일 저편까지 건너뛰어야 한다.
 *
 * @param tracks [{cache, init, segments, firstTime}]
 * @returns {{start: number, end: number}} 실제로 담긴 구간(초)
 */
export async function writeProgressive(output, tracks, section, control, onStep) {
  const indexed = [];
  for (const track of tracks) indexed.push(await indexTrack(track, control));

  // 두 트랙이 같은 지점에서 끝나야 한다. 소리 쪽이 더 길면 화면이 멈춘 채 소리만 남는다.
  const endTime = Math.min(section.end, ...indexed.map(trackEndTime));
  const wanted = Math.max(section.start, ...indexed.map((track) => track.firstTime));
  // 영상은 프레임 단위로만 존재한다(60fps 면 16.67ms 마다 한 장). 고른 지점이 프레임
  // 한가운데면, 그 순간 화면에 떠 있던 프레임부터 시작해야 한다. 그러지 않으면 재생기가
  // "지정 시각 이상인 첫 프레임"을 골라 그 장을 통째로 건너뛴다(실측으로 확인했다).
  // 소리는 프레임 제약이 없어 여기 맞추기만 하면 샘플 단위로 정확히 따라온다.
  const anchor = indexed.find((track) => track.snap);
  const startTime = anchor ? snapToFrame(anchor, wanted) : wanted;
  const presentSeconds = Math.max(0, endTime - startTime);

  const parts = indexed.map((track) => {
    const cut = trimTail(track, endTime);
    return {
      ...cut,
      // 앞머리에서 건너뛸 만큼. 조각 시작(c0)에서 고른 지점까지의 거리다.
      editMediaTime: Math.round(cut.c0 + Math.max(0, startTime - cut.firstTime) * cut.timescale),
      presentSeconds,
    };
  });

  const totalBytes = parts.reduce(
    (sum, track) => sum + track.runs.reduce((n, run) => n + run.bytes, 0),
    0,
  );
  // 4GB 를 넘으면 덩어리 위치를 32비트에 못 담는다. 넘칠 것 같으면 64비트 표를 쓴다.
  const largeOffsets = totalBytes > 0xf0000000;
  const { head } = buildHead({ tracks: parts, presentSeconds, largeOffsets });
  const mdat = mdatHeader(totalBytes);

  // 덩어리를 시간 순서로 늘어놓고 자리를 매긴다. 같은 시각이면 영상을 먼저 둔다.
  const order = [];
  parts.forEach((track, index) => {
    track.runs.forEach((run, at) => order.push({ track: index, at, time: run.time, run }));
  });
  order.sort((a, b) => a.time - b.time || a.track - b.track);
  const offsets = parts.map((track) => new Array(track.runs.length));
  let cursor = head.length + mdat.length;
  for (const item of order) {
    offsets[item.track][item.at] = cursor;
    cursor += item.run.bytes;
  }
  fillChunkOffsets(head, offsets);

  await output.write(head);
  await output.write(mdat);
  // 바이트는 여기서 처음이자 마지막으로 옮겨진다. 조각 하나씩 읽어 쓰므로
  // 메모리에는 한 번에 조각 하나만 올라온다.
  let written = 0;
  let open = null;
  for (const item of order) {
    await control?.gate();
    const track = parts[item.track];
    // 같은 조각의 묶음이 이어지면 다시 읽지 않는다(라이브 조각이 그렇다).
    if (!open || open.track !== item.track || open.name !== item.run.segment.name) {
      open = {
        track: item.track,
        name: item.run.segment.name,
        bytes: await readMedia(track.cache, item.run.segment),
      };
    }
    await output.write(open.bytes.subarray(item.run.at, item.run.at + item.run.bytes));
    written += 1;
    onStep?.(written, order.length);
  }
  return { start: startTime, end: endTime };
}

/** 파일 이름에 쓸 수 없는 글자를 지운다. */
export function safeFileName(text, fallback = "video") {
  const cleaned = String(text || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * 파일 이름에 쓸 시각. 1/100초까지 적는다 — 같은 초 안에서 여러 구간을 받아도
 * 이름이 겹치지 않고, 어디를 잘랐는지 이름만 봐도 알 수 있다.
 *
 * 콜론은 파일 이름에 못 쓰므로 하이픈으로, 소수점은 그대로 쓴다(예: `00-01-23.45`).
 */
export function clockLabel(seconds) {
  // 반올림은 쪼개기 전에 한 번만. 나중에 하면 59.996초가 `59.100` 으로 적힌다.
  const total = Math.round(Math.max(0, Number(seconds) || 0) * 100) / 100;
  const whole = Math.floor(total);
  const h = String(Math.floor(whole / 3600)).padStart(2, "0");
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const s = String(whole % 60).padStart(2, "0");
  const frac = String(Math.round((total - whole) * 100)).padStart(2, "0");
  return `${h}-${m}-${s}.${frac}`;
}

/**
 * 구간 하나를 받아 파일(Blob)을 만든다.
 *
 * @param store 저장소(store.js). 안 주면 메모리 저장소를 쓴다(이어받기 없음).
 * @param onProgress (받은 양, 전체 양, 단계 이름)
 * @returns {{file: Blob, mediaStart: number, mediaSeconds: number}}
 *   저장소가 디스크(OPFS)면 file 은 디스크 기반이라 커도 메모리를 먹지 않는다.
 */
export async function downloadSection({
  videoFormat,
  audioFormat,
  start,
  end,
  onProgress,
  control,
  store,
  renewUrl,
}) {
  const media = store || openMemory();
  const pull = makePuller(renewUrl);
  const caches = {
    video: await media.track(videoFormat.itag),
    audio: await media.track(audioFormat.itag),
  };

  // 두 트랙의 진행률을 하나로 합쳐 보여준다.
  const progress = { video: [0, 1, null], audio: [0, 1, null] };
  // 전체 용량 어림은 트랙별로 따로 낸 뒤 합친다. 영상·음성 조각은 크기가 크게 달라서,
  // 섞어서 평균을 내면 작은 음성이 먼저 끝난 뒤 평균이 계속 올라가 어림값이 불어난다.
  const sizeEstimate = () => {
    const tracks = [progress.video, progress.audio];
    if (!tracks.some(([, , size]) => size)) return null;
    let got = 0;
    let estimated = 0;
    for (const [, , size] of tracks) {
      if (!size) continue;
      got += size.bytes;
      estimated += size.estimated;
    }
    return { got, estimated };
  };
  const report = (kind) => (received, expected, size) => {
    progress[kind] = [received, expected, size || null];
    onProgress?.(
      progress.video[0] + progress.audio[0],
      progress.video[1] + progress.audio[1],
      "받는 중",
      sizeEstimate(),
    );
  };

  const live = videoFormat.segmentSeconds > 0 && !videoFormat.indexRange;
  let video;
  let audio;

  if (live) {
    onProgress?.(0, 1, "조각 받는 중");
    // 소리는 영상이 시작하는 지점부터 받아야 한다. 조각 길이가 서로 달라서
    // 같은 시각을 달라고 하면 소리가 영상보다 늦게 시작하는 일이 생긴다.
    const videoHead = Math.floor(start / videoFormat.segmentSeconds) * videoFormat.segmentSeconds;
    [video, audio] = await Promise.all([
      fetchLiveSegments(videoFormat, start, end, report("video"), control, caches.video, pull),
      fetchLiveSegments(audioFormat, videoHead, end, report("audio"), control, caches.audio, pull),
    ]);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const [videoIndex, audioIndex] = await Promise.all([
      fetchIndex(videoFormat, pull),
      fetchIndex(audioFormat, pull),
    ]);
    // 영상은 조각 경계에서만 시작할 수 있다. 소리도 그 지점부터 받아야
    // 두 트랙이 같은 곳에서 시작한다. 그러지 않으면 소리가 늦게 시작해 앞서 간다.
    const videoHead = segmentsForRange(videoIndex.segments, start, end)[0]?.time ?? start;
    const [videoParts, audioParts] = await Promise.all([
      fetchSegments(videoFormat, videoIndex, start, end, report("video"), control, caches.video, pull),
      fetchSegments(audioFormat, audioIndex, videoHead, end, report("audio"), control, caches.audio, pull),
    ]);
    video = { init: videoIndex.init, ...videoParts };
    audio = { init: audioIndex.init, ...audioParts };
  }

  onProgress?.(0, 1, "합치는 중");
  const output = await media.output();
  let file;
  let span;
  try {
    span = await writeProgressive(
      output,
      [
        { ...video, cache: caches.video, snap: true },
        { ...audio, cache: caches.audio },
      ],
      { start, end },
      control,
      (step, steps) => onProgress?.(step, steps, "합치는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }

  // 조각은 통째로 받지만 파일은 고른 구간만 내놓는다(앞은 편집 목록, 뒤는 실제로 잘라냄).
  // 영상은 프레임 단위라 시작이 한 프레임 안쪽에서 당겨질 수 있어, 실제 값을 그대로 알린다.
  return {
    file,
    mediaStart: span.start,
    mediaEnd: span.end,
    mediaSeconds: Math.max(0, span.end - span.start),
  };
}

/**
 * 트랙 하나만 골라 파일로 만든다. 앞머리는 원본 그대로라 트랙을 합칠 일이 없다.
 *
 * 영상은 키프레임(조각 경계)에서만 자를 수 있어 조각을 통째로 담고,
 * 소리는 샘플 단위로 잘라 요청한 구간에 정확히 맞춘다.
 *
 * @param kind "video" 또는 "audio"
 * @returns downloadSection 과 같은 모양: {file, mediaStart, mediaEnd, mediaSeconds}
 */
export async function downloadTrack({ format, kind, start, end, onProgress, control, store, renewUrl }) {
  const media = store || openMemory();
  const pull = makePuller(renewUrl);
  const cache = await media.track(format.itag);
  const report = (done, total, size) => {
    onProgress?.(done, total, "받는 중", size && { got: size.bytes, estimated: size.estimated });
  };

  const live = format.segmentSeconds > 0 && !format.indexRange;
  let track;
  if (live) {
    onProgress?.(0, 1, "조각 받는 중");
    track = await fetchLiveSegments(format, start, end, report, control, cache, pull);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const index = await fetchIndex(format, pull);
    const parts = await fetchSegments(format, index, start, end, report, control, cache, pull);
    track = { init: index.init, ...parts };
  }

  onProgress?.(0, 1, "파일 만드는 중");
  const output = await media.output();
  let file;
  let span;
  try {
    span = await writeProgressive(
      output,
      // 영상만 받을 때는 프레임에 맞춰 당기고, 소리만 받을 때는 그럴 것이 없다.
      [{ ...track, cache, snap: kind === "video" }],
      { start, end },
      control,
      (step, steps) => onProgress?.(step, steps, "파일 만드는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }
  return {
    file,
    mediaStart: span.start,
    mediaEnd: span.end,
    mediaSeconds: Math.max(0, span.end - span.start),
  };
}
