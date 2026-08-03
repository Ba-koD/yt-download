//! 로컬 HTTP 서버: 라우팅, 요청/응답 타입, 화면 파일 제공.

use std::sync::mpsc;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
};

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::download::{
    default_output_dir, normalize_output_dir, run_download, validate_range, DownloadRequest,
};
use crate::jobs::{push_log, update_job, JobState, JobStatus};
use crate::login::{
    close_browser_processes, detect_default_browser, export_login_cookies, open_url_for_login,
    selected_browser, start_app_login_browser, LoginSession, YOUTUBE_LOGIN_URL,
};
use crate::tools::{
    add_cookie_args, add_ffmpeg_location, add_js_runtime, resolve_tool, tool_version,
    yt_dlp_command, ToolStatus,
};
use crate::youtube::{
    available_max_height, discover_owned_channel_id, library_item, library_kind,
    library_response_is_empty, live_edge_seconds, load_channel_library, metadata_duration,
    validate_url, value_str, yt_dlp_error, LibraryItem, LibraryKind, LIBRARY_PAGE_SIZE,
};

pub(crate) const INDEX_HTML: &str = include_str!("../web/index.html");

pub(crate) const CONSOLE_HTML: &str = include_str!("../web/console.html");

pub(crate) const APP_CSS: &str = include_str!("../web/app.css");

/// 화면 스크립트. ES 모듈로 나뉘어 있어서 이름으로 찾아 내보낸다.
const APP_SCRIPTS: &[(&str, &str)] = &[
    ("api.js", include_str!("../web/api.js")),
    ("app.js", include_str!("../web/app.js")),
    ("format.js", include_str!("../web/format.js")),
    ("jobs.js", include_str!("../web/jobs.js")),
    ("library.js", include_str!("../web/library.js")),
    ("login.js", include_str!("../web/login.js")),
    ("player.js", include_str!("../web/player.js")),
    ("settings.js", include_str!("../web/settings.js")),
    ("state.js", include_str!("../web/state.js")),
    ("timeline.js", include_str!("../web/timeline.js")),
    ("ui.js", include_str!("../web/ui.js")),
    ("update.js", include_str!("../web/update.js")),
    ("video.js", include_str!("../web/video.js")),
];

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) jobs: Arc<Mutex<HashMap<String, JobStatus>>>,
    // 콘솔 창이 어떤 작업을 보여줘야 하는지 알기 위해 마지막 작업을 기억한다.
    pub(crate) latest_job: Arc<Mutex<Option<String>>>,
    pub(crate) login_sessions: Arc<Mutex<HashMap<String, LoginSession>>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MetadataRequest {
    pub(crate) url: String,
    pub(crate) cookies_browser: Option<String>,
    pub(crate) cookies_profile: Option<String>,
    pub(crate) cookies_file: Option<String>,
    pub(crate) yt_dlp_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LibraryRequest {
    pub(crate) cookies_browser: Option<String>,
    pub(crate) cookies_profile: Option<String>,
    pub(crate) cookies_file: Option<String>,
    pub(crate) yt_dlp_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MetadataResponse {
    pub(crate) id: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) uploader: Option<String>,
    pub(crate) duration: Option<f64>,
    pub(crate) thumbnail: Option<String>,
    pub(crate) webpage_url: Option<String>,
    pub(crate) live_status: Option<String>,
    pub(crate) is_live: bool,
    pub(crate) was_live: bool,
    pub(crate) width: Option<f64>,
    pub(crate) height: Option<f64>,
    // 라이브에서 "방송 시작 = 00:00:00"을 잡기 위한 기준 시각(유닉스 초).
    pub(crate) release_timestamp: Option<f64>,
    pub(crate) max_height: Option<f64>,
    // 진행 중인 라이브에서 실제로 받을 수 있는 가장 최신 지점(초).
    // 유튜브가 조각을 내주기까지 몇 분 걸려서 "지금"보다 뒤처져 있다.
    pub(crate) live_edge: Option<f64>,
    // 화면에 보여줄 기본 정보.
    pub(crate) channel: Option<String>,
    pub(crate) upload_timestamp: Option<f64>,
    pub(crate) view_count: Option<f64>,
    pub(crate) like_count: Option<f64>,
    pub(crate) fps: Option<f64>,
    /// public / unlisted / private / needs_auth 등. 비공개 영상인지 알려준다.
    pub(crate) availability: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct StartJobResponse {
    pub(crate) job_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct LibraryResponse {
    pub(crate) videos: Vec<LibraryItem>,
    pub(crate) shorts: Vec<LibraryItem>,
    pub(crate) lives: Vec<LibraryItem>,
}

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    pub(crate) version: &'static str,
    pub(crate) yt_dlp: ToolStatus,
    pub(crate) ffmpeg: ToolStatus,
    pub(crate) default_output_dir: String,
    /// 이 컴퓨터의 기본 브라우저. 브라우저 칸을 처음 채울 때 쓴다.
    pub(crate) default_browser: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenLoginRequest {
    pub(crate) cookies_browser: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppLoginRequest {
    pub(crate) cookies_browser: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExportLoginRequest {
    pub(crate) cookies_browser: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CloseBrowserRequest {
    pub(crate) cookies_browser: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct OpenLoginResponse {
    pub(crate) browser: String,
    pub(crate) url: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AppLoginResponse {
    pub(crate) browser: String,
    pub(crate) port: u16,
    pub(crate) profile_dir: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ExportLoginResponse {
    pub(crate) browser: String,
    pub(crate) cookies_file: String,
    pub(crate) cookie_count: usize,
    pub(crate) youtube_cookie_count: usize,
    pub(crate) auth_cookie_count: usize,
    pub(crate) youtube_session_cookie_count: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct CloseBrowserResponse {
    pub(crate) browser: String,
    pub(crate) message: String,
}

pub(crate) async fn serve_app(
    started: Option<mpsc::Sender<Result<String, String>>>,
    open_browser: bool,
) -> Result<()> {
    let state = AppState {
        jobs: Arc::new(Mutex::new(HashMap::new())),
        latest_job: Arc::new(Mutex::new(None)),
        login_sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/console", get(console_page))
        .route("/api/jobs/latest", get(latest_job))
        .route("/web/:file", get(static_file))
        .route("/api/health", get(health))
        .route("/api/open-login", post(open_login))
        .route("/api/app-login", post(app_login))
        .route("/api/export-login", post(export_login))
        .route("/api/close-browser", post(close_browser))
        .route("/api/library", post(library))
        .route("/api/metadata", post(metadata))
        .route("/api/download", post(start_download))
        .route("/api/jobs/:id", get(job_status))
        .route("/api/jobs/:id/cancel", post(cancel_job))
        .route("/api/update/check", post(update_check))
        .route("/api/update/apply", post(update_apply))
        .route("/api/update/restart", post(update_restart))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = bind_listener().await.inspect_err(|err| {
        if let Some(started) = &started {
            let _ = started.send(Err(err.to_string()));
        }
    })?;
    let addr = listener.local_addr()?;
    let url = format!("http://{addr}");

    println!("yt-download is running at {url}");
    if let Some(started) = started {
        let _ = started.send(Ok(url.clone()));
    }
    if open_browser {
        if let Err(err) = webbrowser::open(&url) {
            eprintln!("Could not open browser automatically: {err}");
        }
    }

    axum::serve(listener, app).await?;
    Ok(())
}

pub(crate) async fn bind_listener() -> Result<TcpListener> {
    let bind_addr =
        std::env::var("YT_DOWNLOAD_ADDR").unwrap_or_else(|_| "127.0.0.1:8765".to_string());
    // 업데이트로 다시 켜진 직후에는 방금 나간 프로세스가 아직 포트를 쥐고 있다.
    // 그때만 몇 번 더 두드려 본다. 평소에는 한 번 보고 바로 다른 포트로 넘어간다.
    let mut attempts = if crate::update::restarted() { 20 } else { 1 };
    loop {
        match TcpListener::bind(&bind_addr).await {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                attempts -= 1;
                if attempts > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    continue;
                }
                if bind_addr == "127.0.0.1:8765" {
                    eprintln!(
                        "Could not bind {bind_addr}: {err}. Falling back to an available port."
                    );
                    return Ok(TcpListener::bind("127.0.0.1:0").await?);
                }
                return Err(err.into());
            }
        }
    }
}

pub(crate) async fn index() -> HtmlResponse {
    HtmlResponse(INDEX_HTML, "text/html; charset=utf-8")
}

pub(crate) async fn console_page() -> HtmlResponse {
    HtmlResponse(CONSOLE_HTML, "text/html; charset=utf-8")
}

// 콘솔 창은 어떤 작업이 도는지 모르므로 가장 최근 작업을 보여준다.
pub(crate) async fn latest_job(State(state): State<AppState>) -> Json<Value> {
    let id = state.latest_job.lock().await.clone();
    let job = match id {
        Some(id) => state.jobs.lock().await.get(&id).cloned(),
        None => None,
    };
    Json(json!({ "job": job }))
}

pub(crate) async fn static_file(AxumPath(file): AxumPath<String>) -> impl IntoResponse {
    if file == "app.css" {
        return HtmlResponse(APP_CSS, "text/css; charset=utf-8").into_response();
    }
    match APP_SCRIPTS.iter().find(|(name, _)| *name == file) {
        Some((_, body)) => {
            HtmlResponse(body, "application/javascript; charset=utf-8").into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn health() -> Json<HealthResponse> {
    let yt_dlp = tool_version(resolve_tool(None, "yt-dlp"), &["--version"]).await;
    let ffmpeg = tool_version(resolve_tool(None, "ffmpeg"), &["-version"]).await;
    Json(HealthResponse {
        version: env!("CARGO_PKG_VERSION"),
        yt_dlp,
        ffmpeg,
        default_output_dir: default_output_dir().to_string_lossy().to_string(),
        default_browser: detect_default_browser(),
    })
}

/// 새 버전이 있는지 본다.
pub(crate) async fn update_check() -> Result<Json<crate::update::UpdateStatus>, AppError> {
    Ok(Json(crate::update::check().await?))
}

/// 받아서 바꿔 끼운다. 여기서 성공해도 지금 프로세스는 옛 코드로 계속 돈다.
pub(crate) async fn update_apply() -> Result<Json<crate::update::UpdateStatus>, AppError> {
    Ok(Json(crate::update::apply().await?))
}

/// 새 실행 파일로 다시 켠다. 답을 보낸 뒤에 나가야 화면이 이유를 알 수 있다.
pub(crate) async fn update_restart() -> Result<Json<Value>, AppError> {
    crate::update::restart()?;
    tokio::spawn(async {
        // 답이 나갈 틈만 준다. 오래 잡고 있으면 새로 뜬 쪽이 포트를 못 잡는다.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::process::exit(0);
    });
    Ok(Json(json!({ "restarting": true })))
}

pub(crate) async fn open_login(
    Json(req): Json<OpenLoginRequest>,
) -> Result<Json<OpenLoginResponse>, AppError> {
    let browser = req
        .cookies_browser
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        .unwrap_or("default")
        .to_ascii_lowercase();
    let url = YOUTUBE_LOGIN_URL;

    open_url_for_login(&browser, url)?;

    Ok(Json(OpenLoginResponse {
        browser,
        url: url.to_string(),
    }))
}

pub(crate) async fn app_login(
    State(state): State<AppState>,
    Json(req): Json<AppLoginRequest>,
) -> Result<Json<AppLoginResponse>, AppError> {
    let browser = selected_browser(req.cookies_browser.as_deref())?;
    let session = start_app_login_browser(&browser).await?;

    state
        .login_sessions
        .lock()
        .await
        .insert(browser.clone(), session.clone());

    Ok(Json(AppLoginResponse {
        browser,
        port: session.port,
        profile_dir: session.profile_dir.to_string_lossy().to_string(),
    }))
}

pub(crate) async fn export_login(
    State(state): State<AppState>,
    Json(req): Json<ExportLoginRequest>,
) -> Result<Json<ExportLoginResponse>, AppError> {
    let browser = selected_browser(req.cookies_browser.as_deref())?;

    // 창을 아직 안 열었으면 여기서 연다. 이미 떠 있으면 그 창에 다시 붙으므로,
    // 앱을 껐다 켠 뒤에도 "로그인 적용"만 눌러서 쿠키를 새로 받을 수 있다.
    let existing = state.login_sessions.lock().await.get(&browser).cloned();
    let session = match existing {
        Some(session) => session,
        None => {
            let session = start_app_login_browser(&browser).await?;
            state
                .login_sessions
                .lock()
                .await
                .insert(browser.clone(), session.clone());
            session
        }
    };

    let result = export_login_cookies(&session).await?;

    Ok(Json(ExportLoginResponse {
        browser,
        cookies_file: result.path.to_string_lossy().to_string(),
        cookie_count: result.cookie_count,
        youtube_cookie_count: result.youtube_cookie_count,
        auth_cookie_count: result.auth_cookie_count,
        youtube_session_cookie_count: result.youtube_session_cookie_count,
    }))
}

pub(crate) async fn close_browser(
    Json(req): Json<CloseBrowserRequest>,
) -> Result<Json<CloseBrowserResponse>, AppError> {
    let browser = req
        .cookies_browser
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        .ok_or_else(|| anyhow!("종료할 브라우저를 먼저 선택하세요"))?
        .to_ascii_lowercase();

    close_browser_processes(&browser)?;

    Ok(Json(CloseBrowserResponse {
        message: format!("{browser} browser was closed"),
        browser,
    }))
}

pub(crate) async fn library(
    Json(req): Json<LibraryRequest>,
) -> Result<Json<LibraryResponse>, AppError> {
    let has_cookies_file = req
        .cookies_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let browser = req
        .cookies_browser
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"));
    if !has_cookies_file && browser.is_none() {
        return Err(anyhow!("로그인 브라우저 또는 쿠키 파일을 먼저 선택하세요").into());
    }

    let exe = resolve_tool(req.yt_dlp_path.as_deref(), "yt-dlp");
    if let Some(channel_id) = discover_owned_channel_id(req.cookies_file.as_deref()).await? {
        eprintln!("library: discovered channel id {channel_id}");
        let channel_response = load_channel_library(&exe, &req, browser, &channel_id).await?;
        eprintln!(
            "library: channel tabs loaded videos={} shorts={} lives={}",
            channel_response.videos.len(),
            channel_response.shorts.len(),
            channel_response.lives.len()
        );
        if !library_response_is_empty(&channel_response) {
            return Ok(Json(channel_response));
        }
    } else {
        eprintln!("library: could not find the signed-in channel id; falling back to /feed/you");
    }

    let mut cmd = yt_dlp_command(&exe);
    cmd.args([
        "--ignore-config",
        "--no-update",
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-end",
        LIBRARY_PAGE_SIZE,
        "--skip-download",
        "--no-warnings",
    ]);
    add_js_runtime(&mut cmd);
    add_cookie_args(
        &mut cmd,
        browser,
        req.cookies_profile.as_deref(),
        req.cookies_file.as_deref(),
    )?;
    cmd.arg("https://www.youtube.com/feed/you");

    let output = cmd
        .output()
        .await
        .context("yt-dlp library command failed to start")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(yt_dlp_error("내 영상 목록을 불러오지 못했습니다", &stderr).into());
    }

    let value: Value =
        serde_json::from_slice(&output.stdout).context("yt-dlp returned invalid library JSON")?;
    let mut response = LibraryResponse {
        videos: Vec::new(),
        shorts: Vec::new(),
        lives: Vec::new(),
    };

    for entry in value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(item) = library_item(entry) else {
            continue;
        };
        match library_kind(&item) {
            LibraryKind::Live => response.lives.push(item),
            LibraryKind::Short => response.shorts.push(item),
            LibraryKind::Video => response.videos.push(item),
        }
    }

    // 여기까지 왔는데 비어 있으면 내 채널을 알아내지 못한 것이다.
    // 쿠키 파일이 있는데도 그렇다면 대개 로그인이 만료된 경우다.
    // 유튜브는 `__Secure-1PSIDTS` 같은 쿠키를 수시로 갈아치우기 때문에 저장해둔 파일이 금방 낡는다.
    if library_response_is_empty(&response) {
        return Err(anyhow!(if has_cookies_file {
            "내 영상을 찾지 못했습니다. 저장된 로그인이 만료됐을 수 있습니다. \
             로그인·도구 칸에서 \"로그인 적용\"을 다시 눌러주세요."
        } else {
            "내 영상 목록을 가져오려면 로그인이 필요합니다. \
             로그인·도구 칸에서 \"로그인 적용\"을 눌러주세요."
        })
        .into());
    }

    Ok(Json(response))
}

pub(crate) async fn metadata(
    Json(req): Json<MetadataRequest>,
) -> Result<Json<MetadataResponse>, AppError> {
    validate_url(&req.url)?;

    let exe = resolve_tool(req.yt_dlp_path.as_deref(), "yt-dlp");
    let mut cmd = yt_dlp_command(&exe);
    cmd.args([
        "--ignore-config",
        "--no-update",
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--ignore-no-formats-error",
        "--no-warnings",
        // 진행 중인 라이브는 이 옵션이 있어야 고화질(4K 등) 조각 포맷이 목록에 나온다.
        // 일반 영상에는 아무 영향이 없다.
        "--live-from-start",
    ]);
    add_ffmpeg_location(&mut cmd);
    add_js_runtime(&mut cmd);
    add_cookie_args(
        &mut cmd,
        req.cookies_browser.as_deref(),
        req.cookies_profile.as_deref(),
        req.cookies_file.as_deref(),
    )?;
    cmd.arg(&req.url);

    let output = cmd
        .output()
        .await
        .context("yt-dlp metadata command failed to start")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(yt_dlp_error("metadata load failed", &stderr).into());
    }

    let value: Value =
        serde_json::from_slice(&output.stdout).context("yt-dlp returned invalid JSON")?;
    Ok(Json(MetadataResponse {
        id: value_str(&value, "id"),
        title: value_str(&value, "title"),
        uploader: value_str(&value, "uploader"),
        duration: metadata_duration(&value),
        thumbnail: value_str(&value, "thumbnail"),
        webpage_url: value_str(&value, "webpage_url"),
        live_status: value_str(&value, "live_status"),
        is_live: value
            .get("is_live")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        was_live: value
            .get("was_live")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        width: value.get("width").and_then(Value::as_f64),
        height: value.get("height").and_then(Value::as_f64),
        live_edge: live_edge_seconds(&value).await,
        channel: value_str(&value, "channel").or_else(|| value_str(&value, "uploader")),
        // 라이브는 release_timestamp 가 방송 시작이고, 일반 영상은 timestamp 가 업로드 시각이다.
        upload_timestamp: value
            .get("timestamp")
            .or_else(|| value.get("release_timestamp"))
            .and_then(Value::as_f64),
        view_count: value.get("view_count").and_then(Value::as_f64),
        like_count: value.get("like_count").and_then(Value::as_f64),
        fps: value.get("fps").and_then(Value::as_f64),
        availability: value_str(&value, "availability"),
        release_timestamp: value
            .get("release_timestamp")
            .or_else(|| value.get("timestamp"))
            .and_then(Value::as_f64),
        max_height: available_max_height(&value),
    }))
}

pub(crate) async fn start_download(
    State(state): State<AppState>,
    Json(req): Json<DownloadRequest>,
) -> Result<Json<StartJobResponse>, AppError> {
    validate_url(&req.url)?;
    validate_range(req.start_seconds, req.end_seconds)?;

    let output_dir = req
        .output_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_output_dir);
    let output_dir = normalize_output_dir(&output_dir)?;
    tokio::fs::create_dir_all(&output_dir)
        .await
        .with_context(|| format!("could not create output directory {}", output_dir.display()))?;

    let id = Uuid::new_v4().to_string();
    let status = JobStatus {
        id: id.clone(),
        state: JobState::Running,
        message: "다운로드 준비 중".to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        output_path: None,
        progress: Some(0.0),
        speed: None,
        eta: None,
        log: Vec::new(),
        cancel: Arc::new(AtomicBool::new(false)),
    };

    let cancel = status.cancel.clone();
    state.jobs.lock().await.insert(id.clone(), status);
    *state.latest_job.lock().await = Some(id.clone());

    let jobs = state.jobs.clone();
    let job_id = id.clone();
    tokio::spawn(async move {
        let result = run_download(
            job_id.clone(),
            req,
            output_dir,
            jobs.clone(),
            cancel.clone(),
        )
        .await;
        if let Err(err) = result {
            let cancelled = cancel.load(Ordering::SeqCst);
            update_job(&jobs, &job_id, |job| {
                job.state = JobState::Failed;
                job.message = if cancelled {
                    format!("중지했습니다: {err}")
                } else {
                    err.to_string()
                };
                job.speed = None;
                job.eta = None;
                push_log(job, format!("ERROR: {err:#}"));
            })
            .await;
        }
    });

    Ok(Json(StartJobResponse { job_id: id }))
}

pub(crate) async fn cancel_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    {
        let jobs = state.jobs.lock().await;
        let job = jobs.get(&id).ok_or_else(|| anyhow!("job not found"))?;
        job.cancel.store(true, Ordering::SeqCst);
    }
    update_job(&state.jobs, &id, |job| {
        if matches!(job.state, JobState::Running) {
            job.message = "중지 요청됨. 지금까지 받은 부분을 정리하는 중".to_string();
            push_log(job, "cancel requested".to_string());
        }
    })
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn job_status(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<JobStatus>, AppError> {
    let jobs = state.jobs.lock().await;
    let status = jobs
        .get(&id)
        .cloned()
        .ok_or_else(|| anyhow!("job not found"))?;
    Ok(Json(status))
}

pub(crate) struct HtmlResponse(pub(crate) &'static str, pub(crate) &'static str);

impl IntoResponse for HtmlResponse {
    fn into_response(self) -> Response {
        let mut response = self.0.into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(self.1));
        // 앱을 재빌드하면 내장된 HTML/JS가 바뀌므로 웹뷰가 이전 버전을 캐시하면 안 된다.
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[derive(Debug)]
pub(crate) struct AppError(pub(crate) anyhow::Error);

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        AppError(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({
            "error": self.0.to_string(),
        });
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    }
}
