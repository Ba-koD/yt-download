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
import {
  combineInit,
  splitLiveSegment,
  dropLeadingSamples,
  dropTrailingSamples,
  firstDecodeTime,
  mediaTimescaleOf,
  patchDurations,
  rebaseDecodeTimes,
  retagFragments,
} from "./mp4mux.js";

/** 한 번에 보내는 요청 수. 너무 늘리면 유튜브가 속도를 깎는다. */
const CONCURRENCY = 6;

export async function getFormats(videoId, visitorData, unlock) {
  const visitor = visitorData || (await fetchVisitorData());
  const player = await fetchPlayerResponse(videoId, visitor);
  const formats = readFormats(player);

  // 로그인해야 볼 수 있는 영상의 주소에는 `n` 이 붙어 있고, 풀지 않으면 403 이다.
  // 공개 영상 주소에는 아예 없으므로 이 길로 오지 않는다.
  const tracks = [...formats.video, ...formats.audio];
  if (unlock && tracks.some((track) => track.url.includes("n="))) {
    const solved = await unlock(tracks.map((track) => track.url));
    tracks.forEach((track, index) => {
      track.url = solved[index];
    });
  }
  return formats;
}

async function fetchRange(url, start, end) {
  return request.bytes(url, { Range: `bytes=${start}-${end}` });
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
export async function fetchLiveSegments(format, start, end, onProgress, control, track) {
  const step = format.segmentSeconds;
  if (!(step > 0)) throw new Error("조각 길이를 알 수 없습니다");

  const first = Math.max(0, Math.floor(Math.min(start, end) / step));
  const last = Math.max(first, Math.floor(Math.max(start, end) / step));
  const numbers = [];
  for (let sq = first; sq <= last; sq += 1) numbers.push(sq);

  // 이미 받아둔 조각은 건너뛴다. 진행률에는 처음부터 받은 것으로 잡힌다.
  const missing = numbers.filter((sq) => !track.has(liveName(sq)));
  let done = numbers.length - missing.length;
  // 이번에 실제로 받은 용량과 조각 수. 조각당 평균 크기로 전체 용량을 어림하는 데 쓴다.
  let gotBytes = 0;
  let fetched = 0;
  onProgress?.(done, numbers.length, { bytes: 0, fetched: 0 });

  await mapWithLimit(missing, CONCURRENCY, async (sq) => {
    const bytes = await request.bytes(`${format.url}&sq=${sq}`, {});
    await track.write(liveName(sq), bytes);
    done += 1;
    gotBytes += bytes.length;
    fetched += 1;
    onProgress?.(done, numbers.length, { bytes: gotBytes, fetched });
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

/** 앞머리(init)와 조각 색인(sidx)을 한 번에 받아 온다. 둘이 파일 맨 앞에 붙어 있다. */
export async function fetchIndex(format) {
  const head = await fetchRange(format.url, 0, format.indexRange.end);
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
      // 조각을 새로 집기 직전에만 멈춘다. 이미 나간 요청은 그대로 끝나게 둔다.
      await control?.gate();
      const index = next;
      next += 1;
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
export async function fetchSegments(format, index, start, end, onProgress, control, track) {
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
    const bytes = await fetchRange(format.url, range.start, range.end);
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

/**
 * 영상 조각과 소리 조각을 하나의 mp4 로 엮어 출력에 흘려 쓴다.
 *
 * 앞머리는 트랙 두 개짜리로 새로 쓰고, 조각은 시간 순서대로 번갈아 넣는다.
 * 같은 시각이면 영상을 먼저 둔다(재생기가 화면부터 준비하도록).
 * 조각 바이트는 저장소에서 하나씩 읽어 쓰므로 메모리에는 한 번에 조각 하나만 있다.
 */
export async function writeMp4(output, caches, video, audio, section, control, onStep) {
  // 영상과 소리는 조각 길이가 달라서(영상 5초, 소리 10초 같은 식) 구간을 잡으면
  // 두 트랙이 서로 다른 지점에서 시작한다. 영상은 키프레임에서만 자를 수 있으므로
  // 영상 조각의 시작을 기준으로 삼고, 소리 쪽 앞부분을 그만큼 실제로 버린다.
  // 이렇게 해두면 편집 목록을 무시하는 재생기에서도 소리가 어긋나지 않는다.
  const mediaStart = video.segments[0]?.time ?? 0;
  const audioStart = audio.segments[0]?.time ?? 0;
  const audioLead = Math.max(0, mediaStart - audioStart);
  const audioTimescale = mediaTimescaleOf(audio.init);
  // 영상 트랙이 끝나는 지점. 소리도 여기서 끝나야 한다 — 소리 조각이 더 길면
  // (조각이 긴 라이브에서 두드러진다) 영상이 멈춘 채 소리만 계속 나온다.
  const lastVideo = video.segments[video.segments.length - 1];
  const videoEnd = lastVideo ? lastVideo.time + (lastVideo.duration || 0) : Infinity;

  const readMedia = async (kind, segment) => {
    const bytes = await caches[kind].read(segment.name);
    // 라이브 조각은 통째로 저장돼 있다(앞머리 포함). 본체만 꺼낸다.
    return segment.live ? splitLiveSegment(bytes).media : bytes;
  };

  // 소리 조각별로 앞에서 얼마나 잘라낼지 미리 정한다(바이트는 아직 읽지 않는다).
  const audioPlan = [];
  let toDrop = audioLead;
  for (const segment of audio.segments) {
    if (toDrop <= 0) {
      audioPlan.push({ segment, trim: 0, time: segment.time });
    } else {
      audioPlan.push({ segment, trim: toDrop, time: Math.max(segment.time, mediaStart) });
      toDrop -= segment.duration || 0;
    }
  }
  const trimmedAudio = async (plan) => {
    let bytes = await readMedia("audio", plan.segment);
    // 통째로 버려야 하는 조각이면 null 이 돌아온다.
    if (plan.trim > 0) bytes = dropLeadingSamples(bytes, plan.trim, audioTimescale);
    if (!bytes) return null;
    // 영상이 끝나는 지점 뒤의 소리는 잘라낸다(남은 앞부분 기준으로 남길 길이를 잰다).
    return dropTrailingSamples(bytes, videoEnd - (plan.segment.time + plan.trim), audioTimescale);
  };

  // 기준 시각을 얻기 위해 첫 조각들만 먼저 읽는다. 읽은 것은 아래에서 한 번만 다시 쓴다.
  //
  // 두 트랙 모두 같은 지점을 0으로 삼아야 서로 어긋나지 않는다.
  // 소리가 영상보다 늦게 시작할 수도 있다(조각 경계가 서로 다르니까).
  // 그때 소리를 0초에 붙여버리면 그 차이만큼 소리가 앞서 간다. 늦은 만큼 뒤로 민다.
  const firstVideoBytes = video.segments.length
    ? await readMedia("video", video.segments[0])
    : null;
  let firstAudio = null; // { index, bytes } — 잘라내고도 살아남은 첫 소리 조각
  for (let i = 0; i < audioPlan.length; i += 1) {
    const bytes = await trimmedAudio(audioPlan[i]);
    if (bytes) {
      firstAudio = { index: i, bytes };
      break;
    }
  }
  const videoBase = firstVideoBytes ? firstDecodeTime(firstVideoBytes) : 0;
  const audioBase = firstAudio ? firstDecodeTime(firstAudio.bytes) : 0;
  const audioLate = Math.max(
    0,
    (firstAudio ? audioPlan[firstAudio.index].time : mediaStart) - mediaStart,
  );
  const audioOrigin = audioBase - audioLate * audioTimescale;

  // 앞부분을 편집 목록(elst)으로 건너뛰게 하면 안 된다.
  //
  // 영상은 키프레임에서만 자를 수 있어 요청한 지점보다 조금 앞에서 시작한다.
  // 예전에는 그 앞부분을 건너뛰라고 편집 목록에 적어뒀는데, 재생기가 그 지시를
  // **소리에만** 적용하고 영상은 앞부분을 그대로 두더라(디코딩에 필요하니까).
  // 그래서 소리가 5초쯤 앞서 갔다. 실측한 값이다.
  //
  //   소리 밀림 4.96초 / 화면 밀림 0.00초 → 어긋남 4.96초
  //
  // 앞은 손대지 않고 뒤 길이만 맞춘다. 두 트랙이 항상 같이 간다.
  // 대신 파일이 요청보다 몇 초 앞에서 시작하는데, 그건 부르는 쪽에서 알려준다.
  // 파일에 적는 길이는 실제 담긴 내용과 같아야 한다. 뒤쪽도 조각 경계까지 담기므로
  // 요청한 구간이 아니라 영상 트랙의 실제 끝(videoEnd)을 기준으로 잰다.
  const span = Number.isFinite(videoEnd)
    ? videoEnd - mediaStart
    : sectionSeconds(video.segments) || sectionSeconds(audio.segments);
  const { init, audioTrackId } = combineInit(
    video.init,
    audio.init,
    section ? { video: { skip: 0, seconds: span }, audio: { skip: 0, seconds: span } } : null,
  );
  await output.write(patchDurations(init, span));

  // 시간 순서대로 두 트랙을 번갈아 쓴다. 같은 시각이면 영상 먼저.
  const steps = video.segments.length + audioPlan.length;
  let written = 0;
  let vi = 0;
  let ai = 0;
  while (vi < video.segments.length || ai < audioPlan.length) {
    await control?.gate();
    const v = video.segments[vi];
    const a = audioPlan[ai];
    if (v && (!a || v.time <= a.time)) {
      const bytes = vi === 0 && firstVideoBytes ? firstVideoBytes : await readMedia("video", v);
      await output.write(rebaseDecodeTimes(bytes, videoBase));
      vi += 1;
    } else {
      let bytes = null;
      if (firstAudio && ai === firstAudio.index) bytes = firstAudio.bytes;
      else if (!firstAudio || ai > firstAudio.index) bytes = await trimmedAudio(a);
      // firstAudio 앞의 조각들은 통째로 버려진 것들이다(bytes = null 그대로).
      if (bytes) {
        await output.write(rebaseDecodeTimes(retagFragments(bytes, audioTrackId), audioOrigin));
      }
      ai += 1;
    }
    written += 1;
    onStep?.(written, steps);
  }
}

function sectionSeconds(segments) {
  if (!segments.length) return 0;
  const last = segments[segments.length - 1];
  return last.time + (last.duration || 0) - segments[0].time;
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

export function clockLabel(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}-${m}-${s}`;
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
}) {
  const media = store || openMemory();
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
    for (const [, expected, size] of tracks) {
      if (!size) continue;
      got += size.bytes;
      if (size.fetched > 0) estimated += (size.bytes / size.fetched) * expected;
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
      fetchLiveSegments(videoFormat, start, end, report("video"), control, caches.video),
      fetchLiveSegments(audioFormat, videoHead, end, report("audio"), control, caches.audio),
    ]);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const [videoIndex, audioIndex] = await Promise.all([
      fetchIndex(videoFormat),
      fetchIndex(audioFormat),
    ]);
    // 영상은 조각 경계에서만 시작할 수 있다. 소리도 그 지점부터 받아야
    // 두 트랙이 같은 곳에서 시작한다. 그러지 않으면 소리가 늦게 시작해 앞서 간다.
    const videoHead = segmentsForRange(videoIndex.segments, start, end)[0]?.time ?? start;
    const [videoParts, audioParts] = await Promise.all([
      fetchSegments(videoFormat, videoIndex, start, end, report("video"), control, caches.video),
      fetchSegments(audioFormat, audioIndex, videoHead, end, report("audio"), control, caches.audio),
    ]);
    video = { init: videoIndex.init, ...videoParts };
    audio = { init: audioIndex.init, ...audioParts };
  }

  onProgress?.(0, 1, "합치는 중");
  const output = await media.output();
  let file;
  try {
    await writeMp4(output, caches, video, audio, { start, end }, control, (step, steps) =>
      onProgress?.(step, steps, "합치는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }

  // 조각을 통째로 받으므로 파일은 요청보다 앞에서 시작하고 뒤로도 조금 길다. 그대로 알려준다.
  const mediaStart = video.segments[0]?.time ?? start;
  const lastSegment = video.segments[video.segments.length - 1];
  const mediaEnd = lastSegment ? lastSegment.time + (lastSegment.duration || 0) : end;
  return { file, mediaStart, mediaEnd, mediaSeconds: Math.max(0, mediaEnd - mediaStart) };
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
export async function downloadTrack({ format, kind, start, end, onProgress, control, store }) {
  const media = store || openMemory();
  const cache = await media.track(format.itag);
  const report = (done, total, size) =>
    onProgress?.(
      done,
      total,
      "받는 중",
      size && {
        got: size.bytes,
        estimated: size.fetched > 0 ? (size.bytes / size.fetched) * total : 0,
      },
    );

  const live = format.segmentSeconds > 0 && !format.indexRange;
  let track;
  if (live) {
    onProgress?.(0, 1, "조각 받는 중");
    track = await fetchLiveSegments(format, start, end, report, control, cache);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const index = await fetchIndex(format);
    const parts = await fetchSegments(format, index, start, end, report, control, cache);
    track = { init: index.init, ...parts };
  }

  onProgress?.(0, 1, "파일 만드는 중");
  const output = await media.output();
  let file;
  let span;
  try {
    span = await writeTrack(output, cache, track, kind, { start, end }, control, (step, steps) =>
      onProgress?.(step, steps, "파일 만드는 중"),
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

/**
 * 트랙 하나를 출력에 흘려 쓴다. 조각의 시각을 0에서 시작하도록 옮기는 것은
 * writeMp4 와 같지만, 트랙이 하나뿐이라 서로 맞출 상대가 없어 훨씬 단순하다.
 */
export async function writeTrack(output, cache, track, kind, section, control, onStep) {
  const timescale = mediaTimescaleOf(track.init);
  const readMedia = async (segment) => {
    const bytes = await cache.read(segment.name);
    // 라이브 조각은 통째로 저장돼 있다(앞머리 포함). 본체만 꺼낸다.
    return segment.live ? splitLiveSegment(bytes).media : bytes;
  };

  const segments = track.segments;
  const first = segments[0]?.time ?? section.start;
  const last = segments[segments.length - 1];
  const tail = last ? last.time + (last.duration || 0) : section.end;

  // 소리(AAC)는 샘플마다 독립이라 요청한 지점에서 그대로 자른다. 영상은 조각째 둔다.
  const trim = kind === "audio";
  const startAt = trim ? Math.min(Math.max(section.start, first), tail) : first;
  const endAt = trim ? Math.min(tail, Math.max(section.end, startAt)) : tail;

  // 조각별로 앞에서 얼마나 버릴지 정한다(writeMp4 의 소리 계획과 같은 방식).
  const plan = [];
  let toDrop = trim ? Math.max(0, startAt - first) : 0;
  for (const segment of segments) {
    if (toDrop <= 0) {
      plan.push({ segment, trim: 0 });
    } else {
      plan.push({ segment, trim: toDrop });
      toDrop -= segment.duration || 0;
    }
  }
  const readKept = async (item) => {
    let bytes = await readMedia(item.segment);
    if (item.trim > 0) bytes = dropLeadingSamples(bytes, item.trim, timescale);
    if (!bytes || !trim) return bytes;
    // 요청한 끝 지점 뒤의 샘플은 잘라낸다(남은 앞부분 기준으로 남길 길이를 잰다).
    return dropTrailingSamples(bytes, endAt - (item.segment.time + item.trim), timescale);
  };

  // 잘라내고도 살아남은 첫 조각이 시간축의 0이 된다.
  let firstKept = null;
  for (let index = 0; index < plan.length; index += 1) {
    const bytes = await readKept(plan[index]);
    if (bytes) {
      firstKept = { index, bytes };
      break;
    }
  }
  if (!firstKept) throw new Error("해당 구간에 남길 조각이 없습니다");
  const base = firstDecodeTime(firstKept.bytes);

  await output.write(patchDurations(track.init, Math.max(0, endAt - startAt)));

  const steps = plan.length - firstKept.index;
  let written = 0;
  for (let index = firstKept.index; index < plan.length; index += 1) {
    await control?.gate();
    const bytes = index === firstKept.index ? firstKept.bytes : await readKept(plan[index]);
    if (bytes) await output.write(rebaseDecodeTimes(bytes, base));
    written += 1;
    onStep?.(written, steps);
  }
  return { start: startAt, end: endAt };
}
