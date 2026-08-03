//! 깃허브 릴리스에서 확장과 관리자 자신을 받아 온다.
//!
//! 릴리스 조회·SHA256 대조·압축 풀기·실행 파일 바꿔 끼우기는 앱과 같은 일이라
//! 공용 크레이트(`yt-download-update`)가 한다. 여기는 "무엇을 받을지"만 정한다.

use std::path::Path;

use anyhow::{anyhow, Result};
use yt_download_update as update;

pub use update::Release;

/// 확장을 어디서 가져오는지. 포크해서 쓰려면 공용 크레이트의 `REPO` 만 바꾸면 된다.
pub const REPO: &str = update::REPO;

/// 깃허브 API 는 User-Agent 가 없으면 403 을 준다.
fn agent() -> String {
    format!(
        "yt-download-extension-manager/{}",
        env!("CARGO_PKG_VERSION")
    )
}

pub fn latest_release() -> Result<Release> {
    update::latest_release(REPO, &agent())
}

/// 확장을 받아서 정해진 자리에 푼다. 받은 파일이 맞는지 먼저 확인한다.
pub fn install_extension(release: &Release, into: &Path) -> Result<()> {
    let bytes = update::fetch_verified(release, update::EXTENSION_ASSET, &agent())?;
    // 압축을 푼 자리에 manifest.json 이 바로 있어야 크롬이 폴더로 인식한다.
    update::replace_directory(&bytes, update::EXTENSION_ASSET, into, Some("manifest.json"))
}

/// 관리자 자신을 새 버전으로 바꾼다. 바꾼 뒤 다시 켜야 새것이 뜬다.
pub fn update_manager(release: &Release) -> Result<()> {
    let program = update::Program::Manager;
    let asset = program
        .asset_name()
        .ok_or_else(|| anyhow!("이 컴퓨터 종류로 나온 릴리스 자산이 없습니다"))?;
    let bytes = update::fetch_verified(release, &asset, &agent())?;
    update::update_self(&bytes, &asset, program.binary_name())
}

/// 지금 도는 관리자 버전.
pub fn manager_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
