@echo off
chcp 65001 >nul
echo ============================================
echo   图像工具箱 - 便携版打包脚本
echo   产物：exe + ffmpeg.exe（双击即用，无需安装）
echo ============================================
echo.

echo [1/4] 检查 / 下载 ffmpeg.exe...
powershell -ExecutionPolicy Bypass -File "scripts\download-ffmpeg.ps1"
if errorlevel 1 (
    echo.
    echo [错误] ffmpeg 下载失败，请检查网络连接
    exit /b 1
)

echo.
echo [2/4] 编译 release（不打安装包）...
npm run build -- --no-bundle
if errorlevel 1 (
    echo.
    echo [错误] 构建失败，请检查上方日志
    exit /b 1
)

echo.
echo [3/4] 复制内置 ffmpeg 到 exe 同级目录...
copy /Y "src-tauri\resources\ffmpeg.exe" "src-tauri\target\release\ffmpeg.exe" >nul
if errorlevel 1 (
    echo [错误] 复制 ffmpeg 失败，请确认 src-tauri\resources\ffmpeg.exe 存在
    exit /b 1
)

echo.
echo [4/4] 清理调试符号文件（.pdb）...
del /Q "src-tauri\target\release\*.pdb" 2>nul

echo.
echo ============================================
echo   打包完成！
echo   产物目录：src-tauri\target\release\
echo   运行文件：图像工具箱.exe + ffmpeg.exe
echo   （两个文件放同一目录，双击 exe 即可运行）
echo ============================================
