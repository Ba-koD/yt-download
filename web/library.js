// 내 채널의 영상 목록: 불러오기, 검색·기간 걸러내기, 화면에 그리기.

import { api, baseRequest } from "./api.js";
import { formatClock, formatSince, toDate } from "./format.js";
import { el, state } from "./state.js";
import { setMessage } from "./ui.js";
import { loadMetadata } from "./video.js";

const TAB_LABELS = { videos: "동영상", shorts: "Shorts", lives: "라이브" };

export async function loadLibrary() {
  // 내 채널을 알아내려면 쿠키 파일이 필요하고, 그건 "로그인 적용"이 만들어 준다.
  if (!el.cookiesFile.value.trim() && !el.useBrowserCookies?.checked) {
    setMessage("먼저 로그인·도구 칸에서 '로그인 적용'을 눌러 로그인해 주세요.", true);
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

// 검색어와 기간을 함께 적용한다. 둘 다 비어 있으면 원본 그대로.
export function filterItems(items, { query, from, to }) {
  const needle = String(query || "").trim().toLowerCase();
  return items.filter((item) => {
    if (needle && !String(item.title || "").toLowerCase().includes(needle)) return false;
    if (!from && !to) return true;

    const date = toDate(item.timestamp);
    // 날짜를 모르는 항목(진행 중인 라이브 등)은 기간을 걸면 숨긴다.
    if (!date) return false;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

// 화면의 검색어·기간 입력을 하나의 조건으로 모은다.
export function currentFilter() {
  const period = el.libraryPeriod?.value || "all";
  let from = null;
  let to = null;

  if (period === "custom") {
    from = el.libraryFrom?.value ? new Date(`${el.libraryFrom.value}T00:00:00`) : null;
    to = el.libraryTo?.value ? new Date(`${el.libraryTo.value}T23:59:59`) : null;
  } else if (period !== "all") {
    from = new Date(Date.now() - Number(period) * 86_400_000);
  }

  return { query: el.librarySearch?.value || "", from, to };
}

export function hasActiveFilter(filter) {
  return Boolean(String(filter.query || "").trim() || filter.from || filter.to);
}

export function bindLibraryFilters() {
  el.librarySearch?.addEventListener("input", renderLibrary);
  el.libraryFrom?.addEventListener("change", renderLibrary);
  el.libraryTo?.addEventListener("change", renderLibrary);
  el.libraryPeriod?.addEventListener("change", () => {
    // "직접 지정"일 때만 날짜 칸을 보여준다.
    if (el.libraryRange) el.libraryRange.hidden = el.libraryPeriod.value !== "custom";
    renderLibrary();
  });
}

export function renderLibrary() {
  const filter = currentFilter();

  for (const tab of el.libraryTabs) {
    const name = tab.dataset.libraryTab;
    tab.classList.toggle("active", name === state.libraryTab);
    const shown = filterItems(state.library[name] || [], filter).length;
    tab.textContent = `${TAB_LABELS[name]} ${shown}`;
  }

  const all = state.library[state.libraryTab] || [];
  const items = filterItems(all, filter);

  if (el.libraryCount) {
    const filtering = hasActiveFilter(filter);
    el.libraryCount.hidden = !filtering || all.length === 0;
    el.libraryCount.textContent = `${all.length}개 중 ${items.length}개`;
  }

  if (!items.length) {
    el.libraryList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = all.length
      ? "조건에 맞는 영상이 없습니다"
      : "불러오기를 누르면 내 채널의 영상이 여기에 나옵니다";
    el.libraryList.append(empty);
    return;
  }

  el.libraryList.innerHTML = "";
  for (const item of items) {
    el.libraryList.append(libraryButton(item));
  }
}

function libraryButton(item) {
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
    thumb.loading = "lazy";
  }

  const body = document.createElement("div");
  body.className = "library-body";

  const title = document.createElement("div");
  title.className = "library-title";
  title.textContent = item.title;

  const meta = document.createElement("div");
  meta.className = "library-meta";
  const bits = [formatSince(item.timestamp), item.duration ? formatClock(item.duration) : ""];
  meta.textContent = bits.filter(Boolean).join(" · ");

  body.append(title, meta);
  if (item.live_status === "is_live") {
    const badge = document.createElement("span");
    badge.className = "library-badge";
    badge.textContent = "LIVE";
    body.append(badge);
  }

  button.append(thumb, body);
  return button;
}

export function renderLibraryError(message) {
  el.libraryList.innerHTML = "";
  const node = document.createElement("div");
  node.className = "library-empty";
  node.textContent = message;
  el.libraryList.append(node);
}
