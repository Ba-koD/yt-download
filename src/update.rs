//! 앱 자동 업데이트.
//!
//! 실제 일(릴리스 조회·SHA256 대조·압축 풀기·실행 파일 바꿔 끼우기)은 공용 크레이트가 한다.
//! 여기서는 화면에 줄 답을 만들고, 네트워크가 서버를 붙잡지 않도록 따로 돌린다.
//!
//! 앱은 자기 자산만 받는다(`yt-download-<플랫폼>`). 관리자는 자기 것을 따로 받는다.
//! 하나로 묶여 있던 시절에는 관리자만 고쳐도 167MB 를 다시 받아야 했다.

use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use yt_download_update as update;

pub(crate) const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 다시 켜진 것이 업데이트 때문임을 알리는 표시.
/// 이걸 달고 뜨면 옛 프로세스가 포트를 놓을 때까지 잠깐 기다렸다가 같은 포트를 잡는다.
pub(crate) const RESTART_ENV: &str = "YT_DOWNLOAD_RESTARTED";

#[derive(Debug, Serialize)]
pub(crate) struct UpdateStatus {
    pub(crate) current: &'static str,
    pub(crate) latest: Option<String>,
    pub(crate) published: Option<String>,
    /// 받을 것이 있는지.
    pub(crate) available: bool,
    /// 바꿔 끼운 뒤. 다시 켜야 새 버전이 뜬다.
    pub(crate) restart: bool,
    pub(crate) note: String,
}

impl UpdateStatus {
    fn new(note: impl Into<String>) -> Self {
        UpdateStatus {
            current: CURRENT_VERSION,
            latest: None,
            published: None,
            available: false,
            restart: false,
            note: note.into(),
        }
    }
}

fn agent() -> String {
    format!("yt-download/{CURRENT_VERSION}")
}

/// 새 버전이 있는지만 본다.
pub(crate) async fn check() -> Result<UpdateStatus> {
    off_thread(check_now).await
}

/// 받아서 바꿔 끼운다. 다 받아 검사한 뒤 마지막에 바꾸므로, 실패하면 쓰던 것이 그대로 남는다.
pub(crate) async fn apply() -> Result<UpdateStatus> {
    off_thread(apply_now).await
}

/// 새 실행 파일을 띄운다. 부른 쪽은 곧 자기를 끝내야 한다.
pub(crate) fn restart() -> Result<()> {
    let exe = std::env::current_exe().context("지금 실행 파일의 자리를 알지 못했습니다")?;
    Command::new(&exe)
        .env(RESTART_ENV, "1")
        .spawn()
        .with_context(|| format!("다시 띄우지 못했습니다: {}", exe.display()))?;
    Ok(())
}

fn check_now() -> Result<UpdateStatus> {
    let release = update::latest_release(update::REPO, &agent())?;
    let mut status = UpdateStatus::new("");
    status.published = release.published_day();
    status.latest = Some(release.version.clone());

    if !release.is_newer_than(CURRENT_VERSION) {
        status.note = format!("최신입니다 (v{CURRENT_VERSION})");
        return Ok(status);
    }

    match asset_for_this_computer(&release) {
        Ok(_) => {
            status.available = true;
            status.note = format!("v{} 로 업데이트할 수 있습니다", release.version);
        }
        Err(err) => status.note = format!("{err}"),
    }
    Ok(status)
}

fn apply_now() -> Result<UpdateStatus> {
    let release = update::latest_release(update::REPO, &agent())?;
    let mut status = UpdateStatus::new("");
    status.published = release.published_day();
    status.latest = Some(release.version.clone());

    if !release.is_newer_than(CURRENT_VERSION) {
        status.note = format!("최신입니다 (v{CURRENT_VERSION})");
        return Ok(status);
    }

    let asset = asset_for_this_computer(&release)?;
    let bytes = update::fetch_verified(&release, &asset, &agent())?;
    update::update_self(&bytes, &asset, update::Program::App.binary_name())?;

    status.restart = true;
    status.note = format!("v{} 로 바꿨습니다 · 다시 켜면 적용됩니다", release.version);
    Ok(status)
}

/// 이 컴퓨터가 받아야 할 자산 이름. 릴리스에 실제로 올라와 있어야 한다.
fn asset_for_this_computer(release: &update::Release) -> Result<String> {
    let name = update::Program::App
        .asset_name()
        .ok_or_else(|| anyhow!("이 컴퓨터 종류로는 릴리스가 나오지 않습니다"))?;
    if release.asset(&name).is_none() {
        return Err(anyhow!(
            "새 버전 v{} 이 있지만 이 컴퓨터용 파일({name})이 릴리스에 없습니다",
            release.version
        ));
    }
    Ok(name)
}

/// 네트워크 작업을 서버 바깥에서 돌린다.
///
/// 공용 크레이트는 기다리는 방식(blocking)의 HTTP 를 쓴다. 관리자와 같은 코드를 쓰려면
/// 그게 맞는데, 그대로 부르면 서버가 그동안 아무것도 못 한다(내려받기는 수십 초다).
/// 그래서 따로 만든 실 위에서 돌리고 여기서는 답만 기다린다.
async fn off_thread<T>(work: fn() -> Result<T>) -> Result<T>
where
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.await.context("업데이트 작업이 끝나기 전에 끊겼습니다")?
}

/// 업데이트로 다시 켜진 것인지.
///
/// 그렇다면 옛 프로세스가 아직 포트를 쥐고 있을 수 있다. 서버가 몇 번 더 두드려 보고
/// 쓰던 주소를 그대로 잡게 한다(사용자가 열어둔 주소가 바뀌면 성가시다).
pub(crate) fn restarted() -> bool {
    std::env::var(RESTART_ENV).is_ok_and(|value| value == "1")
}
