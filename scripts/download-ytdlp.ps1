# Auto-download yt-dlp.exe to src-tauri/resources/
# Skips if a valid yt-dlp.exe already exists.
$ErrorActionPreference = 'Stop'

$destDir = Join-Path $PSScriptRoot '..\src-tauri\resources'
$destFile = Join-Path $destDir 'yt-dlp.exe'

if (Test-Path $destFile) {
    $size = (Get-Item $destFile).Length
    if ($size -gt 1MB) {
        Write-Host "[yt-dlp] Already exists ($([math]::Round($size/1MB,1)) MB), skip download."
        exit 0
    }
    Write-Host "[yt-dlp] Existing file too small ($([math]::Round($size/1MB,1)) MB), re-downloading..."
    Remove-Item $destFile -Force
}

if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

$url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

Write-Host "[yt-dlp] Downloading yt-dlp.exe..."
Invoke-WebRequest -Uri $url -OutFile $destFile -UseBasicParsing

$finalSize = (Get-Item $destFile).Length
Write-Host "[yt-dlp] Done. Saved to $destFile ($([math]::Round($finalSize/1MB,1)) MB)"
