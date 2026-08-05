//! yt-download: YouTube 영상/라이브의 원하는 구간만 받아오는 데스크톱 앱.
//!
//! 실행 방식은 두 가지다.
//! - 기본: 앱 창(webview)을 띄운다. 화면과 API 는 webview 의 커스텀 프로토콜로 나르므로
//!   **열린 포트가 없다** — 다른 프로그램이나 웹페이지가 API 를 건드릴 길 자체가 없다.
//! - `--browser`: 로컬 서버(127.0.0.1)를 띄우고 기본 브라우저로 연다. 이때는 포트가
//!   열리므로 시작할 때 만든 토큰 없이는 API 를 받지 않는다.

// 배포 빌드는 창 없는 GUI 로 만든다. 안 그러면 실행할 때 검은 콘솔 창이 함께 뜬다.
// 개발 빌드는 그대로 둬서 로그를 콘솔에서 본다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;

use anyhow::{Context, Result};
use axum::Router;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget},
    window::{Window, WindowBuilder},
};
use wry::{
    http::{Request as HttpRequest, Response as HttpResponse, StatusCode},
    NewWindowResponse, RequestAsyncResponder, WebView, WebViewBuilder,
};

use crate::server::serve_app;

mod download;
mod jobs;
mod live;
mod login;
mod media;
mod proc;
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

/// 앱 화면이 사는 주소. wry 가 Windows 에서는 `http://app.localhost` 로 바꿔 준다.
const UI_SCHEME: &str = "app";
const UI_ORIGIN: &str = "app://localhost";

fn run_desktop_app() -> Result<()> {
    // 다운로드 작업이 이 런타임에서 돈다. 이벤트 루프는 끝나지 않으므로 런타임도 앱과 함께 산다.
    let runtime = tokio::runtime::Runtime::new().context("could not start async runtime")?;
    let router = server::build_router(server::app_state(), None);

    // 앱 창은 시스템 webview(Windows는 WebView2, Linux는 WebKitGTK)에 기대고 있다.
    // 그게 없으면 창을 못 만드는데, 그때만 예전 방식(로컬 서버 + 기본 브라우저)으로 연다.
    if let Err(err) = open_app_window(router, runtime.handle().clone()) {
        eprintln!("could not open the app window: {err:#}");
        eprintln!("falling back to a local server in the default browser");
        return runtime.block_on(serve_app(None, true)).context(
            "앱 창을 열지 못했습니다. Windows라면 Microsoft Edge WebView2 런타임 설치가 \
필요할 수 있습니다.",
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum UserEvent {
    OpenConsole,
}

/// 창에 붙일 아이콘.
///
/// PNG 해독기를 들이지 않으려고 생 RGBA 로 담아둔다(`scripts/make-logo.py` 가 만든다).
/// 64×64 × 4바이트 = 16KB 라 실행 파일에 담아도 부담이 없다.
fn window_icon() -> Option<tao::window::Icon> {
    const ICON: &[u8] = include_bytes!("../assets/icon-64.rgba");
    tao::window::Icon::from_rgba(ICON.to_vec(), 64, 64).ok()
}

/// webview 의 요청을 라우터로 넘긴다. TCP 를 거치지 않는 것만 다르고 처리는 서버와 같다.
async fn dispatch(
    router: Router,
    request: HttpRequest<Vec<u8>>,
) -> HttpResponse<Cow<'static, [u8]>> {
    use tower::ServiceExt;

    let (parts, body) = request.into_parts();
    let request = HttpRequest::from_parts(parts, axum::body::Body::from(body));
    let response = match router.oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let (parts, body) = response.into_parts();
    match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => HttpResponse::from_parts(parts, Cow::Owned(bytes.to_vec())),
        Err(err) => {
            eprintln!("could not read response body: {err}");
            HttpResponse::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Cow::Borrowed(&[][..]))
                .expect("static error response")
        }
    }
}

/// 커스텀 프로토콜 처리기. 창마다 하나씩 등록해야 해서 따로 만들어 쓴다.
fn ui_protocol(
    router: Router,
    handle: tokio::runtime::Handle,
) -> impl Fn(&str, HttpRequest<Vec<u8>>, RequestAsyncResponder) + 'static {
    move |_id, request, responder| {
        let router = router.clone();
        handle.spawn(async move {
            responder.respond(dispatch(router, request).await);
        });
    }
}

fn open_app_window(router: Router, handle: tokio::runtime::Handle) -> Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("yt-download")
        .with_window_icon(window_icon())
        .with_inner_size(LogicalSize::new(1440.0, 920.0))
        .with_min_inner_size(LogicalSize::new(1040.0, 720.0))
        .build(&event_loop)
        .context("could not create app window")?;
    let main_window_id = window.id();

    let builder = WebViewBuilder::new()
        .with_url(format!("{UI_ORIGIN}/"))
        .with_asynchronous_custom_protocol(
            UI_SCHEME.to_string(),
            ui_protocol(router.clone(), handle.clone()),
        )
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

    let mut console: Option<(Window, WebView)> = None;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(UserEvent::OpenConsole) => {
                if let Some((window, _)) = &console {
                    window.set_focus();
                    return;
                }
                match open_console_window(target, router.clone(), handle.clone()) {
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
    router: Router,
    handle: tokio::runtime::Handle,
) -> Result<(Window, WebView)> {
    let window = WindowBuilder::new()
        .with_title("yt-download 콘솔")
        .with_window_icon(window_icon())
        .with_inner_size(LogicalSize::new(820.0, 560.0))
        .with_min_inner_size(LogicalSize::new(420.0, 260.0))
        .build(target)
        .context("could not create console window")?;
    let webview = build_webview(
        WebViewBuilder::new()
            .with_url(format!("{UI_ORIGIN}/console"))
            // 프로토콜은 창마다 따로 등록된다. 콘솔 창에도 같은 처리기를 단다.
            .with_asynchronous_custom_protocol(UI_SCHEME.to_string(), ui_protocol(router, handle)),
        &window,
    )?;
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
