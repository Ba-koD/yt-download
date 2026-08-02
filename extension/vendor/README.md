# 가져다 쓴 코드

## yt-solver-lib.js / yt-solver-core.js

- 출처: [yt-dlp/ejs](https://github.com/yt-dlp/ejs) 0.8.0 릴리스
  (`yt.solver.lib.min.js`, `yt.solver.core.min.js`)
- 라이선스: Unlicense (퍼블릭 도메인)

유튜브가 미디어 주소에 붙이는 `n` 파라미터를 푸는 데 씁니다.
`n` 을 풀지 않은 주소로 요청하면 유튜브가 **403** 을 줍니다. 직접 재본 결과입니다.

```
올바른 n  -> HTTP 206
뒤집은 n  -> HTTP 403
n 제거    -> HTTP 403
```

공개 영상은 `ANDROID_VR` 클라이언트가 `n` 없는 주소를 주기 때문에 이 코드가 필요 없습니다.
로그인이 필요한 영상(내 비공개·멤버 전용)은 웹 계열 클라이언트로만 열리는데,
그쪽 주소에는 항상 `n` 이 붙습니다. 그래서 이때만 씁니다.

`lib` 은 자바스크립트 파서(meriyah)와 생성기(astring)를 담고 있고,
`core` 가 그걸로 `base.js` 를 뜯어 `n` 변환 부분을 찾아냅니다.

## 갱신하는 법

릴리스에서 두 파일을 받아 그대로 덮어씁니다.

```bash
curl -sL https://github.com/yt-dlp/ejs/releases/download/<버전>/yt.solver.lib.min.js \
  -o extension/vendor/yt-solver-lib.js
curl -sL https://github.com/yt-dlp/ejs/releases/download/<버전>/yt.solver.core.min.js \
  -o extension/vendor/yt-solver-core.js
```

부르는 방법은 `src/nsig.js` 에 있습니다. yt-dlp 쪽이 호출 규약을 바꾸면
`yt_dlp/extractor/youtube/jsc/_builtin/ejs.py` 의 `_construct_stdin` 을 보면 됩니다.
