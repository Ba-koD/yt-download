// 요청 통로. 기본은 그냥 fetch 지만, 확장 안에서는 배경 일꾼을 거치도록 바꿔 끼운다.
//
// content script 가 직접 googlevideo 를 부르면 교차 출처로 막히기 때문이다.
// 이렇게 갈아끼울 수 있게 해두면 브라우저 밖(테스트)에서도 같은 코드를 돌릴 수 있다.

/** 페이지에서 그대로 부르는 통로. youtube.com 은 동일 출처라 이걸 써야 한다. */
export function directTransport() {
  return {
  async json(url, init) {
    // youtube.com 은 같은 출처라 쿠키가 함께 나간다.
    // 내 비공개 영상이나 멤버 전용 영상은 로그인 상태여야 주소를 준다.
    const response = await fetch(url, { credentials: "same-origin", ...init });
    if (!response.ok) throw new Error(`요청 실패 (HTTP ${response.status})`);
    return response.json();
  },
  async text(url) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`요청 실패 (HTTP ${response.status})`);
    return response.text();
  },
  async bytes(url, headers) {
    const response = await fetch(url, { headers, credentials: "omit" });
    if (!response.ok) throw new Error(`조각을 받지 못했습니다 (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  },
  };
}

let transport = directTransport();

export function useTransport(next) {
  transport = next;
}

export const request = {
  json: (url, init) => transport.json(url, init),
  text: (url) => transport.text(url),
  bytes: (url, headers) => transport.bytes(url, headers),
};

/**
 * 페이지(MAIN) 쪽에 요청을 대신 시키는 통로.
 *
 * content script 에서 곧바로 googlevideo 를 부르면 교차 출처로 막히고,
 * 배경 일꾼으로 보내면 Origin 이 붙어 InnerTube 가 403 을 준다.
 * 페이지 안에서 부르면 유튜브 자신이 부르는 것과 같아 둘 다 통과한다.
 */
export function pageTransport(target = window, timeoutMs = 120_000) {
  let nextId = 1;
  const waiting = new Map();

  target.addEventListener("message", (event) => {
    if (event.source !== target) return;
    const message = event.data;
    if (message?.ytdl !== "response") return;
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(message.error || `요청 실패 (HTTP ${message.status})`));
  });

  const ask = (payload) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      target.postMessage({ ytdl: "request", id, ...payload }, "*");
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error("페이지가 응답하지 않습니다"));
      }, timeoutMs);
    });

  const decode = (buffer) => new TextDecoder().decode(new Uint8Array(buffer));

  return {
    json: async (url, init = {}) =>
      JSON.parse(
        decode(
          (await ask({ url, method: init.method, headers: init.headers, body: init.body })).buffer,
        ),
      ),
    text: async (url) => decode((await ask({ url })).buffer),
    bytes: async (url, headers) => new Uint8Array((await ask({ url, headers })).buffer),
  };
}

/**
 * 예비 통로. 배경 일꾼이 대신 받아 base64 로 돌려준다.
 *
 * 페이지 쪽이 CORS 로 막혔을 때만 쓴다. 바이트를 문자로 바꿔 넘기느라 느리지만,
 * 배경 일꾼은 host_permissions 덕분에 리다이렉트를 타도 막히지 않는다.
 */
export function workerBytes(runtime) {
  return (url, headers) =>
    new Promise((resolve, reject) => {
      runtime.sendMessage({ type: "bytes", url, headers }, (reply) => {
        const failure = runtime.lastError;
        if (failure) return reject(new Error(failure.message));
        if (!reply?.ok) return reject(new Error(reply?.error || "요청 실패"));
        resolve(decodeBase64(reply.base64));
      });
    });
}

export function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 먼저 빠른 쪽으로 받아보고, 막히면 예비 통로로 다시 받는다. */
export function withFallback(primary, secondary) {
  let usePrimary = true;
  return async (url, headers) => {
    if (usePrimary) {
      try {
        return await primary(url, headers);
      } catch (error) {
        // 한 번 막히면 그 뒤로도 막힐 가능성이 크므로 아예 예비 통로로 옮겨 탄다.
        usePrimary = false;
        console.warn("[yt-download] 페이지 요청이 막혀 예비 통로로 넘어갑니다:", error.message);
      }
    }
    return secondary(url, headers);
  };
}
