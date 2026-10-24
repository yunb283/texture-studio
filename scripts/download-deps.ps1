# 统一下载构建所需的外部可执行文件（ffmpeg.exe、yt-dlp.exe）
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
& (Join-Path $scriptDir 'download-ffmpeg.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $scriptDir 'download-ytdlp.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[deps] All dependencies ready."
