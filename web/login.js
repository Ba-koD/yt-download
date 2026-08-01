// 로그인 브라우저와 도구 상태.

import { api } from "./api.js";
import { saveSettings } from "./settings.js";
import { el } from "./state.js";
import { browserLabel, setMessage } from "./ui.js";

export async function closeSelectedBrowser() {
  const browser = el.cookieBrowser.value;
  if (!browser || browser === "none") {
    setMessage("종료할 브라우저를 먼저 선택하세요.", true);
    return;
  }

  try {
    setMessage(`${browserLabel(browser)} 종료 중`);
    const result = await api("/api/close-browser", {
      method: "POST",
      body: JSON.stringify({ cookies_browser: browser }),
    });
    setMessage(`${browserLabel(result.browser)}를 종료했습니다. 다시 불러오기나 다운로드를 시도하세요.`);
  } catch (error) {
    setMessage(error.message, true);
  }
}

export async function openAppLoginBrowser() {
  const browser = el.cookieBrowser.value;
  if (!browser || browser === "none") {
    setMessage("Chrome, Edge, Brave 같은 브라우저를 먼저 선택하세요.", true);
    return;
  }
  if (browser === "firefox") {
    setMessage("앱 로그인은 Chromium 계열만 지원합니다. Firefox는 쿠키 파일 방식으로 사용하세요.", true);
    return;
  }

  try {
    setMessage(`${browserLabel(browser)} 앱 로그인 창을 여는 중`);
    await api("/api/app-login", {
      method: "POST",
      body: JSON.stringify({ cookies_browser: browser }),
    });
    setMessage("열린 창에서 YouTube 로그인을 완료한 뒤 앱으로 돌아와 로그인 적용을 누르세요.");
  } catch (error) {
    setMessage(error.message, true);
  }
}

export async function applyAppLogin() {
  const browser = el.cookieBrowser.value;
  if (!browser || browser === "none") {
    setMessage("로그인을 적용할 브라우저를 먼저 선택하세요.", true);
    return;
  }

  try {
    setMessage("앱 로그인 쿠키 저장 중");
    const result = await api("/api/export-login", {
      method: "POST",
      body: JSON.stringify({ cookies_browser: browser }),
    });
    el.cookiesFile.value = result.cookies_file;
    saveSettings();
    if (!result.auth_cookie_count) {
      setMessage("쿠키 파일은 저장됐지만 Google 인증 쿠키를 찾지 못했습니다. 열린 창에서 로그인을 다시 확인하세요.", true);
      return;
    }
    setMessage(`로그인 적용 완료: 쿠키 ${result.cookie_count}개 저장, 인증 쿠키 ${result.auth_cookie_count}개`);
  } catch (error) {
    setMessage(error.message, true);
  }
}

export async function refreshHealth() {
  try {
    const health = await api("/api/health");
    if (el.appVersion && health.version) el.appVersion.textContent = `v${health.version}`;
    renderTool(el.ytDlpStatus, "yt-dlp", health.yt_dlp);
    renderTool(el.ffmpegStatus, "ffmpeg", health.ffmpeg);
    if (!el.outputDir.value) el.outputDir.value = health.default_output_dir;
    if (!health.yt_dlp.available) {
      setMessage("yt-dlp를 찾을 수 없습니다. 경로를 입력하거나 내장 도구를 확인하세요.", true);
    }
  } catch (error) {
    setMessage(error.message, true);
  }
}

export function renderTool(node, label, status) {
  node.classList.toggle("ok", status.available);
  node.classList.toggle("bad", !status.available);
  node.textContent = status.available ? `${label} ${shortVersion(status.version)}` : `${label} 없음`;
  node.title = [status.version, status.path, status.error].filter(Boolean).join("\n");
}

// 버전 문자열이 길어서(ffmpeg는 빌드 정보까지 붙는다) 숫자만 남긴다.
function shortVersion(version) {
  if (!version) return "OK";
  const match = String(version).match(/\d+(\.\d+)+/);
  return match ? match[0] : String(version).slice(0, 12);
}
