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
 * 예비 통로. 배경 일꾼이 대신 받아 base64 와 최종 도착 주소를 돌려준다.
 *
 * 페이지 쪽이 CORS 로 막혔을 때만 쓴다. 바이트를 문자로 바꿔 넘기느라 느리지만,
 * 배경 일꾼은 host_permissions 덕분에 리다이렉트를 타도 막히지 않는다.
 * finalUrl 은 리다이렉트를 따라간 도착지다 — withFallback 이 기억해 두고
 * 다음부터는 빠른 통로로 도착지를 곧장 부른다.
 */
export function workerBytes(runtime) {
  return (url, headers) =>
    new Promise((resolve, reject) => {
      runtime.sendMessage({ type: "bytes", url, headers }, (reply) => {
        const failure = runtime.lastError;
        if (failure) return reject(new Error(failure.message));
        if (!reply?.ok) return reject(new Error(reply?.error || "요청 실패"));
        resolve({ bytes: decodeBase64(reply.base64), finalUrl: reply.finalUrl });
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
 * 빠른 통로가 막히는 원인은 대개 서버 교대의 리다이렉트다(리다이렉트를 탄 요청은
 * CORS 헤더 주입이 안 먹는다). 그런데 리다이렉트의 **도착지를 곧장 부르면** 리다이렉트가
 * 없어 막히지 않는다. 그래서 예비 통로(배경 일꾼)가 알려준 도착지를 기억해 두고,
 * 다음 요청부터는 빠른 통로로 도착지를 직접 두드린다 — 느린 base64 예비 통로는
 * 서버가 바뀌는 순간 한 번만 쓰게 된다.
 *
 * 도착지를 아직 모르는 채 막혔을 때만 예전처럼 잠깐 식힌 뒤 빠른 통로를 다시 두드린다.
 */
export function withFallback(primary, secondary, { coolOffMs = 60_000, now = Date.now } = {}) {
  let blocked = false;
  let blockedAt = 0;
  const memory = redirectMemory();
  return async (url, headers) => {
    const direct = memory.resolve(url);
    // 도착지로 직행하는 요청은 리다이렉트가 없으니, 막혔던 중이라도 바로 시도한다.
    if (direct !== url || !blocked || now() - blockedAt >= coolOffMs) {
      try {
        const bytes = await primary(direct, headers);
        blocked = false;
        return bytes;
      } catch (error) {
        // 상태 코드가 있다면 통로는 멀쩡한데 서버가 거절한 것이다. 통로를 갈아타 봐야
        // 같은 답이 오므로 그대로 던진다(일시적인 코드라면 withRetry 가 다시 시도한다).
        if (httpStatusOf(error)) throw error;
        // 상태 코드조차 없이 죽었다면(CORS 차단 등) 통로 문제다. 예비 통로로 옮겨 탄다.
        // 자동으로 처리되는 일이므로 오류처럼 보이지 않게 info 로, 전환되는 순간 한 번만 적는다
        // (요청 여섯이 나란히 막히면 같은 줄이 여섯 번 찍혔다).
        if (!blocked) {
          console.info("[yt-download] 페이지 요청이 막혀 예비 통로로 넘어갑니다:", error.message);
        }
        blocked = true;
        blockedAt = now();
        // 기억해 둔 도착지마저 막혔다면 서버가 또 바뀐 것이다. 버리고 새로 배운다.
        if (direct !== url) memory.forget(url);
      }
    }
    const { bytes, finalUrl } = await secondary(url, headers);
    if (memory.learn(url, finalUrl)) {
      console.info("[yt-download] 옮겨간 서버를 기억했습니다. 다음 조각부터 곧장 받습니다.");
    }
    return bytes;
  };
}

/**
 * 리다이렉트 도착지를 기억한다: 원래 주소(sq 제외) → 도착지 주소(sq 제외).
 *
 * 라이브 조각은 같은 밑 주소에 &sq=번호 만 바뀌므로, sq 를 떼서 짝을 지어 두면
 * 어느 조각이든 도착지 주소에 sq 만 다시 붙여 만들 수 있다(sq 는 서명 대상이 아니다).
 * sq 가 없는 일반 영상 주소는 통째로 짝이 된다.
 */
export function redirectMemory() {
  const learned = new Map();
  const keyOf = (url) => url.replace(/[?&]sq=\d+/, "");
  const sqOf = (url) => /[?&]sq=(\d+)/.exec(url)?.[1];
  return {
    resolve(url) {
      const target = learned.get(keyOf(url));
      if (!target) return url;
      const sq = sqOf(url);
      return sq === undefined ? target : `${target}&sq=${sq}`;
    },
    learn(url, finalUrl) {
      if (!finalUrl || keyOf(finalUrl) === keyOf(url)) return false;
      learned.set(keyOf(url), keyOf(finalUrl));
      return true;
    },
    forget(url) {
      learned.delete(keyOf(url));
    },
  };
}

/**
 * 서버 교대 리다이렉트를 302 대신 "본문 안내"로 받아 CORS 차단을 원천 봉쇄한다.
 *
 * googlevideo 는 주소에 `alr=yes` 를 붙이면(유튜브 플레이어 자신이 쓰는 방식)
 * 302 로 넘기는 대신 HTTP 200 에 **새 주소를 본문 텍스트로** 담아 준다.
 * 리다이렉트가 아예 없으니 페이지 fetch 가 CORS 로 막힐 일도 없다 — 배경 일꾼이
 * 없는 북마클릿에서도 통한다. 안내받은 도착지는 기억해 두고 다음 조각부터 직행한다.
 * (alr 은 서명 대상이 아니라 붙여도 안전하고, 서버가 모르는 값이면 그냥 무시된다.)
 */
export function withAppRedirect(fetcher) {
  const memory = redirectMemory();
  const withAlr = (url) => (/[?&]alr=/.test(url) ? url : `${url}&alr=yes`);
  return async (url, headers) => {
    let target = memory.resolve(url);
    let moved = target !== url;
    for (let hop = 0; hop < 4; hop += 1) {
      let bytes;
      try {
        bytes = await fetcher(withAlr(target), headers);
      } catch (error) {
        // 기억해 둔 도착지가 죽었으면(만료 등) 잊고 원래 주소로 한 번 되돌아간다.
        if (moved && hop === 0) {
          memory.forget(url);
          target = url;
          moved = false;
          continue;
        }
        throw error;
      }
      const next = appRedirectUrl(bytes);
      if (!next) {
        if (moved && memory.learn(url, target)) {
          console.info("[yt-download] 서버가 옮겨갔습니다. 다음 조각부터 새 서버로 곧장 받습니다.");
        }
        return bytes;
      }
      target = next;
      moved = true;
    }
    throw new Error("서버가 안내한 주소가 너무 여러 번 바뀝니다");
  };
}

/** alr=yes 응답이 "새 주소 안내" 인지 판별한다. 미디어 조각이 통째로 주소일 수는 없다. */
export function appRedirectUrl(bytes) {
  if (bytes.length < 12 || bytes.length > 8192) return null;
  const text = new TextDecoder().decode(bytes).trim();
  return /^https:\/\/\S+$/.test(text) ? text : null;
}

/** 통로를 지나간 바이트를 세어 준다. 다운로드 속도 표시는 이 숫자로 만든다. */
export function withMeter(fetcher, onBytes) {
  return async (url, headers) => {
    const bytes = await fetcher(url, headers);
    onBytes?.(bytes.length);
    return bytes;
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
// 몫이 다시 열릴 때까지 기다려야 해서 상한이 길다(8초로는 모자랐다 — 실측).
export function withRetry(fetcher, { tries = 7, waitMs = 1000, maxWaitMs = 30_000, sleep } = {}) {
  const rest = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transient = (error, url) => {
    const status = httpStatusOf(error);
    // 상태 코드가 없으면 네트워크가 잠깐 끊긴 것으로 보고 다시 해본다.
    if (!status) return true;
    if (status === 408 || status === 429 || status >= 500) return true;
    // googlevideo 의 403 은 영구 거절이 아니라 "이 영상은 지금 이만큼까지"라는 뜻이다.
    //
    // 실측한 것: 한 영상에서 일정량(어떤 영상은 18MB, 다른 영상은 60MB)을 받고 나면
    // 그 뒤 자리는 전부 403 이 된다. 주소를 새로 받아도, 방문자 ID 를 새로 만들어도,
    // 쿠키를 빼도 똑같다 — 아이피와 영상에 걸린 몫이다. 트랙도 가리지 않는다(영상 쪽을
    // 다 쓰면 소리 쪽도 곧바로 403 이었다). 반면 **이미 받아둔 자리는 계속 내어준다**.
    // 그리고 시간이 지나면 다시 열린다.
    //
    // 그래서 미디어의 403 은 기다렸다 다시 두드린다. 조각은 저장소에 남으므로
    // 중간에 그만두더라도 다음에 없는 것만 마저 받는다(이어받기).
    return status === 403 || (status === 401 && /[?&]live=1/.test(String(url)));
  };
  return async (url, headers) => {
    let wait = waitMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetcher(url, headers);
      } catch (error) {
        if (attempt >= tries || !transient(error, url)) throw error;
        // 재시도로 처리되는 일이므로 오류처럼 보이지 않게 info 로 적는다.
        console.info(
          `[yt-download] 잠시 쉬었다 다시 받아봅니다 (${attempt}/${tries - 1}):`,
          error.message,
        );
        await rest(wait);
        wait = Math.min(wait * 2, maxWaitMs);
      }
    }
  };
}
