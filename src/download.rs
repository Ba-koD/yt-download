//! 영상 상태에 맞는 다운로드 방식 선택과 실행.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tokio::{process::Command, sync::Mutex};

use crate::jobs::{
    finish_download_job, job_log_contains, job_output_path, push_log, update_job, JobState,
    JobStatus,
};
use crate::live::{
    capture_covered_seconds, capture_output_path, live_capture_dir, probe_target, run_live_capture,
    TargetInfo,
};
use crate::media::{cut_media_section, cut_media_streams, format_time, probe_capture_stream};
use crate::progress::{
    forward_process_output, report_download_progress, DownloadProgress, ProcessOutput,
};
use crate::tools::{
    add_cookie_args, add_ffmpeg_location, add_js_runtime, app_temp_dir, resolve_tool,
    yt_dlp_command,
};

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DownloadRequest {
    pub(crate) url: String,
    pub(crate) start_seconds: Option<f64>,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) live_from_start: bool,
    pub(crate) cookies_browser: Option<String>,
    pub(crate) cookies_profile: Option<String>,
    pub(crate) cookies_file: Option<String>,
    pub(crate) output_dir: Option<String>,
    pub(crate) yt_dlp_path: Option<String>,
    pub(crate) format_mode: FormatMode,
    pub(crate) accurate_cut: bool,
    pub(crate) is_live: Option<bool>,
    // 화질 상한(세로 픽셀). 없거나 0이면 가장 높은 화질.
    pub(crate) max_height: Option<u32>,
}

impl DownloadRequest {
    pub(crate) fn max_height(&self) -> Option<u32> {
        self.max_height.filter(|height| *height >= 144)
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FormatMode {
    Mp4,
    Best,
}

pub(crate) async fn run_download(
    job_id: String,
    req: DownloadRequest,
    output_dir: PathBuf,
    jobs: Arc<Mutex<HashMap<String, JobStatus>>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let section = section_arg(req.start_seconds, req.end_seconds);
    let section_duration = download_section_duration(req.start_seconds, req.end_seconds);
    let live_hint = req.is_live.unwrap_or(false) || req.live_from_start;

    // 화면에서 넘어온 라이브 여부는 오래된 값일 수 있다. 어떤 방식으로 받을지는
    // 실제 live_status로 정해야 "진행 중 라이브에 구간 다운로드" 같은 잘못된 조합을 피할 수 있다.
    update_job(&jobs, &job_id, |job| {
        job.message = "영상 상태 확인 중".to_string();
    })
    .await;
    let info = match probe_target(&req, live_hint).await {
        Ok(info) => {
            update_job(&jobs, &job_id, |job| {
                push_log(job, format!("target: {}", info.summary()));
            })
            .await;
            info
        }
        Err(err) => {
            update_job(&jobs, &job_id, |job| {
                push_log(job, format!("could not read video state: {err}"));
            })
            .await;
            TargetInfo::default()
        }
    };

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("시작 전에 중지했습니다"));
    }

    let live_now = match info.live_status.as_deref() {
        Some("is_live") => true,
        Some(_) => false,
        None => req.is_live.unwrap_or(false),
    };

    // 진행 중인 라이브는 yt-dlp가 구간 다운로드를 지원하지 않는다.
    // (--live-from-start는 조각 생성기 프로토콜이라 ffmpeg 구간 다운로더를 쓸 수 없어
    //  "This format cannot be partially downloaded"로 즉시 실패한다.)
    // 그래서 처음부터 조각을 받다가 필요한 지점에서 멈추고 로컬에서 잘라낸다.
    if live_now && (section.is_some() || req.live_from_start) {
        let result = run_live_capture(&job_id, &req, &output_dir, &jobs, &info, &cancel).await;
        if result.is_err() {
            // 작업별 임시 폴더라 다른 작업이 이어받지 못한다. 실패/중지 시엔 지운다.
            let _ = tokio::fs::remove_dir_all(live_capture_dir(&job_id)).await;
        }
        return result;
    }

    // 라이브가 방금 끝난 영상(post_live)은 유튜브가 다시보기를 만드는 동안
    // 스트림 URL이 ffmpeg의 구간 요청을 거부한다. 시도해봐야 실패하므로 바로 전체 받고 잘라낸다.
    if section.is_some() && info.is_post_live() {
        update_job(&jobs, &job_id, |job| {
            push_log(
                job,
                "post_live: skipping ffmpeg sections, downloading full video first".to_string(),
            );
        })
        .await;
        return run_section_fallback(&job_id, &req, &output_dir, &jobs, &cancel).await;
    }

    let wants_live_from_start = req.live_from_start;

    // 구간(ffmpeg) 방식은 재시도해도 같은 이유로 실패하므로 1회만, 일반 다운로드는 이어받기 재시도.
    let initial_attempts = if section.is_some() { 1 } else { 3 };
    let mut outcome = run_attempt_with_retries(
        &job_id,
        &req,
        &output_dir,
        &jobs,
        wants_live_from_start,
        initial_attempts,
        &cancel,
        Some(&info),
    )
    .await?;

    // 종료된 라이브에 --live-from-start를 주면 yt-dlp가
    // "This live event has ended."로 실패하므로 일반 VOD로 한 번 더 시도한다.
    if !outcome.status.success()
        && !outcome.cancelled
        && wants_live_from_start
        && job_log_contains(&jobs, &job_id, "This live event has ended").await
    {
        update_job(&jobs, &job_id, |job| {
            job.message = "라이브가 종료된 영상입니다. 일반 영상으로 다시 시도합니다".to_string();
            job.progress = Some(0.0);
            push_log(
                job,
                "retrying without --live-from-start (live event has ended)".to_string(),
            );
        })
        .await;
        outcome = run_download_attempt(
            &job_id,
            &req,
            &output_dir,
            &jobs,
            false,
            &cancel,
            Some(&info),
        )
        .await?;
    }

    if outcome.cancelled {
        return finish_cancelled_download(&job_id, &req, &output_dir, &jobs, &info).await;
    }

    if outcome.status.success() {
        match finish_download_job(&jobs, &job_id, section_duration).await {
            Ok(()) => return Ok(()),
            Err(err) if section.is_some() => {
                // 구간이 잘린 채 저장됨 → 전체 다운로드 후 잘라내기로 재시도
                update_job(&jobs, &job_id, |job| {
                    push_log(job, format!("section result invalid: {err}"));
                })
                .await;
            }
            Err(err) => return Err(err),
        }
    } else if section.is_none() || !section_download_unsupported(&jobs, &job_id).await {
        return Err(
            download_failure_error(&jobs, &job_id, section.is_some(), outcome.status).await,
        );
    }

    // 라이브 종료 직후에는 스트림 URL이 ffmpeg의 구간 요청을 거부하므로,
    // 전체 영상을 일반 다운로더로 받은 뒤 로컬에서 구간을 잘라낸다.
    run_section_fallback(&job_id, &req, &output_dir, &jobs, &cancel).await
}

// 구간을 ffmpeg로 바로 받지 못한 상황인지(= 전체 받고 잘라내기로 넘어가야 하는지) 판단한다.
pub(crate) async fn section_download_unsupported(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
) -> bool {
    for needle in [
        "ffmpeg exited with code",
        "Error opening input",
        "cannot be partially downloaded",
        "Unable to download video data",
    ] {
        if job_log_contains(jobs, job_id, needle).await {
            return true;
        }
    }
    false
}

pub(crate) async fn run_section_fallback(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    update_job(jobs, job_id, |job| {
        job.message = "유튜브가 아직 다시보기를 처리 중이라 구간만 받을 수 없습니다. \
전체 영상을 받은 뒤 구간을 잘라냅니다 (시간이 걸립니다)"
            .to_string();
        job.progress = Some(0.0);
        job.output_path = None;
        push_log(
            job,
            "fallback: downloading full video, then cutting the section locally".to_string(),
        );
    })
    .await;

    let mut full_req = req.clone();
    full_req.start_seconds = None;
    full_req.end_seconds = None;
    full_req.live_from_start = false;
    full_req.is_live = Some(false);

    // 전체 영상은 임시 폴더에 받고, 잘라낸 구간 파일만 사용자 폴더에 넣는다.
    let temp_dir = app_temp_dir();
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .with_context(|| format!("could not create temp directory {}", temp_dir.display()))?;

    let outcome =
        run_attempt_with_retries(job_id, &full_req, &temp_dir, jobs, false, 4, cancel, None)
            .await?;
    if outcome.cancelled {
        return Err(anyhow!("전체 영상을 받는 중에 중지했습니다"));
    }
    if !outcome.status.success() {
        return Err(download_failure_error(jobs, job_id, false, outcome.status).await);
    }
    let full_path = job_output_path(jobs, job_id)
        .await
        .ok_or_else(|| anyhow!("전체 영상 파일 경로를 찾지 못했습니다"))?;

    let section_path =
        section_output_path(&full_path, output_dir, req.start_seconds, req.end_seconds)?;
    update_job(jobs, job_id, |job| {
        job.message = "구간을 잘라내는 중".to_string();
        job.progress = Some(99.0);
    })
    .await;

    cut_media_section(
        &full_path,
        &section_path,
        req.start_seconds,
        req.end_seconds,
    )
    .await?;

    update_job(jobs, job_id, |job| {
        job.output_path = Some(section_path.clone());
    })
    .await;

    let section_duration = download_section_duration(req.start_seconds, req.end_seconds);
    // 검증까지 통과한 뒤에만 전체 파일을 지운다. 실패 시 원본을 남겨야 재시도가 빠르다.
    finish_download_job(jobs, job_id, section_duration).await?;
    if let Err(err) = tokio::fs::remove_file(&full_path).await {
        update_job(jobs, job_id, |job| {
            push_log(job, format!("could not remove full video file: {err}"));
        })
        .await;
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct AttemptOutcome {
    pub(crate) status: std::process::ExitStatus,
    pub(crate) cancelled: bool,
}

// 중지된 일반 다운로드는 남은 조각을 살릴 수 있으면 살린다.
pub(crate) async fn finish_cancelled_download(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    info: &TargetInfo,
) -> Result<()> {
    let unfinished = || anyhow!("받던 부분은 임시 폴더에 남아 있어서 다시 누르면 이어받습니다");
    let Some(id) = info.id.clone() else {
        return Err(unfinished());
    };

    update_job(jobs, job_id, |job| {
        job.message = "중지했습니다. 지금까지 받은 부분을 확인하는 중".to_string();
    })
    .await;

    let temp_dir = app_temp_dir();
    let marker = format!("[{id}]");
    let mut candidates = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&temp_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(&marker) && name.ends_with(".part") {
                candidates.push(entry.path());
            }
        }
    }

    let mut streams = Vec::new();
    for path in candidates {
        if let Some(stream) = probe_capture_stream(path).await {
            if stream.duration.unwrap_or(0.0) > 1.0 {
                streams.push(stream);
            }
        }
    }
    if streams.is_empty() {
        return Err(unfinished());
    }
    streams.sort_by_key(|stream| !stream.has_video);

    let inputs: Vec<PathBuf> = streams.iter().map(|stream| stream.path.clone()).collect();
    let output_path = capture_output_path(output_dir, info, req, &streams, None, None);
    let covered = capture_covered_seconds(&streams);
    // 받다 만 파일은 컨테이너가 끝나지 않아 못 살릴 수 있다. 그때는 이어받기 안내만 한다.
    if let Err(err) = cut_media_streams(
        &inputs,
        &output_path,
        None,
        Some(covered).filter(|value| *value > 0.0),
        false,
    )
    .await
    {
        update_job(jobs, job_id, |job| {
            push_log(job, format!("could not salvage partial download: {err}"));
        })
        .await;
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(unfinished());
    }

    let saved = output_path.to_string_lossy().to_string();
    update_job(jobs, job_id, |job| {
        job.output_path = Some(saved.clone());
        job.state = JobState::Done;
        job.message = "중지한 지점까지 저장했습니다".to_string();
        job.progress = Some(100.0);
        job.speed = None;
        job.eta = None;
    })
    .await;
    Ok(())
}

pub(crate) fn section_output_path(
    full_path: &str,
    output_dir: &Path,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<String> {
    let path = Path::new(full_path);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("잘라낼 파일 이름을 만들지 못했습니다"))?;
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    let label = section_file_label(start, end);
    Ok(output_dir
        .join(format!("{stem}_{label}.{ext}"))
        .to_string_lossy()
        .to_string())
}

pub(crate) async fn download_failure_error(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    section_requested: bool,
    status: std::process::ExitStatus,
) -> anyhow::Error {
    // 라이브 종료 직후에는 유튜브가 다시보기를 처리하는 동안 스트림 URL이
    // 통짜 요청을 거부해 ffmpeg가 열지 못하고 죽는다. 사용자에게 상황을 설명한다.
    let ffmpeg_failed = job_log_contains(jobs, job_id, "ffmpeg exited with code").await
        || job_log_contains(jobs, job_id, "Error opening input").await;
    if section_requested && ffmpeg_failed {
        return anyhow!(
            "구간 다운로드 중 ffmpeg가 영상 스트림을 열지 못했습니다. \
방금 끝난 라이브라면 유튜브가 다시보기를 처리하는 동안(보통 수십 분~몇 시간) 구간 다운로드가 실패할 수 있습니다. \
시간이 지난 뒤 다시 시도해 보세요."
        );
    }
    if job_log_contains(jobs, job_id, "Video unavailable").await {
        return anyhow!(
            "유튜브가 이 영상에 접근을 허용하지 않았습니다. 라이브 종료 직후 처리 중이거나 \
비공개/멤버 전용 영상일 수 있습니다. 잠시 후 다시 시도하거나 로그인 상태를 확인하세요."
        );
    }
    anyhow!("yt-dlp exited with status {status}")
}

// 실패해도 .part/.ytdl 파일 덕분에 이어받기가 되므로, 중단 시 자동으로 몇 번 더 시도한다.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_attempt_with_retries(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    live_from_start: bool,
    max_attempts: u32,
    cancel: &Arc<AtomicBool>,
    info: Option<&TargetInfo>,
) -> Result<AttemptOutcome> {
    let mut outcome =
        run_download_attempt(job_id, req, output_dir, jobs, live_from_start, cancel, info).await?;
    let mut attempt = 1;
    while !outcome.status.success() && !outcome.cancelled && attempt < max_attempts {
        attempt += 1;
        update_job(jobs, job_id, |job| {
            job.message = format!(
                "다운로드가 중단되어 이어받기로 다시 시도합니다 ({attempt}/{max_attempts})"
            );
            push_log(job, format!("auto retry {attempt}/{max_attempts}"));
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        if cancel.load(Ordering::SeqCst) {
            outcome.cancelled = true;
            break;
        }
        outcome =
            run_download_attempt(job_id, req, output_dir, jobs, live_from_start, cancel, info)
                .await?;
    }
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_download_attempt(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    live_from_start: bool,
    cancel: &Arc<AtomicBool>,
    info: Option<&TargetInfo>,
) -> Result<AttemptOutcome> {
    let exe = resolve_tool(req.yt_dlp_path.as_deref(), "yt-dlp");
    let mut cmd = yt_dlp_command(&exe);

    cmd.args([
        "--ignore-config",
        "--no-update",
        "--no-playlist",
        "--newline",
        // --print 옵션이 quiet 모드를 켜서 진행률과 로그가 사라지므로 둘 다 강제로 켠다.
        "--progress",
        "--no-quiet",
        "--trim-filenames",
        "180",
        "-N",
        "16",
        // Windows에서 백신/인덱서가 .part 파일을 잠시 잠가 rename이 실패하는 일이 잦다.
        "--file-access-retries",
        "20",
        "--retry-sleep",
        "file_access:1",
    ]);
    add_ffmpeg_location(&mut cmd);
    add_js_runtime(&mut cmd);
    if cfg!(windows) {
        cmd.arg("--windows-filenames");
    }
    cmd.arg("--paths")
        .arg(format!("home:{}", output_dir.to_string_lossy()));
    let temp_dir = app_temp_dir();
    if fs::create_dir_all(&temp_dir).is_ok() {
        cmd.arg("--paths")
            .arg(format!("temp:{}", temp_dir.to_string_lossy()));
    }
    let section = section_arg(req.start_seconds, req.end_seconds);
    let section_duration = download_section_duration(req.start_seconds, req.end_seconds);
    let output_template = if section.is_some() {
        format!(
            "%(title).120B [%(id)s]_{}.%(ext)s",
            section_file_label(req.start_seconds, req.end_seconds)
        )
    } else {
        "%(title).120B [%(id)s].%(ext)s".to_string()
    };
    cmd.args(["-o", &output_template]);

    add_format_args(&mut cmd, req.format_mode, req.max_height());

    if live_from_start {
        cmd.arg("--live-from-start");
    } else {
        cmd.arg("--no-live-from-start");
    }

    if let Some(section) = section {
        cmd.args(["--download-sections", &section]);
        if req.accurate_cut {
            cmd.arg("--force-keyframes-at-cuts");
        }
    } else if info
        .map(|info| info.expected_bytes.is_some())
        .unwrap_or(false)
    {
        // 통짜 URL을 구간별 조각으로 바꿔서 -N 개수만큼 동시에 받는다(체감 2~3배).
        // 이 변환은 용량을 아는 포맷만 남기므로, 고른 포맷의 용량이 확인된 경우에만 쓴다.
        // (구간 다운로드는 ffmpeg 다운로더를 써야 해서 이 변환과 같이 쓸 수 없다.)
        cmd.args(["--extractor-args", "youtube:formats=dashy"]);
    }

    // 진행률은 사람이 읽는 줄 대신 정해진 형식으로 받아서 정확한 퍼센트를 계산한다.
    cmd.args([
        "--progress-template",
        "download:@P@%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s",
    ]);
    cmd.args([
        "--progress-template",
        "postprocess:@PP@%(progress.status)s|%(progress.postprocessor)s",
    ]);

    // 합치기(ffmpeg)는 진행률을 안 알려주므로 파일로 받아서 읽는다.
    let merge_progress = app_temp_dir().join(format!("merge-{job_id}.txt"));
    let _ = tokio::fs::remove_file(&merge_progress).await;
    // yt-dlp가 이 인자를 shlex로 쪼개면서 역슬래시를 먹어버리므로 슬래시 경로로 넘긴다.
    let merge_progress_arg = merge_progress.to_string_lossy().replace('\\', "/");
    for pp in ["Merger", "VideoRemuxer", "VideoConvertor"] {
        cmd.arg("--ppa")
            .arg(format!("{pp}:-progress {merge_progress_arg}"));
    }

    add_cookie_args(
        &mut cmd,
        req.cookies_browser.as_deref(),
        req.cookies_profile.as_deref(),
        req.cookies_file.as_deref(),
    )?;
    cmd.args(["--print", "after_move:filepath"]);
    cmd.arg(&req.url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let progress = Arc::new(DownloadProgress::new(
        info.and_then(|info| info.expected_bytes),
        info.map(|info| info.stream_count).unwrap_or(0),
        section_duration.or_else(|| info.and_then(|info| info.duration)),
        &merge_progress,
    ));
    update_job(jobs, job_id, |job| {
        job.message = "다운로드 시작".to_string();
        job.progress = Some(0.0);
    })
    .await;

    let mut child = cmd
        .spawn()
        .context("yt-dlp download command failed to start")?;
    let stdout = child
        .stdout
        .take()
        .context("could not capture yt-dlp stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("could not capture yt-dlp stderr")?;

    let stdout_task = tokio::spawn(forward_process_output(
        stdout,
        jobs.clone(),
        job_id.to_string(),
        ProcessOutput::Stdout,
        section_duration,
        None,
        Some(progress.clone()),
    ));
    let stderr_task = tokio::spawn(forward_process_output(
        stderr,
        jobs.clone(),
        job_id.to_string(),
        ProcessOutput::Stderr,
        section_duration,
        None,
        Some(progress.clone()),
    ));

    let mut cancelled = false;
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.context("yt-dlp wait failed")?,
            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                if !cancelled && cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    stop_child_process(&mut child).await;
                }
                report_download_progress(jobs, job_id, &progress).await;
            }
        }
    };
    join_output_task(stdout_task).await;
    join_output_task(stderr_task).await;
    let _ = tokio::fs::remove_file(&merge_progress).await;

    Ok(AttemptOutcome { status, cancelled })
}

// 패키징된 yt-dlp.exe는 실제 작업을 자식 프로세스에서 한다.
// 부모만 죽이면 자식이 계속 받으면서 파이프도 잡고 있어서 프로세스 트리째 정리해야 한다.
pub(crate) async fn stop_child_process(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = Command::new("taskkill");
        crate::proc::hide(&mut cmd);
        let _ = cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.start_kill();
}

// 프로세스가 죽어도 파이프가 늦게 닫히는 경우가 있어서 무한정 기다리지 않는다.
pub(crate) async fn join_output_task(task: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .is_err()
    {
        // 출력 수집이 끝나지 않아도 다운로드 결과에는 영향이 없다.
    }
}

// 화질 상한(max_height)이 없으면 4K/8K를 포함해 가장 높은 해상도를 고른다.
pub(crate) fn add_format_args(cmd: &mut Command, mode: FormatMode, max_height: Option<u32>) {
    let cap = max_height
        .map(|height| format!("[height<={height}]"))
        .unwrap_or_default();
    match mode {
        FormatMode::Mp4 => {
            cmd.arg("-f")
                .arg(format!("bv*{cap}+ba[ext=m4a]/bv*{cap}+ba/b{cap}/bv*+ba/b"));
            // 해상도를 먼저 맞추고, 같은 해상도면 재생 호환성이 좋은 H.264를 고른다.
            // (4K는 H.264가 없어서 VP9/AV1이 선택된다.)
            cmd.args(["-S", "res,vcodec:h264,acodec:aac"]);
            cmd.args(["--merge-output-format", "mp4", "--remux-video", "mp4"]);
        }
        FormatMode::Best => {
            cmd.arg("-f").arg(format!("bv*{cap}+ba/b{cap}/bv*+ba/b"));
            cmd.args(["-S", "res"]);
        }
    }
}

pub(crate) fn default_output_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::video_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("yt-download")
}

pub(crate) fn normalize_output_dir(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(anyhow!("output directory is empty"));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

pub(crate) fn validate_range(start: Option<f64>, end: Option<f64>) -> Result<()> {
    if let Some(value) = start {
        if value < 0.0 || !value.is_finite() {
            return Err(anyhow!("start time must be a positive number"));
        }
    }
    if let Some(value) = end {
        if value <= 0.0 || !value.is_finite() {
            return Err(anyhow!("end time must be a positive number"));
        }
    }
    if let (Some(start), Some(end)) = (start, end) {
        if end <= start {
            return Err(anyhow!("end time must be greater than start time"));
        }
    }
    Ok(())
}

pub(crate) fn section_arg(start: Option<f64>, end: Option<f64>) -> Option<String> {
    match (start, end) {
        (Some(start), Some(end)) => Some(format!("*{}-{}", format_time(start), format_time(end))),
        (Some(start), None) => Some(format!("*{}-inf", format_time(start))),
        (None, Some(end)) => Some(format!("*0-{}", format_time(end))),
        (None, None) => None,
    }
}

// 파일명에 넣는 구간 표기. 콜론은 Windows 파일명에 못 쓰므로 02.09.03-02.22.11 형태로 만든다.
pub(crate) fn section_file_label(start: Option<f64>, end: Option<f64>) -> String {
    let start_label = format_time(start.unwrap_or(0.0)).replace(':', ".");
    let end_label = match end {
        Some(end) => format_time(end).replace(':', "."),
        None => "end".to_string(),
    };
    format!("{start_label}-{end_label}")
}

pub(crate) fn download_section_duration(start: Option<f64>, end: Option<f64>) -> Option<f64> {
    match (start, end) {
        (Some(start), Some(end)) if end > start => Some(end - start),
        (None, Some(end)) if end > 0.0 => Some(end),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_section_file_label() {
        assert_eq!(
            section_file_label(Some(7743.0), Some(8531.0)),
            "02.09.03-02.22.11"
        );
        assert_eq!(section_file_label(None, Some(60.0)), "00.00.00-00.01.00");
        assert_eq!(section_file_label(Some(30.0), None), "00.00.30-end");
    }

    #[test]
    fn builds_download_section_arguments() {
        assert_eq!(
            section_arg(Some(10.0), Some(20.5)),
            Some("*00:00:10-00:00:20.500".to_string())
        );
        assert_eq!(
            section_arg(Some(90.0), None),
            Some("*00:01:30-inf".to_string())
        );
        assert_eq!(
            section_arg(None, Some(5.0)),
            Some("*0-00:00:05".to_string())
        );
        assert_eq!(section_arg(None, None), None);
        assert_eq!(
            download_section_duration(Some(10.0), Some(20.5)),
            Some(10.5)
        );
        assert_eq!(download_section_duration(None, Some(5.0)), Some(5.0));
        assert_eq!(download_section_duration(Some(90.0), None), None);
    }

    #[test]
    fn rejects_invalid_ranges() {
        assert!(validate_range(Some(2.0), Some(1.0)).is_err());
        assert!(validate_range(Some(-1.0), Some(1.0)).is_err());
        assert!(validate_range(Some(1.0), Some(2.0)).is_ok());
    }
}
