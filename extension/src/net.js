// 요청 통로. 기본은 그냥 fetch 지만, 확장 안에서는 배경 일꾼을 거치도록 바꿔 끼운다.
//
// content script 가 직접 googlevideo 를 부르면 교차 출처로 막히기 때문이다.
// 이렇게 갈아끼울 수 있게 해두면 브라우저 밖(테스트)에서도 같은 코드를 돌릴 수 있다.

let transport = {
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

export function useTransport(next) {
  transport = next;
}

export const request = {
  json: (url, init) => transport.json(url, init),
  text: (url) => transport.text(url),
  bytes: (url, headers) => transport.bytes(url, headers),
};

/** 확장 안에서 쓰는 통로. 실제 요청은 배경 일꾼이 대신 한다. */
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
