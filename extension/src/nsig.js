// 유튜브가 미디어 주소에 붙이는 `n` 파라미터를 푼다.
//
// 왜 필요한가: 로그인해야 볼 수 있는 영상(내 비공개·멤버 전용)은 웹 계열 클라이언트로만
// 열리는데, 그쪽이 주는 주소에는 항상 `n` 이 붙는다. 풀지 않고 요청하면 403 이다.
// 직접 재본 결과 — 올바른 n: 206 / 뒤집은 n: 403 / n 제거: 403.
//
// 공개 영상은 `ANDROID_VR` 이 `n` 없는 주소를 주므로 이 길로 오지 않는다.
//
// 푸는 일 자체는 유튜브 플레이어(base.js)를 뜯어야 해서 yt-dlp 쪽 해결기를 그대로 쓴다
// (`vendor/` 참고). 그 코드는 일꾼(worker) 안에서 돌린다 — 이유는 solver-worker.js 참고.

import { request } from "./net.js";

const FILES = {
  worker: "src/solver-worker.js",
  lib: "vendor/yt-solver-lib.js",
  core: "vendor/yt-solver-core.js",
};

let ready = null;

/**
 * 일꾼을 띄우고 해결기 코드를 읽어둔다. 한 번만 한다.
 *
 * 일꾼은 여기(content script)에서 만든다. 페이지 쪽에서 만들면 유튜브의 CSP 가
 * blob 일꾼을 막아 조용히 실패한다. content script 는 그 규칙을 타지 않는다.
 */
function boot(runtime) {
  if (ready) return ready;
  ready = (async () => {
    const [worker, lib, core] = await Promise.all(
      [FILES.worker, FILES.lib, FILES.core].map(async (name) =>
        (await fetch(runtime.getURL(name))).text()
      ),
    );
    const blob = new Blob([worker], { type: "text/javascript" });
    return { worker: new Worker(URL.createObjectURL(blob)), lib, core };
  })();
  return ready;
}

let nextId = 1;

function askWorker(worker, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const done = (fn, value) => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      clearTimeout(timer);
      fn(value);
    };
    const onMessage = (event) => {
      if (event.data?.id !== id) return;
      if (event.data.ok) done(resolve, event.data.answers);
      else done(reject, new Error(event.data.error || "n 을 풀지 못했습니다"));
    };
    const onError = (event) =>
      done(reject, new Error(`해결기를 띄우지 못했습니다: ${event.message || "이유 없음"}`));
    const timer = setTimeout(
      () => done(reject, new Error("n 을 푸는 데 너무 오래 걸립니다")),
      timeoutMs,
    );
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, ...payload });
  });
}

/**
 * 주소들의 `n` 을 풀어 새 주소로 바꿔 돌려준다.
 *
 * `n` 이 없는 주소는 그대로 둔다.
 */
export async function solveUrls(urls, { runtime, playerUrl, onStep }) {
  const challenges = [...new Set(urls.map(challengeOf).filter(Boolean))];
  if (!challenges.length) return urls;

  onStep?.("로그인 영상이라 주소를 푸는 중입니다");
  const { worker, lib, core } = await boot(runtime);
  // 플레이어는 2~3MB 다. 일꾼이 첫 번째에 손질해두고 그 뒤로는 다시 받지 않는다.
  const player = await request.text(playerUrl);
  const answers = await askWorker(worker, { lib, core, player, challenges }, 120_000);

  return urls.map((url) => {
    const raw = challengeOf(url);
    const answer = raw && answers[raw];
    return answer ? url.replace(`n=${raw}`, `n=${answer}`) : url;
  });
}

export function challengeOf(url) {
  const match = /[?&]n=([^&]+)/.exec(url);
  return match ? match[1] : null;
}
