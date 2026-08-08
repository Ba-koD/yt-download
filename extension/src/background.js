// 배경 일꾼이 하는 일은 하나다: 페이지 쪽에서 막혔을 때의 예비 통로(미디어 내려받기).
//
// googlevideo 가 다른 호스트로 넘기면(cms_redirect) 페이지 쪽이 막힐 수 있다.
// 리다이렉트를 탄 요청은 브라우저가 Origin 을 null 로 바꿔 보내므로, 응답의
// Access-Control-Allow-Origin 이 딱 맞는 값이 아니면 읽지 못한다. 그래서 rules.json 이
// googlevideo 응답에 `*` 를 박아 넣는다(우리 미디어 요청은 쿠키를 안 쓰므로 `*` 가 된다).
//
// 단, **우리가 쓰는 클라이언트(c=ANDROID_VR·WEB_CREATOR)의 주소에만** 건다.
// 유튜브 자신의 플레이어(c=WEB)는 쿠키를 실어 보내는데(credentials: include),
// 그 요청에 `*` 를 박으면 CORS 규칙 위반으로 **유튜브 재생 자체가 죽는다**(실제로 죽었다).
//
// 그래도 막히는 경우를 위해 남겨둔 것이 이 예비 통로다 — 배경 일꾼은
// host_permissions 덕분에 CORS 제한을 받지 않는다.
//
// 다만 chrome.runtime.sendMessage 는 JSON 직렬화라 ArrayBuffer 를 그대로 못 보낸다.
// 그래서 여기서 base64 로 바꿔 보낸다(느리지만 예비 경로에서만 쓴다).
//
// (예전에는 "관리자가 폴더를 갈아 끼우면 스스로 다시 켜기" 도 여기서 했다. 관리자를
//  없애면서 함께 지웠다 — 확장은 이제 릴리스에서 직접 받아 손으로 얹는다.)

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bytes") return false;
  fetchBytes(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true; // 비동기로 답한다
});

async function fetchBytes({ url, headers }) {
  const response = await fetch(url, { headers, credentials: "omit" });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  // finalUrl 은 리다이렉트를 따라간 최종 주소다. 페이지 쪽이 이 주소를 기억해 두면
  // 다음 요청부터 도착지 서버를 곧장 불러(리다이렉트 없음) CORS 로 막히지 않는다.
  return {
    ok: true,
    base64: toBase64(new Uint8Array(await response.arrayBuffer())),
    finalUrl: response.url,
  };
}

function toBase64(bytes) {
  // 한 번에 넘기면 인자 개수 제한에 걸리므로 조금씩 이어 붙인다.
  const step = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}
