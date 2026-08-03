//! 바깥 명령(yt-dlp·ffmpeg·taskkill 등)을 창 없이 띄우기.
//!
//! 배포 빌드의 앱은 창 없는 GUI 다(`main.rs` 의 `windows_subsystem = "windows"`).
//! 그 상태에서 콘솔 프로그램을 그냥 띄우면 **검은 콘솔 창이 깜빡였다 사라진다.**
//! `CREATE_NO_WINDOW` 로 창을 아예 안 만든다. 유닉스에서는 하는 일이 없다.

/// CREATE_NO_WINDOW. 콘솔 창을 만들지 않는다.
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

/// 비동기(tokio) 명령에 창 숨김을 건다.
pub(crate) fn hide(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    cmd
}

/// 동기(std) 명령에 창 숨김을 건다(로그인·기본 브라우저 감지의 콘솔 명령에 쓴다).
///
/// 부르는 곳이 전부 `#[cfg(windows)]` 안이라 유닉스에서는 쓰이지 않는다. 그래도 신호를
/// 맞추려고 양쪽에 둔다(유닉스에서는 죽은 코드지만 두어도 무해하다).
#[cfg(windows)]
pub(crate) fn hide_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub(crate) fn hide_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}
