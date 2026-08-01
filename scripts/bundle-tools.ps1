param(
  [string]$Target = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Get-HostTriple {
  $line = rustc -vV | Select-String '^host:'
  if (-not $line) { throw "Could not determine Rust host triple" }
  return ($line.ToString().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[1])
}

function Resolve-RealPath([string]$CommandName) {
  $command = Get-Command $CommandName -ErrorAction Stop
  $item = Get-Item $command.Source
  if ($item.LinkType -and $item.Target) {
    return [string]$item.Target[0]
  }
  return $item.FullName
}

if (-not $Target) {
  $Target = Get-HostTriple
}

if (-not $Target.Contains("windows")) {
  throw "This PowerShell helper currently bundles Windows tools. Use scripts/bundle-tools.sh on macOS/Linux."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$toolsDir = Join-Path $root "tools\$Target"
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$ytDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
$ytDlpPath = Join-Path $toolsDir "yt-dlp.exe"
Write-Host "Downloading yt-dlp: $ytDlpUrl"
Invoke-WebRequest -Uri $ytDlpUrl -OutFile $ytDlpPath

$denoUrl = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
$denoZip = Join-Path $env:TEMP "deno-x86_64-pc-windows-msvc.zip"
Write-Host "Downloading Deno: $denoUrl"
Invoke-WebRequest -Uri $denoUrl -OutFile $denoZip
Expand-Archive -LiteralPath $denoZip -DestinationPath $toolsDir -Force

# ffmpeg/ffprobe 는 정적 빌드를 받아온다.
# PATH 의 것을 복사하면 그 PC 에 깔린 DLL 에 묶일 수 있어 다른 PC 에서 안 돈다.
$ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
$ffmpegZip = Join-Path $env:TEMP "ffmpeg-win64-gpl.zip"
$ffmpegDir = Join-Path $env:TEMP "ffmpeg-win64-gpl"
$downloaded = $false
try {
  Write-Host "Downloading ffmpeg: $ffmpegUrl"
  Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip
  Remove-Item -Recurse -Force $ffmpegDir -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegDir -Force
  foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
    $found = Get-ChildItem -Path $ffmpegDir -Filter $tool -Recurse | Select-Object -First 1
    if (-not $found) { throw "$tool 이 압축 안에 없습니다" }
    Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $toolsDir $tool) -Force
  }
  $downloaded = $true
} catch {
  Write-Warning "정적 ffmpeg 를 받지 못했습니다: $($_.Exception.Message)"
} finally {
  Remove-Item -Force $ffmpegZip -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $ffmpegDir -ErrorAction SilentlyContinue
}

if (-not $downloaded) {
  # 받지 못하면 PATH 의 것으로 때운다(그 PC 안에서는 동작한다).
  foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
    $source = Resolve-RealPath $tool
    Write-Warning "정적 빌드 대신 PATH 의 $tool 을 씁니다 ($source). 다른 PC 에서는 안 돌 수 있습니다."
    Copy-Item -LiteralPath $source -Destination (Join-Path $toolsDir $tool) -Force
  }
}

if (-not $SkipBuild) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & cargo build --release 2>&1 | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) { throw "cargo build failed ($code)" }
}

Write-Host "Bundled tools in $toolsDir"
