//! 깃허브 릴리스에서 최신 확장을 찾아 받아 온다.

use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 확장을 어디서 가져오는지. 포크해서 쓰려면 여기만 바꾸면 된다.
pub const REPO: &str = "Ba-koD/yt-download";
const ASSET: &str = "yt-download-extension.zip";
const CHECKSUMS: &str = "SHA256SUMS.txt";

pub struct Release {
    pub tag: String,
    pub archive_url: String,
    pub checksums_url: Option<String>,
    pub published: Option<String>,
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

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // 깃허브 API 는 User-Agent 가 없으면 403 을 준다.
        .user_agent(concat!(
            "yt-download-extension-manager/",
            env!("CARGO_PKG_VERSION")
        ))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("네트워크 준비에 실패했습니다")
}

/// 최신 릴리스를 찾는다.
pub fn latest_release() -> Result<Release> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let response = client()?
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
    let find = |name: &str| {
        release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .map(|asset| asset.browser_download_url.clone())
    };

    Ok(Release {
        archive_url: find(ASSET).ok_or_else(|| anyhow!("릴리스에 {ASSET} 이 없습니다"))?,
        checksums_url: find(CHECKSUMS),
        tag: release.tag_name,
        published: release.published_at,
    })
}

/// 확장을 받아서 정해진 자리에 푼다. 받은 파일이 맞는지 먼저 확인한다.
pub fn install(release: &Release, into: &Path) -> Result<()> {
    let http = client()?;
    let archive = http
        .get(&release.archive_url)
        .send()
        .and_then(|response| response.error_for_status())
        .context("확장을 내려받지 못했습니다")?
        .bytes()
        .context("내려받은 내용을 읽지 못했습니다")?;

    verify(&http, release, &archive)?;
    unpack(&archive, into)
}

/// 받은 파일이 릴리스에 적힌 것과 같은지 본다.
///
/// 체크섬 파일이 없으면 넘어간다. 옛 릴리스에는 없을 수 있어서 여기서 막지는 않는다.
fn verify(http: &reqwest::blocking::Client, release: &Release, archive: &[u8]) -> Result<()> {
    let Some(url) = &release.checksums_url else {
        return Ok(());
    };
    let listing = http
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .context("체크섬 목록을 받지 못했습니다")?
        .text()
        .context("체크섬 목록을 읽지 못했습니다")?;

    let Some(expected) = expected_hash(&listing, ASSET) else {
        return Ok(());
    };

    let actual = format!("{:x}", Sha256::digest(archive));
    if actual != expected {
        bail!("받은 파일이 릴리스에 적힌 것과 다릅니다 (내려받다 깨졌을 수 있습니다)");
    }
    Ok(())
}

/// `sha256sum` 형식의 목록에서 그 파일의 해시를 찾는다.
///
/// 목록은 `<해시>  <이름>` 꼴이고, 이름 앞에 `*` 가 붙기도 한다(이진 모드 표시).
fn expected_hash(listing: &str, name: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let found = parts.next()?.trim_start_matches('*');
        (found == name).then(|| hash.to_ascii_lowercase())
    })
}

/// 압축을 푼다. 있던 파일은 지우고 새로 쓴다.
///
/// 이름이 바뀐 옛 파일이 남아 있으면 크롬이 그걸 계속 읽어서
/// 무슨 일이 벌어지는지 알기 어려워진다.
fn unpack(archive: &[u8], into: &Path) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(archive)).context("압축을 열지 못했습니다")?;

    // 압축을 푼 자리에 manifest.json 이 바로 있어야 크롬이 폴더로 인식한다.
    if zip.by_name("manifest.json").is_err() {
        bail!("압축 안에 manifest.json 이 없습니다");
    }

    let staging = into.with_extension("new");
    let _ = fs::remove_dir_all(&staging);

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .context("압축 안의 파일을 읽지 못했습니다")?;
        let Some(relative) = entry.enclosed_name() else {
            bail!("압축 안에 이상한 경로가 있습니다: {}", entry.name());
        };
        if relative
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            bail!(
                "압축 안에 폴더 밖을 가리키는 경로가 있습니다: {}",
                entry.name()
            );
        }

        let target = staging.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        fs::write(&target, bytes)
            .with_context(|| format!("파일을 쓰지 못했습니다: {}", target.display()))?;
    }

    // 다 풀고 나서 한 번에 바꿔 끼운다. 도중에 실패해도 쓰던 확장은 멀쩡하다.
    let _ = fs::remove_dir_all(into);
    fs::rename(&staging, into)
        .with_context(|| format!("새 확장을 자리에 놓지 못했습니다: {}", into.display()))?;
    Ok(())
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
    fn 목록에서_그_파일의_해시만_고른다() {
        let listing = "aaaa  other.zip
bbbb *yt-download-extension.zip
cccc  yt-download-extension.zip.sig
";
        assert_eq!(expected_hash(listing, ASSET).as_deref(), Some("bbbb"));
        assert_eq!(expected_hash(listing, "없는파일.zip"), None);
    }

    #[test]
    fn manifest_가_없으면_확장이_아니다() {
        let archive = zip_of(&[("src/content.js", b"// content")]);
        let dir = std::env::temp_dir().join("ytdl-manager-test-1");
        let err = unpack(&archive, &dir).unwrap_err();
        assert!(err.to_string().contains("manifest.json"), "{err}");
    }

    #[test]
    fn 새_확장이_옛_파일을_남기지_않는다() {
        let dir = std::env::temp_dir().join("ytdl-manager-test-2");
        let _ = fs::remove_dir_all(&dir);

        unpack(
            &zip_of(&[("manifest.json", br#"{"version":"1"}"#), ("old.js", b"x")]),
            &dir,
        )
        .unwrap();
        assert!(dir.join("old.js").exists());

        // 이름이 바뀐 옛 파일이 남아 있으면 크롬이 그걸 계속 읽는다.
        unpack(
            &zip_of(&[("manifest.json", br#"{"version":"2"}"#), ("new.js", b"y")]),
            &dir,
        )
        .unwrap();
        assert!(dir.join("new.js").exists());
        assert!(!dir.join("old.js").exists(), "옛 파일이 남았습니다");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 폴더_밖을_가리키는_경로는_거절한다() {
        let archive = zip_of(&[("manifest.json", b"{}"), ("../outside.js", b"x")]);
        let dir = std::env::temp_dir().join("ytdl-manager-test-3");
        assert!(unpack(&archive, &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
