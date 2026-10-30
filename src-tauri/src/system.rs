//! 本机能力：电脑配置读取 + 电源操作。
//!
//! 分层原因：基础项全部走 Win32 API 和注册表（毫秒级、不起进程、不闪黑框），
//! 打开页签就能见到内容；详细项（内存条、磁盘型号、驱动版本、序列号这类）只有 WMI 有，
//! 需要起一次 PowerShell，实测 1~3 秒，所以单独一个命令、由前端在「详细配置」里按需加载。

use serde::Serialize;
use std::fs;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::command_no_window;

/// WMI 查询的等待上限。正常 3 秒内返回，超过这个时间基本是被组策略或安全软件挡住了，
/// 继续等只会让界面一直挂在「读取中」。
const WMI_TIMEOUT: Duration = Duration::from_secs(20);

/// 临时脚本 / 结果文件放在 %TEMP%，用完即删。脚本走 -File 执行，避免把整段 PowerShell
/// 塞进 -Command 时的引号与控制台代码页问题；结果落盘再读，绕开管道编码差异。
const WMI_SCRIPT_NAME: &str = "seqtool_sysinfo.ps1";
const WMI_JSON_NAME: &str = "seqtool_sysinfo.json";

#[derive(Serialize)]
pub struct InfoField {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct InfoGroup {
    pub title: String,
    pub fields: Vec<InfoField>,
}

/// 电源状态。自动关机页在按下「开始计时」时靠这几项判断风险（只用电池、
/// 电源策略不允许关机），所以返回结构而不是文案，措辞交给界面。
#[derive(Serialize)]
pub struct PowerStatus {
    /// 外接电源是否接通；读不到时按 true 处理，免得台式机每次都被拦住要二次确认
    pub ac_online: bool,
    pub battery_present: bool,
    pub battery_percent: Option<u8>,
    pub charging: bool,
    /// 电源能力里有没有 S5（软关机）——组策略禁掉关机时这一项为 false
    pub shutdown_allowed: bool,
}

// ===== 组装与格式化工具 =====

fn field(name: &str, value: impl Into<String>) -> Option<InfoField> {
    let value = value.into();
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(InfoField {
            name: name.to_string(),
            value: trimmed.to_string(),
        })
    }
}

fn push(out: &mut Vec<InfoField>, item: Option<InfoField>) {
    if let Some(item) = item {
        out.push(item);
    }
}

fn group(title: &str, fields: Vec<InfoField>) -> Option<InfoGroup> {
    if fields.is_empty() {
        None
    } else {
        Some(InfoGroup {
            title: title.to_string(),
            fields,
        })
    }
}

/// 小数点后一位，整数值时去掉 .0（16.0 GB → 16 GB）
fn trim_one(v: f64) -> String {
    let s = format!("{:.1}", v);
    match s.strip_suffix(".0") {
        Some(head) => head.to_string(),
        None => s,
    }
}

/// 按资源管理器的习惯用二进制单位显示（这里的 GB 实际是 GiB）
fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    const TIB: f64 = GIB * 1024.0;
    let v = bytes as f64;
    if v >= TIB {
        format!("{} TB", trim_one(v / TIB))
    } else if v >= GIB {
        format!("{} GB", trim_one(v / GIB))
    } else if v >= MIB {
        format!("{} MB", trim_one(v / MIB))
    } else {
        format!("{} KB", trim_one(v / KIB))
    }
}

/// MHz → "5.0 GHz" / "2400 MHz"
fn human_freq(mhz: u32) -> Option<String> {
    if mhz == 0 {
        None
    } else if mhz >= 1000 {
        Some(format!("{} GHz", trim_one(mhz as f64 / 1000.0)))
    } else {
        Some(format!("{} MHz", mhz))
    }
}

fn human_duration(ms: u64) -> String {
    let total = ms / 1000;
    let days = total / 86_400;
    let hours = (total % 86_400) / 3_600;
    let minutes = (total % 3_600) / 60;
    if days > 0 {
        format!("{days} 天 {hours} 小时")
    } else if hours > 0 {
        format!("{hours} 小时 {minutes} 分")
    } else {
        format!("{minutes} 分")
    }
}

/// 儒略日 → "YYYY-MM-DD"（civil_from_days，为了不只有一个字段就引日期库）
fn date_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 注册表的 InstallDate 是 UTC 秒，按本机时区偏移折成当地日期，
/// 否则凌晨装的系统会比「详细配置」里 WMI 的本地时间少一天
#[cfg(windows)]
fn date_from_unix(secs: u32) -> String {
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut tz: TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    // 返回 TIME_ZONE_ID_INVALID(u32::MAX) 时 Bias 不可信，按 UTC 处理
    let bias = if unsafe { GetTimeZoneInformation(&mut tz) } == u32::MAX {
        0
    } else {
        tz.Bias
    };
    let local = secs as i64 - bias as i64 * 60;
    date_from_days(local.div_euclid(86_400))
}

#[cfg(test)]
mod tests {
    use super::date_from_days;

    #[test]
    fn days_to_date() {
        assert_eq!(date_from_days(0), "1970-01-01");
        assert_eq!(date_from_days(20_062), "2024-12-05");
        assert_eq!(date_from_days(20_063), "2024-12-06");
        assert_eq!(date_from_days(-1), "1969-12-31");
        assert_eq!(date_from_days(19_358), "2023-01-01");
    }
}

// ===== 基础配置（Win32 + 注册表） =====

#[cfg(windows)]
mod local {
    use super::{
        InfoField, InfoGroup, PowerStatus, date_from_unix, field, group, human_bytes,
        human_duration, human_freq, push,
    };
    use std::mem;
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use windows_sys::Win32::Graphics::Gdi::{DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::Power::{
        GetPwrCapabilities, GetSystemPowerStatus, SYSTEM_POWER_CAPABILITIES, SYSTEM_POWER_STATUS,
    };
    use windows_sys::Win32::System::SystemInformation::{
        GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;
    use windows_sys::Win32::UI::HiDpi::GetDpiForSystem;

    const CPU_KEY: &str = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    const OS_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    /// 显示设备类 GUID：显卡的 DriverDesc 存在这里的 0000/0001 实例键上
    const GPU_CLASS_KEY: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    fn reg_sz(key: &RegKey, path: &str, value: &str) -> Option<String> {
        key.open_subkey(path)
            .ok()?
            .get_value::<String, _>(value)
            .ok()
            .map(|s| s.trim().trim_end_matches('\0').trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn reg_u32(key: &RegKey, path: &str, value: &str) -> Option<u32> {
        key.open_subkey(path)
            .ok()?
            .get_value::<u32, _>(value)
            .ok()
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// Windows 11 的 ProductName 常常还写着 "Windows 10"，按编译号纠正前缀
    fn os_display_name(product: Option<String>, build: u32) -> Option<String> {
        let mut name = product?;
        if build >= 22_000 {
            name = name.replace("Windows 10", "Windows 11");
        }
        Some(name)
    }

    fn memory() -> Option<(u64, u64, u32)> {
        let mut status: MEMORYSTATUSEX = unsafe { mem::zeroed() };
        // GlobalMemoryStatusEx 靠 dwLength 判断调用方用的是哪个版本的结构体，必须填
        status.dwLength = mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
            return None;
        }
        Some((
            status.ullTotalPhys,
            status.ullAvailPhys,
            status.dwMemoryLoad,
        ))
    }

    /// 主显示器的当前模式：分辨率、刷新率、色深
    fn primary_display() -> Option<(u32, u32, u32, u32)> {
        let mut mode: DEVMODEW = unsafe { mem::zeroed() };
        // 设备名传 NULL 表示主屏
        let ok = unsafe {
            EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut mode)
        };
        if ok == 0 {
            return None;
        }
        Some((
            mode.dmPelsWidth,
            mode.dmPelsHeight,
            mode.dmDisplayFrequency,
            mode.dmBitsPerPel,
        ))
    }

    /// 投屏/远程工具会往显示设备类里注册假显卡（GameViewer、Remote Display 等），
    /// 它们没有显存也没有分辨率，列出来只会挤掉真卡，所以两边视图都跳过
    fn is_virtual_gpu(desc: &str) -> bool {
        let lower = desc.to_lowercase();
        lower.contains("virtual") || lower.contains("remote display")
    }

    fn gpu_names(hklm: &RegKey) -> Vec<String> {
        let Ok(class) = hklm.open_subkey(GPU_CLASS_KEY) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for name in class.enum_keys().filter_map(Result::ok) {
            // 只收 0000 / 0001 这类实例键，跳过 Configuration、Properties 等
            if name.len() != 4 || !name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Ok(sub) = class.open_subkey(&name) else {
                continue;
            };
            let Ok(desc) = sub.get_value::<String, _>("DriverDesc") else {
                continue;
            };
            let desc = desc.trim().to_string();
            if !desc.is_empty() && !is_virtual_gpu(&desc) && !out.contains(&desc) {
                out.push(desc);
            }
        }
        out
    }

    /// 固定磁盘逐个列出。可移动盘和光驱跳过：读卡器无卡时 GetVolumeInformationW 会
    /// 走到驱动提示，宁可少列一块盘也不冒卡住的险。
    fn fixed_drives() -> Vec<InfoField> {
        let mut out = Vec::new();
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let root = wide(&format!("{letter}:\\"));
            if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_FIXED {
                continue;
            }
            let mut free = 0u64;
            let mut total = 0u64;
            let mut total_free = 0u64;
            if unsafe {
                GetDiskFreeSpaceExW(root.as_ptr(), &mut free, &mut total, &mut total_free)
            } == 0
            {
                continue;
            }
            let mut label_buf = [0u16; 64];
            let mut fs_buf = [0u16; 64];
            let mut serial = 0u32;
            let mut max_component = 0u32;
            let mut flags = 0u32;
            let got = unsafe {
                GetVolumeInformationW(
                    root.as_ptr(),
                    label_buf.as_mut_ptr(),
                    label_buf.len() as u32,
                    &mut serial,
                    &mut max_component,
                    &mut flags,
                    fs_buf.as_mut_ptr(),
                    fs_buf.len() as u32,
                )
            };
            let mut title = format!("{letter}:");
            if got != 0 {
                let label = from_wide(&label_buf).trim().to_string();
                if !label.is_empty() {
                    title.push_str(&format!(" ({label})"));
                }
            }
            let fs_name = if got != 0 {
                from_wide(&fs_buf).trim().to_string()
            } else {
                String::new()
            };
            let value = format!(
                "可用 {} / 共 {}{}",
                human_bytes(free),
                human_bytes(total),
                if fs_name.is_empty() {
                    String::new()
                } else {
                    format!(" · {fs_name}")
                }
            );
            push(&mut out, field(&title, value));
        }
        out
    }

    /// 面板顶部要单独显示「本次开机」：详细档不读基础档，所以给它一条自己的取数路径
    pub fn uptime() -> String {
        human_duration(unsafe { GetTickCount64() })
    }

    pub fn power_status() -> PowerStatus {
        let mut status: SYSTEM_POWER_STATUS = unsafe { mem::zeroed() };
        let mut caps: SYSTEM_POWER_CAPABILITIES = unsafe { mem::zeroed() };
        let got_status = unsafe { GetSystemPowerStatus(&mut status) } != 0;
        let got_caps = unsafe { GetPwrCapabilities(&mut caps) } != 0;
        // ACLineStatus: 0 = 电池，1 = 外接电源，255 = 未知
        let ac_online = !got_status || status.ACLineStatus != 0;
        let percent = if got_status && status.BatteryLifePercent <= 100 {
            Some(status.BatteryLifePercent)
        } else {
            None
        };
        PowerStatus {
            ac_online,
            battery_present: got_caps && caps.SystemBatteriesPresent != 0,
            battery_percent: percent,
            // BatteryFlag 的 bit3 = 正在充电
            charging: got_status && (status.BatteryFlag & 8) != 0,
            shutdown_allowed: !got_caps || caps.SystemS5 != 0,
        }
    }

    pub fn basic() -> Vec<InfoGroup> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let mut groups: Vec<InfoGroup> = Vec::new();

        {
            let mut v = Vec::new();
            // 24H2 之后这两个值改成了 REG_SZ，只按 DWORD 读会拿到 0，
            // 连带 Windows 11 的名字纠正也失效，所以两种类型都试
            let build = reg_u32(&hklm, OS_KEY, "CurrentBuildNumber")
                .or_else(|| reg_sz(&hklm, OS_KEY, "CurrentBuildNumber").and_then(|s| s.parse().ok()))
                .or_else(|| reg_u32(&hklm, OS_KEY, "CurrentBuild"))
                .or_else(|| reg_sz(&hklm, OS_KEY, "CurrentBuild").and_then(|s| s.parse().ok()))
                .unwrap_or(0);
            push(
                &mut v,
                field(
                    "操作系统",
                    os_display_name(reg_sz(&hklm, OS_KEY, "ProductName"), build).unwrap_or_default(),
                ),
            );
            let feature = reg_sz(&hklm, OS_KEY, "DisplayVersion").unwrap_or_default();
            push(
                &mut v,
                field(
                    "版本",
                    match (feature.is_empty(), build == 0) {
                        (false, false) => format!("{feature} · Build {build}"),
                        (false, true) => feature,
                        (true, false) => format!("Build {build}"),
                        (true, true) => String::new(),
                    },
                ),
            );
            push(
                &mut v,
                field(
                    "累计更新",
                    reg_u32(&hklm, OS_KEY, "UBR").map(|v| format!("UBR {v}")).unwrap_or_default(),
                ),
            );
            push(
                &mut v,
                field(
                    "体系结构",
                    match env("PROCESSOR_ARCHITECTURE").as_str() {
                        "AMD64" => "x64",
                        "ARM64" => "ARM64",
                        other => other,
                    },
                ),
            );
            push(&mut v, field("计算机名", env("COMPUTERNAME")));
            push(&mut v, field("当前用户", env("USERNAME")));
            push(
                &mut v,
                field(
                    "系统安装于",
                    reg_u32(&hklm, OS_KEY, "InstallDate")
                        .map(date_from_unix)
                        .unwrap_or_default(),
                ),
            );
            push(
                &mut v,
                field("本次开机", human_duration(unsafe { GetTickCount64() })),
            );
            groups.extend(group("系统", v));
        }

        {
            let mut v = Vec::new();
            push(
                &mut v,
                field(
                    "型号",
                    reg_sz(&hklm, CPU_KEY, "ProcessorNameString").unwrap_or_default(),
                ),
            );
            push(
                &mut v,
                field(
                    "厂商标识",
                    reg_sz(&hklm, CPU_KEY, "VendorIdentifier").unwrap_or_default(),
                ),
            );
            push(
                &mut v,
                field(
                    // 注册表的 ~MHz 是开机上报的标称值，和 WMI 的基准主频可以差一截
                    // （本机 2688 vs 2300），所以这里只写「主频」，不冒充基准值
                    "主频",
                    reg_u32(&hklm, CPU_KEY, "~MHz")
                        .and_then(human_freq)
                        .unwrap_or_default(),
                ),
            );
            let logical = env("NUMBER_OF_PROCESSORS");
            push(
                &mut v,
                field(
                    "逻辑处理器",
                    if logical.is_empty() {
                        String::new()
                    } else {
                        format!("{logical} 个")
                    },
                ),
            );
            groups.extend(group("处理器", v));
        }

        if let Some((total, avail, load)) = memory() {
            let mut v = Vec::new();
            push(&mut v, field("总量", human_bytes(total)));
            push(&mut v, field("可用", human_bytes(avail)));
            push(&mut v, field("使用率", format!("{load}%")));
            groups.extend(group("内存", v));
        }

        {
            let mut v = Vec::new();
            for (i, name) in gpu_names(&hklm).iter().enumerate() {
                let label = if i == 0 {
                    "显卡".to_string()
                } else {
                    format!("显卡 {}", i + 1)
                };
                push(&mut v, field(&label, name.clone()));
            }
            groups.extend(group("显卡", v));
        }

        if let Some((w, h, freq, depth)) = primary_display() {
            let mut v = Vec::new();
            push(&mut v, field("主屏分辨率", format!("{w} × {h}")));
            push(&mut v, field("刷新率", format!("{freq} Hz")));
            push(&mut v, field("色深", format!("{depth} 位")));
            let dpi = unsafe { GetDpiForSystem() };
            if dpi > 0 {
                push(&mut v, field("系统缩放", format!("{}%", dpi * 100 / 96)));
            }
            groups.extend(group("显示", v));
        }

        groups.extend(group("存储", fixed_drives()));

        {
            let status = power_status();
            if status.battery_present {
                let mut v = Vec::new();
                push(
                    &mut v,
                    field("供电", if status.ac_online { "外接电源" } else { "电池" }),
                );
                push(
                    &mut v,
                    field(
                        "电池",
                        status
                            .battery_percent
                            .map(|p| {
                                format!(
                                    "{p}%{}",
                                    if status.charging { " · 充电中" } else { "" }
                                )
                            })
                            .unwrap_or_default(),
                    ),
                );
                groups.extend(group("电源", v));
            }
        }

        groups
    }
}

#[cfg(not(windows))]
mod local {
    use super::{InfoGroup, PowerStatus};

    pub fn basic() -> Vec<InfoGroup> {
        Vec::new()
    }

    pub fn uptime() -> String {
        String::new()
    }

    pub fn power_status() -> PowerStatus {
        PowerStatus {
            ac_online: true,
            battery_present: false,
            battery_percent: None,
            charging: false,
            shutdown_allowed: true,
        }
    }
}

// ===== 详细配置（WMI） =====

/// 一次 PowerShell 调用取回全部详细项：逐项起进程会把 1~3 秒变成十几秒。
/// 脚本里一次查完再 ConvertTo-Json 落盘，由前端负责排版成明细行。
///
/// 脚本内容必须保持纯 ASCII（注释也一样）：这里落盘的是无 BOM 的 UTF-8，
/// 中文系统上 powershell.exe 5.1 会按 GBK 解码，多字节注释里很容易蹭出一个
/// 引号，整份脚本直接解析失败。字段取舍和措辞属于显示层，全部留在前端。
#[cfg(windows)]
const WMI_SCRIPT: &str = r#"
param([string]$Out)
$ErrorActionPreference = 'SilentlyContinue'
# -Property wants a string array; 'A,B' as one quoted string is treated as a
# single (nonexistent) property name and errors out, so split it first.
# Every name below has to exist on the class - one bad name kills the whole query.
function Get-Rows([string]$Class, [string]$Props) {
  $p = $Props.Split(',')
  @(Get-CimInstance -ClassName $Class -Property $p | ForEach-Object {
      $row = $_
      $o = [ordered]@{}
      foreach ($k in $p) {
        $v = $row.$k
        # PS 5.1 turns a DateTime into /Date(ms)/, so format it here instead
        if ($v -is [datetime]) { $v = $v.ToString('yyyy-MM-dd HH:mm:ss') }
        $o[$k] = $v
      }
      [pscustomobject]$o
    })
}
$d = [ordered]@{}
$d.os      = Get-Rows 'Win32_OperatingSystem' 'Caption,Version,BuildNumber,BuildType,SerialNumber,InstallDate,LastBootUpTime,SystemDrive,WindowsDirectory'
$d.cs      = Get-Rows 'Win32_ComputerSystem' 'Manufacturer,Model,TotalPhysicalMemory,NumberOfProcessors,NumberOfLogicalProcessors,Domain,SystemFamily,PCSystemType'
$d.cpu     = Get-Rows 'Win32_Processor' 'Name,Manufacturer,Description,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,CurrentClockSpeed,L2CacheSize,L3CacheSize,SocketDesignation,VirtualizationFirmwareEnabled'
$d.mem     = Get-Rows 'Win32_PhysicalMemory' 'DeviceLocator,Capacity,ConfiguredClockSpeed,Manufacturer,PartNumber,FormFactor,SMBIOSMemoryType'
$d.gpu     = Get-Rows 'Win32_VideoController' 'Name,AdapterCompatibility,AdapterRAM,DriverVersion,DriverDate,VideoProcessor,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate'
$d.disk    = Get-Rows 'Win32_DiskDrive' 'Model,Size,InterfaceType,Index,Partitions'
$d.pdisk   = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object FriendlyName,MediaType,BusType,Size,HealthStatus)
$d.vol     = Get-Rows 'Win32_LogicalDisk' 'DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType'
$d.bios    = Get-Rows 'Win32_BIOS' 'Manufacturer,SMBIOSBIOSVersion,ReleaseDate,SerialNumber'
$d.board   = Get-Rows 'Win32_BaseBoard' 'Manufacturer,Product,Version,SerialNumber'
$d.enc     = Get-Rows 'Win32_SystemEnclosure' 'Manufacturer,Model,SerialNumber'
$d.bat     = Get-Rows 'Win32_Battery' 'Name,EstimatedChargeRemaining,BatteryStatus'
$netProps = 'Description,MACAddress,IPAddress,DefaultIPGateway,DHCPEnabled,IPEnabled'.Split(',')
$d.net     = @(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Property $netProps |
  Where-Object { $_.IPEnabled } |
  Select-Object -Property $netProps)
$d | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $Out -Encoding UTF8
"#;

#[cfg(windows)]
fn wmi_rows() -> Result<serde_json::Value, String> {
    let dir = std::env::temp_dir();
    let script = dir.join(WMI_SCRIPT_NAME);
    let json = dir.join(WMI_JSON_NAME);
    let _ = fs::remove_file(&json); // 删掉上一次结果，避免读到旧数据

    if let Err(e) = fs::write(&script, WMI_SCRIPT) {
        return Err(format!("写入查询脚本失败：{e}"));
    }
    let spawned = command_no_window("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg(&json)
        // 三个管道都不接：结果走文件，只等退出码，省掉「输出塞满管道、子进程写不进去」
        // 这类死锁
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            let _ = fs::remove_file(&script);
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                "找不到 powershell.exe，无法读取详细配置".to_string()
            } else {
                format!("启动详细配置查询失败：{e}")
            });
        }
    };

    // 看门狗轮询：PowerShell 冷启动或组策略拦截时不能让 invoke 永远不返回，
    // 否则前端按钮会一直停在「读取详细配置…」
    let started = Instant::now();
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => {
                if started.elapsed() > WMI_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break true;
                }
            }
            Err(e) => {
                let _ = fs::remove_file(&script);
                return Err(format!("查询进程状态失败：{e}"));
            }
        }
        std::thread::sleep(Duration::from_millis(120));
    };
    let _ = fs::remove_file(&script);

    if timed_out {
        let _ = fs::remove_file(&json);
        return Err(format!(
            "详细配置读取超时（{} 秒），可能被安全软件或组策略挡住了",
            WMI_TIMEOUT.as_secs()
        ));
    }

    let text = match fs::read_to_string(&json) {
        Ok(text) => text,
        Err(_) => {
            return Err("详细配置查询没有返回结果".to_string());
        }
    };
    let _ = fs::remove_file(&json);
    // PS 5.1 的 -Encoding UTF8 会写 BOM，serde_json 不认
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("解析详细配置结果失败：{e}"))
}

#[cfg(not(windows))]
fn wmi_rows() -> Result<serde_json::Value, String> {
    Err("详细配置只在 Windows 下可用".to_string())
}

// ===== 电源操作 =====

#[cfg(windows)]
fn run_shutdown(args: &[&str]) -> Result<(), String> {
    let out = command_no_window("shutdown")
        .args(args)
        .output()
        .map_err(|e| format!("启动 shutdown 失败：{e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // 1116 = 当前没有待撤回的关机计划，对界面来说不算失败
    if out.status.code() == Some(1116) {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("shutdown 返回 {}", out.status)
    } else {
        err
    })
}

#[cfg(not(windows))]
fn run_shutdown(_args: &[&str]) -> Result<(), String> {
    Err("电源操作只在 Windows 下可用".to_string())
}

/// 只放行秒数，前端传来的其它内容一律不进命令行
fn clamp_delay(secs: u32) -> u32 {
    secs.min(36_000)
}

// ===== 命令 =====

#[tauri::command]
pub async fn sysinfo_basic() -> Result<Vec<InfoGroup>, String> {
    // 同步命令会跑在主线程上：注册表这几十个值本身是微秒级，但插着读卡器或网络盘时
    // GetVolumeInformationW 可能挂住，界面会跟着发灰。
    tauri::async_runtime::spawn_blocking(local::basic)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))
}

#[tauri::command]
pub async fn sysinfo_detail() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(wmi_rows)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

/// 面板顶部的「本次开机」：微秒级的一个 API 调用，不值得走 basic 那一整套注册表读取
#[tauri::command]
pub fn sysinfo_uptime() -> String {
    local::uptime()
}

#[tauri::command]
pub async fn power_status() -> Result<PowerStatus, String> {
    tauri::async_runtime::spawn_blocking(local::power_status)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))
}

/// action: shutdown / reboot / abort。abort 走 shutdown /a，用来撤回还没到点的关机计划，
/// 覆盖「已经按下执行、还想反悔」的那十几秒。
#[tauri::command]
pub async fn power_action(action: String, delay: Option<u32>) -> Result<(), String> {
    let secs = clamp_delay(delay.unwrap_or(0));
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "shutdown" => run_shutdown(&["/s", "/t", &secs.to_string()]),
        "reboot" => run_shutdown(&["/r", "/t", &secs.to_string()]),
        "abort" => run_shutdown(&["/a"]),
        other => Err(format!("未知的电源操作：{other}")),
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}
