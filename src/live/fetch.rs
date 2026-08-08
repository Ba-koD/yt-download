//! 필요한 구간의 조각만 골라 받아 하나로 잇는다.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use tokio::sync::Mutex;

use super::capture::capture_output_path;
use super::source::{parse_hls_playlist, HlsSegment, LiveSource, LiveSourceKind, TargetInfo};
use crate::download::{download_section_duration, DownloadRequest};
use crate::jobs::{finish_download_job, push_log, update_job, JobStatus};
use crate::media::{cut_media_inputs, format_time, probe_capture_stream};
use crate::tools::app_temp_dir;

// 조각을 동시에 몇 개까지 받을지.
pub(crate) const LIVE_FETCH_CONCURRENCY: usize = 8;

// 작업별 라이브 임시 폴더.
pub(crate) fn live_capture_dir(job_id: &str) -> PathBuf {
    app_temp_dir().join(format!("live-{job_id}"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_live_section_fetch(
    job_id: &str,
    req: &DownloadRequest,
    output_dir: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    info: &TargetInfo,
    cancel: &Arc<AtomicBool>,
    capture_dir: &Path,
    start: f64,
    end: f64,
) -> Result<()> {
    update_job(jobs, job_id, |job| {
        job.progress = Some(0.0);
        job.message = "라이브에서 필요한 구간만 골라 받는 중".to_string();
        push_log(
            job,
            format!(
                "direct live section: {} ~ {} (video {}, audio {})",
                format_time(start),
                format_time(end),
                info.live_sources
                    .iter()
                    .filter(|source| source.has_video)
                    .count(),
                info.live_sources
                    .iter()
                    .filter(|source| !source.has_video)
                    .count()
            ),
        );
    })
    .await;

    let files = fetch_live_section(job_id, jobs, cancel, info, capture_dir, start, end).await?;

    // 파일마다 "방송 몇 초 지점부터 담겼는지"가 달라서 잘라낼 때 각각 보정한다.
    let mut streams = Vec::new();
    let mut offsets = Vec::new();
    let mut covered = f64::INFINITY;
    for (path, offset, covered_end) in files {
        if let Some(stream) = probe_capture_stream(path).await {
            offsets.push(offset);
            streams.push(stream);
            covered = covered.min(covered_end);
        }
    }
    if streams.is_empty() {
        return Err(anyhow!("받은 조각을 읽지 못했습니다"));
    }

    // 방송이 아직 OUT 지점까지 오지 않았으면 받은 데까지만 자른다.
    let cut_end = end.min(covered);
    if cut_end <= start + 0.5 {
        return Err(anyhow!(
            "구간을 만들 만큼 받지 못했습니다 (확보한 길이 {})",
            format_time(covered)
        ));
    }
    let truncated = end - cut_end > 2.0;

    update_job(jobs, job_id, |job| {
        job.progress = Some(94.0);
        job.message = "구간을 잘라내는 중".to_string();
        if truncated {
            push_log(
                job,
                format!(
                    "live has not reached {} yet, cutting at {}",
                    format_time(end),
                    format_time(cut_end)
                ),
            );
        }
    })
    .await;

    let inputs: Vec<(PathBuf, f64)> = streams
        .iter()
        .zip(&offsets)
        .map(|(stream, offset)| (stream.path.clone(), *offset))
        .collect();
    let output_path = capture_output_path(
        output_dir,
        info,
        req,
        &streams,
        req.start_seconds,
        req.end_seconds,
    );
    cut_media_inputs(
        &inputs,
        &output_path,
        Some(start),
        Some(cut_end),
        req.accurate_cut,
    )
    .await?;

    let saved = output_path.to_string_lossy().to_string();
    update_job(jobs, job_id, |job| {
        job.output_path = Some(saved.clone());
    })
    .await;

    finish_download_job(
        jobs,
        job_id,
        download_section_duration(Some(start), Some(cut_end)),
    )
    .await?;
    if let Err(err) = tokio::fs::remove_dir_all(capture_dir).await {
        update_job(jobs, job_id, |job| {
            push_log(job, format!("could not clean capture directory: {err}"));
        })
        .await;
    }
    Ok(())
}

// 진행 중인 라이브에서 원하는 구간의 조각만 골라 받는다.
// 방송 처음부터 받을 필요가 없어서 몇 시간짜리 방송에서도 몇 초면 끝난다.
pub(crate) async fn fetch_live_section(
    job_id: &str,
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    cancel: &Arc<AtomicBool>,
    info: &TargetInfo,
    dir: &Path,
    start: f64,
    end: f64,
) -> Result<Vec<(PathBuf, f64, f64)>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
        .context("could not create http client")?;

    let mut outputs = Vec::new();
    // 영상/음성 스트림을 통틀어 받은 용량. 표시가 중간에 0으로 되돌아가지 않게 한다.
    let fetched_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
    for (index, source) in info.live_sources.iter().enumerate() {
        let stream_dir = dir.join(format!("stream{index}"));
        let _ = tokio::fs::remove_dir_all(&stream_dir).await;
        tokio::fs::create_dir_all(&stream_dir).await?;

        // 받을 조각 목록 / 파일이 시작하는 지점 / 어디까지 담기는지.
        let (targets, offset, covered_end) = match source.kind {
            LiveSourceKind::Dash { target_seconds } => {
                dash_fragment_plan(&client, source, target_seconds, start, end).await?
            }
            LiveSourceKind::Hls => {
                hls_fragment_plan(&client, source, info.release_timestamp, start, end).await?
            }
        };
        if targets.is_empty() {
            return Err(anyhow!("받을 조각이 없습니다"));
        }

        let total = targets.len();
        let done = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut tasks = futures_util::stream::iter(targets.into_iter().enumerate())
            .map(|(order, url)| {
                let client = client.clone();
                let stream_dir = stream_dir.clone();
                let done = done.clone();
                let fetched_bytes = fetched_bytes.clone();
                let jobs = jobs.clone();
                let job_id = job_id.to_string();
                let cancel = cancel.clone();
                async move {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(anyhow!("중지했습니다"));
                    }
                    let body = fetch_url(&client, &url).await?.0;
                    tokio::fs::write(stream_dir.join(format!("{order:08}.bin")), &body).await?;
                    let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                    let total_bytes =
                        fetched_bytes.fetch_add(body.len() as u64, Ordering::SeqCst)
                            + body.len() as u64;
                    update_job(&jobs, &job_id, |job| {
                        job.progress =
                            Some(((finished as f64 / total as f64) * 90.0).clamp(0.0, 90.0));
                        job.message =
                            format!("라이브 구간을 받는 중 {}", format_size(total_bytes));
                    })
                    .await;
                    Ok(())
                }
            })
            .buffer_unordered(LIVE_FETCH_CONCURRENCY);

        while let Some(result) = tasks.next().await {
            result?;
        }
        drop(tasks);

        // 받은 조각을 순서대로 이어붙이면 그대로 재생 가능한 파일이 된다.
        let output = dir.join(format!("live{index}.{}", source.ext));
        let target_path = output.clone();
        let source_dir = stream_dir.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut writer = fs::File::create(&target_path)?;
            let mut parts: Vec<PathBuf> = fs::read_dir(&source_dir)?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().map(|ext| ext == "bin").unwrap_or(false))
                .collect();
            parts.sort();
            for part in parts {
                let mut reader = fs::File::open(&part)?;
                std::io::copy(&mut reader, &mut writer)?;
            }
            Ok(())
        })
        .await??;

        let _ = tokio::fs::remove_dir_all(&stream_dir).await;
        outputs.push((output, offset, covered_end));
    }

    Ok(outputs)
}

// 받은 용량을 사람이 읽기 쉬운 단위로 표시한다.
fn format_size(bytes: u64) -> String {
    let bytes = bytes as f64;
    if bytes >= 1_000_000_000.0 {
        format!("{:.2} GB", bytes / 1_000_000_000.0)
    } else if bytes >= 1_000_000.0 {
        format!("{:.1} MB", bytes / 1_000_000.0)
    } else {
        format!("{:.0} KB", bytes / 1_000.0)
    }
}

// 조각을 몇 개 더 받아 시간 계산 오차를 흡수한다(조각 하나가 5초라 비용이 작다).
pub(crate) const DASH_FRAGMENT_MARGIN: i64 = 2;

// DASH: 0번 조각(초기화 정보) + 구간에 해당하는 번호들.
pub(crate) async fn dash_fragment_plan(
    client: &reqwest::Client,
    source: &LiveSource,
    target_seconds: f64,
    start: f64,
    end: f64,
) -> Result<(Vec<String>, f64, f64)> {
    let (_, headers) = fetch_url(client, &source.fragment_url(0)).await?;
    let head_sequence = header_number(&headers, "X-Head-Seqnum").map(|value| value as u64);
    let head_media = header_number(&headers, "X-Head-Time-Millis").map(|value| value / 1000.0);

    // 조각 하나의 실제 길이. 이름값(보통 5초)과 미세하게 달라서 몇 시간 지나면 몇 초씩 벌어진다.
    // 라이브 끝 조각의 번호와 시각을 알면 정확한 값을 구할 수 있다.
    let seconds_per_fragment = match (head_sequence, head_media) {
        (Some(head_seq), Some(head_media)) if head_seq > 0 => head_media / head_seq as f64,
        _ => target_seconds,
    };

    let first =
        (((start / seconds_per_fragment).floor() as i64) - DASH_FRAGMENT_MARGIN).max(0) as u64;
    let mut last =
        ((end / seconds_per_fragment).ceil() as i64 + DASH_FRAGMENT_MARGIN).max(0) as u64;
    if let Some(head) = head_sequence {
        if first > head {
            return Err(anyhow!(
                "아직 받을 수 있는 지점이 아닙니다. 지금은 {}까지만 받을 수 있습니다 \
(유튜브가 조각을 내주기까지 몇 분 걸립니다)",
                format_time(head as f64 * seconds_per_fragment)
            ));
        }
        last = last.min(head);
    }
    if last < first {
        return Err(anyhow!("받을 조각이 없습니다"));
    }

    // 0번 조각을 앞에 붙이면 파일 시간축이 영상 시작 기준이 된다.
    let mut urls = vec![source.fragment_url(0)];
    urls.extend((first..=last).map(|sequence| source.fragment_url(sequence)));
    // WebM 조각은 컨테이너에 길이가 안 적혀 있어서, 받은 번호로 확보 범위를 계산한다.
    let covered = (last as f64 * seconds_per_fragment).min(head_media.unwrap_or(f64::INFINITY));
    Ok((urls, 0.0, covered))
}

// HLS: 재생목록에서 구간에 걸치는 조각만 고른다.
pub(crate) async fn hls_fragment_plan(
    client: &reqwest::Client,
    source: &LiveSource,
    release_timestamp: Option<f64>,
    start: f64,
    end: f64,
) -> Result<(Vec<String>, f64, f64)> {
    let (body, _) = fetch_url(client, &source.url).await?;
    let text = String::from_utf8_lossy(&body);
    let segments = parse_hls_playlist(&text, release_timestamp);
    if segments.is_empty() {
        return Err(anyhow!("라이브 재생목록에서 조각을 찾지 못했습니다"));
    }

    let available_from = segments
        .first()
        .map(|segment| segment.position)
        .unwrap_or(0.0);
    let available_to = segments
        .last()
        .map(|segment| segment.position + segment.duration)
        .unwrap_or(0.0);
    let chosen: Vec<&HlsSegment> = segments
        .iter()
        .filter(|segment| segment.position + segment.duration > start && segment.position < end)
        .collect();
    if chosen.is_empty() {
        return Err(anyhow!(
            "요청한 구간이 유튜브에 남아 있는 범위를 벗어났습니다 (지금 받을 수 있는 구간: {} ~ {})",
            format_time(available_from.max(0.0)),
            format_time(available_to.max(0.0))
        ));
    }

    let offset = chosen[0].position;
    let covered_end = chosen
        .last()
        .map(|segment| segment.position + segment.duration)
        .unwrap_or(offset);
    Ok((
        chosen.iter().map(|segment| segment.url.clone()).collect(),
        offset,
        covered_end,
    ))
}

pub(crate) async fn fetch_url(
    client: &reqwest::Client,
    url: &str,
) -> Result<(Vec<u8>, reqwest::header::HeaderMap)> {
    let response = client
        .get(url)
        .send()
        .await
        .context("라이브 조각 요청 실패")?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("라이브 조각을 받지 못했습니다 (HTTP {status})"));
    }
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .context("라이브 조각 내려받기 실패")?;
    Ok((body.to_vec(), headers))
}

pub(crate) fn header_number(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}
