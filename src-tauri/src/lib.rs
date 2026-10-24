use std::borrow::Cow;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

fn file_path_to_string(fp: FilePath) -> String {
    match fp {
        FilePath::Path(p) => p.to_string_lossy().into_owned(),
        FilePath::Url(u) => u
            .to_file_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| u.to_string()),
    }
}

const IMAGE_EXTS: &[&str] = &[
    "png", "tga", "targa", "jpg", "jpeg", "bmp", "gif", "webp", "tif", "tiff",
];

#[tauri::command]
fn pick_images(
    app: tauri::AppHandle,
    multi: bool,
    exts: Option<Vec<String>>,
    title: Option<String>,
    label: Option<String>,
) -> Option<Vec<String>> {
    // 扩展名由前端按页面白名单传入；不传时用默认的序列图格式
    let list = exts.unwrap_or_else(|| IMAGE_EXTS.iter().map(|s| s.to_string()).collect());
    let refs: Vec<&str> = list.iter().map(|s| s.as_str()).collect();
    let dlg_title = title.unwrap_or_else(|| "选择序列贴图".to_string());
    let filter = label.unwrap_or_else(|| "图片文件".to_string());
    let (tx, rx) = mpsc::channel();
    if multi {
        app.dialog()
            .file()
            .set_title("选择序列帧图片")
            .add_filter(&filter, &refs)
            .pick_files(move |paths| {
                let _ =
                    tx.send(paths.map(|v| v.into_iter().map(file_path_to_string).collect()));
            });
    } else {
        app.dialog()
            .file()
            .set_title(dlg_title)
            .add_filter(&filter, &refs)
            .pick_file(move |path| {
                let _ = tx.send(path.map(|p| vec![file_path_to_string(p)]));
            });
    }
    rx.recv().ok().flatten()
}

#[tauri::command]
fn pick_dir(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择保存目录")
        .pick_folder(move |path| {
            let _ = tx.send(path.map(file_path_to_string));
        });
    rx.recv().ok().flatten()
}

// 原始字节直接回传，JS 侧收到 ArrayBuffer，避免 base64 编解码开销
#[tauri::command]
async fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

// 原始字节写入：自定义协议被拦截时载荷会退化成 JSON 数字数组，这里一并接受
#[tauri::command]
async fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let payload = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Cow::Borrowed(b.as_slice()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(values)) => {
            let mut b = Vec::with_capacity(values.len());
            for v in values {
                let n = v.as_u64().ok_or("载荷不是字节数组")?;
                if n > 255 {
                    return Err("载荷不是字节数组".into());
                }
                b.push(n as u8);
            }
            Cow::Owned(b)
        }
        _ => return Err("write_file 需要二进制载荷".into()),
    };
    // 原始请求体带不了 JSON 参数，路径写在载荷头部：[u32 小端 路径长度][路径 utf8][文件字节]
    let head: [u8; 4] = payload
        .get(..4)
        .ok_or("载荷长度不足")?
        .try_into()
        .unwrap();
    let path_len = u32::from_le_bytes(head) as usize;
    let (path_bytes, bytes) = payload
        .get(4..)
        .and_then(|tail| tail.split_at_checked(path_len))
        .ok_or("载荷格式不正确")?;
    let path = std::str::from_utf8(path_bytes).map_err(|_| "路径编码错误")?;

    if let Some(parent) = PathBuf::from(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    // 用系统默认方式打开文件或文件夹。explorer 即使成功也常常返回非 0，
    // 所以只看 spawn 成没成，不去判退出码。
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败：{e}"))?;
    Ok(())
}

#[tauri::command]
fn list_files(dir: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_file() {
            out.push(p.to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

// ===================== 视频转换（内置 ffmpeg） =====================

#[derive(Serialize, Deserialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: String,
    pub bitrate: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Serialize, Deserialize)]
pub struct ConvertOptions {
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_bitrate: Option<String>,
    pub audio_bitrate: Option<String>,
    pub crf: Option<u32>,
    pub preset: Option<String>,
    pub copy: Option<bool>, // 纯封装转换 -c copy
    // 裁剪区域（源像素坐标）
    pub crop_x: Option<u32>,
    pub crop_y: Option<u32>,
    pub crop_w: Option<u32>,
    pub crop_h: Option<u32>,
    // 导出时间区间（秒）
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
}

/// 解析 "HH:MM:SS.xx" 为秒数
fn parse_time_to_seconds(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// 定位内置 ffmpeg：打包后在 resource_dir 根目录，开发模式在 resource_dir/resources 下
fn locate_ffmpeg_inner(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let rd = app.path().resource_dir().map_err(|e| e.to_string())?;
    let candidates = [
        rd.join("ffmpeg.exe"),
        rd.join("resources").join("ffmpeg.exe"),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    // 回退：可执行文件同级目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("ffmpeg.exe");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err("未找到内置 ffmpeg，请检查安装包".into())
}

#[tauri::command]
fn locate_ffmpeg(app: tauri::AppHandle) -> Result<String, String> {
    locate_ffmpeg_inner(&app).map(|p| p.to_string_lossy().into_owned())
}

/// 用 ffmpeg -i 解析视频信息（不依赖 ffprobe）
fn ffprobe_inner(ffmpeg: &Path, path: &str) -> Result<VideoInfo, String> {
    let output = Command::new(ffmpeg)
        .arg("-i")
        .arg(path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut info = VideoInfo {
        duration: 0.0,
        width: 0,
        height: 0,
        fps: 0.0,
        video_codec: String::new(),
        audio_codec: String::new(),
        bitrate: String::new(),
        sample_rate: None,
        channels: None,
    };

    for line in stderr.lines() {
        let line = line.trim();
        // Duration: 00:00:10.50, start: 0.000000, bitrate: 1234 kb/s
        if line.starts_with("Duration:") {
            let rest = &line["Duration:".len()..];
            let parts: Vec<&str> = rest.split(',').collect();
            if let Some(dur) = parts.first() {
                if let Some(d) = parse_time_to_seconds(dur.trim()) {
                    info.duration = d;
                }
            }
            if let Some(br) = parts.iter().find(|p| p.contains("bitrate")) {
                info.bitrate = br.trim().replace("bitrate: ", "比特率：");
            }
        }
        // Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps
        if line.contains("Video:") {
            if let Some(idx) = line.find("Video:") {
                let rest = &line[idx + 6..];
                let parts: Vec<&str> = rest.split(',').collect();
                if let Some(codec) = parts.first() {
                    info.video_codec = codec.trim().split(' ').next().unwrap_or("").to_string();
                }
                for p in &parts {
                    let p = p.trim();
                    // 从形如 "2560x1440 [SAR 1:1 DAR 16:9]" 的片段提取宽高
                    if p.contains('x') {
                        if let Some(x_idx) = p.find('x') {
                            let left = &p[..x_idx];
                            let right = &p[x_idx + 1..];
                            // 左边末尾连续数字 = 宽
                            let w: u32 = left
                                .chars()
                                .rev()
                                .take_while(|c| c.is_ascii_digit())
                                .collect::<String>()
                                .chars()
                                .rev()
                                .collect::<String>()
                                .parse()
                                .unwrap_or(0);
                            // 右边开头连续数字 = 高
                            let h: u32 = right
                                .chars()
                                .take_while(|c| c.is_ascii_digit())
                                .collect::<String>()
                                .parse()
                                .unwrap_or(0);
                            if w > 0 && h > 0 {
                                info.width = w;
                                info.height = h;
                            }
                        }
                    }
                    if p.ends_with("fps") {
                        let fps_str = p.trim_end_matches("fps").trim();
                        info.fps = fps_str.parse().unwrap_or(0.0);
                    }
                }
            }
        }
        // Stream #0:1: Audio: aac, 44100 Hz, stereo
        if line.contains("Audio:") {
            if let Some(idx) = line.find("Audio:") {
                let rest = &line[idx + 6..];
                let parts: Vec<&str> = rest.split(',').collect();
                if let Some(codec) = parts.first() {
                    info.audio_codec = codec.trim().split(' ').next().unwrap_or("").to_string();
                }
                for p in &parts {
                    let p = p.trim();
                    if p.ends_with("Hz") {
                        let sr: u32 = p.trim_end_matches("Hz").trim().parse().unwrap_or(0);
                        if sr > 0 {
                            info.sample_rate = Some(sr);
                        }
                    }
                    let ch = match p {
                        "mono" => Some(1),
                        "stereo" => Some(2),
                        "2.1" => Some(3),
                        "5.1" => Some(6),
                        "7.1" => Some(8),
                        _ => None,
                    };
                    if ch.is_some() {
                        info.channels = ch;
                    }
                }
            }
        }
    }

    Ok(info)
}

#[tauri::command]
fn ffprobe_video(app: tauri::AppHandle, path: String) -> Result<VideoInfo, String> {
    let ffmpeg = locate_ffmpeg_inner(&app)?;
    ffprobe_inner(&ffmpeg, &path)
}

#[tauri::command]
async fn convert_video(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: String,
    output: String,
    options: ConvertOptions,
) -> Result<(), String> {
    let ffmpeg = locate_ffmpeg_inner(&app)?;
    let info = ffprobe_inner(&ffmpeg, &input)?;
    let total = info.duration.max(0.001);

    // 时间区间：用 -ss（输入定位，更快）+ -t（时长）
    let start = options.start_time.unwrap_or(0.0).max(0.0);
    let end = options.end_time.unwrap_or(total).min(total).max(start);
    let duration = end - start;

    let mut args: Vec<String> = vec!["-y".to_string()];
    if start > 0.0 {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", start));
    }
    args.push("-i".to_string());
    args.push(input.clone());
    if duration < total - 0.001 {
        args.push("-t".to_string());
        args.push(format!("{:.3}", duration));
    }

    // 收集视频滤镜（裁剪 + 缩放），最后合并成一个 -vf
    let mut vf_parts: Vec<String> = Vec::new();
    if let (Some(cx), Some(cy), Some(cw), Some(ch)) = (
        options.crop_x,
        options.crop_y,
        options.crop_w,
        options.crop_h,
    ) {
        if cw > 0 && ch > 0 {
            vf_parts.push(format!("crop={cw}:{ch}:{cx}:{cy}"));
        }
    }

    if options.copy.unwrap_or(false) {
        // 纯封装转换，不重编码
        args.push("-c".to_string());
        args.push("copy".to_string());
    } else {
        if let Some(vc) = &options.video_codec {
            args.push("-c:v".to_string());
            args.push(vc.clone());
        }
        if let Some(ac) = &options.audio_codec {
            args.push("-c:a".to_string());
            args.push(ac.clone());
        }
        if let (Some(w), Some(h)) = (options.width, options.height) {
            if w > 0 && h > 0 {
                vf_parts.push(format!("scale={w}:{h}"));
            }
        }
        if let Some(fps) = options.fps {
            if fps > 0.0 {
                args.push("-r".to_string());
                args.push(fps.to_string());
            }
        }
        if let Some(vb) = &options.video_bitrate {
            args.push("-b:v".to_string());
            args.push(vb.clone());
        }
        if let Some(ab) = &options.audio_bitrate {
            args.push("-b:a".to_string());
            args.push(ab.clone());
        }
        if let Some(crf) = options.crf {
            args.push("-crf".to_string());
            args.push(crf.to_string());
        }
        if let Some(preset) = &options.preset {
            args.push("-preset".to_string());
            args.push(preset.clone());
        }
    }

    if !vf_parts.is_empty() {
        args.push("-vf".to_string());
        args.push(vf_parts.join(","));
    }

    args.push(output.clone());

    let window_clone = window.clone();
    let ffmpeg_str = ffmpeg.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = Command::new(&ffmpeg_str)
            .args(&args)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if let Some(idx) = line.find("time=") {
                    let rest = &line[idx + 5..];
                    let time_str = rest.split(' ').next().unwrap_or("");
                    if let Some(t) = parse_time_to_seconds(time_str) {
                        let progress = (t / total).min(1.0).max(0.0);
                        let _ = window_clone.emit("video-progress", progress);
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("ffmpeg 转换失败，请检查参数或输出格式".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))??;

    let _ = result;
    Ok(())
}

// ===================== 音频转换 =====================

#[derive(Serialize, Deserialize)]
pub struct AudioConvertOptions {
    pub audio_codec: Option<String>,
    pub audio_bitrate: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
}

#[tauri::command]
async fn convert_audio(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: String,
    output: String,
    options: AudioConvertOptions,
) -> Result<(), String> {
    let ffmpeg = locate_ffmpeg_inner(&app)?;
    let info = ffprobe_inner(&ffmpeg, &input)?;
    let total = info.duration.max(0.001);

    let start = options.start_time.unwrap_or(0.0).max(0.0);
    let end = options.end_time.unwrap_or(total).min(total).max(start);
    let duration = end - start;

    let mut args: Vec<String> = vec!["-y".to_string()];
    if start > 0.0 {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", start));
    }
    args.push("-i".to_string());
    args.push(input.clone());
    if duration < total - 0.001 {
        args.push("-t".to_string());
        args.push(format!("{:.3}", duration));
    }
    // 丢弃视频流
    args.push("-vn".to_string());

    if let Some(ac) = &options.audio_codec {
        if ac != "copy" {
            args.push("-c:a".to_string());
            args.push(ac.clone());
        } else {
            args.push("-c:a".to_string());
            args.push("copy".to_string());
        }
    }
    if let Some(ab) = &options.audio_bitrate {
        args.push("-b:a".to_string());
        args.push(ab.clone());
    }
    if let Some(sr) = options.sample_rate {
        if sr > 0 {
            args.push("-ar".to_string());
            args.push(sr.to_string());
        }
    }
    if let Some(ch) = options.channels {
        if ch > 0 {
            args.push("-ac".to_string());
            args.push(ch.to_string());
        }
    }

    args.push(output.clone());

    let window_clone = window.clone();
    let ffmpeg_str = ffmpeg.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = Command::new(&ffmpeg_str)
            .args(&args)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if let Some(idx) = line.find("time=") {
                    let rest = &line[idx + 5..];
                    let time_str = rest.split(' ').next().unwrap_or("");
                    if let Some(t) = parse_time_to_seconds(time_str) {
                        let progress = (t / total).min(1.0).max(0.0);
                        let _ = window_clone.emit("audio-progress", progress);
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("ffmpeg 转换失败，请检查参数或输出格式".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))??;

    let _ = result;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_images,
            pick_dir,
            read_file,
            write_file,
            list_files,
            open_path,
            locate_ffmpeg,
            ffprobe_video,
            convert_video,
            convert_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
