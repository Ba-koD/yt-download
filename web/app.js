// 시작점: 이벤트를 연결하고 첫 화면을 준비한다.

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
  bindEvents();
  refreshHealth();
  restoreSettings();
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
    el.accurateCut,
    el.liveFromStart,
  ]) {
    item.addEventListener("change", saveSettings);
  }
}

boot();
