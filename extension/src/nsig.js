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
export async function solveUrls(urls, { runtime, ask, onStep }) {
  const challenges = [...new Set(urls.map(challengeOf).filter(Boolean))];
  if (!challenges.length) return urls;

  onStep?.("주소를 푸는 중입니다");
  const { lib, core } = await loadSolver(runtime);
  const answered = await ask({ lib, core, challenges });
  const answers = answered?.answers;
  if (!answers) throw new Error("n 을 풀지 못했습니다");

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
