use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 窗口配置成 visible:false，启动时就不会露出还没渲染的白底；前端 main.js 在
        // HTML 和样式表到位后自己 show()。这里兜一层底：万一脚本没跑起来，2 秒后强制
        // 显示，不至于留下一个永远看不见的窗口。
        .setup(|app| {
            use tauri::Manager;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                if let Some(w) = handle.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        return;
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_images,
            pick_dir,
            read_file,
            write_file,
            list_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
