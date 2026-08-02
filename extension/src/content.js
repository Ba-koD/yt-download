// 유튜브 영상 페이지에 구간 편집 패널을 얹는다.
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
  };

  const el = {};

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  }

  function player() {
    return document.querySelector(".html5-main-video") || document.querySelector("video");
  }

  function playerDuration() {
    const video = player();
    const known = Number(video?.duration);
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

  function build() {
    const root = document.createElement("div");
    root.className = "ytdl-panel";
    root.innerHTML = `
      <div class="ytdl-head">
        <span class="ytdl-title">구간 받기</span>
        <button class="ytdl-fold" type="button" title="접기">−</button>
      </div>
      <div class="ytdl-body">
        <div class="ytdl-row">
          <button class="ytdl-mark" data-mark="start" type="button">현재 위치 IN</button>
          <input class="ytdl-time" data-time="start" value="0:00" size="8" />
          <span class="ytdl-sep">~</span>
          <input class="ytdl-time" data-time="end" value="0:00" size="8" />
          <button class="ytdl-mark" data-mark="end" type="button">OUT</button>
        </div>
        <div class="ytdl-row">
          <span class="ytdl-length"></span>
          <select class="ytdl-quality"><option>불러오는 중…</option></select>
        </div>
        <button class="ytdl-go" type="button" disabled>구간 받기</button>
        <div class="ytdl-status">화질 목록을 불러오는 중입니다</div>
      </div>`;
    document.body.append(root);

    el.root = root;
    el.body = root.querySelector(".ytdl-body");
    el.fold = root.querySelector(".ytdl-fold");
    el.length = root.querySelector(".ytdl-length");
    el.quality = root.querySelector(".ytdl-quality");
    el.go = root.querySelector(".ytdl-go");
    el.status = root.querySelector(".ytdl-status");
    el.inputs = {
      start: root.querySelector('[data-time="start"]'),
      end: root.querySelector('[data-time="end"]'),
    };

    el.fold.addEventListener("click", () => {
      const folded = el.body.classList.toggle("ytdl-hidden");
      el.fold.textContent = folded ? "+" : "−";
      el.fold.title = folded ? "펼치기" : "접기";
    });

    for (const button of root.querySelectorAll(".ytdl-mark")) {
      button.addEventListener("click", () => {
        const video = player();
        if (!video) return;
        setRange(
          button.dataset.mark === "start" ? video.currentTime : state.start,
          button.dataset.mark === "end" ? video.currentTime : state.end,
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
        // 고친 지점으로 미리보기를 옮겨 눈으로 확인할 수 있게 한다.
        const video = player();
        if (video) video.currentTime = value;
      });
    }

    el.go.addEventListener("click", start);
    return root;
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
    el.inputs.start.value = showClock(state.start);
    el.inputs.end.value = showClock(state.end);
    const length = Math.max(0, state.end - state.start);
    el.length.textContent = `길이 ${showClock(length)}`;
    el.go.disabled = state.busy || !state.formats || length < 0.5;
  }

  function setStatus(text, kind = "") {
    el.status.textContent = text;
    el.status.className = `ytdl-status ${kind}`;
  }

  async function loadFormats() {
    const videoId = currentVideoId();
    if (!videoId) return;
    state.videoId = videoId;
    state.formats = null;
    el.quality.innerHTML = "<option>불러오는 중…</option>";
    setStatus("화질 목록을 불러오는 중입니다");

    try {
      const formats = await getFormats(videoId);
      if (state.videoId !== videoId) return; // 그 사이 다른 영상으로 옮겼다
      if (!formats.video.length || !formats.audio.length) {
        throw new Error("받을 수 있는 mp4 화질이 없습니다");
      }
      state.formats = formats;
      el.quality.innerHTML = "";
      for (const format of formats.video) {
        const option = document.createElement("option");
        option.value = String(format.itag);
        option.textContent = formatLabel(format);
        el.quality.append(option);
      }
      const video = player();
      setRange(0, video?.duration || formats.durationSeconds || 0);
      setStatus(formats.isLive ? "진행 중인 라이브는 아직 지원하지 않습니다" : "준비됨");
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
      el.quality.innerHTML = "<option>없음</option>";
    }
    render();
  }

  async function start() {
    if (state.busy || !state.formats) return;
    const videoFormat =
      state.formats.video.find((format) => String(format.itag) === el.quality.value) ||
      state.formats.video[0];
    const audioFormat = state.formats.audio[0];

    state.busy = true;
    render();
    const began = Date.now();

    try {
      const { bytes } = await downloadSection({
        videoFormat,
        audioFormat,
        start: state.start,
        end: state.end,
        onProgress: (done, total, stage) => {
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          setStatus(stage === "받는 중" ? `${stage} ${percent}%` : stage);
        },
      });

      const name =
        `${safeFileName(state.formats.title)} ` +
        `[${clockLabel(state.start)}~${clockLabel(state.end)}].mp4`;
      save(bytes, name);
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

  build();
  render();
  await loadFormats();

  // 유튜브는 페이지를 새로 그리지 않고 영상만 갈아끼운다.
  let lastId = state.videoId;
  setInterval(() => {
    const id = currentVideoId();
    if (id && id !== lastId) {
      lastId = id;
      loadFormats();
    }
  }, 1000);
})();
