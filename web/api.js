// 로컬 서버 호출.

import { el } from "./state.js";

// 브라우저 모드에서 서버가 준 접근 토큰. 앱 창(포트 없는 커스텀 프로토콜)에서는 없다.
const TOKEN_KEY = "yt-download-token";

export function apiToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** 주소의 ?token= 을 세션에 담고 주소에서 지운다(주소창·북마크에 남지 않게). */
export function rememberTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 세션 저장이 막혀 있으면 주소에 남겨둔다. 지우면 새로고침 때 토큰을 잃는다.
    return;
  }
  url.searchParams.delete("token");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

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
  const headers = { "content-type": "application/json" };
  const token = apiToken();
  if (token) headers["x-yt-download-token"] = token;
  const response = await fetch(path, { headers, ...options });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "요청 실패");
  }
  return data;
}
