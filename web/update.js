// 앱 업데이트. 확인 → 받기 → 다시 켜기, 세 걸음을 단추 하나로 밟는다.
//
// 서버가 실제 일을 한다(릴리스 조회, SHA256 대조, 실행 파일 바꿔 끼우기).
// 여기서는 지금 어느 걸음에 있는지만 보여준다.

import { api } from "./api.js";
import { el } from "./state.js";

// 지금 어느 걸음인지. "idle" | "ready"(받을 것이 있음) | "restart"(바꿔 끼움)
let step = "idle";

function show(note, { bad = false } = {}) {
  if (!el.updateStatus) return;
  el.updateStatus.hidden = !note;
  el.updateStatus.textContent = note || "";
  el.updateStatus.classList.toggle("bad", bad);
}

function label(text, { busy = false, highlight = false } = {}) {
  if (!el.updateButton) return;
  el.updateButton.textContent = text;
  el.updateButton.disabled = busy;
  el.updateButton.classList.toggle("update-ready", highlight);
}

function apply(status) {
  if (status.restart) {
    step = "restart";
    label("다시 켜기", { highlight: true });
  } else if (status.available) {
    step = "ready";
    label(`v${status.latest} 받기`, { highlight: true });
  } else {
    step = "idle";
    label("업데이트 확인");
  }
  show(status.note);
}

/**
 * 새 버전이 있는지 본다.
 *
 * 시작할 때는 조용히 본다. 인터넷이 없거나 저장소가 비공개면 실패하는데,
 * 그건 사용자가 뭘 잘못한 게 아니라서 화면에 붉은 글씨를 띄울 일이 아니다.
 */
export async function checkUpdate({ quiet = false } = {}) {
  if (!el.updateButton) return;
  label("확인 중…", { busy: true });
  try {
    apply(await api("/api/update/check", { method: "POST" }));
  } catch (error) {
    step = "idle";
    label("업데이트 확인");
    if (quiet) show("");
    else show(error.message, { bad: true });
  }
}

async function download() {
  label("받는 중…", { busy: true });
  show("내려받아 검사하는 중입니다. 다 받은 뒤에 바꿔 끼웁니다");
  try {
    apply(await api("/api/update/apply", { method: "POST" }));
  } catch (error) {
    // 여기서 실패해도 쓰던 실행 파일은 그대로다. 다시 눌러보면 된다.
    step = "ready";
    label("다시 받기", { highlight: true });
    show(error.message, { bad: true });
  }
}

async function restart() {
  label("다시 켜는 중…", { busy: true });
  show("새 버전으로 다시 켭니다");
  try {
    await api("/api/update/restart", { method: "POST" });
  } catch (error) {
    label("다시 켜기", { highlight: true });
    show(`${error.message} · 앱을 직접 껐다 켜면 새 버전이 뜹니다`, { bad: true });
  }
}

export function bindUpdate() {
  if (!el.updateButton) return;
  el.updateButton.addEventListener("click", () => {
    if (step === "ready") return download();
    if (step === "restart") return restart();
    return checkUpdate();
  });
}
