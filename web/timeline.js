// 구간 편집 타임라인: 표시, 확대/축소, 끌어서 조절.

import { clamp, formatClock, formatClockPrecise, pad, parseTime } from "./format.js";
import { previewSelection, seekPlayerToUiTime } from "./player.js";
import { el, state } from "./state.js";
import { setMessage } from "./ui.js";
import { updateLiveHint } from "./video.js";

export function minGap() {
  return state.duration > 600 ? 0.5 : 0.1;
}

export function updateFromText(which) {
  state.userEditedRange = true;
  const target = which === "start" ? el.startInput : el.endInput;
  const seconds = parseTime(target.value);
  if (!Number.isFinite(seconds)) {
    target.value = formatClock(which === "start" ? state.range.start : state.range.end);
    setMessage("시간 형식이 올바르지 않습니다.", true);
    return;
  }
  if (which === "start") {
    setRangeValues(seconds, state.range.end, "start");
  } else {
    setRangeValues(state.range.start, seconds, "end");
  }
  ensureVisible(which === "start" ? state.range.start : state.range.end);
  previewSelection(which);
}

// 선택 구간을 정하는 단일 통로. anchor는 밀려날 때 어느 쪽을 고정할지 정한다.
export function setRangeValues(start, end, anchor = "end") {
  const duration = Math.max(1, state.duration || 1);
  const gap = minGap();
  let nextStart = clamp(Number(start) || 0, 0, duration);
  let nextEnd = clamp(Number(end) || 0, 0, duration);

  if (nextEnd - nextStart < gap) {
    if (anchor === "start") {
      nextEnd = Math.min(duration, nextStart + gap);
      nextStart = Math.max(0, nextEnd - gap);
    } else {
      nextStart = Math.max(0, nextEnd - gap);
      nextEnd = Math.min(duration, nextStart + gap);
    }
  }

  state.range.start = nextStart;
  state.range.end = nextEnd;
  el.startInput.value = formatClock(nextStart);
  el.endInput.value = formatClock(nextEnd);
  updateTimelineSelection();
}

export function updateTimelineSelection() {
  const selected = Math.max(0, state.range.end - state.range.start);
  el.selectionDuration.textContent = formatClock(selected);
  el.segmentSummary.textContent = `IN ${formatClock(state.range.start)} · OUT ${formatClock(state.range.end)} · 길이 ${formatClock(selected)}`;
  renderTimeline();
  updateLiveHint();
}

export function resetView() {
  state.view.start = 0;
  state.view.end = Math.max(1, state.duration || 1);
  renderTimeline();
}

export function viewSpan() {
  return Math.max(0.2, state.view.end - state.view.start);
}

export function minViewSpan() {
  return Math.min(Math.max(1, state.duration || 1), 2);
}

export function setView(start, span) {
  const duration = Math.max(1, state.duration || 1);
  const nextSpan = clamp(span, minViewSpan(), duration);
  const nextStart = clamp(start, 0, Math.max(0, duration - nextSpan));
  state.view.start = nextStart;
  state.view.end = nextStart + nextSpan;
  renderTimeline();
}

export function timeToRatio(seconds) {
  return (seconds - state.view.start) / viewSpan();
}

export function ratioToTime(ratio) {
  return state.view.start + ratio * viewSpan();
}

export function zoomBy(factor, anchorRatio = 0.5) {
  const anchorTime = ratioToTime(anchorRatio);
  const span = clamp(viewSpan() * factor, minViewSpan(), Math.max(1, state.duration || 1));
  setView(anchorTime - anchorRatio * span, span);
}

export function fitViewToSelection() {
  const length = Math.max(minViewSpan(), state.range.end - state.range.start);
  const pad = Math.max(length * 0.12, 0.5);
  setView(state.range.start - pad, length + pad * 2);
}

// 확대된 상태에서 편집하면 보이는 범위 밖으로 나갈 수 있으니 따라가게 한다.
export function ensureVisible(seconds) {
  const span = viewSpan();
  const margin = span * 0.08;
  if (seconds < state.view.start + margin) {
    setView(seconds - margin, span);
  } else if (seconds > state.view.end - margin) {
    setView(seconds - span + margin, span);
  }
}

export function renderTimeline() {
  const startRatio = timeToRatio(state.range.start);
  const endRatio = timeToRatio(state.range.end);
  const left = clamp(startRatio, 0, 1);
  const right = clamp(endRatio, 0, 1);
  el.tlSelection.style.left = `${left * 100}%`;
  el.tlSelection.style.width = `${Math.max(0, right - left) * 100}%`;
  el.tlSelection.classList.toggle("clipped-start", startRatio < 0);
  el.tlSelection.classList.toggle("clipped-end", endRatio > 1);
  placeHandle(el.tlHandleStart, startRatio);
  placeHandle(el.tlHandleEnd, endRatio);

  const playRatio = timeToRatio(state.playhead);
  el.playhead.style.left = `${clamp(playRatio, 0, 1) * 100}%`;
  el.playhead.classList.toggle("outside", playRatio < 0 || playRatio > 1);
  el.playheadTime.textContent = formatClock(state.playhead);

  renderRuler();
  renderTimelineMap();

  const duration = Math.max(1, state.duration || 1);
  el.zoomLabel.textContent =
    viewSpan() >= duration - 0.5 ? "전체 구간 표시" : `${formatClock(viewSpan())} 표시 중`;
}

export function placeHandle(node, ratio) {
  node.classList.toggle("outside", ratio < -0.001 || ratio > 1.001);
  node.style.left = `${clamp(ratio, 0, 1) * 100}%`;
}

export const RULER_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
];

export function renderRuler() {
  const span = viewSpan();
  const width = el.timelineTrack.clientWidth || 640;
  const wanted = span / Math.max(3, Math.min(12, Math.floor(width / 88)));
  const step = RULER_STEPS.find((value) => value >= wanted) || RULER_STEPS[RULER_STEPS.length - 1];
  el.timelineRuler.innerHTML = "";
  const first = Math.ceil(state.view.start / step) * step;
  for (let time = first; time <= state.view.end + 1e-6; time += step) {
    const ratio = clamp(timeToRatio(time), 0, 1);
    const tick = document.createElement("span");
    tick.className = "tl-tick";
    tick.textContent = step < 1 ? formatClockPrecise(time) : formatClock(time);
    // 양 끝 눈금은 가운데 정렬하면 잘리므로 안쪽으로 붙인다.
    if (ratio < 0.04) {
      tick.style.left = "0";
      tick.style.transform = "none";
    } else if (ratio > 0.96) {
      tick.style.right = "0";
      tick.style.transform = "none";
    } else {
      tick.style.left = `${ratio * 100}%`;
    }
    el.timelineRuler.append(tick);
  }
}

export function renderTimelineMap() {
  const duration = Math.max(1, state.duration || 1);
  el.timelineMapView.style.left = `${(state.view.start / duration) * 100}%`;
  el.timelineMapView.style.width = `${Math.max(1, (viewSpan() / duration) * 100)}%`;
  el.timelineMapSelection.style.left = `${(state.range.start / duration) * 100}%`;
  el.timelineMapSelection.style.width = `${Math.max(0.4, ((state.range.end - state.range.start) / duration) * 100)}%`;
}

export function bindTimeline() {
  el.timelineTrack.addEventListener("pointerdown", onTrackPointerDown);
  el.timelineTrack.addEventListener("pointermove", onTrackHover);
  el.timelineTrack.addEventListener("wheel", onTrackWheel, { passive: false });
  el.timelineMap.addEventListener("pointerdown", onMapPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", renderTimeline);
}

export function trackRatio(event) {
  const rect = el.timelineTrack.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

export function grabSeconds() {
  const width = el.timelineTrack.clientWidth || 640;
  return (12 / width) * viewSpan();
}

export function onTrackHover(event) {
  if (state.drag) return;
  const time = ratioToTime(trackRatio(event));
  const grab = grabSeconds();
  const near =
    Math.abs(time - state.range.start) <= grab || Math.abs(time - state.range.end) <= grab;
  el.timelineTrack.classList.toggle("near-handle", near);
}

export function onTrackPointerDown(event) {
  if (event.button !== 0) return;
  const ratio = trackRatio(event);
  const time = ratioToTime(ratio);
  const grab = grabSeconds();

  let mode = "seek";
  if (event.target.closest(".tl-handle.start") || Math.abs(time - state.range.start) <= grab) {
    mode = "start";
  } else if (event.target.closest(".tl-handle.end") || Math.abs(time - state.range.end) <= grab) {
    mode = "end";
  } else if (time > state.range.start && time < state.range.end) {
    mode = "move";
  }

  state.drag = {
    mode,
    pointerId: event.pointerId,
    anchorTime: time,
    originStart: state.range.start,
    originEnd: state.range.end,
    moved: false,
  };
  el.timelineTrack.setPointerCapture?.(event.pointerId);
  event.preventDefault();

  if (mode === "start" || mode === "end") {
    state.userEditedRange = true;
    applyDrag(time);
  } else {
    updatePlayhead(time);
  }
}

export function onPointerMove(event) {
  const drag = state.drag;
  if (!drag) return;
  const ratio = trackRatio(event);
  const time = ratioToTime(ratio);
  drag.moved = drag.moved || Math.abs(time - drag.anchorTime) > viewSpan() * 0.004;

  // 확대 상태에서 끝까지 끌면 타임라인이 따라 움직인다.
  if (ratio <= 0.02) setView(state.view.start - viewSpan() * 0.03, viewSpan());
  else if (ratio >= 0.98) setView(state.view.start + viewSpan() * 0.03, viewSpan());

  if (drag.mode === "map") {
    panMapTo(event);
    return;
  }
  if (drag.mode === "seek" && drag.moved) {
    // 빈 곳을 끌면 새 구간을 그린다.
    state.userEditedRange = true;
    setRangeValues(
      Math.min(drag.anchorTime, time),
      Math.max(drag.anchorTime, time),
      time >= drag.anchorTime ? "start" : "end",
    );
    updatePlayhead(time);
    return;
  }
  if (drag.mode === "seek") {
    updatePlayhead(time);
    return;
  }
  state.userEditedRange = true;
  applyDrag(time);
}

export function applyDrag(time) {
  const drag = state.drag;
  if (!drag) return;
  if (drag.mode === "start") {
    setRangeValues(time, state.range.end, "end");
    updatePlayhead(state.range.start);
  } else if (drag.mode === "end") {
    setRangeValues(state.range.start, time, "start");
    updatePlayhead(state.range.end);
  } else if (drag.mode === "move") {
    const duration = Math.max(1, state.duration || 1);
    const length = drag.originEnd - drag.originStart;
    let nextStart = clamp(drag.originStart + (time - drag.anchorTime), 0, Math.max(0, duration - length));
    setRangeValues(nextStart, nextStart + length, "start");
    updatePlayhead(state.range.start);
  }
}

export function onPointerUp(event) {
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  el.timelineTrack.releasePointerCapture?.(event.pointerId);
  if (drag.mode === "map") return;

  if (drag.mode === "seek" && !drag.moved) {
    seekPlayerToUiTime(state.playhead);
    return;
  }
  if (drag.mode === "start") previewSelection("start");
  else if (drag.mode === "end") previewSelection("end");
  else seekPlayerToUiTime(state.playhead);
}

export function onTrackWheel(event) {
  event.preventDefault();
  const ratio = trackRatio(event);
  if (event.shiftKey) {
    setView(state.view.start + Math.sign(event.deltaY) * viewSpan() * 0.15, viewSpan());
    return;
  }
  zoomBy(event.deltaY > 0 ? 1.25 : 0.8, ratio);
}

export function onMapPointerDown(event) {
  if (event.button !== 0) return;
  state.drag = { mode: "map", pointerId: event.pointerId, moved: true };
  el.timelineMap.setPointerCapture?.(event.pointerId);
  panMapTo(event);
  event.preventDefault();
}

export function panMapTo(event) {
  const rect = el.timelineMap.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const duration = Math.max(1, state.duration || 1);
  setView(ratio * duration - viewSpan() / 2, viewSpan());
}

export function updatePlayhead(seconds) {
  const duration = Math.max(1, state.duration || 1);
  state.playhead = clamp(seconds, 0, duration);
  const ratio = timeToRatio(state.playhead);
  el.playhead.style.left = `${clamp(ratio, 0, 1) * 100}%`;
  el.playhead.classList.toggle("outside", ratio < 0 || ratio > 1);
  el.playheadTime.textContent = formatClock(state.playhead);
}

export function nudgeTime(which, delta) {
  state.userEditedRange = true;
  const start = state.range.start;
  const end = state.range.end;
  if (which === "start") {
    setRangeValues(start + delta, end, "start");
  } else {
    setRangeValues(start, end + delta, "end");
  }
  ensureVisible(which === "start" ? state.range.start : state.range.end);
  previewSelection(which);
}

export function selectedCoversWholeVideo(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= 0.05 && end >= Math.max(0, state.duration - 0.05);
}
