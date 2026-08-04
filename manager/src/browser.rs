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
//! # 정책으로 자동 설치
//!
//! 손으로 얹는 일까지 없애는 길은 **정책 강제 설치**뿐이다. 크로미움은 정책에 적힌
//! `<확장ID>;<update.xml 주소>` 를 보고 스스로 내려받아 설치하고, 그 뒤로도 스스로 갱신한다.
//! 개발자 모드도, 압축해제 로드도, 관리자 권한도 필요 없다(정책을 `HKCU` 에 적는다).
//!
//! 대신 브라우저마다 정책을 읽는 레지스트리 자리가 다르고, 벤더 문서가 엇갈리는 곳도 있다.
//! 확실하지 않은 브라우저는 **알려진 자리 모두에 적는다** — 안 보는 자리에 적힌 값은
//! 아무 일도 하지 않고, 해제하면 전부 지운다. 그리고 정말 깔렸는지는 우리 짐작이 아니라
//! **브라우저 프로필을 읽어서** 확인한다(`extension_state`).

use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::Serialize;

/// 이 확장의 ID. `extension/manifest.json` 의 `key`(= CRX 서명키의 공개키)에서 나온다.
///
/// 서명키를 바꾸면 이 값도 바뀌고, 그러면 이미 깔린 확장과 다른 것이 된다.
/// 정책·update.xml·매니페스트 셋이 같은 키를 가리켜야 설치가 된다.
pub const EXTENSION_ID: &str = "gddgamjmdkmoobgnliipmenchgejaefi";

/// 브라우저가 "새 버전 있나" 하고 물어볼 자리. 릴리스마다 같은 주소에 새로 올라간다.
///
/// 정책을 적을 때만 쓴다. 정책은 윈도우에서만 되므로 다른 OS 에서는 이 값도 필요 없다
/// (그냥 두면 리눅스 CI 가 "안 쓰는 상수"로 잡는다 — `-D warnings` 라 빌드가 선다).
#[cfg(windows)]
pub const UPDATE_URL: &str =
    "https://github.com/Ba-koD/yt-download/releases/latest/download/update.xml";

/// 정책을 적을 자리(`HKCU\SOFTWARE\Policies\` 아래).
///
/// 여러 개인 것은 벤더 문서가 엇갈려서다. 안 보는 자리에 적힌 값은 아무 일도 하지 않는다.
#[cfg(windows)]
fn policy_roots(key: &str) -> &'static [&'static str] {
    match key {
        "chrome" => &[r"Google\Chrome"],
        "edge" => &[r"Microsoft\Edge"],
        // 브레이브는 문서마다 Brave-Browser 와 Brave 가 섞여 나온다.
        "brave" => &[r"BraveSoftware\Brave-Browser", r"BraveSoftware\Brave"],
        // 웨일은 정책 문서를 공개하지 않는다. 크로미움 관례대로 둘을 짚어본다.
        "whale" => &[r"Naver\Whale", r"NaverWhale\Whale"],
        "vivaldi" => &["Vivaldi"],
        "opera" => &[r"Opera Software\Opera", r"Opera Software\Opera Stable"],
        _ => &[],
    }
}

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
    /// 정책으로 설치돼 있다. 브라우저가 스스로 갱신하므로 더 손댈 것이 없다.
    Policy,
    /// 관리자가 갈아 끼우는 그 폴더를 압축해제 확장으로 얹었다.
    /// 폴더는 관리자가 갱신하고, 갈아 끼우면 확장이 스스로 다시 켜진다.
    Folder,
    /// 우리 확장이긴 한데 다른 폴더로 얹혀 있다.
    /// 관리자는 자기 폴더만 갈아 끼우므로, 그 브라우저에는 갱신이 닿지 않는다.
    Elsewhere { path: String },
}

/// 정책 목록에 우리 확장이 적혀 있는지.
///
/// 적혀 있다는 것과 실제로 깔렸다는 것은 다르다(브라우저를 한 번 다시 켜야 한다).
/// 그래서 화면은 이 값과 `extension_state` 를 함께 보여준다.
#[cfg(windows)]
pub fn policy_registered(key: &str) -> bool {
    policy_roots(key)
        .iter()
        .any(|root| !policy_entries(root).is_empty())
}

#[cfg(not(windows))]
pub fn policy_registered(key: &str) -> bool {
    let _ = key;
    false
}

/// 이 컴퓨터에서 정책 등록을 쓸 수 있는지. 지금은 윈도우만 된다.
///
/// macOS 는 `.plist`, 리눅스는 `/etc/opt/<브라우저>/policies/managed/` 라 자리도 다르고
/// 리눅스는 root 가 필요하다. 그쪽은 아직 손으로 얹는 길만 있다.
pub const fn policy_supported() -> bool {
    cfg!(windows)
}

// ── 정책 쓰기 ──────────────────────────────────────────────────────────────
//
// `ExtensionInstallForcelist` 는 값 이름이 "1", "2", … 인 목록이다. 남이 쓴 항목을
// 덮어쓰면 그 확장이 조용히 사라지므로, 빈 번호를 찾아 우리 것만 얹는다.

#[cfg(windows)]
fn policy_key_path(root: &str) -> String {
    format!(r"HKCU\SOFTWARE\Policies\{root}\ExtensionInstallForcelist")
}

/// 그 자리에 적힌 우리 항목들의 값 이름.
#[cfg(windows)]
fn policy_entries(root: &str) -> Vec<String> {
    read_policy_values(root)
        .into_iter()
        .filter(|(_, data)| data.starts_with(EXTENSION_ID))
        .map(|(name, _)| name)
        .collect()
}

/// 그 자리에 적힌 값 전부(이름, 내용).
#[cfg(windows)]
fn read_policy_values(root: &str) -> Vec<(String, String)> {
    let Ok(output) = crate::proc::command("reg")
        .args(["query", &policy_key_path(root)])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new(); // 자리 자체가 없다 = 아무것도 안 적혀 있다
    }
    // "    1    REG_SZ    abcd…;https://…" 형태다.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once("    REG_SZ")?;
            Some((name.trim().to_string(), rest.trim().to_string()))
        })
        .collect()
}

/// 고른 브라우저의 정책에 우리 확장을 적는다. 브라우저를 다시 켜면 스스로 설치한다.
#[cfg(windows)]
pub fn register_policy(key: &str) -> anyhow::Result<()> {
    let roots = policy_roots(key);
    if roots.is_empty() {
        anyhow::bail!("이 브라우저는 정책 설치를 지원하지 않습니다");
    }
    let value = format!("{EXTENSION_ID};{UPDATE_URL}");
    let mut wrote = 0;
    for root in roots {
        let existing = read_policy_values(root);
        // 이미 우리 것이 있으면 그 자리에 다시 쓴다(주소가 바뀌었을 수 있다).
        let name = existing
            .iter()
            .find(|(_, data)| data.starts_with(EXTENSION_ID))
            .map(|(name, _)| name.clone())
            .unwrap_or_else(|| {
                // 남의 항목을 덮지 않도록 안 쓰인 가장 작은 번호를 고른다.
                let used: Vec<u32> = existing
                    .iter()
                    .filter_map(|(name, _)| name.parse().ok())
                    .collect();
                (1..).find(|n| !used.contains(n)).unwrap_or(1).to_string()
            });

        let status = crate::proc::command("reg")
            .args([
                "add",
                &policy_key_path(root),
                "/v",
                &name,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])
            .status();
        if matches!(status, Ok(status) if status.success()) {
            wrote += 1;
        }
    }
    if wrote == 0 {
        anyhow::bail!("정책을 적지 못했습니다");
    }
    Ok(())
}

/// 정책에서 우리 확장을 뺀다. 브라우저를 다시 켜면 스스로 지운다.
#[cfg(windows)]
pub fn unregister_policy(key: &str) -> anyhow::Result<()> {
    for root in policy_roots(key) {
        for name in policy_entries(root) {
            let _ = crate::proc::command("reg")
                .args(["delete", &policy_key_path(root), "/v", &name, "/f"])
                .status();
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn register_policy(key: &str) -> anyhow::Result<()> {
    let _ = key;
    anyhow::bail!("정책 설치는 아직 윈도우에서만 됩니다")
}

#[cfg(not(windows))]
pub fn unregister_policy(key: &str) -> anyhow::Result<()> {
    let _ = key;
    anyhow::bail!("정책 설치는 아직 윈도우에서만 됩니다")
}

/// 그 브라우저의 프로필들을 뒤져서 우리 확장이 얹혀 있는지 본다.
///
/// 두 가지를 본다.
///  - **확장 ID** — 매니페스트에 `key` 를 박아둔 뒤로는 정책으로 깔든 폴더로 얹든 ID 가 같다.
///    정책으로 깔린 것은 브라우저 자기 폴더에 들어가므로 경로로는 못 알아본다.
///  - **폴더 경로** — `key` 가 없던 시절에 얹은 것은 ID 가 다르다. 그때 얹은 것도 알아본다.
pub fn extension_state(key: &str, dir: &Path) -> Loaded {
    let Some(profiles) = profile_dirs(key) else {
        return Loaded::Unknown;
    };
    let wanted = normalize(dir);
    let mut read_any = false;
    let mut elsewhere = None;

    for profile in profiles {
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

            // ID 로 바로 찾는다. 이게 걸리면 어떻게 깔렸는지까지 알 수 있다.
            if let Some(entry) = settings.get(EXTENSION_ID) {
                let path = entry.get("path").and_then(serde_json::Value::as_str);
                return match path {
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
                    // 정책으로 깔린 것은 브라우저 자기 확장 폴더에 들어가고,
                    // 경로도 "<ID>/<버전>" 같은 상대 경로로 적힌다.
                    _ => Loaded::Policy,
                };
            }

            // 매니페스트에 `key` 가 없던 시절에 얹은 것. ID 가 달라서 경로로만 알아본다.
            for entry in settings.values() {
                let Some(path) = entry.get("path").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if normalize(Path::new(path)) == wanted {
                    return Loaded::Folder;
                }
                if elsewhere.is_none() && is_our_folder(Path::new(path)) {
                    elsewhere = Some(path.to_string());
                }
            }
        }
    }

    match (elsewhere, read_any) {
        (Some(path), _) => Loaded::Elsewhere { path },
        (None, true) => Loaded::No,
        (None, false) => Loaded::Unknown,
    }
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
fn user_data_dir(key: &str) -> Option<PathBuf> {
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
fn user_data_dir(key: &str) -> Option<PathBuf> {
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
fn user_data_dir(key: &str) -> Option<PathBuf> {
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
pub fn open_extensions_page(key: &str) -> bool {
    let page = find(key).map_or("chrome://extensions", |browser| browser.page);
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
fn browser_executable(key: &str) -> Option<PathBuf> {
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
fn browser_executable(key: &str) -> Option<PathBuf> {
    // macOS 는 앱 번들이라 open -a 로 여는 편이 낫다. 여기서는 기본 열기에 맡긴다.
    let _ = key;
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_executable(key: &str) -> Option<PathBuf> {
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
    fn 모르는_브라우저는_안_얹혔다고_말하지_않는다() {
        // "모르겠다"와 "아니다"를 섞으면 멀쩡히 쓰는 사람에게 헛수고를 시킨다.
        assert_eq!(
            extension_state("firefox", Path::new("/nowhere")),
            Loaded::Unknown
        );
    }
}
