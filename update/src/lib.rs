//! 앱과 확장 관리자가 함께 쓰는 자동 업데이트.
//!
//! 깃허브 릴리스를 보고, 자기 것만 받아서, 돌고 있는 실행 파일을 바꿔 끼운다.
//! 확장 관리자는 여기서 확장(폴더)도 함께 받아 푼다.
//!
//! 지키는 것(HANDOFF 의 "정할 것 2"):
//!
//! 1. 실패해도 쓰던 실행 파일이 멀쩡하다 — 다 받아서 검사한 뒤 **마지막에** 바꿔 끼운다.
//! 2. 관리자 권한을 요구하지 않는다 — 자기 자리와 임시 폴더만 건드린다.
//! 3. 받은 파일을 `SHA256SUMS.txt` 와 대조한다.
//! 4. 별도 창이 뜨지 않는다 — 도우미 프로세스(숨긴 PowerShell 같은 것)를 띄우지 않는다.
//! 5. 세 플랫폼에서 된다 — macOS 는 `.app` 안의 실행 파일과 `Info.plist` 를 함께 바꾼다.
//! 6. 되돌릴 수 있다 — 바꿔 끼우기는 `self-replace` 가 한다. 옛 파일을 옆으로 치우고
//!    새것을 그 이름에 놓기 때문에, 도중에 실패하면 옛 파일이 제자리로 돌아온다.
//!
//! 릴리스 자산은 프로그램별로 나뉘어 있다. 관리자(4MB)만 고쳐도 앱(167MB)을
//! 다시 받는 일이 없도록 하기 위해서다. 버전은 셋이 함께 간다(`VERSION` 하나).

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub mod archive;

/// 릴리스를 어디서 가져오는지. 포크해서 쓰려면 여기만 바꾸면 된다.
pub const REPO: &str = "Ba-koD/yt-download";

/// 릴리스에 함께 올라가는 체크섬 목록.
pub const CHECKSUMS: &str = "SHA256SUMS.txt";

/// 크롬 확장. 플랫폼을 타지 않아 하나뿐이다.
pub const EXTENSION_ASSET: &str = "yt-download-extension.zip";

/// 자기 자신을 갱신할 수 있는 프로그램.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    App,
    Manager,
}

impl Program {
    /// 릴리스에서 받아야 할 자산 이름. 알 수 없는 플랫폼이면 `None`.
    ///
    /// **관리자는 어느 플랫폼에서도 압축하지 않는다.** 실행 파일 하나뿐이라 묶을 이유가 없다.
    /// 유닉스에서 받은 사람은 `chmod +x` 를 한 번 해줘야 한다(깃허브 릴리스 자산은
    /// 실행 권한을 잃는다). 자동 업데이트는 스스로 권한을 주므로 이 영향을 받지 않는다.
    ///
    /// 앱은 압축본으로 둔다(윈도우 165.8MB 대 170.2MB). macOS 는 `.app` 폴더라 묶어야만 한다.
    pub fn asset_name(self) -> Option<String> {
        let slug = platform_slug()?;
        match self {
            Program::App => Some(format!("yt-download-{slug}{}", archive_suffix())),
            Program::Manager => Some(format!(
                "yt-download-manager-{slug}{}",
                if cfg!(windows) { ".exe" } else { "" }
            )),
        }
    }

    /// 압축 안에 들어 있는 실행 파일 이름.
    pub fn binary_name(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Program::App, true) => "yt-download.exe",
            (Program::App, false) => "yt-download",
            (Program::Manager, true) => "yt-download-extension-manager.exe",
            (Program::Manager, false) => "yt-download-extension-manager",
        }
    }
}

/// 릴리스 자산 이름에 붙는 플랫폼 이름. 릴리스 워크플로가 쓰는 것과 같아야 한다.
pub fn platform_slug() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x64",
        ("linux", "x86_64") => "linux-x64",
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        _ => return None,
    })
}

fn archive_suffix() -> &'static str {
    if cfg!(windows) {
        ".zip"
    } else {
        ".tar.gz"
    }
}

#[derive(Debug, Clone)]
pub struct Asset {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    /// 태그에서 앞의 `v` 를 뗀 것.
    pub version: String,
    pub published: Option<String>,
    pub assets: Vec<Asset>,
}

impl Release {
    pub fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| asset.name == name)
    }

    /// 지금 도는 버전보다 새것인지.
    pub fn is_newer_than(&self, current: &str) -> bool {
        is_newer(&self.version, current)
    }

    /// 올린 날짜(`2026-08-03`). 시각까지는 필요 없다.
    pub fn published_day(&self) -> Option<String> {
        self.published
            .as_ref()
            .and_then(|when| when.get(..10))
            .map(str::to_string)
    }
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    published_at: Option<String>,
    assets: Vec<ApiAsset>,
}

#[derive(Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
}

fn client(agent: &str) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // 깃허브 API 는 User-Agent 가 없으면 403 을 준다.
        .user_agent(agent.to_string())
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .context("네트워크 준비에 실패했습니다")
}

/// 최신 릴리스를 찾는다.
pub fn latest_release(repo: &str, agent: &str) -> Result<Release> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = client(agent)?
        .get(&url)
        .send()
        .context("깃허브에 닿지 못했습니다")?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("아직 공개된 릴리스가 없습니다 (저장소가 비공개이면 보이지 않습니다)");
    }
    if !response.status().is_success() {
        bail!(
            "깃허브가 거절했습니다 (HTTP {})",
            response.status().as_u16()
        );
    }

    let release: ApiRelease = response.json().context("깃허브 응답을 읽지 못했습니다")?;
    Ok(Release {
        version: release.tag_name.trim_start_matches('v').to_string(),
        tag: release.tag_name,
        published: release.published_at,
        assets: release
            .assets
            .into_iter()
            .map(|asset| Asset {
                name: asset.name,
                url: asset.browser_download_url,
            })
            .collect(),
    })
}

/// 자산 하나를 받아서 릴리스에 적힌 해시와 대조한다.
///
/// 체크섬 목록이 없거나 그 파일 줄이 없으면 넘어간다. 옛 릴리스에는 없을 수 있다.
pub fn fetch_verified(release: &Release, name: &str, agent: &str) -> Result<Vec<u8>> {
    let http = client(agent)?;
    let asset = release
        .asset(name)
        .ok_or_else(|| anyhow!("릴리스에 {name} 이 없습니다"))?;

    let bytes = http
        .get(&asset.url)
        .send()
        .and_then(|response| response.error_for_status())
        .with_context(|| format!("{name} 을 내려받지 못했습니다"))?
        .bytes()
        .context("내려받은 내용을 읽지 못했습니다")?
        .to_vec();

    if let Some(listing) = release.asset(CHECKSUMS) {
        let text = http
            .get(&listing.url)
            .send()
            .and_then(|response| response.error_for_status())
            .context("체크섬 목록을 받지 못했습니다")?
            .text()
            .context("체크섬 목록을 읽지 못했습니다")?;
        if let Some(expected) = expected_hash(&text, name) {
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if actual != expected {
                bail!("받은 파일이 릴리스에 적힌 것과 다릅니다 (내려받다 깨졌을 수 있습니다)");
            }
        }
    }

    Ok(bytes)
}

/// `sha256sum` 형식의 목록에서 그 파일의 해시를 찾는다.
///
/// 목록은 `<해시>  <이름>` 꼴이고, 이름 앞에 `*` 가 붙기도 한다(이진 모드 표시).
pub fn expected_hash(listing: &str, name: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let found = parts.next()?.trim_start_matches('*');
        (found == name).then(|| hash.to_ascii_lowercase())
    })
}

/// 버전 비교. `0.10.0` 이 `0.9.0` 보다 새것이어야 하므로 숫자로 나눠서 본다.
pub fn is_newer(latest: &str, current: &str) -> bool {
    numbers(latest) > numbers(current)
}

fn numbers(version: &str) -> Vec<u64> {
    let mut parts: Vec<u64> = version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    parts.resize(4, 0);
    parts
}

/// 폴더 하나를 통째로 갈아 끼운다(확장이 이 방식이다).
///
/// 다 풀고 나서 마지막에 바꾼다. 도중에 실패해도 쓰던 것은 멀쩡하다.
/// 이름이 바뀐 옛 파일이 남아 있으면 크롬이 그걸 계속 읽어서, 통째로 바꾸는 편이 안전하다.
pub fn replace_directory(
    bytes: &[u8],
    asset_name: &str,
    into: &Path,
    require: Option<&str>,
) -> Result<()> {
    let kind = archive::kind_of(asset_name)?;
    if kind == archive::Kind::Raw {
        bail!("{asset_name} 은 폴더로 풀 수 있는 것이 아닙니다");
    }
    let staging = into.with_extension("new");
    let _ = fs::remove_dir_all(&staging);

    let staged = (|| -> Result<()> {
        archive::extract(bytes, kind, &staging)?;
        if let Some(name) = require {
            if !staging.join(name).exists() {
                bail!("압축 안에 {name} 이 없습니다");
            }
        }
        Ok(())
    })();
    if let Err(err) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }

    let _ = fs::remove_dir_all(into);
    fs::rename(&staging, into)
        .with_context(|| format!("새 파일을 자리에 놓지 못했습니다: {}", into.display()))?;
    Ok(())
}

/// 돌고 있는 자기 자신을 새 실행 파일로 바꾼다.
///
/// 윈도우는 돌고 있는 파일을 지울 수는 없지만 **이름은 바꿀 수 있다.** `self-replace` 가
/// 그 성질을 써서 옛것을 옆으로 치우고 새것을 그 이름에 놓는다. 도우미 프로세스가 필요 없다.
/// 바꾼 뒤에도 지금 프로세스는 옛 코드로 계속 돈다. 다시 켜야 새 버전이 뜬다.
pub fn update_self(bytes: &[u8], asset_name: &str, binary: &str) -> Result<()> {
    let staging = staging_dir();
    let _ = fs::remove_dir_all(&staging);

    let outcome = (|| -> Result<()> {
        let new_exe = stage_new_binary(bytes, asset_name, binary, &staging)?;

        // 받다 만 파일로 바꿔 끼우면 다시는 켜지지 않는다. 마지막으로 한 번 더 본다.
        let size = fs::metadata(&new_exe)?.len();
        if size < 512 * 1024 {
            bail!("새 실행 파일이 너무 작습니다 ({size} 바이트). 내려받다 깨진 것 같습니다");
        }
        make_executable(&new_exe)?;

        self_replace::self_replace(&new_exe).context("실행 파일을 바꿔 끼우지 못했습니다")?;
        copy_bundle_extras(&staging);
        Ok(())
    })();

    let _ = fs::remove_dir_all(&staging);
    outcome
}

/// 받은 자산에서 새 실행 파일을 꺼내 임시 자리에 놓고 그 경로를 준다.
///
/// 압축본이면 풀어서 찾고, 실행 파일이 그대로 올라온 자산(윈도우용 관리자)이면
/// 받은 바이트가 곧 그 파일이다. 압축이 필요 없는 것까지 굳이 묶지 않는다.
fn stage_new_binary(
    bytes: &[u8],
    asset_name: &str,
    binary: &str,
    staging: &Path,
) -> Result<PathBuf> {
    let kind = archive::kind_of(asset_name)?;
    if kind == archive::Kind::Raw {
        fs::create_dir_all(staging)?;
        let target = staging.join(binary);
        fs::write(&target, bytes)
            .with_context(|| format!("파일을 쓰지 못했습니다: {}", target.display()))?;
        return Ok(target);
    }

    archive::extract(bytes, kind, staging)?;
    archive::find_file(staging, binary).ok_or_else(|| anyhow!("압축 안에 {binary} 이 없습니다"))
}

/// 새 실행 파일을 띄운다. 부른 쪽은 곧바로 자기를 끝내야 한다.
pub fn restart_self() -> Result<()> {
    let exe = std::env::current_exe().context("지금 실행 파일의 자리를 알지 못했습니다")?;
    Command::new(&exe)
        .spawn()
        .with_context(|| format!("다시 띄우지 못했습니다: {}", exe.display()))?;
    Ok(())
}

fn staging_dir() -> PathBuf {
    std::env::temp_dir().join(format!("yt-download-update-{}", std::process::id()))
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .with_context(|| format!("실행 권한을 주지 못했습니다: {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// macOS 는 실행 파일 하나가 아니라 `.app` 번들이다.
///
/// 실행 파일은 `self-replace` 가 바꿨으니 번들에 함께 든 `Info.plist` 도 새것으로 맞춘다.
/// (버전이 적혀 있어서 안 바꾸면 Finder 가 옛 버전으로 보여준다.)
fn copy_bundle_extras(staging: &Path) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // .../yt-download.app/Contents/MacOS/yt-download -> .../yt-download.app/Contents
    let Some(contents) = exe.parent().and_then(Path::parent) else {
        return;
    };
    let in_bundle = contents.file_name().and_then(|name| name.to_str()) == Some("Contents")
        && contents.parent().and_then(Path::extension) == Some(std::ffi::OsStr::new("app"));
    if !in_bundle {
        return;
    }
    if let Some(plist) = archive::find_file(staging, "Info.plist") {
        let _ = fs::copy(plist, contents.join("Info.plist"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in entries {
            use std::io::Write;
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn 폴더는_통째로_갈아_끼운다() {
        let dir = std::env::temp_dir().join("ytdl-update-replace-dir");
        let _ = fs::remove_dir_all(&dir);

        replace_directory(
            &zip_of(&[("manifest.json", br#"{"version":"1"}"#), ("old.js", b"x")]),
            "a.zip",
            &dir,
            Some("manifest.json"),
        )
        .unwrap();
        assert!(dir.join("old.js").exists());

        // 이름이 바뀐 옛 파일이 남아 있으면 크롬이 그걸 계속 읽는다.
        replace_directory(
            &zip_of(&[("manifest.json", br#"{"version":"2"}"#), ("new.js", b"y")]),
            "a.zip",
            &dir,
            Some("manifest.json"),
        )
        .unwrap();
        assert!(dir.join("new.js").exists());
        assert!(!dir.join("old.js").exists(), "옛 파일이 남았습니다");

        // 있어야 할 파일이 없으면 자리에 놓기 전에 멈춘다. 쓰던 것은 그대로 남는다.
        let err = replace_directory(
            &zip_of(&[("other.js", b"z")]),
            "a.zip",
            &dir,
            Some("manifest.json"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("manifest.json"), "{err}");
        assert!(
            dir.join("new.js").exists(),
            "실패했는데 쓰던 것이 사라졌습니다"
        );
        assert!(
            !dir.with_extension("new").exists(),
            "임시 폴더가 남았습니다"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 목록에서_그_파일의_해시만_고른다() {
        let listing = "aaaa  other.zip
bbbb *yt-download-extension.zip
cccc  yt-download-extension.zip.sig
";
        assert_eq!(
            expected_hash(listing, EXTENSION_ASSET).as_deref(),
            Some("bbbb")
        );
        assert_eq!(expected_hash(listing, "없는파일.zip"), None);
    }

    #[test]
    fn 버전은_숫자로_비교한다() {
        assert!(is_newer("0.10.0", "0.9.0"), "10 이 9 보다 크다");
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.3.0"));
        // 태그 그대로 들어와도 같은 답이 나와야 한다.
        assert!(is_newer("v0.3.0", "0.2.0"));
        // 뒤에 붙은 표시는 숫자가 아니라 0 으로 본다(0.3.0-rc1 < 0.3.0 이 아니라 같다).
        assert!(!is_newer("0.3.0-rc1", "0.3.0"));
    }

    #[test]
    fn 자산_이름은_플랫폼을_따른다() {
        let Some(slug) = platform_slug() else {
            return; // 릴리스를 내지 않는 플랫폼에서는 이름도 없다
        };
        let app = Program::App.asset_name().unwrap();
        let manager = Program::Manager.asset_name().unwrap();
        assert!(app.starts_with(&format!("yt-download-{slug}")), "{app}");
        assert!(
            manager.starts_with(&format!("yt-download-manager-{slug}")),
            "{manager}"
        );
        // 앱 이름이 관리자 자산까지 함께 잡아버리면 안 된다.
        assert_ne!(app, manager);
        assert!(app.ends_with(archive_suffix()));

        // 관리자는 어디서든 압축하지 않고 실행 파일 그대로 올린다.
        if cfg!(windows) {
            assert!(manager.ends_with(".exe"), "{manager}");
        } else {
            assert!(!manager.contains('.'), "{manager}");
        }
        // 이름만 보고 어떻게 다룰지 정할 수 있어야 한다.
        assert_eq!(archive::kind_of(&manager).unwrap(), archive::Kind::Raw);
        assert_ne!(archive::kind_of(&app).unwrap(), archive::Kind::Raw);
    }

    #[test]
    fn 압축하지_않은_자산은_그대로_실행_파일이다() {
        let staging = std::env::temp_dir().join("ytdl-update-stage-raw");
        let _ = fs::remove_dir_all(&staging);

        let staged = stage_new_binary(b"binary", "a-windows-x64.exe", "app.exe", &staging).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"binary");
        assert!(staged.ends_with("app.exe"), "{staged:?}");

        // 압축본이면 풀어서 찾는다.
        let _ = fs::remove_dir_all(&staging);
        let archive = zip_of(&[("app.exe", b"zipped")]);
        let staged = stage_new_binary(&archive, "a-windows-x64.zip", "app.exe", &staging).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"zipped");

        // 모르는 이름은 실행 파일 자리에 놓지 않는다.
        assert!(stage_new_binary(b"x", "a.7z", "app.exe", &staging).is_err());

        let _ = fs::remove_dir_all(&staging);
    }

    #[test]
    fn 새_릴리스인지는_버전으로_본다() {
        let release = Release {
            tag: "v0.3.0".into(),
            version: "0.3.0".into(),
            published: Some("2026-08-03T04:00:00Z".into()),
            assets: vec![Asset {
                name: "yt-download-windows-x64.zip".into(),
                url: "https://example.test/a.zip".into(),
            }],
        };
        assert!(release.is_newer_than("0.2.0"));
        assert!(!release.is_newer_than("0.3.0"));
        assert_eq!(release.published_day().as_deref(), Some("2026-08-03"));
        assert!(release.asset("yt-download-windows-x64.zip").is_some());
        assert!(release.asset("없는자산.zip").is_none());
    }
}
