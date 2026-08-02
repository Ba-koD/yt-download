// 페이지(MAIN) 쪽에서 대신 요청해 주는 작은 다리.
//
// 왜 이게 필요한가:
// - content script 에서 googlevideo 를 곧바로 부르면 교차 출처로 막힌다.
// - 배경 일꾼으로 보내면 `Origin: chrome-extension://…` 이 붙어 InnerTube 가 403 을 준다.
//   게다가 chrome.runtime.sendMessage 는 JSON 직렬화라 받은 바이트가 통째로 사라진다.
// - 페이지 안에서 부르면 유튜브 자신이 부르는 것과 같아서 둘 다 통과한다.
//
// 여기서는 오직 요청만 대신하고, 판단은 전부 확장 쪽에서 한다.

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;
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
