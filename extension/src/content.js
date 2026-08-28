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

  // 이 스크립트는 두 자리에서 돈다.
  //  - 확장: 격리된 세계. 모듈은 확장 주소로 하나씩 불러온다.
  //  - 북마클릿: 페이지 안. 확장 주소가 없으므로 번들이 미리 넣어둔 것을 그대로 쓴다.
  //
  // 어느 쪽인지는 **번들이 있는지**로 가른다. `chrome.runtime` 으로 가르면 안 된다 —
  // 확장이 깔린 브라우저에서는 페이지 쪽에도 `chrome.runtime` 이 있어서, 북마클릿이
  // 확장인 척하고 있지도 않은 배경 일꾼에게 조각을 부탁하게 된다.
  const bundled = window.__ytdlModules || null;
  const runtime = bundled ? null : chrome.runtime;
  const load = (name) => (bundled ? bundled[name] : import(runtime.getURL(`src/${name}`)));
  const [
    { downloadSection, downloadTrack, downloadClips, getFormats, safeFileName, clockLabel, createControl, Stopped },
    innertube,
    net,
    nsig,
    store,
  ] =
    await Promise.all([
      load("download.js"),
      load("innertube.js"),
      load("net.js"),
      load("nsig.js"),
      load("store.js"),
    ]);

  // 그만둔 이어받기 조각과 완성본 찌꺼기가 디스크(OPFS)에 눌러앉지 않게 이따금 청소한다.
  store.cleanup().catch(() => {});

  // 다운로드 속도 계량기. 통로를 지나간 바이트를 최근 8초 창으로 재서 속도를 만든다.
  // 누적치(bytes)는 받는 쪽이 용량을 알려주지 않을 때의 예비 표시로 쓴다.
  const meter = { events: [], bytes: 0 };
  const METER_WINDOW = 8000;
  const meterAdd = (count) => {
    meter.events.push({ at: Date.now(), count });
    meter.bytes += count;
  };
  const meterSpeed = () => {
    const now = Date.now();
    while (meter.events.length && now - meter.events[0].at > METER_WINDOW) meter.events.shift();
    if (!meter.events.length) return 0;
    const span = Math.max(1000, now - meter.events[0].at);
    return meter.events.reduce((sum, event) => sum + event.count, 0) / (span / 1000);
  };

  // 남은 시간 어림. 진행량의 최근 증가 속도로 잰다 — 진행량이 바이트(일반 영상)든
  // 조각 개수(라이브)든 똑같이 통해서, 어느 쪽에서도 예상 시간을 보여줄 수 있다.
  const pace = { events: [] };
  const PACE_WINDOW = 15_000;
  const paceAdd = (done) => {
    pace.events.push({ at: Date.now(), done });
  };
  const paceRemaining = (done, total) => {
    const now = Date.now();
    while (pace.events.length && now - pace.events[0].at > PACE_WINDOW) pace.events.shift();
    if (pace.events.length < 2) return null;
    const first = pace.events[0];
    const last = pace.events[pace.events.length - 1];
    const rate = ((last.done - first.done) / Math.max(1, last.at - first.at)) * 1000;
    if (rate <= 0) return null;
    return (total - done) / rate;
  };

  // 미디어는 페이지 쪽에서 받아온다. 확장에서 곧바로 부르면 교차 출처로 막히고,
  // 배경 일꾼으로 보내면 Origin 이 붙어 InnerTube 가 403 을 준다.
  // youtube.com 은 여기가 동일 출처라 그대로 부른다.
  const direct = net.directTransport();
  const viaPage = net.pageTransport();
  // 북마클릿은 이미 페이지 안이라 다리를 건널 것 없이 그대로 부르면 된다.
  // 대신 배경 일꾼이 없어서 CORS 로 막히면 예비 통로가 없다(alr 안내와 재시도로 버틴다).
  const media = runtime
    ? net.withFallback(viaPage.bytes, net.workerBytes(runtime))
    : direct.bytes;
  net.useTransport({
    json: direct.json,
    text: direct.text,
    // googlevideo 가 다른 호스트로 넘길 때 302 를 타면 페이지 쪽이 CORS 로 막힌다.
    // 그래서 alr=yes 로 "본문 안내" 를 받아 리다이렉트 자체를 피한다(withAppRedirect).
    // 그래도 막히면 배경 일꾼이 대신 받아온다(느리지만 확실하다 — withFallback).
    // 라이브 조각은 서버가 일시적으로 503 을 주는 일이 흔해서, 어느 통로든
    // 일시적인 실패는 잠깐 쉬었다 몇 번 더 받아 본다.
    bytes: net.withMeter(net.withRetry(net.withAppRedirect(media)), meterAdd),
    // SABR 은 POST 다. 위 껍데기들(재시도·alr 안내)은 GET 으로 범위를 받는 길에 맞춰져
    // 있어 여기에는 씌우지 않는다. 확장에서는 페이지 다리를, 북마클릿에서는 그냥 부른다.
    post: runtime ? viaPage.post : direct.post,
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
    // 받다 만 조각이 디스크에 남아 있는지. 버리기 버튼을 보일지 정한다.
    hasLeftovers: false,
    // 방금 저장을 마쳤는지. "폴더 열기" 버튼을 보일지 정한다.
    saved: false,
    // 담아둔 구간 목록. 오른쪽 딸림창에 선다.
    clips: [],
    // 지금 편집 중인 구간. 목록에서 고른 것이 여기 들어오고, 시각을 고치면 함께 바뀐다.
    activeClip: null,
    // 조각이 남아 있는 영상들. 왼쪽 딸림창에 선다.
    leftovers: [],
    // 딸림창을 접어 뒀는지. 담긴 것이 있어도 접혀 있으면 안 보인다.
    clipsShut: false,
    leftoversShut: false,
    // 남은 조각을 이 영상 것만 볼지, 이 브라우저에 쌓인 것을 전부 볼지.
    leftoversAll: false,
    // 받을 내용(영상+소리 / 영상만 / 소리만). 마지막 선택을 기억한다.
    media: savedMediaMode(),
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
    // 이 값이 어느 시점의 것인지 함께 적어 둔다. 사이를 메우는 데 쓴다(playedSeconds).
    state.progressAt = Number(player()?.currentTime);
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

  // 받을 내용 선택은 영상과 무관한 취향이라 하나만 기억한다.
  const MEDIA_KEY = "ytdl-media-mode";

  function savedMediaMode() {
    try {
      const value = localStorage.getItem(MEDIA_KEY);
      return value === "video" || value === "audio" ? value : "merged";
    } catch {
      return "merged";
    }
  }

  function saveMediaMode(value) {
    try {
      localStorage.setItem(MEDIA_KEY, value);
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
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

  // 담아둔 구간 목록도 영상별로 기억한다. 여러 구간을 잡아두는 일은 한 번에 끝나지 않는다 —
  // 창을 닫거나 다른 영상에 갔다 와도 그대로 있어야 쓸모가 있다.
  const CLIPS_KEY = "ytdl-clips";
  const CLIPS_LIMIT = 50;

  function readClipStore() {
    try {
      return JSON.parse(localStorage.getItem(CLIPS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveClipList() {
    if (!state.videoId) return;
    try {
      const all = readClipStore();
      if (state.clips.length) {
        all[state.videoId] = {
          at: Date.now(),
          clips: state.clips.map((clip) => ({
            start: clip.start,
            end: clip.end,
            picked: clip.picked,
            mode: clip.mode,
            itag: clip.itag,
          })),
        };
      } else {
        delete all[state.videoId];
      }
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, CLIPS_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(CLIPS_KEY, JSON.stringify(trimmed));
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
  }

  function savedClips(videoId) {
    const saved = readClipStore()[videoId];
    if (!saved?.clips?.length) return [];
    return saved.clips
      .filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start)
      .map((clip) => ({ ...clip, id: (state.clipSeq = (state.clipSeq || 0) + 1) }));
  }

  // 남은 조각 목록에 영상 제목을 보여주려고 기억해 둔다. 저장소에는 영상 ID 밖에 없는데,
  // ID 만 늘어놓으면 어느 영상인지 알 수 없다.
  const TITLE_KEY = "ytdl-titles";
  const TITLE_LIMIT = 200;

  function rememberTitle(videoId, title) {
    if (!videoId || !title) return;
    try {
      const all = JSON.parse(localStorage.getItem(TITLE_KEY) || "{}");
      all[videoId] = { title, at: Date.now() };
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, TITLE_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(TITLE_KEY, JSON.stringify(trimmed));
    } catch {
      // 못 적어도 ID 로 보여주면 된다.
    }
  }

  function knownTitle(videoId) {
    try {
      return JSON.parse(localStorage.getItem(TITLE_KEY) || "{}")[videoId]?.title || "";
    } catch {
      return "";
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

  /**
   * 지금 재생 중인 지점.
   *
   * 라이브에서는 플레이어가 알려준 값이라야 정확하다(영상 요소의 `currentTime` 은 방송
   * 전체가 아니라 지금 받아둔 창 안의 자리를 가리킨다). 그런데 그 값은 페이지에서
   * 0.4초에 한 번만 건너온다 — 그대로 쓰면 1/100초까지 적는 시계가 뚝뚝 끊긴다.
   *
   * 그래서 마지막으로 받은 값과, 그때의 `currentTime` 을 함께 기억해 두고 그 뒤로 흐른
   * 만큼을 더한다. 0.4초마다 값이 다시 오므로 어긋나도 그때 바로잡힌다.
   */
  function playedSeconds() {
    let now = Number(player()?.currentTime);
    // 우리가 옮긴 뒤로 움직이지 않았다면, 화면에 뜬 장의 시각을 쓴다. 한 장 이동은
    // 장 사이로 건너뛰어 보내므로 `currentTime` 그대로 적으면 없는 시각이 뜬다.
    const frame = state.shownFrame;
    if (frame && Number.isFinite(now) && Math.abs(now - frame.at) < 1e-3) now = frame.media;
    if (state.progress) {
      if (Number.isFinite(now) && Number.isFinite(state.progressAt)) {
        return state.progress.current + (now - state.progressAt);
      }
      return state.progress.current;
    }
    return Number.isFinite(now) ? now : 0;
  }

  function boundsSpan() {
    const { start, end } = bounds();
    return Math.max(0, end - start);
  }

  /**
   * 사람이 적은 시각을 초로 읽는다. `1:03.16`, `63.16`, `1:02:03.5` 를 모두 받는다.
   *
   * 빈 칸과 음수는 거절한다(`Number("")` 이 0 이라 그냥 두면 빈 칸이 0초로 들어간다).
   */
  function parseClock(text) {
    const raw = String(text).trim();
    if (!raw) return null;
    const parts = raw.split(":");
    if (parts.length > 3 || parts.some((part) => !part.trim())) return null;
    const numbers = parts.map(Number);
    if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
    return numbers.reduce((total, part) => total * 60 + part, 0);
  }

  /**
   * 초를 시:분:초로 적는다. `decimals` 를 주면 소수점 아래까지 적는다(예: `1:03.16`).
   *
   * 구간은 프레임 단위로 다뤄야 해서 소수점이 필요하지만, 남은 시간 같은 어림값에
   * 소수점을 붙이면 눈만 어지럽다. 그래서 부르는 쪽이 자릿수를 정한다.
   *
   * 반올림은 쪼개기 **전에** 한 번만 한다. 나중에 하면 59.996초가 `59.100` 으로 적힌다.
   */
  function showClock(seconds, decimals = 0) {
    const step = 10 ** decimals;
    const total = Math.round(Math.max(0, Number(seconds) || 0) * step) / step;
    const whole = Math.floor(total);
    const h = Math.floor(whole / 3600);
    const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    const s = String(whole % 60).padStart(2, "0");
    const clock = h ? `${h}:${m}:${s}` : `${m}:${s}`;
    if (decimals <= 0) return clock;
    const frac = String(Math.round((total - whole) * step)).padStart(decimals, "0");
    return `${clock}.${frac}`;
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

  /**
   * 한 장 이동 아이콘. 편집 프로그램에서 쓰는 모양 그대로 — 막대에 삼각형이 붙어 있다.
   * 막대가 "여기서 멈춘다", 삼각형이 "이쪽으로 한 칸"을 뜻한다.
   *
   * 글자(‹ ›)로 그리면 그냥 화살표로 보여서 한 장씩 간다는 뜻이 드러나지 않는다.
   */
  function frameIcon(back) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      back
        ? "M12.2 3.4v9.2L5.6 8l6.6-4.6ZM3.2 3.2h1.6v9.6H3.2Z"
        : "M3.8 3.4v9.2L10.4 8 3.8 3.4ZM11.2 3.2h1.6v9.6h-1.6Z",
    );
    svg.append(path);
    return svg;
  }

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
      const what = state.drag;
      const at = state.dropAt;
      state.drag = null;
      state.dropAt = null;
      if (!what) return;
      // 끌어 정한 자리도 장에 맞춘다. 손잡이는 화면 위 한 점이라 장 사이에 떨어지는데,
      // 그대로 두면 칸에 뜬 숫자와 실제로 받는 장이 어긋난다.
      if (what !== "seek" && at !== null) {
        seekToFrame(at).then(({ media }) => {
          setRange(what === "in" ? media : state.start, what === "out" ? media : state.end);
        });
      }
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
  /**
   * 제목 줄 시계를 화면 새로 고침에 맞춰 갱신한다.
   *
   * `timeupdate` 는 1초에 네 번쯤만 온다 — 1/100초까지 적는 칸에는 너무 성기다.
   * 대신 값이 실제로 바뀔 때만 글자를 다시 써서, 매 프레임 DOM 을 건드리지는 않는다.
   */
  function runClock(on) {
    cancelAnimationFrame(state.clockFrame || 0);
    state.clockFrame = 0;
    if (!on) return;
    const tick = () => {
      if (!state.open || !el.now || !el.now.isConnected) {
        state.clockFrame = 0;
        return;
      }
      const at = playedSeconds();
      // 고쳐 넣는 중이면 손대지 않는다. 커서가 튀고 글자가 지워진다.
      if (document.activeElement !== el.now) {
        const text = showClock(at, 2);
        if (el.now.value !== text) el.now.value = text;
      }
      // 타임라인의 재생 위치 표시도 같은 박자로 움직여야 따로 놀지 않는다.
      if (el.headMark) {
        const edge = bounds();
        const span = edge.end - edge.start;
        if (span > 0) {
          const ratio = Math.max(0, Math.min(at - edge.start, span)) / span;
          el.headMark.style.left = `${ratio * 100}%`;
        }
      }
      state.clockFrame = requestAnimationFrame(tick);
    };
    state.clockFrame = requestAnimationFrame(tick);
  }

  function seek(seconds) {
    const video = player();
    if (video && Number.isFinite(seconds) && boundsSpan() > 0) video.currentTime = seconds;
  }

  /**
   * 그 시각으로 영상을 옮기고, **실제로 화면에 뜬 프레임**의 시각을 돌려준다.
   *
   * 영상은 프레임 단위로만 존재한다(30fps 면 33.37ms 마다 한 장). 그래서 `7.14` 처럼
   * 적어 넣으면 화면에 뜨는 것은 그보다 조금 앞선 장이고, 받는 파일도 그 장부터 시작한다.
   * 여기서 실제 값을 받아 칸에 되적으면 눈에 보이는 숫자와 받을 파일이 어긋나지 않는다.
   *
   * `requestVideoFrameCallback` 이 **새로 그려진** 장의 정확한 시각을 알려준다. 여기서
   * "새로"가 중요하다 — 같은 장 안으로 옮기면 다시 그릴 것이 없어 콜백이 아예 오지 않는다.
   * 그때 `seeked` 가 주는 값(= 우리가 요청한 자리)을 장 시각으로 쓰면 실제로는 없는 시각이
   * 된다. 실측으로 겪었다: 한 장 이동이 13ms 만 움직이고 멈춰, 시계가 흔들려 보였다.
   * 그래서 콜백이 왔는지를 `fresh` 로 함께 알린다.
   *
   * @returns {Promise<{media: number, fresh: boolean}>}
   *   `fresh` 가 거짓이면 장이 바뀌지 않은 것이다(또는 콜백을 받지 못한 것이다).
   */
  function seekToFrame(seconds) {
    const video = player();
    if (!video || !Number.isFinite(seconds)) {
      return Promise.resolve({ media: seconds, fresh: false });
    }
    video.currentTime = seconds;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (media, fresh) => {
        if (settled) return;
        settled = true;
        const at = Number(video.currentTime);
        // 장이 그대로면 시각은 두고 "어느 자리에서 본 것인지"만 새로 적는다.
        // 그래야 시계가 계속 그 장의 시각을 적는다.
        if (fresh) state.shownFrame = { media, at };
        else if (state.shownFrame) state.shownFrame = { media: state.shownFrame.media, at };
        resolve({ media: fresh ? media : (state.shownFrame?.media ?? seconds), fresh });
      };
      video.requestVideoFrameCallback?.((_, info) => finish(info.mediaTime, true));
      // 새 장이면 콜백이 `seeked` 보다 먼저 온다(실측 6~10ms 대 12~16ms). 그래도 조금 더
      // 기다렸다 끊는다 — 같은 장이면 콜백은 영영 오지 않으므로 여기서 끝내야 한다.
      video.addEventListener("seeked", () => setTimeout(() => finish(null, false), 50), {
        once: true,
      });
      setTimeout(() => finish(null, false), 500);
    });
  }

  /**
   * 한 장 앞이나 뒤로 옮긴다. 유튜브도 `,` `.` 로 같은 일을 하지만 아는 사람이 드물다.
   *
   * 화질 목록이 알려주는 프레임률은 정확하지 않다 — 29.97 을 30 이라고 적어 보낸다.
   * 그래서 한 번에 크게 뛰지 않고 조금씩 밀어 보며, **새 장이 그려지면** 멈춘다.
   * 크게 뛰면 두 장을 건너뛰고, 작게만 뛰면 제자리다.
   */
  async function stepFrame(direction) {
    const video = player();
    if (!video || boundsSpan() <= 0) return;
    // 재생 중에는 옮겨봐야 곧 흘러가 버린다. 유튜브의 `,` `.` 도 멈춘 뒤에야 뜻이 있다.
    video.pause();
    const fps = Number(qualityChoices()[0]?.fps) || 30;
    const edge = bounds();
    const from = (await seekToFrame(video.currentTime)).media;
    for (let step = 1; step <= 8; step += 1) {
      const to = from + (direction * step * 0.4) / fps;
      const limited = Math.max(edge.start, Math.min(to, edge.end));
      const landed = await seekToFrame(limited);
      if (landed.fresh && Math.abs(landed.media - from) > 1e-4) return;
      if (limited <= edge.start || limited >= edge.end) return;
    }
  }


  function buildPanel(floating) {
    el.inputs = {
      start: make("input", { class: "ytdl-time", value: "0:00.00", dataset: { time: "start" } }),
      end: make("input", { class: "ytdl-time", value: "0:00.00", dataset: { time: "end" } }),
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
    // 받을 내용. "소리만"을 고르면 화질칸이 소리 품질 목록으로 바뀐다.
    el.media = make("select", { class: "ytdl-quality ytdl-media", title: "받을 내용" }, [
      make("option", { value: "merged", text: "영상+소리" }),
      make("option", { value: "video", text: "영상만" }),
      make("option", { value: "audio", text: "소리만" }),
    ]);
    el.media.value = state.media;
    el.media.addEventListener("change", () => {
      state.media = el.media.value;
      saveMediaMode(state.media);
      fillQuality();
      applyToActiveClip();
      render();
    });
    el.quality = make("select", { class: "ytdl-quality" }, [make("option", { text: "불러오는 중…" })]);
    el.quality.addEventListener("change", () => {
      applyToActiveClip();
      render();
    });
    el.go = make("button", { class: "ytdl-go", type: "button", text: "구간 받기", disabled: true });
    // 받는 동안에만 보이는 버튼들.
    el.hold = make("button", { class: "ytdl-hold", type: "button", text: "일시정지", hidden: true });
    el.halt = make("button", { class: "ytdl-halt", type: "button", text: "정지", hidden: true });
    el.addClip = make("button", {
      class: "ytdl-addclip", type: "button", text: "구간 담기",
      title: "지금 고른 구간을 아래 목록에 담습니다",
    });
    // 딸림창 여닫이. 담긴 것이 있을 때만 보인다.
    el.clipsToggle = make("button", { class: "ytdl-toggle", type: "button", text: "구간 목록", hidden: true });
    el.clipsToggle.addEventListener("click", () => {
      state.clipsShut = !state.clipsShut;
      render();
    });
    el.leftoversToggle = make("button", { class: "ytdl-toggle", type: "button", text: "남은 조각", hidden: true });
    el.leftoversToggle.addEventListener("click", () => {
      state.leftoversShut = !state.leftoversShut;
      if (state.leftoversShut) render();
      else refreshLeftovers().catch(() => render()); // 펼 때는 최신 목록으로
    });
    // 저장이 끝난 뒤에만 보이는 버튼. 확장에서만 쓸 수 있다(웹 페이지는 폴더를 못 연다).
    el.reveal = make("button", {
      class: "ytdl-reveal", type: "button", text: "폴더 열기", hidden: true,
      title: "저장된 파일이 있는 폴더를 엽니다",
    });
    // 받다 만 조각이 남아 있을 때만 보이는 버튼.
    el.discard = make("button", {
      class: "ytdl-discard", type: "button", text: "받던 조각 버리기", hidden: true,
      title: "이어받기용으로 남겨둔 조각을 지웁니다",
    });
    el.status = make("div", { class: "ytdl-status", text: "화질 목록을 불러오는 중입니다" });
    // 제목 줄의 시계. 왼쪽은 고쳐 넣을 수 있는 칸이라 그 자리로 바로 건너뛴다.
    el.prevFrame = make(
      "button",
      { class: "ytdl-step", type: "button", title: "한 장 앞으로 · 유튜브 단축키 ," },
      [frameIcon(true)],
    );
    el.nextFrame = make(
      "button",
      { class: "ytdl-step", type: "button", title: "한 장 뒤로 · 유튜브 단축키 ." },
      [frameIcon(false)],
    );
    el.now = make("input", {
      class: "ytdl-now",
      value: "0:00.00",
      title: "지금 재생 위치 — 고쳐 넣으면 그 자리로 갑니다",
      spellcheck: false,
    });
    el.total = make("span", { class: "ytdl-total" });

    const close = make("button", { class: "ytdl-close", type: "button", title: "닫기", text: "✕" });
    close.addEventListener("click", togglePanel);

    const clock = make("div", { class: "ytdl-clock" }, [
      el.prevFrame,
      el.now,
      el.nextFrame,
      make("span", { class: "ytdl-slash", text: "/" }),
      el.total,
    ]);
    el.prevFrame.addEventListener("click", () => stepFrame(-1));
    el.nextFrame.addEventListener("click", () => stepFrame(1));
    // 시계를 잡고 끌면 패널이 딸려 온다. 칸에 글자를 넣으려는 것이지 옮기려는 게 아니다.
    clock.addEventListener("pointerdown", (event) => event.stopPropagation());

    // 여닫이는 창 조작이라 머리줄에 둔다. 받기 줄에 섞어 두면 주 동작(구간 받기)과 경쟁한다.
    const head = make("div", { class: "ytdl-head" }, [
      make("span", { class: "ytdl-title", text: "구간 받기" }),
      clock,
      make("span", { class: "ytdl-head-tools" }, [el.clipsToggle, el.leftoversToggle]),
      close,
    ]);
    if (floating) bindPanelDrag(head);

    // 딸림창 둘. **패널과 별개의 창**이다(문서 본문에 따로 붙는다).
    //
    // 패널 안에 두면 패널의 스크롤·최대 높이에 갇혀 잘리고, 좁은 창에서는 안쪽으로 접혀
    // 버린다. 그래서 따로 띄운다. 손대기 전에는 `placeSides()` 가 패널 옆자리에 붙여 주고,
    // 머리를 잡아 끌면 그때부터 제자리를 지킨다(패널을 따라다니지 않는다).
    el.clipList = make("div", { class: "ytdl-clip-list" });
    el.clipSaveEach = make("button", { class: "ytdl-clip-btn", type: "button", text: "따로 저장" });
    el.clipSaveJoin = make("button", { class: "ytdl-clip-btn", type: "button", text: "이어붙여 저장" });
    el.clipAll = make("button", { class: "ytdl-clip-btn", type: "button", text: "모두 고르기" });
    const shutClips = make("button", { class: "ytdl-side-shut", type: "button", text: "✕", title: "접기" });
    shutClips.addEventListener("click", () => {
      state.clipsShut = true;
      render();
    });
    // 구간 목록은 **패널 안**에 둔다. 받기 줄 바로 아래에 있어야 "담고 → 받는다"가 한눈에 읽힌다.
    el.clips = make("section", { class: "ytdl-clips", hidden: true }, [
      make("div", { class: "ytdl-side-head" }, [
        make("span", { text: "구간 목록" }),
        shutClips,
      ]),
      el.clipList,
      make("div", { class: "ytdl-side-foot" }, [el.clipAll, el.clipSaveEach, el.clipSaveJoin]),
    ]);

    el.leftoverList = make("div", { class: "ytdl-leftover-list" });
    el.leftoverScope = make("button", { class: "ytdl-clip-btn", type: "button", text: "전체 보기" });
    el.leftoverScope.addEventListener("click", () => {
      state.leftoversAll = !state.leftoversAll;
      // 목록을 다시 읽는다. 다른 탭이나 다른 영상에서 쌓인 것이 그새 생겼을 수 있다.
      refreshLeftovers().catch(() => render());
    });
    el.leftoverAll = make("button", { class: "ytdl-clip-btn", type: "button", text: "모두 버리기" });
    const shutLeft = make("button", { class: "ytdl-side-shut", type: "button", text: "✕", title: "접기" });
    shutLeft.addEventListener("click", () => {
      state.leftoversShut = true;
      render();
    });
    el.leftovers = make("aside", { class: "ytdl-side ytdl-leftovers", hidden: true }, [
      make("div", { class: "ytdl-side-head" }, [
        make("span", { text: "남은 조각" }),
        shutLeft,
      ]),
      el.leftoverList,
      make("div", { class: "ytdl-side-foot" }, [el.leftoverScope, el.leftoverAll]),
    ]);

    // 숏츠에는 영상 아래에 끼워 넣을 자리가 없다. 화면 위에 띄운다.
    const panel = make("div", { class: floating ? "ytdl-panel ytdl-float" : "ytdl-panel", hidden: true }, [
      head,
      make("div", { class: "ytdl-body" }, [
        buildTimeline(),
        // 두 줄로 나눈다 — 위는 무엇을 고를지, 아래는 그걸로 무엇을 할지.
        make("div", { class: "ytdl-row" }, [
          make("span", { class: "ytdl-group" }, [
            toStart,
            markIn,
            el.inputs.start,
            make("span", { class: "ytdl-sep", text: "~" }),
            el.inputs.end,
            markOut,
            toEnd,
            el.length,
          ]),
          make("span", { class: "ytdl-group" }, [el.media, el.quality]),
        ]),
        // 받기 줄. 담기는 왼쪽, 받기는 오른쪽 — 왼쪽은 쌓는 일, 오른쪽은 끝내는 일이다.
        make("div", { class: "ytdl-row ytdl-do" }, [
          el.addClip,
          make("span", { class: "ytdl-group ytdl-actions" }, [el.go, el.reveal, el.hold, el.halt]),
        ]),
        el.clips,
        el.status,
      ]),
    ]);
    el.panel = panel;
    // 패널은 유튜브가 화면을 다시 그릴 때마다 새로 만들어진다. 딸림창은 패널의 자식이
    // 아니라 본문에 붙어 있어서, 그냥 붙이면 옛 창이 남아 **두 개가 뜬다**(실제로 그랬다).
    for (const stale of document.querySelectorAll(".ytdl-side")) stale.remove();
    document.body.append(el.leftovers);
    bindSideDrag(el.leftovers, "leftovers");

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
        // 적어 넣은 시각으로 영상을 옮기고, 화면에 실제로 뜬 장의 시각을 받아 그것을 쓴다.
        // 눈에 보이는 숫자와 받게 될 파일이 어긋나지 않게 하려는 것이다.
        const edge = bounds();
        seekToFrame(Math.max(edge.start, Math.min(value, edge.end))).then(({ media }) => {
          setRange(which === "start" ? media : state.start, which === "end" ? media : state.end);
        });
      });
    }

    // 지금 위치 칸. 값을 고쳐 넣으면 영상이 그 자리로 간다.
    el.now.addEventListener("change", () => {
      const value = parseClock(el.now.value);
      const edge = bounds();
      if (value === null || edge.end <= edge.start) {
        el.now.value = showClock(playedSeconds(), 2);
        return;
      }
      seekToFrame(Math.max(edge.start, Math.min(value, edge.end))).then(({ media }) => {
        if (document.activeElement !== el.now) el.now.value = showClock(media, 2);
      });
    });
    // Enter 로 확정하면 칸에서 손을 뗀다(다시 시계가 흐르기 시작한다).
    el.now.addEventListener("keydown", (event) => {
      if (event.key === "Enter") el.now.blur();
      else if (event.key === "Escape") { el.now.value = showClock(playedSeconds(), 2); el.now.blur(); }
    });
    // 칸을 누르면 통째로 잡아준다. 소수점까지 지우고 다시 쓰는 게 보통이라서다.
    el.now.addEventListener("focus", () => el.now.select());

    el.go.addEventListener("click", start);
    el.hold.addEventListener("click", () => {
      if (!state.control) return;
      if (state.control.paused) state.control.resume();
      else state.control.pause();
      render();
    });
    el.halt.addEventListener("click", () => state.control?.stop());
    el.addClip.addEventListener("click", () => {
      if (state.end - state.start < 0.05) return;
      // 구간마다 화질·내용을 따로 기억한다. 담을 때의 설정이 그 구간의 설정이 된다.
      const clip = { id: (state.clipSeq = (state.clipSeq || 0) + 1),
                     start: state.start, end: state.end, picked: true,
                     mode: state.media || "merged", itag: el.quality.value };
      state.clips.push(clip);
      // 담은 뒤에는 **편집 대상을 놓는다.** 그대로 붙들고 있으면 다음 구간을 잡으려고
      // 시각을 바꿀 때 방금 담은 구간이 덮어써진다. 고치고 싶으면 목록에서 누르면 된다.
      state.activeClip = null;
      state.clipsShut = false; // 담았으면 보여준다
      saveClipList();
      render();
    });
    el.clipAll.addEventListener("click", () => {
      const 켤까 = state.clips.some((clip) => !clip.picked);
      for (const clip of state.clips) clip.picked = 켤까;
      saveClipList();
      render();
    });
    el.clipSaveEach.addEventListener("click", () => saveClips(false));
    el.clipSaveJoin.addEventListener("click", () => saveClips(true));
    el.leftoverAll.addEventListener("click", async () => {
      // 지금 보이는 것만 버린다. "이 영상만" 보기에서 다른 영상 것까지 지우면 놀란다.
      const 대상 = state.leftoversAll
        ? state.leftovers
        : state.leftovers.filter((item) => item.videoId === state.videoId);
      for (const item of 대상) await store.discard(item.videoId);
      if (대상.some((item) => item.videoId === state.videoId)) state.hasLeftovers = false;
      await refreshLeftovers();
    });
    el.reveal.addEventListener("click", () => {
      // 배경 일꾼만 chrome.downloads 를 부를 수 있다.
      runtime?.sendMessage({ type: "reveal" }, () => void chrome.runtime.lastError);
    });
    el.discard.addEventListener("click", async () => {
      if (!state.videoId || state.busy) return;
      await store.discard(state.videoId);
      state.hasLeftovers = false;
      state.saved = false;
      setStatus("받아둔 조각을 지웠습니다");
      render();
    });
    return panel;
  }

  /**
   * 지금 자리를 시작점이나 끝점으로 찍는다.
   *
   * `video.currentTime` 을 그대로 쓰면 안 된다. 한 장 이동은 장이 바뀔 때까지 조금씩
   * 밀어 찾으므로, 멈춘 뒤 `currentTime` 은 장보다 몇 ms 뒤(마지막으로 민 자리)에 있다.
   * 그걸 찍으면 시계에 뜬 값과 다른 값이 들어간다(실측: 시계는 01:49.01, 찍힌 값은 .02).
   * `playedSeconds()` 는 화면에 뜬 장의 시각을 돌려주므로 눈에 보이는 것과 같아진다.
   */
  function markHere(which) {
    if (!player()) return;
    const now = playedSeconds();
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

  /**
   * 패널을 끼워 넣을 자리. 없으면(null) 화면 위에 띄운다.
   *
   * 숏츠는 끼울 데가 없다. 북마클릿도 늘 띄운다 — 눌러서 들어온 길이라 누른 그 자리에서
   * 바로 보이는 편이 낫고, 유튜브가 화면 구조를 바꿔도 붙일 자리를 못 찾아 안 뜨는 일이 없다.
   */
  function panelAnchor() {
    if (isShorts() || bundled) return null;
    return document.querySelector("ytd-watch-metadata") || document.querySelector("#below");
  }

  /**
   * 제목 줄을 잡아 패널을 옮긴다.
   *
   * 한 번이라도 직접 옮겼으면 그 뒤로는 자동 배치를 하지 않는다. 놓아둔 자리가
   * 매 초 원래대로 돌아가면 옮기는 의미가 없다.
   */
  // 패널이 움직이는 길은 끌기 말고도 있다 — 페이지 스크롤(끼워 넣은 패널), 창 크기 변화,
  // 유튜브가 화면을 다시 그릴 때. 그때마다 딸림창 자리를 다시 잡는다.
  window.addEventListener("scroll", () => placeSides(), { passive: true });
  window.addEventListener("resize", () => placeSides(), { passive: true });

  function bindPanelDrag(head) {
    head.addEventListener("pointerdown", (event) => {
      // 머리줄에 놓인 단추·칸을 누른 것은 끌기가 아니다.
      //
      // 닫기만 빼뒀더니 머리줄로 옮긴 창 여닫이가 먹통이 됐다 — 끌기가 `preventDefault()` 로
      // 클릭을 삼켜 창이 안 열리고, 게다가 끌기 준비가 패널 너비를 다시 잡아 누를 때마다
      // 조금씩 커졌다(테두리·안여백이 매번 더해져서).
      if (event.target.closest("button, input, select, a")) return;
      const rect = el.panel.getBoundingClientRect();
      state.panelDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      state.panelMoved = true;
      // 지금 보이는 그 자리에서 시작하도록 좌표를 굳힌다(가운데 맞춤을 풀어준다).
      el.panel.style.transform = "none";
      el.panel.style.bottom = "auto";
      el.panel.style.width = `${Math.round(rect.width)}px`; // 놓을 때 푼다(drop)
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
      // 끄는 동안만 너비를 굳혀 뒀다. 놓으면 푼다 —
      // 그래야 창 크기가 같으면 패널 크기도 늘 같다(폭은 사람이 정하는 값이 아니다).
      el.panel.style.width = "";
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);

    // 머리줄을 두 번 누르면 처음 자리로 돌아간다.
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, input, select, a")) return;
      state.panelMoved = false;
      placeFloatingPanel();
    });
  }

  /** 화면 밖으로 나가지 않게 잡아두고 옮긴다. */
  /**
   * 딸림창을 패널 양옆에 붙인다.
   *
   * 옆에 자리가 모자라면 패널 아래로 내린다. 화면 밖으로 나가지 않게 가둔다.
   */
  /**
   * 딸림창을 따로 끌 수 있게 한다.
   *
   * 한 번이라도 옮기면 그때부터 **패널을 따라다니지 않는다**. 옆에 붙여 두는 것이 기본이지만
   * 화면을 어떻게 쓸지는 사람마다 다르다 — 옮겨 놓은 자리를 우리가 도로 끌고 가면 안 된다.
   * 머리줄을 두 번 누르면 다시 패널 옆으로 붙는다.
   */
  function bindSideDrag(side, key) {
    const head = side.querySelector(".ytdl-side-head");
    if (!head) return;
    let grab = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return; // 접기 단추는 끌기가 아니다
      const box = side.getBoundingClientRect();
      grab = { x: event.clientX - box.left, y: event.clientY - box.top };
      state[`${key}Free`] = true;
      side.classList.add("ytdl-side-free");
      try {
        head.setPointerCapture(event.pointerId);
      } catch {
        // 못 잡아도 끌리기는 한다
      }
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      if (!grab) return;
      const width = side.offsetWidth;
      const height = side.offsetHeight;
      const 가두기 = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
      side.style.left = `${Math.round(가두기(event.clientX - grab.x, window.innerWidth - width - 8))}px`;
      side.style.top = `${Math.round(가두기(event.clientY - grab.y, window.innerHeight - height - 8))}px`;
    });
    const drop = () => {
      grab = null;
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);
    // 두 번 누르면 다시 패널 옆으로.
    head.addEventListener("dblclick", () => {
      state[`${key}Free`] = false;
      side.classList.remove("ytdl-side-free");
      placeSides();
    });
  }

  function placeSides() {
    if (!el.panel || el.panel.hidden) {
      if (el.leftovers) el.leftovers.style.visibility = "hidden";
      return;
    }
    const box = el.panel.getBoundingClientRect();
    const gap = 10;
    // 딸림창 너비는 화면에 맞춘다(좁으면 좁게, 넓으면 넉넉하게).
    const wide = Math.round(Math.max(200, Math.min(window.innerWidth * 0.22, 320)));

    // **양옆을 따로 잰다.** "화면이 넓은가"로 뭉뚱그리면 한쪽에 자리가 남는데도 둘 다
    // 아래로 내려가 버린다(실제로 1600px 에서 그랬다).
    const 들어가나 = (space) => space >= wide + gap + 8;
    const 왼쪽 = 들어가나(box.left);

    const 띠 = [];
    const 옆에 = (side, where) => {
      side.style.visibility = "visible";
      side.classList.remove("ytdl-side-wide");
      side.style.width = `${wide}px`;
      side.style.maxHeight = `${Math.round(Math.max(140, window.innerHeight - box.top - 16))}px`;
      side.style.left = `${Math.round(where === "right" ? box.right + gap : box.left - wide - gap)}px`;
      side.style.top = `${Math.round(Math.max(8, box.top))}px`;
    };

    // 구간 목록은 패널 안으로 들어갔다. 여기서 자리를 봐줄 것은 남은 조각뿐이다.
    for (const [side, where, 자리있음] of [[el.leftovers, "left", 왼쪽]]) {
      if (!side) continue;
      if (side.hidden) {
        side.style.visibility = "hidden";
        continue;
      }
      // 사람이 옮겨 놓은 창은 그 자리에 둔다. 화면 밖으로만 안 나가게 지켜본다.
      if (state.leftoversFree) {
        side.style.visibility = "visible";
        const box2 = side.getBoundingClientRect();
        const 가두기 = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
        side.style.left = `${Math.round(가두기(box2.left, window.innerWidth - box2.width - 8))}px`;
        side.style.top = `${Math.round(가두기(box2.top, window.innerHeight - Math.min(box2.height, 160) - 8))}px`;
        continue;
      }
      if (자리있음) 옆에(side, where);
      else 띠.push(side);
    }
    if (!띠.length) return;

    // 옆에 못 세운 것은 패널 폭짜리 띠로 위아래 **남는 쪽**에 쌓는다.
    const 아래여유 = window.innerHeight - box.bottom - gap - 8;
    const 위여유 = box.top - gap - 8;
    const 아래로 = 아래여유 >= 위여유;
    const 여유 = Math.max(120, 아래로 ? 아래여유 : 위여유);
    const 몫 = Math.max(110, Math.floor((여유 - gap * (띠.length - 1)) / 띠.length));
    let cursor = 아래로 ? box.bottom + gap : box.top - gap;
    for (const side of 띠) {
      side.style.visibility = "visible";
      side.classList.add("ytdl-side-wide");
      side.style.width = `${Math.round(box.width)}px`;
      side.style.maxHeight = `${몫}px`;
      side.style.left = `${Math.round(Math.max(8, box.left))}px`;
      const height = Math.min(side.offsetHeight || 0, 몫);
      const top = 아래로 ? cursor : cursor - height;
      side.style.top = `${Math.round(Math.max(8, top))}px`;
      cursor = 아래로 ? top + height + gap : top - gap;
    }
  }

  function moveFloatingPanel(left, top) {
    const width = el.panel.offsetWidth;
    const height = el.panel.offsetHeight;
    const limit = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
    el.panel.style.left = `${Math.round(limit(left, window.innerWidth - width - 8))}px`;
    el.panel.style.top = `${Math.round(limit(top, window.innerHeight - height - 8))}px`;
    placeSides();
  }

  /**
   * 띄운 패널을 화면 아래 가운데에 세운다.
   *
   * 예전에는 영상 옆 빈자리를 재서 세웠는데, 창 크기에 따라 설 자리가 오락가락했다
   * (좁으면 아래로 눕고 넓으면 옆으로 갔다). 처음 열 때 어디에 뜰지 모르면 눈이
   * 패널을 찾아 헤맨다. 아래 가운데는 숏츠든 일반 화면이든 늘 같은 자리다.
   *
   * 그 자리가 싫으면 제목 줄을 잡아 옮기면 된다 — 한 번 옮기면 그 뒤로는 건드리지 않는다.
   */
  function placeFloatingPanel() {
    if (!el.panel || el.panel.hidden || !el.panel.classList.contains("ytdl-float")) return;
    // 사용자가 직접 옮겼으면 자리만 지켜주고, 화면 밖으로 나가지 않게 봐준다.
    // **너비는 언제나 되돌린다** — 자리는 사람이 정하는 것이지만 크기는 화면이 정한다.
    if (state.panelMoved) {
      el.panel.style.width = "";
      const rect = el.panel.getBoundingClientRect();
      moveFloatingPanel(rect.left, rect.top);
      return;
    }
    // 끌어 옮기며 굳혀둔 좌표가 남아 있을 수 있다. 지워야 가운데 맞춤이 다시 산다.
    el.panel.style.left = "";
    el.panel.style.top = "";
    el.panel.style.bottom = "";
    el.panel.style.transform = "";
    el.panel.style.width = "";
  }

  // 유튜브는 화면을 통째로 다시 그리는 일이 잦다. 사라졌으면 다시 붙인다.
  function mount() {
    // 영상 화면을 떠났다(홈·검색 …). 얹어둔 것을 걷어낸다.
    // 특히 숏츠 패널은 body 에 띄워 둔 것이라, 두면 엉뚱한 화면 위에 그대로 남는다.
    if (!isVideoPage()) {
      if (state.mode !== null) {
        el.button?.remove();
        el.panel?.remove();
        el.leftovers?.remove();
        el.button = null;
        el.panel = null;
        state.mode = null;
        state.panelMoved = false;
        state.panelDrag = null;
        watchProgress(false);
        runClock(false);
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
      // 끼워 넣을 자리가 없으면 띄운다. 일반 화면의 확장만 자리를 기다린다 —
      // 유튜브가 아직 안 그린 것뿐이라 다음 차례에 붙는다.
      if (anchor || mode === "shorts" || bundled) {
        const panel = buildPanel(!anchor);
        if (anchor) anchor.insertAdjacentElement("afterend", panel);
        else document.body.append(panel);
        panel.hidden = !state.open;
        // 열어둔 채 다른 화면에 갔다 왔으면 재생 상태 받아오기가 꺼져 있다. 다시 켠다.
        watchProgress(state.open);
        runClock(state.open);
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
    runClock(state.open);
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
    // 목록에서 고른 구간이 있으면 그 구간을 고치는 중이다.
    const editing = state.clips.find((clip) => clip.id === state.activeClip);
    if (editing) {
      editing.start = state.start;
      editing.end = state.end;
      saveClipList();
    }
    render();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveRange, 400);
  }

  function render() {
    if (!el.panel) return;
    el.inputs.start.value = showClock(state.start, 2);
    // 끝까지 받는 중이면 시각 대신 그렇다고 적는다. 라이브는 끝이 계속 밀리니까.
    el.inputs.end.value = state.toEnd ? "" : showClock(state.end, 2);
    el.inputs.end.placeholder = state.toEnd ? "끝까지" : "";
    const length = Math.max(0, state.end - state.start);
    el.length.textContent = showClock(length, 2);
    el.go.disabled = state.busy || !state.formats || length < 0.05;
    el.hold.hidden = !state.busy;
    el.halt.hidden = !state.busy;
    el.reveal.hidden = state.busy || !state.saved || !runtime;
    el.hold.textContent = state.control?.paused ? "이어받기" : "일시정지";
    el.addClip.disabled = state.busy || state.end - state.start < 0.05;
    renderClips();
    renderLeftovers();
    renderTimeline();
    placeSides();
  }

  /** 화질·내용을 바꾸면 편집 중인 구간에도 그대로 적어 둔다. */
  function applyToActiveClip() {
    const editing = state.clips.find((clip) => clip.id === state.activeClip);
    if (!editing) return;
    editing.mode = state.media || "merged";
    editing.itag = el.quality.value;
    saveClipList();
  }

  /** 구간에 적힌 설정을 화면(내용·화질 칸)에 되돌려 놓는다. */
  function loadClipSettings(clip) {
    if (clip.mode && clip.mode !== state.media) {
      state.media = clip.mode;
      el.media.value = clip.mode;
      saveMediaMode(clip.mode);
      fillQuality();
    }
    if (clip.itag && [...el.quality.options].some((option) => option.value === clip.itag)) {
      el.quality.value = clip.itag;
    }
  }

  /** 구간에 적힌 설정을 사람이 읽을 말로. */
  function clipLabel(clip) {
    const 내용 = clip.mode === "video" ? "영상만" : clip.mode === "audio" ? "소리만" : "영상+소리";
    const list = clip.mode === "audio" ? state.formats?.audio : state.formats?.video;
    const format = list?.find((one) => String(one.itag) === String(clip.itag));
    return format ? `${innertube.formatLabel(format)} · ${내용}` : 내용;
  }

  /** 오른쪽 구간 목록. 고른 줄은 하이라이트되고, 누르면 그 구간이 편집 대상이 된다. */
  function renderClips() {
    if (!el.clips) return;
    el.clips.hidden = !state.clips.length || state.clipsShut;
    el.clipsToggle.hidden = !state.clips.length;
    el.clipsToggle.textContent = `구간 목록 ${state.clips.length}`;
    el.clipsToggle.classList.toggle("on", !state.clipsShut);
    const rows = state.clips.map((clip, at) => {
      const pick = make("input", { class: "ytdl-clip-pick", type: "checkbox" });
      pick.checked = clip.picked;
      pick.addEventListener("click", (event) => event.stopPropagation());
      pick.addEventListener("change", () => {
        clip.picked = pick.checked;
        saveClipList();
      });
      const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "목록에서 뺍니다" });
      drop.addEventListener("click", (event) => {
        event.stopPropagation();
        state.clips = state.clips.filter((one) => one !== clip);
        if (state.activeClip === clip.id) state.activeClip = null;
        saveClipList();
        render();
      });
      const row = make(
        "div",
        { class: state.activeClip === clip.id ? "ytdl-clip on" : "ytdl-clip" },
        [
          pick,
          make("span", { class: "ytdl-clip-no", text: `구간${at + 1}` }),
          make("span", { class: "ytdl-clip-time" }, [
            make("span", { text: `${showClock(clip.start, 2)}~${showClock(clip.end, 2)}` }),
            make("span", { class: "ytdl-clip-set", text: clipLabel(clip) }),
          ]),
          drop,
        ],
      );
      // 누르면 그 구간으로 옮겨간다. 손잡이·시각칸이 따라 움직이고, 고치면 이 구간이 바뀐다.
      row.addEventListener("click", () => {
        state.activeClip = clip.id;
        // 시각뿐 아니라 그 구간의 화질·내용까지 화면에 되돌린다. 그래야 바로 고칠 수 있다.
        loadClipSettings(clip);
        setRange(clip.start, clip.end);
      });
      return row;
    });
    el.clipList.replaceChildren(...rows);
    const 고른수 = state.clips.filter((clip) => clip.picked).length;
    el.clipSaveEach.disabled = state.busy || !고른수;
    el.clipSaveJoin.disabled = state.busy || 고른수 < 2;
    el.clipSaveEach.textContent = 고른수 ? `따로 저장 (${고른수})` : "따로 저장";
  }

  /** 왼쪽 남은 조각 목록. 이 브라우저에 쌓인 것을 영상별로 보여준다. */
  function renderLeftovers() {
    if (!el.leftovers) return;
    // 기본은 지금 보고 있는 영상 것만. "전체 보기"를 누르면 이 브라우저에 쌓인 것을 다 보여준다.
    const 보일것 = state.leftoversAll
      ? state.leftovers
      : state.leftovers.filter((item) => item.videoId === state.videoId);
    const 다른것 = state.leftovers.length - 보일것.length;
    el.leftovers.hidden = !state.leftovers.length || state.leftoversShut;
    el.leftoversToggle.hidden = !state.leftovers.length;
    el.leftoversToggle.textContent = `남은 조각 ${보일것.length}`;
    el.leftoversToggle.classList.toggle("on", !state.leftoversShut);
    el.leftoverScope.textContent = state.leftoversAll ? "이 영상만" : `전체 보기${다른것 ? ` (+${다른것})` : ""}`;
    el.leftoverScope.classList.toggle("on", state.leftoversAll);
    el.leftoverScope.hidden = false;
    el.leftoverAll.textContent = state.leftoversAll ? "모두 버리기" : "조각 버리기";
    // 한 영상이 여러 줄이 될 수 있다 — 받아둔 구간마다 한 줄, 남은 조각이 있으면 한 줄 더.
    const rows = [];
    for (const item of 보일것) {
      const 지금 = item.videoId === state.videoId;
      const 꼬리표 = (글, 작게) =>
        make("span", { class: "ytdl-clip-time" }, [
          make("span", { text: 글 }),
          make("span", { class: "ytdl-clip-set", text: 작게 }),
        ]);
      const 이름 = knownTitle(item.videoId);
      const 이동 = (row) => {
        if (지금) return row;
        row.title = `${이름 || item.videoId} — 새 창에서 엽니다`;
        row.addEventListener("click", () => {
          // 새 창으로 연다. 지금 보던 영상을 잃지 않고 확인만 하러 갈 수 있어야 한다.
          window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`, "_blank", "noopener");
        });
        return row;
      };
      // 어느 영상인지 한눈에 보이게 섬네일을 붙인다. 제목을 못 적어둔 옛 것도 이걸로 알아본다.
      const 섬네일 = () =>
        make("img", {
          class: "ytdl-clip-thumb",
          src: `https://i.ytimg.com/vi/${item.videoId}/default.jpg`,
          alt: "",
          loading: "lazy",
        });

      for (const done of item.outputs || []) {
        const again = make("button", { class: "ytdl-clip-btn ytdl-clip-save", type: "button", text: "저장" });
        again.addEventListener("click", async (event) => {
          event.stopPropagation();
          const file = await store.readOutput(item.videoId, done.key).catch(() => null);
          if (!file) {
            setStatus("저장해 둔 파일을 찾지 못했습니다");
            return;
          }
          const 이름 = done.name || `${item.videoId} [받아둔 구간].mp4`;
          offerLink(save(file, 이름), `받아둔 파일을 내보냈습니다 · ${showMb(file.size)} MB`);
        });
        const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "이 파일을 지웁니다" });
        drop.addEventListener("click", async (event) => {
          event.stopPropagation();
          await store.discardOutput(item.videoId, done.key);
          await refreshLeftovers();
        });
        // 이름에 적어둔 구간 표시가 있으면 그것을, 없으면 영상 ID 를 보여준다.
        const 구간 = ((done.name || "").match(/\[([0-9:.~\-]+)\]/) || [])[1] || done.key || "받아둔 파일";
        rows.push(
          이동(make("div", { class: `ytdl-clip${지금 ? " on" : ""}` }, [
            ...(지금 ? [make("span", { class: "ytdl-clip-no", text: "받음" })] : [섬네일()]),
            꼬리표(
              구간.replace(/-/g, ":"),
              `${지금 ? "" : `${이름 || item.videoId} · `}${showMb(done.bytes)} MB`,
            ),
            again,
            drop,
          ])),
        );
      }

      if (item.chunks) {
        const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "이 영상의 조각을 지웁니다" });
        drop.addEventListener("click", async (event) => {
          event.stopPropagation();
          await store.discard(item.videoId);
          if (지금) state.hasLeftovers = false;
          await refreshLeftovers();
        });
        rows.push(
          이동(make("div", { class: `ytdl-clip${지금 ? " on" : ""}` }, [
            ...(지금 ? [make("span", { class: "ytdl-clip-no", text: "조각" })] : [섬네일()]),
            꼬리표(
              지금 ? "이어받기용 조각" : 이름 || item.videoId,
              `조각 ${item.chunks}개 · ${showMb(item.bytes)} MB`,
            ),
            drop,
          ])),
        );
      }
    }
    el.leftoverList.replaceChildren(...rows);
  }

  async function refreshLeftovers() {
    // 이 브라우저에 쌓인 것을 영상 가리지 않고 다 보여준다. 지금 영상 것이 맨 앞에 온다.
    const all = await store.listLeftovers().catch(() => []);
    state.leftovers = all.sort((a, b) => {
      const 지금 = (item) => (item.videoId === state.videoId ? 0 : 1);
      return 지금(a) - 지금(b) || b.usedAt - a.usedAt;
    });
    render();
  }

  function renderTimeline() {
    const edge = bounds();
    const span = edge.end - edge.start;
    el.total.textContent = span > 0 ? showClock(span, 2) : "";
    // 시계는 사용자가 고쳐 넣는 중일 때만 손대지 않는다. 커서가 튀어버린다.
    if (document.activeElement !== el.now) {
      const now = showClock(playedSeconds(), 2);
      if (el.now.value !== now) el.now.value = now;
    }
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

  /** 받을 내용에 맞는 품질 목록. "소리만"이면 소리 품질(비트레이트)을 보여준다. */
  function qualityChoices(mode = state.media) {
    if (!state.formats) return [];
    return mode === "audio" ? state.formats.audio : state.formats.video;
  }

  /** 받아둔 품질 목록을 화질칸에 채운다. 패널을 다시 만들었을 때도 쓴다. */
  function fillQuality() {
    if (!el.quality || !state.formats) return;
    const before = el.quality.value;
    el.quality.replaceChildren(
      ...qualityChoices().map((format) =>
        make("option", { value: String(format.itag), text: innertube.formatLabel(format) }),
      ),
    );
    // 목록을 갈아끼워도 같은 포맷이 남아 있으면 선택을 유지한다.
    if ([...el.quality.options].some((option) => option.value === before)) {
      el.quality.value = before;
    }
  }

  async function loadFormats() {
    const videoId = currentVideoId();
    if (!videoId) return;
    state.videoId = videoId;
    state.formats = null;
    state.saved = false;
    // 이 영상에 담아둔 구간을 되살린다.
    state.clips = savedClips(videoId);
    state.activeClip = null;
    el.quality.replaceChildren(make("option", { text: "불러오는 중…" }));
    setStatus("화질 목록을 불러오는 중입니다");

    try {
      // 로그인해서 받은 주소에는 `n` 이 붙어 있다. 풀지 않으면 403 이다.
      const unlock = (urls) =>
        nsig.solveUrls(urls, {
          // 해결기 원본이 있는 곳. 북마클릿은 확장 주소가 없어 배포처에서 받아온다.
          runtime: runtime || { getURL: (path) => new URL(path, window.__ytdlBase).href },
          ask: (payload) => viaPage.ask(payload, "solve"),
          onStep: (text) => setStatus(text),
        });
      // PO 토큰은 페이지 안의 유튜브 발급기가 만든다. 없으면 앞 60초까지만 받힌다.
      const mintPot = async (bind) => (await viaPage.ask({ bind }, "pot"))?.token;
      // 로그아웃일 때 TVHTML5_SIMPLY 로 물으려면 페이지의 STS 가 있어야 한다.
      const getSts = async () => (await viaPage.ask({}, "sts"))?.sts;
      const formats = await getFormats(videoId, null, unlock, undefined, mintPot, getSts);
      if (state.videoId !== videoId) return; // 그 사이 다른 영상으로 옮겼다
      if (!formats.video.length || !formats.audio.length) {
        throw new Error("받을 수 있는 mp4 화질이 없습니다");
      }
      state.formats = formats;
      rememberTitle(videoId, formats.title);
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
      // 받다 만 조각이 남아 있으면 알려준다(같은 구간을 다시 받으면 이어서 받는다).
      store.hasLeftovers(videoId).then((left) => {
        if (state.videoId !== videoId) return;
        state.hasLeftovers = left;
        if (left && !state.busy) {
          setStatus("받다 만 조각이 남아 있습니다 · 같은 구간을 받으면 이어서 받습니다");
        }
        render();
      }).catch(() => {});
      // 왼쪽 목록은 이 브라우저에 쌓인 것을 통째로 보여준다(다른 영상 것까지).
      refreshLeftovers().catch(() => {});
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
      say("화질 목록 실패:", error);
      el.quality.replaceChildren(make("option", { text: "없음" }));
    }
    render();
  }

  const showMb = (bytes) => (bytes / 1048576).toFixed(1);

  function speedLabel(bytesPerSec) {
    if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
  }

  // 마지막으로 알려온 진행 상황. 조각이 뜸하게 와도 속도 표시는 계속 새로 그린다(주기 갱신).
  let lastProgress = null;

  function showProgress() {
    if (!lastProgress) return;
    const { done, total, stage, size } = lastProgress;
    if (stage !== "받는 중") {
      // 합치기 같은 단계도 몇째 조각인지 같이 적는다.
      setStatus(total > 1 ? `${stage} ${done}/${total}` : stage);
      return;
    }
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    let text = `${state.stageLabel || ""}받는 중 ${percent}%`;
    // 일반 영상은 진행량이 바이트라 그대로 적는다. 라이브는 조각 개수로 받아서
    // 전체 용량을 미리 모르므로, 받는 쪽이 트랙별 평균 조각 크기로 어림해 준
    // 용량(size)을 적는다(진행률 막대는 여전히 조각 개수 기준이라 정확하다).
    const inBytes = total > 1_000_000;
    if (inBytes) text += ` · ${showMb(done)}/${showMb(total)} MB`;
    else if (size) {
      text += ` · ${showMb(size.got)}`;
      // 조각을 다 받으면 어림이 실측과 같아진다. 그때는 "약"을 떼고 하나만 적는다.
      if (size.estimated > size.got) text += `/약 ${showMb(size.estimated)}`;
      text += " MB";
    } else {
      text += ` · ${showMb(meter.bytes)} MB`;
    }
    if (state.control?.paused) {
      setStatus(`${text} (멈춤)`);
      return;
    }
    const speed = meterSpeed();
    if (speed > 0) text += ` · ${speedLabel(speed)}`;
    const left = paceRemaining(done, total);
    if (left !== null && done < total) text += ` · 예상 ${showClock(left)} 남음`;
    setStatus(text);
  }

  /**
   * 고른 구간들을 받는다.
   *
   * `merge` 면 하나로 이어붙이고, 아니면 구간마다 파일을 하나씩 만든다.
   * 따로 저장은 기존 받기를 구간마다 한 번씩 부르는 것뿐이라 이어받기·갈아타기가 그대로 산다.
   */
  async function saveClips(merge) {
    if (state.busy) return;
    const order = state.clips.filter((clip) => clip.picked).sort((a, b) => a.start - b.start);
    if (!order.length) return;
    if (merge) {
      // 이어붙이기는 트랙 하나로 조립하므로 화질이 섞이면 안 된다. 첫 구간 것으로 맞춘다.
      const 섞임 = order.some((clip) => clip.mode !== order[0].mode || clip.itag !== order[0].itag);
      await start({ clips: order, mode: order[0].mode, itag: order[0].itag });
      if (섞임 && state.saved) {
        setStatus(
          `${el.status.textContent} · 구간마다 설정이 달라 첫 구간(${clipLabel(order[0])}) 것으로 맞췄습니다`,
          "ytdl-ok",
        );
      }
      return;
    }
    for (let at = 0; at < order.length; at += 1) {
      const clip = order[at];
      state.activeClip = clip.id;
      loadClipSettings(clip);
      setRange(clip.start, clip.end);
      await start({ label: `구간 ${at + 1}/${order.length} · `, mode: clip.mode, itag: clip.itag });
      if (!state.saved) return; // 실패하거나 멈췄으면 거기서 그만둔다
    }
    setStatus(`구간 ${order.length}개를 모두 저장했습니다`, "ytdl-ok");
  }

  async function start(options = {}) {
    if (state.busy || !state.formats) return;
    state.stageLabel = options.label || "";
    // 구간 목록에서 부르면 그 구간에 적힌 화질·내용을 쓴다(칸에 뭐가 떠 있든 상관없다).
    const mode = options.mode || state.media || "merged";
    const choices = qualityChoices(mode);
    const wanted = options.itag || el.quality.value;
    const chosenFormat =
      choices.find((format) => String(format.itag) === String(wanted)) || choices[0];
    if (!chosenFormat) return;

    state.busy = true;
    state.saved = false;
    state.control = createControl();
    render();
    const began = Date.now();

    // 조각은 되도록 디스크(OPFS)에 쌓는다. 메모리는 조각 하나 크기만 쓰고,
    // 받다 죽어도 조각이 남아 다시 누르면 이어받는다.
    // 완성본을 구간마다 따로 남긴다. 한 칸만 쓰면 다음 구간을 받을 때 앞 구간이 지워져,
    // 여러 구간을 받아 놓고도 마지막 것만 다시 꺼낼 수 있었다.
    const outputKey = options.clips
      ? `join${options.clips.length}-${Math.round(options.clips[0].start * 100)}`
      : `${Math.round(state.start * 100)}-${Math.round(state.end * 100)}`;
    const disk = await store.openBest(state.videoId || "video");
    const media = {
      ...disk,
      output: () => disk.output(outputKey),
      rememberName: (text) => disk.rememberName?.(outputKey, text),
    };
    const resumable = media.kind === "disk";
    const resumeHint = resumable ? " · 받은 만큼은 남아 있어 다시 누르면 이어받습니다" : "";
    meter.events.length = 0;
    meter.bytes = 0;
    pace.events.length = 0;
    lastProgress = null;
    const ticker = setInterval(showProgress, 500);

    try {
      // 몫이 떨어져 403 이 나면 다른 클라이언트로 물어 새 주소를 받아 온다.
      // 같은 itag 면 어느 클라이언트에서 받아도 바이트가 같아서 받던 자리에서 이어진다.
      //
      // 목록을 다 돌면 거기까지다. 기다리게 하지 않는다 — 몫이 되돌아오는 데 15분을
      // 재봐도 한 톨도 안 열렸다(45MB 영상, 첫 몫 10MB). 화면 앞에서 붙들고 있느니
      // 받아둔 데까지 남기고 끝내는 편이 낫다. 다음에 누르면 없는 것만 받는다.
      let clientAt = 0;
      const renewUrl = async () => {
        clientAt += 1;
        const next = innertube.ROTATION[clientAt];
        if (!next) return null;
        setStatus(`몫이 떨어져 ${next.clientName} 로 갈아타 이어받습니다`);
        // 이 클라이언트들의 주소에는 `n` 이 붙지 않아 해독기가 필요 없다(확인했다).
        const fresh = await getFormats(state.videoId, null, null, next, null);
        const table = new Map(
          [...fresh.video, ...fresh.audio].map((f) => [String(f.itag), f.url]),
        );
        return (itag) => table.get(String(itag));
      };

      const request = {
        start: state.start,
        end: state.end,
        control: state.control,
        store: media,
        renewUrl,
        onProgress: (done, total, stage, size) => {
          lastProgress = { done, total, stage, size };
          if (stage === "받는 중") paceAdd(done);
          showProgress();
        },
      };
      const { file, mediaStart, mediaEnd, mediaSeconds } = options.clips
        ? await downloadClips({
            ...request,
            clips: options.clips,
            videoFormat: chosenFormat,
            audioFormat: state.formats.audio[0],
          })
        : mode === "merged"
          ? await downloadSection({
              ...request,
              videoFormat: chosenFormat,
              audioFormat: state.formats.audio[0],
            })
          : await downloadTrack({ ...request, format: chosenFormat, kind: mode });

      // 파일은 고른 구간 그대로다. 다만 영상은 프레임 단위로만 존재해서(60fps 면
      // 16.67ms 마다 한 장) 시작이 한 프레임 안쪽에서 당겨질 수 있다. 고른 그 순간
      // 화면에 떠 있던 장을 살리려는 것이다. 이름도 실제 내용에 맞춰 붙인다.
      const realStart = Number.isFinite(mediaStart) ? mediaStart : state.start;
      const realEnd = Number.isFinite(mediaEnd) ? mediaEnd : state.end;
      // 소리만 받은 파일은 확장자(m4a)가, 소리 없는 영상은 이름표가 내용을 알려준다.
      const marker =
        (mode === "video" ? " [영상만]" : "") + (options.clips ? ` [구간 ${options.clips.length}개]` : "");
      const ext = mode === "audio" ? "m4a" : "mp4";
      // 어떤 화질로 받았는지 파일 이름만 봐도 알 수 있게 앞에 붙인다. 예: [2160p60 AV1]
      const quality = innertube.formatLabel(chosenFormat);
      const fileName =
        `[${quality}] ${safeFileName(state.formats.title)} ` +
        `[${clockLabel(realStart)}~${clockLabel(realEnd)}]${marker}.${ext}`;
      save(file, fileName);
      // 같은 이름으로 다시 내줄 수 있게 완성본 옆에 적어 둔다(저장을 취소했을 때 쓴다).
      media.rememberName(fileName)?.catch?.(() => {});
      // 조각을 언제 지울지.
      //
      // 예전에는 저장 버튼을 누르자마자 지웠다. 그런데 `<a download>` 는 저장을 **시작**만
      // 시킬 뿐이라, 사용자가 저장 대화상자에서 취소해도 우리는 모른 채 지워버렸다.
      // 그러면 다시 누를 때 통째로 받아야 한다 — 다 받아놓고도 말이다.
      //
      // 확장에서는 배경 일꾼이 내려받기 상태를 볼 수 있으니 **정말 끝났을 때만** 지운다.
      // 북마클릿은 볼 길이 없어 그냥 남겨둔다(오래된 것은 store.cleanup 이 걷어간다).
      state.saved = true;
      if (runtime) {
        runtime.sendMessage({ type: "download-state" }, (answer) => {
          void chrome.runtime.lastError;
          if (answer?.state === "complete") {
            media.clearChunks().catch(() => {});
            state.hasLeftovers = false;
          } else {
            // 취소했거나 알 수 없다. 조각을 남겨 다시 누르면 곧바로 나오게 한다.
            state.hasLeftovers = true;
          }
          refreshLeftovers().catch(() => render());
        });
      } else {
        // 북마클릿은 저장이 끝났는지 알 길이 없다. 조각을 남기고 목록에 바로 띄운다.
        state.hasLeftovers = true;
        refreshLeftovers().catch(() => render());
      }
      const took = ((Date.now() - began) / 1000).toFixed(1);
      const pads = [];
      if (state.start - realStart >= 0.05) pads.push(`앞 ${(state.start - realStart).toFixed(2)}초`);
      if (realEnd - state.end >= 0.05) pads.push(`뒤 ${(realEnd - state.end).toFixed(2)}초`);
      const note = pads.length ? ` · ${pads.join("·")}가 더 붙었습니다(프레임 경계)` : "";
      setStatus(
        `저장했습니다 · ${showClock(realStart, 2)}~${showClock(realEnd, 2)} ` +
          `(${showClock(mediaSeconds, 2)})${note} · ` +
          `${showMb(file.size)} MB · ${took}초` +
          // 저장 대화상자에서 취소했을 수도 있다. 그때 다시 받지 않아도 된다는 것을 알려준다.
          (state.hasLeftovers ? " · 조각을 남겨뒀습니다(다시 누르면 바로 나옵니다)" : ""),
        "ytdl-ok",
      );
    } catch (error) {
      // 조각이 남았을 수 있다 — 이어받기 안내와 버리기 버튼의 근거가 된다.
      if (resumable) state.hasLeftovers = true;
      // 내가 정지를 누른 것은 실패가 아니다.
      if (error instanceof Stopped) setStatus(`받기를 멈췄습니다${resumeHint}`);
      else if (net.httpStatusOf(error) === 503) {
        // 막 끝난 라이브는 유튜브가 아직 다시보기로 가공 중이라 고화질을 못 줄 때가 많다.
        setStatus(
          "서버가 지금 이 화질을 주지 못합니다(503) · 방금 끝난 라이브면 준비 중일 수 있어요" +
            ` · 잠시 뒤 다시 누르거나 낮은 화질을 골라보세요${resumeHint}`,
          "ytdl-bad",
        );
        say("받기 실패(서버 503):", error);
      } else if (net.httpStatusOf(error) === 403) {
        // 유튜브는 PO 토큰 없이는 **영상 앞부분 약 60초까지만** 내어준다. 그 너머는 받은
        // 양과 상관없이 언제나 403 이다 — 새 주소에서 곧바로 뒷부분을 달라고 해도 403 이고,
        // 클라이언트를 갈아타도 경계가 똑같다(ANDROID_VR·IOS·ANDROID 셋 다 60초. 실측).
        // 그러니 기다리라고 하면 안 된다. 열리지 않는다.
        setStatus(
          "유튜브가 PO 토큰 없이는 앞부분 약 60초까지만 내어줍니다(403)" +
            ` · 60초 안쪽 구간을 고르면 받힙니다${resumeHint}`,
          "ytdl-bad",
        );
        say("받기 실패(60초 경계 너머, 403):", error);
      } else if (error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "")) {
        // 용량 상한은 우리가 정하지 않는다 — 브라우저의 오리진 할당량이 곧 상한이다.
        setStatus("브라우저 저장 공간이 부족합니다. 디스크 여유를 만들고 다시 눌러주세요", "ytdl-bad");
        say("받기 실패(저장 공간):", error);
      } else {
        setStatus(`${error.message}${resumeHint}`, "ytdl-bad");
        say("받기 실패:", error);
      }
    } finally {
      clearInterval(ticker);
      lastProgress = null;
      state.busy = false;
      state.control = null;
      render();
    }
  }

  /**
   * 만든 파일을 브라우저에 넘긴다.
   *
   * **문서에 붙였다 누른다.** 떼어 놓은 채로 누르면 크롬이 그냥 무시할 때가 있다
   * (실제로 "다시 저장"이 조용히 아무 일도 안 했다).
   *
   * 그래도 안 되는 경우가 있어서(누른 지 시간이 지나 사용자 동작으로 안 쳐줄 때),
   * 같은 주소를 가리키는 링크를 하나 돌려준다 — 부르는 쪽이 눌러볼 수 있게 띄운다.
   */
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    setTimeout(() => link.remove(), 1000);
    // 브라우저가 내려받기를 시작할 틈을 준 뒤 정리한다.
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    return { url, name };
  }

  /** 저장이 막혔을 때 사람이 직접 누를 수 있는 링크를 상태줄에 띄운다. */
  function offerLink({ url, name }, text) {
    if (!el.status) return;
    const link = make("a", { class: "ytdl-save-link", text: "여기를 눌러 저장" });
    link.href = url;
    link.download = name;
    el.status.className = "ytdl-status ytdl-ok";
    el.status.replaceChildren(document.createTextNode(`${text} · `), link);
  }

  // 북마클릿은 사용자가 "지금 받겠다"고 눌러서 들어온 길이다. 패널을 바로 펼쳐 준다.
  // (확장은 버튼이 늘 붙어 있으니 누를 때까지 기다린다.)
  // 유튜브가 화면을 다 그리기 전이면 붙일 자리가 없다. 자리가 생기는 순간 한 번만 편다.
  let autoOpened = false;
  function maybeAutoOpen() {
    if (!bundled || autoOpened || state.open || !el.panel) return;
    autoOpened = true;
    togglePanel().then(() => {
      el.panel?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  mount();
  maybeAutoOpen();
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
    runClock(false);
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

  // 패널을 여닫는 단축키. 북마클릿은 눌러서 들어온 뒤 닫았다 다시 열 때 쓴다.
  //
  // Alt+S 를 쓴다. 크롬이 잡아둔 자리(Alt+D 는 주소창, Alt+E·F 는 메뉴)와 유튜브가 쓰는
  // 낱글자(k·j·l·f·t·c·m·i)를 모두 피해야 해서 조합키로 뒀다.
  listen(document, "keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code !== "KeyS") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (!el.panel) return;
    event.preventDefault();
    event.stopPropagation();
    togglePanel();
  });

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
    maybeAutoOpen();
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
      // 남은 조각 여부는 영상마다 따로다. 목록을 다시 받을 때 다시 알아본다.
      state.hasLeftovers = false;
      // 이전 영상의 재생 위치를 새 영상에 쓰면 안 된다.
      state.progress = null;
      state.progressAt = null;
      // 열려 있으면 새 영상 목록으로 갈아끼우고, 닫혀 있으면 열 때 받는다.
      if (state.open) loadFormats();
      else render();
    }
  }, 1000);
  cleanup.push(() => clearInterval(ticker));
})().catch((error) => {
  console.error("[yt-download] 시작하지 못했습니다:", error);
});
