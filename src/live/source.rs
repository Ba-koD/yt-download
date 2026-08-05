//! 진행 중인 라이브의 조각 주소와 시간 기준을 알아낸다.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::download::{add_format_args, DownloadRequest};
use crate::media::format_time;
use crate::tools::{
    add_cookie_args, add_ffmpeg_location, add_js_runtime, resolve_tool, yt_dlp_command,
};
use crate::youtube::{metadata_duration, value_str, yt_dlp_error};

// 다운로드 방식을 정하기 위해 미리 확인하는 영상 상태.
#[derive(Debug, Clone, Default)]
pub(crate) struct TargetInfo {
    pub(crate) live_status: Option<String>,
    pub(crate) duration: Option<f64>,
    pub(crate) fragment_seconds: Option<f64>,
    pub(crate) title: Option<String>,
    pub(crate) id: Option<String>,
    // 정확한 진행률을 만들기 위해 미리 확인하는 예상 용량과 스트림 개수.
    pub(crate) expected_bytes: Option<u64>,
    pub(crate) stream_count: usize,
    // 진행 중인 라이브에서 필요한 구간의 조각만 직접 받기 위한 정보.
    pub(crate) live_sources: Vec<LiveSource>,
    // 라이브 시간 기준점(방송 시작 시각, 유닉스 초).
    pub(crate) release_timestamp: Option<f64>,
}

// 진행 중인 라이브에서 원하는 지점의 조각을 바로 받는 방법은 두 가지다.
#[derive(Debug, Clone, Copy)]
pub(crate) enum LiveSourceKind {
    // DASH: `<url>&sq=<번호>`로 조각을 직접 부른다. 0번 조각에 초기화 정보가 있다.
    Dash { target_seconds: f64 },
    // HLS: 재생목록(m3u8)에 조각 주소가 전부 들어 있어서 필요한 것만 골라 받는다.
    Hls,
}

#[derive(Debug, Clone)]
pub(crate) struct LiveSource {
    pub(crate) url: String,
    pub(crate) ext: String,
    pub(crate) kind: LiveSourceKind,
    pub(crate) has_video: bool,
}

impl LiveSource {
    pub(crate) fn fragment_url(&self, sequence: u64) -> String {
        if self.url.contains('?') {
            format!("{}&sq={sequence}", self.url)
        } else {
            format!("{}?sq={sequence}", self.url)
        }
    }
}

#[derive(Debug)]
pub(crate) struct HlsSegment {
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) url: String,
}

// 재생목록에서 조각별 "영상 시작 기준 위치"를 계산한다.
// 조각 번호 × 조각 길이가 영상 시간축과 일치한다(실측 확인).
// EXT-X-PROGRAM-DATE-TIME은 시계 기준이라 몇 시간짜리 방송에서 수십 초씩 어긋나므로
// 번호를 못 읽을 때만 보조로 쓴다.
pub(crate) fn parse_hls_playlist(text: &str, release_timestamp: Option<f64>) -> Vec<HlsSegment> {
    let mut target = 5.0_f64;
    let mut cursor: Option<f64> = None;
    let mut pending: Option<f64> = None;
    let mut segments = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            if let Ok(value) = value.trim().parse::<f64>() {
                if value > 0.0 {
                    target = value;
                }
            }
        } else if let Some(value) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            if let (Some(stamp), Some(release)) =
                (parse_iso8601_seconds(value.trim()), release_timestamp)
            {
                cursor = Some(stamp - release);
            }
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            pending = value
                .split(',')
                .next()
                .and_then(|value| value.trim().parse().ok());
        } else if line.starts_with("http") {
            let duration = pending.take().unwrap_or(target);
            let position = match sequence_from_url(line) {
                Some(sequence) => sequence as f64 * target,
                None => cursor.unwrap_or(0.0),
            };
            segments.push(HlsSegment {
                position,
                duration,
                url: line.to_string(),
            });
            cursor = Some(position + duration);
        }
    }
    segments
}

pub(crate) fn sequence_from_url(url: &str) -> Option<u64> {
    let position = url.find("/sq/")?;
    let rest = &url[position + 4..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

// "2026-08-01T09:10:55.062+00:00" / "...Z" 형태를 유닉스 초로 바꾼다.
pub(crate) fn parse_iso8601_seconds(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: f64 = value.get(17..19)?.parse().ok()?;

    let rest = &value[19..];
    let mut fraction = 0.0;
    let mut zone = rest;
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            fraction = format!("0.{digits}").parse().unwrap_or(0.0);
            zone = &stripped[digits.len()..];
        }
    }

    let offset = match zone.chars().next() {
        None | Some('Z') | Some('z') => 0,
        Some(sign @ ('+' | '-')) => {
            let hours: i64 = zone.get(1..3)?.parse().ok()?;
            let minutes: i64 = zone.get(4..6).unwrap_or("00").parse().unwrap_or(0);
            let total = hours * 3600 + minutes * 60;
            if sign == '-' {
                -total
            } else {
                total
            }
        }
        _ => 0,
    };

    let days = days_from_civil(year, month, day);
    Some((days * 86400 + hour * 3600 + minute * 60 - offset) as f64 + second + fraction)
}

// 1970-01-01부터의 일 수 (Howard Hinnant의 civil_from_days 역함수).
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

impl TargetInfo {
    pub(crate) fn is_post_live(&self) -> bool {
        self.live_status.as_deref() == Some("post_live")
    }

    // 라이브 조각 1개의 길이(초). 유튜브는 보통 5초이며, 못 읽으면 그 값을 쓴다.
    pub(crate) fn frag_seconds(&self) -> f64 {
        self.fragment_seconds
            .filter(|value| value.is_finite() && *value > 0.5)
            .unwrap_or(5.0)
    }

    pub(crate) fn summary(&self) -> String {
        format!(
            "live_status={} duration={} fragment={}s",
            self.live_status.as_deref().unwrap_or("unknown"),
            self.duration
                .map(format_time)
                .unwrap_or_else(|| "unknown".to_string()),
            self.frag_seconds()
        )
    }
}

pub(crate) async fn probe_target(req: &DownloadRequest, live_hint: bool) -> Result<TargetInfo> {
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
    ]);
    // 진행 중인 라이브일 때만 조각 정보(target_duration)가 붙는다.
    if live_hint {
        cmd.arg("--live-from-start");
    }
    // 실제로 받을 포맷을 그대로 물어봐야 예상 용량이 맞는다.
    add_format_args(&mut cmd, req);
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
        .context("yt-dlp state command failed to start")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(yt_dlp_error("영상 상태를 확인하지 못했습니다", &stderr));
    }

    let value: Value =
        serde_json::from_slice(&output.stdout).context("yt-dlp returned invalid JSON")?;
    let (expected_bytes, stream_count) = requested_download_size(&value);
    Ok(TargetInfo {
        live_status: value_str(&value, "live_status"),
        duration: metadata_duration(&value),
        fragment_seconds: fragment_seconds_from_formats(&value),
        title: value_str(&value, "title"),
        id: value_str(&value, "id"),
        expected_bytes,
        stream_count,
        live_sources: live_sources_from_formats(&value),
        release_timestamp: value
            .get("release_timestamp")
            .or_else(|| value.get("timestamp"))
            .and_then(Value::as_f64),
    })
}

// 고른 포맷이 조각 방식(DASH/HLS)이면 조각 주소를 그대로 쓸 수 있다.
pub(crate) fn live_sources_from_formats(value: &Value) -> Vec<LiveSource> {
    // 영상+음성이 한 스트림에 들어 있으면 requested_formats 없이 최상위에 정보가 온다.
    let formats: Vec<&Value> = match value.get("requested_formats").and_then(Value::as_array) {
        Some(formats) => formats.iter().collect(),
        None => vec![value],
    };

    let mut sources = Vec::new();
    for format in formats {
        let Some(source) = live_source_from_format(format) else {
            return Vec::new();
        };
        sources.push(source);
    }
    sources
}

pub(crate) fn live_source_from_format(format: &Value) -> Option<LiveSource> {
    let protocol = format
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let url = value_str(format, "url")?;

    let kind = if protocol.starts_with("http_dash_segments") {
        let target = format.get("target_duration").and_then(Value::as_f64)?;
        if !target.is_finite() || target <= 0.0 {
            return None;
        }
        LiveSourceKind::Dash {
            target_seconds: target,
        }
    } else if protocol.starts_with("m3u8") {
        LiveSourceKind::Hls
    } else {
        return None;
    };

    Some(LiveSource {
        url,
        ext: match kind {
            LiveSourceKind::Hls => "ts".to_string(),
            LiveSourceKind::Dash { .. } => {
                value_str(format, "ext").unwrap_or_else(|| "mp4".to_string())
            }
        },
        kind,
        has_video: format
            .get("vcodec")
            .and_then(Value::as_str)
            .map(|codec| codec != "none")
            .unwrap_or(false),
    })
}

// 선택된 포맷들의 예상 용량 합계와 개수. 하나라도 모르면 합계는 버린다.
pub(crate) fn requested_download_size(value: &Value) -> (Option<u64>, usize) {
    let formats = value
        .get("requested_formats")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            value
                .get("requested_downloads")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("requested_formats"))
                .and_then(Value::as_array)
                .cloned()
        });

    let Some(formats) = formats else {
        // 영상+음성이 한 파일에 들어 있는 경우.
        let size = value
            .get("filesize")
            .or_else(|| value.get("filesize_approx"))
            .and_then(Value::as_u64);
        return (size, if size.is_some() { 1 } else { 0 });
    };

    let mut total = 0_u64;
    let mut complete = true;
    for format in &formats {
        match format
            .get("filesize")
            .or_else(|| format.get("filesize_approx"))
            .and_then(Value::as_u64)
        {
            Some(size) => total += size,
            None => complete = false,
        }
    }
    ((complete && total > 0).then_some(total), formats.len())
}

pub(crate) fn fragment_seconds_from_formats(value: &Value) -> Option<f64> {
    let formats = value.get("formats")?.as_array()?;
    formats
        .iter()
        .filter(|format| {
            format
                .get("protocol")
                .and_then(Value::as_str)
                .map(|protocol| protocol.starts_with("http_dash_segments"))
                .unwrap_or(false)
        })
        .filter_map(|format| format.get("target_duration").and_then(Value::as_f64))
        .filter(|value| value.is_finite() && *value > 0.0)
        .fold(None, |best: Option<f64>, value| {
            Some(best.map_or(value, |best| best.max(value)))
        })
}

#[cfg(test)]
mod tests {

    use super::*;
    use serde_json::json;

    #[test]
    fn reads_expected_download_size() {
        let value = json!({
            "requested_formats": [
                {"format_id": "137", "filesize": 100},
                {"format_id": "140", "filesize_approx": 20}
            ]
        });
        assert_eq!(requested_download_size(&value), (Some(120), 2));

        let unknown = json!({"requested_formats": [{"format_id": "137"}]});
        assert_eq!(requested_download_size(&unknown), (None, 1));
    }

    #[test]
    fn parses_iso8601_timestamps() {
        assert_eq!(parse_iso8601_seconds("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_iso8601_seconds("2026-08-01T09:10:55.062+00:00"),
            Some(1785575455.062)
        );
        // 시간대가 붙으면 UTC로 되돌린다.
        assert_eq!(
            parse_iso8601_seconds("2026-08-01T18:10:55+09:00"),
            Some(1785575455.0)
        );
        assert_eq!(parse_iso8601_seconds("이건 시각이 아님"), None);
    }

    #[test]
    fn maps_hls_segments_to_media_time() {
        let release = 1785575000.0;
        let playlist = "#EXTM3U\n\
             #EXT-X-TARGETDURATION:5\n\
             #EXT-X-MEDIA-SEQUENCE:176\n\
             #EXT-X-PROGRAM-DATE-TIME:2026-08-01T09:10:55+00:00\n\
             #EXTINF:5.0,\n\
             https://example.com/videoplayback/sq/176/file/seg.ts\n\
             #EXTINF:5.0,\n\
             https://example.com/videoplayback/sq/177/file/seg.ts\n";
        let segments = parse_hls_playlist(playlist, Some(release));
        assert_eq!(segments.len(), 2);
        // 조각 번호 × 조각 길이가 영상 시간축이다. (실제 시각은 수십 초 어긋나므로 쓰지 않는다.)
        assert!((segments[0].position - 880.0).abs() < 0.001);
        assert!((segments[1].position - 885.0).abs() < 0.001);
        assert_eq!(sequence_from_url(&segments[1].url), Some(177));

        // 번호를 못 읽으면 실제 시각으로 대신 계산한다.
        let no_sequence = "#EXTM3U\n\
             #EXT-X-TARGETDURATION:5\n\
             #EXT-X-PROGRAM-DATE-TIME:2026-08-01T09:10:55+00:00\n\
             #EXTINF:5.0,\n\
             https://example.com/seg1.ts\n";
        let fallback = parse_hls_playlist(no_sequence, Some(release));
        assert!((fallback[0].position - 455.0).abs() < 0.001);
    }

    #[test]
    fn reads_live_sources_for_dash_and_hls() {
        let dash = json!({
            "requested_formats": [
                {"format_id": "315", "protocol": "http_dash_segments_generator",
                 "url": "https://example.com/videoplayback?x=1", "target_duration": 5, "ext": "webm",
                 "vcodec": "vp9", "acodec": "none"},
                {"format_id": "140", "protocol": "http_dash_segments_generator",
                 "url": "https://example.com/audio?x=1", "target_duration": 5, "ext": "m4a",
                 "vcodec": "none", "acodec": "mp4a.40.2"}
            ]
        });
        let sources = live_sources_from_formats(&dash);
        assert_eq!(sources.len(), 2);
        assert!(sources[0].has_video);
        assert!(matches!(
            sources[0].kind,
            LiveSourceKind::Dash { target_seconds } if target_seconds == 5.0
        ));
        assert_eq!(
            sources[0].fragment_url(7),
            "https://example.com/videoplayback?x=1&sq=7"
        );

        // 영상+음성이 한 스트림인 HLS는 최상위 정보를 쓴다.
        let hls = json!({
            "protocol": "m3u8_native",
            "url": "https://example.com/index.m3u8",
            "ext": "mp4",
            "vcodec": "avc1.64002A",
            "acodec": "mp4a.40.2"
        });
        let sources = live_sources_from_formats(&hls);
        assert_eq!(sources.len(), 1);
        assert!(matches!(sources[0].kind, LiveSourceKind::Hls));
        assert_eq!(sources[0].ext, "ts");

        // 조각 방식이 아니면 쓸 수 없다.
        let progressive = json!({"protocol": "https", "url": "https://example.com/video.mp4"});
        assert!(live_sources_from_formats(&progressive).is_empty());
    }

    #[test]
    fn reads_live_fragment_length_from_formats() {
        let value = json!({
            "formats": [
                {"format_id": "140", "protocol": "http_dash_segments_generator", "target_duration": 5},
                {"format_id": "18", "protocol": "https"}
            ]
        });
        assert_eq!(fragment_seconds_from_formats(&value), Some(5.0));
        assert_eq!(fragment_seconds_from_formats(&json!({"formats": []})), None);
    }
}
