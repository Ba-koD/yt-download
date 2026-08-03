//! 받은 압축본을 푼다. 윈도우는 zip, 나머지는 tar.gz 다.

use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

use anyhow::{bail, Context, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    TarGz,
    /// 압축하지 않은 실행 파일 그 자체. 윈도우용 관리자가 이렇게 올라간다.
    Raw,
}

/// 자산 이름 끝을 보고 어떤 것인지 정한다.
///
/// 실행 파일 그 자체로 올라오는 것은 윈도우에서 `.exe`, 유닉스에서는 확장자가 없다.
/// 그 둘만 원문으로 보고, **모르는 확장자는 거절한다.** 아무거나 "실행 파일이겠지" 하고
/// 받아쓰면, 이름을 한쪽에서만 고쳤을 때 엉뚱한 것을 실행 파일 자리에 놓게 된다.
pub fn kind_of(name: &str) -> Result<Kind> {
    if name.ends_with(".zip") {
        Ok(Kind::Zip)
    } else if name.ends_with(".tar.gz") {
        Ok(Kind::TarGz)
    } else if name.ends_with(".exe") || !name.contains('.') {
        Ok(Kind::Raw)
    } else {
        bail!("모르는 자산 형식입니다: {name}")
    }
}

/// 압축을 `into` 아래에 푼다. 폴더 밖을 가리키는 경로는 거절한다.
///
/// 유닉스에서는 실행 권한을 지켜야 한다. 잃어버리면 새 실행 파일을 띄울 수 없다.
pub fn extract(archive: &[u8], kind: Kind, into: &Path) -> Result<()> {
    fs::create_dir_all(into)
        .with_context(|| format!("폴더를 만들지 못했습니다: {}", into.display()))?;
    match kind {
        Kind::Zip => extract_zip(archive, into),
        Kind::TarGz => extract_tar_gz(archive, into),
        // 압축하지 않은 실행 파일은 풀 것이 없다. 부르는 쪽이 그대로 써야 한다.
        Kind::Raw => bail!("압축본이 아닙니다"),
    }
}

fn extract_zip(archive: &[u8], into: &Path) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(archive)).context("압축을 열지 못했습니다")?;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .context("압축 안의 파일을 읽지 못했습니다")?;
        let Some(relative) = entry.enclosed_name() else {
            bail!("압축 안에 이상한 경로가 있습니다: {}", entry.name());
        };
        if relative
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            bail!(
                "압축 안에 폴더 밖을 가리키는 경로가 있습니다: {}",
                entry.name()
            );
        }

        let target = into.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        fs::write(&target, bytes)
            .with_context(|| format!("파일을 쓰지 못했습니다: {}", target.display()))?;

        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &[u8], into: &Path) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(archive));
    let mut tar = tar::Archive::new(decoder);
    // 실행 권한이 살아 있어야 새 실행 파일을 띄울 수 있다.
    tar.set_preserve_permissions(true);
    // tar 크레이트의 unpack 은 폴더 밖을 가리키는 경로를 스스로 거른다.
    tar.unpack(into).context("압축을 풀지 못했습니다")?;
    Ok(())
}

/// 푼 폴더 안에서 이름이 같은 파일을 찾는다(맨 위에 없을 수도 있다 — macOS 는 .app 안이다).
pub fn find_file(root: &Path, name: &str) -> Option<std::path::PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Some(path);
        }
    }
    dirs.into_iter().find_map(|dir| find_file(&dir, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in entries {
            use std::io::Write;
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn 압축_형식은_이름_끝으로_가린다() {
        assert_eq!(kind_of("a-windows-x64.zip").unwrap(), Kind::Zip);
        assert_eq!(kind_of("a-linux-x64.tar.gz").unwrap(), Kind::TarGz);
        // 압축하지 않고 올리는 것들 — 윈도우는 .exe, 유닉스는 확장자가 없다.
        assert_eq!(kind_of("a-windows-x64.exe").unwrap(), Kind::Raw);
        assert_eq!(kind_of("a-linux-x64").unwrap(), Kind::Raw);
        assert_eq!(kind_of("a-macos-arm64").unwrap(), Kind::Raw);
        // 모르는 확장자는 실행 파일 자리에 놓지 않는다.
        assert!(kind_of("a.7z").is_err());
        assert!(kind_of("a.tar.bz2").is_err());
    }

    #[test]
    fn 폴더_밖을_가리키는_경로는_거절한다() {
        let dir = temp("ytdl-update-outside");
        let archive = zip_of(&[("ok.txt", b"1"), ("../outside.txt", b"2")]);
        assert!(extract(&archive, Kind::Zip, &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn tar_gz_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, name, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    // 유닉스 자산은 tar.gz 다. 윈도우에서 개발하다 보면 이 길만 검사 없이 나가기 쉽다.
    #[test]
    fn tar_gz_도_같은_자리에_푼다() {
        let dir = temp("ytdl-update-targz");
        let archive = tar_gz_of(&[
            ("yt-download", b"binary" as &[u8]),
            ("nested/note.txt", b"hello"),
        ]);
        extract(&archive, Kind::TarGz, &dir).unwrap();
        assert_eq!(fs::read(dir.join("yt-download")).unwrap(), b"binary");
        assert_eq!(fs::read(dir.join("nested/note.txt")).unwrap(), b"hello");
        assert!(find_file(&dir, "yt-download").is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 깊이_들어_있는_실행_파일도_찾는다() {
        let dir = temp("ytdl-update-find");
        let archive = zip_of(&[
            ("yt-download.app/Contents/Info.plist", b"<plist/>"),
            ("yt-download.app/Contents/MacOS/yt-download", b"binary"),
        ]);
        extract(&archive, Kind::Zip, &dir).unwrap();
        let found = find_file(&dir, "yt-download").expect("찾지 못했습니다");
        assert!(found.ends_with("Contents/MacOS/yt-download"), "{found:?}");
        assert!(find_file(&dir, "없는파일").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
