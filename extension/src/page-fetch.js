// 페이지(MAIN) 쪽에서 대신 요청해 주는 작은 다리.
//
// 왜 이게 필요한가:
// - content script 에서 googlevideo 를 곧바로 부르면 교차 출처로 막힌다.
// - 배경 일꾼으로 보내면 `Origin: chrome-extension://…` 이 붙어 InnerTube 가 403 을 준다.
//   게다가 chrome.runtime.sendMessage 는 JSON 직렬화라 받은 바이트가 통째로 사라진다.
// - 페이지 안에서 부르면 유튜브 자신이 부르는 것과 같아서 둘 다 통과한다.
//
// 여기서는 오직 요청만 대신하고, 판단은 전부 확장 쪽에서 한다.

// 재생 위치와 되감기 구간은 플레이어에게 직접 물어본다.
//
// `video.seekable` 은 라이브에서 실제 되감기 구간보다 한 시간쯤 앞을 가리킨다.
// 그 값으로 막대를 그리면 라이브를 보고 있는데도 막대가 중간에 놓인다.
// 플레이어의 `getProgressState()` 는 정확하다. 다만 그 함수는 페이지 쪽에만 있어서
// 확장(격리된 세계)에서는 부를 수 없다. 그래서 여기서 읽어 넘긴다.
// 플레이어 요소는 화면마다 이름이 다르다(일반 #movie_player, 숏츠 #shorts-player).
//
// 숏츠 화면에는 **둘 다 있다.** 그런데 거기서 `#movie_player` 는 값이 전부 0 인
// 빈 껍데기다(직접 확인함). 하나만 골라 보고 끝내면 길이를 0 으로 읽는다.
// 그래서 후보를 차례로 읽어보고 쓸 만한 값을 주는 첫 번째를 쓴다.
function playerApis() {
  const found = ["#shorts-player", "#movie_player", ".html5-video-player"]
    .map((selector) => document.querySelector(selector))
    .filter((node) => node && typeof node.getProgressState === "function");
  return [...new Set(found)];
}

function readProgressFrom(api) {
  let state;
  try {
    state = api.getProgressState();
  } catch {
    return null;
  }
  if (!state || !Number.isFinite(state.current)) return null;
  // 라이브는 방송 전체 시간축을 쓰므로 offset 을 빼서 영상 기준으로 되돌린다.
  const offset = Number(state.offset) || 0;
  const start = Number(state.seekableStart) - offset;
  const end = Number(state.seekableEnd) - offset;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, current: Number(state.current) - offset, live: Boolean(state.ingestionTime) };
}

function readProgress() {
  for (const api of playerApis()) {
    const progress = readProgressFrom(api);
    if (progress) return progress;
  }
  return null;
}

let progressTimer = null;

// 플레이어(base.js)는 2~3MB 다. 한 번만 받아둔다.
let playerSource = null;

/**
 * 미디어 주소에 붙은 `n` 을 푼다.
 *
 * 왜 여기(페이지 쪽)에서 하나:
 *  - 해결기는 base.js 를 뜯어 새 코드를 만들어 돌린다. 확장 안에서는 그게 금지돼 있고,
 *    유튜브 페이지는 CSP 가 `unsafe-eval` 을 허용해서 여기서는 된다.
 *  - blob 일꾼은 못 쓴다. 유튜브 CSP 의 `script-src` 에 `blob:` 이 없어서 막힌다.
 *
 * 왜 빈 iframe 안에서 하나:
 *  - 유튜브는 이 페이지의 내장 함수를 자기 것으로 바꿔치기해 뒀다. 그대로 돌리면
 *    파서가 엉뚱한 데서 터진다("... 'attestationRequest' in null").
 *    새로 만든 틀(iframe)은 손타지 않은 깨끗한 곳이다.
 *  - 해결기가 준비 과정에서 `globalThis.location` 에 값을 넣는데, 창에서는 그게 곧
 *    페이지 이동이다. 본 화면에서 하면 유튜브가 날아간다. 틀 안이라 안전하고,
 *    답은 그전에 이미 나오므로(푸는 일은 동기다) 받자마자 틀을 치운다.
 */
async function solveChallenges({ lib, core, challenges }) {
  if (!playerSource) {
    const jsUrl = window.ytcfg?.get?.("PLAYER_JS_URL");
    if (!jsUrl) throw new Error("플레이어 주소를 찾지 못했습니다");
    playerSource = await (await fetch(jsUrl, { credentials: "same-origin" })).text();
  }

  const frame = document.createElement("iframe");
  frame.style.display = "none";
  document.documentElement.appendChild(frame);
  try {
    const realm = frame.contentWindow;
    // 해결기는 자기 안에서도 코드를 만들어 돌린다. 우리 손을 거치지 않으므로
    // 이 틀에만 기본 정책을 깔아 통과시킨다. 유튜브 본 화면은 그대로다.
    const policy = realm.trustedTypes?.createPolicy("default", {
      createScript: (text) => text,
      createScriptURL: (url) => url,
      createHTML: (html) => html,
    });
    const run = (source) => (policy ? realm.eval(policy.createScript(source)) : realm.eval(source));

    // 전역을 더럽히지 않도록 파서를 인자로 넘긴다.
    const parsers = run(`(function () {${lib};return lib; })`)();
    const solve = run(`(function (meriyah, astring) {${core};return jsc; })`)(
      parsers.meriyah,
      parsers.astring,
    );

    const result = solve({
      type: "player",
      player: playerSource,
      requests: [{ type: "n", challenges }],
    });
    if (result?.type === "error") throw new Error(result.error || "해결기 오류");
    const first = result.responses?.[0];
    if (first?.type !== "result") throw new Error(first?.error || "n 을 풀지 못했습니다");
    return first.data;
  } finally {
    frame.remove();
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;

  if (message?.ytdl === "solve") {
    try {
      const answers = await solveChallenges(message);
      window.postMessage({ ytdl: "response", id: message.id, ok: true, answers }, "*");
    } catch (error) {
      window.postMessage({
        ytdl: "response",
        id: message.id,
        ok: false,
        status: 0,
        error: String(error?.message || error),
      }, "*");
    }
    return;
  }

  if (message?.ytdl === "watch-progress") {
    clearInterval(progressTimer);
    progressTimer = null;
    if (!message.on) return;
    const tick = () => {
      const progress = readProgress();
      if (progress) window.postMessage({ ytdl: "progress", ...progress }, "*");
    };
    tick();
    progressTimer = setInterval(tick, 400);
    return;
  }

  if (message?.ytdl !== "request") return;

  const reply = (payload, transfer = []) =>
    window.postMessage({ ytdl: "response", id: message.id, ...payload }, "*", transfer);

  try {
    // youtube.com 은 로그인 상태로 물어봐야 내 비공개 영상 주소를 준다.
    // 미디어(googlevideo)는 쿠키가 필요 없고, 붙이면 오히려 거절당할 수 있다.
    const sameSite = new URL(message.url, location.href).hostname.endsWith("youtube.com");
    const response = await fetch(message.url, {
      method: message.method || "GET",
      headers: message.headers,
      body: message.body,
      credentials: sameSite ? "same-origin" : "omit",
    });
    // 바이트는 postMessage 로 그대로 넘어간다(여기는 JSON 직렬화가 아니다).
    const buffer = await response.arrayBuffer();
    reply({ ok: response.ok, status: response.status, buffer }, [buffer]);
  } catch (error) {
    reply({ ok: false, status: 0, error: String(error?.message || error) });
  }
});
