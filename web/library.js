// 내 채널의 영상 목록.

import { api, baseRequest } from "./api.js";
import { formatClock } from "./format.js";
import { el, state } from "./state.js";
import { setMessage } from "./ui.js";
import { loadMetadata } from "./video.js";

export async function loadLibrary() {
  const browser = el.cookieBrowser.value;
  if ((!browser || browser === "none") && !el.cookiesFile.value.trim()) {
    setMessage("내 영상을 보려면 로그인 브라우저 또는 쿠키 파일을 먼저 선택하세요.", true);
    return;
  }

  el.loadLibraryButton.disabled = true;
  setMessage("내 영상 목록을 불러오는 중");
  try {
    state.library = await api("/api/library", {
      method: "POST",
      body: JSON.stringify(baseRequest()),
    });
    renderLibrary();
    setMessage("내 영상 목록 로드 완료");
  } catch (error) {
    renderLibraryError(error.message);
    setMessage(error.message, true);
  } finally {
    el.loadLibraryButton.disabled = false;
  }
}

export function renderLibrary() {
  for (const tab of el.libraryTabs) {
    tab.classList.toggle("active", tab.dataset.libraryTab === state.libraryTab);
    const count = state.library[tab.dataset.libraryTab]?.length || 0;
    const label = tab.dataset.libraryTab === "videos" ? "동영상" : tab.dataset.libraryTab === "shorts" ? "Shorts" : "라이브";
    tab.textContent = `${label} ${count}`;
  }

  const items = state.library[state.libraryTab] || [];
  if (!items.length) {
    el.libraryList.innerHTML = `<div class="library-empty">목록 없음</div>`;
    return;
  }

  el.libraryList.innerHTML = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "library-item";
    button.type = "button";
    button.addEventListener("click", () => {
      el.urlInput.value = item.url;
      loadMetadata();
    });

    const thumb = document.createElement(item.thumbnail ? "img" : "div");
    thumb.className = "library-thumb";
    if (item.thumbnail) {
      thumb.src = item.thumbnail;
      thumb.alt = "";
    }

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "library-title";
    title.textContent = item.title;
    const meta = document.createElement("div");
    meta.className = "library-meta";
    meta.textContent = item.duration ? formatClock(item.duration) : item.live_status || "";
    body.append(title, meta);
    button.append(thumb, body);
    el.libraryList.append(button);
  }
}

export function renderLibraryError(message) {
  el.libraryList.innerHTML = "";
  const node = document.createElement("div");
  node.className = "library-empty";
  node.textContent = message;
  el.libraryList.append(node);
}
