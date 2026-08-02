// 고른 구간만 받아서 재생 가능한 mp4 하나로 만든다.
//
// 브라우저 API(fetch)만 쓴다. 확장의 content script 는 youtube.com 오리진에서 돌기 때문에
// InnerTube 는 동일 출처로, googlevideo 는 Range 를 허용하는 CORS 로 그대로 부를 수 있다.

import { fetchPlayerResponse, fetchVisitorData, readFormats } from "./innertube.js";
import { mergeRanges, parseSidx, segmentsForRange } from "./mp4index.js";
import {
  combineInit,
  concat,
  firstDecodeTime,
  patchDurations,
  rebaseDecodeTimes,
  retagFragments,
} from "./mp4mux.js";

/** 한 번에 보내는 요청 수. 너무 늘리면 유튜브가 속도를 깎는다. */
const CONCURRENCY = 6;

export async function getFormats(videoId, visitorData) {
  const visitor = visitorData || (await fetchVisitorData());
  const player = await fetchPlayerResponse(videoId, visitor);
  return readFormats(player);
}

async function fetchRange(url, start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!response.ok) throw new Error(`조각을 받지 못했습니다 (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 앞머리(init)와 조각 색인(sidx)을 한 번에 받아 온다. 둘이 파일 맨 앞에 붙어 있다. */
export async function fetchIndex(format) {
  const head = await fetchRange(format.url, 0, format.indexRange.end);
  const init = head.subarray(format.initRange.start, format.initRange.end + 1);
  const index = parseSidx(head, format.indexRange.end);
  return { init: init.slice(), ...index };
}

/** 여러 요청을 동시에 보내되, 결과 순서는 그대로 지킨다. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 구간에 걸치는 조각들을 받아 온다.
 *
 * 이어진 조각은 한 요청으로 묶어 받고, 받은 뒤 다시 조각별로 쪼갠다.
 * 조각 단위를 유지해야 영상과 소리를 시간 순서대로 섞을 수 있다.
 */
export async function fetchSegments(format, index, start, end, onProgress) {
  const wanted = segmentsForRange(index.segments, start, end);
  if (!wanted.length) throw new Error("해당 구간에 받을 조각이 없습니다");

  const ranges = mergeRanges(wanted);
  const totalBytes = wanted.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  let done = 0;

  const chunks = await mapWithLimit(ranges, CONCURRENCY, async (range) => {
    const bytes = await fetchRange(format.url, range.start, range.end);
    done += bytes.length;
    onProgress?.(done, totalBytes);
    return { range, bytes };
  });

  // 묶어 받은 덩어리를 다시 조각 단위로 되돌린다.
  const out = [];
  for (const segment of wanted) {
    const chunk = chunks.find(
      ({ range }) => segment.start >= range.start && segment.end <= range.end,
    );
    if (!chunk) throw new Error("받은 조각이 어긋났습니다");
    const from = segment.start - chunk.range.start;
    out.push({
      time: segment.time,
      duration: segment.duration,
      bytes: chunk.bytes.subarray(from, from + (segment.end - segment.start + 1)),
    });
  }
  return { segments: out, totalBytes, firstTime: wanted[0].time };
}

/**
 * 영상 조각과 소리 조각을 하나의 mp4 로 엮는다.
 *
 * 앞머리는 트랙 두 개짜리로 새로 쓰고, 조각은 시간 순서대로 번갈아 넣는다.
 * 같은 시각이면 영상을 먼저 둔다(재생기가 화면부터 준비하도록).
 */
export function buildMp4(video, audio, section) {
  // 조각은 통째로만 받을 수 있어서 요청한 구간보다 앞뒤로 조금 넓다.
  // 편집 목록으로 "여기부터 이만큼만 보여줘"라고 적어 정확히 맞춘다.
  const edits = section
    ? {
        video: {
          skip: Math.max(0, section.start - (video.segments[0]?.time ?? 0)),
          seconds: section.end - section.start,
        },
        audio: {
          skip: Math.max(0, section.start - (audio.segments[0]?.time ?? 0)),
          seconds: section.end - section.start,
        },
      }
    : null;

  const { init, audioTrackId } = combineInit(video.init, audio.init, edits);

  // 각 트랙의 첫 조각이 들고 있는 시각만큼 전체를 앞으로 당겨 0에서 시작하게 한다.
  const videoBase = video.segments.length ? firstDecodeTime(video.segments[0].bytes) : 0;
  const audioBase = audio.segments.length ? firstDecodeTime(audio.segments[0].bytes) : 0;

  const timeline = [
    ...video.segments.map((segment) => ({
      time: segment.time,
      kind: 0,
      bytes: rebaseDecodeTimes(segment.bytes, videoBase),
    })),
    ...audio.segments.map((segment) => ({
      time: segment.time,
      kind: 1,
      bytes: rebaseDecodeTimes(retagFragments(segment.bytes, audioTrackId), audioBase),
    })),
  ].sort((a, b) => a.time - b.time || a.kind - b.kind);

  const seconds = section
    ? section.end - section.start
    : sectionSeconds(video.segments) || sectionSeconds(audio.segments);
  return concat([patchDurations(init, seconds), ...timeline.map((item) => item.bytes)]);
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
 * 구간 하나를 받아 파일 바이트를 만든다.
 *
 * @param onProgress (받은 바이트, 전체 바이트, 단계 이름)
 */
export async function downloadSection({ videoFormat, audioFormat, start, end, onProgress }) {
  onProgress?.(0, 1, "색인 읽는 중");
  const [videoIndex, audioIndex] = await Promise.all([
    fetchIndex(videoFormat),
    fetchIndex(audioFormat),
  ]);

  // 두 트랙의 진행률을 하나로 합쳐 보여준다.
  const progress = { video: [0, 1], audio: [0, 1] };
  const report = (kind) => (done, total) => {
    progress[kind] = [done, total];
    const received = progress.video[0] + progress.audio[0];
    const expected = progress.video[1] + progress.audio[1];
    onProgress?.(received, expected, "받는 중");
  };

  const [video, audio] = await Promise.all([
    fetchSegments(videoFormat, videoIndex, start, end, report("video")),
    fetchSegments(audioFormat, audioIndex, start, end, report("audio")),
  ]);

  onProgress?.(1, 1, "합치는 중");
  const bytes = buildMp4(
    { init: videoIndex.init, ...video },
    { init: audioIndex.init, ...audio },
    { start, end },
  );
  return { bytes };
}
