// 로컬 서버 호출.

import { el } from "./state.js";

export function baseRequest(extra = {}) {
  return {
    // 브라우저에서 직접 쿠키를 읽는 건 그 브라우저가 완전히 꺼져 있어야만 되는 방식이라,
    // 사용자가 일부러 켰을 때만 보낸다. 평소에는 앱 로그인이 만든 쿠키 파일을 쓴다.
    cookies_browser: el.useBrowserCookies?.checked ? el.cookieBrowser.value : null,
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
