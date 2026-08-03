//! yt-download: YouTube 영상/라이브의 원하는 구간만 받아오는 데스크톱 앱.
//!
//! 실행 방식은 두 가지다.
//! - 기본: 앱 창(webview)을 띄우고 그 안에서 로컬 서버 화면을 연다.
//! - `--browser`: 서버만 띄우고 기본 브라우저로 연다.

use std::{sync::mpsc, thread, time::Duration};

use anyhow::{anyhow, Context, Result};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget},
    window::{Window, WindowBuilder},
};
use wry::{NewWindowResponse, WebView, WebViewBuilder};

use crate::server::serve_app;

mod download;
mod jobs;
mod live;
mod login;
mod media;
mod progress;
mod server;
mod tools;
mod update;
mod youtube;

fn main() -> Result<()> {
    let mode = RunMode::from_args();
    match mode {
        RunMode::Desktop => run_desktop_app(),
        RunMode::Browser => {
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(serve_app(None, true))
        }
    }
}

enum RunMode {
    Desktop,
    Browser,
}

impl RunMode {
    fn from_args() -> Self {
        if std::env::args()
            .skip(1)
            .any(|arg| arg == "--browser" || arg == "--web")
        {
            Self::Browser
        } else {
            Self::Desktop
        }
    }
}

fn run_desktop_app() -> Result<()> {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(err) => {
                let _ = tx.send(Err(format!("could not start async runtime: {err}")));
                return;
            }
        };

        if let Err(err) = runtime.block_on(serve_app(Some(tx), false)) {
            eprintln!("server error: {err:#}");
        }
    });

    let url = rx
        .recv_timeout(Duration::from_secs(10))
        .context("local server did not start in time")?
        .map_err(|err| anyhow!(err))?;

    // 앱 창은 시스템 webview(Windows는 WebView2, Linux는 WebKitGTK)에 기대고 있다.
    // 그게 없으면 창을 못 만드는데, 서버는 멀쩡하므로 기본 브라우저로 열어서 계속 쓸 수 있게 한다.
    if let Err(err) = open_app_window(&url) {
        eprintln!("could not open the app window: {err:#}");
        eprintln!("falling back to the default browser at {url}");
        if webbrowser::open(&url).is_err() {
            return Err(err.context(format!(
                "앱 창을 열지 못했습니다. 브라우저에서 {url} 로 접속해 사용하세요. \
Windows라면 Microsoft Edge WebView2 런타임 설치가 필요할 수 있습니다."
            )));
        }
        // 브라우저로 넘어갔으면 서버가 살아 있어야 하므로 여기서 계속 기다린다.
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum UserEvent {
    OpenConsole,
}

fn open_app_window(url: &str) -> Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("yt-download")
        .with_inner_size(LogicalSize::new(1440.0, 920.0))
        .with_min_inner_size(LogicalSize::new(1040.0, 720.0))
        .build(&event_loop)
        .context("could not create app window")?;
    let main_window_id = window.id();

    let builder = WebViewBuilder::new()
        .with_url(url)
        // 화면에서 "콘솔 창"을 누르면 로그 전용 창을 따로 띄운다.
        .with_ipc_handler(move |request| {
            if request.body().trim() == "open-console" {
                let _ = proxy.send_event(UserEvent::OpenConsole);
            }
        })
        .with_new_window_req_handler(|url, _features| {
            let _ = webbrowser::open(&url);
            NewWindowResponse::Deny
        });

    let _webview = build_webview(builder, &window)?;

    let console_url = format!("{}/console", url.trim_end_matches('/'));
    let mut console: Option<(Window, WebView)> = None;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(UserEvent::OpenConsole) => {
                if let Some((window, _)) = &console {
                    window.set_focus();
                    return;
                }
                match open_console_window(target, &console_url) {
                    Ok(pair) => console = Some(pair),
                    Err(err) => eprintln!("could not open console window: {err:#}"),
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if window_id == main_window_id {
                    *control_flow = ControlFlow::Exit;
                } else if console
                    .as_ref()
                    .map(|(window, _)| window.id() == window_id)
                    .unwrap_or(false)
                {
                    console = None;
                }
            }
            _ => {}
        }
    });
}

fn open_console_window(
    target: &EventLoopWindowTarget<UserEvent>,
    url: &str,
) -> Result<(Window, WebView)> {
    let window = WindowBuilder::new()
        .with_title("yt-download 콘솔")
        .with_inner_size(LogicalSize::new(820.0, 560.0))
        .with_min_inner_size(LogicalSize::new(420.0, 260.0))
        .build(target)
        .context("could not create console window")?;
    let webview = build_webview(WebViewBuilder::new().with_url(url), &window)?;
    Ok((window, webview))
}

fn build_webview(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView> {
    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    ))]
    {
        builder.build(window).context("could not create webview")
    }

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().context("could not access GTK vbox")?;
        builder
            .build_gtk(vbox)
            .context("could not create GTK webview")
    }
}
