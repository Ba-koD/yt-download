// 네트워크 요청을 대신 해주는 배경 일꾼.
//
// content script 에서 곧바로 googlevideo 를 부르면 교차 출처로 막힌다.
// 배경 일꾼은 manifest 의 host_permissions 덕분에 그 제한을 받지 않으므로,
// 실제 요청은 전부 여기서 하고 결과만 넘겨준다.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  // 비동기로 답하겠다는 표시.
  return true;
});

async function handle(message) {
  if (message?.type === "json") return requestJson(message);
  if (message?.type === "text") return requestText(message);
  if (message?.type === "bytes") return requestBytes(message);
  throw new Error(`알 수 없는 요청: ${message?.type}`);
}

async function requestJson({ url, method, headers, body }) {
  const response = await fetch(url, { method: method || "GET", headers, body, credentials: "omit" });
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  return { ok: true, status: response.status, json: await response.json() };
}

async function requestText({ url }) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  return { ok: true, status: response.status, text: await response.text() };
}

async function requestBytes({ url, headers }) {
  const response = await fetch(url, { headers, credentials: "omit" });
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  // ArrayBuffer 는 메시지로 그대로 건네줄 수 있다.
  return { ok: true, status: response.status, buffer: await response.arrayBuffer() };
}
