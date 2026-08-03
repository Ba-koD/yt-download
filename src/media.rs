//! ffmpeg/ffprobe로 잘라내기와 정보 확인.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

use crate::live::CaptureStream;
use crate::tools::resolve_tool;

pub(crate) async fn probe_capture_stream(path: PathBuf) -> Option<CaptureStream> {
    let exe = resolve_tool(None, "ffprobe");
    let mut cmd = Command::new(exe);
    crate::proc::hide(&mut cmd);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1",
    ]);
    cmd.arg(&path);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut has_video = false;
    let mut has_audio = false;
    let mut duration = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(kind) = line.strip_prefix("codec_type=") {
            match kind {
                "video" => has_video = true,
                "audio" => has_audio = true,
                _ => {}
            }
        } else if let Some(value) = line.strip_prefix("duration=") {
            duration = value.parse::<f64>().ok().filter(|value| value.is_finite());
        }
    }
    if !has_video && !has_audio {
        return None;
    }
    Some(CaptureStream {
        path,
        duration,
        has_video,
        has_audio,
    })
}

pub(crate) async fn cut_media_section(
    input: &str,
    output: &str,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<()> {
    cut_media_streams(
        &[PathBuf::from(input)],
        Path::new(output),
        start,
        end,
        false,
    )
    .await
}

// 영상/음성이 따로 있는 경우까지 처리하는 구간 잘라내기.
pub(crate) async fn cut_media_streams(
    inputs: &[PathBuf],
    output: &Path,
    start: Option<f64>,
    end: Option<f64>,
    accurate: bool,
) -> Result<()> {
    let inputs: Vec<(PathBuf, f64)> = inputs.iter().map(|path| (path.clone(), 0.0)).collect();
    cut_media_inputs(&inputs, output, start, end, accurate).await
}

// 파일마다 시간축 시작점(offset)이 다를 수 있어서 각각 보정해서 자른다.
pub(crate) async fn cut_media_inputs(
    inputs: &[(PathBuf, f64)],
    output: &Path,
    start: Option<f64>,
    end: Option<f64>,
    accurate: bool,
) -> Result<()> {
    if inputs.is_empty() {
        return Err(anyhow!("잘라낼 입력 파일이 없습니다"));
    }

    let exe = resolve_tool(None, "ffmpeg");
    let mut cmd = Command::new(exe);
    crate::proc::hide(&mut cmd);
    cmd.args(["-hide_banner", "-y"]);
    for (input, offset) in inputs {
        // 입력 쪽 -ss/-to를 쓰면 필요한 구간만 읽어서 빠르다.
        if let Some(start) = start {
            cmd.args(["-ss", &format_time((start - offset).max(0.0))]);
        }
        if let Some(end) = end {
            cmd.args(["-to", &format_time((end - offset).max(0.0))]);
        }
        cmd.arg("-i").arg(input);
    }
    for index in 0..inputs.len() {
        cmd.arg("-map").arg(index.to_string());
    }
    if accurate {
        // 정확 컷은 시작 지점 키프레임을 새로 만들어야 해서 다시 인코딩한다.
        cmd.args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
        ]);
    } else {
        cmd.args(["-c", "copy"]);
    }
    let is_mp4 = output
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("mp4") || ext.eq_ignore_ascii_case("m4a"))
        .unwrap_or(false);
    if is_mp4 {
        cmd.args(["-movflags", "+faststart"]);
    }
    cmd.arg(output);

    let output_result = cmd
        .output()
        .await
        .context("ffmpeg cut command failed to start")?;
    if !output_result.status.success() {
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(anyhow!("구간 잘라내기에 실패했습니다: {tail}"));
    }
    Ok(())
}

// "2160p (3840x2160, vp9)" 형태의 짧은 설명.
pub(crate) async fn probe_video_quality(path: &str) -> Option<String> {
    let exe = resolve_tool(None, "ffprobe");
    let mut cmd = Command::new(exe);
    crate::proc::hide(&mut cmd);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name",
        "-of",
        "default=nw=1",
    ]);
    cmd.arg(path);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut width = None;
    let mut height = None;
    let mut codec = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("width=") {
            width = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix("height=") {
            height = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix("codec_name=") {
            codec = Some(value.to_string());
        }
    }
    let height = height?;
    let width = width?;
    Some(match codec {
        Some(codec) => format!("{height}p ({width}x{height}, {codec})"),
        None => format!("{height}p ({width}x{height})"),
    })
}

// 오디오만 길고 영상 트랙이 잘린 파일도 있으므로, 컨테이너 길이와 영상 트랙 길이 중 짧은 쪽을 쓴다.
pub(crate) async fn probe_media_duration(path: &str) -> Option<f64> {
    let container = probe_duration_value(path, &["-show_entries", "format=duration"]).await;
    let video = probe_duration_value(
        path,
        &["-select_streams", "v:0", "-show_entries", "stream=duration"],
    )
    .await;
    match (container, video) {
        (Some(container), Some(video)) => Some(container.min(video)),
        (container, video) => container.or(video),
    }
}

pub(crate) async fn probe_duration_value(path: &str, selector: &[&str]) -> Option<f64> {
    let exe = resolve_tool(None, "ffprobe");
    let mut cmd = Command::new(exe);
    crate::proc::hide(&mut cmd);
    cmd.args(["-v", "error"]);
    cmd.args(selector);
    cmd.args(["-of", "csv=p=0", path]);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

pub(crate) fn format_time(seconds: f64) -> String {
    let millis = (seconds * 1000.0).round() as u64;
    let hours = millis / 3_600_000;
    let minutes = (millis % 3_600_000) / 60_000;
    let secs = (millis % 60_000) / 1000;
    let ms = millis % 1000;
    if ms == 0 {
        format!("{hours:02}:{minutes:02}:{secs:02}")
    } else {
        format!("{hours:02}:{minutes:02}:{secs:02}.{ms:03}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_download_section_times() {
        assert_eq!(format_time(0.0), "00:00:00");
        assert_eq!(format_time(65.0), "00:01:05");
        assert_eq!(format_time(3723.25), "01:02:03.250");
    }
}
