//! yt-dlp가 준 메타데이터 해석과 내 채널 목록 불러오기.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::live::{header_number, live_sources_from_formats, LiveSourceKind};
use crate::server::{LibraryRequest, LibraryResponse};
use crate::tools::{add_cookie_args, yt_dlp_command};

#[derive(Debug, Serialize)]
pub(crate) struct LibraryItem {
    pub(crate) id: Option<String>,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) duration: Option<f64>,
    pub(crate) thumbnail: Option<String>,
    pub(crate) live_status: Option<String>,
}

pub(crate) async fn load_channel_library(
    exe: &Path,
    req: &LibraryRequest,
    browser: Option<&str>,
    channel_id: &str,
) -> Result<LibraryResponse> {
    let mut response = LibraryResponse {
        videos: Vec::new(),
        shorts: Vec::new(),
        lives: Vec::new(),
    };

    for item in load_optional_library_tab(
        exe,
        req,
        browser,
        &format!("https://www.youtube.com/channel/{channel_id}/videos"),
    )
    .await?
    {
        push_unique_library_item(&mut response.videos, item);
    }

    for item in load_optional_library_tab(
        exe,
        req,
        browser,
        &format!("https://www.youtube.com/channel/{channel_id}/shorts"),
    )
    .await?
    {
        push_unique_library_item(&mut response.shorts, item);
    }

    for item in load_optional_library_tab(
        exe,
        req,
        browser,
        &format!("https://www.youtube.com/channel/{channel_id}/streams"),
    )
    .await?
    {
        push_unique_library_item(&mut response.lives, item);
    }

    Ok(response)
}

pub(crate) async fn load_optional_library_tab(
    exe: &Path,
    req: &LibraryRequest,
    browser: Option<&str>,
    url: &str,
) -> Result<Vec<LibraryItem>> {
    match load_library_playlist(exe, req, browser, url).await {
        Ok(items) => Ok(items),
        Err(err) if is_missing_youtube_tab_error(&err.to_string()) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

pub(crate) async fn load_library_playlist(
    exe: &Path,
    req: &LibraryRequest,
    browser: Option<&str>,
    url: &str,
) -> Result<Vec<LibraryItem>> {
    let mut cmd = yt_dlp_command(exe);
    cmd.args([
        "--ignore-config",
        "--no-update",
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-end",
        "80",
        "--skip-download",
        "--no-warnings",
    ]);
    add_cookie_args(
        &mut cmd,
        browser,
        req.cookies_profile.as_deref(),
        req.cookies_file.as_deref(),
    )?;
    cmd.arg(url);

    let output = cmd
        .output()
        .await
        .context("yt-dlp library command failed to start")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(yt_dlp_error("library load failed", &stderr));
    }

    let value: Value =
        serde_json::from_slice(&output.stdout).context("yt-dlp returned invalid library JSON")?;
    Ok(value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(library_item)
        .collect())
}

pub(crate) async fn discover_owned_channel_id(
    cookies_file: Option<&str>,
) -> Result<Option<String>> {
    let Some(cookies_file) = cookies_file
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(cookie_header) = cookie_header_from_netscape_file(cookies_file)? else {
        return Ok(None);
    };

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .context("could not create HTTP client")?;
    let html = client
        .get("https://www.youtube.com/account_advanced")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        )
        .header(reqwest::header::COOKIE, cookie_header)
        .send()
        .await
        .context("could not load YouTube account page")?
        .text()
        .await
        .context("could not read YouTube account page")?;

    Ok(extract_owned_channel_id(&html))
}

pub(crate) fn cookie_header_from_netscape_file(path: &str) -> Result<Option<String>> {
    let text =
        fs::read_to_string(path).with_context(|| format!("could not read cookies file {path}"))?;
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let _domain = fields.next();
        let _include_subdomains = fields.next();
        let _path = fields.next();
        let _secure = fields.next();
        let _expires = fields.next();
        let Some(name) = fields.next() else {
            continue;
        };
        let Some(value) = fields.next() else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        pairs.push(format!("{name}={value}"));
    }

    Ok((!pairs.is_empty()).then(|| pairs.join("; ")))
}

pub(crate) fn extract_owned_channel_id(html: &str) -> Option<String> {
    [
        "\"shortUrl\":\"",
        "\\\"shortUrl\\\":\\\"",
        "https://www.youtube.com/channel/",
        "https:\\/\\/www.youtube.com\\/channel\\/",
    ]
    .iter()
    .find_map(|marker| extract_channel_id_after_marker(html, marker))
}

pub(crate) fn extract_channel_id_after_marker(html: &str, marker: &str) -> Option<String> {
    let mut offset = 0;
    while let Some(pos) = html[offset..].find(marker) {
        let start = offset + pos + marker.len();
        let candidate: String = html[start..].chars().take(24).collect();
        if is_youtube_channel_id(&candidate) {
            return Some(candidate);
        }
        offset = start;
    }
    None
}

pub(crate) fn is_youtube_channel_id(value: &str) -> bool {
    value.len() == 24
        && value.starts_with("UC")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub(crate) fn is_missing_youtube_tab_error(message: &str) -> bool {
    message.contains("This channel does not have a shorts tab")
        || message.contains("This channel does not have a streams tab")
        || message.contains("This channel does not have a live tab")
        || message.contains("This channel does not have a videos tab")
}

pub(crate) fn library_response_is_empty(response: &LibraryResponse) -> bool {
    response.videos.is_empty() && response.shorts.is_empty() && response.lives.is_empty()
}

pub(crate) fn push_unique_library_item(items: &mut Vec<LibraryItem>, item: LibraryItem) {
    if items.iter().any(|existing| {
        existing.url == item.url || (existing.id.is_some() && existing.id == item.id)
    }) {
        return;
    }
    items.push(item);
}

// 진행 중인 라이브에서 지금 받을 수 있는 마지막 지점.
// 조각 응답 헤더가 "라이브 끝 조각 번호와 그 시각"을 알려준다.
pub(crate) async fn live_edge_seconds(value: &Value) -> Option<f64> {
    if value_str(value, "live_status").as_deref() != Some("is_live") {
        return None;
    }
    let source = live_sources_from_formats(value)
        .into_iter()
        .find(|source| matches!(source.kind, LiveSourceKind::Dash { .. }))?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
        .ok()?;
    // 헤더만 필요하므로 앞부분만 요청한다.
    let response = client
        .get(source.fragment_url(0))
        .header("Range", "bytes=0-1")
        .send()
        .await
        .ok()?;
    header_number(response.headers(), "X-Head-Time-Millis").map(|value| value / 1000.0)
}

// 화질 선택칸에서 실제로 받을 수 있는 최대 화질만 보여주기 위한 값.
pub(crate) fn available_max_height(value: &Value) -> Option<f64> {
    let formats = value.get("formats")?.as_array()?;
    formats
        .iter()
        .filter(|format| {
            format
                .get("vcodec")
                .and_then(Value::as_str)
                .map(|codec| codec != "none")
                .unwrap_or(false)
        })
        .filter_map(|format| format.get("height").and_then(Value::as_f64))
        .fold(None, |best: Option<f64>, height| {
            Some(best.map_or(height, |best| best.max(height)))
        })
}

pub(crate) fn validate_url(url: &str) -> Result<()> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(anyhow!("URL must start with http:// or https://"));
    }
    Ok(())
}

pub(crate) fn yt_dlp_error(prefix: &str, stderr: &str) -> anyhow::Error {
    let detail = if stderr.trim().is_empty() {
        "yt-dlp exited with an error"
    } else {
        stderr.trim()
    };

    if detail.contains("Could not copy Chrome cookie database") || detail.contains("issues/7271") {
        return anyhow!(
            "{prefix}: Chrome/Edge/Brave가 쿠키 DB를 잠가서 로그인 쿠키를 읽지 못했습니다. \
앱의 '브라우저 종료' 버튼으로 선택 브라우저를 완전히 종료한 뒤 다시 시도하거나, Firefox를 로그인 브라우저로 사용하세요. \
이미 Netscape 형식 cookies.txt가 있으면 쿠키 파일 경로에 넣으면 브라우저 쿠키 읽기를 건너뜁니다. 원문: {detail}"
        );
    }

    if detail.contains("No video formats found") {
        return anyhow!(
            "{prefix}: YouTube가 이 계정/세션에 다운로드 가능한 영상 스트림을 반환하지 않았습니다. \
앱 로그인 창에서 같은 영상 URL이 실제로 재생되는지 확인하세요. 재생되지 않으면 해당 계정에 권한이 없거나 영상/라이브 상태 문제입니다. \
재생된다면 '로그인 적용'을 다시 눌러 쿠키 파일을 갱신한 뒤 재시도하세요. 원문: {detail}"
        );
    }

    anyhow!("{prefix}: {detail}")
}

pub(crate) fn value_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn metadata_duration(value: &Value) -> Option<f64> {
    if let Some(duration) = value.get("duration").and_then(Value::as_f64) {
        if duration > 0.0 {
            return Some(duration);
        }
    }

    let live_status = value_str(value, "live_status")?;
    if !matches!(live_status.as_str(), "is_live" | "post_live" | "was_live") {
        return None;
    }

    let start = value
        .get("release_timestamp")
        .or_else(|| value.get("timestamp"))
        .and_then(Value::as_f64)?;
    let end = value
        .get("epoch")
        .and_then(Value::as_f64)
        .unwrap_or_else(current_unix_timestamp);

    (end > start).then_some(end - start)
}

pub(crate) fn current_unix_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

pub(crate) fn library_item(value: &Value) -> Option<LibraryItem> {
    let title = value_str(value, "title")?;
    if title == "[Deleted video]" || title == "[Private video]" {
        return None;
    }

    let id = value_str(value, "id");
    let url = value_str(value, "webpage_url")
        .or_else(|| value_str(value, "url"))
        .or_else(|| {
            id.as_ref()
                .map(|id| format!("https://www.youtube.com/watch?v={id}"))
        })?;

    Some(LibraryItem {
        id,
        title,
        url,
        duration: value.get("duration").and_then(Value::as_f64),
        thumbnail: value_str(value, "thumbnail").or_else(|| thumbnail_from_array(value)),
        live_status: value_str(value, "live_status"),
    })
}

pub(crate) fn thumbnail_from_array(value: &Value) -> Option<String> {
    value
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("url"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(crate) enum LibraryKind {
    Video,
    Short,
    Live,
}

pub(crate) fn library_kind(item: &LibraryItem) -> LibraryKind {
    if item
        .live_status
        .as_deref()
        .map(|status| status.contains("live") || status.contains("upcoming"))
        .unwrap_or(false)
    {
        return LibraryKind::Live;
    }

    if item.url.contains("/shorts/")
        || item
            .duration
            .map(|duration| duration > 0.0 && duration <= 61.0)
            .unwrap_or(false)
    {
        return LibraryKind::Short;
    }

    LibraryKind::Video
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn estimates_active_live_duration_from_timestamps() {
        let value = json!({
            "duration": null,
            "live_status": "is_live",
            "release_timestamp": 1000.0,
            "epoch": 4600.0
        });
        assert_eq!(metadata_duration(&value), Some(3600.0));
    }

    #[test]
    fn extracts_owned_channel_id_from_account_html() {
        let html = r#"{"copyLinkCommand":{"shortUrl":"UCgO9qWNRUzHIeRQNwmyyR0g"}}"#;
        assert_eq!(
            extract_owned_channel_id(html),
            Some("UCgO9qWNRUzHIeRQNwmyyR0g".to_string())
        );

        let escaped = r#"{\"shortUrl\":\"UCgO9qWNRUzHIeRQNwmyyR0g\"}"#;
        assert_eq!(
            extract_owned_channel_id(escaped),
            Some("UCgO9qWNRUzHIeRQNwmyyR0g".to_string())
        );
    }
}
