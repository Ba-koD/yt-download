//! 관리자가 기억해야 할 몇 가지. 창을 닫아도, 로그인 자동 확인이 창 없이 돌 때도 읽는다.
//!
//! 창에서 고른 브라우저와 "로그인 시 자동 확인" 여부를 여기 담는다.
//! 자동 확인은 창을 띄우지 않고 도므로, 무엇을 열어야 할지 이 파일에서만 알 수 있다.

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    /// 확장을 넣어 둔 브라우저 키(chrome, edge …). changelog 를 그 브라우저로 연다.
    #[serde(default)]
    pub browser: Option<String>,
    /// 로그인할 때 관리자가 창 없이 한 번 업데이트를 확인하는지.
    #[serde(default)]
    pub auto_update: bool,
}

fn path() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("yt-download")
        .join("manager.json")
}

impl Config {
    /// 없거나 깨졌으면 기본값. 설정을 못 읽었다고 관리자가 안 뜨면 안 된다.
    pub fn load() -> Self {
        fs::read(path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }
}
