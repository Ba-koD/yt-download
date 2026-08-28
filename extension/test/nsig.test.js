// `n` 해제가 조용히 실패하지 않는지 확인한다.
//   deno test --allow-read extension/test/
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { challengeOf, solveUrls } from "../src/nsig.js";

// 해결기 원본을 받아오는 부분은 건드리지 않는다. 시험에서는 빈 파일로 충분하다.
const runtime = { getURL: () => "data:text/plain," };

const 주소 = (n) => `https://rr1.googlevideo.com/videoplayback?itag=140&n=${n}&c=TVHTML5_SIMPLY`;

Deno.test("주소에서 n 을 뽑아낸다", () => {
  assertEquals(challengeOf(주소("ABCDEFGH")), "ABCDEFGH");
  assertEquals(challengeOf("https://x/videoplayback?itag=140"), null);
});

Deno.test("n 이 없으면 그대로 돌려준다", async () => {
  const urls = ["https://x/videoplayback?itag=140"];
  let 불렸나 = false;
  const out = await solveUrls(urls, { runtime, ask: () => { 불렸나 = true; } });
  assertEquals(out, urls);
  assertEquals(불렸나, false);
});

Deno.test("푼 값으로 주소를 바꾼다", async () => {
  const out = await solveUrls([주소("길다란원본값")], {
    runtime,
    ask: () => ({ answers: { 길다란원본값: "짧은답" } }),
  });
  assertEquals(challengeOf(out[0]), "짧은답");
});

Deno.test("답이 빠지면 한 번 더 물어본다", async () => {
  const 물어본것 = [];
  const out = await solveUrls([주소("가"), 주소("나")], {
    runtime,
    ask: ({ challenges }) => {
      물어본것.push([...challenges]);
      // 처음에는 하나만 답한다. 두 번째에 나머지를 답한다.
      return 물어본것.length === 1 ? { answers: { 가: "A" } } : { answers: { 나: "B" } };
    },
  });
  assertEquals(물어본것, [["가", "나"], ["나"]]);
  assertEquals(out.map(challengeOf), ["A", "B"]);
});

Deno.test("끝내 못 풀면 조용히 넘어가지 않고 알린다", async () => {
  // 안 풀린 주소를 그대로 돌려주면 나중에 403 이 나서 원인을 찾기 어렵다.
  await assertRejects(
    () => solveUrls([주소("가")], { runtime, ask: () => ({ answers: {} }) }),
    Error,
    "n 을 풀지 못했습니다",
  );
});

Deno.test("답 자체가 없으면 알린다", async () => {
  await assertRejects(
    () => solveUrls([주소("가")], { runtime, ask: () => ({}) }),
    Error,
    "n 을 풀지 못했습니다",
  );
});
