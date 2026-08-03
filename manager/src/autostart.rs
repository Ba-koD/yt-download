//! 로그인할 때 관리자를 창 없이 한 번 돌게 등록한다(관리자 권한 없이, 사용자 계정에만).
//!
//! 세 플랫폼 모두 "사용자 로그인 시 실행" 자리가 따로 있다.
//! - 윈도우: `HKCU\...\Run` 레지스트리 값
//! - macOS: `~/Library/LaunchAgents` 의 plist
//! - 리눅스: `~/.config/autostart` 의 .desktop
//!
//! 등록하는 명령은 `<관리자 경로> --auto` 다. 그 인자로 뜨면 창을 만들지 않고
//! 업데이트만 확인하고 나간다(`main.rs` 의 `run_auto`).

use anyhow::{Context, Result};

/// 시작 항목에 붙는 이름. 지울 때도 이 이름으로 찾는다.
const LABEL: &str = "yt-download-extension-manager";

/// 지금 이 관리자가 로그인 시 자동 실행으로 등록돼 있는지.
pub fn is_enabled() -> bool {
    imp::is_enabled()
}

/// `on` 이면 등록, 아니면 지운다. 지금 실행 파일 경로로 등록한다.
pub fn set(on: bool) -> Result<()> {
    if on {
        let exe = std::env::current_exe().context("지금 실행 파일의 자리를 알지 못했습니다")?;
        imp::enable(&exe)
    } else {
        imp::disable()
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    // reg.exe 로 다룬다. 작은 값 하나라 별도 크레이트를 들일 것 없다.
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn is_enabled() -> bool {
        crate::proc::command("reg")
            .args(["query", KEY, "/v", LABEL])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    pub fn enable(exe: &std::path::Path) -> Result<()> {
        // 값은 따옴표로 감싼 경로 + 인자. 경로에 공백이 있어도 깨지지 않는다.
        let value = format!("\"{}\" --auto", exe.display());
        let status = crate::proc::command("reg")
            .args(["add", KEY, "/v", LABEL, "/t", "REG_SZ", "/d", &value, "/f"])
            .status()
            .context("시작 항목을 등록하지 못했습니다")?;
        if !status.success() {
            anyhow::bail!("시작 항목 등록이 거절됐습니다");
        }
        Ok(())
    }

    pub fn disable() -> Result<()> {
        // 이미 없으면 reg 가 1을 주는데, 그건 실패로 보지 않는다.
        let _ = crate::proc::command("reg")
            .args(["delete", KEY, "/v", LABEL, "/f"])
            .status();
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::{fs, path::PathBuf};

    fn plist_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Library/LaunchAgents")
            .join(format!("dev.local.{LABEL}.plist"))
    }

    pub fn is_enabled() -> bool {
        plist_path().exists()
    }

    pub fn enable(exe: &std::path::Path) -> Result<()> {
        let path = plist_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // RunAtLoad 로 로그인 때 한 번 돈다. KeepAlive 는 주지 않는다(계속 살릴 이유가 없다).
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.local.{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>--auto</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
"#,
            exe.display()
        );
        fs::write(&path, plist).context("시작 항목을 등록하지 못했습니다")?;
        Ok(())
    }

    pub fn disable() -> Result<()> {
        let _ = fs::remove_file(plist_path());
        Ok(())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::*;
    use std::{fs, path::PathBuf};

    fn desktop_path() -> PathBuf {
        dirs::config_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("autostart")
            .join(format!("{LABEL}.desktop"))
    }

    pub fn is_enabled() -> bool {
        desktop_path().exists()
    }

    pub fn enable(exe: &std::path::Path) -> Result<()> {
        let path = desktop_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let desktop = format!(
            "[Desktop Entry]\nType=Application\nName=yt-download 확장 관리자\n\
Exec=\"{}\" --auto\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
            exe.display()
        );
        fs::write(&path, desktop).context("시작 항목을 등록하지 못했습니다")?;
        Ok(())
    }

    pub fn disable() -> Result<()> {
        let _ = fs::remove_file(desktop_path());
        Ok(())
    }
}
