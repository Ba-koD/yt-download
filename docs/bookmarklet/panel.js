// yt-download 북마클릿판 — scripts/build-bookmarklet.py 가 만든 파일입니다.
// 고칠 곳은 extension/src/ 입니다. 이 파일을 직접 고치지 마세요.
(() => {
const __mods = {};
const __ready = {};
const __define = (name, factory) => { __mods[name] = factory; };
const __need = (name) => {
  if (!(name in __ready)) {
    if (!__mods[name]) throw new Error(`모듈을 찾지 못했습니다: ${name}`);
    __ready[name] = __mods[name](__need);
  }
  return __ready[name];
};
__define("net.js", (__need) => {
// 요청 통로. 기본은 그냥 fetch 지만, 확장 안에서는 배경 일꾼을 거치도록 바꿔 끼운다.
//
// content script 가 직접 googlevideo 를 부르면 교차 출처로 막히기 때문이다.
// 이렇게 갈아끼울 수 있게 해두면 브라우저 밖(테스트)에서도 같은 코드를 돌릴 수 있다.

/** 페이지에서 그대로 부르는 통로. youtube.com 은 동일 출처라 이걸 써야 한다. */
function directTransport() {
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
    async post(url, body) {
      const response = await fetch(url, { method: "POST", body, credentials: "omit" });
      if (!response.ok) throw new Error(`조각을 받지 못했습니다 (HTTP ${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

let transport = directTransport();

function useTransport(next) {
  transport = next;
}

const request = {
  json: (url, init) => transport.json(url, init),
  text: (url) => transport.text(url),
  bytes: (url, headers) => transport.bytes(url, headers),
  // SABR 전용. 재시도·서버 안내(alr) 껍데기를 거치지 않는다 —
  // 그 껍데기들은 GET 으로 범위를 받는 길에 맞춰져 있어 POST 에는 해가 된다.
  post: (url, body) => transport.post(url, body),
};

/**
 * 페이지(MAIN) 쪽에 요청을 대신 시키는 통로.
 *
 * content script 에서 곧바로 googlevideo 를 부르면 교차 출처로 막히고,
 * 배경 일꾼으로 보내면 Origin 이 붙어 InnerTube 가 403 을 준다.
 * 페이지 안에서 부르면 유튜브 자신이 부르는 것과 같아 둘 다 통과한다.
 */
function pageTransport(target = window, timeoutMs = 120_000) {
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
    post: async (url, body) => adopt((await ask({ url, method: "POST", body })).buffer),
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
function workerBytes(runtime) {
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

function decodeBase64(text) {
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
function withFallback(primary, secondary, { coolOffMs = 60_000, now = Date.now } = {}) {
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
function redirectMemory() {
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
function withAppRedirect(fetcher) {
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
function appRedirectUrl(bytes) {
  if (bytes.length < 12 || bytes.length > 8192) return null;
  const text = new TextDecoder().decode(bytes).trim();
  return /^https:\/\/\S+$/.test(text) ? text : null;
}

/** 통로를 지나간 바이트를 세어 준다. 다운로드 속도 표시는 이 숫자로 만든다. */
function withMeter(fetcher, onBytes) {
  return async (url, headers) => {
    const bytes = await fetcher(url, headers);
    onBytes?.(bytes.length);
    return bytes;
  };
}

/** 실패 메시지에 담긴 HTTP 상태 코드. 없으면 0(네트워크 단계에서 죽은 것). */
function httpStatusOf(error) {
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
function withRetry(fetcher, { tries = 6, waitMs = 1000, maxWaitMs = 8000, sleep } = {}) {
  const rest = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transient = (error, url) => {
    const status = httpStatusOf(error);
    // 상태 코드가 없으면 네트워크가 잠깐 끊긴 것으로 보고 다시 해본다.
    if (!status) return true;
    if (status === 408 || status === 429 || status >= 500) return true;
    // 403 은 여기서 기다리지 않는다. 이 오류는 "이 영상·이 클라이언트 몫을 다 썼다"는
    // 뜻인데(download.js 의 makePuller 주석 참고), 기다려도 잘 열리지 않는 반면
    // 다른 클라이언트로 주소를 새로 받으면 곧바로 이어진다. 그 갈아타기가 위층에서
    // 일어나므로, 여기서 붙잡고 있으면 갈아타기만 늦어진다.
    // 막 시작한 라이브는 가장자리 서버가 401·403 을 잠깐 주기도 해서 그때만 다시 본다.
    return (status === 401 || status === 403) && /[?&]live=1/.test(String(url));
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

return {directTransport: directTransport, useTransport: useTransport, request: request, pageTransport: pageTransport, workerBytes: workerBytes, decodeBase64: decodeBase64, withFallback: withFallback, redirectMemory: redirectMemory, withAppRedirect: withAppRedirect, appRedirectUrl: appRedirectUrl, withMeter: withMeter, httpStatusOf: httpStatusOf, withRetry: withRetry};
});
__define("innertube.js", (__need) => {
// 유튜브 내부 API(InnerTube)에서 실제 다운로드 주소를 받아온다.
//
// 웹 클라이언트로 물어보면 요즘은 주소를 주지 않는다(SABR 로 넘어갔다).
// 반면 ANDROID_VR 클라이언트로 물어보면 포맷마다 직접 주소를 주고,
// 그 주소에는 속도 제한용 n 파라미터도 붙지 않아 서명 해독이 필요 없다.

const { request } = __need("net.js");
const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

// 이 클라이언트 정보가 낡으면 유튜브가 주소를 주지 않는다. 가장 먼저 의심할 곳이다.
const CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  androidSdkVersion: 32,
  osName: "Android",
  osVersion: "12L",
  hl: "en",
  gl: "US",
};

/**
 * 403 이 났을 때 갈아탈 클라이언트들.
 *
 * 주소가 만료된 경우를 잡는 용도다. **60초 벽에는 소용이 없다** — 로그인하지 않으면
 * 유튜브가 앞부분 약 60초까지만 내어주는데, `ANDROID_VR`·`IOS`·`ANDROID` 셋의 경계가
 * 바이트까지 똑같아서(245.7MB 파일에서 셋 다 23.27MB) 갈아타도 그대로 막힌다.
 * 60초 너머를 받으려면 `WEB_CREATOR`(로그인) 나 `TVHTML5_SIMPLY`(로그아웃) 로 물어
 * PO 토큰을 붙여야 한다(`fetchPlayerResponse`).
 *
 * 갈아타도 안전한 이유: 같은 itag 면 세 클라이언트가 **완전히 같은 파일**을 준다.
 * contentLength·initRange·indexRange·lastModified 가 모두 같고, 앞부분 바이트를 받아
 * 견주어도 같았다. 그래서 받다가 중간에 주소만 바꿔 끼워도 이어진다.
 */
const FALLBACK_CLIENTS = [
  {
    clientName: "IOS",
    clientVersion: "20.10.4",
    deviceMake: "Apple",
    deviceModel: "iPhone16,2",
    osName: "iPhone",
    osVersion: "18.3.2.22D82",
    hl: "en",
    gl: "US",
  },
  {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    androidSdkVersion: 34,
    osName: "Android",
    osVersion: "14",
    hl: "en",
    gl: "US",
  },
];

/** 기본 클라이언트부터 차례로 돌 목록. 몫이 떨어지면 다음 것으로 갈아탄다. */
const ROTATION = [CLIENT, ...FALLBACK_CLIENTS];

function buildPlayerRequest(videoId, visitorData, client = CLIENT, sts) {
  const body = {
    videoId,
    context: { client: { ...client, visitorData: visitorData || "" } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  // TVHTML5_SIMPLY 는 이게 없으면 UNPLAYABLE 로 끝난다(주소를 하나도 주지 않는다).
  if (sts) {
    body.playbackContext = {
      contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS", signatureTimestamp: sts },
    };
  }
  return body;
}

/** 유튜브 첫 화면에서 방문자 ID를 얻는다. 이게 없으면 로그인하라는 답이 온다. */
async function fetchVisitorData() {
  return extractVisitorData(await request.text("https://www.youtube.com/"));
}

function extractVisitorData(html) {
  const match =
    html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) || html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * 내 비공개·멤버 전용 영상을 물어볼 때 쓰는 클라이언트.
 *
 * ANDROID_VR 은 로그인 정보를 아예 받아주지 않아서 "Please sign in" 으로 끝난다.
 * 창작자용 클라이언트는 로그인 상태를 인정하지만, 쿠키만으로는 부족하고
 * 아래 SAPISIDHASH 인증 헤더까지 있어야 한다(유튜브 웹 화면이 쓰는 방식과 같다).
 */
const CREATOR_CLIENT = {
  clientName: "WEB_CREATOR",
  clientVersion: "1.20250219.00.00",
  hl: "ko",
  gl: "KR",
};

/**
 * 로그인하지 않았을 때 60초 벽을 넘게 해주는 클라이언트.
 *
 * 로그아웃 상태에서 `WEB` 계열은 이제 평범한 주소를 주지 않고 SABR 만 준다. 그런데
 * `TVHTML5_SIMPLY` 는 **여전히 포맷마다 직접 주소를 준다**(게스트 브라우저에서 실측:
 * 검색으로 뽑은 일반 영상 12개가 모두 주소를 줬다). 주소가 `c=TVHTML5_SIMPLY` 라
 * 웹 계열로 쳐주므로, 여기에 방문자에 묶은 PO 토큰을 `&pot=` 로 붙이면 벽이 사라진다
 * (토큰 없이 65초 → 403, 붙이면 맨 끝까지 206 — 영상 둘로 갈라 확인했다).
 *
 * **`signatureTimestamp` 가 없으면 `UNPLAYABLE` 로 끝나고 주소를 하나도 주지 않는다.**
 * 그래서 이 클라이언트는 STS 를 구할 수 있을 때만 쓴다.
 *
 * 안 되는 것: 공식 뮤직비디오는 이 클라이언트로도 SABR 만 준다(8개 중 7개).
 * 그때는 아래 `CLIENT` 로 떨어져 앞 60초까지만 받힌다.
 */
const TV_CLIENT = {
  clientName: "TVHTML5_SIMPLY",
  clientVersion: "1.0",
  hl: "en",
  gl: "US",
};

const ORIGIN = "https://www.youtube.com";

/**
 * 포맷 주소를 받아 온다. **로그인해 있으면 내 계정으로 먼저 물어본다.**
 *
 * 왜 로그인 쪽이 먼저인가 — 유튜브가 2026-08-02 에 바꿔서, `ANDROID_VR` 같은 클라이언트는
 * PO 토큰 없이는 **영상 앞부분 약 60초까지만** 내어준다. 그 너머는 받은 양과 상관없이
 * 언제나 403 이고, 클라이언트를 갈아타도(IOS·ANDROID) 경계가 바이트까지 똑같다.
 * 기다려도 열리지 않는다 — 위치 제한이지 몫이 아니다.
 *
 * 반면 `WEB_CREATOR` 로 로그인해 물으면 **파일 끝까지 준다**(0%·50%·99% 전부 206 확인).
 * 영상 넷으로 재봤고, `contentLength`·`initRange`·`indexRange` 가 `ANDROID_VR` 것과
 * 완전히 같아서 색인·조각 경계·이어받기가 그대로 맞는다. 대신 주소에 `n` 이 붙어 있어
 * 풀어야 한다(`nsig.js`. 안 풀면 403).
 *
 * **로그인 여부와 상관없이 `TVHTML5_SIMPLY` 를 먼저 본다.** 무료 계정에서는 `WEB_CREATOR` 가
 * PO 토큰을 붙여도 벽을 못 넘는다(실측). 전에 넘었던 것은 프리미엄 면제 덕이었다.
 * `TVHTML5_SIMPLY` 는 무료·게스트 모두 끝까지 준다. 다만 **토큰을 방문자에 묶어야 한다** —
 * 인증 없이 받은 주소라 계정 토큰을 붙이면 403 그대로다.
 *
 * `WEB_CREATOR` 는 이제 비공개·멤버 전용처럼 계정이 있어야 나오는 것만 맡는다.
 * 둘 다 주소를 못 주면(공식 뮤직비디오) 예전대로 `ANDROID_VR` 이라 앞 60초까지만 받힌다.
 *
 * @param options.sts 페이지의 `STS`. TVHTML5_SIMPLY 를 쓰려면 꼭 있어야 한다.
 */
async function fetchPlayerResponse(videoId, visitorData, client = CLIENT, options = {}) {
  // 부르는 쪽이 클라이언트를 콕 집어 줬으면(갈아타기 중이다) 그대로 따른다.
  if (client === CLIENT) {
    // 로그인 여부와 상관없이 이쪽을 먼저 본다. **인증 없이** 물어야 한다
    // (인증 헤더를 붙이면 HTTP 400 이다 — 실측).
    const sts = await readSts(options.sts);
    if (sts) {
      try {
        const open = await requestPlayer(videoId, visitorData, TV_CLIENT, null, sts);
        // 주소를 실제로 줬을 때만 받아들인다. 뮤직비디오는 status 가 OK 라도
        // SABR 만 주므로, 그때는 아래 길로 떨어지는 편이 낫다.
        if (open?.playabilityStatus?.status === "OK" && hasDirectUrl(open)) return open;
      } catch {
        // 이 길이 막히면 조용히 아래로 간다.
      }
    }

    // 내 비공개·멤버 전용 영상은 계정으로 물어야 나온다. 여기도 STS 가 필요하다 —
    // 없으면 "페이지를 새로고침해야 합니다"(UNPLAYABLE)로 끝난다(실측).
    try {
      const auth = await authHeaders();
      if (auth) {
        const mine = await requestPlayer(videoId, visitorData, CREATOR_CLIENT, auth, sts);
        if (mine?.playabilityStatus?.status === "OK" && hasDirectUrl(mine)) return mine;
      }
    } catch {
      // 로그인 쪽이 안 되면 조용히 아래 길로 간다.
    }
  }

  const first = await requestPlayer(videoId, visitorData, client);
  if (first?.playabilityStatus?.status === "OK") return first;

  // 로그인해야 볼 수 있는 영상이면 내 계정으로 다시 물어본다.
  try {
    const auth = await authHeaders();
    if (!auth) return first;
    const second = await requestPlayer(videoId, visitorData, CREATOR_CLIENT, auth);
    if (second?.playabilityStatus?.status === "OK") return second;
  } catch {
    // 두 번째 시도가 실패해도 첫 번째 결과의 이유를 그대로 보여준다.
  }
  return first;
}

function requestPlayer(videoId, visitorData, client, extraHeaders, sts) {
  return request.json(PLAYER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Visitor-Id": visitorData || "",
      ...extraHeaders,
    },
    body: JSON.stringify(buildPlayerRequest(videoId, visitorData, client, sts)),
  });
}

/**
 * 받을 거리가 있는 답인지.
 *
 * 포맷마다 주소를 줬거나(보통), 주소는 없어도 `serverAbrStreamingUrl` 을 줬으면(뮤직비디오)
 * 받을 수 있다. 후자는 SABR 로 조각을 받는다(`sabr.js`).
 */
function hasDirectUrl(playerResponse) {
  const formats = playerResponse?.streamingData?.adaptiveFormats || [];
  if (formats.some((format) => format.url)) return true;
  return Boolean(
    playerResponse?.streamingData?.serverAbrStreamingUrl &&
      playerResponse?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
        ?.videoPlaybackUstreamerConfig,
  );
}

/**
 * `STS`(signatureTimestamp)를 구한다.
 *
 * 페이지 쪽에만 있는 값이라 부르는 쪽이 다리를 건너 가져다준다. 못 구해도 받기를 막지
 * 않는다 — TVHTML5_SIMPLY 를 건너뛰고 예전 길로 갈 뿐이다.
 */
async function readSts(source) {
  try {
    const value = typeof source === "function" ? await source() : source;
    return Number(value) || null;
  } catch {
    return null;
  }
}

/**
 * 유튜브가 로그인으로 인정하는 인증 헤더.
 *
 * 쿠키만 보내면 로그인으로 쳐주지 않는다. `SAPISID` 쿠키와 지금 시각을 섞어
 * SHA-1 로 해시한 값을 함께 보내야 내 계정으로 물어본 것이 된다.
 * 브라우저 밖(테스트)에서는 쿠키가 없으므로 `null` 을 돌려주고 조용히 넘어간다.
 */
async function authHeaders() {
  const sapisid = readCookie("SAPISID") || readCookie("__Secure-3PAPISID");
  if (!sapisid || typeof crypto === "undefined" || !crypto.subtle) return null;

  const stamp = Math.floor(Date.now() / 1000);
  const digest = await sha1(`${stamp} ${sapisid} ${ORIGIN}`);
  return {
    Authorization: `SAPISIDHASH ${stamp}_${digest}`,
    "X-Origin": ORIGIN,
    "X-Goog-AuthUser": "0",
  };
}

function readCookie(name) {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const found = document.cookie.split("; ").find((pair) => pair.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function sha1(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 쓸 만한 포맷만 골라 정리한다.
 *
 * 지금은 mp4 만 다룬다. mp4 는 sidx 색인이 있어서 구간을 바이트로 옮길 수 있고,
 * 4K 도 AV1 로 mp4 에 담겨 나온다. webm(VP9/Opus)은 색인 방식이 달라 아직 제외한다.
 */
function readFormats(playerResponse) {
  const status = playerResponse?.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = playerResponse.playabilityStatus.reason || status;
    throw new Error(`재생할 수 없는 영상입니다: ${reason}`);
  }

  const all = playerResponse?.streamingData?.adaptiveFormats || [];
  // 두 가지 방식이 있다.
  // - 일반 영상: 파일 하나에 색인(sidx)이 있어 필요한 바이트만 집어온다.
  // - 라이브: 색인이 없고 조각 번호(`&sq=N`)로 하나씩 받는다. 조각 길이는 targetDurationSec.
  // - 뮤직비디오: 주소를 아예 안 주고 `serverAbrStreamingUrl`(SABR) 만 준다.
  //   이때는 주소가 없어도 쓸 만한 포맷으로 친다 — 조각은 SABR 로 받는다(sabr.js).
  const sabrUrl = playerResponse?.streamingData?.serverAbrStreamingUrl || null;
  const sabrConfig =
    playerResponse?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
      ?.videoPlaybackUstreamerConfig || null;
  const viaSabr = Boolean(sabrUrl && sabrConfig && !all.some((format) => format.url));

  const usable = all.filter(
    (format) =>
      (format.url || viaSabr) &&
      isMp4(format) &&
      ((format.indexRange && format.initRange) || format.targetDurationSec > 0),
  );

  const video = usable
    .filter((format) => format.mimeType.startsWith("video/"))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const audio = usable
    .filter((format) => format.mimeType.startsWith("audio/"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return {
    video: video.map(describe),
    audio: audio.map(describe),
    durationSeconds: Number(playerResponse?.videoDetails?.lengthSeconds || 0),
    title: playerResponse?.videoDetails?.title || "",
    isLive: Boolean(playerResponse?.videoDetails?.isLiveContent),
    // 라이브·지난 라이브는 조각(`&sq=N`) 방식이라 mp4 에 색인이 없다.
    // 왜 못 받는지 구분해서 알려주려고 따로 표시해 둔다.
    liveWithoutIndex: all.length > 0 && usable.length === 0 && all.some(isSegmentedLive),
    // 주소가 없어 SABR 로 받아야 할 때 필요한 것들. 주소의 `n` 은 아직 안 풀린 상태다.
    sabr: viaSabr ? { url: sabrUrl, config: sabrConfig } : null,
  };
}

/// 색인 대신 조각 목록으로 오는 포맷인지. 라이브가 여기에 해당한다.
function isSegmentedLive(format) {
  return Boolean(format.url) && !format.indexRange;
}

function isMp4(format) {
  return format.mimeType.includes("mp4");
}

function describe(format) {
  return {
    itag: format.itag,
    url: format.url,
    // SABR 요청에서 포맷을 가리킬 때 itag 와 함께 보내야 하는 값.
    lastModified: format.lastModified || 0,
    mimeType: format.mimeType,
    codec: (format.mimeType.match(/codecs="([^"]+)"/) || [])[1] || "",
    width: format.width,
    height: format.height,
    fps: format.fps,
    bitrate: format.bitrate,
    qualityLabel: format.qualityLabel,
    contentLength: Number(format.contentLength || 0),
    initRange: numericRange(format.initRange),
    indexRange: numericRange(format.indexRange),
    // 라이브 조각 하나의 길이(초). 이 값이 있으면 조각 번호로 받아야 한다.
    segmentSeconds: Number(format.targetDurationSec) || 0,
  };
}

function numericRange(range) {
  return range ? { start: Number(range.start), end: Number(range.end) } : null;
}

/** 화면에 보여줄 짧은 이름. */
function formatLabel(format) {
  if (format.mimeType.startsWith("audio/")) {
    return `${Math.round((format.bitrate || 0) / 1000)}kbps ${shortCodec(format.codec)}`;
  }
  // qualityLabel 은 "2160p60" 처럼 주사율까지 담고 있다. 그게 없을 때만 직접 붙인다.
  const fallback = `${format.height}p${format.fps > 30 ? format.fps : ""}`;
  return `${format.qualityLabel || fallback} ${shortCodec(format.codec)}`;
}

function shortCodec(codec) {
  if (codec.startsWith("avc1")) return "H.264";
  if (codec.startsWith("av01")) return "AV1";
  if (codec.startsWith("vp9") || codec.startsWith("vp09")) return "VP9";
  if (codec.startsWith("mp4a")) return "AAC";
  if (codec.startsWith("opus")) return "Opus";
  return codec;
}

return {CLIENT: CLIENT, FALLBACK_CLIENTS: FALLBACK_CLIENTS, ROTATION: ROTATION, buildPlayerRequest: buildPlayerRequest, fetchVisitorData: fetchVisitorData, extractVisitorData: extractVisitorData, fetchPlayerResponse: fetchPlayerResponse, authHeaders: authHeaders, sha1: sha1, readFormats: readFormats, formatLabel: formatLabel, shortCodec: shortCodec};
});
__define("mp4index.js", (__need) => {
// DASH mp4 의 조각 색인(sidx) 을 읽어 "시간 ↔ 바이트" 표를 만든다.
//
// 유튜브가 주는 mp4 포맷에는 initRange(=ftyp+moov)와 indexRange(=sidx)가 함께 온다.
// sidx 하나가 2KB 남짓이라, 이것만 받아보면 1.3GB 짜리 영상에서도
// 원하는 구간이 어느 바이트에 있는지 바로 알 수 있다.

/** mp4 박스를 훑어 원하는 타입의 시작 위치를 찾는다. */
function findBox(bytes, type, from = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = from;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    const name = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (name === type) return { start: offset, size };
    if (size < 8) break; // 크기가 망가진 박스. 더 읽어도 의미 없다.
    offset += size;
  }
  return null;
}

/**
 * sidx 박스를 해석한다.
 *
 * 결과의 `segments` 는 조각마다 {start, end, time, duration} 을 담는다.
 * start/end 는 파일 전체 기준 바이트 위치(양끝 포함), time/duration 은 초 단위다.
 *
 * @param bytes  indexRange 를 포함해 받은 앞부분 바이트
 * @param indexEnd  indexRange.end (조각 바이트는 그 다음부터 시작한다)
 */
function parseSidx(bytes, indexEnd) {
  const box = findBox(bytes, "sidx");
  if (!box) throw new Error("sidx 박스를 찾지 못했습니다");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = box.start + 8;
  const version = view.getUint8(offset);
  offset += 4; // version(1) + flags(3)
  offset += 4; // reference_ID

  const timescale = view.getUint32(offset);
  offset += 4;

  let earliestPresentationTime;
  let firstOffset;
  if (version === 0) {
    earliestPresentationTime = view.getUint32(offset);
    offset += 4;
    firstOffset = view.getUint32(offset);
    offset += 4;
  } else {
    earliestPresentationTime = Number(view.getBigUint64(offset));
    offset += 8;
    firstOffset = Number(view.getBigUint64(offset));
    offset += 8;
  }

  offset += 2; // reserved
  const count = view.getUint16(offset);
  offset += 2;

  // 첫 조각은 sidx 가 끝난 바로 다음부터 시작한다.
  let bytePos = indexEnd + 1 + firstOffset;
  let timePos = earliestPresentationTime;
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const first = view.getUint32(offset);
    offset += 4;
    const duration = view.getUint32(offset);
    offset += 4;
    offset += 4; // SAP 정보. 유튜브 조각은 모두 키프레임으로 시작한다.

    // 최상위 비트가 1이면 다른 sidx 를 가리킨다(유튜브는 쓰지 않는다).
    const referenceType = first >>> 31;
    const size = first & 0x7fffffff;
    if (referenceType === 1) throw new Error("계층형 sidx 는 지원하지 않습니다");

    segments.push({
      start: bytePos,
      end: bytePos + size - 1,
      time: timePos / timescale,
      duration: duration / timescale,
    });
    bytePos += size;
    timePos += duration;
  }

  return { timescale, segments, totalDuration: timePos / timescale };
}

/**
 * [start, end] 초 구간에 걸치는 조각을 **모두** 고른다.
 *
 * 조각은 통째로 받아야 하므로 받는 양은 요청보다 넓다. 파일에 담기는 길이는 그렇지
 * 않다 — 뒤는 샘플 단위로 잘라내고 앞은 편집 목록으로 가리기 때문이다.
 *
 * 전에는 끝에 아주 조금만 걸치는 조각을 버렸다. 그때는 정확히 자를 수 없어서, 0.1초를
 * 담자고 10초짜리 소리 조각을 끌고 오면 파일이 영상보다 한참 길어졌기 때문이다.
 * 지금은 그 0.1초를 버리면 그냥 0.1초가 모자란 파일이 된다(실측: 요청 15.12초에
 * 15.015초에서 끊긴 파일). 그래서 걸치면 무조건 받는다.
 */
function segmentsForRange(segments, start, end) {
  if (!segments.length) return [];
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  const picked = segments.filter(
    (segment) => segment.time + segment.duration > from && segment.time < to,
  );
  // 요청 구간이 조각 사이에 끼어 아무것도 안 걸리면 가장 가까운 것 하나라도 준다.
  if (!picked.length) {
    const nearest = segments.reduce((best, segment) =>
      Math.abs(segment.time - from) < Math.abs(best.time - from) ? segment : best,
    );
    return [nearest];
  }
  return picked;
}

/** 고른 조각들을 이어붙는 바이트 구간으로 묶는다(요청 수를 줄인다). */
function mergeRanges(segments, maxBytesPerRequest = 8 * 1024 * 1024) {
  const ranges = [];
  for (const segment of segments) {
    const last = ranges[ranges.length - 1];
    const wouldBe = last ? segment.end - last.start + 1 : 0;
    if (last && last.end + 1 === segment.start && wouldBe <= maxBytesPerRequest) {
      last.end = segment.end;
    } else {
      ranges.push({ start: segment.start, end: segment.end });
    }
  }
  return ranges;
}

return {findBox: findBox, parseSidx: parseSidx, segmentsForRange: segmentsForRange, mergeRanges: mergeRanges};
});
__define("mp4mux.js", (__need) => {
// mp4 바이트를 읽는 연장들. 상자를 훑고, 조각(fragment) 안의 샘플 표를 꺼낸다.
//
// 여기는 "읽기"만 한다. 읽어낸 표로 파일을 짓는 일은 mp4file.js 가 맡는다.
//
// mp4 는 온통 상자(box)다. 상자마다 앞 4바이트가 크기, 다음 4바이트가 이름이고,
// 그 안에 또 상자가 들어 있다. 그래서 훑는 함수 하나면 어디든 닿을 수 있다.

const HEADER = 8;

/** 한 겹만 훑어서 박스 목록을 만든다. */
function listBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset + HEADER <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (size < HEADER || offset + size > end) break;
    boxes.push({ type, start: offset, end: offset + size, size });
    offset += size;
  }
  return boxes;
}

/** 경로로 박스를 찾는다. 예: findPath(bytes, ["moov", "trak", "tkhd"]) */
function findPath(bytes, path, start = 0, end = bytes.length) {
  let from = start;
  let to = end;
  let found = null;
  for (const type of path) {
    found = listBoxes(bytes, from, to).find((box) => box.type === type);
    if (!found) return null;
    from = found.start + HEADER;
    to = found.end;
  }
  return found;
}

function boxBytes(bytes, box) {
  return bytes.subarray(box.start, box.end);
}

function u32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function ascii(text) {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

function makeBox(type, ...payloads) {
  const size = HEADER + payloads.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(ascii(type), 4);
  let offset = HEADER;
  for (const part of payloads) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readU64At(bytes, offset) {
  return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset));
}

function readU32At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** 앞머리(init)에 담긴 트랙의 시간 단위. 조각의 tfdt 와 샘플 길이가 이 단위를 쓴다. */
function mediaTimescaleOf(init) {
  const moov = findPath(init, ["moov"]);
  if (!moov) return 0;
  const trak = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  return trak ? readMediaTimescale(init, trak) : 0;
}

function readMediaTimescale(bytes, trakBox) {
  const mdhd = findPath(bytes, ["mdia", "mdhd"], trakBox.start + HEADER, trakBox.end);
  if (!mdhd) throw new Error("mdhd 를 찾지 못했습니다");
  const version = bytes[mdhd.start + HEADER];
  return readU32At(bytes, mdhd.start + HEADER + 4 + (version === 1 ? 16 : 8));
}

/**
 * 조각 안의 샘플을 하나하나 읽어 표로 만든다.
 *
 * `trun` 은 무엇을 담을지 플래그로 정한다. 소리 조각은 "크기만" 담은 단순한 모양이지만
 * 영상 조각은 길이·플래그·화면순서 보정까지 담는다(유튜브 영상은 `0xe01`). 그래서
 * 소리 전용으로 짜여 있던 `readTrunSizes` 로는 영상 조각을 아예 못 건드렸다.
 *
 * 라이브에서 온 조각은 moof+mdat 짝이 여러 개다. 순서대로 이어 읽는다.
 *
 * @returns {{decodeTime: number, samples: Array<{at, size, duration, cto, sync}>}|null}
 *   `at` 은 조각 안에서 그 샘플의 바이트가 시작하는 자리다. 다루지 못하는 모양이면 null.
 */
function readSamples(fragment) {
  const pairs = fragmentPairs(fragment);
  if (!pairs) return null;

  const samples = [];
  let decodeTime = null;

  for (const pair of pairs) {
    const traf = listBoxes(fragment, pair.moof.start + HEADER, pair.moof.end)
      .find((box) => box.type === "traf");
    if (!traf) return null;
    const children = listBoxes(fragment, traf.start + HEADER, traf.end);
    const tfhd = children.find((box) => box.type === "tfhd");
    if (!tfhd) return null;

    const head = readTfhd(fragment, tfhd, pair.moof.start);
    if (decodeTime === null) {
      const tfdt = children.find((box) => box.type === "tfdt");
      decodeTime = tfdt ? readDecodeTime(fragment, tfdt) : 0;
    }

    for (const trun of children.filter((box) => box.type === "trun")) {
      const read = readTrun(fragment, trun, head, pair);
      if (!read) return null;
      samples.push(...read);
    }
  }
  return samples.length ? { decodeTime: decodeTime || 0, samples } : null;
}

/** tfhd 의 기본값들. 여기 없는 값은 샘플마다 trun 이 들고 있다. */
function readTfhd(bytes, tfhd, moofStart) {
  const flags = readU32At(bytes, tfhd.start + HEADER) & 0xffffff;
  let at = tfhd.start + HEADER + 4 + 4; // version/flags + track_ID
  // 샘플 바이트가 어디부터인지의 기준점. 0x020000 은 "moof 시작이 기준"이라는 뜻이고,
  // 유튜브 조각이 그렇다. 기준점이 따로 적혀 있으면 그것을 쓴다.
  let base = moofStart;
  if (flags & 0x000001) {
    base = readU64At(bytes, at);
    at += 8;
  }
  if (flags & 0x000002) at += 4; // sample_description_index
  const duration = flags & 0x000008 ? readU32At(bytes, (at += 4) - 4) : 0;
  const size = flags & 0x000010 ? readU32At(bytes, (at += 4) - 4) : 0;
  const sampleFlags = flags & 0x000020 ? readU32At(bytes, (at += 4) - 4) : null;
  return { base, duration, size, sampleFlags };
}

function readDecodeTime(bytes, tfdt) {
  const at = tfdt.start + HEADER + 4;
  return bytes[tfdt.start + HEADER] === 1 ? readU64At(bytes, at) : readU32At(bytes, at);
}

/** `sample_is_non_sync_sample` 은 sample_flags 의 16번 비트다. 없으면 키프레임으로 본다. */
const isSync = (flags) => (flags === null || flags === undefined ? true : ((flags >>> 16) & 1) === 0);

function readTrun(bytes, trun, head, pair) {
  const word = readU32At(bytes, trun.start + HEADER);
  const version = word >>> 24;
  const flags = word & 0xffffff;
  const count = readU32At(bytes, trun.start + HEADER + 4);
  let at = trun.start + HEADER + 8;

  let cursor = head.base;
  if (flags & 0x000001) {
    cursor += new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at);
    at += 4;
  }
  let firstFlags = null;
  if (flags & 0x000004) {
    firstFlags = readU32At(bytes, at);
    at += 4;
  }

  const out = [];
  for (let i = 0; i < count; i += 1) {
    const duration = flags & 0x000100 ? readU32At(bytes, (at += 4) - 4) : head.duration;
    const size = flags & 0x000200 ? readU32At(bytes, (at += 4) - 4) : head.size;
    const own = flags & 0x000400 ? readU32At(bytes, (at += 4) - 4) : head.sampleFlags;
    // 화면 순서 보정. version 1 은 음수를 허용한다(B프레임이 앞뒤로 오갈 때 쓴다).
    let cto = 0;
    if (flags & 0x000800) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      cto = version === 0 ? view.getUint32(at) : view.getInt32(at);
      at += 4;
    }
    if (!size) return null; // 크기를 모르면 샘플을 떼어낼 수 없다
    out.push({
      at: cursor,
      size,
      duration,
      cto,
      sync: isSync(i === 0 && firstFlags !== null ? firstFlags : own),
    });
    cursor += size;
  }
  // 샘플 바이트가 mdat 밖을 가리키면 우리가 잘못 읽은 것이다. 조용히 틀리느니 포기한다.
  const last = out[out.length - 1];
  if (out[0] && (out[0].at < pair.mdat.start || last.at + last.size > pair.mdat.end)) return null;
  return out;
}

/** 조각 속의 moof+mdat 짝들. 하나짜리(일반 영상)도, 여러 개짜리(라이브 출신)도 있다. */
function fragmentPairs(bytes) {
  const boxes = listBoxes(bytes);
  const pairs = [];
  for (let i = 0; i < boxes.length; i += 1) {
    if (boxes[i].type !== "moof") continue;
    const next = boxes[i + 1];
    if (!next || next.type !== "mdat") return null; // 예상 밖 구조 — 손대지 않는다
    pairs.push({ moof: boxes[i], mdat: next });
  }
  return pairs.length ? pairs : null;
}

/**
 * 라이브 조각을 앞머리(ftyp+moov)와 본체(moof+mdat)로 가른다.
 *
 * 라이브는 조각마다 앞머리를 다시 붙여서 준다(중간부터 봐도 재생되도록).
 * 파일로 묶을 때는 앞머리가 하나만 있어야 하므로 첫 조각의 것만 쓰고 나머지는 버린다.
 */
function splitLiveSegment(bytes) {
  const boxes = listBoxes(bytes);
  const firstMoof = boxes.find((box) => box.type === "moof");
  if (!firstMoof) return { init: null, media: bytes };

  const headParts = boxes
    .filter((box) => box.start < firstMoof.start && (box.type === "ftyp" || box.type === "moov"))
    .map((box) => boxBytes(bytes, box));

  return {
    init: headParts.length ? concat(headParts) : null,
    media: bytes.subarray(firstMoof.start),
  };
}

return {listBoxes: listBoxes, findPath: findPath, boxBytes: boxBytes, makeBox: makeBox, concat: concat, mediaTimescaleOf: mediaTimescaleOf, readMediaTimescale: readMediaTimescale, readSamples: readSamples, splitLiveSegment: splitLiveSegment};
});
__define("mp4file.js", (__need) => {
// 받아온 조각들을 "일반 mp4"(샘플 표가 있는 보통 파일) 하나로 짓는다.
//
// 왜 조각 그대로가 아니라 일반 mp4 인가:
//
// 영상은 키프레임에서만 시작할 수 있어서, 고른 지점보다 앞선 조각 경계에서 파일이
// 시작한다. 그 앞부분을 잘라내면 남은 프레임들이 참조할 그림이 사라져 화면이 안 나온다
// (실측: 13.000초부터 자르면 15.650초까지 160프레임이 아예 안 그려졌다).
//
// mp4 에는 이걸 위한 장치가 있다 — 편집 목록(elst). "파일은 여기서 시작하지만 보여줄
// 곳은 여기부터 이만큼"이라고 적어두면, 앞부분은 디코딩에만 쓰이고 화면에는 안 나온다.
// 바이트를 한 비트도 건드리지 않고 정확한 구간이 된다.
//
// 그런데 편집 목록은 **조각화 mp4(fMP4)에서는 거의 지원되지 않는다**. ffmpeg 도 크롬도
// 무시한다(실측). 일반 mp4 에서는 제대로 동작한다 — QuickTime 시절부터 쓰던 길이다.
// 그래서 조각을 그대로 이어 붙이는 대신, 샘플 표(stbl)를 만들어 일반 mp4 로 담는다.
// 샘플 바이트는 원본 그대로 옮겨 담을 뿐이라 다시 인코딩하는 곳은 한 군데도 없다.

const { boxBytes, concat, findPath, listBoxes, makeBox } = __need("mp4mux.js");
const HEADER = 8;

const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** 표 하나를 만든다: version/flags(0) + 항목 수 + 항목들. mp4 의 표는 죄다 이 모양이다. */
function table(type, entries, width, fill) {
  const body = new Uint8Array(8 + entries.length * width);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0);
  dv.setUint32(4, entries.length);
  entries.forEach((entry, i) => fill(dv, 8 + i * width, entry));
  return makeBox(type, body);
}

/** 같은 값이 이어지면 하나로 묶는다. stts·ctts·stsc 가 모두 이 방식이다. */
function runLength(values) {
  const out = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last.value === value) last.count += 1;
    else out.push({ count: 1, value });
  }
  return out;
}

/**
 * 샘플들을 담을 표들을 만든다.
 *
 * @param samples [{size, duration, cto, sync}] — 트랙 전체, 디코딩 순서
 * @param chunks  덩어리별 샘플 수. 덩어리 하나가 stco 의 자리 하나다.
 */
function sampleTableBoxes(samples, chunks, largeOffsets) {
  const boxes = [];

  // stts — 샘플 길이. 대개 전부 같아서 항목 하나로 줄어든다.
  boxes.push(
    table("stts", runLength(samples.map((s) => s.duration)), 8, (dv, at, e) => {
      dv.setUint32(at, e.count);
      dv.setUint32(at + 4, e.value);
    }),
  );

  // ctts — 화면 순서 보정. B프레임이 없으면(AV1 등) 전부 0이라 아예 넣지 않는다.
  if (samples.some((s) => s.cto !== 0)) {
    const negative = samples.some((s) => s.cto < 0);
    const runs = runLength(samples.map((s) => s.cto));
    const body = new Uint8Array(8 + runs.length * 8);
    const dv = new DataView(body.buffer);
    dv.setUint8(0, negative ? 1 : 0); // 음수 보정은 version 1 에서만 쓸 수 있다
    dv.setUint32(4, runs.length);
    runs.forEach((run, i) => {
      dv.setUint32(8 + i * 8, run.count);
      if (negative) dv.setInt32(12 + i * 8, run.value);
      else dv.setUint32(12 + i * 8, run.value);
    });
    boxes.push(makeBox("ctts", body));
  }

  // stss — 키프레임 자리(1부터 센다). 소리처럼 전부 키프레임이면 넣지 않는다
  // (없는 것이 곧 "전부 키프레임"이라는 뜻이다).
  const syncs = [];
  samples.forEach((s, i) => {
    if (s.sync) syncs.push(i + 1);
  });
  if (syncs.length !== samples.length) {
    boxes.push(table("stss", syncs, 4, (dv, at, n) => dv.setUint32(at, n)));
  }

  // stsc — 덩어리마다 샘플이 몇 개인지.
  const perChunk = runLength(chunks);
  let chunkNo = 1;
  const stsc = perChunk.map((run) => {
    const entry = { first: chunkNo, count: run.value };
    chunkNo += run.count;
    return entry;
  });
  boxes.push(
    table("stsc", stsc, 12, (dv, at, e) => {
      dv.setUint32(at, e.first);
      dv.setUint32(at + 4, e.count);
      dv.setUint32(at + 8, 1); // sample_description_index
    }),
  );

  // stsz — 샘플 크기. 전부 같으면 값 하나로 끝난다.
  const uniform = samples.every((s) => s.size === samples[0].size);
  const stszBody = new Uint8Array(12 + (uniform ? 0 : samples.length * 4));
  const sdv = new DataView(stszBody.buffer);
  sdv.setUint32(0, 0);
  sdv.setUint32(4, uniform ? samples[0].size : 0);
  sdv.setUint32(8, samples.length);
  if (!uniform) samples.forEach((s, i) => sdv.setUint32(12 + i * 4, s.size));
  boxes.push(makeBox("stsz", stszBody));

  // stco/co64 — 덩어리가 파일 어디에 있는지. 자리는 비워 두고 나중에 채운다
  // (머리 크기를 알아야 mdat 이 어디서 시작하는지 알 수 있다).
  const width = largeOffsets ? 8 : 4;
  const body = new Uint8Array(8 + chunks.length * width);
  new DataView(body.buffer).setUint32(4, chunks.length);
  boxes.push(makeBox(largeOffsets ? "co64" : "stco", body));

  return boxes;
}

/**
 * 앞머리가 이미 적어둔 "내용은 여기서 시작한다" 값(미디어 시간 단위).
 *
 * 코덱은 앞머리에 버릴 것을 얹어 보낸다 — AAC 는 인코더가 워밍업으로 만든 샘플
 * 1024개(48kHz 에서 21.33ms), H.264 는 B프레임 재정렬 때문에 생기는 어긋남이다.
 * 이 값을 무시하면 그만큼 소리가 늦게 나온다(실측 21.33ms).
 *
 * 빈 구간을 뜻하는 음수는 0으로 본다.
 */
function editStartOf(init) {
  const moov = findPath(init, ["moov"]);
  if (!moov) return 0;
  const trak = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  if (!trak) return 0;
  const edts = listBoxes(init, trak.start + HEADER, trak.end).find((b) => b.type === "edts");
  if (!edts) return 0;
  const elst = listBoxes(init, edts.start + HEADER, edts.end).find((b) => b.type === "elst");
  if (!elst || !view(init).getUint32(elst.start + HEADER + 4)) return 0;
  const wide = init[elst.start + HEADER] === 1;
  const at = elst.start + HEADER + 8;
  const mediaTime = wide
    ? Number(view(init).getBigInt64(at + 8))
    : view(init).getInt32(at + 4);
  return mediaTime > 0 ? mediaTime : 0;
}

/** 박스 하나를 자식들만 바꿔 다시 만든다. 크기는 다시 잰다. */
function rebuild(bytes, box, mapChild) {
  const head = bytes.subarray(box.start, box.start + HEADER);
  const children = listBoxes(bytes, box.start + HEADER, box.end).map(mapChild).filter(Boolean);
  const out = concat([head, ...children]);
  view(out).setUint32(0, out.length);
  return out;
}

/** mvhd·mdhd 는 구조가 같다: version/flags, 시각 둘, timescale, duration. */
function setScaleDuration(bytes, box, seconds) {
  const version = bytes[box.start + HEADER];
  const base = box.start + HEADER + 4 + (version === 1 ? 16 : 8);
  const timescale = view(bytes).getUint32(base);
  const value = Math.round(seconds * timescale);
  if (version === 1) view(bytes).setBigUint64(base + 4, BigInt(value));
  else view(bytes).setUint32(base + 4, value);
}

/** tkhd: version/flags, 시각 둘, track_ID, 예약(4), duration. 길이는 영화 시간 단위다. */
function setTrackHeader(bytes, tkhd, trackId, seconds, movieTimescale) {
  const version = bytes[tkhd.start + HEADER];
  const idAt = tkhd.start + HEADER + 4 + (version === 1 ? 16 : 8);
  view(bytes).setUint32(idAt, trackId);
  const durAt = idAt + 4 + 4;
  const value = Math.round(seconds * movieTimescale);
  if (version === 1) view(bytes).setBigUint64(durAt, BigInt(value));
  else view(bytes).setUint32(durAt, value);
}

/**
 * 편집 목록. "미디어 시간축의 여기부터 이만큼을 보여줘라".
 *
 * @param mediaTime  트랙의 미디어 시간 단위. 앞머리에서 얼마나 건너뛸지.
 * @param seconds    보여줄 길이(초).
 */
function editList(mediaTime, seconds, movieTimescale) {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0); // version 0 + flags
  dv.setUint32(4, 1); // 항목 하나
  dv.setUint32(8, Math.max(0, Math.round(seconds * movieTimescale)));
  dv.setInt32(12, Math.max(0, Math.round(mediaTime)));
  dv.setUint16(16, 1); // 1배속
  dv.setUint16(18, 0);
  return makeBox("edts", makeBox("elst", body));
}

/**
 * 트랙 하나의 `trak` 을 짓는다. 원본 앞머리의 trak 을 본으로 삼아,
 * 표가 비어 있던 `stbl` 만 진짜 표로 갈아 끼우고 편집 목록을 붙인다.
 *
 * `stsd`(코덱 설명)는 원본 것을 그대로 옮긴다 — 그래야 avc1 이든 av01 이든
 * 코덱을 가리지 않는다. 우리가 손대는 것은 "어느 바이트가 몇 번째 샘플인가" 뿐이다.
 */
function buildTrak(track, movieTimescale) {
  const { init, trackId, samples, chunks, editMediaTime, presentSeconds, largeOffsets } = track;
  const moov = findPath(init, ["moov"]);
  const source = findPath(init, ["trak"], moov.start + HEADER, moov.end);
  if (!source) throw new Error("앞머리에서 trak 을 찾지 못했습니다");

  const mediaSeconds = samples.reduce((sum, s) => sum + s.duration, 0) / track.timescale;
  const tables = sampleTableBoxes(samples, chunks, largeOffsets);

  const bytes = rebuild(init, source, (child) => {
    if (child.type === "edts") return null; // 우리가 새로 붙인다
    if (child.type !== "mdia") return boxBytes(init, child);
    return rebuild(init, child, (inner) => {
      if (inner.type !== "minf") return boxBytes(init, inner);
      return rebuild(init, inner, (leaf) => {
        if (leaf.type !== "stbl") return boxBytes(init, leaf);
        // stsd 만 남기고 나머지 표는 우리가 만든 것으로 바꾼다.
        const stsd = listBoxes(init, leaf.start + HEADER, leaf.end).find((b) => b.type === "stsd");
        if (!stsd) throw new Error("stsd 를 찾지 못했습니다");
        const out = concat([
          init.subarray(leaf.start, leaf.start + HEADER),
          boxBytes(init, stsd),
          ...tables,
        ]);
        view(out).setUint32(0, out.length);
        return out;
      });
    });
  });

  // tkhd/mdhd 의 길이와 번호를 실제 내용에 맞춘다. 그 다음 편집 목록을 tkhd 뒤에 끼운다.
  const tkhd = findPath(bytes, ["tkhd"], HEADER, bytes.length);
  if (tkhd) setTrackHeader(bytes, tkhd, trackId, mediaSeconds, movieTimescale);
  const mdhd = findPath(bytes, ["mdia", "mdhd"], HEADER, bytes.length);
  if (mdhd) setScaleDuration(bytes, mdhd, mediaSeconds);

  const edts = editList(editMediaTime, presentSeconds, movieTimescale);
  const head = bytes.subarray(0, tkhd ? tkhd.end : HEADER);
  const rest = bytes.subarray(tkhd ? tkhd.end : HEADER);
  const out = concat([head, edts, rest]);
  view(out).setUint32(0, out.length);
  return out;
}

/**
 * 파일의 머리(ftyp + moov)를 짓는다. 이 뒤에 mdat 이 이어진다.
 *
 * @param tracks 트랙마다:
 *   init            원본 앞머리(ftyp+moov)
 *   timescale       미디어 시간 단위
 *   samples         디코딩 순서의 전체 샘플 [{size, duration, cto, sync}]
 *   chunks          덩어리별 샘플 수(stco 자리 수와 같다)
 *   editMediaTime   앞머리에서 건너뛸 만큼(미디어 시간 단위)
 * @param presentSeconds 실제로 보여줄 길이(초) — 편집 목록에 적힌다.
 */
function buildHead({ tracks, presentSeconds, largeOffsets = false }) {
  const first = tracks[0];
  const ftyp = findPath(first.init, ["ftyp"]);
  const moov = findPath(first.init, ["moov"]);
  if (!ftyp || !moov) throw new Error("ftyp/moov 를 찾지 못했습니다");
  const mvhd = findPath(first.init, ["mvhd"], moov.start + HEADER, moov.end);
  if (!mvhd) throw new Error("mvhd 를 찾지 못했습니다");
  const movieTimescale = view(first.init).getUint32(
    mvhd.start + HEADER + 4 + (first.init[mvhd.start + HEADER] === 1 ? 16 : 8),
  );

  const mvhdBytes = boxBytes(first.init, mvhd).slice();
  setScaleDuration(mvhdBytes, { start: 0, end: mvhdBytes.length }, presentSeconds);
  // next_track_ID 는 mvhd 의 맨 끝 4바이트다. 우리가 쓴 번호보다 커야 한다.
  view(mvhdBytes).setUint32(mvhdBytes.length - 4, tracks.length + 1);

  const traks = tracks.map((track, index) =>
    buildTrak({ ...track, trackId: index + 1, largeOffsets }, movieTimescale),
  );
  const moovBytes = makeBox("moov", mvhdBytes, ...traks);
  return { head: concat([boxBytes(first.init, ftyp), moovBytes]), movieTimescale };
}

/**
 * 덩어리들이 파일 어디에 앉는지를 표에 적어 넣는다.
 *
 * 머리를 다 짓고 나서야 mdat 이 어디서 시작하는지 알 수 있어서, 표에는 자리만 비워
 * 두었다가 여기서 채운다. 항목 폭이 고정이라 채워 넣어도 머리 크기는 그대로다.
 *
 * @param offsets 트랙 순서대로, 그 트랙의 덩어리 위치 목록
 */
function fillChunkOffsets(head, offsets) {
  const found = [];
  const walk = (from, to) => {
    for (const box of listBoxes(head, from, to)) {
      if (box.type === "stco" || box.type === "co64") found.push(box);
      else if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type)) {
        walk(box.start + HEADER, box.end);
      }
    }
  };
  walk(0, head.length);
  if (found.length !== offsets.length) {
    throw new Error(`덩어리 표 수가 맞지 않습니다 (${found.length} ≠ ${offsets.length})`);
  }
  found.forEach((box, index) => {
    const wide = box.type === "co64";
    const list = offsets[index];
    const dv = view(head);
    list.forEach((value, i) => {
      const at = box.start + HEADER + 8 + i * (wide ? 8 : 4);
      if (wide) dv.setBigUint64(at, BigInt(value));
      else dv.setUint32(at, value);
    });
  });
  return head;
}

/** mdat 상자의 머리. 4GB 를 넘으면 64비트 크기 형식을 쓴다. */
function mdatHeader(size) {
  if (size + HEADER <= 0xfffffffe) {
    return concat([u32(size + HEADER), new Uint8Array([0x6d, 0x64, 0x61, 0x74])]);
  }
  const out = new Uint8Array(16);
  view(out).setUint32(0, 1); // 크기 1 = "진짜 크기는 뒤에 64비트로"
  out.set([0x6d, 0x64, 0x61, 0x74], 4);
  view(out).setBigUint64(8, BigInt(size + 16));
  return out;
}

return {sampleTableBoxes: sampleTableBoxes, editStartOf: editStartOf, buildHead: buildHead, fillChunkOffsets: fillChunkOffsets, mdatHeader: mdatHeader};
});
__define("store.js", (__need) => {
// 받은 조각을 디스크(OPFS)에 쌓아 두는 곳.
//
// 왜: 전에는 조각 전부와 완성본까지 메모리에 들고 있었다. 4K 로 긴 구간을 받으면
// GB 단위로 부풀고, 탭이 닫히면 받은 것이 전부 사라졌다. OPFS(youtube.com 오리진의
// 전용 디스크 저장소)에 조각을 흘려 쓰면 메모리에는 한 번에 조각 하나 크기만 남고,
// 탭이 죽어도 조각이 살아 있어 같은 구간을 다시 받으면 없는 것만 마저 받는다(이어받기).
//
// 이름 규칙이 곧 색인이다. 일반 영상은 `s<시작바이트>-<끝바이트>`(sidx 가 정한 조각
// 경계라 세션이 바뀌어도 같다), 라이브는 `q<조각번호>`. 목록 파일을 따로 두지 않으므로
// 목록과 실제 파일이 어긋날 일이 없다. 쓰다 만 파일도 없다 — OPFS 의 createWritable 은
// close() 때에야 원자적으로 자리를 잡는다. 파일이 보이면 완성된 것이다.
//
// 얼마나 쌓이나: 받는 동안 조각(구간 크기만큼) + 조립된 완성본(구간 크기만큼)이 잠깐
// 함께 있다. 조각은 저장이 끝나면 곧바로 지우고, 완성본과 남은 찌꺼기는 이틀 지나면
// 지운다(cleanup). 상한은 우리가 정하지 않는다 — 브라우저의 오리진 할당량이 이미 있고,
// 여유가 모자라 보이면 시작 전에 알려줄 수 있도록 remaining() 만 제공한다.

const ROOT = "ytdl-media";
const STAMP = "stamp";
// 완성본은 **구간마다 따로** 둔다. 한 칸만 두면 다음 구간을 받을 때 앞 구간이 지워져,
// 여러 구간을 받아 놓고도 마지막 것 하나만 다시 꺼낼 수 있었다.
const OUTPUT = (key) => `out-${key || "last"}.mp4`;
// 저장할 때 쓴 파일 이름. 완성본 옆에 적어 둬야 나중에 그대로 다시 내줄 수 있다.
const OUTNAME = (key) => `out-${key || "last"}.name`;
const OLD_OUTPUT = "out.mp4"; // 예전 판이 남긴 것. 읽기만 한다.

/** OPFS 를 쓸 수 있는 곳인가. 아니면 메모리 저장소로 대신한다(이어받기만 없어진다). */
async function diskAvailable() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/** 브라우저가 알려주는 남은 저장 공간(바이트). 모르면 Infinity(막지 않는다). */
async function remaining() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!Number.isFinite(usage) || !Number.isFinite(quota)) return Infinity;
    return Math.max(0, quota - usage);
  } catch {
    return Infinity;
  }
}

async function dir(parent, name, create) {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
}

async function readFileIn(parent, name) {
  const handle = await parent.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFileIn(parent, name, bytes) {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close(); // 여기서야 파일이 자리를 잡는다(원자적)
}

/**
 * 한 영상의 저장소. 트랙(itag)별 조각 통과 완성본 자리를 준다.
 *
 * 열 때 시각 도장을 찍어 둔다 — cleanup 이 "요즘 쓴 것"을 알아보는 근거다.
 */
async function openDisk(videoId) {
  const opfs = await navigator.storage.getDirectory();
  const root = await dir(opfs, ROOT, true);
  const home = await dir(root, videoId, true);
  await writeFileIn(home, STAMP, new TextEncoder().encode(String(Date.now())));

  return {
    kind: "disk",

    /** 트랙 하나의 조각 통. 이름 → 바이트. */
    async track(itag) {
      const box = await dir(home, String(itag), true);
      // 있는 조각 이름을 한 번에 읽어 둔다. 조각이 수백 개라도 목록은 값싸다.
      const names = new Set();
      for await (const name of box.keys()) names.add(name);
      return {
        has: (name) => names.has(name),
        read: (name) => readFileIn(box, name),
        // 조각 크기만 알아본다(내용은 안 읽는다). 이어받은 조각을 용량 어림에 넣는 데 쓴다.
        async size(name) {
          try {
            return (await (await box.getFileHandle(name)).getFile()).size;
          } catch {
            return 0;
          }
        },
        async write(name, bytes) {
          await writeFileIn(box, name, bytes);
          names.add(name);
        },
      };
    },

    /**
     * 완성본을 흘려 쓸 자리. close() 가 디스크 기반 File 을 돌려준다(메모리에 안 올라온다).
     * `key` 는 구간을 가리킨다 — 구간마다 파일이 따로 남는다.
     */
    async output(key) {
      const handle = await home.getFileHandle(OUTPUT(key), { create: true });
      const writable = await handle.createWritable(); // 기존 내용은 지워진다
      return {
        write: (bytes) => writable.write(bytes),
        async close() {
          await writable.close();
          return handle.getFile();
        },
        abort: () => writable.abort().catch(() => {}),
      };
    },

    /** 저장할 때 쓴 이름을 적어 둔다. 나중에 "저장"을 다시 눌러도 같은 이름으로 나간다. */
    async rememberName(key, text) {
      await writeFileIn(home, OUTNAME(key), new TextEncoder().encode(String(text)));
    },

    /** 저장까지 끝났으면 조각은 더 필요 없다. 완성본(out.mp4)은 브라우저가 아직
     *  내려받기로 옮기는 중일 수 있어 여기서 지우지 않는다 — cleanup 몫이다. */
    async clearChunks() {
      for await (const [name, handle] of home.entries()) {
        if (handle.kind === "directory") {
          await home.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }
    },
  };
}

/** 이어받을 것이 남아 있는지(조각이 하나라도 있는지). 알림 문구를 고르는 데만 쓴다. */
async function hasLeftovers(videoId) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    const home = root && (await dir(root, videoId, false));
    if (!home) return false;
    for await (const [, handle] of home.entries()) {
      if (handle.kind === "directory") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 조각이 남아 있는 영상을 전부 훑는다. 왼쪽 "남은 조각" 목록이 쓴다.
 *
 * 크기까지 재는 이유 — 몇 MB 가 눌러앉아 있는지 보이지 않으면 지울 마음이 안 생긴다.
 * 파일 수가 많을 수 있어 크기는 조각 파일만 더한다(완성본은 세지 않는다).
 */
async function listLeftovers() {
  const out = [];
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    if (!root) return out;
    for await (const [videoId, home] of root.entries()) {
      if (home.kind !== "directory") continue;
      let bytes = 0;
      let chunks = 0;
      let stamped = 0;
      try {
        const raw = await readFileIn(home, STAMP);
        stamped = Number(new TextDecoder().decode(raw)) || 0;
      } catch {
        // 도장이 없으면 0 으로 둔다
      }
      // 조립까지 끝난 파일들. 저장을 취소했어도 여기 그대로 있다 — 구간마다 하나씩이다.
      const outputs = [];
      for await (const [name, box] of home.entries()) {
        if (box.kind === "file") {
          const 완성본 = name === OLD_OUTPUT || (name.startsWith("out-") && name.endsWith(".mp4"));
          if (!완성본) continue;
          const key = name === OLD_OUTPUT ? "" : name.slice(4, -4);
          let label = "";
          try {
            label = new TextDecoder().decode(await readFileIn(home, OUTNAME(key)));
          } catch {
            // 이름을 안 적어둔 옛 것이면 부르는 쪽이 알아서 짓는다
          }
          try {
            outputs.push({ key, name: label, bytes: (await box.getFile()).size });
          } catch {
            // 읽을 수 없으면 없는 것으로 친다
          }
          continue;
        }
        if (box.kind !== "directory") continue;
        for await (const [, file] of box.entries()) {
          if (file.kind !== "file") continue;
          try {
            bytes += (await file.getFile()).size;
            chunks += 1;
          } catch {
            // 읽다 만 파일은 건너뛴다
          }
        }
      }
      if (chunks || outputs.length) out.push({ videoId, bytes, chunks, outputs, usedAt: stamped });
    }
  } catch {
    // 디스크가 없는 곳이면 빈 목록이다
  }
  return out.sort((a, b) => b.usedAt - a.usedAt);
}

/**
 * 조립까지 끝난 파일을 그대로 꺼낸다.
 *
 * 저장 대화상자에서 취소했더라도 완성본은 여기 남아 있다. 다시 받을 것도, 다시 합칠
 * 것도 없이 이걸 그대로 내주면 된다.
 */
async function readOutput(videoId, key) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    const home = root && (await dir(root, videoId, false));
    if (!home) return null;
    const name = key === "" ? OLD_OUTPUT : OUTPUT(key);
    return await (await home.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** 완성본 하나만 지운다(그 구간 것만). 조각은 그대로 둔다. */
async function discardOutput(videoId, key) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    const home = root && (await dir(root, videoId, false));
    if (!home) return;
    await home.removeEntry(key === "" ? OLD_OUTPUT : OUTPUT(key)).catch(() => {});
    await home.removeEntry(OUTNAME(key)).catch(() => {});
  } catch {
    // 지울 것이 없으면 그대로 둔다
  }
}

/** 이 영상의 저장소를 통째로 지운다(받다 만 조각 버리기). */
async function discard(videoId) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    await root?.removeEntry(videoId, { recursive: true });
  } catch {
    // 지울 것이 없거나 디스크가 없는 곳이면 그대로 둔다
  }
}

/** 오래 안 쓴 영상 폴더를 지운다. 그만둔 이어받기와 완성본 찌꺼기가 디스크에 눌러앉지 않게. */
async function cleanup(maxAgeMs = 2 * 24 * 3600 * 1000) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    if (!root) return;
    const now = Date.now();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "directory") continue;
      let stamped = 0;
      try {
        const bytes = await readFileIn(handle, STAMP);
        stamped = Number(new TextDecoder().decode(bytes)) || 0;
      } catch {
        // 도장이 없으면 옛 것으로 본다
      }
      if (now - stamped >= maxAgeMs) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  } catch {
    // 청소는 못 해도 받는 일은 계속돼야 한다
  }
}

/**
 * OPFS 가 없을 때의 대체 저장소. 모양은 같고 자리만 메모리다.
 * 이어받기는 안 되지만(탭이 죽으면 함께 사라진다) 받는 일 자체는 그대로 된다.
 * 시험(deno)에서도 이것을 쓴다.
 */
function openMemory() {
  const tracks = new Map();
  return {
    kind: "memory",
    // 메모리에는 남길 자리가 없다. 모양만 맞춰 둔다.
    async rememberName() {},
    async track(itag) {
      if (!tracks.has(itag)) tracks.set(itag, new Map());
      const box = tracks.get(itag);
      return {
        has: (name) => box.has(name),
        read: async (name) => box.get(name),
        size: async (name) => box.get(name)?.length || 0,
        write: async (name, bytes) => {
          box.set(name, bytes);
        },
      };
    },
    async output() {
      const parts = [];
      return {
        write: async (bytes) => {
          parts.push(bytes);
        },
        close: async () => new Blob(parts, { type: "video/mp4" }),
        abort: () => {},
      };
    },
    async clearChunks() {
      tracks.clear();
    },
  };
}

/** 쓸 수 있는 가장 좋은 저장소를 연다. */
async function openBest(videoId) {
  if (await diskAvailable()) {
    try {
      return await openDisk(videoId);
    } catch {
      // 디스크가 갑자기 안 열려도 받는 일은 계속돼야 한다
    }
  }
  return openMemory();
}

return {diskAvailable: diskAvailable, remaining: remaining, openDisk: openDisk, hasLeftovers: hasLeftovers, listLeftovers: listLeftovers, readOutput: readOutput, discardOutput: discardOutput, discard: discard, cleanup: cleanup, openMemory: openMemory, openBest: openBest};
});
__define("sabr.js", (__need) => {
// SABR — 주소 대신 "요청을 보내면 조각을 내어주는" 길.
//
// 공식 뮤직비디오는 웹 계열 클라이언트가 포맷마다 주소를 주지 않고
// `serverAbrStreamingUrl` 하나만 준다. 그 주소에 protobuf 요청을 POST 하면
// UMP 라는 형식으로 조각이 돌아온다. 이 파일이 그 요청을 만들고 답을 푼다.
//
// 왜 이게 필요한가 — 주소를 주는 `ANDROID_VR`·`IOS` 로는 앞 60초까지밖에 못 받는다
// (안드로이드·iOS 토큰을 브라우저에서 만들 수 없어서다). SABR 은 그 벽이 없다.
// 실측: 213초 뮤직비디오에서 90·150·200초 조각을 모두 받았다.

const { parseSidx, segmentsForRange } = __need("mp4index.js");
const { request } = __need("net.js");
/* ── protobuf 쓰기 ─────────────────────────────────────────────── */

function varint(value) {
  const out = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

const tag = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
/** 숫자 필드 */
const num = (field, value) => [...tag(field, 0), ...varint(value)];
/** 길이가 붙는 필드(바이트·문자열·중첩) */
const buf = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const utf8 = (text) => [...new TextEncoder().encode(text)];

/* ── protobuf 읽기 (필요한 필드만 훑는다) ──────────────────────── */

/**
 * 최상위 필드를 훑어 `{필드번호: 값}` 으로 만든다.
 * 숫자는 Number, 길이 필드는 Uint8Array 로 준다. 같은 번호가 여럿이면 마지막 것을 쓴다
 * (우리가 읽는 곳은 전부 하나씩만 온다).
 */
function readFields(bytes) {
  const out = {};
  let p = 0;
  const readVarint = () => {
    let x = 0n;
    let shift = 0n;
    while (p < bytes.length) {
      const b = bytes[p++];
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return x;
  };
  while (p < bytes.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (!field) break;
    if (wire === 0) out[field] = Number(readVarint());
    else if (wire === 2) {
      const len = Number(readVarint());
      out[field] = bytes.subarray(p, p + len);
      p += len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else break;
  }
  return out;
}

/* ── UMP 읽기 ──────────────────────────────────────────────────── */

/**
 * UMP 의 길이 앞머리는 **유튜브 고유 varint** 다. 첫 바이트로 몇 바이트짜리인지 가른다.
 * 흔한 little-endian varint 로 읽으면 엉뚱한 데서 어긋난다.
 */
function umpVarint(data, at) {
  const first = data[at];
  const size = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
  let value;
  if (size === 1) value = first;
  else if (size === 2) value = (first & 0x3f) | (data[at + 1] << 6);
  else if (size === 3) value = (first & 0x1f) | (data[at + 1] << 5) | (data[at + 2] << 13);
  else if (size === 4)
    value = (first & 0x0f) | (data[at + 1] << 4) | (data[at + 2] << 12) | (data[at + 3] << 20);
  else value = data[at + 1] | (data[at + 2] << 8) | (data[at + 3] << 16) | (data[at + 4] << 24);
  return { value: value >>> 0, size };
}

/** 답을 부위별로 가른다. `{type, at, size}` 목록. */
function readUmp(data) {
  const parts = [];
  let p = 0;
  while (p < data.length) {
    const type = umpVarint(data, p);
    p += type.size;
    if (p >= data.length) break;
    const size = umpVarint(data, p);
    p += size.size;
    if (size.value > data.length - p) break; // 잘려 왔다
    parts.push({ type: type.value, at: p, size: size.value });
    p += size.value;
  }
  return parts;
}

/** UMP 부위 번호. 이름을 붙여두지 않으면 나중에 무슨 뜻인지 알 수 없다. */
const PART = {
  MEDIA_HEADER: 20,
  MEDIA: 21,
  MEDIA_END: 22,
  STATUS: 35,
  CONTEXT_UPDATE: 57,
};

/* ── 요청 만들기 ───────────────────────────────────────────────── */

const formatId = (format) => [...num(1, format.itag), ...num(2, format.lastModified || 0)];

const clientInfo = (clientVersion) => [
  ...buf(1, utf8("en_US")),
  ...num(16, 1), // WEB
  ...buf(17, utf8(clientVersion)),
  ...buf(18, utf8("Windows")),
  ...buf(19, utf8("10.0")),
];

/**
 * 재생기 상태. 서버는 이걸 보고 "지금 어디를 보고 있으니 이 조각들을 주자"고 정한다.
 * **f28(재생 위치 ms)이 핵심**이고 나머지는 그럴듯하면 된다(실측으로 확인).
 */
const abrState = (playerTimeMs) => [
  ...num(28, Math.max(0, Math.round(playerTimeMs))),
  ...num(29, 1),
  ...num(34, 3),
  ...num(57, 222),
  ...num(59, 8192),
  ...num(71, 1),
  ...num(80, 4),
  ...num(85, 1),
];

/**
 * 한 번 물어볼 요청을 만든다.
 *
 * **선호 포맷(16·17)을 안 주면 서버가 멋대로 고른다.** 우리가 고른 화질이 아닌 것을
 * 받아오게 되므로 반드시 넣는다.
 *
 * **고른 포맷(2)은 일부러 안 보낸다.** 그 자리는 "이 포맷들은 이미 받아뒀다"는 뜻이라,
 * 넣으면 서버가 앞머리(ftyp+moov)를 생략한다. 조각은 `moof`+`mdat` 뿐이라 앞머리가 없으면
 * 파일을 만들 수 없다. 빼두면 어느 재생 위치에서 물어도 앞머리를 함께 준다(실측).
 */
function buildRequest({ playerTimeMs, video, audio, config, poToken, contexts, clientVersion }) {
  const out = [...buf(1, abrState(playerTimeMs))];
  out.push(...buf(5, [...config]));
  if (audio) out.push(...buf(16, formatId(audio)));
  if (video) out.push(...buf(17, formatId(video)));

  const context = [...buf(1, clientInfo(clientVersion))];
  if (poToken) context.push(...buf(2, [...poToken]));
  // 서버가 준 컨텍스트는 그대로 되돌려준다. 웹 클라이언트로 물을 때는 이게 없으면
  // 계속 실패한다(TVHTML5_SIMPLY 는 없어도 바로 준다 — 실측).
  for (const value of contexts || []) context.push(...buf(5, value));
  out.push(...buf(19, context));
  return new Uint8Array(out);
}

/**
 * base64url 을 바이트로. PO 토큰과 ustreamer 설정이 둘 다 이 꼴로 온다.
 * 요청에는 바이트로 넣어야 한다.
 */
function decodeBase64Url(text) {
  if (!text) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* ── 한 번 주고받기 ────────────────────────────────────────────── */

/** 무작위 16자. 유튜브가 재생 한 번을 가리키는 값(cpn)이다. */
function playbackNonce() {
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => ABC[b & 63]).join("");
}

/**
 * SABR 한 판. 주소·설정·토큰을 쥐고 있다가 `pull(재생위치)` 로 조각을 받아온다.
 */
function openSession({ url, config, poToken, clientVersion = "2.20260826.01.00" }) {
  const cpn = playbackNonce();
  const contexts = [];
  let requestNumber = 0;

  const target = (() => {
    const u = new URL(url);
    u.searchParams.set("cpn", cpn);
    u.searchParams.set("cver", clientVersion);
    return u;
  })();

  return {
    async pull({ playerTimeMs, video, audio }) {
      target.searchParams.set("rn", String(requestNumber++));
      const body = buildRequest({
        playerTimeMs,
        video,
        audio,
        config,
        poToken,
        contexts,
        clientVersion,
      });
      const answer = await request.post(target.toString(), body);
      return readAnswer(answer, contexts);
    },
  };
}

/**
 * 답을 풀어 조각으로 만든다.
 *
 * 미디어 한 조각이 여러 부위에 나뉘어 오므로(32KB 씩), **머리말 번호로 이어 붙인다.**
 * 첫 바이트가 머리말 번호이고 나머지가 내용이다.
 */
function readAnswer(data, contexts) {
  const parts = readUmp(data);
  const byHeader = new Map();
  const errors = [];

  for (const part of parts) {
    const bytes = data.subarray(part.at, part.at + part.size);
    if (part.type === PART.MEDIA_HEADER) {
      const f = readFields(bytes);
      byHeader.set(f[1] || 0, {
        itag: f[3],
        startMs: f[11] || 0,
        durationMs: f[12] || 0,
        byteAt: f[6] || 0,
        expected: f[14] || 0,
        // 조각 번호가 없으면 앞머리(init)다.
        sequence: f[9] ?? null,
        chunks: [],
        got: 0,
      });
    } else if (part.type === PART.MEDIA) {
      const entry = byHeader.get(bytes[0]);
      if (!entry) continue;
      const chunk = bytes.subarray(1);
      entry.chunks.push(chunk);
      entry.got += chunk.length;
    } else if (part.type === PART.STATUS) {
      const f = readFields(bytes);
      if (f[4]) errors.push(f[4]);
    } else if (part.type === PART.CONTEXT_UPDATE) {
      // 서버가 "이 값을 다음부터 같이 보내라"고 알려준다.
      const f = readFields(bytes);
      if (f[3]) contexts.push(new Uint8Array([...num(1, f[1] || 0), ...buf(2, [...f[3]])]));
    }
  }

  const segments = [];
  for (const entry of byHeader.values()) {
    if (!entry.got) continue;
    const bytes = new Uint8Array(entry.got);
    let at = 0;
    for (const chunk of entry.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    segments.push({
      itag: entry.itag,
      sequence: entry.sequence,
      time: entry.startMs / 1000,
      duration: entry.durationMs / 1000,
      init: entry.sequence === null,
      bytes,
    });
  }
  return { segments, errors };
}

/* ── 구간 받기 ─────────────────────────────────────────────────── */

/**
 * 앞머리를 받아 갈무리하면서 **고른 구간의 정확한 크기**를 함께 낸다.
 *
 * SABR 이 주는 앞머리는 `ftyp`+`moov`+`sidx` 다 — 일반 경로에서 `fetchIndex` 가 파일 앞을
 * 잘라 받는 것과 같은 내용이고, 길이도 `indexRange.end + 1` 과 딱 맞는다(실측).
 * 그래서 색인을 그대로 읽어 어느 조각이 몇 바이트인지 처음부터 알 수 있다.
 *
 * 앞머리 자체는 `initRange` 까지만 남긴다. 뒤에 붙은 색인은 합칠 때 쓰지 않는다.
 */
function takeInit(track, bytes, start, end) {
  const format = track.format;
  track.init = bytes;
  if (!format?.indexRange || !format?.initRange) return;
  try {
    const index = parseSidx(bytes, format.indexRange.end);
    track.init = bytes.subarray(format.initRange.start, format.initRange.end + 1).slice();
    track.expected = segmentsForRange(index.segments, start, end).reduce(
      (sum, segment) => sum + (segment.end - segment.start + 1),
      0,
    );
  } catch {
    // 색인을 못 읽어도 받기는 계속한다. 총량만 모른 채 간다.
  }
}

/**
 * 고른 구간을 덮을 때까지 재생 위치를 밀어가며 조각을 모은다.
 *
 * 서버가 한 번에 얼마를 줄지는 서버가 정한다. 그래서 "받은 조각 중 가장 뒤쪽 끝"을
 * 다음 재생 위치로 삼아 되풀이한다. 더 나아가지 못하면 그만둔다(끝에 닿았거나 막혔다).
 *
 * @returns `{video, audio}` — 각각 `{init, segments}`. 라이브 경로와 같은 모양이라
 *          합치는 쪽(writeProgressive)을 그대로 쓴다.
 */
async function fetchSabrSection({
  session,
  videoFormat,
  audioFormat,
  start,
  end,
  caches,
  onProgress,
  control,
}) {
  const tracks = {
    video: { format: videoFormat, cache: caches.video, init: null, seen: new Set(), segments: [], bytes: 0 },
    audio: { format: audioFormat, cache: caches.audio, init: null, seen: new Set(), segments: [], bytes: 0 },
  };
  const byItag = new Map();
  if (videoFormat) byItag.set(Number(videoFormat.itag), tracks.video);
  if (audioFormat) byItag.set(Number(audioFormat.itag), tracks.audio);

  const covered = (track) => {
    if (!track.format) return Infinity;
    let last = start;
    for (const s of track.segments) last = Math.max(last, s.time + s.duration);
    return last;
  };
  const 남은트랙 = () => [tracks.video, tracks.audio].filter((t) => t.format);

  // 받은 양과 **정확한 총량**을 알린다.
  //
  // 총량은 앞머리에 딸려 온 색인(sidx)에서 한 번에 낸다. 조각을 받아가며 평균으로
  // 어림하면 받을수록 총량이 불어나 남은 시간이 계속 어긋난다(라이브가 그렇다).
  // SABR 은 색인이 있으니 그럴 이유가 없다.
  const 보고 = () => {
    const list = 남은트랙();
    const bytes = list.reduce((n, t) => n + t.bytes, 0);
    const estimated = list.reduce((n, t) => n + (t.expected || 0), 0);
    onProgress?.(bytes, Math.max(1, estimated), { bytes, estimated });
  };

  let playerTimeMs = Math.max(0, start) * 1000;
  let guard = 0;

  while (guard++ < 400) {
    control?.throwIfStopped?.();
    const { segments, errors } = await session.pull({
      playerTimeMs,
      video: videoFormat,
      audio: audioFormat,
    });
    if (!segments.length) {
      if (errors.length) throw new Error(`조각을 받지 못했습니다 (SABR ${errors[0]})`);
      break;
    }

    let 진전 = false;
    for (const segment of segments) {
      const track = byItag.get(Number(segment.itag));
      if (!track) continue;
      if (segment.init) {
        if (!track.init) takeInit(track, segment.bytes, start, end);
        continue;
      }
      const name = `q${segment.sequence}`;
      if (track.seen.has(name)) continue;
      track.seen.add(name);
      // 고른 구간에 안 걸치는 조각은 버린다(서버가 넉넉히 보내준다).
      if (segment.time + segment.duration <= start || segment.time >= end) continue;
      await track.cache.write(name, segment.bytes);
      // `live: true` 를 달면 안 된다 — 라이브 조각은 앞머리를 품고 와서 떼어내야 하지만,
      // SABR 조각은 `moof`+`mdat` 뿐이라 그대로 써야 한다.
      track.segments.push({ time: segment.time, duration: segment.duration, name });
      track.bytes += segment.bytes.length;
      진전 = true;
    }

    const 진행 = 남은트랙().map(covered);
    const 가장뒤처진 = Math.min(...진행);
    보고();
    if (가장뒤처진 >= end) break;
    const 다음 = 가장뒤처진 * 1000;
    if (!진전 || 다음 <= playerTimeMs) break; // 더 안 나간다
    playerTimeMs = 다음;
  }

  for (const track of 남은트랙()) {
    if (!track.segments.length) throw new Error("해당 구간에 받을 조각이 없습니다");
    if (!track.init) throw new Error("조각에서 앞머리를 찾지 못했습니다");
    track.segments.sort((a, b) => a.time - b.time);
  }
  // `firstTime` 은 합치는 쪽이 편집 목록을 만들 때 쓴다. 빠뜨리면 계산이 NaN 이 되어
  // "담을 샘플이 없다"는 엉뚱한 곳에서 터진다.
  const 묶기 = (track) => ({
    init: track.init,
    segments: track.segments,
    firstTime: track.segments[0].time,
  });
  return {
    video: videoFormat ? 묶기(tracks.video) : null,
    audio: audioFormat ? 묶기(tracks.audio) : null,
  };
}

return {readUmp: readUmp, buildRequest: buildRequest, decodeBase64Url: decodeBase64Url, openSession: openSession, fetchSabrSection: fetchSabrSection};
});
__define("download.js", (__need) => {
// 고른 구간만 받아서 재생 가능한 mp4 하나로 만든다.
//
// 브라우저 API(fetch)만 쓴다. 확장의 content script 는 youtube.com 오리진에서 돌기 때문에
// InnerTube 는 동일 출처로, googlevideo 는 Range 를 허용하는 CORS 로 그대로 부를 수 있다.
//
// 받은 조각은 저장소(store.js — 되도록 OPFS 디스크)에 조각 단위로 쌓는다. 그래서
//  - 메모리에는 한 번에 조각 하나 크기만 남고(전에는 완성본까지 통째로 들고 있었다),
//  - 받다 죽어도 조각이 남아, 같은 구간을 다시 받으면 없는 것만 마저 받는다(이어받기).

const { fetchPlayerResponse, fetchVisitorData, readFormats } = __need("innertube.js");
const { mergeRanges, parseSidx, segmentsForRange } = __need("mp4index.js");
const { request } = __need("net.js");
const { openMemory } = __need("store.js");
const { decodeBase64Url, fetchSabrSection, openSession } = __need("sabr.js");
const { buildHead, editStartOf, fillChunkOffsets, mdatHeader } = __need("mp4file.js");
const { mediaTimescaleOf, readSamples, splitLiveSegment } = __need("mp4mux.js");
/** 한 번에 보내는 요청 수. 너무 늘리면 유튜브가 속도를 깎는다. */
const CONCURRENCY = 6;

/** 웹 계열 클라이언트가 준 주소인가. 이쪽만 PO 토큰이 통한다. */
const isWebUrl = (url) => /[?&]c=(WEB|MWEB|TVHTML5)/.test(url);

async function getFormats(videoId, visitorData, unlock, client, mintPot, getSts) {
  const visitor = visitorData || (await fetchVisitorData());
  const player = await fetchPlayerResponse(videoId, visitor, client, { sts: getSts });
  const formats = readFormats(player);

  // 웹 계열이 주는 주소에는 `n` 이 붙어 있고, 풀지 않으면 403 이다.
  // 로그아웃일 때 쓰는 TVHTML5_SIMPLY 주소에도 붙어 있다.
  // ANDROID_VR 주소에는 아예 없으므로 이 길로 오지 않는다.
  const tracks = [...formats.video, ...formats.audio];
  // SABR 로 받을 영상은 포맷마다 주소가 없다. 푸는 것은 SABR 주소 하나뿐이라 아래에서 따로 한다.
  const withUrl = tracks.filter((track) => track.url);
  if (unlock && withUrl.some((track) => track.url.includes("n="))) {
    const solved = await unlock(withUrl.map((track) => track.url));
    withUrl.forEach((track, index) => {
      track.url = solved[index];
    });
  }

  // PO 토큰이 없으면 유튜브는 앞부분 약 60초까지만 내어준다. 웹 계열 주소에만 통하므로
  // 그쪽일 때만 붙인다(ANDROID_VR 주소에 붙여봐야 403 그대로다 — 실측).
  // 못 만들어도 받기를 막지는 않는다. 앞 60초까지는 그대로 되니까.
  if (mintPot && withUrl.some((track) => isWebUrl(track.url) && !/[?&]pot=/.test(track.url))) {
    try {
      // 무엇에 묶을지는 주소를 준 클라이언트가 정한다. `TVHTML5_SIMPLY` 는 인증 없이
      // 받은 주소라 **방문자**에 묶어야 한다(계정에 묶으면 로그인 상태에서 403).
      const guestUrl = withUrl.some((track) => /[?&]c=TVHTML5/.test(track.url));
      const token = await mintPot(guestUrl ? "visitor" : undefined);
      if (token) {
        for (const track of withUrl) {
          if (isWebUrl(track.url) && !/[?&]pot=/.test(track.url)) {
            track.url += `&pot=${encodeURIComponent(token)}`;
          }
        }
      }
    } catch {
      // 발급기가 없거나 아직 안 덥혀졌다. 앞부분만이라도 받게 두고 넘어간다.
    }
  }
  // 주소가 아예 없으면(공식 뮤직비디오) SABR 로 받는다. 조각을 받으려면 주소의 `n` 을 풀고
  // PO 토큰을 함께 보내야 한다. 여기서 준비만 해두고, 실제 요청은 downloadSection 이 한다.
  if (formats.sabr) {
    let url = formats.sabr.url;
    if (unlock) {
      const [solved] = await unlock([url]);
      if (solved) url = typeof solved === "string" ? solved : solved.url || url;
    }
    let poToken = null;
    if (mintPot) {
      try {
        // SABR 주소도 인증 없이 받은 것이라 토큰은 방문자에 묶는다.
        poToken = decodeBase64Url(await mintPot("visitor"));
      } catch {
        // 없으면 없는 대로 해본다.
      }
    }
    const session = { url, config: decodeBase64Url(formats.sabr.config), poToken };
    for (const track of tracks) track.sabr = session;
  }
  return formats;
}

async function fetchRange(url, start, end) {
  return request.bytes(url, { Range: `bytes=${start}-${end}` });
}

/** 오류 문구에 섞여 오는 HTTP 상태를 꺼낸다. */
const statusOf = (error) => Number(/HTTP (\d{3})/.exec(error?.message || "")?.[1]) || 0;

/**
 * 조각을 받아 온다. 403 이 나면 주소를 새로 받아 한 번 더 해본다.
 *
 * 403 의 큰 원인은 두 가지다.
 * - **주소 만료.** 새로 받으면 풀린다. 이 갈아타기가 그 경우를 잡는다.
 * - **60초 벽.** PO 토큰이 없으면 유튜브가 앞부분 약 60초까지만 내어준다. 이건 갈아타도
 *   못 넘는다 — 세 클라이언트의 경계가 바이트까지 같다. `WEB_CREATOR`(로그인) 나
 *   `TVHTML5_SIMPLY`(로그아웃) 로 물어 토큰을 붙였으면 끝까지 받으므로 여기 오지 않는다.
 *   공식 뮤직비디오는 로그아웃에서 두 길이 다 막혀 여전히 앞 60초까지다.
 *
 * 영상과 소리가 거의 동시에 403 을 맞으므로 갈아타기는 한 번만 한다(같은 약속을 나눠 쓴다).
 *
 * @param renew 새 주소표를 받아 오는 함수. `(itag) => 새 주소` 를 돌려준다.
 * @returns `(format, run)` — `run(주소)` 로 실제 요청을 만든다.
 */
function makePuller(renew) {
  let pending = null;
  return async (format, run) => {
    // 갈아탈 곳은 몇 군데뿐이지만, 끝없이 도는 일이 없도록 횟수를 묶어 둔다.
    for (let hop = 0; hop < 8; hop += 1) {
      try {
        return await run(format.url);
      } catch (error) {
        if (!renew || statusOf(error) !== 403) throw error;
        if (!pending) {
          pending = Promise.resolve(renew()).finally(() => {
            pending = null;
          });
        }
        const lookup = await pending;
        const fresh = lookup?.(format.itag);
        // 갈아탈 곳이 더 없으면 여기까지다.
        //
        // "받은 주소가 지금 것과 같으면 그만" 같은 검사를 두면 안 된다. 일꾼 여럿이
        // 함께 갈아타므로, 먼저 간 일꾼이 이미 같은 주소를 넣어 둔 상태에서 뒤따르는
        // 일꾼이 그 검사에 걸려 엉뚱하게 포기해 버린다(실제로 그래서 한 번밖에 못 갈아탔다).
        if (!fresh) throw error;
        format.url = fresh;
      }
    }
    return run(format.url);
  };
}

// 조각 파일의 이름. 이 이름이 곧 이어받기의 근거다 —
// 일반 영상은 sidx 가 정한 바이트 경계(세션이 바뀌어도 같다), 라이브는 조각 번호.
const rangeName = (segment) => `s${segment.start}-${segment.end}`;
const liveName = (sq) => `q${sq}`;

/**
 * 라이브 조각을 번호로 받아 저장소에 쌓는다.
 *
 * 라이브에는 색인이 없다. 대신 조각이 일정한 길이(`targetDurationSec`)로 잘려 있고
 * `&sq=N` 으로 N번째 조각을 바로 집어올 수 있다. 조각마다 앞머리가 붙어 오므로
 * 통째로 저장해 두고, 엮을 때 앞머리를 떼어낸다(첫 조각의 것만 쓴다).
 */
async function fetchLiveSegments(format, start, end, onProgress, control, track, pull) {
  const step = format.segmentSeconds;
  if (!(step > 0)) throw new Error("조각 길이를 알 수 없습니다");

  const first = Math.max(0, Math.floor(Math.min(start, end) / step));
  const last = Math.max(first, Math.floor(Math.max(start, end) / step));
  const numbers = [];
  for (let sq = first; sq <= last; sq += 1) numbers.push(sq);

  // 이미 받아둔 조각은 건너뛴다. 진행률에는 처음부터 받은 것으로 잡힌다.
  const have = numbers.filter((sq) => track.has(liveName(sq)));
  const missing = numbers.filter((sq) => !track.has(liveName(sq)));
  let done = have.length;

  // 전체 용량 어림. 크기를 아는 조각은 실제 값을 그대로 쓰고, 아직 모르는 조각만
  // 지금까지의 평균으로 메운다. 그래서 받을수록 어림이 실제 크기로 수렴하고,
  // 다 받으면 어림이 아니라 실측이 된다.
  //
  // 앞머리 몇 개만 보고 평균을 고정하면 안 된다. 영상 조각은 화면이 얼마나 움직이느냐에
  // 따라 크기가 배로 오르내리고(균일한 것은 소리뿐이다), 동시에 여러 개를 받으므로
  // 먼저 끝나는 작은 것부터 표본에 들어와 어림이 낮은 쪽으로 치우친다.
  let gotBytes = 0;
  let known = 0;
  // 이어받은 조각도 디스크에서 크기를 읽어 표본에 넣는다. 이러지 않으면 받은 양이
  // 이번에 새로 받은 것만 세어, 진행률은 100%인데 용량은 절반으로 보인다.
  const cached = await Promise.all(have.map((sq) => track.size?.(liveName(sq))));
  for (const size of cached) {
    if (size > 0) {
      gotBytes += size;
      known += 1;
    }
  }
  const sizeReport = () => ({
    bytes: gotBytes,
    estimated: known > 0 ? gotBytes + (gotBytes / known) * (numbers.length - known) : 0,
  });
  onProgress?.(done, numbers.length, sizeReport());

  await mapWithLimit(missing, CONCURRENCY, async (sq) => {
    // 라이브 조각도 몫에 걸린다. 주소를 갈아탈 수 있게 같은 통로로 받는다.
    const fetchOne = (url) => request.bytes(`${url}&sq=${sq}`, {});
    const bytes = pull ? await pull(format, fetchOne) : await fetchOne(format.url);
    await track.write(liveName(sq), bytes);
    done += 1;
    gotBytes += bytes.length;
    known += 1;
    onProgress?.(done, numbers.length, sizeReport());
  }, control);

  // 앞머리(ftyp+moov)가 든 첫 조각을 찾는다. 대개 첫 번째 조각에 있다.
  let init = null;
  for (const sq of numbers) {
    init = splitLiveSegment(await track.read(liveName(sq))).init;
    if (init) break;
  }
  if (!init) throw new Error("조각에서 앞머리를 찾지 못했습니다");

  const segments = numbers.map((sq) => ({
    time: sq * step,
    duration: step,
    name: liveName(sq),
    live: true,
  }));
  return { init, segments, firstTime: first * step };
}

/**
 * 앞머리(init)와 조각 색인(sidx)을 한 번에 받아 온다. 둘이 파일 맨 앞에 붙어 있다.
 *
 * 이 첫 요청도 `pull` 을 거쳐야 한다. 몫이 떨어진 뒤 다시 눌러 이어받을 때 맨 처음
 * 하는 일이 바로 여기라서, 여기서 갈아타지 못하면 조각 받기까지 가보지도 못하고
 * 403 으로 끝난다. 클라이언트가 달라도 initRange/indexRange 는 같으므로(실측) 그대로 쓴다.
 */
async function fetchIndex(format, pull) {
  const fetchOne = (url) => fetchRange(url, 0, format.indexRange.end);
  const head = pull ? await pull(format, fetchOne) : await fetchOne(format.url);
  const init = head.subarray(format.initRange.start, format.initRange.end + 1);
  const index = parseSidx(head, format.indexRange.end);
  return { init: init.slice(), ...index };
}

/** 여러 요청을 동시에 보내되, 결과 순서는 그대로 지킨다. */
async function mapWithLimit(items, limit, worker, control) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      // 차례는 기다리기 전에 집는다. gate() 를 먼저 기다리면 그 사이에 다른 일꾼이
      // 마지막 것을 가져가, 목록에 없는 자리(undefined)까지 집어 오게 된다.
      const index = next;
      next += 1;
      // 조각을 새로 받기 직전에만 멈춘다. 이미 나간 요청은 그대로 끝나게 둔다.
      await control?.gate();
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 받기를 그만뒀을 때 던진다. 실패와 구분해서 조용히 끝내려는 것이다. */
class Stopped extends Error {
  constructor() {
    super("받기를 멈췄습니다");
    this.name = "Stopped";
  }
}

/**
 * 받는 도중 잠깐 멈추거나 아예 그만두게 해준다.
 *
 * 이미 나간 요청을 중간에 끊지는 않는다. 조각 하나는 길어야 몇 초라,
 * 다음 조각을 집지 않는 것만으로 충분히 빨리 멈춘다.
 */
function createControl() {
  let paused = false;
  let stopped = false;
  let wake = null;

  const release = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  return {
    get paused() {
      return paused;
    },
    get stopped() {
      return stopped;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      release();
    },
    stop() {
      stopped = true;
      paused = false;
      release();
    },
    async gate() {
      if (stopped) throw new Stopped();
      while (paused) {
        await new Promise((resolve) => {
          wake = resolve;
        });
        if (stopped) throw new Stopped();
      }
    },
  };
}

/**
 * 구간에 걸치는 조각들을 받아 저장소에 쌓는다.
 *
 * 이어진 조각은 한 요청으로 묶어 받고(8MB 상한 — mergeRanges), 받은 뒤 조각별로
 * 쪼개 저장한다. 조각 단위로 저장해야 다음에 다른 구간을 받아도 겹치는 만큼 다시 쓴다.
 */
async function fetchSegments(format, index, start, end, onProgress, control, track, pull) {
  const wanted = segmentsForRange(index.segments, start, end);
  if (!wanted.length) throw new Error("해당 구간에 받을 조각이 없습니다");

  const size = (segment) => segment.end - segment.start + 1;
  const totalBytes = wanted.reduce((sum, s) => sum + size(s), 0);

  // 이미 받아둔 조각은 건너뛴다. 진행률에는 처음부터 받은 것으로 잡힌다.
  const missing = wanted.filter((segment) => !track.has(rangeName(segment)));
  let done = totalBytes - missing.reduce((sum, s) => sum + size(s), 0);
  onProgress?.(done, totalBytes);

  const ranges = mergeRanges(missing);
  await mapWithLimit(ranges, CONCURRENCY, async (range) => {
    const bytes = pull
      ? await pull(format, (url) => fetchRange(url, range.start, range.end))
      : await fetchRange(format.url, range.start, range.end);
    // 묶어 받은 덩어리를 조각 단위로 잘라 저장한다.
    // slice(복사)를 쓴다 — subarray 로 두면 덩어리 전체가 메모리에 붙들린다.
    for (const segment of missing) {
      if (segment.start < range.start || segment.end > range.end) continue;
      const from = segment.start - range.start;
      await track.write(rangeName(segment), bytes.slice(from, from + size(segment)));
    }
    done += bytes.length;
    onProgress?.(done, totalBytes);
  }, control);

  const segments = wanted.map((segment) => ({
    time: segment.time,
    duration: segment.duration,
    name: rangeName(segment),
  }));
  return { segments, totalBytes, firstTime: wanted[0].time };
}

/** 저장해 둔 조각에서 본체(moof+mdat)만 꺼낸다. 라이브 조각에는 앞머리가 붙어 있다. */
async function readMedia(cache, segment) {
  const bytes = await cache.read(segment.name);
  return segment.live ? splitLiveSegment(bytes).media : bytes;
}

/**
 * 트랙의 조각들을 훑어 샘플 표를 만든다. 바이트는 아직 옮기지 않는다.
 *
 * 여기서 나오는 `c0` 이 편집 목록의 기준점이다. 화면에 처음 나오는 시각(= 조각의 시작
 * 시각)이 미디어 시간축에서 어디인지를 뜻한다. B프레임이 있으면 0이 아니다 — 디코딩
 * 순서의 첫 샘플이 화면에서는 첫 장이 아니기 때문이다(유튜브 H.264 는 256, AV1 은 0).
 *
 * `runs` 는 "이어 붙은 샘플 묶음"이다. 대개 조각 하나가 묶음 하나지만, 라이브 조각은
 * moof+mdat 짝이 여럿이라 여러 묶음으로 갈린다. 이 묶음이 곧 mp4 의 덩어리(chunk)다.
 */
async function indexTrack(track, control) {
  const timescale = mediaTimescaleOf(track.init);
  if (!timescale) throw new Error("트랙의 시간 단위를 읽지 못했습니다");

  const samples = [];
  const runs = [];
  let decodeTime = 0;
  let c0 = Infinity;

  for (const segment of track.segments) {
    await control?.gate();
    const read = readSamples(await readMedia(track.cache, segment));
    if (!read) throw new Error("조각의 샘플 표를 읽지 못했습니다");
    let run = null;
    for (const sample of read.samples) {
      const cts = decodeTime + sample.cto;
      if (cts < c0) c0 = cts;
      decodeTime += sample.duration;
      if (run && sample.at === run.at + run.bytes) {
        run.bytes += sample.size;
        run.count += 1;
      } else {
        if (run) runs.push(run);
        run = { segment, at: sample.at, bytes: sample.size, count: 1, time: segment.time };
      }
      samples.push({
        size: sample.size,
        duration: sample.duration,
        cto: sample.cto,
        sync: sample.sync,
        cts,
      });
    }
    if (run) runs.push(run);
  }
  if (!samples.length) throw new Error("해당 구간에 담을 샘플이 없습니다");
  // 조각의 시작 시각이 미디어 시간축에서 어디인가. 우리가 잰 값(c0)과 앞머리가 적어둔
  // 값 중 큰 쪽을 쓴다. 둘은 같은 뜻이지만 한쪽만 있을 때가 있다 — 유튜브 H.264 는
  // 둘 다 256, AV1 은 앞머리에 없어서 c0(0)만, AAC 는 c0 가 0이라 앞머리 값이 있어야 한다.
  return { ...track, timescale, samples, runs, c0: Math.max(c0, editStartOf(track.init)) };
}

/**
 * 뒤쪽을 실제로 잘라낸다. 화면 순서(CTS)로 골라야 B프레임을 빠뜨리지 않는다.
 *
 * 뒤를 자르는 데는 손실이 없다 — 프레임은 디코딩 순서상 자기보다 **앞**의 것만
 * 참조하므로, 뒤를 버려도 남은 것들은 참조할 것을 모두 갖고 있다.
 * 앞은 그럴 수 없어서 편집 목록으로 가린다.
 */
function trimTail(track, endTime) {
  // 눈금 단위로 반올림해서 센다. 초를 곱해 얻은 값은 아주 조금씩 어긋나서
  // (13초가 36095.9995 처럼 나온다), 그대로 비교하면 경계에 딱 맞춘 요청이
  // 프레임 하나만큼 밀린다. 눈금 하나는 0.065ms 라 반올림해도 잃을 것이 없다.
  const limit = Math.round(track.c0 + (endTime - track.firstTime) * track.timescale);
  let keep = 0;
  for (let i = 0; i < track.samples.length; i += 1) {
    if (track.samples[i].cts < limit) keep = i + 1;
  }
  if (!keep) throw new Error("해당 구간에 담을 샘플이 없습니다");
  if (keep >= track.samples.length) {
    return { ...track, chunks: track.runs.map((run) => run.count) };
  }

  const chunks = [];
  const runs = [];
  let seen = 0;
  for (const run of track.runs) {
    if (seen >= keep) break;
    const take = Math.min(run.count, keep - seen);
    let bytes = 0;
    for (let i = 0; i < take; i += 1) bytes += track.samples[seen + i].size;
    runs.push({ ...run, count: take, bytes });
    chunks.push(take);
    seen += take;
  }
  return { ...track, samples: track.samples.slice(0, keep), runs, chunks };
}

/** 고른 지점을 담고 있는 프레임의 시작 시각(초). 없으면 첫 프레임으로. */
function snapToFrame(track, time) {
  const target = Math.round(track.c0 + (time - track.firstTime) * track.timescale);
  let best = track.c0;
  for (const sample of track.samples) {
    if (sample.cts <= target && sample.cts > best) best = sample.cts;
  }
  return track.firstTime + (best - track.c0) / track.timescale;
}

/** 트랙이 화면에 내놓는 마지막 시각(초). 두 트랙 중 이른 쪽에서 파일이 끝나야 한다. */
function trackEndTime(track) {
  let last = 0;
  for (const sample of track.samples) last = Math.max(last, sample.cts + sample.duration);
  return track.firstTime + (last - track.c0) / track.timescale;
}

/**
 * 트랙들을 일반 mp4 하나로 엮어 출력에 흘려 쓴다.
 *
 * 앞은 편집 목록으로 가리고(바이트를 지키면서 정확해지는 길은 이것뿐이다),
 * 뒤는 실제로 잘라낸다(무손실이고, 편집 목록을 무시하는 재생기에서도 정확해진다).
 *
 * 덩어리는 두 트랙을 시간 순서로 번갈아 놓는다. 한쪽을 몰아 놓으면 재생기가 소리를
 * 찾으러 파일 저편까지 건너뛰어야 한다.
 *
 * @param tracks [{cache, init, segments, firstTime}]
 * @returns {{start: number, end: number}} 실제로 담긴 구간(초)
 */
async function writeProgressive(output, tracks, section, control, onStep) {
  const indexed = [];
  for (const track of tracks) indexed.push(await indexTrack(track, control));

  // 두 트랙이 같은 지점에서 끝나야 한다. 소리 쪽이 더 길면 화면이 멈춘 채 소리만 남는다.
  const endTime = Math.min(section.end, ...indexed.map(trackEndTime));
  const wanted = Math.max(section.start, ...indexed.map((track) => track.firstTime));
  // 영상은 프레임 단위로만 존재한다(60fps 면 16.67ms 마다 한 장). 고른 지점이 프레임
  // 한가운데면, 그 순간 화면에 떠 있던 프레임부터 시작해야 한다. 그러지 않으면 재생기가
  // "지정 시각 이상인 첫 프레임"을 골라 그 장을 통째로 건너뛴다(실측으로 확인했다).
  // 소리는 프레임 제약이 없어 여기 맞추기만 하면 샘플 단위로 정확히 따라온다.
  const anchor = indexed.find((track) => track.snap);
  const startTime = anchor ? snapToFrame(anchor, wanted) : wanted;
  const presentSeconds = Math.max(0, endTime - startTime);

  const parts = indexed.map((track) => {
    const cut = trimTail(track, endTime);
    return {
      ...cut,
      // 앞머리에서 건너뛸 만큼. 조각 시작(c0)에서 고른 지점까지의 거리다.
      editMediaTime: Math.round(cut.c0 + Math.max(0, startTime - cut.firstTime) * cut.timescale),
      presentSeconds,
    };
  });

  const totalBytes = parts.reduce(
    (sum, track) => sum + track.runs.reduce((n, run) => n + run.bytes, 0),
    0,
  );
  // 4GB 를 넘으면 덩어리 위치를 32비트에 못 담는다. 넘칠 것 같으면 64비트 표를 쓴다.
  const largeOffsets = totalBytes > 0xf0000000;
  const { head } = buildHead({ tracks: parts, presentSeconds, largeOffsets });
  const mdat = mdatHeader(totalBytes);

  // 덩어리를 시간 순서로 늘어놓고 자리를 매긴다. 같은 시각이면 영상을 먼저 둔다.
  const order = [];
  parts.forEach((track, index) => {
    track.runs.forEach((run, at) => order.push({ track: index, at, time: run.time, run }));
  });
  order.sort((a, b) => a.time - b.time || a.track - b.track);
  const offsets = parts.map((track) => new Array(track.runs.length));
  let cursor = head.length + mdat.length;
  for (const item of order) {
    offsets[item.track][item.at] = cursor;
    cursor += item.run.bytes;
  }
  fillChunkOffsets(head, offsets);

  await output.write(head);
  await output.write(mdat);
  // 바이트는 여기서 처음이자 마지막으로 옮겨진다. 조각 하나씩 읽어 쓰므로
  // 메모리에는 한 번에 조각 하나만 올라온다.
  let written = 0;
  let open = null;
  for (const item of order) {
    await control?.gate();
    const track = parts[item.track];
    // 같은 조각의 묶음이 이어지면 다시 읽지 않는다(라이브 조각이 그렇다).
    if (!open || open.track !== item.track || open.name !== item.run.segment.name) {
      open = {
        track: item.track,
        name: item.run.segment.name,
        bytes: await readMedia(track.cache, item.run.segment),
      };
    }
    await output.write(open.bytes.subarray(item.run.at, item.run.at + item.run.bytes));
    written += 1;
    onStep?.(written, order.length);
  }
  return { start: startTime, end: endTime };
}

/** 파일 이름에 쓸 수 없는 글자를 지운다. */
function safeFileName(text, fallback = "video") {
  const cleaned = String(text || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * 파일 이름에 쓸 시각. 1/100초까지 적는다 — 같은 초 안에서 여러 구간을 받아도
 * 이름이 겹치지 않고, 어디를 잘랐는지 이름만 봐도 알 수 있다.
 *
 * 콜론은 파일 이름에 못 쓰므로 하이픈으로, 소수점은 그대로 쓴다(예: `00-01-23.45`).
 */
function clockLabel(seconds) {
  // 반올림은 쪼개기 전에 한 번만. 나중에 하면 59.996초가 `59.100` 으로 적힌다.
  const total = Math.round(Math.max(0, Number(seconds) || 0) * 100) / 100;
  const whole = Math.floor(total);
  const h = String(Math.floor(whole / 3600)).padStart(2, "0");
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const s = String(whole % 60).padStart(2, "0");
  const frac = String(Math.round((total - whole) * 100)).padStart(2, "0");
  return `${h}-${m}-${s}.${frac}`;
}

/**
 * 구간 하나를 받아 파일(Blob)을 만든다.
 *
 * @param store 저장소(store.js). 안 주면 메모리 저장소를 쓴다(이어받기 없음).
 * @param onProgress (받은 양, 전체 양, 단계 이름)
 * @returns {{file: Blob, mediaStart: number, mediaSeconds: number}}
 *   저장소가 디스크(OPFS)면 file 은 디스크 기반이라 커도 메모리를 먹지 않는다.
 */
async function downloadSection({
  videoFormat,
  audioFormat,
  start,
  end,
  onProgress,
  control,
  store,
  renewUrl,
}) {
  const media = store || openMemory();
  const pull = makePuller(renewUrl);
  const caches = {
    video: await media.track(videoFormat.itag),
    audio: await media.track(audioFormat.itag),
  };

  // 두 트랙의 진행률을 하나로 합쳐 보여준다.
  const progress = { video: [0, 1, null], audio: [0, 1, null] };
  // 전체 용량 어림은 트랙별로 따로 낸 뒤 합친다. 영상·음성 조각은 크기가 크게 달라서,
  // 섞어서 평균을 내면 작은 음성이 먼저 끝난 뒤 평균이 계속 올라가 어림값이 불어난다.
  const sizeEstimate = () => {
    const tracks = [progress.video, progress.audio];
    if (!tracks.some(([, , size]) => size)) return null;
    let got = 0;
    let estimated = 0;
    for (const [, , size] of tracks) {
      if (!size) continue;
      got += size.bytes;
      estimated += size.estimated;
    }
    return { got, estimated };
  };
  const report = (kind) => (received, expected, size) => {
    progress[kind] = [received, expected, size || null];
    onProgress?.(
      progress.video[0] + progress.audio[0],
      progress.video[1] + progress.audio[1],
      "받는 중",
      sizeEstimate(),
    );
  };

  const live = videoFormat.segmentSeconds > 0 && !videoFormat.indexRange;
  let video;
  let audio;

  if (videoFormat.sabr) {
    // 주소가 없는 영상(공식 뮤직비디오)이다. 재생 위치를 밀어가며 조각을 받아온다.
    onProgress?.(0, 1, "조각 받는 중");
    const session = openSession(videoFormat.sabr);
    const got = await fetchSabrSection({
      session,
      videoFormat,
      audioFormat,
      start,
      end,
      caches,
      control,
      onProgress: (done, total, size) =>
        onProgress?.(done, total, "받는 중", size && { got: size.bytes, estimated: size.estimated }),
    });
    video = got.video;
    audio = got.audio;
  } else if (live) {
    onProgress?.(0, 1, "조각 받는 중");
    // 소리는 영상이 시작하는 지점부터 받아야 한다. 조각 길이가 서로 달라서
    // 같은 시각을 달라고 하면 소리가 영상보다 늦게 시작하는 일이 생긴다.
    const videoHead = Math.floor(start / videoFormat.segmentSeconds) * videoFormat.segmentSeconds;
    [video, audio] = await Promise.all([
      fetchLiveSegments(videoFormat, start, end, report("video"), control, caches.video, pull),
      fetchLiveSegments(audioFormat, videoHead, end, report("audio"), control, caches.audio, pull),
    ]);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const [videoIndex, audioIndex] = await Promise.all([
      fetchIndex(videoFormat, pull),
      fetchIndex(audioFormat, pull),
    ]);
    // 영상은 조각 경계에서만 시작할 수 있다. 소리도 그 지점부터 받아야
    // 두 트랙이 같은 곳에서 시작한다. 그러지 않으면 소리가 늦게 시작해 앞서 간다.
    const videoHead = segmentsForRange(videoIndex.segments, start, end)[0]?.time ?? start;
    const [videoParts, audioParts] = await Promise.all([
      fetchSegments(videoFormat, videoIndex, start, end, report("video"), control, caches.video, pull),
      fetchSegments(audioFormat, audioIndex, videoHead, end, report("audio"), control, caches.audio, pull),
    ]);
    video = { init: videoIndex.init, ...videoParts };
    audio = { init: audioIndex.init, ...audioParts };
  }

  onProgress?.(0, 1, "합치는 중");
  const output = await media.output();
  let file;
  let span;
  try {
    span = await writeProgressive(
      output,
      [
        { ...video, cache: caches.video, snap: true },
        { ...audio, cache: caches.audio },
      ],
      { start, end },
      control,
      (step, steps) => onProgress?.(step, steps, "합치는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }

  // 조각은 통째로 받지만 파일은 고른 구간만 내놓는다(앞은 편집 목록, 뒤는 실제로 잘라냄).
  // 영상은 프레임 단위라 시작이 한 프레임 안쪽에서 당겨질 수 있어, 실제 값을 그대로 알린다.
  return {
    file,
    mediaStart: span.start,
    mediaEnd: span.end,
    mediaSeconds: Math.max(0, span.end - span.start),
  };
}

/**
 * 고른 구간 여러 개를 **하나로 이어붙여** 받는다.
 *
 * 어떻게 이어지나 — 조각들을 시간 순으로 늘어놓고 한 번에 조립한다. 샘플 시간은 조각을
 * 이어 붙인 순서대로 흐르므로(`indexTrack` 이 길이를 누적한다), 구간 사이의 빈 곳은
 * 저절로 사라지고 고른 데만 이어서 재생된다.
 *
 * **경계는 조각 단위다.** 구간 하나만 받을 때는 뒤를 샘플 단위로 잘라내지만, 여기서는
 * 시간축이 이어지지 않아 그 계산을 쓸 수 없다. 그래서 각 구간이 조각 경계까지 조금
 * 넉넉하게 담긴다(앞쪽 한 번만 편집 목록으로 다듬는다).
 *
 * 라이브와 SABR(뮤직비디오)은 아직 지원하지 않는다 — 색인이 있어야 조각을 고를 수 있다.
 */
async function downloadClips({
  videoFormat,
  audioFormat,
  clips,
  onProgress,
  control,
  store,
  renewUrl,
}) {
  if (videoFormat.sabr || videoFormat.segmentSeconds > 0 || !videoFormat.indexRange) {
    throw new Error("이 영상은 이어붙이기를 지원하지 않습니다");
  }
  const order = [...clips].sort((a, b) => a.start - b.start);
  if (!order.length) throw new Error("고른 구간이 없습니다");

  const media = store || openMemory();
  const pull = makePuller(renewUrl);
  const caches = {
    video: await media.track(videoFormat.itag),
    audio: await media.track(audioFormat.itag),
  };

  onProgress?.(0, 1, "색인 읽는 중");
  const [videoIndex, audioIndex] = await Promise.all([
    fetchIndex(videoFormat, pull),
    fetchIndex(audioFormat, pull),
  ]);

  const picked = { video: [], audio: [] };
  let done = 0;
  const total = order.length;
  for (const clip of order) {
    // 소리는 영상 조각이 시작하는 곳부터 받아야 두 트랙이 같은 자리에서 시작한다.
    const head = segmentsForRange(videoIndex.segments, clip.start, clip.end)[0]?.time ?? clip.start;
    const [v, a] = await Promise.all([
      fetchSegments(videoFormat, videoIndex, clip.start, clip.end, null, control, caches.video, pull),
      fetchSegments(audioFormat, audioIndex, head, clip.end, null, control, caches.audio, pull),
    ]);
    picked.video.push(...v.segments);
    picked.audio.push(...a.segments);
    done += 1;
    onProgress?.(done, total, "받는 중");
  }

  // 겹치는 구간을 고르면 같은 조각이 두 번 들어온다. 이름으로 걸러 시간 순으로 세운다.
  const tidy = (segments) => {
    const seen = new Map();
    for (const segment of segments) if (!seen.has(segment.name)) seen.set(segment.name, segment);
    return [...seen.values()].sort((x, y) => x.time - y.time);
  };
  const video = { init: videoIndex.init, segments: tidy(picked.video) };
  const audio = { init: audioIndex.init, segments: tidy(picked.audio) };
  video.firstTime = video.segments[0].time;
  audio.firstTime = audio.segments[0].time;

  onProgress?.(0, 1, "합치는 중");
  const output = await media.output();
  let file;
  try {
    // 꼬리를 자르지 않는다(end 를 무한대로) — 구간이 여럿이라 "몇 초까지"가 뜻을 잃는다.
    await writeProgressive(
      output,
      [
        { ...video, cache: caches.video, snap: true },
        { ...audio, cache: caches.audio },
      ],
      { start: order[0].start, end: Infinity },
      control,
      (step, steps) => onProgress?.(step, steps, "합치는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }
  const seconds = video.segments.reduce((sum, segment) => sum + segment.duration, 0);
  return { file, mediaStart: order[0].start, mediaEnd: order[0].start + seconds, mediaSeconds: seconds };
}

/**
 * 트랙 하나만 골라 파일로 만든다. 앞머리는 원본 그대로라 트랙을 합칠 일이 없다.
 *
 * 영상은 키프레임(조각 경계)에서만 자를 수 있어 조각을 통째로 담고,
 * 소리는 샘플 단위로 잘라 요청한 구간에 정확히 맞춘다.
 *
 * @param kind "video" 또는 "audio"
 * @returns downloadSection 과 같은 모양: {file, mediaStart, mediaEnd, mediaSeconds}
 */
async function downloadTrack({ format, kind, start, end, onProgress, control, store, renewUrl }) {
  const media = store || openMemory();
  const pull = makePuller(renewUrl);
  const cache = await media.track(format.itag);
  const report = (done, total, size) => {
    onProgress?.(done, total, "받는 중", size && { got: size.bytes, estimated: size.estimated });
  };

  const live = format.segmentSeconds > 0 && !format.indexRange;
  let track;
  if (live) {
    onProgress?.(0, 1, "조각 받는 중");
    track = await fetchLiveSegments(format, start, end, report, control, cache, pull);
  } else {
    onProgress?.(0, 1, "색인 읽는 중");
    const index = await fetchIndex(format, pull);
    const parts = await fetchSegments(format, index, start, end, report, control, cache, pull);
    track = { init: index.init, ...parts };
  }

  onProgress?.(0, 1, "파일 만드는 중");
  const output = await media.output();
  let file;
  let span;
  try {
    span = await writeProgressive(
      output,
      // 영상만 받을 때는 프레임에 맞춰 당기고, 소리만 받을 때는 그럴 것이 없다.
      [{ ...track, cache, snap: kind === "video" }],
      { start, end },
      control,
      (step, steps) => onProgress?.(step, steps, "파일 만드는 중"),
    );
    file = await output.close();
  } catch (error) {
    output.abort();
    throw error;
  }
  return {
    file,
    mediaStart: span.start,
    mediaEnd: span.end,
    mediaSeconds: Math.max(0, span.end - span.start),
  };
}

return {getFormats: getFormats, fetchLiveSegments: fetchLiveSegments, fetchIndex: fetchIndex, Stopped: Stopped, createControl: createControl, fetchSegments: fetchSegments, writeProgressive: writeProgressive, safeFileName: safeFileName, clockLabel: clockLabel, downloadSection: downloadSection, downloadClips: downloadClips, downloadTrack: downloadTrack};
});
__define("nsig.js", (__need) => {
// 유튜브가 미디어 주소에 붙이는 `n` 파라미터를 푼다.
//
// 왜 필요한가: 로그인해야 볼 수 있는 영상(내 비공개·멤버 전용)은 웹 계열 클라이언트로만
// 열리는데, 그쪽이 주는 주소에는 항상 `n` 이 붙는다. 풀지 않고 요청하면 403 이다.
// 직접 재본 결과 — 올바른 n: 206 / 뒤집은 n: 403 / n 제거: 403.
//
// 공개 영상은 `ANDROID_VR` 이 `n` 없는 주소를 주므로 이 길로 오지 않는다.
//
// 여기서는 해결기 코드를 읽어 넘기기만 한다. 실제로 푸는 곳은 페이지 쪽(page-fetch.js)이고,
// 왜 거기여야 하는지는 그 파일에 적어뒀다.

const FILES = ["vendor/yt-solver-lib.js", "vendor/yt-solver-core.js"];

let sources = null;

/** 해결기 원본을 한 번만 읽어둔다. 150KB 남짓이라 매번 읽을 이유가 없다. */
async function loadSolver(runtime) {
  if (!sources) {
    const [lib, core] = await Promise.all(
      FILES.map(async (name) => (await fetch(runtime.getURL(name))).text()),
    );
    sources = { lib, core };
  }
  return sources;
}

/**
 * 주소들의 `n` 을 풀어 새 주소로 바꿔 돌려준다.
 *
 * `n` 이 없는 주소는 그대로 둔다.
 */
async function solveUrls(urls, { runtime, ask, onStep }) {
  const challenges = [...new Set(urls.map(challengeOf).filter(Boolean))];
  if (!challenges.length) return urls;

  onStep?.("주소를 푸는 중입니다");
  const { lib, core } = await loadSolver(runtime);
  const answered = await ask({ lib, core, challenges });
  const answers = { ...(answered?.answers || {}) };
  if (!answered?.answers) throw new Error("n 을 풀지 못했습니다");

  // 답이 빠진 것이 있으면 한 번 더 물어본다.
  //
  // 왜 이렇게까지 하나 — 안 풀린 주소를 그대로 돌려주면 **받을 때가 되어서야 403** 이 난다.
  // 그 403 은 60초 벽과 생김새가 같아서 엉뚱한 데를 파게 된다(실제로 한 번 그랬다).
  // 여기서 확인하고 못 풀면 못 풀었다고 말하는 편이 낫다.
  let missing = challenges.filter((raw) => !answers[raw]);
  if (missing.length) {
    onStep?.("주소를 다시 푸는 중입니다");
    const again = await ask({ lib, core, challenges: missing });
    Object.assign(answers, again?.answers || {});
    missing = challenges.filter((raw) => !answers[raw]);
  }
  if (missing.length) throw new Error(`n 을 풀지 못했습니다 (${missing.length}개 남음)`);

  return urls.map((url) => {
    const raw = challengeOf(url);
    const answer = raw && answers[raw];
    return answer ? url.replace(`n=${raw}`, `n=${answer}`) : url;
  });
}

function challengeOf(url) {
  const match = /[?&]n=([^&]+)/.exec(url);
  return match ? match[1] : null;
}

return {solveUrls: solveUrls, challengeOf: challengeOf};
});
window.__ytdlBase = "https://ba-kod.github.io/yt-download/";
window.__ytdlModules = Object.fromEntries(
  ["net.js", "innertube.js", "mp4index.js", "mp4mux.js", "mp4file.js", "store.js", "sabr.js", "download.js", "nsig.js"].map((name) => [name, __need(name)]),
);
const __styleId = 'ytdl-overlay-style';
document.getElementById(__styleId)?.remove();
const __style = document.createElement('style');
__style.id = __styleId;
__style.textContent = "/* \uc720\ud29c\ube0c \uc548\uc5d0 \uc5b9\ub294 UI. \ud398\uc774\uc9c0 \uc2a4\ud0c0\uc77c\uacfc \uc11e\uc774\uc9c0 \uc54a\ub3c4\ub85d \uac12\uc744 \ubaa8\ub450 \uc9c1\uc811 \uc801\ub294\ub2e4. */\n\n/* \uc88b\uc544\uc694\u00b7\uacf5\uc720 \uc606\uc5d0 \uc11c\ub294 \ubc84\ud2bc.\n   \uce58\uc218\uc640 \uc0c9\uc740 \uc606\uc5d0 \uc120 \uc9c4\uc9dc \uc720\ud29c\ube0c \ubc84\ud2bc\uc744 \uc7ac\uc11c `--ytdl-open-*` \ub85c \ub123\uc5b4\uc900\ub2e4\n   (content.js \uc758 matchNeighbour). \uc5ec\uae30 \uc801\ud78c \uac12\uc740 \ubabb \uc7c0\uc744 \ub54c \uc4f0\ub294 \ub300\ube44\ucc45\uc774\ub2e4. */\n.ytdl-open {\n  position: relative;\n  /* \uc5b9\ub294 \uc0c9(::before)\uc774 \ubc14\ud0d5 \uc704\u00b7\uae00\uc790 \uc544\ub798\uc5d0 \uc624\ub3c4\ub85d \uc774 \ubc84\ud2bc\uc744 \ud55c \uacb9\uc73c\ub85c \ubb36\ub294\ub2e4. */\n  isolation: isolate;\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: var(--ytdl-open-h, 36px);\n  border: 0;\n  border-radius: var(--ytdl-open-r, 18px);\n  margin-left: var(--ytdl-open-ml, 8px);\n  background: var(--ytdl-open-bg, rgba(0, 0, 0, 0.05));\n  color: var(--ytdl-open-fg, #0f0f0f);\n  padding: var(--ytdl-open-pad, 0 16px);\n  font: var(--ytdl-open-font, 500 14px/1 \"Roboto\", \"Noto Sans KR\", system-ui, sans-serif);\n  letter-spacing: var(--ytdl-open-track, normal);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n/* \uc5b9\ub294 \uc0c9\uc744 \ub530\ub85c \ub450\ub294 \uc774\uc720: \ubc14\ud0d5\uc0c9\uc744 \uc720\ud29c\ube0c\uc5d0\uc11c \uc7ac \uc628 \uac12\uc73c\ub85c \uc4f0\uae30 \ub54c\ubb38\uc5d0,\n   :hover \uc5d0 \uc0c9\uc744 \ubabb\ubc15\uc73c\uba74 \uc7b0 \uac12\uc774 \ud1b5\uc9f8\ub85c \ub36e\uc778\ub2e4. \uae00\uc790\uc0c9\uc73c\ub85c \uc587\uac8c \ub36e\uc73c\uba74\n   \ubc1d\uc740 \ud14c\ub9c8\uc5d0\uc11c\ub294 \uc5b4\ub461\uac8c, \uc5b4\ub450\uc6b4 \ud14c\ub9c8\uc5d0\uc11c\ub294 \ubc1d\uac8c \u2014 \uc800\uc808\ub85c \ub9de\ub294\ub2e4. */\n.ytdl-open::before {\n  content: \"\";\n  position: absolute;\n  inset: 0;\n  z-index: -1;\n  border-radius: inherit;\n  background: currentColor;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.ytdl-open:hover::before {\n  opacity: 0.1;\n}\n\n.ytdl-open.ytdl-open-active {\n  background: #0f0f0f;\n  color: #fff;\n}\n\n/* \uc720\ud29c\ube0c \uc544\uc774\ucf58\uacfc \uac19\uc740 \ud2c0. \uadf8\ub9bc\uc744 \uadf8 \uc548\uc5d0 \ub9de\ucdb0 \uadf8\ub824\ub46c\uc11c(content.js \uc758 downloadIcon)\n   \ud2c0 \ud06c\uae30\ub294 \uc5ec\uae30 \ubabb\ubc15\uc544\ub3c4 \uc606 \uc544\uc774\ucf58\ub4e4\uacfc \uac19\uc740 \ud06c\uae30\ub85c \ubcf4\uc778\ub2e4. */\n.ytdl-open-icon {\n  display: inline-flex;\n  flex: none;\n  width: 24px;\n  height: 24px;\n}\n\n.ytdl-open-icon svg {\n  width: 100%;\n  height: 100%;\n  display: block;\n}\n\n/* \uc20f\uce20\uc758 \uc624\ub978\ucabd \uc138\ub85c \uc904\uc5d0 \uc11c\ub294 \ubaa8\uc591.\n   \uc720\ud29c\ube0c\uc758 \uc88b\uc544\uc694 \uce78\uacfc \ub611\uac19\uc774 \ub9cc\ub4e0\ub2e4 \u2014 48px \ub3d9\uadf8\ub77c\ubbf8 + \uadf8 \uc544\ub798 \uae00\uc790, \uc804\uccb4 78px, \uc5ec\ubc31 0.\n   \uadf8 \uc904\uc740 gap \ub3c4 margin \ub3c4 \uc5c6\uc774 \uce78 \ub192\uc774\ub85c\ub9cc \uac04\uaca9\uc744 \ub9cc\ub4e0\ub2e4(\uc7ac\uc11c \ud655\uc778\ud568).\n   \uc5ec\ubc31\uc744 \ub530\ub85c \uc8fc\uba74 \uc6b0\ub9ac \uac83\ub9cc \uc5b4\uae0b\ub09c\ub2e4. */\n.ytdl-open-reel {\n  flex-direction: column;\n  justify-content: flex-start;\n  gap: 0;\n  width: 48px;\n  height: 78px;\n  margin: 0;\n  padding: 0;\n  border-radius: 0;\n  background: transparent;\n}\n\n.ytdl-open-reel:hover {\n  background: transparent;\n}\n\n/* \uc138\ub85c \uc904\uc5d0\uc11c\ub294 \uce78 \uc804\uccb4\uac00 \uc544\ub2c8\ub77c \ub3d9\uadf8\ub77c\ubbf8\ub9cc \ub36e\uc5ec\uc57c \ud55c\ub2e4. \uc5b9\ub294 \uc0c9\uc744 \ub048\ub2e4. */\n.ytdl-open-reel::before {\n  content: none;\n}\n\n.ytdl-open-reel .ytdl-open-icon {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 48px;\n  height: 48px;\n  border-radius: 50%;\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.ytdl-open-reel .ytdl-open-icon svg {\n  width: 24px;\n  height: 24px;\n}\n\n.ytdl-open-reel:hover .ytdl-open-icon {\n  background: rgba(0, 0, 0, 0.1);\n}\n\n.ytdl-open-reel .ytdl-open-label {\n  margin-top: 6px;\n  font-size: 12px;\n  font-weight: 500;\n  line-height: 1;\n}\n\n/* \ub20c\ub9b0 \uc0c1\ud0dc\ub294 \ub3d9\uadf8\ub77c\ubbf8\ub9cc \ubc18\uc804\ud55c\ub2e4(\uce78 \uc804\uccb4\ub97c \uce60\ud558\uba74 \uc720\ud29c\ube0c \ubc84\ud2bc\ub4e4\uacfc \ub530\ub85c \ub17c\ub2e4). */\n.ytdl-open-reel.ytdl-open-active,\n.ytdl-open-reel.ytdl-open-active:hover {\n  background: transparent;\n  color: inherit;\n}\n\n.ytdl-open-reel.ytdl-open-active .ytdl-open-icon {\n  background: #0f0f0f;\n  color: #fff;\n}\n\n/* \uc601\uc0c1 \uc815\ubcf4 \ubc14\ub85c \uc544\ub798\uc5d0 \ub07c\uc5b4\ub4dc\ub294 \ud328\ub110.\n   \uc790\uae30 \ub108\ube44\ub97c \uae30\uc900\uc73c\ub85c \uc904\uc744 \ub2e4\uc2dc \uc9dc\ub294 \ubc18\uc751\ud615\uc774\ub2e4(\uc544\ub798 @container \uaddc\uce59).\n   \ud654\uba74(\ubdf0\ud3ec\ud2b8)\uc774 \uc544\ub2c8\ub77c \ud328\ub110\uc774 \ub080 \uce78\uc758 \ub108\ube44\uac00 \uae30\uc900\uc774\ub77c \ucee8\ud14c\uc774\ub108 \ucffc\ub9ac\ub97c \uc4f4\ub2e4. */\n/* \ub538\ub9bc\ucc3d(\uad6c\uac04 \ubaa9\ub85d\u00b7\ub0a8\uc740 \uc870\uac01)\uc744 \ud328\ub110 \uc591\uc606\uc5d0 \uc138\uc6b0\ub294 \uae30\uc900\uc810. */\n.ytdl-panel {\n  position: relative;\n  /* \ub04c \ub54c \uc7b0 \ub108\ube44\ub97c \uadf8\ub300\ub85c \ub2e4\uc2dc \ub123\ub294\ub2e4. \ud14c\ub450\ub9ac\ub97c \ub108\ube44\uc5d0 \ud3ec\ud568\uc2dc\ud0a4\uc9c0 \uc54a\uc73c\uba74 \ub123\uc744 \ub54c\ub9c8\ub2e4 \ucee4\uc9c4\ub2e4. */\n  box-sizing: border-box;\n  container-type: inline-size;\n  margin: 12px 0 16px;\n  border: 1px solid rgba(0, 0, 0, 0.1);\n  border-radius: 12px;\n  background: #f9f9f9;\n  color: #0f0f0f;\n  font: 14px/1.4 \"Roboto\", \"Noto Sans KR\", system-ui, sans-serif;\n}\n\n/* \uc20f\uce20\uc5d0\ub294 \uc601\uc0c1 \uc544\ub798\uc5d0 \ub07c\uc6cc \ub123\uc744 \uc790\ub9ac\uac00 \uc5c6\ub2e4. \ud654\uba74 \uc704\uc5d0 \ub744\uc6b4\ub2e4.\n   \uc20f\uce20 UI \ub294 z-index \ub97c 2000 \ub300\uae4c\uc9c0 \uc4f0\ubbc0\ub85c \uadf8\ubcf4\ub2e4 \uc704\uc5d0 \ub193\ub294\ub2e4.\n\n   \uac00\uc6b4\ub370 \ubaa8\ub2ec\ub85c \ub744\uc6b0\uc9c0 \uc54a\ub294 \uc774\uc720: \uc190\uc7a1\uc774\ub97c \ub04c\uba74 \uc720\ud29c\ube0c \uc601\uc0c1\uc774 \uadf8 \uc9c0\uc810\uc73c\ub85c \ub530\ub77c\uac00\uc11c\n   \ud654\uba74 \uc790\uccb4\uac00 \ubbf8\ub9ac\ubcf4\uae30\ub2e4. \uc601\uc0c1\uc744 \uac00\ub9ac\uba74 \uadf8 \ubbf8\ub9ac\ubcf4\uae30\ub97c \uc783\ub294\ub2e4.\n   \uadf8\ub798\uc11c \uc20f\uce20(\uc138\ub85c \uc601\uc0c1) \uc606\uc758 \ube48\uc790\ub9ac\uc5d0 \uc138\uc6b4\ub2e4.\n\n   \uac00\ub85c \uc790\ub9ac(left\u00b7width)\ub294 \ud654\uba74\ub9c8\ub2e4 \ub2ec\ub77c\uc11c content.js \uac00 \uc7ac\uc11c \ub123\ub294\ub2e4. \uc138\ub85c \ubc84\ud2bc \uc904\uc774\n   \uc601\uc0c1 \ubc14\ub85c \uc624\ub978\ucabd\uc5d0 \ubd99\uc5b4 \uc788\uc5b4\uc11c, \uace0\uc815\uac12\uc73c\ub85c \ub450\uba74 \uadf8 \ubc84\ud2bc\ub4e4\uc744 \ub36e\ub294\ub2e4(\uc2e4\uc81c\ub85c \ub36e\uc5c8\ub2e4). */\n/* \ub744\uc6b4 \ud328\ub110\uc740 \ud654\uba74 \uc544\ub798 \uac00\uc6b4\ub370\uc5d0 \uc120\ub2e4. \uc20f\uce20\ub4e0 \uc77c\ubc18 \ud654\uba74\uc774\ub4e0 \ub298 \uac19\uc740 \uc790\ub9ac\ub77c\n   \ucc98\uc74c \uc5f4\uc5c8\uc744 \ub54c \ub208\uc774 \ucc3e\uc744 \uacf3\uc744 \uc548\ub2e4. \uc81c\ubaa9 \uc904\uc744 \uc7a1\uc544 \ub04c\uba74 \uadf8 \uc790\ub9ac\ub85c \uc62e\uaca8\uac04\ub2e4\n   (\ub04c\uae30\uac00 \uc88c\ud45c\ub97c \uc9c1\uc811 \ubc15\uc544 \ub123\uc5b4\uc11c \uc544\ub798 \uac00\uc6b4\ub370 \ub9de\ucda4\uc744 \ub36e\ub294\ub2e4). */\n.ytdl-panel.ytdl-float {\n  position: fixed;\n  top: auto;\n  right: auto;\n  bottom: 16px;\n  left: 50%;\n  transform: translateX(-50%);\n  /* 920px \uc774\uba74 \uc2dc\uac01\u00b7\ud654\uc9c8\u00b7\ubc1b\uae30\uac00 \ud55c \uc904\uc5d0 \ub2e4 \uc120\ub2e4(760px \uc774\uba74 \ub450 \uc904\ub85c \uc811\ud78c\ub2e4).\n     \uc881\uc740 \ucc3d\uc5d0\uc11c\ub294 \uc54c\uc544\uc11c \uc904\uace0, 520px \uc544\ub798\ub85c \ub0b4\ub824\uac00\uba74 \ucee8\ud14c\uc774\ub108 \uc9c8\uc758\uac00 \uc138 \uc904\ub85c \ub098\ub208\ub2e4. */\n  width: min(920px, calc(100vw - 32px));\n  max-height: 60vh;\n  overflow-y: auto;\n  margin: 0;\n  z-index: 2500;\n  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);\n  background: #fff;\n}\n\n.ytdl-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 10px 14px;\n  border-bottom: 1px solid rgba(0, 0, 0, 0.08);\n}\n\n/* \ub744\uc6b4 \ud328\ub110\uc740 \uc81c\ubaa9 \uc904\uc744 \uc7a1\uc544 \ub04c\uc5b4 \uc62e\uae38 \uc218 \uc788\ub2e4. */\n.ytdl-float .ytdl-head {\n  cursor: grab;\n  user-select: none;\n}\n\n.ytdl-float .ytdl-head:active {\n  cursor: grabbing;\n}\n\n.ytdl-title {\n  font-weight: 600;\n}\n\n.ytdl-close {\n  width: 28px;\n  height: 28px;\n  border: 0;\n  border-radius: 50%;\n  background: transparent;\n  color: inherit;\n  font-size: 13px;\n  line-height: 1;\n  cursor: pointer;\n}\n\n.ytdl-close:hover {\n  background: rgba(0, 0, 0, 0.08);\n}\n\n.ytdl-body {\n  padding: 14px;\n}\n\n/* \ud0c0\uc784\ub77c\uc778: \uc804\uccb4 \uae38\uc774\ub97c \uac00\ub85c\uc904\ub85c \ub193\uace0 \uace0\ub978 \uad6c\uac04\uc744 \uce60\ud55c\ub2e4. */\n.ytdl-track {\n  position: relative;\n  height: 34px;\n  margin: 2px 10px 14px;\n  border-radius: 4px;\n  background: rgba(0, 0, 0, 0.1);\n  cursor: pointer;\n  touch-action: none;\n}\n\n.ytdl-range {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  border-radius: 4px;\n  background: rgba(15, 123, 108, 0.35);\n  pointer-events: none;\n}\n\n.ytdl-handle {\n  position: absolute;\n  top: -3px;\n  bottom: -3px;\n  width: 12px;\n  margin-left: -6px;\n  border-radius: 3px;\n  background: #0f7b6c;\n  cursor: ew-resize;\n}\n\n.ytdl-handle::after {\n  content: \"\";\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  width: 2px;\n  height: 12px;\n  margin: -6px 0 0 -1px;\n  border-radius: 1px;\n  background: rgba(255, 255, 255, 0.75);\n}\n\n/* \uc9c0\uae08 \uc7ac\uc0dd \uc911\uc778 \uc704\uce58 */\n.ytdl-head-mark {\n  position: absolute;\n  top: -5px;\n  bottom: -5px;\n  width: 2px;\n  margin-left: -1px;\n  background: #f03;\n  pointer-events: none;\n}\n\n/* \uc81c\ubaa9 \uc904 \uc2dc\uacc4 \u2014 \uc67c\ucabd\uc740 \uace0\uccd0 \ub123\uc744 \uc218 \uc788\ub294 \uc9c0\uae08 \uc704\uce58, \uc624\ub978\ucabd\uc740 \uc804\uccb4 \uae38\uc774. */\n.ytdl-clock {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n  margin-left: auto;\n  margin-right: 8px;\n  font-size: 12px;\n  font-variant-numeric: tabular-nums;\n  cursor: default;\n}\n\n/* \ube57\uae08 \uc591\uc606\uc740 \ub109\ub109\ud788 \u2014 \"\uc9c0\uae08 / \uc804\uccb4\"\uac00 \ud55c \ub369\uc5b4\ub9ac\ub85c \ubd99\uc5b4 \uc77d\ud788\uba74 \uc5b4\ub290 \ucabd\uc774 \uc5b4\ub290 \uac83\uc778\uc9c0 \ud750\ub824\uc9c4\ub2e4. */\n.ytdl-slash {\n  margin: 0 5px;\n}\n\n/* \ud55c \uc7a5\uc529 \uc62e\uae30\ub294 \ub2e8\ucd94. \uc2dc\uacc4 \uc591\uc606\uc5d0 \uc11c\ubbc0\ub85c \uc791\uace0 \uc870\uc6a9\ud558\uac8c \ub450\ub418, \ub208\uc5d0\ub294 \ub744\uc5b4\uc57c \ud55c\ub2e4. */\n.ytdl-step {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 22px;\n  height: 22px;\n  border: 0;\n  border-radius: 5px;\n  background: transparent;\n  color: inherit;\n  opacity: 0.6;\n  padding: 0;\n  cursor: pointer;\n}\n\n.ytdl-step svg {\n  width: 13px;\n  height: 13px;\n  display: block;\n}\n\n.ytdl-step:hover {\n  opacity: 1;\n  background: rgba(0, 0, 0, 0.08);\n}\n\n.ytdl-now {\n  width: 74px;\n  height: 24px;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background: transparent;\n  color: inherit;\n  padding: 0 5px;\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n  /* \uc591\uc606\uc5d0 \ub2e8\ucd94\uac00 \uc11c \uc788\uc73c\ubbc0\ub85c \uac00\uc6b4\ub370\ub85c \ub454\ub2e4. \uc624\ub978\ucabd\uc73c\ub85c \ubd99\uc774\uba74 \uc67c\ucabd \ub2e8\ucd94\uc640 \uba40\uc5b4\uc838 \uc5b4\uc0c9\ud558\ub2e4. */\n  text-align: center;\n}\n\n/* \ud3c9\uc18c\uc5d0\ub294 \uadf8\ub0e5 \uae00\uc790\ucc98\ub7fc \ub450\uace0, \uc190\uc774 \ub2ff\uc744 \ub54c\ub9cc \uace0\uce60 \uc218 \uc788\ub294 \uce78\uc774\ub77c\uace0 \uc54c\ub824\uc900\ub2e4. */\n.ytdl-now:hover {\n  border-color: rgba(0, 0, 0, 0.18);\n}\n\n.ytdl-now:focus {\n  border-color: rgba(0, 0, 0, 0.4);\n  background: #fff;\n  outline: none;\n}\n\n.ytdl-slash,\n.ytdl-total {\n  color: rgba(0, 0, 0, 0.55);\n}\n\n.ytdl-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.ytdl-row + .ytdl-row {\n  margin-top: 10px;\n}\n\n.ytdl-sep {\n  color: rgba(0, 0, 0, 0.45);\n}\n\n.ytdl-time {\n  width: 92px;\n  height: 34px;\n  border: 1px solid rgba(0, 0, 0, 0.18);\n  border-radius: 8px;\n  background: #fff;\n  color: inherit;\n  padding: 0 8px;\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n}\n\n.ytdl-mark {\n  width: 34px;\n  padding: 0;\n  font-size: 17px;\n  font-weight: 700;\n  line-height: 1;\n}\n\n.ytdl-mark,\n.ytdl-go {\n  height: 34px;\n  border: 1px solid rgba(0, 0, 0, 0.18);\n  border-radius: 8px;\n  background: #fff;\n  color: inherit;\n  padding: 0 12px;\n  font: inherit;\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.ytdl-mark:hover {\n  background: #ececec;\n}\n\n.ytdl-length {\n  min-width: 62px;\n  border-radius: 6px;\n  background: rgba(15, 123, 108, 0.12);\n  color: #0f7b6c;\n  padding: 5px 10px;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n}\n\n/*\n * \uaebe\uc1e0\ub97c \uc6b0\ub9ac\uac00 \uadf8\ub9b0\ub2e4.\n *\n * \ud06c\ub86c\uc774 \uadf8\ub9ac\ub294 \uae30\ubcf8 \uaebe\uc1e0\ub294 `padding-right` \ub97c \ubb34\uc2dc\ud558\uace0 \ud14c\ub450\ub9ac\uc5d0 \ubd99\uc5b4\ubc84\ub9b0\ub2e4\n * (\uc5ec\ubc31\uc744 \ub298\ub9ac\uba74 \uae00\uc790\ub9cc \uc67c\ucabd\uc73c\ub85c \ubc00\ub9b4 \ubfd0 \uaebe\uc1e0\ub294 \uadf8 \uc790\ub9ac\ub2e4). \ub5a8\uc5b4\ub728\ub9b4 \ubc29\ubc95\uc774 \uc5c6\uc5b4\uc11c\n * `appearance: none` \uc73c\ub85c \ub044\uace0 \ubc30\uacbd \uadf8\ub9bc\uc73c\ub85c \uc9c1\uc811 \ub193\ub294\ub2e4 \u2014 \uc790\ub9ac\ub97c \uc6b0\ub9ac\uac00 \uc815\ud55c\ub2e4.\n */\n.ytdl-quality {\n  height: 34px;\n  min-width: 162px;\n  max-width: 100%;\n  border: 1px solid rgba(0, 0, 0, 0.18);\n  border-radius: 8px;\n  background-color: #fff;\n  background-image: url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1.5 2 6 6.5 10.5 2' fill='none' stroke='%23606060' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");\n  background-repeat: no-repeat;\n  background-position: right 12px center;\n  background-size: 12px 8px;\n  color: inherit;\n  /* \uc624\ub978\ucabd\uc740 \uaebe\uc1e0 \uc790\ub9ac(12px) + \ud14c\ub450\ub9ac\uc640\uc758 \uac04\uaca9(12px) + \uae00\uc790\uc640\uc758 \uac04\uaca9\ub9cc\ud07c \ube44\uc6cc \ub454\ub2e4. */\n  padding: 0 34px 0 10px;\n  font: inherit;\n  appearance: none;\n  -webkit-appearance: none;\n}\n\n/* \ubc1b\uc744 \ub0b4\uc6a9(\uc601\uc0c1+\uc18c\ub9ac/\uc601\uc0c1\ub9cc/\uc18c\ub9ac\ub9cc). \ud654\uc9c8\uce78\uacfc \uac19\uc740 \uc0dd\uae40\uc0c8, \ud3ed\ub9cc \uc881\ub2e4. */\n.ytdl-media {\n  min-width: 108px;\n}\n\n.ytdl-go {\n  margin-left: auto;\n  border-color: #0f7b6c;\n  background: #0f7b6c;\n  color: #fff;\n  font-weight: 600;\n  padding: 0 18px;\n}\n\n.ytdl-go:hover:not(:disabled) {\n  background: #0c6a5d;\n}\n\n.ytdl-go:disabled {\n  border-color: rgba(0, 0, 0, 0.12);\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.4);\n  cursor: default;\n}\n\n.ytdl-status {\n  margin-top: 10px;\n  min-height: 18px;\n  color: rgba(0, 0, 0, 0.6);\n  font-size: 13px;\n}\n\n.ytdl-status.ytdl-ok {\n  color: #0f7b6c;\n}\n\n.ytdl-status.ytdl-bad {\n  color: #c5221f;\n}\n\n/* \uc720\ud29c\ube0c \uc5b4\ub450\uc6b4 \ud14c\ub9c8\uc5d0 \ub9de\ucd98\ub2e4.\n   \uc5ec\uae30\uc11c\ub3c4 \uc7b0 \uac12\uc774 \uba3c\uc800\ub2e4 \u2014 \uc774 \uaddc\uce59\uc774 \ub354 \uc138\uc11c, \uc0c9\uc744 \ubabb\ubc15\uc73c\uba74 \uc7b0 \uac12\uc744 \ub36e\uc5b4\ubc84\ub9b0\ub2e4. */\nhtml[dark] .ytdl-open {\n  background: var(--ytdl-open-bg, rgba(255, 255, 255, 0.1));\n  color: var(--ytdl-open-fg, #f1f1f1);\n}\n\nhtml[dark] .ytdl-open.ytdl-open-active {\n  background: #f1f1f1;\n  color: #0f0f0f;\n}\n\nhtml[dark] .ytdl-open-reel,\nhtml[dark] .ytdl-open-reel:hover,\nhtml[dark] .ytdl-open-reel.ytdl-open-active {\n  background: transparent;\n  color: #f1f1f1;\n}\n\nhtml[dark] .ytdl-open-reel .ytdl-open-icon {\n  background: rgba(255, 255, 255, 0.1);\n}\n\nhtml[dark] .ytdl-open-reel:hover .ytdl-open-icon {\n  background: rgba(255, 255, 255, 0.2);\n}\n\nhtml[dark] .ytdl-open-reel.ytdl-open-active .ytdl-open-icon {\n  background: #f1f1f1;\n  color: #0f0f0f;\n}\n\nhtml[dark] .ytdl-panel {\n  border-color: rgba(255, 255, 255, 0.15);\n  background: #212121;\n  color: #f1f1f1;\n}\n\nhtml[dark] .ytdl-panel.ytdl-float {\n  background: #212121;\n}\n\nhtml[dark] .ytdl-head {\n  border-bottom-color: rgba(255, 255, 255, 0.12);\n}\n\nhtml[dark] .ytdl-close:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n\nhtml[dark] .ytdl-time,\nhtml[dark] .ytdl-quality,\nhtml[dark] .ytdl-mark {\n  border-color: rgba(255, 255, 255, 0.22);\n  background-color: #121212;\n  color: #f1f1f1;\n}\n\n/* \uc5b4\ub450\uc6b4 \ud14c\ub9c8\uc5d0\uc11c\ub294 \uaebe\uc1e0\ub3c4 \ubc1d\uac8c. \ubc30\uacbd \uadf8\ub9bc\uc774\ub77c currentColor \uac00 \uba39\uc9c0 \uc54a\uc544 \ub530\ub85c \uadf8\ub9b0\ub2e4. */\nhtml[dark] .ytdl-quality {\n  background-image: url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1.5 2 6 6.5 10.5 2' fill='none' stroke='%23d0d0d0' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");\n}\n\nhtml[dark] .ytdl-mark:hover {\n  background: #383838;\n}\n\nhtml[dark] .ytdl-sep,\nhtml[dark] .ytdl-slash,\nhtml[dark] .ytdl-total,\nhtml[dark] .ytdl-status {\n  color: rgba(255, 255, 255, 0.6);\n}\n\nhtml[dark] .ytdl-step:hover {\n  background: rgba(255, 255, 255, 0.12);\n}\n\nhtml[dark] .ytdl-now:hover {\n  border-color: rgba(255, 255, 255, 0.22);\n}\n\nhtml[dark] .ytdl-now:focus {\n  border-color: rgba(255, 255, 255, 0.45);\n  background: #121212;\n}\n\nhtml[dark] .ytdl-track {\n  background: rgba(255, 255, 255, 0.16);\n}\n\nhtml[dark] .ytdl-length {\n  background: rgba(15, 123, 108, 0.28);\n  color: #7fd8c9;\n}\n\nhtml[dark] .ytdl-go:disabled {\n  border-color: rgba(255, 255, 255, 0.14);\n  background: rgba(255, 255, 255, 0.08);\n  color: rgba(255, 255, 255, 0.4);\n}\n\n/* \ubc1b\ub294 \ub3d9\uc548\uc5d0\ub9cc \ub098\ud0c0\ub098\ub294 \ubc84\ud2bc\ub4e4. \ubc1b\uae30 \ubc84\ud2bc\ubcf4\ub2e4 \ub208\uc5d0 \ub35c \ub744\uac8c \ub454\ub2e4. */\n.ytdl-hold,\n.ytdl-halt,\n.ytdl-reveal,\n.ytdl-discard {\n  border: 1px solid var(--ytdl-line, rgba(255, 255, 255, 0.2));\n  background: transparent;\n  color: inherit;\n  border-radius: 18px;\n  padding: 0 14px;\n  height: 36px;\n  cursor: pointer;\n  font: inherit;\n  white-space: nowrap;\n}\n\n.ytdl-hold:hover,\n.ytdl-halt:hover,\n.ytdl-reveal:hover,\n.ytdl-discard:hover {\n  background: rgba(127, 127, 127, 0.15);\n}\n\n/* \ud328\ub110\uc774 \uc881\uc544\uc9c0\uba74 \ud55c \uc904\uc5d0 \ub2e4 \ubabb \uc120\ub2e4. \uce78\uc744 \ud06c\uac8c \uc14b\uc73c\ub85c \ub098\ub208\ub2e4 \u2014\n   \uc2dc\uac04 \uce78\ub4e4\uc740 \ub0a8\ub294 \ub108\ube44\ub97c \ub098\ub220 \uac16\uace0, \ud654\uc9c8\uce78\uc740 \uc81c \uc904\uc744 \ud1b5\uc9f8\ub85c \uc4f0\uace0,\n   \ubc1b\uae30 \ubc84\ud2bc\uc740 \uadf8 \uc544\ub798\uc5d0\uc11c \uc804\uccb4 \ub108\ube44\ub85c \uc120\ub2e4. */\n@container (max-width: 520px) {\n  .ytdl-time {\n    flex: 1 1 88px;\n    width: auto;\n    min-width: 84px;\n  }\n\n  .ytdl-length {\n    margin-left: auto;\n  }\n\n  .ytdl-quality {\n    flex: 1 1 100%;\n    min-width: 0;\n  }\n\n  .ytdl-go,\n  .ytdl-hold,\n  .ytdl-halt,\n  .ytdl-reveal,\n  .ytdl-discard {\n    flex: 1 1 auto;\n    margin-left: 0;\n  }\n}\n\n/* \u2500\u2500 \ub538\ub9bc\ucc3d: \uad6c\uac04 \ubaa9\ub85d(\uc624\ub978\ucabd)\uacfc \ub0a8\uc740 \uc870\uac01(\uc67c\ucabd) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n   \ud328\ub110\uc758 \uc790\uc2dd\uc774\ub77c \ud328\ub110\uc744 \ub04c\uba74 \ud568\uaed8 \ub530\ub77c\uc628\ub2e4. \uc790\ub9ac\uac00 \uc881\uc73c\uba74 \uc544\ub798\ub85c \uc811\uc5b4 \ub123\ub294\ub2e4. */\n.ytdl-side {\n  position: fixed;\n  /* \ub108\ube44\ub294 placeSides() \uac00 \ud654\uba74 \ud06c\uae30\ub97c \ubcf4\uace0 \uc815\ud574 \uc900\ub2e4. \uc5ec\uae30 \uac12\uc740 \ucc98\uc74c \ud55c \ubc88\uc758 \ub208\uae08\uc774\ub2e4. */\n  width: var(--ytdl-side-width, 240px);\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px;\n  box-sizing: border-box;\n  border: 1px solid rgba(0, 0, 0, 0.1);\n  border-radius: 12px;\n  background: #f9f9f9;\n  color: #0f0f0f;\n  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);\n  z-index: 1;\n}\n\n/* \uc790\ub9ac\ub294 placeSides() \uac00 \uc7a1\ub294\ub2e4. \ud328\ub110\ubcf4\ub2e4 \uc704\uc5d0 \ub46c\uc57c \uac00\ub824\uc9c0\uc9c0 \uc54a\ub294\ub2e4. */\n.ytdl-side {\n  z-index: 2501;\n}\n\n/* \u2500\u2500 \ud328\ub110 \uc548\uc758 \uad6c\uac04 \ubaa9\ub85d \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n   \ubc1b\uae30 \uc904 \ubc14\ub85c \uc544\ub798\uc5d0 \ub454\ub2e4. \ub2f4\uc740 \uac83\uc774 \ub208\uc55e\uc5d0 \uc788\uc5b4\uc57c \ub2e4\uc74c\uc5d0 \ubb58 \ud560\uc9c0 \uc815\ud560 \uc218 \uc788\ub2e4. */\n.ytdl-clips {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  margin-top: 10px;\n  padding: 10px;\n  border: 1px solid rgba(127, 127, 127, 0.25);\n  border-radius: 10px;\n}\n\n.ytdl-clips .ytdl-clip-list {\n  flex-direction: row;\n  flex-wrap: wrap;\n  max-height: 30vh;\n}\n\n.ytdl-clips .ytdl-clip {\n  flex: 0 1 auto;\n  min-width: 200px;\n  border: 1px solid rgba(127, 127, 127, 0.25);\n}\n\n.ytdl-clips .ytdl-clip.on {\n  border-color: currentColor;\n}\n\n/* \ubc1b\uae30 \uc904: \ub2f4\uae30\ub294 \uc67c\ucabd \ub05d, \ubc1b\uae30\ub294 \uc624\ub978\ucabd \ub05d. */\n.ytdl-do {\n  align-items: center;\n}\n\n.ytdl-addclip {\n  border: 1px solid var(--ytdl-line, rgba(127, 127, 127, 0.5));\n  background: transparent;\n  color: inherit;\n  border-radius: 18px;\n  height: 36px;\n  padding: 0 14px;\n  cursor: pointer;\n  font: inherit;\n  white-space: nowrap;\n}\n\n.ytdl-addclip:hover:not(:disabled) {\n  background: rgba(127, 127, 127, 0.15);\n}\n\n.ytdl-addclip:disabled {\n  opacity: 0.45;\n  cursor: default;\n}\n\n.ytdl-side-head {\n  font-weight: 500;\n  opacity: 0.75;\n}\n\n.ytdl-side-foot {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.ytdl-clip-list,\n.ytdl-leftover-list {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  overflow-y: auto;\n  max-height: 40vh;\n}\n\n/* \ubaa9\ub85d\uc758 \ud55c \uc904. \ub204\ub974\uba74 \uadf8 \uad6c\uac04\uc73c\ub85c \uc62e\uaca8\uac00\ubbc0\ub85c \ub20c\ub9b4 \uac83\ucc98\ub7fc \ubcf4\uc5ec\uc57c \ud55c\ub2e4. */\n.ytdl-clip {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 4px 6px;\n  border-radius: 8px;\n  cursor: pointer;\n  border: 1px solid transparent;\n}\n\n.ytdl-clip:hover {\n  background: rgba(127, 127, 127, 0.12);\n}\n\n/* \uc9c0\uae08 \ud3b8\uc9d1 \uc911\uc778 \uad6c\uac04. \uc5b4\ub290 \uc904\uc744 \uace0\ucce4\ub294\uc9c0 \ud55c\ub208\uc5d0 \ubcf4\uc774\uac8c \ud55c\ub2e4. */\n.ytdl-clip.on {\n  border-color: currentColor;\n  background: rgba(127, 127, 127, 0.16);\n}\n\n.ytdl-clip-no {\n  min-width: 40px;\n  opacity: 0.7;\n  font-size: 12px;\n}\n\n.ytdl-clip-time {\n  flex: 1 1 auto;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.ytdl-clip-del {\n  border: 0;\n  background: transparent;\n  color: inherit;\n  cursor: pointer;\n  font: inherit;\n  opacity: 0.6;\n  padding: 0 4px;\n}\n\n.ytdl-clip-del:hover {\n  opacity: 1;\n}\n\n.ytdl-clip-btn,\n.ytdl-add {\n  border: 1px solid var(--ytdl-line, rgba(255, 255, 255, 0.2));\n  background: transparent;\n  color: inherit;\n  border-radius: 18px;\n  padding: 0 12px;\n  height: 32px;\n  cursor: pointer;\n  font: inherit;\n  white-space: nowrap;\n}\n\n.ytdl-add {\n  height: 36px;\n}\n\n.ytdl-clip-btn:hover:not(:disabled),\n.ytdl-add:hover:not(:disabled) {\n  background: rgba(127, 127, 127, 0.15);\n}\n\n.ytdl-clip-btn:disabled,\n.ytdl-add:disabled {\n  opacity: 0.45;\n  cursor: default;\n}\n\nhtml[dark] .ytdl-side {\n  border-color: rgba(255, 255, 255, 0.2);\n  background: #0f0f0f;\n  color: #f1f1f1;\n}\n\n/* \uc881\uc740 \ud654\uba74\uc5d0\uc11c \ud328\ub110 \ud3ed\uc5d0 \ub9de\ucdb0 \ub215\ub294 \uaf34.\n   \uc904\uc774 \uc138\ub85c\ub85c\ub9cc \uc313\uc774\uba74 \ub760\uac00 \uae38\uc5b4\uc838 \ud654\uba74\uc744 \ub2e4 \uba39\ub294\ub2e4. \uac00\ub85c\ub85c \ud758\ub824 \uc5ec\ub7ec \uc904\uc5d0 \ub098\ub220 \ub2f4\ub294\ub2e4. */\n.ytdl-side-wide .ytdl-clip-list,\n.ytdl-side-wide .ytdl-leftover-list {\n  flex-direction: row;\n  flex-wrap: wrap;\n}\n\n.ytdl-side-wide .ytdl-clip {\n  flex: 0 1 auto;\n  min-width: 190px;\n  border: 1px solid rgba(127, 127, 127, 0.25);\n}\n\n.ytdl-side-wide .ytdl-clip.on {\n  border-color: currentColor;\n}\n\n/* \ub0a8\uc740 \ud30c\uc77c\uc744 \uadf8\ub300\ub85c \ub2e4\uc2dc \ub0b4\uc8fc\ub294 \ubc84\ud2bc. \uc904 \uc548\uc5d0 \ub4e4\uc5b4\uac00\ubbc0\ub85c \uc791\uac8c \ub454\ub2e4. */\n.ytdl-clip-save {\n  height: 26px;\n  padding: 0 10px;\n  font-size: 12px;\n}\n\n/* \uc800\uc7a5\uc774 \ub9c9\ud614\uc744 \ub54c \uc9c1\uc811 \ub204\ub974\ub294 \ub9c1\ud06c. \ub208\uc5d0 \ub744\uc5b4\uc57c \ud55c\ub2e4. */\n.ytdl-save-link {\n  color: inherit;\n  text-decoration: underline;\n  cursor: pointer;\n  font-weight: 500;\n}\n\n/* \uad6c\uac04 \uc904\uc758 \uc124\uc815 \ud45c\uc2dc. \uc2dc\uac01 \uc544\ub798\uc5d0 \uc791\uac8c \ubd99\ub294\ub2e4. */\n.ytdl-clip-time {\n  display: flex;\n  flex-direction: column;\n  line-height: 1.25;\n}\n\n.ytdl-clip-set {\n  font-size: 11px;\n  opacity: 0.65;\n}\n\n/* \ub538\ub9bc\ucc3d \uba38\ub9ac: \uc81c\ubaa9\uacfc \uc811\uae30 \ub2e8\ucd94\ub97c \uc591\ub05d\uc5d0 \ub454\ub2e4. */\n.ytdl-side-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.ytdl-side-shut {\n  border: 0;\n  background: transparent;\n  color: inherit;\n  cursor: pointer;\n  font: inherit;\n  opacity: 0.6;\n  padding: 0 2px;\n}\n\n.ytdl-side-shut:hover {\n  opacity: 1;\n}\n\n/* \uc5ec\ub2eb\uc774 \ub2e8\ucd94. \ud3bc\uccd0\uc838 \uc788\uc73c\uba74 \ub20c\ub9b0 \uac83\ucc98\ub7fc \ubcf4\uc778\ub2e4. */\n.ytdl-toggle.on {\n  background: rgba(127, 127, 127, 0.2);\n  border-color: currentColor;\n}\n\n/* \ud654\uba74\uc774 \uc791\uc544\uc9c0\uba74 \uae00\uc790\uc640 \uc5ec\ubc31\ub3c4 \ud568\uaed8 \uc904\uc778\ub2e4. \uc881\uc740 \ucc3d\uc5d0\uc11c \uc904\uc774 \ub450 \uc904\ub85c \uc811\ud788\uc9c0 \uc54a\uac8c. */\n@media (max-width: 800px) {\n  .ytdl-side {\n    padding: 8px;\n    font-size: 13px;\n  }\n\n  .ytdl-side-wide .ytdl-clip {\n    min-width: 150px;\n  }\n\n  .ytdl-clip-btn {\n    height: 30px;\n    padding: 0 10px;\n  }\n}\n\n@media (max-width: 500px) {\n  .ytdl-side-wide .ytdl-clip {\n    min-width: 100%;\n  }\n\n  .ytdl-clip-no {\n    min-width: 0;\n  }\n}\n\n/* \u2500\u2500 \ubc1b\uae30 \uc904\uc758 \ubb36\uc74c \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n   \uad6c\uac04 / \ub0b4\uc6a9\u00b7\ud654\uc9c8 / \ub3d9\uc791 \uc14b\uc73c\ub85c \ub098\ub220 \uc77d\ub294\ub2e4. \ubb36\uc74c \uc0ac\uc774\ub97c \ub113\uac8c \ubc8c\ub824 \uacbd\uacc4\ub97c \ub9cc\ub4e0\ub2e4. */\n.ytdl-group {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex-wrap: wrap;\n}\n\n/* \ub3d9\uc791 \ubb36\uc74c\uc740 \uc624\ub978\ucabd \ub05d\uc73c\ub85c \ubbfc\ub2e4. \uc8fc \ub3d9\uc791\uc774 \ub298 \uac19\uc740 \uc790\ub9ac\uc5d0 \uc788\uc5b4\uc57c \uc190\uc774 \uae30\uc5b5\ud55c\ub2e4. */\n.ytdl-actions {\n  margin-left: auto;\n}\n\n/* \uc9c0\uae08 \uad6c\uac04\uc744 \ubaa9\ub85d\uc5d0 \ub2f4\ub294 \ub2e8\ucd94. \uad6c\uac04 \uce78\uc5d0 \ub538\ub9b0 \uac83\uc774\ub77c \uc791\uac8c \ubd99\uc778\ub2e4. */\n.ytdl-plus {\n  border: 1px dashed var(--ytdl-line, rgba(127, 127, 127, 0.5));\n  background: transparent;\n  color: inherit;\n  border-radius: 16px;\n  height: 30px;\n  padding: 0 10px;\n  cursor: pointer;\n  font: inherit;\n  font-size: 13px;\n  white-space: nowrap;\n  opacity: 0.85;\n}\n\n.ytdl-plus:hover:not(:disabled) {\n  background: rgba(127, 127, 127, 0.15);\n  opacity: 1;\n}\n\n.ytdl-plus:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n/* \uba38\ub9ac\uc904\uc758 \ucc3d \uc5ec\ub2eb\uc774. \uc81c\ubaa9 \uc606\uc5d0 \uc791\uac8c \ub454\ub2e4. */\n.ytdl-head-tools {\n  display: flex;\n  gap: 6px;\n  margin-left: auto;\n}\n\n.ytdl-toggle {\n  border: 1px solid var(--ytdl-line, rgba(127, 127, 127, 0.4));\n  background: transparent;\n  color: inherit;\n  border-radius: 14px;\n  height: 26px;\n  padding: 0 10px;\n  cursor: pointer;\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  opacity: 0.8;\n}\n\n.ytdl-toggle:hover {\n  opacity: 1;\n  background: rgba(127, 127, 127, 0.15);\n}\n\n/* \ub538\ub9bc\ucc3d \uba38\ub9ac\ub294 \uc7a1\uc544 \ub044\ub294 \uc790\ub9ac\ub2e4. \uadf8\ub807\uac8c \ubcf4\uc774\uac8c \ud55c\ub2e4. */\n.ytdl-side-head {\n  cursor: grab;\n  user-select: none;\n}\n\n.ytdl-side-head:active {\n  cursor: grabbing;\n}\n\n/* \uc0ac\ub78c\uc774 \uc62e\uaca8 \ub193\uc740 \ucc3d. \ud328\ub110\uc744 \ub530\ub77c\ub2e4\ub2c8\uc9c0 \uc54a\ub294\ub2e4\ub294 \ud45c\uc2dc\ub85c \ud14c\ub450\ub9ac\ub97c \uc0b4\uc9dd \uc138\uc6b4\ub2e4. */\n.ytdl-side-free {\n  border-color: currentColor;\n}\n\n/* \ub0a8\uc740 \uc870\uac01\uc758 \uc601\uc0c1 \uc12c\ub124\uc77c. \uc81c\ubaa9\uc744 \ubabb \uc801\uc5b4\ub454 \uac83\ub3c4 \uc774\uac78\ub85c \uc54c\uc544\ubcf8\ub2e4. */\n.ytdl-clip-thumb {\n  width: 44px;\n  height: 33px;\n  object-fit: cover;\n  border-radius: 4px;\n  flex: 0 0 auto;\n  background: rgba(127, 127, 127, 0.2);\n}\n\n/* \uc313\uc544\ub454 \uac83\uc774 \uc5c6\uc744 \ub54c\uc758 \uc548\ub0b4. \ub20c\ub7ec\ub3c4 \uc544\ubb34 \uc77c \uc5c6\ub2e4\ub294 \uac83\uc774 \ubcf4\uc774\uac8c \ud750\ub9ac\uac8c \ub454\ub2e4. */\n.ytdl-empty {\n  opacity: 0.55;\n  cursor: default;\n}\n\n.ytdl-empty:hover {\n  background: transparent;\n}\n";
document.documentElement.append(__style);
(() => {
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
// 플레이어 요소는 화면마다 이름이 다르다(일반 #movie_player, 숏츠 #shorts-player).
//
// 숏츠 화면에는 **둘 다 있다.** 그런데 거기서 `#movie_player` 는 값이 전부 0 인
// 빈 껍데기다(직접 확인함). 하나만 골라 보고 끝내면 길이를 0 으로 읽는다.
// 그래서 후보를 차례로 읽어보고 쓸 만한 값을 주는 첫 번째를 쓴다.
function playerApis() {
  const found = ["#shorts-player", "#movie_player", ".html5-video-player"]
    .map((selector) => document.querySelector(selector))
    .filter((node) => node && typeof node.getProgressState === "function");
  return [...new Set(found)];
}

function readProgressFrom(api) {
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

function readProgress() {
  for (const api of playerApis()) {
    const progress = readProgressFrom(api);
    if (progress) return progress;
  }
  return null;
}

// `let` 이 아니라 `var` 인 이유: 이 다리는 같은 페이지에 다시 놓일 수 있다
// (확장이 스스로 갱신하면 열려 있는 탭에 새 판을 넣는다). 같은 전역에서 `let` 을 두 번
// 선언하면 그 자리에서 터진다. `var` 는 다시 선언해도 된다.
var progressTimer = null;

// 플레이어(base.js)는 2~3MB 다. 한 번만 받아둔다.
var playerSource = null;
// 받아오는 중인 약속. 동시에 여러 번 불려도 한 번만 받게 한다.
var playerSourceLoading = null;

/**
 * 미디어 주소에 붙은 `n` 을 푼다.
 *
 * 왜 여기(페이지 쪽)에서 하나:
 *  - 해결기는 base.js 를 뜯어 새 코드를 만들어 돌린다. 확장 안에서는 그게 금지돼 있고,
 *    유튜브 페이지는 CSP 가 `unsafe-eval` 을 허용해서 여기서는 된다.
 *  - blob 일꾼은 못 쓴다. 유튜브 CSP 의 `script-src` 에 `blob:` 이 없어서 막힌다.
 *
 * 왜 빈 iframe 안에서 하나:
 *  - 유튜브는 이 페이지의 내장 함수를 자기 것으로 바꿔치기해 뒀다. 그대로 돌리면
 *    파서가 엉뚱한 데서 터진다("... 'attestationRequest' in null").
 *    새로 만든 틀(iframe)은 손타지 않은 깨끗한 곳이다.
 *  - 해결기가 준비 과정에서 `globalThis.location` 에 값을 넣는데, 창에서는 그게 곧
 *    페이지 이동이다. 본 화면에서 하면 유튜브가 날아간다. 틀 안이라 안전하고,
 *    답은 그전에 이미 나오므로(푸는 일은 동기다) 받자마자 틀을 치운다.
 */
/**
 * GVS(googlevideo) PO 토큰을 만든다.
 *
 * 왜 필요한가 — 유튜브가 2026-08-02 에 바꿔서, PO 토큰이 없으면 영상 **앞부분 약 60초까지만**
 * 내어준다. 그 너머는 언제나 403 이다(위치 제한이지 몫이 아니다. 기다려도 안 열린다).
 *
 * 어떻게 만드나 — 유튜브 페이지 자신이 토큰 발급기(WebPoClient)를 들고 있다. yt-dlp 같은
 * 바깥 도구는 이걸 쓰려고 브라우저를 따로 띄워야 하지만, 우리는 이미 페이지 안이라
 * 그냥 부르면 된다. 여기가 우리가 유리한 자리다.
 *
 * 무엇에 묶나 — GVS 토큰은 로그인해 있으면 계정(DATASYNC_ID), 아니면 방문자(visitorData)에
 * 묶는다(yt-dlp 의 get_webpo_content_binding 과 같은 규칙이다).
 *
 * 이 토큰은 **웹 계열 클라이언트에만 통한다.** ANDROID_VR 주소에 붙여봐야 403 그대로다
 * (안드로이드는 DroidGuard 토큰을 따로 요구한다 — 실측했다).
 */
async function mintPoToken(bind) {
  // 발급기는 유튜브가 이름을 난독화해 두었다. 없으면 실험이 안 켜진 것이다.
  const make = window.top?.["havuokmhhs-0"]?.bevasrs?.wpc;
  if (typeof make !== "function") throw new Error("토큰 발급기를 찾지 못했습니다");

  const cfg = window.ytcfg;
  const dataSync = cfg?.get?.("DATASYNC_ID");
  const visitor = cfg?.get?.("INNERTUBE_CONTEXT")?.client?.visitorData;
  // 무엇에 묶을지는 **주소를 어떻게 받았는지**로 갈린다.
  //
  // `WEB_CREATOR` 처럼 인증(SAPISIDHASH)해서 받은 주소는 계정에 묶어야 하고,
  // `TVHTML5_SIMPLY` 처럼 인증 없이 받은 주소는 로그인해 있더라도 **방문자에 묶어야 한다.**
  // 로그인 상태에서 TV 주소에 계정 토큰을 붙이면 60초 너머가 그대로 403 이다(실측).
  //
  // DATASYNC_ID 는 `계정||기기` 꼴이다. 앞쪽만 쓴다.
  const account = cfg?.get?.("LOGGED_IN") && dataSync ? dataSync.split("||")[0] : null;
  const binding = (bind === "visitor" ? visitor : account || visitor) || visitor;
  if (!binding) throw new Error("토큰을 묶을 값을 찾지 못했습니다");

  // 발급기가 아직 덥혀지지 않았으면 "backoff" 를 준다. 잠깐 두었다 다시 묻는다.
  for (let tries = 0; tries < 8; tries += 1) {
    const client = await make();
    const token = await client.mws({ c: binding, mc: false, me: false });
    if (token && token !== "backoff") return token;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("토큰 발급기가 준비되지 않았습니다");
}

async function solveChallenges({ lib, core, challenges }) {
  if (!playerSource) {
    // 여러 번 겹쳐 불려도 2~3MB 짜리 플레이어를 한 번만 받는다.
    // 받아오는 중에 또 불리면 같은 약속을 함께 기다린다.
    if (!playerSourceLoading) {
      playerSourceLoading = (async () => {
        const jsUrl = window.ytcfg?.get?.("PLAYER_JS_URL");
        if (!jsUrl) throw new Error("플레이어 주소를 찾지 못했습니다");
        return (await fetch(jsUrl, { credentials: "same-origin" })).text();
      })();
    }
    try {
      playerSource = await playerSourceLoading;
    } finally {
      playerSourceLoading = null;
    }
  }

  const frame = document.createElement("iframe");
  frame.style.display = "none";
  document.documentElement.appendChild(frame);
  try {
    const realm = frame.contentWindow;
    // 해결기는 자기 안에서도 코드를 만들어 돌린다. 우리 손을 거치지 않으므로
    // 이 틀에만 기본 정책을 깔아 통과시킨다. 유튜브 본 화면은 그대로다.
    const policy = realm.trustedTypes?.createPolicy("default", {
      createScript: (text) => text,
      createScriptURL: (url) => url,
      createHTML: (html) => html,
    });
    const run = (source) => (policy ? realm.eval(policy.createScript(source)) : realm.eval(source));

    // 전역을 더럽히지 않도록 파서를 인자로 넘긴다.
    const parsers = run(`(function () {${lib};return lib; })`)();
    const solve = run(`(function (meriyah, astring) {${core};return jsc; })`)(
      parsers.meriyah,
      parsers.astring,
    );

    const result = solve({
      type: "player",
      player: playerSource,
      requests: [{ type: "n", challenges }],
    });
    if (result?.type === "error") throw new Error(result.error || "해결기 오류");
    const first = result.responses?.[0];
    if (first?.type !== "result") throw new Error(first?.error || "n 을 풀지 못했습니다");
    return first.data;
  } finally {
    frame.remove();
  }
}

// 확장이 스스로 갱신하면 이 다리도 다시 놓인다(열린 탭에 새 판이 들어온다).
// 옛 다리가 남아 있으면 요청 하나에 두 번 답해서 같은 것을 두 번 받아온다.
window.__ytdlPageTeardown?.();

async function onMessage(event) {
  if (event.source !== window) return;
  const message = event.data;

  if (message?.ytdl === "solve") {
    try {
      const answers = await solveChallenges(message);
      window.postMessage({ ytdl: "response", id: message.id, ok: true, answers }, "*");
    } catch (error) {
      window.postMessage({
        ytdl: "response",
        id: message.id,
        ok: false,
        status: 0,
        error: String(error?.message || error),
      }, "*");
    }
    return;
  }

  if (message?.ytdl === "pot") {
    try {
      const token = await mintPoToken(message.bind);
      window.postMessage({ ytdl: "response", id: message.id, ok: true, token }, "*");
    } catch (error) {
      window.postMessage({
        ytdl: "response",
        id: message.id,
        ok: false,
        status: 0,
        error: String(error?.message || error),
      }, "*");
    }
    return;
  }

  // STS(signatureTimestamp). 페이지 쪽에만 있는 값인데, 로그아웃에서 쓰는
  // TVHTML5_SIMPLY 는 이게 없으면 주소를 하나도 주지 않는다.
  if (message?.ytdl === "sts") {
    const sts = Number(window.ytcfg?.get?.("STS")) || 0;
    window.postMessage({ ytdl: "response", id: message.id, ok: true, sts }, "*");
    return;
  }

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
}

window.addEventListener("message", onMessage);

window.__ytdlPageTeardown = () => {
  window.__ytdlPageTeardown = null;
  window.removeEventListener("message", onMessage);
  clearInterval(progressTimer);
  progressTimer = null;
};

})();
// 유튜브 영상 페이지의 좋아요·공유 줄에 "구간 받기" 버튼을 넣고,
// 누르면 영상 아래에 구간 편집 패널을 펼친다.
//
// 숏츠도 같은 방식으로 받는다. 화면 생김새만 달라서(오른쪽 세로 버튼 줄, 아래 정보칸 없음)
// 버튼은 그 세로 줄에 넣고 패널은 화면 아래에 띄운다. 받는 일 자체는 똑같다.
//
// content script 는 확장의 격리된 세계에서 돌지만 네트워크는 페이지(youtube.com) 몫으로 나간다.
// 덕분에 InnerTube 는 동일 출처로, 미디어는 Range 를 허용하는 CORS 로 그대로 받을 수 있다.
//
// 이 스크립트는 **유튜브의 모든 화면**에 붙는다(영상 주소만 고르지 않는다).
// 유튜브는 한 번 띄운 뒤로 화면만 갈아 끼우는데(SPA), 그때 크롬은 content script 를
// 다시 넣어주지 않는다. 영상 주소만 골라 붙이면 홈에서 영상을 눌러 들어갔을 때
// 아무것도 붙지 않아서, F5 를 눌러야 버튼이 떴다. 대신 영상 화면이 아닐 때는
// `mount()` 가 얹은 것을 걷어내고 아무 일도 하지 않는다.

(async () => {
  // 붙었는지 콘솔에서 바로 알 수 있게 한 줄 남긴다.
  // 이게 안 보이면 확장이 이 페이지에 붙지 않은 것이다(새로고침이나 재로드가 필요하다).
  const say = (...parts) => console.info("[yt-download]", ...parts);

  // 이 판을 걷어낼 때 할 일들.
  //
  // 확장이 스스로 갱신하면 배경 일꾼이 열려 있는 탭에 새 판을 곧바로 넣는다(F5 가 필요 없게).
  // 그때 옛 판이 그대로 남아 있으면 버튼과 패널이 둘씩 생기고 타이머도 두 벌 돈다.
  // 그래서 새 판은 들어오자마자 옛 판에게 물러나라고 한다.
  //
  // 알리는 길이 둘인 이유: 다시 켜진 확장은 **격리된 세계가 새로 만들어져서** 옛 판의
  // 전역 변수가 보이지 않는다(실제로 그래서 버튼이 둘 생겼다). DOM 은 두 세계가 함께 보므로
  // 이벤트로 알린다. 같은 세계에 다시 얹히는 경우를 위해 전역 표시도 함께 둔다.
  const STAND_DOWN = "ytdl-stand-down";
  const cleanup = [];
  window.dispatchEvent(new Event(STAND_DOWN));
  window.__ytdlTeardown?.();
  window.__ytdlTeardown = () => {
    window.__ytdlTeardown = null;
    for (const undo of cleanup.splice(0)) {
      try {
        undo();
      } catch {
        // 걷어내다 하나가 실패해도 나머지는 걷어내야 한다.
      }
    }
  };

  // 이 스크립트는 두 자리에서 돈다.
  //  - 확장: 격리된 세계. 모듈은 확장 주소로 하나씩 불러온다.
  //  - 북마클릿: 페이지 안. 확장 주소가 없으므로 번들이 미리 넣어둔 것을 그대로 쓴다.
  //
  // 어느 쪽인지는 **번들이 있는지**로 가른다. `chrome.runtime` 으로 가르면 안 된다 —
  // 확장이 깔린 브라우저에서는 페이지 쪽에도 `chrome.runtime` 이 있어서, 북마클릿이
  // 확장인 척하고 있지도 않은 배경 일꾼에게 조각을 부탁하게 된다.
  const bundled = window.__ytdlModules || null;
  const runtime = bundled ? null : chrome.runtime;
  const load = (name) => (bundled ? bundled[name] : import(runtime.getURL(`src/${name}`)));
  const [
    { downloadSection, downloadTrack, downloadClips, getFormats, safeFileName, clockLabel, createControl, Stopped },
    innertube,
    net,
    nsig,
    store,
  ] =
    await Promise.all([
      load("download.js"),
      load("innertube.js"),
      load("net.js"),
      load("nsig.js"),
      load("store.js"),
    ]);

  // 그만둔 이어받기 조각과 완성본 찌꺼기가 디스크(OPFS)에 눌러앉지 않게 이따금 청소한다.
  store.cleanup().catch(() => {});

  // 다운로드 속도 계량기. 통로를 지나간 바이트를 최근 8초 창으로 재서 속도를 만든다.
  // 누적치(bytes)는 받는 쪽이 용량을 알려주지 않을 때의 예비 표시로 쓴다.
  const meter = { events: [], bytes: 0 };
  const METER_WINDOW = 8000;
  const meterAdd = (count) => {
    meter.events.push({ at: Date.now(), count });
    meter.bytes += count;
  };
  const meterSpeed = () => {
    const now = Date.now();
    while (meter.events.length && now - meter.events[0].at > METER_WINDOW) meter.events.shift();
    if (!meter.events.length) return 0;
    const span = Math.max(1000, now - meter.events[0].at);
    return meter.events.reduce((sum, event) => sum + event.count, 0) / (span / 1000);
  };

  // 남은 시간 어림. 진행량의 최근 증가 속도로 잰다 — 진행량이 바이트(일반 영상)든
  // 조각 개수(라이브)든 똑같이 통해서, 어느 쪽에서도 예상 시간을 보여줄 수 있다.
  const pace = { events: [] };
  const PACE_WINDOW = 15_000;
  const paceAdd = (done) => {
    pace.events.push({ at: Date.now(), done });
  };
  const paceRemaining = (done, total) => {
    const now = Date.now();
    while (pace.events.length && now - pace.events[0].at > PACE_WINDOW) pace.events.shift();
    if (pace.events.length < 2) return null;
    const first = pace.events[0];
    const last = pace.events[pace.events.length - 1];
    const rate = ((last.done - first.done) / Math.max(1, last.at - first.at)) * 1000;
    if (rate <= 0) return null;
    return (total - done) / rate;
  };

  // 미디어는 페이지 쪽에서 받아온다. 확장에서 곧바로 부르면 교차 출처로 막히고,
  // 배경 일꾼으로 보내면 Origin 이 붙어 InnerTube 가 403 을 준다.
  // youtube.com 은 여기가 동일 출처라 그대로 부른다.
  const direct = net.directTransport();
  const viaPage = net.pageTransport();
  // 북마클릿은 이미 페이지 안이라 다리를 건널 것 없이 그대로 부르면 된다.
  // 대신 배경 일꾼이 없어서 CORS 로 막히면 예비 통로가 없다(alr 안내와 재시도로 버틴다).
  const media = runtime
    ? net.withFallback(viaPage.bytes, net.workerBytes(runtime))
    : direct.bytes;
  net.useTransport({
    json: direct.json,
    text: direct.text,
    // googlevideo 가 다른 호스트로 넘길 때 302 를 타면 페이지 쪽이 CORS 로 막힌다.
    // 그래서 alr=yes 로 "본문 안내" 를 받아 리다이렉트 자체를 피한다(withAppRedirect).
    // 그래도 막히면 배경 일꾼이 대신 받아온다(느리지만 확실하다 — withFallback).
    // 라이브 조각은 서버가 일시적으로 503 을 주는 일이 흔해서, 어느 통로든
    // 일시적인 실패는 잠깐 쉬었다 몇 번 더 받아 본다.
    bytes: net.withMeter(net.withRetry(net.withAppRedirect(media)), meterAdd),
    // SABR 은 POST 다. 위 껍데기들(재시도·alr 안내)은 GET 으로 범위를 받는 길에 맞춰져
    // 있어 여기에는 씌우지 않는다. 확장에서는 페이지 다리를, 북마클릿에서는 그냥 부른다.
    post: runtime ? viaPage.post : direct.post,
  });

  const state = {
    videoId: null,
    formats: null,
    start: 0,
    end: 0,
    busy: false,
    open: false,
    drag: null,
    saveTimer: null,
    // 사용자가 구간을 직접 정했는지. 그 전에는 길이를 알게 될 때마다 전 구간으로 맞춰준다.
    touched: false,
    // 페이지 쪽 플레이어가 알려준 재생 위치·되감기 구간.
    progress: null,
    // 받는 중에 멈추거나 그만두게 해주는 손잡이.
    control: null,
    // 받다 만 조각이 디스크에 남아 있는지. 버리기 버튼을 보일지 정한다.
    hasLeftovers: false,
    // 방금 저장을 마쳤는지. "폴더 열기" 버튼을 보일지 정한다.
    saved: false,
    // 담아둔 구간 목록. 오른쪽 딸림창에 선다.
    clips: [],
    // 지금 편집 중인 구간. 목록에서 고른 것이 여기 들어오고, 시각을 고치면 함께 바뀐다.
    activeClip: null,
    // 조각이 남아 있는 영상들. 왼쪽 딸림창에 선다.
    leftovers: [],
    // 딸림창을 접어 뒀는지. 담긴 것이 있어도 접혀 있으면 안 보인다.
    clipsShut: false,
    leftoversShut: false,
    // 남은 조각을 이 영상 것만 볼지, 이 브라우저에 쌓인 것을 전부 볼지.
    leftoversAll: false,
    // 받을 내용(영상+소리 / 영상만 / 소리만). 마지막 선택을 기억한다.
    media: savedMediaMode(),
    // 끝점을 "끝까지"로 둔 상태. 라이브면 방송이 진행되는 만큼 따라간다.
    toEnd: false,
    // 지금 붙어 있는 화면 종류("watch" 또는 "shorts"). 바뀌면 붙일 자리를 다시 잡는다.
    mode: null,
    // 옆에 선 유튜브 버튼을 재서 치수를 맞췄는지. 못 쟀으면 다음 차례에 다시 해본다.
    matched: false,
    // 띄운 패널을 끌고 있는 중인지, 그리고 사용자가 한 번이라도 직접 옮겼는지.
    panelDrag: null,
    panelMoved: false,
    // 구간 손잡이를 놓았을 때 영상을 옮겨줄 지점.
    dropAt: null,
  };

  /** 걷어낼 때 같이 떼어내도록 붙여둔다. */
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  // 나중에 들어온 판이 물러나라고 하면 물러난다.
  listen(window, STAND_DOWN, () => window.__ytdlTeardown?.());

  // 패널이 열려 있는 동안만 페이지에게 재생 상태를 받아온다.
  listen(window, "message", (event) => {
    if (event.source !== window || event.data?.ytdl !== "progress") return;
    const before = state.progress;
    state.progress = {
      start: event.data.start,
      end: event.data.end,
      current: event.data.current,
      live: event.data.live,
    };
    // 이 값이 어느 시점의 것인지 함께 적어 둔다. 사이를 메우는 데 쓴다(playedSeconds).
    state.progressAt = Number(player()?.currentTime);
    // 처음 알게 됐거나 길이가 달라졌을 때만 다시 그린다(매 400ms 그리면 낭비다).
    const changed = !before || before.end !== state.progress.end ||
      before.current !== state.progress.current;
    if (changed && state.open) renderTimeline();
  });

  const watchProgress = (on) => window.postMessage({ ytdl: "watch-progress", on }, "*");

  const el = {};

  // 유튜브는 Trusted Types 를 강제해서 innerHTML 을 막는다. 노드를 직접 만들어 붙인다.
  function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  }

  // 받을 내용 선택은 영상과 무관한 취향이라 하나만 기억한다.
  const MEDIA_KEY = "ytdl-media-mode";

  function savedMediaMode() {
    try {
      const value = localStorage.getItem(MEDIA_KEY);
      return value === "video" || value === "audio" ? value : "merged";
    } catch {
      return "merged";
    }
  }

  function saveMediaMode(value) {
    try {
      localStorage.setItem(MEDIA_KEY, value);
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
  }

  // 골라둔 구간을 영상별로 기억한다. 실수로 창을 닫거나 다른 영상에 갔다 와도 그대로 남는다.
  const SAVED_KEY = "ytdl-sections";
  const SAVED_LIMIT = 200;

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveRange() {
    if (!state.videoId) return;
    try {
      const all = readSaved();
      all[state.videoId] = {
        start: state.start,
        end: state.end,
        toEnd: state.toEnd,
        at: Date.now(),
      };
      // 오래된 것부터 버려서 저장 공간이 넘치지 않게 한다.
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, SAVED_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(SAVED_KEY, JSON.stringify(trimmed));
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
  }

  // 담아둔 구간 목록도 영상별로 기억한다. 여러 구간을 잡아두는 일은 한 번에 끝나지 않는다 —
  // 창을 닫거나 다른 영상에 갔다 와도 그대로 있어야 쓸모가 있다.
  const CLIPS_KEY = "ytdl-clips";
  const CLIPS_LIMIT = 50;

  function readClipStore() {
    try {
      return JSON.parse(localStorage.getItem(CLIPS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveClipList() {
    if (!state.videoId) return;
    try {
      const all = readClipStore();
      if (state.clips.length) {
        all[state.videoId] = {
          at: Date.now(),
          clips: state.clips.map((clip) => ({
            start: clip.start,
            end: clip.end,
            picked: clip.picked,
            mode: clip.mode,
            itag: clip.itag,
          })),
        };
      } else {
        delete all[state.videoId];
      }
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, CLIPS_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(CLIPS_KEY, JSON.stringify(trimmed));
    } catch {
      // 저장 공간이 막혀 있어도 기능 자체는 계속 쓸 수 있어야 한다.
    }
  }

  function savedClips(videoId) {
    const saved = readClipStore()[videoId];
    if (!saved?.clips?.length) return [];
    return saved.clips
      .filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start)
      .map((clip) => ({ ...clip, id: (state.clipSeq = (state.clipSeq || 0) + 1) }));
  }

  // 남은 조각 목록에 영상 제목을 보여주려고 기억해 둔다. 저장소에는 영상 ID 밖에 없는데,
  // ID 만 늘어놓으면 어느 영상인지 알 수 없다.
  const TITLE_KEY = "ytdl-titles";
  const TITLE_LIMIT = 200;

  function rememberTitle(videoId, title) {
    if (!videoId || !title) return;
    try {
      const all = JSON.parse(localStorage.getItem(TITLE_KEY) || "{}");
      all[videoId] = { title, at: Date.now() };
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const key of keys.slice(0, TITLE_LIMIT)) trimmed[key] = all[key];
      localStorage.setItem(TITLE_KEY, JSON.stringify(trimmed));
    } catch {
      // 못 적어도 ID 로 보여주면 된다.
    }
  }

  function knownTitle(videoId) {
    try {
      return JSON.parse(localStorage.getItem(TITLE_KEY) || "{}")[videoId]?.title || "";
    } catch {
      return "";
    }
  }

  // 저장이 실제로 끝났는지 기억해 둔다. 확장에서만 알 수 있다(브라우저가 알려준다).
  const DONE_KEY = "ytdl-saved";

  function markSaved(videoId, key, ok) {
    try {
      const all = JSON.parse(localStorage.getItem(DONE_KEY) || "{}");
      all[`${videoId}|${key}`] = { ok, at: Date.now() };
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      const trimmed = {};
      for (const k of keys.slice(0, 200)) trimmed[k] = all[k];
      localStorage.setItem(DONE_KEY, JSON.stringify(trimmed));
    } catch {
      // 못 적어도 파일은 목록에 남는다.
    }
  }

  function savedMark(videoId, key) {
    try {
      return JSON.parse(localStorage.getItem(DONE_KEY) || "{}")[`${videoId}|${key}`]?.ok;
    } catch {
      return undefined;
    }
  }

  function savedRange(videoId) {
    const saved = readSaved()[videoId];
    if (!saved || !Number.isFinite(saved.start) || !Number.isFinite(saved.end)) return null;
    return saved.end > saved.start ? saved : null;
  }

  function currentVideoId() {
    const url = new URL(location.href);
    // /live/<id> 와 /shorts/<id> 는 주소 자체가 영상 ID 다.
    if (url.pathname.startsWith("/live/") || url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/")[2] || null;
    }
    return url.searchParams.get("v");
  }

  function isShorts() {
    return location.pathname.startsWith("/shorts/");
  }

  /** 영상 화면인지. 홈·검색·채널 같은 데서는 얹을 것이 없다. */
  function isVideoPage() {
    const path = location.pathname;
    return path === "/watch" || path.startsWith("/live/") || path.startsWith("/shorts/");
  }

  /**
   * 지금 보고 있는 숏츠 한 편.
   *
   * 편을 넘겨도 `ytd-reel-video-renderer` 는 하나뿐이고 유튜브가 그 안을 갈아 끼운다.
   * 표시용 속성(`is-active` 같은 것)은 이 버전에 없어서, 플레이어가 들어 있는 쪽을
   * 지금 보는 편으로 본다. 이름이 바뀌어도 플레이어는 하나라 이 방법이 오래 간다.
   */
  function activeReel() {
    const shortsPlayer = document.querySelector("#shorts-player");
    return (
      shortsPlayer?.closest("ytd-reel-video-renderer") ||
      document.querySelector("ytd-reel-video-renderer")
    );
  }

  // 숏츠는 다음 편을 미리 붙여 두기 때문에 <video> 가 여러 개 있다.
  // 아무거나 집으면 보고 있지 않은 영상의 시간을 읽게 된다.
  function player() {
    if (isShorts()) {
      const inPlayer = document.querySelector("#shorts-player video");
      if (inPlayer) return inPlayer;
      const inReel = activeReel()?.querySelector("video");
      if (inReel) return inReel;
    }
    return document.querySelector(".html5-main-video") || document.querySelector("video");
  }

  /**
   * 타임라인이 다룰 구간. 대개 0~길이지만 라이브는 다르다.
   *
   * 라이브에서 `video.seekable` 과 `duration` 은 믿을 수 없다. 실제 되감기 구간보다
   * 한 시간쯤 앞을 가리켜서, 라이브 지점을 보고 있는데도 막대가 중간에 놓인다.
   * (14시간짜리 방송에서 잰 값: seekable 끝 50400, 실제 라이브 지점 46813)
   * 플레이어가 가진 값이 정확하므로 페이지 쪽에서 받아온 걸 먼저 쓴다.
   */
  function bounds() {
    if (state.progress) return { start: state.progress.start, end: state.progress.end };

    const video = player();
    const known = Number(video?.duration);
    if (Number.isFinite(known) && known > 0) return { start: 0, end: known };

    const fallback = Number(state.formats?.durationSeconds) || 0;
    return { start: 0, end: fallback };
  }

  /**
   * 지금 재생 중인 지점.
   *
   * 라이브에서는 플레이어가 알려준 값이라야 정확하다(영상 요소의 `currentTime` 은 방송
   * 전체가 아니라 지금 받아둔 창 안의 자리를 가리킨다). 그런데 그 값은 페이지에서
   * 0.4초에 한 번만 건너온다 — 그대로 쓰면 1/100초까지 적는 시계가 뚝뚝 끊긴다.
   *
   * 그래서 마지막으로 받은 값과, 그때의 `currentTime` 을 함께 기억해 두고 그 뒤로 흐른
   * 만큼을 더한다. 0.4초마다 값이 다시 오므로 어긋나도 그때 바로잡힌다.
   */
  function playedSeconds() {
    let now = Number(player()?.currentTime);
    // 우리가 옮긴 뒤로 움직이지 않았다면, 화면에 뜬 장의 시각을 쓴다. 한 장 이동은
    // 장 사이로 건너뛰어 보내므로 `currentTime` 그대로 적으면 없는 시각이 뜬다.
    const frame = state.shownFrame;
    if (frame && Number.isFinite(now) && Math.abs(now - frame.at) < 1e-3) now = frame.media;
    if (state.progress) {
      if (Number.isFinite(now) && Number.isFinite(state.progressAt)) {
        return state.progress.current + (now - state.progressAt);
      }
      return state.progress.current;
    }
    return Number.isFinite(now) ? now : 0;
  }

  function boundsSpan() {
    const { start, end } = bounds();
    return Math.max(0, end - start);
  }

  /**
   * 사람이 적은 시각을 초로 읽는다. `1:03.16`, `63.16`, `1:02:03.5` 를 모두 받는다.
   *
   * 빈 칸과 음수는 거절한다(`Number("")` 이 0 이라 그냥 두면 빈 칸이 0초로 들어간다).
   */
  function parseClock(text) {
    const raw = String(text).trim();
    if (!raw) return null;
    const parts = raw.split(":");
    if (parts.length > 3 || parts.some((part) => !part.trim())) return null;
    const numbers = parts.map(Number);
    if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
    return numbers.reduce((total, part) => total * 60 + part, 0);
  }

  /**
   * 초를 시:분:초로 적는다. `decimals` 를 주면 소수점 아래까지 적는다(예: `1:03.16`).
   *
   * 구간은 프레임 단위로 다뤄야 해서 소수점이 필요하지만, 남은 시간 같은 어림값에
   * 소수점을 붙이면 눈만 어지럽다. 그래서 부르는 쪽이 자릿수를 정한다.
   *
   * 반올림은 쪼개기 **전에** 한 번만 한다. 나중에 하면 59.996초가 `59.100` 으로 적힌다.
   */
  function showClock(seconds, decimals = 0) {
    const step = 10 ** decimals;
    const total = Math.round(Math.max(0, Number(seconds) || 0) * step) / step;
    const whole = Math.floor(total);
    const h = Math.floor(whole / 3600);
    const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    const s = String(whole % 60).padStart(2, "0");
    const clock = h ? `${h}:${m}:${s}` : `${m}:${s}`;
    if (decimals <= 0) return clock;
    const frac = String(Math.round((total - whole) * step)).padStart(decimals, "0");
    return `${clock}.${frac}`;
  }

  /**
   * 내려받기 아이콘. 글자(↧)로 그리면 글꼴마다 굵기와 자리가 달라 옆 버튼들과 따로 논다.
   *
   * 이 그림은 **유튜브가 자기 화면에서 쓰는 그것 그대로다**(왼쪽 목록의 "오프라인 저장
   * 동영상"에서 그대로 가져왔다). 비슷하게 새로 그리면 선 굵기와 끝 모양이 미묘하게
   * 달라서 나란히 놓았을 때 티가 난다(실제로 티가 났다 — 유튜브의 옛 얇은 아이콘을
   * 억지로 키워 썼더니 선만 두꺼워졌다).
   *
   * 24 틀에서 세로로 2~22 를 차지한다. 재보니 유튜브가 이 줄에 쓰는 아이콘들도 20~21 이라
   * 크기를 따로 맞출 것이 없다.
   */
  const DOWNLOAD_PATH =
    "M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 " +
    "10-1.414-1.414L13 14.586V3a1 1 0 00-1-1Zm7 18H5a1 1 0 000 2h14a1 1 0 000-2Z";

  /**
   * 한 장 이동 아이콘. 편집 프로그램에서 쓰는 모양 그대로 — 막대에 삼각형이 붙어 있다.
   * 막대가 "여기서 멈춘다", 삼각형이 "이쪽으로 한 칸"을 뜻한다.
   *
   * 글자(‹ ›)로 그리면 그냥 화살표로 보여서 한 장씩 간다는 뜻이 드러나지 않는다.
   */
  function frameIcon(back) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      back
        ? "M12.2 3.4v9.2L5.6 8l6.6-4.6ZM3.2 3.2h1.6v9.6H3.2Z"
        : "M3.8 3.4v9.2L10.4 8 3.8 3.4ZM11.2 3.2h1.6v9.6h-1.6Z",
    );
    svg.append(path);
    return svg;
  }

  function downloadIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", DOWNLOAD_PATH);
    svg.append(path);
    return svg;
  }

  // 유튜브의 좋아요·공유 버튼과 나란히 설 버튼.
  // 숏츠에서는 오른쪽 세로 줄에 들어가므로 아이콘만 있는 동그란 모양으로 바꾼다.
  function buildButton(shorts) {
    const icon = make("span", { class: "ytdl-open-icon" }, [downloadIcon()]);
    icon.setAttribute("aria-hidden", "true");
    const button = make(
      "button",
      {
        id: "ytdl-open",
        class: shorts ? "ytdl-open ytdl-open-reel" : "ytdl-open",
        type: "button",
        title: "이 영상의 원하는 구간만 받기",
      },
      [icon, make("span", { class: "ytdl-open-label", text: shorts ? "구간" : "구간 받기" })],
    );
    button.addEventListener("click", togglePanel);
    return button;
  }

  // 타임라인: 전체 길이를 가로줄로 놓고 IN/OUT 손잡이와 재생 위치를 얹는다.
  // 손잡이를 끌면 영상이 그 지점으로 따라가서, 유튜브 화면 자체가 미리보기가 된다.
  function buildTimeline() {
    el.range = make("div", { class: "ytdl-range" });
    el.headMark = make("div", { class: "ytdl-head-mark" });
    el.inHandle = make("div", { class: "ytdl-handle ytdl-in", title: "시작점" });
    el.outHandle = make("div", { class: "ytdl-handle ytdl-out", title: "끝점" });
    el.track = make("div", { class: "ytdl-track" }, [
      el.range,
      el.headMark,
      el.inHandle,
      el.outHandle,
    ]);

    const seconds = (event) => {
      const box = el.track.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / Math.max(1, box.width);
      const { start, end } = bounds();
      return start + Math.max(0, Math.min(1, ratio)) * Math.max(0, end - start);
    };

    const startDrag = (what) => (event) => {
      // 길이를 아직 모르면 아무 데나 눌러도 0초로 튀어버린다. 그 전에는 받지 않는다.
      if (boundsSpan() <= 0) return;
      event.preventDefault();
      el.track.setPointerCapture(event.pointerId);
      state.drag = what;
      onDrag(event);
    };

    const onDrag = (event) => {
      if (!state.drag) return;
      const value = seconds(event);
      if (state.drag === "in") setRange(value, state.end);
      else if (state.drag === "out") setRange(state.start, value);

      if (state.drag === "seek") {
        // 재생 위치를 끄는 중이라면 영상이 곧바로 따라가야 한다.
        seek(value);
      } else {
        // 구간 손잡이는 놓을 때 한 번만 옮긴다. 끄는 내내 영상이 따라다니면
        // 되감기가 이어지면서 화면이 어지럽고, 어디를 잡았는지도 잘 안 보인다.
        state.dropAt = value;
      }
    };

    const dropDrag = () => {
      const what = state.drag;
      const at = state.dropAt;
      state.drag = null;
      state.dropAt = null;
      if (!what) return;
      // 끌어 정한 자리도 장에 맞춘다. 손잡이는 화면 위 한 점이라 장 사이에 떨어지는데,
      // 그대로 두면 칸에 뜬 숫자와 실제로 받는 장이 어긋난다.
      if (what !== "seek" && at !== null) {
        seekToFrame(at).then(({ media }) => {
          setRange(what === "in" ? media : state.start, what === "out" ? media : state.end);
        });
      }
    };

    el.inHandle.addEventListener("pointerdown", startDrag("in"));
    el.outHandle.addEventListener("pointerdown", startDrag("out"));
    el.track.addEventListener("pointerdown", (event) => {
      if (event.target === el.inHandle || event.target === el.outHandle) return;
      startDrag("seek")(event);
    });
    el.track.addEventListener("pointermove", onDrag);
    el.track.addEventListener("pointerup", dropDrag);
    el.track.addEventListener("pointercancel", dropDrag);

    return el.track;
  }

  // 영상 위치는 사용자가 타임라인을 직접 끌 때만 옮긴다.
  // 시간 칸을 고치거나 목록을 불러오는 것만으로 재생 위치가 바뀌면 성가시다.
  /**
   * 제목 줄 시계를 화면 새로 고침에 맞춰 갱신한다.
   *
   * `timeupdate` 는 1초에 네 번쯤만 온다 — 1/100초까지 적는 칸에는 너무 성기다.
   * 대신 값이 실제로 바뀔 때만 글자를 다시 써서, 매 프레임 DOM 을 건드리지는 않는다.
   */
  function runClock(on) {
    cancelAnimationFrame(state.clockFrame || 0);
    state.clockFrame = 0;
    if (!on) return;
    const tick = () => {
      if (!state.open || !el.now || !el.now.isConnected) {
        state.clockFrame = 0;
        return;
      }
      const at = playedSeconds();
      // 고쳐 넣는 중이면 손대지 않는다. 커서가 튀고 글자가 지워진다.
      if (document.activeElement !== el.now) {
        const text = showClock(at, 2);
        if (el.now.value !== text) el.now.value = text;
      }
      // 타임라인의 재생 위치 표시도 같은 박자로 움직여야 따로 놀지 않는다.
      if (el.headMark) {
        const edge = bounds();
        const span = edge.end - edge.start;
        if (span > 0) {
          const ratio = Math.max(0, Math.min(at - edge.start, span)) / span;
          el.headMark.style.left = `${ratio * 100}%`;
        }
      }
      state.clockFrame = requestAnimationFrame(tick);
    };
    state.clockFrame = requestAnimationFrame(tick);
  }

  function seek(seconds) {
    const video = player();
    if (video && Number.isFinite(seconds) && boundsSpan() > 0) video.currentTime = seconds;
  }

  /**
   * 그 시각으로 영상을 옮기고, **실제로 화면에 뜬 프레임**의 시각을 돌려준다.
   *
   * 영상은 프레임 단위로만 존재한다(30fps 면 33.37ms 마다 한 장). 그래서 `7.14` 처럼
   * 적어 넣으면 화면에 뜨는 것은 그보다 조금 앞선 장이고, 받는 파일도 그 장부터 시작한다.
   * 여기서 실제 값을 받아 칸에 되적으면 눈에 보이는 숫자와 받을 파일이 어긋나지 않는다.
   *
   * `requestVideoFrameCallback` 이 **새로 그려진** 장의 정확한 시각을 알려준다. 여기서
   * "새로"가 중요하다 — 같은 장 안으로 옮기면 다시 그릴 것이 없어 콜백이 아예 오지 않는다.
   * 그때 `seeked` 가 주는 값(= 우리가 요청한 자리)을 장 시각으로 쓰면 실제로는 없는 시각이
   * 된다. 실측으로 겪었다: 한 장 이동이 13ms 만 움직이고 멈춰, 시계가 흔들려 보였다.
   * 그래서 콜백이 왔는지를 `fresh` 로 함께 알린다.
   *
   * @returns {Promise<{media: number, fresh: boolean}>}
   *   `fresh` 가 거짓이면 장이 바뀌지 않은 것이다(또는 콜백을 받지 못한 것이다).
   */
  function seekToFrame(seconds) {
    const video = player();
    if (!video || !Number.isFinite(seconds)) {
      return Promise.resolve({ media: seconds, fresh: false });
    }
    video.currentTime = seconds;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (media, fresh) => {
        if (settled) return;
        settled = true;
        const at = Number(video.currentTime);
        // 장이 그대로면 시각은 두고 "어느 자리에서 본 것인지"만 새로 적는다.
        // 그래야 시계가 계속 그 장의 시각을 적는다.
        if (fresh) state.shownFrame = { media, at };
        else if (state.shownFrame) state.shownFrame = { media: state.shownFrame.media, at };
        resolve({ media: fresh ? media : (state.shownFrame?.media ?? seconds), fresh });
      };
      video.requestVideoFrameCallback?.((_, info) => finish(info.mediaTime, true));
      // 새 장이면 콜백이 `seeked` 보다 먼저 온다(실측 6~10ms 대 12~16ms). 그래도 조금 더
      // 기다렸다 끊는다 — 같은 장이면 콜백은 영영 오지 않으므로 여기서 끝내야 한다.
      video.addEventListener("seeked", () => setTimeout(() => finish(null, false), 50), {
        once: true,
      });
      setTimeout(() => finish(null, false), 500);
    });
  }

  /**
   * 한 장 앞이나 뒤로 옮긴다. 유튜브도 `,` `.` 로 같은 일을 하지만 아는 사람이 드물다.
   *
   * 화질 목록이 알려주는 프레임률은 정확하지 않다 — 29.97 을 30 이라고 적어 보낸다.
   * 그래서 한 번에 크게 뛰지 않고 조금씩 밀어 보며, **새 장이 그려지면** 멈춘다.
   * 크게 뛰면 두 장을 건너뛰고, 작게만 뛰면 제자리다.
   */
  async function stepFrame(direction) {
    const video = player();
    if (!video || boundsSpan() <= 0) return;
    // 재생 중에는 옮겨봐야 곧 흘러가 버린다. 유튜브의 `,` `.` 도 멈춘 뒤에야 뜻이 있다.
    video.pause();
    const fps = Number(qualityChoices()[0]?.fps) || 30;
    const edge = bounds();
    const from = (await seekToFrame(video.currentTime)).media;
    for (let step = 1; step <= 8; step += 1) {
      const to = from + (direction * step * 0.4) / fps;
      const limited = Math.max(edge.start, Math.min(to, edge.end));
      const landed = await seekToFrame(limited);
      if (landed.fresh && Math.abs(landed.media - from) > 1e-4) return;
      if (limited <= edge.start || limited >= edge.end) return;
    }
  }


  function buildPanel(floating) {
    el.inputs = {
      start: make("input", { class: "ytdl-time", value: "0:00.00", dataset: { time: "start" } }),
      end: make("input", { class: "ytdl-time", value: "0:00.00", dataset: { time: "end" } }),
    };
    // 편집 프로그램에서 쓰는 대괄호 표시를 그대로 쓴다(I/O 단축키도 같이 받는다).
    const markIn = make("button", {
      class: "ytdl-mark", type: "button", text: "[", title: "지금 위치를 시작점으로 (I)",
      dataset: { mark: "start" },
    });
    const markOut = make("button", {
      class: "ytdl-mark", type: "button", text: "]", title: "지금 위치를 끝점으로 (O)",
      dataset: { mark: "end" },
    });
    // 양 끝으로 보내는 버튼. 안쪽 대괄호가 "지금 위치", 바깥 화살표가 "맨 끝"이라
    // 줄만 봐도 어느 쪽이 더 멀리 가는지 알 수 있다.
    const toStart = make("button", {
      class: "ytdl-mark", type: "button", text: "⇤", title: "시작점을 맨 앞으로 (Home)",
      dataset: { edge: "start" },
    });
    const toEnd = make("button", {
      class: "ytdl-mark", type: "button", text: "⇥", title: "끝점을 맨 끝으로 (End)",
      dataset: { edge: "end" },
    });

    el.length = make("span", { class: "ytdl-length" });
    // 받을 내용. "소리만"을 고르면 화질칸이 소리 품질 목록으로 바뀐다.
    el.media = make("select", { class: "ytdl-quality ytdl-media", title: "받을 내용" }, [
      make("option", { value: "merged", text: "영상+소리" }),
      make("option", { value: "video", text: "영상만" }),
      make("option", { value: "audio", text: "소리만" }),
    ]);
    el.media.value = state.media;
    el.media.addEventListener("change", () => {
      state.media = el.media.value;
      saveMediaMode(state.media);
      fillQuality();
      applyToActiveClip();
      render();
    });
    el.quality = make("select", { class: "ytdl-quality" }, [make("option", { text: "불러오는 중…" })]);
    el.quality.addEventListener("change", () => {
      applyToActiveClip();
      render();
    });
    el.go = make("button", { class: "ytdl-go", type: "button", text: "구간 받기", disabled: true });
    // 받는 동안에만 보이는 버튼들.
    el.hold = make("button", { class: "ytdl-hold", type: "button", text: "일시정지", hidden: true });
    el.halt = make("button", { class: "ytdl-halt", type: "button", text: "정지", hidden: true });
    el.addClip = make("button", {
      class: "ytdl-addclip", type: "button", text: "구간 담기",
      title: "지금 고른 구간을 아래 목록에 담습니다",
    });
    // 딸림창 여닫이. 담긴 것이 있을 때만 보인다.
    el.clipsToggle = make("button", { class: "ytdl-toggle", type: "button", text: "구간 목록", hidden: true });
    el.clipsToggle.addEventListener("click", () => {
      state.clipsShut = !state.clipsShut;
      render();
    });
    el.leftoversToggle = make("button", { class: "ytdl-toggle", type: "button", text: "남은 조각", hidden: true });
    el.leftoversToggle.addEventListener("click", () => {
      state.leftoversShut = !state.leftoversShut;
      if (state.leftoversShut) render();
      else refreshLeftovers().catch(() => render()); // 펼 때는 최신 목록으로
    });
    // 저장이 끝난 뒤에만 보이는 버튼. 확장에서만 쓸 수 있다(웹 페이지는 폴더를 못 연다).
    el.reveal = make("button", {
      class: "ytdl-reveal", type: "button", text: "폴더 열기", hidden: true,
      title: "저장된 파일이 있는 폴더를 엽니다",
    });
    // 받다 만 조각이 남아 있을 때만 보이는 버튼.
    el.discard = make("button", {
      class: "ytdl-discard", type: "button", text: "받던 조각 버리기", hidden: true,
      title: "이어받기용으로 남겨둔 조각을 지웁니다",
    });
    el.status = make("div", { class: "ytdl-status", text: "화질 목록을 불러오는 중입니다" });
    // 제목 줄의 시계. 왼쪽은 고쳐 넣을 수 있는 칸이라 그 자리로 바로 건너뛴다.
    el.prevFrame = make(
      "button",
      { class: "ytdl-step", type: "button", title: "한 장 앞으로 · 유튜브 단축키 ," },
      [frameIcon(true)],
    );
    el.nextFrame = make(
      "button",
      { class: "ytdl-step", type: "button", title: "한 장 뒤로 · 유튜브 단축키 ." },
      [frameIcon(false)],
    );
    el.now = make("input", {
      class: "ytdl-now",
      value: "0:00.00",
      title: "지금 재생 위치 — 고쳐 넣으면 그 자리로 갑니다",
      spellcheck: false,
    });
    el.total = make("span", { class: "ytdl-total" });

    const close = make("button", { class: "ytdl-close", type: "button", title: "닫기", text: "✕" });
    close.addEventListener("click", togglePanel);

    const clock = make("div", { class: "ytdl-clock" }, [
      el.prevFrame,
      el.now,
      el.nextFrame,
      make("span", { class: "ytdl-slash", text: "/" }),
      el.total,
    ]);
    el.prevFrame.addEventListener("click", () => stepFrame(-1));
    el.nextFrame.addEventListener("click", () => stepFrame(1));
    // 시계를 잡고 끌면 패널이 딸려 온다. 칸에 글자를 넣으려는 것이지 옮기려는 게 아니다.
    clock.addEventListener("pointerdown", (event) => event.stopPropagation());

    // 여닫이는 창 조작이라 머리줄에 둔다. 받기 줄에 섞어 두면 주 동작(구간 받기)과 경쟁한다.
    const head = make("div", { class: "ytdl-head" }, [
      make("span", { class: "ytdl-title", text: "구간 받기" }),
      clock,
      make("span", { class: "ytdl-head-tools" }, [el.clipsToggle, el.leftoversToggle]),
      close,
    ]);
    if (floating) bindPanelDrag(head);

    // 딸림창 둘. **패널과 별개의 창**이다(문서 본문에 따로 붙는다).
    //
    // 패널 안에 두면 패널의 스크롤·최대 높이에 갇혀 잘리고, 좁은 창에서는 안쪽으로 접혀
    // 버린다. 그래서 따로 띄운다. 손대기 전에는 `placeSides()` 가 패널 옆자리에 붙여 주고,
    // 머리를 잡아 끌면 그때부터 제자리를 지킨다(패널을 따라다니지 않는다).
    el.clipList = make("div", { class: "ytdl-clip-list" });
    el.clipSaveEach = make("button", { class: "ytdl-clip-btn", type: "button", text: "따로 저장" });
    el.clipSaveJoin = make("button", { class: "ytdl-clip-btn", type: "button", text: "이어붙여 저장" });
    el.clipAll = make("button", { class: "ytdl-clip-btn", type: "button", text: "모두 고르기" });
    const shutClips = make("button", { class: "ytdl-side-shut", type: "button", text: "✕", title: "접기" });
    shutClips.addEventListener("click", () => {
      state.clipsShut = true;
      render();
    });
    // 구간 목록은 **패널 안**에 둔다. 받기 줄 바로 아래에 있어야 "담고 → 받는다"가 한눈에 읽힌다.
    el.clips = make("section", { class: "ytdl-clips", hidden: true }, [
      make("div", { class: "ytdl-side-head" }, [
        make("span", { text: "구간 목록" }),
        shutClips,
      ]),
      el.clipList,
      make("div", { class: "ytdl-side-foot" }, [el.clipAll, el.clipSaveEach, el.clipSaveJoin]),
    ]);

    el.leftoverList = make("div", { class: "ytdl-leftover-list" });
    el.leftoverScope = make("button", { class: "ytdl-clip-btn", type: "button", text: "전체 보기" });
    el.leftoverScope.addEventListener("click", () => {
      state.leftoversAll = !state.leftoversAll;
      // 목록을 다시 읽는다. 다른 탭이나 다른 영상에서 쌓인 것이 그새 생겼을 수 있다.
      refreshLeftovers().catch(() => render());
    });
    el.leftoverAll = make("button", { class: "ytdl-clip-btn", type: "button", text: "모두 버리기" });
    const shutLeft = make("button", { class: "ytdl-side-shut", type: "button", text: "✕", title: "접기" });
    shutLeft.addEventListener("click", () => {
      state.leftoversShut = true;
      render();
    });
    el.leftovers = make("aside", { class: "ytdl-side ytdl-leftovers", hidden: true }, [
      make("div", { class: "ytdl-side-head" }, [
        make("span", { text: "남은 조각" }),
        shutLeft,
      ]),
      el.leftoverList,
      make("div", { class: "ytdl-side-foot" }, [el.leftoverScope, el.leftoverAll]),
    ]);

    // 숏츠에는 영상 아래에 끼워 넣을 자리가 없다. 화면 위에 띄운다.
    const panel = make("div", { class: floating ? "ytdl-panel ytdl-float" : "ytdl-panel", hidden: true }, [
      head,
      make("div", { class: "ytdl-body" }, [
        buildTimeline(),
        // 두 줄로 나눈다 — 위는 무엇을 고를지, 아래는 그걸로 무엇을 할지.
        make("div", { class: "ytdl-row" }, [
          make("span", { class: "ytdl-group" }, [
            toStart,
            markIn,
            el.inputs.start,
            make("span", { class: "ytdl-sep", text: "~" }),
            el.inputs.end,
            markOut,
            toEnd,
            el.length,
          ]),
          make("span", { class: "ytdl-group" }, [el.media, el.quality]),
        ]),
        // 받기 줄. 담기는 왼쪽, 받기는 오른쪽 — 왼쪽은 쌓는 일, 오른쪽은 끝내는 일이다.
        make("div", { class: "ytdl-row ytdl-do" }, [
          el.addClip,
          make("span", { class: "ytdl-group ytdl-actions" }, [el.go, el.reveal, el.hold, el.halt]),
        ]),
        el.clips,
        el.status,
      ]),
    ]);
    el.panel = panel;
    // 패널은 유튜브가 화면을 다시 그릴 때마다 새로 만들어진다. 딸림창은 패널의 자식이
    // 아니라 본문에 붙어 있어서, 그냥 붙이면 옛 창이 남아 **두 개가 뜬다**(실제로 그랬다).
    for (const stale of document.querySelectorAll(".ytdl-side")) stale.remove();
    document.body.append(el.leftovers);
    bindSideDrag(el.leftovers, "leftovers");

    for (const button of [markIn, markOut]) {
      button.addEventListener("click", () => markHere(button.dataset.mark));
    }
    for (const button of [toStart, toEnd]) {
      button.addEventListener("click", () => markEdge(button.dataset.edge));
    }

    for (const [which, input] of Object.entries(el.inputs)) {
      input.addEventListener("change", () => {
        // 끝칸을 비우면 "끝까지"라는 뜻으로 받는다.
        if (which === "end" && !input.value.trim()) {
          setRange(state.start, bounds().end);
          return;
        }
        const value = parseClock(input.value);
        if (value === null) {
          render();
          return;
        }
        // 적어 넣은 시각으로 영상을 옮기고, 화면에 실제로 뜬 장의 시각을 받아 그것을 쓴다.
        // 눈에 보이는 숫자와 받게 될 파일이 어긋나지 않게 하려는 것이다.
        const edge = bounds();
        seekToFrame(Math.max(edge.start, Math.min(value, edge.end))).then(({ media }) => {
          setRange(which === "start" ? media : state.start, which === "end" ? media : state.end);
        });
      });
    }

    // 지금 위치 칸. 값을 고쳐 넣으면 영상이 그 자리로 간다.
    el.now.addEventListener("change", () => {
      const value = parseClock(el.now.value);
      const edge = bounds();
      if (value === null || edge.end <= edge.start) {
        el.now.value = showClock(playedSeconds(), 2);
        return;
      }
      seekToFrame(Math.max(edge.start, Math.min(value, edge.end))).then(({ media }) => {
        if (document.activeElement !== el.now) el.now.value = showClock(media, 2);
      });
    });
    // Enter 로 확정하면 칸에서 손을 뗀다(다시 시계가 흐르기 시작한다).
    el.now.addEventListener("keydown", (event) => {
      if (event.key === "Enter") el.now.blur();
      else if (event.key === "Escape") { el.now.value = showClock(playedSeconds(), 2); el.now.blur(); }
    });
    // 칸을 누르면 통째로 잡아준다. 소수점까지 지우고 다시 쓰는 게 보통이라서다.
    el.now.addEventListener("focus", () => el.now.select());

    el.go.addEventListener("click", start);
    el.hold.addEventListener("click", () => {
      if (!state.control) return;
      if (state.control.paused) state.control.resume();
      else state.control.pause();
      render();
    });
    el.halt.addEventListener("click", () => state.control?.stop());
    el.addClip.addEventListener("click", () => {
      if (state.end - state.start < 0.05) return;
      // 구간마다 화질·내용을 따로 기억한다. 담을 때의 설정이 그 구간의 설정이 된다.
      const clip = { id: (state.clipSeq = (state.clipSeq || 0) + 1),
                     start: state.start, end: state.end, picked: true,
                     mode: state.media || "merged", itag: el.quality.value };
      state.clips.push(clip);
      // 담은 뒤에는 **편집 대상을 놓는다.** 그대로 붙들고 있으면 다음 구간을 잡으려고
      // 시각을 바꿀 때 방금 담은 구간이 덮어써진다. 고치고 싶으면 목록에서 누르면 된다.
      state.activeClip = null;
      state.clipsShut = false; // 담았으면 보여준다
      saveClipList();
      render();
    });
    el.clipAll.addEventListener("click", () => {
      const 켤까 = state.clips.some((clip) => !clip.picked);
      for (const clip of state.clips) clip.picked = 켤까;
      saveClipList();
      render();
    });
    el.clipSaveEach.addEventListener("click", () => saveClips(false));
    el.clipSaveJoin.addEventListener("click", () => saveClips(true));
    el.leftoverAll.addEventListener("click", async () => {
      // 지금 보이는 것만 버린다. "이 영상만" 보기에서 다른 영상 것까지 지우면 놀란다.
      const 대상 = state.leftoversAll
        ? state.leftovers
        : state.leftovers.filter((item) => item.videoId === state.videoId);
      for (const item of 대상) await store.discard(item.videoId);
      if (대상.some((item) => item.videoId === state.videoId)) state.hasLeftovers = false;
      await refreshLeftovers();
    });
    el.reveal.addEventListener("click", () => {
      // 배경 일꾼만 chrome.downloads 를 부를 수 있다.
      runtime?.sendMessage({ type: "reveal" }, () => void chrome.runtime.lastError);
    });
    el.discard.addEventListener("click", async () => {
      if (!state.videoId || state.busy) return;
      await store.discard(state.videoId);
      state.hasLeftovers = false;
      state.saved = false;
      setStatus("받아둔 조각을 지웠습니다");
      render();
    });
    return panel;
  }

  /**
   * 지금 자리를 시작점이나 끝점으로 찍는다.
   *
   * `video.currentTime` 을 그대로 쓰면 안 된다. 한 장 이동은 장이 바뀔 때까지 조금씩
   * 밀어 찾으므로, 멈춘 뒤 `currentTime` 은 장보다 몇 ms 뒤(마지막으로 민 자리)에 있다.
   * 그걸 찍으면 시계에 뜬 값과 다른 값이 들어간다(실측: 시계는 01:49.01, 찍힌 값은 .02).
   * `playedSeconds()` 는 화면에 뜬 장의 시각을 돌려주므로 눈에 보이는 것과 같아진다.
   */
  function markHere(which) {
    if (!player()) return;
    const now = playedSeconds();
    setRange(which === "start" ? now : state.start, which === "end" ? now : state.end);
  }

  /** 시작점을 맨 앞으로, 또는 끝점을 맨 끝으로. 라이브면 "끝"은 지금 받을 수 있는 데까지다. */
  function markEdge(which) {
    const edge = bounds();
    if (edge.end <= edge.start) return;
    if (which === "start") setRange(edge.start, state.end);
    else setRange(state.start, edge.end);
  }

  /**
   * 버튼을 넣을 자리. 숏츠는 좋아요·댓글이 있는 오른쪽 세로 줄이다.
   *
   * 그 줄은 `reel-action-bar-view-model` 이다. 일반 화면의 `#actions` 는 숏츠에도
   * 빈 껍데기로 남아 있어서 그걸 찾으면 크기 0인 자리에 버튼을 붙이게 된다(실제로 그랬다).
   */
  function buttonHost() {
    if (isShorts()) {
      const reel = activeReel();
      return (
        reel?.querySelector("reel-action-bar-view-model") ||
        reel?.querySelector(".ytReelPlayerOverlayViewModelActionsContainer") ||
        document.querySelector("reel-action-bar-view-model")
      );
    }
    return (
      document.querySelector("#actions #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner")
    );
  }

  /**
   * 옆에 선 유튜브 버튼을 재서 우리 버튼을 같은 치수로 맞춘다.
   *
   * 치수를 CSS 에 적어두면 유튜브가 버튼을 손볼 때마다 우리 것만 어긋난다(실제로 어긋났다 —
   * 높이도 색도 옆 버튼과 달랐다). 그래서 그 줄에 실제로 서 있는 버튼에서 높이·모서리·여백·
   * 글꼴·색을 읽어 그대로 쓴다. 밝게/어둡게 테마도 이걸로 함께 따라온다.
   *
   * 읽은 값은 사용자 지정 속성으로 넣는다. 그래야 :hover 와 눌린 상태 규칙이 그대로 산다
   * (인라인 background 로 박으면 그 규칙들이 전부 진다).
   */
  function matchNeighbour() {
    // 숏츠 쪽은 세로 줄에 맞춘 다른 모양이라 여기서 건드리지 않는다.
    if (!el.button || state.mode !== "watch") return;
    const host = el.button.parentElement;
    const sample = sampleButton(host);
    // 옆 버튼이 아직 안 그려졌을 수 있다. 그때는 표시를 남기지 않아서 다음 차례에 다시 잰다.
    if (!sample) return;
    state.matched = true;

    const style = getComputedStyle(sample);
    const box = sample.getBoundingClientRect();
    const set = (name, value) => value && el.button.style.setProperty(name, value);

    const height = Math.round(box.height);
    set("--ytdl-open-h", `${height}px`);
    // 모서리는 베끼지 않고 높이의 절반으로 둔다. 이 줄의 버튼은 모두 완전한 알약인데,
    // 좋아요·싫어요는 서로 붙어 있어 한쪽만 둥글게 적혀 있다(그대로 베끼면 우리도 반쪽이 된다).
    set("--ytdl-open-r", `${height / 2}px`);
    set("--ytdl-open-font", `${style.fontWeight} ${style.fontSize}/1 ${style.fontFamily}`);
    set("--ytdl-open-track", style.letterSpacing === "normal" ? "" : style.letterSpacing);
    set("--ytdl-open-fg", style.color);
    // 좌우 여백은 글자가 있는 버튼에서만 뜻이 있다. 동그란 아이콘 버튼은 여백이 0 이다.
    if (sample.textContent.trim()) {
      set("--ytdl-open-pad", `0 ${style.paddingRight} 0 ${style.paddingLeft}`);
    }
    // 속이 빈 버튼을 골랐다면 색은 우리 기본값을 쓴다(투명을 그대로 쓰면 바탕이 사라진다).
    const background = style.backgroundColor;
    if (background && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(background)) {
      set("--ytdl-open-bg", background);
    }
    // 아이콘 크기는 여기서 재지 않는다. 유튜브의 틀은 24 였다가 48 이었다가 하지만
    // 그 안의 그림은 어디서나 20~21 이라, 틀을 베끼면 우리 것만 두 배로 커진다.
    // 유튜브의 그림을 그대로 쓰므로 애초에 맞춰져 있다(downloadIcon 참고).

    // 옆 버튼과의 사이. 유튜브는 여백을 버튼이 아니라 그것을 감싼 껍데기에 준다.
    // 줄 자체가 벌려 주고 있으면(gap) 우리만 여백을 더하면 안 된다.
    const wrapper = [...host.children].find((node) => node.contains(sample));
    const own = Number.parseFloat(wrapper ? getComputedStyle(wrapper).marginLeft : "");
    const gap = Number.parseFloat(getComputedStyle(host).columnGap);
    set("--ytdl-open-ml", gap > 0 ? "0px" : own > 0 ? `${own}px` : "8px");
  }

  /**
   * 견줄 만한 유튜브 버튼 하나.
   *
   * 까다롭게 고르면 안 된다. 창이 좁으면 유튜브는 공유·저장을 글자 없는 `⋯` 동그라미
   * 하나로 접어버린다. 그러면 "글자 있는 알약"만 찾다가 아무것도 못 고른다(실제로 그랬다 —
   * 재지 못해 우리 버튼만 36px 로 남고 옆 버튼들은 40px 이었다).
   *
   * 그래서 보이는 버튼이면 무엇이든 받아들이고, 글자가 있는 것을 먼저 본다.
   * 좌우 여백과 글꼴은 글자 있는 버튼에서만 뜻이 있기 때문이다.
   */
  function sampleButton(host) {
    if (!host) return null;
    const buttons = [...host.querySelectorAll("button")].filter((node) => {
      if (node === el.button || el.button?.contains(node)) return false;
      const box = node.getBoundingClientRect();
      return box.height > 20 && box.width > 0;
    });
    return buttons.find((node) => node.textContent.trim()) || buttons[0] || null;
  }

  /**
   * 패널을 끼워 넣을 자리. 없으면(null) 화면 위에 띄운다.
   *
   * 숏츠는 끼울 데가 없다. 북마클릿도 늘 띄운다 — 눌러서 들어온 길이라 누른 그 자리에서
   * 바로 보이는 편이 낫고, 유튜브가 화면 구조를 바꿔도 붙일 자리를 못 찾아 안 뜨는 일이 없다.
   */
  function panelAnchor() {
    if (isShorts() || bundled) return null;
    return document.querySelector("ytd-watch-metadata") || document.querySelector("#below");
  }

  /**
   * 제목 줄을 잡아 패널을 옮긴다.
   *
   * 한 번이라도 직접 옮겼으면 그 뒤로는 자동 배치를 하지 않는다. 놓아둔 자리가
   * 매 초 원래대로 돌아가면 옮기는 의미가 없다.
   */
  // 패널이 움직이는 길은 끌기 말고도 있다 — 페이지 스크롤(끼워 넣은 패널), 창 크기 변화,
  // 유튜브가 화면을 다시 그릴 때. 그때마다 딸림창 자리를 다시 잡는다.
  window.addEventListener("scroll", () => placeSides(), { passive: true });
  window.addEventListener("resize", () => placeSides(), { passive: true });

  function bindPanelDrag(head) {
    head.addEventListener("pointerdown", (event) => {
      // 머리줄에 놓인 단추·칸을 누른 것은 끌기가 아니다.
      //
      // 닫기만 빼뒀더니 머리줄로 옮긴 창 여닫이가 먹통이 됐다 — 끌기가 `preventDefault()` 로
      // 클릭을 삼켜 창이 안 열리고, 게다가 끌기 준비가 패널 너비를 다시 잡아 누를 때마다
      // 조금씩 커졌다(테두리·안여백이 매번 더해져서).
      if (event.target.closest("button, input, select, a")) return;
      const rect = el.panel.getBoundingClientRect();
      state.panelDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      state.panelMoved = true;
      // 지금 보이는 그 자리에서 시작하도록 좌표를 굳힌다(가운데 맞춤을 풀어준다).
      el.panel.style.transform = "none";
      el.panel.style.bottom = "auto";
      el.panel.style.width = `${Math.round(rect.width)}px`; // 놓을 때 푼다(drop)
      moveFloatingPanel(rect.left, rect.top);
      try {
        head.setPointerCapture(event.pointerId);
      } catch {
        // 잡아두지 못해도 끄는 것 자체는 된다(포인터가 밖으로 나가면 멈출 뿐).
      }
      event.preventDefault();
    });

    head.addEventListener("pointermove", (event) => {
      if (!state.panelDrag) return;
      moveFloatingPanel(event.clientX - state.panelDrag.x, event.clientY - state.panelDrag.y);
    });

    const drop = () => {
      state.panelDrag = null;
      // 끄는 동안만 너비를 굳혀 뒀다. 놓으면 푼다 —
      // 그래야 창 크기가 같으면 패널 크기도 늘 같다(폭은 사람이 정하는 값이 아니다).
      el.panel.style.width = "";
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);

    // 머리줄을 두 번 누르면 처음 자리로 돌아간다.
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, input, select, a")) return;
      state.panelMoved = false;
      placeFloatingPanel();
    });
  }

  /** 화면 밖으로 나가지 않게 잡아두고 옮긴다. */
  /**
   * 딸림창을 패널 양옆에 붙인다.
   *
   * 옆에 자리가 모자라면 패널 아래로 내린다. 화면 밖으로 나가지 않게 가둔다.
   */
  /**
   * 딸림창을 따로 끌 수 있게 한다.
   *
   * 한 번이라도 옮기면 그때부터 **패널을 따라다니지 않는다**. 옆에 붙여 두는 것이 기본이지만
   * 화면을 어떻게 쓸지는 사람마다 다르다 — 옮겨 놓은 자리를 우리가 도로 끌고 가면 안 된다.
   * 머리줄을 두 번 누르면 다시 패널 옆으로 붙는다.
   */
  function bindSideDrag(side, key) {
    const head = side.querySelector(".ytdl-side-head");
    if (!head) return;
    let grab = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return; // 접기 단추는 끌기가 아니다
      const box = side.getBoundingClientRect();
      grab = { x: event.clientX - box.left, y: event.clientY - box.top };
      state[`${key}Free`] = true;
      side.classList.add("ytdl-side-free");
      try {
        head.setPointerCapture(event.pointerId);
      } catch {
        // 못 잡아도 끌리기는 한다
      }
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      if (!grab) return;
      const width = side.offsetWidth;
      const height = side.offsetHeight;
      const 가두기 = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
      side.style.left = `${Math.round(가두기(event.clientX - grab.x, window.innerWidth - width - 8))}px`;
      side.style.top = `${Math.round(가두기(event.clientY - grab.y, window.innerHeight - height - 8))}px`;
    });
    const drop = () => {
      grab = null;
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);
    // 두 번 누르면 다시 패널 옆으로.
    head.addEventListener("dblclick", () => {
      state[`${key}Free`] = false;
      side.classList.remove("ytdl-side-free");
      placeSides();
    });
  }

  function placeSides() {
    if (!el.panel || el.panel.hidden) {
      if (el.leftovers) el.leftovers.style.visibility = "hidden";
      return;
    }
    const box = el.panel.getBoundingClientRect();
    const gap = 10;
    // 딸림창 너비는 화면에 맞춘다(좁으면 좁게, 넓으면 넉넉하게).
    const wide = Math.round(Math.max(200, Math.min(window.innerWidth * 0.22, 320)));

    // **양옆을 따로 잰다.** "화면이 넓은가"로 뭉뚱그리면 한쪽에 자리가 남는데도 둘 다
    // 아래로 내려가 버린다(실제로 1600px 에서 그랬다).
    const 들어가나 = (space) => space >= wide + gap + 8;
    const 왼쪽 = 들어가나(box.left);

    const 띠 = [];
    const 옆에 = (side, where) => {
      side.style.visibility = "visible";
      side.classList.remove("ytdl-side-wide");
      side.style.width = `${wide}px`;
      side.style.maxHeight = `${Math.round(Math.max(140, window.innerHeight - box.top - 16))}px`;
      side.style.left = `${Math.round(where === "right" ? box.right + gap : box.left - wide - gap)}px`;
      side.style.top = `${Math.round(Math.max(8, box.top))}px`;
    };

    // 구간 목록은 패널 안으로 들어갔다. 여기서 자리를 봐줄 것은 남은 조각뿐이다.
    for (const [side, where, 자리있음] of [[el.leftovers, "left", 왼쪽]]) {
      if (!side) continue;
      if (side.hidden) {
        side.style.visibility = "hidden";
        continue;
      }
      // 사람이 옮겨 놓은 창은 그 자리에 둔다. 화면 밖으로만 안 나가게 지켜본다.
      if (state.leftoversFree) {
        side.style.visibility = "visible";
        const box2 = side.getBoundingClientRect();
        const 가두기 = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
        side.style.left = `${Math.round(가두기(box2.left, window.innerWidth - box2.width - 8))}px`;
        side.style.top = `${Math.round(가두기(box2.top, window.innerHeight - Math.min(box2.height, 160) - 8))}px`;
        continue;
      }
      if (자리있음) 옆에(side, where);
      else 띠.push(side);
    }
    if (!띠.length) return;

    // 옆에 못 세운 것은 패널 폭짜리 띠로 위아래 **남는 쪽**에 쌓는다.
    const 아래여유 = window.innerHeight - box.bottom - gap - 8;
    const 위여유 = box.top - gap - 8;
    const 아래로 = 아래여유 >= 위여유;
    const 여유 = Math.max(120, 아래로 ? 아래여유 : 위여유);
    const 몫 = Math.max(110, Math.floor((여유 - gap * (띠.length - 1)) / 띠.length));
    let cursor = 아래로 ? box.bottom + gap : box.top - gap;
    for (const side of 띠) {
      side.style.visibility = "visible";
      side.classList.add("ytdl-side-wide");
      side.style.width = `${Math.round(box.width)}px`;
      side.style.maxHeight = `${몫}px`;
      side.style.left = `${Math.round(Math.max(8, box.left))}px`;
      const height = Math.min(side.offsetHeight || 0, 몫);
      const top = 아래로 ? cursor : cursor - height;
      side.style.top = `${Math.round(Math.max(8, top))}px`;
      cursor = 아래로 ? top + height + gap : top - gap;
    }
  }

  function moveFloatingPanel(left, top) {
    const width = el.panel.offsetWidth;
    const height = el.panel.offsetHeight;
    const limit = (value, high) => Math.max(8, Math.min(value, Math.max(8, high)));
    el.panel.style.left = `${Math.round(limit(left, window.innerWidth - width - 8))}px`;
    el.panel.style.top = `${Math.round(limit(top, window.innerHeight - height - 8))}px`;
    placeSides();
  }

  /**
   * 띄운 패널을 화면 아래 가운데에 세운다.
   *
   * 예전에는 영상 옆 빈자리를 재서 세웠는데, 창 크기에 따라 설 자리가 오락가락했다
   * (좁으면 아래로 눕고 넓으면 옆으로 갔다). 처음 열 때 어디에 뜰지 모르면 눈이
   * 패널을 찾아 헤맨다. 아래 가운데는 숏츠든 일반 화면이든 늘 같은 자리다.
   *
   * 그 자리가 싫으면 제목 줄을 잡아 옮기면 된다 — 한 번 옮기면 그 뒤로는 건드리지 않는다.
   */
  function placeFloatingPanel() {
    if (!el.panel || el.panel.hidden || !el.panel.classList.contains("ytdl-float")) return;
    // 사용자가 직접 옮겼으면 자리만 지켜주고, 화면 밖으로 나가지 않게 봐준다.
    // **너비는 언제나 되돌린다** — 자리는 사람이 정하는 것이지만 크기는 화면이 정한다.
    if (state.panelMoved) {
      el.panel.style.width = "";
      const rect = el.panel.getBoundingClientRect();
      moveFloatingPanel(rect.left, rect.top);
      return;
    }
    // 끌어 옮기며 굳혀둔 좌표가 남아 있을 수 있다. 지워야 가운데 맞춤이 다시 산다.
    el.panel.style.left = "";
    el.panel.style.top = "";
    el.panel.style.bottom = "";
    el.panel.style.transform = "";
    el.panel.style.width = "";
  }

  // 유튜브는 화면을 통째로 다시 그리는 일이 잦다. 사라졌으면 다시 붙인다.
  function mount() {
    // 영상 화면을 떠났다(홈·검색 …). 얹어둔 것을 걷어낸다.
    // 특히 숏츠 패널은 body 에 띄워 둔 것이라, 두면 엉뚱한 화면 위에 그대로 남는다.
    if (!isVideoPage()) {
      if (state.mode !== null) {
        el.button?.remove();
        el.panel?.remove();
        el.leftovers?.remove();
        el.button = null;
        el.panel = null;
        state.mode = null;
        state.panelMoved = false;
        state.panelDrag = null;
        watchProgress(false);
        runClock(false);
      }
      return;
    }

    const mode = isShorts() ? "shorts" : "watch";
    // 숏츠와 일반 화면 사이를 오갈 때 유튜브는 문서를 새로 만들지 않는다.
    // 붙일 자리도 모양도 달라지므로 떼어내고 새로 만든다.
    if (state.mode !== mode) {
      state.mode = mode;
      el.button?.remove();
      el.button = null;
      el.panel?.remove();
      el.panel = null;
      // 옮겨둔 자리는 그 화면에서만 뜻이 있다.
      state.panelMoved = false;
      state.panelDrag = null;
    }

    const host = buttonHost();
    // 숏츠는 한 편 넘길 때마다 버튼 줄이 통째로 갈린다. 그러면 새 줄로 옮겨 붙인다.
    if (host && el.button?.parentElement !== host) {
      el.button = el.button || buildButton(mode === "shorts");
      el.button.classList.toggle("ytdl-open-active", state.open);
      // 숏츠에서는 좋아요 위에 둔다. 아래에 붙이면 창이 조금만 낮아도 화면 밖으로 밀린다.
      if (mode === "shorts") host.prepend(el.button);
      else host.append(el.button);
      // 새 줄에 붙었으면 치수도 그 줄의 버튼에서 다시 잰다.
      state.matched = false;
    }

    // 옆 버튼을 재서 치수를 맞춘다. 그 버튼들이 우리보다 늦게 그려질 때가 있어서,
    // 잴 수 있을 때까지 매 차례 다시 해본다(한 번 재고 나면 그만둔다).
    if (!state.matched) matchNeighbour();

    if (!el.panel || !el.panel.isConnected) {
      const anchor = panelAnchor();
      // 끼워 넣을 자리가 없으면 띄운다. 일반 화면의 확장만 자리를 기다린다 —
      // 유튜브가 아직 안 그린 것뿐이라 다음 차례에 붙는다.
      if (anchor || mode === "shorts" || bundled) {
        const panel = buildPanel(!anchor);
        if (anchor) anchor.insertAdjacentElement("afterend", panel);
        else document.body.append(panel);
        panel.hidden = !state.open;
        // 열어둔 채 다른 화면에 갔다 왔으면 재생 상태 받아오기가 꺼져 있다. 다시 켠다.
        watchProgress(state.open);
        runClock(state.open);
        // 새로 만든 패널은 화질칸이 비어 있다. 이미 받아둔 목록이 있으면 그대로 채운다.
        fillQuality();
        render();
      }
    }
  }

  async function togglePanel() {
    state.open = !state.open;
    if (el.panel) el.panel.hidden = !state.open;
    placeFloatingPanel();
    el.button?.classList.toggle("ytdl-open-active", state.open);
    // 열려 있는 동안만 재생 상태를 받아온다.
    watchProgress(state.open);
    runClock(state.open);
    // 목록은 처음 열 때만 받아온다(영상마다 미리 받아두면 낭비다).
    if (state.open && !state.formats) await loadFormats();
  }

  /** 아직 손대지 않았으면 전 구간을 고른 상태로 둔다. */
  function selectWhole() {
    const edge = bounds();
    if (edge.end <= edge.start) return false;
    state.start = edge.start;
    state.end = edge.end;
    state.toEnd = true;
    render();
    return true;
  }

  function setRange(start, end) {
    const edge = bounds();
    const low = edge.end > edge.start ? edge.start : 0;
    const high = edge.end > edge.start ? edge.end : Math.max(start, end);
    state.start = Math.max(low, Math.min(start, high));
    state.end = Math.max(low, Math.min(end, high));
    if (state.end < state.start) [state.start, state.end] = [state.end, state.start];
    // 끝에 붙여뒀으면 "끝까지"로 본다. 라이브면 방송이 나아가는 만큼 함께 간다.
    state.toEnd = high > low && state.end >= high - 0.5;
    state.touched = true;
    // 목록에서 고른 구간이 있으면 그 구간을 고치는 중이다.
    const editing = state.clips.find((clip) => clip.id === state.activeClip);
    if (editing) {
      editing.start = state.start;
      editing.end = state.end;
      saveClipList();
    }
    render();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveRange, 400);
  }

  function render() {
    if (!el.panel) return;
    el.inputs.start.value = showClock(state.start, 2);
    // 끝까지 받는 중이면 시각 대신 그렇다고 적는다. 라이브는 끝이 계속 밀리니까.
    el.inputs.end.value = state.toEnd ? "" : showClock(state.end, 2);
    el.inputs.end.placeholder = state.toEnd ? "끝까지" : "";
    const length = Math.max(0, state.end - state.start);
    el.length.textContent = showClock(length, 2);
    el.go.disabled = state.busy || !state.formats || length < 0.05;
    el.hold.hidden = !state.busy;
    el.halt.hidden = !state.busy;
    el.reveal.hidden = state.busy || !state.saved || !runtime;
    el.hold.textContent = state.control?.paused ? "이어받기" : "일시정지";
    el.addClip.disabled = state.busy || state.end - state.start < 0.05;
    renderClips();
    renderLeftovers();
    renderTimeline();
    placeSides();
  }

  /** 화질·내용을 바꾸면 편집 중인 구간에도 그대로 적어 둔다. */
  function applyToActiveClip() {
    const editing = state.clips.find((clip) => clip.id === state.activeClip);
    if (!editing) return;
    editing.mode = state.media || "merged";
    editing.itag = el.quality.value;
    saveClipList();
  }

  /** 구간에 적힌 설정을 화면(내용·화질 칸)에 되돌려 놓는다. */
  function loadClipSettings(clip) {
    if (clip.mode && clip.mode !== state.media) {
      state.media = clip.mode;
      el.media.value = clip.mode;
      saveMediaMode(clip.mode);
      fillQuality();
    }
    if (clip.itag && [...el.quality.options].some((option) => option.value === clip.itag)) {
      el.quality.value = clip.itag;
    }
  }

  /** 구간에 적힌 설정을 사람이 읽을 말로. */
  function clipLabel(clip) {
    const 내용 = clip.mode === "video" ? "영상만" : clip.mode === "audio" ? "소리만" : "영상+소리";
    const list = clip.mode === "audio" ? state.formats?.audio : state.formats?.video;
    const format = list?.find((one) => String(one.itag) === String(clip.itag));
    return format ? `${innertube.formatLabel(format)} · ${내용}` : 내용;
  }

  /** 오른쪽 구간 목록. 고른 줄은 하이라이트되고, 누르면 그 구간이 편집 대상이 된다. */
  function renderClips() {
    if (!el.clips) return;
    el.clips.hidden = !state.clips.length || state.clipsShut;
    el.clipsToggle.hidden = !state.clips.length;
    el.clipsToggle.textContent = `구간 목록 ${state.clips.length}`;
    el.clipsToggle.classList.toggle("on", !state.clipsShut);
    const rows = state.clips.map((clip, at) => {
      const pick = make("input", { class: "ytdl-clip-pick", type: "checkbox" });
      pick.checked = clip.picked;
      pick.addEventListener("click", (event) => event.stopPropagation());
      pick.addEventListener("change", () => {
        clip.picked = pick.checked;
        saveClipList();
      });
      const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "목록에서 뺍니다" });
      drop.addEventListener("click", (event) => {
        event.stopPropagation();
        state.clips = state.clips.filter((one) => one !== clip);
        if (state.activeClip === clip.id) state.activeClip = null;
        saveClipList();
        render();
      });
      const row = make(
        "div",
        { class: state.activeClip === clip.id ? "ytdl-clip on" : "ytdl-clip" },
        [
          pick,
          make("span", { class: "ytdl-clip-no", text: `구간${at + 1}` }),
          make("span", { class: "ytdl-clip-time" }, [
            make("span", { text: `${showClock(clip.start, 2)}~${showClock(clip.end, 2)}` }),
            make("span", { class: "ytdl-clip-set", text: clipLabel(clip) }),
          ]),
          drop,
        ],
      );
      // 누르면 그 구간으로 옮겨간다. 손잡이·시각칸이 따라 움직이고, 고치면 이 구간이 바뀐다.
      row.addEventListener("click", () => {
        state.activeClip = clip.id;
        // 시각뿐 아니라 그 구간의 화질·내용까지 화면에 되돌린다. 그래야 바로 고칠 수 있다.
        loadClipSettings(clip);
        setRange(clip.start, clip.end);
      });
      return row;
    });
    el.clipList.replaceChildren(...rows);
    const 고른수 = state.clips.filter((clip) => clip.picked).length;
    el.clipSaveEach.disabled = state.busy || !고른수;
    el.clipSaveJoin.disabled = state.busy || 고른수 < 2;
    el.clipSaveEach.textContent = 고른수 ? `따로 저장 (${고른수})` : "따로 저장";
  }

  /** 왼쪽 남은 조각 목록. 이 브라우저에 쌓인 것을 영상별로 보여준다. */
  function renderLeftovers() {
    if (!el.leftovers) return;
    // 기본은 지금 보고 있는 영상 것만. "전체 보기"를 누르면 이 브라우저에 쌓인 것을 다 보여준다.
    const 보일것 = state.leftoversAll
      ? state.leftovers
      : state.leftovers.filter((item) => item.videoId === state.videoId);
    const 다른것 = state.leftovers.length - 보일것.length;
    // 늘 보여준다. 비어 있을 때도 "없다"는 것이 보여야 어디를 봐야 할지 알 수 있다.
    el.leftovers.hidden = state.leftoversShut;
    el.leftoversToggle.hidden = false;
    el.leftoversToggle.textContent = `남은 조각 ${보일것.length}`;
    el.leftoversToggle.classList.toggle("on", !state.leftoversShut);
    el.leftoverScope.textContent = state.leftoversAll ? "이 영상만" : `전체 보기${다른것 ? ` (+${다른것})` : ""}`;
    el.leftoverScope.classList.toggle("on", state.leftoversAll);
    el.leftoverScope.hidden = false;
    el.leftoverAll.textContent = state.leftoversAll ? "모두 버리기" : "조각 버리기";
    // 한 영상이 여러 줄이 될 수 있다 — 받아둔 구간마다 한 줄, 남은 조각이 있으면 한 줄 더.
    const rows = [];
    for (const item of 보일것) {
      const 지금 = item.videoId === state.videoId;
      const 꼬리표 = (글, 작게) =>
        make("span", { class: "ytdl-clip-time" }, [
          make("span", { text: 글 }),
          make("span", { class: "ytdl-clip-set", text: 작게 }),
        ]);
      const 이름 = knownTitle(item.videoId);
      const 이동 = (row) => {
        if (지금) return row;
        row.title = `${이름 || item.videoId} — 새 창에서 엽니다`;
        row.addEventListener("click", () => {
          // 새 창으로 연다. 지금 보던 영상을 잃지 않고 확인만 하러 갈 수 있어야 한다.
          window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`, "_blank", "noopener");
        });
        return row;
      };
      // 어느 영상인지 한눈에 보이게 섬네일을 붙인다. 제목을 못 적어둔 옛 것도 이걸로 알아본다.
      const 섬네일 = () =>
        make("img", {
          class: "ytdl-clip-thumb",
          src: `https://i.ytimg.com/vi/${item.videoId}/default.jpg`,
          alt: "",
          loading: "lazy",
        });

      for (const done of item.outputs || []) {
        const again = make("button", { class: "ytdl-clip-btn ytdl-clip-save", type: "button", text: "저장" });
        again.addEventListener("click", async (event) => {
          event.stopPropagation();
          const file = await store.readOutput(item.videoId, done.key).catch(() => null);
          if (!file) {
            setStatus("저장해 둔 파일을 찾지 못했습니다");
            return;
          }
          const 이름 = done.name || `${item.videoId} [받아둔 구간].mp4`;
          offerLink(save(file, 이름), `받아둔 파일을 내보냈습니다 · ${showMb(file.size)} MB`);
        });
        const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "이 파일을 지웁니다" });
        drop.addEventListener("click", async (event) => {
          event.stopPropagation();
          await store.discardOutput(item.videoId, done.key);
          await refreshLeftovers();
        });
        // 이름에 적어둔 구간 표시가 있으면 그것을, 없으면 영상 ID 를 보여준다.
        const 구간 = ((done.name || "").match(/\[([0-9:.~\-]+)\]/) || [])[1] || done.key || "받아둔 파일";
        rows.push(
          이동(make("div", { class: `ytdl-clip${지금 ? " on" : ""}` }, [
            ...(지금 ? [make("span", { class: "ytdl-clip-no", text: "받음" })] : [섬네일()]),
            꼬리표(
              구간.replace(/-/g, ":"),
              `${지금 ? "" : `${이름 || item.videoId} · `}${showMb(done.bytes)} MB` +
                (() => {
                  const 표 = savedMark(item.videoId, done.key);
                  // 북마클릿은 알 길이 없어 아무 말도 하지 않는다.
                  return 표 === true ? " · 저장함" : 표 === false ? " · 저장 안 함" : "";
                })(),
            ),
            again,
            drop,
          ])),
        );
      }

      if (item.chunks) {
        const drop = make("button", { class: "ytdl-clip-del", type: "button", text: "✕", title: "이 영상의 조각을 지웁니다" });
        drop.addEventListener("click", async (event) => {
          event.stopPropagation();
          await store.discard(item.videoId);
          if (지금) state.hasLeftovers = false;
          await refreshLeftovers();
        });
        rows.push(
          이동(make("div", { class: `ytdl-clip${지금 ? " on" : ""}` }, [
            ...(지금 ? [make("span", { class: "ytdl-clip-no", text: "조각" })] : [섬네일()]),
            꼬리표(
              지금 ? "받다 만 조각" : 이름 || item.videoId,
              `조각 ${item.chunks}개 · ${showMb(item.bytes)} MB`,
            ),
            drop,
          ])),
        );
      }
    }
    if (!rows.length) {
      rows.push(
        make("div", { class: "ytdl-clip ytdl-empty" }, [
          make("span", {
            class: "ytdl-clip-time",
            text: state.leftoversAll ? "쌓아둔 것이 없습니다" : "이 영상에 쌓아둔 것이 없습니다",
          }),
        ]),
      );
    }
    el.leftoverList.replaceChildren(...rows);
  }

  async function refreshLeftovers() {
    // 이 브라우저에 쌓인 것을 영상 가리지 않고 다 보여준다. 지금 영상 것이 맨 앞에 온다.
    const all = await store.listLeftovers().catch(() => []);
    state.leftovers = all.sort((a, b) => {
      const 지금 = (item) => (item.videoId === state.videoId ? 0 : 1);
      return 지금(a) - 지금(b) || b.usedAt - a.usedAt;
    });
    render();
  }

  function renderTimeline() {
    const edge = bounds();
    const span = edge.end - edge.start;
    el.total.textContent = span > 0 ? showClock(span, 2) : "";
    // 시계는 사용자가 고쳐 넣는 중일 때만 손대지 않는다. 커서가 튀어버린다.
    if (document.activeElement !== el.now) {
      const now = showClock(playedSeconds(), 2);
      if (el.now.value !== now) el.now.value = now;
    }
    if (span <= 0) return;
    const percent = (seconds) =>
      `${(Math.max(0, Math.min(seconds - edge.start, span)) / span) * 100}%`;
    el.range.style.left = percent(state.start);
    el.range.style.width = `${((state.end - state.start) / span) * 100}%`;
    el.inHandle.style.left = percent(state.start);
    el.outHandle.style.left = percent(state.end);
    el.headMark.style.left = percent(playedSeconds());
  }

  function setStatus(text, kind = "") {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.className = `ytdl-status ${kind}`;
  }

  /** 받을 내용에 맞는 품질 목록. "소리만"이면 소리 품질(비트레이트)을 보여준다. */
  function qualityChoices(mode = state.media) {
    if (!state.formats) return [];
    return mode === "audio" ? state.formats.audio : state.formats.video;
  }

  /** 받아둔 품질 목록을 화질칸에 채운다. 패널을 다시 만들었을 때도 쓴다. */
  function fillQuality() {
    if (!el.quality || !state.formats) return;
    const before = el.quality.value;
    el.quality.replaceChildren(
      ...qualityChoices().map((format) =>
        make("option", { value: String(format.itag), text: innertube.formatLabel(format) }),
      ),
    );
    // 목록을 갈아끼워도 같은 포맷이 남아 있으면 선택을 유지한다.
    if ([...el.quality.options].some((option) => option.value === before)) {
      el.quality.value = before;
    }
  }

  async function loadFormats() {
    const videoId = currentVideoId();
    if (!videoId) return;
    state.videoId = videoId;
    state.formats = null;
    state.saved = false;
    // 이 영상에 담아둔 구간을 되살린다.
    state.clips = savedClips(videoId);
    state.activeClip = null;
    el.quality.replaceChildren(make("option", { text: "불러오는 중…" }));
    setStatus("화질 목록을 불러오는 중입니다");

    try {
      // 로그인해서 받은 주소에는 `n` 이 붙어 있다. 풀지 않으면 403 이다.
      const unlock = (urls) =>
        nsig.solveUrls(urls, {
          // 해결기 원본이 있는 곳. 북마클릿은 확장 주소가 없어 배포처에서 받아온다.
          runtime: runtime || { getURL: (path) => new URL(path, window.__ytdlBase).href },
          ask: (payload) => viaPage.ask(payload, "solve"),
          onStep: (text) => setStatus(text),
        });
      // PO 토큰은 페이지 안의 유튜브 발급기가 만든다. 없으면 앞 60초까지만 받힌다.
      const mintPot = async (bind) => (await viaPage.ask({ bind }, "pot"))?.token;
      // 로그아웃일 때 TVHTML5_SIMPLY 로 물으려면 페이지의 STS 가 있어야 한다.
      const getSts = async () => (await viaPage.ask({}, "sts"))?.sts;
      const formats = await getFormats(videoId, null, unlock, undefined, mintPot, getSts);
      if (state.videoId !== videoId) return; // 그 사이 다른 영상으로 옮겼다
      if (!formats.video.length || !formats.audio.length) {
        throw new Error("받을 수 있는 mp4 화질이 없습니다");
      }
      state.formats = formats;
      rememberTitle(videoId, formats.title);
      fillQuality();
      const saved = savedRange(videoId);
      if (saved) {
        state.touched = true;
        // 끝까지로 저장돼 있었다면 지금 기준의 끝으로 되살린다(라이브는 그새 늘어난다).
        setRange(saved.start, saved.toEnd ? bounds().end : saved.end);
        setStatus("지난번에 골라둔 구간을 불러왔습니다");
      } else {
        selectWhole();
        setStatus("");
      }
      // 받다 만 조각이 남아 있으면 알려준다(같은 구간을 다시 받으면 이어서 받는다).
      store.hasLeftovers(videoId).then((left) => {
        if (state.videoId !== videoId) return;
        state.hasLeftovers = left;
        if (left && !state.busy) {
          setStatus("받다 만 조각이 남아 있습니다 · 같은 구간을 받으면 이어서 받습니다");
        }
        render();
      }).catch(() => {});
      // 왼쪽 목록은 이 브라우저에 쌓인 것을 통째로 보여준다(다른 영상 것까지).
      refreshLeftovers().catch(() => {});
    } catch (error) {
      setStatus(error.message, "ytdl-bad");
      say("화질 목록 실패:", error);
      el.quality.replaceChildren(make("option", { text: "없음" }));
    }
    render();
  }

  const showMb = (bytes) => (bytes / 1048576).toFixed(1);

  function speedLabel(bytesPerSec) {
    if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
  }

  // 마지막으로 알려온 진행 상황. 조각이 뜸하게 와도 속도 표시는 계속 새로 그린다(주기 갱신).
  let lastProgress = null;

  function showProgress() {
    if (!lastProgress) return;
    const { done, total, stage, size } = lastProgress;
    if (stage !== "받는 중") {
      // 합치기 같은 단계도 몇째 조각인지 같이 적는다.
      setStatus(total > 1 ? `${stage} ${done}/${total}` : stage);
      return;
    }
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    let text = `${state.stageLabel || ""}받는 중 ${percent}%`;
    // 일반 영상은 진행량이 바이트라 그대로 적는다. 라이브는 조각 개수로 받아서
    // 전체 용량을 미리 모르므로, 받는 쪽이 트랙별 평균 조각 크기로 어림해 준
    // 용량(size)을 적는다(진행률 막대는 여전히 조각 개수 기준이라 정확하다).
    const inBytes = total > 1_000_000;
    if (inBytes) text += ` · ${showMb(done)}/${showMb(total)} MB`;
    else if (size) {
      text += ` · ${showMb(size.got)}`;
      // 조각을 다 받으면 어림이 실측과 같아진다. 그때는 "약"을 떼고 하나만 적는다.
      if (size.estimated > size.got) text += `/약 ${showMb(size.estimated)}`;
      text += " MB";
    } else {
      text += ` · ${showMb(meter.bytes)} MB`;
    }
    if (state.control?.paused) {
      setStatus(`${text} (멈춤)`);
      return;
    }
    const speed = meterSpeed();
    if (speed > 0) text += ` · ${speedLabel(speed)}`;
    const left = paceRemaining(done, total);
    if (left !== null && done < total) text += ` · 예상 ${showClock(left)} 남음`;
    setStatus(text);
  }

  /**
   * 고른 구간들을 받는다.
   *
   * `merge` 면 하나로 이어붙이고, 아니면 구간마다 파일을 하나씩 만든다.
   * 따로 저장은 기존 받기를 구간마다 한 번씩 부르는 것뿐이라 이어받기·갈아타기가 그대로 산다.
   */
  async function saveClips(merge) {
    if (state.busy) return;
    const order = state.clips.filter((clip) => clip.picked).sort((a, b) => a.start - b.start);
    if (!order.length) return;
    if (merge) {
      // 이어붙이기는 트랙 하나로 조립하므로 화질이 섞이면 안 된다. 첫 구간 것으로 맞춘다.
      const 섞임 = order.some((clip) => clip.mode !== order[0].mode || clip.itag !== order[0].itag);
      await start({ clips: order, mode: order[0].mode, itag: order[0].itag });
      if (섞임 && state.saved) {
        setStatus(
          `${el.status.textContent} · 구간마다 설정이 달라 첫 구간(${clipLabel(order[0])}) 것으로 맞췄습니다`,
          "ytdl-ok",
        );
      }
      return;
    }
    for (let at = 0; at < order.length; at += 1) {
      const clip = order[at];
      state.activeClip = clip.id;
      loadClipSettings(clip);
      setRange(clip.start, clip.end);
      await start({ label: `구간 ${at + 1}/${order.length} · `, mode: clip.mode, itag: clip.itag });
      if (!state.saved) return; // 실패하거나 멈췄으면 거기서 그만둔다
    }
    setStatus(`구간 ${order.length}개를 모두 저장했습니다`, "ytdl-ok");
  }

  async function start(options = {}) {
    if (state.busy || !state.formats) return;
    state.stageLabel = options.label || "";
    // 구간 목록에서 부르면 그 구간에 적힌 화질·내용을 쓴다(칸에 뭐가 떠 있든 상관없다).
    const mode = options.mode || state.media || "merged";
    const choices = qualityChoices(mode);
    const wanted = options.itag || el.quality.value;
    const chosenFormat =
      choices.find((format) => String(format.itag) === String(wanted)) || choices[0];
    if (!chosenFormat) return;

    state.busy = true;
    state.saved = false;
    state.control = createControl();
    render();
    const began = Date.now();

    // 조각은 되도록 디스크(OPFS)에 쌓는다. 메모리는 조각 하나 크기만 쓰고,
    // 받다 죽어도 조각이 남아 다시 누르면 이어받는다.
    // 완성본을 구간마다 따로 남긴다. 한 칸만 쓰면 다음 구간을 받을 때 앞 구간이 지워져,
    // 여러 구간을 받아 놓고도 마지막 것만 다시 꺼낼 수 있었다.
    const outputKey = options.clips
      ? `join${options.clips.length}-${Math.round(options.clips[0].start * 100)}`
      : `${Math.round(state.start * 100)}-${Math.round(state.end * 100)}`;
    const disk = await store.openBest(state.videoId || "video");
    const media = {
      ...disk,
      output: () => disk.output(outputKey),
      rememberName: (text) => disk.rememberName?.(outputKey, text),
    };
    const resumable = media.kind === "disk";
    const resumeHint = resumable ? " · 받은 만큼은 남아 있어 다시 누르면 이어받습니다" : "";
    meter.events.length = 0;
    meter.bytes = 0;
    pace.events.length = 0;
    lastProgress = null;
    const ticker = setInterval(showProgress, 500);

    try {
      // 몫이 떨어져 403 이 나면 다른 클라이언트로 물어 새 주소를 받아 온다.
      // 같은 itag 면 어느 클라이언트에서 받아도 바이트가 같아서 받던 자리에서 이어진다.
      //
      // 목록을 다 돌면 거기까지다. 기다리게 하지 않는다 — 몫이 되돌아오는 데 15분을
      // 재봐도 한 톨도 안 열렸다(45MB 영상, 첫 몫 10MB). 화면 앞에서 붙들고 있느니
      // 받아둔 데까지 남기고 끝내는 편이 낫다. 다음에 누르면 없는 것만 받는다.
      let clientAt = 0;
      const renewUrl = async () => {
        clientAt += 1;
        const next = innertube.ROTATION[clientAt];
        if (!next) return null;
        setStatus(`몫이 떨어져 ${next.clientName} 로 갈아타 이어받습니다`);
        // 이 클라이언트들의 주소에는 `n` 이 붙지 않아 해독기가 필요 없다(확인했다).
        const fresh = await getFormats(state.videoId, null, null, next, null);
        const table = new Map(
          [...fresh.video, ...fresh.audio].map((f) => [String(f.itag), f.url]),
        );
        return (itag) => table.get(String(itag));
      };

      const request = {
        start: state.start,
        end: state.end,
        control: state.control,
        store: media,
        renewUrl,
        onProgress: (done, total, stage, size) => {
          // 멈춘 뒤에도 이미 날아간 요청이 뒤늦게 보고해 온다. 그것까지 받아 적으면
          // "멈췄습니다"를 곧바로 "받는 중 54%"가 덮어써서 멈춘 줄 모르게 된다(실제로 그랬다).
          if (state.control?.stopped) return;
          lastProgress = { done, total, stage, size };
          if (stage === "받는 중") paceAdd(done);
          showProgress();
        },
      };
      const { file, mediaStart, mediaEnd, mediaSeconds } = options.clips
        ? await downloadClips({
            ...request,
            clips: options.clips,
            videoFormat: chosenFormat,
            audioFormat: state.formats.audio[0],
          })
        : mode === "merged"
          ? await downloadSection({
              ...request,
              videoFormat: chosenFormat,
              audioFormat: state.formats.audio[0],
            })
          : await downloadTrack({ ...request, format: chosenFormat, kind: mode });

      // 파일은 고른 구간 그대로다. 다만 영상은 프레임 단위로만 존재해서(60fps 면
      // 16.67ms 마다 한 장) 시작이 한 프레임 안쪽에서 당겨질 수 있다. 고른 그 순간
      // 화면에 떠 있던 장을 살리려는 것이다. 이름도 실제 내용에 맞춰 붙인다.
      const realStart = Number.isFinite(mediaStart) ? mediaStart : state.start;
      const realEnd = Number.isFinite(mediaEnd) ? mediaEnd : state.end;
      // 소리만 받은 파일은 확장자(m4a)가, 소리 없는 영상은 이름표가 내용을 알려준다.
      const marker =
        (mode === "video" ? " [영상만]" : "") + (options.clips ? ` [구간 ${options.clips.length}개]` : "");
      const ext = mode === "audio" ? "m4a" : "mp4";
      // 어떤 화질로 받았는지 파일 이름만 봐도 알 수 있게 앞에 붙인다. 예: [2160p60 AV1]
      const quality = innertube.formatLabel(chosenFormat);
      const fileName =
        `[${quality}] ${safeFileName(state.formats.title)} ` +
        `[${clockLabel(realStart)}~${clockLabel(realEnd)}]${marker}.${ext}`;
      save(file, fileName);
      // 같은 이름으로 다시 내줄 수 있게 완성본 옆에 적어 둔다(저장을 취소했을 때 쓴다).
      media.rememberName(fileName)?.catch?.(() => {});
      // 조립까지 끝났으면 조각은 지운다.
      //
      // 한때 "저장 대화상자에서 취소하면 다시 받아야 한다"는 걱정에 남겨 뒀었다. 그런데
      // 이제 **완성본을 구간마다 보관**하니 취소해도 목록에서 곧바로 다시 내줄 수 있다.
      // 조각까지 끌어안고 있으면 같은 내용을 두 벌로 들고 있는 셈이고, 목록에도 "조각"
      // 줄이 따라 붙어 무엇이 무엇인지 헷갈린다.
      //
      // 그래서 조각이 남는 경우는 하나로 좁혔다 — **받다 만 것.** 그때는 이어받기의 근거다.
      state.saved = true;
      state.hasLeftovers = false;
      media.clearChunks().catch(() => {});
      refreshLeftovers().catch(() => render());
      // 실제로 저장까지 됐는지는 브라우저만 안다. 확장에서는 물어볼 수 있다.
      if (runtime) {
        runtime.sendMessage({ type: "download-state" }, (answer) => {
          void chrome.runtime.lastError;
          if (!answer?.state || answer.state === "unknown") return;
          const 됐나 = answer.state === "complete";
          markSaved(state.videoId, outputKey, 됐나);
          if (!됐나) {
            setStatus("저장을 취소했습니다 · 아래 목록에서 다시 저장할 수 있습니다", "ytdl-ok");
          }
          refreshLeftovers().catch(() => render());
        });
      }
      const took = ((Date.now() - began) / 1000).toFixed(1);
      const pads = [];
      if (state.start - realStart >= 0.05) pads.push(`앞 ${(state.start - realStart).toFixed(2)}초`);
      if (realEnd - state.end >= 0.05) pads.push(`뒤 ${(realEnd - state.end).toFixed(2)}초`);
      const note = pads.length ? ` · ${pads.join("·")}가 더 붙었습니다(프레임 경계)` : "";
      setStatus(
        `저장했습니다 · ${showClock(realStart, 2)}~${showClock(realEnd, 2)} ` +
          `(${showClock(mediaSeconds, 2)})${note} · ` +
          `${showMb(file.size)} MB · ${took}초` +
          // 저장 대화상자에서 취소했을 수도 있다. 그때 다시 받지 않아도 된다는 것을 알려준다.
          (runtime ? "" : " · 저장을 취소했다면 아래 목록에서 다시 저장하세요"),
        "ytdl-ok",
      );
    } catch (error) {
      // 조각이 남았을 수 있다 — 이어받기 안내와 버리기 버튼의 근거가 된다.
      if (resumable) state.hasLeftovers = true;
      // 내가 정지를 누른 것은 실패가 아니다.
      if (error instanceof Stopped) setStatus(`받기를 멈췄습니다${resumeHint}`);
      else if (net.httpStatusOf(error) === 503) {
        // 막 끝난 라이브는 유튜브가 아직 다시보기로 가공 중이라 고화질을 못 줄 때가 많다.
        setStatus(
          "서버가 지금 이 화질을 주지 못합니다(503) · 방금 끝난 라이브면 준비 중일 수 있어요" +
            ` · 잠시 뒤 다시 누르거나 낮은 화질을 골라보세요${resumeHint}`,
          "ytdl-bad",
        );
        say("받기 실패(서버 503):", error);
      } else if (net.httpStatusOf(error) === 403) {
        // 유튜브는 PO 토큰 없이는 **영상 앞부분 약 60초까지만** 내어준다. 그 너머는 받은
        // 양과 상관없이 언제나 403 이다 — 새 주소에서 곧바로 뒷부분을 달라고 해도 403 이고,
        // 클라이언트를 갈아타도 경계가 똑같다(ANDROID_VR·IOS·ANDROID 셋 다 60초. 실측).
        // 그러니 기다리라고 하면 안 된다. 열리지 않는다.
        setStatus(
          "유튜브가 PO 토큰 없이는 앞부분 약 60초까지만 내어줍니다(403)" +
            ` · 60초 안쪽 구간을 고르면 받힙니다${resumeHint}`,
          "ytdl-bad",
        );
        say("받기 실패(60초 경계 너머, 403):", error);
      } else if (error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "")) {
        // 용량 상한은 우리가 정하지 않는다 — 브라우저의 오리진 할당량이 곧 상한이다.
        setStatus("브라우저 저장 공간이 부족합니다. 디스크 여유를 만들고 다시 눌러주세요", "ytdl-bad");
        say("받기 실패(저장 공간):", error);
      } else {
        setStatus(`${error.message}${resumeHint}`, "ytdl-bad");
        say("받기 실패:", error);
      }
    } finally {
      clearInterval(ticker);
      lastProgress = null;
      state.busy = false;
      state.control = null;
      render();
    }
  }

  /**
   * 만든 파일을 브라우저에 넘긴다.
   *
   * **문서에 붙였다 누른다.** 떼어 놓은 채로 누르면 크롬이 그냥 무시할 때가 있다
   * (실제로 "다시 저장"이 조용히 아무 일도 안 했다).
   *
   * 그래도 안 되는 경우가 있어서(누른 지 시간이 지나 사용자 동작으로 안 쳐줄 때),
   * 같은 주소를 가리키는 링크를 하나 돌려준다 — 부르는 쪽이 눌러볼 수 있게 띄운다.
   */
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    setTimeout(() => link.remove(), 1000);
    // 브라우저가 내려받기를 시작할 틈을 준 뒤 정리한다.
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    return { url, name };
  }

  /** 저장이 막혔을 때 사람이 직접 누를 수 있는 링크를 상태줄에 띄운다. */
  function offerLink({ url, name }, text) {
    if (!el.status) return;
    const link = make("a", { class: "ytdl-save-link", text: "여기를 눌러 저장" });
    link.href = url;
    link.download = name;
    el.status.className = "ytdl-status ytdl-ok";
    el.status.replaceChildren(document.createTextNode(`${text} · `), link);
  }

  // 북마클릿은 사용자가 "지금 받겠다"고 눌러서 들어온 길이다. 패널을 바로 펼쳐 준다.
  // (확장은 버튼이 늘 붙어 있으니 누를 때까지 기다린다.)
  // 유튜브가 화면을 다 그리기 전이면 붙일 자리가 없다. 자리가 생기는 순간 한 번만 편다.
  let autoOpened = false;
  function maybeAutoOpen() {
    if (!bundled || autoOpened || state.open || !el.panel) return;
    autoOpened = true;
    togglePanel().then(() => {
      el.panel?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  mount();
  maybeAutoOpen();
  say(
    isVideoPage()
      ? "준비됨 · 좋아요 옆 '구간 받기' 버튼을 눌러주세요"
      : "준비됨 · 영상 화면으로 가면 '구간 받기' 버튼이 붙습니다",
  );

  // 걷어낼 때는 화면에 얹은 것을 모두 치운다. 남겨두면 새 판의 것과 겹쳐 보인다.
  cleanup.push(() => {
    el.button?.remove();
    el.panel?.remove();
    watchProgress(false);
    runClock(false);
  });

  // 재생 위치 표시가 영상을 따라가게 한다.
  listen(
    document,
    "timeupdate",
    (event) => {
      if (state.open && event.target?.tagName === "VIDEO") renderTimeline();
    },
    true,
  );

  // 패널을 여닫는 단축키. 북마클릿은 눌러서 들어온 뒤 닫았다 다시 열 때 쓴다.
  //
  // Alt+S 를 쓴다. 크롬이 잡아둔 자리(Alt+D 는 주소창, Alt+E·F 는 메뉴)와 유튜브가 쓰는
  // 낱글자(k·j·l·f·t·c·m·i)를 모두 피해야 해서 조합키로 뒀다.
  listen(document, "keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code !== "KeyS") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (!el.panel) return;
    event.preventDefault();
    event.stopPropagation();
    togglePanel();
  });

  // 편집 프로그램처럼 I / O 로 시작점·끝점을 찍는다.
  listen(document, "keydown", (event) => {
    if (!state.open || event.ctrlKey || event.altKey || event.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (event.key === "i" || event.key === "I") markHere("start");
    else if (event.key === "o" || event.key === "O") markHere("end");
    // 양 끝으로 보내기. 편집 프로그램에서 Home/End 가 하는 일과 같다.
    else if (event.key === "Home") markEdge("start");
    else if (event.key === "End") markEdge("end");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  // 유튜브는 페이지를 새로 그리지 않고 영상만 갈아끼운다.
  // 창 크기가 바뀌면 띄운 패널이 설 자리도 달라진다.
  listen(window, "resize", placeFloatingPanel);

  // 화면을 갈아 끼웠다고 유튜브가 알려주는 순간. 아래 1초 시계가 어차피 다시 붙이지만,
  // 그때까지 버튼이 비어 있는 게 눈에 보인다. 알려주면 바로 붙인다.
  listen(window, "yt-navigate-finish", () => mount());

  // 테마를 밝게/어둡게 바꾸면 옆 버튼의 색이 달라진다. 다시 재서 맞춘다.
  const themeWatch = new MutationObserver(() => {
    state.matched = false;
    matchNeighbour();
  });
  themeWatch.observe(document.documentElement, { attributeFilter: ["dark"] });
  cleanup.push(() => themeWatch.disconnect());

  let lastId = currentVideoId();
  const ticker = setInterval(() => {
    mount();
    maybeAutoOpen();
    placeFloatingPanel();
    // 영상 길이는 늦게 정해진다(특히 라이브). 손대기 전이라면 전 구간을 따라간다.
    if (state.open && !state.touched) selectWhole();
    // "끝까지"로 둔 상태면 라이브가 나아가는 만큼 끝점도 함께 민다.
    else if (state.open && state.toEnd) {
      const edge = bounds();
      if (edge.end > state.end + 0.5) {
        state.end = edge.end;
        render();
      }
    }
    const id = currentVideoId();
    if (id && id !== lastId) {
      lastId = id;
      state.formats = null;
      state.videoId = id;
      state.touched = false;
      // 남은 조각 여부는 영상마다 따로다. 목록을 다시 받을 때 다시 알아본다.
      state.hasLeftovers = false;
      // 이전 영상의 재생 위치를 새 영상에 쓰면 안 된다.
      state.progress = null;
      state.progressAt = null;
      // 열려 있으면 새 영상 목록으로 갈아끼우고, 닫혀 있으면 열 때 받는다.
      if (state.open) loadFormats();
      else render();
    }
  }, 1000);
  cleanup.push(() => clearInterval(ticker));
})().catch((error) => {
  console.error("[yt-download] 시작하지 못했습니다:", error);
});

})();
