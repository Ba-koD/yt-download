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
      // 미디어(googlevideo)는 쿠키가 필요 없고, 붙이면 오히려 거절당할 수 있다.
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

  // kind 는 페이지 쪽에서 무슨 일을 시킬지 고르는 값이다("request" 는 그냥 받아오기).
  const ask = (payload, kind = "request") =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      target.postMessage({ ytdl: kind, id, ...payload }, "*");
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error("페이지가 응답하지 않습니다"));
      }, timeoutMs);
    });

  // 페이지(MAIN) 쪽에서 넘어온 ArrayBuffer 를 이 realm 의 버퍼로 복사해 온다.
  //
  // 파이어폭스에서는 MAIN 세계와 content script 가 **다른 realm** 이다. 넘어온 버퍼로
  // `new Uint8Array(buffer)` 는 되지만 그 뷰의 `.buffer` 가 여전히 외래 realm 이라,
  // 나중에 `new DataView(bytes.buffer)`(색인·먹싱에서 쓴다)를 만들 때 종족(constructor)
  // 조회에서 막힌다(`Permission denied to access property "constructor"`). 그래서 바이트를
  // 이 realm 의 새 버퍼로 실제 복사한다. 크롬은 같은 realm 이라 값만 한 번 더 복사될 뿐이다.
  const adopt = (buffer) => {
    let foreign;
    try {
      foreign = new Uint8Array(buffer);
    } catch {
      foreign = new Uint8Array(structuredClone(buffer));
    }
    const local = new Uint8Array(foreign.length); // 숫자로 만들어 이 realm 버퍼를 갖는다
    local.set(foreign); // 바이트만 읽어 복사한다(외래 뷰의 원소 접근은 허용된다)
    return local;
  };
  const decode = (buffer) => new TextDecoder().decode(adopt(buffer));

  return {
    json: async (url, init = {}) =>
      JSON.parse(
        decode(
          (await ask({ url, method: init.method, headers: init.headers, body: init.body })).buffer,
        ),
      ),
    text: async (url) => decode((await ask({ url })).buffer),
    bytes: async (url, headers) => adopt((await ask({ url, headers })).buffer),
    // 받아오기 말고 다른 일(예: n 풀기)을 시킬 때 쓴다.
    ask,
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

/**
 * 먼저 빠른 쪽으로 받아보고, 막히면 예비 통로로 다시 받는다.
 *
 * 통로가 막히는 원인(라이브 서버 교대의 리다이렉트 등)은 대개 일시적이다.
 * 그래서 영영 갈아타지 않고, 잠깐 식힌 뒤에는 빠른 통로를 다시 두드려 본다.
 * 예비 통로는 base64 를 거쳐서 눈에 띄게 느리다 — 긴 받기가 통째로 느려지면 아깝다.
 */
export function withFallback(primary, secondary, { coolOffMs = 60_000, now = Date.now } = {}) {
  let blocked = false;
  let blockedAt = 0;
  return async (url, headers) => {
    if (!blocked || now() - blockedAt >= coolOffMs) {
      try {
        const bytes = await primary(url, headers);
        blocked = false;
        return bytes;
      } catch (error) {
        // 상태 코드가 있다면 통로는 멀쩡한데 서버가 거절한 것이다. 통로를 갈아타 봐야
        // 같은 답이 오므로 그대로 던진다(일시적인 코드라면 withRetry 가 다시 시도한다).
        if (httpStatusOf(error)) throw error;
        // 상태 코드조차 없이 죽었다면(CORS 차단 등) 통로 문제다. 예비 통로로 옮겨 탄다.
        blocked = true;
        blockedAt = now();
        console.warn("[yt-download] 페이지 요청이 막혀 예비 통로로 넘어갑니다:", error.message);
      }
    }
    return secondary(url, headers);
  };
}

/** 실패 메시지에 담긴 HTTP 상태 코드. 없으면 0(네트워크 단계에서 죽은 것). */
export function httpStatusOf(error) {
  const found = /HTTP (\d{3})/.exec(String(error?.message || error));
  return found ? Number(found[1]) : 0;
}

/**
 * 일시적인 실패는 잠깐 쉬었다가 다시 받아 본다.
 *
 * 라이브 조각은 서버가 잠깐 503 을 주는 일이 흔하다(방금 만들어진 조각, 서버 교대 등).
 * 그 한 번에 전체 받기를 포기하지 않도록 점점 길게(상한 있음) 쉬며 몇 번 더 두드린다.
 * 요청 하나는 길어야 8MB 라(mergeRanges 가 그 크기로 자른다) 다시 받는 값이 싸다.
 * 403(주소 만료)·404 같은 답은 다시 물어도 같으므로 바로 던진다.
 */
export function withRetry(fetcher, { tries = 6, waitMs = 1000, maxWaitMs = 8000, sleep } = {}) {
  const rest = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transient = (error) => {
    const status = httpStatusOf(error);
    // 상태 코드가 없으면 네트워크가 잠깐 끊긴 것으로 보고 다시 해본다.
    if (!status) return true;
    return status === 408 || status === 429 || status >= 500;
  };
  return async (url, headers) => {
    let wait = waitMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetcher(url, headers);
      } catch (error) {
        if (attempt >= tries || !transient(error)) throw error;
        console.warn(
          `[yt-download] 잠시 쉬었다 다시 받아봅니다 (${attempt}/${tries - 1}):`,
          error.message,
        );
        await rest(wait);
        wait = Math.min(wait * 2, maxWaitMs);
      }
    }
  };
}
