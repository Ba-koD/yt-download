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
}

pub(crate) async fn start_app_login_browser(browser: &str) -> Result<LoginSession> {
    let port = available_local_port()?;
    let profile_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("browser-profiles")
        .join(browser);
    fs::create_dir_all(&profile_dir)
        .with_context(|| format!("could not create login profile {}", profile_dir.display()))?;

    launch_chromium_login(browser, port, &profile_dir)?;
    wait_for_cdp(port).await?;

    Ok(LoginSession {
        browser: browser.to_string(),
        port,
        profile_dir,
    })
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
    let cookies = read_cdp_cookies(session.port).await?;
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
    let auth_cookie_count = cookies
        .iter()
        .filter(|cookie| {
            let name = cookie.get("name").and_then(Value::as_str).unwrap_or("");
            matches!(
                name,
                "SID"
                    | "HSID"
                    | "SSID"
                    | "APISID"
                    | "SAPISID"
                    | "__Secure-1PSID"
                    | "__Secure-3PSID"
                    | "__Secure-1PAPISID"
                    | "__Secure-3PAPISID"
                    | "LOGIN_INFO"
            )
        })
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
    })
}

pub(crate) async fn read_cdp_cookies(port: u16) -> Result<Vec<Value>> {
    let version_url = format!("http://127.0.0.1:{port}/json/version");
    let version: Value = reqwest::get(&version_url).await?.json().await?;
    let ws_url = version
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("DevTools websocket URL을 찾지 못했습니다"))?;

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
