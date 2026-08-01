<#
.SYNOPSIS
  yt-download 을 사용자 계정에 설치한다(관리자 권한 필요 없음).

.DESCRIPTION
  실행 파일을 %LOCALAPPDATA%\Programs\yt-download 로 복사하고
  시작 메뉴(원하면 바탕화면)에 바로가기를 만든다. 제거 스크립트도 같이 둔다.

.PARAMETER Exe
  설치할 실행 파일. 없으면 dist\ 또는 target\release\ 에서 찾는다.

.PARAMETER Desktop
  바탕화면에도 바로가기를 만든다.

.PARAMETER Uninstall
  설치된 파일과 바로가기를 지운다.
#>
param(
  [string]$Exe = "",
  [switch]$Desktop,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$appName = "yt-download"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\$appName"
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$appName.lnk"
$desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "$appName.lnk"

if ($Uninstall) {
  foreach ($link in @($startMenu, $desktopLink)) {
    if (Test-Path $link) { Remove-Item $link -Force; Write-Host "바로가기 삭제: $link" }
  }
  if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force; Write-Host "설치 폴더 삭제: $installDir" }
  Write-Host "제거했습니다. 받아둔 영상과 설정은 그대로 있습니다."
  Write-Host "도구 캐시까지 지우려면: $env:LOCALAPPDATA\$appName"
  return
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $Exe) {
  foreach ($candidate in @("dist\yt-download.exe", "target\release\yt-download.exe")) {
    $path = Join-Path $root $candidate
    if (Test-Path $path) { $Exe = $path; break }
  }
}
if (-not $Exe -or -not (Test-Path $Exe)) {
  throw "설치할 실행 파일을 찾지 못했습니다. 먼저 scripts\build-portable.ps1 을 실행하세요."
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$targetExe = Join-Path $installDir "$appName.exe"

# 실행 중이면 덮어쓸 수 없다.
Get-Process $appName -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "실행 중인 $appName 을 종료합니다"
  $_ | Stop-Process -Force
  Start-Sleep -Milliseconds 700
}

Copy-Item $Exe $targetExe -Force
Copy-Item (Join-Path $PSScriptRoot "install.ps1") (Join-Path $installDir "uninstall.ps1") -Force

$shell = New-Object -ComObject WScript.Shell
foreach ($link in @($startMenu) + $(if ($Desktop) { @($desktopLink) } else { @() })) {
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $targetExe
  $shortcut.WorkingDirectory = $installDir
  $shortcut.Description = "YouTube 구간 다운로드"
  $shortcut.Save()
  Write-Host "바로가기: $link"
}

$size = [math]::Round((Get-Item $targetExe).Length / 1MB, 1)
Write-Host ""
Write-Host "설치 완료: $targetExe ($size MB)"
Write-Host "제거하려면: powershell -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`" -Uninstall"
