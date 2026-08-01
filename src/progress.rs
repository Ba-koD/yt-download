//! yt-dlp/ffmpeg 출력에서 진행률을 읽어 하나의 상태로 합친다.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::Mutex,
};

use crate::jobs::{push_log, update_job, JobStatus};
use crate::live::CaptureCtx;
use crate::media::format_time;

// 받기 92%, 합치기 8%로 나눠서 하나의 진행률로 보여준다.
pub(crate) const DOWNLOAD_SHARE: f64 = 92.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadPhase {
    Downloading,
    Merging,
    Finishing,
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StreamProgress {
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
    pub(crate) finished: bool,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct ProgressState {
    pub(crate) order: Vec<String>,
    pub(crate) streams: HashMap<String, StreamProgress>,
    pub(crate) speed: Option<String>,
    pub(crate) eta: Option<String>,
    pub(crate) phase_index: usize,
}

// 영상/음성 스트림과 합치기 단계를 하나의 진행률로 묶는다.
#[derive(Debug)]
pub(crate) struct DownloadProgress {
    pub(crate) expected_bytes: Option<u64>,
    pub(crate) expected_streams: usize,
    pub(crate) media_seconds: Option<f64>,
    pub(crate) merge_progress_path: PathBuf,
    pub(crate) state: std::sync::Mutex<ProgressState>,
    pub(crate) phase: std::sync::Mutex<DownloadPhase>,
}

impl DownloadProgress {
    pub(crate) fn new(
        expected_bytes: Option<u64>,
        expected_streams: usize,
        media_seconds: Option<f64>,
        merge_progress_path: &Path,
    ) -> Self {
        Self {
            expected_bytes,
            expected_streams,
            media_seconds,
            merge_progress_path: merge_progress_path.to_path_buf(),
            state: std::sync::Mutex::new(ProgressState::default()),
            phase: std::sync::Mutex::new(DownloadPhase::Downloading),
        }
    }

    pub(crate) fn lock_state(&self) -> std::sync::MutexGuard<'_, ProgressState> {
        self.state.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub(crate) fn has_data(&self) -> bool {
        self.phase() != DownloadPhase::Downloading || !self.lock_state().streams.is_empty()
    }

    pub(crate) fn phase(&self) -> DownloadPhase {
        *self.phase.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub(crate) fn set_phase(&self, phase: DownloadPhase) {
        *self.phase.lock().unwrap_or_else(|err| err.into_inner()) = phase;
    }

    // 진행률 전용 줄이면 true. 사람이 읽는 로그에는 남기지 않는다.
    pub(crate) fn note_line(&self, line: &str) -> bool {
        if let Some(rest) = line.strip_prefix("@P@") {
            self.note_download(rest);
            return true;
        }
        if let Some(rest) = line.strip_prefix("@PP@") {
            self.note_postprocess(rest);
            return true;
        }
        false
    }

    pub(crate) fn note_download(&self, rest: &str) {
        let fields: Vec<&str> = rest.split('|').collect();
        let status = fields.first().copied().unwrap_or("");
        let downloaded = parse_progress_number(fields.get(1).copied()).unwrap_or(0.0) as u64;
        let total = parse_progress_number(fields.get(2).copied())
            .or_else(|| parse_progress_number(fields.get(3).copied()))
            .map(|value| value as u64);
        let speed = parse_progress_number(fields.get(4).copied());
        let eta = parse_progress_number(fields.get(5).copied());
        let format_id = fields.get(6).copied().unwrap_or("").to_string();

        let mut state = self.lock_state();
        if !state.streams.contains_key(&format_id) {
            state.order.push(format_id.clone());
        }
        let entry = state.streams.entry(format_id).or_default();
        entry.downloaded = downloaded.max(entry.downloaded);
        if let Some(total) = total {
            entry.total = Some(total);
        }
        if status == "finished" {
            entry.finished = true;
            if let Some(total) = entry.total {
                entry.downloaded = entry.downloaded.max(total);
            }
        }
        state.phase_index = state.order.len().saturating_sub(1);
        if let Some(speed) = speed.filter(|value| *value > 0.0) {
            state.speed = Some(normalize_download_speed(&format!("{speed:.0}B/s")));
        }
        state.eta = eta
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| format_time(value.round()));
    }

    pub(crate) fn note_postprocess(&self, rest: &str) {
        let mut fields = rest.split('|');
        let status = fields.next().unwrap_or("");
        let name = fields.next().unwrap_or("");
        let merging = matches!(name, "Merger" | "VideoRemuxer" | "VideoConvertor");
        match status {
            "started" | "processing" if merging => self.set_phase(DownloadPhase::Merging),
            "started" | "processing" => self.set_phase(DownloadPhase::Finishing),
            "finished" => self.set_phase(DownloadPhase::Finishing),
            _ => {}
        }
    }

    pub(crate) fn download_percent(&self) -> f64 {
        let state = self.lock_state();
        let downloaded: u64 = state.streams.values().map(|value| value.downloaded).sum();
        let known_total: u64 = state.streams.values().filter_map(|value| value.total).sum();
        let all_started = self.expected_streams > 0 && state.streams.len() >= self.expected_streams;
        let total = match self.expected_bytes {
            Some(expected) if expected > 0 => expected.max(known_total),
            _ if all_started && known_total > 0 => known_total,
            _ if known_total > 0 => {
                // 아직 시작 안 한 스트림이 있으면 남은 몫을 대충 남겨둔다.
                let started = state.streams.len().max(1) as u64;
                let expected = self.expected_streams.max(started as usize) as u64;
                known_total * expected / started
            }
            _ => 0,
        };
        if total == 0 {
            return 0.0;
        }
        ((downloaded as f64 / total as f64) * DOWNLOAD_SHARE).clamp(0.0, DOWNLOAD_SHARE)
    }

    // ffmpeg가 파일로 남기는 진행률을 읽어 합치기 단계 퍼센트를 만든다.
    pub(crate) fn merge_percent(&self) -> Option<f64> {
        let text = fs::read_to_string(&self.merge_progress_path).ok()?;
        let mut seconds = None;
        let mut ended = false;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("out_time_us=") {
                seconds = value.trim().parse::<f64>().ok().map(|value| value / 1e6);
            } else if line.trim() == "progress=end" {
                ended = true;
            }
        }
        if ended {
            return Some(100.0);
        }
        let seconds = seconds?;
        let duration = self.media_seconds.filter(|value| *value > 1.0)?;
        Some(((seconds / duration) * 100.0).clamp(0.0, 99.0))
    }

    // 스트림을 다 받았으면 합치는 단계로 본다.
    // (yt-dlp가 --print 때문에 조용 모드로 돌아서 후처리 알림이 안 오는 경우가 있다.)
    pub(crate) fn downloads_finished(&self) -> bool {
        let state = self.lock_state();
        if state.streams.is_empty() {
            return false;
        }
        if self.expected_streams > 0 && state.streams.len() < self.expected_streams {
            return false;
        }
        state.streams.values().all(|stream| stream.finished)
    }

    pub(crate) fn snapshot(&self) -> (f64, String, Option<String>, Option<String>) {
        let mut phase = self.phase();
        if phase == DownloadPhase::Downloading && self.downloads_finished() {
            phase = DownloadPhase::Merging;
        }
        let download = self.download_percent();
        let (speed, eta, index, count) = {
            let state = self.lock_state();
            (
                state.speed.clone(),
                state.eta.clone(),
                state.phase_index,
                state.streams.len().max(self.expected_streams),
            )
        };

        match phase {
            DownloadPhase::Downloading => {
                let label = stream_label(index, count);
                (download, label, speed, eta)
            }
            DownloadPhase::Merging => {
                let merge = self.merge_percent().unwrap_or(0.0);
                let percent = DOWNLOAD_SHARE + (100.0 - DOWNLOAD_SHARE) * (merge / 100.0);
                let label = if count > 1 {
                    "영상과 음성을 합치는 중"
                } else {
                    "파일 마무리 중"
                };
                (
                    percent.clamp(DOWNLOAD_SHARE, 99.5),
                    label.to_string(),
                    None,
                    None,
                )
            }
            DownloadPhase::Finishing => (99.5, "파일 정리 중".to_string(), None, None),
        }
    }
}

pub(crate) fn stream_label(index: usize, count: usize) -> String {
    if count <= 1 {
        return "받는 중".to_string();
    }
    let kind = if index == 0 { "영상" } else { "음성" };
    format!("{kind} 받는 중 ({}/{count})", index + 1)
}

pub(crate) fn parse_progress_number(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty() || value == "NA" || value == "None" {
        return None;
    }
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

pub(crate) async fn report_download_progress(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    progress: &Arc<DownloadProgress>,
) {
    if !progress.has_data() {
        return;
    }
    let (percent, label, speed, eta) = progress.snapshot();
    update_job(jobs, job_id, |job| {
        // 뒤로 가는 진행률은 사용자를 헷갈리게 하므로 앞으로만 움직인다.
        let previous = job.progress.unwrap_or(0.0);
        job.progress = Some(percent.max(previous).min(99.9));
        job.message = label;
        job.speed = speed;
        job.eta = eta;
    })
    .await;
}

#[derive(Clone, Copy)]
pub(crate) enum ProcessOutput {
    Stdout,
    Stderr,
}

pub(crate) async fn forward_process_output<R>(
    mut reader: R,
    jobs: Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: String,
    stream: ProcessOutput,
    section_duration: Option<f64>,
    capture: Option<Arc<CaptureCtx>>,
    progress: Option<Arc<DownloadProgress>>,
) where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 4096];
    let mut record = Vec::new();

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                for byte in &chunk[..read] {
                    if *byte == b'\n' || *byte == b'\r' {
                        handle_process_record(
                            &jobs,
                            &job_id,
                            stream,
                            section_duration,
                            capture.as_ref(),
                            progress.as_ref(),
                            &mut record,
                        )
                        .await;
                    } else {
                        record.push(*byte);
                    }
                }
            }
            Err(err) => {
                update_job(&jobs, &job_id, |job| {
                    push_log(job, format!("could not read yt-dlp output: {err}"));
                })
                .await;
                break;
            }
        }
    }

    handle_process_record(
        &jobs,
        &job_id,
        stream,
        section_duration,
        capture.as_ref(),
        progress.as_ref(),
        &mut record,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_process_record(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    stream: ProcessOutput,
    section_duration: Option<f64>,
    capture: Option<&Arc<CaptureCtx>>,
    progress: Option<&Arc<DownloadProgress>>,
    record: &mut Vec<u8>,
) {
    let Some(clean) = take_clean_process_record(record) else {
        return;
    };

    // 진행률 전용 줄은 화면/로그에 그대로 뿌리지 않고 숫자만 반영한다.
    if let Some(progress) = progress {
        if progress.note_line(&clean) {
            return;
        }
    }

    // 라이브 캡처는 조각 번호로 진행 상황을 계산하고, 상태 메시지는 따로 관리한다.
    if let Some(capture) = capture {
        capture.note_line(&clean);
        update_job(jobs, job_id, |job| {
            if let Some(speed) = parse_value_after_marker(&clean, " at ") {
                job.speed = Some(normalize_download_speed(&speed));
            }
            if matches!(stream, ProcessOutput::Stderr) && clean.starts_with("ERROR") {
                job.message = short_status(&clean);
            }
            // 조각 진행률은 초당 수십 줄이라 로그에 남기지 않는다.
            if !clean.contains("[download]") {
                push_log(job, clean.clone());
            }
        })
        .await;
        return;
    }

    // 단계별 안내를 쓰고 있으면 원본 출력으로 덮어쓰지 않는다(오류는 예외).
    let keep_raw_message = progress.map(|value| !value.has_data()).unwrap_or(true);
    update_job(jobs, job_id, |job| {
        match stream {
            ProcessOutput::Stdout => {
                if looks_like_path(&clean) {
                    job.output_path = Some(clean.clone());
                }
                if keep_raw_message {
                    job.message = clean.clone();
                }
            }
            ProcessOutput::Stderr => {
                if keep_raw_message || clean.starts_with("ERROR") {
                    job.message = short_status(&clean);
                }
            }
        }
        apply_progress_line(job, &clean, section_duration);
        push_log(job, clean.clone());
    })
    .await;
}

pub(crate) fn take_clean_process_record(record: &mut Vec<u8>) -> Option<String> {
    if record.is_empty() {
        return None;
    }
    let clean = String::from_utf8_lossy(record).trim().to_string();
    record.clear();
    (!clean.is_empty()).then_some(clean)
}

pub(crate) fn apply_progress_line(job: &mut JobStatus, line: &str, section_duration: Option<f64>) {
    if let Some(progress) = parse_download_percent(line) {
        job.progress = Some(progress);
    } else if let (Some(elapsed), Some(duration)) =
        (parse_ffmpeg_progress_seconds(line), section_duration)
    {
        if duration > 0.0 {
            job.progress = Some(((elapsed / duration) * 100.0).clamp(0.0, 99.0));
        }
    }
    if let Some(speed) = parse_value_after_marker(line, " at ") {
        job.speed = Some(normalize_download_speed(&speed));
    }
    if let Some(eta) = parse_value_after_marker(line, " ETA ") {
        job.eta = Some(eta);
    }
}

pub(crate) fn parse_download_percent(line: &str) -> Option<f64> {
    if !line.contains("[download]") {
        return None;
    }
    let percent_pos = line.find('%')?;
    let before_percent = &line[..percent_pos];
    let token = before_percent
        .split_whitespace()
        .rev()
        .find(|value| value.chars().any(|ch| ch.is_ascii_digit()))?;
    token
        .trim()
        .parse::<f64>()
        .ok()
        .map(|value| value.clamp(0.0, 100.0))
}

pub(crate) fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    if let Some(value) = parse_token_after_marker(line, "out_time_ms=") {
        return value.parse::<f64>().ok().map(|value| value / 1_000_000.0);
    }
    parse_token_after_marker(line, "out_time=")
        .or_else(|| parse_token_after_marker(line, "time="))
        .and_then(|value| parse_time_seconds(&value))
}

pub(crate) fn parse_token_after_marker(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)? + marker.len();
    let value = line[start..]
        .split_whitespace()
        .next()?
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    (!value.is_empty() && value != "N/A").then_some(value)
}

pub(crate) fn parse_time_seconds(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((hours * 3600.0) + (minutes * 60.0) + seconds)
}

pub(crate) fn parse_value_after_marker(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)? + marker.len();
    let tail = &line[start..];
    let end = tail.find(" ETA ").unwrap_or(tail.len());
    let value = tail[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn normalize_download_speed(value: &str) -> String {
    let compact = value.trim().replace(' ', "");
    let Some((amount, unit)) = split_speed_value(&compact) else {
        return value.trim().to_string();
    };

    let bytes_per_second = match unit.to_ascii_lowercase().as_str() {
        "b/s" | "bytes/s" => amount,
        "kb/s" => amount * 1_000.0,
        "kib/s" => amount * 1024.0,
        "mb/s" => amount * 1_000_000.0,
        "mib/s" => amount * 1024.0 * 1024.0,
        "gb/s" => amount * 1_000_000_000.0,
        "gib/s" => amount * 1024.0 * 1024.0 * 1024.0,
        _ => return value.trim().to_string(),
    };

    if bytes_per_second >= 1_000_000.0 {
        format!("{:.1} MB/s", bytes_per_second / 1_000_000.0)
    } else if bytes_per_second >= 1_000.0 {
        format!("{:.1} KB/s", bytes_per_second / 1_000.0)
    } else {
        format!("{:.0} B/s", bytes_per_second)
    }
}

pub(crate) fn split_speed_value(value: &str) -> Option<(f64, &str)> {
    let split_at = value
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_digit() || *ch == '.'))
        .map(|(index, _)| index)?;
    let amount = value[..split_at].parse::<f64>().ok()?;
    Some((amount, &value[split_at..]))
}

pub(crate) fn short_status(line: &str) -> String {
    static PREFIXES: &[&str] = &[
        "[download]",
        "[ExtractAudio]",
        "[Merger]",
        "[VideoRemuxer]",
        "[ffmpeg]",
        "[youtube]",
    ];
    for prefix in PREFIXES {
        if line.starts_with(prefix) {
            return line.to_string();
        }
    }
    if line.len() > 120 {
        format!("{}...", &line[..120])
    } else {
        line.to_string()
    }
}

// 출력 줄이 저장 경로인지 판별한다(yt-dlp가 완료 후 경로를 찍어준다).
pub(crate) fn looks_like_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive_path = bytes.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic();
    drive_path || value.starts_with('/') || value.starts_with("\\\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_download_progress_lines() {
        let line = "[download]  37.8% of 100.00MiB at 2.40MiB/s ETA 00:12";
        assert_eq!(parse_download_percent(line), Some(37.8));
        assert_eq!(
            parse_value_after_marker(line, " at "),
            Some("2.40MiB/s".to_string())
        );
        assert_eq!(
            parse_value_after_marker(line, " ETA "),
            Some("00:12".to_string())
        );
    }

    #[test]
    fn parses_ffmpeg_progress_times() {
        let stats = "frame= 123 fps=0.0 q=-1.0 size= 1024KiB time=00:10:48.500 bitrate=1200.0kbits/s speed=1.2x";
        assert_eq!(parse_ffmpeg_progress_seconds(stats), Some(648.5));
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time=00:00:12.250000"),
            Some(12.25)
        );
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time_ms=12500000"),
            Some(12.5)
        );
    }

    #[test]
    fn normalizes_download_speed_units() {
        assert_eq!(normalize_download_speed("512.0KiB/s"), "524.3 KB/s");
        assert_eq!(normalize_download_speed("2.40MiB/s"), "2.5 MB/s");
        assert_eq!(normalize_download_speed("950B/s"), "950 B/s");
    }

    #[test]
    fn merges_stream_progress_into_one_bar() {
        let progress = DownloadProgress::new(Some(1000), 2, Some(60.0), Path::new("no-merge-file"));
        assert!(!progress.has_data());

        assert!(progress.note_line("@P@downloading|400|800|800|1048576.0|3.0|137"));
        assert!(progress.has_data());
        let (percent, label, speed, eta) = progress.snapshot();
        assert_eq!(label, "영상 받는 중 (1/2)");
        assert_eq!(speed.as_deref(), Some("1.0 MB/s"));
        assert_eq!(eta.as_deref(), Some("00:00:03"));
        assert!((percent - 36.8).abs() < 0.1, "percent was {percent}");

        assert!(progress.note_line("@P@finished|800|800|800|NA|NA|137"));
        assert!(progress.note_line("@P@finished|200|200|200|NA|NA|140"));
        let (percent, label, _, _) = progress.snapshot();
        // 두 스트림을 다 받았으면 자동으로 합치기 단계로 넘어간다.
        assert_eq!(label, "영상과 음성을 합치는 중");
        assert!(
            (percent - DOWNLOAD_SHARE).abs() < 0.01,
            "percent was {percent}"
        );

        assert!(progress.note_line("@PP@finished|Merger"));
        let (_, label, _, _) = progress.snapshot();
        assert_eq!(label, "파일 정리 중");
        assert!(!progress.note_line("[download] Destination: video.mp4"));
    }
}
