// `n` 을 푸는 일만 하는 일꾼.
//
// 왜 따로 떼어놨나: 해결기는 유튜브 플레이어(base.js)를 파싱해서 새 코드를 만들어 돌린다.
// 그런데 유튜브 페이지 안에서 돌리면 두 가지가 걸린다.
//
//  - 유튜브가 내장 함수를 자기 것으로 바꿔치기해 둬서 파서가 엉뚱한 데서 터진다
//    ("Cannot use 'in' operator to search for 'attestationRequest' in null").
//  - 해결기가 준비 과정에서 `globalThis.location` 에 값을 넣는데,
//    창(window)에서는 그게 곧 페이지 이동이라 화면이 날아간다.
//
// 일꾼 안은 유튜브가 손대지 않은 깨끗한 곳이고 `location` 도 바꿀 수 없어 무시된다.

// 유튜브 문서의 규칙(Trusted Types)이 일꾼에도 따라오므로 정책을 하나 만들어 통과시킨다.
function makeEvaluator() {
  const policy = self.trustedTypes?.createPolicy?.("ytdl-solver", { createScript: (s) => s });
  return (source) => (policy ? eval(policy.createScript(source)) : eval(source));
}

let solve = null;
// 손질해둔 플레이어. 두 번째부터는 2~3MB 를 다시 뜯지 않아도 된다.
let prepared = null;

self.onmessage = (event) => {
  const { id, lib, core, player, challenges } = event.data;
  try {
    if (!solve) {
      const run = makeEvaluator();
      // 전역을 더럽히지 않도록 파서를 인자로 넘긴다.
      const parsers = run(`(function () {${lib};return lib; })`)();
      solve = run(`(function (meriyah, astring) {${core};return jsc; })`)(
        parsers.meriyah,
        parsers.astring,
      );
    }

    const requests = [{ type: "n", challenges }];
    const result = solve(
      prepared
        ? { type: "preprocessed", preprocessed_player: prepared, requests }
        : { type: "player", player, requests, output_preprocessed: true },
    );

    if (result?.type === "error") throw new Error(result.error || "해결기 오류");
    if (result.preprocessed_player) prepared = result.preprocessed_player;

    const first = result.responses?.[0];
    if (first?.type !== "result") throw new Error(first?.error || "n 을 풀지 못했습니다");
    self.postMessage({ id, ok: true, answers: first.data });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
