// 유튜브 영상 페이지의 좋아요·공유 줄에 "구간 받기" 버튼을 넣고,
// 누르면 영상 아래에 구간 편집 패널을 펼친다.
//
// content script 는 확장의 격리된 세계에서 돌지만 네트워크는 페이지(youtube.com) 몫으로 나간다.
// 덕분에 InnerTube 는 동일 출처로, 미디어는 Range 를 허용하는 CORS 로 그대로 받을 수 있다.

(async () => {
  const load = (name) => import(chrome.runtime.getURL(`src/${name}`));
  const [{ downloadSection, getFormats, safeFileName, clockLabel }, { formatLabel }, net] =
    await Promise.all([load("download.js"), load("innertube.js"), load("net.js")]);

  // 여기(content script)에서 곧바로 googlevideo 를 부르면 교차 출처로 막힌다.
  // 실제 요청은 배경 일꾼이 대신 하도록 통로를 갈아끼운다.
  net.useTransport(net.backgroundTransport(chrome.runtime));

  const state = {
    videoId: null,
    formats: null,
    start: 0,
    end: 0,
    busy: false,
    open: false,
    drag: null,
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

  // 타임라인: 전체 길이를 가로줄로 놓고 IN/OUT 손잡이와 재생 위치를 얹는다.
  // 손잡이를 끌면 영상이 그 지점으로 따라가서, 유튜브 화면 자체가 미리보기가 된다.
  function buildTimeline() {
    el.range = make("div", { class: "ytdl-range" });
    el.headMark = make("div", { class: "ytdl-head-mark" });
    el.inHandle = make("div", { class: "ytdl-handle ytdl-in", title: "시작점" });
    el.outHandle = make("div", { class: "ytdl-handle ytdl-out", title: "끝점" });
    el.track = make("div", { class: "ytdl-track" }, [
      el.range,
      el.headMark,
      el.inHandle,
      el.outHandle,
    ]);

    const seconds = (event) => {
      const box = el.track.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / Math.max(1, box.width);
      return Math.max(0, Math.min(1, ratio)) * (playerDuration() || 0);
    };

    const startDrag = (what) => (event) => {
      event.preventDefault();
      el.track.setPointerCapture(event.pointerId);
      state.drag = what;
      onDrag(event);
    };

    const onDrag = (event) => {
      if (!state.drag) return;
      const value = seconds(event);
      if (state.drag === "in") setRange(value, state.end);
      else if (state.drag === "out") setRange(state.start, value);
      // 끄는 지점을 영상에서 바로 보여준다.
      seek(value);
    };

    el.inHandle.addEventListener("pointerdown", startDrag("in"));
    el.outHandle.addEventListener("pointerdown", startDrag("out"));
    el.track.addEventListener("pointerdown", (event) => {
      if (event.target === el.inHandle || event.target === el.outHandle) return;
      startDrag("seek")(event);
    });
    el.track.addEventListener("pointermove", onDrag);
    el.track.addEventListener("pointerup", () => {
      state.drag = null;
    });
    el.track.addEventListener("pointercancel", () => {
      state.drag = null;
    });

    return el.track;
  }

  function seek(seconds) {
    const video = player();
    if (video && Number.isFinite(seconds)) video.currentTime = seconds;
  }

  function buildPanel() {
    el.inputs = {
      start: make("input", { class: "ytdl-time", value: "0:00", dataset: { time: "start" } }),
      end: make("input", { class: "ytdl-time", value: "0:00", dataset: { time: "end" } }),
    };
    // 편집 프로그램에서 쓰는 대괄호 표시를 그대로 쓴다(I/O 단축키도 같이 받는다).
    const markIn = make("button", {
      class: "ytdl-mark", type: "button", text: "[", title: "지금 위치를 시작점으로 (I)",
      dataset: { mark: "start" },
    });
    const markOut = make("button", {
      class: "ytdl-mark", type: "button", text: "]", title: "지금 위치를 끝점으로 (O)",
      dataset: { mark: "end" },
    });

    el.length = make("span", { class: "ytdl-length" });
    el.quality = make("select", { class: "ytdl-quality" }, [make("option", { text: "불러오는 중…" })]);
    el.go = make("button", { class: "ytdl-go", type: "button", text: "구간 받기", disabled: true });
    el.status = make("div", { class: "ytdl-status", text: "화질 목록을 불러오는 중입니다" });
    el.total = make("span", { class: "ytdl-total" });

    const close = make("button", { class: "ytdl-close", type: "button", title: "닫기", text: "✕" });
    close.addEventListener("click", togglePanel);

    const panel = make("div", { class: "ytdl-panel", hidden: true }, [
      make("div", { class: "ytdl-head" }, [
        make("span", { class: "ytdl-title", text: "구간 받기" }),
        el.total,
        close,
      ]),
      make("div", { class: "ytdl-body" }, [
        buildTimeline(),
        make("div", { class: "ytdl-row" }, [
          markIn,
          el.inputs.start,
          make("span", { class: "ytdl-sep", text: "~" }),
          el.inputs.end,
          markOut,
          el.length,
          el.quality,
          el.go,
        ]),
        el.status,
      ]),
    ]);
    el.panel = panel;

    for (const button of [markIn, markOut]) {
      button.addEventListener("click", () => markHere(button.dataset.mark));
    }

    for (const [which, input] of Object.entries(el.inputs)) {
      input.addEventListener("change", () => {
        const value = parseClock(input.value);
        if (value === null) {
          render();
          return;
        }
        setRange(which === "start" ? value : state.start, which === "end" ? value : state.end);
        seek(value);
      });
    }

    el.go.addEventListener("click", start);
    return panel;
  }

  function markHere(which) {
    const video = player();
    if (!video) return;
    const now = video.currentTime;
    setRange(which === "start" ? now : state.start, which === "end" ? now : state.end);
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
    el.length.textContent = showClock(length);
    el.go.disabled = state.busy || !state.formats || length < 0.5;
    renderTimeline();
  }

  function renderTimeline() {
    const duration = playerDuration();
    el.total.textContent = duration ? showClock(duration) : "";
    if (!duration) return;
    const percent = (seconds) => `${(Math.max(0, Math.min(seconds, duration)) / duration) * 100}%`;
    el.range.style.left = percent(state.start);
    el.range.style.width = `${((state.end - state.start) / duration) * 100}%`;
    el.inHandle.style.left = percent(state.start);
    el.outHandle.style.left = percent(state.end);
    el.headMark.style.left = percent(player()?.currentTime || 0);
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
        throw new Error(
          formats.liveWithoutIndex
            ? "라이브·지난 라이브는 아직 지원하지 않습니다. 데스크톱 앱을 써주세요."
            : "받을 수 있는 mp4 화질이 없습니다",
        );
      }
      state.formats = formats;
      el.quality.replaceChildren(
        ...formats.video.map((format) =>
          make("option", { value: String(format.itag), text: formatLabel(format) }),
        ),
      );
      setRange(0, player()?.duration || formats.durationSeconds || 0);
      setStatus("");
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

  // 재생 위치 표시가 영상을 따라가게 한다.
  document.addEventListener(
    "timeupdate",
    (event) => {
      if (state.open && event.target?.tagName === "VIDEO") renderTimeline();
    },
    true,
  );

  // 편집 프로그램처럼 I / O 로 시작점·끝점을 찍는다.
  document.addEventListener("keydown", (event) => {
    if (!state.open || event.ctrlKey || event.altKey || event.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (event.key === "i" || event.key === "I") markHere("start");
    else if (event.key === "o" || event.key === "O") markHere("end");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

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
