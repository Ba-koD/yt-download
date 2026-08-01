//! 빌드 시 `tools/<target>/` 의 도구들을 압축해서 실행 파일 안에 넣는다.
//!
//! 그대로 넣으면 300MB가 넘어가서, gzip으로 줄여(약 42%) 담고 첫 실행 때 풀어 쓴다.
//! `YT_DOWNLOAD_EMBED_TOOLS=0` 이면 넣지 않는다(개발 중 빌드 속도용).

use std::{
    env,
    fs::{self, File},
    io::{BufReader, BufWriter},
    path::{Path, PathBuf},
};

use flate2::{write::GzEncoder, Compression};

fn main() {
    let target = env::var("TARGET").expect("TARGET is set by Cargo");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let tools_dir = manifest_dir.join("tools").join(&target);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));

    check_version(&manifest_dir);

    println!("cargo:rerun-if-env-changed=YT_DOWNLOAD_EMBED_TOOLS");
    println!("cargo:rerun-if-changed={}", tools_dir.display());

    let enabled = env::var("YT_DOWNLOAD_EMBED_TOOLS")
        .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true);

    let mut entries = Vec::new();
    if enabled {
        for name in tool_names(&target) {
            let path = tools_dir.join(name);
            if !path.is_file() {
                continue;
            }
            println!("cargo:rerun-if-changed={}", path.display());
            let packed = compress_tool(name, &path, &out_dir);
            entries.push(format!(
                "    EmbeddedTool {{ name: {:?}, size: {}, packed: include_bytes!(r#\"{}\"#) }},",
                name,
                fs::metadata(&path).expect("tool metadata").len(),
                packed.display()
            ));
        }
    }

    write_tools_module(&out_dir, &target, &entries);
}

/// 버전의 단일 출처는 `VERSION` 파일이다. `Cargo.toml` 과 어긋나면 빌드를 세운다.
///
/// 릴리스 스크립트가 둘을 같이 고치지만, 손으로 한쪽만 고치는 일이 흔해서 여기서 막는다.
fn check_version(manifest_dir: &Path) {
    let version_file = manifest_dir.join("VERSION");
    println!("cargo:rerun-if-changed={}", version_file.display());

    let declared = match fs::read_to_string(&version_file) {
        Ok(text) => text.trim().to_string(),
        Err(err) => {
            println!("cargo:warning=VERSION 파일을 읽지 못했습니다: {err}");
            return;
        }
    };
    let manifest = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    assert!(
        declared == manifest,
        "VERSION({declared}) 과 Cargo.toml({manifest}) 의 버전이 다릅니다. \
         scripts/release.ps1 (또는 release.sh) 로 버전을 올리세요."
    );
}

fn write_tools_module(out_dir: &Path, target: &str, entries: &[String]) {
    let mut code = String::new();
    code.push_str("/// 실행 파일에 담긴 도구 하나. `packed`는 gzip으로 줄인 내용이다.\n");
    code.push_str("pub struct EmbeddedTool {\n");
    code.push_str("    pub name: &'static str,\n");
    code.push_str("    /// 압축을 푼 뒤의 크기(이미 풀어둔 파일인지 확인할 때 쓴다).\n");
    code.push_str("    pub size: u64,\n");
    code.push_str("    pub packed: &'static [u8],\n");
    code.push_str("}\n\n");
    code.push_str(&format!("pub const EMBEDDED_TARGET: &str = {target:?};\n"));
    code.push_str("pub const EMBEDDED_TOOLS: &[EmbeddedTool] = &[\n");
    for entry in entries {
        code.push_str(entry);
        code.push('\n');
    }
    code.push_str("];\n");

    fs::write(out_dir.join("embedded_tools.rs"), code).expect("write generated module");
}

fn tool_names(target: &str) -> Vec<&'static str> {
    if target.contains("windows") {
        vec!["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe"]
    } else {
        vec!["yt-dlp", "ffmpeg", "ffprobe", "deno"]
    }
}

/// 도구를 gzip으로 줄여 OUT_DIR에 둔다. 원본이 그대로면 다시 압축하지 않는다.
fn compress_tool(name: &str, path: &Path, out_dir: &Path) -> PathBuf {
    let packed = out_dir.join(format!("{name}.gz"));
    let source_time = fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let packed_time = fs::metadata(&packed).and_then(|meta| meta.modified()).ok();
    if let (Some(source), Some(existing)) = (source_time, packed_time) {
        if existing >= source {
            return packed;
        }
    }

    let mut reader = BufReader::new(File::open(path).expect("open tool"));
    let writer = BufWriter::new(File::create(&packed).expect("create packed tool"));
    let mut encoder = GzEncoder::new(writer, Compression::default());
    std::io::copy(&mut reader, &mut encoder).expect("compress tool");
    encoder.finish().expect("finish compression");
    packed
}
