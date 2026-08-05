// 다운로드 시작과 진행 상황 표시.

import { api, apiToken, baseRequest } from "./api.js";
import { clamp } from "./format.js";
import { syncLiveDuration } from "./player.js";
import { saveSettings } from "./settings.js";
import { el, state } from "./state.js";
import { selectedCoversWholeVideo } from "./timeline.js";
import { requestNotificationPermission, setMessage, showSystemNotification, showToast } from "./ui.js";
import { isActiveLiveMetadata } from "./video.js";

export async function startDownload() {
  const url = el.urlInput.value.trim();
  if (!url) {
    setMessage("영상 주소를 입력하세요.", true);
    return;
  }

  saveSettings();
  requestNotificationPermission();
  syncLiveDuration();
  el.downloadButton.disabled = true;
  el.downloadButton.textContent = "다운로드 중...";
  resetJobUi();
  el.jobState.textContent = "시작";
  setMessage("다운로드 작업 생성 중");

  try {
    const start = state.range.start;
    const end = state.range.end;
    const wholeVideo = selectedCoversWholeVideo(start, end);
    const payload = baseRequest({
      url,
      start_seconds: !wholeVideo && Number.isFinite(start) ? start : null,
      end_seconds: !wholeVideo && Number.isFinite(end) ? end : null,
      live_from_start: el.liveFromStart.checked,
      is_live: isActiveLiveMetadata(),
      output_dir: el.outputDir.value.trim() || null,
      format_mode: el.formatMode.value,
      media_mode: el.mediaMode.value,
      max_height: Number(el.qualityMode.value) || null,
      accurate_cut: el.accurateCut.checked,
    });
    const data = await api("/api/download", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    pollJob(data.job_id);
  } catch (error) {
    setMessage(error.message, true);
    el.downloadButton.disabled = false;
    el.downloadButton.textContent = "선택 구간 다운로드";
    showToast("다운로드 시작 실패", error.message, true);
  }
}

// 로그는 앱 창을 좁히지 않도록 별도 창에서 본다. 브라우저 모드에서는 새 탭으로 연다.
export function openConsoleWindow() {
  if (window.ipc && typeof window.ipc.postMessage === "function") {
    window.ipc.postMessage("open-console");
    return;
  }
  // 콘솔 창은 세션 저장소를 공유하지 않으므로 토큰을 주소로 넘긴다.
  const token = apiToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`/console${query}`, "yt-download-console", "width=820,height=560");
}

export async function cancelCurrentJob() {
  if (!state.jobId) return;
  el.cancelButton.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.jobId)}/cancel`, { method: "POST" });
    setMessage("중지 요청을 보냈습니다. 받은 부분을 정리하는 중입니다.");
  } catch (error) {
    setMessage(error.message, true);
    el.cancelButton.disabled = false;
  }
}

export function pollJob(jobId) {
  clearInterval(state.jobTimer);
  state.jobId = jobId;
  el.cancelButton.hidden = false;
  el.cancelButton.disabled = false;
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      renderJob(job);
      if (job.state !== "running") {
        clearInterval(state.jobTimer);
        el.downloadButton.disabled = false;
        el.downloadButton.textContent = "선택 구간 다운로드";
        el.cancelButton.hidden = true;
        state.jobId = null;
        document.title = "yt-download";
        if (!state.notifiedJobs.has(job.id)) {
          state.notifiedJobs.add(job.id);
          const ok = job.state === "done";
          const title = ok ? "다운로드 완료" : "다운로드 실패";
          const body = ok && job.output_path ? job.output_path : job.message;
          showToast(title, body, !ok);
          showSystemNotification(title, body);
        }
      }
    } catch (error) {
      clearInterval(state.jobTimer);
      setMessage(error.message, true);
      el.downloadButton.disabled = false;
      el.downloadButton.textContent = "선택 구간 다운로드";
      el.cancelButton.hidden = true;
      state.jobId = null;
      showToast("상태 확인 실패", error.message, true);
    }
  };
  tick();
  state.jobTimer = setInterval(tick, 1000);
}

export function renderJob(job) {
  const progress = Number.isFinite(job.progress) ? clamp(job.progress, 0, 100) : job.state === "done" ? 100 : 0;
  el.jobState.textContent = renderState(job.state);
  el.jobState.dataset.state = job.state;
  el.miniJobPercent.textContent = `${Math.round(progress)}%`;
  el.miniJobProgressBar.style.width = `${progress}%`;

  const details = [];
  if (job.speed) details.push(job.speed);
  if (job.eta) details.push(`남은 시간 ${job.eta}`);
  el.miniJobDetails.textContent = details.join(" · ") || job.message || "대기 중";

  const message = job.output_path ? `저장됨: ${job.output_path}` : job.message;
  setMessage(message, job.state === "failed");
  if (job.state === "running") {
    document.title = `${Math.round(progress)}% · yt-download`;
  }
}

export function resetJobUi() {
  el.jobState.textContent = "대기";
  el.jobState.dataset.state = "idle";
  el.miniJobPercent.textContent = "0%";
  el.miniJobDetails.textContent = "대기 중";
  el.miniJobProgressBar.style.width = "0%";
}

export function renderState(value) {
  if (value === "running") return "실행 중";
  if (value === "done") return "완료";
  if (value === "failed") return "실패";
  return value;
}
