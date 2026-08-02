// 유튜브 내부 API(InnerTube)에서 실제 다운로드 주소를 받아온다.
//
// 웹 클라이언트로 물어보면 요즘은 주소를 주지 않는다(SABR 로 넘어갔다).
// 반면 ANDROID_VR 클라이언트로 물어보면 포맷마다 직접 주소를 주고,
// 그 주소에는 속도 제한용 n 파라미터도 붙지 않아 서명 해독이 필요 없다.

import { request } from "./net.js";

const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

// 이 클라이언트 정보가 낡으면 유튜브가 주소를 주지 않는다. 가장 먼저 의심할 곳이다.
export const CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  androidSdkVersion: 32,
  osName: "Android",
  osVersion: "12L",
  hl: "en",
  gl: "US",
};

export function buildPlayerRequest(videoId, visitorData, client = CLIENT) {
  return {
    videoId,
    context: { client: { ...client, visitorData: visitorData || "" } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

/** 유튜브 첫 화면에서 방문자 ID를 얻는다. 이게 없으면 로그인하라는 답이 온다. */
export async function fetchVisitorData() {
  return extractVisitorData(await request.text("https://www.youtube.com/"));
}

export function extractVisitorData(html) {
  const match =
    html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) || html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * 내 비공개 영상을 물어볼 때 쓰는 클라이언트.
 *
 * ANDROID_VR 은 로그인 정보를 받아주지 않아서 "Please sign in" 으로 끝난다.
 * 창작자용 클라이언트는 쿠키를 인정하므로 내가 올린 비공개 영상도 주소를 준다.
 */
const CREATOR_CLIENT = {
  clientName: "WEB_CREATOR",
  clientVersion: "1.20250219.00.00",
  hl: "ko",
  gl: "KR",
};

export async function fetchPlayerResponse(videoId, visitorData) {
  const first = await requestPlayer(videoId, visitorData, CLIENT);
  const status = first?.playabilityStatus?.status;
  // 로그인해야 볼 수 있는 영상이면 창작자용 클라이언트로 한 번 더 물어본다.
  if (status && status !== "OK") {
    try {
      const second = await requestPlayer(videoId, visitorData, CREATOR_CLIENT);
      if (second?.playabilityStatus?.status === "OK") return second;
    } catch {
      // 두 번째 시도는 실패해도 첫 번째 결과의 이유를 그대로 보여준다.
    }
  }
  return first;
}

function requestPlayer(videoId, visitorData, client) {
  return request.json(PLAYER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Visitor-Id": visitorData || "",
    },
    body: JSON.stringify(buildPlayerRequest(videoId, visitorData, client)),
  });
}

/**
 * 쓸 만한 포맷만 골라 정리한다.
 *
 * 지금은 mp4 만 다룬다. mp4 는 sidx 색인이 있어서 구간을 바이트로 옮길 수 있고,
 * 4K 도 AV1 로 mp4 에 담겨 나온다. webm(VP9/Opus)은 색인 방식이 달라 아직 제외한다.
 */
export function readFormats(playerResponse) {
  const status = playerResponse?.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = playerResponse.playabilityStatus.reason || status;
    throw new Error(`재생할 수 없는 영상입니다: ${reason}`);
  }

  const all = playerResponse?.streamingData?.adaptiveFormats || [];
  // 두 가지 방식이 있다.
  // - 일반 영상: 파일 하나에 색인(sidx)이 있어 필요한 바이트만 집어온다.
  // - 라이브: 색인이 없고 조각 번호(`&sq=N`)로 하나씩 받는다. 조각 길이는 targetDurationSec.
  const usable = all.filter(
    (format) =>
      format.url &&
      isMp4(format) &&
      ((format.indexRange && format.initRange) || format.targetDurationSec > 0),
  );

  const video = usable
    .filter((format) => format.mimeType.startsWith("video/"))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const audio = usable
    .filter((format) => format.mimeType.startsWith("audio/"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return {
    video: video.map(describe),
    audio: audio.map(describe),
    durationSeconds: Number(playerResponse?.videoDetails?.lengthSeconds || 0),
    title: playerResponse?.videoDetails?.title || "",
    isLive: Boolean(playerResponse?.videoDetails?.isLiveContent),
    // 라이브·지난 라이브는 조각(`&sq=N`) 방식이라 mp4 에 색인이 없다.
    // 왜 못 받는지 구분해서 알려주려고 따로 표시해 둔다.
    liveWithoutIndex: all.length > 0 && usable.length === 0 && all.some(isSegmentedLive),
  };
}

/// 색인 대신 조각 목록으로 오는 포맷인지. 라이브가 여기에 해당한다.
function isSegmentedLive(format) {
  return Boolean(format.url) && !format.indexRange;
}

function isMp4(format) {
  return format.mimeType.includes("mp4");
}

function describe(format) {
  return {
    itag: format.itag,
    url: format.url,
    mimeType: format.mimeType,
    codec: (format.mimeType.match(/codecs="([^"]+)"/) || [])[1] || "",
    width: format.width,
    height: format.height,
    fps: format.fps,
    bitrate: format.bitrate,
    qualityLabel: format.qualityLabel,
    contentLength: Number(format.contentLength || 0),
    initRange: numericRange(format.initRange),
    indexRange: numericRange(format.indexRange),
    // 라이브 조각 하나의 길이(초). 이 값이 있으면 조각 번호로 받아야 한다.
    segmentSeconds: Number(format.targetDurationSec) || 0,
  };
}

function numericRange(range) {
  return range ? { start: Number(range.start), end: Number(range.end) } : null;
}

/** 화면에 보여줄 짧은 이름. */
export function formatLabel(format) {
  if (format.mimeType.startsWith("audio/")) {
    return `${Math.round((format.bitrate || 0) / 1000)}kbps ${shortCodec(format.codec)}`;
  }
  const fps = format.fps && format.fps > 30 ? format.fps : "";
  return `${format.qualityLabel || `${format.height}p`}${fps ? "" : ""} ${shortCodec(format.codec)}`;
}

export function shortCodec(codec) {
  if (codec.startsWith("avc1")) return "H.264";
  if (codec.startsWith("av01")) return "AV1";
  if (codec.startsWith("vp9") || codec.startsWith("vp09")) return "VP9";
  if (codec.startsWith("mp4a")) return "AAC";
  if (codec.startsWith("opus")) return "Opus";
  return codec;
}
