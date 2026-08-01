// 로컬 서버 호출.

import { el } from "./state.js";

export function baseRequest(extra = {}) {
  return {
    cookies_browser: el.cookieBrowser.value,
    cookies_profile: null,
    cookies_file: el.cookiesFile.value.trim() || null,
    yt_dlp_path: el.ytDlpPath.value.trim() || null,
    ...extra,
  };
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "요청 실패");
  }
  return data;
}
