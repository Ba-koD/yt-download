//! 바깥 명령을 띄울 때 쓰는 공용 만들기.
//!
//! 관리자는 창 없는 GUI 앱이라(`windows_subsystem = "windows"`), 여기서 `reg`·`cmd` 같은
//! 콘솔 프로그램을 그냥 띄우면 **검은 콘솔 창이 깜빡였다 사라진다.** 게다가 그 창이 잠깐
//! 포커스를 가져가서 화면이 얼어붙은 것처럼 보인다. `CREATE_NO_WINDOW` 로 창을 아예 안 만든다.

use std::{ffi::OsStr, process::Command};

/// 창을 만들지 않고 프로그램을 띄울 준비를 한다.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    hide(Command::new(program))
}

#[cfg(windows)]
fn hide(mut cmd: Command) -> Command {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW. 콘솔 창을 만들지 않는다.
    cmd.creation_flags(0x0800_0000);
    cmd
}

#[cfg(not(windows))]
fn hide(cmd: Command) -> Command {
    cmd
}
