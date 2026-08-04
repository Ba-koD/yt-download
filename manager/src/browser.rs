//! 어느 브라우저에 넣을지 고르게 하고, 그 브라우저에 맞는 안내를 준다.
//!
//! 확장 폴더는 하나이고 크로미움 계열은 모두 같은 폴더를 읽는다. 브라우저마다 다른 것은
//! **확장 페이지 주소**뿐이다(`chrome://extensions`, `edge://extensions` …).
//!
//! 페이지를 우리가 대신 열어줄 수는 없다. 크로미움은 명령줄로 넘긴 `chrome://` 주소를
//! 무시한다(직접 확인했다 — 새 탭이 열린다). 그래서 주소를 복사해 주는 데까지만 한다.
//!
//! 다만 **폴더가 있다는 것과 그 브라우저가 그 폴더를 얹었다는 것은 다른 이야기다.**
//! 폴더 하나를 여러 브라우저가 함께 쓰지만, "압축해제된 확장 로드"는 브라우저마다
//! 한 번씩 해줘야 한다. 크롬에만 얹어둔 채 엣지에서 열면 버튼이 없다(실제로 그랬다).
//! 그래서 브라우저마다 얹혀 있는지를 따로 본다 — 크로미움은 얹은 확장의 폴더 경로를
//! 프로필의 `Preferences` 에 적어두므로 그걸 읽으면 알 수 있다.
//!
//! # 프로그램으로 설치하는 길은 전부 막혀 있다 (하나씩 재서 확인함)
//!
//! 여기서 읽기만 하는 이유다. 넣는 일은 사람이 한 번 해야 한다.
//!
//! **정책 강제설치**(`ExtensionInstallForcelist`): 안 된다. 크로미움은
//! **웹 스토어가 아닌 update URL 을 조용히 버린다.** 같은 정책 키에 웹 스토어 확장과
//! 우리 것을 나란히 넣고 돌려보면 웹 스토어 것만 깔리고, 우리 확장은 로그에 ID 조차
//! 나오지 않는다(요청을 아예 안 한다). `chrome://policy` 에는 오류 없이 잘 실려 있다.
//! `ExtensionSettings` + `override_update_url` 도 마찬가지다.
//!
//! 게다가 정책을 쓰면 대가가 크다 — 브라우저에 "조직에서 관리하는 브라우저입니다" 가
//! 계속 뜨고, `HKCU\SOFTWARE\Policies` 는 윈도우가 잠가둬서(사용자에게 읽기만 준다)
//! 쓰려면 관리자 권한이 필요하다.
//!
//! **레지스트리 사이드로드**(`Software\Google\Chrome\Extensions`): 문서상 웹 스토어 확장만
//! 되고, Chrome 33 부터 로컬 CRX 설치가 막혔다.
//!
//! **웹사이트에서 설치**: `chrome.webstore.install()` 인라인 설치는 Chrome 71(2018)에서
//! API 째로 사라졌다. `ExtensionInstallSources` 로 출처를 허용하고 CRX 를
//! `application/x-chrome-extension` 으로 내려줘도 — 크롬이 받아만 가고 아무 일도 안 한다.
//!
//! **개발자 도구 프로토콜**(`Extensions.loadUnpacked`): 기능 자체는 완벽히 된다. 그런데
//! 크롬 136 부터 기본 프로필에서는 디버깅 포트를 안 열어주고, 경로를 바꿔(정션 등) 우회하면
//! **크롬이 다른 암호화 키를 쓴다** — 그 프로필의 로그인이 풀린다. 우회를 막으려고 만든
//! 방어막이라 우회하면 대가를 치른다.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::Serialize;

/// 이 확장의 ID. `extension/manifest.json` 의 `key` 에서 나온다.
///
/// `key` 를 박아두는 이유는 **ID 를 고정하기 위해서다.** 압축해제 확장의 ID 는 원래
/// 얹은 폴더 경로에서 나와서, 폴더가 다르면 같은 확장도 다른 ID 가 된다. 그러면
/// "이 프로필에 얹혀 있나" 를 ID 로 물을 수 없다. `key` 가 있으면 어디서 얹든 ID 가 같다.
pub const EXTENSION_ID: &str = "gddgamjmdkmoobgnliipmenchgejaefi";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Browser {
    /// 화면과 코드가 함께 쓰는 이름.
    pub key: &'static str,
    pub label: &'static str,
    /// 확장 페이지 주소.
    pub page: &'static str,
}

pub const BROWSERS: &[Browser] = &[
    Browser {
        key: "chrome",
        label: "Chrome",
        page: "chrome://extensions",
    },
    Browser {
        key: "edge",
        label: "Edge",
        page: "edge://extensions",
    },
    Browser {
        key: "brave",
        label: "Brave",
        page: "brave://extensions",
    },
    Browser {
        key: "whale",
        label: "Whale",
        page: "whale://extensions",
    },
    Browser {
        key: "vivaldi",
        label: "Vivaldi",
        page: "vivaldi://extensions",
    },
    Browser {
        key: "opera",
        label: "Opera",
        page: "opera://extensions",
    },
];

/// 목록에서 키로 하나 찾는다.
pub fn find(key: &str) -> Option<&'static Browser> {
    BROWSERS.iter().find(|browser| browser.key == key)
}

/// 그 브라우저가 이 컴퓨터에 깔려 있는지.
pub fn is_installed(key: &str) -> bool {
    browser_executable(key).is_some() || user_data_dir(key).is_some_and(|dir| dir.is_dir())
}

/// 그 브라우저에 우리 확장이 얹혀 있는지, 그리고 어떤 방식으로인지.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Loaded {
    /// 프로필을 찾지 못했거나 읽지 못했다. "아니다"가 아니라 **모르겠다**는 뜻이다.
    /// 모르는 것을 안 얹혔다고 잘라 말하면 멀쩡히 쓰는 사람에게 헛수고를 시킨다.
    #[default]
    Unknown,
    /// 얹은 흔적이 없다.
    No,
    /// 관리자가 갈아 끼우는 그 폴더를 얹었다. 정상 상태다.
    /// 폴더는 관리자가 갱신하고, 갈아 끼우면 확장이 스스로 다시 켜진다.
    Folder,
    /// 우리 확장이긴 한데 다른 폴더로 얹혀 있다.
    /// 관리자는 자기 폴더만 갈아 끼우므로, 그 브라우저에는 갱신이 닿지 않는다.
    Elsewhere { path: String },
}

/// 어떻게 얹혀 있는지와, 그 브라우저에 실제로 깔린 버전.
///
/// 버전은 브라우저에게 직접 물어야 한다. 폴더 버전을 그대로 보여주면, 폴더만 새것이고
/// 브라우저는 아직 옛 판인 순간에 거짓말이 된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub state: Loaded,
    pub version: Option<String>,
}

impl Presence {
    fn plain(state: Loaded) -> Self {
        Presence {
            state,
            version: None,
        }
    }
}

/// 브라우저 프로필 하나. 화면의 프로필 고르개가 이걸 그대로 쓴다.
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    /// 폴더 이름(`Default`, `Profile 1` …). 어느 것을 골랐는지 기억할 때 쓴다.
    pub dir: String,
    /// 사람이 보는 이름. 브라우저가 `Local State` 에 적어둔 것을 그대로 쓴다.
    pub name: String,
    /// 로그인한 계정. 이름이 겹칠 때 이걸로 가린다.
    pub account: Option<String>,
    /// 이 프로필에 우리 확장이 얹혀 있는지.
    pub state: Loaded,
    /// 이 프로필에 깔린 확장 버전.
    pub version: Option<String>,
}

/// 그 브라우저의 프로필들과, 각 프로필의 확장 상태.
///
/// **확장은 프로필마다 따로 저장된다**(공용 자리가 없다). 그래서 "이 브라우저에 얹혀
/// 있나" 라는 질문은 성립하지 않는다 — 프로필마다 따로 물어야 한다. 프로필이 여섯 개인
/// 환경에서 한 곳에만 얹어두고 "얹혀 있음" 이라고 하면 나머지 다섯에서 왜 버튼이 없는지
/// 알 수 없다.
pub fn profiles(key: &str, dir: &Path) -> Vec<Profile> {
    let Some(root) = user_data_dir(key).filter(|root| root.is_dir()) else {
        return Vec::new();
    };
    let named = profile_names(&root);
    let wanted = normalize(dir);

    let mut found: Vec<Profile> = profile_dirs(key)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().to_string();
            // 사용자 폴더 자체는 프로필이 아니다(오페라처럼 겹치는 경우가 있어 걸러낸다).
            if name != "Default" && !name.starts_with("Profile ") {
                return None;
            }
            let presence = presence_in(&path, &wanted);
            let info = named.get(&name);
            Some(Profile {
                name: info
                    .map(|(label, _)| label.clone())
                    .unwrap_or_else(|| name.clone()),
                account: info.and_then(|(_, account)| account.clone()),
                dir: name,
                state: presence.state,
                version: presence.version,
            })
        })
        .collect();

    // 브라우저가 보여주는 순서를 그대로 따른다.
    let order = profile_order(&root);
    found.sort_by_key(|profile| {
        order
            .iter()
            .position(|dir| dir == &profile.dir)
            .unwrap_or(usize::MAX)
    });
    found
}

/// `Local State` 에 적힌 프로필 이름과 계정.
fn profile_names(root: &Path) -> std::collections::HashMap<String, (String, Option<String>)> {
    let mut names = std::collections::HashMap::new();
    let Ok(bytes) = std::fs::read(root.join("Local State")) else {
        return names;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return names;
    };
    let cache = value
        .get("profile")
        .and_then(|node| node.get("info_cache"))
        .and_then(serde_json::Value::as_object);
    for (dir, info) in cache.into_iter().flatten() {
        let label = info
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(dir)
            .to_string();
        let account = info
            .get("user_name")
            .and_then(serde_json::Value::as_str)
            .filter(|account| !account.is_empty())
            .map(ToOwned::to_owned);
        names.insert(dir.clone(), (label, account));
    }
    names
}

/// 브라우저가 프로필을 보여주는 순서.
fn profile_order(root: &Path) -> Vec<String> {
    std::fs::read(root.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("profile")
                .and_then(|node| node.get("profiles_order"))
                .and_then(serde_json::Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// 프로필 하나를 읽어 우리 확장이 얹혀 있는지 본다.
///
/// 두 가지를 본다.
///
///  - **확장 ID** — 매니페스트에 `key` 를 박아둔 뒤로는 어떻게 얹든 ID 가 같다.
///  - **폴더 경로** — `key` 가 없던 시절에 얹은 것은 ID 가 다르다. 그때 얹은 것도 알아본다.
fn presence_in(profile: &Path, wanted: &str) -> Presence {
    let mut read_any = false;
    let mut elsewhere = None;

    // 확장 목록이 어느 파일에 적히는지는 판마다 다르다(요즘 크롬은 Secure Preferences 다).
    // 둘 다 본다.
    for name in ["Preferences", "Secure Preferences"] {
        let Ok(bytes) = std::fs::read(profile.join(name)) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        read_any = true;
        let Some(settings) = value
            .get("extensions")
            .and_then(|node| node.get("settings"))
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };

        // ID 로 바로 찾는다. 이게 걸리면 어떻게 얹혔는지까지 알 수 있다.
        if let Some(entry) = settings.get(EXTENSION_ID) {
            let path = entry.get("path").and_then(serde_json::Value::as_str);
            let version = entry
                .get("manifest")
                .and_then(|node| node.get("version"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
            let state = match path {
                // 압축해제 확장은 얹은 폴더를 그대로 적는다. 절대 경로면 그것이다.
                Some(path) if Path::new(path).is_absolute() => {
                    if normalize(Path::new(path)) == wanted {
                        Loaded::Folder
                    } else {
                        Loaded::Elsewhere {
                            path: path.to_string(),
                        }
                    }
                }
                // 경로가 없거나 상대 경로면 브라우저가 자기 폴더에 받아둔 것이다.
                // 우리가 얹은 것은 늘 절대 경로라, 여기 오면 우리 소관이 아니다.
                _ => Loaded::Unknown,
            };
            return Presence { state, version };
        }

        // 매니페스트에 `key` 가 없던 시절에 얹은 것. ID 가 달라서 경로로만 알아본다.
        for entry in settings.values() {
            let Some(path) = entry.get("path").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if normalize(Path::new(path)) == wanted {
                return Presence::plain(Loaded::Folder);
            }
            if elsewhere.is_none() && is_our_folder(Path::new(path)) {
                elsewhere = Some(path.to_string());
            }
        }
    }

    Presence::plain(match (elsewhere, read_any) {
        (Some(path), _) => Loaded::Elsewhere { path },
        (None, true) => Loaded::No,
        (None, false) => Loaded::Unknown,
    })
}

/// 그 폴더가 우리 확장인지. manifest 의 이름으로 가린다.
///
/// 크롬에 저장소 폴더를 직접 얹어 쓰는 경우가 있다(개발할 때 그렇게 한다).
/// 그때 "안 얹혔다"고 하면 거짓말이 된다 — 얹혀 있되 갱신이 닿지 않을 뿐이다.
fn is_our_folder(path: &Path) -> bool {
    // 브라우저가 딸려 보내는 내장 확장은 수십 개다. 그 안까지 읽을 이유가 없다.
    if !path.is_absolute() {
        return false;
    }
    let Ok(bytes) = std::fs::read(path.join("manifest.json")) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(|name| name.contains("yt-download"))
        })
        .unwrap_or(false)
}

/// 경로를 견주기 좋게 다듬는다. 윈도우는 대소문자를 가리지 않고 `\` 와 `/` 를 함께 쓴다.
fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

/// 프로필 폴더들(`Default`, `Profile 1` …). 어느 프로필에 얹었는지는 알 수 없으니 다 본다.
fn profile_dirs(key: &str) -> Option<Vec<PathBuf>> {
    let root = user_data_dir(key)?;
    if !root.is_dir() {
        return None;
    }
    // 오페라처럼 사용자 폴더가 곧 프로필인 것도 있다. 그 자리도 후보에 넣는다.
    let mut found = vec![root.clone()];
    for entry in std::fs::read_dir(&root).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "Default" || name.starts_with("Profile ") {
            found.push(entry.path());
        }
    }
    Some(found)
}

#[cfg(windows)]
pub fn user_data_dir(key: &str) -> Option<PathBuf> {
    let local = dirs::data_local_dir()?;
    let roaming = dirs::data_dir()?;
    Some(match key {
        "chrome" => local.join(r"Google\Chrome\User Data"),
        "edge" => local.join(r"Microsoft\Edge\User Data"),
        "brave" => local.join(r"BraveSoftware\Brave-Browser\User Data"),
        "whale" => local.join(r"Naver\Naver Whale\User Data"),
        "vivaldi" => local.join(r"Vivaldi\User Data"),
        "opera" => roaming.join(r"Opera Software\Opera Stable"),
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub fn user_data_dir(key: &str) -> Option<PathBuf> {
    let support = dirs::home_dir()?.join("Library/Application Support");
    Some(match key {
        "chrome" => support.join("Google/Chrome"),
        "edge" => support.join("Microsoft Edge"),
        "brave" => support.join("BraveSoftware/Brave-Browser"),
        "whale" => support.join("Naver/Whale"),
        "vivaldi" => support.join("Vivaldi"),
        "opera" => support.join("com.operasoftware.Opera"),
        _ => return None,
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn user_data_dir(key: &str) -> Option<PathBuf> {
    let config = dirs::config_dir()?;
    Some(match key {
        "chrome" => config.join("google-chrome"),
        "edge" => config.join("microsoft-edge"),
        "brave" => config.join("BraveSoftware/Brave-Browser"),
        "whale" => config.join("naver-whale"),
        "vivaldi" => config.join("vivaldi"),
        "opera" => config.join("opera"),
        _ => return None,
    })
}

/// 이 컴퓨터의 기본 브라우저. 목록에 없는 것(파이어폭스·사파리)이면 `None`.
pub fn default_key() -> Option<&'static str> {
    let raw = default_browser_id()?.to_ascii_lowercase();
    // 브라우저마다 자기 이름을 조금씩 다르게 적어서(BraveHTML, brave-browser.desktop …)
    // 이름이 들어 있는지만 본다.
    BROWSERS
        .iter()
        .find(|browser| raw.contains(browser.key))
        .map(|browser| browser.key)
}

/// 주소를 연다. 고른 브라우저가 있으면 그 브라우저로, 없으면 기본 브라우저로.
///
/// 확장이 그 브라우저에 들어 있으므로 changelog 도 같은 브라우저로 보여주는 편이 자연스럽다.
/// 실행 파일을 못 찾으면 OS 기본 열기로 넘어간다(적어도 뜨긴 한다).
pub fn open_url(url: &str, prefer: Option<&str>) {
    if let Some(exe) = prefer.and_then(browser_executable) {
        if crate::proc::command(&exe).arg(url).spawn().is_ok() {
            return;
        }
    }
    open_with_os(url);
}

/// 확장 관리 화면을 열 수 있게 창을 띄우고 주소를 복사해 준다.
///
/// **크로미움은 명령줄로 넘긴 `chrome://` 주소를 무시한다**(여러 번 확인했다 — 빈 창만
/// 하나 뜬다. `chrome://extensions` 도 `chrome://version` 도 똑같았다). 그래서 우리가
/// 대신 열어줄 수는 없고, 창을 띄우고 주소를 클립보드에 넣는 데까지만 한다.
/// 사용자는 그 창에서 붙여넣기만 하면 된다.
///
/// 확장이 처음 깔릴 때는 확장 자신이 이 화면을 연다(`background.js`). 확장 안에서는
/// `chrome://` 를 열 수 있어서, 정책으로 조용히 깔려도 사용자가 알아챌 수 있다.
///
/// 돌려주는 값은 클립보드에 넣었는지 여부다.
pub fn open_browser_page(key: &str, page: &str) -> bool {
    if let Some(exe) = browser_executable(key) {
        let _ = crate::proc::command(&exe).arg(page).spawn();
    }
    copy_to_clipboard(page)
}

fn open_with_os(url: &str) {
    let mut command = if cfg!(windows) {
        let mut command = crate::proc::command("cmd");
        command.args(["/c", "start", ""]);
        command
    } else if cfg!(target_os = "macos") {
        crate::proc::command("open")
    } else {
        crate::proc::command("xdg-open")
    };
    let _ = command.arg(url).spawn();
}

/// 고른 브라우저의 실행 파일 자리. 못 찾으면 `None`(기본 열기로 넘어간다).
#[cfg(windows)]
pub fn browser_executable(key: &str) -> Option<PathBuf> {
    // 설치된 브라우저의 실행 파일 자리는 App Paths 에 적혀 있다.
    let app = match key {
        "chrome" => "chrome.exe",
        "edge" => "msedge.exe",
        "brave" => "brave.exe",
        "whale" => "whale.exe",
        "vivaldi" => "vivaldi.exe",
        "opera" => "launcher.exe",
        _ => return None,
    };
    for root in ["HKCU", "HKLM"] {
        let key_path = format!(r"{root}\Software\Microsoft\Windows\CurrentVersion\App Paths\{app}");
        let output = crate::proc::command("reg")
            .args(["query", &key_path, "/ve"])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // "    (기본값)    REG_SZ    C:\...\chrome.exe" 에서 경로만 꺼낸다.
        if let Some(path) = text.lines().find_map(|line| {
            line.find("REG_SZ")
                .map(|at| line[at + "REG_SZ".len()..].trim().to_string())
        }) {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub fn browser_executable(key: &str) -> Option<PathBuf> {
    // macOS 는 앱 번들이라 open -a 로 여는 편이 낫다. 여기서는 기본 열기에 맡긴다.
    let _ = key;
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn browser_executable(key: &str) -> Option<PathBuf> {
    // PATH 에서 흔한 실행 파일 이름을 찾는다.
    let candidates: &[&str] = match key {
        "chrome" => &["google-chrome", "google-chrome-stable", "chromium"],
        "edge" => &["microsoft-edge", "microsoft-edge-stable"],
        "brave" => &["brave-browser", "brave"],
        "vivaldi" => &["vivaldi", "vivaldi-stable"],
        "opera" => &["opera"],
        _ => return None,
    };
    for name in candidates {
        if let Ok(output) = crate::proc::command("which").arg(name).output() {
            if output.status.success() {
                let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn default_browser_id() -> Option<String> {
    // https 를 여는 프로그램이 곧 기본 브라우저다.
    let output = crate::proc::command("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
            "/v",
            "ProgId",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // "    ProgId    REG_SZ    ChromeHTML" 형태에서 마지막 토막만 꺼낸다.
    text.lines()
        .find(|line| line.contains("ProgId"))
        .and_then(|line| line.split_whitespace().last())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "macos")]
fn default_browser_id() -> Option<String> {
    let output = crate::proc::command("defaults")
        .args([
            "read",
            "com.apple.LaunchServices/com.apple.launchservices.secure",
            "LSHandlers",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // https 를 맡은 항목의 바로 앞줄에 프로그램 이름이 적혀 있다.
    let lines: Vec<&str> = text.lines().collect();
    let index = lines
        .iter()
        .position(|line| line.contains("LSHandlerURLScheme = https"))?;
    lines[..index]
        .iter()
        .rev()
        .find(|line| line.contains("LSHandlerRoleAll"))
        .map(|line| line.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_browser_id() -> Option<String> {
    let output = crate::proc::command("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 글자를 클립보드에 넣는다. 붙여넣을 곳이 확장 페이지 주소창과 파일 선택 창이라
/// 복사만 해줘도 손이 많이 준다.
pub fn copy_to_clipboard(text: &str) -> bool {
    let mut command = if cfg!(windows) {
        let mut command = crate::proc::command("cmd");
        command.args(["/c", "clip"]);
        command
    } else if cfg!(target_os = "macos") {
        crate::proc::command("pbcopy")
    } else {
        let mut command = crate::proc::command("xclip");
        command.args(["-selection", "clipboard"]);
        command
    };

    let Ok(mut child) = command.stdin(Stdio::piped()).spawn() else {
        return false;
    };
    let wrote = child
        .stdin
        .as_mut()
        .map(|stdin| {
            use std::io::Write;
            stdin.write_all(text.as_bytes()).is_ok()
        })
        .unwrap_or(false);
    let done = child.wait().map(|status| status.success()).unwrap_or(false);
    wrote && done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 브라우저마다_확장_페이지_주소가_다르다() {
        for browser in BROWSERS {
            assert!(browser.page.ends_with("://extensions"), "{}", browser.page);
            assert!(browser.page.starts_with(browser.key), "{}", browser.page);
        }
        // 기본 브라우저를 못 알아내도 목록은 그대로 쓸 수 있어야 한다.
        assert!(BROWSERS.iter().any(|browser| browser.key == "chrome"));
    }

    #[test]
    fn 얹은_폴더는_적힌_모양이_달라도_같은_것으로_본다() {
        // 크로미움은 `\` 로 적고 우리는 `/` 로 이어 붙이기도 한다. 윈도우는 대소문자도 안 가린다.
        let a = normalize(Path::new(
            r"C:\Users\me\AppData\Local\yt-download\extension",
        ));
        let b = normalize(Path::new(
            "C:/Users/me/AppData/Local/yt-download/extension/",
        ));
        assert_eq!(a, b);
        if cfg!(windows) {
            assert_eq!(
                a,
                normalize(Path::new(
                    r"c:\users\me\appdata\local\YT-DOWNLOAD\extension"
                ))
            );
        }
        // 다른 폴더까지 같다고 하면 안 된다.
        assert_ne!(
            a,
            normalize(Path::new(r"C:\Users\me\yt-download\extension"))
        );
    }

    #[test]
    fn 모르는_브라우저는_프로필이_없다() {
        // 목록에 없는 브라우저를 물으면 빈 목록이 나와야 한다. 지어내면 안 된다.
        assert!(profiles("firefox", Path::new("/nowhere")).is_empty());
    }

    #[test]
    fn 읽을수_없는_프로필은_안_얹혔다고_말하지_않는다() {
        // "모르겠다"와 "아니다"를 섞으면 멀쩡히 쓰는 사람에게 헛수고를 시킨다.
        assert_eq!(
            presence_in(Path::new("/nowhere-at-all"), "/nowhere").state,
            Loaded::Unknown
        );
    }
}
