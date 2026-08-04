// 배경 일꾼이 하는 일 두 가지.
//
// 1. 페이지 쪽에서 막혔을 때의 예비 통로(미디어 내려받기)
// 2. 관리자가 폴더를 갈아 끼웠을 때 스스로 새 판으로 갈아타기
//
// googlevideo 가 다른 호스트로 넘기면(cms_redirect) 넘어간 응답에 CORS 헤더가 없어서
// 페이지에서는 읽을 수 없다. 배경 일꾼은 host_permissions 덕분에 그 제한을 받지 않는다.
//
// 다만 chrome.runtime.sendMessage 는 JSON 직렬화라 ArrayBuffer 를 그대로 못 보낸다.
// 그래서 여기서 base64 로 바꿔 보낸다(느리지만 예비 경로에서만 쓴다).

const FOLDER_CHECK = "ytdl-folder-check";
const REINJECT_FLAG = "ytdl-reinject";
const RELOAD_TRIES = "ytdl-reload-tries";
/// 스스로 갈아타지 못했을 때, 화면이 사람에게 알리기 위해 보는 표시.
const MANUAL_FLAG = "ytdl-needs-manual-reload";

// 어떤 탭이 지금 받는 중인지. 받는 도중에 다시 켜면 그 작업이 통째로 날아간다.
const busyTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "busy") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      if (message.on) busyTabs.add(tabId);
      else busyTabs.delete(tabId);
    }
    return false;
  }

  // 유튜브 페이지가 열릴 때마다 한 번 본다. 알람만 믿으면 최대 몇 분을 기다리게 된다.
  // 스스로 갈아타지 못한 상태라면 화면이 사람에게 알릴 수 있도록 그 사실을 돌려준다.
  if (message?.type === "check-folder") {
    chrome.storage.local
      .get(MANUAL_FLAG)
      .then((stored) => sendResponse({ needsManualReload: stored?.[MANUAL_FLAG] ?? null }))
      .catch(() => sendResponse({ needsManualReload: null }));
    applyIfFolderChanged();
    return true; // 비동기로 답한다
  }

  if (message?.type !== "bytes") return false;
  fetchBytes(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true; // 비동기로 답한다
});

async function fetchBytes({ url, headers }) {
  const response = await fetch(url, { headers, credentials: "omit" });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  return { ok: true, base64: toBase64(new Uint8Array(await response.arrayBuffer())) };
}

function toBase64(bytes) {
  // 한 번에 넘기면 인자 개수 제한에 걸리므로 조금씩 이어 붙인다.
  const step = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

// ── 스스로 갈아타기 ────────────────────────────────────────────────────────
//
// 크롬은 스토어 밖 확장을 자동으로 갱신해 주지 않는다. 관리자가 폴더를 갈아 끼워도
// 크롬은 켜질 때 읽어둔 옛 판을 계속 쓰고, 사용자가 chrome://extensions 에서
// 새로고침을 눌러야 반영된다.
//
// 그런데 **파일 자체는 요청할 때마다 디스크에서 읽힌다**(직접 확인했다 — 폴더의 파일을
// 바꾸면 같은 주소로 받아온 내용이 곧바로 달라진다). 그래서 디스크의 manifest.json 을
// 읽어 지금 돌고 있는 판과 견주면, 폴더가 갈렸다는 것을 우리가 먼저 알 수 있다.
// 알았으면 스스로 다시 켠다(chrome.runtime.reload). 사용자가 누를 것이 없어진다.

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(FOLDER_CHECK, { periodInMinutes: 5 });
  applyIfFolderChanged();
  if (details?.reason === "install") showExtensionPage();
});

/**
 * 처음 깔렸을 때 확장 관리 화면을 한 번 열어준다.
 *
 * 정책으로 깔리면 아무 소리 없이 들어와서, 사용자는 깔린 줄도 모른다. 한 번 보여준다.
 *
 * 이 일은 **확장만 할 수 있다.** 명령줄로 넘긴 `chrome://` 주소는 브라우저가 무시한다
 * (관리자에서 여러 번 확인했다 — 빈 창만 하나 뜬다). 확장 안에서는 열린다.
 */
function showExtensionPage() {
  try {
    const url = `chrome://extensions/?id=${chrome.runtime.id}`;
    Promise.resolve(chrome.tabs.create({ url })).catch(() => {
      // 막는 판이 있을 수 있다. 확장은 이미 잘 돌고 있으니 조용히 넘어간다.
    });
  } catch {
    // 위와 같다. 여기서 시끄럽게 굴 이유가 없다.
  }
}

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FOLDER_CHECK, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FOLDER_CHECK) applyIfFolderChanged();
});

/**
 * 스스로 다시 켜는 일은 **되는지 확인하고 물러날 줄 알아야** 한다.
 *
 * 다시 켜기가 먹히지 않는 자리가 있을 수 있어서(예: 개발자 도구로 얹은 확장), 같은 판을
 * 두 번까지만 시도하고 그만둔다. 그만둔 뒤에는 화면이 "새로고침해 달라"고 알려준다.
 * 무한히 다시 켜기를 시도하면 브라우저를 붙잡고 늘어지게 된다.
 */
const RELOAD_LIMIT = 2;

async function applyIfFolderChanged() {
  if (busyTabs.size > 0) return; // 받는 중에 다시 켜면 그 작업이 날아간다
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "reload" });
    const onDisk = await response.json();
    const running = chrome.runtime.getManifest().version;
    if (!onDisk?.version || onDisk.version === running) {
      await chrome.storage.local.remove([RELOAD_TRIES, MANUAL_FLAG]);
      return;
    }

    const stored = await chrome.storage.local.get(RELOAD_TRIES);
    const tries = stored?.[RELOAD_TRIES];
    const count = tries?.version === onDisk.version ? tries.count : 0;
    if (count >= RELOAD_LIMIT) {
      // 두 번 해봤는데도 그대로다. 더 해봐야 소용없으니 사람에게 넘긴다.
      await chrome.storage.local.set({ [MANUAL_FLAG]: onDisk.version });
      return;
    }

    console.info(`[yt-download] 폴더가 ${running} → ${onDisk.version} 로 갈렸습니다. 다시 켭니다`);
    await chrome.storage.local.set({
      [RELOAD_TRIES]: { version: onDisk.version, count: count + 1 },
      // 다시 켜지면 열려 있는 유튜브 탭에 새 판을 넣어야 한다. 그 표시를 남긴다.
      [REINJECT_FLAG]: true,
    });
    chrome.runtime.reload();
  } catch {
    // 다음 차례에 다시 본다. 여기서 시끄럽게 굴 이유가 없다.
  }
}

// 다시 켜진 직후라면, 이미 열려 있는 유튜브 탭에 새 판을 넣는다.
// 이렇게 해야 사용자가 F5 를 누르지 않아도 새 판이 그 자리에서 돈다.
chrome.storage.local.get(REINJECT_FLAG).then((stored) => {
  if (!stored?.[REINJECT_FLAG]) return;
  chrome.storage.local.remove(REINJECT_FLAG);
  reinjectAll();
});

async function reinjectAll() {
  // 유튜브 화면 전부. 지금 홈에 있어도 곧 영상으로 넘어가고, 그때는 크롬이 다시
  // 넣어주지 않는다(유튜브는 화면만 갈아 끼운다). 그래서 미리 넣어둔다.
  const urls = ["https://www.youtube.com/*"];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: urls });
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const target = { tabId: tab.id };
    // 넣는 순서가 중요하다. 페이지 쪽 다리를 먼저 놓아야 새 판이 그것을 쓴다.
    await chrome.scripting
      .executeScript({ target, files: ["src/page-fetch.js"], world: "MAIN" })
      .catch(() => {});
    await chrome.scripting.insertCSS({ target, files: ["src/overlay.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ["src/content.js"] }).catch(() => {});
  }
  if (tabs.length) console.info(`[yt-download] 열려 있던 탭 ${tabs.length}개에 새 판을 넣었습니다`);
}
