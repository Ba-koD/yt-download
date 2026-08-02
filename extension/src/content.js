// 유튜브 영상 페이지의 좋아요·공유 줄에 "구간 받기" 버튼을 넣고,
// 누르면 영상 아래에 구간 편집 패널을 펼친다.
//
// content script 는 확장의 격리된 세계에서 돌지만 네트워크는 페이지(youtube.com) 몫으로 나간다.
// 덕분에 InnerTube 는 동일 출처로, 미디어는 Range 를 허용하는 CORS 로 그대로 받을 수 있다.

(async () => {
  // 붙었는지 콘솔에서 바로 알 수 있게 한 줄 남긴다.
  // 이게 안 보이면 확장이 이 페이지에 붙지 않은 것이다(새로고침이나 재로드가 필요하다).
  const say = (...parts) => console.info("[yt-download]", ...parts);

  const load = (name) => import(chrome.runtime.getURL(`src/${name}`));
  const [
    { downloadSection, getFormats, safeFileName, clockLabel, createControl, Stopped },
    { formatLabel },
    net,
    nsig,
  ] =
    await Promise.all([
      load("download.js"),
      load("innertube.js"),
      load("net.js"),
      load("nsig.js"),
    ]);

  // 미디어는 페이지 쪽에서 받아온다. 여기서 곧바로 부르면 교차 출처로 막히고,
  // 배경 일꾼으로 보내면 Origin 이 붙어 InnerTube 가 403 을 준다.
  // youtube.com 은 여기가 동일 출처라 그대로 부른다.
  const direct = net.directTransport();
  const viaPage = net.pageTransport();
  net.useTransport({
    json: direct.json,
    text: direct.text,
    // googlevideo 가 다른 호스트로 넘기면 페이지 쪽이 CORS 로 막힐 때가 있다.
    // 그때는 배경 일꾼이 대신 받아온다(느리지만 확실하다).
    bytes: net.withFallback(viaPage.bytes, net.workerBytes(chrome.runtime)),
  });

  const state = {
    videoId: null,
    formats: null,
    start: 0,
    end: 0,
    busy: false,
    open: false,
    drag: null,
    saveTimer: null,
    // 사용자가 구간을 직접 정했는지. 그 전에는 길이를 알게 될 때마다 전 구간으로 맞춰준다.
    touched: false,
    // 페이지 쪽 플레이어가 알려준 재생 위치·되감기 구간.
    progress: null,
    // 받는 중에 멈추거나 그만두게 해주는 손잡이.
    control: null,
  };

  // 패널이 열려 있는 동안만 페이지에게 재생 상태를 받아온다.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.ytdl !== "progress") return;
    const before = state.progress;
    state.progress = {
      start: event.data.start,
      end: event.data.end,
      current: event.data.current,
      live: event.data.live,
    };
    // 처음 알게 됐거나 길이가 달라졌을 때만 다시 그린다(매 400ms 그리면 낭비다).
    const changed = !before || before.end !== state.progress.end ||
      before.current !== state.progress.current;
    if (changed && state.open) renderTimeline();
  });

  const watchProgress = (on) => window.postMessage({ ytdl: "watch-progress", on }, "*");

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

  // 골라둔 구간을 영상별로 기억한다. 실수로 창을 닫거나 다른 영상에 갔다 와도 그대로 남는다.
  const SAVED_KEY = "ytdl-sections";
  const SAVED_LIMIT = 200;

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveRange() {
    if (!state.videoId) return;
    try {
      const all = readSaved();
      all[state.videoId] = { start: state.start, end: state.end, at: Date.now() };
      // 오래된 것부터 버려서 저장 공간이 넘치지 않게 한다.
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, SAVED_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(SAVED_KEY, JSON.stringify(trimmed));
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
  }

  function savedRange(videoId) {
    const saved = readSaved()[videoId];
    if (!saved || !Number.isFinite(saved.start) || !Number.isFinite(saved.end)) return null;
    return saved.end > saved.start ? saved : null;
  }

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  }

  function player() {
    return document.querySelector(".html5-main-video") || document.querySelector("video");
  }

  /**
   * 타임라인이 다룰 구간. 대개 0~길이지만 라이브는 다르다.
   *
   * 라이브에서 `video.seekable` 과 `duration` 은 믿을 수 없다. 실제 되감기 구간보다
   * 한 시간쯤 앞을 가리켜서, 라이브 지점을 보고 있는데도 막대가 중간에 놓인다.
   * (14시간짜리 방송에서 잰 값: seekable 끝 50400, 실제 라이브 지점 46813)
   * 플레이어가 가진 값이 정확하므로 페이지 쪽에서 받아온 걸 먼저 쓴다.
   */
  function bounds() {
    if (state.progress) return { start: state.progress.start, end: state.progress.end };

    const video = player();
    const known = Number(video?.duration);
    if (Number.isFinite(known) && known > 0) return { start: 0, end: known };

    const fallback = Number(state.formats?.durationSeconds) || 0;
    return { start: 0, end: fallback };
  }

  /** 지금 재생 중인 지점. 라이브에서는 플레이어가 알려준 값이 정확하다. */
  function playedSeconds() {
    if (state.progress) return state.progress.current;
    return Number(player()?.currentTime) || 0;
  }

  function boundsSpan() {
    const { start, end } = bounds();
    return Math.max(0, end - start);
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
      const { start, end } = bounds();
      return start + Math.max(0, Math.min(1, ratio)) * Math.max(0, end - start);
    };

    const startDrag = (what) => (event) => {
      // 길이를 아직 모르면 아무 데나 눌러도 0초로 튀어버린다. 그 전에는 받지 않는다.
      if (boundsSpan() <= 0) return;
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

  // 영상 위치는 사용자가 타임라인을 직접 끌 때만 옮긴다.
  // 시간 칸을 고치거나 목록을 불러오는 것만으로 재생 위치가 바뀌면 성가시다.
  function seek(seconds) {
    const video = player();
    if (video && Number.isFinite(seconds) && boundsSpan() > 0) video.currentTime = seconds;
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
    // 받는 동안에만 보이는 버튼들.
    el.hold = make("button", { class: "ytdl-hold", type: "button", text: "일시정지", hidden: true });
    el.halt = make("button", { class: "ytdl-halt", type: "button", text: "정지", hidden: true });
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
          el.hold,
          el.halt,
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
      });
    }

    el.go.addEventListener("click", start);
    el.hold.addEventListener("click", () => {
      if (!state.control) return;
      if (state.control.paused) state.control.resume();
      else state.control.pause();
      render();
    });
    el.halt.addEventListener("click", () => state.control?.stop());
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
    // 열려 있는 동안만 재생 상태를 받아온다.
    watchProgress(state.open);
    // 목록은 처음 열 때만 받아온다(영상마다 미리 받아두면 낭비다).
    if (state.open && !state.formats) await loadFormats();
  }

  /** 아직 손대지 않았으면 전 구간을 고른 상태로 둔다. */
  function selectWhole() {
    const edge = bounds();
    if (edge.end <= edge.start) return false;
    state.start = edge.start;
    state.end = edge.end;
    render();
    return true;
  }

  function setRange(start, end) {
    const edge = bounds();
    const low = edge.end > edge.start ? edge.start : 0;
    const high = edge.end > edge.start ? edge.end : Math.max(start, end);
    state.start = Math.max(low, Math.min(start, high));
    state.end = Math.max(low, Math.min(end, high));
    if (state.end < state.start) [state.start, state.end] = [state.end, state.start];
    state.touched = true;
    render();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveRange, 400);
  }

  function render() {
    if (!el.panel) return;
    el.inputs.start.value = showClock(state.start);
    el.inputs.end.value = showClock(state.end);
    const length = Math.max(0, state.end - state.start);
    el.length.textContent = showClock(length);
    el.go.disabled = state.busy || !state.formats || length < 0.5;
    el.hold.hidden = !state.busy;
    el.halt.hidden = !state.busy;
    el.hold.textContent = state.control?.paused ? "이어받기" : "일시정지";
    renderTimeline();
  }

  function renderTimeline() {
    const edge = bounds();
    const span = edge.end - edge.start;
    el.total.textContent = span > 0 ? showClock(span) : "";
    if (span <= 0) return;
    const percent = (seconds) =>
      `${(Math.max(0, Math.min(seconds - edge.start, span)) / span) * 100}%`;
    el.range.style.left = percent(state.start);
    el.range.style.width = `${((state.end - state.start) / span) * 100}%`;
    el.inHandle.style.left = percent(state.start);
    el.outHandle.style.left = percent(state.end);
    el.headMark.style.left = percent(playedSeconds());
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
      // 로그인해야 볼 수 있는 영상은 주소의 `n` 을 풀어야 받을 수 있다.
      const unlock = (urls) =>
        nsig.solveUrls(urls, {
          runtime: chrome.runtime,
          ask: (payload) => viaPage.ask(payload, "solve"),
          onStep: (text) => setStatus(text),
        });
      const formats = await getFormats(videoId, null, unlock);
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
      const saved = savedRange(videoId);
      if (saved) {
        state.touched = true;
        setRange(saved.start, saved.end);
        setStatus("지난번에 골라둔 구간을 불러왔습니다");
      } else {
        selectWhole();
        setStatus("");
      }
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
      say("화질 목록 실패:", error);
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
    state.control = createControl();
    render();
    const began = Date.now();

    try {
      const { bytes, mediaStart, mediaSeconds } = await downloadSection({
        videoFormat,
        audioFormat: state.formats.audio[0],
        start: state.start,
        end: state.end,
        control: state.control,
        onProgress: (done, total, stage) => {
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          const paused = state.control?.paused ? " (멈춤)" : "";
          setStatus(stage === "받는 중" ? `${stage} ${percent}%${paused}` : stage);
        },
      });

      // 영상은 키프레임에서만 자를 수 있어 실제 파일은 고른 지점보다 조금 앞에서 시작한다.
      // 이름도 실제 내용에 맞춰 붙인다. 이름과 속이 다르면 헷갈리기만 한다.
      const realStart = Number.isFinite(mediaStart) ? mediaStart : state.start;
      save(
        bytes,
        `${safeFileName(state.formats.title)} ` +
          `[${clockLabel(realStart)}~${clockLabel(state.end)}].mp4`,
      );
      const took = ((Date.now() - began) / 1000).toFixed(1);
      const lead = state.start - realStart;
      const note = lead >= 0.5 ? ` · 앞 ${lead.toFixed(1)}초가 더 붙었습니다(키프레임)` : "";
      setStatus(
        `저장했습니다 · ${showClock(realStart)}~${showClock(state.end)} ` +
          `(${showClock(mediaSeconds)})${note} · ` +
          `${(bytes.length / 1048576).toFixed(1)} MB · ${took}초`,
        "ytdl-ok",
      );
    } catch (error) {
      // 내가 정지를 누른 것은 실패가 아니다.
      if (error instanceof Stopped) setStatus("받기를 멈췄습니다");
      else {
        setStatus(error.message, "ytdl-bad");
        say("받기 실패:", error);
      }
    } finally {
      state.busy = false;
      state.control = null;
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
  say("준비됨 · 좋아요 옆 '구간 받기' 버튼을 눌러주세요");

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
    // 영상 길이는 늦게 정해진다(특히 라이브). 손대기 전이라면 전 구간을 따라간다.
    if (state.open && !state.touched) selectWhole();
    const id = currentVideoId();
    if (id && id !== lastId) {
      lastId = id;
      state.formats = null;
      state.videoId = id;
      state.touched = false;
      // 이전 영상의 재생 위치를 새 영상에 쓰면 안 된다.
      state.progress = null;
      // 열려 있으면 새 영상 목록으로 갈아끼우고, 닫혀 있으면 열 때 받는다.
      if (state.open) loadFormats();
      else render();
    }
  }, 1000);
})().catch((error) => {
  console.error("[yt-download] 시작하지 못했습니다:", error);
});
