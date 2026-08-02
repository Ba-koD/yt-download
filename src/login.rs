//! 브라우저 로그인 창과 쿠키 내보내기.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use futures_util::SinkExt;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone)]
pub(crate) struct LoginSession {
    pub(crate) browser: String,
    pub(crate) port: u16,
    pub(crate) profile_dir: PathBuf,
}

pub(crate) const YOUTUBE_LOGIN_URL: &str = "https://accounts.google.com/AccountChooser?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Faccount";

pub(crate) fn selected_browser(value: Option<&str>) -> Result<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| anyhow!("브라우저를 먼저 선택하세요"))
}

pub(crate) struct ExportedCookies {
    pub(crate) path: PathBuf,
    pub(crate) cookie_count: usize,
    pub(crate) youtube_cookie_count: usize,
    pub(crate) auth_cookie_count: usize,
    /// youtube.com 도메인에 실제로 붙은 세션 쿠키 수.
    /// 구글에만 로그인하고 유튜브를 한 번도 열지 않으면 0이 되고, 그러면 내 영상 목록이 비어 있다.
    pub(crate) youtube_session_cookie_count: usize,
}

/// 로그인 여부를 가르는 쿠키들. 이 중 하나라도 youtube.com 에 있어야 내 계정으로 인정된다.
const SESSION_COOKIE_NAMES: &[&str] = &[
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
    "LOGIN_INFO",
];

pub(crate) async fn start_app_login_browser(browser: &str) -> Result<LoginSession> {
    let profile_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("browser-profiles")
        .join(browser);
    fs::create_dir_all(&profile_dir)
        .with_context(|| format!("could not create login profile {}", profile_dir.display()))?;

    // 이 프로필로 이미 창이 떠 있으면 새로 띄울 수 없다(프로필을 먼저 잡은 쪽이 소유한다).
    // 그때 다시 실행하면 디버깅 포트가 열리지 않아 "제시간에 시작되지 않았습니다"로 끝난다.
    // 그래서 지난번 포트를 적어두고, 아직 살아 있으면 그 창에 그대로 붙는다.
    let port_file = profile_dir.join("yt-download-cdp-port");
    if let Some(port) = fs::read_to_string(&port_file)
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
    {
        if cdp_is_alive(port).await {
            return Ok(LoginSession {
                browser: browser.to_string(),
                port,
                profile_dir,
            });
        }
    }

    let port = available_local_port()?;
    launch_chromium_login(browser, port, &profile_dir)?;
    wait_for_cdp(port).await?;
    let _ = fs::write(&port_file, port.to_string());

    Ok(LoginSession {
        browser: browser.to_string(),
        port,
        profile_dir,
    })
}

pub(crate) async fn cdp_is_alive(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    match reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_millis(800))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

pub(crate) fn available_local_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

pub(crate) async fn wait_for_cdp(port: u16) -> Result<()> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::new();
    for _ in 0..40 {
        if client.get(&url).send().await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(anyhow!("앱 로그인 브라우저가 제시간에 시작되지 않았습니다"))
}

pub(crate) async fn export_login_cookies(session: &LoginSession) -> Result<ExportedCookies> {
    // 구글에 로그인해도 유튜브를 한 번 열기 전에는 youtube.com 에 세션 쿠키가 생기지 않는다.
    // 그 상태로 내보내면 "적용 완료"라고 나오지만 내 영상 목록은 계속 비어 있다.
    // 그래서 로그인 창을 유튜브로 한 번 보내고, 세션 쿠키가 생길 때까지 기다렸다가 읽는다.
    let cookies = cookies_after_visiting_youtube(session.port).await?;
    if cookies.is_empty() {
        return Err(anyhow!(
            "쿠키를 찾지 못했습니다. 앱 로그인 브라우저에서 YouTube 로그인을 완료한 뒤 다시 누르세요"
        ));
    }

    let youtube_cookie_count = cookies
        .iter()
        .filter(|cookie| {
            cookie
                .get("domain")
                .and_then(Value::as_str)
                .map(|domain| domain.contains("youtube.com") || domain.contains("google.com"))
                .unwrap_or(false)
        })
        .count();
    let auth_cookie_count = cookies.iter().filter(|c| is_session_cookie(c)).count();
    let youtube_session_cookie_count = cookies
        .iter()
        .filter(|cookie| is_session_cookie(cookie) && is_youtube_domain(cookie))
        .count();

    let path = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("cookies")
        .join(format!("app-login-{}.txt", session.browser));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, netscape_cookie_file(&cookies))
        .with_context(|| format!("could not write cookies file {}", path.display()))?;

    Ok(ExportedCookies {
        path,
        cookie_count: cookies.len(),
        youtube_cookie_count,
        auth_cookie_count,
        youtube_session_cookie_count,
    })
}

pub(crate) fn is_session_cookie(cookie: &Value) -> bool {
    cookie
        .get("name")
        .and_then(Value::as_str)
        .map(|name| SESSION_COOKIE_NAMES.contains(&name))
        .unwrap_or(false)
}

pub(crate) fn is_youtube_domain(cookie: &Value) -> bool {
    cookie
        .get("domain")
        .and_then(Value::as_str)
        .map(|domain| {
            let domain = domain.trim_start_matches('.');
            domain == "youtube.com" || domain.ends_with(".youtube.com")
        })
        .unwrap_or(false)
}

/// 로그인 창에 유튜브 탭을 하나 띄우고, youtube.com 세션 쿠키가 생길 때까지 기다린다.
///
/// 로그인이 이미 끝나 있으면 몇 초면 붙는다. 끝까지 안 생기면 있는 그대로 돌려주고,
/// 부족하다는 판단은 부르는 쪽에서 한다(사용자에게 무엇을 더 해야 하는지 알려주기 위해).
pub(crate) async fn cookies_after_visiting_youtube(port: u16) -> Result<Vec<Value>> {
    let before = read_cdp_cookies(port).await?;
    if before
        .iter()
        .any(|c| is_session_cookie(c) && is_youtube_domain(c))
    {
        return Ok(before);
    }

    if let Err(err) = open_cdp_tab(port, "https://www.youtube.com/").await {
        eprintln!("login: could not open a YouTube tab in the login browser: {err:#}");
        return Ok(before);
    }

    for _ in 0..24 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let cookies = read_cdp_cookies(port).await?;
        if cookies
            .iter()
            .any(|c| is_session_cookie(c) && is_youtube_domain(c))
        {
            return Ok(cookies);
        }
    }
    read_cdp_cookies(port).await
}

pub(crate) async fn open_cdp_tab(port: u16, url: &str) -> Result<()> {
    let ws_url = cdp_browser_socket(port).await?;
    let (mut socket, _) = connect_async(ws_url)
        .await
        .context("could not connect to app login browser")?;
    socket
        .send(Message::Text(
            json!({ "id": 1, "method": "Target.createTarget", "params": { "url": url } })
                .to_string()
                .into(),
        ))
        .await?;

    while let Some(message) = socket.next().await {
        let message = message?;
        if !message.is_text() {
            continue;
        }
        let value: Value = serde_json::from_str(message.to_text()?)?;
        if value.get("id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(anyhow!("could not open a tab: {error}"));
        }
        return Ok(());
    }
    Err(anyhow!("opening a tab returned no response"))
}

pub(crate) async fn cdp_browser_socket(port: u16) -> Result<String> {
    let version: Value = reqwest::get(format!("http://127.0.0.1:{port}/json/version"))
        .await?
        .json()
        .await?;
    version
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("DevTools websocket URL을 찾지 못했습니다"))
}

pub(crate) async fn read_cdp_cookies(port: u16) -> Result<Vec<Value>> {
    let ws_url = cdp_browser_socket(port).await?;

    let (mut socket, _) = connect_async(ws_url)
        .await
        .context("could not connect to app login browser")?;
    socket
        .send(Message::Text(
            json!({ "id": 1, "method": "Storage.getCookies", "params": {} })
                .to_string()
                .into(),
        ))
        .await?;

    while let Some(message) = socket.next().await {
        let message = message?;
        if !message.is_text() {
            continue;
        }
        let value: Value = serde_json::from_str(message.to_text()?)?;
        if value.get("id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(anyhow!("DevTools cookie export failed: {error}"));
        }
        return Ok(value
            .get("result")
            .and_then(|result| result.get("cookies"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default());
    }

    Err(anyhow!("DevTools cookie export returned no response"))
}

pub(crate) fn netscape_cookie_file(cookies: &[Value]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n# Generated by yt-download\n");
    for cookie in cookies {
        let Some(domain) = cookie.get("domain").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = cookie.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(value) = cookie.get("value").and_then(Value::as_str) else {
            continue;
        };
        if domain.is_empty() || name.is_empty() {
            continue;
        }

        let domain_field = if cookie
            .get("httpOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            format!("#HttpOnly_{}", sanitize_cookie_field(domain))
        } else {
            sanitize_cookie_field(domain)
        };
        let include_subdomains = if domain.starts_with('.') {
            "TRUE"
        } else {
            "FALSE"
        };
        let path = cookie
            .get("path")
            .and_then(Value::as_str)
            .map(sanitize_cookie_field)
            .unwrap_or_else(|| "/".to_string());
        let secure = if cookie
            .get("secure")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "TRUE"
        } else {
            "FALSE"
        };
        let expires = cookie
            .get("expires")
            .or_else(|| cookie.get("expirationDate"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.floor() as i64)
            .unwrap_or(0);

        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            domain_field,
            include_subdomains,
            path,
            secure,
            expires,
            sanitize_cookie_field(name),
            sanitize_cookie_field(value)
        ));
    }
    out
}

pub(crate) fn sanitize_cookie_field(value: &str) -> String {
    value.replace('\t', "%09").replace(['\r', '\n'], "")
}

pub(crate) fn open_url_for_login(browser: &str, url: &str) -> Result<()> {
    if browser == "default" {
        webbrowser::open(url).context("could not open the default browser")?;
        return Ok(());
    }

    if open_specific_browser(browser, url).is_ok() {
        return Ok(());
    }

    webbrowser::open(url).with_context(|| {
        format!("could not open {browser}; also failed to open the default browser")
    })?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn launch_chromium_login(browser: &str, port: u16, profile_dir: &Path) -> Result<()> {
    let exe = match browser {
        "chrome" => windows_browser_exe(&[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]),
        "edge" => windows_browser_exe(&[
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ]),
        "brave" => windows_browser_exe(&[
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        ]),
        "vivaldi" => windows_browser_exe(&[
            r"C:\Program Files\Vivaldi\Application\vivaldi.exe",
            r"C:\Program Files (x86)\Vivaldi\Application\vivaldi.exe",
        ]),
        "whale" => windows_browser_exe(&[
            r"C:\Program Files\Naver\Naver Whale\Application\whale.exe",
            r"C:\Program Files (x86)\Naver\Naver Whale\Application\whale.exe",
        ]),
        _ => {
            return Err(anyhow!(
                "앱 로그인은 Chrome, Edge, Brave, Vivaldi, Whale만 지원합니다"
            ))
        }
    }
    .ok_or_else(|| anyhow!("{browser} 실행 파일을 찾지 못했습니다"))?;

    std::process::Command::new(&exe)
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(YOUTUBE_LOGIN_URL)
        .spawn()
        .with_context(|| format!("could not start {}", exe.display()))?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windows_browser_exe(system_paths: &[&str]) -> Option<PathBuf> {
    for path in system_paths {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub(crate) fn launch_chromium_login(browser: &str, port: u16, profile_dir: &Path) -> Result<()> {
    let app = match browser {
        "chrome" => "Google Chrome",
        "edge" => "Microsoft Edge",
        "brave" => "Brave Browser",
        "vivaldi" => "Vivaldi",
        "whale" => "Whale",
        _ => {
            return Err(anyhow!(
                "앱 로그인은 Chrome, Edge, Brave, Vivaldi, Whale만 지원합니다"
            ))
        }
    };

    std::process::Command::new("open")
        .args(["-na", app, "--args"])
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(YOUTUBE_LOGIN_URL)
        .spawn()
        .with_context(|| format!("could not start {app}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn launch_chromium_login(browser: &str, port: u16, profile_dir: &Path) -> Result<()> {
    let candidates: &[&str] = match browser {
        "edge" => &["microsoft-edge", "microsoft-edge-stable"],
        "chrome" => &[
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ],
        "brave" => &["brave-browser", "brave"],
        "vivaldi" => &["vivaldi", "vivaldi-stable"],
        "whale" => &["whale"],
        _ => {
            return Err(anyhow!(
                "앱 로그인은 Chrome, Edge, Brave, Vivaldi, Whale만 지원합니다"
            ))
        }
    };

    for command in candidates {
        if std::process::Command::new(command)
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg(YOUTUBE_LOGIN_URL)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    Err(anyhow!("could not find {browser}"))
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn launch_chromium_login(browser: &str, _port: u16, _profile_dir: &Path) -> Result<()> {
    Err(anyhow!("unsupported platform for app login: {browser}"))
}

#[cfg(windows)]
pub(crate) fn close_browser_processes(browser: &str) -> Result<()> {
    let names: &[&str] = match browser {
        "chrome" => &["chrome.exe"],
        "edge" => &["msedge.exe"],
        "brave" => &["brave.exe"],
        "vivaldi" => &["vivaldi.exe"],
        "whale" => &["whale.exe"],
        "firefox" => &["firefox.exe"],
        _ => return Err(anyhow!("unsupported browser for closing: {browser}")),
    };

    for name in names {
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", name, "/F", "/T"])
            .output();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn close_browser_processes(browser: &str) -> Result<()> {
    let app = match browser {
        "edge" => "Microsoft Edge",
        "chrome" => "Google Chrome",
        "firefox" => "Firefox",
        "brave" => "Brave Browser",
        "vivaldi" => "Vivaldi",
        "safari" => "Safari",
        "whale" => "Whale",
        _ => return Err(anyhow!("unsupported browser for closing: {browser}")),
    };

    let _ = std::process::Command::new("osascript")
        .args(["-e", &format!("quit app \"{app}\"")])
        .output();
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn close_browser_processes(browser: &str) -> Result<()> {
    let names: &[&str] = match browser {
        "edge" => &["microsoft-edge", "microsoft-edge-stable"],
        "chrome" => &[
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ],
        "firefox" => &["firefox"],
        "brave" => &["brave-browser", "brave"],
        "vivaldi" => &["vivaldi", "vivaldi-bin"],
        "whale" => &["whale"],
        _ => return Err(anyhow!("unsupported browser for closing: {browser}")),
    };

    for name in names {
        let _ = std::process::Command::new("pkill")
            .args(["-f", name])
            .output();
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn close_browser_processes(browser: &str) -> Result<()> {
    Err(anyhow!(
        "unsupported platform for closing browser processes: {browser}"
    ))
}

#[cfg(windows)]
pub(crate) fn open_specific_browser(browser: &str, url: &str) -> Result<()> {
    if browser == "edge" {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &format!("microsoft-edge:{url}")])
            .spawn()
            .with_context(|| format!("could not open {browser}"))?;
        return Ok(());
    }

    let exe = match browser {
        "chrome" => windows_browser_exe(&[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]),
        "brave" => windows_browser_exe(&[
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        ]),
        "vivaldi" => windows_browser_exe(&[
            r"C:\Program Files\Vivaldi\Application\vivaldi.exe",
            r"C:\Program Files (x86)\Vivaldi\Application\vivaldi.exe",
        ]),
        "whale" => windows_browser_exe(&[
            r"C:\Program Files\Naver\Naver Whale\Application\whale.exe",
            r"C:\Program Files (x86)\Naver\Naver Whale\Application\whale.exe",
        ]),
        _ => return Err(anyhow!("unsupported browser for login: {browser}")),
    }
    .ok_or_else(|| anyhow!("{browser} 실행 파일을 찾지 못했습니다"))?;

    std::process::Command::new(&exe)
        .arg(url)
        .spawn()
        .with_context(|| format!("could not open {}", exe.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_specific_browser(browser: &str, url: &str) -> Result<()> {
    let app = match browser {
        "edge" => "Microsoft Edge",
        "chrome" => "Google Chrome",
        "firefox" => "Firefox",
        "brave" => "Brave Browser",
        "vivaldi" => "Vivaldi",
        "safari" => "Safari",
        "whale" => "Whale",
        _ => return Err(anyhow!("unsupported browser for login: {browser}")),
    };

    std::process::Command::new("open")
        .args(["-a", app, url])
        .spawn()
        .with_context(|| format!("could not open {app}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_specific_browser(browser: &str, url: &str) -> Result<()> {
    let candidates: &[&str] = match browser {
        "edge" => &["microsoft-edge", "microsoft-edge-stable"],
        "chrome" => &[
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ],
        "firefox" => &["firefox"],
        "brave" => &["brave-browser", "brave"],
        "vivaldi" => &["vivaldi", "vivaldi-stable"],
        "whale" => &["whale"],
        _ => return Err(anyhow!("unsupported browser for login: {browser}")),
    };

    for command in candidates {
        if std::process::Command::new(command).arg(url).spawn().is_ok() {
            return Ok(());
        }
    }

    Err(anyhow!("could not find {browser}"))
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn open_specific_browser(browser: &str, _url: &str) -> Result<()> {
    Err(anyhow!(
        "unsupported platform for browser selection: {browser}"
    ))
}

/// 이 컴퓨터의 기본 브라우저. 화면의 브라우저 칸을 처음 채울 때 쓴다.
///
/// 화면의 값(chrome/edge/firefox/…)과 같은 이름으로 돌려주고, 알아내지 못하면 `None`.
pub(crate) fn detect_default_browser() -> Option<String> {
    let raw = default_browser_id()?.to_ascii_lowercase();
    // 각 브라우저가 자기 이름을 조금씩 다르게 적어서(BraveHTML, brave-browser.desktop,
    // com.brave.browser …) 이름이 들어 있는지만 본다.
    // "chromium" 도 "chrome" 에 걸리는데, 어차피 같은 취급이라 그대로 둔다.
    [
        "chrome", "edge", "firefox", "brave", "vivaldi", "whale", "opera", "safari",
    ]
    .into_iter()
    .find(|name| raw.contains(name))
    .map(ToOwned::to_owned)
}

#[cfg(windows)]
fn default_browser_id() -> Option<String> {
    // https 를 여는 프로그램이 곧 기본 브라우저다.
    let output = std::process::Command::new("reg")
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
    let output = std::process::Command::new("defaults")
        .args([
            "read",
            "com.apple.LaunchServices/com.apple.launchservices.secure",
            "LSHandlers",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // https 항목 바로 앞뒤에 적힌 번들 ID를 찾는다.
    let position = text.find("LSHandlerURLScheme = https")?;
    let around = &text[position.saturating_sub(240)..text.len().min(position + 240)];
    around
        .lines()
        .find(|line| line.contains("LSHandlerRoleAll"))
        .and_then(|line| line.split('=').nth(1))
        .map(|value| {
            value
                .trim()
                .trim_matches(|c| c == '"' || c == ';')
                .to_string()
        })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_browser_id() -> Option<String> {
    let output = std::process::Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(any(windows, unix)))]
fn default_browser_id() -> Option<String> {
    None
}
