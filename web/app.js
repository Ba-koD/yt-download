// 시작점: 이벤트를 연결하고 첫 화면을 준비한다.

import { rememberTokenFromUrl } from "./api.js";
import { cancelCurrentJob, openConsoleWindow, resetJobUi, startDownload } from "./jobs.js";
import { bindLibraryFilters, loadLibrary, renderLibrary } from "./library.js";
import { applyAppLogin, closeSelectedBrowser, openAppLoginBrowser, refreshHealth } from "./login.js";
import {
  markFromPlayer,
  playSelectedSegment,
  syncPlayheadFromPlayer,
  togglePlayPause,
} from "./player.js";
import { restoreSettings, saveSettings } from "./settings.js";
import { el, state } from "./state.js";
import { bindTimeline, fitViewToSelection, nudgeTime, resetView, setRangeValues, updateFromText, zoomBy } from "./timeline.js";
import { bindUpdate, checkUpdate } from "./update.js";
import { loadMetadata, watchUrlInput } from "./video.js";

// 유튜브 iframe API가 준비되면 부르는 전역 콜백(플레이어는 필요할 때 만든다).
window.onYouTubeIframeAPIReady = () => {};

export function boot() {
  // 첫 API 호출 전에 주소의 접근 토큰부터 챙긴다(브라우저 모드).
  rememberTokenFromUrl();
  bindEvents();
  refreshHealth();
  restoreSettings();
  syncMediaMode();
  setRangeValues(0, state.duration);
  resetView();
  resetJobUi();
  // 새 버전이 있는지는 조용히 본다. 인터넷이 없어도 앱은 그대로 쓸 수 있어야 한다.
  checkUpdate({ quiet: true });
  setInterval(syncPlayheadFromPlayer, 500);
}

export function bindEvents() {
  el.loadButton.addEventListener("click", loadMetadata);
  el.urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadMetadata();
  });
  watchUrlInput();
  el.openLoginButton.addEventListener("click", openAppLoginBrowser);
  el.applyLoginButton.addEventListener("click", applyAppLogin);
  el.closeBrowserButton.addEventListener("click", closeSelectedBrowser);
  bindTimeline();
  el.startInput.addEventListener("change", () => updateFromText("start"));
  el.endInput.addEventListener("change", () => updateFromText("end"));
  el.playSegmentButton.addEventListener("click", playSelectedSegment);
  el.playPauseButton.addEventListener("click", togglePlayPause);
  el.markStartButton.addEventListener("click", () => markFromPlayer("start"));
  el.markEndButton.addEventListener("click", () => markFromPlayer("end"));
  el.nudgeStartBack.addEventListener("click", () => nudgeTime("start", -1));
  el.nudgeStartForward.addEventListener("click", () => nudgeTime("start", 1));
  el.nudgeEndBack.addEventListener("click", () => nudgeTime("end", -1));
  el.nudgeEndForward.addEventListener("click", () => nudgeTime("end", 1));
  el.downloadButton.addEventListener("click", startDownload);
  el.cancelButton.addEventListener("click", cancelCurrentJob);
  el.openConsoleButton.addEventListener("click", openConsoleWindow);
  bindUpdate();
  el.loadLibraryButton.addEventListener("click", loadLibrary);
  bindLibraryFilters();
  el.zoomInButton.addEventListener("click", () => zoomBy(0.55));
  el.zoomOutButton.addEventListener("click", () => zoomBy(1.8));
  el.fitSelectionButton.addEventListener("click", fitViewToSelection);
  el.viewAllButton.addEventListener("click", () => {
    resetView();
  });

  for (const tab of el.libraryTabs) {
    tab.addEventListener("click", () => {
      state.libraryTab = tab.dataset.libraryTab;
      renderLibrary();
    });
  }

  for (const item of [
    el.cookieBrowser,
    el.cookiesFile,
    el.outputDir,
    el.ytDlpPath,
    el.formatMode,
    el.qualityMode,
    el.mediaMode,
    el.accurateCut,
    el.liveFromStart,
  ]) {
    item.addEventListener("change", saveSettings);
  }
  el.mediaMode.addEventListener("change", syncMediaMode);
}

// 출력 모드에 따라 화질 선택을 잠그고, 어떤 파일이 만들어지는지 알려준다.
function syncMediaMode() {
  const mode = el.mediaMode.value;
  el.qualityMode.disabled = mode === "audio";
  const hints = {
    video_only: "소리 없는 영상 파일 하나가 저장됩니다.",
    audio: "소리 파일(m4a) 하나가 저장됩니다. 화질 설정은 쓰지 않습니다.",
  };
  el.mediaModeHint.textContent = hints[mode] || "";
  el.mediaModeHint.hidden = !hints[mode];
}

boot();
