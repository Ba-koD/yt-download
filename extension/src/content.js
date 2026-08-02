// 유튜브 영상 페이지의 좋아요·공유 줄에 "구간 받기" 버튼을 넣고,
// 누르면 영상 아래에 구간 편집 패널을 펼친다.
//
// content script 는 확장의 격리된 세계에서 돌지만 네트워크는 페이지(youtube.com) 몫으로 나간다.
// 덕분에 InnerTube 는 동일 출처로, 미디어는 Range 를 허용하는 CORS 로 그대로 받을 수 있다.

(async () => {
  const load = (name) => import(chrome.runtime.getURL(`src/${name}`));
  const [{ downloadSection, getFormats, safeFileName, clockLabel }, { formatLabel }] =
    await Promise.all([load("download.js"), load("innertube.js")]);

  const state = {
    videoId: null,
    formats: null,
    start: 0,
    end: 0,
    busy: false,
    open: false,
  };

  const el = {};

  // 유튜브는 Trusted Types 를 강제해서 innerHTML 을 막는다. 노드를 직접 만들어 붙인다.
  function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  }

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  }

  function player() {
    return document.querySelector(".html5-main-video") || document.querySelector("video");
  }

  function playerDuration() {
    const known = Number(player()?.duration);
    if (Number.isFinite(known) && known > 0) return known;
    return state.formats?.durationSeconds || 0;
  }

  function parseClock(text) {
    const parts = String(text).trim().split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function showClock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  // 유튜브의 좋아요·공유 버튼과 나란히 설 버튼.
  function buildButton() {
    const icon = make("span", { class: "ytdl-open-icon", text: "↧" });
    icon.setAttribute("aria-hidden", "true");
    const button = make(
      "button",
      { id: "ytdl-open", class: "ytdl-open", type: "button", title: "이 영상의 원하는 구간만 받기" },
      [icon, make("span", { text: "구간 받기" })],
    );
    button.addEventListener("click", togglePanel);
    return button;
  }

  function buildPanel() {
    el.inputs = {
      start: make("input", { class: "ytdl-time", value: "0:00", dataset: { time: "start" } }),
      end: make("input", { class: "ytdl-time", value: "0:00", dataset: { time: "end" } }),
    };
    const markStart = make("button", {
      class: "ytdl-mark", type: "button", text: "지금 위치를 IN", dataset: { mark: "start" },
    });
    const markEnd = make("button", {
      class: "ytdl-mark", type: "button", text: "OUT", dataset: { mark: "end" },
    });

    el.length = make("span", { class: "ytdl-length" });
    el.quality = make("select", { class: "ytdl-quality" }, [make("option", { text: "불러오는 중…" })]);
    el.go = make("button", { class: "ytdl-go", type: "button", text: "구간 받기", disabled: true });
    el.status = make("div", { class: "ytdl-status", text: "화질 목록을 불러오는 중입니다" });

    const close = make("button", { class: "ytdl-close", type: "button", title: "닫기", text: "✕" });
    close.addEventListener("click", togglePanel);

    const panel = make("div", { class: "ytdl-panel", hidden: true }, [
      make("div", { class: "ytdl-head" }, [
        make("span", { class: "ytdl-title", text: "구간 받기" }),
        close,
      ]),
      make("div", { class: "ytdl-body" }, [
        make("div", { class: "ytdl-row" }, [
          markStart,
          el.inputs.start,
          make("span", { class: "ytdl-sep", text: "~" }),
          el.inputs.end,
          markEnd,
        ]),
        make("div", { class: "ytdl-row" }, [el.length, el.quality, el.go]),
        el.status,
      ]),
    ]);
    el.panel = panel;

    for (const button of [markStart, markEnd]) {
      button.addEventListener("click", () => {
        const video = player();
        if (!video) return;
        const now = video.currentTime;
        setRange(
          button.dataset.mark === "start" ? now : state.start,
          button.dataset.mark === "end" ? now : state.end,
        );
      });
    }

    for (const [which, input] of Object.entries(el.inputs)) {
      input.addEventListener("change", () => {
        const value = parseClock(input.value);
        if (value === null) {
          render();
          return;
        }
        setRange(which === "start" ? value : state.start, which === "end" ? value : state.end);
        // 고친 지점으로 영상을 옮겨 눈으로 확인할 수 있게 한다.
        const video = player();
        if (video) video.currentTime = value;
      });
    }

    el.go.addEventListener("click", start);
    return panel;
  }

  function actionRow() {
    return (
      document.querySelector("#actions #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner")
    );
  }

  // 유튜브는 화면을 통째로 다시 그리는 일이 잦다. 사라졌으면 다시 붙인다.
  function mount() {
    const row = actionRow();
    if (row && !row.querySelector("#ytdl-open")) {
      el.button = buildButton();
      row.append(el.button);
    }

    const below = document.querySelector("ytd-watch-metadata") || document.querySelector("#below");
    if (below && (!el.panel || !el.panel.isConnected)) {
      const panel = buildPanel();
      below.insertAdjacentElement("afterend", panel);
      panel.hidden = !state.open;
      render();
    }
  }

  async function togglePanel() {
    state.open = !state.open;
    if (el.panel) el.panel.hidden = !state.open;
    el.button?.classList.toggle("ytdl-open-active", state.open);
    // 목록은 처음 열 때만 받아온다(영상마다 미리 받아두면 낭비다).
    if (state.open && !state.formats) await loadFormats();
  }

  function setRange(start, end) {
    const duration = playerDuration();
    const limit = duration > 0 ? duration : Math.max(start, end);
    state.start = Math.max(0, Math.min(start, limit));
    state.end = Math.max(0, Math.min(end, limit));
    if (state.end < state.start) [state.start, state.end] = [state.end, state.start];
    render();
  }

  function render() {
    if (!el.panel) return;
    el.inputs.start.value = showClock(state.start);
    el.inputs.end.value = showClock(state.end);
    const length = Math.max(0, state.end - state.start);
    el.length.textContent = `길이 ${showClock(length)}`;
    el.go.disabled = state.busy || !state.formats || length < 0.5;
  }

  function setStatus(text, kind = "") {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.className = `ytdl-status ${kind}`;
  }

  async function loadFormats() {
    const videoId = currentVideoId();
    if (!videoId) return;
    state.videoId = videoId;
    state.formats = null;
    el.quality.replaceChildren(make("option", { text: "불러오는 중…" }));
    setStatus("화질 목록을 불러오는 중입니다");

    try {
      const formats = await getFormats(videoId);
      if (state.videoId !== videoId) return; // 그 사이 다른 영상으로 옮겼다
      if (!formats.video.length || !formats.audio.length) {
        throw new Error("받을 수 있는 mp4 화질이 없습니다");
      }
      state.formats = formats;
      el.quality.replaceChildren(
        ...formats.video.map((format) =>
          make("option", { value: String(format.itag), text: formatLabel(format) }),
        ),
      );
      setRange(0, player()?.duration || formats.durationSeconds || 0);
      setStatus(formats.isLive ? "진행 중인 라이브는 아직 지원하지 않습니다" : "");
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
      el.quality.replaceChildren(make("option", { text: "없음" }));
    }
    render();
  }

  async function start() {
    if (state.busy || !state.formats) return;
    const videoFormat =
      state.formats.video.find((format) => String(format.itag) === el.quality.value) ||
      state.formats.video[0];

    state.busy = true;
    render();
    const began = Date.now();

    try {
      const { bytes } = await downloadSection({
        videoFormat,
        audioFormat: state.formats.audio[0],
        start: state.start,
        end: state.end,
        onProgress: (done, total, stage) => {
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          setStatus(stage === "받는 중" ? `${stage} ${percent}%` : stage);
        },
      });

      save(
        bytes,
        `${safeFileName(state.formats.title)} ` +
          `[${clockLabel(state.start)}~${clockLabel(state.end)}].mp4`,
      );
      const seconds = ((Date.now() - began) / 1000).toFixed(1);
      setStatus(`저장했습니다 · ${(bytes.length / 1048576).toFixed(1)} MB · ${seconds}초`, "ytdl-ok");
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
    } finally {
      state.busy = false;
      render();
    }
  }

  function save(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    // 브라우저가 내려받기를 시작할 틈을 준 뒤 정리한다.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  mount();

  // 유튜브는 페이지를 새로 그리지 않고 영상만 갈아끼운다.
  let lastId = currentVideoId();
  setInterval(() => {
    mount();
    const id = currentVideoId();
    if (id && id !== lastId) {
      lastId = id;
      state.formats = null;
      state.videoId = id;
      // 열려 있으면 새 영상 목록으로 갈아끼우고, 닫혀 있으면 열 때 받는다.
      if (state.open) loadFormats();
      else render();
    }
  }, 1000);
})();
