//! 다운로드 작업 상태 보관과 갱신.

use std::{collections::HashMap, sync::atomic::AtomicBool, sync::Arc};

use anyhow::{anyhow, Result};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::media::{probe_media_duration, probe_video_quality};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct JobStatus {
    pub(crate) id: String,
    pub(crate) state: JobState,
    pub(crate) message: String,
    pub(crate) output_dir: String,
    pub(crate) output_path: Option<String>,
    pub(crate) progress: Option<f64>,
    pub(crate) speed: Option<String>,
    pub(crate) eta: Option<String>,
    pub(crate) log: Vec<String>,
    // 진행 중인 라이브 녹화는 사용자가 멈춰야 끝나므로 중지 플래그를 잡업과 함께 들고 다닌다.
    #[serde(skip)]
    pub(crate) cancel: Arc<AtomicBool>,
}

pub(crate) async fn finish_download_job(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    section_duration: Option<f64>,
) -> Result<()> {
    // yt-dlp가 성공으로 끝나도 스트림이 도중에 끊겨 일부만 저장될 수 있다(라이브 종료 직후 등).
    // 구간 다운로드는 결과 파일 길이를 확인해서 잘린 파일을 "완료"로 표시하지 않는다.
    if let Some(expected) = section_duration {
        let output_path = job_output_path(jobs, job_id).await;
        if let Some(path) = output_path {
            if let Some(actual) = probe_media_duration(&path).await {
                if expected - actual > 5.0 && actual < expected * 0.9 {
                    return Err(anyhow!(
                        "요청한 구간은 {:.0}초인데 {:.0}초 분량만 저장되었습니다. \
라이브 종료 직후 유튜브가 다시보기를 처리하는 중이면 이렇게 잘릴 수 있습니다. \
시간이 지난 뒤 다시 시도하세요. (일부만 저장된 파일: {path})",
                        expected,
                        actual
                    ));
                }
            }
        }
    }

    // 실제로 받은 화질을 알려줘야 "왜 4K가 아니지?" 같은 상황을 바로 알 수 있다.
    let quality = match job_output_path(jobs, job_id).await {
        Some(path) => probe_video_quality(&path).await,
        None => None,
    };
    update_job(jobs, job_id, |job| {
        job.state = JobState::Done;
        job.message = match &quality {
            Some(quality) => format!("완료 · {quality}"),
            None => "완료".to_string(),
        };
        job.progress = Some(100.0);
        job.speed = None;
        job.eta = None;
    })
    .await;
    Ok(())
}

pub(crate) async fn job_output_path(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
) -> Option<String> {
    let jobs = jobs.lock().await;
    jobs.get(job_id).and_then(|job| job.output_path.clone())
}

pub(crate) async fn job_log_contains(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
    needle: &str,
) -> bool {
    let jobs = jobs.lock().await;
    jobs.get(job_id)
        .map(|job| job.log.iter().any(|line| line.contains(needle)))
        .unwrap_or(false)
}

pub(crate) async fn update_job<F>(
    jobs: &Arc<Mutex<HashMap<String, JobStatus>>>,
    id: &str,
    update: F,
) where
    F: FnOnce(&mut JobStatus),
{
    let mut jobs = jobs.lock().await;
    if let Some(job) = jobs.get_mut(id) {
        update(job);
    }
}

pub(crate) fn push_log(job: &mut JobStatus, line: String) {
    job.log.push(line);
    if job.log.len() > 250 {
        let overflow = job.log.len() - 250;
        job.log.drain(0..overflow);
    }
}
