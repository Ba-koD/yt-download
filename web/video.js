// 영상 정보 불러오기와 화면 반영.

import { api, baseRequest } from "./api.js";
import { extractYouTubeId, formatClock, resolutionLabel } from "./format.js";
import { loadPlayer, resetLivePreviewState, stopSegmentPlayback } from "./player.js";
import { saveSettings } from "./settings.js";
import { el, state } from "./state.js";
import { resetView, selectedCoversWholeVideo, setRangeValues, updatePlayhead } from "./timeline.js";
import { setBusy, setMessage } from "./ui.js";

export async function loadMetadata() {
  const url = el.urlInput.value.trim();
  if (!url) {
    setMessage("영상 주소를 입력하세요.", true);
    return;
  }

  // 정보 조회는 유튜브에서 여러 번 받아와야 해서 몇 초 걸린다.
  // 주소만 있으면 미리보기는 바로 띄울 수 있으므로 기다리지 않고 먼저 보여준다.
  const videoId = extractYouTubeId(url);
  if (videoId) loadPlayer(videoId);

  const token = (state.metadataToken = (state.metadataToken || 0) + 1);
  setBusy(true);
  setMessage("영상 정보를 불러오는 중");
  try {
    const data = await api("/api/metadata", {
      method: "POST",
      body: JSON.stringify(baseRequest({ url })),
    });
    // 그 사이 다른 주소를 불러왔으면 늦게 온 응답은 버린다.
    if (token !== state.metadataToken) return;
    state.metadata = data;
    renderMetadata(data);
    el.downloadButton.disabled = false;
    setMessage("정보 로드 완료");
  } catch (error) {
    if (token !== state.metadataToken) return;
    setMessage(error.message, true);
  } finally {
    if (token === state.metadataToken) setBusy(false);
  }
}

// 주소를 붙여넣으면 알아서 불러온다(버튼을 누르러 갈 필요가 없다).
export function watchUrlInput() {
  let timer = null;
  el.urlInput.addEventListener("input", () => {
    const id = extractYouTubeId(el.urlInput.value.trim());
    if (!id || id === state.loadedVideoId) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.loadedVideoId = id;
      loadMetadata();
    }, 400);
  });
}

export function renderMetadata(data) {
  stopSegmentPlayback();
  state.userEditedRange = false;
  resetLivePreviewState();
  el.videoTitle.textContent = data.title || "제목 없음";

  const bits = [];
  if (data.uploader) bits.push(data.uploader);
  const status = liveStatusLabel(data.live_status);
  if (status) bits.push(status);
  if (data.duration) bits.push(formatClock(data.duration));
  if (data.max_height) bits.push(`최대 ${resolutionLabel(data.max_height)}`);
  el.videoMeta.textContent = bits.join(" · ") || "메타데이터 로드됨";
  applyPreviewRatio(data);
  updateQualityOptions(data);

  if (data.thumbnail) {
    el.thumbnail.src = data.thumbnail;
  } else {
    el.thumbnail.removeAttribute("src");
  }

  const videoId = data.id || extractYouTubeId(el.urlInput.value);
  if (videoId) {
    state.loadedVideoId = videoId;
    loadPlayer(videoId);
  }

  // 진행 중인 라이브는 유튜브가 조각을 내주기까지 몇 분 걸린다.
  // 아직 못 받는 구간을 고를 수 있으면 미리보기와 결과가 어긋나므로 실제 받을 수 있는 끝까지만 쓴다.
  const duration = Number(data.live_edge || data.duration || 0);
  if (duration > 0) {
    state.duration = duration;
    state.durationEstimated = false;
    if (isActiveLiveMetadata()) {
      state.liveDurationAtLoad = duration;
      state.liveLoadedAt = Date.now() / 1000;
      state.liveEdgeDelay = Math.max(0, Number(data.duration || 0) - duration);
    }
  } else {
    state.duration = 3600;
    state.durationEstimated = true;
  }
  setRangeValues(0, state.duration, "start");
  updateDurationLabel();
  resetView();
  updatePlayhead(0);
  updateLiveHint();
}

// 세로 영상(Shorts)이나 4:3 영상도 검은 여백 없이 보이도록 미리보기 비율을 맞춘다.
// yt-dlp가 주는 상태값을 그대로 보여주면 알아보기 어렵다.
function liveStatusLabel(status) {
  return {
    is_live: "라이브 중",
    post_live: "다시보기 준비 중",
    was_live: "지난 라이브",
    is_upcoming: "예정된 라이브",
  }[status] || "";
}

export function applyPreviewRatio(data) {
  const width = Number(data?.width || 0);
  const height = Number(data?.height || 0);
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  el.previewFrame.style.setProperty("--preview-ratio", ratio.toFixed(4));
}

// 이 영상에 없는 화질은 고를 수 없게 하고, 최고 화질이 뭔지 알려준다.
export function updateQualityOptions(data) {
  const max = Number(data?.max_height || 0);
  for (const option of el.qualityMode.options) {
    const value = Number(option.value);
    if (!value) {
      option.textContent = max ? `최고 (${resolutionLabel(max)})` : "최고 화질";
      continue;
    }
    option.disabled = Boolean(max) && value > max;
    option.hidden = option.disabled;
  }
  if (el.qualityMode.selectedOptions[0]?.disabled) {
    el.qualityMode.value = "0";
    saveSettings();
  }
}

// 진행 중인 라이브에서 구간을 지정하지 않으면 녹화 방식이라 안내가 필요하다.
export function updateLiveHint() {
  if (!el.liveHint) return;
  const notes = isActiveLiveMetadata() ? activeLiveNotes() : archiveNotes();
  el.liveHint.hidden = notes.length === 0;
  el.liveHint.textContent = notes.join(" ");
}

function activeLiveNotes() {
  const notes = [];
  if (selectedCoversWholeVideo(state.range.start, state.range.end)) {
    notes.push("진행 중인 라이브입니다. 구간을 지정하지 않으면 지금부터 녹화하며, 중지를 눌러야 저장됩니다.");
  }
  const delay = Math.round(state.liveEdgeDelay || 0);
  if (delay > 20) {
    notes.push(
      `유튜브가 조각을 내주기까지 걸리는 시간 때문에 지금 방송분보다 약 ${formatClock(delay)} 전까지만 받을 수 있습니다. 타임라인 끝이 그 지점입니다.`,
    );
  }
  return notes;
}

// 라이브가 끝나면 유튜브가 다시보기 화질을 낮은 것부터 새로 만든다.
// 방금 끝난 방송은 한동안 원래 화질보다 낮게 보이므로 미리 알려준다.
function archiveNotes() {
  const status = state.metadata?.live_status;
  if (status !== "post_live" && status !== "was_live") return [];

  const max = Number(state.metadata?.max_height || 0);
  const endedHoursAgo = liveEndedHoursAgo();
  if (status === "post_live") {
    return ["방금 끝난 라이브라 유튜브가 다시보기를 만드는 중입니다. 화질과 구간이 제한될 수 있습니다."];
  }
  if (max && max < 2160 && endedHoursAgo !== null && endedHoursAgo < 12) {
    return [
      `끝난 지 얼마 안 된 방송이라 유튜브가 아직 높은 화질을 다 만들지 않았습니다. ` +
        `지금은 최대 ${resolutionLabel(max)}이고, 나중에 다시 불러오면 더 높은 화질이 나올 수 있습니다.`,
    ];
  }
  return [];
}

function liveEndedHoursAgo() {
  const release = Number(state.metadata?.release_timestamp || 0);
  const duration = Number(state.metadata?.duration || 0);
  if (!release || !duration) return null;
  return (Date.now() / 1000 - (release + duration)) / 3600;
}

export function updateDurationLabel() {
  // 진행 중인 라이브만 길이가 계속 늘어나므로 그때만 LIVE로 표시한다.
  const live = isActiveLiveMetadata();
  if (state.durationEstimated) {
    el.durationLabel.textContent = live ? "LIVE · 길이 확인 중" : "길이 확인 중";
    return;
  }
  el.durationLabel.textContent = live
    ? `LIVE · ${formatClock(state.duration)}`
    : formatClock(state.duration);
}

export function isLiveLikeMetadata() {
  const status = state.metadata?.live_status || "";
  return Boolean(
    state.metadata?.is_live ||
      state.metadata?.was_live ||
      status === "is_live" ||
      status === "was_live" ||
      status === "post_live" ||
      status === "is_upcoming",
  );
}

export function isActiveLiveMetadata() {
  const status = state.metadata?.live_status || "";
  return Boolean(state.metadata?.is_live || status === "is_live");
}
