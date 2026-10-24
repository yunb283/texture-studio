# Auto-download ffmpeg.exe to src-tauri/resources/
# Skips if a valid ffmpeg.exe already exists.
$ErrorActionPreference = 'Stop'

$destDir = Join-Path $PSScriptRoot '..\src-tauri\resources'
$destFile = Join-Path $destDir 'ffmpeg.exe'

if (Test-Path $destFile) {
    $size = (Get-Item $destFile).Length
    if ($size -gt 10MB) {
        Write-Host "[ffmpeg] Already exists ($([math]::Round($size/1MB,1)) MB), skip download."
        exit 0
    }
    Write-Host "[ffmpeg] Existing file too small ($([math]::Round($size/1MB,1)) MB), re-downloading..."
    Remove-Item $destFile -Force
}

if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$zipFile = Join-Path $env:TEMP 'ffmpeg-essentials.zip'

Write-Host "[ffmpeg] Downloading ffmpeg essentials package..."
Invoke-WebRequest -Uri $url -OutFile $zipFile -UseBasicParsing

Write-Host "[ffmpeg] Extracting..."
$extractDir = Join-Path $env:TEMP 'ffmpeg-extract'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zipFile -DestinationPath $extractDir -Force

$ffmpegExe = Get-ChildItem -Path $extractDir -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
if (-not $ffmpegExe) {
    throw "ffmpeg.exe not found in downloaded archive"
}

Copy-Item $ffmpegExe.FullName $destFile -Force
$finalSize = (Get-Item $destFile).Length
Write-Host "[ffmpeg] Done. Saved to $destFile ($([math]::Round($finalSize/1MB,1)) MB)"

Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
