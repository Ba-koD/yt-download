// 요청 통로. 기본은 그냥 fetch 지만, 확장 안에서는 배경 일꾼을 거치도록 바꿔 끼운다.
//
// content script 가 직접 googlevideo 를 부르면 교차 출처로 막히기 때문이다.
// 이렇게 갈아끼울 수 있게 해두면 브라우저 밖(테스트)에서도 같은 코드를 돌릴 수 있다.

/** 페이지에서 그대로 부르는 통로. youtube.com 은 동일 출처라 이걸 써야 한다. */
export function directTransport() {
  return {
  async json(url, init) {
    const response = await fetch(url, { credentials: "omit", ...init });
    if (!response.ok) throw new Error(`요청 실패 (HTTP ${response.status})`);
    return response.json();
  },
  async text(url) {
    const response = await fetch(url, { credentials: "omit" });
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
 * 배경 일꾼을 거치는 통로.
 *
 * 미디어(googlevideo)는 content script 에서 곧바로 부르면 교차 출처로 막히므로 이쪽을 써야 한다.
 * 반대로 youtube.com 은 이쪽으로 보내면 안 된다. 배경 일꾼의 요청에는
 * `Origin: chrome-extension://…` 이 붙는데, InnerTube 는 그런 요청을 403 으로 거절한다.
 */
export function backgroundTransport(runtime) {
  const ask = (message) =>
    new Promise((resolve, reject) => {
      runtime.sendMessage(message, (reply) => {
        const failure = runtime.lastError;
        if (failure) reject(new Error(failure.message));
        else if (!reply?.ok) reject(new Error(reply?.error || "요청 실패"));
        else resolve(reply);
      });
    });

  return {
    json: async (url, init = {}) =>
      (await ask({ type: "json", url, method: init.method, headers: init.headers, body: init.body }))
        .json,
    text: async (url) => (await ask({ type: "text", url })).text,
    bytes: async (url, headers) => new Uint8Array((await ask({ type: "bytes", url, headers })).buffer),
  };
}
