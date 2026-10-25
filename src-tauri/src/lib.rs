use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 的 CREATE_NO_WINDOW：启动控制台子进程时不要新建控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 全局取消标志：前端点「取消下载」时置位，ytdlp_download 在下一次进度行里检测到后 kill 子进程。
static YTDLP_CANCEL: AtomicBool = AtomicBool::new(false);

/// 全局取消标志：前端点「清除链接」时置位，ytdlp_info 检测到后 kill 正在跑的解析进程。
static YTDLP_INFO_CANCEL: AtomicBool = AtomicBool::new(false);

/// 启动子进程（ffmpeg / yt-dlp）时统一隐藏控制台。
///
/// release 版是 GUI 子系统、自身没有控制台，Windows 会为每个控制台子进程新建一个
/// conhost，实测每次多花 0.5~0.7 秒（还会闪一下黑框）；开发版（debug）是控制台程序，
/// 子进程直接继承父进程的控制台，所以没有这笔开销。加上 CREATE_NO_WINDOW 后两边一致。
fn command_no_window<P: AsRef<std::ffi::OsStr>>(program: P) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Windows 作业对象：把子进程整棵进程树装进来。
///
/// 为什么需要它：yt-dlp.exe 是 PyInstaller 单文件包，运行时会先解压、再派生一个
/// 真正干活的 Python 子进程。`Child::kill()` 只杀直接子进程（bootloader 父进程），
/// 子进程会变成孤儿继续下载，并且还占着 stdout/stderr 管道，导致：
///   1. 进度条照涨、流量照跑；
///   2. 读取管道的线程等不到 EOF，invoke 永不返回，按钮一直停在「正在取消下载…」。
/// 装进作业对象后，`TerminateJobObject` 一次杀掉作业里的全部进程；
/// 同时设置 KILL_ON_JOB_CLOSE，哪怕本程序异常退出，句柄关闭时子进程也会被一并收走。
#[cfg(windows)]
mod kill_tree_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub(crate) struct KillTreeJob(HANDLE);

    impl KillTreeJob {
        /// 创建作业对象并设置「句柄关闭时杀光全部进程」。失败返回 None（调用方退化为普通 kill）。
        pub(crate) fn new() -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job == 0 {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }

        /// spawn 成功后立刻把子进程装入作业；它之后派生的所有子孙进程也都在作业里。
        pub(crate) fn assign(&self, child: &Child) {
            unsafe {
                let _ = AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }

        /// 终止作业内的全部进程（整棵树）。
        pub(crate) fn kill(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for KillTreeJob {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

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
async fn pick_images(
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
    // 对话框回调在插件自己的线程里执行；这里用阻塞线程等结果，别占住 UI 主线程
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn pick_dir(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择保存目录")
        .pick_folder(move |path| {
            let _ = tx.send(path.map(file_path_to_string));
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
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
async fn open_path(path: String) -> Result<(), String> {
    // 用系统默认方式打开文件或文件夹。explorer 即使成功也常常返回非 0，
    // 所以只看 spawn 成没成，不去判退出码。
    // explorer 冷启动可能要几百毫秒，同步命令会占住主线程让窗口变灰，放后台线程跑。
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

#[tauri::command]
async fn file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_files(dir: String) -> Result<Vec<String>, String> {
    // 同步命令跑在主线程上：读网络盘或几千个文件的目录会直接卡住界面，
    // 丢到阻塞线程池里就没这个问题了。
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_file() {
                out.push(p.to_string_lossy().into_owned());
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

// ===================== 视频转换（内置 ffmpeg） =====================

#[derive(Serialize, Deserialize, Clone)]
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
// ===== 视频/音频导入提速：路径缓存 + 探测结果缓存 + 启动预热 =====

/// 内置 ffmpeg 的实际路径。定位成功后一直复用。
///
/// 原来每次探测都要重算一遍 resource_dir 再做 2~3 次 exists 检查，虽然单次只有微秒级，
/// 但一次导入到转换的链路上会重复走三四趟，白白的多余逻辑。
static FFMPEG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 探测结果缓存：绝对路径 -> (文件指纹, 探测结果)。
///
/// 为什么需要：一次「导入 → 开始转换」会把 ffmpeg -i 跑两遍 —— 页面填信息一遍、
/// 转换命令算总时长一遍。ffmpeg.exe 有 100MB，每跑一遍都要重新映射映像，实测
/// 170~320ms。命中缓存后第二趟直接从内存拿，用户点「开始转换」就少一次等待。
/// 键除路径外还带文件指纹，源文件被替换/改动过就拿不到过期结果。
static FFPROBE_CACHE: OnceLock<Mutex<HashMap<String, (u64, VideoInfo)>>> = OnceLock::new();

/// 缓存条目上限。单条只有几十字节，给个宽松容量，超了整体清空重来。
const FFPROBE_CACHE_MAX: usize = 256;

fn ffprobe_cache() -> &'static Mutex<HashMap<String, (u64, VideoInfo)>> {
    FFPROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 文件大小 + 修改时间混成一个指纹，用来判断缓存是不是还对应磁盘上的这份内容。
fn file_stamp(path: &str) -> u64 {
    let Ok(md) = fs::metadata(path) else {
        return 0; // 0 表示拿不到元数据，走不缓存分支
    };
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    md.len().wrapping_add(mtime.wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// 带缓存的探测入口：命中缓存直接返回，否则起一次 ffmpeg 并把结果记下来。
fn probe_video(app: &tauri::AppHandle, path: &str) -> Result<VideoInfo, String> {
    let stamp = file_stamp(path);
    if stamp != 0 {
        if let Ok(cache) = ffprobe_cache().lock() {
            if let Some((s, info)) = cache.get(path) {
                if *s == stamp {
                    return Ok(info.clone());
                }
            }
        }
    }

    let ffmpeg = locate_ffmpeg_inner(app)?;
    let info = ffprobe_inner(&ffmpeg, path)?;

    if stamp != 0 {
        if let Ok(mut cache) = ffprobe_cache().lock() {
            if cache.len() >= FFPROBE_CACHE_MAX {
                cache.clear();
            }
            cache.insert(path.to_string(), (stamp, info.clone()));
        }
    }
    Ok(info)
}

/// 关键帧时间戳缓存：路径 -> (文件指纹, 秒列表)。
/// 拖动预览要用它做吸附，一个文件只扫一遍；文件被替换会拿到不同的指纹，不会误用旧数据。
static KEYFRAME_CACHE: OnceLock<Mutex<HashMap<String, (u64, Arc<Vec<f64>>)>>> = OnceLock::new();

const KEYFRAME_CACHE_MAX: usize = 64;

fn keyframe_cache() -> &'static Mutex<HashMap<String, (u64, Arc<Vec<f64>>)>> {
    KEYFRAME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 扫出视频的所有关键帧（I 帧）时间戳，供前端拖动时间轴时吸附预览。
///
/// 原理：seek 到非关键帧时解码器要从最近的上一个关键帧逐帧解码到目标位置 ——
/// 高码率录制文件的关键帧间隔往往 2~4 秒（60fps 下就是 120~240 帧），这就是拖动后
/// 要等一会儿才出画面的原因。而 seek 到关键帧本身不需要解码任何中间帧，几乎即时。
///
/// `-skip_frame nokey` 让解码器整帧跳过 P/B 帧，只解关键帧；showinfo 把每个关键帧的
/// pts_time 打到 stderr。大文件的开销主要是顺序读盘（700MB 实测约 1~4 秒），
/// 全程在阻塞线程池里跑，不占 UI。
#[tauri::command]
async fn keyframe_times(app: tauri::AppHandle, path: String) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = file_stamp(&path);
        if stamp != 0 {
            if let Ok(cache) = keyframe_cache().lock() {
                if let Some((s, times)) = cache.get(&path) {
                    if *s == stamp {
                        return Ok(times.as_ref().clone());
                    }
                }
            }
        }

        let ffmpeg = locate_ffmpeg_inner(&app)?;
        let output = command_no_window(ffmpeg)
            .arg("-hide_banner")
            .arg("-nostdin")
            .arg("-skip_frame")
            .arg("nokey")
            .arg("-i")
            .arg(&path)
            .arg("-an")
            .arg("-sn")
            .arg("-vf")
            .arg("showinfo")
            .arg("-f")
            .arg("null")
            .arg("-")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut times: Vec<f64> = Vec::new();
        for line in stderr.lines() {
            // showinfo 每个关键帧一行：... n: 12 pts: 12288 pts_time:1.28 ...
            if !line.contains("showinfo") {
                continue;
            }
            if let Some(i) = line.find("pts_time:") {
                let rest = &line[i + "pts_time:".len()..];
                let num: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                    .collect();
                if let Ok(t) = num.parse::<f64>() {
                    times.push(t);
                }
            }
        }
        // 保险：排序去重，并保证 0 在表里（个别封装会漏掉第一帧）
        times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        times.dedup();
        if times.first().map(|t| *t > 0.0).unwrap_or(true) {
            times.insert(0, 0.0);
        }

        if stamp != 0 && !times.is_empty() {
            if let Ok(mut cache) = keyframe_cache().lock() {
                if cache.len() >= KEYFRAME_CACHE_MAX {
                    cache.clear();
                }
                cache.insert(path.clone(), (stamp, Arc::new(times.clone())));
            }
        }
        Ok(times)
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

/// 启动时把 ffmpeg.exe 的映像预热到系统缓存里。
///
/// ffmpeg.exe 有 100MB，Windows 每新建一次进程都要重新映射这份映像，第一次还得等
/// 安全软件扫一遍 —— 实测同一份二进制首次执行约 320ms、预热后约 170ms。放到启动后
/// 空闲的一小段时间里跑一次 -version（几毫秒的活），把这笔开销挪出用户点导入的等待区间。
fn warm_up_ffmpeg(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // 等首屏渲染完再动，别跟界面加载抢资源
        std::thread::sleep(Duration::from_millis(800));
        let Ok(ffmpeg) = locate_ffmpeg_inner(&app) else {
            return;
        };
        let _ = command_no_window(ffmpeg)
            .arg("-hide_banner")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
}

fn locate_ffmpeg_inner(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(cached) = FFMPEG_PATH.get() {
        return Ok(cached.clone());
    }
    let rd = app.path().resource_dir().map_err(|e| e.to_string())?;
    let candidates = [
        rd.join("ffmpeg.exe"),
        rd.join("resources").join("ffmpeg.exe"),
    ];
    for c in &candidates {
        if c.exists() {
            let _ = FFMPEG_PATH.set(c.clone());
            return Ok(c.clone());
        }
    }
    // 回退：可执行文件同级目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("ffmpeg.exe");
            if p.exists() {
                let _ = FFMPEG_PATH.set(p.clone());
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

/// 定位内置 yt-dlp：打包后在 resource_dir 根目录，开发模式在 resource_dir/resources 下
fn locate_ytdlp_inner(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let rd = app.path().resource_dir().map_err(|e| e.to_string())?;
    let candidates = [
        rd.join("yt-dlp.exe"),
        rd.join("resources").join("yt-dlp.exe"),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("yt-dlp.exe");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err("未找到内置 yt-dlp，请检查安装包".into())
}

/// 用 ffmpeg -i 解析视频信息（不依赖 ffprobe）
fn ffprobe_inner(ffmpeg: &Path, path: &str) -> Result<VideoInfo, String> {
    let output = command_no_window(ffmpeg)
        .arg("-hide_banner")
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
async fn ffprobe_video(app: tauri::AppHandle, path: String) -> Result<VideoInfo, String> {
    // 探测要起子进程、读文件头，放到阻塞线程池，别让 UI 线程等它
    tauri::async_runtime::spawn_blocking(move || probe_video(&app, &path))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

#[tauri::command]
async fn convert_video(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: String,
    output: String,
    options: ConvertOptions,
) -> Result<(), String> {
    // 走缓存：导入时已经探测过同一个文件的话，这里不再重复起一遍 ffmpeg
    let info = probe_video(&app, &input)?;
    let total = info.duration.max(0.001);

    // 时间区间：用 -ss（输入定位，更快）+ -t（时长）
    let start = options.start_time.unwrap_or(0.0).max(0.0);
    let end = options.end_time.unwrap_or(total).min(total).max(start);
    let duration = end - start;

    let mut args: Vec<String> = vec![
        "-y".to_string(),
        // 进度写到 stderr（每 0.5 秒一行 out_time=...），-nostats 关掉默认那种用 \r 覆盖的统计行
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-nostats".to_string(),
    ];
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
    let ffmpeg = locate_ffmpeg_inner(&app)?;
    let ffmpeg_str = ffmpeg.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = command_no_window(&ffmpeg_str)
            .args(&args)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

        let mut stderr_tail: Vec<String> = Vec::new();
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                stderr_tail.push(line.clone());
                if stderr_tail.len() > 5 {
                    stderr_tail.remove(0);
                }
                let Some(rest) = line.strip_prefix("out_time=") else {
                    continue;
                };
                if let Some(t) = parse_time_to_seconds(rest.trim()) {
                    let progress = (t / duration.max(0.001)).min(1.0).max(0.0);
                    let _ = window_clone.emit("video-progress", progress);
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let tail = stderr_tail.join(" | ");
            let msg = if tail.is_empty() {
                "ffmpeg 转换失败".to_string()
            } else {
                format!("ffmpeg 转换失败：{tail}")
            };
            return Err(msg);
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
    // 走缓存：导入时已经探测过同一个文件的话，这里不再重复起一遍 ffmpeg
    let info = probe_video(&app, &input)?;
    let total = info.duration.max(0.001);

    let start = options.start_time.unwrap_or(0.0).max(0.0);
    let end = options.end_time.unwrap_or(total).min(total).max(start);
    let duration = end - start;

    let mut args: Vec<String> = vec![
        "-y".to_string(),
        // 进度写到 stderr（每 0.5 秒一行 out_time=...），-nostats 关掉默认那种用 \r 覆盖的统计行
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-nostats".to_string(),
    ];
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
    let ffmpeg = locate_ffmpeg_inner(&app)?;
    let ffmpeg_str = ffmpeg.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = command_no_window(&ffmpeg_str)
            .args(&args)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

        let mut stderr_tail: Vec<String> = Vec::new();
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                // 保留最后 5 行，失败时带出来方便诊断
                stderr_tail.push(line.clone());
                if stderr_tail.len() > 5 {
                    stderr_tail.remove(0);
                }
                // 解析 -progress 的 out_time= 行来实时刷新进度
                let Some(rest) = line.strip_prefix("out_time=") else {
                    continue;
                };
                if let Some(t) = parse_time_to_seconds(rest.trim()) {
                    let progress = (t / duration.max(0.001)).min(1.0).max(0.0);
                    let _ = window_clone.emit("audio-progress", progress);
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let tail = stderr_tail.join(" | ");
            let msg = if tail.is_empty() {
                "ffmpeg 转换失败".to_string()
            } else {
                format!("ffmpeg 转换失败：{tail}")
            };
            return Err(msg);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))??;

    let _ = result;
    Ok(())
}

// ===================== yt-dlp 视频下载 =====================

#[derive(Serialize, Deserialize)]
pub struct YtDlpFormat {
    pub format_id: String,
    pub ext: String,
    pub resolution: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: String,
    pub acodec: String,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub tbr: Option<f64>,
    pub format_note: String,
    pub protocol: String,
}

#[derive(Serialize, Deserialize)]
pub struct YtDlpPlaylistEntry {
    pub id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub uploader: String,
    pub thumbnail: String,
    pub webpage_url: String,
}

#[derive(Serialize, Deserialize)]
pub struct YtDlpInfo {
    pub id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub uploader: String,
    pub thumbnail: String,
    pub webpage_url: String,
    pub ext: String,
    pub formats: Vec<YtDlpFormat>,
    /// 如果是播放列表/合集/分 P，这里包含所有子视频
    pub entries: Vec<YtDlpPlaylistEntry>,
}

/// 浏览器级 User-Agent，降低站点反爬拦截概率（如 B 站 HTTP 412）
const YTDLP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// B 站分 P URL 带 `?p=N` 或 `/video/xxx?p=N` 时，yt-dlp 只解析那一 P，
/// 去掉 `p=N` 让它看到完整合集主页。其他站点原样返回。
fn normalize_bili_part_url(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.contains("bilibili.com") {
        // 先拆 query string
        if let Some(q) = url.find('?') {
            let base = &url[..q];
            let qs = &url[q + 1..];
            // 过滤掉 p=N 参数（注意要按 & 分割，不能简单字符串替换）
            let filtered: Vec<&str> = qs
                .split('&')
                .filter(|kv| !kv.starts_with("p="))
                .collect();
            if filtered.is_empty() {
                return base.to_string();
            }
            return format!("{}?{}", base, filtered.join("&"));
        }
    }
    url.to_string()
}

/// 用 B站公开 API 拉取视频所属的 ugc_season（系列/合集）里的所有 episode。
/// 不需要 wbi 签名，只需要 User-Agent + Referer。
///
/// yt-dlp 的 BiliBili extractor 目前（2026.10）只能自动识别「分 P」（同 BVID 带 pages）
/// 和「medialist 收藏夹」，但不会自动展开 UP 主创建的 ugc_season 系列。
/// 这个函数作为兜底：当 yt-dlp 返回单视频、但 B站 API 说它属于某个系列时，
/// 把系列里所有视频拼成 entries 返回。
/// 返回：(season_title, season_cover_url, entries)
fn fetch_bili_season_entries(
    bvid: &str,
) -> Option<(String, String, Vec<YtDlpPlaylistEntry>)> {
    let api = format!(
        "https://api.bilibili.com/x/web-interface/view?bvid={}",
        bvid
    );
    // 用系统自带的 curl.exe（Windows 10+ 有），比引入 reqwest 依赖轻量
    let mut cmd = command_no_window("curl.exe");
    cmd.arg("-s")
        .arg("-H")
        .arg(format!("User-Agent: {}", YTDLP_UA))
        .arg("-H")
        .arg("Referer: https://www.bilibili.com/")
        .arg(&api)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout).ok()?;

    // ugc_season: { id, title, cover, sections: [{ episodes: [{ arc: { bvid, title, duration, pic } }] }] }
    let ugc_season = json.get("data")?.get("ugc_season")?;
    let season_title = ugc_season
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("系列")
        .to_string();
    let season_cover = ugc_season
        .get("cover")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut entries: Vec<YtDlpPlaylistEntry> = Vec::new();

    if let Some(sections) = ugc_season.get("sections").and_then(|v| v.as_array()) {
        for section in sections {
            if let Some(eps) = section.get("episodes").and_then(|v| v.as_array()) {
                for ep in eps {
                    // 注意：bvid 在 episode 层（ep.bvid），不在 arc 层；arc 层只有 aid（数字）
                    let bvid = ep
                        .get("bvid")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if bvid.is_empty() {
                        continue;
                    }
                    let arc = ep.get("arc");
                    let title = ep
                        .get("title")
                        .and_then(|v| v.as_str())
                        .or_else(|| {
                            arc.and_then(|a| a.get("title"))
                                .and_then(|v| v.as_str())
                        })
                        .unwrap_or("")
                        .to_string();
                    let duration = arc
                        .and_then(|a| a.get("duration"))
                        .and_then(|v| v.as_f64());
                    let pic = arc
                        .and_then(|a| a.get("pic"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let uploader = arc
                        .and_then(|a| a.get("author"))
                        .and_then(|v| v.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let webpage_url = format!(
                        "https://www.bilibili.com/video/{}/",
                        bvid
                    );
                    entries.push(YtDlpPlaylistEntry {
                        id: bvid.clone(),
                        title,
                        duration,
                        uploader,
                        thumbnail: pic,
                        webpage_url,
                    });
                }
            }
        }
    }

    if entries.is_empty() {
        None
    } else {
        Some((season_title, season_cover, entries))
    }
}

/// 把 yt-dlp 的英文报错翻译成能直接照着做的中文提示
fn friendly_ytdlp_error(msg: &str) -> String {
    if msg.contains("Failed to decrypt") || msg.contains("Could not copy Chrome cookie database") {
        return format!(
            "yt-dlp 解析失败：{msg}（读不到浏览器 Cookies：新版 Chrome/Edge 给 Cookie 库加了加密或被占用。请先完全退出浏览器再选「从 Edge 读取」，或改用「自定义」导入导出的 cookies.txt）"
        );
    }
    if msg.contains("412") || msg.contains("Precondition Failed") {
        return format!(
            "yt-dlp 解析失败：{msg}（HTTP 412 是站点风控：当前网络出口 IP 被判定为风险，常见于开着代理/VPN。请让 bilibili.com 走直连（或在 VPN 软件里把本程序加入直连进程），再在下方「网络代理」选「直连」或「跟随系统代理」重试）"
        );
    }
    if msg.contains("403") && (msg.contains("Cloudflare") || msg.contains("anti-bot") || msg.contains("generic")) {
        return format!(
            "yt-dlp 解析失败：{msg}（被 Cloudflare 反爬拦截了。新版本已自动开启 TLS 指纹模拟，仍失败请尝试：① 换个网络出口（手机热点）；② 在下方「网络代理」选「直连」或「跟随系统代理」；③ 在浏览器登录目标网站后，选「从 Chrome/Edge 读取」带 Cookie 重试）"
        );
    }
    if msg.contains("Unsupported URL") || (msg.contains("generic") && msg.contains("Falling back")) {
        return format!(
            "yt-dlp 不支持这个网站：{msg}（yt-dlp 支持 YouTube、Bilibili、Twitter/X、TikTok、Vimeo、Instagram 等数千个主流视频平台，但不支持 ArtStation、Behance、Dribbble 这类设计作品集站点。请换一个 yt-dlp 支持的视频链接试试）"
        );
    }
    format!("yt-dlp 解析失败：{msg}")
}

/// 调用 yt-dlp -J 获取视频信息和可用格式列表
#[tauri::command]
async fn ytdlp_info(
    app: tauri::AppHandle,
    url: String,
    cookies: Option<String>,
    cookies_from_browser: Option<String>,
) -> Result<YtDlpInfo, String> {
    let ytdlp = locate_ytdlp_inner(&app)?;
    // B 站带 p=N 参数的 URL 会被 yt-dlp 当作单 P 视频，拿不到合集 entries
    let url = normalize_bili_part_url(&url);
    let mut cmd = command_no_window(&ytdlp);
    cmd.arg("-J")
        .arg("--extractor-args")
        .arg("generic:impersonate")
        .arg("--user-agent")
        .arg(YTDLP_UA);
    if let Some(browser) = &cookies_from_browser {
        if !browser.is_empty() {
            cmd.arg("--cookies-from-browser").arg(browser);
        }
    } else if let Some(cookie_file) = &cookies {
        if !cookie_file.is_empty() {
            cmd.arg("--cookies").arg(cookie_file);
        }
    }
    cmd.arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 每次解析前清掉上一个取消请求（比如用户之前点过清除链接）
    YTDLP_INFO_CANCEL.store(false, Ordering::SeqCst);

    let mut child = cmd.spawn().map_err(|e| format!("调用 yt-dlp 失败：{e}"))?;

    // 装进作业对象：取消时杀整棵进程树，PyInstaller 子进程不会变孤儿（同下载侧）
    let job = Arc::new(kill_tree_job::KillTreeJob::new());
    if let Some(job) = &*job {
        job.assign(&child);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    // 看门狗：清除链接触发取消时 kill 解析进程整棵树，让阻塞读取立刻返回
    {
        let watchdog = child.clone();
        let watchdog_job = job.clone();
        std::thread::spawn(move || loop {
            if YTDLP_INFO_CANCEL.load(Ordering::SeqCst) {
                if let Some(job) = &*watchdog_job {
                    job.kill();
                }
                let _ = watchdog.lock().unwrap().kill();
                break;
            }
            if watchdog.lock().unwrap().try_wait().map(|s| s.is_some()).unwrap_or(true) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
    }

    // stderr 单独线程读完，避免和 stdout 互相阻塞（-J 输出较大）
    let err_thread = stderr.map(|stderr| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut BufReader::new(stderr), &mut buf);
            buf
        })
    });

    let mut out_bytes = Vec::new();
    if let Some(stdout) = stdout {
        let _ = std::io::Read::read_to_end(&mut BufReader::new(stdout), &mut out_bytes);
    }
    let err_bytes = err_thread.and_then(|h| h.join().ok()).unwrap_or_default();

    let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    if YTDLP_INFO_CANCEL.load(Ordering::SeqCst) {
        return Err("已取消解析".into());
    }

    if !status.success() {
        let err = String::from_utf8_lossy(&err_bytes);
        return Err(friendly_ytdlp_error(err.trim()));
    }

    let json: serde_json::Value = serde_json::from_slice(&out_bytes)
        .map_err(|e| format!("解析 yt-dlp 输出失败：{e}"))?;

    let formats_val = json.get("formats").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut formats: Vec<YtDlpFormat> = Vec::new();
    for f in formats_val {
        let fmt_id = f.get("format_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ext = f.get("ext").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // 跳过没有媒体流的空格式
        let vcodec = f.get("vcodec").and_then(|v| v.as_str()).unwrap_or("none").to_string();
        let acodec = f.get("acodec").and_then(|v| v.as_str()).unwrap_or("none").to_string();
        if vcodec == "none" && acodec == "none" {
            continue;
        }
        formats.push(YtDlpFormat {
            format_id: fmt_id,
            ext,
            resolution: f.get("resolution").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            width: f.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
            height: f.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
            fps: f.get("fps").and_then(|v| v.as_f64()),
            vcodec,
            acodec,
            filesize: f.get("filesize").and_then(|v| v.as_u64()),
            filesize_approx: f.get("filesize_approx").and_then(|v| v.as_u64()),
            tbr: f.get("tbr").and_then(|v| v.as_f64()),
            format_note: f.get("format_note").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            protocol: f.get("protocol").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
    }

    // 判断是播放列表还是单视频：type == "playlist" 或 entries 数组非空
    let is_playlist = json
        .get("_type")
        .and_then(|v| v.as_str())
        .map(|t| t == "playlist")
        .unwrap_or(false)
        || json
            .get("entries")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);

    let mut entries: Vec<YtDlpPlaylistEntry> = Vec::new();
    if is_playlist {
        if let Some(arr) = json.get("entries").and_then(|v| v.as_array()) {
            for e in arr {
                entries.push(YtDlpPlaylistEntry {
                    id: e.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    title: e.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    duration: e.get("duration").and_then(|v| v.as_f64()),
                    uploader: e
                        .get("uploader")
                        .and_then(|v| v.as_str())
                        .or_else(|| e.get("channel").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string(),
                    thumbnail: e.get("thumbnail").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    webpage_url: e
                        .get("webpage_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
    }

    // —— B站 ugc_season 兜底 ——
    // yt-dlp 的 BiliBili extractor 不会自动展开 UP 主创建的系列，我们自己调 API。
    let mut playlist_title_override: Option<String> = None;
    let mut playlist_cover_override: Option<String> = None;
    if !is_playlist
        && json
            .get("extractor_key")
            .and_then(|v| v.as_str())
            .map(|k| k == "BiliBili")
            .unwrap_or(false)
    {
        let bvid = json
            .get("display_id")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("id").and_then(|v| v.as_str()))
            .unwrap_or("");
        if !bvid.is_empty() {
            if let Some((season_title, season_cover, season_entries)) =
                fetch_bili_season_entries(bvid)
            {
                entries = season_entries;
                playlist_title_override = Some(season_title);
                if !season_cover.is_empty() {
                    playlist_cover_override = Some(season_cover);
                }
            }
        }
    }

    Ok(YtDlpInfo {
        id: json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        title: playlist_title_override.clone().unwrap_or_else(|| {
            json.get("title")
                .and_then(|v| v.as_str())
                .or_else(|| json.get("playlist_title").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string()
        }),
        duration: json.get("duration").and_then(|v| v.as_f64()),
        uploader: json
            .get("uploader")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("channel").and_then(|v| v.as_str()))
            .or_else(|| json.get("uploader_id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        thumbnail: playlist_cover_override
            .clone()
            .or_else(|| json.get("playlist_thumbnail").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .or_else(|| json.get("thumbnail").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_default(),
        webpage_url: json
            .get("webpage_url")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("original_url").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        ext: json.get("ext").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        formats,
        entries,
    })
}

#[derive(Deserialize)]
pub struct YtDlpDownloadOptions {
    pub format: Option<String>,
    pub cookies: Option<String>,
    pub cookies_from_browser: Option<String>,
}

/// yt-dlp 下载/合并进度
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    /// 0~1，合并阶段和完成时分别为 0（不确定进度）和 1
    pub percent: f64,
    pub speed: String,
    pub eta: String,
    /// "download" / "merge" / "done"
    pub phase: String,
    /// 当前下载段的总大小（从 "of XX at" 提取，如 "20.00MiB"）
    pub total_size: String,
}

#[derive(Clone, Default)]
struct ProgressState {
    last_percent: f64,
    phase: String,
    total_size: String,
}

/// 从 "[download]  25.0% of 10.00MiB at 1.23MiB/s ETA 00:12" 里取速度和剩余时间
fn extract_speed_eta(line: &str) -> (String, String) {
    let token_after = |needle: &str| -> String {
        line.find(needle)
            .map(|i| {
                line[i + needle.len()..]
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default()
    };
    (token_after(" at "), token_after("ETA "))
}

/// 从 "[download] 25.0% of 10.00MiB at ..." 提取总大小 "10.00MiB"
fn extract_total_size(line: &str) -> String {
    if let Some(start) = line.find("of ") {
        let after_of = &line[start + 3..];
        let end = after_of.find(" at ").unwrap_or(after_of.len());
        after_of[..end].trim().to_string()
    } else {
        String::new()
    }
}

/// 发送指定 phase 的进度事件（合并/完成阶段用）
fn emit_phase(window: &tauri::Window, phase: &str, percent: f64, total_size: &str) {
    let _ = window.emit(
        "ytdlp-progress",
        DownloadProgress {
            percent,
            speed: String::new(),
            eta: String::new(),
            phase: phase.to_string(),
            total_size: total_size.to_string(),
        },
    );
}

/// 解析一行下载进度并发事件。
/// 检测到跨段时 percent 会从接近 1 掉到接近 0（视频流→音频流），
/// 此时重置 last_percent，让新段进度能正常上报。
fn emit_progress(line: &str, state: &Arc<Mutex<ProgressState>>, window: &tauri::Window) {
    if !line.starts_with("[download]") {
        return;
    }
    let Some(pct) = extract_percent(line) else {
        return;
    };
    let p = (pct / 100.0).clamp(0.0, 1.0);
    let (speed, eta) = extract_speed_eta(line);
    let total_size = extract_total_size(line);

    let Ok(mut guard) = state.lock() else { return };

    // 已经进入合并/完成阶段就别再发下载进度了
    if guard.phase == "merge" || guard.phase == "done" {
        return;
    }
    guard.phase = "download".to_string();

    // 明显倒退 → 换了下载段（视频→音频），重置 last_percent
    if p < guard.last_percent - 0.3 {
        guard.last_percent = p;
    } else if p <= guard.last_percent + 0.001 {
        // 同段重复行，跳过
        return;
    } else {
        guard.last_percent = p;
    }

    guard.total_size = total_size.clone();

    let _ = window.emit(
        "ytdlp-progress",
        DownloadProgress {
            percent: p,
            speed,
            eta,
            phase: "download".to_string(),
            total_size,
        },
    );
}

/// 前端点「取消下载」时调用：置位全局取消标志，ytdlp_download 会 kill 正在跑的 yt-dlp。
#[tauri::command]
fn cancel_download() {
    YTDLP_CANCEL.store(true, Ordering::SeqCst);
}

/// 前端点「清除链接」时调用：置位解析取消标志，ytdlp_info 会 kill 正在跑的解析进程。
#[tauri::command]
fn cancel_ytdlp_info() {
    YTDLP_INFO_CANCEL.store(true, Ordering::SeqCst);
}

// ===================== yt-dlp 检查更新（仅安装版显示） =====================

/// 是否以「安装版」运行：MSI 安装包安装后返回 true（前端显示「检查更新yt-dlp」按钮），
/// 免安装/绿色版返回 false（隐藏按钮）。dev 构建恒为 true，便于调试。
fn detect_installed_build() -> bool {
    use std::sync::OnceLock;
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        if cfg!(debug_assertions) {
            return true;
        }
        // 1) MSI 安装包会在注册表写卸载项（...Uninstall），免安装版没有
        if installed_in_registry() {
            return true;
        }
        // 2) 兜底：exe 目录不可写（如 Program Files）也视为安装版
        !exe_dir_writable()
    })
}

fn exe_dir_writable() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"ok").is_ok();
    if ok {
        let _ = fs::remove_file(&probe);
    }
    ok
}

#[cfg(windows)]
fn installed_in_registry() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const APP_NAME: &str = "图像工具箱";
    let roots = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    for (root, path) in roots {
        let Ok(uninst) = RegKey::predef(root).open_subkey(path) else {
            continue;
        };
        for key in uninst.enum_keys().flatten() {
            let Ok(sk) = uninst.open_subkey(&key) else {
                continue;
            };
            if let Ok(name) = sk.get_value::<String, _>("DisplayName") {
                if name.contains(APP_NAME) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn installed_in_registry() -> bool {
    false
}

#[tauri::command]
fn ytdlp_update_ui_visible() -> bool {
    detect_installed_build()
}

/// yt-dlp.exe 所在目录（也就是软件所在目录），给「安装目录」按钮用
#[tauri::command]
async fn ytdlp_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = locate_ytdlp_inner(&app)?;
    let dir = p.parent().ok_or("yt-dlp 路径没有上级目录")?;
    Ok(dir.to_string_lossy().into_owned())
}

/// "2025.01.15" → [2025, 1, 15]，用于版本比较
fn version_key(s: &str) -> Vec<u32> {
    s.trim()
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(0))
        .collect()
}

#[derive(Serialize)]
struct YtDlpUpdateCheck {
    local_version: String,
    remote_version: String,
    latest: bool,
}

/// 检查 yt-dlp 是否有新版本：本地 --version 对比 GitHub latest release 的 tag_name。
#[tauri::command]
async fn ytdlp_check_update(app: tauri::AppHandle) -> Result<YtDlpUpdateCheck, String> {
    // 同步命令会把整段逻辑跑在主线程上：本地 yt-dlp --version 要解压 PyInstaller 包
    // （通常 1~3 秒），GitHub 请求最长还会等到 20 秒超时 —— 期间窗口走不了任何动画、
    // 甚至变灰无响应。丢到阻塞线程池里，界面该转圈转圈。
    tauri::async_runtime::spawn_blocking(move || ytdlp_check_update_inner(&app))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn ytdlp_check_update_inner(app: &tauri::AppHandle) -> Result<YtDlpUpdateCheck, String> {
    let ytdlp = locate_ytdlp_inner(app)?;

    // 本地版本
    let out = command_no_window(&ytdlp)
        .arg("--version")
        .output()
        .map_err(|e| format!("无法运行本地 yt-dlp：{e}"))?;
    let local = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || local.is_empty() {
        return Err("无法获取本地 yt-dlp 版本，可能文件损坏，请重新安装本程序".into());
    }

    // 远端版本：GitHub API（用系统自带 curl.exe，Windows 10+ 自带）
    let out2 = command_no_window("curl.exe")
        .args([
            "-s",
            "--max-time",
            "20",
            "-H",
            "User-Agent: texture-studio",
            "-H",
            "Accept: application/vnd.github+json",
            "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
        ])
        .output()
        .map_err(|_| "无法连接 GitHub，请检查网络连接后重试".to_string())?;
    if !out2.status.success() {
        return Err(
            "无法连接 GitHub（请求超时或被拦截）。解决方案：检查网络连接，或在下载页「网络代理」里配置可用代理后重试".into(),
        );
    }
    let json: serde_json::Value = serde_json::from_slice(&out2.stdout)
        .map_err(|_| "GitHub 返回内容异常，请稍后重试".to_string())?;
    if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
        return Err(format!("GitHub 接口返回错误：{msg}（可能是限流，请稍后重试）"));
    }
    let remote = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    if remote.is_empty() {
        return Err("未能从 GitHub 获取到最新版本号，请稍后重试".into());
    }

    let latest = version_key(&local) >= version_key(&remote);
    Ok(YtDlpUpdateCheck {
        local_version: local,
        remote_version: remote,
        latest,
    })
}

/// 下载最新 yt-dlp.exe 并替换内置文件。通过 ytdlp-update-progress 事件上报下载进度（0~100）。
#[tauri::command]
async fn ytdlp_apply_update(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<String, String> {
    let ytdlp = locate_ytdlp_inner(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ytdlp
            .parent()
            .map(|d| d.to_path_buf())
            .ok_or("无法定位 yt-dlp 所在目录")?;
        let tmp = dir.join("yt-dlp.exe.new");
        let bak = dir.join("yt-dlp.exe.bak");
        let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

        let emit = |percent: f64| {
            let _ = window.emit(
                "ytdlp-update-progress",
                serde_json::json!({ "percent": percent }),
            );
        };

        // 清掉上次失败的残留
        let _ = fs::remove_file(&tmp);

        // Program Files 等受保护目录普通权限写不进去：提前探测，别让下载报出误导性的网络错误
        let probe = dir.join(".update-probe");
        match fs::write(&probe, b"ok") {
            Ok(_) => {
                let _ = fs::remove_file(&probe);
            }
            Err(_) => {
                return Err(
                    "更新失败：当前没有写入安装目录的权限。解决方案：右键「以管理员身份运行」本程序后再检查更新，或手动下载新版覆盖 resources 下的 yt-dlp.exe".into(),
                );
            }
        }

        // 先 HEAD 拿文件总大小，用于计算进度百分比（拿不到就只上报已完成）
        let head = command_no_window("curl.exe")
            .args(["-sIL", "--max-time", "20", url])
            .output();
        let total: u64 = head
            .ok()
            .map(|h| {
                String::from_utf8_lossy(&h.stdout)
                    .lines()
                    .rev()
                    .find_map(|l| {
                        let l = l.trim();
                        if l.len() > 15 && l[..15].eq_ignore_ascii_case("content-length:") {
                            l[15..].trim().parse::<u64>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0)
            })
            .unwrap_or(0);

        emit(0.0);

        // 后台下载到同目录临时文件（同分区 rename 才能原子替换）
        let mut child = command_no_window("curl.exe")
            .args(["-L", "--fail", "--max-time", "600", "-o"])
            .arg(&tmp)
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动下载失败：{e}"))?;

        // 轮询临时文件大小上报进度，直到 curl 退出
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            match child.try_wait() {
                Ok(Some(status)) => {
                    let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                    if !status.success() || size < 1_000_000 {
                        let _ = fs::remove_file(&tmp);
                        return Err(
                            "下载失败：网络中断或 GitHub 不可达。解决方案：检查网络连接，或在下载页「网络代理」里配置可用代理后重试".into(),
                        );
                    }
                    break;
                }
                Ok(None) => {
                    if let Ok(m) = fs::metadata(&tmp) {
                        if total > 0 {
                            emit((m.len() as f64 / total as f64 * 100.0).min(99.0));
                        }
                    }
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = fs::remove_file(&tmp);
                    return Err(format!("下载进程异常：{e}"));
                }
            }
        }

        let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if total > 0 && size != total {
            let _ = fs::remove_file(&tmp);
            return Err("下载不完整，已中止更新。解决方案：请重试；多次失败请检查网络或代理".into());
        }

        // 校验新文件能正常运行且版本更新
        emit(100.0);
        let ver_out = command_no_window(&tmp).arg("--version").output();
        let new_ver = ver_out
            .as_ref()
            .map(|v| String::from_utf8_lossy(&v.stdout).trim().to_string())
            .unwrap_or_default();
        let ver_ok = ver_out.as_ref().map(|v| v.status.success()).unwrap_or(false);
        if !ver_ok || new_ver.is_empty() {
            let _ = fs::remove_file(&tmp);
            return Err(
                "新版本文件校验失败：下载的 yt-dlp 无法运行（可能被杀毒软件误报拦截）。解决方案：将本程序加入杀软白名单后重试".into(),
            );
        }

        // 替换：旧文件先挪到 .bak，新文件改名上位，成功后删 .bak；失败则回滚
        let replace_err = |e: std::io::Error| {
            let _ = fs::remove_file(&tmp);
            let reason = if e.kind() == std::io::ErrorKind::PermissionDenied {
                "权限不足或文件被占用"
            } else {
                "文件替换失败"
            };
            format!(
                "更新失败：{reason}。解决方案：① 等待正在进行的下载/解析结束或取消后重试；② 右键「以管理员身份运行」本程序后重试；③ 或手动下载新版覆盖安装目录 resources 下的 yt-dlp.exe"
            )
        };
        let _ = fs::remove_file(&bak);
        fs::rename(&ytdlp, &bak).map_err(replace_err)?;
        if let Err(e) = fs::rename(&tmp, &ytdlp) {
            let _ = fs::rename(&bak, &ytdlp); // 回滚，保住旧版本可用
            return Err(replace_err(e));
        }
        let _ = fs::remove_file(&bak);
        Ok(new_ver)
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

/// 调用 yt-dlp 下载视频，通过 ytdlp-progress 事件上报进度（0~1）。
/// 返回 yt-dlp 报告的最终文件路径（合并后的文件），拿不到就是空串。
#[tauri::command]
async fn ytdlp_download(
    app: tauri::AppHandle,
    window: tauri::Window,
    url: String,
    output: String,
    options: YtDlpDownloadOptions,
) -> Result<String, String> {
    let ytdlp = locate_ytdlp_inner(&app)?;
    let ytdlp_str = ytdlp.to_string_lossy().into_owned();
    // 注意：这里不要调 normalize_bili_part_url！
    // 解析合集主页时需要去掉 p=N 让 yt-dlp 拿到 entries，但下载时 entry URL 带 p=N 才是正确的单 P 链接。

    // 视频/音频分离的站点需要合并，告诉 yt-dlp 内置 ffmpeg 在哪
    let ffmpeg_dir = locate_ffmpeg_inner(&app)
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()));

    let mut args: Vec<String> = vec![
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--no-color".to_string(),
        // 同名文件已存在时默认会跳过（还报"下载完成"），换分辨率重下必须覆盖
        "--force-overwrites".to_string(),
        // --print 会进 quiet 模式，进度行需要 --progress 才会输出
        "--progress".to_string(),
        // --print 默认会带 --simulate，不关掉就只解析不下载
        "--no-simulate".to_string(),
        "--print".to_string(),
        "after_move:filepath".to_string(),
        // 文件名可能含中文：固定 UTF-8，否则管道里是 GBK，读出来是乱码/空
        "--encoding".to_string(),
        "utf-8".to_string(),
        "--user-agent".to_string(),
        YTDLP_UA.to_string(),
        "--extractor-args".to_string(),
        "generic:impersonate".to_string(),
    ];
    if let Some(dir) = &ffmpeg_dir {
        args.push("--ffmpeg-location".to_string());
        args.push(dir.clone());
    }
    if let Some(fmt) = &options.format {
        if !fmt.is_empty() {
            args.push("-f".to_string());
            args.push(fmt.clone());
        }
    }
    if let Some(cookie_file) = &options.cookies {
        if !cookie_file.is_empty() {
            args.push("--cookies".to_string());
            args.push(cookie_file.clone());
        }
    }
    if let Some(browser) = &options.cookies_from_browser {
        if !browser.is_empty() {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.clone());
        }
    }
    args.push("-o".to_string());
    args.push(output.clone());
    args.push(url.clone());

    // 目标目录可能还不存在（默认下载目录\图像工具箱），先建出来
    if let Some(parent) = Path::new(&output).parent() {
        let _ = fs::create_dir_all(parent);
    }

    let window_clone = window.clone();

    // 每次新下载先清掉上一个取消请求，避免残留标志影响本次
    YTDLP_CANCEL.store(false, Ordering::SeqCst);

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut child = command_no_window(&ytdlp_str)
            .args(&args)
            // yt-dlp 是 PyInstaller 打包的 Python：管道里默认按块缓冲，进度会憋到结束才一次性吐出来。
            // 关掉缓冲，进度行才能实时到达。
            .env("PYTHONUNBUFFERED", "1")
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 yt-dlp 失败：{e}"))?;

        // 装进作业对象：取消时 TerminateJobObject 杀整棵进程树（PyInstaller 会派生子进程，
        // 只 kill 直接子进程会留下孤儿继续下载）。必须在子进程开始派生活儿之前装入。
        let job = Arc::new(kill_tree_job::KillTreeJob::new());
        if let Some(job) = &*job {
            job.assign(&child);
        }

        // 进度行有些站点写 stdout、有些写 stderr，两边都解析；共享 phase + 百分比状态
        let progress_state = Arc::new(Mutex::new(ProgressState::default()));

        // stdout 里还有 --print 输出的最终文件路径
        let stdout_handle = child.stdout.take().map(|stdout| {
            let win = window_clone.clone();
            let shared = progress_state.clone();
            std::thread::spawn(move || {
                let mut last_non_progress = String::new();
                for line in BufReader::new(stdout).lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    let trimmed = line.trim();
                    if trimmed.starts_with("[download]") {
                        emit_progress(trimmed, &shared, &win);
                        continue;
                    }
                    if !trimmed.is_empty() {
                        last_non_progress = trimmed.to_string();
                    }
                }
                last_non_progress
            })
        });

        let child = Arc::new(Mutex::new(child));

        // 看门狗：即使 yt-dlp 暂时没有输出，也在检测到取消标志时立即 kill 整棵进程树、让阻塞的读取立刻返回
        {
            let watchdog = child.clone();
            let watchdog_job = job.clone();
            std::thread::spawn(move || loop {
                if YTDLP_CANCEL.load(Ordering::SeqCst) {
                    // 先杀作业里的整棵树（真正下载的 PyInstaller 子进程），再 kill 直接子进程双保险
                    if let Some(job) = &*watchdog_job {
                        job.kill();
                    }
                    let _ = watchdog.lock().unwrap().kill();
                    break;
                }
                let done = watchdog
                    .lock()
                    .unwrap()
                    .try_wait()
                    .map(|s| s.is_some())
                    .unwrap_or(true);
                if done {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            });
        }

        // stderr：错误识别 + 进度（YouTube 这类站点进度走 stderr）+ 合并阶段检测
        let mut risk_blocked = false;
        // 必须先 take 再 if let：把 child.lock() 写在 if let 条件里的话，
        // MutexGuard 临时值会活到整个 if let 结束，看门狗抢不到锁、永远 kill 不了
        let stderr = child.lock().unwrap().stderr.take();
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines() {
                if YTDLP_CANCEL.load(Ordering::SeqCst) {
                    if let Some(job) = &*job {
                        job.kill();
                    }
                    let _ = child.lock().unwrap().kill();
                    break;
                }
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.contains("412") || trimmed.contains("Precondition Failed") {
                    risk_blocked = true;
                }
                // 检测到合并阶段，切换 phase
                if (trimmed.starts_with("[Merger]")
                    || trimmed.starts_with("[ExtractAudio]")
                    || trimmed.starts_with("[ExtractVideo]"))
                    && progress_state.lock().map(|mut s| {
                        if s.phase != "merge" && s.phase != "done" {
                            s.phase = "merge".to_string();
                            true
                        } else {
                            false
                        }
                    }).unwrap_or(false)
                {
                    emit_phase(&window_clone, "merge", 0.0, "");
                }
                emit_progress(trimmed, &progress_state, &window_clone);
            }
        }

        let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
        let final_path = stdout_handle.and_then(|h| h.join().ok()).unwrap_or_default();
        if YTDLP_CANCEL.load(Ordering::SeqCst) {
            return Err("已取消下载".into());
        }
        if !status.success() {
            return Err(if risk_blocked {
                "下载失败：站点返回 HTTP 412（当前网络出口被风控，常见于代理/VPN。请让 bilibili.com 直连或在「网络代理」里换一个出口后重试）".into()
            } else {
                "yt-dlp 下载失败，请检查链接或网络".into()
            });
        }
        // 下载+合并全部完成，发 done 事件
        emit_phase(&window_clone, "done", 1.0, "");
        Ok(final_path)
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))??;

    Ok(result)
}

/// 从 yt-dlp 输出行中提取百分比数值（如 " 25.0%" → 25.0）
fn extract_percent(line: &str) -> Option<f64> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // 往前找数字
            let mut j = i;
            while j > 0 && (bytes[j - 1].is_ascii_digit() || bytes[j - 1] == b'.') {
                j -= 1;
            }
            if j < i {
                let num_str = &line[j..i];
                if let Ok(v) = num_str.parse::<f64>() {
                    return Some(v);
                }
            }
        }
        i += 1;
    }
    None
}

/// 去掉系统标题栏后，Win11 不再自动给窗口加圆角，这里显式打开 DWM 圆角。
/// Win10 及更早版本不认这个属性，调用失败就保持直角。
#[cfg(windows)]
fn enable_round_corners(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWCP_ROUND, DWMWA_WINDOW_CORNER_PREFERENCE,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let preference: u32 = DWMWCP_ROUND as u32;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as isize,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &preference as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    enable_round_corners(&window);
                }
            }
            // ffmpeg.exe 有 100MB，第一次调用要现映射映像 + 过安全软件。后台先跑一次
            // 把它热起来，用户点导入时就只需要付热启动的那部分时间。
            warm_up_ffmpeg(app.handle().clone());
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_images,
            pick_dir,
            read_file,
            write_file,
            file_size,
            list_files,
            open_path,
            locate_ffmpeg,
            ffprobe_video,
            keyframe_times,
            convert_video,
            convert_audio,
            ytdlp_info,
            ytdlp_download,
            cancel_download,
            cancel_ytdlp_info,
            ytdlp_update_ui_visible,
            ytdlp_dir,
            ytdlp_check_update,
            ytdlp_apply_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
