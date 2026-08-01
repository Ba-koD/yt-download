<#
.SYNOPSIS
  버전을 올리고 릴리스 태그를 만든다.

.DESCRIPTION
  VERSION, Cargo.toml, Cargo.lock, CHANGELOG.md 를 한꺼번에 맞추고
  커밋과 v<버전> 태그를 만든다. 태그를 밀면 GitHub Actions 가 빌드해서 릴리스로 올린다.

.PARAMETER Bump
  patch / minor / major 중 하나. 지금 버전에서 한 칸 올린다.

.PARAMETER Version
  올릴 버전을 직접 지정한다(예: 1.2.0). Bump 대신 쓴다.

.PARAMETER Push
  커밋과 태그를 origin 으로 바로 민다(= 릴리스 시작).

.EXAMPLE
  .\scripts\release.ps1 -Bump patch
  .\scripts\release.ps1 -Version 0.2.0 -Push
#>
param(
  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch",
  [string]$Version = "",
  [switch]$Push
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

# git 은 정상 동작 중에도 표준 오류로 말을 거는 일이 있어서 감싼다.
function Invoke-Git([string[]]$GitArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & git @GitArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) { throw "git $($GitArgs -join ' ') 실패 (코드 $code)`n$output" }
  return $output.Trim()
}

# PowerShell 5.1 의 Set-Content -Encoding utf8 은 BOM 을 붙인다.
# Cargo.toml 이나 CHANGELOG 에 BOM 이 들어가면 도구들이 싫어하므로 직접 쓴다.
function Write-Utf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

if (-not (Test-Path (Join-Path $root ".git"))) {
  throw "git 저장소가 아닙니다. 먼저 git init 을 하세요."
}
if (Invoke-Git @("status", "--porcelain")) {
  throw "커밋하지 않은 변경이 있습니다. 먼저 정리하세요."
}

$current = (Get-Content (Join-Path $root "VERSION") -Raw).Trim()
if ($Version) {
  $next = $Version.TrimStart("v")
} else {
  $parts = $current.Split(".")
  if ($parts.Count -ne 3) { throw "VERSION 형식이 x.y.z 가 아닙니다: $current" }
  $major, $minor, $patch = [int]$parts[0], [int]$parts[1], [int]$parts[2]
  switch ($Bump) {
    "major" { $major++; $minor = 0; $patch = 0 }
    "minor" { $minor++; $patch = 0 }
    "patch" { $patch++ }
  }
  $next = "$major.$minor.$patch"
}
if ($next -notmatch '^\d+\.\d+\.\d+$') { throw "버전 형식이 x.y.z 가 아닙니다: $next" }
if ($next -eq $current) { throw "지금 버전과 같습니다: $next" }

$tag = "v$next"
if (Invoke-Git @("tag", "--list", $tag)) { throw "태그가 이미 있습니다: $tag" }

Write-Host "$current -> $next"

# 1) VERSION — 단일 출처
Write-Utf8 (Join-Path $root "VERSION") "$next`n"

# 2) Cargo.toml 의 [package] 버전만 바꾼다(의존성 버전은 건드리지 않는다).
$manifestPath = Join-Path $root "Cargo.toml"
$manifest = [IO.File]::ReadAllText($manifestPath)
$versionLine = New-Object Text.RegularExpressions.Regex '(?m)^version = "[^"]+"\r?$'
if (-not $versionLine.IsMatch($manifest)) { throw "Cargo.toml 에서 version 줄을 찾지 못했습니다." }
Write-Utf8 $manifestPath $versionLine.Replace($manifest, "version = `"$next`"", 1)

# 3) CHANGELOG — Unreleased 아래에 새 칸을 만들고 비교 링크를 옮긴다.
$changelogPath = Join-Path $root "CHANGELOG.md"
$changelog = [IO.File]::ReadAllText($changelogPath)
$today = Get-Date -Format "yyyy-MM-dd"
if ($changelog -notmatch '(?m)^## \[Unreleased\]\s*$') { throw "CHANGELOG 에 ## [Unreleased] 가 없습니다." }

$linkPattern = New-Object Text.RegularExpressions.Regex '(?m)^\[Unreleased\]: (?<url>\S+)/compare/v[\d.]+\.\.\.HEAD\r?$'
$linkMatch = $linkPattern.Match($changelog)
if (-not $linkMatch.Success) { throw "CHANGELOG 아래쪽의 [Unreleased] 링크를 찾지 못했습니다." }
$repoUrl = $linkMatch.Groups["url"].Value

$changelog = [Text.RegularExpressions.Regex]::Replace(
  $changelog, '(?m)^## \[Unreleased\][^\S\r\n]*$', "## [Unreleased]`n`n## [$next] - $today")
$changelog = $linkPattern.Replace(
  $changelog,
  "[Unreleased]: $repoUrl/compare/$tag...HEAD`n[$next]: $repoUrl/releases/tag/$tag",
  1)
Write-Utf8 $changelogPath $changelog

# 4) Cargo.lock 에도 자기 버전이 적혀 있다.
$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& cargo update --workspace --offline 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "Cargo.lock 갱신 실패 — cargo check 를 한 번 돌려주세요." }
$ErrorActionPreference = $previous

Invoke-Git @("add", "VERSION", "Cargo.toml", "Cargo.lock", "CHANGELOG.md") | Out-Null
Invoke-Git @("commit", "-m", "release: $tag") | Out-Null
Invoke-Git @("tag", "-a", $tag, "-m", "yt-download $tag") | Out-Null

Write-Host ""
Write-Host "커밋과 태그를 만들었습니다: $tag"
Write-Host "CHANGELOG.md 의 [$next] 칸을 먼저 채워두면 릴리스 설명으로 그대로 올라갑니다."

if ($Push) {
  Invoke-Git @("push", "origin", "HEAD") | Out-Null
  Invoke-Git @("push", "origin", $tag) | Out-Null
  Write-Host "밀었습니다. GitHub Actions 의 release 워크플로가 빌드를 시작합니다."
} else {
  Write-Host ""
  Write-Host "밀 준비가 되면:  git push origin HEAD; git push origin $tag"
}
