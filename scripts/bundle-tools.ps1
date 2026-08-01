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

foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
  $source = Resolve-RealPath $tool
  Write-Host "Copying $tool from $source"
  Copy-Item -LiteralPath $source -Destination (Join-Path $toolsDir $tool) -Force
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
