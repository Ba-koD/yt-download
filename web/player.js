// 유튜브 미리보기 플레이어 연동과 라이브 시간 기준 맞추기.

import { clamp } from "./format.js";
import { el, state } from "./state.js";
import { ensureVisible, renderTimeline, resetView, selectedCoversWholeVideo, setRangeValues, updatePlayhead, updateTimelineSelection, viewSpan } from "./timeline.js";
import { setMessage } from "./ui.js";
import { isActiveLiveMetadata, isLiveLikeMetadata, updateDurationLabel } from "./video.js";

export function resetLivePreviewState() {
  state.liveDurationAtLoad = null;
  state.liveLoadedAt = null;
  state.liveEdgeDelay = 0;
  state.playerTimeOffset = 0;
  state.playerTimeOffsetReady = false;
  if (state.previewSeekTimer) {
    clearTimeout(state.previewSeekTimer);
    state.previewSeekTimer = null;
  }
}

export function loadPlayer(videoId) {
  el.previewFrame.classList.add("loaded");
  if (state.player && typeof state.player.loadVideoById === "function") {
    state.player.loadVideoById(videoId);
    setTimeout(refreshDurationFromPlayer, 1000);
    return;
  }
  if (!window.YT || !window.YT.Player) {
    setTimeout(() => loadPlayer(videoId), 250);
    return;
  }
  state.player = new YT.Player("player", {
    videoId,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
    },
    events: {
      onReady: refreshDurationFromPlayer,
      onStateChange: refreshDurationFromPlayer,
    },
  });
}

export function refreshDurationFromPlayer() {
  if (!state.player || typeof state.player.getDuration !== "function") return;
  calibratePlayerTimeOffset();
  if (hasLiveClock()) return;

  let playerDuration = 0;
  try {
    playerDuration = Number(state.player.getDuration() || 0);
  } catch {
    return;
  }
  if (!Number.isFinite(playerDuration) || playerDuration <= 1) return;

  const shouldUpdate =
    state.durationEstimated || (isLiveLikeMetadata() && Math.abs(playerDuration - state.duration) > 5);
  if (!shouldUpdate) return;

  const oldStart = state.range.start;
  const oldEnd = state.range.end;
  const wasWholeVideo = !state.userEditedRange || selectedCoversWholeVideo(oldStart, oldEnd);
  const wasWholeView = viewSpan() >= state.duration - 0.5;

  state.duration = playerDuration;
  state.durationEstimated = false;
  updateDurationLabel();

  if (wasWholeVideo) {
    setRangeValues(0, playerDuration, "start");
  } else {
    setRangeValues(Math.min(oldStart, playerDuration), Math.min(oldEnd, playerDuration), "start");
  }
  if (wasWholeView) resetView();
  else renderTimeline();
}

// 라이브의 시간 기준은 항상 "방송 시작 = 00:00:00"이다.
// 유튜브 플레이어는 되감기 가능한 구간(DVR) 안에서의 위치를 주기 때문에,
// 그 구간이 실제로 몇 시부터인지(progressBar...UtcTimeMillis)를 받아 절대 시각으로 옮긴다.
export function calibratePlayerTimeOffset() {
  if (!isLiveLikeMetadata()) {
    state.playerTimeOffset = 0;
    return;
  }
  if (!state.player || typeof state.player.getCurrentTime !== "function") return;

  const release = Number(state.metadata?.release_timestamp || 0);
  const windowStartMs = Number(
    (typeof state.player.getVideoData === "function"
      ? state.player.getVideoData()?.progressBarStartPositionUtcTimeMillis
      : 0) || 0,
  );
  if (release > 0 && windowStartMs > 0) {
    // 되감기 구간의 시작이 방송 시작으로부터 몇 초 뒤인지.
    state.playerTimeOffset = Math.max(0, windowStartMs / 1000 - release);
    state.playerTimeOffsetReady = true;
    return;
  }

  if (state.playerTimeOffsetReady || !hasLiveClock()) return;

  let playerCurrent = 0;
  let playerDuration = 0;
  try {
    playerCurrent = Number(state.player.getCurrentTime() || 0);
    if (typeof state.player.getDuration === "function") {
      playerDuration = Number(state.player.getDuration() || 0);
    }
  } catch {
    return;
  }

  const liveDuration = currentLiveDuration();
  if (Number.isFinite(playerDuration) && playerDuration > 0 && Math.abs(playerDuration - liveDuration) <= 5) {
    state.playerTimeOffset = 0;
    state.playerTimeOffsetReady = true;
    return;
  }

  if (!Number.isFinite(playerCurrent) || playerCurrent <= 0) return;
  if (Number.isFinite(playerDuration) && playerDuration > 0 && playerCurrent < playerDuration - 5) return;

  const reference = Number.isFinite(playerDuration) && playerDuration > 0 ? Math.max(playerCurrent, playerDuration) : playerCurrent;
  const offset = liveDuration - reference;
  state.playerTimeOffset = offset > 2 ? offset : 0;
  state.playerTimeOffsetReady = true;
}

export function hasLiveClock() {
  return (
    isActiveLiveMetadata() &&
    Number.isFinite(state.liveDurationAtLoad) &&
    Number.isFinite(state.liveLoadedAt)
  );
}

export function currentLiveDuration() {
  if (!hasLiveClock()) return state.duration;
  const elapsed = Math.max(0, Date.now() / 1000 - state.liveLoadedAt);
  return state.liveDurationAtLoad + elapsed;
}

export function syncLiveDuration() {
  if (!hasLiveClock()) return;
  const nextDuration = currentLiveDuration();
  if (!Number.isFinite(nextDuration) || nextDuration <= state.duration + 0.5) return;

  const oldDuration = state.duration;
  const oldStart = state.range.start;
  const oldEnd = state.range.end;
  const followsLiveEdge =
    !state.userEditedRange ||
    oldEnd >= oldDuration - 1.5 ||
    selectedCoversWholeVideo(oldStart, oldEnd);
  const editingText = document.activeElement === el.startInput || document.activeElement === el.endInput;
  const wasWholeView = viewSpan() >= oldDuration - 0.5;

  state.duration = nextDuration;
  updateDurationLabel();

  if (editingText || state.drag) {
    updateTimelineSelection();
  } else if (followsLiveEdge) {
    setRangeValues(oldStart, nextDuration, "start");
  } else {
    setRangeValues(Math.min(oldStart, nextDuration), Math.min(oldEnd, nextDuration), "start");
  }
  if (wasWholeView) resetView();
  else renderTimeline();
}

export function previewSelection(which) {
  const start = state.range.start;
  const end = state.range.end;
  const leadIn = Math.min(2, Math.max(0, end - start) / 2);
  const target = which === "end" ? Math.max(start, end - leadIn) : start;
  schedulePreviewSeek(target);
}

export function schedulePreviewSeek(seconds) {
  updatePlayhead(seconds);
  if (!state.player || typeof state.player.seekTo !== "function") return;
  if (state.previewSeekTimer) clearTimeout(state.previewSeekTimer);
  state.previewSeekTimer = setTimeout(() => {
    seekPlayerToUiTime(seconds);
  }, 100);
}

export function seekPlayerToUiTime(seconds) {
  if (!state.player || typeof state.player.seekTo !== "function") return;
  state.player.seekTo(uiTimeToPlayerTime(seconds), true);
}

export function uiTimeToPlayerTime(seconds) {
  return Math.max(0, seconds - (state.playerTimeOffset || 0));
}

export function playerTimeToUiTime(seconds) {
  const offset = state.playerTimeOffset || 0;
  return clamp((Number(seconds) || 0) + offset, 0, Math.max(1, state.duration || 1));
}

export function syncPlayheadFromPlayer() {
  syncLiveDuration();
  if (!state.player || typeof state.player.getCurrentTime !== "function") return;
  try {
    calibratePlayerTimeOffset();
    updatePlayhead(playerTimeToUiTime(state.player.getCurrentTime()));
    refreshDurationFromPlayer();
  } catch {
    // The iframe can briefly be unavailable while the player is loading.
  }
}

export function markFromPlayer(which) {
  if (!state.player || typeof state.player.getCurrentTime !== "function") return;
  state.userEditedRange = true;
  const current = playerTimeToUiTime(state.player.getCurrentTime());
  updatePlayhead(current);
  if (which === "start") {
    setRangeValues(current, state.range.end, "start");
  } else {
    setRangeValues(state.range.start, current, "end");
  }
  ensureVisible(current);
}

export function playSelectedSegment() {
  if (!state.player || typeof state.player.seekTo !== "function") {
    setMessage("미리보기를 먼저 불러오세요.", true);
    return;
  }
  stopSegmentPlayback();
  const start = state.range.start;
  const end = state.range.end;
  seekPlayerToUiTime(start);
  if (typeof state.player.playVideo === "function") state.player.playVideo();
  updatePlayhead(start);
  state.segmentTimer = setInterval(() => {
    try {
      const current = playerTimeToUiTime(state.player.getCurrentTime());
      updatePlayhead(current);
      if (current >= end) {
        if (typeof state.player.pauseVideo === "function") state.player.pauseVideo();
        stopSegmentPlayback();
        updatePlayhead(end);
      }
    } catch {
      stopSegmentPlayback();
    }
  }, 250);
}

export function stopSegmentPlayback() {
  if (state.segmentTimer) {
    clearInterval(state.segmentTimer);
    state.segmentTimer = null;
  }
}
