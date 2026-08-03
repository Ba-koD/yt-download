//! 크롬 확장 관리자.
//!
//! 크롬은 스토어를 거치지 않은 확장을 자동으로 갱신해 주지 않는다. 예전에는 CRX 를
//! 직접 호스팅하고 `update_url` 로 갱신할 수 있었지만 지금은 막혔다. 남은 길은
//! "압축 해제된 확장"인데, 그건 폴더를 그대로 읽는 방식이라 폴더만 갈아주면 된다.
//!
//! 그래서 이 앱이 깃허브 릴리스를 보고 최신인지 확인한 뒤, 정해진 자리에 풀어 놓는다.
//! 자리가 고정이라 크롬이 보던 확장이 그대로 갱신되고 확장 ID 도 바뀌지 않는다.
//! 다만 크롬이 폴더를 다시 읽게 하려면 사용자가 새로고침을 한 번 눌러야 한다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Result;
use serde::Serialize;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

mod github;

/// 확장을 풀어 놓는 자리. 크롬에 이 폴더를 골라준다.
fn install_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("extension")
}

/// manifest.json 에서 버전만 꺼낸다. 통째로 파싱할 이유가 없다.
fn installed_version() -> Option<String> {
    let bytes = fs::read(install_dir().join("manifest.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// 화면에 그대로 넘겨주는 상태.
#[derive(Serialize, Default)]
struct View {
    installed: Option<String>,
    latest: Option<String>,
    published: Option<String>,
    path: String,
    note: String,
    /// 받을 것이 있는지. 이때만 설치 단추를 눈에 띄게 둔다.
    update: bool,
    busy: bool,
    failed: bool,
    /// 지금 도는 관리자 버전. 확장 버전과 헷갈리지 않게 따로 보여준다.
    manager: &'static str,
    /// 관리자 자신에게도 새 버전이 있는지.
    manager_update: bool,
    /// 관리자를 바꿔 끼운 뒤. 다시 켜야 새것이 뜬다.
    restart: bool,
}

impl View {
    fn base() -> Self {
        View {
            installed: installed_version(),
            path: install_dir().to_string_lossy().to_string(),
            manager: github::manager_version(),
            ..Default::default()
        }
    }
}

enum Message {
    Show(View),
}

fn main() -> Result<()> {
    let event_loop = EventLoopBuilder::<Message>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("yt-download 확장 관리자")
        .with_inner_size(LogicalSize::new(640.0, 660.0))
        .with_min_inner_size(LogicalSize::new(520.0, 560.0))
        .build(&event_loop)?;

    let handler = {
        let proxy = proxy.clone();
        move |request: wry::http::Request<String>| handle(request.body().trim(), proxy.clone())
    };

    let webview = WebViewBuilder::new()
        .with_html(include_str!("page.html"))
        .with_ipc_handler(handler)
        .build(&window)?;

    // 창이 뜨자마자 최신인지 본다. 사용자가 뭘 누르기를 기다릴 이유가 없다.
    check_in_background(proxy);

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Message::Show(view)) => {
                let json = serde_json::to_string(&view).unwrap_or_else(|_| "{}".into());
                let _ = webview.evaluate_script(&format!("window.show({json})"));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

fn handle(action: &str, proxy: EventLoopProxy<Message>) {
    match action {
        "check" => check_in_background(proxy),
        "install" => install_in_background(proxy),
        "update-self" => update_self_in_background(proxy),
        "restart" => {
            // 바꿔 끼운 새 실행 파일을 띄우고 이 프로세스는 나간다.
            // 실패하면 창을 그대로 두고 이유를 적는다(적어도 쓰던 것은 멀쩡하다).
            match yt_download_update::restart_self() {
                Ok(()) => std::process::exit(0),
                Err(err) => {
                    let mut view = View::base();
                    view.failed = true;
                    view.restart = true;
                    view.note = format!("{err}");
                    let _ = proxy.send_event(Message::Show(view));
                }
            }
        }
        "remove" => {
            let dir = install_dir();
            let mut view = View::base();
            match fs::remove_dir_all(&dir) {
                Ok(()) => {
                    view.installed = None;
                    view.update = true;
                    view.note = "지웠습니다 · 크롬의 확장 목록에서도 제거해 주세요".into();
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    view.note = "이미 없습니다".into();
                }
                Err(err) => {
                    view.failed = true;
                    view.note = format!("지우지 못했습니다: {err}");
                }
            }
            let _ = proxy.send_event(Message::Show(view));
        }
        "open" => {
            let dir = install_dir();
            if dir.exists() {
                open_folder(&dir);
            } else {
                let mut view = View::base();
                view.note = "아직 설치하지 않았습니다".into();
                let _ = proxy.send_event(Message::Show(view));
            }
        }
        _ => {}
    }
}

/// 최신 릴리스를 확인한다. 네트워크가 오래 걸려도 창이 멈추지 않도록 따로 돌린다.
fn check_in_background(proxy: EventLoopProxy<Message>) {
    let mut busy = View::base();
    busy.busy = true;
    busy.note = "최신 버전을 확인하는 중입니다".into();
    let _ = proxy.send_event(Message::Show(busy));

    std::thread::spawn(move || {
        let mut view = View::base();
        match github::latest_release() {
            Ok(release) => {
                let latest = release.version.clone();
                view.update = view.installed.as_deref() != Some(latest.as_str());
                view.manager_update = release.is_newer_than(github::manager_version());
                view.note = match &view.installed {
                    None => "아직 설치하지 않았습니다".into(),
                    Some(installed) if *installed == latest => "최신입니다".into(),
                    Some(installed) => format!("{installed} → {latest} 업데이트가 있습니다"),
                };
                if view.manager_update {
                    view.note.push_str(" · 관리자 자신도 새 버전이 있습니다");
                }
                view.published = release.published_day();
                view.latest = Some(latest);
            }
            Err(err) => {
                view.failed = true;
                view.note = format!("{err}");
            }
        }
        let _ = proxy.send_event(Message::Show(view));
    });
}

fn install_in_background(proxy: EventLoopProxy<Message>) {
    let mut busy = View::base();
    busy.busy = true;
    busy.note = "받아서 설치하는 중입니다".into();
    let _ = proxy.send_event(Message::Show(busy));

    std::thread::spawn(move || {
        let outcome = github::latest_release().and_then(|release| {
            github::install_extension(&release, &install_dir()).map(|()| release)
        });

        let mut view = View::base();
        match outcome {
            Ok(release) => {
                view.installed = installed_version();
                view.note = "설치했습니다 · 크롬에서 새로고침하면 반영됩니다".into();
                view.manager_update = release.is_newer_than(github::manager_version());
                view.latest = Some(release.version);
                view.update = false;
            }
            Err(err) => {
                view.failed = true;
                view.note = format!("{err}");
            }
        }
        let _ = proxy.send_event(Message::Show(view));
    });
}

/// 관리자 자신을 갱신한다. 확장과 달리 돌고 있는 실행 파일을 바꿔 끼우는 일이다.
fn update_self_in_background(proxy: EventLoopProxy<Message>) {
    let mut busy = View::base();
    busy.busy = true;
    busy.note = "관리자를 받아서 바꿔 끼우는 중입니다".into();
    let _ = proxy.send_event(Message::Show(busy));

    std::thread::spawn(move || {
        let outcome = github::latest_release()
            .and_then(|release| github::update_manager(&release).map(|()| release));

        let mut view = View::base();
        match outcome {
            Ok(release) => {
                // 지금 프로세스는 여전히 옛 코드로 돈다. 다시 켜야 새것이 뜬다.
                view.note = format!("{} 로 바꿨습니다 · 다시 켜면 적용됩니다", release.version);
                view.latest = Some(release.version);
                view.restart = true;
            }
            Err(err) => {
                view.failed = true;
                view.note = format!("{err}");
            }
        }
        let _ = proxy.send_event(Message::Show(view));
    });
}

fn open_folder(path: &Path) {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // 탐색기는 폴더를 열어주고도 0이 아닌 값을 돌려줄 때가 있어서 결과를 따지지 않는다.
    let _ = Command::new(program).arg(path).spawn();
}
