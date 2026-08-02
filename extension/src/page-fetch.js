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
function readProgress() {
  const api = document.querySelector("#movie_player");
  if (!api || typeof api.getProgressState !== "function") return null;
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

let progressTimer = null;

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;

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
