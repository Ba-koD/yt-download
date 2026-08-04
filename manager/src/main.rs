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
    sync::Mutex,
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

mod autostart;
mod browser;
mod config;
mod github;
mod proc;

use config::Config;

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

/// 로그인 시 창 없이 도는 자동 확인.
///
/// 확장이 최신이면 아무것도 하지 않고 조용히 나간다(창도, 소리도 없다).
/// 새 버전이면 폴더를 갈아 끼우고(확장이 스스로 갈아탄다) 무엇이 바뀌었는지
/// changelog 페이지를 브라우저로 열어 보여준다.
fn run_auto() {
    // 아직 설치도 안 했으면 자동으로 할 일이 없다. 처음 설치는 사람이 창에서 한다.
    let Some(installed) = installed_version() else {
        return;
    };
    let Ok(release) = github::latest_release() else {
        return; // 인터넷이 없거나 깃허브가 막혔다. 다음 로그인에 다시 본다.
    };
    if !release.is_newer_than(&installed) {
        return; // 최신이다. 조용히 나간다.
    }

    // 다 받아 검사한 뒤 폴더를 갈아 끼운다. 실패하면 쓰던 확장이 그대로 남는다.
    if github::install_extension(&release, &install_dir()).is_err() {
        return;
    }

    // 무엇이 바뀌었는지 보여준다. 확장이 들어 있는 브라우저로 연다.
    let config = Config::load();
    browser::open_url(
        &github::changelog_url(&release.version),
        config.browser.as_deref(),
    );
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
    /// 넣을 수 있는 브라우저들과, 지금 고른 브라우저.
    browsers: &'static [browser::Browser],
    chosen_browser: Option<String>,
    /// 고른 브라우저의 이름. 화면이 문장에 그대로 쓴다.
    browser_label: Option<&'static str>,
    /// 고른 브라우저가 이 컴퓨터에 깔려 있는지.
    browser_here: bool,
    /// 고른 브라우저에 우리 확장이 얹혀 있는지.
    browser_loaded: browser::Loaded,
    /// 로그인 시 자동으로 업데이트를 확인하도록 등록돼 있는지.
    auto_update: bool,
}

/// 마지막으로 확인한 최신 릴리스(버전, 올라온 날).
///
/// 담아두지 않으면 화면을 다시 그릴 때마다 "최신" 칸이 `—` 로 돌아간다. 브라우저를
/// 고르거나 경로를 복사하는 것 같은 일에도 화면을 다시 그리므로 그때마다 깜빡였다.
/// 깃허브에 다시 묻는 것은 "다시 확인" 을 눌렀을 때뿐이다.
static LATEST: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

fn remembered_latest() -> Option<(String, Option<String>)> {
    LATEST.lock().ok().and_then(|slot| slot.clone())
}

impl View {
    fn base() -> Self {
        let config = Config::load();
        // 지난번에 고른 브라우저가 있으면 그것, 없으면 이 컴퓨터의 기본 브라우저.
        // 파이어폭스처럼 목록에 없는 것이 기본이면 고르지 않은 채로 둔다.
        let chosen = config
            .browser
            .or_else(|| browser::default_key().map(str::to_string));
        let dir = install_dir();
        let installed = installed_version();
        let latest = remembered_latest();
        View {
            update: latest
                .as_ref()
                .is_some_and(|(version, _)| Some(version.as_str()) != installed.as_deref()),
            latest: latest.as_ref().map(|(version, _)| version.clone()),
            published: latest.and_then(|(_, day)| day),
            installed,
            path: dir.to_string_lossy().to_string(),
            manager: github::manager_version(),
            browsers: browser::BROWSERS,
            browser_label: chosen
                .as_deref()
                .and_then(browser::find)
                .map(|browser| browser.label),
            browser_here: chosen.as_deref().is_some_and(browser::is_installed),
            browser_loaded: chosen.as_deref().map_or(browser::Loaded::Unknown, |key| {
                browser::extension_state(key, &dir)
            }),
            chosen_browser: chosen,
            auto_update: autostart::is_enabled(),
            ..Default::default()
        }
    }
}

enum Message {
    Show(View),
}

fn main() -> Result<()> {
    // 로그인 시 시작 항목이 `--auto` 로 띄운다. 창 없이 업데이트만 확인하고 나간다.
    if std::env::args().skip(1).any(|arg| arg == "--auto") {
        run_auto();
        return Ok(());
    }

    let event_loop = EventLoopBuilder::<Message>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("yt-download 확장 관리자")
        // 앱과 같은 아이콘. 생 RGBA 라 해독기가 필요 없다(scripts/make-logo.py 가 만든다).
        .with_window_icon(
            tao::window::Icon::from_rgba(
                include_bytes!("../../assets/icon-64.rgba").to_vec(),
                64,
                64,
            )
            .ok(),
        )
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
                    let label = view.browser_label.unwrap_or("브라우저");
                    view.installed = None;
                    view.update = true;
                    view.browser_loaded = browser::Loaded::No;
                    view.note = format!("지웠습니다 · {label} 의 확장 목록에서도 제거해 주세요");
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
        // 화면이 "copy:<붙여넣을 것>" 으로 보낸다. 확장 페이지 주소와 폴더 경로를 나른다.
        // 크로미움은 명령줄로 넘긴 chrome:// 주소를 무시해서, 열어주는 대신 복사해 준다.
        other if other.starts_with("copy:") => {
            let text = other.trim_start_matches("copy:").trim();
            let mut view = View::base();
            view.note = if browser::copy_to_clipboard(text) {
                format!("복사했습니다: {text}")
            } else {
                format!("복사하지 못했습니다. 직접 입력해 주세요: {text}")
            };
            let _ = proxy.send_event(Message::Show(view));
        }
        // 브라우저를 골랐다. 자동 확인이 창 없이 돌 때도 알 수 있도록 파일에 적어둔다.
        // 고르고 나면 그 브라우저 기준으로 화면을 다시 그린다 — 폴더는 같아도
        // 그 브라우저에 얹혔는지는 브라우저마다 다르다.
        other if other.starts_with("browser:") => {
            let key = other.trim_start_matches("browser:").trim().to_string();
            let mut config = Config::load();
            config.browser = (!key.is_empty()).then_some(key);
            let _ = config.save();
            let _ = proxy.send_event(Message::Show(View::base()));
        }
        // 로그인 시 자동 확인 켜기/끄기. 시작 항목을 등록하거나 지운다.
        "auto-on" | "auto-off" => {
            let on = action == "auto-on";
            let mut view = View::base();
            match autostart::set(on) {
                Ok(()) => {
                    view.auto_update = on;
                    view.note = if on {
                        "로그인할 때마다 조용히 업데이트를 확인합니다".into()
                    } else {
                        "자동 확인을 껐습니다".into()
                    };
                }
                Err(err) => {
                    view.failed = true;
                    view.note = format!("설정하지 못했습니다: {err}");
                }
            }
            let _ = proxy.send_event(Message::Show(view));
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
                if let Ok(mut slot) = LATEST.lock() {
                    *slot = Some((latest.clone(), release.published_day()));
                }
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
                // 처음 설치하면 로그인 자동 확인을 켜 둔다. "설치하고 잊기"가 되도록.
                // 사용자가 끈 적이 있으면(설정에 흔적) 다시 켜지 않는다.
                if !view.auto_update && autostart::set(true).is_ok() {
                    view.auto_update = true;
                }
                view.installed = installed_version();
                // 폴더만 갈아 끼운 것과 그 브라우저가 그 폴더를 읽는 것은 다른 이야기다.
                // 아직 안 얹은 브라우저를 골라뒀다면 그것부터 알려준다.
                let label = view.browser_label.unwrap_or("브라우저");
                view.note = if view.browser_loaded == browser::Loaded::Yes {
                    format!("설치했습니다 · {label} 에서 새로고침하면 반영됩니다. 이후 갱신은 자동입니다")
                } else {
                    format!("설치했습니다 · {label} 에 이 폴더를 얹어주세요(아래 순서, 한 번만)")
                };
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
    let _ = crate::proc::command(program).arg(path).spawn();
}
