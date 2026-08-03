//! 어느 브라우저에 넣을지 고르게 하고, 그 브라우저에 맞는 안내를 준다.
//!
//! 확장 폴더는 하나이고 크로미움 계열은 모두 같은 폴더를 읽는다. 브라우저마다 다른 것은
//! **확장 페이지 주소**뿐이다(`chrome://extensions`, `edge://extensions` …).
//!
//! 페이지를 우리가 대신 열어줄 수는 없다. 크로미움은 명령줄로 넘긴 `chrome://` 주소를
//! 무시한다(직접 확인했다 — 새 탭이 열린다). 그래서 주소를 복사해 주는 데까지만 한다.

use std::process::{Command, Stdio};

use serde::Serialize;

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

#[cfg(windows)]
fn default_browser_id() -> Option<String> {
    // https 를 여는 프로그램이 곧 기본 브라우저다.
    let output = Command::new("reg")
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
    let output = Command::new("defaults")
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
    let output = Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 글자를 클립보드에 넣는다. 붙여넣을 곳이 확장 페이지 주소창과 파일 선택 창이라
/// 복사만 해줘도 손이 많이 준다.
pub fn copy_to_clipboard(text: &str) -> bool {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/c", "clip"]);
        command
    } else if cfg!(target_os = "macos") {
        Command::new("pbcopy")
    } else {
        let mut command = Command::new("xclip");
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
}
