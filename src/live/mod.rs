//! 진행 중인 라이브 처리.
//!
//! - [`source`]: 조각 주소와 시간 기준 확인
//! - [`fetch`]: 원하는 구간의 조각만 받아 잘라내기
//! - [`capture`]: 조각을 못 받을 때 쓰는 예전 방식(처음부터 받기)

pub(crate) mod capture;
pub(crate) mod fetch;
pub(crate) mod source;

pub(crate) use capture::{
    capture_covered_seconds, capture_output_path, run_live_capture, CaptureCtx, CaptureStream,
};
pub(crate) use fetch::{header_number, live_capture_dir};
pub(crate) use source::{live_sources_from_formats, probe_target, LiveSourceKind, TargetInfo};
