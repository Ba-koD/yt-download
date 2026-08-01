// 사용자가 고른 설정을 브라우저에 저장한다.

import { el } from "./state.js";

export function saveSettings() {
  localStorage.setItem(
    "yt-download-settings",
    JSON.stringify({
      cookieBrowser: el.cookieBrowser.value,
      cookiesFile: el.cookiesFile.value,
      outputDir: el.outputDir.value,
      ytDlpPath: el.ytDlpPath.value,
      formatMode: el.formatMode.value,
      qualityMode: el.qualityMode.value,
      accurateCut: el.accurateCut.checked,
      liveFromStart: el.liveFromStart.checked,
    }),
  );
}

export function restoreSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem("yt-download-settings") || "{}");
    if (settings.cookieBrowser) el.cookieBrowser.value = settings.cookieBrowser;
    if (settings.cookiesFile) el.cookiesFile.value = settings.cookiesFile;
    if (settings.outputDir) el.outputDir.value = settings.outputDir;
    if (settings.ytDlpPath) el.ytDlpPath.value = settings.ytDlpPath;
    if (settings.formatMode) el.formatMode.value = settings.formatMode;
    if (settings.qualityMode) el.qualityMode.value = settings.qualityMode;
    el.accurateCut.checked = Boolean(settings.accurateCut);
    el.liveFromStart.checked = Boolean(settings.liveFromStart);
  } catch {
    localStorage.removeItem("yt-download-settings");
  }
}
