fn main() {
    // tauri-build 只盯着配置文件和 gen/，换图标不会让它重跑，
    // 于是 exe 里嵌的还是上一版编译出来的那套 icon 资源
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
