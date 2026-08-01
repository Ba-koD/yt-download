//! 내장/시스템 도구(yt-dlp, ffmpeg, ffprobe, deno) 경로와 공통 인자.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::process::Command;

mod embedded_tools {
    include!(concat!(env!("OUT_DIR"), "/embedded_tools.rs"));
}

#[derive(Debug, Serialize)]
pub(crate) struct ToolStatus {
    pub(crate) available: bool,
    pub(crate) version: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) path: Option<String>,
}

// 다운로드 중간 파일(.part, 조각)을 사용자 폴더에 노출하지 않기 위한 임시 작업 폴더.
pub(crate) fn app_temp_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("tmp")
}

pub(crate) fn yt_dlp_command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    // Windows에서 yt-dlp가 파이프 출력을 콘솔 코드페이지(CP949)로 인코딩해 한글이 깨진다.
    // 패키징된 yt-dlp는 PYTHONUTF8 같은 환경변수를 무시하므로 --encoding 옵션으로 강제해야 한다.
    cmd.args(["--encoding", "utf-8"]);
    cmd
}

pub(crate) fn resolve_tool(custom: Option<&str>, name: &str) -> PathBuf {
    if let Some(custom) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        return PathBuf::from(custom);
    }

    if let Some(path) = bundled_tool_path(name) {
        return path;
    }

    PathBuf::from(tool_filename(name))
}

pub(crate) fn bundled_tool_path(name: &str) -> Option<PathBuf> {
    let filename = tool_filename(name);

    if let Some(dir) = embedded_tools_dir() {
        let path = dir.join(&filename);
        if path.is_file() {
            return Some(path);
        }
    }

    for dir in sidecar_tool_dirs() {
        let path = dir.join(&filename);
        if path.is_file() {
            return Some(path);
        }
    }

    None
}

pub(crate) fn embedded_tools_dir() -> Option<PathBuf> {
    static EMBEDDED_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    EMBEDDED_DIR
        .get_or_init(|| extract_embedded_tools().ok().flatten())
        .clone()
}

pub(crate) fn extract_embedded_tools() -> Result<Option<PathBuf>> {
    if embedded_tools::EMBEDDED_TOOLS.is_empty() {
        return Ok(None);
    }

    let dir = dirs::data_local_dir()
        .or_else(dirs::cache_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("tools")
        .join(env!("CARGO_PKG_VERSION"))
        .join(embedded_tools::EMBEDDED_TARGET);

    fs::create_dir_all(&dir).with_context(|| {
        format!(
            "could not create embedded tools directory {}",
            dir.display()
        )
    })?;

    // 실행 파일 안에는 압축된 상태로 들어 있다. 첫 실행 때만 풀고, 이후에는 그대로 쓴다.
    for tool in embedded_tools::EMBEDDED_TOOLS {
        let path = dir.join(tool.name);
        let already_there = fs::metadata(&path)
            .map(|metadata| metadata.len() == tool.size)
            .unwrap_or(false);
        if already_there {
            continue;
        }

        // 쓰는 도중 앱이 꺼져도 반쪽짜리 파일이 남지 않도록 임시 이름으로 풀고 옮긴다.
        let staging = path.with_extension("partial");
        let mut decoder = flate2::read::GzDecoder::new(tool.packed);
        let mut file = fs::File::create(&staging)
            .with_context(|| format!("could not create {}", staging.display()))?;
        std::io::copy(&mut decoder, &mut file)
            .with_context(|| format!("could not unpack {}", tool.name))?;
        drop(file);
        set_executable(&staging)?;
        fs::rename(&staging, &path)
            .with_context(|| format!("could not place {}", path.display()))?;
    }

    Ok(Some(dir))
}

#[cfg(unix)]
pub(crate) fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

pub(crate) fn sidecar_tool_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("tools").join(embedded_tools::EMBEDDED_TARGET));
            dirs.push(parent.join("tools"));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        dirs.push(current.join("tools").join(embedded_tools::EMBEDDED_TARGET));
        dirs.push(current.join("tools"));
    }
    dirs
}

pub(crate) fn tool_filename(name: &str) -> String {
    if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub(crate) fn add_ffmpeg_location(cmd: &mut Command) {
    if let Some(ffmpeg) = bundled_tool_path("ffmpeg") {
        if let Some(dir) = ffmpeg.parent() {
            cmd.arg("--ffmpeg-location").arg(dir);
        }
    }
}

pub(crate) fn add_js_runtime(cmd: &mut Command) {
    if let Some(deno) = bundled_tool_path("deno") {
        cmd.arg("--js-runtimes")
            .arg(format!("deno:{}", deno.to_string_lossy()));
    } else if let Some(deno) = find_system_tool("deno") {
        cmd.arg("--js-runtimes")
            .arg(format!("deno:{}", deno.to_string_lossy()));
    } else if let Some(node) = find_system_tool("node") {
        cmd.arg("--js-runtimes")
            .arg(format!("node:{}", node.to_string_lossy()));
    }
}

pub(crate) fn find_system_tool(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates = if cfg!(windows) {
        vec![tool_filename(name)]
    } else {
        vec![name.to_string()]
    };

    for dir in std::env::split_paths(&path_var) {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub(crate) fn add_cookie_args(
    cmd: &mut Command,
    browser: Option<&str>,
    profile: Option<&str>,
    cookies_file: Option<&str>,
) -> Result<()> {
    if let Some(cookies_file) = cookies_file
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if cookies_file.contains(['\n', '\r']) {
            return Err(anyhow!("cookies file path contains an invalid character"));
        }
        cmd.arg("--cookies").arg(cookies_file);
        return Ok(());
    }

    let Some(browser) = browser.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if browser.eq_ignore_ascii_case("none") {
        return Ok(());
    }

    let allowed = [
        "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
    ];
    if !allowed
        .iter()
        .any(|item| item.eq_ignore_ascii_case(browser))
    {
        return Err(anyhow!("unsupported browser for cookies: {browser}"));
    }

    let mut value = browser.to_ascii_lowercase();
    if let Some(profile) = profile.map(str::trim).filter(|value| !value.is_empty()) {
        if profile.contains(['\n', '\r']) {
            return Err(anyhow!("browser profile contains an invalid character"));
        }
        value.push(':');
        value.push_str(profile);
    }
    cmd.args(["--cookies-from-browser", &value]);
    Ok(())
}

pub(crate) async fn tool_version(exe: PathBuf, args: &[&str]) -> ToolStatus {
    let path = exe.to_string_lossy().to_string();
    match Command::new(&exe).args(args).output().await {
        Ok(output) if output.status.success() => {
            let text = if output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr).to_string()
            } else {
                String::from_utf8_lossy(&output.stdout).to_string()
            };
            ToolStatus {
                available: true,
                version: text.lines().next().map(|line| line.trim().to_string()),
                error: None,
                path: Some(path),
            }
        }
        Ok(output) => ToolStatus {
            available: false,
            version: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
            path: Some(path),
        },
        Err(err) => ToolStatus {
            available: false,
            version: None,
            error: Some(err.to_string()),
            path: Some(path),
        },
    }
}
