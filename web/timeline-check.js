// 브라우저 없이 구간 편집 로직을 확인하는 검사기.
// 실행: deno run --allow-read web/timeline-check.js

function makeNode(id) {
  return {
    id,
    children: [],
    style: {
      values: {},
      setProperty(key, value) {
        this.values[key] = value;
      },
      removeProperty(key) {
        delete this.values[key];
      },
    },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    dataset: {},
    clientWidth: 800,
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    checked: false,
    options: [],
    addEventListener() {},
    append(child) {
      this.children.push(child);
    },
    closest: () => null,
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, width: 800, top: 0, height: 54 }),
    removeAttribute() {},
    querySelector: () => makeNode("child"),
  };
}

const nodes = new Map();
globalThis.document = {
  querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, makeNode(selector));
    return nodes.get(selector);
  },
  querySelectorAll: () => [],
  createElement: (tag) => makeNode(tag),
  get activeElement() {
    return null;
  },
  title: "",
};
globalThis.window = { addEventListener() {}, YT: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = () => Promise.reject(new Error("no network in checks"));

const { state } = await import("./state.js");
const timeline = await import("./timeline.js");
const player = await import("./player.js");
const video = await import("./video.js");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${label} ${detail}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label} ${detail}`);
  }
}

const pointer = (x, extra = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: x,
  target: { closest: () => null },
  preventDefault() {},
  ...extra,
});

// 1) 긴 영상에서 구간 지정
state.duration = 7200;
timeline.setRangeValues(3600, 3630, "start");
timeline.resetView();
check("range set", state.range.start === 3600 && state.range.end === 3630);
check("view full", Math.abs(timeline.viewSpan() - 7200) < 0.01);

// 2) 구간에 맞추기(확대)
timeline.fitViewToSelection();
check("fit zooms in", timeline.viewSpan() < 60, `span=${timeline.viewSpan().toFixed(1)}`);
check("selection inside view", state.view.start <= 3600 && state.view.end >= 3630);

// 3) 확대/축소 한계
for (let i = 0; i < 40; i += 1) timeline.zoomBy(0.55, 0.5);
check("zoom floor", timeline.viewSpan() >= 1.99, `span=${timeline.viewSpan().toFixed(2)}`);
for (let i = 0; i < 40; i += 1) timeline.zoomBy(1.8, 0.5);
check("zoom ceiling", Math.abs(timeline.viewSpan() - 7200) < 0.01);
check("view clamped", state.view.start === 0 && Math.abs(state.view.end - 7200) < 0.01);

// 4) 핸들을 끌어 OUT 옮기기
timeline.setRangeValues(1000, 2000, "start");
timeline.setView(900, 1200);
timeline.onTrackPointerDown(pointer(((2000 - 900) / 1200) * 800));
check("drag grabs end handle", state.drag?.mode === "end", `mode=${state.drag?.mode}`);
timeline.onPointerMove({ pointerId: 1, clientX: ((1500 - 900) / 1200) * 800 });
check("end moved back", Math.abs(state.range.end - 1500) < 5, `end=${state.range.end.toFixed(1)}`);
timeline.onPointerUp({ pointerId: 1 });
check("drag released", state.drag === null);

// 5) 빈 곳을 끌면 새 구간
timeline.setView(0, 7200);
timeline.onTrackPointerDown(pointer((100 / 7200) * 800, { pointerId: 2 }));
check("empty drag starts as seek", state.drag.mode === "seek");
timeline.onPointerMove({ pointerId: 2, clientX: (900 / 7200) * 800 });
timeline.onPointerUp({ pointerId: 2 });
check(
  "new selection drawn",
  Math.abs(state.range.start - 100) < 30 && Math.abs(state.range.end - 900) < 30,
  `${state.range.start.toFixed(0)}-${state.range.end.toFixed(0)}`,
);

// 6) 구간 안쪽을 끌면 통째로 이동
const length = state.range.end - state.range.start;
timeline.onTrackPointerDown(pointer((500 / 7200) * 800, { pointerId: 3 }));
check("inside drag moves", state.drag.mode === "move");
timeline.onPointerMove({ pointerId: 3, clientX: (1500 / 7200) * 800 });
check("length kept", Math.abs(state.range.end - state.range.start - length) < 1);
check("moved by delta", Math.abs(state.range.start - 1100) < 40, `start=${state.range.start.toFixed(0)}`);
timeline.onPointerUp({ pointerId: 3 });

// 7) 최소 길이 보장
timeline.setRangeValues(500, 500, "start");
check("min gap", state.range.end - state.range.start >= timeline.minGap() - 1e-9);

// 8) 휠 확대는 커서 위치를 유지
timeline.setView(0, 7200);
const anchorBefore = timeline.ratioToTime(0.25);
timeline.onTrackWheel({ deltaY: -1, clientX: 0.25 * 800, shiftKey: false, preventDefault() {} });
check(
  "wheel keeps anchor",
  Math.abs(timeline.ratioToTime(0.25) - anchorBefore) < 1,
  `${timeline.ratioToTime(0.25).toFixed(1)} vs ${anchorBefore.toFixed(1)}`,
);

// 9) 라이브 시간 기준: 되감기 구간 안의 위치를 방송 시작 기준으로 옮긴다
const release = 1_700_000_000;
state.metadata = { live_status: "is_live", is_live: true, release_timestamp: release };
state.duration = 10800;
state.liveDurationAtLoad = 10800;
state.liveLoadedAt = release + 10800;
state.player = {
  getCurrentTime: () => 120,
  getDuration: () => 7200,
  getVideoData: () => ({ progressBarStartPositionUtcTimeMillis: (release + 3600) * 1000 }),
  seekTo: () => {},
};
player.calibratePlayerTimeOffset();
check(
  "live offset from broadcast start",
  Math.abs(state.playerTimeOffset - 3600) < 1,
  `offset=${state.playerTimeOffset}`,
);
check("player time becomes absolute", Math.abs(player.playerTimeToUiTime(120) - 3720) < 1);
check("absolute time maps back", Math.abs(player.uiTimeToPlayerTime(3720) - 120) < 1);
player.markFromPlayer("start");
check("mark IN uses absolute time", Math.abs(state.range.start - 3720) < 1, `in=${state.range.start.toFixed(0)}`);

state.metadata = { live_status: "not_live", is_live: false };
state.playerTimeOffsetReady = false;
player.calibratePlayerTimeOffset();
check("vod keeps player time", state.playerTimeOffset === 0);

// 10) 미리보기 비율
video.applyPreviewRatio({ width: 1080, height: 1920 });
check("portrait ratio", nodes.get(".preview-frame").style.values["--preview-ratio"] === "0.5625");
video.applyPreviewRatio({});
check("default ratio 16:9", nodes.get(".preview-frame").style.values["--preview-ratio"] === "1.7778");

console.log(failures ? `\n${failures} FAILURES` : "\nall timeline checks passed");
if (failures) Deno.exit(1);
