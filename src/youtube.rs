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
use crate::tools::{add_cookie_args, add_js_runtime, yt_dlp_command};

/// 한 번에 읽어올 목록 개수. 올릴수록 오래 걸린다(200개에 약 3초).
pub(crate) const LIBRARY_PAGE_SIZE: &str = "200";

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

    // 두 곳을 합쳐야 목록이 온전해진다.
    //
    // - 업로드 재생목록(UU…): 비공개·일부공개까지 들어 있지만 최근 것부터 섞여 나온다.
    //   방송을 자주 하는 채널이면 앞쪽이 전부 스트림이라 동영상이 몇 개 안 걸린다.
    // - 채널 탭(videos/shorts/streams): 종류별로 나뉘어 있어 각 칸을 채워주지만 공개된 것만 나온다.
    //
    // 넷을 동시에 읽고 겹치는 것은 버린다.
    let base = format!("https://www.youtube.com/channel/{channel_id}");
    let uploads_url = uploads_playlist_id(channel_id)
        .map(|uploads| format!("https://www.youtube.com/playlist?list={uploads}"));
    let videos_url = format!("{base}/videos");
    let shorts_url = format!("{base}/shorts");
    let streams_url = format!("{base}/streams");

    let (uploads, videos, shorts, lives) = tokio::join!(
        async {
            match &uploads_url {
                Some(url) => load_optional_library_tab(exe, req, browser, url).await,
                None => Ok(Vec::new()),
            }
        },
        load_optional_library_tab(exe, req, browser, &videos_url),
        load_optional_library_tab(exe, req, browser, &shorts_url),
        load_optional_library_tab(exe, req, browser, &streams_url),
    );

    // 업로드 재생목록이 먼저다. 비공개 영상이 목록 위쪽에 오도록.
    for item in uploads? {
        match library_kind(&item) {
            LibraryKind::Live => push_unique_library_item(&mut response.lives, item),
            LibraryKind::Short => push_unique_library_item(&mut response.shorts, item),
            LibraryKind::Video => push_unique_library_item(&mut response.videos, item),
        }
    }
    for item in videos? {
        push_unique_library_item(&mut response.videos, item);
    }
    for item in shorts? {
        push_unique_library_item(&mut response.shorts, item);
    }
    for item in lives? {
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

/// 채널의 업로드 재생목록 ID. `UC…` 채널 ID의 앞 두 글자만 `UU` 로 바꾼 것이다.
pub(crate) fn uploads_playlist_id(channel_id: &str) -> Option<String> {
    is_youtube_channel_id(channel_id).then(|| format!("UU{}", &channel_id[2..]))
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
        LIBRARY_PAGE_SIZE,
        "--skip-download",
        "--no-warnings",
    ]);
    // 유튜브는 요즘 목록을 읽을 때도 자바스크립트 실행을 요구한다.
    add_js_runtime(&mut cmd);
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
    let Some(cookie_header) = cookie_header_from_netscape_file(cookies_file, "www.youtube.com")?
    else {
        return Ok(None);
    };

    let cookie_count = cookie_header.split("; ").count();

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
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .context("could not load YouTube account page")?
        .text()
        .await
        .context("could not read YouTube account page")?;

    let channel_id = extract_owned_channel_id(&html);
    // 쿠키가 모자라면 유튜브는 로그아웃 페이지를 준다. 목록이 비었을 때 원인을 가리려면 이 셋을 같이 봐야 한다.
    eprintln!(
        "library: account page with {} cookies, signed in: {}, channel: {}",
        cookie_count,
        html.contains("\"LOGGED_IN\":true"),
        channel_id.as_deref().unwrap_or("(찾지 못함)")
    );
    Ok(channel_id)
}

/// 쿠키 파일에서 `host` 로 보낼 `Cookie` 헤더를 만든다.
///
/// 파일에는 google.com, google.co.kr, youtube.com 것이 섞여 있고 `SID` 같은 이름은
/// 도메인마다 값이 다르다. 전부 이어붙이면 같은 이름이 여러 번 들어가서 유튜브가
/// 아예 로그아웃 상태로 취급한다. 그래서 해당 호스트에 해당하는 것만 골라내고,
/// 이름이 겹치면 더 구체적인 도메인(길이가 긴 쪽)을 남긴다.
pub(crate) fn cookie_header_from_netscape_file(path: &str, host: &str) -> Result<Option<String>> {
    let text =
        fs::read_to_string(path).with_context(|| format!("could not read cookies file {path}"))?;
    let host = host.to_ascii_lowercase();

    // 이름 -> (고른 도메인, 값). 도메인이 더 긴 쪽이 이긴다.
    let mut chosen: Vec<(String, String, String)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let [domain, _include_subdomains, _path, _secure, _expires, name, value] = fields[..]
        else {
            continue;
        };
        if name.is_empty() || !cookie_domain_matches(domain, &host) {
            continue;
        }

        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        match chosen.iter_mut().find(|(existing, _, _)| existing == name) {
            Some((_, best_domain, best_value)) => {
                if domain.len() > best_domain.len() {
                    *best_domain = domain;
                    *best_value = value.to_string();
                }
            }
            None => chosen.push((name.to_string(), domain, value.to_string())),
        }
    }

    let pairs: Vec<String> = chosen
        .into_iter()
        .map(|(name, _, value)| format!("{name}={value}"))
        .collect();
    Ok((!pairs.is_empty()).then(|| pairs.join("; ")))
}

/// 넷스케이프 쿠키의 도메인이 이 호스트에 보내도 되는 것인지 본다.
/// `.youtube.com` 은 `www.youtube.com` 에 보내지만 `google.com` 에는 보내지 않는다.
pub(crate) fn cookie_domain_matches(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// 로그인한 계정의 채널 ID를 계정 페이지 HTML에서 찾는다.
///
/// 유튜브는 채널 주소를 절대 URL로 쓰지 않는다. 실제로 나오는 형태는
/// `"shortUrl":"UC…"`, `"browseId":"UC…"`, `"url":"/channel/UC…"` 셋이다.
pub(crate) fn extract_owned_channel_id(html: &str) -> Option<String> {
    [
        "\"shortUrl\":\"",
        "\\\"shortUrl\\\":\\\"",
        "\"browseId\":\"",
        "\\\"browseId\\\":\\\"",
        "/channel/",
        "\\/channel\\/",
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

    #[test]
    fn finds_channel_id_in_relative_urls_and_browse_ids() {
        // 유튜브가 실제로 내려주는 형태. 절대 URL은 나오지 않는다.
        let relative = r#""webCommandMetadata":{"url":"/channel/UCgO9qWNRUzHIeRQNwmyyR0g/posts"}"#;
        assert_eq!(
            extract_owned_channel_id(relative),
            Some("UCgO9qWNRUzHIeRQNwmyyR0g".to_string())
        );

        // 채널이 아닌 browseId("FEwhat_to_watch" 등)는 건너뛰고 진짜를 찾아야 한다.
        let browse = r#"{"browseId":"FEwhat_to_watch"},{"browseId":"UCgO9qWNRUzHIeRQNwmyyR0g"}"#;
        assert_eq!(
            extract_owned_channel_id(browse),
            Some("UCgO9qWNRUzHIeRQNwmyyR0g".to_string())
        );

        // "/channel/UC/livestreaming" 처럼 채널 ID가 아닌 것에 걸리면 안 된다.
        assert_eq!(
            extract_owned_channel_id(r#""url":"/channel/UC/live""#),
            None
        );
    }

    #[test]
    fn uploads_playlist_id_swaps_the_prefix() {
        assert_eq!(
            uploads_playlist_id("UCgO9qWNRUzHIeRQNwmyyR0g").as_deref(),
            Some("UUgO9qWNRUzHIeRQNwmyyR0g")
        );
        assert_eq!(uploads_playlist_id("not-a-channel"), None);
    }

    #[test]
    fn cookie_header_keeps_one_value_per_name() {
        // 같은 이름이 도메인마다 다른 값으로 들어 있는 실제 상황.
        // 전부 이어붙이면 유튜브가 로그아웃으로 본다.
        let file = concat!(
            ".google.com\tTRUE\t/\tFALSE\t0\tSID\tgoogle-value\n",
            ".google.co.kr\tTRUE\t/\tFALSE\t0\tSID\tkr-value\n",
            "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tyoutube-value\n",
            ".youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tinfo\n",
            "accounts.google.com\tFALSE\t/\tTRUE\t0\tLSID\tlsid\n",
        );
        let path = std::env::temp_dir().join("yt-download-cookie-test.txt");
        fs::write(&path, file).unwrap();

        let header = cookie_header_from_netscape_file(path.to_str().unwrap(), "www.youtube.com")
            .unwrap()
            .unwrap();
        assert_eq!(header, "SID=youtube-value; LOGIN_INFO=info");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn cookie_domains_only_match_their_own_host() {
        assert!(cookie_domain_matches(".youtube.com", "www.youtube.com"));
        assert!(cookie_domain_matches("www.youtube.com", "www.youtube.com"));
        assert!(!cookie_domain_matches(".google.com", "www.youtube.com"));
        assert!(!cookie_domain_matches(
            "accounts.google.com",
            "www.youtube.com"
        ));
        // "notyoutube.com" 이 "youtube.com" 에 붙으면 안 된다.
        assert!(!cookie_domain_matches("youtube.com", "wwwyoutube.com"));
    }
}
