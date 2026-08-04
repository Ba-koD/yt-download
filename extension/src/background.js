// 배경 일꾼이 하는 일은 하나다: 페이지 쪽에서 막혔을 때의 예비 통로(미디어 내려받기).
//
// googlevideo 가 다른 호스트로 넘기면(cms_redirect) 넘어간 응답에 CORS 헤더가 없어서
// 페이지에서는 읽을 수 없다. 배경 일꾼은 host_permissions 덕분에 그 제한을 받지 않는다.
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
  return { ok: true, base64: toBase64(new Uint8Array(await response.arrayBuffer())) };
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
