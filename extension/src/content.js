// 유튜브 영상 페이지의 좋아요·공유 줄에 "구간 받기" 버튼을 넣고,
// 누르면 영상 아래에 구간 편집 패널을 펼친다.
//
// 숏츠도 같은 방식으로 받는다. 화면 생김새만 달라서(오른쪽 세로 버튼 줄, 아래 정보칸 없음)
// 버튼은 그 세로 줄에 넣고 패널은 화면 아래에 띄운다. 받는 일 자체는 똑같다.
//
// content script 는 확장의 격리된 세계에서 돌지만 네트워크는 페이지(youtube.com) 몫으로 나간다.
// 덕분에 InnerTube 는 동일 출처로, 미디어는 Range 를 허용하는 CORS 로 그대로 받을 수 있다.
//
// 이 스크립트는 **유튜브의 모든 화면**에 붙는다(영상 주소만 고르지 않는다).
// 유튜브는 한 번 띄운 뒤로 화면만 갈아 끼우는데(SPA), 그때 크롬은 content script 를
// 다시 넣어주지 않는다. 영상 주소만 골라 붙이면 홈에서 영상을 눌러 들어갔을 때
// 아무것도 붙지 않아서, F5 를 눌러야 버튼이 떴다. 대신 영상 화면이 아닐 때는
// `mount()` 가 얹은 것을 걷어내고 아무 일도 하지 않는다.

(async () => {
  // 붙었는지 콘솔에서 바로 알 수 있게 한 줄 남긴다.
  // 이게 안 보이면 확장이 이 페이지에 붙지 않은 것이다(새로고침이나 재로드가 필요하다).
  const say = (...parts) => console.info("[yt-download]", ...parts);

  // 이 판을 걷어낼 때 할 일들.
  //
  // 확장이 스스로 갱신하면 배경 일꾼이 열려 있는 탭에 새 판을 곧바로 넣는다(F5 가 필요 없게).
  // 그때 옛 판이 그대로 남아 있으면 버튼과 패널이 둘씩 생기고 타이머도 두 벌 돈다.
  // 그래서 새 판은 들어오자마자 옛 판에게 물러나라고 한다.
  //
  // 알리는 길이 둘인 이유: 다시 켜진 확장은 **격리된 세계가 새로 만들어져서** 옛 판의
  // 전역 변수가 보이지 않는다(실제로 그래서 버튼이 둘 생겼다). DOM 은 두 세계가 함께 보므로
  // 이벤트로 알린다. 같은 세계에 다시 얹히는 경우를 위해 전역 표시도 함께 둔다.
  const STAND_DOWN = "ytdl-stand-down";
  const cleanup = [];
  window.dispatchEvent(new Event(STAND_DOWN));
  window.__ytdlTeardown?.();
  window.__ytdlTeardown = () => {
    window.__ytdlTeardown = null;
    for (const undo of cleanup.splice(0)) {
      try {
        undo();
      } catch {
        // 걷어내다 하나가 실패해도 나머지는 걷어내야 한다.
      }
    }
  };

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
    // 끝점을 "끝까지"로 둔 상태. 라이브면 방송이 진행되는 만큼 따라간다.
    toEnd: false,
    // 지금 붙어 있는 화면 종류("watch" 또는 "shorts"). 바뀌면 붙일 자리를 다시 잡는다.
    mode: null,
    // 옆에 선 유튜브 버튼을 재서 치수를 맞췄는지. 못 쟀으면 다음 차례에 다시 해본다.
    matched: false,
    // 띄운 패널을 끌고 있는 중인지, 그리고 사용자가 한 번이라도 직접 옮겼는지.
    panelDrag: null,
    panelMoved: false,
    // 구간 손잡이를 놓았을 때 영상을 옮겨줄 지점.
    dropAt: null,
  };

  /** 걷어낼 때 같이 떼어내도록 붙여둔다. */
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  // 나중에 들어온 판이 물러나라고 하면 물러난다.
  listen(window, STAND_DOWN, () => window.__ytdlTeardown?.());

  // 패널이 열려 있는 동안만 페이지에게 재생 상태를 받아온다.
  listen(window, "message", (event) => {
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
      all[state.videoId] = {
        start: state.start,
        end: state.end,
        toEnd: state.toEnd,
        at: Date.now(),
      };
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
    // /live/<id> 와 /shorts/<id> 는 주소 자체가 영상 ID 다.
    if (url.pathname.startsWith("/live/") || url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/")[2] || null;
    }
    return url.searchParams.get("v");
  }

  function isShorts() {
    return location.pathname.startsWith("/shorts/");
  }

  /** 영상 화면인지. 홈·검색·채널 같은 데서는 얹을 것이 없다. */
  function isVideoPage() {
    const path = location.pathname;
    return path === "/watch" || path.startsWith("/live/") || path.startsWith("/shorts/");
  }

  /**
   * 지금 보고 있는 숏츠 한 편.
   *
   * 편을 넘겨도 `ytd-reel-video-renderer` 는 하나뿐이고 유튜브가 그 안을 갈아 끼운다.
   * 표시용 속성(`is-active` 같은 것)은 이 버전에 없어서, 플레이어가 들어 있는 쪽을
   * 지금 보는 편으로 본다. 이름이 바뀌어도 플레이어는 하나라 이 방법이 오래 간다.
   */
  function activeReel() {
    const shortsPlayer = document.querySelector("#shorts-player");
    return (
      shortsPlayer?.closest("ytd-reel-video-renderer") ||
      document.querySelector("ytd-reel-video-renderer")
    );
  }

  // 숏츠는 다음 편을 미리 붙여 두기 때문에 <video> 가 여러 개 있다.
  // 아무거나 집으면 보고 있지 않은 영상의 시간을 읽게 된다.
  function player() {
    if (isShorts()) {
      const inPlayer = document.querySelector("#shorts-player video");
      if (inPlayer) return inPlayer;
      const inReel = activeReel()?.querySelector("video");
      if (inReel) return inReel;
    }
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

  /**
   * 내려받기 아이콘. 글자(↧)로 그리면 글꼴마다 굵기와 자리가 달라 옆 버튼들과 따로 논다.
   *
   * 이 그림은 **유튜브가 자기 화면에서 쓰는 그것 그대로다**(왼쪽 목록의 "오프라인 저장
   * 동영상"에서 그대로 가져왔다). 비슷하게 새로 그리면 선 굵기와 끝 모양이 미묘하게
   * 달라서 나란히 놓았을 때 티가 난다(실제로 티가 났다 — 유튜브의 옛 얇은 아이콘을
   * 억지로 키워 썼더니 선만 두꺼워졌다).
   *
   * 24 틀에서 세로로 2~22 를 차지한다. 재보니 유튜브가 이 줄에 쓰는 아이콘들도 20~21 이라
   * 크기를 따로 맞출 것이 없다.
   */
  const DOWNLOAD_PATH =
    "M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 " +
    "10-1.414-1.414L13 14.586V3a1 1 0 00-1-1Zm7 18H5a1 1 0 000 2h14a1 1 0 000-2Z";

  function downloadIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", DOWNLOAD_PATH);
    svg.append(path);
    return svg;
  }

  // 유튜브의 좋아요·공유 버튼과 나란히 설 버튼.
  // 숏츠에서는 오른쪽 세로 줄에 들어가므로 아이콘만 있는 동그란 모양으로 바꾼다.
  function buildButton(shorts) {
    const icon = make("span", { class: "ytdl-open-icon" }, [downloadIcon()]);
    icon.setAttribute("aria-hidden", "true");
    const button = make(
      "button",
      {
        id: "ytdl-open",
        class: shorts ? "ytdl-open ytdl-open-reel" : "ytdl-open",
        type: "button",
        title: "이 영상의 원하는 구간만 받기",
      },
      [icon, make("span", { class: "ytdl-open-label", text: shorts ? "구간" : "구간 받기" })],
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

      if (state.drag === "seek") {
        // 재생 위치를 끄는 중이라면 영상이 곧바로 따라가야 한다.
        seek(value);
      } else {
        // 구간 손잡이는 놓을 때 한 번만 옮긴다. 끄는 내내 영상이 따라다니면
        // 되감기가 이어지면서 화면이 어지럽고, 어디를 잡았는지도 잘 안 보인다.
        state.dropAt = value;
      }
    };

    const dropDrag = () => {
      if (state.drag && state.drag !== "seek" && state.dropAt !== null) seek(state.dropAt);
      state.drag = null;
      state.dropAt = null;
    };

    el.inHandle.addEventListener("pointerdown", startDrag("in"));
    el.outHandle.addEventListener("pointerdown", startDrag("out"));
    el.track.addEventListener("pointerdown", (event) => {
      if (event.target === el.inHandle || event.target === el.outHandle) return;
      startDrag("seek")(event);
    });
    el.track.addEventListener("pointermove", onDrag);
    el.track.addEventListener("pointerup", dropDrag);
    el.track.addEventListener("pointercancel", dropDrag);

    return el.track;
  }

  // 영상 위치는 사용자가 타임라인을 직접 끌 때만 옮긴다.
  // 시간 칸을 고치거나 목록을 불러오는 것만으로 재생 위치가 바뀌면 성가시다.
  function seek(seconds) {
    const video = player();
    if (video && Number.isFinite(seconds) && boundsSpan() > 0) video.currentTime = seconds;
  }

  function buildPanel(floating) {
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
    // 양 끝으로 보내는 버튼. 안쪽 대괄호가 "지금 위치", 바깥 화살표가 "맨 끝"이라
    // 줄만 봐도 어느 쪽이 더 멀리 가는지 알 수 있다.
    const toStart = make("button", {
      class: "ytdl-mark", type: "button", text: "⇤", title: "시작점을 맨 앞으로 (Home)",
      dataset: { edge: "start" },
    });
    const toEnd = make("button", {
      class: "ytdl-mark", type: "button", text: "⇥", title: "끝점을 맨 끝으로 (End)",
      dataset: { edge: "end" },
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

    const head = make("div", { class: "ytdl-head" }, [
      make("span", { class: "ytdl-title", text: "구간 받기" }),
      el.total,
      close,
    ]);
    if (floating) bindPanelDrag(head);

    // 숏츠에는 영상 아래에 끼워 넣을 자리가 없다. 화면 위에 띄운다.
    const panel = make("div", { class: floating ? "ytdl-panel ytdl-float" : "ytdl-panel", hidden: true }, [
      head,
      make("div", { class: "ytdl-body" }, [
        buildTimeline(),
        make("div", { class: "ytdl-row" }, [
          toStart,
          markIn,
          el.inputs.start,
          make("span", { class: "ytdl-sep", text: "~" }),
          el.inputs.end,
          markOut,
          toEnd,
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
    for (const button of [toStart, toEnd]) {
      button.addEventListener("click", () => markEdge(button.dataset.edge));
    }

    for (const [which, input] of Object.entries(el.inputs)) {
      input.addEventListener("change", () => {
        // 끝칸을 비우면 "끝까지"라는 뜻으로 받는다.
        if (which === "end" && !input.value.trim()) {
          setRange(state.start, bounds().end);
          return;
        }
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

  /** 시작점을 맨 앞으로, 또는 끝점을 맨 끝으로. 라이브면 "끝"은 지금 받을 수 있는 데까지다. */
  function markEdge(which) {
    const edge = bounds();
    if (edge.end <= edge.start) return;
    if (which === "start") setRange(edge.start, state.end);
    else setRange(state.start, edge.end);
  }

  /**
   * 버튼을 넣을 자리. 숏츠는 좋아요·댓글이 있는 오른쪽 세로 줄이다.
   *
   * 그 줄은 `reel-action-bar-view-model` 이다. 일반 화면의 `#actions` 는 숏츠에도
   * 빈 껍데기로 남아 있어서 그걸 찾으면 크기 0인 자리에 버튼을 붙이게 된다(실제로 그랬다).
   */
  function buttonHost() {
    if (isShorts()) {
      const reel = activeReel();
      return (
        reel?.querySelector("reel-action-bar-view-model") ||
        reel?.querySelector(".ytReelPlayerOverlayViewModelActionsContainer") ||
        document.querySelector("reel-action-bar-view-model")
      );
    }
    return (
      document.querySelector("#actions #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner")
    );
  }

  /**
   * 옆에 선 유튜브 버튼을 재서 우리 버튼을 같은 치수로 맞춘다.
   *
   * 치수를 CSS 에 적어두면 유튜브가 버튼을 손볼 때마다 우리 것만 어긋난다(실제로 어긋났다 —
   * 높이도 색도 옆 버튼과 달랐다). 그래서 그 줄에 실제로 서 있는 버튼에서 높이·모서리·여백·
   * 글꼴·색을 읽어 그대로 쓴다. 밝게/어둡게 테마도 이걸로 함께 따라온다.
   *
   * 읽은 값은 사용자 지정 속성으로 넣는다. 그래야 :hover 와 눌린 상태 규칙이 그대로 산다
   * (인라인 background 로 박으면 그 규칙들이 전부 진다).
   */
  function matchNeighbour() {
    // 숏츠 쪽은 세로 줄에 맞춘 다른 모양이라 여기서 건드리지 않는다.
    if (!el.button || state.mode !== "watch") return;
    const host = el.button.parentElement;
    const sample = sampleButton(host);
    // 옆 버튼이 아직 안 그려졌을 수 있다. 그때는 표시를 남기지 않아서 다음 차례에 다시 잰다.
    if (!sample) return;
    state.matched = true;

    const style = getComputedStyle(sample);
    const box = sample.getBoundingClientRect();
    const set = (name, value) => value && el.button.style.setProperty(name, value);

    const height = Math.round(box.height);
    set("--ytdl-open-h", `${height}px`);
    // 모서리는 베끼지 않고 높이의 절반으로 둔다. 이 줄의 버튼은 모두 완전한 알약인데,
    // 좋아요·싫어요는 서로 붙어 있어 한쪽만 둥글게 적혀 있다(그대로 베끼면 우리도 반쪽이 된다).
    set("--ytdl-open-r", `${height / 2}px`);
    set("--ytdl-open-font", `${style.fontWeight} ${style.fontSize}/1 ${style.fontFamily}`);
    set("--ytdl-open-track", style.letterSpacing === "normal" ? "" : style.letterSpacing);
    set("--ytdl-open-fg", style.color);
    // 좌우 여백은 글자가 있는 버튼에서만 뜻이 있다. 동그란 아이콘 버튼은 여백이 0 이다.
    if (sample.textContent.trim()) {
      set("--ytdl-open-pad", `0 ${style.paddingRight} 0 ${style.paddingLeft}`);
    }
    // 속이 빈 버튼을 골랐다면 색은 우리 기본값을 쓴다(투명을 그대로 쓰면 바탕이 사라진다).
    const background = style.backgroundColor;
    if (background && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(background)) {
      set("--ytdl-open-bg", background);
    }
    // 아이콘 크기는 여기서 재지 않는다. 유튜브의 틀은 24 였다가 48 이었다가 하지만
    // 그 안의 그림은 어디서나 20~21 이라, 틀을 베끼면 우리 것만 두 배로 커진다.
    // 유튜브의 그림을 그대로 쓰므로 애초에 맞춰져 있다(downloadIcon 참고).

    // 옆 버튼과의 사이. 유튜브는 여백을 버튼이 아니라 그것을 감싼 껍데기에 준다.
    // 줄 자체가 벌려 주고 있으면(gap) 우리만 여백을 더하면 안 된다.
    const wrapper = [...host.children].find((node) => node.contains(sample));
    const own = Number.parseFloat(wrapper ? getComputedStyle(wrapper).marginLeft : "");
    const gap = Number.parseFloat(getComputedStyle(host).columnGap);
    set("--ytdl-open-ml", gap > 0 ? "0px" : own > 0 ? `${own}px` : "8px");
  }

  /**
   * 견줄 만한 유튜브 버튼 하나.
   *
   * 까다롭게 고르면 안 된다. 창이 좁으면 유튜브는 공유·저장을 글자 없는 `⋯` 동그라미
   * 하나로 접어버린다. 그러면 "글자 있는 알약"만 찾다가 아무것도 못 고른다(실제로 그랬다 —
   * 재지 못해 우리 버튼만 36px 로 남고 옆 버튼들은 40px 이었다).
   *
   * 그래서 보이는 버튼이면 무엇이든 받아들이고, 글자가 있는 것을 먼저 본다.
   * 좌우 여백과 글꼴은 글자 있는 버튼에서만 뜻이 있기 때문이다.
   */
  function sampleButton(host) {
    if (!host) return null;
    const buttons = [...host.querySelectorAll("button")].filter((node) => {
      if (node === el.button || el.button?.contains(node)) return false;
      const box = node.getBoundingClientRect();
      return box.height > 20 && box.width > 0;
    });
    return buttons.find((node) => node.textContent.trim()) || buttons[0] || null;
  }

  /** 패널을 끼워 넣을 자리. 숏츠는 끼울 데가 없어서 화면 위에 띄운다(그때는 null). */
  function panelAnchor() {
    if (isShorts()) return null;
    return document.querySelector("ytd-watch-metadata") || document.querySelector("#below");
  }

  /** 띄운 패널이 설 가로 자리. 필요한 최소 너비. */
  const FLOAT_MIN_WIDTH = 320;
  const FLOAT_MAX_WIDTH = 430;
  const FLOAT_GAP = 16;

  /**
   * 숏츠에서 패널을 세로 버튼 줄 오른쪽 빈자리에 세운다.
   *
   * 고정된 `right` 값으로 두면 안 된다 — 세로 버튼 줄이 영상 바로 옆에 붙어 있어서
   * 창 크기에 따라 그 버튼들을 덮어버린다(재보니 실제로 덮었다).
   * 자리가 모자라면 화면 아래에 눕힌다.
   */
  /**
   * 제목 줄을 잡아 패널을 옮긴다.
   *
   * 한 번이라도 직접 옮겼으면 그 뒤로는 자동 배치를 하지 않는다. 놓아둔 자리가
   * 매 초 원래대로 돌아가면 옮기는 의미가 없다.
   */
  function bindPanelDrag(head) {
    head.addEventListener("pointerdown", (event) => {
      // 닫기 단추를 누른 것은 끌기가 아니다.
      if (event.target.closest(".ytdl-close")) return;
      const rect = el.panel.getBoundingClientRect();
      state.panelDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      state.panelMoved = true;
      // 지금 보이는 그 자리에서 시작하도록 좌표를 굳힌다(가운데 맞춤을 풀어준다).
      el.panel.classList.remove("ytdl-float-bottom");
      el.panel.style.transform = "none";
      el.panel.style.bottom = "auto";
      el.panel.style.width = `${Math.round(rect.width)}px`;
      moveFloatingPanel(rect.left, rect.top);
      try {
        head.setPointerCapture(event.pointerId);
      } catch {
        // 잡아두지 못해도 끄는 것 자체는 된다(포인터가 밖으로 나가면 멈출 뿐).
      }
      event.preventDefault();
    });

    head.addEventListener("pointermove", (event) => {
      if (!state.panelDrag) return;
      moveFloatingPanel(event.clientX - state.panelDrag.x, event.clientY - state.panelDrag.y);
    });

    const drop = () => {
      state.panelDrag = null;
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);
  }

  /** 화면 밖으로 나가지 않게 잡아두고 옮긴다. */
  function moveFloatingPanel(left, top) {
    const width = el.panel.offsetWidth;
    const height = el.panel.offsetHeight;
    const limit = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
    el.panel.style.left = `${Math.round(limit(left, window.innerWidth - width - 8))}px`;
    el.panel.style.top = `${Math.round(limit(top, window.innerHeight - height - 8))}px`;
  }

  function placeFloatingPanel() {
    if (state.mode !== "shorts" || !el.panel || el.panel.hidden) return;
    // 사용자가 직접 옮겼으면 화면 밖으로 나가지 않게만 봐준다.
    if (state.panelMoved) {
      const rect = el.panel.getBoundingClientRect();
      moveFloatingPanel(rect.left, rect.top);
      return;
    }
    const bar = buttonHost()?.getBoundingClientRect();
    const room = bar ? window.innerWidth - bar.right - FLOAT_GAP * 2 : 0;
    if (bar && room >= FLOAT_MIN_WIDTH) {
      el.panel.classList.remove("ytdl-float-bottom");
      el.panel.style.left = `${Math.round(bar.right + FLOAT_GAP)}px`;
      el.panel.style.width = `${Math.round(Math.min(room, FLOAT_MAX_WIDTH))}px`;
    } else {
      el.panel.classList.add("ytdl-float-bottom");
      el.panel.style.left = "";
      el.panel.style.width = "";
    }
  }

  // 유튜브는 화면을 통째로 다시 그리는 일이 잦다. 사라졌으면 다시 붙인다.
  function mount() {
    // 영상 화면을 떠났다(홈·검색 …). 얹어둔 것을 걷어낸다.
    // 특히 숏츠 패널은 body 에 띄워 둔 것이라, 두면 엉뚱한 화면 위에 그대로 남는다.
    if (!isVideoPage()) {
      if (state.mode !== null) {
        el.button?.remove();
        el.panel?.remove();
        el.button = null;
        el.panel = null;
        state.mode = null;
        state.panelMoved = false;
        state.panelDrag = null;
        watchProgress(false);
      }
      return;
    }

    const mode = isShorts() ? "shorts" : "watch";
    // 숏츠와 일반 화면 사이를 오갈 때 유튜브는 문서를 새로 만들지 않는다.
    // 붙일 자리도 모양도 달라지므로 떼어내고 새로 만든다.
    if (state.mode !== mode) {
      state.mode = mode;
      el.button?.remove();
      el.button = null;
      el.panel?.remove();
      el.panel = null;
      // 옮겨둔 자리는 그 화면에서만 뜻이 있다.
      state.panelMoved = false;
      state.panelDrag = null;
    }

    const host = buttonHost();
    // 숏츠는 한 편 넘길 때마다 버튼 줄이 통째로 갈린다. 그러면 새 줄로 옮겨 붙인다.
    if (host && el.button?.parentElement !== host) {
      el.button = el.button || buildButton(mode === "shorts");
      el.button.classList.toggle("ytdl-open-active", state.open);
      // 숏츠에서는 좋아요 위에 둔다. 아래에 붙이면 창이 조금만 낮아도 화면 밖으로 밀린다.
      if (mode === "shorts") host.prepend(el.button);
      else host.append(el.button);
      // 새 줄에 붙었으면 치수도 그 줄의 버튼에서 다시 잰다.
      state.matched = false;
    }

    // 옆 버튼을 재서 치수를 맞춘다. 그 버튼들이 우리보다 늦게 그려질 때가 있어서,
    // 잴 수 있을 때까지 매 차례 다시 해본다(한 번 재고 나면 그만둔다).
    if (!state.matched) matchNeighbour();

    if (!el.panel || !el.panel.isConnected) {
      const anchor = panelAnchor();
      if (mode === "shorts" || anchor) {
        const panel = buildPanel(mode === "shorts");
        if (anchor) anchor.insertAdjacentElement("afterend", panel);
        else document.body.append(panel);
        panel.hidden = !state.open;
        // 열어둔 채 다른 화면에 갔다 왔으면 재생 상태 받아오기가 꺼져 있다. 다시 켠다.
        watchProgress(state.open);
        // 새로 만든 패널은 화질칸이 비어 있다. 이미 받아둔 목록이 있으면 그대로 채운다.
        fillQuality();
        render();
      }
    }
  }

  async function togglePanel() {
    state.open = !state.open;
    if (el.panel) el.panel.hidden = !state.open;
    placeFloatingPanel();
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
    state.toEnd = true;
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
    // 끝에 붙여뒀으면 "끝까지"로 본다. 라이브면 방송이 나아가는 만큼 함께 간다.
    state.toEnd = high > low && state.end >= high - 0.5;
    state.touched = true;
    render();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveRange, 400);
  }

  function render() {
    if (!el.panel) return;
    el.inputs.start.value = showClock(state.start);
    // 끝까지 받는 중이면 시각 대신 그렇다고 적는다. 라이브는 끝이 계속 밀리니까.
    el.inputs.end.value = state.toEnd ? "" : showClock(state.end);
    el.inputs.end.placeholder = state.toEnd ? "끝까지" : "";
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

  /** 받아둔 화질 목록을 화질칸에 채운다. 패널을 다시 만들었을 때도 쓴다. */
  function fillQuality() {
    if (!el.quality || !state.formats) return;
    el.quality.replaceChildren(
      ...state.formats.video.map((format) =>
        make("option", { value: String(format.itag), text: formatLabel(format) }),
      ),
    );
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
      fillQuality();
      const saved = savedRange(videoId);
      if (saved) {
        state.touched = true;
        // 끝까지로 저장돼 있었다면 지금 기준의 끝으로 되살린다(라이브는 그새 늘어난다).
        setRange(saved.start, saved.toEnd ? bounds().end : saved.end);
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
  say(
    isVideoPage()
      ? "준비됨 · 좋아요 옆 '구간 받기' 버튼을 눌러주세요"
      : "준비됨 · 영상 화면으로 가면 '구간 받기' 버튼이 붙습니다",
  );

  // 걷어낼 때는 화면에 얹은 것을 모두 치운다. 남겨두면 새 판의 것과 겹쳐 보인다.
  cleanup.push(() => {
    el.button?.remove();
    el.panel?.remove();
    watchProgress(false);
  });

  // 재생 위치 표시가 영상을 따라가게 한다.
  listen(
    document,
    "timeupdate",
    (event) => {
      if (state.open && event.target?.tagName === "VIDEO") renderTimeline();
    },
    true,
  );

  // 편집 프로그램처럼 I / O 로 시작점·끝점을 찍는다.
  listen(document, "keydown", (event) => {
    if (!state.open || event.ctrlKey || event.altKey || event.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (event.key === "i" || event.key === "I") markHere("start");
    else if (event.key === "o" || event.key === "O") markHere("end");
    // 양 끝으로 보내기. 편집 프로그램에서 Home/End 가 하는 일과 같다.
    else if (event.key === "Home") markEdge("start");
    else if (event.key === "End") markEdge("end");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  // 유튜브는 페이지를 새로 그리지 않고 영상만 갈아끼운다.
  // 창 크기가 바뀌면 띄운 패널이 설 자리도 달라진다.
  listen(window, "resize", placeFloatingPanel);

  // 화면을 갈아 끼웠다고 유튜브가 알려주는 순간. 아래 1초 시계가 어차피 다시 붙이지만,
  // 그때까지 버튼이 비어 있는 게 눈에 보인다. 알려주면 바로 붙인다.
  listen(window, "yt-navigate-finish", () => mount());

  // 테마를 밝게/어둡게 바꾸면 옆 버튼의 색이 달라진다. 다시 재서 맞춘다.
  const themeWatch = new MutationObserver(() => {
    state.matched = false;
    matchNeighbour();
  });
  themeWatch.observe(document.documentElement, { attributeFilter: ["dark"] });
  cleanup.push(() => themeWatch.disconnect());

  let lastId = currentVideoId();
  const ticker = setInterval(() => {
    mount();
    placeFloatingPanel();
    // 영상 길이는 늦게 정해진다(특히 라이브). 손대기 전이라면 전 구간을 따라간다.
    if (state.open && !state.touched) selectWhole();
    // "끝까지"로 둔 상태면 라이브가 나아가는 만큼 끝점도 함께 민다.
    else if (state.open && state.toEnd) {
      const edge = bounds();
      if (edge.end > state.end + 0.5) {
        state.end = edge.end;
        render();
      }
    }
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
  cleanup.push(() => clearInterval(ticker));
})().catch((error) => {
  console.error("[yt-download] 시작하지 못했습니다:", error);
});
