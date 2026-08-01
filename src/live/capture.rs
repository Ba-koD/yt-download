//! 조각을 바로 못 받을 때: 방송 처음부터 받다가 필요한 지점에서 멈춘다.

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
use tokio::sync::Mutex;

use super::fetch::{live_capture_dir, run_live_section_fetch};
use super::source::TargetInfo;
use crate::download::{
    add_format_args, download_section_duration, join_output_task, section_file_label,
    stop_child_process, AttemptOutcome, DownloadRequest, FormatMode,
};
use crate::jobs::{finish_download_job, push_log, update_job, JobStatus};
use crate::media::{cut_media_streams, format_time, probe_capture_stream};
use crate::progress::{forward_process_output, ProcessOutput};
use crate::tools::{
    add_cookie_args, add_ffmpeg_location, add_js_runtime, resolve_tool, yt_dlp_command,
};

// 동시에 받는 조각 수(-N)만큼은 중단 시점에 덜 써졌을 수 있어서 계산에서 빼둔다.
pub(crate) const CAPTURE_TAIL_FRAGMENTS: u64 = 12;

// 라이브 조각 동시 다운로드 수. 오래된 방송을 따라잡는 속도를 좌우한다.
pub(crate) const CAPTURE_CONCURRENCY: &str = "8";

// 유튜브가 라이브 조각을 보관하는 최대 길이(120시간).
pub(crate) const LIVE_FRAGMENT_WINDOW: f64 = 432_000.0;

pub(crate) fn live_capture_origin(duration: Option<f64>) -> f64 {
    duration
        .map(|duration| (duration - LIVE_FRAGMENT_WINDOW).max(0.0))
        .unwrap_or(0.0)
}

// 라이브 조각 다운로드가 어디까지 왔는지 추적한다. 영상/음성 스트림이 각각 따로 받아지므로
// 둘 중 느린 쪽을 기준으로 삼아야 구간이 비지 않는다.
#[derive(Debug)]
pub(crate) struct CaptureCtx {
    pub(crate) fragment_seconds: f64,
    pub(crate) frags: std::sync::Mutex<HashMap<String, u64>>,
}

impl CaptureCtx {
    pub(crate) fn new(fragment_seconds: f64) -> Self {
        Self {
            fragment_seconds,
            frags: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn note_line(&self, line: &str) {
        let Some(index) = parse_fragment_index(line) else {
            return;
        };
        let key = progress_stream_key(line);
        let mut frags = self.frags.lock().unwrap_or_else(|err| err.into_inner());
        let entry = frags.entry(key).or_insert(0);
        if index > *entry {
            *entry = index;
        }
    }

    pub(crate) fn safe_seconds(&self) -> f64 {
        let frags = self.frags.lock().unwrap_or_else(|err| err.into_inner());
        match frags.values().copied().min() {
            Some(min) => min.saturating_sub(CAPTURE_TAIL_FRAGMENTS) as f64 * self.fragment_seconds,
            None => 0.0,
        }
    }
}

// "[download] 12.3MiB at 1.0MiB/s (frag 138)" 같은 줄에서 조각 번호를 읽는다.
pub(crate) fn parse_fragment_index(line: &str) -> Option<u64> {
    let position = line.find("(frag ")?;
    let rest = &line[position + "(frag ".len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

// 여러 스트림을 동시에 받으면 yt-dlp가 "1: ", "2: " 접두사를 붙인다.
pub(crate) fn progress_stream_key(line: &str) -> String {
    let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() && line[digits.len()..].starts_with(':') {
        return digits;
    }
    String::new()
}

#[derive(Debug)]
pub(crate) struct CaptureStream {
    pub(crate) path: PathBuf,
    pub(crate) duration: Option<f64>,
    pub(crate) has_video: bool,
    pub(crate) has_audio: bool,
}

pub(crate) async fn run_live_capture(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    info: &TargetInfo,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    // 시간 기준은 항상 "방송 시작 = 00:00:00"이다. 다만 유튜브는 라이브 조각을
    // 최대 120시간까지만 들고 있어서, 그보다 오래된 방송은 받을 수 있는 첫 조각이
    // 방송 시작이 아니다. 그만큼 기준점을 옮겨야 요청한 시각과 결과가 맞는다.
    let origin = live_capture_origin(info.duration);
    let start = req.start_seconds.map(|value| (value - origin).max(0.0));
    let end = req.end_seconds.map(|value| value - origin);
    if let Some(end) = end {
        if end <= 0.0 {
            return Err(anyhow!(
                "요청한 구간이 유튜브에 남아 있지 않습니다. 진행 중인 라이브는 최근 {}까지만 받을 수 있습니다.",
                format_time(LIVE_FRAGMENT_WINDOW)
            ));
        }
    }

    let capture_dir = live_capture_dir(job_id);
    tokio::fs::create_dir_all(&capture_dir)
        .await
        .with_context(|| {
            format!(
                "could not create capture directory {}",
                capture_dir.display()
            )
        })?;

    // 구간이 정해져 있으면 그 구간 조각만 골라 받는다(방송 처음부터 받을 필요가 없다).
    if let (Some(section_start), Some(section_end)) = (req.start_seconds, req.end_seconds) {
        if !info.live_sources.is_empty() {
            match run_live_section_fetch(
                job_id,
                req,
                output_dir,
                jobs,
                info,
                cancel,
                &capture_dir,
                section_start,
                section_end,
            )
            .await
            {
                Ok(()) => return Ok(()),
                Err(err) if cancel.load(Ordering::SeqCst) => return Err(err),
                Err(err) => {
                    update_job(jobs, job_id, |job| {
                        job.message =
                            "구간 조각을 바로 받지 못해 방송 처음부터 받는 방식으로 넘어갑니다"
                                .to_string();
                        push_log(job, format!("direct live section fetch failed: {err}"));
                    })
                    .await;
                }
            }
        }
    }

    update_job(jobs, job_id, |job| {
        job.progress = Some(0.0);
        job.message = match req.end_seconds {
            Some(end) => format!(
                "진행 중인 라이브라 방송 시작부터 {}까지 받은 뒤 구간을 잘라냅니다",
                format_time(end)
            ),
            None => {
                "라이브 녹화 중입니다. 중지를 누르면 지금까지 받은 부분을 저장합니다".to_string()
            }
        };
        push_log(
            job,
            format!(
                "live capture: fragments={}s origin={} target={}",
                info.frag_seconds(),
                format_time(origin),
                end.map(format_time)
                    .unwrap_or_else(|| "live end".to_string())
            ),
        );
    })
    .await;

    let ctx = Arc::new(CaptureCtx::new(info.frag_seconds()));
    // 동시에 받던 조각은 잘려 있을 수 있어서 꼬리를 버린다. 그만큼 더 받아둬야 구간이 안 빈다.
    let stop_at = end.map(|end| end + (CAPTURE_TAIL_FRAGMENTS as f64 + 2.0) * info.frag_seconds());

    let mut attempt = 0;
    let streams = loop {
        attempt += 1;
        let outcome =
            run_capture_attempt(job_id, req, &capture_dir, jobs, &ctx, stop_at, end, cancel)
                .await?;

        update_job(jobs, job_id, |job| {
            job.message = "받은 조각을 이어붙이는 중".to_string();
            job.speed = None;
            job.eta = None;
        })
        .await;
        let streams = assemble_capture_streams(&capture_dir).await?;
        let covered = capture_covered_seconds(&streams);
        update_job(jobs, job_id, |job| {
            push_log(
                job,
                format!(
                    "capture attempt {attempt}: video={} audio={} covered={} cancelled={}",
                    streams.iter().filter(|stream| stream.has_video).count(),
                    streams.iter().filter(|stream| stream.has_audio).count(),
                    format_time(covered),
                    outcome.cancelled
                ),
            );
        })
        .await;

        if outcome.cancelled {
            break streams;
        }

        let enough = match end {
            Some(end) => covered + 1.0 >= end,
            None => true,
        };
        if enough || attempt >= 3 {
            break streams;
        }

        // 부족하면 같은 폴더에서 이어받는다(.ytdl 덕분에 받은 조각은 다시 받지 않는다).
        update_job(jobs, job_id, |job| {
            job.message = "구간에 필요한 만큼 조각을 더 받는 중".to_string();
            push_log(job, "capture is short, resuming".to_string());
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    };

    if streams.is_empty() {
        return Err(anyhow!(
            "라이브에서 받은 조각이 없습니다. 잠시 후 다시 시도하거나 로그인 상태를 확인하세요."
        ));
    }

    let covered = capture_covered_seconds(&streams);
    if let Some(start) = start {
        if covered <= start + 1.0 {
            return Err(anyhow!(
                "라이브에서 {}까지만 받았는데 구간 시작이 {}입니다. 아직 방송이 그 지점까지 오지 않았을 수 있습니다.",
                format_time(covered + origin),
                format_time(start + origin)
            ));
        }
    }
    // 영상/음성 조각은 서로 다른 속도로 받아지므로 확보한 길이에서 잘라야
    // 소리만 길게 남는 파일이 나오지 않는다.
    let cut_end = Some(end.map_or(covered, |end| end.min(covered))).filter(|value| *value > 0.0);

    update_job(jobs, job_id, |job| {
        job.message = if start.is_some() || cut_end.is_some() {
            "구간을 잘라내는 중".to_string()
        } else {
            "영상 파일을 만드는 중".to_string()
        };
        job.progress = Some(99.0);
    })
    .await;

    let inputs: Vec<PathBuf> = streams.iter().map(|stream| stream.path.clone()).collect();
    // 파일 이름은 사용자가 고른 시각(방송 시작 기준) 그대로 쓴다.
    let output_path = capture_output_path(
        output_dir,
        info,
        req,
        &streams,
        req.start_seconds,
        req.end_seconds,
    );
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    cut_media_streams(&inputs, &output_path, start, cut_end, req.accurate_cut).await?;

    let saved = output_path.to_string_lossy().to_string();
    update_job(jobs, job_id, |job| {
        job.output_path = Some(saved.clone());
    })
    .await;

    let expected = download_section_duration(start, cut_end);
    finish_download_job(jobs, job_id, expected).await?;

    if let Err(err) = tokio::fs::remove_dir_all(&capture_dir).await {
        update_job(jobs, job_id, |job| {
            push_log(job, format!("could not clean capture directory: {err}"));
        })
        .await;
    }
    Ok(())
}

pub(crate) fn capture_covered_seconds(streams: &[CaptureStream]) -> f64 {
    if streams.is_empty() {
        return 0.0;
    }
    streams
        .iter()
        .map(|stream| stream.duration.unwrap_or(0.0))
        .fold(f64::INFINITY, f64::min)
        .max(0.0)
}

pub(crate) fn capture_output_path(
    output_dir: &Path,
    info: &TargetInfo,
    req: &DownloadRequest,
    streams: &[CaptureStream],
    start: Option<f64>,
    end: Option<f64>,
) -> PathBuf {
    let mp4_friendly = streams.iter().all(|stream| {
        matches!(
            stream
                .path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "mp4" | "m4a" | "mov" | "m4v" | "ts"
        )
    });
    // MP4 우선을 골랐으면 VP9/AV1이어도 mp4로 담는다(그대로 복사라 화질 손실 없음).
    let ext = if mp4_friendly || req.accurate_cut || matches!(req.format_mode, FormatMode::Mp4) {
        "mp4"
    } else {
        "mkv"
    };

    let title = sanitize_media_filename(info.title.as_deref().unwrap_or("live"));
    let id = info
        .id
        .as_deref()
        .map(sanitize_media_filename)
        .unwrap_or_default();
    let mut name = if id.is_empty() {
        title
    } else {
        format!("{title} [{id}]")
    };
    if start.is_some() || end.is_some() {
        name.push('_');
        name.push_str(&section_file_label(start, end));
    } else {
        name.push_str("_live");
    }
    output_dir.join(format!("{name}.{ext}"))
}

pub(crate) fn sanitize_media_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if (ch as u32) < 0x20 => ' ',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    let shortened: String = trimmed.chars().take(100).collect();
    let shortened = shortened.trim().to_string();
    if shortened.is_empty() {
        "video".to_string()
    } else {
        shortened
    }
}

// 받아둔 조각 파일을 스트림별로 이어붙여서 재생 가능한 파일로 만든다.
pub(crate) async fn assemble_capture_streams(dir: &Path) -> Result<Vec<CaptureStream>> {
    let merged_dir = dir.join("merged");
    let _ = tokio::fs::remove_dir_all(&merged_dir).await;
    tokio::fs::create_dir_all(&merged_dir)
        .await
        .with_context(|| format!("could not create merge directory {}", merged_dir.display()))?;

    let mut groups: HashMap<String, Vec<(u64, PathBuf)>> = HashMap::new();
    let mut finished: Vec<PathBuf> = Vec::new();
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .with_context(|| format!("could not read capture directory {}", dir.display()))?;
    while let Some(entry) = entries.next_entry().await? {
        if !entry
            .file_type()
            .await
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some((base, index)) = split_fragment_name(&name) {
            groups.entry(base).or_default().push((index, entry.path()));
        } else if is_media_filename(&name) {
            finished.push(entry.path());
        }
    }

    let mut streams = Vec::new();
    // 라이브가 끝나서 yt-dlp가 스스로 마무리한 경우. 조각을 잇는 것보다 이 파일이 온전하다.
    finished.retain(|path| {
        !path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(".temp."))
            .unwrap_or(false)
    });
    if let Some(merged) = finished
        .iter()
        .find(|path| !has_format_marker(path))
        .cloned()
    {
        finished = vec![merged];
    }
    if !finished.is_empty() {
        for path in finished {
            if let Some(stream) = probe_capture_stream(path).await {
                streams.push(stream);
            }
        }
        streams.sort_by_key(|stream| !stream.has_video);
        return Ok(streams);
    }
    if groups.is_empty() {
        return Ok(streams);
    }

    let mut bases: Vec<String> = groups.keys().cloned().collect();
    bases.sort();
    for base in bases {
        let mut fragments = groups.remove(&base).unwrap_or_default();
        fragments.sort_by_key(|(index, _)| *index);
        // 번호가 하나라도 비면 거기서 끊는다(빠진 조각 뒤는 이어붙여도 깨진다).
        let first = fragments.first().map(|(index, _)| *index).unwrap_or(1);
        let mut ordered: Vec<PathBuf> = fragments
            .into_iter()
            .zip(first..)
            .take_while(|((index, _), expected)| index == expected)
            .map(|((_, path), _)| path)
            .collect();
        // 중단 시점에 쓰이던 조각은 잘려 있을 수 있으므로 꼬리를 버린다.
        let keep = ordered
            .len()
            .saturating_sub(CAPTURE_TAIL_FRAGMENTS as usize);
        if keep == 0 {
            continue;
        }
        ordered.truncate(keep);

        let merged_path = merged_dir.join(&base);
        let target = merged_path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut output = fs::File::create(&target)
                .with_context(|| format!("could not create {}", target.display()))?;
            for path in ordered {
                let mut input = fs::File::open(&path)
                    .with_context(|| format!("could not open {}", path.display()))?;
                std::io::copy(&mut input, &mut output)
                    .with_context(|| format!("could not append {}", path.display()))?;
            }
            Ok(())
        })
        .await??;

        if let Some(stream) = probe_capture_stream(merged_path).await {
            streams.push(stream);
        }
    }

    // 영상 트랙을 먼저 넣어야 합칠 때 순서가 자연스럽다.
    streams.sort_by_key(|stream| !stream.has_video);
    Ok(streams)
}

pub(crate) fn split_fragment_name(name: &str) -> Option<(String, u64)> {
    let marker = ".part-Frag";
    let position = name.find(marker)?;
    let index = name[position + marker.len()..].parse().ok()?;
    Some((name[..position].to_string(), index))
}

// "capture.f137.mp4"처럼 포맷별로 따로 받아둔 파일인지 (합쳐진 "capture.mp4"와 구분).
pub(crate) fn has_format_marker(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    name.split('.').any(|part| {
        part.strip_prefix('f')
            .map(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()))
            .unwrap_or(false)
    })
}

pub(crate) fn is_media_filename(name: &str) -> bool {
    if name.contains(".part") || name.ends_with(".ytdl") {
        return false;
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp4" | "mkv" | "webm" | "m4a" | "ts" | "mov" | "m4v" | "opus" | "aac" | "mp3"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_capture_attempt(
    job_id: &str,
    req: &DownloadRequest,
    capture_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    ctx: &Arc<CaptureCtx>,
    stop_at: Option<f64>,
    end: Option<f64>,
    cancel: &Arc<AtomicBool>,
) -> Result<AttemptOutcome> {
    let exe = resolve_tool(req.yt_dlp_path.as_deref(), "yt-dlp");
    let mut cmd = yt_dlp_command(&exe);
    cmd.args([
        "--ignore-config",
        "--no-update",
        "--no-playlist",
        "--newline",
        "--progress",
        "-N",
        CAPTURE_CONCURRENCY,
        "--file-access-retries",
        "20",
        "--retry-sleep",
        "file_access:1",
        // 중간에 멈춰도 조각 파일이 남아 있어야 이어붙일 수 있다.
        "--keep-fragments",
        "--live-from-start",
    ]);
    add_ffmpeg_location(&mut cmd);
    add_js_runtime(&mut cmd);
    if cfg!(windows) {
        cmd.arg("--windows-filenames");
    }
    cmd.arg("--paths")
        .arg(format!("home:{}", capture_dir.to_string_lossy()));
    cmd.args(["-o", "capture.%(ext)s"]);
    add_format_args(&mut cmd, req.format_mode, req.max_height());
    add_cookie_args(
        &mut cmd,
        req.cookies_browser.as_deref(),
        req.cookies_profile.as_deref(),
        req.cookies_file.as_deref(),
    )?;
    cmd.arg(&req.url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .context("yt-dlp live capture command failed to start")?;
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
        None,
        Some(ctx.clone()),
        None,
    ));
    let stderr_task = tokio::spawn(forward_process_output(
        stderr,
        jobs.clone(),
        job_id.to_string(),
        ProcessOutput::Stderr,
        None,
        Some(ctx.clone()),
        None,
    ));

    let mut cancelled = false;
    let mut stopping = false;
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.context("yt-dlp wait failed")?,
            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                if !stopping && cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    stopping = true;
                    stop_child_process(&mut child).await;
                } else if !stopping {
                    if let Some(stop_at) = stop_at {
                        if ctx.safe_seconds() >= stop_at {
                            stopping = true;
                            stop_child_process(&mut child).await;
                        }
                    }
                }
                report_capture_progress(jobs, job_id, ctx, end, stopping).await;
            }
        }
    };

    join_output_task(stdout_task).await;
    join_output_task(stderr_task).await;
    Ok(AttemptOutcome { status, cancelled })
}

pub(crate) async fn report_capture_progress(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    ctx: &Arc<CaptureCtx>,
    end: Option<f64>,
    stopping: bool,
) {
    let covered = ctx.safe_seconds();
    update_job(jobs, job_id, |job| {
        if stopping {
            job.message = "필요한 만큼 받아서 정리하는 중".to_string();
            return;
        }
        match end {
            Some(end) if end > 0.0 => {
                job.progress = Some(((covered / end) * 100.0).clamp(0.0, 99.0));
                job.message = format!(
                    "라이브에서 구간 확보 중 {} / {}",
                    format_time(covered),
                    format_time(end)
                );
            }
            _ => {
                job.message = format!("라이브 녹화 중 {}", format_time(covered));
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_live_fragment_progress() {
        let line = "1: [download]   39.50MiB at    1.08MiB/s (00:00:42) (frag 55)";
        assert_eq!(parse_fragment_index(line), Some(55));
        assert_eq!(progress_stream_key(line), "1");
        assert_eq!(
            parse_fragment_index("[download] 1.2MiB (frag 7/120)"),
            Some(7)
        );
        assert_eq!(progress_stream_key("[download] 1.2MiB (frag 7)"), "");
        assert_eq!(parse_fragment_index("[download] 100% of 12MiB"), None);
    }

    #[test]
    fn tracks_slowest_capture_stream() {
        let ctx = CaptureCtx::new(5.0);
        ctx.note_line("1: [download] 10MiB (frag 40)");
        ctx.note_line("2: [download] 2MiB (frag 90)");
        // 느린 쪽(40조각)에서 꼬리 조각을 뺀 만큼만 확보한 것으로 본다.
        let tail = CAPTURE_TAIL_FRAGMENTS as f64;
        assert_eq!(ctx.safe_seconds(), (40.0 - tail) * 5.0);
        ctx.note_line("1: [download] 12MiB (frag 46)");
        assert_eq!(ctx.safe_seconds(), (46.0 - tail) * 5.0);
    }

    #[test]
    fn shifts_live_times_for_very_old_streams() {
        // 120시간 안쪽이면 방송 시작이 그대로 기준점이다.
        assert_eq!(live_capture_origin(Some(3600.0)), 0.0);
        // 그보다 오래된 방송은 받을 수 있는 첫 조각만큼 기준을 옮긴다.
        assert_eq!(
            live_capture_origin(Some(LIVE_FRAGMENT_WINDOW + 7200.0)),
            7200.0
        );
        assert_eq!(live_capture_origin(None), 0.0);
    }

    #[test]
    fn splits_fragment_file_names() {
        assert_eq!(
            split_fragment_name("capture.f137.mp4.part-Frag12"),
            Some(("capture.f137.mp4".to_string(), 12))
        );
        assert_eq!(split_fragment_name("capture.f137.mp4.part"), None);
        assert!(is_media_filename("capture.mp4"));
        assert!(!is_media_filename("capture.f137.mp4.part"));
        assert!(!is_media_filename("capture.f137.mp4.ytdl"));
    }

    #[test]
    fn cleans_windows_unsafe_file_names() {
        assert_eq!(
            sanitize_media_filename("라이브: 1부 <테스트> | 실황"),
            "라이브_ 1부 _테스트_ _ 실황"
        );
        assert_eq!(sanitize_media_filename("   "), "video");
    }
}
