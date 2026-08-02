<#
.SYNOPSIS
  도구를 모두 담은 단일 실행 파일(포터블)을 만든다.

.DESCRIPTION
  tools\<target>\ 에 yt-dlp, ffmpeg, ffprobe, deno 가 없으면 먼저 받아온다.
  빌드 결과는 dist\ 에 실행 파일 하나로 떨어지며, 그 파일만 옮겨도 동작한다.

.PARAMETER SkipTools
  도구 내려받기를 건너뛴다(이미 tools\ 에 있을 때).
#>
param(
  [switch]$SkipTools
)

$ErrorActionPreference = "Stop"

# cargo 는 진행 상황을 표준 오류로 내보낸다. PowerShell 이 그걸 오류로 보지 않도록 감싼다.
function Invoke-Cargo([string[]]$CargoArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & cargo @CargoArgs 2>&1 | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) { throw "cargo $($CargoArgs -join ' ') 실패 (코드 $code)" }
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$target = (rustc -vV | Select-String '^host:').ToString().Split(" ")[1]
$toolsDir = Join-Path $root "tools\$target"

if (-not $SkipTools) {
  $needed = @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe") |
    Where-Object { -not (Test-Path (Join-Path $toolsDir $_)) }
  if ($needed) {
    Write-Host "도구 준비 중: $($needed -join ', ')"
    & (Join-Path $PSScriptRoot "bundle-tools.ps1") -SkipBuild
  } else {
    Write-Host "도구가 이미 준비되어 있습니다: $toolsDir"
  }
}

Write-Host "빌드 중 (도구를 압축해 실행 파일에 담습니다. 몇 분 걸립니다)"
$env:YT_DOWNLOAD_EMBED_TOOLS = "1"
Invoke-Cargo @("build", "--release")

# 확장 관리자는 도구를 담지 않아 금방 빌드된다.
Invoke-Cargo @("build", "--release", "-p", "yt-download-extension-manager")

$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$exe = Join-Path $dist "yt-download.exe"
Copy-Item (Join-Path $root "target\release\yt-download.exe") $exe -Force
Copy-Item (Join-Path $root "target\release\yt-download-extension-manager.exe") `
  (Join-Path $dist "yt-download-extension-manager.exe") -Force

$hash = (Get-FileHash $exe -Algorithm SHA256).Hash
$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
"$hash  yt-download.exe" | Set-Content (Join-Path $dist "yt-download.exe.sha256") -Encoding ascii

Write-Host ""
Write-Host "완성: $exe  ($size MB)"
Write-Host "SHA256: $hash"
Write-Host "이 파일 하나만 복사해서 쓰면 됩니다. 처음 실행할 때 도구를 풀어내느라 몇 초 걸립니다."
Write-Host "Windows에는 Microsoft Edge WebView2 런타임이 필요합니다(대부분 이미 설치되어 있습니다)."
